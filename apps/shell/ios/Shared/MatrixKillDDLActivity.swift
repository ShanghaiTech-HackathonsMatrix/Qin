import ActivityKit
import Foundation

struct MatrixKillDDLAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let progress: Double
    }
    let eventID: String
    let title: String
    let course: String
    let isDemo: Bool
}

// Serial playback keeps a batch of confirmed submissions from competing for the
// compact island. No platform record is changed by this visual feedback.
actor MatrixKillDDLPlayer {
    static let shared = MatrixKillDDLPlayer()
    private var queue: [MatrixKillDDLAttributes] = []
    private var playing = false

    func enqueue(_ items: [MatrixKillDDLAttributes]) async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let defaults = UserDefaults(suiteName: "group.dev.matrix.shell")
        var seen = defaults?.stringArray(forKey: "ddl.kill.seenEvents") ?? []
        for item in items {
            if item.isDemo {
                // Repeated taps during playback merge.
                if playing || queue.contains(where: { $0.isDemo }) { continue }
            } else {
                if seen.contains(item.eventID) { continue }
                seen.append(item.eventID)
            }
            queue.append(item)
        }
        defaults?.set(Array(seen.suffix(100)), forKey: "ddl.kill.seenEvents")
        guard !playing else { return }
        playing = true
        defer { playing = false }
        while !queue.isEmpty {
            let item = queue.removeFirst()
            await play(item, defaults: defaults)
        }
    }

    private func play(_ item: MatrixKillDDLAttributes, defaults: UserDefaults?) async {
        // A refresh and its result belong to one interaction, not two islands.
        for activity in Activity<MatrixRefreshAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        for activity in Activity<MatrixKillDDLAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        do {
            let initial = ActivityContent(state: MatrixKillDDLAttributes.ContentState(progress: 0),
                                          staleDate: .now.addingTimeInterval(20))
            let activity = try Activity.request(attributes: item, content: initial, pushType: nil)
            defaults?.set(Date().timeIntervalSince1970, forKey: "ddl.kill.lastStartedAt")
            // Alerting updates request the system's brief expanded presentation.
            // There is no API to force its dimensions or expansion duration.
            try? await Task.sleep(for: .milliseconds(200))
            if activity.activityState == .active {
                await activity.update(initial, alertConfiguration: AlertConfiguration(
                    title: item.isDemo ? "演示 DDL / Demo DDL" : "作业已提交 / Submitted",
                    body: "查看 DDL 完成效果 / DDL completed", sound: .default))
                try? await Task.sleep(for: .milliseconds(450))
            }
            if activity.activityState == .active {
                await activity.update(ActivityContent(state: .init(progress: 1),
                                                       staleDate: .now.addingTimeInterval(5)))
                try? await Task.sleep(for: .milliseconds(1450))
            }
            await activity.end(nil, dismissalPolicy: .immediate)
            defaults?.set(Date().timeIntervalSince1970, forKey: "ddl.kill.lastFinishedAt")
        } catch {
            defaults?.set(String(describing: error), forKey: "ddl.kill.activityError")
        }
    }
}
