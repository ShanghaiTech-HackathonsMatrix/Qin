package dev.matrix.shell;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.SslErrorHandler;
import android.net.http.SslError;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 真机验证 spike，只有 debug 源集会编译。不是生产认证代理，也不接插件网关。
 * WebView 持有自己的 Cookie；原生请求验证关闭页面后的复用能力。
 * 不保存密码、不输出 Cookie、HTML、账号和带查询参数的 URL。
 */
public final class LoginProbeActivity extends Activity {
    private static final String TAG = "QinLoginProbe";
    private static final String GS = "https://www.gradescope.com/account";
    private static final String BB = "https://elearning.shanghaitech.edu.cn:8443/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1";
    private static final String EAMS = "https://eams.shanghaitech.edu.cn/eams/courseTableForStd.action";
    private static final int MAX_BYTES = 5 * 1024 * 1024;
    private static boolean webViewConfigured;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private WebView web;
    private LinearLayout root;
    private TextView status;
    private String provider;
    private String userAgent;
    private boolean busy;
    private boolean pageFailed;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (!webViewConfigured) {
            if (android.os.Build.VERSION.SDK_INT >= 28) WebView.setDataDirectorySuffix("loginprobe");
            webViewConfigured = true;
        }
        // 这是无桥的专用登录 WebView；避免通过远程调试读取账号或会话。
        WebView.setWebContentsDebuggingEnabled(false);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(16, 36, 16, 20);
        status = new TextView(this);
        status.setTextSize(15);
        status.setText("登录验证版：请在官方页面输入账号密码。登录后点击“关闭网页并验证”。\n验证仅输出认证结果与课程入口数量。");
        root.addView(status);
        addButton("Gradescope 邮箱登录", () -> login("gradescope"));
        addButton("BB 学校统一认证", () -> login("blackboard"));
        addButton("教务课表统一认证", () -> login("eams"));
        addButton("关闭网页并验证", () -> verify(provider));
        addButton("只验证 Gradescope 已存会话", () -> verify("gradescope"));
        addButton("只验证 BB 已存会话", () -> verify("blackboard"));
        setContentView(root);
        userAgent = WebSettings.getDefaultUserAgent(this);
        String requested = getIntent().getStringExtra("provider");
        if ("gradescope".equals(requested) || "blackboard".equals(requested) || "eams".equals(requested)) {
            if (getIntent().getBooleanExtra("verify", false)) verify(requested);
            else login(requested);
        }
    }

    private void addButton(String title, Runnable action) {
        Button button = new Button(this);
        button.setText(title);
        button.setOnClickListener(v -> { if (!busy) action.run(); });
        root.addView(button, new LinearLayout.LayoutParams(-1, -2));
    }

    private void report(String text) {
        status.setText(text);
        Log.i(TAG, text);
    }

    private void closeWeb() {
        if (web == null) return;
        web.stopLoading();
        root.removeView(web);
        web.destroy();
        web = null;
        CookieManager.getInstance().flush();
    }

    private void login(String selected) {
        closeWeb();
        provider = selected;
        pageFailed = false;
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                if (!req.isForMainFrame()) return false;
                String host = req.getUrl().getHost();
                // BB 实际返回旧 HTTP 认证入口；已验证同一入口支持 HTTPS。
                // 只升级这个 GET 入口，保留原查询参数，不放行明文登录请求。
                if (!"gradescope".equals(provider) && "GET".equals(req.getMethod()) &&
                    "http".equals(req.getUrl().getScheme()) && "ids.shanghaitech.edu.cn".equals(host) &&
                    (req.getUrl().getPort() == -1 || req.getUrl().getPort() == 80) &&
                    req.getUrl().getUserInfo() == null && "/authserver/login".equals(req.getUrl().getPath())) {
                    view.loadUrl(req.getUrl().buildUpon().scheme("https").encodedAuthority("ids.shanghaitech.edu.cn").build().toString());
                    return true;
                }
                boolean allowed = "https".equals(req.getUrl().getScheme()) && host != null &&
                    ("gradescope".equals(provider)
                        ? host.equals("gradescope.com") || host.endsWith(".gradescope.com")
                        : host.equals("shanghaitech.edu.cn") || host.endsWith(".shanghaitech.edu.cn"));
                if (!allowed) {
                    pageFailed = true;
                    report(provider + "：已阻止跳转，协议 " + req.getUrl().getScheme() + "，域名 " + host);
                }
                return !allowed;
            }
            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                if (pageFailed) return;
                try {
                    report(provider + "：页面加载完成，域名 " + new URL(url).getHost() +
                        "\n请完成登录，再点“关闭网页并验证”。");
                } catch (Exception ignored) { /* 不输出可能包含敏感参数的 URL */ }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError error) {
                if (req.isForMainFrame()) {
                    pageFailed = true;
                    report(provider + "：网页加载失败，错误码 " + error.getErrorCode());
                }
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest req, WebResourceResponse response) {
                if (req.isForMainFrame()) {
                    pageFailed = true;
                    report(provider + "：网页 HTTP 错误 " + response.getStatusCode());
                }
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                pageFailed = true;
                report(provider + "：证书校验失败，错误码 " + error.getPrimaryError());
            }
        });
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        report(provider + "：正在打开官方登录页。");
        web.loadUrl("gradescope".equals(provider) ? GS : "eams".equals(provider) ? EAMS : BB);
    }

    private void verify(String selected) {
        if (selected == null) { report("请先选择平台。"); return; }
        closeWeb();
        provider = selected;
        busy = true;
        report(selected + "：登录网页已关闭，正在用原生 HTTP 验证会话……");
        io.execute(() -> {
            String result;
            try { result = fetch(selected); }
            catch (Exception e) { result = selected + " result=NETWORK_ERROR type=" + e.getClass().getSimpleName(); }
            final String message = result;
            runOnUiThread(() -> {
                busy = false;
                if (!isDestroyed()) report(message);
            });
        });
    }

    private String fetch(String selected) throws Exception {
        URL target = new URL("gradescope".equals(selected) ? GS : "eams".equals(selected) ? EAMS : BB);
        String expectedHost = target.getHost();
        int expectedPort = target.getPort();
        String eamsBody = null;
        for (int hop = 0; hop < 10; hop++) {
            // 不把学校认证重定向当成成功，也不把会话带到认证站点。
            if (!"https".equals(target.getProtocol()) || !target.getHost().equals(expectedHost) ||
                target.getPort() != expectedPort || target.getUserInfo() != null)
                return selected + " result=LOGIN_REQUIRED redirect=true";
            HttpURLConnection conn = (HttpURLConnection) target.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(20000);
            conn.setRequestProperty("User-Agent", userAgent);
            conn.setRequestProperty("Accept", "text/html,application/xhtml+xml");
            conn.setRequestProperty("Cache-Control", "no-cache");
            String cookie = CookieManager.getInstance().getCookie(target.toString());
            if (cookie != null) conn.setRequestProperty("Cookie", cookie);
            if (eamsBody != null) {
                conn.setRequestMethod("POST"); conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                try (java.io.OutputStream out = conn.getOutputStream()) { out.write(eamsBody.getBytes(StandardCharsets.UTF_8)); }
            }
            try {
                int code = conn.getResponseCode();
                for (Map.Entry<String, List<String>> h : conn.getHeaderFields().entrySet()) {
                    if ("Set-Cookie".equalsIgnoreCase(h.getKey()))
                        for (String value : h.getValue()) CookieManager.getInstance().setCookie(target.toString(), value);
                }
                if (code >= 300 && code < 400) {
                    String location = conn.getHeaderField("Location");
                    if (location == null) return selected + " result=UNKNOWN http=" + code;
                    target = new URL(target, location);
                    continue;
                }
                if (code != 200) return selected + " result=HTTP_ERROR http=" + code;
                String html;
                try (InputStream stream = conn.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[8192];
                    int n;
                    while ((n = stream.read(buffer)) != -1) {
                        if (out.size() + n > MAX_BYTES) throw new java.io.IOException("response limit");
                        out.write(buffer, 0, n);
                    }
                    html = out.toString(StandardCharsets.UTF_8.name());
                }
                String lower = html.toLowerCase(Locale.ROOT);
                if ("eams".equals(selected) && eamsBody == null && html.contains("semesterCalendar")) {
                    Matcher student = Pattern.compile("addInput\\(form,\"ids\",\"(\\d+)\"\\)").matcher(html);
                    Matcher term = Pattern.compile("semesterCalendar\\(\\{[^}]*value:\"(\\d+)\"").matcher(html);
                    if (student.find() && term.find()) {
                        eamsBody = "setting.kind=std&startWeek=&semester.id=" + term.group(1) + "&ids=" + student.group(1);
                        target = new URL("https://eams.shanghaitech.edu.cn/eams/courseTableForStd!courseTable.action"); continue;
                    }
                }
                String expression = "gradescope".equals(selected) ? "/courses/(\\d+)" : "course_id=([^&\\\"'<>\\s]+)";
                Matcher matcher = Pattern.compile(expression).matcher(html);
                Set<String> ids = new HashSet<>();
                while (matcher.find()) ids.add(matcher.group(1));
                boolean passwordForm = Pattern.compile("type\\s*=\\s*['\"]password['\"]", Pattern.CASE_INSENSITIVE).matcher(html).find();
                boolean logout = lower.contains("/logout") || lower.contains("/log_out") || lower.contains("logout(" ) || lower.contains("退出登录");
                boolean authenticated = !passwordForm && (!ids.isEmpty() || logout);
                CookieManager.getInstance().flush();
                return selected + " result=" + (authenticated ? "AUTHENTICATED" : passwordForm ? "LOGIN_REQUIRED" : "UNKNOWN") +
                    " http=" + code + " courseLinks=" + ids.size() + " passwordForm=" + passwordForm + " logout=" + logout;
            } finally { conn.disconnect(); }
        }
        return selected + " result=REDIRECT_LIMIT";
    }

    @Override protected void onDestroy() {
        closeWeb();
        io.shutdownNow();
        super.onDestroy();
    }
}
