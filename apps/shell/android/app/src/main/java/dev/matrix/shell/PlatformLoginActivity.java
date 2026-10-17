package dev.matrix.shell;

import android.app.Activity;
import android.os.Bundle;
import android.net.Uri;
import android.net.http.SslError;
import android.webkit.*;
import android.widget.*;

/** 专用无桥登录页，与主 WebView 分进程。只在用户操作时打开。 */
public class PlatformLoginActivity extends Activity {
    private WebView web;
    private TextView status;
    private String provider;
    private boolean failed;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        PlatformSessionProvider.configure(this);
        provider = getIntent().getStringExtra("provider");
        String entry;
        try { entry = PlatformSessionProvider.entry(provider); } catch (Exception e) { finish(); return; }
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(16, 36, 16, 24);
        status = new TextView(this); status.setText("请在官方页面登录。完成后点击下方按钮验证并同步。"); root.addView(status);
        Button done = new Button(this); done.setText("完成登录并同步"); root.addView(done);
        done.setOnClickListener(v -> { CookieManager.getInstance().flush(); setResult(RESULT_OK); finish(); });
        web = new WebView(this);
        WebSettings settings = web.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false); settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                if (!req.isForMainFrame()) return false;
                Uri uri = req.getUrl(); String host = uri.getHost();
                if (!"gradescope".equals(provider) && "GET".equals(req.getMethod()) && "http".equals(uri.getScheme()) &&
                    "ids.shanghaitech.edu.cn".equals(host) && "/authserver/login".equals(uri.getPath()) &&
                    uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 80)) {
                    view.loadUrl(uri.buildUpon().scheme("https").encodedAuthority("ids.shanghaitech.edu.cn").build().toString()); return true;
                }
                boolean allowed = "https".equals(uri.getScheme()) && uri.getUserInfo() == null && host != null &&
                    ("gradescope".equals(provider) ? (("gradescope.com".equals(host) || "www.gradescope.com".equals(host)) && PlatformSessionProvider.effectivePort(uri) == 443) :
                     (("ids.shanghaitech.edu.cn".equals(host) && PlatformSessionProvider.effectivePort(uri) == 443) || PlatformSessionProvider.targetAllowed(provider, uri)));
                if (!allowed) { failed = true; status.setText("跳转未获允许：" + uri.getScheme() + " / " + host); }
                return !allowed;
            }
            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                if (!failed) status.setText("当前站点：" + Uri.parse(url).getHost() +
                    ("eams".equals(provider)
                        ? "\n教务网页可能只显示学期选择；无需等待课表显示，点击“完成登录并同步”，以同步结果为准。"
                        : "\n登录完成后，点击“完成登录并同步”。"));
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError e) {
                if (req.isForMainFrame()) { failed = true; status.setText("页面加载失败：" + e.getErrorCode()); }
            }
            @Override public void onReceivedHttpError(WebView v, WebResourceRequest req, WebResourceResponse r) {
                if (req.isForMainFrame()) { failed = true; status.setText("页面返回错误：HTTP " + r.getStatusCode()); }
            }
            @Override public void onReceivedSslError(WebView v, SslErrorHandler handler, SslError e) {
                handler.cancel(); failed = true; status.setText("证书校验失败，已停止加载。");
            }
        });
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1)); setContentView(root); web.loadUrl(entry);
    }
    @Override protected void onDestroy() {
        if (web != null) { web.stopLoading(); web.destroy(); CookieManager.getInstance().flush(); }
        super.onDestroy();
    }
}
