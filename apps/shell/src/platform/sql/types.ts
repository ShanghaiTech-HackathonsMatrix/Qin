/** SQL 抽象层：策略层与具体 SQLite 实现之间的契约 */

export type SqlParam = string | number | null;

/** 最小 SQL 执行接口。任何后端（SQLCipher / 普通 SQLite / …）都实现它。 */
export interface SqlDb {
  /** 执行多条语句（建表、建索引、建触发器） */
  exec(sql: string): Promise<void>;
  /** 查询，返回行对象数组 */
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  /** 执行单条带参语句 */
  run(sql: string, params?: SqlParam[]): Promise<void>;
  /** 诊断信息（版本、编译选项等），用于自检报告 */
  info(): Promise<Record<string, string>>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------- 查询 DSL

export type Scalar = SqlParam;

export type Where =
  | { and: Where[] }
  | { or: Where[] }
  | { not: Where }
  | { field: string; eq: Scalar }
  | { field: string; ne: Scalar }
  | { field: string; in: Scalar[] }
  | { field: string; gt: number }
  | { field: string; gte: number }
  | { field: string; lt: number }
  | { field: string; lte: number }
  | { field: string; contains: string }
  | { field: string; exists: boolean };

export interface FindOpts {
  orderBy?: Array<{ field: string; dir: 'asc' | 'desc' }>;
  limit?: number;
  offset?: number;
}

export type SqlType = 'INTEGER' | 'REAL' | 'TEXT';

export interface FieldSpec {
  col: string;
  type: SqlType;
}

export interface CollectionSpec {
  name: string;
  /** DSL 字段名 → 物理列。只有这里声明过的字段才能被查询（白名单）。 */
  fields: Record<string, FieldSpec>;
  /** 需要建索引的 DSL 字段名 */
  indexed: string[];
}

export interface Compiled {
  sql: string;
  params: SqlParam[];
}

export interface QueryCompiler {
  find(collection: string, where?: Where, opts?: FindOpts): Compiled;
  upsert(collection: string, id: string, doc: unknown, now: number): Compiled;
  remove(collection: string, id: string): Compiled;
  count(collection: string): Compiled;
}

// ---------------------------------------------------------------- 错误

export class PlatformError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'PlatformError';
  }
}
