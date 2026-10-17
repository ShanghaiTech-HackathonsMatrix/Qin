import type { Manifest, ParseInput, ParseResult, PluginExports, PlannedRequest } from '@matrix/plugin-api';
import { anchors, attr, requirePage } from './html.ts';
import { blackboardAssignment, blackboardCourses, eamsSelection, eamsTimetable, gradescopeAssignments, gradescopeCourses } from './parsers.ts';
import { ENTRY, PLUGIN_IDS, type AcademicCourse, type Assignment, type LessonRule, type Period, type Provider } from './model.ts';

export const SNAPSHOT = 'academic_snapshot';
export const MAX_ACADEMIC_PAGES = 600;
export interface AcademicSnapshot {
  provider: Provider; syncedAt: number; courses: AcademicCourse[]; assignments: Assignment[]; rules: LessonRule[];
  periods: Period[]; semester: string;
}
export function connectorManifest(provider: Provider): Manifest {
  return { id:PLUGIN_IDS[provider], name:{gradescope:'Gradescope 作业',blackboard:'Blackboard 作业',eams:'教务课表'}[provider], version:'0.1.0', apiVersion:'^1.0.0', kind:'first-party',
    permissions:{ net:{domains:[new URL(ENTRY[provider]).hostname], methods: provider==='eams'?['GET','POST']:['GET']}, data:{write:[SNAPSHOT],read:[SNAPSHOT]}, auth:{providers:[provider]} },
    contributes:{entityTypes:[{name:SNAPSHOT, schema:{ type:'object', properties:{json:{type:'string',maxLength:2*1024*1024,shared:false}},required:['json'],additionalProperties:false }}]} };
}
interface Page { url: string; kind: string; course?: AcademicCourse; depth: number; title?: string; body?: string }
/** 每轮只在最后产出一个完整快照；任何前序错误都不会覆盖旧数据。 */
export function createConnector(provider: Provider): PluginExports {
  let snapshot: AcademicSnapshot;
  let queue: Page[] = [], seen = new Set<string>(), page: Page, count = 0;
  let settings: Record<string,string> = {};
  const selected = () => settings.selectedCourses ? JSON.parse(settings.selectedCourses) as string[] : null;
  const canonical = (url:string) => {
    const u=new URL(url);u.hash='';
    if(provider==='blackboard') {u.searchParams.delete('mode');u.searchParams.delete('displayMode');u.searchParams.sort();}
    return u.href;
  };
  const enqueue = (p: Page) => {
    p={...p,url:canonical(p.url)};
    const key=p.url+(p.body??''); if (seen.has(key)) return;
    if (seen.size >= MAX_ACADEMIC_PAGES) throw new Error(`扫描达到 ${MAX_ACADEMIC_PAGES} 页上限，本轮未覆盖旧数据，请减少选中的课程`);
    seen.add(key); queue.push(p);
  };
  const request = (): PlannedRequest => {
    page = queue.shift()!;
    return {id:`page-${++count}`,method:page.body?'POST':'GET',url:page.url,body:page.body,parse:'page',...(page.body?{headers:{'Content-Type':'application/x-www-form-urlencoded'}}:{})};
  };
  const finish = (): ParseResult => ({entities:[{type:SNAPSHOT,id:'current',data:{json:JSON.stringify(snapshot)}}],summary:`课程 ${snapshot.courses.length}，作业 ${snapshot.assignments.length}，排课规则 ${snapshot.rules.length}`});
  return {
    plan(input) {
      settings=input.settings??{}; queue=[];seen=new Set();count=0;
      snapshot={provider,syncedAt:input.now,courses:[],assignments:[],rules:[],periods:[],semester:''};
      enqueue({url:ENTRY[provider],kind:'entry',depth:0}); return {requests:[request()]};
    },
    parsers:{page(input: ParseInput): ParseResult {
      requirePage(input.body,input.status,input.baseUrl);
      if (provider==='eams') {
        if (page.kind==='entry') {
          const selection=eamsSelection(input.body,settings.semesterId??'');snapshot.semester=selection.semester;
          enqueue({url:'https://eams.shanghaitech.edu.cn/eams/courseTableForStd!courseTable.action',kind:'table',depth:0,body:selection.body});
        } else {
          const parsed=eamsTimetable(input.body,snapshot.semester);
          snapshot.rules=parsed.rules;snapshot.courses=parsed.courses;snapshot.periods=parsed.periods;
        }
      } else if (page.kind==='entry') {
        snapshot.courses=provider==='gradescope'?gradescopeCourses(input.body,input.baseUrl):blackboardCourses(input.body,input.baseUrl);
        const selection=selected();
        const courses=snapshot.courses.filter(c=>selection===null||selection.includes(c.id));
        if (courses.length>60) throw new Error('课程超过 60 门，请选择需要同步的课程');
        for (const course of courses) enqueue({url:course.url,kind:'course',course,depth:0});
      } else if (provider==='gradescope') {
        snapshot.assignments.push(...gradescopeAssignments(input.body,page.course!,settings.gradescopeTimezone??''));
      } else {
        const assignment=blackboardAssignment(input.body,input.baseUrl,page.course!,page.title??page.course!.title);
        if (assignment && !snapshot.assignments.some(a=>a.id===assignment.id)) snapshot.assignments.push(assignment);
        const origin=new URL(ENTRY.blackboard).origin;
        const frames=[...input.body.matchAll(/<(?:frame|iframe)\b[^>]*>/gi)].flatMap(m=>{
          try {const src=attr(m[0],'src');return src?[{url:new URL(src,input.baseUrl).href,title:page.course!.title}]:[];}catch{return [];}
        });
        for (const a of [...anchors(input.body,input.baseUrl),...frames]) {
          const u=new URL(a.url);
          if (u.origin!==origin || !/\/webapps\/(?:blackboard\/content\/(?:listContent|launchLink)\.jsp|assignment\/uploadAssignment)/i.test(u.pathname)) continue;
          // launchLink 的工具入口会跳转论坛、小组等；课程目录只需 toc_id。
          if (/\/launchLink\.jsp$/i.test(u.pathname) && !u.searchParams.has('toc_id')) continue;
          if (u.searchParams.get('course_id') && `blackboard:${u.searchParams.get('course_id')}`!==page.course!.id) continue;
          u.hash='';
          if (seen.has(canonical(u.href))) continue;
          if (page.depth>=6) throw new Error('BB 内容目录超过 6 层，本轮未覆盖旧数据');
          enqueue({url:u.href,kind:'content',course:page.course,depth:page.depth+1,title:a.title});
        }
      }
      return queue.length ? {summary:`已读取 ${count} 页`} : finish();
    }},
    next:()=> queue.length ? {next:'page',requests:[request()]} : null,
  };
}
