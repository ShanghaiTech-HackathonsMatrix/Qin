package dev.matrix.shell;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetHost;
import android.content.Intent;
import android.content.ComponentName;
import android.os.Build;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "MatrixWidget")
public final class MatrixWidgetPlugin extends Plugin {
    @PluginMethod public void consumeTap(PluginCall call){MainActivity activity=(MainActivity)getActivity();String id=activity.consumeWidgetItem(),page=activity.consumeWidgetPage();call.resolve(new com.getcapacitor.JSObject().put("id",id==null?org.json.JSONObject.NULL:id).put("page",page==null?org.json.JSONObject.NULL:page));}
    private String held="";
    @PluginMethod public void begin(PluginCall call){
        String owner="app:"+call.getString("lease","");
        if(!MatrixWidgetSync.acquire(owner)){call.resolve(new com.getcapacitor.JSObject().put("acquired",false));return;}
        held=owner;
        com.getcapacitor.JSObject out=new com.getcapacitor.JSObject().put("acquired",true);
        out.put("pending",MatrixWidgetSync.prefs(getContext()).getString("pending","[]"));call.resolve(out);
    }
    @PluginMethod public void end(PluginCall call){String owner="app:"+call.getString("lease","");MatrixWidgetSync.release(owner);if(held.equals(owner))held="";call.resolve();}
    @Override protected void handleOnDestroy(){if(!held.isEmpty())MatrixWidgetSync.release(held);super.handleOnDestroy();}
    @PluginMethod public void acknowledge(PluginCall call){MatrixWidgetSync.prefs(getContext()).edit().remove("pending").apply();call.resolve();}
    @PluginMethod public void configure(PluginCall call){
        boolean enabled=call.getBoolean("enabled",true);MatrixWidgetSync.prefs(getContext()).edit().putBoolean("enabled",enabled).apply();MatrixWidgetSync.periodic(getContext(),enabled);call.resolve();
    }
    @PluginMethod public void syncNow(PluginCall call){MatrixWidgetSync.enqueue(getContext(),true);call.resolve();}
    @PluginMethod public void state(PluginCall call){
        call.resolve(new com.getcapacitor.JSObject().put("pending",MatrixWidgetSync.prefs(getContext()).contains("pending")).put("enabled",MatrixWidgetSync.prefs(getContext()).getBoolean("enabled",true)).put("status",MatrixWidgetSync.prefs(getContext()).getString("status","尚未后台联网同步")));
    }
    @PluginMethod
    public void setSnapshot(PluginCall call) {
        String snapshot = call.getString("snapshot");
        if (snapshot == null || snapshot.isEmpty()) {
            call.reject("snapshot 不能为空");
            return;
        }
        try {
            String data=call.getString("data");
            if(data==null||data.length()>8*1024*1024||snapshot.length()>2*1024*1024)throw new IllegalArgumentException("挂件数据无效");
            new org.json.JSONObject(data);new org.json.JSONObject(snapshot);
            if(!MatrixWidgetSync.publish(getContext(),data,snapshot)){call.reject("后台同步进行中，请稍后重试");return;}
        }catch(Exception e){call.reject(e.getMessage());return;}
        refreshWidgets();
        call.resolve();
    }

    @PluginMethod
    public void requestRefresh(PluginCall call) {
        MatrixWidgetStore.markRefreshRequested(getContext());
        refreshWidgets();
        call.resolve();
    }

    @PluginMethod
    public void pinWidget(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.reject("当前 Android 版本不支持固定小组件");
            return;
        }
        AppWidgetManager manager = AppWidgetManager.getInstance(getContext());
        ComponentName provider = new ComponentName(getContext(), MatrixWidgetProvider.class);
        if (!manager.isRequestPinAppWidgetSupported()) {
            call.reject("当前桌面不支持系统确认后添加小组件，请从桌面卡片列表手动添加");
            return;
        }
        if (!manager.requestPinAppWidget(provider, null, null)) {
            call.reject("系统未接受添加小组件请求");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void openWidgetPicker(PluginCall call) {
        pinWidget(call);
    }

    private void refreshWidgets() {
        AppWidgetManager manager = AppWidgetManager.getInstance(getContext());
        int[] ids = manager.getAppWidgetIds(new ComponentName(getContext(), MatrixWidgetProvider.class));
        for (int id : ids) {
            MatrixWidgetProvider.refresh(getContext(), manager, id, null);
        }
    }
}
