/**
 * 模拟同步的断言。
 *
 * 这一组测试的用意很具体：**证明模拟通道喂给解析器的是真页面**。
 * 如果哪天有人把样本 HTML 改成一份「刚好能过」的假结构，
 * 这些断言会跟着变松 —— 所以这里断言的是**解析出来的内容**（课程名、作业名、
 * 截止时间、排课节次），而不是「解析没抛错」。
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ENTRY, PLUGIN_IDS, defaultSettings, currentWeek } from './model.ts';
import { gradescopeCourses, gradescopeAssignments, blackboardCourses, blackboardAssignment, eamsSelection, eamsTimetable } from './parsers.ts';
import { SimulatedAcademicTransport, simulatedPage, simulatedWeekOne } from './simulate.ts';
import { createConnector, connectorManifest, SNAPSHOT } from './connectors.ts';
import { ACADEMIC_ID, projectionManifest, projectionPlugin } from './projection.ts';
import { AcademicService } from '../../../core/academic-service.ts';
import { createCore, MockTransport } from '../../../core/index.ts';
import { PluginHost } from '../../../core/plugin-host.ts';
import { KvEntityBackend } from '../../../core/kv-entity-backend.ts';
import type { SecureStore } from '../../../platform/strategies/kv/types.ts';
import type { NotifyPort, ScheduledNotification } from '../../../core/notify/port.ts';
import { manifest as timelineManifest, timelinePlugin, PLUGIN_ID as TIMELINE_ID } from '../timeline/index.ts';

const NOW = Date.parse('2026-10-17T20:00:00+08:00');

test('样本页覆盖三个平台的每一层，未覆盖的返回 null 而不是空页', () => {
  assert.match(simulatedPage(ENTRY.gradescope, NOW) ?? '', /交互设计/);
  assert.match(simulatedPage('https://www.gradescope.com/courses/11', NOW) ?? '', /assignments\/201/);
  assert.match(simulatedPage(ENTRY.blackboard, NOW) ?? '', /launcher\?type=Course/);
  assert.match(simulatedPage(ENTRY.eams, NOW) ?? '', /semesterCalendar/);
  assert.equal(simulatedPage('https://www.gradescope.com/courses/99', NOW), null);
  assert.equal(simulatedPage('https://example.com/', NOW), null);
});

test('Gradescope 样本能被真实解析器读懂：课程、作业名、截止时间', () => {
  const courses = gradescopeCourses(simulatedPage(ENTRY.gradescope, NOW) ?? '', ENTRY.gradescope);
  assert.deepEqual(courses.map((c) => c.title), ['交互设计', '算法设计']);
  assert.equal(courses[0]?.term, 'Fall 2026');

  const rows = gradescopeAssignments(simulatedPage('https://www.gradescope.com/courses/11', NOW) ?? '', courses[0]!, '');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((a) => a.title), ['线框草图 · 第二轮', '可用性测试报告', '叙事体验阅读札记']);
  // 日期是按「现在」生成的，所以这里断言的是相对关系，不是死日期
  assert.equal(rows[0]?.dueAt, NOW + 5 * 3_600_000);
  assert.equal(rows[1]?.dueAt, NOW + 2 * 24 * 3_600_000);
  assert.ok((rows[2]?.dueAt ?? 0) < NOW, '第三条应当已经逾期');
  assert.equal(rows[0]?.status, 'not_submitted');
});

test('Blackboard 样本：课程入口、作业页标题与中文截止时间', () => {
  const courses = blackboardCourses(simulatedPage(ENTRY.blackboard, NOW) ?? '', ENTRY.blackboard);
  assert.deepEqual(courses.map((c) => c.title), ['操作系统', '计算机网络']);
  assert.equal(courses[0]?.id, 'blackboard:_123_1');

  const url = new URL('/webapps/assignment/uploadAssignment?content_id=_9001_1&course_id=_123_1', ENTRY.blackboard).href;
  const page = simulatedPage(url, NOW) ?? '';
  assert.match(page, /进程调度实验/);
  const assignment = blackboardAssignment(page, url, courses[0]!, '课程');
  assert.equal(assignment?.title, '进程调度实验');
  assert.equal(assignment?.dueAt, NOW + 26 * 3_600_000);
  assert.equal(assignment?.status, 'not_submitted');
});

test('教务样本：学生/学期参数与排课节次', () => {
  const selection = eamsSelection(simulatedPage(ENTRY.eams, NOW) ?? '', '');
  assert.equal(selection.student, '999');
  assert.equal(selection.semester, '100');

  const table = simulatedPage('https://eams.shanghaitech.edu.cn/eams/courseTableForStd!courseTable.action', NOW) ?? '';
  const parsed = eamsTimetable(table, '100');
  assert.deepEqual(parsed.courses.map((c) => c.title).sort(), ['操作系统', '算法设计']);
  assert.equal(parsed.rules.length, 3);
  // 第 1 周起、连续 15 周
  assert.deepEqual(parsed.rules[0]?.weeks, Array.from({ length: 15 }, (_, i) => i + 1));
  assert.ok(parsed.periods.length >= 6);
});

test('第一教学周落在两周前，同步完就是第 3 周', () => {
  const weekOne = simulatedWeekOne(NOW);
  assert.equal(weekOne, '2026-09-28'); // 2026-10-17 是周六，两周前的周一
  const settings = { ...defaultSettings(), weekOne };
  assert.equal(currentWeek(settings, NOW), 3);
});

test('模拟通道不截获非平台域名，也不给未覆盖的页面编内容', async () => {
  const fallback = new MockTransport({ status: 200, body: 'fallback' });
  const transport = new SimulatedAcademicTransport(fallback);
  const other = await transport.request({ url: 'https://example.com/x', method: 'GET', headers: {}, connectTimeoutMs: 1000, readTimeoutMs: 1000 });
  assert.equal(other.body, 'fallback');
  const missing = await transport.request({ url: 'https://www.gradescope.com/courses/99', method: 'GET', headers: {}, connectTimeoutMs: 1000, readTimeoutMs: 1000 });
  assert.equal(missing.status, 404);
});

class MemoryKv implements SecureStore {
  encrypted = false;
  map = new Map<string, string>();
  async get(k: string) { return this.map.get(k) ?? null; }
  async set(k: string, v: string) { this.map.set(k, v); }
  async remove(k: string) { this.map.delete(k); }
  async keys() { return [...this.map.keys()]; }
}
class Quiet implements NotifyPort {
  backend = 'test';
  async probe() {}
  isSupported() { return false; }
  capabilities() { return { exact: false, maxPending: 0, lostOnReboot: false, requiresPermission: false }; }
  async checkPermission() { return 'denied' as const; }
  async requestPermission() { return 'denied' as const; }
  async schedule(_items: readonly ScheduledNotification[]) {}
  async cancel(_ids: readonly string[]) {}
  async cancelAll() {}
  async pending() { return []; }
}

test('端到端：模拟同步跑完连接器、解析器、投影，作业进得去', async () => {
  const kv = new MemoryKv();
  const hosts = ['www.gradescope.com', 'elearning.shanghaitech.edu.cn', 'eams.shanghaitech.edu.cn'];
  const host = new PluginHost({
    core: createCore({ transport: new SimulatedAcademicTransport(new MockTransport()), gateway: { config: { allowlist: hosts, rateCapacity: 100, rateRefillPerSec: 100 } } }),
    dataBackend: new KvEntityBackend(kv),
    maxSteps: 605,
    modules: new Map<string, never>([
      [PLUGIN_IDS.gradescope, createConnector('gradescope')],
      [PLUGIN_IDS.blackboard, createConnector('blackboard')],
      [PLUGIN_IDS.eams, createConnector('eams')],
      [ACADEMIC_ID, projectionPlugin],
      [TIMELINE_ID, timelinePlugin],
    ] as never),
  });
  for (const manifest of [timelineManifest, connectorManifest('gradescope'), connectorManifest('blackboard'), connectorManifest('eams'), projectionManifest]) {
    const installed = await host.install(manifest, { allowReservedPrefix: true });
    assert.equal(installed.ok, true, JSON.stringify(installed));
  }
  await host.restoreData();

  const service = new AcademicService({ host, kv, notify: new Quiet(), available: true, login: async () => ({ completed: true }), clear: async () => {} });
  await service.init();
  await service.saveSettings({ ...service.settings, weekOne: simulatedWeekOne(Date.now()) });

  await service.sync('gradescope');
  const gradescope = service.snapshots.find((s) => s.provider === 'gradescope');
  assert.equal(gradescope?.courses.length, 2);
  assert.equal(gradescope?.assignments.length, 5);
  assert.match(service.statuses.gradescope ?? '', /同步成功/);

  await service.sync('blackboard');
  assert.equal(service.snapshots.find((s) => s.provider === 'blackboard')?.assignments.length, 1);

  await service.sync('eams');
  const eams = service.snapshots.find((s) => s.provider === 'eams');
  assert.equal(eams?.rules.length, 3);

  // 投影：作业变成 type='task' 的事件，课次变成 type='session'
  const events = host.bus.read(ACADEMIC_ID, 'academic_event', { owner: ACADEMIC_ID });
  assert.ok(events.ok);
  const tasks = events.data.filter((e) => e.data.type === 'task');
  const sessions = events.data.filter((e) => e.data.type === 'session');
  assert.equal(tasks.length, 6, 'Gradescope 5 条 + Blackboard 1 条');
  assert.ok(sessions.length > 0, '教务课表应当展开成课次');

  // 快照落到了 KV，重启还在
  const again = new AcademicService({ host, kv, notify: new Quiet(), available: true, login: async () => ({ completed: true }), clear: async () => {} });
  await again.init();
  assert.equal(again.snapshots.length, 3);
  assert.equal(again.snapshots.flatMap((s) => s.assignments).length, 6);
  assert.equal(host.bus.read(ACADEMIC_ID, SNAPSHOT, { owner: ACADEMIC_ID }).ok, true);
});
