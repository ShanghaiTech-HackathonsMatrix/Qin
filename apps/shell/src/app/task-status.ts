/** 分类互斥，完成优先；读取失败不参与任务状态推断。 */
export type TaskCategory = 'open' | 'overdue' | 'done' | 'review';
export const TASK_CATEGORIES: {id:TaskCategory; label:string}[] = [
  {id:'open',label:'未完成 / 未提交'}, {id:'overdue',label:'已逾期'},
  {id:'done',label:'已完成 / 已提交'}, {id:'review',label:'待确认'},
];
export interface TaskStatusInput { dueAt:number|null; done?:boolean; needsReview?:boolean; completedAt?:number }
export function taskCategory(item:TaskStatusInput, now:number):TaskCategory {
  if(item.done) return 'done';
  if(item.needsReview) return 'review';
  return item.dueAt !== null && item.dueAt < now ? 'overdue' : 'open';
}
export function compareTasks(a:TaskStatusInput,b:TaskStatusInput,now:number):number {
  const ca=taskCategory(a,now),cb=taskCategory(b,now);
  const order:TaskCategory[]=['overdue','open','review','done'];
  if(ca!==cb)return order.indexOf(ca)-order.indexOf(cb);
  if(ca==='done')return (b.completedAt??0)-(a.completedAt??0);
  if(ca==='overdue')return (b.dueAt??0)-(a.dueAt??0);
  return (a.dueAt??Infinity)-(b.dueAt??Infinity);
}
