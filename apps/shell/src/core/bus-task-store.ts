/**
 * `TaskStore` 的**门面**：读写都走 `DataBus`，物理存储只在 `flush()` 时被碰到。
 *
 * ## 它为什么存在
 *
 * C 段之前，`TaskStore` 和 `DataBus` 是两份数据：UI 写 `TaskStore`，然后调一次
 * `projectCore()` 把内容**投影**进总线给插件看。漏调一次就是「界面改了、时间线没改」，
 * 而漏调是迟早的事。
 *
 * 现在 UI 仍然调 `TaskStore` 这套方法（界面代码一行不用改），但它已经**不是真相**了 ——
 * 真相在总线里。这个类就是把旧接口接到新真相上的那一层胶水。
 *
 * ```
 * UI / 命令  →  BusTaskStore  →  bus.emit / bus.drop  →  flush  →  CoreStoreBackend  →  SQLite
 *                                     ↑
 *                              唯一的内存真相
 * ```
 *
 * ## 为什么每个写方法都 `flush`
 *
 * `await putTask(t)` 的语义是「落盘了」。总线是 write-behind 的：`emit` 只进队列。
 * 不在这里 flush，调用方 `await` 完就以为存住了，实际还在内存里 —— 那是骗人。
 *
 * 代价：一次命令里的 N 条 `coreOps` 会 flush N 次。命令通常只有 1–2 条，
 * 而本地 SQLite 单条写入是微秒级。真到了成批写的场景，应当加一个显式的批处理入口，
 * 而不是偷偷把 `flush` 挪走。
 */

import type { PluginResult } from '@matrix/plugin-api';
import type { DataBus } from '@matrix/kernel';

import type { Course, Task } from '../domain/types.ts';
import {
  CORE_ENTITY,
  CORE_NS,
  HOST_NS,
  projectCourse,
  projectTask,
  unprojectCourse,
  unprojectTask,
} from './core-entities.ts';
import type { TaskStore } from '../platform/strategies/store/types.ts';

/**
 * 单次读取上限。
 *
 * 取的是配额天花板量级（`QUOTA_LIMITS` 的行数上限），而不是分页用的 200 ——
 * 这里要的是「全部」，不是「第一屏」。
 */
const MAX_RECORDS = 20_000;

/** 把 `PluginResult` 的失败翻成异常：`TaskStore` 的方法是 `Promise<void>`，没有错误码可回 */
function must<T>(r: PluginResult<T>, what: string): T {
  if (r.ok) return r.data;
  throw new Error(`${what}失败：${r.code} ${r.message}`);
}

/**
 * 门面对物理层的**全部**要求。
 *
 * 只有自述信息与关闭 —— 数据的读写它一条都不用，因为它走总线。
 * 这个窄接口本身就是「物理层退化成持久化细节」的证明：
 * 如果哪天这里冒出一个 `listTasks`，说明又长出第二条读路径了。
 */
export interface PhysicalStore {
  readonly backend: string;
  info(): Promise<Record<string, string>>;
  close(): Promise<void>;
}

export class BusTaskStore implements TaskStore {
  private readonly raw: PhysicalStore;
  private readonly bus: DataBus;

  /**
   * 只依赖**裸总线**，不依赖 `PluginHost` —— 这样它能被一个几行的
   * `new DataBus({ backend })` 直接测起来，而不用把整个宿主拖进测试。
   */
  constructor(raw: PhysicalStore, bus: DataBus) {
    this.raw = raw;
    this.bus = bus;
  }

  /**
   * 后端名字。
   *
   * 带 `+bus` 后缀是**有意的**：调试面板与顶栏都会显示它，
   * 而「数据到底存在哪」是这个项目反复被问的问题，不该让人猜。
   */
  get backend(): string {
    return `${this.raw.backend}+bus`;
  }

  /**
   * 空操作。
   *
   * 物理层在装配时已经 `init()` 过了（`PluginHost` 的 `restoreData()` 就要读它）。
   * 这里再做一次会让 SQLite 按名字复用连接的行为变得难以推理。
   */
  async init(): Promise<void> {
    return undefined;
  }

  // ---------------------------------------------------------------- 任务

  async listTasks(): Promise<Task[]> {
    const r = this.bus.read(HOST_NS, CORE_ENTITY.task, {
      limit: MAX_RECORDS,
      owner: CORE_NS,
    });
    if (!r.ok) throw new Error(`读取任务失败：${r.code} ${r.message}`);
    return r.data.map(unprojectTask);
  }

  async putTask(t: Task): Promise<void> {
    const r = this.bus.emit(CORE_NS, projectTask(t));
    must(r, '写入任务');
    must(await this.bus.flush(), '落盘任务');
  }

  async deleteTask(id: string): Promise<void> {
    const r = this.bus.drop(CORE_NS, CORE_ENTITY.task, id);
    must(r, '删除任务');
    must(await this.bus.flush(), '落盘任务删除');
  }

  // ---------------------------------------------------------------- 课程

  async listCourses(): Promise<Course[]> {
    const r = this.bus.read(HOST_NS, CORE_ENTITY.course, {
      limit: MAX_RECORDS,
      owner: CORE_NS,
    });
    if (!r.ok) throw new Error(`读取课程失败：${r.code} ${r.message}`);
    return r.data.map(unprojectCourse);
  }

  async putCourse(c: Course): Promise<void> {
    const r = this.bus.emit(CORE_NS, projectCourse(c));
    must(r, '写入课程');
    must(await this.bus.flush(), '落盘课程');
  }

  async deleteCourse(id: string): Promise<void> {
    const r = this.bus.drop(CORE_NS, CORE_ENTITY.course, id);
    must(r, '删除课程');
    must(await this.bus.flush(), '落盘课程删除');
  }

  // ---------------------------------------------------------------- 整体

  /**
   * 清空。
   *
   * 走 `dropPlugin(CORE_NS)` 而不是直接调物理层的 `clearAll()`：那样只有一条路径，
   * 总线里的记录和盘上的数据不会不一致。落盘由 `CoreStoreBackend` 接住。
   */
  async clearAll(): Promise<void> {
    this.bus.dropPlugin(CORE_NS);
    must(await this.bus.flush(), '清空数据');
  }

  /** 行数取自总线 —— 那才是真相。物理层的行数在 flush 失败时会落后 */
  async stats(): Promise<{ tasks: number; courses: number }> {
    const [tasks, courses] = await Promise.all([this.listTasks(), this.listCourses()]);
    return { tasks: tasks.length, courses: courses.length };
  }

  /** 后端自述信息：物理层给什么就报什么，再补上「真相在哪」 */
  async info(): Promise<Record<string, string>> {
    const raw = await this.raw.info();
    return { ...raw, dataLayer: 'bus', physical: this.raw.backend };
  }

  async close(): Promise<void> {
    // 先落盘再关：关掉物理层之后队列里的变更就再也写不进去了
    await this.bus.flush();
    await this.raw.close();
  }
}
