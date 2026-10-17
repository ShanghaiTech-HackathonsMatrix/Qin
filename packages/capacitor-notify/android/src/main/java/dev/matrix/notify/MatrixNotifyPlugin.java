// ============================================================================
//  Android 通知桥 —— 预留骨架，**未实现、未接线**
// ============================================================================
//
//  激活后这里要做的三件事（现在一件都还没做）：
//
//  1. 授权：Android 13+ 需要运行时权限 POST_NOTIFICATIONS。
//     requestPermission() 里用 @Permission / @PermissionCallback 注解走 Capacitor 的
//     权限流程，别自己调 ActivityCompat.requestPermissions。
//
//  2. 排程：AlarmManager.setExactAndAllowWhileIdle() 需要一个能唤醒的 PendingIntent。
//     - 精确闹钟在 Android 12+ 需要 SCHEDULE_EXACT_ALARM（用户可在设置里关掉）
//     - canScheduleExactAlarms() 为 false 时降级到 setWindow()，并把
//       capabilities().exact 报成 false —— **不要**假装精确
//     - AlarmManager 的闹钟**重启后会丢**，所以 capabilities().lostOnReboot = true，
//       并且要注册 BOOT_COMPLETED 的 receiver 在开机后重排
//
//  3. 展示：闹钟触发时发一个 NotificationCompat 通知，channel 必须建
//     （Android 8+ 没有 channel 的通知会被静默丢弃）。
//     点击的 PendingIntent 里带上 payload，交给 MainActivity 处理。
//
//  为什么用 Java 而不是 Kotlin：`apps/shell/android` 目前**没有配置 Kotlin 插件**
//  （MainActivity 就是 Java）。用 Java 就不必为了一个插件往根 build.gradle 里
//  加 kotlin-gradle-plugin。要换 Kotlin 的话，那一步得一起做。
//
// ============================================================================

package dev.matrix.notify;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "MatrixNotify")
public class MatrixNotifyPlugin extends Plugin {

    private static final String NOT_IMPLEMENTED = "MatrixNotify 的 Android 实现尚未开始（预留骨架）";

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        // 骨架阶段如实报 false —— 宿主据此不会宣称支持 notify.local
        ret.put("supported", false);
        call.resolve(ret);
    }

    @PluginMethod
    public void capabilities(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("exact", false);
        ret.put("maxPending", 0);
        ret.put("lostOnReboot", true);   // Android 的闹钟重启即丢，这一点不会因为实现而改变
        ret.put("requiresPermission", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void checkPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("permission", "unsupported");
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("permission", "unsupported");
        call.resolve(ret);
    }

    @PluginMethod
    public void schedule(PluginCall call) {
        call.reject(NOT_IMPLEMENTED);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        call.reject(NOT_IMPLEMENTED);
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        call.reject(NOT_IMPLEMENTED);
    }

    @PluginMethod
    public void pending(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ids", new com.getcapacitor.JSArray());
        call.resolve(ret);
    }
}
