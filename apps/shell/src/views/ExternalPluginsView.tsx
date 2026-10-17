import {useEffect,useMemo,useState} from 'react';
import type {Platform} from '../platform/bootstrap';
import {readPluginPackage,PACKAGE_LIMIT,type ExternalPackage} from '../core/external-package';
import {LayoutStore} from '../ui/layout';
import {WidgetPage} from '../ui/WidgetPage';

export default function ExternalPluginsView({platform:p}:{platform:Platform}){
  const layout=useMemo(()=>new LayoutStore(p.kv,'plugins'),[p]);
  const [,bump]=useState(0),[pending,setPending]=useState<ExternalPackage|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[showViews,setShowViews]=useState(false);
  const [removing,setRemoving]=useState<string|null>(null);
  useEffect(()=>p.externalPlugins.subscribe(()=>bump(n=>n+1)),[p]);
  const run=async(fn:()=>Promise<unknown>)=>{setBusy(true);setMessage('');try{const result=await fn();setMessage(typeof result==='string'?result:'操作完成');bump(n=>n+1);}catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  return <section className="stack">
    <h3>外部插件</h3><p className="faint">从本机导入 .mtp 插件包。安装前会显示权限，插件在独立沙箱中执行。</p>
    <label className="field-label">选择插件包（.mtp）<input type="file" accept="*/*" disabled={busy} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void run(async()=>{if(!file.name.toLowerCase().endsWith('.mtp'))throw Error('请选择 .mtp 插件包');if(file.size>PACKAGE_LIMIT)throw Error('插件包超过 2 MiB');setPending(readPluginPackage(new Uint8Array(await file.arrayBuffer())));return '请核对插件信息与权限';});}}/></label>
    {pending&&<div className="card stack" aria-label="插件安装确认">
      <strong>{pending.manifest.name} · {pending.manifest.version}</strong><span className="mono">{pending.manifest.id}</span>
      <p>来源：本地文件 · 签名未验证</p><p>联网域名：{pending.manifest.permissions?.net?.domains?.join('、')||'无'}</p>
      <p>请求方式：{pending.manifest.permissions?.net?.methods?.join('、')||'无'}</p>
      <p>数据写入：{pending.manifest.permissions?.data?.write?.join('、')||'无'}；读取：{pending.manifest.permissions?.data?.read?.join('、')||'无'}</p>
      <details><summary>完整权限</summary><pre className="diag">{JSON.stringify(pending.manifest.permissions??{},null,2)}</pre></details>
      <div className="conn__actions"><button className="btn btn--primary" disabled={busy} onClick={()=>void run(async()=>{await p.externalPlugins.install(pending);setPending(null);})}>同意权限并安装</button><button className="btn" disabled={busy} onClick={()=>setPending(null)}>取消</button></div>
    </div>}
    {p.externalPlugins.list().length===0&&<p className="faint">尚未安装外部插件</p>}
    {p.externalPlugins.list().map(item=><div className="conn" key={item.manifest.id}>
      <strong>{item.manifest.name}</strong><small> {item.manifest.version} · {item.state==='active'?'已启用':'已停用'}</small><p className="faint">{item.manifest.id} · 本地导入，签名未验证</p>
      <div className="conn__actions"><button className="btn btn--sm" disabled={busy} onClick={()=>void run(()=>p.externalPlugins.enable(item.manifest.id,item.state!=='active'))}>{item.state==='active'?'停用':'启用'}</button><button className="btn btn--sm" disabled={busy||item.state!=='active'} onClick={()=>void run(()=>p.externalPlugins.sync(item.manifest.id))}>运行同步</button><button className="btn btn--sm" disabled={busy} onClick={()=>setRemoving(item.manifest.id)}>卸载</button></div>
      {removing===item.manifest.id&&<div className="stack"><p>卸载 {item.manifest.name} 时如何处理已有数据？</p><button className="btn" disabled={busy} onClick={()=>void run(async()=>{await p.externalPlugins.uninstall(item.manifest.id,true);setRemoving(null);})}>卸载并保留数据</button><button className="btn btn--danger" disabled={busy} onClick={()=>void run(async()=>{await p.externalPlugins.uninstall(item.manifest.id,false);setRemoving(null);})}>卸载并删除数据</button><button className="btn" onClick={()=>setRemoving(null)}>取消</button></div>}
    </div>)}
    {message&&<p role="status">{message}</p>}
    <button className="btn" onClick={()=>setShowViews(v=>!v)}>{showViews?'收起插件视图':'查看插件视图'}</button>
    {showViews&&<WidgetPage host={p.plugins} layout={layout} onNavigate={()=>setMessage('请使用底部导航切换页面')}/>}
  </section>;
}
