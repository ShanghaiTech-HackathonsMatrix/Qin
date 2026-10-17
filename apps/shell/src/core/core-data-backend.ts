/**
 * `DataBus` 的后端：**核心命名空间走物理存储，其它命名空间走 KV**。
 *
 * ## 为什么需要它
 *
 * 这是 C 段（「DataBus 成唯一数据层，TaskStore 退化成门面」）的接缝。
 *
 * 之前：`TaskStore` 是真相，DataBus 里那份是**投影**出来的镜像，每次写完都要
 * 重新投影一遍。同一份数据存两个地方，两条写入路径，靠调用方记得「写完要投影」。
 *
 * 现在：`DataBus` 是内存里唯一的真相，`DataBus.flush()` 调这里，这里把核心记录
 * 翻译成 `putTask` / `putCourse` 落进物理层。**只有一条写入路径。**
 *
 * ## 为什么按命名空间分流，而不是全部走 KV
 *
 * 任务数据有 SQLCipher 加密与索引策略，换成 KV 是倒退。所以核心实体留在
 * SQLite/JSON，插件实体留在 KV —— 但**对外只有一个数据层**，差异只在这个文件里。
 *
 * ## 一个必须处理的历史包袱
 *
 * 投影时代，核心记录也被 `bus.emit()` 写进了 KV（键 `entity.dev.matrix.core`）。
 * 现在它们归物理层，KV 里那份是**过期快照** —— 不丢掉的话，
 * 用户在投影时代删掉的任务会从旧快照里复活。`loadAll()` 里做了自愈。
 */

import type { DataBackend, DataChange, EntityRecord } from '@matrix/kernel';

import type { Course, Task } from '../domain/types.ts';
import {
  CORE_ENTITY,
  CORE_NS,
  projectCourse,
  projectTask,
  unprojectCourse,
  unprojectTask,
} from './core-entities.ts';

/**
 * 物理持久化层需要的能力。
 *
 * 只读写领域对象、**完全不认识 DataBus** —— 所以 `TaskStore` 的结构
 * 天然满足它，测试也可以用一个几行的假实现。
 */
export interface CoreStore {
  listTasks(): Promise<Task[]>;
  putTask(t: Task): Promise<void>;
  deleteTask(id: string): Promise<void>;
  listCourses(): Promise<Course[]>;
  putCourse(c: Course): Promise<void>;
  deleteCourse(id: string): Promise<void>;
  clearAll(): Promise<void>;
}

/** 核心命名空间 → 物理存储 */
export class CoreStoreBackend implements DataBackend {
  private readonly store: CoreStore;

  constructor(store: CoreStore) {
    this.store = store;
  }

  async loadAll(): Promise<EntityRecord[]> {
    const [tasks, courses] = await Promise.all([
      this.store.listTasks(),
      this.store.listCourses(),
    ]);
    const out: EntityRecord[] = [];
    for (const t of tasks) out.push(asRecord(projectTask(t)));
    for (const c of courses) out.push(asRecord(projectCourse(c)));
    return out;
  }

  async save(changes: readonly DataChange[]): Promise<void> {
    for (const c of changes) {
      if (c.kind === 'dropPlugin') {
        // 核心命名空间的整包删除 = 清空物理层
        if (c.pluginId === CORE_NS) await this.store.clearAll();
        continue;
      }
      if (c.kind === 'drop') {
        if (c.pluginId !== CORE_NS) continue;
        if (c.type === CORE_ENTITY.task) await this.store.deleteTask(c.id);
        else if (c.type === CORE_ENTITY.course) await this.store.deleteCourse(c.id);
        // 其它类型（slot_entry 等）不属于物理层，忽略
        continue;
      }

      const rec = c.record;
      if (rec.pluginId !== CORE_NS) continue;
      if (rec.type === CORE_ENTITY.task) await this.store.putTask(unprojectTask(rec));
      else if (rec.type === CORE_ENTITY.course) await this.store.putCourse(unprojectCourse(rec));
    }
  }
}

/**
 * 按命名空间分流的组合后端。
 *
 * 顺序上**先落核心再落插件**：核心是用户自己的数据，插件数据丢了可以重新同步，
 * 任务丢了就是丢了。失败会整体抛出 → `flush()` 把整批放回队列重试。
 */
export class CompositeBackend implements DataBackend {
  private readonly core: CoreStoreBackend;
  private readonly plugins: DataBackend;

  constructor(core: CoreStoreBackend, plugins: DataBackend) {
    this.core = core;
    this.plugins = plugins;
  }

  async loadAll(): Promise<EntityRecord[]> {
    const fromPlugins = await this.plugins.loadAll();

    // 自愈：投影时代核心记录被写进了 KV，现在那份是过期快照。
    // 不清理的话，用户在旧版本里删掉的任务会从快照里复活。
    const stale = fromPlugins.filter((r) => r.pluginId === CORE_NS);
    if (stale.length > 0) {
      await this.plugins.save([{ kind: 'dropPlugin', pluginId: CORE_NS }]);
    }

    return [
      ...(await this.core.loadAll()),
      ...fromPlugins.filter((r) => r.pluginId !== CORE_NS),
    ];
  }

  async save(changes: readonly DataChange[]): Promise<void> {
    const core: DataChange[] = [];
    const plugins: DataChange[] = [];
    for (const c of changes) {
      const owner = c.kind === 'upsert' ? c.record.pluginId : c.pluginId;
      (owner === CORE_NS ? core : plugins).push(c);
    }

    if (core.length > 0) await this.core.save(core);
    if (plugins.length > 0) await this.plugins.save(plugins);
  }
}

/**
 * `projectTask` / `projectCourse` 返回的形状缺 `pluginId` —— 那是**所有者**，
 * 由这一层补上。放在这里而不是投影函数里，是为了让投影函数保持「领域 → 数据」的纯映射。
 */
function asRecord(p: { type: string; id: string; data: Record<string, unknown> }): EntityRecord {
  return {
    type: p.type,
    id: p.id,
    pluginId: CORE_NS,
    data: p.data,
    // 这两个字段由 `DataBus.restore()` 之后的使用方决定；写入路径（emit）会重新盖章。
    // 用 0 / 1 而不是 Date.now()：`loadAll` 必须是纯读，读两次不能得到不同结果。
    updatedAt: typeof p.data.updatedAt === 'number' ? p.data.updatedAt : 0,
    revision: 1,
  };
}
