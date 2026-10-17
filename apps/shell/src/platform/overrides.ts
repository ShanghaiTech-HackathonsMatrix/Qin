/**
 * 手动覆盖项的持久化。
 *
 * 故意存在 localStorage 而不是 KV 策略里 —— 避免鸡生蛋问题
 * （要读覆盖项得先有 KV，而选哪个 KV 又取决于覆盖项）。
 * 这些值只是策略 id，不是机密。
 */
export interface Overrides {
  kv: string | null;
  store: string | null;
  indexing: string | null;
}

const KEY = 'matrix.strategyOverrides.v1';

const EMPTY: Overrides = { kv: null, store: null, indexing: null };

export function loadOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY };
    const o = parsed as Record<string, unknown>;
    const pick = (k: string): string | null =>
      typeof o[k] === 'string' && o[k] ? (o[k] as string) : null;
    return { kv: pick('kv'), store: pick('store'), indexing: pick('indexing') };
  } catch {
    return { ...EMPTY };
  }
}

export function saveOverrides(o: Overrides): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch { /* 存不下就算了，不影响主流程 */ }
}

export function clearOverrides(): void {
  try {
    localStorage.removeItem(KEY);
  } catch { /* 忽略 */ }
}

export function hasAnyOverride(o: Overrides): boolean {
  return Boolean(o.kv || o.store || o.indexing);
}
