import type {AcademicSnapshot} from '../plugins/builtin/academic/connectors.ts';
import {projectAcademic} from '../plugins/builtin/academic/projection.ts';
import type {TimetableSettings,UserCorrections} from '../plugins/builtin/academic/model.ts';
/** App 和后台使用同一投影规则；仅生成学业提醒，不覆盖本机自定义任务。 */
export function academicReminders(snapshots:AcademicSnapshot[],settings:TimetableSettings,corrections:UserCorrections,enabled:Record<string,boolean|undefined>,now:number){
  if(!settings.reminders)return [];
  return projectAcademic(snapshots.filter(s=>enabled[s.provider]!==false),settings,corrections)
    .filter(e=>e.type==='academic_event'&&!e.data.done)
    .map(e=>({id:`academic#${e.id}`,at:Number(e.data.startAt)-(e.data.type==='session'?settings.lessonLead:settings.dueLead)*60000,
      title:`${e.data.type==='session'?'即将上课':'作业截止提醒'} · ${e.data.title}`,body:String(e.data.detail??''),payload:'academic'}))
    .filter(e=>e.at>now).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id)).slice(0,400);
}
