/**
 * 核心层的用户可配置项。
 *
 * 存 localStorage 而不是 kv：这是「配置」，必须在 kv 策略解析出来**之前**就能读到，
 * 否则又变成先有鸡还是先有蛋（和策略覆盖是同一类问题）。
 */

const ALLOWLIST_KEY = 'matrix.core.allowlist.v1';

/**
 * 默认白名单：**空**。
 *
 * 这是刻意的 —— 与 D7「默认拒绝」一致：装好应用后没有任何域名可访问，
 * 由用户显式添加。默认放开几个「常用域名」看起来很友好，
 * 但那等于替用户做了信任决定。
 */
export const DEFAULT_ALLOWLIST: readonly string[] = [];

export function loadAllowlist(): string[] {
  try {
    const raw = localStorage.getItem(ALLOWLIST_KEY);
    if (!raw) return [...DEFAULT_ALLOWLIST];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_ALLOWLIST];
    return parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  } catch {
    return [...DEFAULT_ALLOWLIST];
  }
}

export function saveAllowlist(list: readonly string[]): void {
  try {
    localStorage.setItem(ALLOWLIST_KEY, JSON.stringify(list));
  } catch {
    /* 存不下就算了，本次会话内仍然生效 */
  }
}

/** 把多行文本解析成规则数组：去空行、去重、保留顺序 */
export function parseAllowlistText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
