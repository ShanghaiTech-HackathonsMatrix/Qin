/**
 * 槽（Slot）—— 插件之间**不经过程序调用**的扩展点。
 *
 * ## 它解决什么问题
 *
 * Timeline 需要被别的插件「往里塞事件」：课表塞「8:00~10:00 高等数学」，
 * 作业管理器塞「23:59 DDL」。最直觉的做法是让插件互相调函数：
 *
 * ```ts
 * Core.accessPlugin('app.matrix.timeline').invoke('insert', event)   // ← 不采用
 * ```
 *
 * 那会破掉三条已经定下的东西：**D8**（插件是纯函数，`invoke` 要么有回调、
 * 要么得跨调用持有状态）、**D3**（插件不写存储）、**D5**（布局/配置是纯数据）。
 * 而且沙箱里同步函数调用根本不成立。
 *
 * 槽把它们换成一个**由数据描述**的协议：
 *
 * ```
 *  ①定义方声明       slots: [{ name: 'timeline.event', schema }]
 *         │
 *  ②使用方声明       consumesSlots: [{ slot: 'timeline.event', from: 'session', map }]
 *         │
 *  ③宿主执行        读使用方的实体 → 按 map 映射 → 校验 → 写进槽
 *         │
 *  ④定义方渲染      render() 从 ctx.records 里拿到槽里的条目
 * ```
 *
 * ①和②之间**没有任何运行时耦合**。定义方卸载了，槽变孤儿；重装即恢复。
 *
 * ## 为什么 `map` 是数据不是函数
 *
 * `map` 用 `{ 'timeline.event 的字段名': '实体里的字段名' }` 描述字段对应关系。
 * 是 JSON 能表达的东西，所以：可校验、可序列化、能过沙箱边界、能写进文档。
 * 一旦允许写映射函数，就又回到「插件互相调用」了。
 */

import { fail, ok, type PluginResult } from './errors.ts';

/**
 * 槽名。`<命名空间>.<名字>`，且**必须**以定义方自己的 id 命名空间为前缀 ——
 * 否则一个插件能定义 `app.matrix.timeline.event` 把别人的槽顶掉。
 */
export const SLOT_NAME_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*)+$/;

/** 槽里一个条目的字段类型。刻意只有标量：槽是给 UI 用的，不需要嵌套 */
export const SLOT_FIELD_TYPES = ['string', 'number', 'boolean'] as const;
export type SlotFieldType = (typeof SLOT_FIELD_TYPES)[number];

export interface SlotField {
  type: SlotFieldType;
  required?: boolean;
  maxLength?: number;
  /** 人类可读的说明，宿主不解释 */
  description?: string;
}

/**
 * 槽定义。这是 **`CheckEvent()` 的纯数据部分** ——
 * 「这条记录合不合法」的绝大部分判断靠它，不需要任何回调。
 */
export interface SlotDefinition {
  /** `<自己 id 的首段>.<名字>`，见 `SLOT_NAME_RE` */
  name: string;
  /** 一句人话，告诉别的插件这个槽是干什么的 */
  description?: string;
  /** 条目只能有这里列出的字段；缺省 `additionalProperties: false` 自动生效 */
  fields: Record<string, SlotField>;
  /** 最多保留多少条。超出时宿主按 `orderBy` 保留最靠前的 */
  maxItems?: number;
  /**
   * 槽里条目的推荐排序字段（必须是 number 类型的字段）。
   * `render()` 自己排也行 —— 这只是给宿主的提示。
   */
  orderBy?: string;
}

/**
 * 消费声明：**我往这个槽写，数据从我哪种实体来**。
 *
 * 例如课表插件：
 * ```ts
 * { slot: 'timeline.event', from: 'session',
 *   map: { startAt: 'startAt', endAt: 'endAt', title: 'title', location: 'location' } }
 * ```
 * 意思是「取我自己命名空间里的 `session` 实体，把它的 `startAt` 填进槽条目的
 * `startAt`，以此类推」。
 */
export interface SlotConsumption {
  slot: string;
  /** 源实体类型。必须是本插件 `contributes.entityTypes` 里声明过的 */
  from: string;
  /** 槽字段名 → 源实体字段名 */
  map: Record<string, string>;
  /** 只取满足这个常量条件的实体。键是源实体字段，值必须是字符串/数字/布尔 */
  where?: Record<string, string | number | boolean>;
}

/**
 * 槽条目的实际存储形状。
 *
 * `source` 是宿主填的，插件改不了 —— 有了它，「这条事件是谁塞进来的」
 * 永远可查，卸载那个插件时也能精确摘掉它的条目。
 */
export interface SlotEntry {
  /** 槽字段（由使用方的 `map` 决定） */
  data: Readonly<Record<string, string | number | boolean>>;
  /** 写入方 pluginId */
  source: string;
  /** 源实体类型 */
  from: string;
  /** 源实体 id */
  ref: string;
}

/** 槽条目的数量上限（跨所有使用方）。防止一个插件把定义方的内存塞爆 */
export const SLOT_LIMITS = {
  maxItems: 5000,
  maxFields: 40,
  maxConsumers: 64,
} as const;

// ------------------------------------------------------------ 校验

export function validateSlotDefinition(
  raw: unknown,
  at: string,
  seen: Set<string>,
): PluginResult<SlotDefinition> {
  if (!isPlainObject(raw)) return fail('ESCHEMA', `${at} 必须是对象`);

  const name = raw.name;
  if (typeof name !== 'string' || !SLOT_NAME_RE.test(name)) {
    return fail('ESCHEMA', `${at}.name 必须是 "命名空间.名字" 形式，实际 "${String(name)}"`);
  }
  if (seen.has(name)) return fail('ESCHEMA', `${at}.name 重复：${name}`);
  seen.add(name);

  if (raw.description !== undefined && typeof raw.description !== 'string') {
    return fail('ESCHEMA', `${at}.description 必须是字符串`);
  }

  if (!isPlainObject(raw.fields)) return fail('ESCHEMA', `${at}.fields 必须是对象`);
  const fieldNames = Object.keys(raw.fields);
  if (fieldNames.length === 0) return fail('ESCHEMA', `${at}.fields 至少要有一个字段`);
  if (fieldNames.length > SLOT_LIMITS.maxFields) {
    return fail('ESCHEMA', `${at}.fields 超过 ${SLOT_LIMITS.maxFields} 个`);
  }

  const fields: Record<string, SlotField> = {};
  for (const [k, v] of Object.entries(raw.fields)) {
    const fat = `${at}.fields.${k}`;
    if (!isPlainObject(v)) return fail('ESCHEMA', `${fat} 必须是对象`);
    if (typeof v.type !== 'string' || !(SLOT_FIELD_TYPES as readonly string[]).includes(v.type)) {
      return fail('ESCHEMA', `${fat}.type 只能是 ${SLOT_FIELD_TYPES.join(' / ')}`);
    }
    if (v.required !== undefined && typeof v.required !== 'boolean') {
      return fail('ESCHEMA', `${fat}.required 必须是布尔`);
    }
    if (v.maxLength !== undefined && (typeof v.maxLength !== 'number' || v.maxLength <= 0)) {
      return fail('ESCHEMA', `${fat}.maxLength 必须是正整数`);
    }
    if (v.description !== undefined && typeof v.description !== 'string') {
      return fail('ESCHEMA', `${fat}.description 必须是字符串`);
    }
    fields[k] = {
      type: v.type as SlotFieldType,
      ...(v.required !== undefined ? { required: v.required } : {}),
      ...(v.maxLength !== undefined ? { maxLength: v.maxLength } : {}),
      ...(v.description !== undefined ? { description: v.description } : {}),
    };
  }

  if (raw.maxItems !== undefined) {
    if (typeof raw.maxItems !== 'number' || !Number.isInteger(raw.maxItems) || raw.maxItems <= 0) {
      return fail('ESCHEMA', `${at}.maxItems 必须是正整数`);
    }
    if (raw.maxItems > SLOT_LIMITS.maxItems) {
      return fail('ESCHEMA', `${at}.maxItems 不能超过 ${SLOT_LIMITS.maxItems}`);
    }
  }

  if (raw.orderBy !== undefined) {
    if (typeof raw.orderBy !== 'string' || !(raw.orderBy in fields)) {
      return fail('ESCHEMA', `${at}.orderBy 必须指向一个已声明的字段`);
    }
    if (fields[raw.orderBy]!.type !== 'number') {
      return fail('ESCHEMA', `${at}.orderBy 只能指向 number 字段`);
    }
  }

  return ok({
    name,
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    fields,
    ...(raw.maxItems !== undefined ? { maxItems: raw.maxItems } : {}),
    ...(raw.orderBy !== undefined ? { orderBy: raw.orderBy } : {}),
  });
}

export function validateSlotConsumption(
  raw: unknown,
  at: string,
  seen: Set<string>,
): PluginResult<SlotConsumption> {
  if (!isPlainObject(raw)) return fail('ESCHEMA', `${at} 必须是对象`);

  const slot = raw.slot;
  if (typeof slot !== 'string' || !SLOT_NAME_RE.test(slot)) {
    return fail('ESCHEMA', `${at}.slot 必须是 "命名空间.名字" 形式，实际 "${String(slot)}"`);
  }
  if (seen.has(slot)) return fail('ESCHEMA', `${at}.slot 重复：${slot}`);
  seen.add(slot);

  if (typeof raw.from !== 'string' || raw.from === '') {
    return fail('ESCHEMA', `${at}.from 必须是非空字符串（源实体类型）`);
  }

  if (!isPlainObject(raw.map)) return fail('ESCHEMA', `${at}.map 必须是对象`);
  const entries = Object.entries(raw.map);
  if (entries.length === 0) return fail('ESCHEMA', `${at}.map 不能为空`);
  const map: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof v !== 'string' || v === '') {
      return fail('ESCHEMA', `${at}.map.${k} 必须是源实体的字段名`);
    }
    map[k] = v;
  }

  if (raw.where !== undefined) {
    if (!isPlainObject(raw.where)) return fail('ESCHEMA', `${at}.where 必须是对象`);
    for (const [k, v] of Object.entries(raw.where)) {
      const t = typeof v;
      if (t !== 'string' && t !== 'number' && t !== 'boolean') {
        return fail('ESCHEMA', `${at}.where.${k} 只能是字符串 / 数字 / 布尔`);
      }
    }
  }

  return ok({
    slot,
    from: raw.from,
    map,
    ...(raw.where !== undefined ? { where: raw.where as Record<string, string | number | boolean> } : {}),
  });
}

/**
 * 槽定义方的**跨字段**校验钩子 —— 就是 C++ 设想里的 `bool CheckEvent(const Event&)`，
 * 但换成**同步纯函数**并返回原因，不是 bool。
 *
 * 为什么必须纯：宿主在**写入那一刻**调它。如果它能读全局、能返回两次不同结果，
 * 那「同样数据渲染出同样界面」就不成立了。而且沙箱里回调跨不过去。
 *
 * 绝大多数不合法靠 `SlotDefinition.fields` 就够了；这里只处理跨字段规则
 * （比如 `endAt` 不能早于 `startAt`）。
 */
export type SlotValidator = (entry: Readonly<Record<string, string | number | boolean>>) =>
  | { ok: true }
  | { ok: false; reason: string };

/**
 * 按定义把源实体映射成槽条目。**纯函数**。
 *
 * 返回值里的 `null` 表示「这条不该进槽」（缺必填字段 / 类型不符 / `where` 不匹配），
 * 不是错误 —— 一条坏记录不该让整次同步失败。
 */
export function buildSlotEntry(
  def: SlotDefinition,
  consumption: SlotConsumption,
  source: Readonly<Record<string, unknown>>,
): { ok: true; data: Record<string, string | number | boolean> } | { ok: false; reason: string } {
  // where 先过：不匹配就直接跳过
  if (consumption.where) {
    for (const [k, want] of Object.entries(consumption.where)) {
      if (source[k] !== want) return { ok: false, reason: `where.${k} 不匹配` };
    }
  }

  const data: Record<string, string | number | boolean> = {};
  for (const [slotField, srcField] of Object.entries(consumption.map)) {
    const spec = def.fields[slotField];
    if (!spec) return { ok: false, reason: `槽 ${def.name} 没有字段 "${slotField}"` };

    const v = source[srcField];
    if (v === undefined || v === null) {
      if (spec.required === true) return { ok: false, reason: `缺必填字段 ${slotField}` };
      continue;
    }
    const t = typeof v;
    if (t !== spec.type) {
      return { ok: false, reason: `字段 ${slotField} 期望 ${spec.type}，实际 ${t}` };
    }
    if (spec.type === 'string' && spec.maxLength !== undefined) {
      const s = v as string;
      if (s.length > spec.maxLength) {
        // 截断而不是拒收：一条超长备注不该让整节课消失
        data[slotField] = s.slice(0, spec.maxLength);
        continue;
      }
    }
    data[slotField] = v as string | number | boolean;
  }

  for (const [name, spec] of Object.entries(def.fields)) {
    if (spec.required === true && !(name in data)) {
      return { ok: false, reason: `缺必填字段 ${name}` };
    }
  }

  return { ok: true, data };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
