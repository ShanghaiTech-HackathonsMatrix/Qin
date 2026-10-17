package dev.matrix.notify;

import android.Manifest;
import android.app.AlarmManager;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "MatrixNotify", permissions = {
    @Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})
})
public class MatrixNotifyPlugin extends Plugin {
    @PluginMethod public void isSupported(PluginCall call) { call.resolve(new JSObject().put("supported", true)); }
    @PluginMethod public void capabilities(PluginCall call) {
        AlarmManager alarms = (AlarmManager)getContext().getSystemService(android.content.Context.ALARM_SERVICE);
        call.resolve(new JSObject().put("exact", Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms())
            .put("maxPending", NotificationAlarms.LIMIT).put("lostOnReboot", false).put("requiresPermission", true));
    }
    private String permission() {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED)
            return getPermissionState("notifications") == PermissionState.DENIED ? "denied" : "prompt";
        return NotificationManagerCompat.from(getContext()).areNotificationsEnabled() ? "granted" : "denied";
    }
    @PluginMethod public void checkPermission(PluginCall call) { call.resolve(new JSObject().put("permission", permission())); }
    @PluginMethod public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED)
            requestPermissionForAlias("notifications", call, "permissionResult");
        else checkPermission(call);
    }
    @PermissionCallback private void permissionResult(PluginCall call) { checkPermission(call); }
    @PluginMethod public void schedule(PluginCall call) {
        if (!"granted".equals(permission())) { call.reject("通知权限未开启"); return; }
        try {
            JSONArray items = call.getArray("items");
            if (items == null) throw new IllegalArgumentException("缺少通知列表");
            NotificationAlarms.schedule(getContext(), items); call.resolve();
        } catch (Exception e) { call.reject("通知排程失败：" + e.getMessage()); }
    }
    @PluginMethod public void cancel(PluginCall call) {
        try {
            JSONArray ids = call.getArray("ids");
            if (ids == null) throw new IllegalArgumentException("缺少通知编号");
            NotificationAlarms.cancel(getContext(), ids); call.resolve();
        } catch (Exception e) { call.reject("取消提醒失败：" + e.getMessage()); }
    }
    @PluginMethod public void cancelAll(PluginCall call) {
        try { NotificationAlarms.cancelAll(getContext()); call.resolve(); }
        catch (Exception e) { call.reject("清除提醒失败：" + e.getMessage()); }
    }
    @PluginMethod public void pending(PluginCall call) {
        try { call.resolve(new JSObject().put("ids", new JSArray(NotificationAlarms.pending(getContext()).toString()))); }
        catch (Exception e) { call.reject("读取提醒失败：" + e.getMessage()); }
    }
    @PluginMethod public void consumeTap(PluginCall call) {
        Intent intent = getActivity().getIntent();
        String payload = intent == null ? null : intent.getStringExtra("matrix.notification.payload");
        if (intent != null) intent.removeExtra("matrix.notification.payload");
        call.resolve(new JSObject().put("payload", payload == null ? JSONObject.NULL : payload));
    }
}
