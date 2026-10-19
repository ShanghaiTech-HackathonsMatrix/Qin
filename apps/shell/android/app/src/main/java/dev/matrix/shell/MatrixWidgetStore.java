package dev.matrix.shell;

import android.content.Context;

/** App 与小组件之间的最小本地快照存储；实际同步服务接入后由主 App 写入。 */
public final class MatrixWidgetStore {
    private static final String PREFS = "matrix_widget";
    private static final String SNAPSHOT = "snapshot";
    private static final String REFRESH_REQUESTED_AT = "refresh_requested_at";
    private static final String LOCAL_READ_AT = "local_read_at_";

    private MatrixWidgetStore() {}

    public static String readSnapshot(Context context) {
        return MatrixWidgetSync.prefs(context).getString(SNAPSHOT, null);
    }

    public static void markRefreshRequested(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putLong(REFRESH_REQUESTED_AT, System.currentTimeMillis()).apply();
    }

    static void markLocalRead(Context context, int widgetId) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putLong(LOCAL_READ_AT + widgetId, System.currentTimeMillis()).apply();
    }

    static long lastLocalRead(Context context, int widgetId) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(LOCAL_READ_AT + widgetId, 0);
    }

    /**
     * 每个挂件当前停在哪一页。
     *
     * 页码存在本地而不是靠 ListView 的滚动位置 —— 现在一次只渲染一页，
     * 页码是唯一真相；删挂件时随 `removeLocalRead` 一起清掉。
     */
    static int readPage(Context context, int widgetId) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt("page_" + widgetId, 0) == 1 ? 1 : 0;
    }

    static void writePage(Context context, int widgetId, int page) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putInt("page_" + widgetId, page == 1 ? 1 : 0).apply();
    }

    static void removeLocalRead(Context context, int widgetId) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(LOCAL_READ_AT + widgetId).remove("page_" + widgetId).apply();
    }
}
