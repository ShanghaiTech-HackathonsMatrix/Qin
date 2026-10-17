/**
 * @capacitor-community/sqlite 的薄封装，实现 SqlDb 接口。
 *
 * 注意（已核对 dist/esm/definitions.d.ts 确认）：
 *   · 加密密钥挂在 **SQLiteConnection** 上（setEncryptionSecret / isSecretStored），
 *     不是挂在连接对象上
 *   · createConnection(database, encrypted, mode, version, readonly) 的 mode 在
 *     TS 类型里是 string，实际取 'no-encryption' | 'encryption' | 'secret' | 'newsecret'
 *
 * ⚠️ mode 的语义坑（真机踩过，务必别再改回去）：
 *   已核对插件 Android 源码 Database.open()：
 *
 *     if (_mode.equals("encryption")) { _uCipher.encrypt(_context, _file, password); }
 *     if (_mode.equals("decryption")) { _uCipher.decrypt(_context, _file, password); }
 *     ...
 *     _db = SQLiteDatabase.openOrCreateDatabase(_file, password, null, null);
 *
 *   'encryption' 的意思是「把**已存在的明文库**就地转换成加密库」，
 *   而不是「新建一个加密库」。新建时文件还不存在，_uCipher.encrypt 会失败，
 *   报出 `Failed in encryption ... not found`。
 *
 *   新建/打开一个常规加密库的正确 mode 是 **'secret'**：
 *   它只负责从已存储的口令里取出密码，然后交给
 *   openOrCreateDatabase 去「打开或创建」。前提是口令已经通过
 *   setEncryptionSecret() 存好（见下面 openSqlite 里的检查）。
 */

import { Capacitor } from '@capacitor/core';
import {
  CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection,
} from '@capacitor-community/sqlite';
import { PlatformError, type SqlDb, type SqlParam } from './types';
import { dropWebSqlite, openWebSqlite, webSqliteSupported } from './web-sqlite';

let shared: SQLiteConnection | null = null;

function conn(): SQLiteConnection {
  if (!shared) shared = new SQLiteConnection(CapacitorSQLite);
  return shared;
}

/**
 * 有没有 SQLite 可以用，以及用的是哪一个引擎。
 *
 * 两个来源：
 *   · 原生端 —— CapacitorSQLite 插件（可带 SQLCipher）
 *   · web 端  —— sql.js（WebAssembly），见 web-sqlite.ts
 *
 * 以前这里只认原生插件，于是浏览器里整条策略链一路降级到 `store.json`，
 * 「已降级」警告在开发环境里永远挂着 —— 而那正是最该验证索引策略的地方。
 *
 * ⚠️ 判断顺序不能反：`@capacitor-community/sqlite` 在 web 上也**注册**了一个
 * 实现（CapacitorSQLiteWeb），所以 `isPluginAvailable('CapacitorSQLite')` 在
 * 浏览器里同样返回 true。只看它会把 web 误判成原生，然后因为缺少
 * `<jeep-sqlite>` 元素而失败。必须先判平台。
 */
export function sqliteEngine(): 'native' | 'wasm' | 'none' {
  if (Capacitor.getPlatform() !== 'web' && Capacitor.isPluginAvailable('CapacitorSQLite')) return 'native';
  if (webSqliteSupported()) return 'wasm';
  return 'none';
}

export function sqliteAvailable(): boolean {
  return sqliteEngine() !== 'none';
}

class CapacitorSqlDb implements SqlDb {
  constructor(private db: SQLiteDBConnection, readonly name: string, readonly encrypted: boolean) {}

  async exec(sql: string): Promise<void> {
    // 建表/建索引/建触发器可能一次多条，execute 支持分号分隔的多语句
    await this.db.execute(sql);
  }

  async all<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    const res = await this.db.query(sql, params as unknown[]);
    return ((res?.values ?? []) as T[]);
  }

  async run(sql: string, params: SqlParam[] = []): Promise<void> {
    await this.db.run(sql, params as unknown[]);
  }

  async info(): Promise<Record<string, string>> {
    const out: Record<string, string> = {
      backend: 'capacitor-community/sqlite',
      encrypted: String(this.encrypted),
      database: this.name,
    };
    try {
      const r = await this.db.query('SELECT sqlite_version() AS v');
      out.sqliteVersion = String((r?.values?.[0] as { v?: unknown })?.v ?? '?');
    } catch (e) {
      out.sqliteVersion = `查询失败: ${e instanceof Error ? e.message : String(e)}`;
    }
    try {
      const r = await this.db.query('PRAGMA compile_options');
      const flags = ((r?.values ?? []) as Array<Record<string, unknown>>)
        .map((row) => String(row.compile_options ?? ''));
      out.json1 = String(flags.some((f) => /JSON/i.test(f)));
      out.fts5 = String(flags.some((f) => /FTS5/i.test(f)));
      out.sqlcipher = String(flags.some((f) => /cipher/i.test(f)));
      out.compileOptionCount = String(flags.length);
    } catch (e) {
      out.compileOptions = `查询失败: ${e instanceof Error ? e.message : String(e)}`;
    }
    return out;
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  /** 删除底层数据库文件（仅用于 probe 清理与「清空数据」） */
  async destroy(): Promise<void> {
    await this.db.close().catch(() => undefined);
    await this.db.delete().catch(() => undefined);
  }
}

export interface OpenOptions {
  name: string;
  encrypted: boolean;
  /** encrypted 为 true 时必填 */
  passphrase?: string;
  version?: number;
}

/**
 * 打开（或复用）一个数据库连接。
 * 已存在同名连接时直接复用，避免 "Connection already exists"。
 */
export async function openSqlite(opts: OpenOptions): Promise<SqlDb> {
  const engine = sqliteEngine();
  if (engine === 'none') {
    throw new PlatformError('EUNSUPPORTED', '没有可用的 SQLite 引擎（原生插件与 web 的 sql.js 都不可用）');
  }

  // web 端没有 SQLCipher：sql.js 只编了普通 SQLite。
  // 明确报出来，让 store.sqlcipher 的探测失败并降级到 store.sqlite —— 而不是假装加密成功。
  if (engine === 'wasm') {
    if (opts.encrypted) {
      throw new PlatformError('EUNSUPPORTED', 'web 端的 sql.js 未编译 SQLCipher，无法提供加密数据库');
    }
    return openWebSqlite(opts.name);
  }

  const c = conn();
  const version = opts.version ?? 1;

  if (opts.encrypted) {
    if (!opts.passphrase) throw new PlatformError('ESCHEMA', '加密连接缺少口令');
    const stored = await c.isSecretStored().catch(() => ({ result: false }));
    if (!stored?.result) {
      await c.setEncryptionSecret(opts.passphrase);
    } else {
      // 插件里已有一个口令。如果它和 KV 里的不一致，说明两边已经跑偏，
      // 此时继续下去只会打不开库或更糟（用错口令覆盖），所以直接中止。
      const matches = await c.checkEncryptionSecret(opts.passphrase).catch(() => ({ result: true }));
      if (!matches?.result) {
        throw new PlatformError(
          'ESCHEMA',
          '插件内已存有另一个加密口令，与 KV 中的数据库口令不一致；' +
          '继续会打不开已有数据库，已中止',
        );
      }
    }
  }

  // 连接一致性自检：WebView 重载后插件侧可能残留连接表
  await c.checkConnectionsConsistency().catch(() => undefined);

  const existing = await c.isConnection(opts.name, false).catch(() => ({ result: false }));
  let db: SQLiteDBConnection;
  if (existing?.result) {
    db = await c.retrieveConnection(opts.name, false);
  } else {
    db = await c.createConnection(
      opts.name,
      opts.encrypted,
      opts.encrypted ? 'secret' : 'no-encryption',
      version,
      false,
    );
  }

  const isOpen = await db.isDBOpen().catch(() => ({ result: false }));
  if (!isOpen?.result) await db.open();

  return new CapacitorSqlDb(db, opts.name, opts.encrypted);
}

/**
 * 删除数据库文件并释放连接（probe 清理与「清空数据」用）。
 *
 * encrypted 必须与建库时一致：对加密库用 'no-encryption' 去建连接，
 * 插件侧会因为拿不到口令而报错，文件就删不掉了。
 */
export async function dropSqlite(name: string, encrypted = false): Promise<void> {
  const engine = sqliteEngine();
  if (engine === 'none') return;
  if (engine === 'wasm') {
    await dropWebSqlite(name);
    return;
  }
  const c = conn();
  try {
    const existing = await c.isConnection(name, false);
    const db = existing?.result
      ? await c.retrieveConnection(name, false)
      : await c.createConnection(
          name,
          encrypted,
          encrypted ? 'secret' : 'no-encryption',
          1,
          false,
        );
    await db.close().catch(() => undefined);
    await db.delete().catch(() => undefined);
  } catch {
    // 忽略：可能本来就不存在
  }
  // 让插件忘掉这个连接名，否则下次同名 probe 会撞上 "Connection already exists"
  try {
    await c.closeConnection(name, false);
  } catch {
    // 忽略
  }
}
