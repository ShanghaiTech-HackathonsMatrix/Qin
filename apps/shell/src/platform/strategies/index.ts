import { StrategyRegistry } from './registry';
import { localStorageKv } from './kv/localstorage';
import { preferencesKv } from './kv/preferences';
import { secureStorageKv } from './kv/secure-storage';
import { generatedColumnsIndex, shadowTableIndex } from './indexing/strategies';
import { jsonStoreStrategy, plainSqliteStore, sqlcipherStore } from './store/strategies';

/**
 * 注册全部策略。
 *
 * 解析顺序由 tier 决定（ideal → fallback → dev），同 tier 内按 id 字典序。
 * 想接入新实现，只要在这里 register 一行 —— 业务代码无需改动。
 */
export function createRegistry(): StrategyRegistry {
  const r = new StrategyRegistry();

  // kv 槽位：Keystore → Preferences → localStorage
  r.register(secureStorageKv);
  r.register(preferencesKv);
  r.register(localStorageKv);

  // indexing 槽位：生成列 → 影子表
  r.register(generatedColumnsIndex);
  r.register(shadowTableIndex);

  // store 槽位：SQLCipher → 普通 SQLite → JSON 文档库
  r.register(sqlcipherStore);
  r.register(plainSqliteStore);
  r.register(jsonStoreStrategy);

  return r;
}

export const ALL_STRATEGY_IDS = {
  kv: ['kv.secure-storage', 'kv.preferences', 'kv.localstorage'],
  indexing: ['indexing.generated-columns', 'indexing.shadow-table'],
  store: ['store.sqlcipher', 'store.sqlite', 'store.json'],
} as const;
