/**
 * 内核 —— 数据总线（DESIGN.md §5.3 的 `bus.emit` / `bus.read`）
 *
 * 三件事：
 *   1. **写入前校验**：载荷必须过插件自己声明的 JSON Schema。
 *      不校验的话，一个连接器就能往 Timeline 里塞任意形状的垃圾，
 *      而 Timeline 是内置插件，等于让第三方代码影响第一方渲染路径。
 *   2. **配额**：行数 / 字节数按插件计。超限 `EQUOTA`（§5.3）。
 *   3. **字段投影**：跨插件读取时，只返回 schema 里标为 `shared` 的字段。
 *
 * ⚠️ **关于字段投影的诚实说明**：
 * DESIGN.md §5.3 只写了「只返回声明过的字段投影」，**没有**规定投影机制。
 * 这里给出一个具体提案：schema 里字段级 `shared: false`（默认 true）表示
 * 「本插件内部用，不外泄」。这是一个**待评审的设计决定**，不是文档既有结论。
 * 若评审结果不同（比如改成按 manifest 声明可读字段），只需改 `project()`。
 *
 * 关于命名空间隔离：这里只保证「写入者必须与记录所有者一致」。
 * 真正的物理隔离（`plugin_<id>_*` 表前缀 / 命名空间 KV）在存储层，
 * 属于 `packages/store` 的职责，不在本文件。
 */

import {
  ENTITY_TYPE_RE,
  fail,
  ok,
  type EntitySchema,
  type FieldSchema,
  type ParsedEntity,
  type PluginResult,
  type SchemaIssue,
} from '@matrix/plugin-api';

import { byteLen } from './bytes.ts';

// ------------------------------------------------------------ JSON Schema 子集

/**
 * 这三个类型现在定义在**契约包**里 —— `EntitySchema` 出现在 manifest 的
 * `contributes.entityTypes` 中，它是契约的一部分，不是内核的内部结构。
 *
 * 这里重导出，保持内核对外的形状不变（`packages/kernel/src/index.ts` 走 `export *`）。
 */
export type { EntitySchema, FieldSchema, SchemaIssue } from '@matrix/plugin-api';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function checkField(value: unknown, schema: FieldSchema, path: string, issues: SchemaIssue[]): void {
  if (value === null) {
    if (!schema.nullable) issues.push({ path, message: '不允许 null' });
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    issues.push({ path, message: `不在 enum 内: ${JSON.stringify(value)}` });
    return;
  }
  if (!schema.type) return;

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') issues.push({ path, message: `期望 string，收到 ${typeof value}` });
      else if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        issues.push({ path, message: `长度 ${value.length} 超过上限 ${schema.maxLength}` });
      }
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push({ path, message: `期望有限 number，收到 ${typeof value}` });
      }
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        issues.push({ path, message: '期望 integer' });
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') issues.push({ path, message: `期望 boolean，收到 ${typeof value}` });
      break;
    case 'array':
      if (!Array.isArray(value)) {
        issues.push({ path, message: '期望 array' });
      } else if (schema.items) {
        value.forEach((item, i) => checkField(item, schema.items as FieldSchema, `${path}[${i}]`, issues));
      }
      break;
    case 'object':
      if (!isRecord(value)) issues.push({ path, message: '期望 object' });
      break;
  }
}

/** 校验载荷。返回 issue 列表，空表示通过。 */
export function validateEntity(data: unknown, schema: EntitySchema): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (!isRecord(data)) return [{ path: '', message: '载荷必须是对象' }];

  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(data, key)) issues.push({ path: key, message: '缺少必填字段' });
  }

  for (const [key, value] of Object.entries(data)) {
    // I11：用 Object.hasOwn / Map，不让 __proto__ 之类的东西绕过
    if (!Object.hasOwn(schema.properties ?? {}, key)) {
      if (schema.additionalProperties !== true) {
        issues.push({ path: key, message: '未在 schema 中声明（additionalProperties 默认为 false）' });
      }
      continue;
    }
    const field = (schema.properties as Record<string, FieldSchema>)[key] as FieldSchema;
    checkField(value, field, key, issues);
  }

  return issues;
}

/** 按 schema 的 `shared` 标记裁剪字段（跨插件读取时用） */
export function projectFields(data: Record<string, unknown>, schema: EntitySchema | undefined): Record<string, unknown> {
  if (!schema?.properties) return { ...data };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const field = schema.properties[key];
    // schema 里没声明的字段：写入时已被拒，这里防御性地也带上（自家读自家）
    if (!field || field.shared !== false) out[key] = value;
  }
  return out;
}

// ------------------------------------------------------------ 记录与事件

export interface EntityRecord {
  /** 实体类型，对应 manifest `permissions.data.write` 里的名字 */
  type: string;
  id: string;
  /** 所有者。写入者必须与它一致 */
  pluginId: string;
  data: Record<string, unknown>;
  updatedAt: number;
  /** 第几次写入（同一 id 重复写入时递增） */
  revision: number;
}

export type DataBusEvent =
  | { kind: 'upsert'; record: EntityRecord }
  | { kind: 'drop'; type: string; pluginId: string };

export interface QuotaPolicy {
  maxRowsPerPlugin: number;
  maxBytesPerPlugin: number;
}

export const DEFAULT_QUOTA: QuotaPolicy = {
  maxRowsPerPlugin: 20_000,
  maxBytesPerPlugin: 8 * 1024 * 1024,
};

export interface DataBusOptions {
  quota?: Partial<QuotaPolicy>;
  now?: () => number;
  /**
   * 持久化后端。不传 = 纯内存（默认；测试与「没有可用存储」时都走这条）。
   */
  backend?: DataBackend;
}

/** 一次刷盘变更。upsert 与 dropPlugin 混在同一批里，按队列插入序应用 */
export type DataChange =
  | { kind: 'upsert'; record: EntityRecord }
  | { kind: 'dropPlugin'; pluginId: string };

/**
 * 持久化后端 —— `DataBus` 唯一的存储出口。
 *
 * 两个方法都是 async，而 `DataBus` 的写入路径（`emit`）**必须同步**
 * （D8：插件契约没有异步宿主 API；S4b 已经证明让宿主回调变 async 会把
 * asyncify 状态机搞崩）。所以这里是 **write-behind**：
 * 内存先落、变更进队列，宿主在合适时机 `await bus.flush()`。
 *
 * 实现必须满足三条：
 *   · `save()` 收到的一批里可能同时有 upsert 与 dropPlugin，要**按给定顺序**应用
 *   · upsert **幂等** —— 同一 `(pluginId, type, id)` 重放一次结果相同（`flush` 失败会重放）
 *   · `loadAll()` 返回的 `revision` 要原样保留，不要重置成 1
 */
export interface DataBackend {
  /** 启动时读回全部记录。调用方随后交给 `DataBus.restore()` */
  loadAll(): Promise<EntityRecord[]>;
  /** 应用一批变更。抛异常 = 这批失败，`flush()` 会把它们放回队列 */
  save(changes: readonly DataChange[]): Promise<void>;
}

/**
 * 记录键 = `pluginId \u0000 type \u0000 id`。
 *
 * **必须带上 pluginId**：否则两个插件写同一个 `type` + `id` 会互相覆盖，
 * 既破坏「插件数据命名空间隔离」，也是一条跨插件篡改通路 ——
 * 自动生成的 id 由内容哈希推导，可以被刻意碰撞。
 * 跨插件**读**不受影响：`read()` 是按 `type` 遍历整张表的。
 */
const keyOf = (pluginId: string, type: string, id: string): string =>
  `${pluginId}\u0000${type}\u0000${id}`;

/** 队列去重键。`dropPlugin` 与记录键用不同前缀，避免撞在一起 */
const changeKeyOf = (c: DataChange): string =>
  c.kind === 'upsert'
    ? keyOf(c.record.pluginId, c.record.type, c.record.id)
    : `drop\u0000${c.pluginId}`;

// ------------------------------------------------------------ DataBus

export class DataBus {
  /** pluginId → 实体类型 → schema */
  private readonly schemas = new Map<string, Map<string, EntitySchema>>();
  /** 实体类型 → 记录（按 key 存，保持插入序便于稳定输出） */
  private readonly tables = new Map<string, Map<string, EntityRecord>>();
  private readonly listeners = new Set<(e: DataBusEvent) => void>();
  /**
   * 每个插件的占用，**增量维护**。
   *
   * 早先是每次 `emit` 全表重扫一遍算配额 —— 那是 O(n²)：20,000 行配额下
   * 一次同步要做两亿次序列化。配额是热路径上的判断，不能这么算。
   */
  private readonly usage = new Map<string, { rows: number; bytes: number }>();
  private readonly quota: QuotaPolicy;
  private readonly clock: () => number;
  private readonly backend: DataBackend | undefined;
  /**
   * 待刷盘变更。**用 Map 去重**：同一个 key 连写十次只留最后一次，
   * 所以一次导入 200 条不会变成 200 次后端往返。
   */
  private readonly pending = new Map<string, DataChange>();

  constructor(opts: DataBusOptions = {}) {
    this.quota = { ...DEFAULT_QUOTA, ...opts.quota };
    this.clock = opts.now ?? (() => Date.now());
    this.backend = opts.backend;
  }

  /**
   * 声明一个插件贡献的实体类型。
   * 来自 manifest `contributes.entityTypes`，**写入前必须已声明**。
   */
  declareSchema(pluginId: string, type: string, schema: EntitySchema): PluginResult<void> {
    if (schema.type !== 'object') {
      return fail('ESCHEMA', `实体 ${type} 的 schema 必须是 object 类型`);
    }
    if (!type || !ENTITY_TYPE_RE.test(type)) {
      return fail('ESCHEMA', `实体类型必须是 snake_case 标识符: "${type}"`);
    }
    let m = this.schemas.get(pluginId);
    if (!m) {
      m = new Map();
      this.schemas.set(pluginId, m);
    }
    m.set(type, schema);
    return ok(undefined);
  }

  /** 该插件是否声明过这个实体类型 */
  hasSchema(pluginId: string, type: string): boolean {
    return this.schemas.get(pluginId)?.has(type) === true;
  }

  /** 某个实体类型被哪些插件声明过（同类型多声明者时用于挑 schema） */
  ownersOf(type: string): string[] {
    const out: string[] = [];
    for (const [pluginId, m] of this.schemas) if (m.has(type)) out.push(pluginId);
    return out;
  }

  /**
   * 写入一条记录。
   *
   * 拒绝的情况（全部返回 `PluginResult`，不抛异常）：
   *   · 该插件没声明过这个实体类型 → `ESCHEMA`
   *   · 载荷不合 schema → `ESCHEMA`（带逐字段 issue）
   *   · 超出配额 → `EQUOTA`
   */
  emit(
    pluginId: string,
    entity: ParsedEntity,
    now = this.clock(),
  ): PluginResult<EntityRecord> {
    const { type } = entity;
    if (!type) return fail('ESCHEMA', 'emit 缺少实体类型');

    const schema = this.schemas.get(pluginId)?.get(type);
    if (!schema) {
      return fail('ESCHEMA', `插件 ${pluginId} 未声明实体类型 "${type}"`, { pluginId, type });
    }

    const issues = validateEntity(entity.data, schema);
    if (issues.length > 0) {
      return fail('ESCHEMA', `实体 ${type} 的载荷不合 schema`, {
        issues: issues.map((i) => `${i.path || '<root>'}: ${i.message}`),
      });
    }

    // id：没给就按内容哈希生成（稳定，同样的内容落到同一行）
    const id = entity.id && entity.id !== '' ? entity.id : `h${hash(JSON.stringify(entity.data))}`;

    let table = this.tables.get(type);
    if (!table) {
      table = new Map();
      this.tables.set(type, table);
    }

    const k = keyOf(pluginId, type, id);
    const prev = table.get(k);

    // 键里带了 pluginId，所以 prev 一定是同一个插件的记录
    const newBytes = byteLen(JSON.stringify(entity.data));
    const prevBytes = prev ? byteLen(JSON.stringify(prev.data)) : 0;

    // 配额检查（先算新状态，再决定是否落）
    const usage = this.usageOf(pluginId);
    const deltaRows = prev ? 0 : 1;
    const deltaBytes = newBytes - prevBytes;
    if (
      usage.rows + deltaRows > this.quota.maxRowsPerPlugin ||
      usage.bytes + deltaBytes > this.quota.maxBytesPerPlugin
    ) {
      return fail('EQUOTA', `插件 ${pluginId} 超出数据配额`, {
        rows: usage.rows + deltaRows,
        maxRows: this.quota.maxRowsPerPlugin,
        bytes: usage.bytes + deltaBytes,
        maxBytes: this.quota.maxBytesPerPlugin,
      });
    }

    const record: EntityRecord = {
      type,
      id,
      pluginId,
      data: { ...entity.data },
      updatedAt: now,
      revision: (prev?.revision ?? 0) + 1,
    };
    table.set(k, record);

    // 增量更新占用
    const tally = this.usage.get(pluginId) ?? { rows: 0, bytes: 0 };
    tally.rows += deltaRows;
    tally.bytes += deltaBytes;
    this.usage.set(pluginId, tally);

    // write-behind：内存已经生效，这一条只是排进刷盘队列。
    // 注意 `emit` 的返回值**不反映落盘结果** —— 落盘失败由 `flush()` 报。
    this.enqueue({ kind: 'upsert', record });

    const evt: DataBusEvent = { kind: 'upsert', record: { ...record, data: { ...record.data } } };
    for (const fn of this.listeners) fn(evt);

    return ok({ ...record, data: { ...record.data } });
  }

  /**
   * 读取某类型的记录。
   *
   * 跨插件读取时按 schema 的 `shared` 标记裁剪字段 ——
   * 读自己写的记录不裁剪（否则插件拿不回自己存的东西）。
   */
  read(
    readerPluginId: string,
    type: string,
    opts: { limit?: number } = {},
  ): PluginResult<EntityRecord[]> {
    const table = this.tables.get(type);
    if (!table) return ok([]);

    const out: EntityRecord[] = [];
    for (const rec of table.values()) {
      const sameOwner = rec.pluginId === readerPluginId;
      const schema = this.schemas.get(rec.pluginId)?.get(type);
      out.push({
        ...rec,
        data: sameOwner ? { ...rec.data } : projectFields(rec.data, schema),
      });
      if (opts.limit !== undefined && out.length >= opts.limit) break;
    }
    return ok(out);
  }

  subscribe(fn: (e: DataBusEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 按插件统计行数与字节数（读增量计数，O(1)） */
  usageOf(pluginId: string): { rows: number; bytes: number } {
    const u = this.usage.get(pluginId);
    return u ? { rows: u.rows, bytes: u.bytes } : { rows: 0, bytes: 0 };
  }

  stats(): { types: number; records: number; plugins: number } {
    const plugins = new Set<string>();
    let records = 0;
    for (const table of this.tables.values()) {
      for (const rec of table.values()) {
        records += 1;
        plugins.add(rec.pluginId);
      }
    }
    return { types: this.tables.size, records, plugins: plugins.size };
  }

  /** 卸载：删掉某插件的全部记录（§5.6「删表 or 保留 orphan」里的「删表」） */
  dropPlugin(pluginId: string): number {
    let removed = 0;
    for (const [type, table] of this.tables) {
      for (const [k, rec] of table) {
        if (rec.pluginId === pluginId) {
          table.delete(k);
          removed += 1;
        }
      }
      if (table.size === 0) this.tables.delete(type);
    }
    this.usage.delete(pluginId);
    // 同一批里已排队的 upsert 全部作废 —— 否则「卸载之后又被写回去」
    for (const [k, c] of this.pending) {
      if (c.kind === 'upsert' && c.record.pluginId === pluginId) this.pending.delete(k);
    }
    this.enqueue({ kind: 'dropPlugin', pluginId });
    if (removed > 0) {
      const evt: DataBusEvent = { kind: 'drop', type: '*', pluginId };
      for (const fn of this.listeners) fn(evt);
    }
    return removed;
  }

  /** 卸载：只注销 schema，保留记录（§5.6 的「保留 orphan」） */
  forgetSchemas(pluginId: string): void {
    this.schemas.delete(pluginId);
  }

  // ---------------------------------------------------------- 持久化

  /**
   * 把队列里的变更刷进后端。
   *
   * **宿主必须在 `sync()` 之后调它**，否则这一轮的实体只活在内存里。
   * 失败时这批变更被放回队列（upsert 幂等，重放无害），下次再试 ——
   * 所以「刷盘失败」不等于「数据丢了」，只是「还没落」。
   */
  async flush(): Promise<PluginResult<void>> {
    if (!this.backend || this.pending.size === 0) return ok(undefined);

    const batch = [...this.pending.values()];
    this.pending.clear();
    try {
      await this.backend.save(batch);
      return ok(undefined);
    } catch (e) {
      for (const c of batch) this.pending.set(changeKeyOf(c), c);
      return fail('EINTERNAL', `数据刷盘失败：${e instanceof Error ? e.message : String(e)}`, {
        count: batch.length,
      });
    }
  }

  /**
   * 用后端读回的记录重建内存索引与配额计数。
   *
   * ⚠️ **只在启动时调，且要在订阅之前** —— 它**不发事件**。
   * 发的话几千条记录会把 UI 冲垮，而启动时本来就没人订阅。
   */
  restore(records: readonly EntityRecord[]): number {
    let n = 0;
    for (const rec of records) {
      let table = this.tables.get(rec.type);
      if (!table) {
        table = new Map();
        this.tables.set(rec.type, table);
      }
      table.set(keyOf(rec.pluginId, rec.type, rec.id), rec);
      n += 1;
    }
    this.recountUsage();
    return n;
  }

  /** 还有多少变更没落盘（调试 / 测试用） */
  pendingCount(): number {
    return this.pending.size;
  }

  private enqueue(change: DataChange): void {
    if (!this.backend) return;
    this.pending.set(changeKeyOf(change), change);
  }

  /** 全量重算占用。只在 `restore()` 里用 —— 启动期一次性 O(n) */
  private recountUsage(): void {
    this.usage.clear();
    for (const table of this.tables.values()) {
      for (const rec of table.values()) {
        const u = this.usage.get(rec.pluginId) ?? { rows: 0, bytes: 0 };
        u.rows += 1;
        u.bytes += byteLen(JSON.stringify(rec.data));
        this.usage.set(rec.pluginId, u);
      }
    }
  }
}

/**
 * FNV-1a 32 位。**不是**加密哈希，只用来给「没给 id」的记录生成稳定标识。
 * 不做碰撞防护 —— 碰撞了就是两条记录合并，作者应当显式给 id。
 */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
