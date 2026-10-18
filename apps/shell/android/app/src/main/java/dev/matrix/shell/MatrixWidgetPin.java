package dev.matrix.shell;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import com.getcapacitor.JSObject;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

/** 添加请求与实际添加分开记录；不把超时、取消或已有挂件当作本次成功。 */
final class MatrixWidgetPin {
    static final long WAIT_MS = 15000;
    static final String ACTION_CONFIRMED = "dev.matrix.shell.widget.PIN_CONFIRMED";
    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("matrix-widget-pin", Context.MODE_PRIVATE);
    }
    private static Set<String> installed(Context c) {
        int[] ids = AppWidgetManager.getInstance(c).getAppWidgetIds(new ComponentName(c, MatrixWidgetProvider.class));
        Set<String> result = new HashSet<>();
        for (int id : ids) result.add(Integer.toString(id));
        return result;
    }
    static String evaluate(String token, boolean callback, Set<String> before, Set<String> current, long age) {
        if (token.isEmpty()) return "idle";
        if (callback || !before.containsAll(current)) return "confirmed";
        return age >= 0 && age < WAIT_MS ? "requested" : "unconfirmed";
    }
    static boolean acceptsCallback(String expected, String actual) {
        return !expected.isEmpty() && expected.equals(actual);
    }
    static synchronized JSObject state(Context c) {
        SharedPreferences p = prefs(c);
        Set<String> ids = installed(c);
        String status = evaluate(p.getString("token", ""), p.getBoolean("confirmed", false),
            p.getStringSet("before", new HashSet<>()), ids, System.currentTimeMillis() - p.getLong("requestedAt", 0));
        if ("confirmed".equals(status) && !p.getBoolean("confirmed", false))
            p.edit().putBoolean("confirmed", true).apply();
        boolean supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && AppWidgetManager.getInstance(c).isRequestPinAppWidgetSupported();
        return new JSObject().put("supported", supported).put("widgetCount", ids.size()).put("status", status);
    }
    static synchronized JSObject request(Context c) {
        JSObject initial = state(c);
        if (!initial.optBoolean("supported")) return initial;
        if ("requested".equals(initial.optString("status"))) return initial;
        String token = UUID.randomUUID().toString();
        // 在系统调用之前落盘，避免快速成功回调先到达；进程重建后仍可核对。
        prefs(c).edit().putString("token", token).putLong("requestedAt", System.currentTimeMillis())
            .putStringSet("before", installed(c)).putBoolean("confirmed", false).apply();
        Intent result = new Intent(c, MatrixWidgetPinReceiver.class).setAction(ACTION_CONFIRMED)
            .setData(Uri.parse("qin-widget-pin:" + token)).putExtra("token", token);
        PendingIntent callback = null;
        try {
            callback = PendingIntent.getBroadcast(c, 0, result,
                PendingIntent.FLAG_ONE_SHOT | PendingIntent.FLAG_IMMUTABLE);
            boolean accepted = AppWidgetManager.getInstance(c).requestPinAppWidget(
                new ComponentName(c, MatrixWidgetProvider.class), null, callback);
            if (!accepted) throw new IllegalStateException("桌面未接受请求");
            // 请求发出后不再同步查询桌面；后续查询失败也不能抹掉已发出的请求。
            return initial.put("status", "requested");
        } catch (RuntimeException e) {
            if (callback != null) callback.cancel();
            prefs(c).edit().clear().apply();
            throw e;
        }
    }
    static synchronized void confirm(Context c, String token) {
        SharedPreferences p = prefs(c);
        if (acceptsCallback(p.getString("token", ""), token))
            p.edit().putBoolean("confirmed", true).apply();
    }
}
