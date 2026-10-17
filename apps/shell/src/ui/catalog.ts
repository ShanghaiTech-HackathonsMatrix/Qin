/**
 * 控件目录 —— **从已装 manifest 派生，不落盘**。
 *
 * 为什么不在 KV 里存一份目录：manifest 已经是注册动作、也已经校验过，
 * 再存一份就是第二个真相源。`manifest.ts` 顶部自己写着「两份并存必然漂移，
 * 所以现在只留一份」。落盘的是**布局**（`layout.ts`），不是目录。
 *
 * 这里还负责做一次**交叉核对**：manifest 声明了视图但没有实现、或者实现了却没声明。
 * 这两种都是真 bug，但不该让界面崩 —— 记进 `issues`，由页面显式提示。
 */

import type { ViewContribution, ViewRender } from '@matrix/plugin-api';

import type { PluginHost } from '../core/plugin-host';

export interface CatalogEntry {
  pluginId: string;
  view: ViewContribution;
  /** manifest 声明了但插件没给实现时为 undefined */
  render: ViewRender | undefined;
}

export interface ViewCatalog {
  entries: CatalogEntry[];
  issues: string[];
  find(pluginId: string, viewId: string): CatalogEntry | undefined;
}

export function buildCatalog(host: PluginHost): ViewCatalog {
  const entries: CatalogEntry[] = [];
  const issues: string[] = [];

  for (const rec of host.registry.list()) {
    const pluginId = rec.manifest.id;
    const views = rec.manifest.contributes?.views ?? [];
    const renders = host.registry.exportsOf(pluginId)?.renders ?? {};
    const declared = new Set(views.map((v) => v.id));

    for (const view of views) {
      const render = renders[view.id];
      if (render === undefined) {
        issues.push(`${pluginId} 声明了视图 "${view.id}" 但没有实现（renders 里缺这一项）`);
      }
      entries.push({ pluginId, view, render });
    }

    for (const id of Object.keys(renders)) {
      if (!declared.has(id)) {
        issues.push(`${pluginId} 实现了视图 "${id}" 但没在 manifest 里声明（不会被渲染）`);
      }
    }
  }

  const index = new Map(entries.map((e) => [`${e.pluginId}\u0000${e.view.id}`, e]));
  return {
    entries,
    issues,
    find: (pluginId, viewId) => index.get(`${pluginId}\u0000${viewId}`),
  };
}

/**
 * 自动布局：把目录里所有 `widget` 按 manifest 顺序排开。
 *
 * 用在「用户还没自己摆过」的情况。它是目录的**函数**，所以装了新插件就自动出现 ——
 * 不需要用户手动添加，也不需要往 KV 写任何东西。
 */
export function autoLayout(
  catalog: ViewCatalog,
): Array<{
  instanceId: string;
  pluginId: string;
  viewId: string;
  props: Record<string, unknown>;
  grid: { w: number; h: number };
}> {
  return catalog.entries
    .filter((e) => e.view.kind === 'widget' && e.render !== undefined)
    .map((e) => ({
      instanceId: instanceIdFor(e.pluginId, e.view.id),
      pluginId: e.pluginId,
      viewId: e.view.id,
      props: { ...(e.view.defaultProps ?? {}) },
      grid: {
        w: e.view.defaultSize?.w ?? 12,
        h: e.view.defaultSize?.h ?? 1,
      },
    }));
}

/**
 * 生成合法的 instanceId（`^[a-z0-9][a-z0-9_-]*$`）。
 *
 * 不能用 `pluginId/viewId` 直接拼：`/` 和 `.` 都不合法，而且长度会失控。
 */
export function instanceIdFor(pluginId: string, viewId: string): string {
  const slug = `${pluginId}-${viewId}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `w-${slug}`.slice(0, 120);
}
