import {useEffect,useState} from 'react';
import {AndroidWidget,widgetAvailable} from '../platform/android-widget';
import type {Platform} from '../platform/bootstrap';

export default function WidgetSettings({platform}:{platform:Platform}){
  const [state,setState]=useState({enabled:true,status:'正在读取状态…'}),[note,setNote]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{if(!widgetAvailable())return;const read=()=>void AndroidWidget.state().then(setState).catch(e=>setNote(String(e)));read();const timer=setInterval(read,5000);return()=>clearInterval(timer);},[]);
  const run=async(fn:()=>Promise<unknown>,text:string)=>{setBusy(true);try{await fn();setNote(text);setState(await AndroidWidget.state());}catch(e){setNote(String(e));}finally{setBusy(false);}};
  if(!widgetAvailable())return <div className="card"><p>本轮支持 Android；iOS 稍后接入。</p></div>;
  return <div className="card stack">
    <p>上滑看今日课程，下滑看待办。放大挂件可显示更多条目。</p>
    <p className="faint">切页时请滑动到底，短距离滑动可能停在两页之间。</p>
    <p>单击联网刷新 BB / Gradescope。双击任务打开对应网页，无链接时打开详情；双击课程打开课表。</p>
    <div className="conn__actions">
      <button className="btn" disabled={busy} onClick={()=>void run(()=>AndroidWidget.pinWidget(),'请在系统桌面确认添加挂件')}>添加到桌面</button>
      <button className="btn" disabled={busy} onClick={()=>void run(async()=>{await platform.academic.refreshBackground();await AndroidWidget.requestRefresh();},'已按本机数据刷新，未请求平台')}>本地刷新</button>
      <button className="btn" disabled={busy} onClick={()=>void run(()=>AndroidWidget.syncNow(),'已请求联网同步，等待网络与系统调度')}>联网同步</button>
    </div>
    <label className="field-label"><input type="checkbox" disabled={busy} checked={state.enabled} onChange={e=>void run(()=>AndroidWidget.configure({enabled:e.target.checked}),'后台同步设置已保存')}/>允许后台定期联网同步</label>
    <p className="faint">BB / Gradescope 每小时同步，教务每天同步，省电模式可能延迟。登录过期请到「用户与账号」重新登录；同步失败保留旧数据。</p>
    <p role="status">{state.status}</p>{note&&<p role="status">{note}</p>}
  </div>;
}
