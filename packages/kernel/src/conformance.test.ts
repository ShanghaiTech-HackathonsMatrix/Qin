/**
 * @matrix/kernel 一致性测试套件。
 *
 * 运行：node src/conformance.test.ts
 * （Node 24 原生类型擦除，无需构建）
 *
 * 覆盖的不变量：
 *   §5.6  生命周期状态机：install → activate → suspend → deactivate → uninstall
 *   §5.7  I4/I5/I6：信任与权限正交；信任变更触发重载；受限模式不激活
 *   §5.3  dataBus：schema 校验、配额、命名空间、字段投影
 *   §5.5  broker：宿主驱动状态机；maxSteps；插件异常不越界
 *   S5    状态机不得把累积状态每步传进传出（用 boundaryBytes 观测）
 */

import { strict as assert } from 'node:assert';

import {
  type Manifest,
  type ParsedEntity,
  type PlanInput,
  type PlannedRequest,
  type PluginExports,
  type PluginKind,
  type PluginResult,
} from '@matrix/plugin-api';

import {
  DataBus,
  MemoryTrustBackend,
  PluginRegistry,
  SyncBroker,
  TrustStore,
  byteLen,
  canTransition,
  deriveTrustLevel,
  jsonByteLen,
  projectFields,
  validateEntity,
  validateRequests,
  type BrokerResponse,
  type DataBackend,
  type DataChange,
  type EntityRecord,
  type EntitySchema,
  type LifecycleEvent,
  type LoadedPlugin,
  type PluginRuntime,
  type SignatureVerifier,
  type TrustChange,
} from './index.ts';

// ---------------------------------------------------------------- 迷你测试框架

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

let clock = 1_700_000_000_000;
const now = (): number => (clock += 1000);

// ---------------------------------------------------------------- 夹具

const CONNECTOR_MANIFEST = {
  id: 'org.shtu.ecloud',
  name: 'E云课堂连接器',
  version: '1.2.0',
  apiVersion: '^1.0.0',
  kind: 'connector',
  entry: 'bundle.js',
  permissions: {
    data: { write: ['course', 'ddl'], read: ['course'] },
    net: { domains: ['ecloud.example.edu'], methods: ['GET', 'POST'] },
  },
  contributes: {
    entityTypes: [
      {
        name: 'course',
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string', maxLength: 200 },
            teacher: { type: 'string' },
            credits: { type: 'integer' },
            /** 内部用，不外泄 */
            internalNote: { type: 'string', shared: false },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['title'],
        },
      },
      {
        name: 'ddl',
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            dueAt: { type: 'integer' },
            done: { type: 'boolean' },
          },
          required: ['title', 'dueAt'],
        },
      },
    ],
  },
};

const REMOTE_MANIFEST = {
  id: 'com.example.remote',
  name: '远程规则连接器',
  version: '1.0.0',
  apiVersion: '^1.0.0',
  kind: 'connector',
  entry: 'bundle.js',
  permissions: { net: { domains: ['rules.example.com'], methods: ['GET'] } },
  capabilities: {
    untrustedRemote: 'limited',
    restrictedSettings: ['autoSync'],
    remoteCode: { reason: '解析规则需随平台改版热更新', origins: ['rules.example.com'] },
  },
};

const STRICT_MANIFEST = {
  ...REMOTE_MANIFEST,
  id: 'com.example.strict',
  capabilities: { ...REMOTE_MANIFEST.capabilities, untrustedRemote: false },
};

/** 全部放行的验签器 */
const alwaysSigned: SignatureVerifier = {
  async verify() {
    return { ok: true, data: { fullySigned: true } };
  },
};

const neverSigned: SignatureVerifier = {
  async verify() {
    return { ok: true, data: { fullySigned: false } };
  },
};

/** 记录 load/unload 的假运行时 */
class FakeRuntime implements PluginRuntime {
  readonly loads: string[] = [];
  readonly unloads: string[] = [];
  private readonly registry = new Map<string, PluginExports>();
  private readonly kinds = new Map<string, PluginKind>();

  provide(pluginId: string, exports: PluginExports, kind: PluginKind = 'connector'): void {
    this.registry.set(pluginId, exports);
    this.kinds.set(pluginId, kind);
  }

  async load(manifest: Manifest): Promise<PluginResult<LoadedPlugin>> {
    this.loads.push(manifest.id);
    const exports = this.registry.get(manifest.id);
    if (!exports) {
      return { ok: false, code: 'ENOTFOUND', message: `假运行时没有 ${manifest.id}` };
    }
    return { ok: true, data: { exports, kind: this.kinds.get(manifest.id) ?? 'connector' } };
  }

  async unload(pluginId: string): Promise<void> {
    this.unloads.push(pluginId);
  }
}

function makeKernel(opts: {
  verifier?: SignatureVerifier;
  runtime?: FakeRuntime;
  capabilities?: readonly string[];
} = {}) {
  const audit: Array<{ pluginId: string; action: string; detail?: string }> = [];
  const backend = new MemoryTrustBackend();
  const trust = new TrustStore({
    backend,
    now,
    audit: (e) => audit.push({ pluginId: e.pluginId, action: e.action, detail: `${e.from ?? '-'} → ${e.to}` }),
  });
  const bus = new DataBus({ now });
  const runtime = opts.runtime ?? new FakeRuntime();
  const events: LifecycleEvent[] = [];
  const registry = new PluginRegistry({
    runtime,
    verifier: opts.verifier ?? alwaysSigned,
    trust,
    bus,
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    now,
    audit: (e) => audit.push({ pluginId: e.pluginId, action: e.action, ...(e.detail ? { detail: e.detail } : {}) }),
  });
  registry.on((e) => events.push(e));
  return { registry, trust, bus, runtime, backend, audit, events };
}

// ================================================================ 1. 信任状态机

async function section1(): Promise<void> {
  section('1. 信任状态机（§5.7）');

  await test('deriveTrustLevel：先看「远程代码 + 已授权」，再看签名', () => {
    assert.equal(deriveTrustLevel({ fullySigned: true, hasRemoteCode: false, remoteCodeGranted: false }), 'signed');
    assert.equal(deriveTrustLevel({ fullySigned: false, hasRemoteCode: false, remoteCodeGranted: false }), 'restricted');
    assert.equal(deriveTrustLevel({ fullySigned: true, hasRemoteCode: true, remoteCodeGranted: false }), 'restricted',
      '主包签了但声明了远程代码 ⇒ 仍有未签名路径 ⇒ restricted');
    assert.equal(deriveTrustLevel({ fullySigned: true, hasRemoteCode: true, remoteCodeGranted: true }), 'remote-trusted');
    assert.equal(deriveTrustLevel({ fullySigned: false, hasRemoteCode: true, remoteCodeGranted: true }), 'remote-trusted');
  });

  await test('迁移表很窄：不允许「顺手」的隐式升级', () => {
    assert.equal(canTransition('signed', 'remote-trusted'), true);
    assert.equal(canTransition('restricted', 'remote-trusted'), true);
    assert.equal(canTransition('remote-trusted', 'restricted'), true);
    assert.equal(canTransition('remote-trusted', 'signed'), true);
    assert.equal(canTransition('signed', 'signed'), true);
  });

  await test('register 反映事实；未授权时声明了远程代码就是 restricted', async () => {
    const { trust } = makeKernel();
    const r = await trust.register('com.example.remote', {
      fullySigned: true, hasRemoteCode: true, remoteCodeGranted: false,
    }, { remoteOrigins: ['rules.example.com'], restrictedSettings: ['autoSync'] });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.level, 'restricted');
    assert.equal(r.data.remoteCodeGranted, false);
    assert.deepEqual(r.data.restrictedSettings, ['autoSync']);
    assert.equal(trust.levelOf('com.example.remote'), 'restricted');
    assert.equal(trust.levelOf('从未登记过'), 'restricted', '未知插件默认是最保守的等级');
  });

  await test('grantRemote 需要来源域，且写入 everGranted', async () => {
    const { trust } = makeKernel();
    await trust.register('a.b.c', { fullySigned: true, hasRemoteCode: true, remoteCodeGranted: false }, { remoteOrigins: ['r.example.com'] });

    assert.equal(trust.isFirstRemoteGrant('a.b.c'), true);
    const g = await trust.grantRemote('a.b.c');
    assert.equal(g.ok, true);
    if (!g.ok) return;
    assert.equal(g.data.level, 'remote-trusted');
    assert.equal(g.data.remoteCodeGranted, true);
    assert.equal(g.data.everGranted, true);
    assert.equal(trust.isFirstRemoteGrant('a.b.c'), false, '授予后不再是「首次」');
  });

  await test('grantRemote 对未声明远程代码的插件拒绝（ETRUST）', async () => {
    const { trust } = makeKernel();
    await trust.register('a.b.c', { fullySigned: true, hasRemoteCode: false, remoteCodeGranted: false });
    const g = await trust.grantRemote('a.b.c');
    assert.equal(g.ok, false);
    assert.equal(g.ok === false && g.code, 'ETRUST');
  });

  await test('grantRemote 对未登记的插件给 ENOTFOUND，而不是崩', async () => {
    const { trust } = makeKernel();
    const g = await trust.grantRemote('nope.nope');
    assert.equal(g.ok, false);
    assert.equal(g.ok === false && g.code, 'ENOTFOUND');
  });

  await test('revokeRemote 回到 restricted，且保留 everGranted', async () => {
    const { trust } = makeKernel();
    await trust.register('a.b.c', { fullySigned: true, hasRemoteCode: true, remoteCodeGranted: false }, { remoteOrigins: ['r.example.com'] });
    await trust.grantRemote('a.b.c');
    const r = await trust.revokeRemote('a.b.c');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.level, 'restricted');
    assert.equal(r.data.remoteCodeGranted, false);
    assert.equal(r.data.everGranted, true, '撤销不该抹掉「曾经授予过」这个事实');
  });

  await test('重复撤销给 ETRUST 而不是静默成功', async () => {
    const { trust } = makeKernel();
    await trust.register('a.b.c', { fullySigned: true, hasRemoteCode: true, remoteCodeGranted: false }, { remoteOrigins: ['r.example.com'] });
    const r = await trust.revokeRemote('a.b.c');
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'ETRUST');
  });

  await test('register 不会因为一次验签就悄悄抹掉用户的授权', async () => {
    const { trust } = makeKernel();
    await trust.register('a.b.c', { fullySigned: true, hasRemoteCode: true, remoteCodeGranted: false }, { remoteOrigins: ['r.example.com'] });
    await trust.grantRemote('a.b.c');

    // 重新登记时主包不再全签名 —— 授权是用户的决定，不该被系统改
    const again = await trust.register('a.b.c', { fullySigned: false, hasRemoteCode: true, remoteCodeGranted: false }, { remoteOrigins: ['r.example.com'] });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.data.level, 'remote-trusted', '用户的授权保留');
    assert.ok(again.data.reason.includes('未完全验签'), `reason 应反映当前事实，实际: ${again.data.reason}`);
  });

  await test('每次变更写审计并通知订阅者', async () => {
    const { trust } = makeKernel();
    const changes: TrustChange[] = [];
    trust.onChange((c) => changes.push(c));

    await trust.register('a.b.c', { fullySigned: true, hasRemoteCode: true, remoteCodeGranted: false }, { remoteOrigins: ['r.example.com'] });
    await trust.grantRemote('a.b.c');
    await trust.revokeRemote('a.b.c');

    assert.equal(changes.length, 3);
    assert.deepEqual(changes.map((c) => c.to), ['restricted', 'remote-trusted', 'restricted']);
    assert.deepEqual(changes.map((c) => c.actor), ['system', 'user', 'user']);
    assert.equal(changes[0]!.from, null, '首次登记没有 from');
    assert.equal(changes[1]!.from, 'restricted');
  });

  await test('无变化时不产生变更记录（不刷屏审计）', async () => {
    const { trust } = makeKernel();
    const changes: TrustChange[] = [];
    trust.onChange((c) => changes.push(c));
    const input = { fullySigned: true, hasRemoteCode: false, remoteCodeGranted: false };
    await trust.register('a.b.c', input);
    await trust.register('a.b.c', input);
    assert.equal(changes.length, 1);
    assert.equal(trust.historyFor('a.b.c').length, 1);
  });

  await test('持久化往返：load() 能恢复等级与授权状态', async () => {
    const backend = new MemoryTrustBackend();
    const t1 = new TrustStore({ backend, now });
    await t1.register('a.b.c', { fullySigned: true, hasRemoteCode: true, remoteCodeGranted: false }, { remoteOrigins: ['r.example.com'] });
    await t1.grantRemote('a.b.c');

    const t2 = new TrustStore({ backend, now });
    const r = await t2.load();
    assert.equal(r.loaded, 1);
    assert.equal(r.dropped, 0);
    assert.equal(t2.levelOf('a.b.c'), 'remote-trusted');
    assert.equal(t2.get('a.b.c')?.remoteCodeGranted, true);
    assert.equal(t2.isFirstRemoteGrant('a.b.c'), false, '「曾经授予过」也要持久化');
  });

  await test('load() 对坏数据健壮：丢弃并计数，不抛', async () => {
    const backend = new MemoryTrustBackend();
    backend.poison([
      { pluginId: 'good.one', level: 'signed', updatedAt: 1 },
      { pluginId: 'bad.level', level: 'trusted-ish' },
      { level: 'signed' },
      null,
      42,
      { pluginId: '', level: 'signed' },
    ]);
    const t = new TrustStore({ backend, now });
    const r = await t.load();
    assert.equal(r.loaded, 1);
    assert.equal(r.dropped, 5);
    assert.equal(t.levelOf('good.one'), 'signed');
  });

  await test('badgeFor 常驻可见（工程要求 1）', async () => {
    const { trust } = makeKernel();
    await trust.register('a.b.c', { fullySigned: false, hasRemoteCode: false, remoteCodeGranted: false });
    const b = trust.badgeFor('a.b.c');
    assert.equal(b.level, 'restricted');
    assert.equal(b.label, '受限模式');
    assert.ok(b.hint.length > 0);
    assert.equal(trust.badgeFor('未知').label, '受限模式', '未知插件也显示为受限');
  });

  await test('forget 清掉记录与历史', async () => {
    const { trust } = makeKernel();
    await trust.register('a.b.c', { fullySigned: true, hasRemoteCode: false, remoteCodeGranted: false });
    await trust.forget('a.b.c');
    assert.equal(trust.get('a.b.c'), undefined);
    assert.equal(trust.historyFor('a.b.c').length, 0);
    assert.equal(trust.snapshot().length, 0);
  });
}

// ================================================================ 2. DataBus

async function section2(): Promise<void> {
  section('2. DataBus：schema / 配额 / 投影（§5.3）');

  const COURSE: EntitySchema = {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 10 },
      teacher: { type: 'string' },
      credits: { type: 'integer' },
      kind: { type: 'string', enum: ['必修', '选修'] },
      note: { type: 'string', nullable: true },
      internalNote: { type: 'string', shared: false },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['title'],
  };

  await test('validateEntity：类型 / 必填 / 枚举 / 长度 / 数组元素 / nullable', () => {
    assert.equal(validateEntity({ title: 'a' }, COURSE).length, 0);
    assert.ok(validateEntity({}, COURSE).some((i) => i.path === 'title'));
    assert.ok(validateEntity({ title: 1 }, COURSE).some((i) => i.path === 'title'));
    assert.ok(validateEntity({ title: 'a', credits: 1.5 }, COURSE).some((i) => i.path === 'credits'));
    assert.ok(validateEntity({ title: 'a', kind: '旁听' }, COURSE).some((i) => i.path === 'kind'));
    assert.ok(validateEntity({ title: 'aaaaaaaaaaaa' }, COURSE).some((i) => i.path === 'title'));
    assert.equal(validateEntity({ title: 'a', note: null }, COURSE).length, 0, 'nullable 允许 null');
    assert.ok(validateEntity({ title: 'a', teacher: null }, COURSE).some((i) => i.path === 'teacher'));
    assert.ok(validateEntity({ title: 'a', tags: ['x', 1] }, COURSE).some((i) => i.path === 'tags[1]'));
    assert.equal(validateEntity({ title: 'a', tags: [] }, COURSE).length, 0);
  });

  await test('validateEntity：additionalProperties 默认 false', () => {
    assert.ok(validateEntity({ title: 'a', 额外字段: 1 }, COURSE).some((i) => i.path === '额外字段'));
    const open: EntitySchema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true };
    assert.equal(validateEntity({ a: 'x', b: 2 }, open).length, 0);
  });

  await test('emit 前必须已声明实体类型（ESCHEMA）', () => {
    const bus = new DataBus({ now });
    const r = bus.emit('p1', { type: 'course', id: 'c1', data: { title: 'x' } });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'ESCHEMA');
  });

  await test('emit 通过 schema 后落库，并广播 upsert', () => {
    const bus = new DataBus({ now });
    bus.declareSchema('p1', 'course', COURSE);
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.kind));

    const r = bus.emit('p1', { type: 'course', id: 'c1', data: { title: '数学' } });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.revision, 1);
    assert.equal(r.data.pluginId, 'p1');
    assert.deepEqual(seen, ['upsert']);

    const again = bus.emit('p1', { type: 'course', id: 'c1', data: { title: '数学' } });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.data.revision, 2, '同一 id 重复写入递增 revision');
  });

  await test('emit 不合 schema 时给出逐字段 issue', () => {
    const bus = new DataBus({ now });
    bus.declareSchema('p1', 'course', COURSE);
    const r = bus.emit('p1', { type: 'course', id: 'c1', data: { title: 'a', credits: 'x' } });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'ESCHEMA');
    assert.ok((r.detail?.issues as string[]).some((s) => s.startsWith('credits:')));
  });

  await test('没给 id 时按内容生成稳定 id', () => {
    const bus = new DataBus({ now });
    bus.declareSchema('p1', 'course', COURSE);
    const a = bus.emit('p1', { type: 'course', data: { title: '数学' } });
    const b = bus.emit('p1', { type: 'course', data: { title: '数学' } });
    const c = bus.emit('p1', { type: 'course', data: { title: '物理' } });
    assert.equal(a.ok && b.ok && c.ok, true);
    if (!a.ok || !b.ok || !c.ok) return;
    assert.equal(a.data.id, b.data.id, '同样内容落到同一行');
    assert.notEqual(a.data.id, c.data.id);
  });

  await test('配额：行数超限给 EQUOTA', () => {
    const bus = new DataBus({ now, quota: { maxRowsPerPlugin: 2 } });
    bus.declareSchema('p1', 'course', COURSE);
    assert.equal(bus.emit('p1', { type: 'course', id: 'a', data: { title: 'x' } }).ok, true);
    assert.equal(bus.emit('p1', { type: 'course', id: 'b', data: { title: 'x' } }).ok, true);
    const third = bus.emit('p1', { type: 'course', id: 'c', data: { title: 'x' } });
    assert.equal(third.ok, false);
    assert.equal(third.ok === false && third.code, 'EQUOTA');
    // 更新已存在的行不该被配额挡住
    assert.equal(bus.emit('p1', { type: 'course', id: 'a', data: { title: 'y' } }).ok, true);
  });

  await test('配额：字节数超限给 EQUOTA', () => {
    const bus = new DataBus({ now, quota: { maxBytesPerPlugin: 40 } });
    bus.declareSchema('p1', 'course', COURSE);
    assert.equal(bus.emit('p1', { type: 'course', id: 'a', data: { title: 'aaaa' } }).ok, true);
    const big = bus.emit('p1', { type: 'course', id: 'b', data: { title: 'b', teacher: 'x'.repeat(200) } });
    assert.equal(big.ok, false);
    assert.equal(big.ok === false && big.code, 'EQUOTA');
  });

  await test('配额按插件独立计', () => {
    const bus = new DataBus({ now, quota: { maxRowsPerPlugin: 1 } });
    bus.declareSchema('p1', 'course', COURSE);
    bus.declareSchema('p2', 'course', COURSE);
    assert.equal(bus.emit('p1', { type: 'course', id: 'a', data: { title: 'x' } }).ok, true);
    assert.equal(bus.emit('p2', { type: 'course', id: 'b', data: { title: 'x' } }).ok, true);
    assert.equal(bus.emit('p1', { type: 'course', id: 'c', data: { title: 'x' } }).ok, false);
  });

  await test('字段投影：跨插件读取裁掉 shared:false', () => {
    const bus = new DataBus({ now });
    bus.declareSchema('p1', 'course', COURSE);
    bus.emit('p1', { type: 'course', id: 'c1', data: { title: '数学', internalNote: '内部备注' } });

    const own = bus.read('p1', 'course');
    assert.equal(own.ok, true);
    if (!own.ok) return;
    assert.equal(own.data[0]?.data.internalNote, '内部备注', '读自己写的不裁剪');

    const other = bus.read('p2', 'course');
    assert.equal(other.ok, true);
    if (!other.ok) return;
    assert.equal(other.data[0]?.data.title, '数学');
    assert.equal('internalNote' in (other.data[0]?.data ?? {}), false, '跨插件读取必须裁掉');
  });

  await test('projectFields：没声明 schema 时原样返回', () => {
    assert.deepEqual(projectFields({ a: 1 }, undefined), { a: 1 });
  });

  await test('read 对未知类型返回空数组，不是错误', () => {
    const bus = new DataBus({ now });
    const r = bus.read('p1', '不存在的类型');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.data, []);
  });

  await test('declareSchema 拒绝非法类型名与非 object schema', () => {
    const bus = new DataBus({ now });
    assert.equal(bus.declareSchema('p1', 'Course', COURSE).ok, false);
    assert.equal(bus.declareSchema('p1', 'a b', COURSE).ok, false);
    assert.equal(bus.declareSchema('p1', 'ok_type', { type: 'array' } as never).ok, false);
  });

  await test('dropPlugin 删掉该插件的全部记录', () => {
    const bus = new DataBus({ now });
    bus.declareSchema('p1', 'course', COURSE);
    bus.declareSchema('p2', 'course', COURSE);
    bus.emit('p1', { type: 'course', id: 'a', data: { title: 'x' } });
    bus.emit('p2', { type: 'course', id: 'b', data: { title: 'y' } });
    assert.equal(bus.stats().records, 2);
    assert.equal(bus.dropPlugin('p1'), 1);
    assert.equal(bus.stats().records, 1);
    assert.equal(bus.read('p1', 'course').ok && (bus.read('p1', 'course') as { data: unknown[] }).data.length, 1);
  });

  await test('forgetSchemas 之后不能再写（但记录还在）', () => {
    const bus = new DataBus({ now });
    bus.declareSchema('p1', 'course', COURSE);
    bus.emit('p1', { type: 'course', id: 'a', data: { title: 'x' } });
    bus.forgetSchemas('p1');
    assert.equal(bus.emit('p1', { type: 'course', id: 'b', data: { title: 'y' } }).ok, false);
    assert.equal(bus.stats().records, 1);
  });

  await test('usageOf 按插件统计行数与字节', () => {
    const bus = new DataBus({ now });
    bus.declareSchema('p1', 'course', COURSE);
    bus.declareSchema('p1', 'ddl', { type: 'object', properties: { title: { type: 'string' } } });
    bus.emit('p1', { type: 'course', id: 'a', data: { title: 'x' } });
    bus.emit('p1', { type: 'ddl', id: 'b', data: { title: 'y' } });
    const u = bus.usageOf('p1');
    assert.equal(u.rows, 2);
    assert.ok(u.bytes > 0);
    assert.equal(bus.usageOf('p2').rows, 0);
  });

  await test('命名空间隔离：两个插件写同一 type+id 不互相覆盖', () => {
    const bus = new DataBus({ now });
    bus.declareSchema('p1', 'course', COURSE);
    bus.declareSchema('p2', 'course', COURSE);

    const a = bus.emit('p1', { type: 'course', id: 'c1', data: { title: '甲的课' } });
    const b = bus.emit('p2', { type: 'course', id: 'c1', data: { title: '乙的课' } });
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.equal(a.data.revision, 1);
    assert.equal(b.data.revision, 1, '各自从 1 开始，谁也没顶掉谁');

    const all = bus.read('p1', 'course');
    assert.equal(all.ok, true);
    if (!all.ok) return;
    assert.equal(all.data.length, 2, '同 id 的两条记录并存');
    assert.deepEqual(
      all.data.map((r) => r.data.title).sort(),
      ['甲的课', '乙的课'].sort(),
    );
  });

  await test('内容哈希 id 也隔离：两个插件写同样内容仍是两条', () => {
    const bus = new DataBus({ now });
    bus.declareSchema('p1', 'course', COURSE);
    bus.declareSchema('p2', 'course', COURSE);
    const a = bus.emit('p1', { type: 'course', data: { title: '同' } });
    const b = bus.emit('p2', { type: 'course', data: { title: '同' } });
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.equal(a.data.id, b.data.id, 'id 由内容推导，所以两边算出来一样');
    assert.equal(bus.stats().records, 2, '但落到两行 —— 否则就是跨插件互相覆盖');
  });

  await test('字节配额按 UTF-8 真实字节计（中文不再被低估到 1/3）', () => {
    // 40 个汉字 = 120 字节（UTF-8），但 String.length 只有 40
    const bus = new DataBus({ now, quota: { maxBytesPerPlugin: 100 } });
    bus.declareSchema('p1', 'course', { type: 'object', properties: { title: { type: 'string' } } });
    const r = bus.emit('p1', { type: 'course', id: 'a', data: { title: '中'.repeat(40) } });
    assert.equal(r.ok, false, '按 UTF-16 长度算会误判成 40 字节而放行');
    assert.equal(r.ok === false && r.code, 'EQUOTA');
  });

  await test('usageOf 增量维护，与逐条重算完全一致', () => {
    const bus = new DataBus({ now });
    bus.declareSchema('p1', 'course', COURSE);
    bus.emit('p1', { type: 'course', id: 'a', data: { title: 'aa' } });
    bus.emit('p1', { type: 'course', id: 'b', data: { title: 'bbbb' } });
    const u1 = bus.usageOf('p1');
    assert.equal(u1.rows, 2);

    // 把 b 改小：字节要跟着减
    bus.emit('p1', { type: 'course', id: 'b', data: { title: 'b' } });
    const u2 = bus.usageOf('p1');
    assert.equal(u2.rows, 2, '行数不变');
    assert.ok(u2.bytes < u1.bytes, `更新缩小时字节要减：${u1.bytes} → ${u2.bytes}`);

    // 与全量重算对照
    const dump = bus.read('p1', 'course');
    assert.equal(dump.ok, true);
    if (!dump.ok) return;
    let rows = 0;
    let bytes = 0;
    for (const rec of dump.data as EntityRecord[]) {
      rows += 1;
      bytes += byteLen(JSON.stringify(rec.data));
    }
    assert.equal(u2.rows, rows);
    assert.equal(u2.bytes, bytes, '增量计数必须与逐条重算完全一致');

    bus.dropPlugin('p1');
    assert.deepEqual(bus.usageOf('p1'), { rows: 0, bytes: 0 }, 'dropPlugin 要一并清掉计数');
  });

  await test('byteLen：ASCII 走快路径，非 ASCII 按 UTF-8', () => {
    assert.equal(byteLen('abc'), 3);
    assert.equal(byteLen(''), 0);
    assert.equal(byteLen('中'), 3);
    assert.equal(byteLen('中'.repeat(40)), 120);
    assert.equal(byteLen('é'), 2);
    assert.equal(byteLen('🙂'), 4, '星平面字符 4 字节 / 2 个 UTF-16 码元');
    assert.equal(byteLen('a中b'), 5);
    assert.equal(jsonByteLen({ a: '中' }), byteLen('{"a":"中"}'));
    assert.equal(jsonByteLen(undefined), 0, 'undefined 序列化不出字符串，按 0 计');
  });
}

// ================================================================ 3. Broker

async function section3(): Promise<void> {
  section('3. SyncBroker：宿主驱动状态机（§5.5）');

  const DOMAINS = ['ecloud.example.edu'];

  function makeFetch(
    replies: Record<string, BrokerResponse | { code: string; message: string }>,
  ): { fetch: (r: PlannedRequest) => Promise<PluginResult<BrokerResponse>>; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      fetch: async (r: PlannedRequest) => {
        calls.push(r.url);
        const reply = replies[r.id] ?? replies[r.url];
        if (!reply) return { ok: false, code: 'ENET', message: `未配置的请求: ${r.id}` };
        if ('code' in reply) return { ok: false, code: reply.code as never, message: reply.message };
        return { ok: true, data: reply };
      },
    };
  }

  function makeBroker(deps: {
    fetch: (r: PlannedRequest) => Promise<PluginResult<BrokerResponse>>;
    emit?: (pluginId: string, e: ParsedEntity) => PluginResult<unknown>;
    domains?: readonly string[];
    maxSteps?: number;
    maxBodyBytes?: number;
    maxRequestsPerRound?: number;
  }): SyncBroker {
    return new SyncBroker({
      fetch: (req) => deps.fetch(req),
      domainsFor: () => deps.domains ?? DOMAINS,
      emit: deps.emit ?? (() => ({ ok: true, data: null })),
      now,
      ...(deps.maxSteps !== undefined ? { maxSteps: deps.maxSteps } : {}),
      ...(deps.maxBodyBytes !== undefined ? { maxBodyBytes: deps.maxBodyBytes } : {}),
      ...(deps.maxRequestsPerRound !== undefined ? { maxRequestsPerRound: deps.maxRequestsPerRound } : {}),
    });
  }

  const PLAN_INPUT: PlanInput = { trigger: 'manual', now: 1 };

  await test('happy path：plan → 发请求 → parser → 落库', async () => {
    const emitted: ParsedEntity[] = [];
    const f = makeFetch({ r1: { status: 200, body: '{"courses":[{"title":"数学"}]}', url: 'https://ecloud.example.edu/courses' } });

    const plugin: PluginExports = {
      plan: () => ({ requests: [{ id: 'r1', method: 'GET', url: 'https://ecloud.example.edu/courses', parse: 'courses' }] }),
      parsers: {
        courses: (i) => {
          const parsed = JSON.parse(i.body) as { courses: Array<{ title: string }> };
          return {
            entities: parsed.courses.map((c) => ({ type: 'course', data: { title: c.title } })),
            summary: `抓到 ${parsed.courses.length} 门课`,
          };
        },
      },
    };

    const broker = makeBroker({
      fetch: f.fetch,
      emit: (_p, e) => { emitted.push(e); return { ok: true, data: null }; },
    });
    const r = await broker.run('org.shtu.ecloud', plugin, PLAN_INPUT);
    assert.equal(r.ok, true, r.ok ? '' : r.message);
    if (!r.ok) return;
    assert.equal(r.data.steps, 1);
    assert.equal(r.data.requests, 1);
    assert.equal(r.data.entities, 1);
    assert.deepEqual(r.data.summaries, ['抓到 1 门课']);
    assert.equal(emitted.length, 1);
    assert.equal(f.calls.length, 1);
  });

  await test('多步：next() 返回 directive 时宿主继续跑', async () => {
    let round = 0;
    const f = makeFetch({
      p1: { status: 200, body: 'page1', url: 'https://ecloud.example.edu/p1' },
      p2: { status: 200, body: 'page2', url: 'https://ecloud.example.edu/p2' },
      p3: { status: 200, body: 'page3', url: 'https://ecloud.example.edu/p3' },
    });

    const plugin: PluginExports = {
      plan: () => ({ requests: [{ id: 'p1', method: 'GET', url: 'https://ecloud.example.edu/p1', parse: 'page' }] }),
      parsers: { page: (i) => ({ summary: i.body, cursor: i.body }) },
      next: () => {
        round += 1;
        if (round >= 3) return null;
        return {
          next: 'page',
          requests: [{ id: `p${round + 1}`, method: 'GET', url: `https://ecloud.example.edu/p${round + 1}`, parse: 'page' }],
        };
      },
    };

    const broker = makeBroker({ fetch: f.fetch });
    const r = await broker.run('p', plugin, PLAN_INPUT);
    assert.equal(r.ok, true, r.ok ? '' : r.message);
    if (!r.ok) return;
    assert.equal(r.data.steps, 3);
    assert.equal(r.data.requests, 3);
    assert.deepEqual(r.data.summaries, ['page1', 'page2', 'page3']);
  });

  await test('超过 maxSteps 给 ETIMEOUT（不会无限跑）', async () => {
    let n = 0;
    const plugin: PluginExports = {
      plan: () => ({ requests: [{ id: 'x0', method: 'GET', url: 'https://ecloud.example.edu/x', parse: 'x' }] }),
      parsers: { x: () => ({}) },
      next: () => {
        n += 1;
        return { next: 'x', requests: [{ id: `x${n}`, method: 'GET', url: 'https://ecloud.example.edu/x', parse: 'x' }] };
      },
    };
    const broker = makeBroker({
      fetch: async () => ({ ok: true, data: { status: 200, body: 'x', url: 'https://ecloud.example.edu/x' } }),
      maxSteps: 5,
    });
    const r = await broker.run('p', plugin, PLAN_INPUT);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'ETIMEOUT');
    assert.equal(r.detail?.maxSteps, 5);
    assert.equal(r.detail?.steps, 6, '第 6 轮才发现超限');
  });

  await test('域名不在白名单 → ENETDENIED，且请求根本没发出去', async () => {
    const f = makeFetch({});
    const plugin: PluginExports = {
      plan: () => ({ requests: [{ id: 'r1', method: 'GET', url: 'https://evil.example.com/steal', parse: 'x' }] }),
      parsers: { x: () => ({}) },
    };
    const broker = makeBroker({ fetch: f.fetch });
    const r = await broker.run('p', plugin, PLAN_INPUT);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'ENETDENIED');
    assert.equal(f.calls.length, 0, '被拒的请求绝不能到达传输层');
  });

  await test('http / IP / userinfo 在 broker 层也被拦', async () => {
    for (const url of ['http://ecloud.example.edu/x', 'https://192.168.1.1/x', 'https://u:p@ecloud.example.edu/x']) {
      const f = makeFetch({});
      const plugin: PluginExports = {
        plan: () => ({ requests: [{ id: 'r1', method: 'GET', url, parse: 'x' }] }),
        parsers: { x: () => ({}) },
      };
      const r = await makeBroker({ fetch: f.fetch }).run('p', plugin, PLAN_INPUT);
      assert.equal(r.ok, false, url);
      assert.equal(r.ok === false && r.code, 'ENETDENIED', url);
      assert.equal(f.calls.length, 0, url);
    }
  });

  await test('引用不存在的 parser → ENOTFOUND，并列出可用的', async () => {
    const f = makeFetch({ r1: { status: 200, body: 'x', url: 'https://ecloud.example.edu/x' } });
    const plugin: PluginExports = {
      plan: () => ({ requests: [{ id: 'r1', method: 'GET', url: 'https://ecloud.example.edu/x', parse: 'nope' }] }),
      parsers: { real: () => ({}) },
    };
    const r = await makeBroker({ fetch: f.fetch }).run('p', plugin, PLAN_INPUT);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'ENOTFOUND');
    assert.deepEqual(r.detail?.available, ['real']);
  });

  await test('插件抛异常 → EINTERNAL，不冒泡到宿主', async () => {
    const plugin: PluginExports = {
      plan: () => { throw new Error('插件内部炸了'); },
      parsers: {},
    };
    const r = await makeBroker({ fetch: makeFetch({}).fetch }).run('p', plugin, PLAN_INPUT);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'EINTERNAL');
    assert.ok(r.message.includes('插件内部炸了'));
  });

  await test('parser 抛异常同样被拦住', async () => {
    const f = makeFetch({ r1: { status: 200, body: 'x', url: 'https://ecloud.example.edu/x' } });
    const plugin: PluginExports = {
      plan: () => ({ requests: [{ id: 'r1', method: 'GET', url: 'https://ecloud.example.edu/x', parse: 'x' }] }),
      parsers: { x: () => { throw new Error('解析炸了'); } },
    };
    const r = await makeBroker({ fetch: f.fetch }).run('p', plugin, PLAN_INPUT);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'EINTERNAL');
  });

  await test('插件返回 Promise → ESCHEMA（契约要求全程同步）', async () => {
    const plugin = {
      plan: () => ({ requests: [] }),
      parsers: {},
    } as unknown as PluginExports;
    // 模拟一个违约的插件：plan 返回 Promise
    (plugin as { plan: unknown }).plan = () => Promise.resolve({ requests: [] });

    const r = await makeBroker({ fetch: makeFetch({}).fetch }).run('p', plugin, PLAN_INPUT);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, 'ESCHEMA');
    assert.ok(r.message.includes('Promise'));
  });

  await test('plan 返回垃圾形状 → ESCHEMA，且逐条指出问题', async () => {
    const bad = [
      { requests: 'nope' },
      { requests: [{ id: 'a', method: 'PUT', url: 'https://ecloud.example.edu/x', parse: 'x' }] },
      { requests: [{ id: '', method: 'GET', url: 'https://ecloud.example.edu/x', parse: 'x' }] },
      { requests: [{ id: 'a', method: 'GET', url: 'https://ecloud.example.edu/x', parse: '' }] },
      { requests: [{ id: 'a', method: 'GET', url: 'https://ecloud.example.edu/x', parse: 'x', headers: [] }] },
      { requests: [
        { id: 'dup', method: 'GET', url: 'https://ecloud.example.edu/x', parse: 'x' },
        { id: 'dup', method: 'GET', url: 'https://ecloud.example.edu/x', parse: 'x' },
      ] },
    ];
    for (const p of bad) {
      const plugin: PluginExports = { plan: () => p as never, parsers: { x: () => ({}) } };
      const r = await makeBroker({ fetch: makeFetch({}).fetch }).run('p', plugin, PLAN_INPUT);
      assert.equal(r.ok, false, JSON.stringify(p));
      assert.equal(r.ok === false && r.code, 'ESCHEMA', JSON.stringify(p));
    }
  });

  await test('单个请求失败不终止同步，原因进报告', async () => {
    const f = makeFetch({
      good: { status: 200, body: 'ok', url: 'https://ecloud.example.edu/good' },
      bad: { code: 'ETIMEOUT', message: '超时' },
    });
    const plugin: PluginExports = {
      plan: () => ({
        requests: [
          { id: 'bad', method: 'GET', url: 'https://ecloud.example.edu/bad', parse: 'x' },
          { id: 'good', method: 'GET', url: 'https://ecloud.example.edu/good', parse: 'x' },
        ],
      }),
      parsers: { x: () => ({ summary: 'ok' }) },
    };
    const r = await makeBroker({ fetch: f.fetch }).run('p', plugin, PLAN_INPUT);
    assert.equal(r.ok, true, r.ok ? '' : r.message);
    if (!r.ok) return;
    assert.equal(r.data.requests, 2);
    assert.equal(r.data.summaries.length, 1, '只有成功那条被解析');
    assert.equal(r.data.errors.length, 1);
    assert.ok(r.data.errors[0]!.includes('ETIMEOUT'));
  });

  await test('响应体超上限 → ETOOBIG', async () => {
    const f = makeFetch({ r1: { status: 200, body: 'x'.repeat(100), url: 'https://ecloud.example.edu/x' } });
    const plugin: PluginExports = {
      plan: () => ({ requests: [{ id: 'r1', method: 'GET', url: 'https://ecloud.example.edu/x', parse: 'x' }] }),
      parsers: { x: () => ({}) },
    };
    const r = await makeBroker({ fetch: f.fetch, maxBodyBytes: 50 }).run('p', plugin, PLAN_INPUT);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'ETOOBIG');
  });

  await test('单轮请求数超限 → EQUOTA', async () => {
    const plugin: PluginExports = {
      plan: () => ({
        requests: Array.from({ length: 5 }, (_, i) => ({
          id: `r${i}`, method: 'GET' as const, url: `https://ecloud.example.edu/${i}`, parse: 'x',
        })),
      }),
      parsers: { x: () => ({}) },
    };
    const r = await makeBroker({
      fetch: async () => ({ ok: true, data: { status: 200, body: '', url: 'https://ecloud.example.edu/' } }),
      maxRequestsPerRound: 3,
    }).run('p', plugin, PLAN_INPUT);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'EQUOTA');
  });

  await test('parser 收到的 ParseInput 里没有凭证字段', async () => {
    const f = makeFetch({ r1: { status: 200, body: 'x', url: 'https://ecloud.example.edu/x' } });
    let seenKeys: string[] = [];
    const plugin: PluginExports = {
      plan: () => ({ requests: [{ id: 'r1', method: 'GET', url: 'https://ecloud.example.edu/x', parse: 'x' }] }),
      parsers: { x: (i) => { seenKeys = Object.keys(i); return {}; } },
    };
    await makeBroker({ fetch: f.fetch }).run('p', plugin, PLAN_INPUT);
    assert.deepEqual(seenKeys.sort(), ['baseUrl', 'body', 'status']);
    assert.equal(seenKeys.includes('credentials'), false);
    assert.equal(seenKeys.includes('headers'), false, '响应头（含 set-cookie）不进沙箱');
  });

  await test('validateRequests 是纯函数，可单独复用', () => {
    assert.equal(validateRequests([]).length, 0);
    assert.ok(validateRequests(null).length > 0);
    assert.ok(validateRequests([{ id: 'a', method: 'GET', url: 'https://x.example.com/', parse: 'p', body: 1 }])
      .some((i) => i.field === 'body'));
  });

  // ---- 本地导入（v0.5）：第一个第一方插件暴露的两处契约缺口

  await test('plan().entities 在请求循环之前落库 —— 纯计算插件终于能产出数据', async () => {
    // 修之前：`bus.emit` 只挂在请求循环里，所以一个不发请求的 `kind: 'logic'` 插件
    // 永远产不出数据，而且 run() 返回 ok、**静默**什么都不做。
    const emitted: ParsedEntity[] = [];
    let fetchCalls = 0;
    const plugin: PluginExports = {
      plan: () => ({
        requests: [],
        entities: [{ type: 'course', data: { title: '算出来的' } }],
        summary: '本地计算，没有出网',
      }),
      parsers: {},
    };
    const r = await makeBroker({
      fetch: async () => {
        fetchCalls += 1;
        return { ok: true, data: { status: 200, body: '', url: '' } };
      },
      emit: (_p, e) => { emitted.push(e); return { ok: true, data: null }; },
    }).run('p', plugin, PLAN_INPUT);

    assert.equal(r.ok, true, r.ok ? '' : r.message);
    if (!r.ok) return;
    assert.equal(r.data.steps, 0, '一次请求都没发，步数应为 0');
    assert.equal(r.data.requests, 0);
    assert.equal(r.data.entities, 1);
    assert.deepEqual(r.data.summaries, ['本地计算，没有出网']);
    assert.equal(emitted.length, 1);
    assert.equal(fetchCalls, 0);
  });

  await test('plan().entities 不是数组 → ESCHEMA（不静默吞掉）', async () => {
    const plugin = { plan: () => ({ requests: [], entities: 'oops' }), parsers: {} } as unknown as PluginExports;
    const r = await makeBroker({
      fetch: async () => ({ ok: true, data: { status: 200, body: '', url: '' } }),
    }).run('p', plugin, PLAN_INPUT);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'ESCHEMA');
  });

  await test("source: 'host' 不过域名白名单 —— 它根本不出网", async () => {
    const emitted: ParsedEntity[] = [];
    let seenSource: string | undefined;
    const plugin: PluginExports = {
      plan: () => ({ requests: [{ id: 'ics', method: 'GET', url: 'host://import', parse: 'ics', source: 'host' }] }),
      parsers: { ics: (i) => ({ entities: [{ type: 'course', data: { title: i.body } }] }) },
    };
    // 域名白名单**为空** —— 走网络的请求会 ENETDENIED
    const r = await makeBroker({
      fetch: async (req) => {
        seenSource = req.source;
        return { ok: true, data: { status: 200, body: 'ICS-TEXT', url: req.url } };
      },
      domains: [],
      emit: (_p, e) => { emitted.push(e); return { ok: true, data: null }; },
    }).run('p', plugin, PLAN_INPUT);

    assert.equal(r.ok, true, r.ok ? '' : r.message);
    if (!r.ok) return;
    assert.equal(seenSource, 'host', '内核应把 source 原样交给宿主，由宿主决定怎么兑现');
    assert.equal(r.data.requests, 1, 'host 请求仍然计入 requests（它是一次真实的往返）');
    assert.equal(r.data.entities, 1);
    assert.equal(emitted.length, 1);
  });

  await test("source: 'host' 但 url 为空 → ESCHEMA（宿主拿它当查找键）", async () => {
    const plugin: PluginExports = {
      plan: () => ({ requests: [{ id: 'ics', method: 'GET', url: '', parse: 'ics', source: 'host' }] }),
      parsers: { ics: () => ({}) },
    };
    const r = await makeBroker({
      fetch: async () => ({ ok: true, data: { status: 200, body: '', url: '' } }),
    }).run('p', plugin, PLAN_INPUT);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'ESCHEMA');
  });

  await test("回归：source 缺省仍是 'net'，照样要过域名白名单", async () => {
    // 加 host 分支时最容易犯的错：把校验整体放宽了。
    const plugin: PluginExports = {
      plan: () => ({ requests: [{ id: 'r1', method: 'GET', url: 'https://evil.example.com/x', parse: 'x' }] }),
      parsers: { x: () => ({}) },
    };
    const r = await makeBroker({
      fetch: async () => ({ ok: true, data: { status: 200, body: '', url: '' } }),
      domains: [],
    }).run('p', plugin, PLAN_INPUT);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'ENETDENIED');
  });

  await test("validateRequests 校验 source：拼错的 'nett' 必须当场 ESCHEMA", () => {
    /*
     * 不查的话 `source: 'nett'` 会静默退化成 `'net'`：
     *   · 打在**已授权**的 URL 上 → 当作网络请求正常发出，**拼写错误无人发现**
     *   · 打在未授权的 URL 上 → 以 ENETDENIED 报出来，把用户指向「域名不在白名单」
     * 两条都与本函数存在的目的（尽早 ESCHEMA、把错误指到正确位置）相悖。
     */
    const bad = validateRequests([
      { id: 'a', method: 'GET', url: 'https://x.example.com/', parse: 'p', source: 'nett' },
      { id: 'b', method: 'GET', url: 'https://x.example.com/', parse: 'p', source: 1 },
      { id: 'c', method: 'GET', url: 'https://x.example.com/', parse: 'p', source: null },
    ]);
    assert.equal(bad.filter((i) => i.field === 'source').length, 3);

    const good = validateRequests([
      { id: 'a', method: 'GET', url: 'https://x.example.com/', parse: 'p' },
      { id: 'b', method: 'GET', url: 'https://x.example.com/', parse: 'p', source: 'net' },
      { id: 'c', method: 'GET', url: 'host://import', parse: 'p', source: 'host' },
    ]);
    assert.deepEqual(good, []);
  });

  await test('游标：plan().cursor 被收进 SyncReport（以前是死字段，从不被读）', async () => {
    const plugin: PluginExports = {
      plan: () => ({ requests: [], cursor: 'page=1' }),
      parsers: {},
    };
    const r = await makeBroker({
      fetch: async () => ({ ok: true, data: { status: 200, body: '', url: '' } }),
    }).run('p', plugin, PLAN_INPUT);
    assert.equal(r.ok, true, r.ok ? '' : r.message);
    if (!r.ok) return;
    assert.equal(r.data.cursor, 'page=1');
  });

  await test('游标：多请求的一轮里取**最后**一个非空值', async () => {
    const plugin: PluginExports = {
      plan: () => ({
        requests: [
          { id: 'a', method: 'GET', url: 'https://x.example.com/a', parse: 'p' },
          { id: 'b', method: 'GET', url: 'https://x.example.com/b', parse: 'p' },
        ],
        cursor: 'from-plan',
      }),
      parsers: { p: (i) => ({ cursor: `page=${i.body}` }) },
    };
    const r = await makeBroker({
      fetch: async (req) => ({ ok: true, data: { status: 200, body: req.id, url: req.url } }),
      domains: ['x.example.com'],
    }).run('p', plugin, PLAN_INPUT);
    assert.equal(r.ok, true, r.ok ? '' : r.message);
    if (!r.ok) return;
    assert.equal(r.data.cursor, 'page=b', '契约只给一个游标位，多请求时以最后一个为准');
  });

  await test('游标：没有游标时 SyncReport 不带这个键（不塞空串）', async () => {
    const plugin: PluginExports = { plan: () => ({ requests: [] }), parsers: {} };
    const r = await makeBroker({
      fetch: async () => ({ ok: true, data: { status: 200, body: '', url: '' } }),
    }).run('p', plugin, PLAN_INPUT);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal('cursor' in r.data, false, '空游标与「没有游标」必须可区分');
  });
}

// ================================================================ 4. Registry

async function section4(): Promise<void> {
  section('4. PluginRegistry：生命周期（§5.6）');

  await test('install：先验 manifest → 再验版本 → 再验签 → 最后才谈权限', async () => {
    const { registry } = makeKernel();

    const badManifest = await registry.install({ id: 'BAD' });
    assert.equal(badManifest.ok, false);
    assert.equal(badManifest.ok === false && badManifest.code, 'EMANIFEST');

    const badVersion = await registry.install({ ...CONNECTOR_MANIFEST, apiVersion: '^2.0.0' });
    assert.equal(badVersion.ok, false);
    assert.equal(badVersion.ok === false && badVersion.code, 'EAPIVERSION');

    const unsigned = await registry.install(CONNECTOR_MANIFEST, { activate: false });
    assert.equal(unsigned.ok, true);
  });

  await test('install：权限越权被拒，并写审计（篡改迹象）', async () => {
    const { registry, audit } = makeKernel();
    const r = await registry.install(CONNECTOR_MANIFEST, {
      requested: { net: { domains: ['evil.example.com'] } },
      activate: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'EPERM');
    assert.ok(audit.some((a) => a.action === 'install.rejected'));
  });

  await test('install：验签失败直接拒', async () => {
    const { registry } = makeKernel({
      verifier: { async verify() { return { ok: false, code: 'EAUTH', message: '签名不匹配' }; } },
    });
    const r = await registry.install(CONNECTOR_MANIFEST);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'EAUTH');
  });

  await test('install：重复安装被拒', async () => {
    const { registry } = makeKernel();
    assert.equal((await registry.install(CONNECTOR_MANIFEST, { activate: false })).ok, true);
    const again = await registry.install(CONNECTOR_MANIFEST, { activate: false });
    assert.equal(again.ok, false);
    assert.equal(again.ok === false && again.code, 'EMANIFEST');
  });

  await test('install：contributes.entityTypes 被登记到 DataBus', async () => {
    const { registry, bus } = makeKernel();
    await registry.install(CONNECTOR_MANIFEST, { activate: false });
    assert.equal(bus.hasSchema('org.shtu.ecloud', 'course'), true);
    assert.equal(bus.hasSchema('org.shtu.ecloud', 'ddl'), true);
    assert.equal(bus.hasSchema('org.shtu.ecloud', 'exam'), false);
  });

  await test('install 默认会立刻激活，并调用 onActivate', async () => {
    const runtime = new FakeRuntime();
    let activated = false;
    runtime.provide('org.shtu.ecloud', { onActivate: () => { activated = true; } });
    const { registry, events } = makeKernel({ runtime });

    const r = await registry.install(CONNECTOR_MANIFEST);
    assert.equal(r.ok, true, r.ok ? '' : r.message);
    if (!r.ok) return;
    assert.equal(r.data.state, 'active');
    assert.equal(activated, true);
    assert.deepEqual(events.map((e) => e.kind), ['installed', 'activated']);
    assert.equal(runtime.loads.length, 1);
  });

  await test('生命周期：activate → suspend → activate → deactivate → uninstall', async () => {
    const runtime = new FakeRuntime();
    runtime.provide('org.shtu.ecloud', {});
    const { registry, events } = makeKernel({ runtime });

    await registry.install(CONNECTOR_MANIFEST, { activate: false });
    assert.equal(registry.stateOf('org.shtu.ecloud'), 'installed');

    assert.equal((await registry.activate('org.shtu.ecloud')).ok, true);
    assert.equal(registry.stateOf('org.shtu.ecloud'), 'active');
    assert.ok(registry.exportsOf('org.shtu.ecloud'));

    assert.equal((await registry.suspend('org.shtu.ecloud')).ok, true);
    assert.equal(registry.stateOf('org.shtu.ecloud'), 'suspended');
    assert.equal(registry.exportsOf('org.shtu.ecloud'), undefined, '挂起后拿不到导出');
    assert.deepEqual(runtime.unloads, ['org.shtu.ecloud']);

    assert.equal((await registry.activate('org.shtu.ecloud')).ok, true, '挂起后可重新激活');
    assert.equal(registry.stateOf('org.shtu.ecloud'), 'active');

    assert.equal((await registry.deactivate('org.shtu.ecloud')).ok, true);
    assert.equal(registry.stateOf('org.shtu.ecloud'), 'deactivated');

    const u = await registry.uninstall('org.shtu.ecloud');
    assert.equal(u.ok, true);
    assert.equal(registry.stateOf('org.shtu.ecloud'), 'uninstalled');
    assert.deepEqual(
      events.map((e) => e.kind),
      ['installed', 'activated', 'suspended', 'activated', 'deactivated', 'uninstalled'],
    );
  });

  await test('未安装的插件操作给 ENOTFOUND', async () => {
    const { registry } = makeKernel();
    for (const m of ['activate', 'suspend', 'deactivate', 'uninstall'] as const) {
      const r = await registry[m]('nope.nope');
      assert.equal(r.ok, false, m);
      assert.equal(r.ok === false && r.code, 'ENOTFOUND', m);
    }
  });

  await test('运行时自报 kind 与 manifest 不符 → EMANIFEST，且回收执行环境', async () => {
    const runtime = new FakeRuntime();
    runtime.provide('org.shtu.ecloud', {}, 'ui');
    const { registry } = makeKernel({ runtime });
    const r = await registry.install(CONNECTOR_MANIFEST);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'EMANIFEST');
    assert.deepEqual(runtime.unloads, ['org.shtu.ecloud']);
  });

  await test('onActivate 抛异常 → EINTERNAL，且回收执行环境', async () => {
    const runtime = new FakeRuntime();
    runtime.provide('org.shtu.ecloud', { onActivate: () => { throw new Error('激活失败'); } });
    const { registry } = makeKernel({ runtime });
    const r = await registry.install(CONNECTOR_MANIFEST);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.code, 'EINTERNAL');
    assert.deepEqual(runtime.unloads, ['org.shtu.ecloud']);
    assert.equal(registry.get('org.shtu.ecloud')?.lastError?.code, 'EINTERNAL');
  });

  await test('§5.7：受限模式 + untrustedRemote:false ⇒ 拒绝激活', async () => {
    const runtime = new FakeRuntime();
    runtime.provide('com.example.strict', {});
    const { registry } = makeKernel({ runtime, verifier: neverSigned });

    const installed = await registry.install(STRICT_MANIFEST, { activate: false });
    assert.equal(installed.ok, true, installed.ok ? '' : installed.message);
    const a = await registry.activate('com.example.strict');
    assert.equal(a.ok, false);
    assert.equal(a.ok === false && a.code, 'ETRUST');
    assert.equal(runtime.loads.length, 0, '拒绝激活就不该碰执行环境');
  });

  await test('§5.7：受限模式 + untrustedRemote:"limited" ⇒ 可以激活', async () => {
    const runtime = new FakeRuntime();
    runtime.provide('com.example.remote', {});
    const { registry } = makeKernel({ runtime, verifier: neverSigned });
    const r = await registry.install(REMOTE_MANIFEST, { activate: false });
    assert.equal(r.ok, true, r.ok ? '' : r.message);
    assert.equal((await registry.activate('com.example.remote')).ok, true);
  });

  await test('§5.7：信任变更触发重载，且 active 状态被保留', async () => {
    const runtime = new FakeRuntime();
    runtime.provide('com.example.remote', {});
    const { registry, trust, events } = makeKernel({ runtime, verifier: neverSigned });

    await registry.install(REMOTE_MANIFEST);
    assert.equal(registry.stateOf('com.example.remote'), 'active');

    await trust.grantRemote('com.example.remote');
    // onTrustChanged 是异步的，等一个微任务队列
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(registry.stateOf('com.example.remote'), 'active', '重载后仍是 active');
    assert.equal(runtime.loads.length, 2, '重载 = 卸载 + 重新加载');
    assert.ok(events.some((e) => e.kind === 'reloaded'));
    assert.equal(registry.get('com.example.remote')?.trust.level, 'remote-trusted');
  });

  await test('uninstall keepData:true 保留记录，false 删掉', async () => {
    const runtime = new FakeRuntime();
    runtime.provide('org.shtu.ecloud', {});
    const { registry, bus } = makeKernel({ runtime });
    await registry.install(CONNECTOR_MANIFEST);
    bus.emit('org.shtu.ecloud', { type: 'course', id: 'c1', data: { title: 'x' } });

    await registry.uninstall('org.shtu.ecloud', { keepData: true });
    assert.equal(bus.stats().records, 1, 'keepData 保留 orphan');
    assert.equal(bus.hasSchema('org.shtu.ecloud', 'course'), false, '但 schema 注册要撤掉');
  });

  await test('uninstall keepData:false（默认）删掉记录', async () => {
    const runtime = new FakeRuntime();
    runtime.provide('org.shtu.ecloud', {});
    const { registry, bus } = makeKernel({ runtime });
    await registry.install(CONNECTOR_MANIFEST);
    bus.emit('org.shtu.ecloud', { type: 'course', id: 'c1', data: { title: 'x' } });
    await registry.uninstall('org.shtu.ecloud');
    assert.equal(bus.stats().records, 0);
  });

  await test('capabilities() 缺省是空数组 —— 不申报就不给（宁少不多）', async () => {
    /*
     * 以前这里返回 `HOST_CAPABILITIES_V1`，也就是 v1 规范的**上限**。
     * 于是插件探测 `db.namespaced` 拿到 true，然后去调一个根本不存在的方法。
     * 现在缺省空：忘了申报的宿主会让插件退化成「不用」，而不是「踩空」。
     */
    const { registry } = makeKernel();
    assert.deepEqual(registry.capabilities(), []);
  });

  await test('capabilities() 返回装配点注入的那份，与规范清单可区分', async () => {
    const { registry } = makeKernel({ capabilities: ['net.request', 'local.request'] });
    assert.deepEqual(registry.capabilities(), ['net.request', 'local.request']);
    assert.equal(
      registry.capabilities().includes('notify.local'),
      false,
      '没申报的能力不能凭空出现',
    );
  });
}

// ================================================================ 5. 端到端

async function section5(): Promise<void> {
  section('5. 端到端：一个连接器 + 一个消费方（Timeline 式）');

  await test('安装 → 激活 → 同步 → 落库 → 另一个插件跨插件读取（带投影）', async () => {
    const runtime = new FakeRuntime();
    const { registry, bus, trust } = makeKernel({ runtime });

    // 假 E云课堂：两页课程
    let page = 0;
    const plugin: PluginExports = {
      plan: () => ({
        requests: [{ id: 'p1', method: 'GET', url: 'https://ecloud.example.edu/api/courses?page=1', parse: 'courses' }],
      }),
      parsers: {
        courses: (i) => {
          const data = JSON.parse(i.body) as { items: Array<{ title: string; teacher: string; internalNote: string }> };
          return {
            entities: data.items.map((c) => ({
              type: 'course',
              id: c.title,
              data: { title: c.title, teacher: c.teacher, internalNote: c.internalNote },
            })),
            summary: `第 ${page} 页 ${data.items.length} 门`,
            cursor: `page=${page}`,
          };
        },
      },
      next: () => {
        page += 1;
        if (page >= 2) return null;
        return {
          next: 'courses',
          requests: [{ id: `p${page + 1}`, method: 'GET', url: `https://ecloud.example.edu/api/courses?page=${page + 1}`, parse: 'courses' }],
        };
      },
    };
    runtime.provide('org.shtu.ecloud', plugin);

    const installed = await registry.install(CONNECTOR_MANIFEST);
    assert.equal(installed.ok, true, installed.ok ? '' : installed.message);
    assert.equal(installed.ok && installed.data.state, 'active');

    const broker = new SyncBroker({
      fetch: async (req) => ({
        ok: true,
        data: {
          status: 200,
          url: req.url,
          body: JSON.stringify({
            items: page === 0
              ? [{ title: '数学分析', teacher: '张', internalNote: '内部A' }]
              : [{ title: '线性代数', teacher: '李', internalNote: '内部B' }],
          }),
        },
      }),
      domainsFor: (id) => registry.get(id)?.granted.netDomains ?? [],
      emit: (id, e) => bus.emit(id, e),
      now,
    });

    const sync = await broker.run('org.shtu.ecloud', registry.exportsOf('org.shtu.ecloud')!, { trigger: 'initial', now: 1 });
    assert.equal(sync.ok, true, sync.ok ? '' : sync.message);
    if (!sync.ok) return;
    assert.equal(sync.data.entities, 2);
    assert.equal(bus.stats().records, 2);

    // 消费方（比如内置 Timeline）跨插件读取：内部字段被投影掉
    const read = bus.read('dev.matrix.timeline', 'course');
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.data.length, 2);
    for (const rec of read.data) {
      assert.ok(typeof rec.data.title === 'string');
      assert.equal('internalNote' in rec.data, false, '跨插件读取必须裁掉 shared:false');
    }
    assert.equal(trust.levelOf('org.shtu.ecloud'), 'signed');
  });

  await test('S5 回归：累积状态留在插件模块作用域，跨边界字节只随增量增长', async () => {
    // S5 测出的 O(n²) 源头是「累积状态每步跨边界往返」。
    // 这里用 broker 自己报的 boundaryBytes 把它变成可观测的断言 ——
    // 这样插件作者在开发期就能看到，而不是等到几百步时莫名其妙变慢：
    //   · 正确写法（状态留沙箱）→ 跨边界字节随步数**线性**增长
    //   · 朴素写法（状态每步带出去）→ **超线性**增长
    const PAGE = 'p'.repeat(200); // 模拟一页 ~200 字节的响应体

    async function run(kind: 'naive' | 'module-scope', steps: number): Promise<number> {
      let carried = '';
      let step = 0;
      const plugin: PluginExports = {
        plan: () => ({
          requests: [{ id: 's0', method: 'GET', url: 'https://ecloud.example.edu/s0', parse: 'p' }],
        }),
        parsers: { p: () => ({ summary: 'x' }) },
        next: () => {
          step += 1;
          if (kind === 'naive') carried += PAGE;
          if (step >= steps) return null;
          const req: PlannedRequest = {
            id: `s${step}`,
            method: 'GET',
            url: `https://ecloud.example.edu/s${step}`,
            parse: 'p',
          };
          // 朴素写法的特征：把**全部累积状态**塞进请求描述带出去
          if (kind === 'naive') req.headers = { 'x-state': carried };
          return { next: 'p', requests: [req] };
        },
      };

      const broker = new SyncBroker({
        fetch: async (req) => ({ ok: true, data: { status: 200, url: req.url, body: PAGE } }),
        domainsFor: () => ['ecloud.example.edu'],
        emit: () => ({ ok: true, data: null }),
        maxSteps: steps + 10,
        now,
      });
      const r = await broker.run('p', plugin, { trigger: 'manual', now: 1 });
      assert.equal(r.ok, true, r.ok ? '' : r.message);
      return r.ok ? r.data.boundaryBytes : -1;
    }

    const N = 40;
    const goodN = await run('module-scope', N);
    const goodHalf = await run('module-scope', N / 2);
    const naiveN = await run('naive', N);
    const naiveHalf = await run('naive', N / 2);

    // 正确写法：步数翻倍，字节大致翻倍（线性）
    const goodRatio = goodN / goodHalf;
    assert.ok(
      goodRatio > 1.6 && goodRatio < 2.4,
      `正确写法应当线性：${goodHalf} → ${goodN}（比 ${goodRatio.toFixed(2)}）`,
    );

    // 朴素写法：步数翻倍，字节增长明显超过 2×（超线性）
    const naiveRatio = naiveN / naiveHalf;
    assert.ok(
      naiveRatio > 2.8,
      `朴素写法应当超线性：${naiveHalf} → ${naiveN}（比 ${naiveRatio.toFixed(2)}）`,
    );

    // 同一 N 下，朴素写法明显更贵
    assert.ok(naiveN > goodN * 5, `朴素写法应当明显更贵：naive=${naiveN} good=${goodN}`);
  });
}

// ---------------------------------------------------------------- 6. DataBus 持久化（T2）

/** 记录每次 save 批次的假后端。极简实现，够验证契约即可 */
class RecordingBackend implements DataBackend {
  readonly batches: DataChange[][] = [];
  failNext = false;
  private records: EntityRecord[] = [];

  async loadAll(): Promise<EntityRecord[]> {
    return this.records.map((r) => ({ ...r }));
  }

  async save(changes: readonly DataChange[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('磁盘满了');
    }
    this.batches.push([...changes]);
    for (const c of changes) {
      if (c.kind === 'dropPlugin') {
        this.records = this.records.filter((r) => r.pluginId !== c.pluginId);
      } else {
        const i = this.records.findIndex(
          (r) => r.pluginId === c.record.pluginId && r.type === c.record.type && r.id === c.record.id,
        );
        if (i >= 0) this.records[i] = c.record;
        else this.records.push(c.record);
      }
    }
  }
}

const PERSIST_SCHEMA: EntitySchema = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
  additionalProperties: false,
};

async function section6(): Promise<void> {
  section('6. DataBus 持久化（write-behind + restore）');

  await test('没配后端时：emit 不入队，flush 是空操作而不是错误', async () => {
    const bus = new DataBus();
    const s = bus.declareSchema('p', 'note', PERSIST_SCHEMA);
    assert.equal(s.ok, true);

    const e = bus.emit('p', { type: 'note', id: 'n1', data: { title: 'a' } });
    assert.equal(e.ok, true);
    assert.equal(bus.pendingCount(), 0, '没有后端就不该攒队列');

    const f = await bus.flush();
    assert.equal(f.ok, true, '空 flush 必须是 ok —— 否则每个测试都要处理假失败');
  });

  await test('emit 只进内存 + 队列；flush 才真的落盘', async () => {
    const backend = new RecordingBackend();
    const bus = new DataBus({ backend });
    bus.declareSchema('p', 'note', PERSIST_SCHEMA);

    bus.emit('p', { type: 'note', id: 'n1', data: { title: 'a' } });
    assert.equal(bus.pendingCount(), 1);
    assert.equal(backend.batches.length, 0, 'emit 本身不得触碰后端（D8：写入路径必须同步）');

    const f = await bus.flush();
    assert.equal(f.ok, true);
    assert.equal(backend.batches.length, 1);
    assert.equal(backend.batches[0]!.length, 1);
    assert.equal(bus.pendingCount(), 0);
  });

  await test('同一 id 连写三次只落一次盘（队列按 key 合并）', async () => {
    const backend = new RecordingBackend();
    const bus = new DataBus({ backend });
    bus.declareSchema('p', 'note', PERSIST_SCHEMA);

    for (const title of ['a', 'b', 'c']) {
      bus.emit('p', { type: 'note', id: 'n1', data: { title } });
    }
    assert.equal(bus.pendingCount(), 1, '三次写同一个 key 应当合并成一条');

    await bus.flush();
    const batch = backend.batches[0]!;
    assert.equal(batch.length, 1);
    const only = batch[0]!;
    assert.equal(only.kind, 'upsert');
    assert.equal(only.kind === 'upsert' ? only.record.data.title : '', 'c', '合并后应当是最后一次的值');
  });

  await test('flush 失败：这批变更留在队列里，下次重试', async () => {
    const backend = new RecordingBackend();
    const bus = new DataBus({ backend });
    bus.declareSchema('p', 'note', PERSIST_SCHEMA);
    bus.emit('p', { type: 'note', id: 'n1', data: { title: 'a' } });

    backend.failNext = true;
    const bad = await bus.flush();
    assert.equal(bad.ok, false);
    assert.equal(bad.ok ? '' : bad.code, 'EINTERNAL');
    assert.equal(bus.pendingCount(), 1, '失败不能吞掉变更 —— 否则数据就真丢了');

    const good = await bus.flush();
    assert.equal(good.ok, true);
    assert.equal(bus.pendingCount(), 0);
    assert.equal(backend.batches.length, 1);
  });

  await test('restore 重建记录与配额计数，revision 原样保留', async () => {
    const backend = new RecordingBackend();
    const first = new DataBus({ backend });
    first.declareSchema('p', 'note', PERSIST_SCHEMA);

    first.emit('p', { type: 'note', id: 'n1', data: { title: 'a' } });
    first.emit('p', { type: 'note', id: 'n1', data: { title: 'b' } }); // revision → 2
    first.emit('p', { type: 'note', id: 'n2', data: { title: 'c' } });
    await first.flush();

    const beforeUsage = first.usageOf('p');
    const beforeRev = first.read('p', 'note').ok
      ? (first.read('p', 'note') as { data: EntityRecord[] }).data.find((r) => r.id === 'n1')!.revision
      : -1;

    // 模拟重启：全新 bus，同一个后端
    const second = new DataBus({ backend });
    second.declareSchema('p', 'note', PERSIST_SCHEMA);
    const n = second.restore(await backend.loadAll());

    assert.equal(n, 2);
    const r = second.read('p', 'note');
    assert.equal(r.ok, true);
    const recs = (r as { data: EntityRecord[] }).data;
    assert.equal(recs.length, 2);
    assert.equal(recs.find((x) => x.id === 'n1')!.revision, beforeRev, 'revision 必须接着数，不能重置成 1');

    const afterUsage = second.usageOf('p');
    assert.equal(afterUsage.rows, beforeUsage.rows, '行数要重算回来');
    assert.equal(afterUsage.bytes, beforeUsage.bytes, '字节数也要重算回来（配额靠它）');

    assert.equal(second.pendingCount(), 0, 'restore 不该产生待落盘的变更');
  });

  await test('dropPlugin：作废同批 upsert，且队列里留下 drop 指令', async () => {
    const backend = new RecordingBackend();
    const bus = new DataBus({ backend });
    bus.declareSchema('p', 'note', PERSIST_SCHEMA);

    bus.emit('p', { type: 'note', id: 'n1', data: { title: 'a' } });
    assert.equal(bus.pendingCount(), 1);

    bus.dropPlugin('p');
    assert.equal(bus.pendingCount(), 1, '那条 upsert 应当被作废，只剩 drop');

    await bus.flush();
    const batch = backend.batches[0]!;
    assert.equal(batch.length, 1);
    assert.equal(batch[0]!.kind, 'dropPlugin', '否则「卸载后立刻重装」会把旧数据写回去');
    assert.equal(await backend.loadAll().then((x) => x.length), 0);
  });
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<void> {
  console.log('@matrix/kernel 一致性测试');

  await section1();
  await section2();
  await section3();
  await section4();
  await section5();
  await section6();

  console.log(`\n${'='.repeat(60)}`);
  if (failures.length === 0) {
    console.log(`全部通过：${passed} 项断言`);
    process.exit(0);
  } else {
    console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

void main();
