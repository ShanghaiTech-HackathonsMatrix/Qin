import AppIntents
import WidgetKit

// Compile the same intent into both App and MatrixWidgetExtension. WidgetKit
// needs to resolve the action independently of the SwiftUI view's process.
struct MatrixWidgetRefreshIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "刷新 Matrix / Refresh Matrix"
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult {
        guard let defaults = UserDefaults(suiteName: "group.dev.matrix.shell") else {
            throw IntentError.appGroupUnavailable
        }
        let now = Date().timeIntervalSince1970 * 1000
        defaults.set(now, forKey: "ddl.widget.lastIntentPerformedAt")
        defaults.set(now, forKey: "ddl.widget.refreshRequestedAt")
        if !defaults.bool(forKey: "ddl.widget.hasSyncedPlatforms") {
            defaults.set(now, forKey: "ddl.widget.refreshConsumedAt")
            defaults.set(now, forKey: "ddl.widget.refreshFinishedAt")
            defaults.set("请先在 App 登录平台并同步 / Sign in and sync in app first", forKey: "ddl.widget.refreshError")
        } else {
            defaults.removeObject(forKey: "ddl.widget.refreshError")
        }
        WidgetCenter.shared.reloadAllTimelines()
        await MatrixRefreshActivity.begin(requestID: now, signedIn: defaults.bool(forKey: "ddl.widget.hasSyncedPlatforms"))
        return .result()
    }

    private enum IntentError: Error { case appGroupUnavailable }
}
