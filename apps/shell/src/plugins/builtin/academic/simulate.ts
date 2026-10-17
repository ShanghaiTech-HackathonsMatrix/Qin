/**
 * 网页端的「模拟同步」通道 —— **只在 dev 构建里存在**。
 *
 * 为什么要有它：真正的登录与抓取只跑在 Android 上（原生会话 + WebView 登录），
 * 浏览器里连不上学校平台，于是这一整条链路在网页端是死的，
 * 没法演示、也没法在没有安卓机的时候验证界面。
 *
 * 做法是**只伪造网络那一层**：给核心层换一个 `Transport`，
 * 它按 URL 返回内置的样本 HTML。往上的连接器、解析器、投影、入库、渲染
 * 全都是真代码 —— 也就是说，这个模拟能证明「解析器真的能读懂这些页面」，
 * 而不是证明「我塞了一份假数据进去」。
 *
 * 样本里没有真实学生、课程或会话，全部是合成数据；日期按当前时间生成，
 * 所以演示里永远是「今天/明天」而不是过期的死日期。
 */

import type { Transport, TransportRequest, TransportResponse } from '../../../core/types.ts';
import { ENTRY, PROVIDERS, type Provider } from './model.ts';

/**
 * dev + `?demo=1` 时开启。生产构建里 `DEV` 是 false，这条通道等于不存在。
 *
 * 写得这么绕是因为这个模块也要能在纯 Node 里被测试引用（`simulate.test.ts`）——
 * 那边没有 Vite 的 `import.meta.env`，直接读会抛。
 */
const DEV: boolean = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

export const SIMULATE_ACADEMIC: boolean = DEV
  && typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('demo') === '1';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SHANGHAI = 8 * HOUR;

const pad = (n: number) => String(n).padStart(2, '0');

/** 本地时区的 ISO 时间串（带偏移），解析器直接认这种格式，不用猜时区。 */
function iso(ms: number): string {
  const d = new Date(ms);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T`
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 页面上显示给人看的日期（解析器会把它当成「原文」记下来） */
function readable(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 上海时区的「2026年10月20日 星期二 下午11:59」—— BB 的截止时间是这种写法。 */
function chineseDeadline(ms: number): string {
  const d = new Date(ms + SHANGHAI);
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getUTCDay()];
  const hour = d.getUTCHours();
  const half = hour < 12 ? '上午' : '下午';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 星期${week} `
    + `${half}${h12}:${pad(d.getUTCMinutes())}`;
}

/** 两周前的周一。同步完就能直接看到「第 3 教学周」的课表，不用手工校准。 */
export function simulatedWeekOne(now: number): string {
  const d = new Date(now + SHANGHAI);
  const weekday = (d.getUTCDay() + 6) % 7; // 0 = 周一
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - (weekday + 14) * DAY;
  return new Date(monday).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- 样本页面

const GRADESCOPE_ACCOUNT = `
<div class="courseList">
  <h2>Fall 2026</h2>
  <a href="/courses/11"><h3>交互设计</h3></a>
  <a href="/courses/12"><h3>算法设计</h3></a>
</div>`;

/** Gradescope 的作业表。`time` 上带时区，解析器直接读，不做时区猜测。 */
function gradescopeCourse(course: 11 | 12, now: number): string {
  const rows = course === 11
    ? [
        ['201', '线框草图 · 第二轮', now + 5 * HOUR, 'Not Submitted'],
        ['202', '可用性测试报告', now + 2 * DAY, 'Not Submitted'],
        ['203', '叙事体验阅读札记', now - 1 * DAY, 'Not Submitted'],
      ]
    : [
        ['301', '图论习题集 · 第三章', now + 3 * DAY, 'Submitted 8 / 10'],
        ['302', '动态规划小测', now + 6 * HOUR, 'Not Submitted'],
      ];
  const body = rows.map(([id, title, due, status]) => `
  <tr>
    <td class="assignmentTitle"><a href="/courses/${course}/assignments/${id}">${title}</a></td>
    <td class="dueDate"><time datetime="${iso(due as number)}">${readable(due as number)}</time></td>
    <td class="status">${status}</td>
  </tr>`).join('');
  return `<table class="assignment-list"><thead><tr><th>Assignment</th><th>Due</th><th>Status</th></tr></thead><tbody>${body}</tbody></table>`;
}

const BLACKBOARD_ENTRY = `
<a href="/webapps/blackboard/execute/launcher?type=Course&amp;id=_123_1&amp;url=">操作系统</a>
<a href="/webapps/blackboard/execute/launcher?type=Course&amp;id=_123_2&amp;url=">计算机网络</a>`;

/** 课程目录页：连接器只认带 course_id 的 uploadAssignment 链接。 */
const BLACKBOARD_COURSE = `
<a href="/webapps/assignment/uploadAssignment?content_id=_9001_1&amp;course_id=_123_1">进程调度实验</a>
<a href="/webapps/blackboard/content/listContent.jsp?course_id=_123_1&amp;content_id=_9_1">课程资料</a>`;

/** 课程资料目录：连接器会跟进来找作业链接，这里给一张没有作业的页面收尾 */
const BLACKBOARD_CONTENT = `
<h2>课程资料</h2>
<p>第一章 讲义.pdf</p>
<p>第二章 讲义.pdf</p>`;

function blackboardAssignment(now: number): string {
  return `<h1 id="pageTitleHeader">复查提交历史记录: 进程调度实验</h1>
<p>截止日期：${chineseDeadline(now + 1 * DAY + 2 * HOUR)}</p>
<p>未提交</p>`;
}

const EAMS_ENTRY = `
<script>
addInput(form,"ids","999");
semesterCalendar({value:"100"});
</script>`;

/**
 * 教务课表：`TaskActivity` 的字面量 + 节次时间表。
 * 位串第 0 位必须是 0（教务从第 1 周开始），其余为 1 表示上课周。
 */
function eamsTable(): string {
  return `<script>
activity = new TaskActivity("t1", "陈老师", "c1", "操作系统(CS101)", "r1", "信息学院 A301", "0111111111111111");
index = 0 * unitCount + 0; index = 0 * unitCount + 1; index = 2 * unitCount + 2; index = 2 * unitCount + 3;
activity = new TaskActivity("t2", "李老师", "c2", "算法设计(CS205)", "r2", "信息学院 B204", "0111111111111111");
index = 1 * unitCount + 4; index = 1 * unitCount + 5;
</script>
<p>第 1 节 08:15-09:00 第 2 节 09:10-09:55</p>
<p>第 3 节 10:15-11:00 第 4 节 11:10-11:55</p>
<p>第 5 节 13:00-13:45 第 6 节 13:55-14:40</p>`;
}

function pageFor(url: URL, now: number): string | null {
  const path = url.pathname;
  if (url.hostname === 'www.gradescope.com') {
    if (/^\/account\/?$/.test(path)) return GRADESCOPE_ACCOUNT;
    if (/^\/courses\/11\/?$/.test(path)) return gradescopeCourse(11, now);
    if (/^\/courses\/12\/?$/.test(path)) return gradescopeCourse(12, now);
    return null;
  }
  if (url.hostname === 'elearning.shanghaitech.edu.cn') {
    if (/\/webapps\/blackboard\/execute\/launcher$/i.test(path)) return BLACKBOARD_COURSE;
    if (/\/webapps\/assignment\/uploadAssignment$/i.test(path)) return blackboardAssignment(now);
    if (/\/webapps\/blackboard\/content\/listContent\.jsp$/i.test(path)) return BLACKBOARD_CONTENT;
    if (/\/webapps\/portal\//i.test(path)) return BLACKBOARD_ENTRY;
    return null;
  }
  if (url.hostname === 'eams.shanghaitech.edu.cn') {
    if (/courseTableForStd!courseTable\.action$/i.test(path)) return eamsTable();
    if (/courseTableForStd\.action$/i.test(path)) return EAMS_ENTRY;
    return null;
  }
  return null;
}

const PROVIDER_HOSTS = new Set(PROVIDERS.map((p) => new URL(ENTRY[p]).hostname));

/** 给测试用：直接取某个 URL 的样本页，不经过 Transport。 */
export function simulatedPage(url: string, now: number): string | null {
  try {
    return pageFor(new URL(url), now);
  } catch {
    return null;
  }
}

/**
 * 只截获三个学习平台的请求，其它 URL 原样交给 fallback ——
 * 这样模拟不会悄悄改变应用其它部分的网络行为。
 */
export class SimulatedAcademicTransport implements Transport {
  readonly kind = 'simulated-academic';
  private readonly fallback: Transport;

  constructor(fallback: Transport) {
    this.fallback = fallback;
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return this.fallback.request(req);
    }
    if (!PROVIDER_HOSTS.has(url.hostname)) return this.fallback.request(req);

    const body = pageFor(url, Date.now());
    if (body === null) {
      // 模拟里没有这一页：明确失败，而不是返回一张空页让解析器猜
      return { status: 404, headers: {}, body: '模拟通道没有这一页', url: req.url, followedRedirects: false };
    }
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body, url: req.url, followedRedirects: false };
  }
}

export type { Provider };
