/**
 * 周课表的日期算术。
 *
 * 运行：node src/app/timetable.test.ts
 *
 * 这一段必须单独测：`weekday` 是 1=周一…7=周日，而 JS 的 `getDay()` 是
 * 0=周日…6=周六，两套编号差一天。错一天的表现是「周二的课排到周一」——
 * 界面上看着完全正常，只有真去上课的人知道错了。
 */

import { strict as assert } from 'node:assert';

import { buildWeekDays, lessonCount, teachingWeek, type TimetableRule } from './timetable.ts';

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

/** 2026-09-14 是周一 */
const WEEK_ONE = '2026-09-14';
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

const PERIODS = [
  { start: '08:15', end: '09:00' },
  { start: '09:10', end: '09:55' },
  { start: '10:15', end: '11:00' },
  { start: '11:10', end: '11:55' },
  { start: '13:00', end: '13:45' },
];

const RULES: TimetableRule[] = [
  { id: 'a', title: '概率论', teacher: '张', location: '教学中心204', weekday: 2, first: 3, last: 4, weeks: [1, 2, 3] },
  { id: 'b', title: '英语', teacher: '李', location: '创管107', weekday: 1, first: 1, last: 2, weeks: [2] },
  { id: 'c', title: '设计', teacher: '王', location: 'E307', weekday: 6, first: 5, last: 5, weeks: [2, 3] },
];

test('第 1 教学周的周一就是第 1 周', () => {
  assert.equal(teachingWeek(WEEK_ONE, at(2026, 9, 14)), 1);
});

test('同一周的周日仍算第 1 周', () => {
  assert.equal(teachingWeek(WEEK_ONE, at(2026, 9, 20)), 1);
});

test('下一个周一是第 2 周', () => {
  assert.equal(teachingWeek(WEEK_ONE, at(2026, 9, 21)), 2);
});

test('开学前返回 0，日期没填返回 null —— 两者不能混', () => {
  assert.equal(teachingWeek(WEEK_ONE, at(2026, 9, 1)), 0);
  assert.equal(teachingWeek('', at(2026, 9, 14)), null);
  assert.equal(teachingWeek('2026/09/14', at(2026, 9, 14)), null);
});

test('weekday 1 落在周一，weekday 7 落在周日', () => {
  const days = buildWeekDays({ rules: [], periods: PERIODS, week: 1, weekOne: WEEK_ONE, now: at(2026, 9, 14), showWeekend: true });
  assert.equal(days.length, 7);
  assert.equal(days[0].label, '周一');
  assert.equal(days[0].date, '9月14日');
  assert.equal(days[6].label, '周日');
  assert.equal(days[6].date, '9月20日');
});

test('第 2 周整体后移 7 天', () => {
  const days = buildWeekDays({ rules: [], periods: PERIODS, week: 2, weekOne: WEEK_ONE, now: at(2026, 9, 14), showWeekend: true });
  assert.equal(days[0].date, '9月21日');
  assert.equal(days[0].isToday, false);
});

test('只排这一周生效的课，节次换算成时间', () => {
  const days = buildWeekDays({ rules: RULES, periods: PERIODS, week: 2, weekOne: WEEK_ONE, now: at(2026, 9, 21), showWeekend: true });
  assert.equal(lessonCount(days), 3);
  const tue = days[1];
  assert.equal(tue.lessons.length, 1);
  assert.equal(tue.lessons[0].title, '概率论');
  assert.equal(tue.lessons[0].start, '10:15');
  assert.equal(tue.lessons[0].end, '11:55');
  assert.equal(tue.lessons[0].periods, '第 3-4 节');
});

test('第 1 周只有一条规则生效', () => {
  const days = buildWeekDays({ rules: RULES, periods: PERIODS, week: 1, weekOne: WEEK_ONE, now: at(2026, 9, 14), showWeekend: true });
  assert.equal(lessonCount(days), 1);
  assert.equal(days[0].lessons.length, 0);
});

test('不显示周末时只返回周一到周五', () => {
  const days = buildWeekDays({ rules: RULES, periods: PERIODS, week: 2, weekOne: WEEK_ONE, now: at(2026, 9, 21), showWeekend: false });
  assert.equal(days.length, 5);
  assert.equal(lessonCount(days), 2, '周六那条要被裁掉');
});

test('今天那格标 isToday', () => {
  const days = buildWeekDays({ rules: [], periods: PERIODS, week: 2, weekOne: WEEK_ONE, now: at(2026, 9, 23, 8), showWeekend: true });
  assert.equal(days.filter((d) => d.isToday).length, 1);
  assert.equal(days[2].label, '周三');
  assert.equal(days[2].isToday, true);
});

test('同一天多节课按节次升序', () => {
  const rules: TimetableRule[] = [
    { id: 'late', title: '下午课', weekday: 3, first: 5, last: 5, weeks: [1] },
    { id: 'early', title: '上午课', weekday: 3, first: 1, last: 1, weeks: [1] },
  ];
  const days = buildWeekDays({ rules, periods: PERIODS, week: 1, weekOne: WEEK_ONE, now: at(2026, 9, 14), showWeekend: true });
  assert.deepEqual(days[2].lessons.map((l) => l.title), ['上午课', '下午课']);
});

test('节次超出节次表时不崩，时间留空', () => {
  const rules: TimetableRule[] = [{ id: 'x', title: '夜课', weekday: 1, first: 9, last: 9, weeks: [1] }];
  const days = buildWeekDays({ rules, periods: PERIODS, week: 1, weekOne: WEEK_ONE, now: at(2026, 9, 14), showWeekend: true });
  assert.equal(days[0].lessons[0].start, '');
  assert.equal(days[0].lessons[0].periods, '第 9 节');
});

console.log('');
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：${failures.join('、')}`);
  process.exitCode = 1;
} else {
  console.log(`全部通过：${passed} 项断言`);
}
