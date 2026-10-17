/**
 * ICS 插件贡献的控件 —— **第一个落地控件**，用来证明整条环是通的。
 *
 * 它刻意选最简单的东西：**只读 + 两种动作**（`navigate` / `setUi`），
 * 不需要宿主递文件、不需要命令通道。所以它验证的是纯粹的
 * `数据 → render → UiNode → 渲染 → 动作 → 重新 render` 这一圈。
 *
 * `render()` 是**纯函数**：同样的 `ctx` 必须得到同样的树。不读全局变量、不缓存、
 * 不碰时钟（时间从 `ctx.now` 来）。
 */

import type { UiNode, ViewContext, ViewContribution, ViewRender } from '@matrix/plugin-api';

export const views: ViewContribution[] = [
  {
    id: 'course-list',
    title: '课程',
    kind: 'widget',
    // 宿主按这两项取数据。**不会**因此放宽插件自己的 permissions.data.read
    requires: ['course', 'session'],
    defaultSize: { w: 12, h: 2 },
  },
];

export const renders: Record<string, ViewRender> = {
  'course-list': renderCourseList,
};

function renderCourseList(ctx: ViewContext): UiNode {
  // 瞬时状态存宿主，插件自己不持有 —— 这就是 D8 在 UI 上的样子
  const showAll = ctx.ui.showAll === true;

  const sessions = ctx.records.filter((r) => r.type === 'session');
  const courses = ctx.records.filter((r) => r.type === 'course');

  const sessionCount = new Map<string, number>();
  for (const s of sessions) {
    const cid = typeof s.data.courseId === 'string' ? s.data.courseId : '';
    sessionCount.set(cid, (sessionCount.get(cid) ?? 0) + 1);
  }

  const rows = courses
    .map((c) => ({
      id: c.id,
      title: typeof c.data.title === 'string' ? c.data.title : '未命名课程',
      code: typeof c.data.code === 'string' ? c.data.code : '',
      count: sessionCount.get(c.id) ?? 0,
    }))
    .filter((c) => showAll || c.count > 0)
    .sort((a, b) => a.title.localeCompare(b.title, 'zh'));

  if (courses.length === 0) {
    return {
      type: 'card',
      title: '课程',
      children: [
        {
          type: 'empty',
          text: '还没有课表。导入一份 .ics 就能看到课程与课时。',
          action: { label: '去导入', onPress: { kind: 'navigate', to: 'settings' } },
        },
      ],
    };
  }

  const toggle: UiNode = {
    type: 'button',
    label: showAll ? '只看有课时的' : '显示全部',
    icon: 'search',
    onPress: { kind: 'setUi', key: 'showAll', value: !showAll },
  };

  const body: UiNode =
    rows.length === 0
      ? { type: 'empty', text: '所有课程都没有课时记录。' }
      : { type: 'list', items: rows.map(renderRow) };

  return {
    type: 'card',
    title: `课程（${rows.length}）`,
    children: [
      { type: 'stack', direction: 'row', gap: 'sm', align: 'center', children: [toggle] },
      body,
    ],
  };
}

function renderRow(c: { id: string; title: string; code: string; count: number }): UiNode {
  const children: UiNode[] = [{ type: 'text', text: c.title, weight: 'bold' }];
  if (c.code !== '') children.push({ type: 'badge', text: c.code, tone: 'faint' });
  children.push({
    type: 'badge',
    text: `${c.count} 节`,
    tone: c.count > 0 ? 'accent' : 'faint',
  });
  return { type: 'stack', direction: 'row', gap: 'sm', align: 'center', wrap: true, children };
}
