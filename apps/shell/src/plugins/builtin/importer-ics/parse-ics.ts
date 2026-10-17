/**
 * iCalendar（RFC 5545）解析 —— **纯函数：零 IO、零时钟、零 `Intl`**。
 *
 * ## 为什么刻意不用 `Intl` / 时区数据库
 *
 * 第一方插件现在跑在进程内，用 `Intl` 拿得到真时区。但插件将来要搬进 QuickJS 沙箱
 * （D1/D9），那里**没有时区数据库** —— 现在图方便用 `Intl`，沙箱化那天就会静默算错时间。
 * 所以第一版就把边界画死：只认「UTC（带 `Z`）」与「墙钟 + 固定偏移」两种。
 *
 * 对本项目的主用户场景（中国，无夏令时）固定 +8 是**精确**的，不是近似。
 * `TZID` 原样保留进实体，等真有跨时区需求时由宿主提供换算。
 *
 * ## 只做一个明确子集
 *
 * 越界的东西一律**如实计数**（`ignored`）而不是猜：`RRULE` 原样保留不展开，
 * `EXDATE` / `RECURRENCE-ID` 忽略。宁可少导入，也不要导入错的课表。
 */

export interface IcsEvent {
  uid?: string;
  summary?: string;
  description?: string;
  location?: string;
  /** `DTSTART` 的**原始值**，如 `20250901T080000` 或 `20250901T000000Z` */
  start?: string;
  /** `DTSTART;TZID=...` 的参数，原样保留，不参与换算 */
  startTzid?: string;
  /** `DTEND` 的原始值 */
  end?: string;
  /** `RRULE` 的原始值，**不展开** */
  rrule?: string;
}

export interface IcsCalendar {
  /** `X-WR-CALNAME`：教务系统导出的 ICS 普遍带，用它当课程名 */
  calName?: string;
  events: IcsEvent[];
  /** 被忽略的未支持属性条数 —— 进 `summary`，让用户知道「有东西没进来」 */
  ignored: number;
}

export interface IcsParseOutcome {
  calendar?: IcsCalendar;
  error?: string;
}

/**
 * 整块跳过的组件。
 *
 * `VTIMEZONE` 里也有 `DTSTART`（夏令时起止），不跳的话会被当成事件时间。
 * `STANDARD` / `DAYLIGHT` 是 `VTIMEZONE` 的子组件，一并跳过。
 */
const SKIPPED_BLOCKS = new Set(['VTIMEZONE', 'STANDARD', 'DAYLIGHT', 'VALARM', 'VTODO', 'VJOURNAL', 'VFREEBUSY']);

/** 只匹配这两种写法：`YYYYMMDD[THHMMSS][Z]` */
const DATE_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$/;

// ------------------------------------------------------------ 行处理

/**
 * 展开折叠行（RFC 5545 §3.1）。
 *
 * 长属性值按 75 字节折行，续行以**一个空格或制表符**开头。
 * 不展开的话，`SUMMARY` 会被截成半句，而且看起来像合法的短标题 —— 静默错。
 */
function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of raw) {
    if (line === '') continue;
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** 按分隔符切分，但**不切引号内**的分隔符（`TZID="Asia/Shanghai"` 里的 `;` 不能切） */
function splitUnquoted(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
      continue;
    }
    if (ch === sep && !inQuote) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

/**
 * 拆一行属性：`NAME;PARAM=VAL:value`。
 *
 * 冒号只认**第一个不在引号内的** —— 值里本来就可以有冒号（时间、URL）。
 */
function splitProperty(line: string): IcsProperty | null {
  let inQuote = false;
  let cut = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ':' && !inQuote) {
      cut = i;
      break;
    }
  }
  if (cut <= 0) return null;

  const head = line.slice(0, cut);
  const parts = splitUnquoted(head, ';');
  const name = (parts.shift() ?? '').trim().toUpperCase();
  if (name === '') return null;

  const params: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    const value = part.slice(eq + 1).trim().replace(/^"|"$/g, '');
    params[key] = value;
  }
  return { name, params, value: line.slice(cut + 1) };
}

/** 反转义 TEXT 类型的值：`\n` `\,` `\;` `\\` */
export function unescapeText(v: string): string {
  let out = '';
  for (let i = 0; i < v.length; i += 1) {
    const ch = v[i];
    if (ch === '\\' && i + 1 < v.length) {
      const next = v[i + 1];
      if (next === 'n' || next === 'N') {
        out += '\n';
        i += 1;
        continue;
      }
      if (next === ',' || next === ';' || next === '\\') {
        out += next;
        i += 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

// ------------------------------------------------------------ 时间

/**
 * 把 ICS 的时间值换成 epoch ms。
 *
 *   · `...Z`      —— UTC，精确
 *   · 其余        —— 当作**墙钟**，按固定偏移换算（中国无夏令时，+8 是精确的）
 *   · `YYYYMMDD`  —— 全天事件，取当天 00:00 墙钟
 *
 * 无法解析返回 `null`，由调用方计入「跳过」—— 不猜、不兜底成「现在」。
 */
export function toEpochMs(raw: string | undefined, offsetMin: number): number | null {
  if (typeof raw !== 'string') return null;
  const m = DATE_RE.exec(raw.trim());
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;

  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(utc)) return null;
  return m[7] === 'Z' ? utc : utc - offsetMin * 60_000;
}

// ------------------------------------------------------------ 主入口

export function parseCalendar(text: string): IcsParseOutcome {
  if (typeof text !== 'string' || text.trim() === '') {
    return { error: '文件是空的' };
  }

  const lines = unfold(text);
  const isCalendar = lines.some((l) => l.trim().toUpperCase() === 'BEGIN:VCALENDAR');
  if (!isCalendar) {
    return { error: '不是合法的 iCalendar 文件（缺少 BEGIN:VCALENDAR）' };
  }

  const events: IcsEvent[] = [];
  /** 组件栈：靠它区分「在 VEVENT 里」和「在 VTIMEZONE/VALARM 里」 */
  const stack: string[] = [];
  let calName: string | undefined;
  let ignored = 0;
  let current: IcsEvent | null = null;

  for (const line of lines) {
    const prop = splitProperty(line);
    if (!prop) {
      ignored += 1;
      continue;
    }

    if (prop.name === 'BEGIN') {
      const block = prop.value.trim().toUpperCase();
      stack.push(block);
      if (block === 'VEVENT') current = {};
      continue;
    }
    if (prop.name === 'END') {
      const closing = stack.pop();
      if (closing === 'VEVENT') {
        // 既没有起始时间也没有标题的 VEVENT 是无用残块，不落库
        if (current !== null && (current.start !== undefined || current.summary !== undefined)) {
          events.push(current);
        }
        current = null;
      }
      continue;
    }

    const top = stack[stack.length - 1];

    // VTIMEZONE / VALARM / VTODO 内部的一切静默跳过 —— 它们不是课表事件，
    // 计进 `ignored` 只会把数字弄脏（一个 VTIMEZONE 就有几十行）。
    if (top === undefined || SKIPPED_BLOCKS.has(top)) continue;

    if (top === 'VCALENDAR') {
      if (prop.name === 'X-WR-CALNAME') calName = unescapeText(prop.value).trim();
      continue;
    }

    if (top !== 'VEVENT' || current === null) continue;

    switch (prop.name) {
      case 'UID':
        current.uid = prop.value.trim();
        break;
      case 'SUMMARY':
        current.summary = unescapeText(prop.value).trim();
        break;
      case 'DESCRIPTION':
        current.description = unescapeText(prop.value).trim();
        break;
      case 'LOCATION':
        current.location = unescapeText(prop.value).trim();
        break;
      case 'DTSTART':
        current.start = prop.value.trim();
        if (prop.params.TZID !== undefined) current.startTzid = prop.params.TZID;
        break;
      case 'DTEND':
        current.end = prop.value.trim();
        break;
      case 'RRULE':
        current.rrule = prop.value.trim();
        break;
      default:
        // EXDATE / RECURRENCE-ID / X-* 都在这里：如实计数，不假装处理过
        ignored += 1;
        break;
    }
  }

  return { calendar: { ...(calName !== undefined ? { calName } : {}), events, ignored } };
}
