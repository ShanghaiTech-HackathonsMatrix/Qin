import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {widgetSnapshot,taskTarget,type WidgetData} from './widget-data.ts';
import {defaultSettings} from '../plugins/builtin/academic/model.ts';
import {compareTasks,taskCategory} from '../app/task-status.ts';
import {platformDdls} from '../app/ddl-items.ts';
import {compactDdlLabels} from '../app/ddl-labels.ts';
import {simulatedPage} from '../plugins/builtin/academic/simulate.ts';
import {syncProvider} from './widget-runner.ts';
import {academicReminders} from './academic-reminders.ts';
import {validateManifest} from '@matrix/plugin-api';
const now=new Date('2026-10-18T00:00:00+08:00').getTime();
const data=():WidgetData=>({snapshots:[],settings:defaultSettings(),corrections:{lessons:{},assignments:{}},enabled:{},tasks:[],courses:[]});
test('任务时间顺序跨状态稳定，无日期末尾；挂件与App同序',()=>{
  const rows=[{id:'b',title:'B',dueAt:20,done:false},{id:'z',dueAt:null},{id:'a',dueAt:20,done:true},{id:'d',dueAt:1,needsReview:true}];
  assert.deepEqual([...rows].sort(compareTasks).map(t=>t.id),['d','a','b','z']);
  const d=data();d.tasks=rows.map(t=>({id:t.id,title:t.title??t.id,kind:'ddl',courseId:null,dueAt:t.dueAt,status:t.done?'done':'open',createdAt:0,updatedAt:0}));
  assert.deepEqual(widgetSnapshot(d,now).items.map(t=>t.id),['d','b','z']);
  assert.equal(widgetSnapshot(d,now).schedule.length,0);assert.match(widgetSnapshot(d,now).scheduleNote,/第 1 周/);
});
test('BB只生成课程入口；GS作业入口；拒绝任意跳转',()=>{
  assert.equal(taskTarget({id:'1',provider:'blackboard',url:'https://elearning.shanghaitech.edu.cn:8443/webapps/assignment/x',courseUrl:'https://elearning.shanghaitech.edu.cn:8443/webapps/blackboard/content/listContent.jsp?course_id=_123_1'}),'https://elearning.shanghaitech.edu.cn:8443/webapps/blackboard/execute/launcher?type=Course&id=_123_1');
  assert.equal(taskTarget({id:'1',provider:'blackboard',url:'https://elearning.shanghaitech.edu.cn:8443/assignment'}),'');
  assert.equal(taskTarget({id:'1',provider:'gradescope',url:'https://www.gradescope.com/courses/1/assignments/2?foo=3#x'}),'https://www.gradescope.com/courses/1/assignments/2');
  for(const url of ['https://evil.test/courses/1/assignments/2','http://www.gradescope.com/courses/1/assignments/2','https://www.gradescope.com/account'])assert.equal(taskTarget({id:'1',provider:'gradescope',url}),'');
});

test('快照保留六条以外的任务，由原生按挂件尺寸决定容量',()=>{
  const d=data();d.tasks=Array.from({length:30},(_,i)=>({id:`task-${i}`,title:`任务${i}`,kind:'ddl',courseId:null,dueAt:now+(30-i)*60000,status:'open',createdAt:0,updatedAt:0}));
  const rows=widgetSnapshot(d,now).items;
  assert.equal(rows.length,30);assert.equal(rows[0].id,'task-29');assert.equal(rows[29].id,'task-0');
});
test('后台使用真实GS连接器；个人确认不改平台提交；停用不发布',async()=>{
  const d=data();const snapshot=await syncProvider('gradescope',d,async r=>({body:simulatedPage(r.url,now)??'',status:200,url:r.url}),now);
  assert.ok(snapshot.assignments.length);d.snapshots=[snapshot];
  const a=snapshot.assignments.find(a=>a.dueAt!==null)!;d.corrections.assignments[a.id]={done:false,needsReview:false};
  const row=platformDdls(d.snapshots,{},d.corrections.assignments).find(t=>t.id===a.id)!;
  assert.equal(taskCategory(row,now)==='review',false);const status=a.status;
  d.corrections.assignments[a.id]={done:true,needsReview:false};
  assert.equal(widgetSnapshot(d,now).items.some(t=>t.id===a.id),false);assert.equal(a.status,status);
  d.enabled.gradescope=false;assert.equal(widgetSnapshot(d,now).items.length,0);
  d.settings.reminders=true;assert.equal(academicReminders(d.snapshots,d.settings,d.corrections,d.enabled,now).length,0);
  await assert.rejects(syncProvider('gradescope',data(),async r=>({body:'',status:302,url:r.url,headers:{location:'https://auth.example.test/login'}}),now),/LOGIN_REQUIRED/);
  await assert.rejects(syncProvider('gradescope',data(),async r=>({body:'login',status:200,url:r.url}),now));
});
test('外部账号须精确声明站点与provider，拒绝内置会话复用',()=>{
  const m={id:'org.example.account',name:'账号示例',version:'1.0.0',apiVersion:'^1.0.0',kind:'connector',entry:'bundle.js',permissions:{net:{domains:['example.org'],methods:['GET']},auth:{providers:['main']}},contributes:{accounts:[{id:'main',title:'示例账号',loginUrl:'https://example.org/login',authOrigins:['https://example.org'],dataOrigins:['https://example.org']}]}};
  assert.equal(validateManifest(m).ok,true);
  assert.equal(validateManifest({...m,permissions:{...m.permissions,auth:{providers:['blackboard']}}}).ok,false);
  assert.equal(validateManifest({...m,contributes:{accounts:[{...m.contributes.accounts[0],dataOrigins:['https://evil.test']}]}}).ok,false);
});

test('App 与挂件共用缩名，保留完整原文、标识、时间和跳转；个人标题优先',async()=>{
  const d=data();const snapshot=await syncProvider('gradescope',d,async r=>({body:simulatedPage(r.url,now)??'',status:200,url:r.url}),now);
  const first=snapshot.assignments.find(a=>a.dueAt!==null)!;
  first.title='Homework 02';first.status='not_submitted';
  const course=snapshot.courses.find(c=>c.id===first.courseId)!;course.title='数据结构（2026秋）';
  d.snapshots=[snapshot];
  const before=JSON.stringify(d),original=platformDdls(d.snapshots,{},{}),labels=compactDdlLabels(original),rows=widgetSnapshot(d,now).items;
  const row=rows.find(t=>t.id===first.id)!;
  assert.equal(row.title,'HW2');assert.equal(row.course,'数据结构');
  assert.equal(row.title,labels.get(first.id)?.title);assert.equal(row.course,labels.get(first.id)?.course);
  assert.equal(row.fullTitle,first.title);assert.equal(row.fullCourse,course.title);
  assert.equal(row.dueAt,first.dueAt);assert.equal(row.target,taskTarget(first));assert.equal(JSON.stringify(d),before);
  d.corrections.assignments[first.id]={title:'Homework 02 自己的名称'};
  assert.equal(widgetSnapshot(d,now).items.find(t=>t.id===first.id)?.title,'Homework 02 自己的名称');
  // 消歧先于完成筛选：已完成的同名任务也参与，避免筛选后名称反复变化。
  d.corrections.assignments={};snapshot.assignments.push({...first,id:'collision',title:'HW2',status:'submitted'});
  assert.equal(widgetSnapshot(d,now).items.find(t=>t.id===first.id)?.title,'Homework 02');
  snapshot.assignments.find(a=>a.id==='collision')!.dueAt=null;
  assert.equal(widgetSnapshot(d,now).items.find(t=>t.id===first.id)?.title,'Homework 02');
});
