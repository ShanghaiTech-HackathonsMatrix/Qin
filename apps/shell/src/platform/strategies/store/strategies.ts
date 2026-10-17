import { dropSqlite, openSqlite, sqliteAvailable } from '../../sql/connect';
import type { SqlDb } from '../../sql/types';
import type { ProbeResult, Strategy } from '../types';
import { JsonStore } from './json';
import { SqliteStore } from './sqlite';
import { getOrCreateDbPassphrase, type StoreDeps, type TaskStore } from './types';

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 一次性临时库上的写-读往返 */
async function roundTrip(db: SqlDb): Promise<string | null> {
  await db.exec('CREATE TABLE IF NOT EXISTS t(id TEXT PRIMARY KEY, v TEXT NOT NULL)');
  await db.run('INSERT OR REPLACE INTO t(id, v) VALUES (?, ?)', ['k', 'sentinel']);
  const rows = await db.all<{ v: string }>('SELECT v FROM t WHERE id = ?', ['k']);
  if (rows[0]?.v !== 'sentinel') return `往返值不一致（读回 ${String(rows[0]?.v)}）`;
  return null;
}

/**
 * 理想实现：SQLCipher 加密库。
 *
 * 两个关键点：
 *   1. 用**正式口令**探测（见 types.ts 里 probe 的注释），避免污染插件全局密钥槽
 *   2. 额外用 PRAGMA cipher_version 确认原生库里真的编了 SQLCipher ——
 *      因为「连接能用」不等于「数据真被加密」，这是最容易出现的假阳性
 */
export const sqlcipherStore: Strategy<TaskStore, StoreDeps> = {
  slot: 'store',
  id: 'store.sqlcipher',
  label: 'SQLite + SQLCipher（加密）',
  tier: 'ideal',
  order: 10,
  note: '经 @capacitor-community/sqlite 落到 net.zetetic:sqlcipher-android，口令存于 KV 策略',

  async probe(deps: StoreDeps): Promise<ProbeResult> {
    if (!sqliteAvailable()) return { ok: false, reason: 'CapacitorSQLite 插件不可用' };
    if (!deps.kv) return { ok: false, reason: '没有可用的 KV 策略，无处保存数据库口令' };
    if (!deps.indexing) return { ok: false, reason: '没有可用的索引策略，无法建表' };

    let passphrase: string;
    try {
      passphrase = await getOrCreateDbPassphrase(deps.kv);
    } catch (e) {
      return { ok: false, reason: `口令存取失败: ${msg(e)}` };
    }

    const name = `__matrix_probe_enc_${Date.now()}`;
    let db: SqlDb | null = null;
    try {
      db = await openSqlite({ name, encrypted: true, passphrase });
      const bad = await roundTrip(db);
      if (bad) return { ok: false, reason: bad };

      let cipher = '';
      let cipherKnown = true;
      try {
        const rows = await db.all<Record<string, unknown>>('PRAGMA cipher_version');
        cipher = String(Object.values(rows[0] ?? {})[0] ?? '');
      } catch {
        cipherKnown = false;   // 某些实现不允许在 query 里跑 PRAGMA
      }

      await db.close();
      db = null;
      await dropSqlite(name, true).catch(() => undefined);

      if (cipherKnown && !cipher) {
        return {
          ok: false,
          reason: '连接可用但 PRAGMA cipher_version 为空 —— 原生库未编译 SQLCipher，数据实际是明文',
        };
      }
      const keyNote = deps.kv.encrypted
        ? '口令由系统安全存储保护'
        : '⚠️ 口令与数据库同处明文存储，加密收益有限';
      return {
        ok: true,
        detail: `往返正常；SQLCipher ${cipher || '(版本未知，未能确认)'}；${keyNote}`,
      };
    } catch (e) {
      return { ok: false, reason: `加密库不可用: ${msg(e)}` };
    } finally {
      try { await db?.close(); } catch { /* 忽略 */ }
      await dropSqlite(name, true).catch(() => undefined);
    }
  },

  create: (deps) => SqliteStore.open(true, deps),
};

/** 降级：普通 SQLite，功能全但数据不加密。 */
export const plainSqliteStore: Strategy<TaskStore, StoreDeps> = {
  slot: 'store',
  id: 'store.sqlite',
  label: 'SQLite（未加密）',
  tier: 'fallback',
  order: 10,
  note: '同样的 JSON 文档 + 索引策略，但数据库文件是明文',

  async probe(deps: StoreDeps): Promise<ProbeResult> {
    if (!sqliteAvailable()) return { ok: false, reason: 'CapacitorSQLite 插件不可用' };
    if (!deps.indexing) return { ok: false, reason: '没有可用的索引策略，无法建表' };

    const name = `__matrix_probe_plain_${Date.now()}`;
    let db: SqlDb | null = null;
    try {
      db = await openSqlite({ name, encrypted: false });
      const bad = await roundTrip(db);
      if (bad) return { ok: false, reason: bad };
      await db.close();
      db = null;
      await dropSqlite(name).catch(() => undefined);
      return { ok: true, detail: '往返正常（数据未加密）' };
    } catch (e) {
      return { ok: false, reason: `SQLite 不可用: ${msg(e)}` };
    } finally {
      try { await db?.close(); } catch { /* 忽略 */ }
      await dropSqlite(name).catch(() => undefined);
    }
  },

  create: (deps) => SqliteStore.open(false, deps),
};

/** 降级：KV 之上的 JSON 文档库。web 端与 SQLite 全挂时的后端。 */
export const jsonStoreStrategy: Strategy<TaskStore, StoreDeps> = {
  slot: 'store',
  id: 'store.json',
  label: 'JSON 文档库（KV 后端）',
  tier: 'fallback',
  // 20 而不是 10：普通 SQLite（有事务有索引）必须排在它前面。
  // 早先靠 id 字母序排序时，'store.json' < 'store.sqlite'，它抢走了降级名额 —— 已在真机上复现。
  order: 20,
  note: '无事务无索引，但任何平台都能用；数据量大时性能下降',

  async probe(deps: StoreDeps): Promise<ProbeResult> {
    if (!deps.kv) return { ok: false, reason: '没有可用的 KV 策略' };
    const k = `__probe_json_${Date.now()}`;
    try {
      const payload = JSON.stringify({ t: [1, 2, 3], zh: '中文往返' });
      await deps.kv.set(k, payload);
      const back = await deps.kv.get(k);
      await deps.kv.remove(k);
      if (back !== payload) return { ok: false, reason: 'JSON 往返不一致' };
      return { ok: true, detail: `往返正常（${deps.kv.encrypted ? '底层加密' : '底层未加密'}）` };
    } catch (e) {
      return { ok: false, reason: `KV 读写失败: ${msg(e)}` };
    }
  },

  create: (deps) => JsonStore.open(deps.kv),
};
