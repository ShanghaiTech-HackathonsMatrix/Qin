/**
 * 槽（Slot）解析器 —— 宿主侧把「声明」变成「一条条槽数据」的地方。
 *
 * ```
 *   定义方 manifest.slots[]            → 目录：有哪些槽、条目长什么样
 *   使用方 manifest.consumesSlots[]    → 谁往哪个槽写、从哪种实体映射
 *   使用方 permissions.ui.slots[]      → 用户批准它写哪些槽
 *                       ↓
 *                  宿主（本文件）
 *                       ↓
 *   槽条目录入 DataBus，命名空间 = 定义方
 * ```
 *
 * ## 关键：槽数据存在「定义方」的命名空间下
 *
 * 这样定义方（Timeline）读自己的槽就是读自己的表，天然没有串味问题；
 * 而使用方写得进去，靠的是本文件在写之前**显式授权**（见 `writeSlot`）。
 *
 * ## 孤儿槽
 *
 * 定义方被卸载后，它的槽就没人定义了。此时：
 * - **数据保留**（`keepData` 语义与本项目其他地方一致：不替用户删数据）
 * - 但不再接受新的写入 —— 没有 schema 的槽没法校验
 * - 定义方重装后，数据自动又有了主人
 */

import {
  buildSlotEntry as buildEntry,
  fail,
  ok,
  SLOT_NAME_RE,
  type PluginResult,
  type SlotConsumption,
  type SlotDefinition,
  type SlotEntry,
  type SlotValidator,
} from '@matrix/plugin-api';

import type { EntityRecord, PluginRegistry } from '@matrix/kernel';

/** 一个已定义且定义方仍在的槽 */
export interface ResolvedSlot {
  name: string;
  /** 定义方 pluginId */
  owner: string;
  definition: SlotDefinition;
  /** 定义方注册的跨字段校验钩子（可选） */
  validator: SlotValidator | undefined;
}

export interface SlotWriteResult {
  written: number;
  /** 被跳过的条目及原因（缺必填字段、where 不匹配……）。不是错误，只是没写进去 */
  skipped: Array<{ ref: string; reason: string }>;
}

/**
 * 从注册表里收集当前所有槽。
 *
 * 每次要读的时候现算，不做缓存 —— 插件增多后这里仍然是几十次数组遍历，
 * 而缓存会引入「装了插件但槽没刷新」这类难查的问题。
 */
export function collectSlots(
  registry: PluginRegistry,
  validators?: ReadonlyMap<string, SlotValidator>,
): Map<string, ResolvedSlot> {
  const out = new Map<string, ResolvedSlot>();

  for (const rec of registry.list()) {
    // `uninstall()` 只把状态改成 `uninstalled`，记录本身还留着。
    // 已卸载的插件**不再定义槽** —— 否则「孤儿槽」这个状态根本不会出现。
    if (rec.state === 'uninstalled') continue;

    const defs = rec.manifest.contributes?.slots ?? [];
    for (const definition of defs) {
      const existing = out.get(definition.name);
      if (existing) {
        // 两个插件定义了同名槽 → 先到的那个赢，并留痕（`registry` 那边会记审计）
        continue;
      }
      out.set(definition.name, {
        name: definition.name,
        owner: rec.manifest.id,
        definition,
        validator: validators?.get(definition.name),
      });
    }
  }
  return out;
}

/**
 * 槽名是否属于某个插件的命名空间。
 *
 * 规则：槽名必须以 `<pluginId 的第一段>.<第二段>` 开头。
 * 例如 `app.matrix.timeline` 只能定义 `app.matrix.*` 开头的槽。
 *
 * 这是**防顶替**：不然一个坏插件可以声明 `app.matrix.timeline.event`，
 * 抢走 Timeline 的槽，然后把内容换成假的。
 */
export function ownsSlotNamespace(pluginId: string, slotName: string): boolean {
  if (!SLOT_NAME_RE.test(slotName)) return false;
  const parts = pluginId.split('.');
  const prefix = parts.slice(0, 2).join('.');
  return slotName === prefix || slotName.startsWith(`${prefix}.`);
}

/**
 * 把一个使用方的源实体映射成槽条目并写入。
 *
 * 调用方（`PluginHost`）负责在**同步之后**调它一次。
 *
 * 权限：使用方必须在 `permissions.ui.slots` 里被授予了这个槽名。
 * 这是刻意的第二道 —— `contributes.consumesSlots` 是「我想写」，
 * `permissions.ui.slots` 才是「用户批准了」。
 */
export function writeSlot(params: {
  pluginId: string;
  consumption: SlotConsumption;
  slot: ResolvedSlot;
  grantedSlots: ReadonlySet<string>;
  /** 使用方自己命名空间下的源实体 */
  sources: readonly EntityRecord[];
  /** 写一条槽条目：由调用方决定落到哪里（DataBus 的 `owner` 命名空间） */
  put: (entry: SlotEntry) => PluginResult<unknown>;
  /** 清掉该使用方先前写进这个槽的全部条目（再整体重写，保证删除也能同步） */
  clearConsumer: () => void;
}): PluginResult<SlotWriteResult> {
  const { pluginId, consumption, slot, grantedSlots, sources } = params;

  if (!grantedSlots.has(consumption.slot)) {
    return fail(
      'EPERM',
      `未在 permissions.ui.slots 中声明槽: ${consumption.slot}`,
      { slot: consumption.slot },
    );
  }

  // 每次同步**整体重写**：不做增删差分，因为源实体可能被删、字段可能变。
  // 代价是每次同步都重写这个槽的全部条目（几百条量级，可以接受）。
  params.clearConsumer();

  const def = slot.definition;
  const max = def.maxItems ?? 200;
  let written = 0;
  const skipped: Array<{ ref: string; reason: string }> = [];

  for (const rec of sources) {
    if (written >= max) break;

    const built = buildEntry(def, consumption, rec.data);
    if (!built.ok) {
      skipped.push({ ref: rec.id, reason: built.reason });
      continue;
    }

    // 定义方的跨字段钩子 —— 就是 CheckEvent()
    if (slot.validator) {
      const v = slot.validator(built.data);
      if (!v.ok) {
        skipped.push({ ref: rec.id, reason: v.reason });
        continue;
      }
    }

    const r = params.put({ data: built.data, source: pluginId, from: consumption.from, ref: rec.id });
    if (!r.ok) return r;
    written += 1;
  }

  return ok({ written, skipped });
}
