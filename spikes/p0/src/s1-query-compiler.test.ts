/**
 * S1b —— 查询 DSL → 参数化 SQL 编译器，在真实 SQLite 上验证
 *
 * 要证明三件事：
 *   A. 编译出的 SQL 完全参数化，字段名/集合名/排序方向都过白名单 —— 注入与越界不可能。
 *   B. 主方案（JSON generated column + 索引）查询**命中索引**。
 *   C. 退路方案（影子索引表 + 触发器）与主方案**结果完全一致**，且同样命中索引。
 *      → 万一 @capacitor-community/sqlite 不支持 generated column，S1 也不会阻塞项目。
 *
 * 运行：node src/s1-query-compiler.test.ts   （Node 24 原生类型擦除，无需构建）
 */

import { DatabaseSync } from 'node:sqlite';
import { strict as assert } from 'node:assert';

// ============================================================ 契约（与 docs/design/api-v1.d.ts 对齐）

type Scalar = string | number | boolean | null;

type Where =
  | { and: Where[] } | { or: Where[] } | { not: Where }
  | { field: string; eq: Scalar } | { field: string; ne: Scalar }
  | { field: string; in: Scalar[] }
  | { field: string; gt: number } | { field: string; gte: number }
  | { field: string; lt: number } | { field: string; lte: number }
  | { field: string; contains: string } | { field: string; exists: boolean };

interface FindOpts {
  orderBy?: Array<{ field: string; dir: 'asc' | 'desc' }>;
  limit?: number;
  offset?: number;
}

class PluginError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'PluginError';
  }
}

interface FieldSpec { col: string; type: 'INTEGER' | 'REAL' | 'TEXT' }
interface CollectionSpec {
  name: string;
  fields: Record<string, FieldSpec>;
  indexed: string[];
}

type Strategy = 'generated' | 'shadow';

// ============================================================ 编译器

const MAX_LIMIT = 200;

class QueryCompiler {
  ns: string;
  specs: Map<string, CollectionSpec>;
  strategy: Strategy;

  constructor(ns: string, specs: CollectionSpec[], strategy: Strategy) {
    this.ns = ns;
    this.strategy = strategy;
    // 归一化：字段表一律用 null 原型对象，杜绝 __proto__ / constructor 之类
    // 从 Object.prototype 上"继承"出真值而绕过白名单（见下方 [原型污染] 用例）
    this.specs = new Map(
      specs.map((s) => [s.name, { ...s, fields: Object.assign(Object.create(null), s.fields) }]),
    );
  }

  tableName(name: string): string {
    // 集合名必须已声明 —— 否则连表名都拼不出来，注入面为零
    if (!this.specs.has(name)) throw new PluginError('EPERM', `未声明的集合: ${name}`);
    return `plugin_${this.ns}_${name}`;
  }

  ixTableName(name: string): string {
    return `${this.tableName(name)}_ix`;
  }

  #spec(name: string): CollectionSpec {
    const s = this.specs.get(name);
    if (!s) throw new PluginError('EPERM', `未声明的集合: ${name}`);
    return s;
  }

  #col(spec: CollectionSpec, field: string): string {
    // 必须用 Object.hasOwn，不能只做真值判断：
    //   spec.fields['__proto__']   → Object.prototype（真值，会绕过白名单）
    //   spec.fields['constructor'] → Function（同样是真值）
    if (typeof field !== 'string' || !Object.hasOwn(spec.fields, field)) {
      throw new PluginError('EPERM', `集合 ${spec.name} 未声明字段: ${String(field)}`);
    }
    return spec.fields[field].col;
  }

  #scalar(v: unknown): Scalar {
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string' || t === 'number') return v as Scalar;
    // SQLite 无布尔类型，统一转 0/1，避免驱动层报错
    if (t === 'boolean') return v ? 1 : 0;
    throw new PluginError('ESCHEMA', `只接受标量参数，收到 ${t}`);
  }

  /** WHERE → SQL 片段。所有字面量一律进 params，绝不拼进 SQL 文本。 */
  #where(spec: CollectionSpec, w: Where, alias: string, params: Scalar[]): string {
    const c = (field: string) => `${alias}${this.#col(spec, field)}`;

    if ('and' in w) return `(${w.and.map((x) => this.#where(spec, x, alias, params)).join(' AND ')})`;
    if ('or' in w) return `(${w.or.map((x) => this.#where(spec, x, alias, params)).join(' OR ')})`;
    if ('not' in w) return `NOT (${this.#where(spec, w.not, alias, params)})`;

    if ('eq' in w) { params.push(this.#scalar(w.eq)); return `${c(w.field)} = ?`; }
    if ('ne' in w) { params.push(this.#scalar(w.ne)); return `${c(w.field)} <> ?`; }
    if ('in' in w) {
      if (w.in.length === 0) return '0';
      if (w.in.length > 500) throw new PluginError('EQUOTA', 'IN 子句过长');
      for (const v of w.in) params.push(this.#scalar(v));
      return `${c(w.field)} IN (${w.in.map(() => '?').join(',')})`;
    }
    if ('gt' in w) { params.push(this.#scalar(w.gt)); return `${c(w.field)} > ?`; }
    if ('gte' in w) { params.push(this.#scalar(w.gte)); return `${c(w.field)} >= ?`; }
    if ('lt' in w) { params.push(this.#scalar(w.lt)); return `${c(w.field)} < ?`; }
    if ('lte' in w) { params.push(this.#scalar(w.lte)); return `${c(w.field)} <= ?`; }
    if ('contains' in w) {
      if (typeof w.contains !== 'string') throw new PluginError('ESCHEMA', 'contains 需要字符串');
      // 转义 LIKE 元字符，避免插件用 % 做全表扫描式探测
      const escaped = w.contains.replace(/[\\%_]/g, (m) => `\\${m}`);
      params.push(`%${escaped}%`);
      return `${c(w.field)} LIKE ? ESCAPE '\\'`;
    }
    if ('exists' in w) return w.exists ? `${c(w.field)} IS NOT NULL` : `${c(w.field)} IS NULL`;

    throw new PluginError('ESCHEMA', '未知的查询算子');
  }

  compileFind(name: string, where?: Where, opts?: FindOpts): { sql: string; params: Scalar[] } {
    const spec = this.#spec(name);
    const params: Scalar[] = [];

    const alias = this.strategy === 'shadow' ? 'x.' : '';
    const from = this.strategy === 'shadow'
      ? `${this.tableName(name)} t JOIN ${this.ixTableName(name)} x ON x.id = t.id`
      : this.tableName(name);

    const selectCols = this.strategy === 'shadow'
      ? 't.id, t.doc, t.created_at, t.updated_at'
      : 'id, doc, created_at, updated_at';

    let sql = `SELECT ${selectCols} FROM ${from}`;
    if (where) sql += ` WHERE ${this.#where(spec, where, alias, params)}`;

    if (opts?.orderBy?.length) {
      const parts = opts.orderBy.map((o) => {
        const col = this.#col(spec, o.field);
        if (o.dir !== 'asc' && o.dir !== 'desc') throw new PluginError('ESCHEMA', `非法排序方向: ${o.dir}`);
        return `${alias}${col} ${o.dir.toUpperCase()}`;
      });
      sql += ` ORDER BY ${parts.join(', ')}`;
    }

    // limit 夹紧：插件不能要求全表
    const limit = Math.min(Math.max(1, Math.trunc(opts?.limit ?? 50)), MAX_LIMIT);
    const offset = Math.max(0, Math.trunc(opts?.offset ?? 0));
    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return { sql, params };
  }
}

// ============================================================ 建表（两种策略）

function ddlGenerated(ns: string, spec: CollectionSpec): string[] {
  const tbl = `plugin_${ns}_${spec.name}`;
  const generated = Object.entries(spec.fields).map(
    ([f, s]) => `${s.col} ${s.type} GENERATED ALWAYS AS (json_extract(doc, '$.${f}')) VIRTUAL`,
  );
  const stmts = [
    `CREATE TABLE ${tbl} (
       id TEXT PRIMARY KEY,
       doc TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       ${generated.join(',\n       ')}
     )`,
  ];
  for (const f of spec.indexed) {
    stmts.push(`CREATE INDEX ix_${ns}_${spec.name}_${spec.fields[f].col} ON ${tbl}(${spec.fields[f].col})`);
  }
  return stmts;
}

/** 退路：主表只存 doc，索引列放在影子表里，由触发器维护 */
function ddlShadow(ns: string, spec: CollectionSpec): string[] {
  const tbl = `plugin_${ns}_${spec.name}`;
  const ix = `${tbl}_ix`;
  const cols = Object.entries(spec.fields).map(([, s]) => `${s.col} ${s.type}`);
  const fieldList = Object.keys(spec.fields);
  // 注意：INSERT 的列名必须是**物理列名**，不是 DSL 字段名
  const colList = fieldList.map((f) => spec.fields[f].col);
  const jsonExprs = fieldList.map((f) => `json_extract(NEW.doc, '$.${f}')`);

  const stmts = [
    `CREATE TABLE ${tbl} (
       id TEXT PRIMARY KEY,
       doc TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE ${ix} (
       id TEXT PRIMARY KEY REFERENCES ${tbl}(id) ON DELETE CASCADE,
       ${cols.join(',\n       ')}
     )`,
    `CREATE TRIGGER trg_${ns}_${spec.name}_ai AFTER INSERT ON ${tbl} BEGIN
       INSERT INTO ${ix}(id, ${colList.join(', ')}) VALUES (NEW.id, ${jsonExprs.join(', ')});
     END`,
    `CREATE TRIGGER trg_${ns}_${spec.name}_au AFTER UPDATE ON ${tbl} BEGIN
       UPDATE ${ix} SET ${fieldList.map((f) => `${spec.fields[f].col} = json_extract(NEW.doc, '$.${f}')`).join(', ')}
       WHERE id = NEW.id;
     END`,
    `CREATE TRIGGER trg_${ns}_${spec.name}_ad AFTER DELETE ON ${tbl} BEGIN
       DELETE FROM ${ix} WHERE id = OLD.id;
     END`,
  ];
  for (const f of spec.indexed) {
    stmts.push(`CREATE INDEX ix_${ns}_${spec.name}_${spec.fields[f].col} ON ${ix}(${spec.fields[f].col})`);
  }
  return stmts;
}

// ============================================================ 测试

const NS = 'app_matrix_timeline';
const SPEC: CollectionSpec = {
  name: 'task',
  fields: {
    dueAt: { col: 'due_at', type: 'INTEGER' },
    courseId: { col: 'course_id', type: 'TEXT' },
    status: { col: 'status', type: 'TEXT' },
    title: { col: 'title', type: 'TEXT' },
  },
  indexed: ['dueAt', 'courseId', 'status'],
};

const ROWS = [
  { id: 't1', dueAt: 1000, courseId: 'c1', status: 'open', title: '作业 1' },
  { id: 't2', dueAt: 2000, courseId: 'c1', status: 'done', title: '作业 2' },
  { id: 't3', dueAt: 3000, courseId: 'c2', status: 'open', title: 'Quiz 1' },
  { id: 't4', dueAt: 4000, courseId: 'c2', status: 'open', title: '作业 3' },
  { id: 't5', dueAt: 5000, courseId: 'c3', status: 'dismissed', title: '100% 完成' },
  { id: 't6', dueAt: 6000, courseId: 'c1', status: 'open', title: 'a_b 通配' },
];

function setup(strategy: Strategy): { db: DatabaseSync; qc: QueryCompiler } {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const s of strategy === 'generated' ? ddlGenerated(NS, SPEC) : ddlShadow(NS, SPEC)) db.exec(s);

  const tbl = `plugin_${NS}_${SPEC.name}`;
  const ins = db.prepare(`INSERT INTO ${tbl}(id, doc, created_at, updated_at) VALUES (?, ?, ?, ?)`);
  for (const r of ROWS) ins.run(r.id, JSON.stringify(r), 1, 1);

  return { db, qc: new QueryCompiler(NS, [SPEC], strategy) };
}

function run(db: DatabaseSync, qc: QueryCompiler, where?: Where, opts?: FindOpts) {
  const { sql, params } = qc.compileFind('task', where, opts);
  return { sql, params, rows: db.prepare(sql).all(...params) as any[] };
}

const pass: string[] = [];
const fail: string[] = [];
function check(name: string, fn: () => void) {
  try { fn(); pass.push(name); }
  catch (e: any) { fail.push(`${name}: ${e.message}`); }
}

const A = setup('generated');
const B = setup('shadow');

// ---------- A. 结果一致性 + 索引命中 ----------

const QUERIES: Array<[string, Where | undefined, FindOpts | undefined]> = [
  ['按 dueAt 区间 + 状态', { and: [{ field: 'dueAt', gte: 2000 }, { field: 'dueAt', lt: 5000 }, { not: { field: 'status', eq: 'done' } }] }, { orderBy: [{ field: 'dueAt', dir: 'asc' }], limit: 50 }],
  ['按 courseId IN', { field: 'courseId', in: ['c1', 'c3'] }, { orderBy: [{ field: 'dueAt', dir: 'desc' }] }],
  ['按 status eq', { field: 'status', eq: 'open' }, undefined],
  ['contains 转义', { field: 'title', contains: '%' }, undefined],
  ['exists', { field: 'courseId', exists: true }, { limit: 3 }],
];

for (const [label, where, opts] of QUERIES) {
  check(`[一致] ${label}`, () => {
    const ra = run(A.db, A.qc, where, opts);
    const rb = run(B.db, B.qc, where, opts);
    assert.deepEqual(
      ra.rows.map((r) => r.id).sort(),
      rb.rows.map((r) => r.id).sort(),
      `generated=${JSON.stringify(ra.rows.map((r) => r.id))} shadow=${JSON.stringify(rb.rows.map((r) => r.id))}`,
    );
  });
}

check('[转义] contains "%" 不应匹配全部行', () => {
  const { rows } = run(A.db, A.qc, { field: 'title', contains: '%' });
  assert.equal(rows.length, 1, `期望只匹配 t5，实际 ${rows.length} 行`);
  assert.equal(rows[0].id, 't5');
});

check('[索引] generated 策略命中 ix_..._due_at', () => {
  const { sql, params } = A.qc.compileFind('task', { field: 'dueAt', gte: 2000 }, { orderBy: [{ field: 'dueAt', dir: 'asc' }] });
  const plan = JSON.stringify(A.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params));
  assert.ok(plan.includes('ix_app_matrix_timeline_task_due_at'), plan);
  assert.ok(!/SCAN plugin_/.test(plan) || plan.includes('USING INDEX'), plan);
});

check('[索引] shadow 策略命中 ix_..._due_at', () => {
  const { sql, params } = B.qc.compileFind('task', { field: 'dueAt', gte: 2000 }, undefined);
  const plan = JSON.stringify(B.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params));
  assert.ok(plan.includes('ix_app_matrix_timeline_task_due_at'), plan);
});

check('[索引] 触发器维护的影子表与主表一致', () => {
  const tbl = `plugin_${NS}_${SPEC.name}`;
  A.db.prepare(`INSERT INTO ${tbl}(id, doc, created_at, updated_at) VALUES (?,?,?,?)`)
    .run('t7', JSON.stringify({ id: 't7', dueAt: 7000, courseId: 'c9', status: 'open', title: 'x' }), 1, 1);
  B.db.prepare(`INSERT INTO ${tbl}(id, doc, created_at, updated_at) VALUES (?,?,?,?)`)
    .run('t7', JSON.stringify({ id: 't7', dueAt: 7000, courseId: 'c9', status: 'open', title: 'x' }), 1, 1);
  const ra = run(A.db, A.qc, { field: 'dueAt', gte: 7000 });
  const rb = run(B.db, B.qc, { field: 'dueAt', gte: 7000 });
  assert.deepEqual(ra.rows.map((r) => r.id), rb.rows.map((r) => r.id));
  assert.equal(ra.rows.length, 1);
});

// ---------- B. 注入 / 越界 / 配额 ----------

const REJECT: Array<[string, () => unknown, string]> = [
  ['未声明的集合名', () => A.qc.compileFind('task; DROP TABLE event--'), 'EPERM'],
  ['未声明的字段', () => A.qc.compileFind('task', { field: 'dueAt) OR 1=1 --', eq: 1 }), 'EPERM'],
  ['字段名做注入载荷', () => A.qc.compileFind('task', { field: "title' OR '1'='1", eq: 'x' }), 'EPERM'],
  ['排序字段越界', () => A.qc.compileFind('task', undefined, { orderBy: [{ field: 'doc', dir: 'asc' }] }), 'EPERM'],
  ['排序方向注入', () => A.qc.compileFind('task', undefined, { orderBy: [{ field: 'dueAt', dir: 'asc; DROP TABLE event' as any }] }), 'ESCHEMA'],
  ['对象参数', () => A.qc.compileFind('task', { field: 'dueAt', eq: {} as any }), 'ESCHEMA'],
  ['数组参数', () => A.qc.compileFind('task', { field: 'dueAt', eq: [1] as any }), 'ESCHEMA'],
  ['IN 过长', () => A.qc.compileFind('task', { field: 'courseId', in: Array.from({ length: 501 }, (_, i) => `c${i}`) }), 'EQUOTA'],
  ['未知算子', () => A.qc.compileFind('task', { field: 'dueAt', regex: '.*' } as any), 'ESCHEMA'],
];

for (const [label, fn, code] of REJECT) {
  check(`[拒绝:${code}] ${label}`, () => {
    let threw: any = null;
    try { fn(); } catch (e) { threw = e; }
    assert.ok(threw, '应当抛错但没有');
    assert.equal(threw.code, code, `期望 ${code}，实际 ${threw.code}: ${threw.message}`);
  });
}

check('[参数化] SQL 文本中不含任何字面量', () => {
  const { sql, params } = A.qc.compileFind('task', { and: [{ field: 'courseId', eq: 'c1' }, { field: 'title', contains: "x' OR 1=1 --" }] });
  assert.ok(!sql.includes('c1'), `SQL 里混入了字面量: ${sql}`);
  assert.ok(!sql.includes('OR 1=1'), `SQL 里混入了载荷: ${sql}`);
  assert.equal(params.length, 4, JSON.stringify(params)); // eq + like + limit + offset
});

check('[配额] limit 被夹紧到 200', () => {
  const { params } = A.qc.compileFind('task', undefined, { limit: 100000 });
  assert.equal(params[params.length - 2], 200);
});

check('[配额] limit 为 0/负数时至少为 1', () => {
  assert.equal(A.qc.compileFind('task', undefined, { limit: 0 }).params.at(-2), 1);
  assert.equal(A.qc.compileFind('task', undefined, { limit: -5 }).params.at(-2), 1);
});

check('[命名空间] 表名强制加前缀', () => {
  assert.equal(A.qc.tableName('task'), 'plugin_app_matrix_timeline_task');
});

check('[原型污染] __proto__ 作为字段名被拒', () => {
  let threw: any = null;
  try { A.qc.compileFind('task', { field: '__proto__', eq: 1 }); } catch (e) { threw = e; }
  assert.equal(threw?.code, 'EPERM');
});

// ---------- 输出 ----------

console.log(`\n通过 ${pass.length} 项：`);
for (const p of pass) console.log('  ✓', p);
if (fail.length) {
  console.log(`\n失败 ${fail.length} 项：`);
  for (const f of fail) console.log('  ✗', f);
  process.exitCode = 1;
} else {
  console.log('\n全部通过。');
}

// 顺带打印一次真实计划，便于人工核对
const where: Where = { and: [{ field: 'dueAt', gte: 2000 }, { field: 'status', eq: 'open' }] };
const opts: FindOpts = { orderBy: [{ field: 'dueAt', dir: 'asc' }], limit: 20 };

const sa = A.qc.compileFind('task', where, opts);
console.log('\n[generated] SQL:\n ', sa.sql.replace(/\s+/g, ' '));
console.log('参数:', JSON.stringify(sa.params));
console.log('计划:', JSON.stringify(A.db.prepare(`EXPLAIN QUERY PLAN ${sa.sql}`).all(...sa.params)));

const sb = B.qc.compileFind('task', where, opts);
console.log('\n[shadow] SQL:\n ', sb.sql.replace(/\s+/g, ' '));
console.log('参数:', JSON.stringify(sb.params));
console.log('计划:', JSON.stringify(B.db.prepare(`EXPLAIN QUERY PLAN ${sb.sql}`).all(...sb.params)));
