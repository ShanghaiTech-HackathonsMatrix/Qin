/**
 * `DataBus` 的 KV 持久化后端 —— 让插件写入的实体活过刷新。
 *
 * ## 为什么是 KV，不是 SQLite
 *
 * 1. `TaskStore` 的 `SqlDb` 是**私有**的（`SqliteStore` 不往外给），硬接要么
 *    开第二个连接、要么把抽象捅个洞。
 * 2. 新开一张 `plugin_<ns>_entity` 表就是**第三套表** —— 而 `docs/design/schema.sql`
 *    那 18 张已经闲置着，再加一套只会让「到底哪张表是真的」更难回答。
 * 3. KV 一条代码路径同时覆盖 web 与 Android，预览版两种形态行为一致。
 *
 * **代价写在明处**：实体走 KV、任务走 SQLite。在 SQL 后端下这是个不对称 ——
 * 等 DataBus 收敛成唯一数据层（`dev.md` 的 T2d / T2e）时一起消掉。
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

    for (const c of changes) {
      if (c.kind === 'dropPlugin') {
        drops.add(c.pluginId);
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

    // ② 再落 upsert，一个插件读改写一次
    for (const [pluginId, recs] of upserts) {
      const doc = (await this.readDoc(keyFor(pluginId))) ?? {};
      for (const r of recs) {
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
