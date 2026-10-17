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
import { ddlsFromTasks, pickUrgent, sortByDue, type DdlItem } from './ddl-items.ts';

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

test('只认 kind=ddl', () => {
  const out = ddlsFromTasks([
    task({ kind: 'ddl' }),
    task({ kind: 'course' }),
    task({ kind: 'quiz' }),
    task({ kind: 'custom' }),
  ]);
  assert.equal(out.length, 1);
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