package dev.matrix.shell;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Date;
import java.util.List;
import java.util.TimeZone;

/** 集合中永远只有 DDL / 课程两项；每一项都是固定高度、无内部滚动的整页。 */
public final class MatrixWidgetViewsService extends RemoteViewsService {
    @Override public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Pages(getApplicationContext(), intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1));
    }

    private static final class Pages implements RemoteViewsFactory {
        private final Context c;
        private final int widgetId;
        private JSONObject snapshot;
        private int height, width;

        Pages(Context c, int widgetId) { this.c = c; this.widgetId = widgetId; }
        @Override public void onCreate() { onDataSetChanged(); }
        @Override public void onDataSetChanged() {
            try { snapshot = new JSONObject(MatrixWidgetStore.readSnapshot(c)); }
            catch (Exception ignored) { snapshot = null; }
            AppWidgetManager m = AppWidgetManager.getInstance(c);
            height = px(MatrixWidgetProvider.heightDp(c, m, widgetId));
            width = Math.max(1, px(MatrixWidgetProvider.widthDp(c, m, widgetId) - 24));
        }
        private int px(float dp) { return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, dp, c.getResources().getDisplayMetrics())); }
        private float sp(float value) { return TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value, c.getResources().getDisplayMetrics()); }

        private int textHeight(String text, float size, int lines) {
            TextPaint paint = new TextPaint(android.graphics.Paint.ANTI_ALIAS_FLAG);
            paint.setTextSize(sp(size));
            return StaticLayout.Builder.obtain(text, 0, text.length(), paint, width)
                    .setAlignment(Layout.Alignment.ALIGN_NORMAL).setIncludePad(true)
                    .setMaxLines(lines).setEllipsize(TextUtils.TruncateAt.END).build().getHeight();
        }

        @Override public void onDestroy() {}
        @Override public int getCount() { return 2; }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean hasStableIds() { return true; }
        @Override public int getViewTypeCount() { return 1; }
        @Override public RemoteViews getLoadingView() { return null; }

        @Override public RemoteViews getViewAt(int page) {
            if (page < 0 || page >= 2) return null;
            RemoteViews views = new RemoteViews(c.getPackageName(), R.layout.matrix_widget_page);
            views.setInt(R.id.widget_page, "setMinimumHeight", height);
            views.removeAllViews(R.id.widget_rows);
            Intent tap = new Intent().putExtra("widgetPageIndex", page);
            views.setOnClickFillInIntent(R.id.widget_page, tap);
            int available = height - px(24), shown = 0;
            boolean hasRows = false;
            if (page == 0) {
                JSONArray items = snapshot == null ? null : snapshot.optJSONArray("items");
                hasRows = items != null && items.length() > 0;
                if (items != null) for (int i = 0; i < items.length(); i++) {
                    JSONObject item = items.optJSONObject(i);
                    if (item == null) continue;
                    String title = item.optString("course", "本机任务") + " · " + item.optString("title", "未命名作业");
                    long dueAt = item.optLong("dueAt", 0);
                    String due = dueAt > 0 ? android.text.format.DateFormat.format("yyyy/MM/dd HH:mm", new Date(dueAt)).toString() : "未提供截止时间";
                    int used = px(18) + textHeight(title, 14, 2) + textHeight(due, 12, 2);
                    if (used > available) break;
                    RemoteViews row = new RemoteViews(c.getPackageName(), R.layout.matrix_widget_ddl_row);
                    row.setInt(R.id.widget_ddl_due, "setMaxLines", 2);
                    row.setTextViewText(R.id.widget_ddl_title, title);
                    row.setTextViewText(R.id.widget_ddl_due, due);
                    row.setContentDescription(R.id.widget_ddl_row, item.optString("fullCourse", item.optString("course", "本机任务"))
                            + " · " + item.optString("fullTitle", item.optString("title", "未命名作业")) + "，截止 " + due);
                    row.setOnClickFillInIntent(R.id.widget_ddl_row, new Intent().putExtra("widgetPageIndex", 0).putExtra("widgetItem", item.optString("id", "")));
                    views.addView(R.id.widget_rows, row);
                    available -= used; shown++;
                }
            } else {
                List<MatrixWidgetSchedule.Session> rows = MatrixWidgetSchedule.remaining(
                        MatrixWidgetProvider.sessions(snapshot), System.currentTimeMillis(), TimeZone.getDefault());
                hasRows = !rows.isEmpty();
                for (MatrixWidgetSchedule.Session session : rows) {
                    String when = android.text.format.DateFormat.format("HH:mm", new Date(session.startAt)) + " – "
                            + android.text.format.DateFormat.format("HH:mm", new Date(session.endAt));
                    String where = session.location.isEmpty() ? "地点未提供" : session.location;
                    int used = px(20) + textHeight(session.course, 14, 2) + textHeight(when, 12, 1) + textHeight(where, 12, 1);
                    if (used > available) break;
                    RemoteViews row = new RemoteViews(c.getPackageName(), R.layout.matrix_widget_course_row);
                    row.setTextViewText(R.id.widget_course_title, session.course);
                    row.setTextViewText(R.id.widget_course_when, when);
                    row.setTextViewText(R.id.widget_course_where, where);
                    row.setOnClickFillInIntent(R.id.widget_course_row, tap);
                    views.addView(R.id.widget_rows, row);
                    available -= used; shown++;
                }
            }
            String empty = snapshot == null ? "请先在 App 登录并同步" : page == 0 ? "暂无未完成 DDL" : "今天没有剩余课程";
            if (page == 1 && snapshot != null && !snapshot.optString("scheduleNote", "").isEmpty()) empty = snapshot.optString("scheduleNote");
            if (hasRows && shown == 0) empty = "请放大挂件以完整显示内容";
            views.setTextViewText(R.id.widget_page_empty, empty);
            views.setInt(R.id.widget_page_empty, "setMinimumHeight", Math.max(0, height - px(24)));
            views.setViewVisibility(R.id.widget_page_empty, shown == 0 ? View.VISIBLE : View.GONE);
            views.setOnClickFillInIntent(R.id.widget_page_empty, tap);
            views.setContentDescription(R.id.widget_page, page == 0 ? "未完成 DDL" : "今日剩余课程");
            return views;
        }
    }
}
