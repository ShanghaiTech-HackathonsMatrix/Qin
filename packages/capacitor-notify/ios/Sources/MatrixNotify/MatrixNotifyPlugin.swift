import Foundation
import Capacitor
import UserNotifications

/// 在 AppDelegate 启动时安装，保证冷启动的通知点击也能被消费。
public final class MatrixNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    public static let shared = MatrixNotificationDelegate()
    private let payloadKey = "matrix.notify.tap"
    public func install() { UNUserNotificationCenter.current().delegate = self }

    public func userNotificationCenter(_ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    public func userNotificationCenter(_ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void) {
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           let payload = response.notification.request.content.userInfo["payload"] as? String {
            UserDefaults.standard.set(payload, forKey: payloadKey)
        }
        completionHandler()
    }

    func consumeTap() -> String? {
        let payload = UserDefaults.standard.string(forKey: payloadKey)
        UserDefaults.standard.removeObject(forKey: payloadKey)
        return payload
    }
}

enum NotificationValidation {
    static func requests(_ items: [[String: Any]], now: Date = Date()) throws -> [UNNotificationRequest] {
        guard items.count <= 64 else { throw failure("最多同时排程 64 条通知") }
        var seen = Set<String>()
        return try items.map { item in
            guard let id = item["id"] as? String, !id.isEmpty, id.count <= 512,
                  seen.insert(id).inserted,
                  let at = item["at"] as? NSNumber, CFGetTypeID(at) != CFBooleanGetTypeID(),
                  at.doubleValue.isFinite, at.doubleValue < 253_402_300_799_000,
                  at.doubleValue / 1000 > now.timeIntervalSince1970,
                  let title = item["title"] as? String, !title.isEmpty else {
                throw failure("通知需要唯一 ID、非空标题和未来的截止时刻")
            }
            for field in ["body", "payload"] where item[field] != nil && !(item[field] is String) {
                throw failure("通知 \(field) 必须是字符串")
            }
            if let payload = item["payload"] as? String, payload.utf8.count > 2048 {
                throw failure("通知点击数据超过 2048 字节")
            }
            let content = UNMutableNotificationContent()
            content.title = String(title.prefix(256))
            content.body = String((item["body"] as? String ?? "").prefix(2048))
            content.sound = .default
            if let payload = item["payload"] as? String { content.userInfo["payload"] = payload }
            // 系统日历触发器以秒为单位，向上取整，避免提前触发或落入过去。
            let date = Date(timeIntervalSince1970: ceil(at.doubleValue / 1000))
            var components = Calendar(identifier: .gregorian).dateComponents(in: TimeZone(secondsFromGMT: 0)!, from: date)
            components.nanosecond = nil
            let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            return UNNotificationRequest(identifier: id, content: content, trigger: trigger)
        }
    }

    static func failure(_ message: String) -> NSError {
        NSError(domain: "MatrixNotify", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

/// 所有写操作串行，避免并发取消、覆盖和失败回滚互相破坏。
private actor NotificationMutations {
    static let shared = NotificationMutations()
    private var tail: Task<Void, Never>?
    func run(_ operation: @escaping () async throws -> Void) async throws {
        let previous = tail
        let task = Task { await previous?.value; try await operation() }
        tail = Task { _ = try? await task.value }
        try await task.value
    }
}

@objc(MatrixNotifyPlugin)
public class MatrixNotifyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MatrixNotifyPlugin"
    public let jsName = "MatrixNotify"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "schedule", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelAll", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumeTap", returnType: CAPPluginReturnPromise)
    ]
    @objc func isSupported(_ call: CAPPluginCall) { call.resolve(["supported": true]) }
    @objc func capabilities(_ call: CAPPluginCall) {
        call.resolve(["exact": true, "maxPending": 64, "lostOnReboot": false, "requiresPermission": true])
    }
    private func permission(_ settings: UNNotificationSettings) -> String {
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        default: return "prompt"
        }
    }
    @objc func checkPermission(_ call: CAPPluginCall) {
        Task { call.resolve(["permission": permission(await UNUserNotificationCenter.current().notificationSettings())]) }
    }
    @objc func requestPermission(_ call: CAPPluginCall) {
        Task {
            do {
                _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
                call.resolve(["permission": permission(await UNUserNotificationCenter.current().notificationSettings())])
            } catch { call.reject("请求通知权限失败", nil, error) }
        }
    }
    @objc func schedule(_ call: CAPPluginCall) {
        guard let items = call.getArray("items", [String: Any].self) else { call.reject("items 必须是通知数组"); return }
        Task {
            do {
                try await NotificationMutations.shared.run {
                    let requests = try NotificationValidation.requests(items)
                    if requests.isEmpty { return }
                    let center = UNUserNotificationCenter.current()
                    guard self.permission(await center.notificationSettings()) == "granted" else {
                        throw NotificationValidation.failure("请先在应用中授予通知权限")
                    }
                    let old = await center.pendingNotificationRequests()
                    let ids = Set(requests.map(\.identifier))
                    guard Set(old.map(\.identifier)).union(ids).count <= 64 else {
                        throw NotificationValidation.failure("现有通知与新增通知总量超过 64 条")
                    }
                    do {
                        for request in requests { try await center.add(request) }
                    } catch {
                        center.removePendingNotificationRequests(withIdentifiers: Array(ids))
                        var rollbackErrors: [String] = []
                        for request in old where ids.contains(request.identifier) {
                            do { try await center.add(request) }
                            catch { rollbackErrors.append(error.localizedDescription) }
                        }
                        let suffix = rollbackErrors.isEmpty ? "" : "；恢复旧通知失败：" + rollbackErrors.joined(separator: "；")
                        throw NotificationValidation.failure("排程失败：\(error.localizedDescription)\(suffix)")
                    }
                }
                call.resolve()
            } catch { call.reject(error.localizedDescription, nil, error) }
        }
    }
    @objc func cancel(_ call: CAPPluginCall) {
        guard let ids = call.getArray("ids", String.self) else { call.reject("ids 必须是字符串数组"); return }
        mutate(call) { UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ids) }
    }
    @objc func cancelAll(_ call: CAPPluginCall) {
        mutate(call) { UNUserNotificationCenter.current().removeAllPendingNotificationRequests() }
    }
    private func mutate(_ call: CAPPluginCall, operation: @escaping () async throws -> Void) {
        Task {
            do { try await NotificationMutations.shared.run(operation); call.resolve() }
            catch { call.reject(error.localizedDescription, nil, error) }
        }
    }
    @objc func pending(_ call: CAPPluginCall) {
        Task { call.resolve(["ids": await UNUserNotificationCenter.current().pendingNotificationRequests().map(\.identifier).sorted()]) }
    }
    @objc func consumeTap(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(["payload": MatrixNotificationDelegate.shared.consumeTap() as Any? ?? NSNull()]) }
    }
}
