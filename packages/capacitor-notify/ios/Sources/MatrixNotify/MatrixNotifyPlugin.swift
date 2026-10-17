// ============================================================================
//  iOS 通知桥 —— 预留骨架，**未实现、未接线**
// ============================================================================
//
//  激活后这里要做的三件事（现在一件都还没做）：
//
//  1. 授权：UNUserNotificationCenter.requestAuthorization(options: [.alert, .sound, .badge])。
//     只能在用户主动操作后调用 —— 启动时静默调用会被系统直接判 denied 且难恢复。
//     checkPermission() 用 getNotificationSettings() 读，**不弹窗**。
//
//  2. 排程：UNCalendarNotificationTrigger / UNTimeIntervalNotificationTrigger，
//     identifier 就是我们的 id —— 同 id 再 add 是覆盖，天然满足「覆盖式排程」。
//     硬约束：**系统只保留最近 64 条**未触发的本地通知，超出会被静默丢弃（不报错）。
//     所以 capabilities().maxPending 必须是 64，宿主据此做滚动窗口。
//
//  3. 展示：UNMutableNotificationContent 里设 title/body/sound，
//     userInfo 原样塞 payload。点击回调走 UNUserNotificationCenterDelegate。
//
//  和 Android 的关键差异（都是**数据**，不是分支）：
//    exact            = true   （iOS 的本地通知到点就响，不需要特殊权限）
//    maxPending       = 64     （Android 没有这个硬上限）
//    lostOnReboot     = false  （iOS 的通知由系统持久化，重启不丢）
//    requiresPermission = true
//
//  也就是说 iOS 反而**更简单**，代价是那个 64 的上限。
//
// ============================================================================

import Foundation
import Capacitor

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

    private let notImplemented = "MatrixNotify 的 iOS 实现尚未开始（预留骨架）"

    @objc func isSupported(_ call: CAPPluginCall) {
        // 骨架阶段如实报 false —— 宿主据此不会宣称支持 notify.local
        call.resolve(["supported": false])
    }

    @objc func capabilities(_ call: CAPPluginCall) {
        call.resolve([
            "exact": false,
            "maxPending": 0,
            "lostOnReboot": false,
            "requiresPermission": true
        ])
    }

    @objc func checkPermission(_ call: CAPPluginCall) {
        call.resolve(["permission": "unsupported"])
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        call.resolve(["permission": "unsupported"])
    }

    @objc func schedule(_ call: CAPPluginCall) {
        call.reject(notImplemented)
    }

    @objc func cancel(_ call: CAPPluginCall) {
        call.reject(notImplemented)
    }

    @objc func cancelAll(_ call: CAPPluginCall) {
        call.reject(notImplemented)
    }

    @objc func pending(_ call: CAPPluginCall) {
        call.resolve(["ids": [String]()])
    }
    @objc func consumeTap(_ call: CAPPluginCall) { call.resolve(["payload": NSNull()]) }
}
