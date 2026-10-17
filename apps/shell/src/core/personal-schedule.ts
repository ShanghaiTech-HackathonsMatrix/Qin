import type {SecureStore} from '../platform/strategies/kv/types.ts';
import type {NotifyPort,ScheduledNotification} from './notify/port.ts';

export interface PersonalEvent {
  id:string;title:string;startAt:number;endAt:number;allDay:boolean;location:string;note:string;
  repeat:'none'|'weekly';until:number;remindMinutes:number|null;
}
export function validateEvent(e:PersonalEvent){
  if(!e.id||!e.title.trim()||e.title.length>200)throw Error('请填写日程名称（最多 200 字）');
  if(!Number.isFinite(e.startAt)||!Number.isFinite(e.endAt)||e.endAt<=e.startAt)throw Error('结束时间须晚于开始时间');
  if(e.endAt-e.startAt>31*86400000)throw Error('单次日程不能超过 31 天');
  if(!['none','weekly'].includes(e.repeat))throw Error('重复方式无效');
  if(e.repeat==='weekly'&&(!Number.isFinite(e.until)||e.until<e.startAt||e.until-e.startAt>366*86400000))throw Error('每周重复结束时间应在开始后一年内');
  if(e.remindMinutes!==null&&(!Number.isInteger(e.remindMinutes)||e.remindMinutes<0||e.remindMinutes>43200))throw Error('提醒提前量应为 0–43200 分钟');
  if(e.note.length>2000||e.location.length>300)throw Error('备注或地点过长');
}
export function occurrences(e:PersonalEvent,from:number,to:number){
  const rows:{id:string;eventId:string;at:number;endAt:number;title:string;meta:string;kind:'custom';selfMade:true}[]=[];
  let start=new Date(e.startAt),end=new Date(e.endAt);
  for(let n=0;n<54;n++){
    const at=start.getTime();if(at>to||(e.repeat==='weekly'&&at>e.until))break;
    if(at>=from)rows.push({id:`personal:${e.id}:${at}`,eventId:e.id,at,endAt:end.getTime(),title:e.title,meta:[e.allDay?'全天':'',e.location,e.note].filter(Boolean).join(' · '),kind:'custom',selfMade:true});
    if(e.repeat==='none')break;
    start.setDate(start.getDate()+7);end.setDate(end.getDate()+7);
  }
  return rows;
}
export class PersonalSchedule {
  events:PersonalEvent[]=[];status='';private listeners=new Set<()=>void>();private chain:Promise<unknown>=Promise.resolve();
  private kv:SecureStore;private notify:NotifyPort;
  constructor(kv:SecureStore,notify:NotifyPort){this.kv=kv;this.notify=notify;}
  subscribe(fn:()=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
  private changed(){for(const fn of this.listeners)fn();}
  async init(){const raw=await this.kv.get('personal.schedule.v1');if(raw){const rows=JSON.parse(raw) as PersonalEvent[];for(const row of rows)validateEvent(row);this.events=rows;}await this.reconcile();}
  private save(update:(rows:PersonalEvent[])=>PersonalEvent[]){const run=this.chain.then(async()=>{const rows=update(this.events);await this.kv.set('personal.schedule.v1',JSON.stringify(rows));this.events=rows;await this.reconcile();this.changed();});this.chain=run.catch(()=>{});return run;}
  put(e:PersonalEvent){validateEvent(e);const copy={...e,title:e.title.trim()};return this.save(rows=>{if(rows.length>=500&&!rows.some(x=>x.id===copy.id))throw Error('最多保存 500 个日程');return [...rows.filter(x=>x.id!==copy.id),copy];});}
  remove(id:string){return this.save(rows=>rows.filter(x=>x.id!==id));}
  clear(){return this.save(()=>[]);}
  async requestReminderPermission(){if(this.notify.isSupported())await this.notify.requestPermission();}
  async reconcile(){
    if(!this.notify.isSupported()){this.status='当前平台不支持提醒';return;}
    try{
      const pending=await this.notify.pending(),now=Date.now();
      const allowed=await this.notify.checkPermission()==='granted';
      const items:ScheduledNotification[]=allowed?this.events.flatMap(e=>e.remindMinutes===null?[]:occurrences(e,now,now+31*86400000).map(o=>({id:`personal#${o.id}`,at:o.at-e.remindMinutes!*60000,title:e.title,body:[e.location,e.note].filter(Boolean).join(' · '),payload:'personal'}))).filter(n=>n.at>now).sort((a,b)=>a.at-b.at):[];
      const capacity=Math.max(0,this.notify.capabilities().maxPending-pending.filter(id=>!id.startsWith('personal#')).length);
      const wanted=items.slice(0,Math.min(100,capacity)),ids=new Set(wanted.map(n=>n.id));
      await this.notify.cancel(pending.filter(id=>id.startsWith('personal#')&&!ids.has(id)));await this.notify.schedule(wanted);
      this.status=allowed?`已安排 ${wanted.length} 条日程提醒（未来 31 天，打开应用时更新）`:'通知权限未开启，日程已保存';
    }catch(e){this.status=`日程已保存，提醒排程失败：${String(e)}`;}
  }
}
