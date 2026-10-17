package dev.matrix.shell;

import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.*;
import android.webkit.*;
import androidx.webkit.*;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;

/** 第三方账号独立进程 + 每插件一个 WebView Profile，绝不回传 Cookie。 */
public final class ExternalAccountProvider extends ContentProvider {
    private static boolean configured;
    static synchronized void configureProcess(){if(!configured){WebView.setDataDirectorySuffix("externalaccounts");WebView.setWebContentsDebuggingEnabled(false);configured=true;}}
    static <T>T onMain(Callable<T> operation)throws Exception{
        if(Looper.myLooper()==Looper.getMainLooper())return operation.call();
        FutureTask<T> task=new FutureTask<>(operation);new Handler(Looper.getMainLooper()).post(task);return task.get(15,TimeUnit.SECONDS);
    }
    static void supported(){if(!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE))throw new IllegalStateException("当前 Android WebView 不支持账号隔离，请更新系统 WebView");}
    static String profileName(String id)throws Exception{
        if(!id.matches("[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+"))throw new SecurityException("插件 id 无效");
        byte[] hash=MessageDigest.getInstance("SHA-256").digest(id.getBytes(StandardCharsets.UTF_8));StringBuilder s=new StringBuilder("qin-");for(byte b:hash)s.append(String.format("%02x",b));return s.toString();
    }
    static androidx.webkit.Profile profile(String id)throws Exception{return onMain(()->{supported();return ProfileStore.getInstance().getOrCreateProfile(profileName(id));});}
    static SharedPreferences prefs(Context c){return c.getSharedPreferences("external_accounts",Context.MODE_PRIVATE);}
    static JSONObject account(Context c,String id)throws Exception{
        profileName(id);String raw=prefs(c).getString(id,null);if(raw==null)throw new SecurityException("账号未配置");return new JSONObject(raw);
    }
    static String origin(String raw)throws Exception{
        URI u=new URI(raw);if(!"https".equals(u.getScheme())||u.getHost()==null||u.getUserInfo()!=null||u.getPort()==0)throw new SecurityException("须使用 HTTPS 站点");
        return "https://"+u.getHost().toLowerCase(Locale.ROOT)+(u.getPort()!=-1&&u.getPort()!=443?":"+u.getPort():"");
    }
    static boolean contains(JSONArray values,String value){if(values==null)return false;for(int i=0;i<values.length();i++)if(value.equals(values.optString(i)))return true;return false;}
    static void validate(JSONObject a)throws Exception{
        for(String key:new String[]{"authOrigins","dataOrigins"}){
            JSONArray values=a.getJSONArray(key);if(values.length()<1||values.length()>8)throw new SecurityException("站点数量无效");
            for(int i=0;i<values.length();i++)if(!origin(values.getString(i)).equals(values.getString(i)))throw new SecurityException("须为精确 origin");
        }
        if(!contains(a.getJSONArray("authOrigins"),origin(a.getString("loginUrl"))))throw new SecurityException("登录地址未获允许");
    }
    static void clearProfile(String id)throws Exception{
        androidx.webkit.Profile p=profile(id);CountDownLatch done=new CountDownLatch(1);
        onMain(()->{p.getCookieManager().removeAllCookies(v->{p.getCookieManager().flush();done.countDown();});p.getWebStorage().deleteAllData();p.getGeolocationPermissions().clearAll();return null;});
        if(!done.await(10,TimeUnit.SECONDS))throw new IOException("清理账号超时");
    }
    @Override public boolean onCreate(){configureProcess();return true;}
    @Override public Bundle call(String operation,String arg,Bundle in){
        Bundle out=new Bundle();try{
            if(in==null)throw new IllegalArgumentException();String id=in.getString("pluginId","");profileName(id);
            if("configure".equals(operation)){
                JSONObject a=new JSONObject(in.getString("account","{}"));validate(a);
                String old=prefs(getContext()).getString(id,null);
                if(old!=null){JSONObject prior=new JSONObject(old);if(!prior.getString("loginUrl").equals(a.getString("loginUrl"))||!prior.getJSONArray("authOrigins").toString().equals(a.getJSONArray("authOrigins").toString())||!prior.getJSONArray("dataOrigins").toString().equals(a.getJSONArray("dataOrigins").toString()))clearProfile(id);}
                a.put("enabled",in.getBoolean("enabled",false));a.put("methods",new JSONArray(in.getString("methods","[]")));
                if(!prefs(getContext()).edit().putString(id,a.toString()).commit())throw new IOException("配置保存失败");
            }else if("clear".equals(operation)){clearProfile(id);prefs(getContext()).edit().remove(id).remove(id+".finished").commit();}
            else if("state".equals(operation)){
                boolean available=onMain(()->WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE));out.putBoolean("supported",available);
                out.putString("status",!available?"请更新系统 WebView 后使用独立账号":prefs(getContext()).getBoolean(id+".finished",false)?"登录页已完成；同步时验证会话":"尚未完成网页登录");
            }else if("request".equals(operation)){
                JSONObject a=account(getContext(),id);if(!a.optBoolean("enabled"))throw new SecurityException("插件已停用");
                String address=in.getString("url","");if(!contains(a.getJSONArray("dataOrigins"),origin(address)))throw new SecurityException("LOGIN_REQUIRED：数据请求或重定向超出授权站点");
                String verb=in.getString("method","GET");if(!contains(a.getJSONArray("methods"),verb))throw new SecurityException("请求方法未获允许");
                android.webkit.CookieManager cm=profile(id).getCookieManager();
                HttpURLConnection conn=(HttpURLConnection)new URL(address).openConnection();conn.setInstanceFollowRedirects(false);
                int timeout=Math.max(1000,Math.min(45000,in.getInt("timeout",20000)));conn.setConnectTimeout(timeout);conn.setReadTimeout(timeout);conn.setRequestMethod(verb);
                conn.setRequestProperty("User-Agent",onMain(()->WebSettings.getDefaultUserAgent(getContext())));conn.setRequestProperty("Accept-Encoding","identity");
                JSONObject hs=new JSONObject(in.getString("headers","{}"));Iterator<String> keys=hs.keys();
                while(keys.hasNext()){String key=keys.next(),lower=key.toLowerCase(Locale.ROOT);if(!Arrays.asList("cookie","cookie2","authorization","proxy-authorization","host","connection","content-length","accept-encoding").contains(lower))conn.setRequestProperty(key,hs.getString(key));}
                String cookie=cm.getCookie(address);if(cookie!=null)conn.setRequestProperty("Cookie",cookie);
                try{
                    String body=in.getString("body","");if(!body.isEmpty()&&!"GET".equals(verb)&&!"HEAD".equals(verb)){conn.setDoOutput(true);try(OutputStream stream=conn.getOutputStream()){stream.write(body.getBytes(StandardCharsets.UTF_8));}}
                    int status=conn.getResponseCode();for(Map.Entry<String,List<String>> h:conn.getHeaderFields().entrySet())if("set-cookie".equalsIgnoreCase(h.getKey()))for(String value:h.getValue())cm.setCookie(address,value);cm.flush();
                    JSONObject headers=new JSONObject();for(String key:new String[]{"content-type","location","etag","last-modified"}){String value=conn.getHeaderField(key);if(value!=null)headers.put(key,value);}
                    byte[] bytes;try(InputStream stream=status>=400?conn.getErrorStream():conn.getInputStream();ByteArrayOutputStream target=new ByteArrayOutputStream()){
                        if(stream!=null){byte[] buffer=new byte[8192];int n;while((n=stream.read(buffer))!=-1){if(target.size()+n>5*1024*1024)throw new IOException("响应过大");target.write(buffer,0,n);}}bytes=target.toByteArray();
                    }
                    ParcelFileDescriptor[] pipe=ParcelFileDescriptor.createPipe();new Thread(()->{try(OutputStream stream=new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])){stream.write(bytes);}catch(IOException ignored){}},"external-response").start();
                    out.putParcelable("body",pipe[0]);out.putInt("status",status);out.putString("url",address);out.putString("headers",headers.toString());
                }finally{conn.disconnect();}
            }else throw new IllegalArgumentException("无效账号操作");
        }catch(Exception e){out.putString("error",e.getMessage()==null?e.getClass().getSimpleName():e.getMessage());}return out;
    }
    @Override public Cursor query(Uri u,String[] p,String s,String[] a,String sort){return null;}
    @Override public String getType(Uri u){return null;}
    @Override public Uri insert(Uri u,ContentValues v){throw new UnsupportedOperationException();}
    @Override public int delete(Uri u,String s,String[] a){throw new UnsupportedOperationException();}
    @Override public int update(Uri u,ContentValues v,String s,String[] a){throw new UnsupportedOperationException();}
}
