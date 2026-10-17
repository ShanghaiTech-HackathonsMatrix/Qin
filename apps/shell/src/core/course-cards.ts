/**
 * 「课程」页的数据源（dev.md T15）。
 *
 * ## 为什么要跨命名空间读
 *
 * 课程有两个来源：
 *
 * - **核心**：用户自己建的，存在 `TaskStore`，投影进 DataBus 的 `dev.matrix.core`
 * - **插件**：ICS 导入的，存在它自己的命名空间
 *
 * 原来的 `CoursesView` 直接读 `TaskStore`，所以 ICS 导入的课一个字都看不见 ——
 * 数据明明落了盘，界面却是空的。
 *
 * `DataBus.read()` 不带 `owner` 时**跨命名空间可见**（按 `type` 遍历整张表），
 * 这里正是用它的地方。每条记录按**自己所有者**的 schema 裁剪字段，
 * 所以核心的 `color`、ICS 的 `location` 不会互相污染。
 *
 * ## 一个必须承认的边界
 *
 * 插件课程**只读**。它的真相在插件那边（下次 `sync()` 会整体重写），
 * 让用户在宿主界面上改它，改完下次同步就被覆盖 —— 那是骗人。
 * 所以 `editable` 只有核心课程是 true。
 */

import type { EntityRecord } from '@matrix/kernel';

import { CORE_NS } from './core-entities.ts';

export interface CourseCard {
  /**
   * 跨命名空间唯一的键，用作 React `key`。
   *
   * 不能直接用 `id`：两个插件完全可能各自造一个 `course-1`。
   */
  key: string;
  id: string;
  title: string;
  code: string | undefined;
  color: string | undefined;
  /** 记录属于谁：`dev.matrix.core` 或插件 id */
  owner: string;
  /** 只有核心课程能编辑 / 删除，见文件头 */
  editable: boolean;
}

/** 新增 / 修改课程时用户填的东西。不含 id 与时间戳 —— 那些由宿主决定 */
export interface CourseDraft {
  title: string;
  code?: string;
  color?: string;
}

/**
 * 把 DataBus 里的 `course` 记录转成页面用的卡片。
 *
 * 脏数据（没 `title`、`title` 不是字符串）**跳过而不是抛** ——
 * 一个坏插件不该让整页白屏。用户看到少一门课，比看到「出了点问题」好。
 */
export function toCourseCards(records: readonly EntityRecord[]): CourseCard[] {
  const out: CourseCard[] = [];

  for (const rec of records) {
    const title = rec.data.title;
    if (typeof title !== 'string' || title.trim() === '') continue;

    const code = rec.data.code;
    const color = rec.data.color;

    out.push({
      key: `${rec.pluginId}\u0000${rec.id}`,
      id: rec.id,
      title,
      code: typeof code === 'string' && code !== '' ? code : undefined,
      color: typeof color === 'string' && color !== '' ? color : undefined,
      owner: rec.pluginId,
      editable: rec.pluginId === CORE_NS,
    });
  }

  // 核心的排前面：用户自己建的课是他认识的东西，插件导入的是「外部来的」。
  // 同组内按标题排，让列表稳定（不按 id，id 是随机的）。
  return out.sort((a, b) => {
    const coreA = a.owner === CORE_NS ? 0 : 1;
    const coreB = b.owner === CORE_NS ? 0 : 1;
    if (coreA !== coreB) return coreA - coreB;
    return a.title.localeCompare(b.title, 'zh-CN');
  });
}

/** 给 UI 显示「来自哪个插件」的短名 */
export function ownerLabel(owner: string): string {
  if (owner === CORE_NS) return '本机';
  // `app.matrix.importer.ics` → `importer.ics`；取不到就原样显示
  const parts = owner.split('.');
  return parts.length >= 3 ? parts.slice(2).join('.') : owner;
}
