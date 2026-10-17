package dev.matrix.shell;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.io.*;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "PlatformSessions")
public class PlatformSessionsPlugin extends Plugin {
    private boolean loginOpen;
    @PluginMethod public void login(PluginCall call) {
        if (loginOpen) { call.reject("登录窗口已打开"); return; }
        String provider = call.getString("provider", "");
        try { PlatformSessionProvider.entry(provider); } catch (Exception e) { call.reject("未知平台"); return; }
        loginOpen = true;
        Intent intent = new Intent(getContext(), PlatformLoginActivity.class); intent.putExtra("provider", provider);
        startActivityForResult(call, intent, "loginFinished");
    }
    @ActivityCallback private void loginFinished(PluginCall call, ActivityResult result) {
        loginOpen = false;
        if (call == null) return;
        JSObject out = new JSObject(); out.put("completed", result.getResultCode() == Activity.RESULT_OK); call.resolve(out);
    }
    @PluginMethod public void clear(PluginCall call) { perform(call, "clear"); }
    @PluginMethod public void request(PluginCall call) { perform(call, "request"); }
    private void perform(PluginCall call, String operation) {
        getBridge().execute(() -> {
            try {
                Bundle input = new Bundle();
                for (String key : new String[]{"provider", "url", "method", "body"}) input.putString(key, call.getString(key, ""));
                input.putInt("timeout", call.getInt("timeout", 20000));
                Bundle result = getContext().getContentResolver().call(PlatformSessionProvider.URI, operation, null, input);
                if (result == null) throw new IOException("会话进程未响应");
                if (result.containsKey("error")) { call.reject(result.getString("error")); return; }
                JSObject out = new JSObject();
                if ("request".equals(operation)) {
                    ParcelFileDescriptor fd = result.getParcelable("body");
                    try (InputStream in = new ParcelFileDescriptor.AutoCloseInputStream(fd); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                        byte[] buffer = new byte[8192]; int n;
                        while ((n = in.read(buffer)) != -1) { if (bytes.size() + n > 5 * 1024 * 1024) throw new IOException("响应过大"); bytes.write(buffer, 0, n); }
                        out.put("body", bytes.toString(StandardCharsets.UTF_8.name()));
                    }
                    out.put("status", result.getInt("status")); out.put("url", result.getString("url"));
                    out.put("headers", new JSObject(result.getString("headers"))); out.put("followedRedirects", false);
                }
                call.resolve(out);
            } catch (Exception e) { call.reject("会话操作失败：" + e.getClass().getSimpleName()); }
        });
    }
}
