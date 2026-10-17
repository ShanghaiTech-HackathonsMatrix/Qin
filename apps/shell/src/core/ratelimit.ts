/**
 * 令牌桶限流，键为 `(pluginId, host)`（对应 DESIGN.md §8.1）。
 *
 * 为什么按 host 分桶而不是全局一个桶：一个插件刷爆某个站点不该连累它访问别的站点；
 * 反过来，某个站点被刷爆也不该让插件整体不可用。
 *
 * 时钟可注入，测试里不用真等。
 */

export interface RateDecision {
  ok: boolean;
  /** 桶内剩余令牌（ok 时） */
  remaining: number;
  /** 还需等待多久才有令牌（不 ok 时） */
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/** 桶数量的硬上限，防止 key 空间被撑爆 */
const MAX_BUCKETS = 512;

export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;

  // 注意：不用 TS 参数属性（constructor(private readonly x)）——
  // Node 的类型擦除模式不支持，会直接报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
  // 全项目统一遵守这条，换来「无需构建即可跑测试」。
  constructor(capacity: number, refillPerSec: number, now: () => number = () => Date.now()) {
    if (capacity <= 0) throw new Error('capacity 必须为正');
    if (refillPerSec <= 0) throw new Error('refillPerSec 必须为正');
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
  }

  static key(pluginId: string, host: string): string {
    return `${pluginId}\u0000${host}`;
  }

  take(key: string, cost = 1): RateDecision {
    const t = this.now();
    let b = this.buckets.get(key);

    if (!b) {
      this.evictIfNeeded();
      // 新桶从满开始，否则「第一次访问就被限流」会很反直觉
      b = { tokens: this.capacity, lastRefill: t };
      this.buckets.set(key, b);
    } else {
      const elapsed = Math.max(0, t - b.lastRefill);
      b.tokens = Math.min(this.capacity, b.tokens + (elapsed / 1000) * this.refillPerSec);
      b.lastRefill = t;
    }

    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, remaining: b.tokens, retryAfterMs: 0 };
    }

    const deficit = cost - b.tokens;
    const retryAfterMs = Math.ceil((deficit / this.refillPerSec) * 1000);
    return { ok: false, remaining: b.tokens, retryAfterMs };
  }

  /** 只读观察，不消耗令牌 */
  peek(key: string): number {
    const b = this.buckets.get(key);
    if (!b) return this.capacity;
    const elapsed = Math.max(0, this.now() - b.lastRefill);
    return Math.min(this.capacity, b.tokens + (elapsed / 1000) * this.refillPerSec);
  }

  size(): number {
    return this.buckets.size;
  }

  reset(): void {
    this.buckets.clear();
  }

  /** 清掉已经回满的桶（它们与「不存在」等价），避免长期运行后 key 堆积 */
  private evictIfNeeded(): void {
    if (this.buckets.size < MAX_BUCKETS) return;
    const t = this.now();
    for (const [k, b] of this.buckets) {
      const refilled = b.tokens + ((t - b.lastRefill) / 1000) * this.refillPerSec;
      if (refilled >= this.capacity) this.buckets.delete(k);
      if (this.buckets.size < MAX_BUCKETS) return;
    }
    // 极端情况下仍然超限：丢掉最早插入的那个，保证有界
    const oldest = this.buckets.keys().next();
    if (!oldest.done) this.buckets.delete(oldest.value);
  }
}
