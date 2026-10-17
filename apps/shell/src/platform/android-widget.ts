import {Capacitor,registerPlugin} from '@capacitor/core';
import {widgetSnapshot,type WidgetData} from './widget-data.ts';
import type {Platform} from './bootstrap.ts';
interface Bridge {
  setSnapshot(input:{data:string;snapshot:string}):Promise<void>;
  begin(input:{lease:string}):Promise<{acquired:boolean;pending:string}>;
  end(input:{lease:string}):Promise<void>;acknowledge():Promise<void>;
  configure(input:{enabled:boolean}):Promise<void>;state():Promise<{enabled:boolean;status:string;pending:boolean}>;
  pinWidget():Promise<void>;requestRefresh():Promise<void>;syncNow():Promise<void>;
  consumeTap():Promise<{id:string|null;page?:string|null}>;
}
export const AndroidWidget=registerPlugin<Bridge>('MatrixWidget');
export const widgetAvailable=()=>Capacitor.getPlatform()==='android';
let disconnect:(()=>void)|undefined;
/** 原生门闩串行前后台；后台只交回原始快照，个人修正仍以 App 为准。 */
export async function connectWidget(p:Platform){
  disconnect?.();
  if(!widgetAvailable()||p.academicSimulated)return;
  const publish=async()=>{
    const data:WidgetData={snapshots:p.academic.snapshots,settings:p.academic.settings,corrections:p.academic.corrections,enabled:p.academic.enabled,tasks:await p.store.listTasks(),courses:await p.store.listCourses()};
    await AndroidWidget.setSnapshot({data:JSON.stringify(data),snapshot:JSON.stringify(widgetSnapshot(data,Date.now()))});
  };
  const safePublish=async()=>{try{await publish();}catch(e){p.warnings.push(`挂件发布失败，App 数据已保留：${String(e)}`);}};
  p.academic.guard=async fn=>{
    const lease=crypto.randomUUID();let acquired=false;
    for(let i=0;i<960;i++){
      const state=await AndroidWidget.begin({lease});
      if(state.acquired){acquired=true;
        try{
          const snapshots=JSON.parse(state.pending);if(snapshots.length){await p.academic.importBackground(snapshots);await AndroidWidget.acknowledge();}
          try{return await fn();}finally{await safePublish();}
        }finally{await AndroidWidget.end({lease});}
      }
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(!acquired)throw new Error('后台同步尚未结束，请稍后重试');
    throw new Error('无法获得同步锁');
  };
  let timer:ReturnType<typeof setTimeout>|undefined;
  const changed=()=>{
    if(p.academic.busy)return;
    clearTimeout(timer);timer=setTimeout(()=>void p.academic.refreshBackground().catch(e=>{p.warnings.push(`挂件更新失败：${String(e)}`);}),250);
  };
  const unsubscribe=p.plugins.bus.subscribe(changed);
  const resume=()=>{if(document.visibilityState==='visible')changed();};
  document.addEventListener('visibilitychange',resume);
  window.addEventListener('matrix-widget',changed);
  // Worker 完成时 App 可能仍在前台；只在有待导入结果时进入串行门闩。
  const interval=setInterval(()=>{if(document.visibilityState==='visible'&&!p.academic.busy)void AndroidWidget.state().then(s=>{if(s.pending)changed();}).catch(()=>{});},5000);
  disconnect=()=>{unsubscribe();clearTimeout(timer);clearInterval(interval);document.removeEventListener('visibilitychange',resume);window.removeEventListener('matrix-widget',changed);};
  const state=await AndroidWidget.state();await AndroidWidget.configure({enabled:state.enabled});
  await p.academic.refreshBackground();
}
