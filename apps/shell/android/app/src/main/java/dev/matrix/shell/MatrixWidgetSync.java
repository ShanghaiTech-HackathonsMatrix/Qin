package dev.matrix.shell;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;
import java.util.concurrent.TimeUnit;
import androidx.work.*;

/** 单进程同步门闩与持久化中转。后台不打开 SQLite，不覆盖个人修正。 */
public final class MatrixWidgetSync {
    static String owner = "";
    static final String PREFS="matrix_widget_sync";
    static SharedPreferences prefs(Context c){return c.getSharedPreferences(PREFS,Context.MODE_PRIVATE);}
    static synchronized boolean acquire(String value){if(!owner.isEmpty())return false;owner=value;return true;}
    static synchronized void release(String value){if(owner.equals(value))owner="";}
    static synchronized boolean publish(Context c,String data,String snapshot){
        if(owner.startsWith("worker:"))return false;
        if(!prefs(c).edit().putString("data",data).putString("snapshot",snapshot).commit())throw new IllegalStateException("挂件数据保存失败");
        return true;
    }
    static void enqueue(Context c,boolean all){
        enqueue(c,all,false);
    }
    static void enqueue(Context c,boolean all,boolean feedback){
        if(feedback){
            boolean waiting=prefs(c).getBoolean("feedback",false);
            prefs(c).edit().putBoolean("feedback",true).apply();
            if(!waiting)toast(c,"正在联网刷新…");
        }
        prefs(c).edit().putString("status","等待联网同步…").apply();refresh(c);
        Constraints constraints=new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        OneTimeWorkRequest work=new OneTimeWorkRequest.Builder(MatrixWidgetWorker.class).setConstraints(constraints)
            .setInputData(new Data.Builder().putBoolean("all",all).build()).build();
        WorkManager.getInstance(c).enqueueUniqueWork("matrix-widget-manual",ExistingWorkPolicy.KEEP,work);
    }
    static void toast(Context c,String text){
        new android.os.Handler(android.os.Looper.getMainLooper()).post(()->android.widget.Toast.makeText(c,text,android.widget.Toast.LENGTH_LONG).show());
    }
    static synchronized void feedback(Context c,JSONObject statuses,String failure){
        if(!prefs(c).getBoolean("feedback",false))return;
        prefs(c).edit().putBoolean("feedback",false).apply();
        if(failure!=null){toast(c,failure);return;}
        StringBuilder text=new StringBuilder();
        for(String p:new String[]{"blackboard","gradescope"}){
            if(!statuses.has(p))continue;
            if(text.length()>0)text.append("；");
            String value=statuses.optString(p);
            text.append("blackboard".equals(p)?"BB":"Gradescope").append(": ")
                .append("同步成功".equals(value)?"已更新":value.contains("登录")?"请在 App 重新登录":"同步失败，保留旧数据");
        }
        toast(c,text.length()>0?text.toString():"暂无已启用的 BB / Gradescope 账号，请在 App 登录");
    }
    static String resultStatus(JSONObject statuses){
        StringBuilder out=new StringBuilder();java.util.Iterator<String> keys=statuses.keys();
        while(keys.hasNext()){String p=keys.next();if(out.length()>0)out.append(" · ");out.append("blackboard".equals(p)?"BB":"gradescope".equals(p)?"GS":"教务").append(": ").append(statuses.optString(p));}
        return out.length()==0?"尚无已登录的平台，请在 App 登录":""+out;
    }
    static void periodic(Context c,boolean enabled){
        WorkManager wm=WorkManager.getInstance(c);
        if(!enabled){wm.cancelUniqueWork("matrix-widget-hourly");return;}
        PeriodicWorkRequest work=new PeriodicWorkRequest.Builder(MatrixWidgetWorker.class,1,TimeUnit.HOURS)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build();
        wm.enqueueUniquePeriodicWork("matrix-widget-hourly",ExistingPeriodicWorkPolicy.KEEP,work);
    }
    static void refresh(Context c){android.appwidget.AppWidgetManager m=android.appwidget.AppWidgetManager.getInstance(c);
        for(int id:m.getAppWidgetIds(new android.content.ComponentName(c,MatrixWidgetProvider.class)))MatrixWidgetProvider.refresh(c,m,id,null);}
}
