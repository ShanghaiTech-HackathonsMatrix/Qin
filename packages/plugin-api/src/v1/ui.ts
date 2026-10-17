/**
 * 控件（UI）契约 —— v1。
 *
 * ## 一句话
 *
 * 插件**不持有 UI**，它产出一棵 `UiNode` 树；宿主把树渲染成 DOM。
 * 输入**不回调插件**，输入变成 `Action`，由宿主路由。
 *
 * 整条环是单向的：
 *
 *     数据 → render(纯函数) → UiNode → 宿主渲染 → 用户操作
 *          → Action → 宿主路由 → 改数据 → 重新 render
 *
 * ## 为什么 UI 是数据而不是代码
 *
 * 1. **D8**：插件是纯函数，没有异步宿主 API，也不持有状态。一个「处理点击」的
 *    React 组件必须有回调；有回调就得有活的插件对象 —— 那就把 D8 拆了。
 * 2. **沙箱**：将来第三方插件跑在 QuickJS / iframe 里，React 组件跨不过去，
 *    JSON 树天然可以。现在写回调，等沙箱落地时整个 UI 层要重写。
 * 3. **可测**：`render()` 是纯函数，断言输出树就行 —— 不需要 jsdom，也不需要浏览器。
 *
 * ## 自由度：组合几乎不限，积木和样式受限
 *
 * 原语是**封闭集**（见 `UI_NODE_TYPES`）。插件能任意嵌套组合，但：
 *   · 不能写任意 CSS —— 颜色只能从 `TONES` 里选，间距只能从 `GAPS` 里选
 *   · 不能引用网络图片 —— 插件零网络（D2）；图标只能从 `ICON_NAMES` 里选
 *   · 不能发明新原语 —— 要新原语就是改核心
 *
 * 这个取舍是有意的，换来三件事：插件 UI 一定长得像 Matrix、沙箱里能跑、Node 里能测。
 * 开放任意样式会立刻把这三样全丢掉。
 *
 * ## 本模块是纯函数
 *
 * 不碰 DOM、不碰 React、不碰 Node API —— 与 `@matrix/plugin-api` 其余部分一致。
 */

import { validateCommandInput } from './command.ts';
import { fail, ok, type PluginResult } from './errors.ts';

// ------------------------------------------------------------ 枚举

/** 原语清单。**封闭集** —— 不在表里的 type 一律 `ESCHEMA` */
export const UI_NODE_TYPES = [
  'stack',
  'card',
  'text',
  'button',
  'list',
  'badge',
  'empty',
  'divider',
] as const;
export type UiNodeType = (typeof UI_NODE_TYPES)[number];

/** 语义色。**不是**颜色值 —— 具体色由主题决定，插件拿不到任意 CSS */
export const TONES = ['normal', 'faint', 'accent', 'danger', 'success', 'warning'] as const;
export type Tone = (typeof TONES)[number];

/** 核心提供的图标名。**不是**图片 URL —— 插件零网络（D2） */
export const ICON_NAMES = [
  'calendar',
  'clock',
  'check',
  'close',
  'plus',
  'search',
  'book',
  'warning',
] as const;
export type IconName = (typeof ICON_NAMES)[number];

export const GAPS = ['none', 'sm', 'md', 'lg'] as const;
export type Gap = (typeof GAPS)[number];

export const TEXT_SIZES = ['sm', 'md', 'lg'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

export const STACK_ALIGNS = ['start', 'center', 'end', 'stretch'] as const;
export type StackAlign = (typeof STACK_ALIGNS)[number];

// ------------------------------------------------------------ 输入

/**
 * 用户操作。**这是控件唯一的输出通道。**
 *
 * `setUi` 的值刻意只允许 JSON 标量：瞬时 UI 状态要保持可序列化，
 * 这样将来把它存进布局文档 / 跨 iframe 传递都不需要改协议。
 *
 * ⚠️ **v1 没有「任意命令」通道。** 曾经想放一个 `{ kind: 'command', id }`，
 * 但宿主端没有任何执行入口 —— 那会是一个点了没反应的假开关。所以只留三种
 * **真的有实现**的动作。等 `contributes.commands` 有了执行通道再加，那时是纯加法。
 */
export type Action =
  | { kind: 'navigate'; to: string }
  | { kind: 'setUi'; key: string; value: string | number | boolean | null }
  /** 让宿主对该插件跑一次同步。**走的是现有的 broker，不是新通道** */
  | { kind: 'sync'; settings?: Record<string, string> }
  /**
   * 调插件自己声明过的命令（`contributes.commands`）。
   *
   * 这是**唯一**能改变数据的一档，但它本身不改数据：
   * 宿主找到 `PluginExports.commands[id]`，跑那个纯函数，拿到「要改什么」，
   * 校验完再自己动手（见 `command.ts`）。
   *
   * `id` 必须是插件在 manifest 里声明过的命令；没声明 → 宿主拒掉。
   */
  | { kind: 'command'; id: string; input?: Record<string, string | number | boolean> };

// ------------------------------------------------------------ 节点

/** UI 树。`children` / `items` 可以任意嵌套，但受 `UI_LIMITS` 限制 */
export type UiNode =
  | {
      type: 'stack';
      direction?: 'row' | 'column';
      gap?: Gap;
      align?: StackAlign;
      wrap?: boolean;
      children: UiNode[];
    }
  | { type: 'card'; title?: string; tone?: Tone; children: UiNode[] }
  | { type: 'text'; text: string; tone?: Tone; size?: TextSize; weight?: 'normal' | 'bold' }
  | { type: 'button'; label: string; onPress: Action; tone?: Tone; icon?: IconName; disabled?: boolean }
  | { type: 'list'; items: UiNode[]; empty?: UiNode }
  | { type: 'badge'; text: string; tone?: Tone }
  | { type: 'empty'; text: string; action?: { label: string; onPress: Action } }
  | { type: 'divider' };

// ------------------------------------------------------------ 视图声明

/**
 * manifest `contributes.views` 的一项 —— **纯数据，可校验、可序列化**。
 *
 * 目录（有哪些视图可用）由 manifest 派生，**不落盘**：manifest 已经是注册动作，
 * 再存一份 KV 注册表就是第二个真相源，两份必然漂移。
 *
 * 落盘的是**布局**（`LayoutDoc`：这页摆哪几个实例、什么参数），那是用户的真相。
 */
export interface ViewContribution {
  /** 插件内唯一。建议 kebab-case */
  id: string;
  title: string;
  /** `page` 占一整屏；`widget` 嵌进布局的一个格子 */
  kind: 'page' | 'widget';
  /**
   * 这个视图要读哪些实体类型。宿主按它取数据后填进 `ViewContext.records`。
   *
   * **不会放宽插件自己的 `permissions.data.read`** —— 这里多写只会读到空数组。
   */
  requires?: readonly string[];
  /** 布局里没配 props 时用的默认值 */
  defaultProps?: Readonly<Record<string, unknown>>;
  /** 布局里的默认格子大小（单位：栅格） */
  defaultSize?: { readonly w: number; readonly h: number };
}

/** 宿主交给视图的一条实体（只读投影）。与内核的 `EntityRecord` 结构兼容 */
export interface ViewRecord {
  readonly type: string;
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly updatedAt: number;
}

/** 瞬时 UI 状态。只允许 JSON 标量，理由同 `Action.setUi` */
export type UiState = Readonly<Record<string, string | number | boolean | null>>;

/** `render()` 的全部输入 —— 视图**不该**有任何其他信息来源 */
export interface ViewContext {
  /** 布局里的实例 id。同一个视图被摆两次也不会串状态 */
  readonly instanceId: string;
  /** 布局里配的参数（已与 `defaultProps` 合并） */
  readonly props: Readonly<Record<string, unknown>>;
  /** 宿主按 `requires` 取好的实体。没数据就是空数组，不是 undefined */
  readonly records: readonly ViewRecord[];
  /** 这个实例的瞬时状态（由 `setUi` 写入） */
  readonly ui: UiState;
  readonly locale: string;
  /** 宿主能力清单。插件可以据此决定要不要渲染某个高级控件 */
  readonly capabilities: readonly string[];
  /** 宿主时间。插件没有自己的时钟（与 `PlanInput.now` 同源） */
  readonly now: number;
}

/**
 * 视图渲染函数。
 *
 * **必须同步、纯**：同样的 `ctx` 必须得到同样的树，不得读全局变量、不得缓存、
 * 不得有任何 IO（插件本来也拿不到 IO）。宿主可能在任何一次重渲染时调它。
 */
export type ViewRender = (ctx: ViewContext) => UiNode;

// ------------------------------------------------------------ 解析（安全边界）

export const UI_LIMITS = {
  maxNodes: 2000,
  maxDepth: 24,
  maxTextLength: 8000,
} as const;

export interface UiLimits {
  maxNodes: number;
  maxDepth: number;
  maxTextLength: number;
}

/**
 * 校验并**重建**一棵 UI 树。
 *
 * 这不是「检查一下」，是**安全边界**：插件产出的是不可信输入，宿主拿到的必须
 * 是重建出来的、只有已知字段的新对象。理由：
 *   · 原样透传会把插件塞的任意字段带进 React（原型污染、意外属性）
 *   · 节点数/深度不设上限，一个 `while` 循环就能把界面卡死
 *
 * 返回的树与输入**不共享任何对象**。
 */
export function parseUiNode(
  raw: unknown,
  limits: UiLimits = UI_LIMITS,
): PluginResult<UiNode> {
  return walk(raw, 0, limits, { nodes: 0 });
}

interface Budget {
  nodes: number;
}

function walk(raw: unknown, depth: number, limits: UiLimits, budget: Budget): PluginResult<UiNode> {
  if (depth > limits.maxDepth) {
    return fail('ESCHEMA', `UiNode 嵌套超过 ${limits.maxDepth} 层`);
  }
  budget.nodes += 1;
  if (budget.nodes > limits.maxNodes) {
    return fail('ESCHEMA', `UiNode 节点数超过 ${limits.maxNodes}`);
  }
  if (!isPlainObject(raw)) return fail('ESCHEMA', 'UiNode 必须是对象');

  const type = raw.type;
  if (typeof type !== 'string' || !(UI_NODE_TYPES as readonly string[]).includes(type)) {
    return fail('ESCHEMA', `未知的 UiNode 类型："${String(type)}"（原语是封闭集，见 UI_NODE_TYPES）`);
  }

  switch (type) {
    case 'divider':
      return ok({ type: 'divider' });

    case 'stack': {
      const children = walkList(raw.children, depth, limits, budget, 'children');
      if (!children.ok) return children;
      const direction = raw.direction;
      if (direction !== undefined && direction !== 'row' && direction !== 'column') {
        return fail('ESCHEMA', `stack.direction 只能是 row / column，实际 "${String(direction)}"`);
      }
      const align = pick(raw.align, STACK_ALIGNS, 'stack.align');
      if (!align.ok) return align;
      const gap = pick(raw.gap, GAPS, 'stack.gap');
      if (!gap.ok) return gap;
      return ok({
        type: 'stack',
        ...(direction !== undefined ? { direction } : {}),
        ...(gap.data !== undefined ? { gap: gap.data } : {}),
        ...(align.data !== undefined ? { align: align.data } : {}),
        ...(typeof raw.wrap === 'boolean' ? { wrap: raw.wrap } : {}),
        children: children.data,
      });
    }

    case 'card': {
      const children = walkList(raw.children, depth, limits, budget, 'children');
      if (!children.ok) return children;
      const tone = pick(raw.tone, TONES, 'card.tone');
      if (!tone.ok) return tone;
      const title = text(raw.title, limits, 'card.title', { optional: true });
      if (!title.ok) return title;
      return ok({
        type: 'card',
        ...(title.data !== undefined ? { title: title.data } : {}),
        ...(tone.data !== undefined ? { tone: tone.data } : {}),
        children: children.data,
      });
    }

    case 'text': {
      const t = text(raw.text, limits, 'text.text');
      if (!t.ok) return t;
      const tone = pick(raw.tone, TONES, 'text.tone');
      if (!tone.ok) return tone;
      const size = pick(raw.size, TEXT_SIZES, 'text.size');
      if (!size.ok) return size;
      const weight = raw.weight;
      if (weight !== undefined && weight !== 'normal' && weight !== 'bold') {
        return fail('ESCHEMA', `text.weight 只能是 normal / bold，实际 "${String(weight)}"`);
      }
      return ok({
        type: 'text',
        text: t.data!,
        ...(tone.data !== undefined ? { tone: tone.data } : {}),
        ...(size.data !== undefined ? { size: size.data } : {}),
        ...(weight !== undefined ? { weight } : {}),
      });
    }

    case 'button': {
      const label = text(raw.label, limits, 'button.label');
      if (!label.ok) return label;
      const action = parseAction(raw.onPress, 'button.onPress');
      if (!action.ok) return action;
      const tone = pick(raw.tone, TONES, 'button.tone');
      if (!tone.ok) return tone;
      const icon = pick(raw.icon, ICON_NAMES, 'button.icon');
      if (!icon.ok) return icon;
      return ok({
        type: 'button',
        label: label.data!,
        onPress: action.data!,
        ...(tone.data !== undefined ? { tone: tone.data } : {}),
        ...(icon.data !== undefined ? { icon: icon.data } : {}),
        ...(typeof raw.disabled === 'boolean' ? { disabled: raw.disabled } : {}),
      });
    }

    case 'list': {
      const items = walkList(raw.items, depth, limits, budget, 'items');
      if (!items.ok) return items;
      let emptyNode: UiNode | undefined;
      if (raw.empty !== undefined) {
        const e = walk(raw.empty, depth + 1, limits, budget);
        if (!e.ok) return e;
        emptyNode = e.data;
      }
      return ok({
        type: 'list',
        items: items.data,
        ...(emptyNode !== undefined ? { empty: emptyNode } : {}),
      });
    }

    case 'badge': {
      const t = text(raw.text, limits, 'badge.text');
      if (!t.ok) return t;
      const tone = pick(raw.tone, TONES, 'badge.tone');
      if (!tone.ok) return tone;
      return ok({
        type: 'badge',
        text: t.data!,
        ...(tone.data !== undefined ? { tone: tone.data } : {}),
      });
    }

    case 'empty': {
      const t = text(raw.text, limits, 'empty.text');
      if (!t.ok) return t;
      let action: { label: string; onPress: Action } | undefined;
      if (raw.action !== undefined) {
        if (!isPlainObject(raw.action)) return fail('ESCHEMA', 'empty.action 必须是对象');
        const label = text(raw.action.label, limits, 'empty.action.label');
        if (!label.ok) return label;
        const a = parseAction(raw.action.onPress, 'empty.action.onPress');
        if (!a.ok) return a;
        action = { label: label.data!, onPress: a.data! };
      }
      return ok({
        type: 'empty',
        text: t.data!,
        ...(action !== undefined ? { action } : {}),
      });
    }

    default:
      // 上面已经把 type 收窄到 UiNodeType，走到这里是类型系统在提醒漏了一个分支
      return fail('ESCHEMA', `未处理的 UiNode 类型：${String(type)}`);
  }
}

function walkList(
  raw: unknown,
  depth: number,
  limits: UiLimits,
  budget: Budget,
  field: string,
): PluginResult<UiNode[]> {
  if (!Array.isArray(raw)) return fail('ESCHEMA', `${field} 必须是数组`);
  const out: UiNode[] = [];
  for (const item of raw) {
    const r = walk(item, depth + 1, limits, budget);
    if (!r.ok) return r;
    out.push(r.data);
  }
  return ok(out);
}

/** 校验并重建一个 `Action` */
export function parseAction(raw: unknown, at = 'action'): PluginResult<Action> {
  if (!isPlainObject(raw)) return fail('ESCHEMA', `${at} 必须是对象`);
  const kind = raw.kind;

  if (kind === 'navigate') {
    const to = raw.to;
    if (typeof to !== 'string' || to === '') {
      return fail('ESCHEMA', `${at}.to 必须是非空字符串`);
    }
    return ok({ kind: 'navigate', to });
  }

  if (kind === 'setUi') {
    const key = raw.key;
    if (typeof key !== 'string' || key === '') {
      return fail('ESCHEMA', `${at}.key 必须是非空字符串`);
    }
    const v = raw.value;
    const okScalar =
      v === null || typeof v === 'string' || typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v));
    if (!okScalar) {
      return fail('ESCHEMA', `${at}.value 只能是字符串 / 数字 / 布尔 / null（UI 状态要可序列化）`);
    }
    return ok({ kind: 'setUi', key, value: v as string | number | boolean | null });
  }

  if (kind === 'sync') {
    if (raw.settings !== undefined) {
      if (!isPlainObject(raw.settings)) {
        return fail('ESCHEMA', `${at}.settings 必须是字符串到字符串的映射`);
      }
      for (const [k, v] of Object.entries(raw.settings)) {
        if (typeof v !== 'string') {
          return fail('ESCHEMA', `${at}.settings.${k} 必须是字符串`);
        }
      }
      return ok({ kind: 'sync', settings: raw.settings as Record<string, string> });
    }
    return ok({ kind: 'sync' });
  }

  if (kind === 'command') {
    const id = raw.id;
    if (typeof id !== 'string' || id === '') {
      return fail('ESCHEMA', `${at}.id 必须是非空字符串`);
    }
    const input = validateCommandInput(raw.input, `${at}.input`);
    if (!input.ok) return fail('ESCHEMA', input.reason);
    return ok(
      Object.keys(input.value).length === 0
        ? { kind: 'command', id }
        : { kind: 'command', id, input: { ...input.value } },
    );
  }

  return fail(
    'ESCHEMA',
    `${at}.kind 只能是 navigate / setUi / sync / command，实际 "${String(kind)}"`,
  );
}

// ------------------------------------------------------------ 小工具

const VIEW_ID_RE = /^[a-z][a-z0-9_-]*$/;

/** 供 `manifest.ts` 的 `validateContributes` 使用 */
export function validateViewContribution(
  raw: unknown,
  at: string,
  add: (path: string, message: string) => void,
  seen: Set<string>,
): void {
  if (!isPlainObject(raw)) {
    add(at, '每一项必须是 { id, title, kind } 对象');
    return;
  }
  const id = raw.id;
  if (typeof id !== 'string' || !VIEW_ID_RE.test(id)) {
    add(`${at}.id`, `视图 id 必须是 kebab-case 标识符（小写字母开头，可含数字 / _ / -）："${String(id)}"`);
  } else if (seen.has(id)) {
    add(`${at}.id`, `视图 id 重复：${id}`);
  } else {
    seen.add(id);
  }

  if (typeof raw.title !== 'string' || raw.title === '') {
    add(`${at}.title`, 'title 必须是非空字符串');
  }
  if (raw.kind !== 'page' && raw.kind !== 'widget') {
    add(`${at}.kind`, 'kind 只能是 page / widget');
  }
  if (raw.requires !== undefined && !isStringArray(raw.requires)) {
    add(`${at}.requires`, 'requires 必须是字符串数组（实体类型名）');
  }
  if (raw.defaultProps !== undefined && !isPlainObject(raw.defaultProps)) {
    add(`${at}.defaultProps`, 'defaultProps 必须是对象');
  }
  if (raw.defaultSize !== undefined) {
    const ds = raw.defaultSize;
    if (!isPlainObject(ds)) {
      add(`${at}.defaultSize`, 'defaultSize 必须是 { w, h } 对象');
    } else {
      for (const k of ['w', 'h'] as const) {
        const v = ds[k];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 12) {
          add(`${at}.defaultSize.${k}`, `${k} 必须是 1..12 的整数`);
        }
      }
    }
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** 可选枚举：`undefined` 通过，非法值报错 */
function pick<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  at: string,
): PluginResult<T | undefined> {
  if (raw === undefined) return ok(undefined);
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    return fail('ESCHEMA', `${at} 只能是 ${allowed.join(' / ')} 之一，实际 "${String(raw)}"`);
  }
  return ok(raw as T);
}

function text(
  raw: unknown,
  limits: UiLimits,
  at: string,
  opts: { optional?: boolean } = {},
): PluginResult<string | undefined> {
  if (raw === undefined && opts.optional === true) return ok(undefined);
  if (typeof raw !== 'string') return fail('ESCHEMA', `${at} 必须是字符串`);
  if (raw.length > limits.maxTextLength) {
    return fail('ESCHEMA', `${at} 超过 ${limits.maxTextLength} 字符（实际 ${raw.length}）`);
  }
  return ok(raw);
}
