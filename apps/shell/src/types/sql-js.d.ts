/**
 * `sql.js` 的最小类型声明。
 *
 * 官方包不带 .d.ts（也没有 `types` 字段），而 `@types/sql.js` 是另一份需要跟着
 * 升级的第三方声明。这里只声明本项目真正用到的 API，故意保持很小：
 * 少声明一点，升级 sql.js 时就不会因为类型对不上而误判。
 */
declare module 'sql.js' {
  export type SqlValue = string | number | Uint8Array | null;

  export interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }

  export interface Statement {
    bind(params?: SqlValue[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, SqlValue>;
    free(): boolean;
  }

  export interface Database {
    run(sql: string, params?: SqlValue[]): Database;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array | null) => Database;
  }

  export interface SqlJsConfig {
    locateFile?: (file: string) => string;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
