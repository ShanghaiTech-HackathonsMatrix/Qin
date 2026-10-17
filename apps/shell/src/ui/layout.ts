/**
 * 布局文档 —— 用户「这一页摆哪几个控件」的真相。
 *
 * ## 为什么布局落盘、目录不落盘
 *
 * - **目录**（有哪些控件可用）= 从已装 manifest 的 `contributes.views` 派生。
 *   它是 manifest 的函数，存一份到 KV 就是第二个真相源，两份必然漂移。
 * - **布局**（这页摆哪几个实例、什么参数、多大格子）= 用户的意图，**只能**存在数据里。
 *
 * 这就是 `manifest.ts` 顶部那句「两份并存必然漂移，所以现在只留一份」的具体应用。
 *
 * ## 未知的实例怎么处理
 *
 * 插件被卸载后，它的控件实例会留在布局里。**不要在解析时删掉** ——
 * 用户重装插件后应该恢复原来的摆放。所以这里只校验**形状**，
 * 渲染时再按目录把找不到的实例画成占位（见 `WidgetPage`）。
 */

import { fail, ok, type PluginResult } from '@matrix/plugin-api';

import type { SecureStore } from '../platform/strategies/kv/types';

export const LAYOUT_VERSION = 1;

export const LAYOUT_LIMITS = {
  maxWidgets: 40,
  maxGrid: 12,
} as const;

/** 一个控件实例。同一个 viewId 可以出现多次，靠 instanceId 区分 */
export interface LayoutWidget {
  /** 布局内唯一。也是瞬时 UI 状态的键 */
  instanceId: string;
  pluginId: string;
  viewId: string;
  props: Record<string, unknown>;
  grid: { w: number; h: number };
}

export interface LayoutDoc {
  version: number;
  widgets: LayoutWidget[];
}

const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

export function defaultLayout(): LayoutDoc {
  return { version: LAYOUT_VERSION, widgets: [] };
}

/**
 * 校验并重建一份布局。
 *
 * 与 `parseUiNode` 同样走「重建而不是透传」：布局也是可能被手改 / 被旧版本写坏的
 * 不可信输入，透传会把未知字段带进渲染层。
 */
export function parseLayout(raw: unknown): PluginResult<LayoutDoc> {
  if (!isPlainObject(raw)) return fail('ESCHEMA', '布局必须是对象');
  if (raw.version !== LAYOUT_VERSION) {
    return fail('ESCHEMA', `布局版本不支持：${String(raw.version)}（当前只认 ${LAYOUT_VERSION}）`);
  }
  if (!Array.isArray(raw.widgets)) return fail('ESCHEMA', '布局 widgets 必须是数组');
  if (raw.widgets.length > LAYOUT_LIMITS.maxWidgets) {
    return fail('ESCHEMA', `控件实例超过 ${LAYOUT_LIMITS.maxWidgets} 个`);
  }

  const seen = new Set<string>();
  const widgets: LayoutWidget[] = [];

  for (const [i, w] of raw.widgets.entries()) {
    const at = `widgets[${i}]`;
    if (!isPlainObject(w)) return fail('ESCHEMA', `${at} 必须是对象`);

    const instanceId = w.instanceId;
    if (typeof instanceId !== 'string' || !INSTANCE_ID_RE.test(instanceId)) {
      return fail('ESCHEMA', `${at}.instanceId 必须是 kebab-case 标识符："${String(instanceId)}"`);
    }
    if (seen.has(instanceId)) return fail('ESCHEMA', `${at}.instanceId 重复：${instanceId}`);
    seen.add(instanceId);

    if (typeof w.pluginId !== 'string' || w.pluginId === '') {
      return fail('ESCHEMA', `${at}.pluginId 必须是非空字符串`);
    }
    if (typeof w.viewId !== 'string' || w.viewId === '') {
      return fail('ESCHEMA', `${at}.viewId 必须是非空字符串`);
    }

    const props = w.props === undefined ? {} : w.props;
    if (!isPlainObject(props)) return fail('ESCHEMA', `${at}.props 必须是对象`);

    const grid = w.grid === undefined ? { w: 12, h: 1 } : w.grid;
    if (!isPlainObject(grid)) return fail('ESCHEMA', `${at}.grid 必须是 { w, h } 对象`);
    for (const k of ['w', 'h'] as const) {
      const v = grid[k];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > LAYOUT_LIMITS.maxGrid) {
        return fail('ESCHEMA', `${at}.grid.${k} 必须是 1..${LAYOUT_LIMITS.maxGrid} 的整数`);
      }
    }

    widgets.push({
      instanceId,
      pluginId: w.pluginId,
      viewId: w.viewId,
      props: { ...props },
      grid: { w: grid.w as number, h: grid.h as number },
    });
  }

  return ok({ version: LAYOUT_VERSION, widgets });
}

/**
 * 布局的持久化。一个 profile 一个键：`layout.<profileId>`。
 *
 * `load()` **永不抛异常** —— 布局坏了不该让应用起不来，退回默认布局并把原因带出去，
 * 由调用方决定要不要提示用户。
 */
export class LayoutStore {
  private readonly kv: SecureStore;
  private readonly profileId: string;

  constructor(kv: SecureStore, profileId = 'default') {
    this.kv = kv;
    this.profileId = profileId;
  }

  get key(): string {
    return `layout.${this.profileId}`;
  }

  async load(): Promise<{ doc: LayoutDoc; issue: string | null }> {
    const raw = await this.kv.get(this.key).catch(() => null);
    if (raw === null) return { doc: defaultLayout(), issue: null };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 坏数据留证，别静默覆盖 —— 用户手改过的话，那是他唯一的一份
      await this.kv.set(`${this.key}.corrupt.${Date.now()}`, raw).catch(() => undefined);
      return { doc: defaultLayout(), issue: '布局不是合法 JSON，已退回默认布局（原内容已备份）' };
    }

    const v = parseLayout(parsed);
    if (!v.ok) {
      await this.kv.set(`${this.key}.corrupt.${Date.now()}`, raw).catch(() => undefined);
      return { doc: defaultLayout(), issue: `布局校验失败：${v.message}（已退回默认布局）` };
    }
    return { doc: v.data, issue: null };
  }

  async save(doc: LayoutDoc): Promise<PluginResult<void>> {
    const v = parseLayout(doc);
    if (!v.ok) return v;
    try {
      await this.kv.set(this.key, JSON.stringify(v.data));
      return ok(undefined);
    } catch (e) {
      return fail('EINTERNAL', `布局保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async reset(): Promise<void> {
    await this.kv.remove(this.key).catch(() => undefined);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
