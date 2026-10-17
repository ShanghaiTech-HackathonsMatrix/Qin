import type { Course, Task } from '../../../domain/types';
import { NS } from '../../sql/compiler';
import { openSqlite, sqliteAvailable } from '../../sql/connect';
import { PlatformError, type QueryCompiler, type SqlDb } from '../../sql/types';
import type { IndexingStrategy } from '../indexing/types';
import { getOrCreateDbPassphrase, type StoreDeps, type TaskStore } from './types';

/**
 * 加密库与明文库**必须用不同的文件名**。
 *
 * 它们曾经共用 `matrix_timeline`：从加密策略切到明文策略时，
 * 明文连接会去打开一个 SQLCipher 加密过的文件 —— 轻则 "file is not a database"，
 * 重则把文件写坏。分开之后两者互不干扰，也正好符合
 * 「每个后端各自持有数据、切换不做隐式迁移」的模型。
 */
const DB_NAME_ENC = 'matrix_timeline_enc';
const DB_NAME_PLAIN = 'matrix_timeline';
const MAX_ROWS = 200;

/** SQLite 后端：JSON 文档 + 可插拔索引策略，可选 SQLCipher 加密。 */
export class SqliteStore implements TaskStore {
  private constructor(
    private db: SqlDb,
    private compiler: QueryCompiler,
    private index: IndexingStrategy,
    readonly backend: string,
  ) {}

  static async open(encrypted: boolean, deps: StoreDeps): Promise<SqliteStore> {
    if (!sqliteAvailable()) {
      throw new PlatformError('EUNSUPPORTED', 'CapacitorSQLite 插件不可用');
    }
    if (!deps.indexing) {
      throw new PlatformError('EUNSUPPORTED', '没有可用的索引策略，无法建表');
    }

    let passphrase: string | undefined;
    if (encrypted) {
      if (!deps.kv) throw new PlatformError('EUNSUPPORTED', '加密存储需要 KV 策略提供口令');
      passphrase = await getOrCreateDbPassphrase(deps.kv);
    }

    const name = encrypted ? DB_NAME_ENC : DB_NAME_PLAIN;
    const db = await openSqlite({ name, encrypted, passphrase });
    const setup = await deps.indexing.setup(db, NS);

    const backend = `sqlite${encrypted ? '+sqlcipher' : ''}/${deps.indexing.mode}`;
    return new SqliteStore(db, setup.compiler, deps.indexing, backend);
  }

  /** 建表已在 open() 中完成 */
  async init(): Promise<void> { /* no-op */ }

  async listTasks(): Promise<Task[]> {
    const { sql, params } = this.compiler.find('task', undefined, { limit: MAX_ROWS });
    const rows = await this.db.all<{ doc: string }>(sql, params);
    return rows.map((r) => JSON.parse(r.doc) as Task).sort(byDue);
  }

  async putTask(t: Task): Promise<void> {
    const { sql, params } = this.compiler.upsert('task', t.id, t, Date.now());
    await this.db.run(sql, params);
  }

  async deleteTask(id: string): Promise<void> {
    const { sql, params } = this.compiler.remove('task', id);
    await this.db.run(sql, params);
  }

  async listCourses(): Promise<Course[]> {
    const { sql, params } = this.compiler.find('course', undefined, { limit: MAX_ROWS });
    const rows = await this.db.all<{ doc: string }>(sql, params);
    return rows.map((r) => JSON.parse(r.doc) as Course)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  async putCourse(c: Course): Promise<void> {
    const { sql, params } = this.compiler.upsert('course', c.id, c, Date.now());
    await this.db.run(sql, params);
  }

  async deleteCourse(id: string): Promise<void> {
    const { sql, params } = this.compiler.remove('course', id);
    await this.db.run(sql, params);
  }

  async clearAll(): Promise<void> {
    await this.db.exec(`DELETE FROM plugin_${NS}_task; DELETE FROM plugin_${NS}_course;`);
  }

  async stats(): Promise<{ tasks: number; courses: number }> {
    const t = await this.compiler.count('task');
    const c = await this.compiler.count('course');
    const tr = await this.db.all<{ n: number }>(t.sql, t.params);
    const cr = await this.db.all<{ n: number }>(c.sql, c.params);
    return { tasks: Number(tr[0]?.n ?? 0), courses: Number(cr[0]?.n ?? 0) };
  }

  async info(): Promise<Record<string, string>> {
    const base = await this.db.info();
    return { ...base, indexStrategy: this.index.id, indexMode: this.index.mode };
  }

  async close(): Promise<void> {
    await this.db.close().catch(() => undefined);
  }
}

function byDue(a: Task, b: Task): number {
  if (a.dueAt === b.dueAt) return a.createdAt - b.createdAt;
  if (a.dueAt === null) return 1;      // 无期限的排最后
  if (b.dueAt === null) return -1;
  return a.dueAt - b.dueAt;
}
