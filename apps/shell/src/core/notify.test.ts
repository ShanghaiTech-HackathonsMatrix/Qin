/**
 * 通知桥接缝的测试。
 *
 * 这里钉的是**「没有就说没有」**：
 * 当前构建没有通知能力，那么它必须诚实地报 unsupported，
 * 并且在真的被调用时**炸掉**，而不是静默吞掉。
 *
 * 各平台 bridge 落地后，这个文件里的 unsupported 用例仍然有效 ——
 * 因为 web 构建永远走这条路。
 */

import { strict as assert } from 'node:assert';

import type {
  MatrixNotifyPlugin,
  NotifyCapabilities as WireCapabilities,
  NotifyPermission as WirePermission,
  ScheduledNotification as WireNotification,
} from '@matrix/capacitor-notify';

import { CapacitorNotifyPort } from './notify/capacitor-port.ts';
import { lintNotifications, NO_CAPABILITIES, UnsupportedNotifyPort } from './notify/index.ts';
import type { ScheduledNotification } from './notify/index.ts';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (e: unknown) {
    failures.push(name);
    console.log(`  \u2717 ${name}`);
    console.log(`      ${e instanceof Error ? e.message : String(e)}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const NOW = Date.UTC(2025, 8, 1, 2, 0, 0);
const HOUR = 3_600_000;

const note = (id: string, at: number, extra: Partial<ScheduledNotification> = {}): ScheduledNotification => ({
  id,
  at,
  title: `提醒 ${id}`,
  ...extra,
});

// ---------------------------------------------------------------- 1. 没有就说没有

section('1. UnsupportedNotifyPort：没有就说没有');

const port = new UnsupportedNotifyPort();

await test('isSupported() 为 false —— 宿主据此不对外宣称支持 notify.local', () => {
  assert.equal(port.isSupported(), false);
  assert.equal(port.backend, 'unsupported');
});

await test('capabilities() 全零，调度器据此排不出任何东西', () => {
  assert.deepEqual(port.capabilities(), NO_CAPABILITIES);
  assert.equal(port.capabilities().maxPending, 0);
});

await test('权限查询如实回答 unsupported，而不是假装 denied', async () => {
  // denied 会引导用户「去设置里开权限」，但这个平台根本没有那个开关
  assert.equal(await port.checkPermission(), 'unsupported');
  assert.equal(await port.requestPermission(), 'unsupported');
});

await test('pending() 返回空数组 —— 这是真话，不是敷衍', async () => {
  assert.deepEqual(await port.pending(), []);
});

await test('schedule() 抛错而不是静默成功（假的比没有贵）', async () => {
  await assert.rejects(() => port.schedule([note('a', NOW + HOUR)]), /没有通知桥/);
});

await test('cancel() / cancelAll() 同样抛错', async () => {
  await assert.rejects(() => port.cancel(['a']), /没有通知桥/);
  await assert.rejects(() => port.cancelAll(), /没有通知桥/);
});

// ---------------------------------------------------------------- 2. 形状校验

section('2. lintNotifications：坏数据只丢自己，不拖累整批');

await test('正常的整批通过', () => {
  const { ok, rejected } = lintNotifications([note('a', NOW + HOUR), note('b', NOW + 2 * HOUR)], NOW);
  assert.equal(ok.length, 2);
  assert.equal(rejected.length, 0);
});

await test('已经过去的时刻被拒 —— 排进过去要么立刻响、要么永不响，两种都错', () => {
  const { ok, rejected } = lintNotifications([note('past', NOW - 1)], NOW);
  assert.equal(ok.length, 0);
  assert.match(rejected[0]!.reason, /过去/);
});

await test('空标题被拒', () => {
  const { rejected } = lintNotifications([{ id: 'x', at: NOW + HOUR, title: '   ' }], NOW);
  assert.match(rejected[0]!.reason, /title/);
});

await test('同一批里 id 重复：留第一条，后面的拒掉', () => {
  const { ok, rejected } = lintNotifications([note('dup', NOW + HOUR), note('dup', NOW + 2 * HOUR)], NOW);
  assert.equal(ok.length, 1);
  assert.equal(ok[0]!.at, NOW + HOUR);
  assert.match(rejected[0]!.reason, /重复/);
});

await test('at 不是有限数被拒（NaN / Infinity）', () => {
  const { rejected } = lintNotifications(
    [note('nan', Number.NaN), note('inf', Number.POSITIVE_INFINITY)],
    NOW,
  );
  assert.equal(rejected.length, 2);
  assert.match(rejected[0]!.reason, /有限数/);
});

await test('一条坏的只丢自己，同批好的照样通过', () => {
  const { ok, rejected } = lintNotifications(
    [note('good', NOW + HOUR), note('bad', NOW - HOUR), note('good2', NOW + 3 * HOUR)],
    NOW,
  );
  assert.deepEqual(ok.map((n) => n.id), ['good', 'good2']);
  assert.deepEqual(rejected.map((r) => r.id), ['bad']);
});

// ---------------------------------------------------------------- 3. 适配层

section('3. CapacitorNotifyPort：两端统一的适配层');

/** 假原生桥。默认「能用、上限 4 条」 */
class FakeNative implements MatrixNotifyPlugin {
  supported = true;
  caps: WireCapabilities = {
    exact: true,
    maxPending: 4,
    lostOnReboot: false,
    requiresPermission: true,
  };
  probeThrows = false;
  permission: WirePermission = 'granted';
  probeCalls = 0;
  scheduled: WireNotification[][] = [];
  cancelled: string[][] = [];
  cancelAllCalls = 0;
  pendingIds: string[] = ['a', 'b'];

  async isSupported(): Promise<{ supported: boolean }> {
    this.probeCalls += 1;
    if (this.probeThrows) throw new Error('原生桥炸了');
    return { supported: this.supported };
  }
  async capabilities(): Promise<WireCapabilities> {
    return this.caps;
  }
  async checkPermission(): Promise<{ permission: WirePermission }> {
    return { permission: this.permission };
  }
  async requestPermission(): Promise<{ permission: WirePermission }> {
    return { permission: this.permission };
  }
  async schedule(options: { items: WireNotification[] }): Promise<void> {
    this.scheduled.push(options.items);
  }
  async cancel(options: { ids: string[] }): Promise<void> {
    this.cancelled.push(options.ids);
  }
  async cancelAll(): Promise<void> {
    this.cancelAllCalls += 1;
  }
  async pending(): Promise<{ ids: string[] }> {
    return { ids: this.pendingIds };
  }
}

function makeAdapter(native: FakeNative, label?: string): CapacitorNotifyPort {
  return new CapacitorNotifyPort(native, { label, now: () => NOW });
}

await test('probe() 之前 isSupported() 为 false —— 「还没问过」不能说成「支持」', () => {
  const port2 = makeAdapter(new FakeNative());
  assert.equal(port2.isSupported(), false);
  assert.deepEqual(port2.capabilities(), NO_CAPABILITIES);
});

await test('probe() 之后能力就位', async () => {
  const native = new FakeNative();
  const port2 = makeAdapter(native);
  await port2.probe();

  assert.equal(port2.isSupported(), true);
  assert.deepEqual(port2.capabilities(), {
    exact: true,
    maxPending: 4,
    lostOnReboot: false,
    requiresPermission: true,
  });
});

await test('probe() 幂等：只问原生一次', async () => {
  const native = new FakeNative();
  const port2 = makeAdapter(native);
  await port2.probe();
  await port2.probe();
  assert.equal(native.probeCalls, 1);
});

await test('probe() 时原生抛错 → 降级为不支持，**不**把异常抛给装配流程', async () => {
  const native = new FakeNative();
  native.probeThrows = true;
  const port2 = makeAdapter(native);

  await port2.probe(); // 不该抛
  assert.equal(port2.isSupported(), false);
  assert.deepEqual(port2.capabilities(), NO_CAPABILITIES);
});

await test('说支持但 maxPending 为 0 → 视为不支持（自相矛盾时宁可不排）', async () => {
  const native = new FakeNative();
  native.caps = { exact: true, maxPending: 0, lostOnReboot: false, requiresPermission: true };
  const port2 = makeAdapter(native);
  await port2.probe();
  assert.equal(port2.isSupported(), false);
});

await test('maxPending 是负数或 NaN → 夹成 0，且视为不支持', async () => {
  const native = new FakeNative();
  native.caps = {
    exact: true,
    maxPending: -5,
    lostOnReboot: false,
    requiresPermission: true,
  };
  const port2 = makeAdapter(native);
  await port2.probe();
  assert.equal(port2.capabilities().maxPending, 0);
  assert.equal(port2.isSupported(), false);

  const native2 = new FakeNative();
  native2.caps = {
    exact: true,
    maxPending: Number.NaN,
    lostOnReboot: false,
    requiresPermission: true,
  };
  const port3 = makeAdapter(native2);
  await port3.probe();
  assert.equal(port3.capabilities().maxPending, 0);
});

await test('不支持时 schedule / cancel / cancelAll 全部抛错', async () => {
  const native = new FakeNative();
  native.supported = false;
  const port2 = makeAdapter(native);
  await port2.probe();

  await assert.rejects(() => port2.schedule([note('a', NOW + HOUR)]), /没有可用的通知桥/);
  await assert.rejects(() => port2.cancel(['a']), /没有可用的通知桥/);
  await assert.rejects(() => port2.cancelAll(), /没有可用的通知桥/);
});

await test('形状不合法 → 抛错并点名，而不是静默丢', async () => {
  const port2 = makeAdapter(new FakeNative());
  await port2.probe();
  await assert.rejects(
    () => port2.schedule([note('bad', NOW - HOUR), { id: '', at: NOW + HOUR, title: 'x' }]),
    /形状不合法/,
  );
});

await test('一批超过 maxPending → 抛错并带上限数字（截断会让两端行为分叉）', async () => {
  const native = new FakeNative(); // 上限 4
  const port2 = makeAdapter(native);
  await port2.probe();

  const many = Array.from({ length: 5 }, (_, i) => note(`n${i}`, NOW + HOUR * (i + 1)));
  await assert.rejects(() => port2.schedule(many), /超过本端上限 4/);
  assert.equal(native.scheduled.length, 0, '被拒的批次不该过桥');
});

await test('正常批次原样过桥，且 undefined 的可选字段不出现', async () => {
  const native = new FakeNative();
  const port2 = makeAdapter(native);
  await port2.probe();

  await port2.schedule([
    note('a', NOW + HOUR, { body: '正文', payload: '{"r":"k1"}' }),
    note('b', NOW + 2 * HOUR),
  ]);

  assert.equal(native.scheduled.length, 1);
  const batch = native.scheduled[0]!;
  assert.equal(batch.length, 2);
  assert.deepEqual(batch[0], {
    id: 'a',
    at: NOW + HOUR,
    title: '提醒 a',
    body: '正文',
    payload: '{"r":"k1"}',
  });
  assert.equal('body' in batch[1]!, false, '没有正文就不该有这个键');
  assert.equal('payload' in batch[1]!, false);
});

await test('cancel 空数组不发请求；非空原样过桥；cancelAll 转发', async () => {
  const native = new FakeNative();
  const port2 = makeAdapter(native);
  await port2.probe();

  await port2.cancel([]);
  assert.equal(native.cancelled.length, 0, '空批不该过桥');

  await port2.cancel(['x', 'y']);
  assert.deepEqual(native.cancelled[0], ['x', 'y']);

  await port2.cancelAll();
  assert.equal(native.cancelAllCalls, 1);
});

await test('pending() 透传；不支持时返回空数组（这是真话）', async () => {
  const native = new FakeNative();
  const port2 = makeAdapter(native);
  await port2.probe();
  assert.deepEqual(await port2.pending(), ['a', 'b']);

  const off = new FakeNative();
  off.supported = false;
  const port3 = makeAdapter(off);
  await port3.probe();
  assert.deepEqual(await port3.pending(), []);
});

await test('原生返回未知权限字符串 → 归一成 unsupported（不能引导用户去找不存在的开关）', async () => {
  const native = new FakeNative();
  native.permission = 'maybe' as WirePermission;
  const port2 = makeAdapter(native);
  await port2.probe();

  assert.equal(await port2.checkPermission(), 'unsupported');
  assert.equal(await port2.requestPermission(), 'unsupported');
});

await test('backend 带平台标签，便于在日志里分辨是哪一端', () => {
  assert.equal(makeAdapter(new FakeNative()).backend, 'capacitor');
  assert.equal(makeAdapter(new FakeNative(), 'android').backend, 'capacitor:android');
});

// ---------------------------------------------------------------- 收尾

console.log('\n============================================================');
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`失败 ${failures.length} 项 / 通过 ${passed} 项`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
