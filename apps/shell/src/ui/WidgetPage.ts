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
} from '@matrix/plugin-api';

import type { PluginHost } from '../core/plugin-host';
import { autoLayout, buildCatalog, type CatalogEntry } from './catalog';
import type { LayoutStore, LayoutWidget } from './layout';
import { recordsFor } from './record-selection';
import { UiNodeView } from './render';
import {pageTarget} from './navigation';


export interface WidgetPageProps {
  host: PluginHost;
  layout: LayoutStore;
  onNavigate: (to: string) => void;
  /** 命令改了核心数据后通知宿主刷新（见 `runActionCommand`） */
  onDataChanged?: () => void;
}

export function WidgetPage({ host, layout, onNavigate, onDataChanged }: WidgetPageProps): ReactElement {
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
  useEffect(() => host.registry.on(() => setTick((t) => t + 1)), [host]);

  // `tick` 在依赖里是刻意的：装/卸插件会改变目录
  const catalog = useMemo(() => buildCatalog(host), [host, tick]);

  const dispatch = useCallback(
    (action: Action, w: LayoutWidget): void => {
      if (action.kind === 'navigate') {
        const target=pageTarget(host,w.pluginId,action.to);if(target)onNavigate(target);else setNotice('未声明的插件页面');
        return;
      }
      if (action.kind === 'setUi') {
        setUiState((prev) => ({
          ...prev,
          [w.instanceId]: { ...(prev[w.instanceId] ?? {}), [action.key]: action.value },
        }));
        return;
      }

      if (action.kind === 'command') {
        runActionCommand(host, w.pluginId, action, setNotice, setTick, onDataChanged);
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
    [host, onNavigate, onDataChanged],
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

export interface PageViewProps {
  host: PluginHost;
  /** `pluginId` + `viewId` 定位一个 page 视图 */
  pluginId: string;
  viewId: string;
  onNavigate: (to: string) => void;
  /** 命令改了核心数据后通知宿主刷新（见 `runActionCommand`） */
  onDataChanged?: () => void;
}

/**
 * 渲染一个 **page 级**视图（`kind: 'page'`）—— 占整屏，不参与首页格子布局。
 *
 * 和 `WidgetPage` 共用 `nodeFor()`：两者的差别只是「实例从哪来」
 * （page 没有布局文档，属性就是 `defaultProps`），渲染和安全边界完全一致。
 */
export function PageView({
  host,
  pluginId,
  viewId,
  onNavigate,
  onDataChanged,
}: PageViewProps): ReactElement {
  const [ui, setUi] = useState<UiState>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => host.bus.subscribe(() => setTick((t) => t + 1)), [host]);
  useEffect(() => host.registry.on(() => setTick((t) => t + 1)), [host]);

  const catalog = useMemo(() => buildCatalog(host), [host, tick]);
  const entry = catalog.find(pluginId, viewId);

  const dispatch = useCallback(
    (action: Action): void => {
      if (action.kind === 'navigate') {
        const target=pageTarget(host,pluginId,action.to);if(target)onNavigate(target);else setNotice('未声明的插件页面');
        return;
      }
      if (action.kind === 'setUi') {
        setUi((prev) => ({ ...prev, [action.key]: action.value }));
        return;
      }
      if (action.kind === 'command') {
        runActionCommand(host, pluginId, action, setNotice, setTick, onDataChanged);
        return;
      }
      setNotice(`${pluginId} 正在同步…`);
      void host
        .sync(pluginId, {
          trigger: 'manual',
          now: Date.now(),
          ...(action.settings !== undefined ? { settings: action.settings } : {}),
        })
        .then((r) => {
          setNotice(r.ok ? `${pluginId} 同步完成` : `${pluginId} 同步失败：${r.code} ${r.message}`);
          setTick((t) => t + 1);
        })
        .catch((e: unknown) => {
          setNotice(`${pluginId} 同步异常：${e instanceof Error ? e.message : String(e)}`);
        });
    },
    [host, onNavigate, pluginId, onDataChanged],
  );

  // page 视图没有布局实例，用一组稳定的伪实例（instanceId = viewId）
  const fakeWidget: LayoutWidget = {
    instanceId: viewId,
    pluginId,
    viewId,
    props: {},
    grid: { w: 12, h: 1 },
  };
  const node = nodeFor(entry, fakeWidget, ui, host);

  return createElement(
    'div',
    { className: 'ui-stack', style: { flexDirection: 'column', gap: 'var(--gap)' } },
    ...(notice !== null
      ? [
          createElement(
            'div',
            { key: '__notice', className: 'ui-text', style: { color: 'var(--fg-dim)', fontSize: 'var(--fs-sm)' } },
            notice,
          ),
        ]
      : []),
    createElement(UiNodeView, { node, onAction: dispatch }),
  );
}

/**
 * `command` 动作的公共处理 —— 两个页面组件都要，抽出来免得漂移。
 *
 * 注意 `onDataChanged`：命令可能改了**核心数据**（勾选完成、删任务）。
 * 那些数据落在 `TaskStore` 里，`App` 有自己的 state 副本，不通知它就还是旧的。
 * 这里不直接调 `reload()`，因为 `ui/` 不该知道 `App` 的存在。
 */
function runActionCommand(
  host: PluginHost,
  pluginId: string,
  action: { kind: 'command'; id: string; input?: Record<string, string | number | boolean> },
  setNotice: (s: string) => void,
  setTick: (f: (t: number) => number) => void,
  onDataChanged: (() => void) | undefined,
): void {
  setNotice(`${pluginId} 正在执行…`);
  void host
    .runCommand(pluginId, action.id, action.input ?? {})
    .then((r) => {
      if (!r.ok) {
        setNotice(`${pluginId} 操作失败：${r.code} ${r.message}`);
        return;
      }
      setNotice(r.data.message ?? `${pluginId} 已完成`);
      // 改了核心数据才需要惊动 App；纯插件内写入靠 tick 重渲染就够
      if (r.data.coreOpsApplied > 0) onDataChanged?.();
      else setTick((t) => t + 1);
    })
    .catch((e: unknown) => {
      setNotice(`${pluginId} 操作异常：${e instanceof Error ? e.message : String(e)}`);
    });
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
 * 取控件要的数据 —— 实现在 `record-selection.ts`。
 *
 * 搬出去的原因：这里 `import React`，而那段逻辑是最该被 Node 测试直接跑的。
 * 放一起的话测试会被拖进 React 与 vite 的解析规则。
 */
export { recordsFor };
