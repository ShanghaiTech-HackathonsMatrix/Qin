package dev.matrix.shell;

import android.app.Activity;
import android.os.Bundle;
import android.net.http.SslError;
import android.webkit.*;
import android.widget.*;
import androidx.webkit.WebViewCompat;
import org.json.JSONObject;

/** 官方网页不挂任何应用桥；只有用户点击完成才结束。 */
public final class ExternalLoginActivity extends Activity {
    private WebView web;private String pluginId;
    @Override public void onCreate(Bundle state){
        super.onCreate(state);ExternalAccountProvider.configureProcess();
        try{
            pluginId=getIntent().getStringExtra("pluginId");JSONObject a=ExternalAccountProvider.account(this,pluginId);if(!a.optBoolean("enabled"))throw new SecurityException("插件未启用");
            ExternalAccountProvider.supported();
            LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setPadding(16,40,16,24);
            TextView status=new TextView(this);status.setText(a.getString("title")+"：请在官方页面登录，完成后返回同步验证。");root.addView(status);
            Button done=new Button(this);done.setText("完成网页登录");root.addView(done);
            web=new WebView(this);WebViewCompat.setProfile(web,ExternalAccountProvider.profileName(pluginId));
            WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setAllowFileAccess(false);s.setAllowContentAccess(false);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            WebViewCompat.getProfile(web).getCookieManager().setAcceptThirdPartyCookies(web,false);
            web.setWebViewClient(new WebViewClient(){
                @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){
                    if(!r.isForMainFrame())return false;
                    try{String origin=ExternalAccountProvider.origin(r.getUrl().toString());if(ExternalAccountProvider.contains(a.getJSONArray("authOrigins"),origin)||ExternalAccountProvider.contains(a.getJSONArray("dataOrigins"),origin))return false;}catch(Exception ignored){}
                    status.setText("该跳转未列入插件声明的登录站点，已停止。");return true;
                }
                @Override public void onReceivedSslError(WebView v,SslErrorHandler h,SslError e){h.cancel();status.setText("证书校验失败，已停止加载。");}
                @Override public void onReceivedError(WebView v,WebResourceRequest r,WebResourceError e){if(r.isForMainFrame())status.setText("页面加载失败，请稍后重试。");}
            });
            done.setOnClickListener(v->{WebViewCompat.getProfile(web).getCookieManager().flush();ExternalAccountProvider.prefs(this).edit().putBoolean(pluginId+".finished",true).apply();setResult(RESULT_OK);finish();});
            root.addView(web,new LinearLayout.LayoutParams(-1,0,1));setContentView(root);web.loadUrl(a.getString("loginUrl"));
        }catch(Exception e){Toast.makeText(this,e.getMessage(),Toast.LENGTH_LONG).show();finish();}
    }
    @Override protected void onDestroy(){if(web!=null){web.stopLoading();web.destroy();web=null;}super.onDestroy();}
}
