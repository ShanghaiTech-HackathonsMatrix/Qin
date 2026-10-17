/** 仅用于紧凑界面的显示投影，不改平台快照、个人标题、实体标识或链接。 */
export interface DdlLabelInput {
  id: string;
  title: string;
  courseTitle?: string;
  provider?: string;
  titleEdited?: boolean;
}
export interface DdlLabel { title: string; course: string }
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const TERM_PATTERN = String.raw`(?:(?:20\d{2})(?:\s*[-–/]\s*(?:20)?\d{2})?\s*(?:学年)?\s*(?:(?:第?[一二12]学期)|(?:春|夏|秋|冬)(?:季)?(?:学期)?)|(?:Fall|Spring|Summer|Winter)\s+20\d{2}|20\d{2}\s+(?:Fall|Spring|Summer|Winter))`;
const TERM = new RegExp(`^${TERM_PATTERN}$`, 'i');
const TRAILING_TERM = new RegExp(`\\s+${TERM_PATTERN}$`, 'i');

export function compactCourseName(raw: string): string {
  const original = clean(raw);
  let result = original.replace(/[（(\[【]([^）)\]】]*)[）)\]】]/g, (whole, inside: string) => TERM.test(clean(inside)) ? '' : whole);
  // 只剥离位于边界、完整匹配的学期，不删除班级、方向、课程编号或任意括号。
  result = result.replace(/^(.*?)\s*[·|_]\s*([^·|_]+)$/, (whole, left: string, right: string) => TERM.test(clean(right)) ? left : TERM.test(clean(left)) ? right : whole);
  result = result.replace(TRAILING_TERM, '');
  return clean(result) || original;
}

export function compactAssignmentName(raw: string, course = ''): string {
  let title = clean(raw);
  // BB 页面的操作提示不是作业名；仅剥离带冒号的明确前缀。
  const unwrap = (s: string) => s.replace(/^(?:上载作业|上传作业|提交作业|upload\s+assignment)\s*[:：]\s*(?=\S)/i, '');
  title = unwrap(title);
  for (const prefix of [clean(course), compactCourseName(course)]) {
    if (!prefix || !title.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    const rest = title.slice(prefix.length);
    if (/^\s*[:：·|_–—-]\s*\S/.test(rest)) title = rest.replace(/^\s*[:：·|_–—-]\s*/, '');
  }
  title = unwrap(title);
  const match = /^(homework|hw|assignment|problem\s*set|ps|lab|quiz|project|作业|实验|测验|项目)\s*[-_]?\s*(?:no\.?\s*|#\s*)?(\d+[a-z]?)(?![a-z0-9])(.*)$/i.exec(title);
  if (!match) return title;
  const names: Record<string, string> = {homework:'HW', hw:'HW', assignment:'作业', problemset:'PS', ps:'PS', lab:'Lab', quiz:'Quiz', project:'Project', 作业:'作业', 实验:'实验', 测验:'测验', 项目:'项目'};
  const number = match[2].replace(/^0+(?=\d)/, '');
  // 保留范围、分组、补交等剩余信息，避免只识别 HW2 就丢掉有意义的后缀。
  let suffix = match[3].replace(/^\s*[-:：]?\s*part\s+([a-z0-9]+)\b/i, '-$1');
  suffix = suffix.replace(/\breport\b/gi, '报告');
  return clean(`${names[match[1].toLowerCase().replace(/\s/g, '')]}${number}${suffix}`);
}

/** 对完整集合消歧，不能先按页/状态截取，否则切换筛选会改变名称。 */
export function compactDdlLabels(rows: readonly DdlLabelInput[]): Map<string, DdlLabel> {
  const labels = new Map<string, DdlLabel>();
  const courseGroups = new Map<string, Set<string>>();
  for (const row of rows) {
    const course = row.provider ? compactCourseName(row.courseTitle ?? '') : row.courseTitle ?? '';
    labels.set(row.id, {course, title: row.provider && !row.titleEdited ? compactAssignmentName(row.title, row.courseTitle) : row.title});
    if (row.provider && course) {
      const group = courseGroups.get(course) ?? new Set<string>();
      group.add(clean(row.courseTitle ?? '')); courseGroups.set(course, group);
    }
  }
  const titleGroups = new Map<string, DdlLabelInput[]>();
  for (const row of rows) {
    const label = labels.get(row.id)!;
    if ((courseGroups.get(label.course)?.size ?? 0) > 1) label.course = clean(row.courseTitle ?? '');
    const key = JSON.stringify([row.provider, row.courseTitle, label.title]);
    const group = titleGroups.get(key) ?? []; group.push(row); titleGroups.set(key, group);
  }
  for (const group of titleGroups.values()) {
    if (new Set(group.map(row => row.title)).size > 1) {
      for (const row of group) labels.get(row.id)!.title = row.title;
    }
  }
  return labels;
}
