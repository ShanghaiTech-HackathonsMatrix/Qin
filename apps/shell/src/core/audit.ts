/**
 * 审计日志（对应 DESIGN.md §8.1 最后一步「审计落库」）。
 *
 * 这里只做**有界的环形缓冲**，持久化交给注入的 sink —— 因为审计要写进数据库，
 * 而数据库属于 store 策略层；核心层不该反过来依赖它。
 *
 * 只记主机名与路径，不记完整 URL、更不记请求头与请求体：
 * 那些位置最可能夹带 token / 口令 / 会话 cookie，写进日志就等于泄漏。
 */

import type { AuditEntry } from './types.ts';

const DEFAULT_CAPACITY = 500;

export type AuditSink = (entry: AuditEntry) => void;

export interface AuditStats {
  total: number;
  ok: number;
  denied: number;
  error: number;
}

export class AuditLog {
  private buf: AuditEntry[] = [];
  private total = 0;
  private byOutcome = { ok: 0, denied: 0, error: 0 };
  private readonly capacity: number;
  private readonly sink?: AuditSink;

  constructor(capacity: number = DEFAULT_CAPACITY, sink?: AuditSink) {
    if (capacity <= 0) throw new Error('capacity 必须为正');
    this.capacity = capacity;
    this.sink = sink;
  }

  record(entry: AuditEntry): void {
    this.total += 1;
    this.byOutcome[entry.outcome] += 1;

    this.buf.push(entry);
    if (this.buf.length > this.capacity) {
      this.buf.splice(0, this.buf.length - this.capacity);
    }

    // sink 出错绝不能影响主流程 —— 审计失败不该让请求失败
    try {
      this.sink?.(entry);
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 把**从磁盘读回来的**历史记录填进环形缓冲。
   *
   * 为什么不复用 `record()`：那会重新触发 sink，把刚读出来的东西又写回去。
   * 但计数（total / byOutcome）必须一起补上 —— 否则重启后会出现
   * 「列表里有 12 条、表头统计却是 0」这种自相矛盾的显示。
   *
   * 这也是一个真实的线上 bug：之前 bootstrap 只做了 `auditStore.load()`，
   * 记录进了存储封装自己的缓冲，而面板读的是核心层这个环形缓冲，
   * 两者从未接上 —— 表现就是「显示缓冲 N 条、列表却是空的」。
   */
  seed(entries: readonly AuditEntry[]): number {
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      // 磁盘数据可能被改坏，outcome 不认识就不计入统计，但记录仍然展示
      if (e.outcome === 'ok' || e.outcome === 'denied' || e.outcome === 'error') {
        this.byOutcome[e.outcome] += 1;
      }
      this.total += 1;
      this.buf.push(e);
    }
    if (this.buf.length > this.capacity) {
      this.buf.splice(0, this.buf.length - this.capacity);
    }
    return entries.length;
  }

  /** 最近 n 条，**从新到旧**（排查问题时想看的就是最新那条） */
  tail(n = 50): AuditEntry[] {
    const k = Math.max(0, Math.min(n, this.buf.length));
    return this.buf.slice(this.buf.length - k).reverse();
  }

  /** 按插件过滤，同样从新到旧 */
  tailFor(pluginId: string, n = 50): AuditEntry[] {
    const out: AuditEntry[] = [];
    for (let i = this.buf.length - 1; i >= 0 && out.length < n; i -= 1) {
      const e = this.buf[i];
      if (e && e.pluginId === pluginId) out.push(e);
    }
    return out;
  }

  stats(): AuditStats {
    return { total: this.total, ...this.byOutcome };
  }

  /** 缓冲里现存条数（与 total 不同：total 含已被挤出缓冲的） */
  get size(): number {
    return this.buf.length;
  }

  clear(): void {
    this.buf = [];
    this.total = 0;
    this.byOutcome = { ok: 0, denied: 0, error: 0 };
  }
}
