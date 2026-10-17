/**
 * 命令通道（dev.md T14）—— 控件「点一下要改数据」时走的路。
 *
 * ## 为什么需要它，以及为什么不能更简单
 *
 * 控件是**数据**（`UiNode`），用户点击变成 `Action`，由**宿主**路由。
 * 前三档动作都只是「换页面 / 换局部状态 / 跑一次同步」，没有一档能让数据改变。
 *
 * 最省事的做法是给插件一个 `setData()` 回调。**不行**：
 *
 * - 回调是异步的、有副作用的 → 破 D8（插件是纯函数）
 * - 插件直接写存储 → 破 D3
 * - 同一个 `render()` 可能因为回调被调过而返回不同结果 → 「数据 → 界面」不再是函数
 *
 * 所以命令也是**纯函数**：`(input, ctx) => 要做的改动`。
 * 插件只**描述**改动，宿主**执行**改动。和槽的 `map`、控件的 `Action` 是同一个思路 ——
 * 插件产出数据，宿主做副作用。
 *
 * ## 为什么 `coreOps` 是一张封闭清单
 *
 * 核心数据（任务、课程）是宿主的，不是任何插件的。让插件提交「任意 SQL 式补丁」
 * 等于把 D3 从后门还回去。所以这里只有几种**宿主认识**的操作，
 * 每一种都由宿主翻译成一次 `TaskStore` 调用。
 *
 * 加新操作 = 改核心 + 改契约 + 加测试。这是刻意的摩擦：
 * 核心数据模型不该被插件悄悄扩张。
 */

import type { ParsedEntity } from './contract.ts';

/**
 * 命令入参。
 *
 * 只能是标量：要过沙箱边界、要能写进审计日志、要能被 `JSON.stringify` 往返。
 * 传对象就说明插件想把状态塞进命令里 —— 那应该走它自己的实体。
 */
export type CommandInput = Readonly<Record<string, string | number | boolean>>;

export interface CommandContext {
  /** 发起命令的插件 */
  pluginId: string;
  /**
   * 宿主的当前时间（epoch ms）。
   *
   * 给这个是为了让命令保持纯函数：插件不该调 `Date.now()`，
   * 否则「同样的输入得到同样的改动」不成立，测试也没法钉住。
   */
  now: number;
}

// ------------------------------------------------------------ 核心操作

export const CORE_TASK_STATUSES = ['open', 'done'] as const;
export type CoreTaskStatus = (typeof CORE_TASK_STATUSES)[number];

/**
 * 对**核心数据**的改动意图。封闭清单，见文件头。
 *
 * 每一项都必须满足：宿主能用一次 `TaskStore` 调用完成，且不需要插件提供额外上下文。
 */
export type CoreOp =
  /** 改任务状态。时间线上「勾选完成」就是它 */
  | { op: 'task.setStatus'; id: string; status: CoreTaskStatus }
  /** 删任务 */
  | { op: 'task.delete'; id: string };

/** 每一项 `CoreOp` 对应的实体类型 —— 权限检查按它查 `permissions.data.write` */
export const CORE_OP_TYPE: Readonly<Record<CoreOp['op'], string>> = {
  'task.setStatus': 'task',
  'task.delete': 'task',
};

// ------------------------------------------------------------ 结果

/**
 * 命令的执行结果 —— 全是**描述**，没有一个是副作用。
 */
export interface CommandResult {
  /** 写进插件自己命名空间的实体（受 `permissions.data.write` 约束） */
  entities?: readonly ParsedEntity[];
  /** 对核心数据的改动意图（受 `permissions.data.write` 约束 + 封闭清单） */
  coreOps?: readonly CoreOp[];
  /** 给用户看的一行回执。宿主会显示在页面上 */
  message?: string;
}

export type CommandHandler = (input: CommandInput, ctx: CommandContext) => CommandResult;

// ------------------------------------------------------------ 限制

export const COMMAND_LIMITS = {
  maxInputKeys: 20,
  maxInputString: 300,
  maxEntities: 500,
  maxCoreOps: 200,
  maxMessage: 300,
} as const;

// ------------------------------------------------------------ 校验

export type Validated<T> = { ok: true; value: T } | { ok: false; reason: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

/** 校验命令入参。由宿主在调 handler **之前**跑 */
export function validateCommandInput(raw: unknown, at = 'input'): Validated<CommandInput> {
  if (raw === undefined) return { ok: true, value: {} };
  if (!isPlainObject(raw)) return { ok: false, reason: `${at} 必须是对象` };

  const keys = Object.keys(raw);
  if (keys.length > COMMAND_LIMITS.maxInputKeys) {
    return { ok: false, reason: `${at} 最多 ${COMMAND_LIMITS.maxInputKeys} 个键，实际 ${keys.length}` };
  }

  const out: Record<string, string | number | boolean> = {};
  for (const k of keys) {
    const v = raw[k];
    if (!isScalar(v)) {
      return { ok: false, reason: `${at}.${k} 只能是字符串 / 数字 / 布尔（命令入参要可序列化）` };
    }
    if (typeof v === 'string' && v.length > COMMAND_LIMITS.maxInputString) {
      return {
        ok: false,
        reason: `${at}.${k} 超过 ${COMMAND_LIMITS.maxInputString} 字符`,
      };
    }
    out[k] = v;
  }
  return { ok: true, value: out };
}

/**
 * 校验 handler 的返回值。由宿主在调 handler **之后**跑。
 *
 * ⚠️ 这一步不是「防御性编程」，是**信任边界**：`CommandResult` 来自插件，
 * 第三方插件（将来进沙箱）交回来的东西必须按不可信处理。
 */
export function validateCommandResult(raw: unknown): Validated<CommandResult> {
  if (!isPlainObject(raw)) return { ok: false, reason: '命令必须返回对象' };

  const out: {
    entities?: ParsedEntity[];
    coreOps?: CoreOp[];
    message?: string;
  } = {};

  // --- entities
  if (raw.entities !== undefined) {
    if (!Array.isArray(raw.entities)) return { ok: false, reason: 'entities 必须是数组' };
    if (raw.entities.length > COMMAND_LIMITS.maxEntities) {
      return {
        ok: false,
        reason: `entities 最多 ${COMMAND_LIMITS.maxEntities} 条，实际 ${raw.entities.length}`,
      };
    }
    const list: ParsedEntity[] = [];
    for (let i = 0; i < raw.entities.length; i += 1) {
      const e = raw.entities[i];
      if (!isPlainObject(e)) return { ok: false, reason: `entities[${i}] 必须是对象` };
      if (typeof e.type !== 'string' || e.type === '') {
        return { ok: false, reason: `entities[${i}].type 必须是非空字符串` };
      }
      if (e.id !== undefined && typeof e.id !== 'string') {
        return { ok: false, reason: `entities[${i}].id 必须是字符串` };
      }
      if (!isPlainObject(e.data)) return { ok: false, reason: `entities[${i}].data 必须是对象` };
      list.push(
        e.id === undefined
          ? { type: e.type, data: e.data }
          : { type: e.type, id: e.id, data: e.data },
      );
    }
    out.entities = list;
  }

  // --- coreOps
  if (raw.coreOps !== undefined) {
    if (!Array.isArray(raw.coreOps)) return { ok: false, reason: 'coreOps 必须是数组' };
    if (raw.coreOps.length > COMMAND_LIMITS.maxCoreOps) {
      return {
        ok: false,
        reason: `coreOps 最多 ${COMMAND_LIMITS.maxCoreOps} 条，实际 ${raw.coreOps.length}`,
      };
    }
    const ops: CoreOp[] = [];
    for (let i = 0; i < raw.coreOps.length; i += 1) {
      const op = raw.coreOps[i];
      if (!isPlainObject(op)) return { ok: false, reason: `coreOps[${i}] 必须是对象` };
      if (typeof op.id !== 'string' || op.id === '') {
        return { ok: false, reason: `coreOps[${i}].id 必须是非空字符串` };
      }

      if (op.op === 'task.setStatus') {
        if (!CORE_TASK_STATUSES.includes(op.status as CoreTaskStatus)) {
          return {
            ok: false,
            reason: `coreOps[${i}].status 只能是 ${CORE_TASK_STATUSES.join(' / ')}`,
          };
        }
        ops.push({ op: 'task.setStatus', id: op.id, status: op.status as CoreTaskStatus });
        continue;
      }
      if (op.op === 'task.delete') {
        ops.push({ op: 'task.delete', id: op.id });
        continue;
      }
      return {
        ok: false,
        reason: `coreOps[${i}].op 未知："${String(op.op)}"（封闭清单：${Object.keys(CORE_OP_TYPE).join(' / ')}）`,
      };
    }
    out.coreOps = ops;
  }

  // --- message
  if (raw.message !== undefined) {
    if (typeof raw.message !== 'string') return { ok: false, reason: 'message 必须是字符串' };
    out.message = raw.message.slice(0, COMMAND_LIMITS.maxMessage);
  }

  return { ok: true, value: out };
}

/** 一个 `CoreOp` 触碰的实体类型，用来查 `permissions.data.write` */
export function coreOpType(op: CoreOp): string {
  return CORE_OP_TYPE[op.op];
}
