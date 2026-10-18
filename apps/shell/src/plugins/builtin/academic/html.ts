/** 小范围 HTML/JS 字面量读取工具。不会执行网页脚本。 */
export function decode(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|\d+);?/gi, (_, n: string) => {
    const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }).replace(/&(?:nbsp|amp|lt|gt|quot|apos);/g, s => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[s] ?? s));
}
export function text(html: string): string {
  return decode(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
export function attr(tag: string, name: string): string {
  return decode(tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))?.[2] ?? '');
}
export function anchors(html: string, base: string): { url: string; title: string; html: string; index: number }[] {
  const found: { url: string; title: string; html: string; index: number }[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href=attr(m[1], 'href').trim();
    if (!href || href.startsWith('#')) continue;
    try { const u = new URL(href, base); if (u.protocol === 'https:') found.push({ url: u.href, title: text(m[2]), html: m[0], index:m.index }); } catch { /* 非链接 */ }
  }
  return found;
}
export function requirePage(body: string, status: number, url: string): void {
  if (/\/(?:authserver\/login|login|signin)(?:[/?]|$)/i.test(new URL(url).pathname) || /<input\b[^>]*type\s*=\s*["']password["']/i.test(body))
    throw new Error('LOGIN_REQUIRED：登录已过期，请重新登录');
  if (status !== 200) throw new Error(`平台返回 HTTP ${status}`);
  if (!body.trim()) throw new Error('平台返回空页面');
}
/** 只读字符串字面量，拒绝表达式及函数调用。 */
export function jsStrings(source: string): string[] {
  const values: string[] = [];
  const pattern = /(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const m of source.matchAll(pattern)) {
    values.push(m[2].replace(/\\(u[\da-f]{4}|x[\da-f]{2}|[\s\S])/gi, (_, v: string) => {
      if (/^[ux][\da-f]+$/i.test(v)) return String.fromCharCode(parseInt(v.slice(1), 16));
      return ({ n: '\n', r: '\r', t: '\t' }[v] ?? v);
    }));
  }
  return values;
}
/** 页面未明确时区时绝不默认手机时区。 */
/**
 * 平台原文里只留「日期时间」那一段。
 *
 * 原来的写法是 `截止日期…(.{0,100})` —— 从**整页纯文本**里截 100 个字。
 * 于是「2026年10月20日 下午11:59」后面跟着的页面其它内容（按钮文案、说明、
 * 导航）全被算进了「平台原文」，界面上显示成半句日期 + 半段乱码。
 *
 * 这里改成只认日期表达式本身：认得出就只留那一段，认不出才退回一个短窗口 ——
 * 无论如何都不把整页塞进界面。
 */
export function deadlineText(raw: string): string {
  const value = text(raw);
  const patterns: RegExp[] = [
    // 带时区的机器时间（BB / Gradescope 的 datetime 属性）
    /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s?(?:Z|[+-]\d{2}:?\d{2}))?/,
    // 中文：2026年10月20日 星期二 下午11:59
    /20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日(?:\s*(?:星期|周)[一二三四五六日天])?(?:\s*(?:上午|下午|晚上|凌晨|中午)?\s*\d{1,2}\s*[:：]\s*\d{2}(?:\s*[:：]\s*\d{2})?)?/,
    // 英文：Oct 20, 2026 11:59 PM
    /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+20\d{2})?(?:\s+(?:at\s+)?\d{1,2}:\d{2}\s*(?:AM|PM)?)?/i,
    // 纯日期：2026/10/20
    /20\d{2}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{1,2}/,
  ];
  for (const re of patterns) {
    const hit = value.match(re)?.[0];
    if (hit) return hit.trim();
  }
  return value.length > 40 ? `${value.slice(0, 40).trimEnd()}…` : value;
}

export function parseDeadline(raw: string, term: string, timezone: string): number | null {
  const value = text(raw);
  const zoned = value.match(/\b(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2})(\d{2})\b/);
  if (zoned) { const n = Date.parse(`${zoned[1]}T${zoned[2]}${zoned[3]}:${zoned[4]}`); return Number.isFinite(n) ? n : null; }
  const iso = value.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/i)?.[0];
  if (iso) { const n = Date.parse(iso); return Number.isFinite(n) ? n : null; }
  const chinese = value.match(/(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(?:(?:星期|周)[一二三四五六日天]\s*)?(上午|下午)?\s*(\d{1,2})[:：](\d{2})/);
  if (chinese) {
    let hour = Number(chinese[5]); if (chinese[4]) hour = hour % 12 + (chinese[4] === '下午' ? 12 : 0);
    return localDate(Number(chinese[1]), Number(chinese[2]), Number(chinese[3]), hour, Number(chinese[6]), timezone || 'Asia/Shanghai');
  }
  const en = value.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,?\s+(20\d{2}))?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!en || !timezone) return null;
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const month = months.indexOf(en[1].slice(0, 3).toLowerCase()) + 1;
  let year = Number(en[3] ?? term.match(/20\d{2}/)?.[0]);
  if (!year) return null;
  if (!en[3] && /fall|秋/i.test(term) && month <= 3) year++;
  const hour = en[6] ? Number(en[4]) % 12 + (/pm/i.test(en[6]) ? 12 : 0) : Number(en[4]);
  return localDate(year, month, Number(en[2]), hour, Number(en[5]), timezone);
}
function localDate(year: number, month: number, day: number, hour: number, minute: number, zone: string): number | null {
  if (hour > 23 || minute > 59 || day < 1 || day > 31) return null;
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  if (new Date(desired).getUTCMonth() !== month - 1) return null;
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
    let guess = desired;
    for (let n = 0; n < 3; n++) {
      const parts = Object.fromEntries(fmt.formatToParts(guess).map(p => [p.type, p.value]));
      const represented = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
      if (represented === desired) return guess;
      guess += desired - represented;
    }
  } catch { /* 未知时区或夏令时不存在的当地时刻 */ }
  return null;
}
