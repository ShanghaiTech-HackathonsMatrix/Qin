package dev.matrix.shell;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
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

/** 一次只渲染一页，点底部圆点切换；页内是静态行，没有嵌套滚动。 */
public final class MatrixWidgetProvider extends AppWidgetProvider {
    public static final String ACTION_REFRESH = "dev.matrix.shell.widget.REFRESH";
    static final String ACTION_TAP = "dev.matrix.shell.widget.TAP";
    private static final String ACTION_FLIP = "dev.matrix.shell.widget.FLIP";
    private static final String EXTRA_TARGET_PAGE = "widgetTargetPage";
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
        } else if (ACTION_FLIP.equals(action)) {
            // 点底部圆点：换页只改本地页码，不联网、不打扰用户
            int id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1);
            if (!active(c, id)) return;
            int page = intent.getIntExtra(EXTRA_TARGET_PAGE, 0) == 1 ? 1 : 0;
            MatrixWidgetStore.writePage(c, id, page);
            refresh(c, AppWidgetManager.getInstance(c), id, null);
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
        int page = MatrixWidgetStore.readPage(c, id);
        RemoteViews views = new RemoteViews(c.getPackageName(), R.layout.matrix_widget);
        views.removeAllViews(R.id.widget_page_host);
        views.addView(R.id.widget_page_host, MatrixWidgetPages.build(c, m, id, page));
        views.setTextViewText(R.id.widget_page_label, c.getString(page == MatrixWidgetPages.PAGE_DDL
                ? R.string.widget_page_ddl : R.string.widget_page_courses));
        views.setImageViewResource(R.id.widget_dot_0, page == MatrixWidgetPages.PAGE_DDL
                ? R.drawable.widget_dot_on : R.drawable.widget_dot_off);
        views.setImageViewResource(R.id.widget_dot_1, page == MatrixWidgetPages.PAGE_COURSES
                ? R.drawable.widget_dot_on : R.drawable.widget_dot_off);
        views.setOnClickPendingIntent(R.id.widget_dot_hit_0, flipIntent(c, id, MatrixWidgetPages.PAGE_DDL));
        views.setOnClickPendingIntent(R.id.widget_dot_hit_1, flipIntent(c, id, MatrixWidgetPages.PAGE_COURSES));
        m.updateAppWidget(id, views);
        MatrixWidgetStore.markLocalRead(c, id);
        scheduleClock(c, MatrixWidgetStore.readSnapshot(c));
    }

    /**
     * 换页用的广播。
     *
     * 两个目标页各给一条独立的 data URI —— PendingIntent 的身份是
     * (Intent 的 action/data/component + requestCode)，只靠 requestCode 区分
     * 在挂件 id 很大时会溢出，靠 data 则永远唯一。
     */
    private static PendingIntent flipIntent(Context c, int id, int page) {
        Intent intent = new Intent(c, MatrixWidgetProvider.class).setAction(ACTION_FLIP)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                .putExtra(EXTRA_TARGET_PAGE, page)
                .setData(Uri.parse("matrix-widget://flip/" + id + "/" + page));
        return PendingIntent.getBroadcast(c, 2, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * 行/空白处的单击广播。
     *
     * 以前靠 `setPendingIntentTemplate` + fill-in intent 让集合自己填 extras；
     * 现在不走集合了，每一行必须是**独立**的 PendingIntent：同一条 PendingIntent
     * 的 extras 会被最后一次写入覆盖，点哪行都会开同一个条目。
     * 所以 data 里带上 (页, 行号) 作为身份。
     */
    static PendingIntent tapIntent(Context c, int id, int page, int index, String item) {
        int slot = index + 1; // -1（整页/空白）落到 0，行号从 1 起
        Intent intent = new Intent(c, MatrixWidgetProvider.class).setAction(ACTION_TAP)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                .putExtra("widgetPageIndex", page)
                .setData(Uri.parse("matrix-widget://tap/" + id + "/" + page + "/" + slot));
        if (item != null) intent.putExtra("widgetItem", item);
        return PendingIntent.getBroadcast(c, 1, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
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
