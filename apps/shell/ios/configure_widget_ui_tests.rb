require "xcodeproj"

project = Xcodeproj::Project.open(File.expand_path("App/App.xcodeproj", __dir__))
app = project.targets.find { |target| target.name == "App" }
raise "App target not found" unless app
tests = project.targets.find { |target| target.name == "MatrixWidgetUITests" }
tests ||= project.new_target(:ui_test_bundle, "MatrixWidgetUITests", :ios, "17.0")
tests.add_dependency(app) unless tests.dependencies.any? { |dependency| dependency.target == app }
group = project.main_group.find_subpath("WidgetUITests", false) || project.main_group.new_group("WidgetUITests", "../UITests")
ref = group.files.find { |file| file.path == "WidgetInteractionTests.swift" } || group.new_file("WidgetInteractionTests.swift")
tests.source_build_phase.add_file_reference(ref) unless tests.source_build_phase.files_references.include?(ref)
tests.build_configurations.each do |config|
  config.build_settings.merge!({
    "PRODUCT_BUNDLE_IDENTIFIER" => "dev.matrix.shell.widget-ui-tests",
    "PRODUCT_NAME" => "MatrixWidgetUITests", "GENERATE_INFOPLIST_FILE" => "YES",
    "SWIFT_VERSION" => "5.0", "IPHONEOS_DEPLOYMENT_TARGET" => "17.0",
    "TARGETED_DEVICE_FAMILY" => "1,2", "TEST_TARGET_NAME" => "App",
    "CODE_SIGN_STYLE" => "Automatic",
  })
  team = app.build_configurations.find { |candidate| candidate.name == config.name }&.build_settings&.fetch("DEVELOPMENT_TEAM", nil)
  config.build_settings["DEVELOPMENT_TEAM"] = team if team
end
project.root_object.attributes["TargetAttributes"] ||= {}
project.root_object.attributes["TargetAttributes"][tests.uuid] = { "TestTargetID" => app.uuid }
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.add_build_target(tests)
scheme.add_test_target(tests)
scheme.save_as(project.path, "MatrixWidgetUITests", true)
project.save
