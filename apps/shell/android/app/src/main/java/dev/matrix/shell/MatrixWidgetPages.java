package dev.matrix.shell;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.text.TextUtils;
import android.text.format.DateFormat;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Date;
import java.util.List;
import java.util.TimeZone;

/**
 * 挂件的一页：page 0 = 未完成 DDL，page 1 = 今日剩余课程。
 *
 * 以前这两页是 `RemoteViewsService` 里两个撑满高度的列表项，交给 ListView 去滚 ——
 * 结果就是「自由滚动」而不是翻页：短滑停在两页中间，也看不出总共几页。
 * RemoteViews 没有滚动吸附的接口，所以现在改成一次只渲染一页、点底部圆点切换。
 *
 * 行高是量出来的：按挂件实际尺寸把标题按行折行后算高度，装不下就少放几行，
 * 一行都放不下时给一句「请放大挂件」——而不是让文字被裁掉半截。
 */
final class MatrixWidgetPages {
    static final int PAGE_DDL = 0;
    static final int PAGE_COURSES = 1;
    static final int COUNT = 2;
    /** 底部切换条的高度，算可用行高时要扣掉 */
    static final int BAR_DP = 34;

    private MatrixWidgetPages() {}

    static RemoteViews build(Context c, AppWidgetManager m, int id, int page) {
        int height = MatrixWidgetProvider.heightDp(c, m, id);
        int width = Math.max(1, px(c, MatrixWidgetProvider.widthDp(c, m, id) - 24));
        JSONObject snapshot = snapshot(c);
        RemoteViews views = new RemoteViews(c.getPackageName(), R.layout.matrix_widget_page);
        views.setInt(R.id.widget_page, "setMinimumHeight", px(c, height - BAR_DP));
        views.removeAllViews(R.id.widget_rows);
        // 空白处单击 = 刷新；双击 = 打开课表（第 1 页）或不做（第 0 页）
        views.setOnClickPendingIntent(R.id.widget_page, MatrixWidgetProvider.tapIntent(c, id, page, -1, null));

        int available = px(c, height - BAR_DP - 24), shown = 0;
        boolean hasRows = false;
        if (page == PAGE_DDL) {
            JSONArray items = snapshot == null ? null : snapshot.optJSONArray("items");
            hasRows = items != null && items.length() > 0;
            if (items != null) for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item == null) continue;
                /*
                  第一行必须是**任务**，不是课程。

                  原来这一行拼的是「课程名 · 任务名」，课程名占着主位 —— 挂件本来就窄，
                  于是看得见的是「操作系统」，真正要做的那件事被挤到后面截掉了。
                  课程名降级到第二行、并且排在日期**后面**：窄到要截断时先丢课程名，
                  日期永远留得住。没有课程的条目（course 是占位符「本机任务」）只显示日期。
                */
                String task = item.optString("title", "未命名作业");
                String course = item.optString("course", "").trim();
                boolean hasCourse = !course.isEmpty() && !course.equals("本机任务");
                long dueAt = item.optLong("dueAt", 0);
                String due = dueAt > 0 ? DateFormat.format("yyyy/MM/dd HH:mm", new Date(dueAt)).toString() : "未提供截止时间";
                String meta = hasCourse ? due + " · " + course : due;
                int used = px(c, 18) + textHeight(c, task, 14, 2, width) + textHeight(c, meta, 12, 2, width);
                if (used > available) break;
                RemoteViews row = new RemoteViews(c.getPackageName(), R.layout.matrix_widget_ddl_row);
                row.setInt(R.id.widget_ddl_due, "setMaxLines", 2);
                row.setTextViewText(R.id.widget_ddl_title, task);
                row.setTextViewText(R.id.widget_ddl_due, meta);
                // 读屏仍然先念任务，课程作为补充跟在后面
                row.setContentDescription(R.id.widget_ddl_row,
                        item.optString("fullTitle", task)
                                + (hasCourse ? "，课程 " + item.optString("fullCourse", course) : "")
                                + "，截止 " + due);
                row.setOnClickPendingIntent(R.id.widget_ddl_row,
                        MatrixWidgetProvider.tapIntent(c, id, PAGE_DDL, shown, item.optString("id", "")));
                views.addView(R.id.widget_rows, row);
                available -= used; shown++;
            }
        } else {
            List<MatrixWidgetSchedule.Session> rows = MatrixWidgetSchedule.remaining(
                    MatrixWidgetProvider.sessions(snapshot), System.currentTimeMillis(), TimeZone.getDefault());
            hasRows = !rows.isEmpty();
            for (MatrixWidgetSchedule.Session session : rows) {
                String when = DateFormat.format("HH:mm", new Date(session.startAt)) + " – "
                        + DateFormat.format("HH:mm", new Date(session.endAt));
                String where = session.location.isEmpty() ? "地点未提供" : session.location;
                int used = px(c, 20) + textHeight(c, session.course, 14, 2, width)
                        + textHeight(c, when, 12, 1, width) + textHeight(c, where, 12, 1, width);
                if (used > available) break;
                RemoteViews row = new RemoteViews(c.getPackageName(), R.layout.matrix_widget_course_row);
                row.setTextViewText(R.id.widget_course_title, session.course);
                row.setTextViewText(R.id.widget_course_when, when);
                row.setTextViewText(R.id.widget_course_where, where);
                // 课程行整行点开课表；双击才进 App，单击仍是刷新
                row.setOnClickPendingIntent(R.id.widget_course_row,
                        MatrixWidgetProvider.tapIntent(c, id, PAGE_COURSES, shown, null));
                views.addView(R.id.widget_rows, row);
                available -= used; shown++;
            }
        }

        String empty = snapshot == null ? "请先在 App 登录并同步"
                : page == PAGE_DDL ? "暂无未完成 DDL" : "今天没有剩余课程";
        if (page == PAGE_COURSES && snapshot != null && !snapshot.optString("scheduleNote", "").isEmpty())
            empty = snapshot.optString("scheduleNote");
        if (hasRows && shown == 0) empty = "请放大挂件以完整显示内容";
        views.setTextViewText(R.id.widget_page_empty, empty);
        views.setInt(R.id.widget_page_empty, "setMinimumHeight", Math.max(0, px(c, height - BAR_DP - 24)));
        views.setViewVisibility(R.id.widget_page_empty, shown == 0 ? View.VISIBLE : View.GONE);
        views.setOnClickPendingIntent(R.id.widget_page_empty, MatrixWidgetProvider.tapIntent(c, id, page, -1, null));
        views.setContentDescription(R.id.widget_page, page == PAGE_DDL ? "未完成 DDL" : "今日剩余课程");
        return views;
    }

    private static JSONObject snapshot(Context c) {
        String raw = MatrixWidgetStore.readSnapshot(c);
        if (raw == null) return null;
        try { return new JSONObject(raw); } catch (Exception ignored) { return null; }
    }

    private static int px(Context c, float dp) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, dp, c.getResources().getDisplayMetrics()));
    }

    private static int textHeight(Context c, String text, float size, int lines, int width) {
        TextPaint paint = new TextPaint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        paint.setTextSize(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, size, c.getResources().getDisplayMetrics()));
        return StaticLayout.Builder.obtain(text, 0, text.length(), paint, width)
                .setAlignment(Layout.Alignment.ALIGN_NORMAL).setIncludePad(true)
                .setMaxLines(lines).setEllipsize(TextUtils.TruncateAt.END).build().getHeight();
    }
}
