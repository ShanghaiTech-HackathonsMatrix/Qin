import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {PersonalSchedule,occurrences,validateEvent,type PersonalEvent} from './personal-schedule.ts';
import {taskCategory,compareTasks} from '../app/task-status.ts';
import type {NotifyPort,ScheduledNotification} from './notify/port.ts';
import type {SecureStore} from '../platform/strategies/kv/types.ts';
class Kv implements SecureStore{
  encrypted=false;map=new Map<string,string>();async get(k:string){return this.map.get(k)??null;}async set(k:string,v:string){this.map.set(k,v);}async remove(k:string){this.map.delete(k);}async keys(){return [...this.map.keys()];}
}
class Notify implements NotifyPort{
  backend='test';items=new Map<string,ScheduledNotification>();async probe(){}isSupported(){return true;}capabilities(){return {exact:true,maxPending:3,lostOnReboot:false,requiresPermission:true};}async checkPermission(){return 'granted' as const;}async requestPermission(){return 'granted' as const;}async schedule(rows:readonly ScheduledNotification[]){for(const r of rows)this.items.set(r.id,r);}async pending(){return [...this.items.keys()];}async cancel(ids:readonly string[]){ids.forEach(id=>this.items.delete(id));}async cancelAll(){this.items.clear();}
}
const event=(id='a'):PersonalEvent=>({id,title:'示例日程',startAt:Date.now()+3600000,endAt:Date.now()+7200000,allDay:false,location:'教室',note:'备注',repeat:'weekly',until:Date.now()+30*86400000,remindMinutes:10});
test('任务互斥分类：完成优先、待确认、截止边界与无截止时间',()=>{
  assert.equal(taskCategory({dueAt:1,done:true,needsReview:true},100),'done');assert.equal(taskCategory({dueAt:1,needsReview:true},100),'review');assert.equal(taskCategory({dueAt:100},100),'open');assert.equal(taskCategory({dueAt:99},100),'overdue');assert.equal(taskCategory({dueAt:null},100),'open');assert.ok(compareTasks({dueAt:null},{dueAt:100},100)>0);
});
test('日程校验与按本地日期每周展开',()=>{
  assert.throws(()=>validateEvent({...event(),endAt:0}));assert.throws(()=>validateEvent({...event(),remindMinutes:-1}));
  const e=event(),rows=occurrences(e,e.startAt,e.until);assert.equal(rows.length,5);assert.equal(new Date(rows[1].at).getDay(),new Date(e.startAt).getDay());
});
test('连续并发保存不丢项，重启保留；提醒容量与删除取消',async()=>{
  const kv=new Kv(),notify=new Notify();notify.items.set('academic#other',{id:'academic#other',at:Date.now()+1e6,title:'已有提醒'});
  const service=new PersonalSchedule(kv,notify);await service.init();await Promise.all([service.put(event('a')),service.put(event('b'))]);assert.equal(service.events.length,2);assert.equal(notify.items.size,3);
  const restarted=new PersonalSchedule(kv,notify);await restarted.init();assert.equal(restarted.events.length,2);await restarted.remove('a');assert.ok([...notify.items.keys()].every(k=>!k.startsWith('personal#personal:a:')));await restarted.clear();assert.deepEqual([...notify.items.keys()],['academic#other']);
});
