import {useEffect,useState} from 'react';
import {AndroidWidget,widgetAvailable} from '../platform/android-widget';
import type {Platform} from '../platform/bootstrap';

export default function WidgetSettings({platform}:{platform:Platform}){
  const [state,setState]=useState({enabled:true,status:'正在读取状态…'}),[note,setNote]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{if(!widgetAvailable())return;const read=()=>void AndroidWidget.state().then(setState).catch(e=>setNote(String(e)));read();const timer=setInterval(read,5000);return()=>clearInterval(timer);},[]);
  const run=async(fn:()=>Promise<unknown>,text:string)=>{setBusy(true);try{await fn();setNote(text);setState(await AndroidWidget.state());}catch(e){setNote(String(e));}finally{setBusy(false);}};
  if(!widgetAvailable())return <div className="card"><h3>桌面挂件</h3><p>本轮支持 Android；iOS 稍后接入。</p></div>;
  return <div className="card stack"><h3>桌面挂件</h3>
    <p>向上滑动查看今日剩余课程，向下返回 DDL。两页按挂件尺寸和系统字号展示能完整放下的条目，不在页内滚动。DDL 与 App 同序；课程按上课时间排列，保留到下课。</p>
    <p className="faint">请完整滑动到另一页；当前桌面组件在短距离拖动后可能停在两页之间。</p>
    <p>单击任意内容联网刷新，结果短暂弹出，只显示 BB / Gradescope。双击 BB 任务打开课程，双击 Gradescope 任务打开作业；双击课程进入 App 课表。没有网页链接的任务进入 App 详情。</p>
    <div className="conn__actions">
      <button className="btn" disabled={busy} onClick={()=>void run(()=>AndroidWidget.pinWidget(),'请在系统桌面确认添加挂件')}>添加到桌面</button>
      <button className="btn" disabled={busy} onClick={()=>void run(async()=>{await platform.academic.refreshBackground();await AndroidWidget.requestRefresh();},'已按本机数据刷新，未请求平台')}>本地刷新</button>
      <button className="btn" disabled={busy} onClick={()=>void run(()=>AndroidWidget.syncNow(),'已请求联网同步，等待网络与系统调度')}>联网同步</button>
    </div>
    <label className="field-label"><input type="checkbox" disabled={busy} checked={state.enabled} onChange={e=>void run(()=>AndroidWidget.configure({enabled:e.target.checked}),'后台同步设置已保存')}/>允许后台定期联网同步</label>
    <p className="faint">BB / Gradescope 每小时检查，教务每天检查；系统省电可能延迟执行。登录过期时请到用户与账号重新登录，读取失败保留旧数据。</p>
    <p role="status">{state.status}</p>{note&&<p role="status">{note}</p>}
  </div>;
}
