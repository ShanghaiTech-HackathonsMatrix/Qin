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
        defaults.removeObject(forKey: "ddl.widget.refreshError")
        WidgetCenter.shared.reloadAllTimelines()
        async let feedback: Void = MatrixRefreshActivity.begin(requestID: now,
            signedIn: defaults.bool(forKey: "ddl.widget.hasSyncedPlatforms"))
        #if MATRIX_APP
        await MatrixWidgetSync.refresh(requestID: now)
        #else
        // LiveActivityIntent is expected to execute in the containing app.
        // An unexpected extension execution must not pretend that networking ran.
        defaults.set(now, forKey: "ddl.widget.refreshConsumedAt")
        defaults.set(Date().timeIntervalSince1970 * 1000, forKey: "ddl.widget.refreshFinishedAt")
        defaults.set("原生同步进程未启动，请打开 App 一次后重试", forKey: "ddl.widget.refreshError")
        WidgetCenter.shared.reloadAllTimelines()
        #endif
        await feedback
        return .result()
    }

    private enum IntentError: Error { case appGroupUnavailable }
}
