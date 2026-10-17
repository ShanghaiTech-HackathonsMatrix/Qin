/**
 * 核心命名空间的规范实体 —— **UI 看到的唯一一种任务 / 课程形状**。
 *
 * ## 它解决什么问题
 *
 * 之前有两条互不相通的路：
 *
 * ```
 * TaskStore（SQLite/JSON）  →  Course { name }        → 手写 React 视图
 * DataBus（插件数据）       →  course  { title }       → 控件
 * ```
 *
 * 两个形状、两个来源。Timeline 想变成插件，就必须能读到 `Task`，
 * 而插件唯一的数据通道是 `bus.read()` —— 所以宿主必须把 TaskStore 的数据
 * **投影**进 DataBus。
 *
 * ## 现在：DataBus 是唯一数据层（C 段）
 *
 * 投影是**过渡形态**，已经去掉了。现在：
 *
 * - `DataBus` 是内存里唯一的真相；
 * - `TaskStore`（SQLite/JSON）退化成**物理持久化层**，由 `CoreStoreBackend`
 *   在 `bus.flush()` 时被调用，不再有第二条写入路径；
 * - `BusTaskStore` 是给 UI 的**门面**：读写都走总线，所以「界面改了但时间线没改」
 *   这类 bug 在结构上不存在了。
 *
 * 于是这个文件里成对的两个方向成了核心：
 * `project*`（领域 → 记录）与 `unproject*`（记录 → 领域）。
 * **改动其中一个必须同时改另一个** —— 它们共用 `taskSchema` / `courseSchema`。
 *
 * ## 为什么 `title` 而不是 `name`
 *
 * 插件侧 `course` 用 `title`。核心不能因为自己是核心就另起一个名字 ——
 * `Course.name` 是历史遗留，收敛方向是统一的 `title`。映射只在
 * `projectCourse` / `unprojectCourse` 两处（成对），别在别处再写一遍。
 */

import type { EntitySchema } from '@matrix/plugin-api';

import type { Course, EventKind, Task, TaskStatus } from '../domain/types.ts';

/**
 * 宿主自己的命名空间。
 *
 * 用 `dev.matrix.` 而不是 `app.matrix.`：`app.matrix.*` 留给「用户装得的插件」，
 * 而这里是宿主自己写入的数据。`bus.read()` 的读者 id 也用它。
 */
export const CORE_NS = 'dev.matrix.core';

/**
 * 宿主自己的「读者 id」。
 *
 * `DataBus.read(reader, ...)` 只拿它判断「是不是自己写的记录」（同所有者不做字段裁剪）。
 * 宿主没有 manifest，所以它不是插件命名空间 —— 但必须是个固定字符串，
 * 不能传空串（那会看起来像某个插件）。
 */
export const HOST_NS = 'dev.matrix.shell';

export const CORE_ENTITY = {
  task: 'task',
  course: 'course',
  /** 任务 → 课程的外键，靠它做显示 */
  /** 课程的颜色属于「核心」而不是插件：它是用户自己设的 */
} as const;

/**
 * 槽条目的实体类型名。
 *
 * 槽数据存在**定义方**的命名空间下（`slot.owner`），类型统一叫 `slot_entry`。
 * 一个定义方可以有多个槽，靠 `slot` 字段区分。
 *
 * ⚠️ 定义方必须在自己的 `contributes.entityTypes` 里**声明同名的类型** ——
 * `DataBus.emit()` 不认没有 schema 的类型。宿主这里注册的一份是给核心命名空间
 * 用的（宿主自己也可能有槽），两边的 schema 形状相同。
 */
export const SLOT_TYPE = 'slot_entry';

/**
 * 槽条目的存储 schema。
 *
 * `values` 是槽字段的键值对，形状由**定义方**的 `SlotDefinition.fields` 决定，
 * 所以这里只能声明成「任意标量映射」—— 逐字段的校验在
 * `buildSlotEntry()` 里做（写入时就做了，不是渲染时）。
 *
 * `source` 是宿主填的，写入方改不了：有了它，「这条是谁塞进来的」永远可查。
 */
export const slotEntrySchema: EntitySchema = {
  type: 'object',
  required: ['slot', 'values', 'source', 'from', 'ref'],
  properties: {
    slot: { type: 'string', maxLength: 120 },
    values: { type: 'object' },
    source: { type: 'string', maxLength: 200 },
    from: { type: 'string', maxLength: 60 },
    ref: { type: 'string', maxLength: 200 },
  },
  additionalProperties: false,
};

/** 与 `apps/shell/src/domain/types.ts` 的 `Task` 一一对应 */
export const taskSchema: EntitySchema = {
  type: 'object',
  required: ['title', 'kind', 'status', 'createdAt', 'updatedAt'],
  properties: {
    title: { type: 'string', maxLength: 200 },
    /** ddl | course | quiz | checkin | custom */
    kind: { type: 'string', maxLength: 20 },
    /** 无期限的任务写 null */
    dueAt: { type: 'number', nullable: true },
    status: { type: 'string', maxLength: 20 },
    /** 指向核心 `course` 的 id；null = 不属于任何课程 */
    courseId: { type: 'string', maxLength: 200, nullable: true },
    note: { type: 'string', maxLength: 2000 },
    createdAt: { type: 'number' },
    updatedAt: { type: 'number' },
  },
  additionalProperties: false,
};

/** 与 `apps/shell/src/domain/types.ts` 的 `Course` 一一对应，但 `name` → `title` */
export const courseSchema: EntitySchema = {
  type: 'object',
  required: ['title', 'createdAt', 'updatedAt'],
  properties: {
    title: { type: 'string', maxLength: 200 },
    code: { type: 'string', maxLength: 64 },
    /** 用户自己选的颜色。它是核心数据，不是插件的 */
    color: { type: 'string', maxLength: 32 },
    createdAt: { type: 'number' },
    updatedAt: { type: 'number' },
  },
  additionalProperties: false,
};

// ------------------------------------------------------------ 投影

/** 宿主领域模型的**结构**描述。不 import `domain/types.ts`，避免核心里出现 UI 层的类型 */
export interface TaskLike {
  id: string;
  kind: string;
  title: string;
  courseId: string | null;
  dueAt: number | null;
  status: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CourseLike {
  id: string;
  name: string;
  code?: string;
  color?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 把领域模型投影成 DataBus 实体的形状。
 *
 * **纯函数**，没有任何 IO —— 这样它能被测，也能保证「投影不会偷偷改数据」。
 * 可选字段用**省略键**而不是 `undefined`：`additionalProperties: false` +
 * schema 校验下，`undefined` 会被判成类型不符（和 ICS 插件里同一个理由）。
 */
export function projectTask(t: TaskLike): { type: string; id: string; data: Record<string, unknown> } {
  return {
    type: CORE_ENTITY.task,
    id: t.id,
    data: {
      title: t.title,
      kind: t.kind,
      dueAt: t.dueAt,
      status: t.status,
      courseId: t.courseId,
      ...(t.note !== undefined && t.note !== '' ? { note: t.note } : {}),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    },
  };
}

export function projectCourse(c: CourseLike): { type: string; id: string; data: Record<string, unknown> } {
  return {
    type: CORE_ENTITY.course,
    id: c.id,
    data: {
      // ← 收敛点：`Course.name` → `title`
      title: c.name,
      ...(c.code !== undefined && c.code !== '' ? { code: c.code } : {}),
      ...(c.color !== undefined && c.color !== '' ? { color: c.color } : {}),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    },
  };
}

/**
 * 核心命名空间下所有实体类型的 schema。
 *
 * 宿主在构造 `PluginHost` 时用它一次性声明 —— `DataBus.emit()` 不认没有
 * schema 的类型，宿主自己也不例外。
 */
export const CORE_SCHEMAS: Readonly<Record<string, EntitySchema>> = {
  [CORE_ENTITY.task]: taskSchema,
  [CORE_ENTITY.course]: courseSchema,
  [SLOT_TYPE]: slotEntrySchema,
};

// ------------------------------------------------------------ 逆映射

/**
 * 合法取值的白名单。
 *
 * 记录里的 `kind` / `status` 在 schema 里只是「不超过 20 字的字符串」——
 * schema 管不了枚举，因为枚举属于**领域**而不属于存储形状。
 * 所以逆映射必须自己收窄，否则 `Task.status` 会拿到一个类型系统以为合法、
 * 实际是 `'zzz'` 的值。
 */
const KINDS: readonly EventKind[] = ['ddl', 'course', 'quiz', 'checkin', 'custom'];
const STATUSES: readonly TaskStatus[] = ['open', 'done', 'dismissed'];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * DataBus 记录 → 领域 `Task`。
 *
 * **和 `projectTask` 成对**：改了那边的字段名，这里必须跟着改。
 * 脏数据的处理原则是**降级而不是抛异常** —— 一条坏记录不该让整页打不开。
 */
export function unprojectTask(rec: { id: string; data: Record<string, unknown> }): Task {
  const d = rec.data;
  const kind = str(d.kind);
  const status = str(d.status);
  const note = str(d.note);
  const courseId = str(d.courseId);
  return {
    id: rec.id,
    kind: (KINDS as readonly string[]).includes(kind) ? (kind as EventKind) : 'custom',
    title: str(d.title),
    courseId: courseId === '' ? null : courseId,
    dueAt: finite(d.dueAt),
    status: (STATUSES as readonly string[]).includes(status) ? (status as TaskStatus) : 'open',
    ...(note !== '' ? { note } : {}),
    createdAt: finite(d.createdAt) ?? 0,
    updatedAt: finite(d.updatedAt) ?? 0,
  };
}

/** DataBus 记录 → 领域 `Course`。`title` → `name` 是 `projectCourse` 的逆 */
export function unprojectCourse(rec: { id: string; data: Record<string, unknown> }): Course {
  const d = rec.data;
  const code = str(d.code);
  const color = str(d.color);
  return {
    id: rec.id,
    name: str(d.title),
    ...(code !== '' ? { code } : {}),
    ...(color !== '' ? { color } : {}),
    createdAt: finite(d.createdAt) ?? 0,
    updatedAt: finite(d.updatedAt) ?? 0,
  };
}
