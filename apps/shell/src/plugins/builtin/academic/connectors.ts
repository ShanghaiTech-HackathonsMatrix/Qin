import type { Manifest, ParseInput, ParseResult, PluginExports, PlannedRequest } from '@matrix/plugin-api';
import { anchors, attr, requirePage } from './html.ts';
import { blackboardAssignment, blackboardCourses, blackboardCurrentCourses, blackboardPending, eamsSelection, eamsTimetable, gradescopeAssignments, gradescopeCourses } from './parsers.ts';
import {courseTerm,currentAcademicTerm,currentTermSnapshot} from '../../../app/academic-term.ts';
import { ENTRY, PLUGIN_IDS, type AcademicCourse, type Assignment, type LessonRule, type Period, type Provider } from './model.ts';

export const SNAPSHOT = 'academic_snapshot';
export const MAX_ACADEMIC_PAGES = 600;
export interface AcademicSnapshot {
  provider: Provider; syncedAt: number; courses: AcademicCourse[]; assignments: Assignment[]; rules: LessonRule[];
  periods: Period[]; semester: string;
  mode?:string;
  /** 已可靠识别的本期课程范围；BB 以未完成课程分组为准，供旧缓存跨学期失效。 */
  courseScope?:string;
}
export function connectorManifest(provider: Provider): Manifest {
  return { id:PLUGIN_IDS[provider], name:{gradescope:'Gradescope 作业',blackboard:'Blackboard 作业',eams:'教务课表'}[provider], version:'0.1.0', apiVersion:'^1.0.0', kind:'first-party',
    permissions:{ net:{domains:[new URL(ENTRY[provider]).hostname], methods: provider==='eams'?['GET','POST']:['GET']}, data:{write:[SNAPSHOT],read:[SNAPSHOT]}, auth:{providers:[provider]} },
    contributes:{entityTypes:[{name:SNAPSHOT, schema:{ type:'object', properties:{json:{type:'string',maxLength:2*1024*1024,shared:false}},required:['json'],additionalProperties:false }}]} };
}
interface Page { url: string; kind: string; course?: AcademicCourse; depth: number; title?: string; body?: string }
/** 每页累积写回并保留未读到的旧作业，尾页超时也不会丢弃已成功的读取。 */
export function createConnector(provider: Provider): PluginExports {
  let snapshot: AcademicSnapshot;
  let queue: Page[] = [], seen = new Set<string>(), page: Page, count = 0, parsed = 0;
  let settings: Record<string,string> = {};
  let previous:AcademicSnapshot|undefined;
  const merge=(rows:Assignment[])=>{for(const row of rows){const index=snapshot.assignments.findIndex(a=>a.id===row.id);const old=index<0?undefined:snapshot.assignments[index];const next={...row,verifiedAt:snapshot.syncedAt,needsReview:row.status==='unknown'&&old?.needsReview,completedAt:['submitted','graded'].includes(row.status)?old?.completedAt??snapshot.syncedAt:undefined};if(index<0)snapshot.assignments.push(next);else snapshot.assignments[index]=next;}};
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
  const finish = (): ParseResult => {
    /*
      仅在可靠识别本期范围后接受空课程（例如只有历史学期）。
      未读到页面或结构未知仍失败，不能把读取异常当成「本期无课」。
    */
    if (snapshot.courses.length === 0 && !snapshot.courseScope) throw new Error('这一轮没读到任何课程，已保留上次结果');
    /*
      丢页保护。`broker` 允许单页失败后继续扫（那是对的 —— 一页超时不该连坐
      整轮），但「一页失败」和「大半失败」是两件事：后者说明这次网络根本不通，
      已读页已累计保存，旧作业始终保留；丢了一半以上时报告不完整。
    */
    const lost = count - parsed;
    if (lost > 0 && parsed < count / 2) throw new Error(`这一轮只读回 ${parsed}/${count} 页，已保留上次结果`);
    return {entities:[{type:SNAPSHOT,id:'current',data:{json:JSON.stringify(snapshot)}}],summary:`课程 ${snapshot.courses.length}，作业 ${snapshot.assignments.length}，排课规则 ${snapshot.rules.length}`};
  };
  return {
    plan(input) {
      settings=input.settings??{}; queue=[];seen=new Set();count=0;parsed=0;
      previous=settings.previousSnapshot?JSON.parse(settings.previousSnapshot):undefined;
      snapshot={provider,syncedAt:input.now,courses:[],assignments:previous?.assignments.map(a=>({...a}))??[],rules:[],periods:[],semester:''};
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
        const allCourses=provider==='gradescope'?gradescopeCourses(input.body,input.baseUrl):blackboardCurrentCourses(input.body,input.baseUrl);
        if(provider==='gradescope' && allCourses.some(c=>!courseTerm(c.term)))throw new Error('部分 Gradescope 课程未识别到学期，已保留上次数据，请检查课程分组');
        snapshot.courseScope=currentAcademicTerm(snapshot.syncedAt);
        snapshot.courses=allCourses;
        snapshot=currentTermSnapshot(snapshot,snapshot.syncedAt);
        const selection=selected();
        const courses=snapshot.courses.filter(c=>selection===null||selection.includes(c.id));
        if (courses.length>60) throw new Error('课程超过 60 门，请选择需要同步的课程');
        if(provider==='blackboard' && settings.scanMode!=='deep' && courses.length) {
          const pending=blackboardPending(input.body,input.baseUrl,blackboardCourses(input.body,input.baseUrl));
          // 不再提「扫描课程目录」按钮 —— 它已合并进「同步」，宿主机在失败时会自动改走深度扫描
    if(!pending) throw new Error('未识别 BB 待完成作业模块，已保留历史数据');
          snapshot.mode='pending';
          const listed=new Set<string>();
          const active=new Set(courses.map(c=>c.id));
          for(const link of pending.links.filter(x=>active.has(x.course.id))) {
            enqueue({...link,kind:'assignment',depth:0});
            const u=new URL(link.url);listed.add(`${link.course.id}:assignment:${u.searchParams.get('content_id')??u.searchParams.get('assign_group_id')}`);
          }
          const missing=snapshot.assignments.filter(a=>!listed.has(a.id)&&!['submitted','graded'].includes(a.status)&&(selection===null||selection.includes(a.courseId)));
          for(const a of missing)a.needsReview=true;
          // 每轮核对最多 8 个消失条目，按上次核对时间轮转；消失不等于已提交。
          for(const a of missing.sort((a,b)=>(a.verifiedAt??0)-(b.verifiedAt??0)).slice(0,8)) {
            const course=snapshot.courses.find(c=>c.id===a.courseId);
            if(course)enqueue({url:a.url,title:a.title,course,kind:'assignment',depth:0});
          }
        } else {
          snapshot.mode=provider==='blackboard'?'deep':'courses';
          for (const course of courses) enqueue({url:course.url,kind:'course',course,depth:0});
        }
      } else if (provider==='gradescope') {
        merge(gradescopeAssignments(input.body,page.course!,settings.gradescopeTimezone??''));
      } else {
        const assignment=blackboardAssignment(input.body,input.baseUrl,page.course!,page.title??page.course!.title);
        if (assignment) merge([assignment]);
        const origin=new URL(ENTRY.blackboard).origin;
        const frames=[...input.body.matchAll(/<(?:frame|iframe)\b[^>]*>/gi)].flatMap(m=>{
          try {const src=attr(m[0],'src');return src?[{url:new URL(src,input.baseUrl).href,title:page.course!.title}]:[];}catch{return [];}
        });
        for (const a of [...anchors(input.body,input.baseUrl),...frames]) {
          if(snapshot.mode==='pending')break;
          const u=new URL(a.url);
          if (u.origin!==origin || !/\/webapps\/(?:blackboard\/content\/(?:listContent|launchLink)\.jsp|assignment\/uploadAssignment)/i.test(u.pathname)) continue;
          // launchLink 的工具入口会跳转论坛、小组等；课程目录只需 toc_id。
          if (/\/launchLink\.jsp$/i.test(u.pathname) && !u.searchParams.has('toc_id')) continue;
          if (u.searchParams.get('course_id') && `blackboard:${u.searchParams.get('course_id')}`!==page.course!.id) continue;
          /*
            「已经交过的不用再搜」。
            深度扫描的目的只有一个：把已经交掉、却因为不在「待完成作业」模块里
            而读不到的作业补回来。上一轮已经确认是已提交 / 已批改的作业页，
            状态不会再变回「没交」，重抓只是把同一个结论再读一遍，代价是一整页。
            一轮扫描动辄几百页，重复跑全靠这一条省下来。
          */
          if (/\/assignment\/uploadAssignment(?:\.jsp)?$/i.test(u.pathname)) {
            const native=u.searchParams.get('content_id')??u.searchParams.get('assign_group_id');
            const known=native===null?undefined:snapshot.assignments.find(a=>a.id===`${page.course!.id}:assignment:${native}`);
            if (known!==undefined && (known.status==='submitted'||known.status==='graded')) continue;
          }
          u.hash='';
          if (seen.has(canonical(u.href))) continue;
          if (page.depth>=6) throw new Error('BB 内容目录超过 6 层，本轮未覆盖旧数据');
          enqueue({url:u.href,kind:'content',course:page.course,depth:page.depth+1,title:a.title});
        }
      }
      parsed+=1;
      return queue.length ? {entities:snapshot.courses.length?[{type:SNAPSHOT,id:'current',data:{json:JSON.stringify(snapshot)}}]:[],summary:`已读取 ${parsed}/${count} 页 · ${snapshot.assignments.length} 项作业`} : finish();
    }},
    next:()=> queue.length ? {next:'page',requests:[request()]} : null,
  };
}
