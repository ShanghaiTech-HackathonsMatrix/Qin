import AppIntents
import Foundation
import WidgetKit

struct MatrixKillDDLDemoIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "模拟提交演示 DDL / Demo submit"
    static let openAppWhenRun = false

    @Parameter(title: "重新加入演示 / Restore demo")
    var restore: Bool

    init() { restore = false }
    init(restore: Bool) { self.restore = restore }

    func perform() async throws -> some IntentResult {
        // This state only controls the isolated demo row, never real tasks.
        guard let defaults = UserDefaults(suiteName: "group.dev.matrix.shell") else {
            throw DemoError.containerUnavailable
        }
        if restore {
            defaults.set(false, forKey: "ddl.kill.demoCleared")
            WidgetCenter.shared.reloadTimelines(ofKind: "MatrixDDLWidget")
            return .result()
        }
        guard !defaults.bool(forKey: "ddl.kill.demoCleared") else { return .result() }
        defaults.set(true, forKey: "ddl.kill.demoCleared")
        WidgetCenter.shared.reloadTimelines(ofKind: "MatrixDDLWidget")
        await MatrixKillDDLPlayer.shared.enqueue([
            MatrixKillDDLAttributes(eventID: UUID().uuidString,
                                    title: "演示作业 / Demo DDL", course: "演示课程 / Demo course", isDemo: true)
        ])
        return .result()
    }

    private enum DemoError: Error { case containerUnavailable }
}
