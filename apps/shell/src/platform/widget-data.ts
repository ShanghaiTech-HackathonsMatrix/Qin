import {ddlsFromTasks,platformDdls,type DdlItem} from '../app/ddl-items.ts';
import {expandLessons,type TimetableSettings,type UserCorrections} from '../plugins/builtin/academic/model.ts';
import type {AcademicSnapshot} from '../plugins/builtin/academic/connectors.ts';
import type {Course,Task} from '../domain/types.ts';
import {compareTasks} from '../app/task-status.ts';
import {compactDdlLabels} from '../app/ddl-labels.ts';
import {currentTermSnapshot} from '../app/academic-term.ts';
export interface WidgetData {
  snapshots:AcademicSnapshot[];settings:TimetableSettings;corrections:UserCorrections;
  enabled:Record<string,boolean|undefined>;tasks:Task[];courses:Course[];
}
/*
  挂件上只放课程名。

  `Course.code` 从来没被拼进名字里（它是独立字段），平台快照的 `code` 也一直是空串。
  但**平台给的课程标题本身**常常带着课程代码 —— 「CS204 操作系统」「操作系统（CS204）」。
  `compactCourseName` 只负责剥学期，代码会原样留下来。挂件一行就那么宽，
  代码属于「其他信息」，不该占这个位置。

  只作用在挂件的显示投影上：不改快照、不改个人修正、也不改 App 里的课程名。
*/
export function courseNameOnly(raw:string):string {
  const original=raw.trim();
  const name=original
    // 末尾括号里的代码：操作系统（CS204）→ 操作系统
    .replace(/[（(【[]\s*[A-Za-z]{2,6}[\s-]?\d{2,4}[A-Za-z]?\s*[）)】\]]\s*$/,'')
    // 开头的代码：CS204 操作系统 / CS 204 操作系统 → 操作系统
    .replace(/^[A-Za-z]{2,6}[\s-]?\d{2,4}[A-Za-z]?(?:\s*[-–]\s*\d{1,3})?\s*[:：·|_-]?\s+/,'')
    // 末尾裸露的代码：操作系统 CS204 → 操作系统
    .replace(/\s+[A-Za-z]{2,6}[\s-]?\d{2,4}[A-Za-z]?$/,'')
    .trim();
  // 整个名字就是一个代码时原样留着 —— 剥成空串等于把这一行删了
  return name||original;
}
/** 同一入口用于 App 发布和后台同步。不会把“消失”或读取失败当作提交。 */
export function widgetSnapshot(data:WidgetData,now:number){
  const snapshots=data.snapshots.filter(s=>data.enabled[s.provider]!==false).map(s=>currentTermSnapshot(s,now));
  const undatedLocal=data.tasks.filter(t=>t.kind!=='course'&&t.status!=='dismissed'&&(t.dueAt===null||!Number.isFinite(t.dueAt))).map(t=>({id:t.id,title:t.title,courseId:t.courseId,dueAt:null,done:t.status==='done',provider:undefined,url:undefined,courseUrl:undefined,courseTitle:undefined,needsReview:false}));
  const undatedPlatform=snapshots.flatMap(s=>s.assignments.flatMap(a=>{
    const fix=data.corrections.assignments[a.id],merged={...a,...fix},selected=data.settings.selectedCourses[s.provider];
    if(merged.hidden||(selected&&!selected.includes(a.courseId))||(merged.dueAt!==null&&Number.isFinite(merged.dueAt)))return [];
    const course=s.courses.find(c=>c.id===a.courseId);
    return [{id:a.id,title:merged.title,titleEdited:fix?.title!==undefined,courseId:null,dueAt:null,done:fix?.done??['submitted','graded'].includes(a.status),provider:s.provider,url:a.url,courseUrl:course?.url,courseTitle:course?.title,needsReview:merged.needsReview}];
  }));
  const all=[...ddlsFromTasks(data.tasks),...platformDdls(snapshots,data.settings.selectedCourses,data.corrections.assignments),...undatedLocal,...undatedPlatform];
  const labels=compactDdlLabels(all);
  const items=all.sort(compareTasks).filter(t=>!t.done).map(t=>({
    id:t.id,title:labels.get(t.id)!.title,course:courseNameOnly(labels.get(t.id)!.course||data.courses.find(c=>c.id===t.courseId)?.name||'本机任务'),dueAt:t.dueAt,
    fullTitle:t.title,fullCourse:t.courseTitle??data.courses.find(c=>c.id===t.courseId)?.name??'本机任务',
    target:taskTarget(t),needsReview:!!t.needsReview,
  }));
  const rules=snapshots.flatMap(s=>s.rules).filter(r=>!data.settings.selectedCourses.eams||data.settings.selectedCourses.eams.includes(r.courseId));
  const schedule=rules.flatMap(r=>expandLessons([r],data.settings,data.corrections).map(e=>({id:e.id,course:e.title,location:r.location,startAt:e.startAt,endAt:e.endAt})));
  return {version:1,publishedAt:now,items,schedule,scheduleNote:!data.settings.weekOne?'请在 App 设置学期第 1 周日期':'',
    providers:snapshots.map(s=>({provider:s.provider,syncedAt:s.syncedAt})),syncState:'idle'};
}
export function taskTarget(t:Pick<DdlItem,'id'|'provider'|'url'|'courseUrl'>):string {
  const raw=t.provider==='blackboard'?t.courseUrl:t.provider==='gradescope'?t.url:undefined;
  if(raw){try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password)return '';
    if(t.provider==='blackboard'&&u.origin==='https://elearning.shanghaitech.edu.cn:8443'){
      const id=u.searchParams.get('course_id')??(u.searchParams.get('type')==='Course'?u.searchParams.get('id'):null);
      if(id&&/^_?\d+_\d+$/.test(id)){const target=new URL('/webapps/blackboard/execute/launcher',u.origin);target.searchParams.set('type','Course');target.searchParams.set('id',id);return target.href;}
    }
    if(t.provider==='gradescope'&&u.origin==='https://www.gradescope.com'&&/^\/courses\/\d+\/assignments\/\d+\/?$/.test(u.pathname)){u.search='';u.hash='';return u.href;}
  }catch{/* 非法地址不交给系统浏览器 */}}
  return '';
}
