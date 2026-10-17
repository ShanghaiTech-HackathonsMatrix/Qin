import {ddlsFromTasks,platformDdls,type DdlItem} from '../app/ddl-items.ts';
import {expandLessons,type TimetableSettings,type UserCorrections} from '../plugins/builtin/academic/model.ts';
import type {AcademicSnapshot} from '../plugins/builtin/academic/connectors.ts';
import type {Course,Task} from '../domain/types.ts';
import {compareTasks} from '../app/task-status.ts';
import {compactDdlLabels} from '../app/ddl-labels.ts';
export interface WidgetData {
  snapshots:AcademicSnapshot[];settings:TimetableSettings;corrections:UserCorrections;
  enabled:Record<string,boolean|undefined>;tasks:Task[];courses:Course[];
}
/** 同一入口用于 App 发布和后台同步。不会把“消失”或读取失败当作提交。 */
export function widgetSnapshot(data:WidgetData,now:number){
  const snapshots=data.snapshots.filter(s=>data.enabled[s.provider]!==false);
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
    id:t.id,title:labels.get(t.id)!.title,course:labels.get(t.id)!.course||data.courses.find(c=>c.id===t.courseId)?.name||'本机任务',dueAt:t.dueAt,
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
