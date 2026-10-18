import XCTest

final class WidgetInteractionTests: XCTestCase {
    // Precondition: add a Matrix DDL widget to a Home Screen before running.
    func testTappingDDLWidgetDoesNotOpenApp() throws {
        continueAfterFailure = false
        XCUIDevice.shared.press(.home)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let refresh = springboard.buttons["matrix.widget.refresh.ddl"].firstMatch
        var found = refresh.waitForExistence(timeout: 5)
        for _ in 0..<5 where !found {
            springboard.swipeLeft()
            found = refresh.waitForExistence(timeout: 2)
        }
        let screenshot = XCTAttachment(screenshot: springboard.screenshot())
        screenshot.name = "Widget before interaction"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCTAssertTrue(found, "Home Screen must expose the DDL refresh App Intent button")
        refresh.tap()
        let matrix = XCUIApplication(bundleIdentifier: "dev.matrix.shell")
        let stayedOnHomeScreen = NSPredicate { _, _ in matrix.state != .runningForeground }
        expectation(for: stayedOnHomeScreen, evaluatedWith: nil)
        waitForExpectations(timeout: 5)
        // Check again after the launch animation could have completed.
        RunLoop.current.run(until: Date().addingTimeInterval(3))
        XCTAssertNotEqual(matrix.state, .runningForeground, "Widget refresh must not present the app")
    }
}
