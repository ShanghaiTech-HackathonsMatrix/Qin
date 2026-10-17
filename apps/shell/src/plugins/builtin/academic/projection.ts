import type { Manifest, ParsedEntity, PluginExports } from '@matrix/plugin-api';
import { assignmentEvents, expandLessons, type TimetableSettings, type UserCorrections } from './model.ts';
import type { AcademicSnapshot } from './connectors.ts';

export const ACADEMIC_ID='app.matrix.academic';
export const projectionManifest: Manifest={ id:ACADEMIC_ID,name:'课表与作业',version:'0.1.0',apiVersion:'^1.0.0',kind:'first-party',
  permissions:{data:{write:['academic_event','course'],read:['academic_event','course']},ui:{slots:['app.matrix.timeline.event']}},
  contributes:{entityTypes:[
    {name:'academic_event',schema:{type:'object',properties:{ title:{type:'string',maxLength:200},startAt:{type:'number'},endAt:{type:'number'},type:{type:'string'},detail:{type:'string',maxLength:300},courseId:{type:'string'},done:{type:'boolean'} },required:['title','startAt','type','courseId','done'],additionalProperties:false}},
    {name:'course',schema:{type:'object',properties:{title:{type:'string',maxLength:200},code:{type:'string'},source:{type:'string'}},required:['title'],additionalProperties:false}},
  ],consumesSlots:[{slot:'app.matrix.timeline.event',from:'academic_event',map:{title:'title',startAt:'startAt',endAt:'endAt',type:'type',detail:'detail',courseId:'courseId'}}]},
};
export function projectAcademic(snapshots: AcademicSnapshot[], settings: TimetableSettings, corrections: UserCorrections): ParsedEntity[] {
  const selected=(provider:AcademicSnapshot['provider'],id:string)=>!settings.selectedCourses[provider]||settings.selectedCourses[provider]!.includes(id);
  const lessons=snapshots.flatMap(s=>s.rules.filter(r=>selected(s.provider,r.courseId))), assignments=snapshots.flatMap(s=>s.assignments.filter(a=>selected(s.provider,a.courseId)));
  const events=[...expandLessons(lessons,settings,corrections),...assignmentEvents(assignments,corrections)];
  if (events.length>1900) throw new Error('课时与作业超过时间线容量，请缩短总周数或减少课程');
  return [
    ...snapshots.flatMap(s=>s.courses.map(c=>({type:'course',id:c.id,data:{title:c.title,code:c.code,source:c.provider}}))),
    ...events.map(({id,...data})=>({type:'academic_event',id,data:{...data,title:data.done?`✓ ${data.title}`.slice(0,200):data.title}})),
  ];
}
export const projectionPlugin:PluginExports={plan(input){
  const snapshots=JSON.parse(input.settings?.snapshots??'[]') as AcademicSnapshot[];
  const settings=JSON.parse(input.settings?.timetable??'{}') as TimetableSettings;
  const corrections=JSON.parse(input.settings?.corrections??'{"lessons":{},"assignments":{}}') as UserCorrections;
  return {requests:[],entities:projectAcademic(snapshots,settings,corrections)};
},parsers:{}};
