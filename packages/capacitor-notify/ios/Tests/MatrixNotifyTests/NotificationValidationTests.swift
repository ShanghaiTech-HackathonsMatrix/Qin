import XCTest
import UserNotifications
@testable import MatrixNotify

final class NotificationValidationTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func item(_ id: String = "test") -> [String: Any] {
        ["id": id, "at": (now.timeIntervalSince1970 + 120) * 1000,
         "title": "作业提醒", "payload": "opaque:course/assignment"]
    }

    func testAbsoluteTimeAndOpaquePayloadSurviveTimeZoneChanges() throws {
        let request = try XCTUnwrap(NotificationValidation.requests([item()], now: now).first)
        let trigger = try XCTUnwrap(request.trigger as? UNCalendarNotificationTrigger)
        XCTAssertFalse(trigger.repeats)
        XCTAssertEqual(trigger.dateComponents.date?.timeIntervalSince1970 ?? 0,
                       now.timeIntervalSince1970 + 120, accuracy: 1)
        XCTAssertEqual(request.content.userInfo["payload"] as? String, "opaque:course/assignment")
    }

    func testRejectsPastNonFiniteAndBooleanTimes() {
        for at: Any in [now.timeIntervalSince1970 * 1000, Double.infinity, Double.nan, true] {
            var value = item(); value["at"] = at
            XCTAssertThrowsError(try NotificationValidation.requests([value], now: now))
        }
    }

    func testRejectsDuplicateAndOversizedBatches() {
        XCTAssertThrowsError(try NotificationValidation.requests([item(), item()], now: now))
        XCTAssertThrowsError(try NotificationValidation.requests((0..<65).map { item("id-\($0)") }, now: now))
        XCTAssertEqual(try NotificationValidation.requests((0..<64).map { item("id-\($0)") }, now: now).count, 64)
    }

    func testRejectsMalformedPayloadBeforeScheduling() {
        var value = item(); value["payload"] = ["secret": "not a string"]
        XCTAssertThrowsError(try NotificationValidation.requests([value], now: now))
        value["payload"] = String(repeating: "中", count: 1024)
        XCTAssertThrowsError(try NotificationValidation.requests([value], now: now))
    }

    func testEmptyBatchAndMissingFields() throws {
        XCTAssertTrue(try NotificationValidation.requests([], now: now).isEmpty)
        for field in ["id", "at", "title"] {
            var value = item(); value.removeValue(forKey: field)
            XCTAssertThrowsError(try NotificationValidation.requests([value], now: now))
        }
    }
}
