/**
 * DDL 规整与「最近一天」挑选规则。
 *
 * 运行：node src/app/ddl-items.test.ts
 *
 * 这几条必须测，因为它们是**真实数据与演示数据共用**的分支：
 * 挑错了，首页就会显示昨天的逾期作业而把今天该交的挤掉 ——
 * 这种错误在界面上看不出来「是 bug」，只会让人以为今天没事。
 */

import { strict as assert } from 'node:assert';

import type { Task } from '../domain/types.ts';
import { ddlsFromTasks, pickUrgent, sortByDue, platformDdls, ddlMeta, type DdlItem } from './ddl-items.ts';

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (e: unknown) {
    failures.push(name);
    console.log(`  \u2717 ${name}`);
    console.log(`      ${e instanceof Error ? e.message : String(e)}`);
  }
}

const NOW = new Date(2026, 9, 17, 12, 0, 0).getTime(); // 2026-10-17 周六 12:00
const at = (dayOffset: number, hour: number, minute = 0) =>
  new Date(2026, 9, 17 + dayOffset, hour, minute).getTime();

let seq = 0;
const task = (patch: Partial<Task> = {}): Task => {
  seq += 1;
  return {
    id: `t${seq}`,
    kind: 'ddl',
    title: `任务 ${seq}`,
    courseId: null,
    dueAt: at(0, 20, 0),
    status: 'open',
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
};

const item = (id: string, dueAt: number): DdlItem => ({
  id, title: id, courseId: null, dueAt, source: '测试',
});

console.log('\nDDL：从任务里挑');

test('按「有没有截止时间」收，不按 kind 收', () => {
  const courseId = 't-course';
  const out = ddlsFromTasks([
    task({ id: 't-ddl', kind: 'ddl' }),
    task({ id: 't-quiz', kind: 'quiz' }),
    task({ id: 't-checkin', kind: 'checkin' }),
    task({ id: 't-custom', kind: 'custom' }),
    task({ id: courseId, kind: 'course' }),
  ]);
  // 只有 course 被排除：那是一节课，不是一件要交的事
  assert.equal(out.length, 4);
  assert.ok(!out.some((d) => d.id === courseId), 'kind=course 不该进 DDL 列表');
});

test('自建任务填了截止时间不会从两个列表里同时消失', () => {
  // 这条是回归测试：早先按 kind==='ddl' 过滤，导入文字进来的 custom 任务
  // 一旦有了截止时间，就既不在主列表也不在「自建任务」里 —— 界面凭空少一条
  const [only] = ddlsFromTasks([task({ kind: 'custom', dueAt: at(0, 22, 45) })]);
  assert.ok(only !== undefined, '带截止时间的自建任务必须进主列表');
  assert.equal(only?.dueAt, at(0, 22, 45));
});

test('自建标记：custom 算自建，ddl 不算（真实模式没有来源字段时的判据）', () => {
  const [custom] = ddlsFromTasks([task({ kind: 'custom' })]);
  assert.equal(custom?.selfMade, true);
  const [plain] = ddlsFromTasks([task({ kind: 'ddl' })]);
  assert.equal(plain?.selfMade, false);
});

test('整批都是自己加的时，全部打上自建标记（演示态用）', () => {
  const out = ddlsFromTasks([task({ kind: 'ddl' }), task({ kind: 'quiz' })], true);
  assert.deepEqual(out.map((d) => d.selfMade), [true, true]);
});

test('没有截止时间的任务不算 DDL', () => {
  assert.equal(ddlsFromTasks([task({ dueAt: null })]).length, 0);
});

test('已忽略的不算，已完成仍保留（逾期列表里要能看到它）', () => {
  assert.equal(ddlsFromTasks([task({ status: 'dismissed' })]).length, 0);
  assert.equal(ddlsFromTasks([task({ status: 'done' })]).length, 1);
});

test('真实任务的来源如实写「本机记录」，不编平台名', () => {
  const [only] = ddlsFromTasks([task()]);
  assert.equal(only?.source, '本机记录');
});

test('带 note 的会变成描述，空 note 不产生空字段', () => {
  const [withNote] = ddlsFromTasks([task({ note: '第三章' })]);
  assert.equal(withNote?.description, '第三章');
  const [empty] = ddlsFromTasks([task({ note: '' })]);
  assert.equal(empty !== undefined && 'description' in empty, false);
});

test('每一条都带上 taskId，详情才能回指到编辑表单', () => {
  const [only] = ddlsFromTasks([task({ id: 'abc' })]);
  assert.equal(only?.taskId, 'abc');
});

console.log('\nDDL：挑「最近」');

test('今天有就直接给今天，哪怕昨天还欠着', () => {
  const out = pickUrgent([item('yesterday', at(-1, 23, 59)), item('today', at(0, 20, 0))], NOW);
  assert.deepEqual(out.map((d) => d.id), ['today']);
});

test('今天同一天有多条就全留下', () => {
  const out = pickUrgent([item('a', at(0, 9, 0)), item('b', at(0, 21, 30))], NOW);
  assert.deepEqual(out.map((d) => d.id), ['a', 'b']);
});

test('今天没有就给最近的有事那天（不是最早那天）', () => {
  const out = pickUrgent([
    item('overdue', at(-3, 23, 59)),
    item('soon', at(2, 18, 0)),
    item('later', at(5, 18, 0)),
  ], NOW);
  assert.deepEqual(out.map((d) => d.id), ['soon']);
});

test('全逾期时给最久没处理的那一天', () => {
  const out = pickUrgent([item('old', at(-5, 9, 0)), item('recent', at(-1, 9, 0))], NOW);
  assert.deepEqual(out.map((d) => d.id), ['old']);
});

test('空列表返回空，不抛', () => {
  assert.deepEqual(pickUrgent([], NOW), []);
});

test('不改动传入的数组', () => {
  const input = [item('b', at(0, 21, 0)), item('a', at(0, 9, 0))];
  const before = input.map((d) => d.id);
  pickUrgent(input, NOW);
  assert.deepEqual(input.map((d) => d.id), before);
});

test('排序：任务日志按截止时间升序', () => {
  const out = sortByDue([item('c', at(3, 9, 0)), item('a', at(0, 9, 0)), item('b', at(1, 9, 0))]);
  assert.deepEqual(out.map((d) => d.id), ['a', 'b', 'c']);
});

console.log(
  failures.length === 0
    ? `\n全部通过：${passed} 项断言`
    : `\n失败 ${failures.length} 项 / 通过 ${passed} 项\n  ${failures.join('\n  ')}`,
);

if (failures.length > 0) process.exit(1);

// ---------------------------------------------------------------- 平台作业

const snapshot = (provider: string, assignments: readonly unknown[]) => ({
  provider,
  syncedAt: at(0, 9, 0),
  courses: [
    { id: `${provider}:1`, title: provider === 'gradescope' ? '交互设计' : '操作系统' },
    { id: `${provider}:2`, title: '算法设计' },
  ],
  assignments: assignments as never,
});

const assignment = (id: string, courseId: string, dueAt: number | null, status = 'not_submitted') => ({
  id, courseId, title: `作业 ${id}`, dueAt, status,
});

test('平台作业：没有明确截止时间的不进列表，不猜', () => {
  const out = platformDdls([snapshot('gradescope', [
    assignment('a1', 'gradescope:1', at(0, 22, 0)),
    assignment('a2', 'gradescope:2', null),
  ])]);
  assert.deepEqual(out.map((d) => d.id), ['a1']);
});

test('平台作业：来源写真实平台名，课程名跟着带出来', () => {
  const [item] = platformDdls([snapshot('gradescope', [assignment('a1', 'gradescope:1', at(0, 22, 0))])]);
  assert.equal(item?.source, 'Gradescope');
  assert.equal(item?.courseTitle, '交互设计');
  assert.equal(item?.selfMade, false);
  assert.equal(item?.provider, 'gradescope');
  assert.equal(item === undefined ? '' : ddlMeta(item), '交互设计 · Gradescope');
});

test('平台作业：BB 显示成「互动教学平台」，教务显示成「教务课表」', () => {
  const out = platformDdls([
    snapshot('blackboard', [assignment('b1', 'blackboard:1', at(0, 10, 0))]),
    snapshot('eams', [assignment('e1', 'eams:1', at(1, 10, 0))]),
  ]);
  assert.deepEqual(out.map((d) => d.source), ['互动教学平台', '教务课表']);
});

test('平台作业：按课程筛选，选空就是全不要', () => {
  const rows = [assignment('a1', 'gradescope:1', at(0, 22, 0)), assignment('a2', 'gradescope:2', at(0, 23, 0))];
  assert.equal(platformDdls([snapshot('gradescope', rows)], {}).length, 2);
  assert.deepEqual(platformDdls([snapshot('gradescope', rows)], { gradescope: ['gradescope:2'] }).map((d) => d.id), ['a2']);
  assert.equal(platformDdls([snapshot('gradescope', rows)], { gradescope: [] }).length, 0);
});

test('平台作业：个人修正优先于平台数据，隐藏的不显示', () => {
  const rows = [assignment('a1', 'gradescope:1', at(0, 22, 0)), assignment('a2', 'gradescope:1', at(0, 23, 0))];
  const out = platformDdls([snapshot('gradescope', rows)], {}, {
    a1: { title: '改过的名字', dueAt: at(2, 8, 0), note: '记得带草图' },
    a2: { hidden: true },
  });
  assert.deepEqual(out.map((d) => d.id), ['a1']);
  assert.equal(out[0]?.title, '改过的名字');
  assert.equal(out[0]?.dueAt, at(2, 8, 0));
  assert.equal(out[0]?.description, '记得带草图');
});

test('平台作业：已提交或已评分算完成，个人修正可以覆盖回来', () => {
  const out = platformDdls([snapshot('gradescope', [
    assignment('a1', 'gradescope:1', at(0, 22, 0), 'submitted'),
    assignment('a2', 'gradescope:1', at(0, 22, 0), 'graded'),
    assignment('a3', 'gradescope:1', at(0, 22, 0), 'not_submitted'),
  ])]);
  assert.deepEqual(out.map((d) => d.done === true), [true, true, false]);
  const reopened = platformDdls([snapshot('gradescope', [assignment('a1', 'gradescope:1', at(0, 22, 0), 'submitted')])], {}, { a1: { done: false } });
  assert.equal(reopened[0]?.done, undefined);
});

test('平台作业：多个平台并进同一个列表，不改动传入的数组', () => {
  const snapshots = [
    snapshot('gradescope', [assignment('a1', 'gradescope:1', at(0, 22, 0))]),
    snapshot('blackboard', [assignment('b1', 'blackboard:1', at(0, 21, 0))]),
  ];
  const before = JSON.stringify(snapshots);
  const out = platformDdls(snapshots);
  assert.equal(out.length, 2);
  assert.equal(JSON.stringify(snapshots), before);
  assert.deepEqual(sortByDue(out).map((d) => d.id), ['b1', 'a1']);
});
