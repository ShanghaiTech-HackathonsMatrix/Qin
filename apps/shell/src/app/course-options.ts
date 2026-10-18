/**
 * 「新建 / 编辑任务 → 所属课程」下拉栏的候选。
 *
 * ## 课程有两个来源，原来只取了第一个
 *
 * - **本机**：`TaskStore` 里用户自己建的课（「＋课程」按钮建的）
 * - **平台**：教务课表 / 互动教学平台 / Gradescope 同步回来的课 ——
 *   它们只活在各自的 `AcademicSnapshot` 里，从来没进过 `TaskStore`
 *
 * 下拉栏原来只喂本机那份，于是同步回来几十门课、下拉栏里还是只有「（无）」一项：
 * 看着能点，实际没得选。用户说的「所属课程下拉栏无法选择」就是这个。
 *
 * ## 为什么按 id 去重、且本机优先
 *
 * 同一个 id 只留第一次出现的那条。本机排前面 —— 用户在「课程」页改过的名字
 * 不该被下一次同步覆盖回去。平台课程本身是只读的（真相在插件那边，
 * 下次 `sync()` 会整体重写），所以这里的合并只影响**选择**，不写库。
 */

import { PROVIDER_LABEL } from './ddl-items.ts';

export interface CourseOption {
  id: string;
  name: string;
  code?: string;
  /** 分组标题：本机 / 教务课表 / 互动教学平台 … */
  source: string;
}

/** 本机课程在这份列表里的样子（`Course` 结构比这大） */
export interface OwnCourse {
  id: string;
  name: string;
  code?: string;
}

/**
 * 只需要快照里这两样。
 *
 * 不直接要 `AcademicSnapshot`：那个结构大得多，依赖拖进来之后这段合并逻辑
 * 就没法单独测了。
 */
export interface CourseSource {
  provider: string;
  courses: readonly { id: string; title: string; code?: string }[];
}

export function mergeCourseOptions(
  own: readonly OwnCourse[],
  snapshots: readonly CourseSource[],
): CourseOption[] {
  const seen = new Set<string>();
  const out: CourseOption[] = [];

  for (const c of own) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ id: c.id, name: c.name, code: c.code || undefined, source: '本机' });
  }

  for (const snap of snapshots) {
    // 未知平台就原样显示 id —— 总比显示成「其他」让人猜强
    const source = PROVIDER_LABEL[snap.provider] ?? snap.provider;
    for (const c of snap.courses) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ id: c.id, name: c.title, code: c.code || undefined, source });
    }
  }

  return out;
}

/** 按来源分组，保持出现顺序。给 `<optgroup>` 用 */
export function groupCourseOptions(
  options: readonly CourseOption[],
): Array<[string, CourseOption[]]> {
  const map = new Map<string, CourseOption[]>();
  for (const c of options) {
    const list = map.get(c.source);
    if (list) list.push(c);
    else map.set(c.source, [c]);
  }
  return [...map.entries()];
}
