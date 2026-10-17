/// <reference types="vite/client" />

/**
 * Web 端的 SQLite 实现（sql.js / WebAssembly）。
 *
 * 为什么需要它：
 *   浏览器里没有 CapacitorSQLite 原生插件，过去整条策略链会一路降级到
 *   `store.json` —— 于是「生成列 + 索引」「影子表 + 触发器」这两个索引策略
 *   在开发环境里从来没被真正跑过，只有上真机才知道对不对。
 *   把 sql.js 接进来之后，web 上跑的是**真的 SQLite**（同样的 DDL、同样的
 *   查询编译器、同样的往返探测），只是引擎换成了 WASM。
 *
 * 明确的边界（不要在这里假装）：
 *   · 没有 SQLCipher —— sql.js 不带加密模块，所以 `store.sqlcipher` 在 web 上
 *     必然探测失败，降级到 `store.sqlite`。这是正确行为，不是 bug。
 *   · 没有文件系统 —— 库是内存里的字节数组，靠 IndexedDB 落盘。
 *   · 没有多连接/并发 —— 一个名字对应一个 Database 实例。
 */

import { Capacitor } from '@capacitor/core';
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { PlatformError, type SqlDb, type SqlParam } from './types';

// ---------------------------------------------------------------- 引擎加载

let engine: Promise<SqlJsStatic> | null = null;

/** 只初始化一次。WASM 有几百 KB，重复加载会明显拖慢启动。 */
function loadEngine(): Promise<SqlJsStatic> {
  if (engine === null) {
    engine = initSqlJs({ locateFile: () => wasmUrl }).catch((e: unknown) => {
      engine = null;   // 失败不缓存，下次还能重试
      throw new PlatformError('EUNSUPPORTED', `sql.js 初始化失败: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
  return engine;
}

export function webSqliteSupported(): boolean {
  return Capacitor.getPlatform() === 'web' && typeof indexedDB !== 'undefined';
}

// ---------------------------------------------------------------- 落盘

/**
 * 内存库的持久化。
 *
 * 用 IndexedDB 而不是 localStorage：数据库是二进制、而且会随数据增长，
 * localStorage 的 5MB 文本配额和 base64 膨胀（+33%）都很容易撞墙。
 */
const IDB_NAME = 'matrix.sqlite';
const IDB_STORE = 'files';
const IDB_VERSION = 1;

let idb: Promise<IDBDatabase | null> | null = null;

function openIdb(): Promise<IDBDatabase | null> {
  if (idb === null) {
    idb = new Promise<IDBDatabase | null>((resolve) => {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(IDB_NAME, IDB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      // 隐私模式等场景下 IndexedDB 会直接拒绝。此时不阻塞主流程，只是不落盘。
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }
  return idb;
}

async function idbGet(key: string): Promise<Uint8Array | null> {
  const db = await openIdb();
  if (db === null) return null;
  return new Promise<Uint8Array | null>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const value: unknown = req.result;
        resolve(value instanceof Uint8Array ? value : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbPut(key: string, bytes: Uint8Array): Promise<void> {
  const db = await openIdb();
  if (db === null) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(bytes, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function idbDelete(key: string): Promise<void> {
  const db = await openIdb();
  if (db === null) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** 探测用的临时库不落盘 —— 它们下一秒就被删掉了 */
function isTransient(name: string): boolean {
  return name.startsWith('__matrix_probe');
}

// ---------------------------------------------------------------- 连接

/** 每个名字一个实例。同一名字重复 open 时复用，避免两份数据互相覆盖。 */
const instances = new Map<string, WebSqlDb>();

class WebSqlDb implements SqlDb {
  /** 排队中的落盘。close() 会等它，避免「关掉就丢最后一次写入」 */
  private flushing: Promise<void> = Promise.resolve();
  private flushTimer: number | null = null;
  private dirty = false;

  private constructor(private db: Database, readonly name: string) {}

  static async open(name: string): Promise<WebSqlDb> {
    const existing = instances.get(name);
    if (existing !== undefined) return existing;

    const SQL = await loadEngine();
    const saved = isTransient(name) ? null : await idbGet(name);
    let database: Database;
    try {
      database = saved !== null ? new SQL.Database(saved) : new SQL.Database();
    } catch (e) {
      // 落盘的字节损坏时不要静默清空：先备份，再开新库。
      await idbPut(`${name}.corrupt.${Date.now()}`, saved ?? new Uint8Array());
      await idbDelete(name);
      database = new SQL.Database();
      if (saved !== null) {
        console.warn(
          `[sqlite] 数据库 ${name} 读取失败，已备份并新建：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const db = new WebSqlDb(database, name);
    instances.set(name, db);
    return db;
  }

  // -------------------------------------------------------------- SqlDb

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
    this.schedulePersist();
  }

  async all<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    try {
      if (params.length > 0) stmt.bind(params as SqlValue[]);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      return rows;
    } finally {
      stmt.free();
    }
  }

  async run(sql: string, params: SqlParam[] = []): Promise<void> {
    this.db.run(sql, params as SqlValue[]);
    this.schedulePersist();
  }

  async info(): Promise<Record<string, string>> {
    const out: Record<string, string> = {
      backend: 'sql.js (WebAssembly)',
      encrypted: 'false',
      database: this.name,
      persistent: String(!isTransient(this.name)),
    };
    try {
      const rows = await this.all<{ v: SqlValue }>('SELECT sqlite_version() AS v');
      out.sqliteVersion = String(rows[0]?.v ?? '?');
    } catch (e) {
      out.sqliteVersion = `查询失败: ${e instanceof Error ? e.message : String(e)}`;
    }
    try {
      const rows = await this.all<{ compile_options: SqlValue }>('PRAGMA compile_options');
      const flags = rows.map((r) => String(r.compile_options ?? ''));
      out.json1 = String(flags.some((f) => /JSON/i.test(f)));
      out.fts5 = String(flags.some((f) => /FTS5/i.test(f)));
      out.sqlcipher = String(flags.some((f) => /cipher/i.test(f)));
      out.compileOptionCount = String(flags.length);
    } catch (e) {
      out.compileOptions = `查询失败: ${e instanceof Error ? e.message : String(e)}`;
    }
    out.sizeBytes = String(this.db.export().length);
    return out;
  }

  async close(): Promise<void> {
    await this.flush();
    this.db.close();
    instances.delete(this.name);
  }

  /** 删除库：关闭 + 清掉落盘字节 */
  async destroy(): Promise<void> {
    await this.flush();
    try { this.db.close(); } catch { /* 已关闭 */ }
    instances.delete(this.name);
    await idbDelete(this.name);
  }

  // -------------------------------------------------------------- 落盘调度

  private schedulePersist(): void {
    if (isTransient(this.name)) return;
    this.dirty = true;
    if (this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 60);
  }

  /** 把当前库导出并写进 IndexedDB。串行执行，避免两次导出交错。 */
  private flush(): Promise<void> {
    if (isTransient(this.name) || !this.dirty) return this.flushing;
    this.dirty = false;
    const bytes = this.db.export();
    this.flushing = this.flushing.then(() => idbPut(this.name, bytes)).catch(() => undefined);
    return this.flushing;
  }
}

export async function openWebSqlite(name: string): Promise<SqlDb> {
  return WebSqlDb.open(name);
}

/** 删除一个 web 端数据库（含落盘字节）。名字从未打开过时只清 IndexedDB。 */
export async function dropWebSqlite(name: string): Promise<void> {
  const existing = instances.get(name);
  if (existing !== undefined) {
    await existing.destroy();
    return;
  }
  await idbDelete(name);
}
