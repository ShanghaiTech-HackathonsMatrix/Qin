/**
 * 跨包差分测试：`@matrix/kernel` + `@matrix/plugin-api` ↔ `apps/shell/src/core`
 *
 * 运行：node src/core/plugin-api-diff.test.ts
 *
 * ## 为什么需要这个文件
 *
 * `packages/plugin-api` 里有一份主机名匹配规则（`matchDomainPattern`），
 * `apps/shell/src/core/allowlist.ts` 里有另一份（`matchHost`）。
 * 两份实现服务于同一条安全判定，**一旦漂移就是安全问题**：
 * 内核放行、网关拒绝还只是功能故障；内核拒绝、网关放行就是白名单被绕过。
 *
 * 同理，插件契约的错误码空间（`PluginErrorCode`）必须能装下核心层抛出的全部
 * 传输码（`CoreErrorCode`）—— 装不下的话，适配器只能把「URL 写错了」谎报成
 * 「域名未授权」，用户就再也查不出自己哪里写错了。
 *
 * 所以这个文件测的不是「某个函数对不对」，而是**两个包之间的一致性**。
 * 它 import 两个包的真实源码，任何一侧改了签名或枚举，这里立刻红。
 *
 * 覆盖：
 *   · 错误码空间：核心码 ⊆ 传输码，且契约码与传输码的边界符合设计
 *   · 头策略：适配器与网关引用的是同一份清单
 *   · 端到端：插件 plan → 内核 broker → 宿主适配器 → 核心网关 → 传输
 */

import { strict as assert } from 'node:assert';

import {
  CORE_TRANSPORT_CODES,
  HOST_CAPABILITIES_V1,
  PLUGIN_CONTRACT_CODES,
  type PluginExports,
} from '@matrix/plugin-api';

import { FORBIDDEN_REQUEST_HEADERS } from './gateway.ts';
import { createCore, MockTransport } from './index.ts';
import { FORBIDDEN_PLUGIN_HEADERS, PluginHost } from './plugin-host.ts';
import type { CoreErrorCode } from './types.ts';

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

/** 核心层错误码的全集。核心层加了新码而这里没跟上，tsc 会报错 */
const CORE_CODES_SEEN: Record<CoreErrorCode, true> = {
  EURL: true,
  EIP: true,
  EHOST: true,
  EREDIRECT: true,
  ETIMEOUT: true,
  ETOOBIG: true,
  ERATELIMIT: true,
  EAUTH: true,
  ENET: true,
};

const TEST_HOST = 'api.example.com';

/** 造一个 connector 形态的第一方插件模块 */
function makeConnector(opts: {
  url?: string;
  headers?: Record<string, string>;
  entities?: Array<{ type: string; id?: string; data: Record<string, unknown> }>;
}) {
  const url = opts.url ?? `https://${TEST_HOST}/v1/courses`;
  return {
    plan: () => ({
      requests: [
        {
          id: 'r1',
          method: 'GET' as const,
          url,
          parse: 'courses',
          ...(opts.headers ? { headers: opts.headers } : {}),
        },
      ],
    }),
    parsers: {
      courses: (input: { body: string; status: number }) => ({
        entities: opts.entities ?? [
          { type: 'course', id: 'c1', data: { title: '数据结构' } },
        ],
        summary: `status=${input.status} len=${input.body.length}`,
      }),
    },
  };
}

/** manifest 工厂：`domains` 决定内核侧授予的域名白名单 */
function makeManifest(domains: readonly string[]) {
  return {
    id: 'org.shtu.ecloud',
    name: 'E云课堂连接器',
    version: '1.2.0',
    apiVersion: '^1.0.0',
    kind: 'connector',
    entry: 'bundle.js',
    permissions: {
      data: { write: ['course'], read: ['course'] },
      net: { domains: [...domains], methods: ['GET', 'POST'] },
    },
    contributes: {
      entityTypes: [
        {
          name: 'course',
          schema: {
            type: 'object',
            properties: { title: { type: 'string', maxLength: 200 } },
            required: ['title'],
          },
        },
      ],
    },
  };
}

interface Harness {
  core: ReturnType<typeof createCore>;
  host: PluginHost;
  transport: MockTransport;
}

/**
 * 让挂起的微任务跑完。
 *
 * 信任变更会触发注册表**重载**插件（§5.7：`deactivate` → `activate`），
 * 那条链是 `void` 出去的（订阅回调不能是 async）。整条链只用到微任务，
 * 没有真实计时器或 IO，所以让出一个宏任务就足以把它冲刷干净。
 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 插件模块。统一按契约的导出形状 —— 本地导入器与连接器都装得下 */
type ConnectorModule = PluginExports;

/**
 * 装一套完整栈。
 *
 * 注意两个白名单是**两层**，必须同时满足：
 *   · 内核层：manifest 的 `permissions.net.domains`（授予插件的）
 *   · 网关层：核心的 `config.allowlist`（平台运维配的）
 * 这是纵深防御，不是重复 —— 下层管「这个插件准不准」，上层管「这台机器准不准」。
 */
function makeHarness(opts: {
  gatewayAllowlist?: readonly string[];
  transport?: MockTransport;
  modules?: ReadonlyMap<string, ConnectorModule>;
  maxLocalBytes?: number;
}): Harness {
  const transport = opts.transport ?? new MockTransport();
  const core = createCore({
    transport,
    gateway: { config: { allowlist: [...(opts.gatewayAllowlist ?? [TEST_HOST])] } },
  });
  const host = new PluginHost({
    core,
    modules: opts.modules,
    now: () => 1_700_000_000_000,
    ...(opts.maxLocalBytes !== undefined ? { maxLocalBytes: opts.maxLocalBytes } : {}),
  });
  return { core, host, transport };
}

// ================================================================ 1. 错误码空间

section('1. 错误码空间（核心层 ↔ 插件契约）');

await test('核心层的每一个错误码都能被插件契约的边界类型装下', () => {
  /*
   * 这条是**编译期**保证：`CORE_CODES_SEEN` 的键类型是 `CoreErrorCode`，
   * 核心层一旦新增错误码而这里没跟上，tsc 直接报错。
   * 下面的运行时断言再确认「装了」不等于「装错」。
   */
  const transportCodes = new Set<string>(CORE_TRANSPORT_CODES);
  for (const code of Object.keys(CORE_CODES_SEEN)) {
    assert.ok(
      transportCodes.has(code),
      `核心层错误码 ${code} 不在 CORE_TRANSPORT_CODES 里 —— 适配器将无法如实上报`,
    );
  }
});

await test('两套码空间的数量与设计一致（契约 11 / 传输 10）', () => {
  assert.equal(PLUGIN_CONTRACT_CODES.length, 11, `实际 ${PLUGIN_CONTRACT_CODES.length}`);
  assert.equal(CORE_TRANSPORT_CODES.length, 10, `实际 ${CORE_TRANSPORT_CODES.length}`);
  assert.equal(new Set(PLUGIN_CONTRACT_CODES).size, PLUGIN_CONTRACT_CODES.length, '契约码不能重复');
  assert.equal(new Set(CORE_TRANSPORT_CODES).size, CORE_TRANSPORT_CODES.length, '传输码不能重复');
});

await test('EAUTH / ETIMEOUT 刻意同时属于两套码空间', () => {
  /*
   * 这两个是**真正的双语义**，不是命名冲突：
   *   · EAUTH     —— 令牌无效（核心）／插件凭据不足（契约）
   *   · ETIMEOUT  —— HTTP 超时（核心）／状态机步数超限（契约）
   * 插件侧只看到一个码，靠 message 与上下文区分。合并成一个反而会让
   * 「到底是网络超时还是插件死循环」变得不可分辨。
   */
  for (const code of ['EAUTH', 'ETIMEOUT']) {
    assert.ok(PLUGIN_CONTRACT_CODES.includes(code as never), `${code} 应在契约码里`);
    assert.ok(CORE_TRANSPORT_CODES.includes(code as never), `${code} 应在传输码里`);
  }
});

await test('传输码里有、契约码里没有的，都是核心层专属的失败原因', () => {
  const contract = new Set<string>(PLUGIN_CONTRACT_CODES);
  const onlyTransport = CORE_TRANSPORT_CODES.filter((c) => !contract.has(c));
  assert.deepEqual(
    [...onlyTransport].sort(),
    ['EHOST', 'EIP', 'ENET', 'ERATELIMIT', 'EREDIRECT', 'ETOOBIG', 'EUNKNOWN', 'EURL'].sort(),
    '这几个必须只属于传输码空间 —— 它们是「出网时怎么失败的」，不是「插件用错了 API」',
  );
});

await test('契约码里有、传输码里没有的，都是插件自身的问题', () => {
  const transport = new Set<string>(CORE_TRANSPORT_CODES);
  const onlyContract = PLUGIN_CONTRACT_CODES.filter((c) => !transport.has(c));
  assert.deepEqual(
    [...onlyContract].sort(),
    ['EAPIVERSION', 'EINTERNAL', 'EMANIFEST', 'ENETDENIED', 'ENOTFOUND', 'EPERM', 'EQUOTA', 'ESCHEMA', 'ETRUST'].sort(),
  );
});

// ================================================================ 2. 头策略

section('2. 凭证头策略（适配器 ↔ 网关）');

await test('适配器与网关引用的是同一份清单', () => {
  assert.deepEqual(
    [...FORBIDDEN_PLUGIN_HEADERS].sort(),
    [...FORBIDDEN_REQUEST_HEADERS].sort(),
    '两边必须是同一份策略，否则迟早漂移 —— 而漂移通常意味着后门被重新打开',
  );
});

await test('清单内容被锁死（改动必须是有意识的）', () => {
  assert.deepEqual([...FORBIDDEN_PLUGIN_HEADERS].sort(), [
    'authorization',
    'connection',
    'content-length',
    'cookie',
    'host',
    'proxy-authorization',
    'set-cookie',
    'transfer-encoding',
    'upgrade',
  ]);
});

await test('清单里的每一项真的会被网关剥掉（逐项验证，不靠清单本身自证）', async () => {
  for (const name of FORBIDDEN_PLUGIN_HEADERS) {
    const transport = new MockTransport().queue(`https://${TEST_HOST}/x`, { status: 200, body: 'ok' });
    const { core } = makeHarness({ transport });
    const token = core.issueToken('org.test.probe', ['net']);

    await core.call(token.id, 'net.request', {
      url: `https://${TEST_HOST}/x`,
      headers: { [name]: 'smuggled-value' },
    });

    const sent = transport.calls[0]?.headers ?? {};
    const found = Object.keys(sent).find((k) => k.toLowerCase() === name);
    assert.equal(found, undefined, `${name} 必须被剥掉，实际发出去了`);
    assert.ok(
      !JSON.stringify(sent).includes('smuggled-value'),
      `${name} 的值绝不能出现在实际请求里`,
    );
  }
});

// ================================================================ 3. 端到端

section('3. 端到端：插件 plan → 内核 broker → 适配器 → 核心网关 → 传输');

await test('正常链路：请求发出、实体落库、报告完整', async () => {
  const modules = new Map([['org.shtu.ecloud', makeConnector({})]]);
  const transport = new MockTransport().queue(`https://${TEST_HOST}/v1/courses`, {
    status: 200,
    body: JSON.stringify([{ name: '数据结构' }]),
  });
  const { host } = makeHarness({ modules, transport });

  const installed = await host.install(makeManifest([TEST_HOST]));
  assert.equal(installed.ok, true, installed.ok ? '' : installed.message);

  const r = await host.sync('org.shtu.ecloud', { trigger: 'manual', now: 1_700_000_000_000 });
  assert.equal(r.ok, true, r.ok ? '' : `${r.code} ${r.message}`);
  if (!r.ok) return;

  assert.equal(r.data.requests, 1, '发了一个请求');
  assert.equal(r.data.steps, 1);
  assert.equal(r.data.entities, 1, '落了一条实体');
  assert.deepEqual(r.data.errors, []);
  assert.ok(r.data.boundaryBytes > 0, '跨界字节数应当被计量');

  // 传输确实被调到了，而且带的是正确的 URL
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]?.url, `https://${TEST_HOST}/v1/courses`);

  // 实体真的进了数据总线，能被跨插件读到
  const read = host.read('app.matrix.timeline', 'course');
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.data.length, 1);
  assert.equal(read.data[0]?.data.title, '数据结构');
});

await test('内核层先拦：域名未授予插件时，请求根本到不了网关', async () => {
  /*
   * 这是「纵深防御」的第一层。插件的 manifest 只声明了 other.example.com，
   * 却去请求 api.example.com —— 内核 broker 在发请求**之前**就应当拒绝，
   * 而且**一次传输都不能发生**。
   */
  const modules = new Map([['org.shtu.ecloud', makeConnector({})]]);
  const transport = new MockTransport();
  const { host } = makeHarness({ modules, transport });

  await host.install(makeManifest(['other.example.com']));
  const r = await host.sync('org.shtu.ecloud', { trigger: 'manual', now: 1 });

  assert.equal(r.ok, false, '不在白名单里必须失败');
  assert.equal(r.ok === false && r.code, 'ENETDENIED');
  assert.equal(transport.calls.length, 0, '内核拦住了，网关不该被调用 —— 一次都不行');
});

await test('网关层再拦：域名授予了插件但不在平台白名单里 → 传输码如实透传', async () => {
  /*
   * 第二层。插件被授予了 evil.example.com，但这台机器的平台白名单里没有它。
   * 此时失败发生在**核心层**，错误码是传输码（EHOST）。
   * 适配器必须**原样**把它报出来 —— 谎报成 ENETDENIED 的话，
   * 用户就分不清「插件没被授权」和「这台机器不允许」。
   *
   * 而且：单个请求失败**不该终止整个同步**，原因要进报告让插件决定怎么办。
   */
  const modules = new Map([
    ['org.shtu.ecloud', makeConnector({ url: 'https://evil.example.com/x' })],
  ]);
  const transport = new MockTransport();
  const { host } = makeHarness({
    modules,
    transport,
    gatewayAllowlist: [TEST_HOST], // 平台白名单里没有 evil.example.com
  });

  await host.install(makeManifest(['evil.example.com']));
  const r = await host.sync('org.shtu.ecloud', { trigger: 'manual', now: 1 });

  assert.equal(r.ok, true, '单个请求失败不该让整轮同步失败');
  if (!r.ok) return;
  assert.equal(r.data.requests, 1, '请求被计数了（内核放行了）');
  assert.equal(r.data.entities, 0, '没有响应体，自然解析不出实体');
  assert.equal(r.data.errors.length, 1, '失败原因要进报告');
  assert.ok(
    r.data.errors[0]?.includes('EHOST'),
    `错误码必须是传输码 EHOST，实际: ${r.data.errors[0]}`,
  );
  assert.equal(transport.calls.length, 0, '网关在传输层之前就拒了');
});

await test('适配器层先拒：插件试图自带 cookie 头 → EPERM，且不发出请求', async () => {
  /*
   * 这是第三道。插件在 `PlannedRequest.headers` 里塞 `cookie`。
   * 适配器必须**显式拒掉**而不是让网关静默剥掉 ——
   * 静默剥掉的话插件会以为自己设置成功了，直到线上出问题才发现。
   */
  const modules = new Map([
    ['org.shtu.ecloud', makeConnector({ headers: { cookie: 'sid=forged' } })],
  ]);
  const transport = new MockTransport();
  const { host } = makeHarness({ modules, transport });

  await host.install(makeManifest([TEST_HOST]));
  const r = await host.sync('org.shtu.ecloud', { trigger: 'manual', now: 1 });

  assert.equal(r.ok, true, '同样不该终止整轮同步');
  if (!r.ok) return;
  assert.equal(r.data.errors.length, 1);
  assert.ok(
    r.data.errors[0]?.includes('EPERM'),
    `必须是契约码 EPERM（插件用错了 API），实际: ${r.data.errors[0]}`,
  );
  assert.equal(transport.calls.length, 0, '被适配器拦住了，不该发出去');
});

await test('信任撤销会联动能力令牌：撤销后插件再也发不出请求', async () => {
  /*
   * D7 要求「逐插件可撤销信任」。如果内核的信任状态和核心层的能力令牌不联动，
   * 用户在界面上点了「撤销」，插件手里已签发的令牌照样能用 —— 那这个开关就是假的。
   */
  const modules = new Map([['org.shtu.ecloud', makeConnector({})]]);
  const transport = new MockTransport().queue(`https://${TEST_HOST}/v1/courses`, {
    status: 200, body: '[]',
  });
  const { host, core } = makeHarness({ modules, transport });

  await host.install(makeManifest([TEST_HOST]));
  const first = await host.sync('org.shtu.ecloud', { trigger: 'manual', now: 1 });
  assert.equal(first.ok, true);
  assert.equal(transport.calls.length, 1, '第一次应当成功出网');

  // 模拟用户撤销远程代码信任：登记为 remote-trusted 再撤销
  // 注意 `remoteOrigins` 必须给 —— `grantRemote` 的前置条件之一是
  // 「至少有一个来源域」，否则用户就是批了个空东西（返回 ETRUST）。
  const reg = await host.trust.register(
    'org.shtu.ecloud',
    { fullySigned: false, hasRemoteCode: true, remoteCodeGranted: false },
    { remoteOrigins: ['cdn.example.com'] },
  );
  assert.equal(reg.ok, true, reg.ok ? '' : `${reg.code} ${reg.message}`);

  const granted = await host.trust.grantRemote('org.shtu.ecloud');
  assert.equal(granted.ok, true, granted.ok ? '' : `${granted.code} ${granted.message}`);
  assert.equal(host.trust.levelOf('org.shtu.ecloud'), 'remote-trusted', '授予后应到 remote-trusted');

  const revoked = await host.trust.revokeRemote('org.shtu.ecloud');
  assert.equal(revoked.ok, true, revoked.ok ? '' : `${revoked.code} ${revoked.message}`);
  assert.equal(host.trust.levelOf('org.shtu.ecloud'), 'restricted');
  await flush();

  assert.equal(
    core.tokens.isRevoked('org.shtu.ecloud'),
    true,
    '信任撤销后，核心层必须把该插件的令牌标记为已撤销',
  );

  const second = await host.sync('org.shtu.ecloud', { trigger: 'manual', now: 2 });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.data.errors.length, 1, '第二次必须失败');
  assert.ok(
    second.data.errors[0]?.includes('EAUTH'),
    `撤销后应当是 EAUTH，实际: ${second.data.errors[0]}`,
  );
  assert.equal(transport.calls.length, 1, '第二次不该真的发出去');
});

await test('第一方插件不会被误撤销令牌（回归：曾把任何信任变更都当撤销）', async () => {
  /*
   * 曾经的写法是「凡是 to !== 'remote-trusted' 就 revokePlugin」。
   * 第一方插件（无远程代码）登记时等级是 `signed`，那条规则会把它们统统标成
   * revoked，`issueToken` 从此抛 EAUTH —— 所有第一方插件的网络能力被永久掐死。
   * 这个 bug 不报错，只表现为「请求全都返回 EAUTH」，很难查。
   */
  const modules = new Map([['org.shtu.ecloud', makeConnector({})]]);
  const transport = new MockTransport().queue(`https://${TEST_HOST}/v1/courses`, {
    status: 200, body: '[]',
  });
  const { host, core } = makeHarness({ modules, transport });

  await host.install(makeManifest([TEST_HOST]));

  // 登记一个普通第一方插件（无远程代码、已验签）
  await host.trust.register('org.shtu.ecloud', {
    fullySigned: true,
    hasRemoteCode: false,
    remoteCodeGranted: false,
  });
  await flush();

  assert.equal(
    core.tokens.isRevoked('org.shtu.ecloud'),
    false,
    '第一方插件登记不该把它标成 revoked',
  );

  const r = await host.sync('org.shtu.ecloud', { trigger: 'manual', now: 1 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.data.errors, [], '第一方插件必须能正常出网');
  assert.equal(transport.calls.length, 1);
});

await test('卸载后重装仍能出网（回归：撤销标记必须被清掉）', async () => {
  /*
   * 卸载会把插件标成 revoked（防止已卸载插件手里的令牌继续用）。
   * 重装时必须清掉这个标记，否则重装后的插件永远拿不到令牌 ——
   * 一个「装过一次就废了」的隐性 bug。
   */
  const modules = new Map([['org.shtu.ecloud', makeConnector({})]]);
  const transport = new MockTransport()
    .queue(`https://${TEST_HOST}/v1/courses`, { status: 200, body: '[]' })
    .queue(`https://${TEST_HOST}/v1/courses`, { status: 200, body: '[]' });
  const { host, core } = makeHarness({ modules, transport });

  await host.install(makeManifest([TEST_HOST]));
  await host.uninstall('org.shtu.ecloud');
  assert.equal(core.tokens.isRevoked('org.shtu.ecloud'), true, '卸载应当撤销能力');

  await host.install(makeManifest([TEST_HOST]));
  assert.equal(core.tokens.isRevoked('org.shtu.ecloud'), false, '重装必须清掉撤销标记');

  const r = await host.sync('org.shtu.ecloud', { trigger: 'manual', now: 1 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.data.errors, [], '重装后必须能正常出网');
  assert.equal(transport.calls.length, 1);
});

// ================================================================ 4. 本地导入

section("4. 本地导入（source: 'host'）端到端");

/** 第一方 ICS 导入插件：**没有 entry、没有网络**，只需要读用户选的文件 */
function makeLocalManifest(extra: { local?: boolean } = {}) {
  return {
    id: 'dev.matrix.importer.ics',
    name: 'ICS 课表导入',
    version: '0.1.0',
    apiVersion: '^1.0.0',
    kind: 'first-party',
    permissions: {
      data: { write: ['course'], read: ['course'] },
      ...(extra.local === false ? {} : { local: true }),
    },
    contributes: {
      entityTypes: [
        {
          name: 'course',
          schema: {
            type: 'object',
            properties: { title: { type: 'string', maxLength: 200 } },
            required: ['title'],
          },
        },
      ],
    },
  };
}

/** 插件侧：声明一个 host 请求，解析宿主递过来的文本 */
function makeLocalImporter(): PluginExports {
  return {
    plan: () => ({
      requests: [{ id: 'ics', method: 'GET', url: 'host://import', parse: 'ics', source: 'host' }],
    }),
    parsers: {
      ics: (input) => ({
        entities: input.body
          .split('\n')
          .filter((l) => l.startsWith('SUMMARY:'))
          .map((l) => ({ type: 'course', id: l.slice(8), data: { title: l.slice(8) } })),
        summary: `本地导入，status=${input.status}`,
      }),
    },
  };
}

const ICS_TEXT = ['BEGIN:VEVENT', 'SUMMARY:高等数学', 'SUMMARY:线性代数', 'END:VEVENT'].join('\n');

await test('保留前缀：宿主为编译进应用的插件传 allowReservedPrefix 才装得上', async () => {
  const modules = new Map<string, PluginExports>([['dev.matrix.importer.ics', makeLocalImporter()]]);
  const { host } = makeHarness({ modules });

  const denied = await host.install(makeLocalManifest());
  assert.equal(denied.ok, false, 'dev.matrix.* 默认不得被占用');
  assert.equal(denied.ok === false && denied.code, 'EMANIFEST');

  const allowed = await host.install(makeLocalManifest(), { allowReservedPrefix: true });
  assert.equal(allowed.ok, true, allowed.ok ? '' : allowed.message);
});

await test('本地导入端到端：宿主递文档 → 插件解析 → 落库，全程零出网', async () => {
  const modules = new Map<string, PluginExports>([['dev.matrix.importer.ics', makeLocalImporter()]]);
  const transport = new MockTransport();
  const { host } = makeHarness({ modules, transport });

  const inst = await host.install(makeLocalManifest(), { allowReservedPrefix: true, activate: true });
  assert.equal(inst.ok, true, inst.ok ? '' : inst.message);

  host.provideLocal('dev.matrix.importer.ics', 'host://import', ICS_TEXT);

  const r = await host.sync('dev.matrix.importer.ics', { trigger: 'manual', now: 1 });
  assert.equal(r.ok, true, r.ok ? '' : r.message);
  if (!r.ok) return;

  assert.deepEqual(r.data.errors, []);
  assert.equal(r.data.requests, 1, 'host 请求算一次往返');
  assert.equal(r.data.entities, 2, '两门课');
  assert.equal(transport.calls.length, 0, '全程零出网 —— 这是本地导入的全部意义');

  const courses = host.read('dev.matrix.importer.ics', 'course');
  assert.equal(courses.ok, true);
  if (!courses.ok) return;
  assert.deepEqual(
    courses.data.map((c) => c.data.title).sort(),
    ['线性代数', '高等数学'].sort(),
  );
});

await test('未声明 permissions.local ⇒ 安装时就被拒（授予不能超出声明）', async () => {
  const modules = new Map<string, PluginExports>([['dev.matrix.importer.ics', makeLocalImporter()]]);
  const { host } = makeHarness({ modules });

  const inst = await host.install(makeLocalManifest({ local: false }), {
    allowReservedPrefix: true,
    activate: true,
    // 用户在安装页「批」了 local，但 manifest 没声明 —— 篡改迹象
    requested: { data: { write: ['course'], read: ['course'] }, local: true },
  });
  assert.equal(inst.ok, false, '授予超出声明的权限必须被拒');
  assert.equal(inst.ok === false && inst.code, 'EPERM');
});

await test('声明了 local 但宿主没准备文档 ⇒ ENOTFOUND 进报告，不静默成功', async () => {
  const modules = new Map<string, PluginExports>([['dev.matrix.importer.ics', makeLocalImporter()]]);
  const { host } = makeHarness({ modules });

  await host.install(makeLocalManifest(), { allowReservedPrefix: true, activate: true });
  const r = await host.sync('dev.matrix.importer.ics', { trigger: 'manual', now: 1 });
  assert.equal(r.ok, true, '同步本身不该失败 —— 单个请求失败只进报告');
  if (!r.ok) return;
  assert.equal(r.data.entities, 0);
  assert.equal(r.data.errors.length, 1);
  assert.ok(r.data.errors[0]?.includes('ENOTFOUND'), `实际: ${r.data.errors[0]}`);
});

await test('本地文档按 pluginId 隔离：A 拿不到 B 导入的东西', async () => {
  /*
   * `source: 'host'` 的请求不过域名白名单（它不出网），所以隔离**只能**靠
   * 宿主侧按 (pluginId, url) 分键。键里少了 pluginId，插件 A 就能读到插件 B 的文件。
   * 与 DataBus 的记录键是同一个教训。
   */
  const modules = new Map<string, PluginExports>([
    ['dev.matrix.importer.ics', makeLocalImporter()],
    ['dev.matrix.importer.other', makeLocalImporter()],
  ]);
  const { host } = makeHarness({ modules });

  await host.install(makeLocalManifest(), { allowReservedPrefix: true, activate: true });
  await host.install(
    { ...makeLocalManifest(), id: 'dev.matrix.importer.other', name: '另一个导入器' },
    { allowReservedPrefix: true, activate: true },
  );

  host.provideLocal('dev.matrix.importer.ics', 'host://import', ICS_TEXT);

  const b = await host.sync('dev.matrix.importer.other', { trigger: 'manual', now: 1 });
  assert.equal(b.ok, true);
  if (!b.ok) return;
  assert.equal(b.data.entities, 0, 'B 不该读到 A 的文档');
  assert.ok(b.data.errors[0]?.includes('ENOTFOUND'), `实际: ${b.data.errors[0]}`);

  const a = await host.sync('dev.matrix.importer.ics', { trigger: 'manual', now: 1 });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(a.data.entities, 2, 'A 自己照常能读');
});

// ================================================================ 5. 权限闸与游标

section('5. 权限闸、游标与生命周期（v0.5 补齐）');

await test('bus.emit 查 permissions.data.write：没声明的类型落不了库', async () => {
  /*
   * 之前宿主把 emit 直接转给 `bus.emit` —— 于是 `data.write` 在 emit 路径上是**纸闸**，
   * 只有 net 路径（`dispatchFetch`）是真闸。同一个权限引擎两条路径两个行为，
   * 等于没有引擎：`net` 那条拦得住，写数据那条谁也拦不住。
   *
   * 这里 manifest 是**自相矛盾**的（在 `contributes.entityTypes` 里声明了 `course`，
   * 却不在 `permissions.data.write` 里）—— install 不会拒它，
   * 所以 emit 这道闸是唯一能拦住的地方。
   */
  const modules = new Map<string, PluginExports>([
    [
      'org.shtu.ecloud',
      {
        plan: () => ({ requests: [], entities: [{ type: 'course', data: { title: 'x' } }] }),
        parsers: {},
      },
    ],
  ]);
  const { host } = makeHarness({ modules });

  const manifest = makeManifest([TEST_HOST]);
  manifest.permissions.data.write = ['session'];
  const inst = await host.install(manifest);
  assert.equal(inst.ok, true, inst.ok ? '' : inst.message);

  const r = await host.sync('org.shtu.ecloud', { trigger: 'manual', now: 1 });
  assert.equal(r.ok, true, '同步本身不该失败 —— 单个实体被拒只进报告');
  if (!r.ok) return;
  assert.equal(r.data.entities, 0, '没声明 data.write 的类型不该落库');
  assert.equal(r.data.rejectedEntities, 1);
  assert.ok(r.data.errors[0]?.includes('EPERM'), `实际: ${r.data.errors[0]}`);
});

await test('回归：声明并授予了 data.write 时照常落库（闸不能是关死的）', async () => {
  const modules = new Map<string, PluginExports>([
    [
      'org.shtu.ecloud',
      {
        plan: () => ({ requests: [], entities: [{ type: 'course', data: { title: 'x' } }] }),
        parsers: {},
      },
    ],
  ]);
  const { host } = makeHarness({ modules });
  await host.install(makeManifest([TEST_HOST]));

  const r = await host.sync('org.shtu.ecloud', { trigger: 'manual', now: 1 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.entities, 1);
  assert.deepEqual(r.data.errors, []);
});

await test('provideLocal 早失败：超过 maxLocalBytes 直接 ETOOBIG，不进内存', async () => {
  const modules = new Map<string, PluginExports>([['dev.matrix.importer.ics', makeLocalImporter()]]);
  const { host } = makeHarness({ modules, maxLocalBytes: 16 });
  await host.install(makeLocalManifest(), { allowReservedPrefix: true, activate: true });

  const big = host.provideLocal('dev.matrix.importer.ics', 'host://import', ICS_TEXT);
  assert.equal(big.ok, false, `ICS_TEXT 远超 16 字节（${ICS_TEXT.length} 字符）`);
  assert.equal(big.ok === false && big.code, 'ETOOBIG');

  // 被拒之后不该留下半截文档
  const r = await host.sync('dev.matrix.importer.ics', { trigger: 'manual', now: 1 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.data.errors[0]?.includes('ENOTFOUND'), `实际: ${r.data.errors[0]}`);

  // 正常大小能进去
  assert.equal(host.provideLocal('dev.matrix.importer.ics', 'host://import', 'SUMMARY:A').ok, true);
});

await test('游标跨轮延续：sync #1 产出 → 宿主存下 → sync #2 填进 PlanInput.cursor', async () => {
  /*
   * `cursor` 之前是**死字段**：broker 从不读它，`SyncReport` 也没有这个键，
   * 所以 `PlanInput.cursor` 永远填不上 —— 分页永远不续上，而且不报错。
   */
  const seen: Array<string | undefined> = [];
  const modules = new Map<string, PluginExports>([
    [
      'org.shtu.ecloud',
      {
        plan: (input) => {
          seen.push(input.cursor);
          return { requests: [{ id: 'p', method: 'GET', url: `https://${TEST_HOST}/p`, parse: 'p' }] };
        },
        parsers: { p: (i) => ({ cursor: `next=${i.body}` }) },
      },
    ],
  ]);
  const transport = new MockTransport()
    .queue(`https://${TEST_HOST}/p`, { status: 200, body: '1' })
    .queue(`https://${TEST_HOST}/p`, { status: 200, body: '2' });
  const { host } = makeHarness({ modules, transport });
  await host.install(makeManifest([TEST_HOST]));

  const first = await host.sync('org.shtu.ecloud', { trigger: 'manual', now: 1 });
  assert.equal(first.ok, true, first.ok ? '' : first.message);
  if (!first.ok) return;
  assert.equal(first.data.cursor, 'next=1');
  assert.equal(seen[0], undefined, '第一轮没有上一轮游标');

  const second = await host.sync('org.shtu.ecloud', { trigger: 'manual', now: 2 });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(seen[1], 'next=1', '第二轮必须拿到上一轮的游标');
  assert.equal(second.data.cursor, 'next=2');
});

await test('调用方显式给游标时优先于宿主存下的那个', async () => {
  const seen: Array<string | undefined> = [];
  const modules = new Map<string, PluginExports>([
    [
      'org.shtu.ecloud',
      {
        plan: (input) => {
          seen.push(input.cursor);
          return { requests: [{ id: 'p', method: 'GET', url: `https://${TEST_HOST}/p`, parse: 'p' }] };
        },
        parsers: { p: () => ({ cursor: 'auto' }) },
      },
    ],
  ]);
  const transport = new MockTransport()
    .queue(`https://${TEST_HOST}/p`, { status: 200, body: '1' })
    .queue(`https://${TEST_HOST}/p`, { status: 200, body: '2' });
  const { host } = makeHarness({ modules, transport });
  await host.install(makeManifest([TEST_HOST]));

  await host.sync('org.shtu.ecloud', { trigger: 'manual', now: 1 });
  await host.sync('org.shtu.ecloud', { trigger: 'manual', now: 2, cursor: 'manual' });
  assert.equal(seen[1], 'manual', '显式传入的游标必须盖过宿主记住的那个');
});

await test('卸载清掉游标与本地文档：重装后不从「上一世的进度」继续', async () => {
  const seen: Array<string | undefined> = [];
  const modules = new Map<string, PluginExports>([
    [
      'dev.matrix.importer.ics',
      {
        plan: (input) => {
          seen.push(input.cursor);
          return { requests: [{ id: 'i', method: 'GET', url: 'host://import', parse: 'i', source: 'host' }] };
        },
        parsers: {
          i: (x) => ({ cursor: 'saved', entities: [{ type: 'course', data: { title: x.body } }] }),
        },
      },
    ],
  ]);
  const { host } = makeHarness({ modules });

  await host.install(makeLocalManifest(), { allowReservedPrefix: true, activate: true });
  assert.equal(host.provideLocal('dev.matrix.importer.ics', 'host://import', 'SUMMARY:A').ok, true);
  await host.sync('dev.matrix.importer.ics', { trigger: 'manual', now: 1 });
  assert.equal(seen[0], undefined);

  await host.uninstall('dev.matrix.importer.ics');
  await host.install(makeLocalManifest(), { allowReservedPrefix: true, activate: true });

  const r = await host.sync('dev.matrix.importer.ics', { trigger: 'manual', now: 2 });
  assert.equal(seen[1], undefined, '重装后不该继承上一世的游标');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.data.errors[0]?.includes('ENOTFOUND'), '重装后不该还留着上次的本地文档');
});

await test('宿主能力清单说真话：只列真能用的，且 ⊆ v1 规范', async () => {
  /*
   * `GAPS.md` §1.1 的守卫。以前 `capabilities()` 直接返回 `HOST_CAPABILITIES_V1`
   * （规范上限），于是插件探测 `db.namespaced` 拿到 true，然后去调一个根本不存在的方法 ——
   * 核心层 `METHODS` 里连 `db.*` 都没有。而 README 又反复教作者「查 capabilities」。
   *
   * 这份清单是手写的，所以必须有一条断言把它锁死，否则它会慢慢长回原样。
   */
  const { host } = makeHarness({});
  const caps = host.registry.capabilities();

  // ① 必须是 v1 规范的子集（防拼写错误、防凭空发明能力名）
  const spec = new Set<string>(HOST_CAPABILITIES_V1);
  for (const c of caps) assert.ok(spec.has(c), `${c} 不在 HOST_CAPABILITIES_V1 里`);

  // ② 真实现了的必须在
  for (const c of ['net.request', 'local.request', 'bus.emit']) {
    assert.ok(caps.includes(c), `${c} 已实现，必须出现在清单里`);
  }

  // ③ 没实现的必须不在 —— 这条是重点
  for (const c of [
    'db.namespaced',
    'notify.local',
    'schedule.periodic',
    'schedule.exact',
    'auth.login',
    'ui.registerComponent',
  ]) {
    assert.equal(caps.includes(c), false, `${c} 未实现，不得出现在能力清单里`);
  }

  // ④ 宿主内部有、但插件够不到的也不能列 —— 清单说的是「插件能用什么」
  assert.equal(caps.includes('bus.read'), false, '插件没有 bus.read 的调用路径');
  assert.equal(caps.includes('secrets.namespaced'), false, '核心层有 vault，但没暴露给插件');
});

await test('验签：编译进应用的判 signed；不在 modules 里的根本装不上', async () => {
  /*
   * `compiledInVerifier` **不做任何密码学校验**。它回答的不是「签名对不对」，
   * 而是另一个能如实回答的问题：**这段代码是不是就在这个应用包里？**
   * 判据是 manifest.id 在 `modules` 表里 —— 那种代码与宿主同权限，验不验签没区别。
   *
   * 但真正挡住第三方代码的**不是验签器**，是 `InProcessRuntime.load()`：
   * 不在 `modules` 里的 id 直接 ENOTFOUND，连 manifest 校验都到不了。
   * 所以「签名不核查」在当前架构里是安全的 —— 验签器只决定**装进来之后**的信任等级，
   * 而能装进来的只有第一方。这条断言就是那个「安全」的证据。
   *
   * ⚠️ `signed` 这个名字对第一方插件**名不副实**：它表达的是「代码在应用包里」，
   * 不是「验过签」。目前没有 UI 展示信任等级；T7（授予/撤销 UI）落地时必须换说法。
   */
  const modules = new Map<string, PluginExports>([['org.shtu.ecloud', makeConnector({})]]);
  const { host } = makeHarness({ modules });

  // ① 编译进应用的 → signed
  const r1 = await host.install(makeManifest([TEST_HOST]));
  assert.equal(r1.ok, true);
  assert.equal(host.trust.levelOf('org.shtu.ecloud'), 'signed');

  // ② 不在 modules 里的一律进不来，且拦在「加载」这一步，不是「验签」那一步
  const r2 = await host.install({ ...makeManifest([TEST_HOST]), id: 'com.example.stranger' });
  assert.equal(r2.ok, false);
  assert.equal(
    r2.ok ? '' : r2.code,
    'ENOTFOUND',
    '第三方代码的闸门是「加载」而不是「验签」—— 这是当前唯一真正的准入控制',
  );
});

// ---------------------------------------------------------------- 收尾
console.log(
  failures.length === 0
    ? `\n全部通过：${passed} 项断言`
    : `\n失败 ${failures.length} 项 / 通过 ${passed} 项\n  ${failures.join('\n  ')}`,
);
process.exit(failures.length === 0 ? 0 : 1);
