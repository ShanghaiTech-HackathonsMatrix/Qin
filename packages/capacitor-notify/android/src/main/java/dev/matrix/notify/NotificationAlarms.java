package dev.matrix.notify;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import org.json.*;
import java.util.*;

/** 同一进程内串行修改；提醒内容仅写入应用私有目录。 */
final class NotificationAlarms {
    static final int LIMIT = 400;
    private static final String CHANNEL = "matrix_academic";
    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("matrix-notifications", Context.MODE_PRIVATE); }
    private static JSONObject read(Context c) throws JSONException { return new JSONObject(prefs(c).getString("pending", "{}")); }
    private static void save(Context c, JSONObject data) throws Exception {
        if (!prefs(c).edit().putString("pending", data.toString()).commit()) throw new Exception("无法保存提醒");
    }
    private static AlarmManager manager(Context c) { return (AlarmManager)c.getSystemService(Context.ALARM_SERVICE); }
    private static PendingIntent intent(Context c, String id, boolean create) {
        Intent i = new Intent(c, NotificationReceiver.class).setAction("dev.matrix.notify.FIRE")
            .setData(new Uri.Builder().scheme("matrix-notify").authority("alarm").appendPath(id).build()).putExtra("id", id);
        return PendingIntent.getBroadcast(c, 0, i, PendingIntent.FLAG_IMMUTABLE |
            (create ? PendingIntent.FLAG_UPDATE_CURRENT : PendingIntent.FLAG_NO_CREATE));
    }
    private static void remove(Context c, String id) {
        PendingIntent pi = intent(c, id, false);
        if (pi != null) { manager(c).cancel(pi); pi.cancel(); }
        NotificationManagerCompat.from(c).cancel(id, 1);
    }
    private static void arm(Context c, JSONObject item) throws Exception {
        long at = item.getLong("at");
        if (at <= System.currentTimeMillis()) { remove(c, item.getString("id")); return; }
        PendingIntent pi = intent(c, item.getString("id"), true);
        AlarmManager a = manager(c);
        if (Build.VERSION.SDK_INT < 31 || a.canScheduleExactAlarms()) a.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        else a.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
    }
    static synchronized void schedule(Context c, JSONArray items) throws Exception {
        JSONObject old = read(c), next = new JSONObject(old.toString());
        Set<String> touched = new HashSet<>(); long now = System.currentTimeMillis();
        // 整批验证完成后才改动系统闹钟。
        for (int n = 0; n < items.length(); n++) {
            JSONObject item = items.getJSONObject(n); String id = item.getString("id");
            double at = item.getDouble("at");
            if (id.isEmpty() || id.length() > 512 || !touched.add(id) || !Double.isFinite(at) || at <= now || at != Math.floor(at)
                || item.getString("title").trim().isEmpty() || item.getString("title").length() > 500)
                throw new IllegalArgumentException("通知编号、标题或时间无效");
            next.put(id, item);
        }
        if (next.length() > LIMIT) throw new IllegalArgumentException("待提醒总数超过 " + LIMIT);
        try {
            for (String id : touched) arm(c, next.getJSONObject(id));
            save(c, next);
        } catch (Exception e) {
            // 系统 API 没有事务；恢复失败须带回错误。
            for (String id : touched) {
                try { remove(c, id); if (old.has(id)) arm(c, old.getJSONObject(id)); }
                catch (Exception rollback) { e.addSuppressed(rollback); }
            }
            throw e;
        }
    }
    static synchronized JSONArray pending(Context c) throws Exception {
        JSONObject data = read(c); JSONArray ids = new JSONArray();
        for (Iterator<String> it = data.keys(); it.hasNext();) {
            String id = it.next(); if (intent(c, id, false) != null) ids.put(id);
        }
        return ids;
    }
    static synchronized void cancel(Context c, JSONArray ids) throws Exception {
        JSONObject data = read(c);
        for (int n = 0; n < ids.length(); n++) { String id = ids.getString(n); remove(c, id); data.remove(id); }
        save(c, data);
    }
    static synchronized void cancelAll(Context c) throws Exception {
        JSONObject data = read(c); JSONArray ids = new JSONArray(); data.keys().forEachRemaining(ids::put); cancel(c, ids);
    }
    static synchronized void restore(Context c) throws Exception {
        JSONObject data = read(c); long now = System.currentTimeMillis();
        ArrayList<String> expired = new ArrayList<>();
        for (Iterator<String> it = data.keys(); it.hasNext();) {
            String id = it.next(); JSONObject item = data.getJSONObject(id);
            if (item.getLong("at") > now) arm(c, item); else expired.add(id);
        }
        for (String id : expired) { remove(c, id); data.remove(id); }
        save(c, data);
    }
    static synchronized void fire(Context c, String id) throws Exception {
        JSONObject data = read(c), item = data.optJSONObject(id);
        PendingIntent pi = intent(c, id, false); if (pi != null) pi.cancel();
        if (item == null) return;
        if (item.getLong("at") > System.currentTimeMillis() + 1000) { arm(c, item); return; }
        data.remove(id); save(c, data);
        NotificationManager nm = (NotificationManager)c.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "课程与作业提醒", NotificationManager.IMPORTANCE_HIGH));
        Intent open = c.getPackageManager().getLaunchIntentForPackage(c.getPackageName());
        if (open == null) return;
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .setData(new Uri.Builder().scheme("matrix-notify").authority("open").appendPath(id).build())
            .putExtra("matrix.notification.payload", item.optString("payload", ""));
        PendingIntent tap = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder notification = new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(item.getString("title"))
            .setContentText(item.optString("body", "")).setStyle(new NotificationCompat.BigTextStyle().bigText(item.optString("body", "")))
            .setContentIntent(tap).setAutoCancel(true).setPriority(NotificationCompat.PRIORITY_HIGH);
        if (NotificationManagerCompat.from(c).areNotificationsEnabled()) NotificationManagerCompat.from(c).notify(id, 1, notification.build());
    }
}
