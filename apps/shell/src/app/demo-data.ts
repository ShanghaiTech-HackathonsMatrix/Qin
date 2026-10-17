import type { Course, Task } from '../domain/types';

export interface DemoClassSession {
  id: string;
  courseId: string;
  title: string;
  dayOffset: number;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  location: string;
}

export interface DemoDdl {
  id: string;
  courseId: string;
  title: string;
  source: string;
  dueAt: number;
  description: string;
  url: string;
}

export interface DemoData { courses: Course[]; tasks: Task[]; classes: DemoClassSession[]; ddls: DemoDdl[] }

/** 仅预览 URL `?demo=1` 使用的虚构数据；不写入 TaskStore / DataBus。 */
export function createDemoData(now = new Date()): DemoData {
  const day = (offset: number, hour: number, minute = 0) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, minute);
    return d.getTime();
  };
  const stamp = now.getTime();
  const courses: Course[] = [
    { id: 'demo-algorithm', name: '算法设计', code: 'CS204', createdAt: stamp, updatedAt: stamp },
    { id: 'demo-design', name: '交互设计', code: 'DES102', createdAt: stamp, updatedAt: stamp },
    { id: 'demo-history', name: '世界文明史', code: 'HUM110', createdAt: stamp, updatedAt: stamp },
  ];
  const task = (id: string, title: string, courseId: string | null, dueAt: number | null, status: Task['status'], kind: Task['kind'] = 'ddl'): Task =>
    ({ id: `demo-${id}`, title, courseId, dueAt, status, kind, createdAt: stamp, updatedAt: stamp });
  const classes: DemoClassSession[] = [
    { id: 'class-algorithm', courseId: 'demo-algorithm', title: '算法设计', dayOffset: 0, startHour: 10, startMinute: 0, endHour: 11, endMinute: 40, location: '教学楼 3 · 204' },
    { id: 'class-design', courseId: 'demo-design', title: '交互设计工作坊', dayOffset: 0, startHour: 14, startMinute: 0, endHour: 15, endMinute: 40, location: '设计楼 · 研讨室 2' },
    { id: 'class-history', courseId: 'demo-history', title: '世界文明史', dayOffset: 1, startHour: 9, startMinute: 50, endHour: 11, endMinute: 30, location: '人文楼 · 305' },
    { id: 'class-design-next', courseId: 'demo-design', title: '交互设计评图', dayOffset: 2, startHour: 13, startMinute: 0, endHour: 14, endMinute: 40, location: '设计楼 · 101' },
  ];
  const ddls: DemoDdl[] = [
    { id: 'ddl-studio', courseId: 'demo-design', title: '提交界面线框草图', source: 'Gradescope', dueAt: day(0, 20), description: '上传一份覆盖核心流程的低保真线框图。请包含首页、详情和提交确认三个状态，并附上简短的交互说明。', url: 'https://www.gradescope.com/courses/demo/assignments/02' },
    { id: 'ddl-quiz', courseId: 'demo-algorithm', title: '课堂小测 · 图算法', source: '互动教学平台', dueAt: day(0, 21, 30), description: '限时 20 分钟，覆盖广度优先搜索与最短路径。提交后不显示答案，成绩在下次课公布。', url: 'https://courses.example.edu/quizzes/graph-quiz' },
    { id: 'ddl-graph', courseId: 'demo-algorithm', title: '图论习题集 · 第三章', source: '互动教学平台', dueAt: day(-1, 23, 59), description: '完成第三章习题 1–8，重点说明最短路径算法的复杂度与边界情况。', url: 'https://courses.example.edu/assignments/graph-03' },
    { id: 'ddl-reading', courseId: 'demo-design', title: '叙事体验阅读札记', source: '互动教学平台', dueAt: day(1, 16, 30), description: '阅读指定材料后，记录两个叙事结构案例及其对用户决策的影响。', url: 'https://courses.example.edu/assignments/story-notes' },
    { id: 'ddl-history', courseId: 'demo-history', title: '小组展示提纲', source: 'Gradescope', dueAt: day(3, 18), description: '提交小组展示的主题、分工和 3 个主要论点。', url: 'https://www.gradescope.com/courses/demo/assignments/08' },
  ];
  return {
    courses,
    classes,
    ddls,
    tasks: [
      task('overdue', '完成图论习题集 · 第三章', 'demo-algorithm', day(-1, 23, 59), 'open'),
      task('sketch', '提交界面线框草图', 'demo-design', day(0, 20, 0), 'open'),
      task('reading', '阅读冒险叙事设计笔记', 'demo-design', day(1, 16, 30), 'open'),
      task('essay', '准备小组展示提纲', 'demo-history', day(3, 18), 'open'),
      task('completed', '整理上周课堂笔记', 'demo-history', day(-2, 20), 'done'),
    ],
  };
}
