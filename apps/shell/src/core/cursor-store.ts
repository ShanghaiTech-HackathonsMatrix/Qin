/**
 * 同步游标的持久化（dev.md T10）。
 *
 * ## 为什么游标必须落盘
 *
 * `SyncReport.cursor` 是插件「上次读到哪了」的凭证。原来它只活在宿主的
 * 一个 `Map` 里 —— 重启即失，于是分页同步会从**第一页**重新开始：
 *
 * - 对增量接口：重复拉取已处理的数据（浪费流量，可能触发限流）
 * - 对游标是「快照 id」的接口：拿到的是**新快照**，中间那段数据永久丢失
 *
 * 后一种是静默丢数据，比报错更糟。所以这不是优化，是正确性。
 *
 * ## 键布局
 *
 *     cursor.<pluginId>  →  游标字符串
 *
 * 一个插件一个键，和实体后端（`entity.<pluginId>`）一个思路：
 * 插件 id 里有点，扁平键会有前缀撞车问题。
 *
 * ## 写失败怎么办
 *
 * 游标写不进去**不让同步失败** —— 这一轮的数据已经落库了，用户看得见。
 * 但要把原因记进审计，否则下次重启才发现「游标丢了」就太晚了。
 */

import type { SecureStore } from '../platform/strategies/kv/types';

const PREFIX = 'cursor.';

export class CursorStore {
  private readonly kv: SecureStore;
  /** 内存镜像：同步是热路径，不该为读游标做一次异步 IO */
  private readonly cache = new Map<string, string>();

  constructor(kv: SecureStore) {
    this.kv = kv;
  }

  private key(pluginId: string): string {
    return `${PREFIX}${pluginId}`;
  }

  /** 启动时把已存的游标读回内存。失败不致命 —— 只是这一轮会从头同步 */
  async load(): Promise<number> {
    let keys: string[];
    try {
      keys = await this.kv.keys();
    } catch {
      return 0;
    }

    let n = 0;
    for (const k of keys) {
      if (!k.startsWith(PREFIX)) continue;
      const pluginId = k.slice(PREFIX.length);
      const v = await this.kv.get(k).catch(() => null);
      if (v !== null && v !== '') {
        this.cache.set(pluginId, v);
        n += 1;
      }
    }
    return n;
  }

  /** 同步读（内存）。调用方在热路径上用这个 */
  get(pluginId: string): string | undefined {
    return this.cache.get(pluginId);
  }

  /**
   * 写游标。
   *
   * 内存立刻更新（热路径依赖它），落盘失败时把原因返回给调用方记审计 ——
   * 不回滚内存：这一轮确实读到这里了，下次启动丢一点点比现在假装失败好。
   */
  async set(pluginId: string, cursor: string): Promise<string | null> {
    this.cache.set(pluginId, cursor);
    try {
      await this.kv.set(this.key(pluginId), cursor);
      return null;
    } catch (e) {
      return `游标落盘失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** 卸载插件时清掉 —— 否则重装后从「上一世的进度」继续 */
  async remove(pluginId: string): Promise<void> {
    this.cache.delete(pluginId);
    await this.kv.remove(this.key(pluginId)).catch(() => undefined);
  }
}
