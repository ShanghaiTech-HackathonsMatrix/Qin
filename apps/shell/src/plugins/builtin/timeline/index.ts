/**
 * Timeline 插件 —— **槽的定义方**，也是本项目第一个「页面级」插件。
 *
 * ## 它怎么被别的插件填充
 *
 * 它不知道课表、作业管理器的存在。它只做两件事：
 *
 * 1. 在 manifest 里**定义** `app.matrix.timeline.event` 这个槽（连同条目 schema）
 * 2. 在 `render()` 里读槽里的条目，排成时间轴
 *
 * 别的插件想出现在时间线上，只需要在自己的 manifest 里声明
 * `consumesSlots: [{ slot: 'app.matrix.timeline.event', from: 'session', map }]`。
 * **两边都不需要改对方一行代码。**
 *
 * ## 为什么槽名这么长
 *
 * 槽名前两段必须是自己 id 的命名空间（`app.matrix`），否则一个坏插件能声明
 * `app.matrix.timeline.event` 把真槽顶掉。见 `slot-resolver.ts` 的 `ownsSlotNamespace`。
 */

import type {
  CommandHandler,
  EntitySchema,
  PluginExports,
  SlotEntry,
  UiNode,
  ViewContext,
  ViewRender,
} from '@matrix/plugin-api';

import { SLOT_ENTRY_TYPE, SLOT_NAME } from './constants.ts';

export {
  EVENT_TYPES,
  PLUGIN_ID,
  SLOT_ENTRY_TYPE,
  SLOT_NAME,
  eventSlot,
  views,
} from './constants.ts';
export type { EventType } from './constants.ts';

export const renders: Record<string, ViewRender> = {
  timeline: renderTimeline,
};

/**
 * 跨字段校验 —— **`CheckEvent()` 的纯函数部分**。
 *
 * 单字段的检查（类型、必填、超长）已经由 schema 做了，这里只处理
 * 「两个字段之间的关系」。它是同步纯函数：同样的输入永远同样的输出。
 */
export const slotValidators = {
  [SLOT_NAME]: (values: Readonly<Record<string, string | number | boolean>>) => {
    const startAt = values.startAt;
    const endAt = values.endAt;
    if (typeof endAt === 'number' && typeof startAt === 'number' && endAt < startAt) {
      return { ok: false as const, reason: 'endAt 早于 startAt' };
    }
    return { ok: true as const };
  },
};

/**
 * 命令实现（dev.md T14）。
 *
 * 命令是**纯函数**：拿到入参，返回「要改什么」。它不写存储、
 * 不读全局 —— 宿主负责把 `coreOps` 翻译成 `TaskStore` 调用。
 *
 * 为什么目标状态由插件自己算（而不是宿主做「切换」）：
 * 插件从 `ctx.records` 里已经看到了任务当前的状态，算得出来；
 * 让宿主提供 `toggle` 这种带读-改-写语义的操作，等于让命令变成有状态的调用，
 * 而「同样的入参得到同样的结果」正是它能被测试、能被沙箱承载的原因。
 */
export const commands: Record<string, CommandHandler> = {
  toggleTask: (input) => {
    const id = typeof input.taskId === 'string' ? input.taskId : '';
    if (id === '') return { message: '缺少任务 id' };

    // 入参里带 `to`：由渲染时算好目标状态，命令本身不查数据
    const to = input.to;
    if (to !== 'open' && to !== 'done') {
      return { message: '目标状态不合法' };
    }
    return {
      coreOps: [{ op: 'task.setStatus', id, status: to }],
      message: to === 'done' ? '已标记完成' : '已标记未完成',
    };
  },
};

export const timelinePlugin: PluginExports = { renders, slotValidators, commands };

/** manifest 从 `manifest.ts` 转发出来，方便 `bootstrap` 只 import 一处 */
export { manifest } from './manifest.ts';

/** manifest 里的实体类型：Timeline 自己不写数据，所以是空数组 */
export const entityTypes: EntitySchema[] = [];

// ------------------------------------------------------------ 渲染

interface Event {
  startAt: number;
  endAt: number | undefined;
  title: string;
  type: string;
  detail: string;
  courseId: string;
  ref: string;
  /**
   * 这条事件背后是**核心任务**时填它的 id。
   *
   * 只有核心任务才有这个字段 —— 槽条目是别的插件的数据，
   * Timeline 不能（也不该）去改它们。有 id 才画「勾选完成」按钮。
   */
  taskId?: string;
  /** 任务当前是否已完成（决定按钮文案） */
  taskDone?: boolean;
}

/**
 * 把槽条目 + 核心实体合并成事件列表。
 *
 * ⚠️ 这里刻意**再防御一遍**：槽里可能存着旧版本写的、后来 schema 变严了的条目。
 * `render()` 拿到脏数据不能炸 —— 炸了整页白屏，用户完全不知道为什么。
 */
function collectEvents(ctx: ViewContext): Event[] {
  const out: Event[] = [];

  // 槽条目由宿主以 `slot_entry` 类型递进来，`values` 里是真正的字段
  for (const rec of ctx.records) {
    if (rec.type !== SLOT_ENTRY_TYPE) continue;
    const raw = rec.data.values;
    if (typeof raw !== 'object' || raw === null) continue;
    const v = raw as Record<string, unknown>;

    if (typeof v.startAt !== 'number' || !Number.isFinite(v.startAt)) continue;
    if (typeof v.title !== 'string' || v.title === '') continue;

    out.push({
      startAt: v.startAt,
      endAt: typeof v.endAt === 'number' && Number.isFinite(v.endAt) ? v.endAt : undefined,
      title: v.title,
      type: typeof v.type === 'string' ? v.type : 'custom',
      detail: typeof v.detail === 'string' ? v.detail : '',
      courseId: typeof v.courseId === 'string' ? v.courseId : '',
      ref: typeof rec.data.ref === 'string' ? rec.data.ref : rec.id,
    });
  }

  // 核心任务：有截止时间的那部分也排进时间轴。
  //
  // ⚠️ 这是**核心**数据，不是别的插件的数据 —— Timeline 在自己的 manifest 里
  // 声明了 `data.read: ['task']`，读它是正当的。
  // 将来有作业管理插件时，它应当往 `timeline.event` 槽里写，
  // 那时这里可以退化成「只画没有插件认领的核心任务」。
  for (const rec of ctx.records) {
    if (rec.type !== 'task') continue;
    const dueAt = rec.data.dueAt;
    if (typeof dueAt !== 'number' || !Number.isFinite(dueAt)) continue;
    const title = rec.data.title;
    if (typeof title !== 'string' || title === '') continue;

    const done = rec.data.status === 'done';
    out.push({
      startAt: dueAt,
      endAt: undefined,
      title,
      type: 'task',
      detail: typeof rec.data.note === 'string' ? rec.data.note : '',
      courseId: typeof rec.data.courseId === 'string' ? rec.data.courseId : '',
      ref: rec.id,
      taskId: rec.id,
      taskDone: done,
    });
  }

  return out.sort((a, b) => a.startAt - b.startAt);
}

/** 核心 `task` 实体：有没有过期的、还有多少没做 */
function taskSummary(ctx: ViewContext): { open: number; overdue: number } {
  let open = 0;
  let overdue = 0;
  for (const rec of ctx.records) {
    if (rec.type !== 'task') continue;
    if (rec.data.status !== 'open') continue;
    open += 1;
    const dueAt = rec.data.dueAt;
    if (typeof dueAt === 'number' && dueAt < ctx.now) overdue += 1;
  }
  return { open, overdue };
}

/** 任务的颜色：过期用 danger，今天到期用 warning，其余 accent */
function taskTone(e: Event, now: number): 'danger' | 'warning' | 'accent' | 'faint' {
  if (e.taskDone === true) return 'faint';
  if (e.startAt < now) return 'danger';
  if (e.startAt - now < 86_400_000) return 'warning';
  return 'accent';
}

export function renderTimeline(ctx: ViewContext): UiNode {
  const events = collectEvents(ctx);
  const { open, overdue } = taskSummary(ctx);

  const header: UiNode = {
    type: 'card',
    title: '时间线',
    children: [
      {
        type: 'stack',
        direction: 'row',
        gap: 'sm',
        align: 'center',
        wrap: true,
        children: [
          { type: 'badge', text: `${open} 项未完成`, tone: open > 0 ? 'accent' : 'faint' },
          ...(overdue > 0
            ? [{ type: 'badge' as const, text: `${overdue} 项已过期`, tone: 'danger' as const }]
            : []),
          { type: 'badge', text: `${events.length} 个事件`, tone: 'faint' },
        ],
      },
    ],
  };

  if (events.length === 0) {
    return {
      type: 'stack',
      gap: 'md',
      children: [
        header,
        {
          type: 'empty',
          text: '时间线还是空的。导入一份 .ics 课表，课时就会出现在这里。',
          action: { label: '去导入', onPress: { kind: 'navigate', to: 'settings' } },
        },
      ],
    };
  }

  // 按天分组
  const groups = new Map<string, Event[]>();
  for (const e of events) {
    const k = dayKey(e.startAt);
    const arr = groups.get(k);
    if (arr) arr.push(e);
    else groups.set(k, [e]);
  }

  const sections: UiNode[] = [...groups.keys()].sort().map((k) => ({
    type: 'card',
    title: dayLabel(k, ctx.now),
    children: (groups.get(k) ?? []).map((e) => renderEvent(e, ctx.now)),
  }));

  return { type: 'stack', gap: 'md', children: [header, ...sections] };
}

function renderEvent(e: Event, now: number): UiNode {
  const isTask = e.taskId !== undefined;
  const tone = isTask ? taskTone(e, now) : toneOf(e);
  const time =
    e.endAt !== undefined ? `${hhmm(e.startAt)}–${hhmm(e.endAt)}` : hhmm(e.startAt);

  const children: UiNode[] = [
    {
      type: 'stack',
      direction: 'row',
      gap: 'sm',
      align: 'center',
      wrap: true,
      children: [
        { type: 'badge', text: time, tone },
        { type: 'text', text: e.title, weight: 'bold' },
        // 已完成的任务划掉语义靠 tone='faint' 表达，不新增节点类型
        ...(e.taskDone === true ? [{ type: 'badge' as const, text: '已完成', tone: 'faint' as const }] : []),
      ],
    },
  ];
  if (e.detail !== '') children.push({ type: 'text', text: e.detail, tone: 'faint', size: 'sm' });

  // 只有核心任务能勾选 —— 槽条目属于别的插件，Timeline 无权改
  if (isTask) {
    children.push({
      type: 'stack',
      direction: 'row',
      gap: 'sm',
      children: [
        {
          type: 'button',
          label: e.taskDone === true ? '撤销完成' : '标记完成',
          tone: e.taskDone === true ? 'normal' : 'accent',
          onPress: {
            kind: 'command',
            id: 'toggleTask',
            // 目标状态在渲染时算好：命令因此不需要读数据，保持纯函数
            input: { taskId: e.taskId as string, to: e.taskDone === true ? 'open' : 'done' },
          },
        },
      ],
    });
  }

  return { type: 'stack', gap: 'none', children };
}

function toneOf(e: Event): 'accent' | 'warning' | 'normal' {
  if (e.type === 'task') return 'warning';
  if (e.type === 'session') return 'accent';
  return 'normal';
}

// ------------------------------------------------------------ 时间格式化

const PAD = (n: number) => String(n).padStart(2, '0');

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;
}

/**
 * 天的标签。`now` 来自 `ctx`，**不用 `Date.now()`** —— `render()` 必须是纯的。
 */
function dayLabel(key: string, now: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const target = new Date(y, m - 1, d).getTime();
  const today = new Date(now);
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const diffDays = Math.round((target - t0) / 86_400_000);

  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const base = `${m}月${d}日 周${WEEK[new Date(target).getDay()]}`;
  if (diffDays === 0) return `今天 · ${base}`;
  if (diffDays === 1) return `明天 · ${base}`;
  if (diffDays === -1) return `昨天 · ${base}`;
  if (diffDays < 0) return `已过 ${-diffDays} 天 · ${base}`;
  if (diffDays <= 7) return `${diffDays} 天后 · ${base}`;
  return `${y}年 ${base}`;
}

/** 供测试用的纯函数导出 */
export const __test = { collectEvents, dayLabel, hhmm, dayKey };
export type { SlotEntry };
