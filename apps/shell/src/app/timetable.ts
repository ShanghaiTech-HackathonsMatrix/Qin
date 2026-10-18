/**
 * 周课表的纯逻辑：把「每周几、第几节、哪几周」的课时规则摊成一周七天。
 *
 * 放在 `app/` 而不是视图里，理由和 `ddl-items.ts` 一样：
 * 这里全是日期算术，Node 里跑得动、测得起来；掺进 React 就只能靠肉眼。
 *
 * 上游的课时规则是 `LessonRule`（`weekday` 1=周一…7=周日，`first`/`last`
 * 是第几节，`weeks` 是这条规则生效的教学周列表）。这一层不 import 插件类型，
 * 用结构化类型接住 —— 插件那边的对象天然满足。
 */

export interface TimetableRule {
  id: string;
  title: string;
  teacher?: string;
  location?: string;
  weekday: number;
  first: number;
  last: number;
  weeks: readonly number[];
}

export interface PeriodSlot {
  start: string;
  end: string;
}

export interface TimetableLesson {
  id: string;
  title: string;
  teacher: string;
  location: string;
  start: string;
  end: string;
  /** 「第 3-4 节」/「第 5 节」 */
  periods: string;
  /** 第几节开始、第几节结束。周课表要靠它把一格跨成好几行 */
  first: number;
  last: number;
}

export interface TimetableDay {
  weekday: number;
  /** 周一 … 周日 */
  label: string;
  /** 这一周里那天的日期，M月D日 */
  date: string;
  isToday: boolean;
  lessons: TimetableLesson[];
}

const DAY_LABEL = ['一', '二', '三', '四', '五', '六', '日'];
const DAY_MS = 86_400_000;


/** 本地时区的当天 0 点 */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** `YYYY-MM-DD` → 当天 0 点。格式不对返回 null，不抛 */
function parseDate(text: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/**
 * 今天是第几教学周。`weekOne` 是第 1 周的**周一**。
 *
 * 学期开始前返回 0（还没开学），日期没设或格式不对返回 null ——
 * 这两种情况视图要显示的东西不一样，所以不能都塞成 0。
 */
export function teachingWeek(weekOne: string, now: number): number | null {
  const anchor = parseDate(weekOne);
  if (anchor === null) return null;
  const diff = Math.floor((startOfDay(now) - anchor) / DAY_MS);
  if (diff < 0) return 0;
  return Math.floor(diff / 7) + 1;
}

/**
 * 摊成一周七天。
 *
 * `week` 超出学期范围时返回空数组里的空课表 —— 由调用方决定要不要夹到
 * [1, totalWeeks]，这里不做静默修正：悄悄改掉用户点的周次比空着更难受。
 */
export function buildWeekDays(opts: {
  rules: readonly TimetableRule[];
  periods: readonly PeriodSlot[];
  week: number;
  weekOne: string;
  now: number;
  showWeekend: boolean;
}): TimetableDay[] {
  const { rules, periods, week, weekOne, now, showWeekend } = opts;
  const anchor = parseDate(weekOne);
  if (anchor === null || week < 1) return [];

  const today = startOfDay(now);
  const weekStart = anchor + (week - 1) * 7 * DAY_MS;
  const last = showWeekend ? 7 : 5;

  const days: TimetableDay[] = [];
  for (let weekday = 1; weekday <= last; weekday += 1) {
    const at = weekStart + (weekday - 1) * DAY_MS;
    const d = new Date(at);
    const lessons = rules
      .filter((r) => r.weekday === weekday && r.weeks.includes(week))
      .slice()
      .sort((a, b) => a.first - b.first || a.last - b.last)
      .map((r) => ({
        id: r.id,
        title: r.title,
        teacher: r.teacher ?? '',
        location: r.location ?? '',
        start: periods[r.first - 1]?.start ?? '',
        end: periods[r.last - 1]?.end ?? '',
        periods: r.first === r.last ? `第 ${r.first} 节` : `第 ${r.first}-${r.last} 节`,
        first: r.first,
        last: r.last,
      }));

    days.push({
      weekday,
      label: `周${DAY_LABEL[weekday - 1]}`,
      date: `${d.getMonth() + 1}月${d.getDate()}日`,
      isToday: at === today,
      lessons,
    });
  }
  return days;
}

/** 这一周的上课次数，用来在标题上写「共 N 节」 */
export function lessonCount(days: readonly TimetableDay[]): number {
  return days.reduce((n, d) => n + d.lessons.length, 0);
}

/**
 * 教学周列表 → 人话。
 *
 * 教务给的是 `[1,2,3,…,15]`，直接铺开会把课程详情那一行撑爆，所以连续段压成
 * 「1–15 周」，断开的再逐个列出（单双周课很常见）。空数组给 `—`，不留空白格。
 */
export function weeksText(weeks: readonly number[]): string {
  if (weeks.length === 0) return '—';
  // 先去重再排序：重复的周次会把连续段切断，压出「2、2–3 周」这种鬼东西
  const sorted = [...new Set(weeks)].sort((a, b) => a - b);
  const runs: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const n of sorted.slice(1)) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    runs.push(start === prev ? String(start) : `${start}–${prev}`);
    start = n;
    prev = n;
  }
  runs.push(start === prev ? String(start) : `${start}–${prev}`);
  return `${runs.join('、')} 周`;
}

/**
 * 课程信息表：把「一条条课时」聚合成「一门课一行」。
 *
 * 教务系统页面下方那张表就是按课程列的 —— 一门课有几个上课时段，全塞在同一
 * 行的「上课时间」里。周课表回答「这周哪天有课」，这张表回答「这门课是谁上、
 * 在哪、哪几周、一共几个时段」，两者不能互相替代。
 *
 * `courseId` 缺失时退化成按课程名聚合（ICS 导入的课就没有 courseId），
 * 否则每节课都会自成一门课。
 */
export interface CourseInfoRule extends TimetableRule {
  courseId?: string;
  code?: string;
}

export interface CourseInfoSlot {
  /** 对应课时的 id，点它能打开课程详情 */
  id: string;
  weekday: number;
  first: number;
  last: number;
  weeks: readonly number[];
}

export interface CourseInfoRow {
  key: string;
  /** 课程号，教务没给就是空串 */
  code: string;
  title: string;
  /** 多个教师/多个地点用「、」连起来 */
  teacher: string;
  location: string;
  /** 同一门课的多个上课时段，按星期与节次排好 */
  slots: CourseInfoSlot[];
}

/** 把名字并进已有的「甲、乙」串，重复的不再追加 */
function mergeName(current: string, next: string): string {
  if (next === '') return current;
  if (current === '') return next;
  return current.split('、').includes(next) ? current : `${current}、${next}`;
}

export function courseInfoRows(rules: readonly CourseInfoRule[]): CourseInfoRow[] {
  const byCourse = new Map<string, { row: CourseInfoRow; slotKeys: Set<string> }>();

  for (const r of rules) {
    const key = r.courseId ?? r.title;
    let entry = byCourse.get(key);
    if (entry === undefined) {
      entry = { row: { key, code: r.code ?? '', title: r.title, teacher: '', location: '', slots: [] }, slotKeys: new Set() };
      byCourse.set(key, entry);
    }
    const { row, slotKeys } = entry;
    row.teacher = mergeName(row.teacher, r.teacher ?? '');
    row.location = mergeName(row.location, r.location ?? '');
    // 教务偶尔把同一节课吐两遍，聚合时按「星期+节次+周次」去重
    const slotKey = `${r.weekday}-${r.first}-${r.last}-${[...r.weeks].join(',')}`;
    if (!slotKeys.has(slotKey)) {
      slotKeys.add(slotKey);
      row.slots.push({ id: r.id, weekday: r.weekday, first: r.first, last: r.last, weeks: [...r.weeks] });
    }
  }

  const rows = [...byCourse.values()].map(({ row }) => ({
    ...row,
    slots: [...row.slots].sort((a, b) => a.weekday - b.weekday || a.first - b.first),
  }));
  // 和教务系统一样按课程号排；没课程号的退到课程名
  rows.sort((a, b) => {
    const left = a.code === '' ? a.title : a.code;
    const right = b.code === '' ? b.title : b.code;
    return left === right ? a.title.localeCompare(b.title, 'zh-Hans-CN') : left.localeCompare(right, 'zh-Hans-CN');
  });
  return rows;
}

/** 「周一 第 1–2 节」/「周三 第 5 节」 */
export function slotLabel(slot: { weekday: number; first: number; last: number }): string {
  const day = `周${DAY_LABEL[slot.weekday - 1] ?? '?'}`;
  return slot.first === slot.last
    ? `${day} 第 ${slot.first} 节`
    : `${day} 第 ${slot.first}–${slot.last} 节`;
}
