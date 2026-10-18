require "xcodeproj"

project = Xcodeproj::Project.open(File.expand_path("App/App.xcodeproj", __dir__))
app = project.targets.find { |target| target.name == "App" }
raise "App target not found" unless app
tests = project.targets.find { |target| target.name == "MatrixNativeTests" }
tests ||= project.new_target(:unit_test_bundle, "MatrixNativeTests", :ios, "17.0")
tests.add_dependency(app) unless tests.dependencies.any? { |dependency| dependency.target == app }
group = project.main_group.find_subpath("MatrixNativeTests", false) || project.main_group.new_group("MatrixNativeTests")
test_path = "../../../../packages/capacitor-notify/ios/Tests/MatrixNotifyTests/NotificationValidationTests.swift"
ref = group.files.find { |file| file.path == test_path } || group.new_file(test_path)
tests.source_build_phase.add_file_reference(ref) unless tests.source_build_phase.files_references.include?(ref)
platform_test_path = "../Tests/PlatformSessionsTests.swift"
platform_ref = group.files.find { |file| file.path == platform_test_path } || group.new_file(platform_test_path)
tests.source_build_phase.add_file_reference(platform_ref) unless tests.source_build_phase.files_references.include?(platform_ref)
cap = app.package_product_dependencies.find { |dependency| dependency.product_name == "MatrixCapacitorNotify" }
raise "Run cap sync ios first" unless cap
unless tests.package_product_dependencies.any? { |dependency| dependency.product_name == "MatrixCapacitorNotify" }
  dependency = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
  dependency.package = cap.package
  dependency.product_name = "MatrixCapacitorNotify"
  tests.package_product_dependencies << dependency
  file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
  file.product_ref = dependency
  tests.frameworks_build_phase.files << file
end
tests.build_configurations.each do |config|
  config.build_settings.merge!({
    "PRODUCT_BUNDLE_IDENTIFIER" => "dev.matrix.shell.native-tests",
    "PRODUCT_NAME" => "MatrixNativeTests",
    "GENERATE_INFOPLIST_FILE" => "YES", "SWIFT_VERSION" => "5.0",
    "IPHONEOS_DEPLOYMENT_TARGET" => "17.0", "TARGETED_DEVICE_FAMILY" => "1,2",
    "TEST_HOST" => "$(BUILT_PRODUCTS_DIR)/App.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/App",
    "BUNDLE_LOADER" => "$(TEST_HOST)"
  })
end
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.add_build_target(tests)
scheme.add_test_target(tests)
scheme.save_as(project.path, "MatrixNativeTests", true)
project.save
