import ActivityKit
import Foundation

struct MatrixRefreshAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        // These are transport states, never evidence of a platform submission.
        let phase: String
        let message: String
    }
    let requestID: Double
}

enum MatrixRefreshActivity {
    static func begin(requestID: Double, signedIn: Bool) async {
        for activity in Activity<MatrixRefreshAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let state = MatrixRefreshAttributes.ContentState(
            phase: signedIn ? "queued" : "signInRequired",
            message: signedIn ? "正在检查平台 / Checking platforms" : "请先登录平台 / Sign in in app first")
        do {
            let activity = try Activity.request(
                attributes: MatrixRefreshAttributes(requestID: requestID),
                content: ActivityContent(state: state, staleDate: .now.addingTimeInterval(10)),
                pushType: nil)
            // This first version is brief request feedback, not a persistent
            // sync session. Always close it even if a foreground consumer starts.
            try? await Task.sleep(for: .seconds(3))
            await activity.end(nil, dismissalPolicy: .immediate)
        } catch {
            // Optional visual feedback must not prevent the refresh request.
            UserDefaults(suiteName: "group.dev.matrix.shell")?
                .set(String(describing: error), forKey: "ddl.widget.activityError")
        }
    }

    static func update(requestID: Double, phase: String, message: String) async {
        for activity in Activity<MatrixRefreshAttributes>.activities where activity.attributes.requestID == requestID {
            let content = ActivityContent(state: MatrixRefreshAttributes.ContentState(phase: phase, message: message),
                                          staleDate: .now.addingTimeInterval(120))
            if phase == "syncing" {
                await activity.update(content)
            } else {
                await activity.update(content)
                try? await Task.sleep(for: .seconds(2))
                await activity.end(content, dismissalPolicy: .immediate)
            }
        }
    }
}
