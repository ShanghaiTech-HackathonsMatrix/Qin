import Capacitor
import WidgetKit

@objc(MatrixWidgetPlugin)
public class MatrixWidgetPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MatrixWidgetPlugin"
    public let jsName = "MatrixWidget"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "refreshRequest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishRefresh", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showSubmitted", returnType: CAPPluginReturnPromise),
    ]

    private let appGroup = "group.dev.matrix.shell"

    @objc func showSubmitted(_ call: CAPPluginCall) {
        guard let rows = call.getArray("items", JSObject.self), rows.count <= 100 else {
            call.reject("提交特效事件无效"); return
        }
        var items: [MatrixKillDDLAttributes] = []
        for row in rows {
            guard let eventID = row["eventID"] as? String, !eventID.isEmpty, eventID.count <= 1000,
                  let title = row["title"] as? String, !title.isEmpty, title.count <= 1000,
                  let course = row["course"] as? String, course.count <= 1000 else {
                call.reject("提交特效事件字段无效"); return
            }
            items.append(.init(eventID: eventID, title: title, course: course, isDemo: false))
        }
        Task { await MatrixKillDDLPlayer.shared.enqueue(items) }
        call.resolve()
    }

    @objc func finishRefresh(_ call: CAPPluginCall) {
        guard let requestedAt = call.getDouble("requestedAt"), requestedAt.isFinite,
              let defaults = UserDefaults(suiteName: appGroup) else {
            call.reject("刷新请求无效或 App Group 不可用"); return
        }
        let latest = defaults.double(forKey: "ddl.widget.refreshRequestedAt")
        guard requestedAt <= latest else { call.reject("刷新请求时间无效"); return }
        defaults.set(max(defaults.double(forKey: "ddl.widget.refreshConsumedAt"), requestedAt), forKey: "ddl.widget.refreshConsumedAt")
        defaults.set(call.getString("error") ?? "", forKey: "ddl.widget.refreshError")
        defaults.set(Date().timeIntervalSince1970 * 1000, forKey: "ddl.widget.refreshFinishedAt")
        WidgetCenter.shared.reloadAllTimelines()
        let error = call.getString("error") ?? ""
        Task {
            await MatrixRefreshActivity.update(requestID: requestedAt, phase: error.isEmpty ? "finished" : "failed",
                message: error.isEmpty ? "同步完成 / Updated" : "同步失败，保留原信息 / Failed · Kept previous data")
        }
        call.resolve()
    }

    @objc func setSnapshot(_ call: CAPPluginCall) {
        guard let raw = call.getString("snapshot"),
              let data = raw.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data)) is [String: Any],
              let defaults = UserDefaults(suiteName: appGroup) else {
            call.reject("小组件数据无效或 App Group 不可用")
            return
        }
        defaults.set(data, forKey: "ddl.widget.snapshot")
        defaults.set(call.getBool("hasSyncedPlatforms") ?? false, forKey: "ddl.widget.hasSyncedPlatforms")
        defaults.set(Date().timeIntervalSince1970 * 1000, forKey: "ddl.widget.snapshotUpdatedAt")
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    @objc func refreshRequest(_ call: CAPPluginCall) {
        guard let defaults = UserDefaults(suiteName: appGroup) else {
            call.reject("App Group 不可用")
            return
        }
        let requestedAt = defaults.double(forKey: "ddl.widget.refreshRequestedAt")
        let consumedAt = defaults.double(forKey: "ddl.widget.refreshConsumedAt")
        if requestedAt > consumedAt && defaults.double(forKey: "ddl.widget.refreshStartedAt") < requestedAt {
            defaults.set(requestedAt, forKey: "ddl.widget.refreshStartedAt")
            WidgetCenter.shared.reloadAllTimelines()
            Task {
                await MatrixRefreshActivity.update(requestID: requestedAt, phase: "syncing", message: "正在同步 / Syncing")
            }
        }
        call.resolve([
            "requested": requestedAt > consumedAt,
            "requestedAt": requestedAt > 0 ? requestedAt : NSNull(),
        ])
    }
}
