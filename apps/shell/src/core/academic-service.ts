import { projectAcademic, ACADEMIC_ID } from '../plugins/builtin/academic/projection.ts';
import { PLUGIN_IDS, PROVIDERS, defaultSettings, validateSettings, type Provider, type TimetableSettings, type UserCorrections, type LessonOverride, type AssignmentOverride } from '../plugins/builtin/academic/model.ts';
import { SNAPSHOT, type AcademicSnapshot } from '../plugins/builtin/academic/connectors.ts';
import { explainSyncError, splitSyncErrors } from './sync-errors.ts';
import type { PluginHost } from './plugin-host.ts';
import type { SecureStore } from '../platform/strategies/kv/types.ts';
import type { NotifyPort } from './notify/port.ts';

export class AcademicService {
  settings = defaultSettings();
  corrections: UserCorrections = { lessons:{}, assignments:{} };
  snapshots: AcademicSnapshot[] = [];
  statuses: Partial<Record<Provider,string>> = {};
  reminderStatus = '未开启';
  busy = false;
  private tail: Promise<unknown> = Promise.resolve();
  private listeners = new Set<()=>void>();
  private host: PluginHost;
  private kv: SecureStore;
  private notify: NotifyPort;
  readonly available: boolean;
  private loginPage: (provider: Provider)=>Promise<{completed:boolean}>;
  private clearSessions: ()=>Promise<void>;
  constructor(deps: {host:PluginHost;kv:SecureStore;notify:NotifyPort;available:boolean;login:(p:Provider)=>Promise<{completed:boolean}>;clear:()=>Promise<void>}) {
    this.host=deps.host;this.kv=deps.kv;this.notify=deps.notify;this.available=deps.available;this.loginPage=deps.login;this.clearSessions=deps.clear;
  }
  subscribe(fn:()=>void) { this.listeners.add(fn);return ()=>{this.listeners.delete(fn);}; }
  private changed() { for(const fn of this.listeners) fn(); }
  private serial<T>(fn:()=>Promise<T>):Promise<T> {
    const task=this.tail.then(async()=>{this.busy=true;this.changed();try{return await fn();}finally{this.busy=false;this.changed();}});
    this.tail=task.catch(()=>undefined);return task;
  }
  async init() {
    const raw=await this.kv.get('academic.config.v1');
    if(raw) {
      const saved=JSON.parse(raw);this.settings={...defaultSettings(),...saved.settings};this.corrections=saved.corrections??this.corrections;
      validateSettings(this.settings);
    }
    this.readSnapshots();
    await this.rebuild();
  }
  private readSnapshots() {
    this.snapshots=PROVIDERS.flatMap(provider=>{
      const read=this.host.bus.read(PLUGIN_IDS[provider],SNAPSHOT,{owner:PLUGIN_IDS[provider]});
      if(!read.ok || !read.data.length) return [];
      return [JSON.parse(String(read.data[0].data.json)) as AcademicSnapshot];
    });
  }
  private migrateLessonCorrections(previous:AcademicSnapshot[]) {
    const oldRules=previous.flatMap(s=>s.rules), rules=this.snapshots.flatMap(s=>s.rules);
    const key=(r:typeof rules[number])=>`${r.courseId}:${r.weekday}:${r.first}:${r.last}`;
    // 周次调整时，只迁移一对一的同课程/星期/节次规则。歧义数据不猜测匹配。
    for(const r of rules) {
      if(this.corrections.lessons[r.id]) continue;
      const prior=oldRules.filter(o=>key(o)===key(r));
      if(prior.length===1 && rules.filter(o=>key(o)===key(r)).length===1 && this.corrections.lessons[prior[0].id])
        this.corrections.lessons[r.id]=structuredClone(this.corrections.lessons[prior[0].id]);
    }
  }
  async login(provider:Provider) {
    if(!this.available) throw new Error('此构建仅 Android 支持平台网页登录');
    return this.serial(async()=>{
      const result=await this.loginPage(provider);
      if(!result.completed) throw new Error('已取消登录');
      await this.runSync(provider);
    });
  }
  sync(provider:Provider) { return this.serial(()=>this.runSync(provider)); }
  private async runSync(provider:Provider) {
    if(!this.available) throw new Error('请在 Android 端登录并同步');
    this.statuses[provider]='正在读取…';this.changed();
    try {
      const s=this.settings;
      const now=Date.now();
      const result=await this.host.sync(PLUGIN_IDS[provider],{trigger:'manual',now,settings:{semesterId:s.semesterId,gradescopeTimezone:s.gradescopeTimezone,
        ...(s.selectedCourses[provider]?{selectedCourses:JSON.stringify(s.selectedCourses[provider])}:{})}});
      if(!result.ok) throw new Error(result.message);
      /*
        这里原来写的是「`errors` 有一条就整轮失败」。但 `errors` 里混着两种
        完全不同的东西：一种是「第 56 页超时了」，一种是「解析器抛错 / 没落盘」。
        前者只意味着少几条数据，后者才意味着这一轮白跑。混在一起判的结果是
        ——两百多页里任何一页慢一点，整轮报废。见 core/sync-errors.ts。
      */
      const {soft,hard}=splitSyncErrors(result.data.errors);
      if(hard.length || result.data.rejectedEntities) throw new Error(hard.length?explainSyncError(hard[0]):'同步数据未能保存');
      const previous=this.snapshots;
      this.readSnapshots();this.migrateLessonCorrections(previous);
      const snap=this.snapshots.find(x=>x.provider===provider);
      /*
        顺序要紧：**先**判断「这一轮到底有没有写进新快照」，**再**判断「库里有快照吗」。
        反过来写就会踩到刚踩过的坑 —— 全新安装（库里本来就没有快照）时，
        只要有一个页面没回来，就会先撞上「本次未得到有效数据」这句什么也没说的话，
        真正的原因（`page-155: ETIMEDOUT …`）被吃掉。
      */
      if(soft.length && (!snap || snap.syncedAt!==now))
        throw new Error(`这一轮没有产出完整结果：${explainSyncError(soft[0])}（请求 ${result.data.requests} 次 · 实体 ${result.data.entities} 个 · 最后进度「${result.data.summaries[result.data.summaries.length-1]??'-'}」）`);
      /*
        这句「未得到有效数据」以前什么也没说 —— 到底是没发请求、还是发了没解析、
        还是解析了没落库？三种原因三种修法，光看这句话分不出来。所以把报告里的
        计数一起打出来。
      */
      if(!snap) throw new Error(`本次未得到有效数据，保留上次结果（请求 ${result.data.requests} 次 · 实体 ${result.data.entities} 个 · 步数 ${result.data.steps}${result.data.summaries.length?` · 最后进度「${result.data.summaries[result.data.summaries.length-1]}」`:''}）`);
      // 只在用户尚未调整节次前采用网站识别的作息。
      if(provider==='eams' && snap.periods.length && !(await this.kv.get('academic.periods-edited'))) {
        const candidate={...this.settings,periods:snap.periods};validateSettings(candidate);this.settings=candidate;await this.persist();
      }
      await this.rebuild();
      await this.persist();
      // 少读了几个页面就说出来，别假装全齐了。
      const gap=soft.length?`（${soft.length} 个页面没读到）`:'';
      this.statuses[provider]=`同步成功：${snap.courses.length} 门课程，${provider==='eams'?`${snap.rules.length} 条排课`:`${snap.assignments.length} 项作业`}${gap}`;
    } catch(e) {
      this.statuses[provider]=e instanceof Error?e.message:String(e);throw e;
    }
  }
  saveSettings(next:TimetableSettings) { return this.serial(async()=>{
    validateSettings(next);projectAcademic(this.snapshots,next,this.corrections);
    const edited=JSON.stringify(next.periods)!==JSON.stringify(this.settings.periods);
    await this.applyConfig(next,this.corrections);
    if(edited) await this.kv.set('academic.periods-edited','1');
  }); }
  editLesson(id:string,patch:LessonOverride) { return this.saveCorrection('lessons',id,patch); }
  editAssignment(id:string,patch:AssignmentOverride) { return this.saveCorrection('assignments',id,patch); }
  resetLesson(id:string) { return this.serial(async()=>{const next=structuredClone(this.corrections);delete next.lessons[id];await this.applyConfig(this.settings,next);}); }
  resetAssignment(id:string) { return this.serial(async()=>{const next=structuredClone(this.corrections);delete next.assignments[id];await this.applyConfig(this.settings,next);}); }
  private saveCorrection(kind:'lessons'|'assignments',id:string,patch:LessonOverride|AssignmentOverride) {return this.serial(async()=>{
    const next=structuredClone(this.corrections);(next[kind] as Record<string,object>)[id]={...next[kind][id],...patch};
    await this.applyConfig(this.settings,next);
  });}
  private async applyConfig(settings:TimetableSettings,corrections:UserCorrections) {
    projectAcademic(this.snapshots,settings,corrections);
    const previous={settings:this.settings,corrections:this.corrections};
    this.settings=structuredClone(settings);this.corrections=structuredClone(corrections);
    try {await this.persist();await this.rebuild();}
    catch(e) {
      this.settings=previous.settings;this.corrections=previous.corrections;
      try {await this.persist();await this.rebuild();} catch {throw new Error('保存失败且旧数据恢复失败，请重启后检查存储状态');}
      throw e;
    }
  }
  private persist() {return this.kv.set('academic.config.v1',JSON.stringify({settings:this.settings,corrections:this.corrections}));}
  private async rebuild() {
    // 先计算/校验全量结果，再替换派生实体；原始快照及人工修正始终独立保留。
    projectAcademic(this.snapshots,this.settings,this.corrections);
    const backup=['course','academic_event'].flatMap(type=>{const r=this.host.bus.read(ACADEMIC_ID,type,{owner:ACADEMIC_ID});return r.ok?r.data:[];});
    const removeProjection=()=>{for(const type of ['course','academic_event']) {const r=this.host.bus.read(ACADEMIC_ID,type,{owner:ACADEMIC_ID});if(r.ok)for(const row of r.data)this.host.bus.drop(ACADEMIC_ID,type,row.id);}};
    try {
      removeProjection();
      const result=await this.host.sync(ACADEMIC_ID,{trigger:'manual',now:Date.now(),settings:{snapshots:JSON.stringify(this.snapshots),timetable:JSON.stringify(this.settings),corrections:JSON.stringify(this.corrections)}});
      if(!result.ok || result.data.errors.length || result.data.rejectedEntities)
        throw new Error(result.ok?result.data.errors.join('；')||'课表投影失败':result.message);
    } catch(error) {
      removeProjection();
      for(const rec of backup) this.host.bus.emit(ACADEMIC_ID,{id:rec.id,type:rec.type,data:rec.data});
      await this.host.refreshSlots(ACADEMIC_ID);
      throw error;
    }
    try {await this.reconcileReminders();} catch(e) {this.reminderStatus=`提醒排程失败：${e instanceof Error?e.message:String(e)}`;}
    this.changed();
  }
  async enableReminders() {
    await this.requestReminderPermission();
    await this.saveSettings({...this.settings,reminders:true});
  }
  async requestReminderPermission() {
    if(!this.notify.isSupported()) throw new Error('当前平台尚不支持本地通知');
    if(await this.notify.requestPermission()!=='granted') throw new Error('通知权限未开启，请在手机设置中放行');
  }
  async reconcileReminders() {
    if(!this.notify.isSupported()) {this.reminderStatus='当前平台不支持通知';return;}
    const pending=await this.notify.pending();
    if(!this.settings.reminders || await this.notify.checkPermission()!=='granted') {
      await this.notify.cancel(pending.filter(id=>id.startsWith('academic#')));this.reminderStatus=this.settings.reminders?'通知权限未开启':'未开启';return;
    }
    const entities=projectAcademic(this.snapshots,this.settings,this.corrections).filter(e=>e.type==='academic_event' && !e.data.done);
    const now=Date.now();
    const items=entities.map(e=>({id:`academic#${e.id}`,at:Number(e.data.startAt)-(e.data.type==='session'?this.settings.lessonLead:this.settings.dueLead)*60000,
      title:`${e.data.type==='session'?'即将上课':'作业截止提醒'} · ${e.data.title}`,body:String(e.data.detail??''),payload:'academic'}))
      .filter(e=>e.at>now).sort((a,b)=>a.at-b.at).slice(0,Math.min(400,this.notify.capabilities().maxPending));
    try {
      const wanted=new Set(items.map(e=>e.id));await this.notify.cancel(pending.filter(id=>id.startsWith('academic#')&&!wanted.has(id)));
      await this.notify.schedule(items);
      this.reminderStatus=`已安排 ${items.length} 条提醒${this.notify.capabilities().exact?'':'（系统可能延迟）'}`;
    } catch(e) { this.reminderStatus=`提醒排程失败：${e instanceof Error?e.message:String(e)}`;throw e; }
  }
  testNotification() { return this.serial(async()=>{
    if(await this.notify.requestPermission()!=='granted') throw new Error('请允许通知权限');
    await this.notify.schedule([{id:'academic#test',at:Date.now()+15000,title:'Qin 提醒测试',body:'课程与作业本地通知已接通',payload:'academic'}]);
    this.reminderStatus='测试提醒将在约 15 秒后出现';
  }); }
  clearLogin() {return this.serial(async()=>{await this.clearSessions();for(const p of PROVIDERS)this.statuses[p]='会话已清除，历史数据保留';});}
  clearData() {return this.serial(async()=>{
    if(this.notify.isSupported())await this.notify.cancel((await this.notify.pending()).filter(id=>id.startsWith('academic#')));
    for(const provider of PROVIDERS)this.host.bus.drop(PLUGIN_IDS[provider],SNAPSHOT,'current');
    this.settings=defaultSettings();this.corrections={lessons:{},assignments:{}};this.snapshots=[];this.statuses={};
    await this.kv.remove('academic.periods-edited');await this.persist();await this.rebuild();
    const flushed=await this.host.bus.flush();if(!flushed.ok)throw new Error(flushed.message);
  });}
}
