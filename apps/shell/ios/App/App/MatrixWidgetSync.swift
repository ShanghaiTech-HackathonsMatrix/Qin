import Foundation
import WidgetKit

/// All readers/writers live in the app process, including LiveActivityIntent.
/// Raw platform data stays in protected app-private files, not the widget defaults.
@MainActor enum MatrixWidgetSync {
    static let defaults = UserDefaults(suiteName: "group.dev.matrix.shell")!
    private static var lease: String?
    private static var engine: MatrixWidgetNativeEngine?
    private static func file(_ name: String) throws -> URL {
        let folder = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                appropriateFor: nil, create: true).appendingPathComponent("WidgetSync", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent(name + ".json")
    }
    private static func read(_ name: String) throws -> Data? {
        let url = try file(name)
        return FileManager.default.fileExists(atPath: url.path) ? try Data(contentsOf: url) : nil
    }
    private static func write(_ data: Data, _ name: String) throws {
        try data.write(to: file(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    static func begin(_ id: String) throws -> [String: Any] {
        guard lease == nil else { return ["acquired": false, "pending": "[]"] }
        lease = id
        do {
            let pending = try read("pending").flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            return ["acquired": true, "pending": MatrixWidgetNativeEngine.json(pending?["snapshots"] ?? []),
                    "generation": pending?["generation"] as? String ?? ""]
        } catch { lease = nil; throw error }
    }
    static func end(_ id: String) { if lease == id { lease = nil } }
    static func acknowledge(_ id: String) throws {
        guard lease == id else { throw MatrixWidgetNativeEngine.error("同步锁已失效") }
        let url = try file("pending")
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
    static func publish(_ data: String) throws {
        guard lease != nil else { throw MatrixWidgetNativeEngine.error("发布需要同步锁") }
        guard let bytes = data.data(using: .utf8),
              (try JSONSerialization.jsonObject(with: bytes)) is [String: Any] else { throw MatrixWidgetNativeEngine.error("同步数据格式无效") }
        try write(bytes, "input")
    }
    static func clear() throws {
        // The foreground reset already owns its lease; only a network run conflicts.
        guard engine == nil else { throw MatrixWidgetNativeEngine.error("平台同步中，请稍后再清除") }
        for name in ["input", "pending"] {
            let url = try file(name)
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        }
    }
    static func finish(requestID: Double, error: String, partial: Bool = false) {
        defaults.set(max(requestID, defaults.double(forKey: "ddl.widget.refreshConsumedAt")), forKey: "ddl.widget.refreshConsumedAt")
        defaults.set(Date().timeIntervalSince1970 * 1000, forKey: "ddl.widget.refreshFinishedAt")
        defaults.set(error, forKey: "ddl.widget.refreshError")
        defaults.set(partial, forKey: "ddl.widget.refreshPartial")
        defaults.set("native", forKey: "ddl.widget.lastRefreshExecutor")
        WidgetCenter.shared.reloadAllTimelines()
    }
    static func refresh(requestID: Double) async {
        // Foreground mutations share this lock, so an older background snapshot
        // cannot overwrite edits. Concurrent taps receive an explicit busy result.
        if lease != nil {
            finish(requestID: requestID, error: "已有同步或保存正在执行，请稍后再试 / Busy")
            return
        }
        let id = UUID().uuidString; lease = id
        defer { lease = nil; engine = nil }
        defaults.set(requestID, forKey: "ddl.widget.refreshStartedAt")
        defaults.set("native", forKey: "ddl.widget.lastRefreshExecutor")
        WidgetCenter.shared.reloadAllTimelines()
        do {
            guard let input = try read("input"),
                  var restored = try JSONSerialization.jsonObject(with: input) as? [String: Any] else {
                throw MatrixWidgetNativeEngine.error("请先在 App 登录平台并同步一次")
            }
            if let journal = try read("pending"),
               let pending = try JSONSerialization.jsonObject(with: journal) as? [String: Any],
               let snapshots = pending["snapshots"] as? [[String: Any]] {
                restored["snapshots"] = snapshots
            }
            let raw = MatrixWidgetNativeEngine.json(restored)
            let runner = MatrixWidgetNativeEngine(); engine = runner
            let result = try await runner.run(input: raw)
            try Task.checkCancellation()
            guard let bytes = result.data(using: .utf8),
                  let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
                throw MatrixWidgetNativeEngine.error("平台同步返回格式无效")
            }
            if let error = object["error"] as? String { throw MatrixWidgetNativeEngine.error(error) }
            guard let data = object["data"] as? [String: Any], let snapshots = data["snapshots"] as? [[String: Any]],
                  let snapshot = object["snapshot"] as? [String: Any], let statuses = object["statuses"] as? [String: String] else {
                throw MatrixWidgetNativeEngine.error("平台未返回完整结果，保留旧信息")
            }
            // Journal first. On the next foreground use the app imports raw snapshots
            // through AcademicService and rebuilds its normal DB and reminders.
            let pending = try JSONSerialization.data(withJSONObject: ["generation": id, "snapshots": snapshots])
            try write(pending, "pending")
            try write(try JSONSerialization.data(withJSONObject: data), "input")
            defaults.set(try JSONSerialization.data(withJSONObject: snapshot), forKey: "ddl.widget.snapshot")
            defaults.set(Date().timeIntervalSince1970 * 1000, forKey: "ddl.widget.snapshotUpdatedAt")
            defaults.set(statuses, forKey: "ddl.widget.lastProviderStatuses")
            let errors = statuses.filter { $0.value != "同步成功" }.sorted { $0.key < $1.key }.map { "\($0.key)：\($0.value)" }
            finish(requestID: requestID, error: errors.joined(separator: "；"),
                   partial: !errors.isEmpty && statuses.values.contains("同步成功"))
            if let events = object["submissions"] as? [[String: String]], !events.isEmpty {
                let items = events.compactMap { event -> MatrixKillDDLAttributes? in
                    guard let eventID = event["eventID"], let title = event["title"], let course = event["course"] else { return nil }
                    return .init(eventID: eventID, title: title, course: course, isDemo: false)
                }
                await MatrixKillDDLPlayer.shared.enqueue(items)
            }
        } catch {
            finish(requestID: requestID, error: error.localizedDescription)
        }
    }
}
