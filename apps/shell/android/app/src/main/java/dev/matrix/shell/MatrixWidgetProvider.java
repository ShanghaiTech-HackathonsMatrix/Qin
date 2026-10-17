package dev.matrix.shell;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.widget.RemoteViews;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;

/** 两个固定高度的整页，避免 StackView 的叠层内容与点击区域串页。 */
public final class MatrixWidgetProvider extends AppWidgetProvider {
    public static final String ACTION_REFRESH = "dev.matrix.shell.widget.REFRESH";
    static final String ACTION_TAP = "dev.matrix.shell.widget.TAP";
    private static final String ACTION_CLOCK = "dev.matrix.shell.widget.CLOCK";
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final Map<Integer, Tap> TAPS = new HashMap<>();
    private static final long DOUBLE_TAP_MS = 320;

    private static final class Tap {
        String key;
        long at;
        Runnable action;
    }

    @Override public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        for (int id : ids) refresh(c, m, id, null);
    }

    @Override public void onAppWidgetOptionsChanged(Context c, AppWidgetManager m, int id, Bundle options) {
        refresh(c, m, id, null);
    }

    @Override public void onReceive(Context c, Intent intent) {
        super.onReceive(c, intent);
        String action = intent.getAction();
        if (ACTION_TAP.equals(action)) {
            int id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1);
            if (!active(c, id)) return;
            receiveTap(c.getApplicationContext(), id, intent);
        } else if (ACTION_REFRESH.equals(action)) {
            MatrixWidgetSync.enqueue(c, true, true);
        } else if (ACTION_CLOCK.equals(action) || Intent.ACTION_TIME_CHANGED.equals(action)
                || Intent.ACTION_TIMEZONE_CHANGED.equals(action) || Intent.ACTION_DATE_CHANGED.equals(action)
                || Intent.ACTION_BOOT_COMPLETED.equals(action)) {
            MatrixWidgetSync.refresh(c);
        }
    }

    private void receiveTap(Context c, int id, Intent intent) {
        int page = intent.getIntExtra("widgetPageIndex", 0);
        String item = intent.getStringExtra("widgetItem");
        String key = page + ":" + (item == null ? "" : item);
        long now = SystemClock.uptimeMillis();
        Tap previous = TAPS.remove(id);
        if ((c.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)
            android.util.Log.d("MatrixWidgetTap", "page=" + page + " hasItem=" + (item != null && !item.isEmpty())
                    + " interval=" + (previous == null ? -1 : now - previous.at));
        if (previous != null) {
            MAIN.removeCallbacks(previous.action);
            if (previous.key.equals(key) && now - previous.at <= DOUBLE_TAP_MS
                    && (page == 1 || (item != null && !item.isEmpty()))) {
                // 只传实体标识。MainActivity 从真实快照查找白名单目标，不信任外部 URL。
                Intent open = new Intent(c, MainActivity.class).setAction("matrix-widget-open")
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                if (page == 1) open.putExtra("widgetPage", "timetable");
                else open.putExtra("widgetItem", item);
                try { c.startActivity(open); }
                catch (Exception e) { Toast.makeText(c, "无法打开，请在 App 查看", Toast.LENGTH_SHORT).show(); }
                return;
            }
        }
        Tap tap = new Tap();
        // 不用 goAsync 等待第二击：部分桌面串行派发 PendingIntent 广播，
        // 持有第一击会阻塞第二击，导致所有双击都被误判为两次单击。
        tap.key = key; tap.at = now;
        tap.action = () -> {
            TAPS.remove(id);
            MatrixWidgetSync.enqueue(c, true, true);
        };
        TAPS.put(id, tap);
        MAIN.postDelayed(tap.action, DOUBLE_TAP_MS);
    }

    private static boolean active(Context c, int id) {
        for (int current : AppWidgetManager.getInstance(c).getAppWidgetIds(
                new ComponentName(c, MatrixWidgetProvider.class))) if (id == current) return true;
        return false;
    }

    @Override public void onDeleted(Context c, int[] ids) {
        for (int id : ids) {
            Tap tap = TAPS.remove(id);
            if (tap != null) MAIN.removeCallbacks(tap.action);
            MatrixWidgetStore.removeLocalRead(c, id);
        }
    }

    @Override public void onDisabled(Context c) {
        AlarmManager alarm = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (alarm != null) alarm.cancel(clockIntent(c));
    }

    public static void refresh(Context c, AppWidgetManager m, int id, String unused) {
        RemoteViews views = new RemoteViews(c.getPackageName(), R.layout.matrix_widget);
        Intent adapter = new Intent(c, MatrixWidgetViewsService.class)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                .setData(Uri.parse("matrix-widget://pages/" + id));
        views.setRemoteAdapter(R.id.widget_pages, adapter);
        Intent tap = new Intent(c, MatrixWidgetProvider.class).setAction(ACTION_TAP)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                .setData(Uri.parse("matrix-widget://tap/" + id));
        views.setPendingIntentTemplate(R.id.widget_pages, PendingIntent.getBroadcast(c, id, tap,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0)));
        m.updateAppWidget(id, views);
        m.notifyAppWidgetViewDataChanged(id, R.id.widget_pages);
        MatrixWidgetStore.markLocalRead(c, id);
        scheduleClock(c, MatrixWidgetStore.readSnapshot(c));
    }

    static int heightDp(Context c, AppWidgetManager m, int id) {
        boolean landscape = c.getResources().getConfiguration().orientation
                == android.content.res.Configuration.ORIENTATION_LANDSCAPE;
        int value = m.getAppWidgetOptions(id).getInt(landscape
                ? AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT : AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 220);
        return value > 0 ? value : 220;
    }

    static int widthDp(Context c, AppWidgetManager m, int id) {
        boolean landscape = c.getResources().getConfiguration().orientation
                == android.content.res.Configuration.ORIENTATION_LANDSCAPE;
        int value = m.getAppWidgetOptions(id).getInt(landscape
                ? AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH : AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 280);
        return value > 0 ? value : 280;
    }

    static List<MatrixWidgetSchedule.Session> sessions(JSONObject root) {
        List<MatrixWidgetSchedule.Session> result = new ArrayList<>();
        JSONArray sessions = root == null ? null : root.optJSONArray("schedule");
        if (sessions == null) return result;
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject row = sessions.optJSONObject(i);
            if (row == null) continue;
            long start = row.optLong("startAt", 0), end = row.optLong("endAt", 0);
            if (start <= 0 || end <= start) continue;
            result.add(new MatrixWidgetSchedule.Session(row.optString("course", "未命名课程"),
                    row.isNull("location") ? "" : row.optString("location", ""), start, end));
        }
        return result;
    }

    private static PendingIntent clockIntent(Context c) {
        return PendingIntent.getBroadcast(c, 0, new Intent(c, MatrixWidgetProvider.class).setAction(ACTION_CLOCK),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void scheduleClock(Context c, String raw) {
        JSONObject root = null;
        try { if (raw != null) root = new JSONObject(raw); } catch (Exception ignored) {}
        long next = MatrixWidgetSchedule.nextChange(sessions(root), System.currentTimeMillis(), TimeZone.getDefault());
        AlarmManager alarm = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        // 无须额外闹钟权限；省电状态可能延迟，点按/系统周期更新会重算。
        if (alarm != null) alarm.setWindow(AlarmManager.RTC, next, 10 * 60_000L, clockIntent(c));
    }
}
