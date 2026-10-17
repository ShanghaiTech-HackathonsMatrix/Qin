/**
 * ICS 课表导入插件 —— 契约导出面。
 *
 * ```
 * plan()   → 声明「我需要宿主递给我 host://import 这份文档」
 * parsers  → 拿到文档正文，纯函数算成 course + session 实体
 * next     → 不需要（单步就够）
 * ```
 *
 * 插件**不碰任何 IO**：不读文件、不读时钟、不碰网络。文件是宿主读的、时间偏移是宿主给的
 * （`settings.utcOffsetMinutes`），解析结果由宿主 `bus.emit` 落库。这就是 D8 的全部主张。
 */

import type { ParseInput, ParseResult, ParsedEntity, PlanInput, PluginExports, RequestPlan } from '@matrix/plugin-api';

import { LOCAL_URL } from './manifest.ts';
import { parseCalendar, toEpochMs } from './parse-ics.ts';

export { manifest, LOCAL_URL, PLUGIN_ID } from './manifest.ts';

/** 没有 `DTEND` 时的默认时长。一节课 45 分钟，比「0 分钟」更像话，也比「1 天」安全 */
const DEFAULT_DURATION_MS = 45 * 60_000;

/** 默认时区偏移（分钟）。中国无夏令时，+8 是**精确**值而非近似 */
const DEFAULT_OFFSET_MIN = 480;

/**
 * `plan()` 拿到的 `settings` 转交给 `parsers`。
 *
 * ⚠️ **这是一处契约的别扭**：`PlanInput` 有 `settings`，`ParseInput` 没有
 * （`ParseInput` 只有 `body` / `status` / `baseUrl`）。而解析器确实需要
 * 「用户选了哪门课」「UTC 偏移是多少」这类非敏感配置。
 *
 * 用模块作用域转交是契约**明确允许**的写法 —— §6 的纪律是「累积状态留在插件模块作用域」，
 * 沙箱实例在多次调用之间是存活的。所以这不是绕过契约，正是契约推荐的用法。
 * （另一条路是把配置编进 `url` 键，那更脏：`url` 是不透明键，不该承载数据。）
 */
let pendingSettings: Record<string, string> = {};

// ------------------------------------------------------------ 契约导出

export function plan(input: PlanInput): RequestPlan {
  pendingSettings = { ...(input.settings ?? {}) };
  return {
    requests: [
      {
        id: 'ics',
        // method 对本地文档没有意义，但契约要求 GET|POST 二选一
        method: 'GET',
        url: LOCAL_URL,
        parse: 'ics',
        // ← 关键：宿主自行满足，不出网、不查域名白名单
        source: 'host',
      },
    ],
  };
}

export const parsers: Record<string, (input: ParseInput) => ParseResult> = {
  // 箭头函数在**调用时**读 `pendingSettings`，所以拿到的是本轮 plan() 写进去的那份
  ics: (input: ParseInput): ParseResult => importIcs(input.body, pendingSettings),
};

export const icsImporter: PluginExports = { plan, parsers };

// ------------------------------------------------------------ 纯函数：ICS → 实体

/** 从 `settings` 读偏移，越界就退回默认值 —— 不让一个坏配置把整份课表算到别的时区 */
function readOffsetMin(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_OFFSET_MIN;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return DEFAULT_OFFSET_MIN;
  if (n < -720 || n > 840) return DEFAULT_OFFSET_MIN;
  return n;
}

/**
 * 标题 → 稳定 id。
 *
 * 用 FNV-1a 而不是 `slugify`：中文标题 slug 完会变成空串，那样所有中文课表
 * 都会挤到同一门课里。哈希对中文安全，且同样输入永远同样输出（重复导入幂等）。
 * 与内核的自动 id 是两套算法，但用途不同：这里只是给 course 一个稳定名字。
 */
function stableHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 按 schema 的 `maxLength` 截断。截断比 ESCHEMA 好：一条超长备注不该让整次导入失败 */
function clip(v: string, max: number): string {
  return v.length > max ? v.slice(0, max) : v;
}

/**
 * 解析一份 ICS 文本，产出实体。
 *
 * 课程名三级优先：`settings.courseTitle` → `X-WR-CALNAME` → 兜底。
 * 这样宿主可以显式指定，而插件单独跑（测试、命令行）也仍然工作。
 */
export function importIcs(body: string, settings: Record<string, string>): ParseResult {
  const parsed = parseCalendar(body);
  if (parsed.calendar === undefined) {
    return { error: parsed.error ?? 'iCalendar 解析失败', summary: '导入失败' };
  }
  const cal = parsed.calendar;

  const title =
    (settings.courseTitle ?? '').trim() || (cal.calName ?? '').trim() || '未命名课程';
  const code = (settings.courseCode ?? '').trim();
  const courseId = (settings.courseId ?? '').trim() || `ics:${stableHash(title)}`;
  const offsetMin = readOffsetMin(settings.utcOffsetMinutes);

  const entities: ParsedEntity[] = [
    {
      type: 'course',
      id: clip(courseId, 200),
      data: {
        title: clip(title, 200),
        source: 'ics',
        ...(code !== '' ? { code: clip(code, 64) } : {}),
      },
    },
  ];

  let skipped = 0;
  let recurring = 0;

  for (const ev of cal.events) {
    const startAt = toEpochMs(ev.start, offsetMin);
    if (startAt === null) {
      // 没有可用起始时间 → 跳过并计数，不猜成「现在」
      skipped += 1;
      continue;
    }

    const endRaw = toEpochMs(ev.end, offsetMin);
    const endAt = endRaw !== null && endRaw > startAt ? endRaw : startAt + DEFAULT_DURATION_MS;

    const sessionTitle = (ev.summary ?? '').trim() || title;
    const data: Record<string, unknown> = {
      courseId: clip(courseId, 200),
      title: clip(sessionTitle, 200),
      startAt,
      endAt,
      // 可选字段一律**省略键**而不是填 undefined：
      // `additionalProperties: false` + 类型检查下，`undefined` 会被判成类型不符。
      // 将来搬进沙箱时 JSON 会直接丢掉 undefined，行为也一致。
      ...(ev.location !== undefined && ev.location !== ''
        ? { location: clip(ev.location, 200) }
        : {}),
      ...(ev.uid !== undefined && ev.uid !== '' ? { uid: clip(ev.uid, 200) } : {}),
      ...(ev.rrule !== undefined && ev.rrule !== ''
        ? { rrule: clip(ev.rrule, 512) }
        : {}),
      ...(ev.startTzid !== undefined && ev.startTzid !== ''
        ? { tzid: clip(ev.startTzid, 64) }
        : {}),
    };

    if (ev.rrule !== undefined && ev.rrule !== '') recurring += 1;

    entities.push({
      type: 'session',
      // UID 是 ICS 自带的稳定主键 → 重复导入落到同一行（幂等）。
      // 没有 UID 就不给 id，由宿主按内容哈希生成，同样稳定。
      ...(ev.uid !== undefined && ev.uid !== '' ? { id: clip(ev.uid, 200) } : {}),
      data,
    });
  }

  const sessionCount = entities.length - 1;
  const parts = [`导入「${title}」：${sessionCount} 节课`];
  if (recurring > 0) parts.push(`${recurring} 条周期事件未展开（只保留首节）`);
  if (skipped > 0) parts.push(`跳过 ${skipped} 条无起始时间的事件`);
  if (cal.ignored > 0) parts.push(`忽略 ${cal.ignored} 个未支持属性`);

  return { entities, summary: parts.join('；') };
}
