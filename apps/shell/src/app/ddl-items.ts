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
  /**
   * 用户自己加的，不是从平台提取来的。
   *
   * 视图据此挂一个很小的「自建」标记 —— 混排之后总得能看出哪条是自己写的。
   * 目前只能靠 `kind === 'custom'` 和「演示态里额外加的那一批」判断：
   * `Task` 上没有来源字段，等平台同步接上、真有了来源，这里应该换成读那个字段。
   */
  selfMade?: boolean;
  /** 已完成。日程页据此显示「完成」而不是「逾期」 */
  done?: boolean;
  description?: string;
  url?: string;
  /** 真实任务才有的回指：点开进编辑表单而不是演示详情 */
  taskId?: string;
  /**
   * 来自哪个学习平台。有值就说明这条是**拉回来的作业**，
   * 不是本机任务 —— 点开走作业详情（改截止时间、标记完成），
   * 改的是「个人修正」，不动平台原始数据。
   */
  provider?: string;
  /** 平台上的课程名。核心课程表里没有这些课，所以单独带一份 */
  courseTitle?: string;
}

/** 平台标识 → 界面上显示的名字 */
export const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  gradescope: 'Gradescope',
  blackboard: '互动教学平台',
  eams: '教务课表',
};

/**
 * 从核心任务里挑出「有截止时间、还没被忽略」的那些。
 *
 * 判据是**有没有截止时间**，不是 `kind`。
 * 早先这里写死了 `kind === 'ddl'`，于是「导入文字」进来的任务（kind 是
 * custom）一旦填上截止时间，就从主列表和「自建任务」两段里同时消失了 ——
 * 界面上凭空少一条，比排错序更糟。
 *
 * `kind === 'course'` 仍然排除：那是一节课，不是一件要交的事。
 *
 * @param allSelfMade 整批都是用户自己加的（演示态额外加的那一批）。
 *                    真实模式下没有来源字段，只能按 `kind === 'custom'` 认。
 */
export function ddlsFromTasks(tasks: readonly Task[], allSelfMade = false): DdlItem[] {
  const out: DdlItem[] = [];
  for (const t of tasks) {
    if (t.kind === 'course') continue;
    if (t.status === 'dismissed') continue;
    if (t.dueAt === null || !Number.isFinite(t.dueAt)) continue;
    out.push({
      id: t.id,
      title: t.title,
      courseId: t.courseId,
      dueAt: t.dueAt,
      source: '本机记录',
      selfMade: allSelfMade || t.kind === 'custom',
      ...(t.status === 'done' ? { done: true } : {}),
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

// ---------------------------------------------------------------- 平台作业

/**
 * 平台作业的最小形状。
 *
 * 这里**刻意不 import 插件里的类型**：`app/` 是纯逻辑层，
 * 拖进插件模块会把它和网络、HTML 解析绑在一起，Node 里也跑不动。
 * 结构化类型足够 —— 插件那边的对象天然满足这些字段。
 */
export interface PlatformAssignment {
  id: string;
  courseId: string;
  title: string;
  dueAt: number | null;
  status: 'unknown' | 'not_submitted' | 'submitted' | 'graded';
}

/**
 * 课时规则的最小形状 —— 周课表要的就是这几个字段。
 * 和 `PlatformAssignment` 一样只做结构描述，不 import 插件类型。
 */
export interface PlatformLessonRule {
  id: string;
  title: string;
  teacher?: string;
  location?: string;
  weekday: number;
  first: number;
  last: number;
  weeks: readonly number[];
}

export interface PlatformSnapshot {
  provider: string;
  syncedAt: number;
  courses: readonly { id: string; title: string }[];
  assignments: readonly PlatformAssignment[];
  /**
   * 排课。只有教务课表那个平台有，Gradescope / 互动教学平台给的是作业，
   * 所以这里必须是可选的 —— 否则另外两个快照类型对不上。
   */
  rules?: readonly PlatformLessonRule[];
}

/** 用户对平台数据的「个人修正」—— 只改本应用里的显示，不动平台原文 */
export interface PlatformCorrection {
  title?: string;
  dueAt?: number | null;
  note?: string;
  done?: boolean;
  hidden?: boolean;
}

/** 平台认为「已经交了」的状态 */
const SUBMITTED = new Set(['submitted', 'graded']);

/**
 * 把拉回来的作业变成 DDL 条目。
 *
 * 规则和投影层（`plugins/builtin/academic/projection.ts`）保持一致，
 * 否则会出现「课业页说有 5 条、任务日志只有 3 条」这种对不上的情况：
 *   · 按课程筛选（`selected` 里没这个平台 = 全要）
 *   · 叠上个人修正，然后丢掉被隐藏的
 *   · 没有明确截止时间的不进列表 —— 猜一个时间是更坏的做法
 */
export function platformDdls(
  snapshots: readonly PlatformSnapshot[],
  selected: Readonly<Record<string, readonly string[] | undefined>> = {},
  corrections: Readonly<Record<string, PlatformCorrection | undefined>> = {},
): DdlItem[] {
  const out: DdlItem[] = [];
  for (const snapshot of snapshots) {
    const allowed = selected[snapshot.provider];
    for (const original of snapshot.assignments) {
      if (allowed !== undefined && !allowed.includes(original.courseId)) continue;
      const fix = corrections[original.id];
      const assignment = { ...original, ...fix };
      if (assignment.hidden === true) continue;
      if (assignment.dueAt === null || !Number.isFinite(assignment.dueAt)) continue;
      out.push({
        id: assignment.id,
        title: assignment.title,
        courseId: null,
        dueAt: assignment.dueAt,
        source: PROVIDER_LABEL[snapshot.provider] ?? snapshot.provider,
        selfMade: false,
        ...(assignment.done ?? SUBMITTED.has(assignment.status) ? { done: true } : {}),
        ...(fix?.note !== undefined && fix.note !== '' ? { description: fix.note } : {}),
        provider: snapshot.provider,
        courseTitle: snapshot.courses.find((c) => c.id === assignment.courseId)?.title ?? '',
      });
    }
  }
  return out;
}

/** 一行的副标题：「课程名 · 来源」。两种来源共用，避免两处各拼一遍 */
export function ddlMeta(item: DdlItem, courseName = ''): string {
  const course = item.courseTitle ?? courseName;
  return course === '' ? item.source : `${course} · ${item.source}`;
}
