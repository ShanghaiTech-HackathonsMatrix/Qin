const PAD = (n: number) => String(n).padStart(2, '0');

/** epoch ms → <input type="datetime-local"> 需要的本地时间字符串 */
export function toLocalInput(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}T${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
}

/** <input type="datetime-local"> 的值 → epoch ms */
export function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 用于分组的日期键，例如 2025-03-14 */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;
}

export function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - t0) / 86400000);
  const base = `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`;
  if (diff === 0) return `今天 · ${base}`;
  if (diff === 1) return `明天 · ${base}`;
  if (diff === -1) return `昨天 · ${base}`;
  if (diff < 0) return `已过期 ${-diff} 天 · ${base}`;
  if (diff <= 7) return `${diff} 天后 · ${base}`;
  return `${d.getFullYear()}年${base}`;
}

export function timeLabel(ms: number): string {
  const d = new Date(ms);
  return `${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
}

export function relLabel(ms: number): string {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return '就是现在';
  if (mins < 60) return diff > 0 ? `${mins} 分钟后` : `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return diff > 0 ? `${hours} 小时后` : `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return diff > 0 ? `${days} 天后` : `${days} 天前`;
}

export function uid(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${Date.now().toString(36)}_${hex}`;
}
