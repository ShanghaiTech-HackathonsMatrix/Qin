import {useState} from 'react';
import CloseButton from './CloseButton';
import type {AcademicService} from '../core/academic-service';
export default function LessonSheet({id,service:s,close}:{id:string;service:AcademicService;close:()=>void}){
  const r=s.snapshots.flatMap(x=>x.rules).find(x=>x.id===id);
  const [note,setNote]=useState(s.corrections.lessons[id]?.note??''),[error,setError]=useState('');
  if(!r)return null;
  return <div className="sheet-backdrop"><form className="sheet stack" onSubmit={e=>{e.preventDefault();void s.editLesson(id,{note}).then(close).catch(e=>setError(String(e)));}}><div className="row row--between"><h3>{r.title}</h3><CloseButton onClick={close} /></div>
    <p>{r.location} · {r.teacher}</p><p>周{'一二三四五六日'[r.weekday-1]} · 第 {r.first}–{r.last} 节 · {s.settings.periods[r.first-1]?.start}–{s.settings.periods[r.last-1]?.end}</p><p>教学周：{r.weeks.join('、')}</p>
    <label>个人备注<textarea className="field" maxLength={1000} value={note} onChange={e=>setNote(e.target.value)}/></label>{error&&<p role="alert">{error}</p>}<button className="btn btn--primary" disabled={s.busy}>保存备注</button>
  </form></div>;
}
