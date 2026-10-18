import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {courseTerm,currentAcademicTerm,currentTermSnapshot} from '../../../app/academic-term.ts';
import {blackboardCurrentCourses,gradescopeCourses} from './parsers.ts';
import {ENTRY,defaultSettings,type Provider} from './model.ts';
import type {AcademicSnapshot} from './connectors.ts';
import {projectAcademic} from './projection.ts';
import {widgetSnapshot,type WidgetData} from '../../../platform/widget-data.ts';
import {syncProvider} from '../../../platform/widget-runner.ts';
import {academicReminders} from '../../../platform/academic-reminders.ts';
import {platformDdls} from '../../../app/ddl-items.ts';

const now=Date.parse('2026-10-18T12:00:00+08:00');
const data=():WidgetData=>({snapshots:[],settings:defaultSettings(),corrections:{lessons:{},assignments:{}},enabled:{},tasks:[],courses:[]});
const bbLink=(id:string)=>`<a href="/webapps/blackboard/execute/launcher?type=Course&amp;id=${id}">同名课程</a>`;
const module=(title:string,body:string)=>`<div class="portlet clearfix"><h2><span class="moduleTitle">${title}</span></h2>${body}</div>`;
const current=(body:string)=>module('未完成课程列表（Uncompleted Course List）',body);
const pending=(body:string)=>module('待完成作业',body);
const assignmentUrl=(id:string)=>new URL(`/webapps/assignment/uploadAssignment?content_id=_9_1&course_id=${id}`,ENTRY.blackboard).href;
const bbAll=module('总课程列表',bbLink('_1_1')+bbLink('_2_1'))+current(bbLink('_1_1'))+module('已完成课程列表',bbLink('_2_1'));
const gsAll='<div class="courseList"><div class="courseList--term">Fall 2026</div><a href="/courses/1"><h3>同名课程</h3></a><div class="courseList--term">Spring 2026</div><a href="/courses/2">同名课程</a><div class="courseList--term">Fall 2025</div><a href="/courses/3">旧课</a><div class="courseList--term">Spring 2027</div><a href="/courses/4">未来课</a></div>';
const gsAssignment='<table class="assignment-list"><tr><td><a href="/courses/1/assignments/10">HW2</a></td><td class="dueDate"><time datetime="2026-10-20T23:59:00+08:00"></time></td><td>Not Submitted</td></tr></table>';
function cached(provider:Provider='gradescope'):AcademicSnapshot {
  const courses=['Fall 2026','Spring 2026','Fall 2025','Spring 2027',''].map((term,i)=>({id:`${provider}:${i+1}`,title:`同名课程 ${term}`,term,provider,code:'',url:`https://www.gradescope.com/courses/${i+1}`}));
  return {provider,courses,syncedAt:now-1000,semester:'',periods:[],rules:[],assignments:courses.flatMap(c=>[false,true].map(undated=>({id:`${c.id}:${undated}`,courseId:c.id,title:'HW2',provider,url:`${c.url}/assignments/10`,dueAt:undated?null:now+86400000,lateDueAt:null,dueText:'',status:'not_submitted' as const})))};
}

test('上海时区春秋边界、跨年一月、夏冬和年份不混淆',()=>{
  assert.equal(currentAcademicTerm(now),'Fall 2026');
  for(const [date,term] of [['2027-01-31T15:59:59Z','Fall 2026'],['2027-01-31T16:00:00Z','Spring 2027'],['2026-07-31T15:59:59Z','Spring 2026'],['2026-07-31T16:00:00Z','Fall 2026']])assert.equal(currentAcademicTerm(Date.parse(date)),term);
  for(const [input,term] of [['2026 fall','Fall 2026'],['FALL 2026','Fall 2026'],['EE140 2026-2027学年秋季学期','Fall 2026'],['2025-2026学年春季学期','Spring 2026'],['EE140 (2026-2027-1 term)','Fall 2026'],['2025-2026-2 term','Spring 2026'],['Summer 2026','Summer 2026'],['Winter 2026','Winter 2026']])assert.equal(courseTerm(input),term);
  assert.equal(courseTerm('HW2 due 2026-10-20'),null);
});
test('BB 只认真实未完成模块；忽略排序控件、总列表、已完成列表及重复入口',()=>{
  const html='<option>未完成课程列表（Uncompleted Course List）</option>'+bbAll;
  assert.deepEqual(blackboardCurrentCourses(html,ENTRY.blackboard).map(c=>c.id),['blackboard:_1_1']);
  assert.deepEqual(blackboardCurrentCourses(current('<ul class="portletList-img courseListing"></ul>'),ENTRY.blackboard),[]);
  for(const html of [bbLink('_1_1'),'<option>未完成课程列表</option>',current('<p>请等待模块加载完成</p>'),current('<p>未知新结构</p>'),current('<ul class="courseListing"><a href="/unknown">课程</a></ul>')])assert.throws(()=>blackboardCurrentCourses(html,ENTRY.blackboard));
});
test('Gradescope 学期来自分组；导航重复链接不能覆盖课程卡片的学期',()=>{
  const courses=gradescopeCourses('<nav><a href="/courses/1">导航</a></nav>'+gsAll,ENTRY.gradescope);
  assert.deepEqual(courses.map(c=>c.term),['Fall 2026','Spring 2026','Fall 2025','Spring 2027']);
});
test('旧缓存、无日期作业和个人改期不越过学期范围；App/挂件/提醒共用',()=>{
  const d=data();d.snapshots=[cached()];d.settings.reminders=true;d.settings.dueLead=60;
  const before=JSON.stringify(d.snapshots),history=d.snapshots[0].assignments[2];
  d.corrections.assignments[history.id]={dueAt:now+7200000,done:false};
  const scoped=d.snapshots.map(s=>currentTermSnapshot(s,now));
  assert.equal(scoped[0].courses.length,1);assert.equal(scoped[0].assignments.length,2);
  assert.deepEqual(platformDdls(scoped,{},d.corrections.assignments).map(a=>a.id),['gradescope:1:false']);
  assert.deepEqual(widgetSnapshot(d,now).items.map(a=>a.id),['gradescope:1:false','gradescope:1:true']);
  assert.deepEqual(projectAcademic(d.snapshots,d.settings,d.corrections,now).filter(e=>e.type==='academic_event').map(e=>e.id),['gradescope:1:false']);
  assert.equal(academicReminders(d.snapshots,d.settings,d.corrections,d.enabled,now).length,1);
  assert.equal(JSON.stringify(d.snapshots),before);
  d.settings.selectedCourses.gradescope=['gradescope:2'];
  assert.equal(widgetSnapshot(d,now).items.length,0);assert.equal(academicReminders(d.snapshots,d.settings,d.corrections,d.enabled,now).length,0);
  d.tasks=[{id:'local',title:'自建',kind:'ddl',courseId:null,dueAt:now+86400000,status:'open',createdAt:now,updatedAt:now}];
  assert.deepEqual(widgetSnapshot(d,now).items.map(a=>a.id),['local']);
});
test('BB 新缓存以未完成分组为准，跨学期失效；旧缓存可从完整课程名恢复',()=>{
  const snap=cached('blackboard');snap.courseScope='Fall 2026';
  assert.equal(currentTermSnapshot(snap,now).courses.length,5);
  assert.equal(currentTermSnapshot(snap,Date.parse('2027-03-01T00:00:00+08:00')).assignments.length,0);
  delete snap.courseScope;snap.courses[0].title='EE140 2026-2027学年秋季学期';snap.courses[0].term='';
  assert.equal(currentTermSnapshot(snap,now).assignments.length,2);
  const eams={...cached('eams')};assert.equal(currentTermSnapshot(eams,now),eams);
});
test('GS 同步只请求本期课程，清理本轮历史作业，失败页保留本期旧作业',async()=>{
  const d=data();d.snapshots=[cached()];const urls:string[]=[];
  const result=await syncProvider('gradescope',d,async r=>{urls.push(r.url);return {body:r.url===ENTRY.gradescope?gsAll:gsAssignment,status:200,url:r.url};},now);
  assert.deepEqual(urls,[ENTRY.gradescope,'https://www.gradescope.com/courses/1']);
  assert.equal(result.courses.length,1);assert.ok(result.assignments.every(a=>a.courseId==='gradescope:1'));
  // 解析失败前已发布的门户快照也只含当前课程旧作业，不误删为已提交。
  const mod=(await import('./connectors.ts')).createConnector('gradescope');
  await mod.plan!({trigger:'manual',now,settings:{previousSnapshot:JSON.stringify(cached())}});
  const parsed=await mod.parsers!.page({body:gsAll,baseUrl:ENTRY.gradescope,status:200});
  const partial=JSON.parse(String(parsed.entities![0].data.json)) as AcademicSnapshot;
  assert.equal(partial.assignments.length,2);
  assert.throws(()=>mod.parsers!.page({body:'未知作业结构',baseUrl:'https://www.gradescope.com/courses/1',status:200}));
  assert.equal(partial.assignments[0].status,'not_submitted');
});
test('仅历史学期是可靠空结果，仅请求入口；未知学期明确失败',async()=>{
  for(const [provider,body] of [['gradescope',gsAll.replace('Fall 2026','Spring 2025')],['blackboard',current('<ul class="courseListing"></ul>')]] as const){
    const urls:string[]=[];const d=data();d.snapshots=[cached(provider)];
    const result=await syncProvider(provider,d,async r=>{urls.push(r.url);return {body,status:200,url:r.url};},now);
    assert.deepEqual(urls,[ENTRY[provider]]);assert.deepEqual(result.courses,[]);assert.deepEqual(result.assignments,[]);assert.equal(result.courseScope,'Fall 2026');
  }
  await assert.rejects(syncProvider('gradescope',data(),async r=>({body:'<a href="/courses/1">无学期课程</a>',status:200,url:r.url}),now),/未识别到学期/);
});
test('BB 待完成模块包含历史作业也不访问；旧作业轮转核对仅限本学期',async()=>{
  const d=data();const old=cached('blackboard');old.courses=[{...old.courses[0],id:'blackboard:_1_1'},{...old.courses[1],id:'blackboard:_2_1'}];
  old.assignments=old.courses.map(c=>({...old.assignments[0],id:`${c.id}:assignment:_9_1`,courseId:c.id,url:assignmentUrl(c.id.split(':')[1])}));
  d.snapshots=[old];const urls:string[]=[];
  const result=await syncProvider('blackboard',d,async r=>{urls.push(r.url);return {status:200,url:r.url,body:r.url===ENTRY.blackboard?bbAll+pending(`<a href="${assignmentUrl('_2_1')}">旧作业</a>`):'<h1>HW2</h1>作业信息 截止日期：2026年10月20日 下午11:59 未提交'};},now);
  assert.equal(urls.length,2);assert.ok(urls[1].includes('course_id=_1_1'));assert.equal(result.assignments.length,1);assert.equal(result.assignments[0].needsReview,false);
});
