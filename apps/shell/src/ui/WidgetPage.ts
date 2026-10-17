/**
 * 控件页面容器 —— 把「布局文档 + 控件目录 + 数据」拼成一块能点的界面。
 *
 * 它是**唯一**知道怎么把 `Action` 变成副作用的地方：
 *
 *     navigate → 切标签页
 *     setUi    → 写这个实例的瞬时状态（存宿主，插件自己不持有状态）
 *     sync     → 让宿主对那个插件跑一次同步（走现有 broker）
 *
 * 同样用 `createElement` 而不是 JSX，理由见 `render.ts`。
 */

import { createElement, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import {
  parseUiNode,
  type Action,
  type UiNode,
  type UiState,
  type ViewContext,
  type ViewRecord,
} from '@matrix/plugin-api';

import type { PluginHost } from '../core/plugin-host';
import { autoLayout, buildCatalog, type CatalogEntry } from './catalog';
import type { LayoutStore, LayoutWidget } from './layout';
import { UiNodeView } from './render';

/** 宿主自己的命名空间。`bus.read()` 要求一个读者 id，宿主不是插件 */
const HOST_ID = 'dev.matrix.shell';
const MAX_RECORDS = 200;

export interface WidgetPageProps {
  host: PluginHost;
  layout: LayoutStore;
  onNavigate: (to: string) => void;
}

export function WidgetPage({ host, layout, onNavigate }: WidgetPageProps): ReactElement {
  const [widgets, setWidgets] = useState<LayoutWidget[] | null>(null);
  const [layoutIssue, setLayoutIssue] = useState<string | null>(null);
  const [uiState, setUiState] = useState<Record<string, UiState>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // 布局只读一次。它变了要重新挂载页面（用户改布局是低频操作）
  useEffect(() => {
    let alive = true;
    void layout.load().then(({ doc, issue }) => {
      if (!alive) return;
      setLayoutIssue(issue);
      setWidgets(doc.widgets);
    });
    return () => {
      alive = false;
    };
  }, [layout]);

  // 数据一变就重渲染。控件自己不发事件，它只会被重新调用
  useEffect(() => host.bus.subscribe(() => setTick((t) => t + 1)), [host]);

  // `tick` 在依赖里是刻意的：装/卸插件会改变目录
  const catalog = useMemo(() => buildCatalog(host), [host, tick]);

  const dispatch = useCallback(
    (action: Action, w: LayoutWidget): void => {
      if (action.kind === 'navigate') {
        onNavigate(action.to);
        return;
      }
      if (action.kind === 'setUi') {
        setUiState((prev) => ({
          ...prev,
          [w.instanceId]: { ...(prev[w.instanceId] ?? {}), [action.key]: action.value },
        }));
        return;
      }

      // sync
      setNotice(`${w.pluginId} 正在同步…`);
      void host
        .sync(w.pluginId, {
          trigger: 'manual',
          now: Date.now(),
          ...(action.settings !== undefined ? { settings: action.settings } : {}),
        })
        .then((r) => {
          if (!r.ok) {
            setNotice(`${w.pluginId} 同步失败：${r.code} ${r.message}`);
            return;
          }
          const errs = r.data.errors.length;
          setNotice(`${w.pluginId} 同步完成${errs > 0 ? `（${errs} 条警告）` : ''}`);
          setTick((t) => t + 1);
        })
        .catch((e: unknown) => {
          setNotice(`${w.pluginId} 同步异常：${e instanceof Error ? e.message : String(e)}`);
        });
    },
    [host, onNavigate],
  );

  if (widgets === null) {
    return createElement('div', { className: 'ui-text' }, '正在载入布局…');
  }

  const instances = widgets.length === 0 ? autoLayout(catalog) : widgets;

  const rendered = instances.map((w) => {
    const entry = catalog.find(w.pluginId, w.viewId);
    const node = nodeFor(entry, w, uiState[w.instanceId] ?? {}, host);
    return createElement(UiNodeView, {
      key: w.instanceId,
      node,
      onAction: (a: Action) => dispatch(a, w),
    });
  });

  return createElement(
    'div',
    { className: 'ui-stack', style: { flexDirection: 'column', gap: 'var(--gap)' } },
    ...(layoutIssue !== null
      ? [createElement('div', { key: '__issue', className: 'ui-empty__text' }, layoutIssue)]
      : []),
    ...(notice !== null
      ? [createElement('div', { key: '__notice', className: 'ui-text', style: { color: 'var(--fg-dim)', fontSize: 'var(--fs-sm)' } }, notice)]
      : []),
    ...catalog.issues.map((msg, i) =>
      createElement('div', { key: `__ci${i}`, className: 'ui-empty__text' }, `控件目录警告：${msg}`),
    ),
    ...rendered,
  );
}

/**
 * 把一个实例算成一棵 UI 树。
 *
 * 所有失败路径都返回**可见的占位节点**，不抛异常、不画空白：
 * 用户看到「插件没装」比看到一片空白有用得多。
 */
function nodeFor(
  entry: CatalogEntry | undefined,
  w: LayoutWidget,
  ui: UiState,
  host: PluginHost,
): UiNode {
  if (entry === undefined) {
    return { type: 'empty', text: `控件 ${w.pluginId} / ${w.viewId} 未安装（或已被卸载）` };
  }
  if (entry.render === undefined) {
    return { type: 'empty', text: `控件 ${w.viewId} 声明了但没有实现` };
  }

  const requires = entry.view.requires ?? [];
  const { records, missing } = recordsFor(host, w.pluginId, requires);
  if (missing.length > 0) {
    return {
      type: 'empty',
      text: `控件 ${w.viewId} 需要读取 ${missing.join(' / ')}，但插件没有声明 data.read 权限`,
    };
  }

  const ctx: ViewContext = {
    instanceId: w.instanceId,
    props: { ...(entry.view.defaultProps ?? {}), ...w.props },
    records,
    ui,
    locale: 'zh-CN',
    capabilities: host.registry.capabilities(),
    now: Date.now(),
  };

  let tree: UiNode;
  try {
    tree = entry.render(ctx);
  } catch (e) {
    return { type: 'empty', text: `控件 ${w.viewId} 渲染时抛异常：${e instanceof Error ? e.message : String(e)}` };
  }

  // **安全边界**：插件产出的是不可信输入，重建一遍再交给 React
  const parsed = parseUiNode(tree);
  if (!parsed.ok) {
    return { type: 'empty', text: `控件 ${w.viewId} 产出了非法 UI：${parsed.message}` };
  }
  return parsed.data;
}

/**
 * 取控件要的数据。
 *
 * **按插件自己的 `permissions.data.read` 过滤** —— 控件不能借宿主的读取能力
 * 绕过权限。缺权限的类型进 `missing`，由调用方画成可见的提示。
 */
function recordsFor(
  host: PluginHost,
  pluginId: string,
  types: readonly string[],
): { records: ViewRecord[]; missing: string[] } {
  const granted = host.registry.get(pluginId)?.manifest.permissions?.data?.read ?? [];
  const missing = types.filter((t) => !granted.includes(t));

  const records: ViewRecord[] = [];
  for (const type of types) {
    if (!granted.includes(type)) continue;
    const r = host.bus.read(HOST_ID, type, { limit: MAX_RECORDS });
    if (!r.ok) continue;
    for (const rec of r.data) {
      records.push({ type: rec.type, id: rec.id, data: rec.data, updatedAt: rec.updatedAt });
    }
  }
  return { records, missing };
}
