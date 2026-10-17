/**
 * 查询 DSL → 参数化 SQL 编译器，以及两种索引策略的 DDL。
 *
 * 本文件是 spikes/p0/src/s1-query-compiler.test.ts 的工程化移植，保留了那里实证过的全部约束：
 *   · 集合名 / 字段名 / 排序方向全部走白名单，SQL 文本里不含任何字面量
 *   · LIKE 元字符转义 + ESCAPE
 *   · limit 夹紧、IN 长度配额
 *   · **按名字查表一律用 Object.hasOwn**（P0-S1 实测：fields['__proto__'] 返回 Object.prototype，
 *     朴素真值判断会被直接绕过）
 */

import {
  PlatformError,
  type CollectionSpec, type FieldSpec,
  type QueryCompiler, type SqlParam, type Where,
} from './types';

const MAX_LIMIT = 200;
const MAX_IN = 500;

/** 索引策略：生成列 vs 影子表。二者查询结果一致，仅 DDL 与 find 的 FROM 不同。 */
export type IndexMode = 'generated' | 'shadow';

// ============================================================ DDL

export function ddlFor(ns: string, spec: CollectionSpec, mode: IndexMode): string[] {
  const tbl = `plugin_${ns}_${spec.name}`;
  const base = `CREATE TABLE IF NOT EXISTS ${tbl} (
    id TEXT PRIMARY KEY,
    doc TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL`;

  if (mode === 'generated') {
    const gen = Object.entries(spec.fields).map(
      ([f, s]) => `,\n    ${s.col} ${s.type} GENERATED ALWAYS AS (json_extract(doc, '$.${f}')) VIRTUAL`,
    );
    const stmts = [`${base}${gen.join('')}\n  )`];
    for (const f of spec.indexed) {
      const s = spec.fields[f];
      if (!s) continue;
      stmts.push(`CREATE INDEX IF NOT EXISTS ix_${ns}_${spec.name}_${s.col} ON ${tbl}(${s.col})`);
    }
    return stmts;
  }

  // shadow：主表只存 doc，索引列放影子表，由触发器维护
  const ix = `${tbl}_ix`;
  const fieldNames = Object.keys(spec.fields);
  const colList = fieldNames.map((f) => spec.fields[f]!.col);
  const jsonExprs = fieldNames.map((f) => `json_extract(NEW.doc, '$.${f}')`);

  const stmts = [
    `${base}\n  )`,
    `CREATE TABLE IF NOT EXISTS ${ix} (
    id TEXT PRIMARY KEY REFERENCES ${tbl}(id) ON DELETE CASCADE,
    ${fieldNames.map((f) => `${spec.fields[f]!.col} ${spec.fields[f]!.type}`).join(',\n    ')}
  )`,
    `CREATE TRIGGER IF NOT EXISTS trg_${ns}_${spec.name}_ai AFTER INSERT ON ${tbl} BEGIN
       INSERT INTO ${ix}(id, ${colList.join(', ')}) VALUES (NEW.id, ${jsonExprs.join(', ')});
     END`,
    `CREATE TRIGGER IF NOT EXISTS trg_${ns}_${spec.name}_au AFTER UPDATE ON ${tbl} BEGIN
       UPDATE ${ix} SET ${colList.map((c, i) => `${c} = ${jsonExprs[i]}`).join(', ')} WHERE id = NEW.id;
     END`,
    `CREATE TRIGGER IF NOT EXISTS trg_${ns}_${spec.name}_ad AFTER DELETE ON ${tbl} BEGIN
       DELETE FROM ${ix} WHERE id = OLD.id;
     END`,
  ];
  for (const f of spec.indexed) {
    const s = spec.fields[f];
    if (!s) continue;
    stmts.push(`CREATE INDEX IF NOT EXISTS ix_${ns}_${spec.name}_${s.col} ON ${ix}(${s.col})`);
  }
  return stmts;
}

// ============================================================ 编译器

export function makeCompiler(ns: string, specs: CollectionSpec[], mode: IndexMode): QueryCompiler {
  const byName = new Map<string, CollectionSpec>();
  for (const s of specs) {
    // 归一化：字段表一律用 null 原型对象，杜绝 __proto__ / constructor 从原型链上"继承"出真值
    const fields: Record<string, FieldSpec> = Object.create(null) as Record<string, FieldSpec>;
    for (const [k, v] of Object.entries(s.fields)) fields[k] = v;
    byName.set(s.name, { ...s, fields });
  }

  function specOf(name: string): CollectionSpec {
    const s = byName.get(name);
    if (!s) throw new PlatformError('EPERM', `未声明的集合: ${name}`);
    return s;
  }

  function colOf(spec: CollectionSpec, field: string): string {
    // 必须用 Object.hasOwn，不能只做真值判断
    if (typeof field !== 'string' || !Object.hasOwn(spec.fields, field)) {
      throw new PlatformError('EPERM', `集合 ${spec.name} 未声明字段: ${String(field)}`);
    }
    return spec.fields[field]!.col;
  }

  function scalar(v: unknown): SqlParam {
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string' || t === 'number') return v as SqlParam;
    if (t === 'boolean') return v ? 1 : 0;   // SQLite 无布尔类型
    throw new PlatformError('ESCHEMA', `只接受标量参数，收到 ${t}`);
  }

  function whereSql(spec: CollectionSpec, w: Where, alias: string, params: SqlParam[]): string {
    const c = (field: string) => `${alias}${colOf(spec, field)}`;

    if ('and' in w) return `(${w.and.map((x) => whereSql(spec, x, alias, params)).join(' AND ')})`;
    if ('or' in w) return `(${w.or.map((x) => whereSql(spec, x, alias, params)).join(' OR ')})`;
    if ('not' in w) return `NOT (${whereSql(spec, w.not, alias, params)})`;

    if ('eq' in w) { params.push(scalar(w.eq)); return `${c(w.field)} = ?`; }
    if ('ne' in w) { params.push(scalar(w.ne)); return `${c(w.field)} <> ?`; }
    if ('in' in w) {
      if (w.in.length === 0) return '0';
      if (w.in.length > MAX_IN) throw new PlatformError('EQUOTA', 'IN 子句过长');
      for (const v of w.in) params.push(scalar(v));
      return `${c(w.field)} IN (${w.in.map(() => '?').join(',')})`;
    }
    if ('gt' in w) { params.push(scalar(w.gt)); return `${c(w.field)} > ?`; }
    if ('gte' in w) { params.push(scalar(w.gte)); return `${c(w.field)} >= ?`; }
    if ('lt' in w) { params.push(scalar(w.lt)); return `${c(w.field)} < ?`; }
    if ('lte' in w) { params.push(scalar(w.lte)); return `${c(w.field)} <= ?`; }
    if ('contains' in w) {
      if (typeof w.contains !== 'string') throw new PlatformError('ESCHEMA', 'contains 需要字符串');
      const escaped = w.contains.replace(/[\\%_]/g, (m) => `\\${m}`);
      params.push(`%${escaped}%`);
      return `${c(w.field)} LIKE ? ESCAPE '\\'`;
    }
    if ('exists' in w) return w.exists ? `${c(w.field)} IS NOT NULL` : `${c(w.field)} IS NULL`;

    throw new PlatformError('ESCHEMA', '未知的查询算子');
  }

  const tableOf = (name: string) => `plugin_${ns}_${specOf(name).name}`;

  return {
    find(collection, where, opts) {
      const spec = specOf(collection);
      const params: SqlParam[] = [];
      const alias = mode === 'shadow' ? 'x.' : '';
      const from = mode === 'shadow'
        ? `${tableOf(collection)} t JOIN ${tableOf(collection)}_ix x ON x.id = t.id`
        : tableOf(collection);
      const cols = mode === 'shadow'
        ? 't.id, t.doc, t.created_at, t.updated_at'
        : 'id, doc, created_at, updated_at';

      let sql = `SELECT ${cols} FROM ${from}`;
      if (where) sql += ` WHERE ${whereSql(spec, where, alias, params)}`;

      if (opts?.orderBy?.length) {
        const parts = opts.orderBy.map((o) => {
          const col = colOf(spec, o.field);
          if (o.dir !== 'asc' && o.dir !== 'desc') {
            throw new PlatformError('ESCHEMA', `非法排序方向: ${String(o.dir)}`);
          }
          return `${alias}${col} ${o.dir.toUpperCase()}`;
        });
        sql += ` ORDER BY ${parts.join(', ')}`;
      }

      const limit = Math.min(Math.max(1, Math.trunc(opts?.limit ?? 50)), MAX_LIMIT);
      const offset = Math.max(0, Math.trunc(opts?.offset ?? 0));
      sql += ' LIMIT ? OFFSET ?';
      params.push(limit, offset);
      return { sql, params };
    },

    upsert(collection, id, doc, now) {
      specOf(collection);
      const text = JSON.stringify(doc);
      if (typeof text !== 'string') throw new PlatformError('ESCHEMA', 'doc 无法序列化');
      return {
        sql: `INSERT INTO ${tableOf(collection)}(id, doc, created_at, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
        params: [id, text, now, now],
      };
    },

    remove(collection, id) {
      specOf(collection);
      return { sql: `DELETE FROM ${tableOf(collection)} WHERE id = ?`, params: [id] };
    },

    count(collection) {
      specOf(collection);
      return { sql: `SELECT COUNT(*) AS n FROM ${tableOf(collection)}`, params: [] };
    },
  };
}

// ============================================================ 集合定义

export const NS = 'app_matrix_timeline';

export const COLLECTIONS: CollectionSpec[] = [
  {
    name: 'task',
    fields: {
      kind: { col: 'kind', type: 'TEXT' },
      title: { col: 'title', type: 'TEXT' },
      courseId: { col: 'course_id', type: 'TEXT' },
      dueAt: { col: 'due_at', type: 'INTEGER' },
      status: { col: 'status', type: 'TEXT' },
    },
    indexed: ['dueAt', 'status', 'courseId'],
  },
  {
    name: 'course',
    fields: {
      name: { col: 'name', type: 'TEXT' },
      code: { col: 'code', type: 'TEXT' },
    },
    indexed: ['name'],
  },
];
