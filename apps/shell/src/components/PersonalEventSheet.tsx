import {useState} from 'react';
import type {PersonalEvent,PersonalSchedule} from '../core/personal-schedule';
const stamp=(t:number)=>{const d=new Date(t);return new Date(t-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
export default function PersonalEventSheet({event,service,close}:{event:PersonalEvent|null;service:PersonalSchedule;close:()=>void}){
  const now=Math.ceil(Date.now()/1800000)*1800000;
  const [title,setTitle]=useState(event?.title??''),[start,setStart]=useState(stamp(event?.startAt??now)),[end,setEnd]=useState(stamp(event ? event.endAt-(event.allDay?1:0) : now+3600000));
  const [allDay,setAllDay]=useState(event?.allDay??false),[location,setLocation]=useState(event?.location??''),[note,setNote]=useState(event?.note??'');
  const [repeat,setRepeat]=useState<'none'|'weekly'>(event?.repeat??'none'),[until,setUntil]=useState(stamp(event?.until??now+90*86400000).slice(0,10)),[lead,setLead]=useState(event?.remindMinutes===null?'':String(event?.remindMinutes??''));
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const run=async(fn:()=>Promise<unknown>)=>{setBusy(true);try{await fn();close();}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <div className="sheet-backdrop"><form className="sheet stack" onSubmit={e=>{e.preventDefault();void run(async()=>{
    let startAt=new Date(start).getTime(),endAt=new Date(end).getTime();
    if(allDay){const a=new Date(startAt),b=new Date(endAt);a.setHours(0,0,0,0);b.setHours(0,0,0,0);b.setDate(b.getDate()+1);startAt=a.getTime();endAt=b.getTime();}
    if(lead!=='')await service.requestReminderPermission();
    await service.put({id:event?.id??crypto.randomUUID(),title,startAt,endAt,allDay,location,note,repeat,until:new Date(`${until}T23:59:59`).getTime(),remindMinutes:lead===''?null:Number(lead)});
  });}}><div className="row row--between"><h3>{event?'编辑日程':'新建日程'}</h3><button type="button" className="btn" onClick={close}>关闭</button></div>
    <label>名称<input className="field" required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)}/></label>
    <label><input type="checkbox" checked={allDay} onChange={e=>setAllDay(e.target.checked)}/> 全天（结束日期当天也包含在内）</label>
    <label>开始<input className="field" type="datetime-local" required value={start} onChange={e=>setStart(e.target.value)}/></label><label>结束<input className="field" type="datetime-local" required value={end} onChange={e=>setEnd(e.target.value)}/></label>
    <label>地点<input className="field" maxLength={300} value={location} onChange={e=>setLocation(e.target.value)}/></label><label>备注<textarea className="field" maxLength={2000} value={note} onChange={e=>setNote(e.target.value)}/></label>
    <label>重复<select className="field" value={repeat} onChange={e=>setRepeat(e.target.value as 'none'|'weekly')}><option value="none">不重复</option><option value="weekly">每周</option></select></label>
    {repeat==='weekly'&&<label>重复至<input className="field" type="date" required value={until} onChange={e=>setUntil(e.target.value)}/></label>}
    <label>提前提醒（分钟，留空不提醒）<input className="field" type="number" min="0" max="43200" value={lead} onChange={e=>setLead(e.target.value)}/></label>
    <p className="faint">{service.status}</p>{error&&<p role="alert">{error}</p>}
    <button className="btn btn--primary" disabled={busy}>保存日程</button>{event&&<button className="btn btn--danger" disabled={busy} type="button" onClick={()=>{if(confirm('删除整个日程（包括重复日程）？'))void run(()=>service.remove(event.id));}}>删除日程</button>}
  </form></div>;
}
