package dev.matrix.shell;

import android.app.Activity;
import android.content.Intent;
import android.os.*;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.io.*;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name="ExternalAccounts")
public final class ExternalAccountsPlugin extends Plugin {
    private boolean logging;
    @PluginMethod public void login(PluginCall call){if(logging){call.reject("另一个登录页面正在使用");return;}logging=true;startActivityForResult(call,new Intent(getContext(),ExternalLoginActivity.class).putExtra("pluginId",call.getString("pluginId","")),"loginResult");}
    @ActivityCallback private void loginResult(PluginCall call,ActivityResult result){logging=false;if(call!=null)call.resolve(new JSObject().put("completed",result.getResultCode()==Activity.RESULT_OK));}
    @PluginMethod public void configure(PluginCall c){perform(c,"configure");}
    @PluginMethod public void state(PluginCall c){perform(c,"state");}
    @PluginMethod public void clear(PluginCall c){perform(c,"clear");}
    @PluginMethod public void request(PluginCall c){perform(c,"request");}
    private void perform(PluginCall call,String operation){getBridge().execute(()->{
        try{
            Bundle in=new Bundle();for(String key:new String[]{"pluginId","account","url","method","body"})in.putString(key,call.getString(key,""));
            in.putString("headers",call.getObject("headers",new JSObject()).toString());in.putString("methods",call.getArray("methods",new JSArray()).toString());in.putBoolean("enabled",call.getBoolean("enabled",false));in.putInt("timeout",call.getInt("timeout",20000));
            Bundle res=getContext().getContentResolver().call(android.net.Uri.parse("content://"+getContext().getPackageName()+".externalaccounts"),operation,null,in);
            if(res==null)throw new IOException("账号进程未响应");if(res.containsKey("error")){call.reject(res.getString("error"));return;}
            JSObject out=new JSObject();
            if("request".equals(operation)){
                try(InputStream stream=new ParcelFileDescriptor.AutoCloseInputStream(res.getParcelable("body"));ByteArrayOutputStream bytes=new ByteArrayOutputStream()){
                    byte[] buffer=new byte[8192];int n;while((n=stream.read(buffer))!=-1){if(bytes.size()+n>5*1024*1024)throw new IOException("响应过大");bytes.write(buffer,0,n);}out.put("body",bytes.toString(StandardCharsets.UTF_8.name()));
                }
                out.put("status",res.getInt("status"));out.put("url",res.getString("url"));out.put("headers",new JSObject(res.getString("headers")));out.put("followedRedirects",false);
            }else if("state".equals(operation)){out.put("supported",res.getBoolean("supported"));out.put("status",res.getString("status"));}
            call.resolve(out);
        }catch(Exception e){call.reject("账号操作失败："+e.getClass().getSimpleName());}
    });}
}
