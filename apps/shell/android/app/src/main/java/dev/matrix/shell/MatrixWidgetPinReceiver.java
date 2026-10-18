package dev.matrix.shell;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 仅通过本应用创建的显式 PendingIntent 接收桌面的成功确认。 */
public final class MatrixWidgetPinReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (MatrixWidgetPin.ACTION_CONFIRMED.equals(intent.getAction()))
            MatrixWidgetPin.confirm(context, intent.getStringExtra("token"));
    }
}
