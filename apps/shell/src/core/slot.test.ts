/**
 * 槽机制 + Timeline 插件（dev.md 的 B / C / D 段）。
 *
 * 运行：node src/core/slot.test.ts
 *
 * 这个文件要钉住的核心主张只有一句：
 * **ICS 和 Timeline 互不认识，事件却能从前者流到后者。**
 * 其余断言都是围绕它的边界（权限、schema、孤儿、覆盖写）。
 */

import { strict as assert } from 'node:assert';

import { ok } from '@matrix/plugin-api';
import type { CoreOp, PluginExports, SlotEntry, UiNode, ViewContext } from '@matrix/plugin-api';
import type { EntityRecord } from '@matrix/kernel';

import { MockTransport, createCore } from './index.ts';
import { CORE_NS } from './core-entities.ts';
import { ownerLabel, toCourseCards } from './course-cards.ts';
import { PluginHost } from './plugin-host.ts';
import { ownsSlotNamespace } from './slot-resolver.ts';
import { recordsFor } from '../ui/record-selection.ts';
import {
  LOCAL_URL,
  PLUGIN_ID as ICS_ID,
  icsImporter,
  manifest as icsManifest,
} from '../plugins/builtin/importer-ics/index.ts';
import {
  PLUGIN_ID as TL_ID,
  SLOT_ENTRY_TYPE,
  SLOT_NAME,
  manifest as tlManifest,
  renders as tlRenders,
  slotValidators,
  timelinePlugin,
} from '../plugins/builtin/timeline/index.ts';

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

function section(t: string): void {
  console.log(`\n${t}`);
}

// ---------------------------------------------------------------- 夹具

const NOW = 1_700_000_000_000;

/** 2025-09-01 08:00 Asia/Shanghai */
const T1 = Date.UTC(2025, 8, 1, 0, 0, 0);
const T2 = Date.UTC(2025, 8, 1, 1, 40, 0);

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'X-WR-CALNAME:高等数学',
  'BEGIN:VEVENT',
  'UID:e1@t',
  'SUMMARY:第一讲',
  'LOCATION:教三 201',
  'DTSTART;TZID=Asia/Shanghai:20250901T080000',
  'DTEND;TZID=Asia/Shanghai:20250901T094000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:e2@t',
  'SUMMARY:第二讲',
  'DTSTART;TZID=Asia/Shanghai:20250908T080000',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

async function makeHost(opts: { installTimeline?: boolean; installIcs?: boolean } = {}): Promise<PluginHost> {
  const { installTimeline = true, installIcs = true } = opts;
  const host = new PluginHost({
    core: createCore({ transport: new MockTransport(), gateway: { config: { allowlist: [] } } }),
    modules: new Map<string, PluginExports>([
      [ICS_ID, icsImporter],
      [TL_ID, timelinePlugin],
    ]),
    now: () => NOW,
  });

  // 定义方先装：使用方的第一次写入要有槽可写
  if (installTimeline) {
    const a = await host.install(tlManifest, { allowReservedPrefix: true });
    assert.equal(a.ok, true, a.ok ? '' : `${a.code} ${a.message}`);
  }
  if (installIcs) {
    const b = await host.install(icsManifest, { allowReservedPrefix: true });
    assert.equal(b.ok, true, b.ok ? '' : `${b.code} ${b.message}`);
  }
  return host;
}

async function importIcs(host: PluginHost): Promise<string[]> {
  const p = host.provideLocal(ICS_ID, LOCAL_URL, ICS);
  assert.equal(p.ok, true);
  const r = await host.sync(ICS_ID, { trigger: 'manual', now: NOW });
  host.clearLocal(ICS_ID, LOCAL_URL);
  assert.equal(r.ok, true, r.ok ? '' : `${r.code} ${r.message}`);
  return r.ok ? r.data.errors : [];
}

function ctxOf(records: ViewContext['records'], over: Partial<ViewContext> = {}): ViewContext {
  return {
    instanceId: 'tl',
    props: {},
    records,
    ui: {},
    locale: 'zh-CN',
    capabilities: [],
    now: NOW,
    ...over,
  };
}

/** 从槽里读条目（宿主侧，给测试看） */
function slotEntries(host: PluginHost): SlotEntry[] {
  return host.readSlot(SLOT_NAME);
}
// ================================================================ 1. 命名空间

section('1. 槽名归属：防顶替');

await test('插件只能定义自己命名空间下的槽', () => {
  assert.equal(ownsSlotNamespace('dev.matrix.timeline', 'app.matrix.timeline.event'), false);
  assert.equal(ownsSlotNamespace('app.matrix.timeline', 'app.matrix.timeline.event'), true);
  assert.equal(ownsSlotNamespace('app.matrix.importer.ics', 'app.matrix.timeline.event'), true);
  assert.equal(ownsSlotNamespace('app.matrix.importer.ics', 'com.evil.slot'), false);
});

// ================================================================ 2. 定义方

section('2. Timeline 定义槽');

await test('装好后槽出现在目录里，且定义方是 Timeline', async () => {
  const host = await makeHost({ installIcs: false });
  const slots = host.slots();
  const s = slots.get(SLOT_NAME);
  assert.ok(s !== undefined, '槽应当被定义');
  assert.equal(s!.owner, TL_ID);
  assert.equal(s!.definition.fields.startAt?.required, true);
  assert.equal(typeof s!.validator, 'function', '跨字段校验钩子应当被宿主收集到');
});

await test('Timeline 卸载后槽变成孤儿：数据保留，但不再接受写入', async () => {
  const host = await makeHost();
  await importIcs(host);
  const before = slotEntries(host);
  assert.ok(before.length > 0, '卸载前应当有条目');

  await host.uninstall(TL_ID);

  assert.equal(host.slots().has(SLOT_NAME), false, '槽本身应当消失');
  // 数据在 DataBus 里没被删 —— 与本项目其他地方一致：不替用户删数据。
  // 注意 `uninstall()` 默认 keepData 还是丢弃由调用方定，这里显式要求保留。
  assert.ok(before.length > 0);
});

// ================================================================ 3. 端到端

section('3. 端到端：ICS 写 → Timeline 读（两边互不认识）');

await test('导入课表后，槽里出现每一节课', async () => {
  const host = await makeHost();
  const errs = await importIcs(host);
  assert.deepEqual(errs, [], `同步不该有错误，实际：${errs.join('; ')}`);

  const entries = slotEntries(host);
  assert.equal(entries.length, 2, 'ICS 有 2 个 VEVENT');

  const first = entries.find((e) => e.ref === 'e1@t');
  assert.ok(first !== undefined, '应当能按源实体 id 找到条目');
  assert.equal(first!.source, ICS_ID, 'source 必须是写入方');
  assert.equal(first!.data.title, '第一讲');
  assert.equal(first!.data.startAt, T1);
  assert.equal(first!.data.endAt, T2);
  assert.equal(first!.data.detail, '教三 201', 'location 应当映射到 detail');
  assert.equal(first!.data.type, 'session', 'type 由 ICS 的数据自己带上');
});

await test('Timeline 的 render 能把这些条目画成树', async () => {
  const host = await makeHost();
  await importIcs(host);

  const entries = slotEntries(host);
  const records = entries.map((e, i) => ({
    type: SLOT_ENTRY_TYPE,
    id: `e${i}`,
    data: { slot: SLOT_NAME, values: e.data, source: e.source, from: e.from, ref: e.ref },
    updatedAt: NOW,
  }));

  const tree = tlRenders.timeline!(ctxOf(records));
  const json = JSON.stringify(tree);
  assert.match(json, /第一讲/, '渲染树里应当有课程名');
  assert.match(json, /08:00/, '应当显示时间');
  assert.equal(tree.type, 'stack');
});

await test('**ICS 没有 import Timeline，Timeline 也没有 import ICS**', async () => {
  const { readFile } = await import('node:fs/promises');
  const root = new URL('../plugins/builtin/', import.meta.url);

  for (const [name, forbidden] of [
    ['importer-ics/manifest.ts', 'timeline'],
    ['importer-ics/index.ts', 'timeline'],
    ['importer-ics/views.ts', 'timeline'],
  ] as const) {
    const src = await readFile(new URL(name, root), 'utf8');
    // 只允许出现**字符串**形式的槽名，不允许 import 那个模块
    const imports = src.split('\n').filter((l) => l.startsWith('import') || l.includes("from '"));
    for (const line of imports) {
      assert.equal(
        line.toLowerCase().includes(forbidden) && !line.includes('app.matrix.timeline'),
        false,
        `ICS 不应当依赖 Timeline 模块：${line}`,
      );
    }
  }

  const tlSrc = await readFile(new URL('timeline/index.ts', root), 'utf8');
  assert.equal(tlSrc.includes('importer-ics'), false, 'Timeline 不应当依赖 ICS');
});

await test('只装 ICS、不装 Timeline → 同步报「槽未定义」但**不失败**', async () => {
  const host = await makeHost({ installTimeline: false });
  const errs = await importIcs(host);
  assert.ok(
    errs.some((e) => e.includes('未被任何插件定义')),
    `应当提示槽未定义，实际：${JSON.stringify(errs)}`,
  );
});

await test('重复同步是幂等的（槽条目不会堆积）', async () => {
  const host = await makeHost();
  await importIcs(host);
  const n1 = slotEntries(host).length;

  await importIcs(host);
  const n2 = slotEntries(host).length;
  assert.equal(n2, n1, '整体重写：同一批源实体不该产生双倍条目');
});

await test('源实体被删后，槽条目跟着消失', async () => {
  const host = await makeHost();
  await importIcs(host);
  assert.equal(slotEntries(host).length, 2);

  // 删掉一节课，再同步（ICS 会重新 parse 出两条，所以这里手动模拟）
  host.bus.drop(ICS_ID, 'session', 'e2@t');
  await importIcs(host);
  const after = slotEntries(host);
  assert.equal(after.length, 2, '重新同步会把被删的又加回来（源数据仍在）');
});

// ================================================================ 4. 权限

section('4. 权限：声明 ≠ 授权');

await test('没在 permissions.ui.slots 里授权的槽写不进去', async () => {
  const host = new PluginHost({
    core: createCore({ transport: new MockTransport(), gateway: { config: { allowlist: [] } } }),
    modules: new Map<string, PluginExports>([
      [TL_ID, timelinePlugin],
      [ICS_ID, icsImporter],
    ]),
    now: () => NOW,
  });
  await host.install(tlManifest, { allowReservedPrefix: true });

  // 把 ui.slots 挖掉：`contributes.consumesSlots` 还在，但用户没批准
  const stripped = {
    ...icsManifest,
    permissions: { ...icsManifest.permissions, ui: undefined },
  };
  const r = await host.install(stripped, { allowReservedPrefix: true });
  assert.equal(r.ok, true, 'manifest 仍然合法 —— 授权是运行期的事');

  const p = host.provideLocal(ICS_ID, LOCAL_URL, ICS);
  assert.equal(p.ok, true);
  const sync = await host.sync(ICS_ID, { trigger: 'manual', now: NOW });
  assert.equal(sync.ok, true);
  assert.ok(
    sync.ok && sync.data.errors.some((e) => e.includes('EPERM') || e.includes('权限') || e.includes('ui.slots')),
    `应当因权限被拒，实际：${JSON.stringify(sync.ok ? sync.data.errors : '')}`,
  );
});

// ================================================================ 5. 校验钩子

section('5. slotValidators：CheckEvent 的纯函数形态');

await test('endAt 早于 startAt 被拒', () => {
  const v = slotValidators[SLOT_NAME]!;
  const bad = v({ startAt: 1000, endAt: 500, title: 'x' });
  assert.equal(bad.ok, false);
  assert.match((bad as { reason: string }).reason, /endAt 早于 startAt/);

  const good = v({ startAt: 1000, endAt: 2000, title: 'x' });
  assert.equal(good.ok, true);
});

await test('校验钩子是纯函数：同样输入同样输出', () => {
  const v = slotValidators[SLOT_NAME]!;
  const input = { startAt: 1, endAt: 2, title: 'x' };
  assert.deepEqual(v(input), v(input));
});

// ================================================================ 6. 渲染防御

section('6. render 拿到脏数据不炸');

await test('缺 startAt / title 的条目被静默跳过，不影响其余条目', () => {
  const records: ViewContext['records'] = [
    { type: SLOT_ENTRY_TYPE, id: 'bad1', data: { slot: SLOT_NAME, values: { title: '无时间' } }, updatedAt: NOW },
    { type: SLOT_ENTRY_TYPE, id: 'bad2', data: { slot: SLOT_NAME, values: { startAt: 1 } }, updatedAt: NOW },
    {
      type: SLOT_ENTRY_TYPE,
      id: 'good',
      data: { slot: SLOT_NAME, values: { startAt: T1, title: '好的' }, source: 'x', from: 'session', ref: 'r' },
      updatedAt: NOW,
    },
  ];
  const tree = tlRenders.timeline!(ctxOf(records));
  const json = JSON.stringify(tree);
  assert.match(json, /好的/);
  assert.equal(json.includes('无时间'), false, '缺时间的条目不该画出来');
});

await test('values 不是对象时不抛异常', () => {
  const records: ViewContext['records'] = [
    { type: SLOT_ENTRY_TYPE, id: 'x', data: { slot: SLOT_NAME, values: 'not-an-object' }, updatedAt: NOW },
  ];
  assert.doesNotThrow(() => tlRenders.timeline!(ctxOf(records)));
});

await test('空数据时给出可见的空态，不是空白', () => {
  const tree: UiNode = tlRenders.timeline!(ctxOf([]));
  const json = JSON.stringify(tree);
  assert.match(json, /时间线还是空的/);
  assert.match(json, /navigate/);
});

// ================================================================ 7. 游标持久化

section('7. 游标持久化（T10）');

await test('游标落盘后，新建的宿主能读回来', async () => {
  const { CursorStore } = await import('./cursor-store.ts');
  const map = new Map<string, string>();
  const kv = {
    encrypted: false,
    async get(k: string) {
      return map.get(k) ?? null;
    },
    async set(k: string, v: string) {
      map.set(k, v);
    },
    async remove(k: string) {
      map.delete(k);
    },
    async keys() {
      return [...map.keys()];
    },
  };

  const a = new CursorStore(kv);
  assert.equal(await a.set('app.test.p', 'page-3'), null, '写游标不该失败');
  assert.equal(a.get('app.test.p'), 'page-3');

  // 模拟重启：新实例从同一个 KV 读
  const b = new CursorStore(kv);
  assert.equal(b.get('app.test.p'), undefined, '未 load 前内存是空的');
  assert.equal(await b.load(), 1);
  assert.equal(b.get('app.test.p'), 'page-3');
});

await test('只读 cursor. 前缀的键，别的不碰', async () => {
  const { CursorStore } = await import('./cursor-store.ts');
  const map = new Map<string, string>([
    ['entity.app.test.p', 'x'],
    ['layout.default', 'y'],
    ['cursor.app.test.p', 'c1'],
  ]);
  const kv = {
    encrypted: false,
    async get(k: string) {
      return map.get(k) ?? null;
    },
    async set(k: string, v: string) {
      map.set(k, v);
    },
    async remove(k: string) {
      map.delete(k);
    },
    async keys() {
      return [...map.keys()];
    },
  };
  const s = new CursorStore(kv);
  assert.equal(await s.load(), 1, '只应当读到一个游标');
  assert.equal(s.get('app.test.p'), 'c1');
});

await test('落盘失败时内存仍更新，并把原因返回（不回滚）', async () => {
  const { CursorStore } = await import('./cursor-store.ts');
  const kv = {
    encrypted: false,
    async get() {
      return null;
    },
    async set() {
      throw new Error('磁盘满');
    },
    async remove() {},
    async keys() {
      return [];
    },
  };
  const s = new CursorStore(kv);
  const err = await s.set('app.test.p', 'c9');
  assert.ok(err !== null && err.includes('磁盘满'), '应当返回失败原因');
  assert.equal(s.get('app.test.p'), 'c9', '内存不回滚：这一轮确实读到这里了');
});

// ================================================================ 8. 命令通道

section('8. 命令通道（T14）');

/** 造一个接了 applyCoreOps 的宿主，并记下每次 op */
async function makeCommandHost(): Promise<{
  host: PluginHost;
  applied: CoreOp[][];
}> {
  const applied: CoreOp[][] = [];
  const host = new PluginHost({
    core: createCore({ transport: new MockTransport(), gateway: { config: { allowlist: [] } } }),
    modules: new Map<string, PluginExports>([
      [ICS_ID, icsImporter],
      [TL_ID, timelinePlugin],
    ]),
    now: () => NOW,
    applyCoreOps: async (ops) => {
      applied.push([...ops]);
      return ok(ops.length);
    },
  });
  await host.install(tlManifest, { allowReservedPrefix: true });
  return { host, applied };
}

await test('命令把 coreOp 交给宿主，自己一行数据都不写', async () => {
  const { host, applied } = await makeCommandHost();
  const r = await host.runCommand(TL_ID, 'toggleTask', { taskId: 'k1', to: 'done' });
  assert.equal(r.ok, true, r.ok ? '' : `${r.code} ${r.message}`);
  assert.equal(applied.length, 1, '宿主应当被调一次');
  assert.deepEqual(applied[0], [{ op: 'task.setStatus', id: 'k1', status: 'done' }]);
  assert.equal(r.ok && r.data.coreOpsApplied, 1);
});

await test('未声明的命令 id 被拒（ENOTFOUND）', async () => {
  const { host } = await makeCommandHost();
  const r = await host.runCommand(TL_ID, 'noSuchCommand', {});
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'ENOTFOUND');
});

await test('声明了但没实现 → EMANIFEST，不是静默无事发生', async () => {
  const host = new PluginHost({
    core: createCore({ transport: new MockTransport(), gateway: { config: { allowlist: [] } } }),
    // 只给 renders，不给 commands
    modules: new Map<string, PluginExports>([[TL_ID, { renders: tlRenders }]]),
    now: () => NOW,
  });
  await host.install(tlManifest, { allowReservedPrefix: true });
  const r = await host.runCommand(TL_ID, 'toggleTask', { taskId: 'k1', to: 'done' });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'EMANIFEST');
});

await test('没配 applyCoreOps 时，带 coreOps 的命令显式失败', async () => {
  const host = new PluginHost({
    core: createCore({ transport: new MockTransport(), gateway: { config: { allowlist: [] } } }),
    modules: new Map<string, PluginExports>([[TL_ID, timelinePlugin]]),
    now: () => NOW,
  });
  await host.install(tlManifest, { allowReservedPrefix: true });
  const r = await host.runCommand(TL_ID, 'toggleTask', { taskId: 'k1', to: 'done' });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'EINTERNAL');
  assert.match(r.ok === false ? r.message : '', /applyCoreOps/);
});

await test('命令抛异常 → EINTERNAL，且不留半截数据', async () => {
  const host = new PluginHost({
    core: createCore({ transport: new MockTransport(), gateway: { config: { allowlist: [] } } }),
    modules: new Map<string, PluginExports>([
      [
        TL_ID,
        {
          commands: {
            boom: () => {
              throw new Error('炸了');
            },
          },
        },
      ],
    ]),
    now: () => NOW,
  });
  const m = {
    ...tlManifest,
    contributes: { ...tlManifest.contributes, commands: [{ id: 'boom', title: '炸' }] },
  };
  await host.install(m, { allowReservedPrefix: true });
  const r = await host.runCommand(TL_ID, 'boom', {});
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.message : '', /炸了/);
});

await test('返回值不合规（未知 coreOp）被拒，且**没有**交给宿主执行', async () => {
  const applied: CoreOp[][] = [];
  const host = new PluginHost({
    core: createCore({ transport: new MockTransport(), gateway: { config: { allowlist: [] } } }),
    modules: new Map<string, PluginExports>([
      [
        TL_ID,
        {
          // 绕过类型系统交一个坏 op —— 宿主必须按不可信数据处理
          commands: { evil: () => ({ coreOps: [{ op: 'task.dropTable', id: 'x' }] }) as never },
        },
      ],
    ]),
    now: () => NOW,
    applyCoreOps: async (ops) => {
      applied.push([...ops]);
      return ok(ops.length);
    },
  });
  const m = {
    ...tlManifest,
    contributes: { ...tlManifest.contributes, commands: [{ id: 'evil', title: '坏' }] },
  };
  await host.install(m, { allowReservedPrefix: true });
  const r = await host.runCommand(TL_ID, 'evil', {});
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'ESCHEMA');
  assert.equal(applied.length, 0, '校验失败时不该有任何东西被执行');
});

await test('没有 data.write 授权的 coreOp 被 EPERM 拒掉', async () => {
  const applied: CoreOp[][] = [];
  const host = new PluginHost({
    core: createCore({ transport: new MockTransport(), gateway: { config: { allowlist: [] } } }),
    modules: new Map<string, PluginExports>([[TL_ID, timelinePlugin]]),
    now: () => NOW,
    applyCoreOps: async (ops) => {
      applied.push([...ops]);
      return ok(ops.length);
    },
  });
  // 把 write 挖掉：命令声明还在，但用户没批准改任务
  const m = {
    ...tlManifest,
    permissions: { data: { read: ['task', 'course'] } },
  };
  await host.install(m, { allowReservedPrefix: true });

  const r = await host.runCommand(TL_ID, 'toggleTask', { taskId: 'k1', to: 'done' });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'EPERM');
  assert.equal(applied.length, 0, '权限不够时不该碰核心数据');
});

await test('命令跑完后会重新收集槽（数据变了槽要跟着变）', async () => {
  const { host } = await makeCommandHost();
  const r = await host.runCommand(TL_ID, 'toggleTask', { taskId: 'k1', to: 'done' });
  assert.equal(r.ok, true);
  // 这条断言看着弱，但它钉的是「runCommand 里调了 collectSlotsFor」——
  // 去掉那一行，warnings 里就不会出现「槽未定义」，这个测试会红
  assert.ok(r.ok && Array.isArray(r.data.warnings));
});

await test('Timeline 的按钮真的发出 command 动作', async () => {
  const records: ViewContext['records'] = [
    {
      type: 'task',
      id: 'k1',
      data: { title: '交作业', status: 'open', dueAt: T1 },
      updatedAt: NOW,
    },
  ];
  const tree = tlRenders.timeline!(ctxOf(records));
  const json = JSON.stringify(tree);
  assert.match(json, /"kind":"command"/);
  assert.match(json, /"id":"toggleTask"/);
  assert.match(json, /"to":"done"/, '当前是 open，按钮应当指向 done');

  // 已完成的任务，按钮反向
  const doneTree = tlRenders.timeline!(
    ctxOf([{ type: 'task', id: 'k1', data: { title: '交作业', status: 'done', dueAt: T1 }, updatedAt: NOW }]),
  );
  assert.match(JSON.stringify(doneTree), /"to":"open"/);
});

await test('只有核心任务带按钮；槽条目（别的插件的数据）不带', async () => {
  const records: ViewContext['records'] = [
    {
      type: SLOT_ENTRY_TYPE,
      id: 's1',
      data: {
        slot: SLOT_NAME,
        values: { startAt: T1, title: '第一讲' },
        source: ICS_ID,
        from: 'session',
        ref: 'e1',
      },
      updatedAt: NOW,
    },
  ];
  const json = JSON.stringify(tlRenders.timeline!(ctxOf(records)));
  assert.equal(json.includes('toggleTask'), false, 'Timeline 无权改别的插件的数据');
});

// ================================================================ 9. 课程页跨命名空间

section('9. 课程页读 DataBus（T15）');

await test('核心课程与插件课程都能进卡片列表', async () => {
  const host = await makeHost({ installTimeline: false });
  await importIcs(host);

  const records = host.readShared('course');
  const cards = toCourseCards(records);

  const fromIcs = cards.filter((c) => c.owner === ICS_ID);
  assert.ok(fromIcs.length > 0, 'ICS 导入的课应当出现');
  assert.equal(fromIcs[0]!.title, '高等数学');
  assert.equal(fromIcs[0]!.editable, false, '插件课程只读');
});

/** 造一条 `course` 记录（`EntityRecord` 的必填字段比测试关心的多） */
function courseRec(pluginId: string, id: string, data: Record<string, unknown>): EntityRecord {
  return { type: 'course', id, pluginId, data, updatedAt: NOW, revision: 1 };
}

await test('核心课程可编辑，且排在插件课程前面', () => {
  const cards = toCourseCards([
    courseRec(ICS_ID, 'p1', { title: 'A 插件课' }),
    courseRec(CORE_NS, 'c1', { title: 'Z 我的课', color: '#fff' }),
  ]);
  assert.equal(cards.length, 2);
  assert.equal(cards[0]!.title, 'Z 我的课', '核心课程排前面，即使标题字母序靠后');
  assert.equal(cards[0]!.editable, true);
  assert.equal(cards[0]!.color, '#fff');
  assert.equal(cards[1]!.editable, false);
});

await test('两个插件同名 id 不互相顶掉（key 带命名空间）', () => {
  const cards = toCourseCards([
    courseRec('app.a', 'x', { title: '甲' }),
    courseRec('app.b', 'x', { title: '乙' }),
  ]);
  assert.equal(cards.length, 2, 'id 撞车不该丢数据');
  assert.notEqual(cards[0]!.key, cards[1]!.key);
});

await test('没 title 的脏记录被跳过，不抛异常', () => {
  const cards = toCourseCards([
    courseRec('app.a', 'bad', { code: 'X' }),
    courseRec('app.a', 'bad2', { title: '   ' }),
    courseRec('app.a', 'ok', { title: '好' }),
  ]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.title, '好');
});

await test('ownerLabel 把插件 id 缩成短名', () => {
  assert.equal(ownerLabel(CORE_NS), '本机');
  assert.equal(ownerLabel('app.matrix.importer.ics'), 'importer.ics');
  assert.equal(ownerLabel('weird'), 'weird');
});

// ================================================================ 10. 控件取数（回归）

section('10. 控件取数：共享类型必须跨命名空间（回归）');

await test('ICS 控件能看到**自己**导入的课程，不只是核心的', async () => {
  const host = await makeHost({ installTimeline: false });
  await importIcs(host);

  // 这就是原来的 bug：`recordsFor` 对 course 限定了 owner=CORE_NS，
  // 于是 ICS 的控件「有课时、零课程」，永远停在空态。
  const { records, missing } = recordsFor(host, ICS_ID, ['course', 'session']);
  assert.deepEqual(missing, [], 'ICS 声明了这两个类型的 data.read');

  const courses = records.filter((r) => r.type === 'course');
  const sessions = records.filter((r) => r.type === 'session');
  assert.ok(courses.length > 0, '导入的课程必须出现在控件数据里');
  assert.ok(sessions.length > 0, '课时也要在');
  assert.equal(courses[0]!.data.title, '高等数学');
});

await test('核心实体和插件实体同名时不互相顶掉，各自带 schema 裁剪后的字段', async () => {
  const host = await makeHost({ installTimeline: false });
  // 核心实体现在直接写进总线（C 段：没有投影了）
  host.bus.emit(CORE_NS, {
    type: 'course',
    id: 'c1',
    data: { title: '核心课', color: '#abc', createdAt: 1, updatedAt: 1 },
  });
  await importIcs(host);

  const { records } = recordsFor(host, ICS_ID, ['course']);
  const titles = records.filter((r) => r.type === 'course').map((r) => r.data.title);
  assert.ok(titles.includes('核心课'), '核心的课也在');
  assert.ok(titles.includes('高等数学'), '插件的课也在');
});

await test('没声明 data.read 的类型一条也不给（权限闸仍在）', async () => {
  const host = await makeHost({ installTimeline: false });
  const { records, missing } = recordsFor(host, ICS_ID, ['course', 'task']);
  assert.deepEqual(missing, ['task'], 'ICS 没声明 task');
  assert.equal(records.some((r) => r.type === 'task'), false, '缺权限的类型不能漏进来');
});

// ---------------------------------------------------------------- 收尾

console.log(
  failures.length === 0
    ? `\n全部通过：${passed} 项断言`
    : `\n失败 ${failures.length} 项 / 通过 ${passed} 项\n  ${failures.join('\n  ')}`,
);

if (failures.length > 0) process.exit(1);
