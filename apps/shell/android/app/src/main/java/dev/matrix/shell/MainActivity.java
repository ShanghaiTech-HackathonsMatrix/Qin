package dev.matrix.shell;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private String widgetItem=null;
    private String widgetPage=null;
    @Override public void onCreate(android.os.Bundle state) {
        registerPlugin(PlatformSessionsPlugin.class);
        registerPlugin(ExternalAccountsPlugin.class);
        registerPlugin(MatrixWidgetPlugin.class);
        super.onCreate(state);
        androidx.core.view.WindowInsetsControllerCompat controller=new androidx.core.view.WindowInsetsControllerCompat(getWindow(),getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(true);controller.setAppearanceLightNavigationBars(true);
        handleWidget(getIntent());
    }
    @Override protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if ("matrix-widget-open".equals(intent.getAction())) handleWidget(intent);
        else if (bridge != null) bridge.triggerWindowJSEvent("matrix-notification");
    }
    private void handleWidget(android.content.Intent intent){
        if(intent==null||!"matrix-widget-open".equals(intent.getAction()))return;
        widgetPage = "timetable".equals(intent.getStringExtra("widgetPage")) ? "timetable" : null;
        String id=intent.getStringExtra("widgetItem");widgetItem=id==null?"":id;
        try{
            if (widgetPage != null) { widgetItem = ""; if(bridge!=null)bridge.triggerWindowJSEvent("matrix-widget"); return; }
            org.json.JSONArray items=new org.json.JSONObject(MatrixWidgetStore.readSnapshot(this)).optJSONArray("items");
            if(items!=null)for(int i=0;i<items.length();i++){
                org.json.JSONObject item=items.getJSONObject(i);if(!widgetItem.equals(item.optString("id")))continue;
                String target=item.optString("target");
                if(MatrixWidgetTarget.allowed(target)){
                    startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW,android.net.Uri.parse(target)).addCategory(android.content.Intent.CATEGORY_BROWSABLE));widgetItem=null;
                }
                break;
            }
        }catch(Exception ignored){/* 浏览器不可用时仍可在 App 查看任务。 */}
        if(bridge!=null)bridge.triggerWindowJSEvent("matrix-widget");
    }
    synchronized String consumeWidgetItem(){String id=widgetItem;widgetItem=null;return id;}
    synchronized String consumeWidgetPage(){String page=widgetPage;widgetPage=null;return page;}
}
