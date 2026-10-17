package dev.matrix.notify;

import android.content.*;
import android.util.Log;

public class NotificationReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        PendingResult result = goAsync();
        new Thread(() -> {
            try {
                if ("dev.matrix.notify.FIRE".equals(intent.getAction())) NotificationAlarms.fire(context, intent.getStringExtra("id"));
                else NotificationAlarms.restore(context);
            } catch (Exception e) { Log.e("MatrixNotify", "提醒处理失败：" + e.getClass().getSimpleName()); }
            finally { result.finish(); }
        }, "matrix-notify").start();
    }
}
