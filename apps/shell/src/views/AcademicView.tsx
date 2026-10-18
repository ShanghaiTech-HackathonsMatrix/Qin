import LessonSheet from '../components/LessonSheet';
import CloseButton from '../components/CloseButton';
﻿import { useEffect, useState } from 'react';
import type { AcademicService } from '../core/academic-service.ts';
import { currentWeek, minutes, type LessonRule, type Assignment, type TimetableSettings, type Period, type Provider, type AssignmentOverride } from '../plugins/builtin/academic/model.ts';
import './academic.css';
const LABELS:Record<Provider,string>={gradescope:'Gradescope',blackboard:'Blackboard',eams:'教务课表'};
const days=['一','二','三','四','五','六','日'];
const time=(at:number)=>new Date(at).toLocaleString('zh-CN',{hour12:false});
const stamp=(at:number|null)=>at===null?'':new Date(at-new Date(at).getTimezoneOffset()*60000).toISOString().slice(0,16);
export default function AcademicView({service:s,onChanged}:{service:AcademicService;onChanged:()=>void}) {
  const [,refresh]=useState(0),[error,setError]=useState(''),[mode,setMode]=useState<'table'|'assignments'|'settings'>('table');
  const [week,setWeek]=useState(()=>Math.max(1,Math.min(s.settings.totalWeeks,currentWeek(s.settings,Date.now())??1)));
  const [lesson,setLesson]=useState<LessonRule|null>(null),[assignment,setAssignment]=useState<Assignment|null>(null);
  useEffect(()=>s.subscribe(()=>{refresh(n=>n+1);onChanged();}),[s,onChanged]);
  const run=async(fn:()=>Promise<unknown>)=>{setError('');try{await fn();}catch(e){setError(e instanceof Error?e.message:String(e));}};
  const settings=s.settings;
  useEffect(()=>setWeek(n=>Math.max(1,Math.min(n,settings.totalWeeks))),[settings.totalWeeks]);
  const rules=s.snapshots.flatMap(x=>x.rules).filter(r=>!settings.selectedCourses.eams||settings.selectedCourses.eams.includes(r.courseId));
  const visibleRules=rules.map(r=>({...r,note:s.corrections.lessons[r.id]?.note})).filter(r=>r.weekday<=(settings.showWeekend?7:5)&&(settings.showOtherWeeks||r.weeks.includes(week)));
  const placements=days.flatMap((_,day)=>{
    const laneEnds:number[]=[],items=visibleRules.filter(r=>r.weekday===day+1).sort((a,b)=>a.first-b.first||a.last-b.last).map(r=>{
      let lane=laneEnds.findIndex(end=>end<r.first);if(lane<0)lane=laneEnds.length;laneEnds[lane]=r.last;return {r,lane};
    });
    return items.map(item=>({...item,lanes:laneEnds.length}));
  });
  const tasks=s.snapshots.flatMap(x=>x.assignments.filter(a=>!settings.selectedCourses[x.provider]||settings.selectedCourses[x.provider]!.includes(a.courseId))).sort((a,b)=>(({...a,...s.corrections.assignments[a.id]}).dueAt??Infinity)-(({...b,...s.corrections.assignments[b.id]}).dueAt??Infinity));
  return <div className="academic stack">
    <details className="card" open={!s.snapshots.length}>
      <summary>连接学习平台</summary>
      {!s.available&&<p className="muted">网页登录与同步目前仅支持 Android。</p>}
      <p className="muted">Gradescope 使用邮箱登录；BB 与教务使用学校统一认证。登录完成后点击“完成登录并同步”。</p>
      {(['gradescope','blackboard','eams'] as Provider[]).map(p=><div className="academic-source" key={p}>
        <strong>{LABELS[p]}</strong>
        <div className="row"><button className="btn btn--sm" disabled={s.busy||!s.available} onClick={()=>void run(()=>s.login(p))}>登录{LABELS[p]}</button>
        <button className="btn btn--sm" disabled={s.busy||!s.available} onClick={()=>void run(()=>s.sync(p))}>同步{LABELS[p]}</button></div>
        <div className="muted" role="status">{s.statuses[p]??'尚未同步'}</div>
        {s.snapshots.find(x=>x.provider===p)&&<small className="muted">上次成功：{time(s.snapshots.find(x=>x.provider===p)!.syncedAt)}</small>}
      </div>)}
      <button className="btn btn--sm" disabled={s.busy||!s.available} onClick={()=>void run(()=>s.clearLogin())}>清除全部平台登录状态（保留课表）</button>
    </details>
    {error&&<div role="alert" className="alert alert--bad">{error}</div>}
    <div className="row">{([['table','课表'],['assignments',`作业 (${tasks.length})`],['settings','课表设置']] as const).map(([id,title])=><button key={id} className={`btn ${mode===id?'btn--primary':''}`} onClick={()=>setMode(id)}>{title}</button>)}</div>
    {mode==='table'&&<>
      <div className="row"><h3 style={{flex:1}}>{settings.name}</h3><button className="btn btn--sm" onClick={()=>setWeek(n=>Math.max(1,n-1))}>上一周</button>
      <label>第 <select aria-label="查看周数" value={week} onChange={e=>setWeek(+e.target.value)}>{Array.from({length:settings.totalWeeks},(_,i)=><option key={i} value={i+1}>{i+1}</option>)}</select> 周</label>
      <button className="btn btn--sm" onClick={()=>setWeek(n=>Math.min(settings.totalWeeks,n+1))}>下一周</button></div>
      {!settings.weekOne&&<div className="alert alert--warn">请在课表设置中确认第 1 教学周的周一日期，确认后才会生成时间线与上课提醒。</div>}
      <div className="academic-scroll"><div className="academic-grid" style={{gridTemplateColumns:`44px repeat(${settings.showWeekend?7:5}, minmax(92px,1fr))`,gridTemplateRows:`auto repeat(${settings.periods.length}, minmax(90px,auto))`}}>
        <div className="academic-cell" style={{gridRow:1,gridColumn:1}}>节次</div>{days.slice(0,settings.showWeekend?7:5).map((d,i)=><div key={d} className="academic-cell academic-head" style={{gridRow:1,gridColumn:i+2}}>周{d}{settings.weekOne&&<small>{new Date(Date.parse(settings.weekOne+'T00:00:00+08:00')+((week-1)*7+i)*86400000).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric'})}</small>}</div>)}
        {settings.periods.map((p,i)=><div key={i} style={{display:'contents'}}>
          <div className="academic-cell academic-period" style={{gridRow:i+2,gridColumn:1}}><strong>{i+1}</strong><small>{p.start}<br/>{p.end}</small></div>
          {days.slice(0,settings.showWeekend?7:5).map((_,day)=><div className="academic-cell" key={day} style={{gridRow:i+2,gridColumn:day+2}}/>)}
        </div>)}
        {placements.map(({r,lane,lanes})=><button className={`academic-lesson ${r.weeks.includes(week)?'':'academic-lesson--other'}`} key={r.id} style={{gridRow:`${r.first+1} / span ${r.last-r.first+1}`,gridColumn:r.weekday+1,width:`calc(${100/lanes}% - 6px)`,marginLeft:`calc(${lane*100/lanes}% + 3px)`}} onClick={()=>setLesson(r)}>
          <strong>{r.title}</strong><span>{r.location||'地点待补充'}</span><span>{r.teacher||'教师待补充'}</span><small>{settings.periods[r.first-1]?.start??'?'}–{settings.periods[r.last-1]?.end??'?'} · {r.first}–{r.last}节</small><small>{r.weeks.join(',')}周{!r.weeks.includes(week)?' · 非本周':''}</small>{r.note&&<small>备注：{r.note}</small>}
        </button>)}
      </div></div>
      {!rules.length&&<p className="muted">连接教务并同步后，课表将显示在这里。</p>}
      <details className="card"><summary>全部排课与课程备注</summary>{rules.map(r=><button className="academic-list-item" key={r.id} onClick={()=>setLesson(r)}>{r.title} · 周{days[r.weekday-1]} {r.first}–{r.last}节</button>)}</details>
    </>}
    {mode==='assignments'&&<><p className="muted">无法确定的截止日期会标为“待确认”，不会猜测。修改时间不改变平台原始信息。</p>{!tasks.length&&<p className="muted">同步 Gradescope 或 Blackboard 后显示作业。</p>}
      {tasks.map(original=>{const a={...original,...s.corrections.assignments[original.id]},done=a.done??(['submitted','graded'].includes(a.status));return <button className="card academic-task" key={a.id} onClick={()=>setAssignment(original)}>
        <strong>{done?'✓ ':''}{a.title}</strong><span>{s.snapshots.flatMap(x=>x.courses).find(c=>c.id===a.courseId)?.title} · {LABELS[a.provider]}</span>
        <span>{a.dueAt===null?'截止时间待确认':time(a.dueAt)}</span><small>{a.status==='not_submitted'?'未提交':a.status==='submitted'?'已提交':a.status==='graded'?'已评分':'状态待确认'}{a.hidden?' · 已隐藏':''}</small>{a.note&&<span>备注：{a.note}</span>}
      </button>;})}</>}
    {mode==='settings'&&<Settings key={JSON.stringify(s.settings)} s={s} run={run}/>}
    {lesson&&<LessonSheet id={lesson.id} service={s} close={()=>setLesson(null)}/>}
    {assignment&&<AssignmentEditor assignment={assignment} s={s} close={()=>setAssignment(null)} run={run}/>}
  </div>;
}
function Settings({s,run}:{s:AcademicService;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {
  const [d,setD]=useState<TimetableSettings>(()=>structuredClone(s.settings));
  const [duration,setDuration]=useState(45),[gap,setGap]=useState(10),[counts,setCounts]=useState([4,5,4]),[starts,setStarts]=useState(['08:15','13:00','18:00']);
  const change=(patch:Partial<TimetableSettings>)=>setD(x=>({...x,...patch}));
  const generate=()=>{
    const groups:Period['group'][]=['上午','下午','晚上'];
    const periods=groups.flatMap((group,i)=>Array.from({length:Math.min(12,Math.max(0,counts[i]))},(_,n)=>{
      const start=minutes(starts[i])+n*(duration+gap),end=start+duration;
      const fmt=(v:number)=>`${Math.floor(v/60).toString().padStart(2,'0')}:${(v%60).toString().padStart(2,'0')}`;
      return {start:fmt(start),end:fmt(end),group};
    }));change({periods});
  };
  return <div className="stack">
    <section className="card stack"><h3>学期与显示</h3>
      <label>课程表名称<input className="field" value={d.name} maxLength={80} onChange={e=>change({name:e.target.value})}/></label>
      <label>第 1 教学周周一<input className="field" type="date" value={d.weekOne} onChange={e=>change({weekOne:e.target.value})}/></label>
      <label>当前周数（修改后校准开始日期）<input className="field" type="number" min={1} max={60} value={currentWeek(d,Date.now())??''} onChange={e=>{const w=+e.target.value;if(!Number.isInteger(w)||w<1||w>60)return;const now=new Date(Date.now()+28800000),day=(now.getUTCDay()+6)%7;change({weekOne:new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())-(day+(w-1)*7)*86400000).toISOString().slice(0,10)});}}/></label>
      <label>学期总周数<input className="field" type="number" min={1} max={60} value={d.totalWeeks} onChange={e=>change({totalWeeks:+e.target.value})}/></label>
      <label><input type="checkbox" checked={d.showWeekend} onChange={e=>change({showWeekend:e.target.checked})}/> 显示周末</label>
      <label><input type="checkbox" checked={d.showOtherWeeks} onChange={e=>change({showOtherWeeks:e.target.checked})}/> 显示非本周课程</label>
    </section>
    <section className="card stack"><h3>课程时间设置</h3><p className="muted">先按课长与休息批量生成，再逐节调整大课间、午休。同步不会覆盖人工调整。</p>
      <div className="academic-pair"><label>每节课（分钟）<input className="field" type="number" min={1} max={180} value={duration} onChange={e=>setDuration(+e.target.value)}/></label><label>课间（分钟）<input className="field" type="number" min={0} max={120} value={gap} onChange={e=>setGap(+e.target.value)}/></label></div>
      {['上午','下午','晚上'].map((g,i)=><div className="academic-pair" key={g}><label>{g}节数<input className="field" type="number" min={0} max={12} value={counts[i]} onChange={e=>setCounts(x=>x.map((v,j)=>j===i?+e.target.value:v))}/></label><label>{g}开始<input className="field" type="time" value={starts[i]} onChange={e=>setStarts(x=>x.map((v,j)=>j===i?e.target.value:v))}/></label></div>)}
      <button className="btn" onClick={()=>void run(async()=>generate())}>按以上参数生成节次</button>
      {d.periods.map((p,i)=><div className="academic-period-editor" key={i}><span>第{i+1}节<br/>{p.group}</span><input aria-label={`第${i+1}节开始`} className="field" type="time" value={p.start} onChange={e=>change({periods:d.periods.map((p,j)=>i===j?{...p,start:e.target.value}:p)})}/><span>–</span><input aria-label={`第${i+1}节结束`} className="field" type="time" value={p.end} onChange={e=>change({periods:d.periods.map((p,j)=>i===j?{...p,end:e.target.value}:p)})}/></div>)}
    </section>
    <section className="card stack"><h3>同步设置</h3><label>教务学期 ID（留空为当前学期）<input className="field" inputMode="numeric" value={d.semesterId} onChange={e=>change({semesterId:e.target.value})}/></label>
      <label>Gradescope 页面时区<select className="field" value={d.gradescopeTimezone} onChange={e=>change({gradescopeTimezone:e.target.value})}><option value="">未确认，模糊时间待确认</option>{['Asia/Shanghai','America/Los_Angeles','America/New_York','UTC'].map(t=><option key={t}>{t}</option>)}</select></label>
      <small className="muted">带有时区的日期直接读取。仅显示当地时间的网页，请核对 Gradescope 的页面时区后选择，并重新同步。</small>
      {s.snapshots.map(snap=><details key={snap.provider}><summary>{LABELS[snap.provider]}：选择需要同步的课程</summary>{snap.courses.map(c=><label className="academic-checkbox" key={c.id}><input type="checkbox" checked={!d.selectedCourses[snap.provider]||d.selectedCourses[snap.provider]!.includes(c.id)} onChange={e=>{const selected=d.selectedCourses[snap.provider]??snap.courses.map(c=>c.id);change({selectedCourses:{...d.selectedCourses,[snap.provider]:e.target.checked?[...selected,c.id]:selected.filter(x=>x!==c.id)}});}}/>{c.title}</label>)}</details>)}
    </section>
    <section className="card stack"><h3>提醒</h3><label>课前提前量（分钟）<input className="field" type="number" min={0} max={43200} value={d.lessonLead} onChange={e=>change({lessonLead:+e.target.value})}/></label><label>作业提前量（分钟）<input className="field" type="number" min={0} max={43200} value={d.dueLead} onChange={e=>change({dueLead:+e.target.value})}/></label>
      <label><input type="checkbox" checked={d.reminders} onChange={e=>change({reminders:e.target.checked})}/> 开启本地提醒</label><p className="muted">{s.reminderStatus}。同步发生在应用内；系统可能受省电策略影响而延迟通知。</p>
      <button className="btn" disabled={s.busy} onClick={()=>void run(()=>s.testNotification())}>发送 15 秒测试通知</button>
    </section>
    <button className="btn btn--primary" disabled={s.busy} onClick={()=>void run(async()=>{if(d.reminders&&!s.settings.reminders){await s.requestReminderPermission();}await s.saveSettings(d);})}>保存课表设置</button>
  </div>;
}
function AssignmentEditor({assignment:a,s,close,run}:{assignment:Assignment;s:AcademicService;close:()=>void;run:(fn:()=>Promise<unknown>)=>Promise<void>}) {
  const corrected={...a,...s.corrections.assignments[a.id]};
  const [title,setTitle]=useState(corrected.title),[due,setDue]=useState(stamp(corrected.dueAt)),[note,setNote]=useState(corrected.note??''),[done,setDone]=useState(corrected.done??['submitted','graded'].includes(a.status));
  return <div className="sheet-backdrop"><form className="sheet stack" onSubmit={e=>{e.preventDefault();void run(async()=>{
    const patch:AssignmentOverride={};
    if(title!==corrected.title)patch.title=title;
    if(due!==stamp(corrected.dueAt))patch.dueAt=due?new Date(due).getTime():null;
    if(note!==(corrected.note??''))patch.note=note;
    if(done!==(corrected.done??['submitted','graded'].includes(a.status)))patch.done=done;
    await s.editAssignment(a.id,patch);close();});}}>
    <div className="row"><h3>作业详情</h3><CloseButton onClick={close} /></div>
    <label>名称<input className="field" required value={title} maxLength={200} onChange={e=>setTitle(e.target.value)}/></label>
    <label>截止时间（手机本地时区）<input className="field" type="datetime-local" value={due} onChange={e=>setDue(e.target.value)}/></label>
    <small className="muted">平台原文：{a.dueText||'未提供明确日期'}{a.lateDueAt!==null?`；最迟补交：${time(a.lateDueAt)}`:''}</small>
    <label>个人备注<textarea className="field" value={note} maxLength={1000} onChange={e=>setNote(e.target.value)}/></label>
    <label><input type="checkbox" checked={done} onChange={e=>setDone(e.target.checked)}/> 已完成（仅记录在本应用）</label>
    <div className="row"><button type="button" className="btn" disabled={s.busy} onClick={()=>void run(async()=>{await s.resetAssignment(a.id);close();})}>恢复平台数据</button><button className="btn btn--primary" disabled={s.busy}>保存作业修正</button></div>
  </form></div>;
}
