require "xcodeproj"

project_path = File.expand_path("App/App.xcodeproj", __dir__)
project = Xcodeproj::Project.open(project_path)
app = project.targets.find { |target| target.name == "App" }
raise "Capacitor App target not found" unless app

# AppDelegate 在冷启动阶段使用通知委托，需要直接链接通知库的公开符号。
notify_path = "../../../../packages/capacitor-notify"
notify_package = project.root_object.package_references.find { |ref| ref.respond_to?(:relative_path) && ref.relative_path == notify_path }
unless notify_package
  notify_package = project.new(Xcodeproj::Project::Object::XCLocalSwiftPackageReference)
  notify_package.relative_path = notify_path
  project.root_object.package_references << notify_package
end
unless app.package_product_dependencies.any? { |dependency| dependency.product_name == "MatrixCapacitorNotify" }
  dependency = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
  dependency.package = notify_package
  dependency.product_name = "MatrixCapacitorNotify"
  app.package_product_dependencies << dependency
  file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
  file.product_ref = dependency
  app.frameworks_build_phase.files << file
end

widget = project.targets.find { |target| target.name == "MatrixWidgetExtension" }
widget ||= project.new_target(:app_extension, "MatrixWidgetExtension", :ios, "17.0")
app_group = project.main_group.find_subpath("App", false)
widget_group = project.main_group.find_subpath("Widget", false) || project.main_group.new_group("Widget", "../Widget")
raise "App source group not found" unless app_group

{
  app_group => ["MatrixWidgetPlugin.swift", "MatrixBridgeViewController.swift", "PlatformSessionsPlugin.swift", "PlatformSessionTransport.swift", "MatrixWidgetNativeEngine.swift", "MatrixWidgetSync.swift"],
  widget_group => ["MatrixWidgets.swift", "MatrixRefreshLiveActivity.swift", "MatrixKillDDLLiveActivity.swift"],
}.each do |group, names|
  target = group == app_group ? app : widget
  names.each do |name|
    ref = group.files.find { |file| file.path == name } || group.new_file(name)
    target.source_build_phase.add_file_reference(ref) unless target.source_build_phase.files_references.include?(ref)
  end
end

url_shim = app_group.files.find { |ref| ref.path == "MatrixWidgetURL.js" } || app_group.new_file("MatrixWidgetURL.js")
app.resources_build_phase.add_file_reference(url_shim) unless app.resources_build_phase.files_references.include?(url_shim)

assets = widget_group.files.find { |ref| ref.path == "Assets.xcassets" } || widget_group.new_file("Assets.xcassets")
widget.resources_build_phase.add_file_reference(assets) unless widget.resources_build_phase.files_references.include?(assets)

# Interactive intents must be discoverable from the containing app as well as
# its widget extension. Keep their source shared, without compiling widget views
# or the @main WidgetBundle into the app.
shared_group = project.main_group.find_subpath("Shared", false) || project.main_group.new_group("Shared", "../Shared")
["MatrixWidgetRefreshIntent.swift", "MatrixRefreshActivity.swift", "MatrixKillDDLActivity.swift", "MatrixKillDDLDemoIntent.swift"].each do |name|
  ref = shared_group.files.find { |file| file.path == name } || shared_group.new_file(name)
  [app, widget].each do |target|
    target.source_build_phase.add_file_reference(ref) unless target.source_build_phase.files_references.include?(ref)
  end
end

app.build_configurations.each do |config|
  config.build_settings["SWIFT_ACTIVE_COMPILATION_CONDITIONS"] = "$(inherited) MATRIX_APP"
  config.build_settings["IPHONEOS_DEPLOYMENT_TARGET"] = "17.0"
  config.build_settings["CODE_SIGN_ENTITLEMENTS"] = "App/App.entitlements"
  config.build_settings["TARGETED_DEVICE_FAMILY"] = "1,2"
end

widget.build_configurations.each do |config|
  settings = config.build_settings
  settings["IPHONEOS_DEPLOYMENT_TARGET"] = "17.0"
  settings["PRODUCT_BUNDLE_IDENTIFIER"] = "dev.matrix.shell.widget"
  settings["PRODUCT_NAME"] = "MatrixWidgetExtension"
  settings["CURRENT_PROJECT_VERSION"] = "1"
  settings["MARKETING_VERSION"] = "1.0"
  settings["SWIFT_VERSION"] = "5.0"
  settings["TARGETED_DEVICE_FAMILY"] = "1,2"
  settings["APPLICATION_EXTENSION_API_ONLY"] = "YES"
  settings["SKIP_INSTALL"] = "YES"
  settings["GENERATE_INFOPLIST_FILE"] = "NO"
  settings["INFOPLIST_FILE"] = "../Widget/Info.plist"
  settings["CODE_SIGN_ENTITLEMENTS"] = "../Widget/Widget.entitlements"
end

app.add_dependency(widget) unless app.dependencies.any? { |dependency| dependency.target == widget }
embed = app.copy_files_build_phases.find { |phase| phase.files_references.include?(widget.product_reference) }
embed ||= app.copy_files_build_phases.find { |phase| phase.name == "Embed App Extensions" }
embed ||= app.new_copy_files_build_phase("Embed App Extensions")
embed.dst_subfolder_spec = "13"
embed.add_file_reference(widget.product_reference, true) unless embed.files_references.include?(widget.product_reference)
# Xcode may rename this phase to "Embed Foundation Extensions". Re-running the
# configuration must not embed the same appex twice under the two phase names.
app.copy_files_build_phases.reject { |phase| phase == embed }.each do |phase|
  phase.files.select { |file| file.file_ref == widget.product_reference }.each(&:remove_from_project)
  phase.remove_from_project if phase.files.empty? && phase.name == "Embed App Extensions"
end

# xcodeproj may choose a locally installed SDK version. Keep framework paths portable.
project.files.select { |ref| ref.name == "Foundation.framework" }.each do |ref|
  ref.path = "System/Library/Frameworks/Foundation.framework"
  ref.source_tree = "SDKROOT"
end

project.save
