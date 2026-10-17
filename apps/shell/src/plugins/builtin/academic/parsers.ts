import { anchors, attr, decode, jsStrings, parseDeadline, text } from './html.ts';
import type { AcademicCourse, Assignment, LessonRule, Period } from './model.ts';

export function gradescopeCourses(html: string, base: string): AcademicCourse[] {
  const rows = new Map<string, AcademicCourse>();
  for (const a of anchors(html, base)) {
    if (new URL(a.url).origin !== new URL(base).origin) continue;
    const match = new URL(a.url).pathname.match(/^\/courses\/(\d+)\/?$/);
    if (!match) continue;
    const id = `gradescope:${match[1]}`;
    const fullName = text(a.html.match(/<(?:h[1-6]|[^>]*class=["'][^"']*(?:courseName|course-name)[^"']*["'])[^>]*>([\s\S]*?)<\//i)?.[1] ?? '') || a.title;
    const termPattern=/(?:Fall|Spring|Summer|Winter)\s+20\d{2}|20\d{2}\s+(?:Fall|Spring|Summer|Winter)/gi;
    const term=a.title.match(termPattern)?.[0] ?? [...text(html.slice(0,a.index)).matchAll(termPattern)].at(-1)?.[0] ?? '';
    rows.set(id, { id, title: fullName.slice(0, 200), code: '', provider:'gradescope', url: a.url, term });
  }
  if (!rows.size && !/no courses|not enrolled|courseList|course-list/i.test(html)) throw new Error('未识别 Gradescope 课程列表，保留上次数据');
  return [...rows.values()];
}
export function gradescopeAssignments(html: string, course: AcademicCourse, timezone: string): Assignment[] {
  const rows = new Map<string, Assignment>();
  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const links = anchors(tr[1], course.url);
    const a = links.find(a => new URL(a.url).origin===new URL(course.url).origin && new URL(a.url).pathname.match(/^\/courses\/(\d+)\/assignments\/\d+/)?.[1]===course.id.split(':')[1]);
    if (!a) continue;
    const assignmentId = a.url.match(/\/assignments\/(\d+)/)![1];
    const words = text(tr[1]);
    const cells = [...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[0]);
    const dueCell = cells.find(c => /dueDate|due-date|Due Date/i.test(c)) ?? cells.at(-1) ?? tr[1];
    const timeTags = [...dueCell.matchAll(/<(?:time|span)\b[^>]*\bdatetime\s*=\s*(["'])(.*?)\1[^>]*>/gi)];
    const dueTag = timeTags.find(m => /(?:^|\s)[^\s]*--dueDate(?:\s|$)/i.test(attr(m[0],'class')));
    const lateTag = timeTags.find(m => /late/i.test(attr(m[0],'class')));
    const times = timeTags.filter(m => !/releaseDate/i.test(attr(m[0],'class'))).map(m => decode(m[2]));
    const dueText = text(dueCell);
    const status = /\b(?:not\s+submitted|no\s+submission|missing)\b/i.test(words) ? 'not_submitted' :
      /\bgraded\b|\d+(?:\.\d+)?\s*\/\s*\d/.test(words) ? 'graded' : /\b(?:submitted|submission\s+received|resubmitted)\b/i.test(words) ? 'submitted' : 'unknown';
    rows.set(assignmentId, { id: `${course.id}:assignment:${assignmentId}`, courseId: course.id, title: a.title.slice(0, 200),
      url: `${new URL(course.url).origin}/courses/${course.id.split(':')[1]}/assignments/${assignmentId}`, provider:'gradescope',
      dueAt: parseDeadline(dueTag?.[2] ?? times[0] ?? dueText, course.term, timezone),
      lateDueAt: lateTag || times[1] ? parseDeadline(lateTag?.[2] ?? times[1], course.term, timezone) : null, dueText, status });
  }
  if (!rows.size && !/assignment(s|[-_]list|[-_]table)|no assignments/i.test(html)) throw new Error('未识别 Gradescope 作业表，保留上次数据');
  return [...rows.values()];
}
export function blackboardCourses(html: string, base: string): AcademicCourse[] {
  const rows = new Map<string, AcademicCourse>();
  for (const a of anchors(html, base)) {
    const u = new URL(a.url);
    const nativeId = u.searchParams.get('course_id') ??
      (/\/webapps\/blackboard\/execute\/launcher$/i.test(u.pathname) && u.searchParams.get('type') === 'Course' ? u.searchParams.get('id') : null);
    if (!nativeId || u.origin !== new URL(base).origin || !a.title) continue;
    const id = `blackboard:${nativeId}`;
    if (!rows.has(id)) rows.set(id, { id, title: a.title.slice(0, 200), url:a.url, provider:'blackboard', code:'', term:'' });
  }
  if (!rows.size) throw new Error('BB 门户没有可识别的课程入口，需检查课程模块');
  return [...rows.values()];
}
export function blackboardAssignment(html: string, url: string, course: AcademicCourse, fallbackTitle: string): Assignment | null {
  // 目录也可能出现“提交作业”等文字；只有实际作业页才产生作业实体。
  if (!/\/webapps\/assignment\/uploadAssignment(?:\.jsp)?$/i.test(new URL(url).pathname)) return null;
  const words = text(html);
  const due = words.match(/(?:截止日期|到期日期|Due Date)\s*[:：]?\s*(.{0,100})/i)?.[1] ?? '';
  if (!/截止日期|Due Date|提交作业|Upload Assignment|作业信息|Assignment Information/i.test(words)) return null;
  const u = new URL(url), nativeId = u.searchParams.get('content_id') ?? u.searchParams.get('assign_group_id');
  if (!nativeId) return null;
  const headings = [...html.matchAll(/<h[12]\b([^>]*)>([\s\S]*?)<\/h[12]>/gi)];
  const heading = headings.find(m=>attr(m[1],'id')==='pageTitleHeader') ?? headings.find(m=>!/(?:hideoff|hideFromQuickLinks)/i.test(m[1])&&text(m[2]));
  const title = (heading ? text(heading[2]) : fallbackTitle).replace(/^(?:复查提交历史记录|上传作业|提交作业|Review Submission History|Upload Assignment)\s*[:：]\s*/i,'');
  return { id:`${course.id}:assignment:${nativeId}`, courseId:course.id, title:title.slice(0,200),
    url, provider:'blackboard', dueAt:parseDeadline(due,course.term,'Asia/Shanghai'), lateDueAt:null, dueText:due,
    status:/未提交|尚未提交|not submitted/i.test(words) ? 'not_submitted' : /重新提交|已提交|提交(?:历史)?记录|已上交|submission history/i.test(words) ? 'submitted' : 'unknown' };
}
/** 只读取门户的「待完成作业」模块；缺失或结构未知不能当作空列表。 */
export function blackboardPending(html:string, base:string, courses:AcademicCourse[]): {links:{url:string;title:string;course:AcademicCourse}[];empty:boolean}|null {
  const title=/<span\b[^>]*class=["'][^"']*moduleTitle[^"']*["'][^>]*>\s*待完成作业\s*<\/span>/i.exec(html);
  if(!title) return null;
  const rest=html.slice(title.index+title[0].length);
  const block=rest.split(/<div\b[^>]*class=["'][^"']*portlet\b/i)[0];
  const empty=/您目前没有未完成的作业/.test(text(block));
  const links=anchors(block,base).flatMap(a=>{
    const u=new URL(a.url);
    if(u.origin!==new URL(base).origin || !/^\/webapps\/assignment\/uploadAssignment(?:\.jsp)?$/i.test(u.pathname))return [];
    const course=courses.find(c=>c.id===`blackboard:${u.searchParams.get('course_id')}`);
    return course && (u.searchParams.has('content_id')||u.searchParams.has('assign_group_id'))?[{url:a.url,title:a.title,course}]:[];
  });
  return empty&&!links.length?{links:[],empty:true}:links.length?{links,empty:false}:null;
}
export interface EamsSelection { student: string; semester: string; body: string }
export function eamsSelection(html: string, semesterOverride: string): EamsSelection {
  const student = html.match(/addInput\(\s*form\s*,\s*["']ids["']\s*,\s*["'](\d+)["']\s*\)/)?.[1] ??
    [...html.matchAll(/<input\b[^>]*>/gi)].map(m=>m[0]).filter(tag=>attr(tag,'name')==='ids').map(tag=>attr(tag,'value'))[0];
  const semester = semesterOverride || html.match(/semesterCalendar\(\s*\{[^}]*value\s*:\s*["'](\d+)["']/)?.[1] ||
    [...html.matchAll(/<input\b[^>]*>/gi)].map(m=>m[0]).filter(tag=>attr(tag,'name')==='semester.id').map(tag=>attr(tag,'value'))[0];
  if (!student || !/^\d+$/.test(student) || !semester || !/^\d+$/.test(semester)) throw new Error('教务页未提供学生或学期参数，请先在网页登录到个人课表');
  return { student, semester, body:`setting.kind=std&startWeek=&semester.id=${semester}&ids=${student}` };
}
/** 从 EAMS 的受限 TaskActivity 数据字面量读取排课，不执行脚本。 */
export function eamsTimetable(html: string, semester: string): { rules: LessonRule[]; courses: AcademicCourse[]; periods: Period[] } {
  if (/error\.courseTable|没有权限|会话超时/.test(html)) throw new Error('教务课表请求未成功，保留旧课表');
  const rules: LessonRule[] = [], courses = new Map<string, AcademicCourse>();
  const blocks = [...html.matchAll(/(?:var\s+)?activity\s*=\s*new\s+TaskActivity\(([^;]*)\);([\s\S]*?)(?=(?:var\s+)?activity\s*=\s*new\s+TaskActivity|<\/script>|$)/g)];
  for (const block of blocks) {
    const args = jsStrings(block[1]);
    if (args.length < 7) throw new Error('教务排课字段发生变化');
    const [teacherId, teacher, courseNative, courseLabel, roomId, location, weekBits] = args;
    void teacherId; void roomId;
    if (!/^[01]{2,64}$/.test(weekBits)) throw new Error('教务周次编码未识别');
    const weeks = [...weekBits].flatMap((bit, index) => bit === '1' ? [index] : []);
    if (weeks.includes(0)) throw new Error('教务周次编码基准不明确，需要确认');
    const code = courseLabel.match(/\(([^()]*)\)\s*$/)?.[1] ?? '';
    const title = courseLabel.replace(/\([^()]*\)\s*$/, '').trim();
    const courseId = `eams:${semester}:${courseNative}`;
    courses.set(courseId, { id:courseId, title, code, provider:'eams', term:semester, url:'https://eams.shanghaitech.edu.cn/eams/courseTableForStd.action' });
    const byDay = new Map<number, number[]>();
    for (const m of block[2].matchAll(/index\s*=\s*(\d+)\s*\*\s*(?:unitCount|\d+)\s*\+\s*(\d+)/g)) {
      const day = Number(m[1]) + 1, unit = Number(m[2]) + 1;
      byDay.set(day, [...(byDay.get(day) ?? []), unit]);
    }
    if (!byDay.size) throw new Error('教务节次坐标未识别');
    for (const [weekday, units] of byDay) {
      const sorted = [...new Set(units)].sort((a,b)=>a-b), groups: number[][] = [];
      for (const unit of sorted) { const last = groups.at(-1); if (last && last.at(-1)!+1===unit) last.push(unit); else groups.push([unit]); }
      for (const group of groups) {
        // 身份不含地点与教师，源页面修正这些字段后仍能保留用户备注。
        const id = `${courseId}:${weekday}:${group[0]}:${group.at(-1)}:${weeks.join('.')}`;
        const teacherName = /[\p{L}\p{N}]/u.test(teacher) ? teacher.trim() : '';
        rules.push({ id, courseId, title, code, term:semester, teacher:teacherName, location, weekday, first:group[0], last:group.at(-1)!, weeks });
      }
    }
  }
  if (!rules.length && !/本学期无课|暂无课表|没有排课/.test(html)) throw new Error('未识别到教务排课数据，需要检查页面结构');
  const periods: Period[] = [];
  for (const m of html.matchAll(/(\d{1,2}:\d{2})\s*[-–~]\s*(\d{1,2}:\d{2})/g)) {
    const start=m[1].padStart(5,'0'), end=m[2].padStart(5,'0');
    if (!periods.some(p=>p.start===start)) periods.push({start,end,group:Number(start.slice(0,2))<12?'上午':Number(start.slice(0,2))<18?'下午':'晚上'});
  }
  return { rules, courses:[...courses.values()], periods };
}
