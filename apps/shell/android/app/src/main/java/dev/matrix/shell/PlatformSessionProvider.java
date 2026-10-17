package dev.matrix.shell;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** 独立进程的原生会话代理。应用 WebView 与插件均不能读取这里的 Cookie。 */
public class PlatformSessionProvider extends ContentProvider {
    static boolean configured;
    static String userAgent;
    static synchronized void configure(android.content.Context context) {
        if (configured) return;
        if (android.os.Build.VERSION.SDK_INT >= 28) WebView.setDataDirectorySuffix("platformsessions");
        WebView.setWebContentsDebuggingEnabled(false);
        userAgent = WebSettings.getDefaultUserAgent(context);
        CookieManager.getInstance().setAcceptCookie(true);
        configured = true;
    }
    static String entry(String provider) {
        switch (provider) {
            case "gradescope": return "https://www.gradescope.com/account";
            case "blackboard": return "https://elearning.shanghaitech.edu.cn:8443/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1";
            case "eams": return "https://eams.shanghaitech.edu.cn/eams/courseTableForStd.action";
            default: throw new IllegalArgumentException("未知平台");
        }
    }
    static boolean targetAllowed(String provider, Uri uri) {
        Uri base = Uri.parse(entry(provider));
        return "https".equals(uri.getScheme()) && uri.getUserInfo() == null &&
            base.getHost().equals(uri.getHost()) && effectivePort(base) == effectivePort(uri);
    }
    static int effectivePort(Uri uri) { return uri.getPort() == -1 ? 443 : uri.getPort(); }
    @Override public boolean onCreate() { configure(getContext()); return true; }

    @Override public Bundle call(String method, String arg, Bundle input) {
        Bundle result = new Bundle();
        try {
            if ("clear".equals(method)) {
                java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
                new android.os.Handler(android.os.Looper.getMainLooper()).post(() ->
                    CookieManager.getInstance().removeAllCookies(value -> {
                        CookieManager.getInstance().flush();
                        android.webkit.WebStorage.getInstance().deleteAllData();
                        done.countDown();
                    }));
                if (!done.await(10, java.util.concurrent.TimeUnit.SECONDS)) throw new IOException("清除会话超时");
                result.putBoolean("ok", true); return result;
            }
            if (!"request".equals(method) || input == null) throw new IllegalArgumentException("无效会话操作");
            String provider = input.getString("provider", "");
            String address = input.getString("url", "");
            Uri uri = Uri.parse(address);
            if (!targetAllowed(provider, uri)) throw new SecurityException("平台与目标地址不匹配");
            String verb = input.getString("method", "GET");
            if (!"GET".equals(verb) && !"POST".equals(verb)) throw new SecurityException("仅允许读取平台数据");
            // EAMS 的课表查询使用 POST；禁止借此代理提交作业或改动账号。
            if ("POST".equals(verb) && !("eams".equals(provider) && uri.getPath().startsWith("/eams/courseTableForStd")))
                throw new SecurityException("该平台操作不在同步范围内");
            HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(Math.min(30000, Math.max(1000, input.getInt("timeout", 20000))));
            connection.setReadTimeout(Math.min(30000, Math.max(1000, input.getInt("timeout", 20000))));
            connection.setRequestMethod(verb);
            connection.setRequestProperty("User-Agent", userAgent);
            connection.setRequestProperty("Accept", "text/html,application/json");
            connection.setRequestProperty("Cache-Control", "no-cache");
            connection.setRequestProperty("Accept-Encoding", "identity");
            String cookies = CookieManager.getInstance().getCookie(address);
            if (cookies != null) connection.setRequestProperty("Cookie", cookies);
            try {
                if ("POST".equals(verb)) {
                    connection.setDoOutput(true);
                    connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
                    try (OutputStream out = connection.getOutputStream()) { out.write(input.getString("body", "").getBytes(StandardCharsets.UTF_8)); }
                }
                int status = connection.getResponseCode();
                for (Map.Entry<String,List<String>> h : connection.getHeaderFields().entrySet()) {
                    if ("Set-Cookie".equalsIgnoreCase(h.getKey()))
                        for (String value : h.getValue()) CookieManager.getInstance().setCookie(address, value);
                }
                CookieManager.getInstance().flush();
                JSONObject headers = new JSONObject();
                String location = connection.getHeaderField("Location");
                if (location != null) {
                    Uri next = Uri.parse(new URL(new URL(address), location).toString());
                    if (!targetAllowed(provider, next)) throw new SecurityException("LOGIN_REQUIRED：请重新打开平台登录");
                    headers.put("location", next.toString());
                }
                String contentType = connection.getContentType();
                if (contentType != null) headers.put("content-type", contentType);
                byte[] bytes;
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                try (InputStream in = stream; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                    if (in != null) {
                        byte[] buffer = new byte[8192]; int count;
                        while ((count = in.read(buffer)) != -1) {
                            if (out.size() + count > 5 * 1024 * 1024) throw new IOException("响应超过 5 MiB");
                            out.write(buffer, 0, count);
                        }
                    }
                    bytes = out.toByteArray();
                }
                // 管道跨进程传正文，避免 Binder 的 1 MiB 事务上限；没有临时明文文件。
                ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
                new Thread(() -> { try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) { out.write(bytes); } catch (IOException ignored) {} }, "platform-response").start();
                result.putParcelable("body", pipe[0]); result.putInt("status", status);
                result.putString("headers", headers.toString()); result.putString("url", address);
            } finally { connection.disconnect(); }
        } catch (Exception error) {
            result.putString("error", error instanceof SecurityException ? error.getMessage() : "平台请求失败：" + error.getClass().getSimpleName());
        }
        return result;
    }
    @Override public Cursor query(Uri u, String[] p, String s, String[] a, String o) { throw new UnsupportedOperationException(); }
    @Override public String getType(Uri u) { return null; }
    @Override public Uri insert(Uri u, ContentValues v) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri u, String s, String[] a) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri u, ContentValues v, String s, String[] a) { throw new UnsupportedOperationException(); }
}
