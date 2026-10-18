package dev.matrix.shell;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;

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
    public void pinState(PluginCall call) {
        try { call.resolve(MatrixWidgetPin.state(getContext())); }
        catch (RuntimeException e) { call.reject("无法读取桌面挂件状态，可按下方说明手动添加。"); }
    }

    @PluginMethod
    public void pinWidget(PluginCall call) {
        if (getActivity() == null) { call.reject("请回到应用前台后重试，或手动添加挂件。"); return; }
        getActivity().runOnUiThread(() -> {
            try { call.resolve(MatrixWidgetPin.request(getContext())); }
            catch (RuntimeException e) { call.reject("桌面未能完成添加请求。请保持手机解锁，或按下方说明手动添加。"); }
        });
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
