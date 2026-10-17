import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { anchors, parseDeadline } from './html.ts';
import { gradescopeCourses, gradescopeAssignments, blackboardCourses, blackboardAssignment, blackboardPending, eamsSelection, eamsTimetable } from './parsers.ts';
import { defaultSettings, ENTRY, PLUGIN_IDS, parseWeeks, expandLessons, type AcademicCourse } from './model.ts';
import { createConnector, connectorManifest, SNAPSHOT, type AcademicSnapshot } from './connectors.ts';
import { ACADEMIC_ID, projectionManifest, projectionPlugin } from './projection.ts';
import { AcademicService } from '../../../core/academic-service.ts';
import { AcademicTransport, academicSessionFor } from '../../../core/academic-transport.ts';
import { createCore, MockTransport } from '../../../core/index.ts';
import { PluginHost } from '../../../core/plugin-host.ts';
import { explainSyncError, splitSyncErrors } from '../../../core/sync-errors.ts';
import { KvEntityBackend } from '../../../core/kv-entity-backend.ts';
import type { SecureStore } from '../../../platform/strategies/kv/types.ts';
import type { NotifyPort, ScheduledNotification } from '../../../core/notify/port.ts';
import { manifest as timelineManifest, timelinePlugin, PLUGIN_ID as TIMELINE_ID } from '../timeline/index.ts';

// 全部为合成样本，不含真实学生、课程或会话。
const account='<h2>Fall 2026</h2><a href="/courses/11"><h3>示例课程</h3></a><a href="https://other.example/courses/99">外站</a>';
const course:AcademicCourse={id:'gradescope:11',title:'示例课程',code:'',provider:'gradescope',term:'Fall 2026',url:'https://www.gradescope.com/courses/11'};
const entry='addInput(form,"ids","999"); semesterCalendar({value:"100"});';
const table=(bits='0101',room='教室A')=>`<script>
activity = new TaskActivity("t", "示例教师", "c", "示例课程(CS0)", "r", "${room}", "${bits}");
index = 0 * unitCount + 0; index = 0 * unitCount + 1; index = 6 * unitCount + 3; index = 0 * unitCount + 4;
</script>`;

test('Gradescope 从最近学期标题取年份，拒绝外站与空链接',()=>{
  const courses=gradescopeCourses(account+'<h2>Spring 2027</h2><a href="/courses/12">新课</a>',ENTRY.gradescope);
  assert.deepEqual(courses.map(c=>c.term),['Fall 2026','Spring 2027']);
  assert.equal(anchors('<a>空</a><a href="#x">锚</a><a href="javascript:go()">脚本</a>',ENTRY.gradescope).length,0);
});
test('Gradescope 按日期列读取正常与补交截止时间，未提交优先',()=>{
  const html='<table><tr><td><a href="/courses/11/assignments/2">作业</a></td><td class="dueDate"><time datetime="2026-10-20T23:00:00+08:00"></time><time datetime="2026-10-21T23:00:00+08:00"></time></td><td>Not Submitted 0 / 10</td></tr></table>';
  const [a]=gradescopeAssignments(html,course,'');
  assert.equal(a.status,'not_submitted');assert.equal(a.dueAt,Date.parse('2026-10-20T23:00:00+08:00'));
  assert.equal(a.lateDueAt,Date.parse('2026-10-21T23:00:00+08:00'));
});
test('模糊时区不猜测；秋季跨年、中文星期和非法日期',()=>{
  assert.equal(parseDeadline('Jan 5 at 11:59PM','Fall 2026',''),null);
  assert.equal(parseDeadline('Jan 5 at 11:59PM','Fall 2026','Asia/Shanghai'),Date.parse('2027-01-05T23:59:00+08:00'));
  assert.equal(parseDeadline('2026年10月20日 星期二 下午11:59','','Asia/Shanghai'),Date.parse('2026-10-20T23:59:00+08:00'));
  assert.equal(parseDeadline('2026年2月30日 下午11:59','','Asia/Shanghai'),null);
});
test('平台网页格式：BB launcher 的 id；GS 带时区日期排除发布时间',()=>{
  const courses=blackboardCourses('<a href=" /webapps/blackboard/execute/launcher?type=Course&amp;id=_123_1&amp;url=">示例</a>',ENTRY.blackboard);
  assert.equal(courses[0].id,'blackboard:_123_1');
  assert.throws(()=>blackboardCourses('<a href="/webapps/other?id=_123_1">无关</a>',ENTRY.blackboard));
  const html='<table><tr><th><a href="/courses/11/assignments/2">作业</a></th><td><time class="submissionTimeChart--releaseDate" datetime="2026-10-01 08:00:00 +0800"></time><time class="submissionTimeChart--dueDate" datetime="2026-10-20 23:59:00 +0800"></time><time class="submissionTimeChart--dueDate" datetime="2026-10-21 12:00:00 +0800"></time></td></tr></table>';
  const [a]=gradescopeAssignments(html,course,'');
  assert.equal(a.dueAt,Date.parse('2026-10-20T23:59:00+08:00'));
  assert.equal(a.lateDueAt,Date.parse('2026-10-21T12:00:00+08:00'));
});
test('BB 保留稳定作业ID并读取中文截止时间与未提交状态',()=>{
  const c={...course,id:'blackboard:_1_1',provider:'blackboard' as const};
  const a=blackboardAssignment('<h1 class="hideoff">打开快速链接</h1><h1 id="pageTitleHeader">复查提交历史记录: 练习</h1>截止日期：2026年10月20日 星期二 下午11:59 未提交','https://elearning.shanghaitech.edu.cn:8443/webapps/assignment/uploadAssignment?content_id=_2_1',c,'');
  assert.equal(a?.title,'练习');
  assert.equal(a?.dueAt,Date.parse('2026-10-20T23:59:00+08:00'));assert.equal(a?.status,'not_submitted');
});
test('教务动态参数、断续周、周末及不连续节次；错误页明确失败',()=>{
  assert.equal(eamsSelection(entry,'').body,'setting.kind=std&startWeek=&semester.id=100&ids=999');
  assert.equal(eamsSelection(entry,'101').semester,'101');
  const p=eamsTimetable(table(),'100');
  assert.equal(p.courses.length,1);assert.equal(p.rules.length,3);
  assert.deepEqual(p.rules.map(r=>[r.weekday,r.first,r.last,r.weeks]),[[1,1,2,[1,3]],[1,5,5,[1,3]],[7,4,4,[1,3]]]);
  assert.throws(()=>eamsTimetable('error.courseTable.unknown','100'));
  assert.throws(()=>eamsTimetable(table('110'),'100'));
  assert.ok(eamsTimetable(table().replace('示例教师',',； '),'100').rules.every(r=>r.teacher===''));
});
test('只保留个人备注，识别字段修正不再影响课次；未确认第一周不生成提醒',()=>{
  const rules=eamsTimetable(table(),'100').rules,s=defaultSettings(),r=rules[0];
  assert.deepEqual(parseWeeks('1-8单周'),[1,3,5,7]);assert.deepEqual(parseWeeks('2-8双周,10'),[2,4,6,8,10]);
  assert.equal(expandLessons([r],s,{lessons:{},assignments:{}}).length,0);
  s.weekOne='2026-10-12';s.periods[0]={...s.periods[0],start:'08:00'};
  const events=expandLessons([r],s,{lessons:{[r.id]:{weeks:[2],note:'个人备注'}},assignments:{}});
  assert.equal(events[0].startAt,Date.parse('2026-10-12T08:00:00+08:00'));assert.match(events[0].detail,/个人备注/);
  assert.throws(()=>expandLessons([r],{...s,weekOne:'2026-10-13'},{lessons:{},assignments:{}}));
});

class MemoryKv implements SecureStore {
  encrypted=false;map=new Map<string,string>();
  async get(k:string){return this.map.get(k)??null;} async set(k:string,v:string){this.map.set(k,v);}
  async remove(k:string){this.map.delete(k);} async keys(){return [...this.map.keys()];}
}
class Notifications implements NotifyPort {
  backend='test';items=new Map<string,ScheduledNotification>();fail=false;
  async probe(){} isSupported(){return true;} capabilities(){return {exact:true,maxPending:400,lostOnReboot:false,requiresPermission:true};}
  async checkPermission(){return 'granted' as const;} async requestPermission(){return 'granted' as const;}
  async schedule(items:readonly ScheduledNotification[]){if(this.fail)throw new Error('系统排程失败');for(const i of items)this.items.set(i.id,i);}
  async cancel(ids:readonly string[]){for(const id of ids)this.items.delete(id);} async cancelAll(){this.items.clear();}
  async pending(){return [...this.items.keys()];}
}
async function setup(kv=new MemoryKv()){
  const transport=new MockTransport();
  const host=new PluginHost({core:createCore({transport,gateway:{config:{allowlist:[new URL(ENTRY.eams).hostname]}}}),
    dataBackend:new KvEntityBackend(kv),modules:new Map([[PLUGIN_IDS.eams,createConnector('eams')],[ACADEMIC_ID,projectionPlugin],[TIMELINE_ID,timelinePlugin]])});
  for(const m of [timelineManifest,connectorManifest('eams'),projectionManifest]){
    const result=await host.install(m,{allowReservedPrefix:true});assert.equal(result.ok,true,JSON.stringify(result));
  }
  await host.restoreData();
  const notify=new Notifications(),service=new AcademicService({host,kv,notify,available:true,login:async()=>({completed:true}),clear:async()=>{}});
  await service.init();
  const queue=(body=table())=>{transport.queue(ENTRY.eams,{status:200,body:entry}).queue('https://eams.shanghaitech.edu.cn/eams/courseTableForStd!courseTable.action',{status:200,body});};
  const entities=()=>{const r=host.bus.read(ACADEMIC_ID,'academic_event',{owner:ACADEMIC_ID});assert.ok(r.ok);return r.data;};
  return {kv,transport,host,notify,service,queue,entities};
}
test('真实宿主：重复同步不重复、备注跨周次变化和重启保留、清空删除投影',async()=>{
  const x=await setup();await x.service.saveSettings({...x.service.settings,weekOne:'2026-10-12'});
  x.queue();await x.service.sync('eams');const id=x.service.snapshots[0].rules[0].id;
  await x.service.editLesson(id,{note:'保留备注'});assert.equal(x.entities().length,6);
  x.queue();await x.service.sync('eams');assert.equal(x.entities().length,6);
  x.queue(table('01001','新教室'));await x.service.sync('eams');
  assert.equal(x.service.corrections.lessons[x.service.snapshots[0].rules[0].id].note,'保留备注');
  assert.ok(x.entities().some(e=>String(e.data.detail).includes('新教室')));
  const restarted=await setup(x.kv);assert.equal(restarted.entities().length,6);
  assert.ok(restarted.entities().some(e=>String(e.data.detail).includes('保留备注')));
  await restarted.service.saveSettings({...restarted.service.settings,selectedCourses:{eams:[]}});assert.equal(restarted.entities().length,0);
  await restarted.service.clearData();assert.equal(restarted.entities().length,0);assert.equal(restarted.service.snapshots.length,0);
});
test('真实宿主：网络或HTML解析失败不覆盖旧快照',async()=>{
  const x=await setup();x.queue();await x.service.sync('eams');const old=JSON.stringify(x.service.snapshots);
  x.transport.queue(ENTRY.eams,{status:0,throw:'断网'});await assert.rejects(x.service.sync('eams'));assert.equal(JSON.stringify(x.service.snapshots),old);
  x.queue('error.courseTable.unknown');await assert.rejects(x.service.sync('eams'));assert.equal(JSON.stringify(x.service.snapshots),old);
});
test('真实宿主：通知故障不否认数据同步成功；非法设置不覆盖有效配置',async()=>{
  const x=await setup();x.notify.fail=true;await x.service.saveSettings({...x.service.settings,reminders:true});
  x.queue();await x.service.sync('eams');assert.match(x.service.statuses.eams!,/同步成功/);assert.match(x.service.reminderStatus,/排程失败/);
  const old=JSON.stringify(x.service.settings);await assert.rejects(x.service.saveSettings({...x.service.settings,weekOne:'2026-10-13'}));assert.equal(JSON.stringify(x.service.settings),old);
});
test('平台会话由宿主ID绑定，凭证不能发往其他origin或端口',async()=>{
  const fallback=new MockTransport();let calls=0;
  const transport=new AcademicTransport(fallback,{openExternal:async()=>{},login:async()=>({completed:true}),clear:async()=>{},request:async req=>{calls++;return {status:200,body:'ok',headers:{},url:req.url,followedRedirects:false};}});
  assert.equal(academicSessionFor('third.party'),undefined);assert.equal(academicSessionFor(PLUGIN_IDS.eams),'academic:eams');
  const req={url:ENTRY.eams,method:'GET' as const,headers:{},connectTimeoutMs:1000,readTimeoutMs:1000,session:'academic:eams'};
  await transport.request(req);assert.equal(calls,1);
  for(const url of ['https://other.example/','https://eams.shanghaitech.edu.cn:8443/'])await assert.rejects(transport.request({...req,url}));
  assert.equal(calls,1);
});

test('真实宿主：目录 GET 限流后继续同一页，不重跑或漏页',async()=>{
  const transport=new MockTransport();
  const core=createCore({transport,gateway:{config:{allowlist:['www.gradescope.com'],rateCapacity:1,rateRefillPerSec:100}}});
  const host=new PluginHost({core,modules:new Map([[PLUGIN_IDS.gradescope,createConnector('gradescope')]])});
  assert.ok((await host.install(connectorManifest('gradescope'),{allowReservedPrefix:true})).ok);
  transport.queue(ENTRY.gradescope,{status:200,body:account});
  transport.queue(course.url,{status:200,body:'<table><tr><td><a href="/courses/11/assignments/2">示例作业</a></td><td class="dueDate"><time datetime="2026-10-20T23:00:00+08:00"></time></td></tr></table>'});
  const result=await host.sync(PLUGIN_IDS.gradescope,{trigger:'manual',now:Date.now()});
  assert.ok(result.ok);assert.deepEqual(result.data.errors,[]);
  assert.deepEqual(transport.calls.map(r=>r.url),[ENTRY.gradescope,course.url]);
  assert.ok(host.snapshot().audit.some(e=>e.action==='net.rate_wait'));
});

test('真实宿主：POST 限流明确失败，不重复发送教务表单',async()=>{
  const transport=new MockTransport();
  const core=createCore({transport,gateway:{config:{allowlist:[new URL(ENTRY.eams).hostname],rateCapacity:1,rateRefillPerSec:0.001}}});
  const host=new PluginHost({core,modules:new Map([[PLUGIN_IDS.eams,createConnector('eams')]])});
  assert.ok((await host.install(connectorManifest('eams'),{allowReservedPrefix:true})).ok);
  transport.queue(ENTRY.eams,{status:200,body:entry});
  const result=await host.sync(PLUGIN_IDS.eams,{trigger:'manual',now:Date.now()});
  assert.ok(result.ok);assert.match(result.data.errors.join(' '),/ERATELIMIT/);
  assert.equal(transport.calls.length,1);
});

test('一页课都没读到就失败，不发空快照把旧数据盖掉',async()=>{
  const transport=new MockTransport();
  const core=createCore({transport,gateway:{config:{allowlist:['www.gradescope.com']}}});
  const host=new PluginHost({core,modules:new Map([[PLUGIN_IDS.gradescope,createConnector('gradescope')]])});
  assert.ok((await host.install(connectorManifest('gradescope'),{allowReservedPrefix:true})).ok);
  transport.queue(ENTRY.gradescope,{status:200,body:'<html><body>本学期没有课程</body></html>'});
  const result=await host.sync(PLUGIN_IDS.gradescope,{trigger:'manual',now:Date.now()});
  assert.ok(!result.ok,'空快照必须当成失败');
  assert.match(result.message,/保留上次/);
});

test('单页超时不再连坐：整轮照常出结果，只在报告里记一条',async()=>{
  const transport=new MockTransport();
  const core=createCore({transport,gateway:{config:{allowlist:['www.gradescope.com'],retryCount:0}}});
  const host=new PluginHost({core,modules:new Map([[PLUGIN_IDS.gradescope,createConnector('gradescope')]])});
  assert.ok((await host.install(connectorManifest('gradescope'),{allowReservedPrefix:true})).ok);
  transport.queue(ENTRY.gradescope,{status:200,body:account});
  transport.queue(course.url,{status:0,throw:'SocketTimeoutException'});
  const result=await host.sync(PLUGIN_IDS.gradescope,{trigger:'manual',now:Date.now()});
  assert.ok(result.ok,'一页超时不该让整轮失败');
  assert.match(result.data.errors.join(' '),/page-\d+: ENET /);
});

test('同步错误分类：单页传输错误可忍，解析器抛错与落盘失败不可忍',()=>{
  const {soft,hard}=splitSyncErrors([
    'page-56: ENET 平台请求失败：SocketTimeoutException',
    'page-7: EHTTP 平台返回 500',
    '插件 app.matrix.connector.gradescope 的 parsers.page() 抛出异常: 平台返回 HTTP 401',
    '持久化失败（数据仍在内存中，下次刷新前会重试）：磁盘满了',
    '同步数据未能保存',
  ]);
  assert.deepEqual(soft,[
    'page-56: ENET 平台请求失败：SocketTimeoutException',
    'page-7: EHTTP 平台返回 500',
  ]);
  assert.equal(hard.length,3);
});

test('登录过期（EREDIRECT）不算「某页慢了」，必须整轮失败',()=>{
  const {soft,hard}=splitSyncErrors([
    'page-1: EREDIRECT 跳转目标不在白名单: https://sso.shanghaitech.edu.cn/login',
    'page-9: ETIMEDOUT 平台请求超时',
  ]);
  assert.deepEqual(soft,['page-9: ETIMEDOUT 平台请求超时']);
  assert.equal(hard.length,1,'EREDIRECT 放行下去会读回零页，然后把真正的原因埋掉');
});

test('错误码翻译成人话：EREDIRECT 要说「重新登录」',()=>{
  assert.match(explainSyncError('page-1: EREDIRECT 跳转目标不在白名单'),/重新点「登录」/);
  assert.match(explainSyncError('插件 x 的 parsers.page() 抛出异常: LOGIN_REQUIRED：登录已过期'),/重新登录/);
});

test('单页失败不再中断串行扫描：后面的页面照样扫，快照照样落',async()=>{
  /*
    这条钉的是一个真实事故：学术连接器一轮只发一个请求，靠 `next()` 从自己的
    队列里取下一页。原来 `next()` 只在解析成功时被调用，于是某一页请求失败后，
    队列里剩下的页面再也没人问起 —— 扫描在中间悄悄停住，`finish()` 从没跑过，
    一个实体都没落，报告里却只有一条「可容忍」的传输错误。
  */
  const transport=new MockTransport();
  const core=createCore({transport,gateway:{config:{allowlist:[new URL(ENTRY.blackboard).hostname],retryCount:0}}});
  const host=new PluginHost({core,modules:new Map([[PLUGIN_IDS.blackboard,createConnector('blackboard')]])});
  assert.ok((await host.install(connectorManifest('blackboard'),{allowReservedPrefix:true})).ok);

  const origin=new URL(ENTRY.blackboard).origin;
  // 连接器会把查询参数排序（canonical），这里直接按排序后的形状排应答
  const courseUrl=(id:string)=>`${origin}/webapps/blackboard/execute/launcher?course_id=${id}&id=${id}&type=Course`;
  const portal='<a href="/webapps/blackboard/execute/launcher?type=Course&id=_1_1&course_id=_1_1">操作系统</a>'
    +'<a href="/webapps/blackboard/execute/launcher?type=Course&id=_2_1&course_id=_2_1">算法设计</a>';
  transport.queue(ENTRY.blackboard,{status:200,body:portal});
  // 第一门课的网络直接断掉，第二门课正常
  transport.queue(courseUrl('_1_1'),{status:0,throw:'SocketTimeoutException'});
  transport.queue(courseUrl('_2_1'),{status:200,body:'<html><body>这门课没有作业</body></html>'});

  const result=await host.sync(PLUGIN_IDS.blackboard,{trigger:'manual',now:Date.now(),settings:{scanMode:'deep'}});
  assert.ok(result.ok,'一页失败不该让整轮失败');
  assert.ok(result.data.entities>=1,'快照必须落库 —— 否则用户看到的就是「未得到有效数据」');
  assert.match(result.data.errors.join(' '),/page-2: ENET /,'失败的那一页要留在报告里');
});

const bbCourse:AcademicCourse={id:'blackboard:_1_1',title:'合成课程',code:'',term:'',provider:'blackboard',url:new URL('/webapps/blackboard/execute/launcher?type=Course&id=_1_1',ENTRY.blackboard).href};
const bbPortal='<a href="/webapps/blackboard/execute/launcher?type=Course&id=_1_1">合成课程</a><span class="moduleTitle">待完成作业</span>';
const bbUrl=(i:number)=>new URL(`/webapps/assignment/uploadAssignment?content_id=_${i}_1&course_id=_1_1`,ENTRY.blackboard).href;
test('BB 待完成模块：明确空、结构缺失、非空、拒绝外站',()=>{
  assert.deepEqual(blackboardPending(bbPortal+'您目前没有未完成的作业',ENTRY.blackboard,[bbCourse]),{links:[],empty:true});
  assert.equal(blackboardPending('无模块',ENTRY.blackboard,[bbCourse]),null);
  assert.equal(blackboardPending(bbPortal+'未知结构',ENTRY.blackboard,[bbCourse]),null);
  const html=bbPortal+`<a href="${bbUrl(1)}">作业</a><a href="https://evil.example/webapps/assignment/uploadAssignment?course_id=_1_1&content_id=_2_1">外站</a>`;
  assert.equal(blackboardPending(html,ENTRY.blackboard,[bbCourse])?.links.length,1);
});
test('BB pending 只读门户与作业详情；消失不标完成；8条核对上限及尾页失败保留数据',async()=>{
  const transport=new MockTransport(),host=new PluginHost({core:createCore({transport,gateway:{config:{allowlist:[new URL(ENTRY.blackboard).hostname],retryCount:0}}}),modules:new Map([[PLUGIN_IDS.blackboard,createConnector('blackboard')]])});
  assert.ok((await host.install(connectorManifest('blackboard'),{allowReservedPrefix:true})).ok);
  transport.queue(ENTRY.blackboard,{status:200,body:bbPortal+`<a href="${bbUrl(1)}">作业1</a>`});
  transport.queue(bbUrl(1),{status:200,body:'<h1>作业1</h1>作业信息 截止日期：2026年10月20日 下午11:59 未提交'});
  const first=await host.sync(PLUGIN_IDS.blackboard,{trigger:'manual',now:10});assert.ok(first.ok);assert.equal(first.data.requests,2);
  const previous:AcademicSnapshot={provider:'blackboard',syncedAt:10,courses:[bbCourse],rules:[],periods:[],semester:'',assignments:Array.from({length:10},(_,i)=>({id:`blackboard:_1_1:assignment:_${i+1}_1`,courseId:bbCourse.id,title:`作业${i+1}`,url:bbUrl(i+1),provider:'blackboard',status:'not_submitted',dueAt:100,dueText:'',lateDueAt:null}))};
  transport.queue(ENTRY.blackboard,{status:200,body:bbPortal+'您目前没有未完成的作业'});
  for(let i=1;i<=7;i++)transport.queue(bbUrl(i),{status:200,body:`<h1>作业${i}</h1>作业信息 截止日期：2026年10月20日 下午11:59 未提交`});
  transport.queue(bbUrl(8),{status:0,throw:'SocketTimeoutException'});
  const second=await host.sync(PLUGIN_IDS.blackboard,{trigger:'manual',now:20,settings:{previousSnapshot:JSON.stringify(previous)}});assert.ok(second.ok);assert.equal(second.data.requests,9);
  const read=host.bus.read(PLUGIN_IDS.blackboard,SNAPSHOT,{owner:PLUGIN_IDS.blackboard});assert.ok(read.ok);
  const saved=JSON.parse(String(read.data[0].data.json)) as AcademicSnapshot;assert.equal(saved.assignments.length,10);assert.ok(saved.assignments.every(a=>a.status!=='submitted'));assert.equal(saved.assignments[0].verifiedAt,20);assert.equal(saved.assignments[7].needsReview,true);assert.equal(saved.assignments[8].needsReview,true);
});
