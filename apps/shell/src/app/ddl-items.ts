/**
 * 「最近的 DDL」这一层的数据规整。
 *
 * 背景：首页与任务日志的 DDL 卡片最早只读演示数据（`demo-data.ts`），
 * 于是演示很好看、真实模式下整块是空的。这里把**两种来源收敛成同一种形状**，
 * 视图只认 `DdlItem`，不再按来源分叉。
 *
 * 两条规矩：
 *   · 真实任务没有「来源平台」这个字段（`Task` 里没有 `source`）。
 *     这里如实写「本机记录」，而不是编一个平台名 —— 平台同步接上之后
 *     才有资格显示真来源。
 *   · 挑选规则（今天优先 → 最近的有事那天 → 最久没处理的那天）是纯函数，
 *     单独可测。上一版这段逻辑写死在 useMemo 里，改一个字都没法验证。
 */

import type { Task } from '../domain/types';
import { dayKeyOf } from './date-keys.ts';

export interface DdlItem {
  id: string;
  title: string;
  courseId: string | null;
  /** epoch 毫秒 */
  dueAt: number;
  /** 来源平台；真实任务当前只有「本机记录」 */
  source: string;
  description?: string;
  url?: string;
  /** 真实任务才有的回指：点开进编辑表单而不是演示详情 */
  taskId?: string;
}

/**
 * 从核心任务里挑出 DDL。
 *
 * 只认 `kind === 'ddl'` 且带截止时间的：没有截止时间的任务不叫 DDL，
 * 塞进「最近的 DDL」会让这一栏变成第二个任务列表。
 * 已忽略（dismissed）的不算 —— 用户明确表示不想再看到它。
 */
export function ddlsFromTasks(tasks: readonly Task[]): DdlItem[] {
  const out: DdlItem[] = [];
  for (const t of tasks) {
    if (t.kind !== 'ddl') continue;
    if (t.status === 'dismissed') continue;
    if (t.dueAt === null || !Number.isFinite(t.dueAt)) continue;
    out.push({
      id: t.id,
      title: t.title,
      courseId: t.courseId,
      dueAt: t.dueAt,
      source: '本机记录',
      ...(t.note !== undefined && t.note !== '' ? { description: t.note } : {}),
      taskId: t.id,
    });
  }
  return out;
}

/**
 * 挑出「最近」的那一天，**以天为基准**。
 *
 * 优先级：今天 → 最近的有事的那天 → 最久没处理的那天（全逾期时）。
 * 同一天有多条就全留下 —— 一天的截止压力本来就该一起看。
 *
 * 上一版直接取全表最早的一天，于是昨天的逾期任务会把今天的 DDL 挤掉；
 * 用户看到的「最近」应该是今天该交的东西。
 */
export function pickUrgent(items: readonly DdlItem[], now: number): DdlItem[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.dueAt - b.dueAt);

  const todayKey = dayKeyOf(now);
  const todays = sorted.filter((item) => dayKeyOf(item.dueAt) === todayKey);
  if (todays.length > 0) return todays;

  const upcoming = sorted.find((item) => item.dueAt > now);
  if (upcoming !== undefined) {
    const key = dayKeyOf(upcoming.dueAt);
    return sorted.filter((item) => dayKeyOf(item.dueAt) === key);
  }

  /*
    全部逾期时给**最久没处理的那一天**，也就是 sorted[0]。
    这里原来取的是 sorted[末尾]（最近刚逾期的那天），和注释写的正好相反 ——
    注释说要「最久没处理」，代码给的是「刚错过」。既然都逾期了，
    「拖了 5 天的那件」比「昨天刚过的那件」更该被顶到眼前。
  */
  const oldest = sorted[0];
  if (oldest === undefined) return [];
  const key = dayKeyOf(oldest.dueAt);
  return sorted.filter((item) => dayKeyOf(item.dueAt) === key);
}

/** 任务日志用：按截止时间升序 */
export function sortByDue(items: readonly DdlItem[]): DdlItem[] {
  return [...items].sort((a, b) => a.dueAt - b.dueAt);
}