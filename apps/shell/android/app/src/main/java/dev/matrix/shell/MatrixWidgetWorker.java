package dev.matrix.shell;

import android.content.Context;
import android.net.Uri;
import android.os.*;
import android.webkit.*;
import androidx.annotation.NonNull;
import androidx.webkit.WebViewAssetLoader;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.*;

/** 从 APK 本地资源运行同一份纯连接器；不依赖 Activity、React 或前台 WebView。 */
public final class MatrixWidgetWorker extends Worker {
    private final Handler main=new Handler(Looper.getMainLooper());
    private final CountDownLatch done=new CountDownLatch(1);
    private volatile String output;
    private volatile boolean closed;
    private WebView view;
    private String input;
    public MatrixWidgetWorker(@NonNull Context c,@NonNull WorkerParameters p){super(c,p);}
    @NonNull @Override public Result doWork(){
        Context c=getApplicationContext();String lease="worker:"+UUID.randomUUID();
        if(!MatrixWidgetSync.acquire(lease))return Result.retry();
        try{
            String raw=MatrixWidgetSync.prefs(c).getString("data",null);
            if(raw==null){MatrixWidgetSync.prefs(c).edit().putString("status","请先在 App 登录并同步平台").apply();MatrixWidgetSync.feedback(c,null,"请先在 App 登录并同步 BB / Gradescope");return Result.success();}
            JSONObject data=new JSONObject(raw);JSONArray providers=new JSONArray();long now=System.currentTimeMillis();
            JSONArray snapshots=data.optJSONArray("snapshots");
            if(snapshots!=null)for(int i=0;i<snapshots.length();i++){
                JSONObject s=snapshots.getJSONObject(i);String p=s.getString("provider");
                if(data.optJSONObject("enabled")!=null&&!data.getJSONObject("enabled").optBoolean(p,true))continue;
                if(getInputData().getBoolean("all",false)||now-s.optLong("syncedAt")>=("eams".equals(p)?86400000L:3600000L))providers.put(p);
            }
            if(providers.length()==0){MatrixWidgetSync.prefs(c).edit().putString("status",snapshots==null||snapshots.length()==0?"请先在 App 登录并同步平台":"尚未到自动同步时间").apply();MatrixWidgetSync.feedback(c,new JSONObject(),null);return Result.success();}
            input=new JSONObject().put("data",data).put("providers",providers).toString();
            MatrixWidgetSync.prefs(c).edit().putString("status","正在联网同步…").apply();MatrixWidgetSync.refresh(c);
            main.post(()->{
                if(closed)return;
                view=new WebView(c);view.getSettings().setJavaScriptEnabled(true);
                view.getSettings().setAllowFileAccess(false);view.getSettings().setAllowContentAccess(false);
                view.getSettings().setBlockNetworkLoads(true); // 只允许下方映射到 APK 的本地资产
                WebViewAssetLoader loader=new WebViewAssetLoader.Builder().addPathHandler("/assets/",new WebViewAssetLoader.AssetsPathHandler(c)).build();
                view.setWebViewClient(new WebViewClient(){
                    @Override public WebResourceResponse shouldInterceptRequest(WebView v,WebResourceRequest r){
                        Uri u=r.getUrl();if("https".equals(u.getScheme())&&"appassets.androidplatform.net".equals(u.getHost())){
                            WebResourceResponse response=loader.shouldInterceptRequest(u);if(response!=null)return response;
                        }
                        return new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));
                    }
                    @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){return true;}
                });
                view.addJavascriptInterface(new NativeBridge(),"MatrixBackground");
                view.loadUrl("https://appassets.androidplatform.net/assets/public/widget-sync.html");
            });
            if(!done.await(8,TimeUnit.MINUTES)||output==null)throw new IOException("后台读取超时");
            if(closed||isStopped())throw new IOException("同步已停止");
            JSONObject result=new JSONObject(output);if(result.has("error"))throw new IOException(result.getString("error"));
            // 整个运行期持有门闩；每个平台失败时 JS 已保留该平台旧快照。
            if(!MatrixWidgetSync.prefs(c).edit().putString("data",result.getJSONObject("data").toString())
                .putString("snapshot",result.getJSONObject("snapshot").toString())
                .putString("pending",result.getJSONObject("data").getJSONArray("snapshots").toString())
                .putString("status",MatrixWidgetSync.resultStatus(result.getJSONObject("statuses"))).putLong("attemptAt",System.currentTimeMillis()).commit())throw new IOException("保存失败");
            try{dev.matrix.notify.NotificationAlarms.reconcileAcademic(c,result.getJSONArray("reminders"));}
            catch(Exception e){MatrixWidgetSync.prefs(c).edit().putString("status",MatrixWidgetSync.resultStatus(result.getJSONObject("statuses"))+" · 提醒更新失败，请打开 App 重试").apply();}
            MatrixWidgetSync.feedback(c,result.getJSONObject("statuses"),null);
            return Result.success();
        }catch(Exception e){MatrixWidgetSync.prefs(c).edit().putString("status","同步失败，保留旧数据："+e.getMessage()).apply();MatrixWidgetSync.feedback(c,null,"同步失败，已保留原有数据，请在 App 重试");return Result.retry();}
        finally{closed=true;main.post(()->{if(view!=null){view.removeJavascriptInterface("MatrixBackground");view.destroy();view=null;}});MatrixWidgetSync.release(lease);MatrixWidgetSync.refresh(c);}
    }
    @Override public void onStopped(){closed=true;done.countDown();super.onStopped();}
    public final class NativeBridge {
        @JavascriptInterface public String input(){return input;}
        @JavascriptInterface public void finish(String value){if(!closed&&value.length()<8*1024*1024){output=value;done.countDown();}}
        @JavascriptInterface public String request(String provider,String raw){
            try{
                if(closed||isStopped())throw new IOException("同步已停止");
                JSONObject r=new JSONObject(raw);Bundle in=new Bundle();
                in.putString("provider",provider);in.putString("url",r.getString("url"));in.putString("method",r.optString("method","GET"));in.putString("body",r.optString("body",""));in.putInt("timeout",20000);
                Bundle res=getApplicationContext().getContentResolver().call(Uri.parse("content://"+getApplicationContext().getPackageName()+".platformsessions"),"request",null,in);
                if(res==null)throw new IOException("会话无响应");if(res.containsKey("error"))throw new IOException(res.getString("error"));
                ParcelFileDescriptor fd=res.getParcelable("body");
                try(InputStream stream=new ParcelFileDescriptor.AutoCloseInputStream(fd);ByteArrayOutputStream bytes=new ByteArrayOutputStream()){
                    byte[] buffer=new byte[8192];int n;while((n=stream.read(buffer))!=-1){if(bytes.size()+n>5*1024*1024)throw new IOException("响应过大");bytes.write(buffer,0,n);}
                    return new JSONObject().put("body",bytes.toString(StandardCharsets.UTF_8.name())).put("status",res.getInt("status")).put("url",res.getString("url")).put("headers",new JSONObject(res.getString("headers"))).toString();
                }
            }catch(Exception e){return new com.getcapacitor.JSObject().put("error",e.getMessage()).toString();}
        }
    }
}
