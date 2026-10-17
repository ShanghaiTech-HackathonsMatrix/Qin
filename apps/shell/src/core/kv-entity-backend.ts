/**
 * `DataBus` 的 KV 持久化后端 —— **只管插件命名空间**。
 *
 * ## 为什么插件实体走 KV，而不是 SQLite
 *
 * 1. `TaskStore` 的 `SqlDb` 是**私有**的（`SqliteStore` 不往外给），硬接要么
 *    开第二个连接、要么把抽象捅个洞。
 * 2. 新开一张 `plugin_<ns>_entity` 表就是**第三套表** —— 而 `docs/design/schema.sql`
 *    那 18 张已经闲置着，再加一套只会让「到底哪张表是真的」更难回答。
 * 3. KV 一条代码路径同时覆盖 web 与 Android，预览版两种形态行为一致。
 *
 * ## 核心实体**不**走这里
 *
 * C 段之后核心实体由 `CoreStoreBackend` 落进物理存储（SQLite/JSON，带加密与索引），
 * 分流发生在 `CompositeBackend` 里。所以「实体走 KV、任务走 SQLite」这个不对称
 * 只存在于**存储层**，对外只有一个 `DataBus` —— 调用方不用关心，也看不出区别。
 *
 * ## 键布局：一个插件一个键
 *
 *     entity.<pluginId>  →  { [type]: EntityRecord[] }
 *
 * **刻意不用** `entity.<pluginId>.<type>` 那种扁平布局：插件 id 里有点
 * （`app.matrix.importer.ics`），扁平键下 `app.matrix.importer` 的删除前缀
 * 会顺带把 `app.matrix.importer.ics` 的数据一起删掉 —— 前缀撞车。
 * 一插件一键 + 精确匹配，没有这个问题，而且一次批量只对一个插件读改写一次。
 *
 * ## 一次导入为什么只往返一次
 *
 * `save()` 先按 `pluginId` 分组，每组读一次文档、改完写一次。
 * 200 条实体 = 1 次读 + 1 次写，不是 200 次（那是 O(n²)）。
 */
import type { DataBackend, DataChange, EntityRecord } from '@matrix/kernel';
import type { SecureStore } from '../platform/strategies/kv/types';

const PREFIX = 'entity.';

const keyFor = (pluginId: string): string => `${PREFIX}${pluginId}`;

/** 一个插件的全部实体，按类型分组 */
type PluginDoc = Record<string, EntityRecord[]>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export class KvEntityBackend implements DataBackend {
  // 显式字段声明，不用 TS 参数属性 —— Node 24 的 strip-only 模式不支持它
  private readonly kv: SecureStore;

  constructor(kv: SecureStore) {
    this.kv = kv;
  }

  async loadAll(): Promise<EntityRecord[]> {
    const keys = (await this.kv.keys()).filter((k) => k.startsWith(PREFIX));
    const out: EntityRecord[] = [];
    for (const k of keys) {
      const doc = await this.readDoc(k);
      if (!doc) continue;
      for (const recs of Object.values(doc)) out.push(...recs);
    }
    return out;
  }

  async save(changes: readonly DataChange[]): Promise<void> {
    const drops = new Set<string>();
    const upserts = new Map<string, EntityRecord[]>();
    /** pluginId → 要删掉的单条记录 */
    const removes = new Map<string, { type: string; id: string }[]>();

    for (const c of changes) {
      if (c.kind === 'dropPlugin') {
        drops.add(c.pluginId);
      } else if (c.kind === 'drop') {
        const list = removes.get(c.pluginId);
        const one = { type: c.type, id: c.id };
        if (list) list.push(one);
        else removes.set(c.pluginId, [one]);
      } else {
        const list = upserts.get(c.record.pluginId);
        if (list) list.push(c.record);
        else upserts.set(c.record.pluginId, [c.record]);
      }
    }

    // ① **先落 drop**。「卸载后立刻重装」时旧数据必须先清掉，否则新记录会
    //    叠在旧记录上面，而插件以为自己是从干净状态开始的。
    for (const pluginId of drops) {
      await this.kv.remove(keyFor(pluginId));
    }

    // ② 再落单条删除与 upsert，一个插件读改写一次。
    //    注意**不要**跳过已经在 `drops` 里的插件：「卸载后立刻重装」会给出
    //    `dropPlugin` + `upsert` 的同一批，此时键已被删掉，`readDoc` 读回 null，
    //    从空文档开始写正好就是想要的效果。跳过的话新记录会凭空消失。
    const touched = new Set<string>([...removes.keys(), ...upserts.keys()]);
    for (const pluginId of touched) {
      const doc = (await this.readDoc(keyFor(pluginId))) ?? {};

      for (const r of removes.get(pluginId) ?? []) {
        const list = doc[r.type];
        if (!list) continue;
        const i = list.findIndex((x) => x.id === r.id);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) delete doc[r.type];
        else doc[r.type] = list;
      }

      for (const r of upserts.get(pluginId) ?? []) {
        const list = doc[r.type] ?? [];
        const i = list.findIndex((x) => x.id === r.id);
        if (i >= 0) list[i] = r;
        else list.push(r);
        doc[r.type] = list;
      }

      await this.kv.set(keyFor(pluginId), JSON.stringify(doc));
    }
  }

  /** 该后端里已落盘的插件 id（诊断用） */
  async pluginIds(): Promise<string[]> {
    const keys = (await this.kv.keys()).filter((k) => k.startsWith(PREFIX));
    return keys.map((k) => k.slice(PREFIX.length));
  }

  private async readDoc(key: string): Promise<PluginDoc | null> {
    const raw = await this.kv.get(key);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) throw new Error('不是一个对象');
      const out: PluginDoc = {};
      for (const [type, recs] of Object.entries(parsed)) {
        if (Array.isArray(recs)) out[type] = recs as EntityRecord[];
      }
      return out;
    } catch {
      // 损坏不要静默丢 —— 挪到 .corrupt 备份键下，和 `JsonStore` 一个做法
      await this.kv.set(`${key}.corrupt.${Date.now()}`, raw);
      await this.kv.remove(key);
      return null;
    }
  }
}
