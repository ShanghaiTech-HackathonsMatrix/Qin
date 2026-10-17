/**
 * UiNode → React。
 *
 * ## 为什么用 `createElement` 而不是 JSX
 *
 * 这个文件是 `.ts` 而不是 `.tsx`，因为 Node 24 的类型擦除**不转 JSX**。
 * 写成 `createElement` 之后，整个渲染器能在 Node 里直接跑、直接断言 ——
 * 不需要 jsdom、不需要浏览器、不需要打包。U6 的「纯 Node 测 UI」就是靠这个成立的。
 *
 * ## 这个文件唯一的职责
 *
 * 把**已经校验过**的 `UiNode` 树映射成 DOM。它不做校验（那是 `parseUiNode` 的事），
 * 不做布局计算，不做数据获取 —— 拿到的树就是它要画的全部。
 *
 * 未知节点类型返回 `null` 而不是抛异常：校验层已经挡住了，走到这里说明是我们自己的
 * bug，不该让整个界面白屏。
 */

import { createElement, type ReactElement } from 'react';

import type { Action, Gap, IconName, Tone, UiNode } from '@matrix/plugin-api';

/** 语义色 → CSS 变量。插件拿到的是**语义**，具体色值由主题决定 */
const TONE_COLOR: Record<Tone, string> = {
  normal: 'var(--fg)',
  faint: 'var(--fg-faint)',
  accent: 'var(--accent)',
  danger: 'var(--bad)',
  success: 'var(--ok)',
  warning: 'var(--warn)',
};

/** 间距档位 → 实际值。**不暴露裸数值**，否则插件就能绕过设计系统 */
const GAP_SIZE: Record<Gap, string> = {
  none: '0',
  sm: 'calc(var(--gap) * 0.5)',
  md: 'var(--gap)',
  lg: 'calc(var(--gap) * 1.7)',
};

const TEXT_SIZE: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'var(--fs-sm)',
  md: 'var(--fs)',
  lg: 'calc(var(--fs) * 1.25)',
};

const ALIGN: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
};

/**
 * 核心图标集。**不是**图片 URL —— 插件零网络（D2），所以图标只能从这里挑。
 * 24×24、`stroke="currentColor"`，跟着 `color` 走，自动适配主题。
 */
const ICON_PATHS: Record<IconName, string> = {
  calendar: 'M3 9h18M7 3v4M17 3v4M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z',
  clock: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2',
  check: 'M4 12l5 5L20 6',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
  book: 'M4 5a2 2 0 012-2h12v18H6a2 2 0 01-2-2V5zM8 3v18',
  warning: 'M12 3l9 16H3L12 3zM12 9v5M12 17h.01',
};

export interface UiViewProps {
  node: UiNode;
  /** 唯一的输入出口。渲染器不解释 Action，只往外递 */
  onAction: (action: Action) => void;
}

/** 递归渲染一棵 UI 树 */
export function UiNodeView({ node, onAction }: UiViewProps): ReactElement | null {
  switch (node.type) {
    case 'divider':
      return createElement('div', { className: 'ui-divider' });

    case 'stack':
      return createElement(
        'div',
        {
          className: 'ui-stack',
          style: {
            flexDirection: node.direction === 'row' ? 'row' : 'column',
            gap: GAP_SIZE[node.gap ?? 'md'],
            alignItems: ALIGN[node.align ?? 'stretch'],
            flexWrap: node.wrap === true ? 'wrap' : 'nowrap',
          },
        },
        ...node.children.map((child, i) =>
          createElement(UiNodeView, { key: i, node: child, onAction }),
        ),
      );

    case 'card':
      return createElement(
        'div',
        {
          className: 'ui-card',
          ...(node.tone !== undefined
            ? { style: { borderColor: TONE_COLOR[node.tone] } }
            : {}),
        },
        ...(node.title !== undefined
          ? [createElement('div', { key: 't', className: 'ui-card__title' }, node.title)]
          : []),
        ...node.children.map((child, i) =>
          createElement(UiNodeView, { key: `c${i}`, node: child, onAction }),
        ),
      );

    case 'text':
      return createElement(
        'div',
        {
          className: 'ui-text',
          style: {
            color: TONE_COLOR[node.tone ?? 'normal'],
            fontSize: TEXT_SIZE[node.size ?? 'md'],
            fontWeight: node.weight === 'bold' ? 650 : 400,
          },
        },
        node.text,
      );

    case 'button':
      return createElement(
        'button',
        {
          className: 'ui-btn',
          type: 'button',
          disabled: node.disabled === true,
          ...(node.tone !== undefined ? { style: { color: TONE_COLOR[node.tone] } } : {}),
          onClick: () => onAction(node.onPress),
        },
        ...(node.icon !== undefined ? [createElement(Icon, { key: 'i', name: node.icon })] : []),
        createElement('span', { key: 'l' }, node.label),
      );

    case 'list':
      if (node.items.length === 0 && node.empty !== undefined) {
        return createElement(UiNodeView, { node: node.empty, onAction });
      }
      return createElement(
        'div',
        { className: 'ui-list' },
        ...node.items.map((child, i) =>
          createElement(UiNodeView, { key: i, node: child, onAction }),
        ),
      );

    case 'badge':
      return createElement(
        'span',
        {
          className: 'ui-badge',
          style: {
            color: TONE_COLOR[node.tone ?? 'normal'],
            borderColor: TONE_COLOR[node.tone ?? 'normal'],
          },
        },
        node.text,
      );

    case 'empty':
      return createElement(
        'div',
        { className: 'ui-empty' },
        createElement('div', { className: 'ui-empty__text' }, node.text),
        ...(node.action !== undefined
          ? [
              createElement(
                'button',
                {
                  key: 'a',
                  className: 'ui-btn',
                  type: 'button',
                  onClick: () => onAction(node.action!.onPress),
                },
                node.action.label,
              ),
            ]
          : []),
      );

    default:
      // 类型上不可达。真走到了说明 UI_NODE_TYPES 与这个 switch 漂移了 ——
      // 静默画空，别让整个界面白屏。
      return null;
  }
}

/** 单个图标。`aria-hidden` 是刻意的：按钮的可读文案在 `<span>` 里 */
function Icon({ name }: { name: IconName }): ReactElement {
  return createElement(
    'svg',
    {
      className: 'ui-icon',
      viewBox: '0 0 24 24',
      width: 16,
      height: 16,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    createElement('path', { d: ICON_PATHS[name] }),
  );
}
