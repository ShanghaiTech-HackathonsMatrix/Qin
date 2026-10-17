/**
 * @matrix/plugin-api v1 一致性测试套件。
 *
 * 运行：node src/v1/conformance.test.ts
 * （Node 24 原生类型擦除，无需构建）
 *
 * 覆盖的不变量：
 *   §5.2  Manifest 校验：非法字段被逐条指出，且不抛异常
 *   §5.3  权限矩阵：默认拒绝；每个方法的放行条件
 *   §5.4  版本协商：受限 semver range，不满足给 EAPIVERSION
 *   §5.5  契约形状：纯函数、同步、凭证字段不可写
 *   §5.7  I4/I5/I6：权限与信任正交；受限模式硬拦
 *   技术债 域名匹配与核心层 allowlist.ts 的**差分测试**（防漂移）
 */

import { strict as assert } from 'node:assert';

import {
  CURRENT_API_VERSION,
  CORE_TRANSPORT_CODES,
  DEFAULT_MAX_STEPS,
  HOST_CAPABILITIES_V1,
  PLUGIN_CONTRACT_CODES,
  RPC_METHODS,
  authorize,
  checkPermission,
  codeOf,
  describePermissions,
  emptyPermissions,
  hostOf,
  intersectPermissions,
  isBlockedInRestrictedMode,
  isIpLiteral,
  isMajorSupported,
  isPluginErrorCode,
  isValidDomainPattern,
  matchDomainPattern,
  negotiateApiVersion,
  normalizeHost,
  normalizePermissions,
  parsePluginTarget,
  parseRange,
  parseSemver,
  parseUiNode,
  parseAction,
  UI_LIMITS,
  satisfiesRange,
  validateManifest,
  type Manifest,
  type PermissionContext,
  type PlannedRequest,
  type RequestPlan,
  type TrustLevel,
} from './index.ts';

// 差分测试用：核心层的权威实现（同一条规则的另一份实现 —— 见第 7、9 节）
import {
  compileAllowlist,
  isIpLiteral as coreIsIpLiteral,
  matchHost as coreMatchHost,
  normalizeHost as coreNormalizeHost,
  parseTarget as coreParseTarget,
} from '../../../../apps/shell/src/core/allowlist.ts';
import {
  errorCode as coreErrorCode,
  type CoreErrorCode,
} from '../../../../apps/shell/src/core/types.ts';

// ---------------------------------------------------------------- 迷你测试框架

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

function section(title: string): void {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------- 工具

const VALID_MANIFEST = {
  // 第三方插件用自己的反向域名。宿主/官方第一方命名空间（dev.matrix.* / app.matrix.*）
  // 是保留的，第三方不得占用 —— 见 manifest.ts 的 RESERVED_ID_PREFIXES。
  id: 'org.shtu.ecloud',
  name: 'E云课堂连接器',
  version: '1.2.0',
  apiVersion: '^1.0.0',
  kind: 'connector',
  entry: 'bundle.js',
  engines: { platform: ['android', 'windows', 'web'] },
  permissions: {
    data: { write: ['ddl', 'course', 'session'], read: ['course'] },
    net: { domains: ['ecloud.shanghaitech.edu.cn'], methods: ['GET', 'POST'] },
    auth: { providers: ['shtu-sso'] },
    notify: false,
    background: { periodic: true, exact: false },
    secrets: true,
    fs: 'none',
    ui: { components: [], slots: ['home.cards'] },
  },
  contributes: {
    commands: [{ id: 'sync', title: '立即同步' }],
    connectors: [{ id: 'ecloud', authProvider: 'shtu-sso', syncIntervalMin: 30 }],
  },
  integrity: { algo: 'ed25519', hash: 'sha256-abc', sig: 'sig-abc' },
};

function manifestWith(patch: Record<string, unknown>): unknown {
  return { ...VALID_MANIFEST, ...patch };
}

/** 构造一个上下文：声明 = VALID_MANIFEST.permissions，授予 = 同一份 */
function ctxFor(
  opts: {
    perms?: unknown;
    grantedOverride?: unknown;
    trustLevel?: TrustLevel;
    capabilities?: unknown;
    dependencies?: string[];
  } = {},
): PermissionContext {
  const base = {
    ...VALID_MANIFEST,
    permissions: opts.perms ?? VALID_MANIFEST.permissions,
    ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
    ...(opts.dependencies !== undefined ? { dependencies: opts.dependencies } : {}),
  };
  const v = validateManifest(base);
  assert.equal(v.ok, true, `测试夹具本身必须合法: ${JSON.stringify(v.issues)}`);
  const declared = (base.permissions ?? undefined) as never;
  const g = intersectPermissions(declared, (opts.grantedOverride ?? declared) as never);
  assert.equal(g.ok, true, `夹具授予集必须合法: ${JSON.stringify(g)}`);
  return {
    manifest: v.manifest as Manifest,
    granted: g.ok ? g.data : emptyPermissions(),
    trustLevel: opts.trustLevel ?? 'signed',
  };
}

const denyReason = (v: { ok: boolean } & Record<string, unknown>): string =>
  v.ok ? '<allowed>' : String((v as { code?: string }).code);

// ================================================================ 1. Manifest 校验

section('1. Manifest 校验（§5.2）');

test('合法 manifest 通过，且返回冻结对象', () => {
  const v = validateManifest(VALID_MANIFEST);
  assert.equal(v.ok, true, JSON.stringify(v.issues));
  assert.equal(v.issues.length, 0);
  assert.equal(Object.isFrozen(v.manifest), true);
  assert.equal(v.manifest?.id, 'org.shtu.ecloud');
});

test('非对象输入直接拒绝，不抛异常', () => {
  for (const bad of [null, undefined, 42, 'x', [], true]) {
    const v = validateManifest(bad);
    assert.equal(v.ok, false, `应当拒绝 ${String(bad)}`);
    assert.equal(v.issues[0]?.path, '');
  }
});

test('id 必须是反向域名小写形式', () => {
  assert.equal(validateManifest(manifestWith({ id: 'Ecloud' })).ok, false);
  assert.equal(validateManifest(manifestWith({ id: 'ecloud' })).ok, false, '单段没有点，应拒绝');
  assert.equal(validateManifest(manifestWith({ id: 'app.matrix.x' })).ok, false, '保留前缀应拒绝');
  assert.equal(validateManifest(manifestWith({ id: 'dev.matrix.x' })).ok, false, '保留前缀应拒绝');
  assert.equal(validateManifest(manifestWith({ id: 'com.example.9x' })).ok, false, '标签不能数字开头');
  assert.equal(validateManifest(manifestWith({ id: 'com.example.ok-1' })).ok, true);
});

test('保留命名空间：dev.matrix.* 与 app.matrix.* 第三方不得占用', () => {
  // dev.matrix.* = 宿主内置（与 appId dev.matrix.shell 同命名空间）
  // app.matrix.* = 官方第一方插件（DESIGN.md §5.2 的示例 id 就落在这里）
  for (const id of ['dev.matrix.core', 'dev.matrix.timeline', 'app.matrix.connector.ecloud']) {
    const v = validateManifest(manifestWith({ id }));
    assert.equal(v.ok, false, `${id} 应当被拒`);
    assert.ok(v.issues.some((i) => i.message.includes('保留前缀')));
  }
  assert.equal(validateManifest(manifestWith({ id: 'org.shtu.ecloud' })).ok, true);
  assert.equal(validateManifest(manifestWith({ id: 'devmatrix.core' })).ok, true, '只是前缀像，不是占用');
});

test('version 必须是严格 semver，apiVersion 必须是受限 range', () => {
  assert.equal(validateManifest(manifestWith({ version: '1.2' })).ok, false);
  assert.equal(validateManifest(manifestWith({ version: 'v1.2.0' })).ok, false);
  assert.equal(validateManifest(manifestWith({ version: '1.2.0' })).ok, true);
  assert.equal(validateManifest(manifestWith({ version: '1.2.0-beta.1' })).ok, true);

  assert.equal(validateManifest(manifestWith({ apiVersion: '>=1.0.0' })).ok, false, '不支持 >= 语法');
  assert.equal(validateManifest(manifestWith({ apiVersion: '1.0.0 || 2.0.0' })).ok, false);
  assert.equal(validateManifest(manifestWith({ apiVersion: '^1.0.0' })).ok, true);
  assert.equal(validateManifest(manifestWith({ apiVersion: '~1.2.0' })).ok, true);
  assert.equal(validateManifest(manifestWith({ apiVersion: '1.0.0' })).ok, true);
  assert.equal(validateManifest(manifestWith({ apiVersion: '*' })).ok, true);
});

test('kind 白名单，且非 declarative 必须有 entry', () => {
  assert.equal(validateManifest(manifestWith({ kind: 'magic' })).ok, false);
  assert.equal(validateManifest(manifestWith({ kind: 'declarative', entry: undefined })).ok, true);
  const noEntry = validateManifest(manifestWith({ kind: 'logic', entry: undefined }));
  assert.equal(noEntry.ok, false);
  assert.ok(noEntry.issues.some((i) => i.path === 'entry'));
});

test('entry 不得越出包目录', () => {
  assert.equal(validateManifest(manifestWith({ entry: '../evil.js' })).ok, false);
  assert.equal(validateManifest(manifestWith({ entry: '/abs/evil.js' })).ok, false);
  assert.equal(validateManifest(manifestWith({ entry: 'dist/bundle.js' })).ok, true);
});

test('net.domains 拒绝 scheme / 路径 / 端口 / IP / 大写', () => {
  const bad = [
    'https://ecloud.shanghaitech.edu.cn',
    'ecloud.shanghaitech.edu.cn/path',
    'ecloud.shanghaitech.edu.cn:443',
    'ECLOUD.shanghaitech.edu.cn',
    '192.168.1.1',
    '[::1]',
    '2130706433',
    '*.a.*.b',
    'a.*.b',
    'ecloud..shanghaitech.edu.cn',
    '',
  ];
  for (const d of bad) {
    assert.equal(isValidDomainPattern(d), false, `应当拒绝域名 "${d}"`);
  }
  for (const d of ['ecloud.shanghaitech.edu.cn', '*.shanghaitech.edu.cn', 'a-b.example.com']) {
    assert.equal(isValidDomainPattern(d), true, `应当接受域名 "${d}"`);
  }
});

test('net.domains 重复项被指出', () => {
  const v = validateManifest(
    manifestWith({
      permissions: { net: { domains: ['a.example.com', 'a.example.com'] } },
    }),
  );
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.message.includes('重复')));
});

test('net.methods 只允许标准方法且必须大写', () => {
  const v = validateManifest(manifestWith({ permissions: { net: { methods: ['get'] } } }));
  assert.equal(v.ok, false);
  assert.equal(validateManifest(manifestWith({ permissions: { net: { methods: ['GET', 'PATCH'] } } })).ok, true);
  assert.equal(validateManifest(manifestWith({ permissions: { net: { methods: ['TRACE'] } } })).ok, false);
});

test('data 实体类型必须是 snake_case 标识符', () => {
  assert.equal(validateManifest(manifestWith({ permissions: { data: { write: ['course'] } } })).ok, true);
  assert.equal(validateManifest(manifestWith({ permissions: { data: { write: ['course-list'] } } })).ok, false);
  assert.equal(validateManifest(manifestWith({ permissions: { data: { write: ['Course'] } } })).ok, false);
  assert.equal(validateManifest(manifestWith({ permissions: { data: { write: ['a b'] } } })).ok, false);
});

test('capabilities.remoteCode 强制要求 reason 与 origins', () => {
  const noReason = validateManifest(
    manifestWith({ capabilities: { remoteCode: { origins: ['rules.example.com'] } } }),
  );
  assert.equal(noReason.ok, false);
  assert.ok(noReason.issues.some((i) => i.path === 'capabilities.remoteCode.reason'));

  const noOrigins = validateManifest(
    manifestWith({ capabilities: { remoteCode: { reason: '热更新解析规则' } } }),
  );
  assert.equal(noOrigins.ok, false);

  const badOrigin = validateManifest(
    manifestWith({
      capabilities: { remoteCode: { reason: '热更新', origins: ['https://rules.example.com'] } },
    }),
  );
  assert.equal(badOrigin.ok, false, 'origins 必须是域名形状，不是 URL');

  const good = validateManifest(
    manifestWith({
      capabilities: {
        remoteCode: { reason: '热更新解析规则', origins: ['rules.example.com'], signature: 'required' },
        untrustedRemote: 'limited',
        restrictedSettings: ['autoSync'],
      },
    }),
  );
  assert.equal(good.ok, true, JSON.stringify(good.issues));
});

test('untrustedRemote 只能是 false 或 "limited"', () => {
  assert.equal(validateManifest(manifestWith({ capabilities: { untrustedRemote: true } })).ok, false);
  assert.equal(validateManifest(manifestWith({ capabilities: { untrustedRemote: 'no' } })).ok, false);
  assert.equal(validateManifest(manifestWith({ capabilities: { untrustedRemote: false } })).ok, true);
  assert.equal(validateManifest(manifestWith({ capabilities: { untrustedRemote: 'limited' } })).ok, true);
});

test('dependencies：不得自依赖、不得重复、id 必须合法', () => {
  const self = validateManifest(manifestWith({ dependencies: ['org.shtu.ecloud'] }));
  assert.equal(self.ok, false);
  assert.ok(self.issues.some((i) => i.message.includes('依赖自己')));

  const dup = validateManifest(manifestWith({ dependencies: ['a.b.c', 'a.b.c'] }));
  assert.equal(dup.ok, false);

  const badId = validateManifest(manifestWith({ dependencies: ['NotAnId'] }));
  assert.equal(badId.ok, false);

  assert.equal(validateManifest(manifestWith({ dependencies: ['dev.matrix.core'] })).ok, true);
});

test('integrity 只接受 ed25519，且 hash/sig 非空', () => {
  assert.equal(validateManifest(manifestWith({ integrity: { algo: 'rsa', hash: 'h', sig: 's' } })).ok, false);
  assert.equal(validateManifest(manifestWith({ integrity: { algo: 'ed25519', hash: '', sig: 's' } })).ok, false);
  assert.equal(validateManifest(manifestWith({ integrity: undefined })).ok, true, 'integrity 可选');
});

test('多个问题一次性全报，便于安装页逐条显示', () => {
  const v = validateManifest({ id: 'BAD', version: '1', apiVersion: 'nope', kind: 'x' });
  assert.equal(v.ok, false);
  assert.ok(v.issues.length >= 4, `应当报出至少 4 条，实际 ${v.issues.length}`);
});

// ================================================================ 2. 权限子集

section('2. 权限子集 granted ⊆ declared（§5.3）');

test('子集判定：请求超出声明即拒绝', () => {
  const declared = { data: { write: ['course'] }, net: { domains: ['a.example.com'] } };

  assert.equal(intersectPermissions(declared, declared).ok, true);
  assert.equal(intersectPermissions(declared, { data: { write: ['course', 'ddl'] } }).ok, false);
  assert.equal(intersectPermissions(declared, { net: { domains: ['evil.example.com'] } }).ok, false);
  assert.equal(intersectPermissions(declared, {}).ok, true, '要得更少是允许的');
  assert.equal(intersectPermissions(undefined, { notify: true }).ok, false);
  assert.equal(intersectPermissions(declared, { db: { raw: true } }).ok, false);
});

test('越权时给出结构化违规清单（要写审计）', () => {
  const r = intersectPermissions({ net: { domains: ['a.example.com'] } }, {
    net: { domains: ['a.example.com', 'b.example.com'] },
    secrets: true,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'EPERM');
  const v = (r.detail?.violations ?? []) as string[];
  assert.ok(v.includes('net.domains=b.example.com'));
  assert.ok(v.includes('secrets=true'));
});

test('布尔位只能要得更少', () => {
  const declared = { secrets: true, notify: true, background: { exact: true } };
  assert.equal(intersectPermissions(declared, { secrets: true, notify: false }).ok, true);
  assert.equal(intersectPermissions({ secrets: true }, { notify: true }).ok, false);
  assert.equal(intersectPermissions({}, { background: { exact: true } }).ok, false);
  assert.equal(intersectPermissions({}, { fs: 'sandbox' }).ok, false);
});

test('归一化：缺省字段变成确定形状', () => {
  const g = normalizePermissions(undefined);
  assert.equal(g.fs, 'none');
  assert.equal(g.notify, false);
  assert.equal(g.netDomains.length, 0);
  assert.equal(g.stream, false, 'net.stream 是二期能力，默认 false');
  assert.equal(normalizePermissions({ fs: 'none' }).fs, 'none');
  assert.equal(normalizePermissions({ stream: true }).stream, true, '声明可以写，但未必被授予');
});

// ================================================================ 3. 权限矩阵

section('3. 权限矩阵，默认拒绝（§5.3）');

test('db.* 隐式允许（命名空间隔离由核心层强制）', () => {
  const ctx = ctxFor();
  for (const m of ['db.get', 'db.query', 'db.put', 'db.delete']) {
    assert.equal(checkPermission(ctx, m).ok, true, m);
  }
});

test('db.raw 默认拒绝', () => {
  assert.equal(checkPermission(ctxFor(), 'db.raw').ok, false);
  const ctx = ctxFor({ perms: { ...VALID_MANIFEST.permissions, db: { raw: true } } });
  assert.equal(checkPermission(ctx, 'db.raw').ok, true);
});

test('bus.emit / bus.read 按实体类型逐个判定', () => {
  const ctx = ctxFor();
  assert.equal(checkPermission(ctx, 'bus.emit', { entityType: 'course' }).ok, true);
  assert.equal(checkPermission(ctx, 'bus.emit', { entityType: 'ddl' }).ok, true);
  assert.equal(checkPermission(ctx, 'bus.emit', { entityType: 'exam' }).ok, false, '未声明 write');
  assert.equal(checkPermission(ctx, 'bus.read', { entityType: 'course' }).ok, true);
  assert.equal(checkPermission(ctx, 'bus.read', { entityType: 'ddl' }).ok, false, '只声明了 read: course');
  assert.equal(checkPermission(ctx, 'bus.read', {}).ok, false, '缺 entityType');
});

test('net.request：域名与方法双重判定', () => {
  const ctx = ctxFor();
  assert.equal(checkPermission(ctx, 'net.request', { url: 'https://ecloud.shanghaitech.edu.cn/a', method: 'GET' }).ok, true);
  assert.equal(checkPermission(ctx, 'net.request', { url: 'https://ecloud.shanghaitech.edu.cn/a', method: 'POST' }).ok, true);
  assert.equal(checkPermission(ctx, 'net.request', { url: 'https://ecloud.shanghaitech.edu.cn/a', method: 'DELETE' }).ok, false, '未声明 DELETE');
  assert.equal(checkPermission(ctx, 'net.request', { url: 'https://evil.example.com/a' }).ok, false);
  assert.equal(checkPermission(ctx, 'net.request', { url: 'http://ecloud.shanghaitech.edu.cn/a' }).ok, false, '明文 http');
  assert.equal(checkPermission(ctx, 'net.request', { url: 'https://user:pw@ecloud.shanghaitech.edu.cn/' }).ok, false, 'userinfo');
  assert.equal(checkPermission(ctx, 'net.request', { url: 'https://192.168.1.1/' }).ok, false, 'IP 字面量');
  assert.equal(checkPermission(ctx, 'net.request', { url: 'not a url' }).ok, false);
  assert.equal(checkPermission(ctx, 'net.request', {}).ok, false);
});

test('net.request：通配符匹配子域但不含根域', () => {
  const ctx = ctxFor({ perms: { net: { domains: ['*.example.com'] } } });
  assert.equal(checkPermission(ctx, 'net.request', { url: 'https://a.example.com/' }).ok, true);
  assert.equal(checkPermission(ctx, 'net.request', { url: 'https://a.b.example.com/' }).ok, true);
  assert.equal(checkPermission(ctx, 'net.request', { url: 'https://example.com/' }).ok, false, '根域不匹配 *.');
  assert.equal(checkPermission(ctx, 'net.request', { url: 'https://notexample.com/' }).ok, false);
  assert.equal(checkPermission(ctx, 'net.request', { url: 'https://example.com.evil.com/' }).ok, false);
});

test('net.request：尾点不能绕过白名单', () => {
  const ctx = ctxFor();
  assert.equal(checkPermission(ctx, 'net.request', { url: 'https://ecloud.shanghaitech.edu.cn./a' }).ok, true);
  assert.equal(checkPermission(ctx, 'net.request', { url: 'https://evil.example.com./' }).ok, false);
});

test('auth.login 按 provider 判定，且插件不接触凭证', () => {
  const ctx = ctxFor();
  assert.equal(checkPermission(ctx, 'auth.login', { provider: 'shtu-sso' }).ok, true);
  assert.equal(checkPermission(ctx, 'auth.login', { provider: 'other' }).ok, false);
  assert.equal(checkPermission(ctx, 'auth.login', {}).ok, false);
});

test('notify / schedule 按声明位判定', () => {
  const ctx = ctxFor();
  assert.equal(checkPermission(ctx, 'notify.local').ok, false, 'manifest 声明 notify: false');
  assert.equal(checkPermission(ctx, 'schedule.periodic').ok, true);
  assert.equal(checkPermission(ctx, 'schedule.exact').ok, false, 'exact: false');
  const ctx2 = ctxFor({ perms: { notify: true, background: { periodic: true, exact: true } } });
  assert.equal(checkPermission(ctx2, 'notify.local').ok, true);
  assert.equal(checkPermission(ctx2, 'schedule.exact').ok, true);
});

test('secrets 与 fs 按声明判定', () => {
  const ctx = ctxFor();
  assert.equal(checkPermission(ctx, 'secrets.get').ok, true);
  assert.equal(checkPermission(ctx, 'secrets.set').ok, true);
  assert.equal(checkPermission(ctx, 'fs.read').ok, false, 'fs: "none"');
  const ctx2 = ctxFor({ perms: { secrets: true, fs: 'sandbox' } });
  assert.equal(checkPermission(ctx2, 'fs.write').ok, true);
  assert.equal(checkPermission(ctx2, 'fs.list').ok, true);
});

test('ui.registerComponent 按组件名判定', () => {
  const ctx = ctxFor({ perms: { ui: { components: ['dashboard'] } } });
  assert.equal(checkPermission(ctx, 'ui.registerComponent', { component: 'dashboard' }).ok, true);
  assert.equal(checkPermission(ctx, 'ui.registerComponent', { component: 'other' }).ok, false);
  assert.equal(checkPermission(ctx, 'ui.registerComponent', {}).ok, false);
});

test('llm.complete 需要 llm.local', () => {
  assert.equal(checkPermission(ctxFor(), 'llm.complete').ok, false);
  assert.equal(checkPermission(ctxFor({ perms: { llm: { local: true } } }), 'llm.complete').ok, true);
});

test('未知方法默认拒绝（I11：__proto__ 不能绕过）', () => {
  const ctx = ctxFor();
  for (const m of ['db.drop', '__proto__', 'constructor', 'toString', 'db.get.evil', '']) {
    const v = checkPermission(ctx, m);
    assert.equal(v.ok, false, `未知方法 "${m}" 必须被拒`);
    assert.equal(denyReason(v), 'EPERM');
  }
});

test('所有 RPC 方法都显式出现在矩阵里（没有落到 default 分支）', async () => {
  // 逐个方法给最小合法参数，确认返回的是权限判定而非「未知方法」
  const ctx = ctxFor({
    perms: {
      data: { write: ['course'], read: ['course'] },
      net: { domains: ['a.example.com'], methods: ['GET'] },
      auth: { providers: ['p'] },
      notify: true,
      background: { periodic: true, exact: true },
      secrets: true,
      fs: 'sandbox',
      ui: { components: ['c'] },
      db: { raw: true },
      llm: { local: true },
    },
    capabilities: { remoteCode: { reason: 'r', origins: ['rules.example.com'] } },
    dependencies: ['a.b.c'],
  });
  const args: Record<string, unknown> = {
    'db.get': { type: 'course' }, 'db.query': { type: 'course' }, 'db.put': { type: 'course' },
    'db.delete': { type: 'course' }, 'db.raw': { sql: 'select 1' },
    'bus.emit': { entityType: 'course' }, 'bus.read': { entityType: 'course' },
    'net.request': { url: 'https://a.example.com/', method: 'GET' },
    'auth.login': { provider: 'p' },
    'notify.local': {}, 'schedule.periodic': {}, 'schedule.exact': {},
    'secrets.get': {}, 'secrets.set': {}, 'secrets.delete': {},
    'fs.read': {}, 'fs.write': {}, 'fs.list': {},
    'ui.registerComponent': { component: 'c' },
    'llm.complete': { prompt: 'x' },
    'trust.evalRemote': { source: 'x' }, 'trust.loadModule': { pluginId: 'a.b.c' },
  };
  const mod = await import('./permissions.ts');
  for (const m of mod.RPC_METHODS) {
    const v = checkPermission(ctx, m, args[m]);
    assert.equal(v.ok, true, `方法 ${m} 在权限齐备时仍被拒：${denyReason(v)}`);
  }
});

// ================================================================ 4. 信任（§5.7）

section('4. 信任与权限正交（I4 / I5 / I6）');

const REMOTE_CAP = {
  capabilities: {
    remoteCode: { reason: '热更新解析规则', origins: ['rules.example.com'], signature: 'required' },
  },
};

test('I4：授予 remote-trusted 不等于授予网络权限', () => {
  // 有 remoteCode 声明、信任已授予，但 net.domains 里没有 rules.example.com
  const ctx = ctxFor({ perms: { notify: true }, trustLevel: 'remote-trusted', ...REMOTE_CAP });
  const v = checkPermission(ctx, 'net.request', { url: 'https://rules.example.com/rules.js' });
  assert.equal(v.ok, false, '没有网络权限就不该能发请求');
  assert.equal(denyReason(v), 'ENETDENIED');
  // 而 evalRemote 是允许的 —— 两把锁各管各的
  assert.equal(checkPermission(ctx, 'trust.evalRemote', { source: 'x' }).ok, true);
});

test('I4 反向：有网络权限但信任不足，evalRemote 仍被拒', () => {
  const ctx = ctxFor({
    perms: { net: { domains: ['rules.example.com'], methods: ['GET'] } },
    trustLevel: 'signed',
    ...REMOTE_CAP,
  });
  assert.equal(checkPermission(ctx, 'net.request', { url: 'https://rules.example.com/r' }).ok, true);
  const v = checkPermission(ctx, 'trust.evalRemote', { source: 'x' });
  assert.equal(v.ok, false);
  assert.equal(denyReason(v), 'ETRUST');
});

test('trust.evalRemote 需要 manifest 声明 remoteCode', () => {
  const ctx = ctxFor({ trustLevel: 'remote-trusted' });
  const v = checkPermission(ctx, 'trust.evalRemote', { source: 'x' });
  assert.equal(v.ok, false);
  assert.equal(denyReason(v), 'ETRUST');
});

test('受限模式：evalRemote 硬拦', () => {
  const ctx = ctxFor({ trustLevel: 'restricted', ...REMOTE_CAP });
  assert.equal(isBlockedInRestrictedMode(ctx, 'trust.evalRemote', {}), true);
  const v = authorize(ctx, 'trust.evalRemote', { source: 'x' });
  assert.equal(v.ok, false);
  assert.equal(denyReason(v), 'ETRUST');
});

test('受限模式：通向远程代码来源域的请求也硬拦', () => {
  const ctx = ctxFor({
    perms: { net: { domains: ['rules.example.com', 'api.example.com'], methods: ['GET'] } },
    trustLevel: 'restricted',
    ...REMOTE_CAP,
  });
  // 远程代码来源域 → 拦
  assert.equal(isBlockedInRestrictedMode(ctx, 'net.request', { url: 'https://rules.example.com/x' }), true);
  assert.equal(authorize(ctx, 'net.request', { url: 'https://rules.example.com/x' }).ok, false);
  // 普通域名 → 放行（受限模式只拦远程代码路径）
  assert.equal(isBlockedInRestrictedMode(ctx, 'net.request', { url: 'https://api.example.com/x' }), false);
  assert.equal(authorize(ctx, 'net.request', { url: 'https://api.example.com/x' }).ok, true);
});

test('受限模式：来源域写成通配时，子域也拦', () => {
  const ctx = ctxFor({
    // 根域与子域都授予网络权限，这样唯一变量就只剩「受限模式是否拦」
    perms: { net: { domains: ['rules.example.com', '*.rules.example.com'], methods: ['GET'] } },
    trustLevel: 'restricted',
    capabilities: {
      remoteCode: { reason: '热更新解析规则', origins: ['*.rules.example.com'], signature: 'required' },
    },
  });
  assert.equal(authorize(ctx, 'net.request', { url: 'https://cdn.rules.example.com/x' }).ok, false);
  assert.equal(
    authorize(ctx, 'net.request', { url: 'https://rules.example.com/x' }).ok,
    true,
    '根域不在 *. 的覆盖范围内（与白名单同语义）',
  );
});

test('受限模式：来源域写成精确域时不顺带拦子域', () => {
  // 这条是**有意的**：用户当时批准的是 "rules.example.com" 这一个名字，
  // 我们就不该顺带把 cdn.rules.example.com 也拦掉 —— 那是用户没见过的名字。
  // 想覆盖子域就写 *.rules.example.com。这与白名单的「根域 ≠ 子域」语义一致。
  const ctx = ctxFor({
    perms: { net: { domains: ['*.rules.example.com'], methods: ['GET'] } },
    trustLevel: 'restricted',
    ...REMOTE_CAP,
  });
  assert.equal(authorize(ctx, 'net.request', { url: 'https://rules.example.com/x' }).ok, false);
  assert.equal(authorize(ctx, 'net.request', { url: 'https://cdn.rules.example.com/x' }).ok, true);
});

test('I5：trust.loadModule 必须在 dependencies 里声明', () => {
  const ctx = ctxFor({ dependencies: ['a.b.c'] });
  assert.equal(checkPermission(ctx, 'trust.loadModule', { pluginId: 'a.b.c' }).ok, true);
  const v = checkPermission(ctx, 'trust.loadModule', { pluginId: 'x.y.z' });
  assert.equal(v.ok, false);
  assert.equal(denyReason(v), 'EPERM');
  assert.equal(checkPermission(ctx, 'trust.loadModule', {}).ok, false);
});

test('I5 说明：loadModule 用的是调用方权限，因此不构成提升', () => {
  // 调用方没有任何网络权限，即便被加载的模块声明了网络权限也没用 ——
  // 因为判定用的始终是 ctx.granted（调用方），不是目标插件的 manifest。
  const ctx = ctxFor({ dependencies: ['a.b.c'] });
  assert.equal(checkPermission(ctx, 'trust.loadModule', { pluginId: 'a.b.c' }).ok, true);
  assert.equal(checkPermission(ctx, 'net.request', { url: 'https://a.example.com/' }).ok, false);
});

test('信任等级与标签齐全', async () => {
  const mod = await import('./permissions.ts');
  assert.equal(mod.TRUST_LEVELS.length, 3);
  for (const t of mod.TRUST_LEVELS) {
    assert.ok(mod.TRUST_LABELS[t].length > 0, `${t} 缺少标签`);
  }
});

// ================================================================ 5. 版本协商

section('5. 版本协商与 N-2 兼容（§5.4）');

test('semver 解析与比较', () => {
  assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.equal(parseSemver('1.2'), null);
  assert.equal(parseSemver('1.2.3-rc.1'), null, '受限实现不解析预发布');
  assert.deepEqual(parseRange('^1.0.0'), { op: '^', base: { major: 1, minor: 0, patch: 0 } });
  assert.deepEqual(parseRange('*'), { op: '*', base: null });
  assert.equal(parseRange('>=1.0.0'), null);
});

test('caret / tilde / 精确 / 星号语义', () => {
  assert.equal(satisfiesRange('1.5.0', '^1.0.0'), true);
  assert.equal(satisfiesRange('2.0.0', '^1.0.0'), false);
  assert.equal(satisfiesRange('0.9.0', '^1.0.0'), false);

  assert.equal(satisfiesRange('0.2.9', '^0.2.3'), true, '^0.y.z 的次版本是破坏位');
  assert.equal(satisfiesRange('0.3.0', '^0.2.3'), false);
  assert.equal(satisfiesRange('0.0.3', '^0.0.3'), true);
  assert.equal(satisfiesRange('0.0.4', '^0.0.3'), false);

  assert.equal(satisfiesRange('1.2.9', '~1.2.3'), true);
  assert.equal(satisfiesRange('1.3.0', '~1.2.3'), false);
  assert.equal(satisfiesRange('1.2.3', '1.2.3'), true);
  assert.equal(satisfiesRange('1.2.4', '1.2.3'), false);
  assert.equal(satisfiesRange('99.0.0', '*'), true);
});

test('回归：`~` 的上界是「次版本 +1」，不是「主版本 +1」', () => {
  // 写错成主版本 +1 的话，`~1.2.3` 会覆盖到 1.9.9 —— 这是实测抓到的 bug
  assert.equal(satisfiesRange('1.2.3', '~1.2.3'), true);
  assert.equal(satisfiesRange('1.2.9', '~1.2.3'), true);
  assert.equal(satisfiesRange('1.3.0', '~1.2.3'), false);
  assert.equal(satisfiesRange('1.9.9', '~1.2.3'), false);
  assert.equal(satisfiesRange('2.0.0', '~1.2.3'), false);
  assert.equal(satisfiesRange('0.2.9', '~0.2.3'), true);
  assert.equal(satisfiesRange('0.3.0', '~0.2.3'), false);
});

test('回归：精确版本必须**相等**，不能只判 >=', () => {
  // 只判 >= 的话 `1.2.4` 会满足 `1.2.3` —— 也是实测抓到的 bug
  assert.equal(satisfiesRange('1.2.3', '1.2.3'), true);
  assert.equal(satisfiesRange('1.2.4', '1.2.3'), false);
  assert.equal(satisfiesRange('1.3.0', '1.2.3'), false);
  assert.equal(satisfiesRange('2.0.0', '1.2.3'), false);
  assert.equal(satisfiesRange('1.2.2', '1.2.3'), false);
});

test('握手：满足则给出宿主版本与能力清单', () => {
  const r = negotiateApiVersion('^1.0.0');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.data.apiVersion, CURRENT_API_VERSION);
});

test('握手：不满足给 EAPIVERSION，且信息可读', () => {
  const r = negotiateApiVersion('^2.0.0');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'EAPIVERSION');
  assert.ok(r.message.includes('2.0.0') && r.message.includes(CURRENT_API_VERSION));
  assert.equal(r.detail?.supportedMajors, '1..1');
});

test('握手：非法 range 给 EAPIVERSION 而不是崩', () => {
  for (const bad of ['>=1.0.0', '', 'x', '1.0']) {
    const r = negotiateApiVersion(bad);
    assert.equal(r.ok, false, bad);
    assert.equal(r.ok === false && r.code, 'EAPIVERSION');
  }
});

test('N-2 窗口判定', () => {
  assert.equal(isMajorSupported(1), true);
  assert.equal(isMajorSupported(0), false);
  assert.equal(isMajorSupported(2), false, '宿主当前是 1.x');
});

test('能力探测优于版本探测：v1 清单里没有 net.stream', () => {
  assert.ok(HOST_CAPABILITIES_V1.includes('net.request'));
  assert.ok(HOST_CAPABILITIES_V1.includes('notify.local'));
  assert.equal(HOST_CAPABILITIES_V1.includes('net.stream'), false, 'net.stream 是二期能力');
});

test('能力清单与 RPC 方法表同步：local.request 两边都有', () => {
  /*
   * 这两个清单是**两份独立的手写列表**，一份给插件探测（`capabilities.includes(...)`），
   * 一份给宿主判权限（`checkPermission`）。只加一边的话：
   *   · 只加 RPC：插件探测 `local.request` 拿到 false，于是**永远不用**这个能力
   *   · 只加能力：插件探测为真、真调用却 EPERM
   * 之前就漏了能力清单这一边。
   */
  assert.ok(RPC_METHODS.includes('local.request'), 'RPC 表里应有');
  assert.ok(HOST_CAPABILITIES_V1.includes('local.request'), '能力清单里也必须有');
  assert.equal(
    new Set(HOST_CAPABILITIES_V1).size,
    HOST_CAPABILITIES_V1.length,
    '能力清单不能有重复项',
  );
});

// ================================================================ 6. 契约形状

section('6. 契约形状（§5.5）');

test('默认最大步数存在且是有限正整数', () => {
  assert.equal(Number.isInteger(DEFAULT_MAX_STEPS), true);
  assert.ok(DEFAULT_MAX_STEPS > 0 && DEFAULT_MAX_STEPS <= 64);
});

test('ParseInput 不含 credentials（类型层面 never）', async () => {
  // 类型层面的约束用 tsc 保证；这里做运行时的形状检查：
  // 宿主构造 ParseInput 时只应放这四个键
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./contract.ts', import.meta.url), 'utf8'),
  );
  assert.ok(src.includes('credentials?: never'), 'credentials 必须声明为 never');
  assert.ok(src.includes('STEP_STATE_GUIDANCE'), '状态机指导必须写进契约');
  assert.ok(
    src.includes('O(n²)') || src.includes('O(n2)') || src.includes('54.7'),
    '指导里必须带 S5 实测数字',
  );
});

test('ConnectorPlugin 的三个成员都在契约里', async () => {
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('./contract.ts', import.meta.url), 'utf8'),
  );
  for (const m of ['plan(input: PlanInput)', 'parsers: Record<string', 'next?(input: StepInput)']) {
    assert.ok(src.includes(m), `契约缺少 ${m}`);
  }
});

// ================================================================ 7. 差分测试（防漂移）

section('7. 差分测试：与核心层 allowlist.ts 行为一致');

/*
 * 为什么要有这一节：
 * 域名/URL 的校验规则目前在**两个地方各实现了一遍** —— 本包的 permissions.ts
 * 与核心层 apps/shell/src/core/allowlist.ts。这是**已知技术债**：
 * 正确做法是把共享原语抽成 packages/net 里的单向依赖（本轮不动核心层，因为它是
 * 真机验证过的产物）。在抽出之前，这一节就是防漂移的闸门 ——
 * 只要两边行为分叉，测试立刻变红。
 */

test('normalizeHost 与核心层逐字一致', () => {
  const cases = [
    'Example.COM', 'example.com.', 'example.com..', 'example.com...',
    'a.b.c.', '.', '..', '', 'EXAMPLE.com.', '127.0.0.1', '[::1]', 'x', 'A.B.C',
  ];
  for (const c of cases) {
    assert.equal(normalizeHost(c), coreNormalizeHost(c), `normalizeHost("${c}") 漂移`);
  }
});

test('isIpLiteral 与核心层逐字一致', () => {
  const cases = [
    '127.0.0.1', '2130706433', '0x7f000001', '[::1]', '1.2', 'example.com',
    '1.2.3.4.5', 'a.b', '', 'example.com.', '12345', '0xzz', '999.999.999.999',
    '1.2.3.4.', 'a:1', '00x1', '0', 'x1.2.3.4',
  ];
  for (const c of cases) {
    assert.equal(isIpLiteral(c), coreIsIpLiteral(c), `isIpLiteral("${c}") 漂移`);
  }
});

test('matchDomainPattern ≡ core.matchHost（穷举 主机 × 规则）', () => {
  const hosts = [
    'example.com', 'a.example.com', 'a.b.example.com', 'example.com.', 'EXAMPLE.COM',
    'notexample.com', 'example.com.evil.com', 'xexample.com', 'example.org',
    '127.0.0.1', '2130706433', '0x7f000001', '[::1]', 'a', '', '..',
    'sub.deep.example.com', 'example.com..', 'deep.example.com', 'x.deep.example.com',
  ];
  const patterns = [
    'example.com', '*.example.com', '*.deep.example.com', 'a.example.com',
    '*.example.org', 'sub.deep.example.com',
  ];

  let checked = 0;
  for (const p of patterns) {
    const coreRules = compileAllowlist([p]);
    for (const h of hosts) {
      const mine = matchDomainPattern(h, [p]);
      const core = coreMatchHost(h, coreRules);
      assert.equal(mine, core, `漂移！规则="${p}" 主机="${h}"：plugin-api=${mine} core=${core}`);
      checked += 1;
    }
  }
  assert.equal(checked, patterns.length * hosts.length);
});

test('多规则并存时也不漂移', () => {
  const patterns = ['example.com', '*.example.com', '*.other.org'];
  const coreRules = compileAllowlist(patterns);
  for (const h of ['example.com', 'a.example.com', 'b.other.org', 'other.org', 'evil.com', 'example.com.evil.com']) {
    assert.equal(matchDomainPattern(h, patterns), coreMatchHost(h, coreRules), `多规则漂移：${h}`);
  }
});

test('parsePluginTarget 与 core.parseTarget 的接受/拒绝策略一致', () => {
  const cases = [
    'https://example.com/a?b=1',
    'https://Example.COM./a',
    'https://a.b.example.com/p/q',
    'https://example.com:8443/x',
    'https://example.com',
    'http://example.com/',
    'ftp://example.com/',
    'https://u:p@example.com/',
    'https://user@example.com/',
    'https://192.168.1.1/',
    'https://[::1]/',
    'https://2130706433/',
    'not a url',
    '',
    'https://',
  ];
  for (const c of cases) {
    let coreAccepts = true;
    try {
      coreParseTarget(c);
    } catch {
      coreAccepts = false;
    }
    const mineAccepts = parsePluginTarget(c).ok;
    assert.equal(mineAccepts, coreAccepts, `接受策略不一致："${c}"（core=${coreAccepts} mine=${mineAccepts}）`);
  }
});

test('parsePluginTarget 返回的主机名与核心层一致', () => {
  const cases = [
    'https://Example.COM./a?b=1',
    'https://a.b.example.com/p/q',
    'https://example.com:8443/x',
    'https://example.com',
  ];
  for (const c of cases) {
    const mine = parsePluginTarget(c);
    assert.equal(mine.ok, true, c);
    if (!mine.ok) continue;
    assert.equal(mine.data.host, coreParseTarget(c).host, `主机名不一致："${c}"`);
  }
});

test('hostOf 是 parsePluginTarget 的薄包装（拒绝行为一致）', () => {
  for (const bad of ['http://example.com/', 'https://u:p@example.com/', 'https://192.168.1.1/', 'not a url', '']) {
    assert.equal(hostOf(bad), null, `hostOf 应当拒绝 ${bad}`);
  }
  assert.equal(hostOf('https://Example.COM./a?b=1'), 'example.com');
});

// ================================================================ 8. 安装页文案

section('8. 安装确认页文案（§5.7 工程要求 2）');

test('describePermissions 覆盖各类权限且不泄漏内部字段名', () => {
  const lines = describePermissions({
    data: { write: ['ddl'], read: ['course'] },
    net: { domains: ['a.example.com'] },
    auth: { providers: ['sso'] },
    notify: true,
    background: { exact: true },
    secrets: true,
    fs: 'sandbox',
    ui: { components: ['dashboard'] },
    db: { raw: true },
    llm: { local: true },
    stream: true,
  });
  const text = lines.join('\n');
  assert.ok(text.includes('ddl'), '要写数据要说清写哪些');
  assert.ok(text.includes('a.example.com'), '要说清访问哪些域名');
  assert.ok(text.includes('高风险'), 'db.raw 必须标出风险');
  assert.ok(text.includes('二期'), 'stream 必须标注为二期能力');
  assert.equal(lines.some((l) => l.includes('dataWrite')), false, '不该泄漏内部字段名');
});

test('无权限时给出明确的空文案，而不是空数组', () => {
  const lines = describePermissions(undefined);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.includes('无额外权限'));
});

// ================================================================ 9. 错误码空间

section('9. 错误码空间：契约码 ∪ 传输码（§5.5）');

/*
 * 仓库里有**两个**错误码空间，它们不是同一个东西：
 *   · 契约码 —— 插件 API 自己产生的（权限、配额、版本、schema、生命周期、信任）
 *   · 传输码 —— 核心网关产生的（URL 非法、IP 字面量、主机未授权、重定向越界……）
 *
 * 边界结果类型必须能如实承载两者。否则插件让宿主去取 URL 时，
 * 「URL 写错了」就只能被**谎报**成「域名没授权」—— 而失败原因是用户排查问题的唯一线索。
 * 详见 errors.ts 文件头。
 */

test('传输码清单与核心层 CoreErrorCode 一致（编译期穷举 + 运行期比对）', () => {
  // 编译期守卫：核心层新增错误码时，这个 Record 立刻编译失败，
  // 逼着作者回到这里决定「这个码要不要暴露给插件」。
  const coverage: Record<CoreErrorCode, true> = {
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

  const coreCodes = Object.keys(coverage).sort();
  const mine = CORE_TRANSPORT_CODES.filter((c) => c !== 'EUNKNOWN').slice().sort();
  assert.deepEqual(mine, coreCodes, '传输码清单与核心层漂移');
});

test('EUNKNOWN 是核心 catch 的兜底码，不属于核心声明', () => {
  assert.ok(CORE_TRANSPORT_CODES.includes('EUNKNOWN'));
  assert.equal(coreErrorCode(new Error('随便什么')), 'EUNKNOWN');
  assert.equal(coreErrorCode(undefined), 'EUNKNOWN');
});

test('契约码覆盖 §5.5 文档列出的 8 个', () => {
  const documented = [
    'EPERM', 'EAPIVERSION', 'EQUOTA', 'ENETDENIED',
    'EAUTH', 'ESCHEMA', 'ETIMEOUT', 'EINTERNAL',
  ] as const;
  for (const c of documented) {
    assert.ok((PLUGIN_CONTRACT_CODES as readonly string[]).includes(c), `§5.5 的 ${c} 缺失`);
  }
  // 契约码里另外三个是文档没说、但生命周期与信任模型必需的
  for (const c of ['ETRUST', 'EMANIFEST', 'ENOTFOUND'] as const) {
    assert.ok((PLUGIN_CONTRACT_CODES as readonly string[]).includes(c), `${c} 缺失`);
  }
  assert.equal(PLUGIN_CONTRACT_CODES.length, 11);
});

test('isPluginErrorCode：只有已知码才算数', () => {
  for (const c of PLUGIN_CONTRACT_CODES) assert.equal(isPluginErrorCode(c), true, c);
  for (const c of CORE_TRANSPORT_CODES) assert.equal(isPluginErrorCode(c), true, c);
  assert.equal(isPluginErrorCode('EXXX'), false);
  assert.equal(isPluginErrorCode(''), false);
  assert.equal(isPluginErrorCode(undefined), false);
  assert.equal(isPluginErrorCode(42), false);
  assert.equal(isPluginErrorCode('eperm'), false, '大小写敏感');
});

test('codeOf：未知码一律归 EINTERNAL，绝不原样透传给插件', () => {
  assert.equal(codeOf({ code: 'EHOST' }), 'EHOST', '传输码要如实透传');
  assert.equal(codeOf({ code: 'EPERM' }), 'EPERM');
  assert.equal(codeOf({ code: 'EXXX' }), 'EINTERNAL', '未知码不能原样透传');
  assert.equal(codeOf({ code: '__proto__' }), 'EINTERNAL');
  assert.equal(codeOf({ code: 42 }), 'EINTERNAL');
  assert.equal(codeOf(new Error('x')), 'EINTERNAL');
  assert.equal(codeOf(null), 'EINTERNAL');
  assert.equal(codeOf(undefined), 'EINTERNAL');
  assert.equal(codeOf('EPERM'), 'EINTERNAL', '字符串本身不是错误对象');
});

test('parsePluginTarget 用的是传输码，且与核心层抛出的码一致', () => {
  const expected: Array<[string, string]> = [
    ['not a url', 'EURL'],
    ['', 'EURL'],
    ['http://example.com/', 'EURL'],
    ['ftp://example.com/', 'EURL'],
    ['https://u:p@example.com/', 'EURL'],
    ['https://', 'EURL'],
    ['https://192.168.1.1/', 'EIP'],
    ['https://[::1]/', 'EIP'],
    ['https://2130706433/', 'EIP'],
  ];
  for (const [url, code] of expected) {
    const mine = parsePluginTarget(url);
    assert.equal(mine.ok, false, url);
    if (mine.ok) continue;
    assert.equal(mine.code, code, `parsePluginTarget("${url}")`);

    let coreCode: string;
    try {
      coreParseTarget(url);
      coreCode = '(接受了)';
    } catch (e) {
      coreCode = coreErrorCode(e);
    }
    assert.equal(coreCode, code, `核心层对 "${url}" 的判定漂移`);
  }
});

test('parsePluginTarget 的失败结果是 PluginFailure 形状，不抛异常', () => {
  const r = parsePluginTarget('http://example.com/');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(typeof r.code, 'string');
  assert.equal(typeof r.message, 'string');
  assert.ok(r.message.length > 0);
});

// ================================================================ 第 10 节

section('第 10 节 · 第一个第一方插件暴露的契约缺口');

/**
 * 第一方插件的真实形状：**没有 entry**、**没有网络**、**需要读用户选的本地文件**。
 * 这一节里的每一条都对应一个「写第一个插件时撞上、然后修掉」的问题。
 */
const FIRST_PARTY = {
  id: 'dev.matrix.importer.ics',
  name: 'ICS 课表导入',
  version: '0.1.0',
  apiVersion: '^1.0.0',
  kind: 'first-party',
  permissions: { data: { write: ['course', 'session'], read: ['course'] }, local: true },
  contributes: {
    entityTypes: [
      {
        name: 'course',
        schema: {
          type: 'object',
          properties: { title: { type: 'string', maxLength: 200 }, teacher: { type: 'string' } },
          required: ['title'],
        },
      },
    ],
  },
};

/** 以第一方身份校验：宿主为「编译进应用的」插件传 allowReservedPrefix */
const validateFp = (overrides: Record<string, unknown> = {}) =>
  validateManifest({ ...FIRST_PARTY, ...overrides }, { allowReservedPrefix: true });

test('保留前缀默认关闭：第三方不传开关，dev.matrix.* / app.matrix.* 一律拒', () => {
  for (const id of ['dev.matrix.importer.ics', 'app.matrix.timeline']) {
    const v = validateManifest({ ...FIRST_PARTY, id });
    assert.equal(v.ok, false, `${id} 不该被第三方占用`);
    assert.ok(v.issues.some((i) => i.path === 'id'), JSON.stringify(v.issues));
  }
});

test('保留前缀：开关来自宿主，不来自 manifest 自报的 kind', () => {
  // 这条测试钉的就是这个区别：把 kind 写成 first-party **不能**解锁保留前缀，
  // 否则第三方照抄 kind 就绕过去了 —— 那就是个假开关。
  const claimed = { ...FIRST_PARTY, kind: 'first-party' };
  assert.equal(validateManifest(claimed).ok, false, 'kind 自报 first-party 不该解锁保留前缀');
  assert.equal(validateManifest(claimed, { allowReservedPrefix: true }).ok, true);
});

test('first-party 形态不再要求 entry（进程内运行时根本不读它）', () => {
  const v = validateFp();
  assert.equal(v.ok, true, JSON.stringify(v.issues));
  assert.equal(v.manifest?.entry, undefined);
});

test('first-party 给了 entry 也照收（将来要独立分发时用得上）', () => {
  const v = validateFp({ entry: 'bundle.js' });
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});

test('connector / logic / ui 仍然要求 entry', () => {
  for (const kind of ['connector', 'logic', 'ui'] as const) {
    const v = validateManifest({ ...VALID_MANIFEST, kind, entry: undefined });
    assert.equal(v.ok, false, `${kind} 不该放过空 entry`);
    assert.ok(v.issues.some((i) => i.path === 'entry'), `${kind} 的报错路径不对`);
  }
});

test('entry 只要给了就校验 —— declarative / first-party 也不能塞越界路径', () => {
  // 原实现把校验塞在「必填」分支里，于是这两种形态能带越界路径过关。
  // 现在无害（它们不加载代码），但沙箱加载器一旦读 manifest.entry 就是路径穿越。
  for (const kind of ['declarative', 'first-party'] as const) {
    for (const bad of ['../../etc/passwd', '/abs/path.js']) {
      const v = validateFp({ kind, entry: bad });
      assert.equal(v.ok, false, `${kind} + "${bad}" 应被拒`);
      assert.ok(v.issues.some((i) => i.path === 'entry'), `${kind} + "${bad}" 的报错路径不对`);
    }
  }
});

test('entityTypes 合法形状通过', () => {
  assert.equal(validateFp().ok, true);
});

test('entityTypes 不是数组被拒', () => {
  const v = validateFp({ contributes: { entityTypes: { course: {} } } });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.path === 'contributes.entityTypes'));
});

test('entityTypes 项名必须是 snake_case', () => {
  const v = validateFp({
    contributes: { entityTypes: [{ name: 'Course', schema: { type: 'object' } }] },
  });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.path === 'contributes.entityTypes[0].name'), JSON.stringify(v.issues));
});

test('entityTypes 名字重复被拒', () => {
  const one = { name: 'course', schema: { type: 'object' } };
  const v = validateFp({ contributes: { entityTypes: [one, one] } });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.path === 'contributes.entityTypes[1].name'));
});

test('entityTypes 缺 schema / schema.type 不是 object 被拒', () => {
  const a = validateFp({ contributes: { entityTypes: [{ name: 'course' }] } });
  assert.equal(a.ok, false);
  assert.ok(a.issues.some((i) => i.path === 'contributes.entityTypes[0].schema'));

  const b = validateFp({
    contributes: { entityTypes: [{ name: 'course', schema: { type: 'array' } }] },
  });
  assert.equal(b.ok, false);
  assert.ok(b.issues.some((i) => i.path === 'contributes.entityTypes[0].schema.type'));
});

test('entityTypes 字段类型拼错被拒（以前要等到 install 才报）', () => {
  const v = validateFp({
    contributes: {
      entityTypes: [{ name: 'course', schema: { type: 'object', properties: { title: { type: 'strng' } } } }],
    },
  });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.path === 'contributes.entityTypes[0].schema.properties.title.type'));
});

test('permissions.local 必须是布尔值', () => {
  const v = validateFp({ permissions: { local: 'yes' } });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.path === 'permissions.local'));
});

test('local.request 在 RPC_METHODS 清单里', () => {
  assert.ok(RPC_METHODS.includes('local.request'));
});

test('local.request：未声明 permissions.local 一律拒（默认拒绝）', () => {
  const ctx: PermissionContext = {
    manifest: { ...FIRST_PARTY, permissions: {} } as unknown as Manifest,
    granted: emptyPermissions(),
    trustLevel: 'signed',
  };
  const v = checkPermission(ctx, 'local.request', {});
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.code, 'EPERM');
});

test('local.request：声明并授予后放行', () => {
  const ctx: PermissionContext = {
    manifest: FIRST_PARTY as unknown as Manifest,
    granted: normalizePermissions({ local: true }),
    trustLevel: 'signed',
  };
  assert.equal(checkPermission(ctx, 'local.request', {}).ok, true);
});

test('local.request 不看域名白名单 —— 它根本不出网', () => {
  const ctx: PermissionContext = {
    manifest: FIRST_PARTY as unknown as Manifest,
    granted: normalizePermissions({ local: true }),
    trustLevel: 'signed',
  };
  assert.equal(ctx.granted.netDomains.length, 0);
  assert.equal(checkPermission(ctx, 'local.request', { url: 'host://import' }).ok, true);
});

test('intersectPermissions 拒绝「要了 local 但没声明」', () => {
  const r = intersectPermissions({ local: false }, { local: true });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'EPERM');
});

test('describePermissions 把 local 翻译成人话', () => {
  const out = describePermissions({ local: true });
  assert.ok(out.some((s) => s.includes('本地文件')), JSON.stringify(out));
});

test('ENTITY_TYPE_RE 与 manifest 的 data 校验是同一份规则', () => {
  // 三处共用：manifest 的 permissions.data 校验、contributes.entityTypes 校验、
  // DataBus.declareSchema。这里验前两处对同一批名字的判定一致。
  const names = ['course', 'Course', 'ddl_item', '1abc', 'a-b', '', 'a b', 'session', 'a__b'];
  for (const n of names) {
    const viaData = validateFp({ permissions: { data: { write: [n] } } }).ok;
    const viaEt = validateFp({
      contributes: { entityTypes: [{ name: n, schema: { type: 'object' } }] },
    }).ok;
    assert.equal(viaData, viaEt, `"${n}" 在两处校验里的判定不一致`);
  }
});

test('契约类型接受 source / entities（编译期即可见）', () => {
  const req: PlannedRequest = { id: 'ics', method: 'GET', url: 'host://import', parse: 'ics', source: 'host' };
  const plan: RequestPlan = { requests: [req], entities: [], cursor: 'c', summary: 's' };
  assert.equal(plan.requests[0]?.source, 'host');
  assert.equal(plan.entities?.length, 0);
});

// ================================================================ 11. 控件契约

section('11. 控件契约：UiNode 解析与 views 校验');

test('合法树被重建，且不与输入共享对象', () => {
  const raw = {
    type: 'stack',
    direction: 'column',
    gap: 'md',
    children: [
      { type: 'text', text: '今天', size: 'lg', weight: 'bold' },
      { type: 'card', title: '课程', children: [{ type: 'badge', text: '3 节', tone: 'accent' }] },
      { type: 'divider' },
    ],
  };
  const r = parseUiNode(raw);
  assert.equal(r.ok, true, r.ok ? '' : r.message);
  if (!r.ok) return;

  assert.deepEqual(r.data, raw, '重建结果必须与输入等价');
  assert.notEqual(r.data, raw, '不得原样透传同一个对象');
  const stack = r.data as { children: unknown[] };
  assert.notEqual(stack.children, raw.children, 'children 数组也必须是新数组');
});

test('未知原语被拒 —— 原语是封闭集', () => {
  const r = parseUiNode({ type: 'iframe', src: 'https://evil' });
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.code, 'ESCHEMA');
  assert.ok(!r.ok && r.message.includes('封闭集'), `错误信息要说清原因，实际：${r.ok ? '' : r.message}`);
});

test('children 不是数组被拒', () => {
  const r = parseUiNode({ type: 'stack', children: 'nope' });
  assert.equal(r.ok, false);
});

test('节点数超过上限被拒（防止一个循环把界面卡死）', () => {
  const children = Array.from({ length: UI_LIMITS.maxNodes + 5 }, () => ({ type: 'divider' }));
  const r = parseUiNode({ type: 'stack', children });
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.code, 'ESCHEMA');
});

test('嵌套超过上限被拒', () => {
  let node: unknown = { type: 'divider' };
  for (let i = 0; i <= UI_LIMITS.maxDepth + 1; i += 1) {
    node = { type: 'stack', children: [node] };
  }
  const r = parseUiNode(node);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.message.includes('层'), `应当报嵌套层数，实际：${r.ok ? '' : r.message}`);
});

test('文本超长被拒', () => {
  const r = parseUiNode({ type: 'text', text: 'x'.repeat(UI_LIMITS.maxTextLength + 1) });
  assert.equal(r.ok, false);
});

test('未知字段被丢弃 —— 不透传任何插件塞的东西', () => {
  const raw = {
    type: 'text',
    text: 'hi',
    onClick: () => 1,
    className: 'evil',
    style: { color: 'red' },
    extra: { nested: true },
  };
  const r = parseUiNode(raw);
  assert.equal(r.ok, true, r.ok ? '' : r.message);
  assert.deepEqual(r.data, { type: 'text', text: 'hi' }, '只允许已知字段到达渲染层');
});

test('图标只能是枚举名，不能是图片 URL（插件零网络）', () => {
  const bad = parseUiNode({
    type: 'button',
    label: 'x',
    onPress: { kind: 'navigate', to: 'a' },
    icon: 'https://evil.example/x.png',
  });
  assert.equal(bad.ok, false, 'URL 形式的图标必须被拒');

  const good = parseUiNode({
    type: 'button',
    label: 'x',
    onPress: { kind: 'navigate', to: 'a' },
    icon: 'calendar',
  });
  assert.equal(good.ok, true);
});

test('Action：三种合法形状都能解析', () => {
  const nav = parseAction({ kind: 'navigate', to: 'courses' });
  assert.equal(nav.ok, true);
  const ui = parseAction({ kind: 'setUi', key: 'filter', value: 'open' });
  assert.equal(ui.ok, true);
  const sync = parseAction({ kind: 'sync', settings: { term: '2025-fall' } });
  assert.equal(sync.ok, true);
});

test('Action：没有「任意命令」这一档 —— 宿主没有执行入口，不做假开关', () => {
  const r = parseAction({ kind: 'command', id: 'markDone' });
  assert.equal(r.ok, false, 'v1 不得接受 command：那会是一个点了没反应的按钮');
});

test('Action：setUi 的值必须是 JSON 标量', () => {
  const bad = parseAction({ kind: 'setUi', key: 'k', value: { nested: 1 } });
  assert.equal(bad.ok, false, '对象值必须被拒 —— UI 状态要可序列化');
  const nan = parseAction({ kind: 'setUi', key: 'k', value: Number.NaN });
  assert.equal(nan.ok, false, 'NaN 也要拒（JSON 里表达不了）');
});

test('Action：未知 kind 被拒', () => {
  const r = parseAction({ kind: 'runArbitraryCode', code: 'x' });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.message.includes('navigate'), '错误信息要列出合法取值');
});

test('button 缺 onPress 被拒 —— 不能有点不动的按钮', () => {
  const r = parseUiNode({ type: 'button', label: 'x' });
  assert.equal(r.ok, false);
});

test('manifest.views：合法目录通过', () => {
  const v = validateManifest(
    manifestWith({
      contributes: {
        views: [
          { id: 'upcoming', title: '近期', kind: 'widget', requires: ['session'] },
          { id: 'detail', title: '详情', kind: 'page', defaultSize: { w: 4, h: 2 } },
        ],
      },
    }),
  );
  assert.equal(v.ok, true, v.ok ? '' : JSON.stringify(v.issues));
});

test('manifest.views：重复 id / 非 kebab-case / kind 非法 / 尺寸越界 都被拒', () => {
  const v = validateManifest(
    manifestWith({
      contributes: {
        views: [
          { id: 'a', title: 'A', kind: 'widget' },
          { id: 'a', title: '重复', kind: 'widget' },
          { id: 'Has Space', title: 'B', kind: 'widget' },
          { id: 'c', title: 'C', kind: 'popup' },
          { id: 'd', title: 'D', kind: 'widget', defaultSize: { w: 99, h: 0 } },
        ],
      },
    }),
  );
  assert.equal(v.ok, false);
  const paths = v.issues.map((i) => i.path);
  assert.ok(paths.includes('contributes.views[1].id'), `应报重复 id，实际：${paths.join(',')}`);
  assert.ok(paths.includes('contributes.views[2].id'), '应报非 kebab-case');
  assert.ok(paths.includes('contributes.views[3].kind'), '应报非法 kind');
  assert.ok(
    paths.some((p) => p.startsWith('contributes.views[4].defaultSize')),
    '应报尺寸越界',
  );
});

// ---------------------------------------------------------------- 汇总

console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
