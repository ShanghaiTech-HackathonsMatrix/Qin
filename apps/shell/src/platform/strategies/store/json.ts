import type { Course, Task } from '../../../domain/types';
import { PlatformError } from '../../sql/types';
import type { SecureStore } from '../kv/types';
import type { TaskStore } from './types';

const K_TASKS = 'store.tasks';
const K_COURSES = 'store.courses';
const K_SCHEMA = 'store.schema';
const SCHEMA_VERSION = 1;

/**
 * 降级实现：把整个文档集合序列化后存进 KV。
 *
 * 什么时候会用到它？
 *   1. web/浏览器端（没有 CapacitorSQLite 插件）—— 这也是开发时的默认后端
 *   2. 实机上 SQLite 或 SQLCipher 整体不可用
 *
 * 代价很明确：没有事务、没有索引、数据量大了会变慢。
 * 所以它在自检报告里会显式标出「已降级」。
 */
export class JsonStore implements TaskStore {
  readonly backend = 'json-doc';
  private tasks: Task[] = [];
  private courses: Course[] = [];

  private constructor(private kv: SecureStore) {}

  static async open(kv: SecureStore | null): Promise<JsonStore> {
    if (!kv) throw new PlatformError('EUNSUPPORTED', 'JSON 存储需要 KV 策略');
    const s = new JsonStore(kv);
    await s.init();
    return s;
  }

  async init(): Promise<void> {
    const v = await this.kv.get(K_SCHEMA);
    if (v !== String(SCHEMA_VERSION)) {
      await this.kv.set(K_SCHEMA, String(SCHEMA_VERSION));
    }
    this.tasks = await this.load<Task>(K_TASKS);
    this.courses = await this.load<Course>(K_COURSES);
  }

  private async load<T>(key: string): Promise<T[]> {
    const raw = await this.kv.get(key);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      // 数据损坏时不要静默丢数据 —— 挪到 .corrupt 备份键下，报告里可见
      await this.kv.set(`${key}.corrupt.${Date.now()}`, raw);
      await this.kv.remove(key);
      return [];
    }
  }

  async listTasks(): Promise<Task[]> {
    return [...this.tasks].sort(byDue);
  }

  async putTask(t: Task): Promise<void> {
    const i = this.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) this.tasks[i] = t; else this.tasks.push(t);
    await this.flushTasks();
  }

  async deleteTask(id: string): Promise<void> {
    this.tasks = this.tasks.filter((x) => x.id !== id);
    await this.flushTasks();
  }

  async listCourses(): Promise<Course[]> {
    return [...this.courses].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  async putCourse(c: Course): Promise<void> {
    const i = this.courses.findIndex((x) => x.id === c.id);
    if (i >= 0) this.courses[i] = c; else this.courses.push(c);
    await this.flushCourses();
  }

  async deleteCourse(id: string): Promise<void> {
    this.courses = this.courses.filter((x) => x.id !== id);
    await this.flushCourses();
  }

  async clearAll(): Promise<void> {
    this.tasks = [];
    this.courses = [];
    await this.flushTasks();
    await this.flushCourses();
  }

  async stats(): Promise<{ tasks: number; courses: number }> {
    return { tasks: this.tasks.length, courses: this.courses.length };
  }

  async info(): Promise<Record<string, string>> {
    const raw = await this.kv.get(K_TASKS);
    return {
      backend: 'json-doc (KV)',
      schemaVersion: String(SCHEMA_VERSION),
      tasksBytes: String(raw ? raw.length : 0),
      note: '无事务、无索引；数据量大时性能会下降',
    };
  }

  async close(): Promise<void> { /* 无连接可关 */ }

  private flushTasks(): Promise<void> { return this.kv.set(K_TASKS, JSON.stringify(this.tasks)); }
  private flushCourses(): Promise<void> { return this.kv.set(K_COURSES, JSON.stringify(this.courses)); }
}

function byDue(a: Task, b: Task): number {
  if (a.dueAt === b.dueAt) return a.createdAt - b.createdAt;
  if (a.dueAt === null) return 1;
  if (b.dueAt === null) return -1;
  return a.dueAt - b.dueAt;
}
