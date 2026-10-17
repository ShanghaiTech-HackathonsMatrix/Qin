import { COLLECTIONS, ddlFor, makeCompiler, NS, type IndexMode } from '../../sql/compiler';
import { dropSqlite, openSqlite, sqliteAvailable } from '../../sql/connect';
import type { SqlDb } from '../../sql/types';
import type { ProbeResult, Strategy } from '../types';
import type { IndexingStrategy } from './types';

/**
 * 共享 probe：在一次性临时库里把该索引模式的完整链路跑一遍
 * （建表 → 建索引/触发器 → 写 3 行 → 带过滤和排序查回来 → 清理）。
 *
 * 只验证「能不能用、结果对不对」，不验证性能 —— 性能结论在 P0-S1 里已有。
 */
async function probeIndexMode(mode: IndexMode): Promise<ProbeResult> {
  if (!sqliteAvailable()) {
    return { ok: false, reason: '没有可用的 SQLite 引擎（原生插件与 web 的 sql.js 都不可用）' };
  }

  const dbName = `__matrix_probe_${mode}_${Date.now()}`;
  const ns = 'probe';
  const spec = COLLECTIONS[0]!;
  let db: SqlDb | null = null;

  try {
    db = await openSqlite({ name: dbName, encrypted: false });

    // ① DDL
    const ddl = ddlFor(ns, spec, mode);
    for (const stmt of ddl) await db.exec(stmt);

    // ② 写入
    const compiler = makeCompiler(ns, [spec], mode);
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const doc = {
        kind: 'ddl', title: `探针${i}`, courseId: null,
        dueAt: 1_000_000 + i * 1000, status: i === 2 ? 'done' : 'open',
      };
      const { sql, params } = compiler.upsert('task', `probe-${i}`, doc, now);
      await db.run(sql, params);
    }

    // ③ 过滤 + 排序查回来
    const { sql, params } = compiler.find(
      'task',
      { and: [{ field: 'status', eq: 'open' }, { field: 'dueAt', gte: 1_000_000 }] },
      { orderBy: [{ field: 'dueAt', dir: 'asc' }], limit: 10 },
    );
    const rows = await db.all<{ doc: string; due_at: number }>(sql, params);
    if (rows.length !== 2) {
      return { ok: false, reason: `过滤查询返回 ${rows.length} 行，期望 2 行` };
    }
    const order = rows.map((r) => Number(r.due_at));
    if (order[0]! > order[1]!) {
      return { ok: false, reason: `排序未生效: ${JSON.stringify(order)}` };
    }

    // ④ 确认没有把非 JSON 值塞进索引列（影子表最容易在这里出错）
    const raw = await db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM plugin_${ns}_task WHERE json_extract(doc, '$.status') = 'open'`,
    );
    if (Number(raw[0]?.n ?? -1) !== 2) {
      return { ok: false, reason: `原始 JSON 查询与编译查询结果不一致` };
    }

    // ⑤ 索引命中（尽力而为：不同版本对 EXPLAIN 的支持不同，失败不算探测失败）
    let planNote = '未取到执行计划';
    try {
      const plan = await db.all<Record<string, unknown>>(`EXPLAIN QUERY PLAN ${sql}`, params);
      const text = plan.map((r) => String(r.detail ?? Object.values(r)[3] ?? '')).join(' | ');
      planNote = text.includes('USING INDEX') || text.includes('USING COVERING INDEX')
        ? '命中索引'
        : `未命中索引（${text || '空计划'}）`;
    } catch {
      planNote = '执行计划不可读';
    }

    return { ok: true, detail: `往返正常，${planNote}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `${mode} 模式建表/查询失败: ${msg}` };
  } finally {
    try {
      await db?.close();
    } catch { /* 忽略 */ }
    await dropSqlite(dbName).catch(() => undefined);
  }
}

/** 主方案：生成列 + 索引。要求 SQLite ≥ 3.31。 */
export const generatedColumnsIndex: Strategy<IndexingStrategy> = {
  slot: 'indexing',
  id: 'indexing.generated-columns',
  label: '生成列 + 索引（主方案）',
  tier: 'ideal',
  order: 10,
  note: 'JSON 文档 + GENERATED ALWAYS AS (...) VIRTUAL + 普通索引，要求 SQLite ≥ 3.31',

  probe: () => probeIndexMode('generated'),

  async create(): Promise<IndexingStrategy> {
    return {
      id: 'indexing.generated-columns',
      label: '生成列 + 索引',
      note: 'GENERATED ALWAYS AS (json_extract(...)) VIRTUAL',
      mode: 'generated',
      async setup(db: SqlDb, ns: string) {
        const stmts = COLLECTIONS.flatMap((spec) => ddlFor(ns, spec, 'generated'));
        for (const s of stmts) await db.exec(s);
        return { compiler: makeCompiler(ns, COLLECTIONS, 'generated'), statements: stmts.length };
      },
    };
  },
};

/** 退路：影子表 + 触发器 + 索引。兼容老 SQLite。 */
export const shadowTableIndex: Strategy<IndexingStrategy> = {
  slot: 'indexing',
  id: 'indexing.shadow-table',
  label: '影子表 + 触发器（退路）',
  tier: 'fallback',
  order: 10,
  note: '索引列放独立影子表，由触发器同步；兼容任意 SQLite 版本',

  probe: () => probeIndexMode('shadow'),

  async create(): Promise<IndexingStrategy> {
    return {
      id: 'indexing.shadow-table',
      label: '影子表 + 触发器',
      note: 'plugin_<ns>_<coll>_ix 由 AFTER INSERT/UPDATE/DELETE 触发器维护',
      mode: 'shadow',
      async setup(db: SqlDb, ns: string) {
        const stmts = COLLECTIONS.flatMap((spec) => ddlFor(ns, spec, 'shadow'));
        for (const s of stmts) await db.exec(s);
        return { compiler: makeCompiler(ns, COLLECTIONS, 'shadow'), statements: stmts.length };
      },
    };
  },
};

/** 供 store 策略在 web 端直接使用（不经过探测） */
export const NS_FOR_STORE = NS;
