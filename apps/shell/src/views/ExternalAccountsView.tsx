import {useEffect,useState} from 'react';
import type {Platform} from '../platform/bootstrap';
import {confirmAction} from '../components/ConfirmDialog';

export default function ExternalAccountsView({platform:p,pluginId}:{platform:Platform;pluginId?:string}){
  const [revision,setRevision]=useState(0),[states,setStates]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  useEffect(()=>p.externalPlugins.subscribe(()=>setRevision(n=>n+1)),[p]);
  const items=p.externalPlugins.list().filter(v=>v.manifest.contributes?.accounts?.length&&(!pluginId||v.manifest.id===pluginId));
  const ids=items.map(v=>v.manifest.id).join(',');
  useEffect(()=>{let active=true;void Promise.all(items.map(async v=>[v.manifest.id,await p.externalPlugins.accountState(v.manifest.id)] as const)).then(rows=>{if(active)setStates(Object.fromEntries(rows));}).catch(e=>{if(active)setMessage(String(e));});return()=>{active=false;};},[p,ids,revision]);
  const run=async(fn:()=>Promise<unknown>)=>{setBusy(true);setMessage('');try{const result=await fn();setMessage(typeof result==='string'?result:'账号已退出，已同步数据保留');}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);setRevision(n=>n+1);}};
  return <section className="stack">{!pluginId&&<h3>插件账号</h3>}{items.length===0&&!pluginId&&<p className="faint">需要登录的外部插件会在这里显示。</p>}{items.map(item=><div className="conn stack" key={item.manifest.id}>
    <strong>{item.manifest.contributes!.accounts![0].title}</strong><small>{item.manifest.name} · {states[item.manifest.id]||'读取账号状态中'}</small>
    <div className="conn__actions"><button className="btn" disabled={busy||item.state!=='active'} onClick={()=>void run(()=>p.externalPlugins.login(item.manifest.id))}>网页登录并同步</button><button className="btn" disabled={busy} onClick={()=>void run(async()=>{if(!await confirmAction('清除该插件网页登录状态，保留已同步数据？'))return '已取消';await p.externalPlugins.logout(item.manifest.id);})}>退出账号</button></div>
  </div>)}{message&&<p role="status">{message}</p>}</section>;
}
