/**
 * `app.matrix.importer.ics` 的验收测试。
 *
 * 运行：`node src/plugins/builtin/importer-ics/conformance.test.ts`
 *
 * ## 这个文件要证明的事
 *
 * 它测的不是「ICS 解析对不对」这一件事，而是**插件契约对第一个真实插件是否够用**：
 * 一个真实 manifest 过校验 → install/activate → 宿主递文档 → 插件纯函数解析 →
 * 实体落进 DataBus → 消费方读得到。全程插件零 IO。
 *
 * 与 `core/plugin-api-diff.test.ts` 的分工：那边用**假插件**测契约（`source: 'host'`
 * 的隔离、权限闸、游标），这边用**真插件**测「写一个插件顺不顺手」。
 * 两边都保留 —— 假插件能造出真插件不肯造的坏输入，真插件能暴露假插件不会遇到的别扭。
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

import type { PluginExports } from '@matrix/plugin-api';
import { validateManifest } from '@matrix/plugin-api';

import { MockTransport, createCore } from '../../../core/index.ts';
import { PluginHost } from '../../../core/plugin-host.ts';

import { LOCAL_URL, PLUGIN_ID, icsImporter, manifest } from './index.ts';

// ---------------------------------------------------------------- 迷你测试框架

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  \u2713 ${name}`);
    })
    .catch((e: unknown) => {
      failures.push(name);
      console.log(`  \u2717 ${name}`);
      console.log(`      ${e instanceof Error ? e.message : String(e)}`);
    });
}

function section(t: string): void {
  console.log(`\n${t}`);
}

// ---------------------------------------------------------------- 夹具

const NOW = 1_700_000_000_000;

/** 只读视图没有插件身份 —— 借宿主自己的命名空间读，语义上等价于「宿主在看」 */
const HOST_VIEW_ID = 'dev.matrix.shell';

function makeHost(opts: { maxLocalBytes?: number } = {}): PluginHost {
  const core = createCore({
    transport: new MockTransport(),
    // 本地导入不出网，白名单留空正好证明「一次都没走网关」
    gateway: { config: { allowlist: [] } },
  });
  return new PluginHost({
    core,
    modules: new Map<string, PluginExports>([[PLUGIN_ID, icsImporter]]),
    now: () => NOW,
    ...(opts.maxLocalBytes !== undefined ? { maxLocalBytes: opts.maxLocalBytes } : {}),
  });
}

async function installed(opts: { maxLocalBytes?: number } = {}): Promise<PluginHost> {
  const host = makeHost(opts);
  const r = await host.install(manifest, { allowReservedPrefix: true });
  assert.equal(r.ok, true, r.ok ? '' : `${r.code} ${r.message}`);
  return host;
}

function rowsOf(host: PluginHost, type: string) {
  const r = host.bus.read(HOST_VIEW_ID, type);
  assert.equal(r.ok, true);
  return r.ok ? r.data : [];
}

/** 完整走一遍「宿主递文档 → 同步 → 清掉文档」，返回同步报告 */
async function importText(host: PluginHost, text: string, settings?: Record<string, string>) {
  const p = host.provideLocal(PLUGIN_ID, LOCAL_URL, text);
  assert.equal(p.ok, true, p.ok ? '' : `${p.code} ${p.message}`);
  const r = await host.sync(PLUGIN_ID, {
    trigger: 'manual',
    now: NOW,
    ...(settings !== undefined ? { settings } : {}),
  });
  // 契约要求：UI 导入完成后清掉，否则下次 sync 会把同一份文件再解析一遍
  host.clearLocal(PLUGIN_ID, LOCAL_URL);
  assert.equal(r.ok, true, r.ok ? '' : `${r.code} ${r.message}`);
  return r.data;
}

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Matrix//ICS test//CN',
  'X-WR-CALNAME:高等数学',
  'BEGIN:VEVENT',
  'UID:evt-1@test',
  'SUMMARY:第一讲',
  'LOCATION:教学中心 302',
  'DTSTART;TZID=Asia/Shanghai:20250901T080000',
  'DTEND;TZID=Asia/Shanghai:20250901T094000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:evt-2@test',
  'SUMMARY:第二讲',
  'DTSTART:20250902T000000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

/** 2025-09-01 08:00 墙钟（UTC+8）= 2025-09-01T00:00Z */
const SEP1_0800 = Date.UTC(2025, 8, 1, 0, 0, 0);
const SEP1_0940 = Date.UTC(2025, 8, 1, 1, 40, 0);
const SEP2_0000Z = Date.UTC(2025, 8, 2, 0, 0, 0);

// ================================================================ 1. 契约

section('1. manifest 与生命周期');

await test('manifest 通过 validateManifest（宿主显式放行保留前缀）', () => {
  const v = validateManifest(manifest, { allowReservedPrefix: true });
  assert.equal(v.ok, true, v.ok ? '' : v.issues.map((i) => `${i.path}: ${i.message}`).join('; '));
  // 默认**不**放行 —— 证明 allowReservedPrefix 这道闸是真的在起作用，
  // 而不是「官方插件自动豁免」（那样第三方照抄 kind 就能绕过）
  const denied = validateManifest(manifest);
  assert.equal(denied.ok, false, '不传 allowReservedPrefix 时，app.matrix.* 必须被拒');
  assert.ok(
    denied.issues.some((i) => i.path === 'id'),
    `应在 id 上报错，实际: ${denied.issues.map((i) => i.path).join(',')}`,
  );
});

await test('保留前缀默认被拒：不传 allowReservedPrefix 就装不上', async () => {
  const host = makeHost();
  const r = await host.install(manifest);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'EMANIFEST');
});

await test('install → activate，kind 逐字核对通过', async () => {
  const host = await installed();
  const rec = host.registry.get(PLUGIN_ID);
  assert.ok(rec, '注册表里应有记录');
  assert.equal(rec.state, 'active');
  assert.equal(rec.manifest.kind, 'first-party');
});

await test('宿主快照能列出插件与数据规模', async () => {
  const host = await installed();
  await importText(host, ICS);
  const snap = host.snapshot();
  assert.equal(snap.plugins.length, 1);
  assert.equal(snap.plugins[0]?.id, PLUGIN_ID);
  assert.equal(snap.plugins[0]?.state, 'active');
  assert.equal(snap.data.records, 3, '1 门课 + 2 节课');
});

// ================================================================ 2. 端到端

section('2. 端到端：宿主递文档 → 插件解析 → 落库');

await test('一次导入产出 1 门课 + 2 节课，且全程零出网', async () => {
  const host = await installed();
  const report = await importText(host, ICS);

  assert.equal(report.entities, 3, `实际 entities=${report.entities}`);
  assert.equal(report.rejectedEntities, 0, `被拒: ${report.errors.join(' / ')}`);
  assert.equal(report.requests, 1, '一次 host 请求');
  assert.ok(report.boundaryBytes > 0, '跨边界字节数应被统计');

  const courses = rowsOf(host, 'course');
  assert.equal(courses.length, 1);
  assert.equal(courses[0]?.data.title, '高等数学', 'X-WR-CALNAME 被当作课程名');
  assert.equal(courses[0]?.data.source, 'ics');

  const sessions = rowsOf(host, 'session');
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((s) => s.id), ['evt-1@test', 'evt-2@test'], 'UID 直接当主键');
});

await test('TZID 按固定偏移换算（+8 墙钟 08:00 = 00:00Z）', async () => {
  const host = await installed();
  await importText(host, ICS);
  const evt1 = rowsOf(host, 'session').find((s) => s.id === 'evt-1@test');
  assert.ok(evt1);
  assert.equal(evt1.data.startAt, SEP1_0800);
  assert.equal(evt1.data.endAt, SEP1_0940);
  assert.equal(evt1.data.tzid, 'Asia/Shanghai', 'TZID 原样保留，不参与换算');
  assert.equal(evt1.data.location, '教学中心 302');
});

await test('没有 DTEND 时给 45 分钟默认时长，而不是 0 或 1 天', async () => {
  const host = await installed();
  await importText(host, ICS);
  const evt2 = rowsOf(host, 'session').find((s) => s.id === 'evt-2@test');
  assert.ok(evt2);
  assert.equal(evt2.data.startAt, SEP2_0000Z, '带 Z 的值按 UTC 精确解析');
  assert.equal(evt2.data.endAt, SEP2_0000Z + 45 * 60_000);
});

await test('幂等：重复导入不产生重复行，只把 revision 加上去', async () => {
  const host = await installed();
  await importText(host, ICS);
  const before = rowsOf(host, 'session').map((s) => ({ id: s.id, revision: s.revision }));

  await importText(host, ICS);
  const after = rowsOf(host, 'session').map((s) => ({ id: s.id, revision: s.revision }));

  assert.equal(after.length, before.length, '行数不能变');
  assert.deepEqual(after.map((s) => s.id), before.map((s) => s.id));
  for (const [i, row] of after.entries()) {
    assert.equal(row.revision, (before[i]?.revision ?? 0) + 1, '同一 id 再写一次应递增 revision');
  }
});

await test('消费方（宿主视图）读得到插件写的数据', async () => {
  const host = await installed();
  await importText(host, ICS);
  const r = host.read(HOST_VIEW_ID, 'session', { limit: 10 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.length, 2);
  assert.equal(r.data[0]?.pluginId, PLUGIN_ID, '记录必须归写入者所有');
});

// ================================================================ 3. 失败路径

section('3. 失败路径：不崩、不静默、原因可读');

await test('坏文件：同步仍返回 ok，实体 0 条，原因进 errors', async () => {
  const host = await installed();
  const report = await importText(host, '这不是一个 ICS 文件');
  assert.equal(report.entities, 0);
  assert.ok(
    report.errors.some((e) => e.includes('iCalendar')),
    `实际 errors: ${report.errors.join(' / ')}`,
  );
});

await test('空文件也走同一条路，不是特例崩溃', async () => {
  const host = await installed();
  const report = await importText(host, '   \r\n  ');
  assert.equal(report.entities, 0);
  assert.ok(report.errors.some((e) => e.includes('空')), `实际: ${report.errors.join(' / ')}`);
});

await test('宿主没准备文档 ⇒ ENOTFOUND 进报告，不静默成功', async () => {
  const host = await installed();
  const r = await host.sync(PLUGIN_ID, { trigger: 'manual', now: NOW });
  assert.equal(r.ok, true, '同步本身不该失败 —— 失败的是这一次请求');
  if (!r.ok) return;
  assert.equal(r.data.entities, 0);
  assert.ok(r.data.errors[0]?.includes('ENOTFOUND'), `实际: ${r.data.errors[0]}`);
});

await test('clearLocal 之后不再解析旧文档', async () => {
  const host = await installed();
  await importText(host, ICS);
  const again = await host.sync(PLUGIN_ID, { trigger: 'manual', now: NOW });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.ok(again.data.errors[0]?.includes('ENOTFOUND'), '导入完成后旧文档必须已清掉');
});

await test('超大文档在 provideLocal 就早失败（ETOOBIG），不先进内存', async () => {
  const host = await installed({ maxLocalBytes: 32 });
  const p = host.provideLocal(PLUGIN_ID, LOCAL_URL, ICS);
  assert.equal(p.ok, false);
  assert.equal(p.ok === false && p.code, 'ETOOBIG');
});

// ================================================================ 4. 边界与诚实计数

section('4. 边界：只做声明过的子集，越界如实上报');

await test('RRULE 不展开：1 条周期事件只出 1 节课，原始规则原样保留', async () => {
  const host = await installed();
  const rruleIcs = [
    'BEGIN:VCALENDAR',
    'X-WR-CALNAME:线性代数',
    'BEGIN:VEVENT',
    'UID:weekly-1@test',
    'SUMMARY:周三上午',
    'DTSTART;TZID=Asia/Shanghai:20250903T080000',
    'DTEND;TZID=Asia/Shanghai:20250903T094000',
    'RRULE:FREQ=WEEKLY;COUNT=16;BYDAY=WE',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const report = await importText(host, rruleIcs);
  const sessions = rowsOf(host, 'session');
  assert.equal(sessions.length, 1, '不展开 —— 展开是 timetable 的事');
  assert.equal(sessions[0]?.data.rrule, 'FREQ=WEEKLY;COUNT=16;BYDAY=WE');
  assert.ok(
    report.summaries.some((s) => s.includes('未展开')),
    `摘要要如实说明，实际: ${report.summaries.join(' / ')}`,
  );
});

await test('VTIMEZONE 里的 DTSTART 不会被当成一节课', async () => {
  const host = await installed();
  const tzIcs = [
    'BEGIN:VCALENDAR',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:only@test',
    'SUMMARY:唯一一节课',
    'DTSTART:20250904T000000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  await importText(host, tzIcs);
  const sessions = rowsOf(host, 'session');
  assert.equal(sessions.length, 1, 'VTIMEZONE 的 DTSTART 若被当成事件，这里会是 2');
  assert.equal(sessions[0]?.id, 'only@test');
});

await test('未支持的属性被计数，且不会把实体顶成 ESCHEMA', async () => {
  const host = await installed();
  const weird = [
    'BEGIN:VCALENDAR',
    'X-WR-CALNAME:带杂质的课表',
    'BEGIN:VEVENT',
    'UID:weird@test',
    'SUMMARY:有额外属性',
    'DTSTART:20250905T000000Z',
    'X-CUSTOM-FIELD:随便什么',
    'EXDATE:20250912T000000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const report = await importText(host, weird);
  assert.equal(report.rejectedEntities, 0, `不该因为杂质被拒: ${report.errors.join(' / ')}`);
  assert.equal(report.entities, 2, '1 课 + 1 节');
  assert.ok(
    report.summaries.some((s) => s.includes('忽略')),
    `应如实说明忽略了属性，实际: ${report.summaries.join(' / ')}`,
  );
});

await test('折叠行与转义：长标题被拼回完整一句', async () => {
  const host = await installed();
  const folded = [
    'BEGIN:VCALENDAR',
    'X-WR-CALNAME:转义测试',
    'BEGIN:VEVENT',
    'UID:fold@test',
    'SUMMARY:这是一门名字很长的课\\, 需要折行',
    ' 才能写完',
    'DTSTART:20250906T000000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  await importText(host, folded);
  const s = rowsOf(host, 'session')[0];
  assert.ok(s);
  assert.equal(s.data.title, '这是一门名字很长的课, 需要折行才能写完');
});

await test('课程名三级优先：settings → X-WR-CALNAME → 兜底', async () => {
  const host = await installed();

  await importText(host, ICS, { courseTitle: '线性代数' });
  assert.equal(rowsOf(host, 'course')[0]?.data.title, '线性代数', 'settings 覆盖 X-WR-CALNAME');

  const bare = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:bare@test', 'DTSTART:20250907T000000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  await importText(host, bare);
  const titles = rowsOf(host, 'course').map((c) => c.data.title);
  assert.ok(titles.includes('未命名课程'), `实际: ${JSON.stringify(titles)}`);
});

await test('坏配置不会把课表算到别的时区：偏移越界退回 +8', async () => {
  const host = await installed();
  await importText(host, ICS, { utcOffsetMinutes: '99999' });
  const evt1 = rowsOf(host, 'session').find((s) => s.id === 'evt-1@test');
  assert.ok(evt1);
  assert.equal(evt1.data.startAt, SEP1_0800, '越界偏移应被忽略，退回默认 +8');
});

// ================================================================ 5. 零 IO

section('5. 零 IO：插件源码里没有 IO 原语');

await test('插件源码不含 fetch / Date.now / Capacitor / 内核依赖', () => {
  const dir = new URL('./', import.meta.url);
  const sources = ['index.ts', 'parse-ics.ts', 'manifest.ts'].map((f) =>
    readFileSync(new URL(f, dir), 'utf8'),
  );
  const joined = sources.join('\n');

  /*
   * 这条是**静态**断言，比运行时更硬：运行时可能碰巧没走到那条路，
   * 而源码里出现 `fetch` 就说明作者已经打算自己动手了 —— 那正是 D8 要防的。
   */
  for (const banned of ['fetch(', 'Date.now(', 'XMLHttpRequest', 'localStorage', '@capacitor', '@matrix/kernel']) {
    assert.equal(joined.includes(banned), false, `插件源码里不该出现 ${banned}`);
  }
});

await test('插件只依赖契约包，不依赖内核或平台', () => {
  const dir = new URL('./', import.meta.url);
  const index = readFileSync(new URL('index.ts', dir), 'utf8');
  assert.ok(index.includes("from '@matrix/plugin-api'"), '应当从契约包取类型');
  assert.equal(index.includes('PluginHost'), false, '插件不能认识宿主');
});

// ---------------------------------------------------------------- 收尾

console.log(
  failures.length === 0
    ? `\n全部通过：${passed} 项断言`
    : `\n失败 ${failures.length} 项 / 通过 ${passed} 项\n  ${failures.join('\n  ')}`,
);
process.exit(failures.length === 0 ? 0 : 1);
