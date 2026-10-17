/**
 * 插件数据持久化（dev.md T2）—— 后端契约 + 真实插件的端到端往返。
 *
 * 运行：node src/core/data-persistence.test.ts
 *
 * 这一套回答的核心问题只有一个：**刷新之后数据还在不在。**
 * 所以第 2 节刻意用「建一个新宿主、接同一个 KV」来模拟重启，
 * 而不是在同一份内存里断言 —— 那证明不了任何事。
 */

import { strict as assert } from 'node:assert';

import { type PluginExports } from '@matrix/plugin-api';

import { MockTransport, createCore } from './index.ts';
import { KvEntityBackend } from './kv-entity-backend.ts';
import { PluginHost } from './plugin-host.ts';

import { LOCAL_URL, PLUGIN_ID, icsImporter, manifest } from '../plugins/builtin/importer-ics/index.ts';
import type { SecureStore } from '../platform/strategies/kv/types.ts';

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

/** 内存 KV。真实实现（Keystore / Preferences / localStorage）都满足同一个接口 */
class MemoryKv implements SecureStore {
  readonly encrypted = false;
  readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

const NOW = 1_700_000_000_000;

/** 只读视图没有插件身份 —— 借宿主命名空间读，语义上等价于「宿主在看」 */
const HOST_VIEW_ID = 'dev.matrix.shell';

function rec(pluginId: string, type: string, id: string, data: Record<string, unknown>) {
  return { pluginId, type, id, data, updatedAt: NOW, revision: 1 };
}

function makeHost(kv: SecureStore): PluginHost {
  const core = createCore({
    transport: new MockTransport(),
    gateway: { config: { allowlist: [] } },
  });
  return new PluginHost({
    core,
    modules: new Map<string, PluginExports>([[PLUGIN_ID, icsImporter]]),
    now: () => NOW,
    dataBackend: new KvEntityBackend(kv),
  });
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

async function importIcs(host: PluginHost): Promise<void> {
  const p = host.provideLocal(PLUGIN_ID, LOCAL_URL, ICS);
  assert.equal(p.ok, true, p.ok ? '' : `${p.code} ${p.message}`);
  const r = await host.sync(PLUGIN_ID, { trigger: 'manual', now: NOW });
  host.clearLocal(PLUGIN_ID, LOCAL_URL);
  assert.equal(r.ok, true, r.ok ? '' : `${r.code} ${r.message}`);
}

function rowsOf(host: PluginHost, type: string) {
  const r = host.bus.read(HOST_VIEW_ID, type);
  assert.equal(r.ok, true);
  return r.ok ? r.data : [];
}

// ================================================================ 1. 后端契约

section('1. KvEntityBackend（DataBus 的 KV 后端）');

await test('save 后 loadAll 能原样读回，revision 不被重置', async () => {
  const kv = new MemoryKv();
  const backend = new KvEntityBackend(kv);

  await backend.save([{ kind: 'upsert', record: rec('p', 'note', 'n1', { title: 'a' }) }]);
  const loaded = await backend.loadAll();

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.id, 'n1');
  assert.equal(loaded[0]!.data.title, 'a');
  assert.equal(loaded[0]!.revision, 1);
});

await test('同一 (pluginId,type,id) 重复 upsert 是覆盖，不是追加', async () => {
  const kv = new MemoryKv();
  const backend = new KvEntityBackend(kv);

  await backend.save([{ kind: 'upsert', record: rec('p', 'note', 'n1', { title: 'a' }) }]);
  await backend.save([{ kind: 'upsert', record: rec('p', 'note', 'n1', { title: 'b' }) }]);

  const loaded = await backend.loadAll();
  assert.equal(loaded.length, 1, '幂等：重放同一条不得变成两行');
  assert.equal(loaded[0]!.data.title, 'b');
});

await test('dropPlugin 只删自己那个插件的键 —— 前缀相近的不受牵连', async () => {
  const kv = new MemoryKv();
  const backend = new KvEntityBackend(kv);

  // 这是真实存在的形状：`app.matrix.importer` 是 `app.matrix.importer.ics` 的前缀。
  // 扁平键布局（entity.<id>.<type>）下，删前者会把后者的数据一起带走。
  await backend.save([
    { kind: 'upsert', record: rec('app.matrix.importer', 'note', 'a', { title: '短' }) },
    { kind: 'upsert', record: rec('app.matrix.importer.ics', 'note', 'b', { title: '长' }) },
  ]);

  await backend.save([{ kind: 'dropPlugin', pluginId: 'app.matrix.importer' }]);

  const loaded = await backend.loadAll();
  assert.equal(loaded.length, 1, `前缀撞车：应只剩长 id 那条，实际 ${loaded.map((r) => r.pluginId).join(',')}`);
  assert.equal(loaded[0]!.pluginId, 'app.matrix.importer.ics');
});

await test('一批里 drop 与 upsert 混着来，drop 先落地', async () => {
  const kv = new MemoryKv();
  const backend = new KvEntityBackend(kv);

  await backend.save([{ kind: 'upsert', record: rec('p', 'note', 'old', { title: '旧' }) }]);

  // 「卸载后立刻重装」的真实形状
  await backend.save([
    { kind: 'dropPlugin', pluginId: 'p' },
    { kind: 'upsert', record: rec('p', 'note', 'new', { title: '新' }) },
  ]);

  const loaded = await backend.loadAll();
  assert.equal(loaded.length, 1, '旧数据必须先清掉，新记录不得叠在上面');
  assert.equal(loaded[0]!.id, 'new');
});

await test('损坏的数据挪到 .corrupt 备份键，不静默丢', async () => {
  const kv = new MemoryKv();
  const backend = new KvEntityBackend(kv);
  await kv.set(`entity.${'p'}`, '{ 这不是 JSON');

  const loaded = await backend.loadAll();
  assert.equal(loaded.length, 0);

  const keys = await kv.keys();
  assert.equal(
    keys.some((k) => k.includes('.corrupt.')),
    true,
    `损坏数据必须留证，实际键：${keys.join(',')}`,
  );
});

await test('一次批量只对每个插件读改写一次（不是每行一次）', async () => {
  const kv = new MemoryKv();
  let reads = 0;
  let writes = 0;
  const counting: SecureStore = {
    encrypted: false,
    get: (k) => {
      reads += 1;
      return kv.get(k);
    },
    set: (k, v) => {
      writes += 1;
      return kv.set(k, v);
    },
    remove: (k) => kv.remove(k),
    keys: () => kv.keys(),
  };
  const backend = new KvEntityBackend(counting);

  const batch = Array.from({ length: 50 }, (_, i) => ({
    kind: 'upsert' as const,
    record: rec('p', 'note', `n${i}`, { title: `t${i}` }),
  }));
  await backend.save(batch);

  assert.equal(reads, 1, `50 行应当只读 1 次，实际 ${reads}`);
  assert.equal(writes, 1, `50 行应当只写 1 次，实际 ${writes}`);
});

// ================================================================ 2. 端到端

section('2. 端到端：导入 → 重启 → 还在（用真实 ICS 插件）');

await test('sync 结束就落盘，队列不残留', async () => {
  const kv = new MemoryKv();
  const host = makeHost(kv);
  const inst = await host.install(manifest, { allowReservedPrefix: true });
  assert.equal(inst.ok, true, inst.ok ? '' : `${inst.code} ${inst.message}`);

  await importIcs(host);

  assert.equal(
    host.bus.pendingCount(),
    0,
    'sync() 必须自己刷盘 —— 否则「同步成功」只是内存里成功',
  );
  assert.ok(kv.map.size > 0, 'KV 里必须真的出现了键');
});

await test('重启后记录还在，且行数/字节数与重启前一致', async () => {
  const kv = new MemoryKv();

  const first = makeHost(kv);
  await first.install(manifest, { allowReservedPrefix: true });
  await importIcs(first);

  const beforeCourses = rowsOf(first, 'course').length;
  const beforeSessions = rowsOf(first, 'session').length;
  const beforeUsage = first.bus.usageOf(PLUGIN_ID);
  assert.ok(beforeCourses > 0 && beforeSessions > 0, '先决条件：导入得真的产出实体');

  // ---- 模拟重启：全新宿主、全新后端，只有 KV 是同一个 ----
  const second = makeHost(kv);
  await second.install(manifest, { allowReservedPrefix: true });
  const restored = await second.restoreData();
  assert.equal(restored.ok, true, restored.ok ? '' : restored.message);

  assert.equal(rowsOf(second, 'course').length, beforeCourses, '课程数必须一样');
  assert.equal(rowsOf(second, 'session').length, beforeSessions, '场次数必须一样');

  const afterUsage = second.bus.usageOf(PLUGIN_ID);
  assert.equal(afterUsage.rows, beforeUsage.rows, '配额计数要重建回来（否则配额判定会错）');
  assert.equal(afterUsage.bytes, beforeUsage.bytes, '字节数也要一致');

  // 内容也真的对得上，不只是数量
  const a = rowsOf(second, 'session').map((r) => r.data.title).sort();
  const b = rowsOf(first, 'session').map((r) => r.data.title).sort();
  assert.deepEqual(a, b, '标题必须一致');
});

await test('重启后同一个 id 再写一次是覆盖，不会翻倍', async () => {
  const kv = new MemoryKv();

  const first = makeHost(kv);
  await first.install(manifest, { allowReservedPrefix: true });
  await importIcs(first);
  const before = rowsOf(first, 'session').length;

  const second = makeHost(kv);
  await second.install(manifest, { allowReservedPrefix: true });
  await second.restoreData();
  await importIcs(second); // 再导一次同一份

  assert.equal(
    rowsOf(second, 'session').length,
    before,
    '同一份 ICS 重复导入应当幂等 —— 这是「重启后数据不会翻倍」的直接证据',
  );
});

await test('卸载会连数据一起从磁盘上删掉', async () => {
  const kv = new MemoryKv();

  const first = makeHost(kv);
  await first.install(manifest, { allowReservedPrefix: true });
  await importIcs(first);
  assert.ok(kv.map.size > 0);

  const un = await first.uninstall(PLUGIN_ID);
  assert.equal(un.ok, true, un.ok ? '' : `${un.code} ${un.message}`);

  const third = makeHost(kv);
  await third.install(manifest, { allowReservedPrefix: true });
  await third.restoreData();

  assert.equal(rowsOf(third, 'session').length, 0, '卸载后重启不得让数据复活');
});

await test('没配后端时 restoreData 返回 0 而不是报错（纯内存模式）', async () => {
  const core = createCore({
    transport: new MockTransport(),
    gateway: { config: { allowlist: [] } },
  });
  const host = new PluginHost({ core, modules: new Map(), now: () => NOW });

  const r = await host.restoreData();
  assert.equal(r.ok, true);
  assert.equal(r.ok ? r.data : -1, 0);
});

// ---------------------------------------------------------------- 收尾

console.log(
  failures.length === 0
    ? `\n全部通过：${passed} 项断言`
    : `\n失败 ${failures.length} 项 / 通过 ${passed} 项\n  ${failures.join('\n  ')}`,
);

if (failures.length > 0) process.exit(1);
