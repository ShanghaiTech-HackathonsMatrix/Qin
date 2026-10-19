/** 分类互斥，完成优先；读取失败不参与任务状态推断。 */
export type TaskCategory = 'open' | 'overdue' | 'done' | 'review';
export const TASK_CATEGORIES: {id:TaskCategory; label:string}[] = [
  {id:'open',label:'未完成'}, {id:'overdue',label:'已逾期'},
  {id:'done',label:'已完成'}, {id:'review',label:'待确认'},
];
export interface TaskStatusInput { id?:string; title?:string; dueAt:number|null; done?:boolean; needsReview?:boolean; completedAt?:number }
export function taskCategory(item:TaskStatusInput, now:number):TaskCategory {
  if(item.done) return 'done';
  if(item.needsReview) return 'review';
  return item.dueAt !== null && item.dueAt < now ? 'overdue' : 'open';
}
export function compareTasks(a:TaskStatusInput,b:TaskStatusInput,_now?:number):number {
  const time=(t:TaskStatusInput)=>t.dueAt!==null&&Number.isFinite(t.dueAt)?t.dueAt:Infinity;
  const at=time(a),bt=time(b);
  if(at!==bt)return at<bt?-1:1;
  // 不依赖平台返回顺序、完成状态或分类；刷新后相同时间也保持稳定。
  const key=(t:TaskStatusInput)=>t.id??t.title??'';
  return key(a)<key(b)?-1:key(a)>key(b)?1:0;
}
