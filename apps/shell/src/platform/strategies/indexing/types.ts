import type { QueryCompiler, SqlDb } from '../../sql/types';

export interface IndexSetup {
  compiler: QueryCompiler;
  /** 实际执行的 DDL 语句数，用于诊断展示 */
  statements: number;
}

/**
 * 索引策略：决定「按字段快速过滤」是怎么实现的。
 *
 * 两种实现查询结果完全一致（P0-S1 已实证），只有 DDL 与 find 的 FROM 不同：
 *   · generated —— JSON 文档 + 生成列 + 索引（主方案）
 *   · shadow    —— JSON 文档 + 影子表 + 触发器 + 索引（退路）
 *
 * 之所以要做成策略，是因为 sqlcipher-android 内嵌的 SQLite 版本无法离线确认，
 * 而生成列要求 SQLite ≥ 3.31。实机若探测失败，自动换影子表。
 */
export interface IndexingStrategy {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly mode: 'generated' | 'shadow';
  setup(db: SqlDb, ns: string): Promise<IndexSetup>;
}
