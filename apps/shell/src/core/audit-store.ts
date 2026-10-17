/**
 * 审计落库（DESIGN.md §8.1 的最后一步）。
 *
 * 设计上审计要**持久化**，否则「谁在什么时候访问了什么」重启就没了，
 * 而审计的全部价值恰恰在于事后追溯。
 *
 * 实现取舍：
 *   · 写入走 kv（系统安全存储）—— 与 vault 共用同一个后端，但**不走 Vault 的命名空间**，
 *     因为审计是核心基础设施，不属于任何插件。
 *   · **合并写**：审计是高频的，每条都落一次盘会让请求变慢。这里攒一小段时间写一次，
 *     并且整体失败不影响主流程（审计失败绝不能让请求失败）。
 *   · 有上限：只保留最近 N 条，避免无限增长。
 *
 * 已知限制（如实说明）：合并写意味着**崩溃时最多丢失一个 flush 周期的记录**。
 * 要彻底避免，需要同步落盘或 WAL，那会牺牲请求延迟。当前取的是「延迟优先、最多丢几秒」。
 */

import type { AuditEntry } from './types.ts';

/** 只需要 kv 的读写能力，不需要 vault 的能力校验 */
export interface AuditBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const FLUSH_DELAY_MS = 1500;

export class DurableAuditStore {
  private readonly backend: AuditBackend;
  private readonly key: string;
  private readonly limit: number;
  private buf: AuditEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writes = 0;
  private lastError: string | null = null;

  constructor(backend: AuditBackend, key = 'core.audit.v1', limit = 200) {
    this.backend = backend;
    this.key = key;
    this.limit = limit;
  }

  /** 读回上次留下的记录；坏数据直接丢弃而不是崩掉 */
  async load(): Promise<AuditEntry[]> {
    try {
      const raw = await this.backend.get(this.key);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      this.buf = parsed.filter(isEntryLike).slice(-this.limit);
      return [...this.buf];
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.buf = [];
      return [];
    }
  }

  /** 作为 `AuditSink` 使用。同步返回，落盘在后台合并进行 */
  push = (entry: AuditEntry): void => {
    this.buf.push(entry);
    if (this.buf.length > this.limit) this.buf.splice(0, this.buf.length - this.limit);
    this.schedule();
  };

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
    // Node 环境下不阻止进程退出（测试用）
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** 立即落盘。返回是否成功 —— 调用方可以据此提示，但不必因失败中断流程 */
  async flush(): Promise<boolean> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      await this.backend.set(this.key, JSON.stringify(this.buf));
      this.writes += 1;
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async clear(): Promise<void> {
    this.buf = [];
    try {
      await this.backend.remove(this.key);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  get stats(): { buffered: number; writes: number; lastError: string | null; limit: number } {
    return { buffered: this.buf.length, writes: this.writes, lastError: this.lastError, limit: this.limit };
  }

  entries(): AuditEntry[] {
    return [...this.buf];
  }
}

function isEntryLike(v: unknown): v is AuditEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.at === 'number'
    && typeof e.pluginId === 'string'
    && typeof e.host === 'string'
    && typeof e.outcome === 'string';
}
