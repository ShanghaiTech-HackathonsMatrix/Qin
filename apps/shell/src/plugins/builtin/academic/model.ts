/** 学业插件共享的纯数据与计算；时间由宿主传入，不读时钟、不做 IO。 */
export type Provider = 'gradescope' | 'blackboard' | 'eams';
export const PROVIDERS: Provider[] = ['gradescope', 'blackboard', 'eams'];
export const PLUGIN_IDS: Record<Provider, string> = {
  gradescope: 'app.matrix.connector.gradescope', blackboard: 'app.matrix.connector.blackboard', eams: 'app.matrix.connector.eams',
};
export const ENTRY: Record<Provider, string> = {
  gradescope: 'https://www.gradescope.com/account',
  blackboard: 'https://elearning.shanghaitech.edu.cn:8443/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1',
  eams: 'https://eams.shanghaitech.edu.cn/eams/courseTableForStd.action',
};
export interface AcademicCourse { id: string; title: string; code: string; term: string; url: string; provider: Provider }
export interface Assignment {
  id: string; courseId: string; title: string; url: string; provider: Provider;
  dueAt: number | null; lateDueAt: number | null; dueText: string;
  status: 'unknown' | 'not_submitted' | 'submitted' | 'graded';
  needsReview?:boolean;
  completedAt?:number;
  verifiedAt?:number;
}
export interface LessonRule {
  id: string; courseId: string; title: string; code: string; term: string;
  teacher: string; location: string; weekday: number; first: number; last: number; weeks: number[];
}
export interface Period { start: string; end: string; group: '上午' | '下午' | '晚上' }
export interface TimetableSettings {
  name: string; weekOne: string; totalWeeks: number; periods: Period[];
  showWeekend: boolean; showOtherWeeks: boolean; reminders: boolean;
  lessonLead: number; dueLead: number; selectedCourses: Partial<Record<Provider, string[]>>;
  semesterId: string; gradescopeTimezone: string;
}
export interface LessonOverride {
  title?: string; teacher?: string; location?: string; weekday?: number; first?: number; last?: number;
  weeks?: number[]; note?: string; hidden?: boolean;
}
export interface AssignmentOverride { title?: string; dueAt?: number | null; note?: string; done?: boolean; completedAt?:number; hidden?: boolean }
export interface UserCorrections { lessons: Record<string, LessonOverride>; assignments: Record<string, AssignmentOverride> }
export const DEFAULT_PERIODS: Period[] = [
  ['08:15', '09:00', '上午'], ['09:10', '09:55', '上午'], ['10:15', '11:00', '上午'], ['11:10', '11:55', '上午'],
  ['13:00', '13:45', '下午'], ['13:55', '14:40', '下午'], ['15:00', '15:45', '下午'], ['15:55', '16:40', '下午'], ['16:50', '17:35', '下午'],
  ['18:00', '18:45', '晚上'], ['18:55', '19:40', '晚上'], ['19:50', '20:35', '晚上'], ['20:45', '21:30', '晚上'],
].map(([start, end, group]) => ({ start, end, group: group as Period['group'] }));
export function defaultSettings(): TimetableSettings {
  return { name: '我的课表', weekOne: '', totalWeeks: 18, periods: DEFAULT_PERIODS.map(p => ({ ...p })),
    showWeekend: true, showOtherWeeks: false, reminders: false, lessonLead: 5, dueLead: 1440,
    selectedCourses: {}, semesterId: '', gradescopeTimezone: '' };
}
export function minutes(value: string): number {
  if (!/^\d{2}:\d{2}$/.test(value)) throw new Error('时间必须为 HH:mm');
  const [h, m] = value.split(':').map(Number);
  if (h > 23 || m > 59) throw new Error('时间超出范围');
  return h * 60 + m;
}
export function parseWeeks(text: string, max = 60): number[] {
  const out = new Set<number>();
  const odd = /单/.test(text), even = /双/.test(text);
  const normalized = text.replace(/[周单双()（）\s]/g, '').replace(/[，、；;]/g, ',').replace(/[~～—–至]/g, '-');
  if (!normalized) throw new Error('请填写周次');
  for (const part of normalized.split(',')) {
    if (!/^\d+(?:-\d+)?$/.test(part)) throw new Error('周次格式示例：1-3,5-16');
    const [a, b = a] = part.split('-').map(Number);
    if (a < 1 || b < a || b > max) throw new Error(`周次应在 1–${max} 内`);
    for (let n = a; n <= b; n++) if ((!odd || n % 2 === 1) && (!even || n % 2 === 0)) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}
export function validateSettings(s: TimetableSettings): void {
  if (s.weekOne) {
    const t = Date.parse(`${s.weekOne}T00:00:00+08:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.weekOne) || !Number.isFinite(t) ||
      new Date(t + 8 * 3600000).toISOString().slice(0, 10) !== s.weekOne || new Date(t + 8 * 3600000).getUTCDay() !== 1)
      throw new Error('第 1 教学周起始日期须为有效的周一');
  }
  if (!Number.isInteger(s.totalWeeks) || s.totalWeeks < 1 || s.totalWeeks > 60) throw new Error('总周数应为 1–60');
  if (s.periods.length < 1 || s.periods.length > 24) throw new Error('每天节数应为 1–24');
  let end = -1;
  for (const p of s.periods) {
    const a = minutes(p.start), b = minutes(p.end);
    if (b <= a || a < end) throw new Error('每节课结束须晚于开始，且各节不能重叠');
    end = b;
  }
  for (const n of [s.lessonLead, s.dueLead]) if (!Number.isInteger(n) || n < 0 || n > 43200) throw new Error('提醒提前量应为 0–43200 分钟');
  if (s.gradescopeTimezone) { try { new Intl.DateTimeFormat('en', { timeZone: s.gradescopeTimezone }); } catch { throw new Error('Gradescope 时区无效'); } }
}
export function currentWeek(s: TimetableSettings, now: number): number | null {
  if (!s.weekOne) return null;
  return Math.floor((now - Date.parse(`${s.weekOne}T00:00:00+08:00`)) / 604800000) + 1;
}
export interface AcademicEvent { id: string; title: string; startAt: number; endAt?: number; type: 'session' | 'task'; detail: string; courseId: string; done: boolean }
export function expandLessons(rules: LessonRule[], s: TimetableSettings, changes: UserCorrections): AcademicEvent[] {
  validateSettings(s);
  if (!s.weekOne) return [];
  const anchor = Date.parse(`${s.weekOne}T00:00:00+08:00`), events: AcademicEvent[] = [];
  for (const original of rules) {
    const r = { ...original, note:changes.lessons[original.id]?.note };
    if (!Number.isInteger(r.weekday) || r.weekday < 1 || r.weekday > 7 || !Number.isInteger(r.first) || !Number.isInteger(r.last) || r.first < 1 || r.last < r.first || r.last > s.periods.length) throw new Error(`课程“${r.title}”的星期或节次无效，请修正`);
    for (const week of [...new Set(r.weeks)]) {
      if (!Number.isInteger(week) || week < 1) throw new Error('课程周次无效');
      if (week > s.totalWeeks) continue;
      const day = anchor + ((week - 1) * 7 + r.weekday - 1) * 86400000;
      events.push({ id: `lesson:${r.id}:${week}`, title: r.title, type: 'session', courseId: r.courseId, done: false,
        startAt: day + minutes(s.periods[r.first - 1].start) * 60000,
        endAt: day + minutes(s.periods[r.last - 1].end) * 60000,
        detail: [r.location, r.teacher, `第${week}周`, r.note].filter(Boolean).join(' · ').slice(0, 300) });
    }
  }
  return events;
}
export function assignmentEvents(rows: Assignment[], changes: UserCorrections): AcademicEvent[] {
  return rows.flatMap(original => {
    const a = { ...original, ...changes.assignments[original.id] };
    if (a.hidden || a.dueAt === null || !Number.isFinite(a.dueAt)) return [];
    return [{ id: a.id, title: a.title, startAt: a.dueAt, type: 'task' as const, courseId: a.courseId,
      done: a.done ?? (a.status === 'submitted' || a.status === 'graded'), detail: [a.note, a.provider, a.status].filter(Boolean).join(' · ').slice(0, 300) }];
  });
}
