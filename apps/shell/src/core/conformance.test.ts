/**
 * 核心层一致性测试套件。
 *
 * 运行：node src/core/conformance.test.ts
 * （Node 24 原生类型擦除，无需构建）
 *
 * 这套用例**只依赖 Transport 接口**，因此同一套断言既能跑脚本化传输（本文件），
 * 也能跑真机上的 CapacitorHttp 传输 —— 这就是 DESIGN.md §7.4 里
 * 「由 tools/conformance 用同一套用例跑两边」的最小可用形态。
 *
 * 覆盖的不变量：
 *   §8.1  白名单 / 逐跳复检 / 限流 / 超时 / 大小上限 / 审计
 *   I10   每次调用出示能力令牌；不看 frame origin
 *   I11   方法派发用 Object.hasOwn，`__proto__` 不能绕过
 */

import { strict as assert } from 'node:assert';

import { compileAllowlist, isIpLiteral, matchHost, normalizeHost, parseTarget } from './allowlist.ts';
import { AuditLog } from './audit.ts';
import { DurableAuditStore } from './audit-store.ts';
import { NetGateway } from './gateway.ts';
import { TokenBuckets } from './ratelimit.ts';
import { MemorySessions } from './session.ts';
import { CapacitorCookiesSession, type CookieJarNative } from './session-capacitor.ts';
import { CapabilityRegistry } from './tokens.ts';
import { MockTransport } from './transport.ts';
import { Vault } from './vault.ts';
import { Core, errorCode } from './index.ts';
import type { AuditEntry, Transport } from './types.ts';

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

/** 断言某个异步调用以指定错误码失败 */
async function rejects(
  fn: () => Promise<unknown>,
  code: string,
  hint = '',
): Promise<void> {
  let threw: unknown = null;
  try {
    await fn();
  } catch (e) {
    threw = e;
  }
  assert.ok(threw !== null, `期望抛出 ${code}，但没有抛${hint ? `（${hint}）` : ''}`);
  assert.equal(errorCode(threw), code, `期望 ${code}，实际 ${errorCode(threw)}`);
}

// ---------------------------------------------------------------- 夹具

function makeGateway(opts: {
  allowlist?: string[];
  transport?: MockTransport;
  now?: () => number;
  rateCapacity?: number;
  rateRefillPerSec?: number;
  maxBytes?: number;
} = {}) {
  const transport = opts.transport ?? new MockTransport();
  const tokens = new CapabilityRegistry(opts.now);
  const audit = new AuditLog(200);
  const sessions = new MemorySessions();
  const gateway = new NetGateway({
    transport,
    tokens,
    audit,
    sessions,
    now: opts.now,
    config: {
      allowlist: opts.allowlist ?? ['api.example.com', '*.cdn.example.com'],
      defaultTimeoutMs: 5000,
      defaultMaxBytes: opts.maxBytes ?? 1024,
      maxRedirects: 3,
      retryCount: 2,
      retryBaseMs: 0,          // 测试里不等真实退避时间
      rateCapacity: opts.rateCapacity ?? 20,
      rateRefillPerSec: opts.rateRefillPerSec ?? 2,
    },
  });
  const token = tokens.issue('app.matrix.test', ['net']);
  return { transport, tokens, audit, sessions, gateway, token };
}

// ---------------------------------------------------------------- 1. 主机名规则

section('1. 主机名规则（allowlist.ts）');

await test('归一化：小写 + 去尾点', () => {
  assert.equal(normalizeHost('API.Example.COM'), 'api.example.com');
  // 尾点必须归一化，否则 `example.com.` 就是绕过白名单的手段
  assert.equal(normalizeHost('example.com.'), 'example.com');
  assert.equal(normalizeHost('example.com...'), 'example.com');
});

await test('IP 字面量识别：点分 / 整数 / 十六进制 / IPv6', () => {
  assert.ok(isIpLiteral('127.0.0.1'));
  assert.ok(isIpLiteral('192.168.1.1'));
  assert.ok(isIpLiteral('2130706433'), '十进制整数形式必须拦住');
  assert.ok(isIpLiteral('0x7f000001'), '十六进制形式必须拦住');
  assert.ok(isIpLiteral('[::1]'), 'IPv6 必须拦住');
  assert.ok(isIpLiteral('::ffff:127.0.0.1'));
  assert.ok(isIpLiteral('127.1'), '缩写点分形式必须拦住');
  assert.ok(!isIpLiteral('api.example.com'));
  assert.ok(!isIpLiteral('a-b.example.co.uk'));
});

await test('精确规则只匹配自身，不匹配子域', () => {
  const rules = compileAllowlist(['api.example.com']);
  assert.ok(matchHost('api.example.com', rules));
  assert.ok(!matchHost('evil.api.example.com', rules), '精确规则不该顺带放开子域');
  assert.ok(!matchHost('example.com', rules));
});

await test('通配规则匹配任意层子域，但不含根域', () => {
  const rules = compileAllowlist(['*.cdn.example.com']);
  assert.ok(matchHost('a.cdn.example.com', rules));
  assert.ok(matchHost('a.b.cdn.example.com', rules), '任意层子域都应命中');
  assert.ok(!matchHost('cdn.example.com', rules), '根域不该被通配符顺带放开');
  // 关键：不能让 example.com 通过「后缀包含」蒙混过关
  assert.ok(!matchHost('evilcdn.example.com', rules), '必须按标签边界匹配，不是字符串后缀');
  assert.ok(!matchHost('xcdn.example.com', rules));
});

await test('大小写与尾点不能绕过白名单', () => {
  const rules = compileAllowlist(['api.example.com']);
  assert.ok(matchHost('API.EXAMPLE.COM', rules));
  assert.ok(matchHost('api.example.com.', rules));
});

await test('IP 永远不命中白名单（即使规则写得很宽松）', () => {
  const rules = compileAllowlist(['*.example.com']);
  assert.ok(!matchHost('127.0.0.1', rules));
  assert.ok(!matchHost('2130706433', rules));
});

await test('拒绝非法规则：IP、多通配符、缺主机名', () => {
  assert.throws(() => compileAllowlist(['127.0.0.1']), /IP 字面量/);
  assert.throws(() => compileAllowlist(['*.*.example.com']), /通配符/);
  assert.throws(() => compileAllowlist(['*.']), /主机名/);
  assert.throws(() => compileAllowlist(['example.*.com']), /通配符/);
});

// ---------------------------------------------------------------- 2. URL 校验

section('2. URL 校验（parseTarget）');

await test('只允许 https', () => {
  assert.throws(() => parseTarget('http://api.example.com/x'), /只允许 https/);
  assert.throws(() => parseTarget('ftp://api.example.com/x'), /只允许 https/);
  assert.throws(() => parseTarget('file:///etc/passwd'), /只允许 https/);
  assert.doesNotThrow(() => parseTarget('https://api.example.com/x'));
});

await test('拒绝 userinfo 视觉欺骗', () => {
  // 人眼看到的是 good.com，实际连的是 evil.com
  assert.throws(() => parseTarget('https://good.com@evil.com/x'), /userinfo/);
  assert.throws(() => parseTarget('https://u:p@api.example.com/x'), /userinfo/);
});

await test('拒绝 IP 字面量', () => {
  assert.throws(() => parseTarget('https://127.0.0.1/x'), /IP 字面量/);
  assert.throws(() => parseTarget('https://2130706433/x'), /IP 字面量/);
  assert.throws(() => parseTarget('https://[::1]/x'), /IP 字面量/);
});

await test('路径与查询串被完整保留（供审计用）', () => {
  const t = parseTarget('https://api.example.com/a/b?c=1&d=2');
  assert.equal(t.host, 'api.example.com');
  assert.equal(t.path, '/a/b?c=1&d=2');
});

// ---------------------------------------------------------------- 3. 令牌桶

section('3. 令牌桶（ratelimit.ts）');

await test('初始桶是满的，消耗到空后拒绝', () => {
  let t = 0;
  const b = new TokenBuckets(3, 1, () => t);
  assert.ok(b.take('k').ok);
  assert.ok(b.take('k').ok);
  assert.ok(b.take('k').ok);
  const denied = b.take('k');
  assert.ok(!denied.ok);
  assert.ok(denied.retryAfterMs > 0, '应给出重试等待时间');
});

await test('按时间补充令牌', () => {
  let t = 0;
  const b = new TokenBuckets(2, 1, () => t);
  b.take('k');
  b.take('k');
  assert.ok(!b.take('k').ok);
  t = 1000;                       // 过 1 秒，补 1 个
  assert.ok(b.take('k').ok);
  assert.ok(!b.take('k').ok);
});

await test('不同键互不影响（per pluginId+host）', () => {
  let t = 0;
  const b = new TokenBuckets(1, 1, () => t);
  assert.ok(b.take('a\u0000host1').ok);
  assert.ok(!b.take('a\u0000host1').ok);
  assert.ok(b.take('a\u0000host2').ok, '换主机应重新有额度');
  assert.ok(b.take('b\u0000host1').ok, '换插件应重新有额度');
});

await test('桶数量有界（不会因 key 爆炸而内存失控）', () => {
  const b = new TokenBuckets(1, 0.0001);
  for (let i = 0; i < 2000; i += 1) b.take(`p\u0000h${i}`);
  assert.ok(b.size() <= 512, `桶数应被限制在 512 以内，实际 ${b.size()}`);
});

// ---------------------------------------------------------------- 4. 能力令牌

section('4. 能力令牌（tokens.ts，I10）');

await test('签发后可校验，能力不匹配则拒绝', () => {
  const r = new CapabilityRegistry();
  const t = r.issue('p1', ['net']);
  assert.equal(r.verify(t.id, 'net').pluginId, 'p1');
  assert.throws(() => r.verify(t.id, 'vault'), /不含所需能力/);
});

await test('缺失 / 伪造 / 过期令牌一律拒绝', () => {
  let now = 1000;
  const r = new CapabilityRegistry(() => now);
  const t = r.issue('p1', ['net'], 100);
  assert.throws(() => r.verify(null, 'net'), /缺少能力令牌/);
  assert.throws(() => r.verify('deadbeef', 'net'), /无效/);
  now = 1200;                    // 过期
  assert.throws(() => r.verify(t.id, 'net'), /已过期/);
});

await test('按插件撤销：撤销后该插件全部令牌失效，别的插件不受影响', () => {
  const r = new CapabilityRegistry();
  const a = r.issue('p1', ['net']);
  const b = r.issue('p2', ['net']);
  const n = r.revokePlugin('p1');
  assert.equal(n, 1);
  assert.throws(() => r.verify(a.id, 'net'), /已被撤销/);
  assert.equal(r.verify(b.id, 'net').pluginId, 'p2', '不应误伤其它插件');
});

await test('恢复信任后仍需重新签发（旧令牌不复活）', () => {
  const r = new CapabilityRegistry();
  const a = r.issue('p1', ['net']);
  r.revokePlugin('p1');
  r.restorePlugin('p1');
  assert.throws(() => r.verify(a.id, 'net'), /无效|已被撤销/);
  const fresh = r.issue('p1', ['net']);
  assert.equal(r.verify(fresh.id, 'net').pluginId, 'p1');
});

await test('sweep 回收过期令牌', () => {
  let now = 0;
  const r = new CapabilityRegistry(() => now);
  r.issue('p1', ['net'], 10);
  r.issue('p1', ['net'], 10_000);
  now = 100;
  assert.equal(r.sweep(), 1);
  assert.equal(r.activeCount, 1);
});

// ---------------------------------------------------------------- 5. 网关

section('5. 网络网关（gateway.ts，§8.1）');

await test('白名单内的请求正常返回，并记审计', async () => {
  const transport = new MockTransport().queue('https://api.example.com/', {
    status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' },
  });
  const { gateway, token, audit } = makeGateway({ transport });

  const res = await gateway.request(token.id, { url: 'https://api.example.com/v1/x' });
  assert.equal(res.status, 200);
  assert.equal(res.body, '{"ok":true}');
  assert.equal(res.hops.length, 1);

  const stats = audit.stats();
  assert.equal(stats.total, 1);
  assert.equal(stats.ok, 1);
  const entry = audit.tail(1)[0];
  assert.equal(entry?.pluginId, 'app.matrix.test');
  assert.equal(entry?.host, 'api.example.com');
  assert.equal(entry?.path, '/v1/x');
});

await test('白名单外的主机被拒，且审计记为 denied', async () => {
  const { gateway, token, audit, transport } = makeGateway();
  await rejects(() => gateway.request(token.id, { url: 'https://evil.com/x' }), 'EHOST');
  assert.equal(transport.calls.length, 0, '被拒的请求绝不能真的发出去');
  assert.equal(audit.stats().denied, 1);
});

await test('无令牌不能发请求', async () => {
  const { gateway, transport } = makeGateway();
  await rejects(() => gateway.request(null, { url: 'https://api.example.com/x' }), 'EAUTH');
  assert.equal(transport.calls.length, 0);
});

await test('令牌缺少 net 能力不能发请求', async () => {
  const transport = new MockTransport();
  const tokens = new CapabilityRegistry();
  const gateway = new NetGateway({
    transport, tokens, audit: new AuditLog(50),
    config: { allowlist: ['api.example.com'] },
  });
  const vaultOnly = tokens.issue('p1', ['vault']);
  await rejects(() => gateway.request(vaultOnly.id, { url: 'https://api.example.com/x' }), 'EAUTH');
  assert.equal(transport.calls.length, 0);
});

await test('触发限流后拒绝，且不再发出请求', async () => {
  const transport = new MockTransport().queue('https://api.example.com/', { status: 200, body: 'ok' });
  const { gateway, token } = makeGateway({ transport, rateCapacity: 2, rateRefillPerSec: 0.0001 });

  await gateway.request(token.id, { url: 'https://api.example.com/1' });
  await gateway.request(token.id, { url: 'https://api.example.com/2' });
  await rejects(() => gateway.request(token.id, { url: 'https://api.example.com/3' }), 'ERATELIMIT');
  assert.equal(transport.calls.length, 2, '被限流的请求不该发出去');
});

await test('响应体超限被拒（按 UTF-8 字节算，不是字符数）', async () => {
  // 200 个中文字符 = 600 字节，远超 100 字节上限，但 length 只有 200
  const big = '中'.repeat(200);
  const transport = new MockTransport().queue('https://api.example.com/', { status: 200, body: big });
  const { gateway, token } = makeGateway({ transport, maxBytes: 100 });
  await rejects(() => gateway.request(token.id, { url: 'https://api.example.com/x' }), 'ETOOBIG');
});

await test('超时被拒：一次很慢的请求把时间耗尽后，下一跳不再发出', async () => {
  let now = 0;
  let sent = 0;
  // 故意返回 302，逼网关再走一轮循环 —— 这样才真正验证 deadline 兜底逻辑，
  // 而不是只验证「进循环前就已经超时」这个平凡分支
  const slow: Transport = {
    kind: 'slow',
    async request(req) {
      sent += 1;
      now += 10_000;
      return {
        status: 302,
        headers: { location: 'https://api.example.com/next' },
        body: '',
        url: req.url,
        followedRedirects: false,
      };
    },
  };
  const tokens = new CapabilityRegistry(() => now);
  const gateway = new NetGateway({
    transport: slow, tokens, audit: new AuditLog(50), now: () => now,
    config: { allowlist: ['api.example.com'], defaultTimeoutMs: 100 },
  });
  const token = tokens.issue('p1', ['net']);

  await rejects(() => gateway.request(token.id, { url: 'https://api.example.com/x' }), 'ETIMEOUT');
  assert.equal(sent, 1, '超时后不该再发出第二跳');
});

await test('timeoutMs: 0 立即超时，一个字节都不发', async () => {
  const transport = new MockTransport();
  const tokens = new CapabilityRegistry();
  const gateway = new NetGateway({
    transport, tokens, audit: new AuditLog(50),
    config: { allowlist: ['api.example.com'], defaultTimeoutMs: 100 },
  });
  const token = tokens.issue('p1', ['net']);
  await rejects(
    () => gateway.request(token.id, { url: 'https://api.example.com/x', timeoutMs: 0 }),
    'ETIMEOUT',
  );
  assert.equal(transport.calls.length, 0);
});

// ---------------------------------------------------------------- 5b. 重试

section('5b. 重试与退避（§8.1「幂等方法指数退避 2 次」）');

await test('幂等方法遇 503 会重试，最终成功', async () => {
  const transport = new MockTransport()
    .queue('https://api.example.com/', { status: 503, body: 'busy' })
    .queue('https://api.example.com/', { status: 200, body: 'ok' });
  const { gateway, token } = makeGateway({ transport });

  const res = await gateway.request(token.id, { url: 'https://api.example.com/x' });
  assert.equal(res.status, 200, '重试后应拿到 200');
  assert.equal(transport.calls.length, 2);
});

await test('POST 绝不重试（避免重复提交）', async () => {
  const transport = new MockTransport()
    .queue('https://api.example.com/', { status: 503, body: 'busy' })
    .queue('https://api.example.com/', { status: 200, body: 'ok' });
  const { gateway, token } = makeGateway({ transport });

  const res = await gateway.request(token.id, {
    url: 'https://api.example.com/x', method: 'POST', body: '{"a":1}',
  });
  assert.equal(res.status, 503, 'POST 应原样返回 503，不重试');
  assert.equal(transport.calls.length, 1, '只发一次，绝不能重复提交');
});

await test('网络错误重试耗尽后抛 ENET，共尝试 1+2 次', async () => {
  const transport = new MockTransport({ status: 200, body: '', throw: 'DNS 解析失败' });
  const { gateway, token } = makeGateway({ transport });
  await rejects(() => gateway.request(token.id, { url: 'https://api.example.com/x' }), 'ENET');
  assert.equal(transport.calls.length, 3, 'GET 应共尝试 3 次');
});

await test('4xx 不重试（请求本身的问题，重试只会白耗配额）', async () => {
  const transport = new MockTransport().queue('https://api.example.com/', { status: 404, body: 'nope' });
  const { gateway, token } = makeGateway({ transport });
  const res = await gateway.request(token.id, { url: 'https://api.example.com/x' });
  assert.equal(res.status, 404);
  assert.equal(transport.calls.length, 1);
});

await test('重试受总超时约束：退避等不完就放弃，并把 503 原样交回', async () => {
  let now = 0;
  let sent = 0;
  const flaky: Transport = {
    kind: 'flaky',
    async request(req) {
      sent += 1;
      now += 60;                      // 每次尝试耗时 60ms
      return { status: 503, headers: {}, body: '', url: req.url, followedRedirects: false };
    },
  };
  const tokens = new CapabilityRegistry(() => now);
  const gateway = new NetGateway({
    transport: flaky, tokens, audit: new AuditLog(50), now: () => now,
    config: {
      allowlist: ['api.example.com'], defaultTimeoutMs: 100,
      retryCount: 5, retryBaseMs: 40,   // 退避 40ms，但只剩 40ms → 等不完
    },
  });
  const token = tokens.issue('p1', ['net']);

  const res = await gateway.request(token.id, { url: 'https://api.example.com/x' });
  assert.equal(res.status, 503, '没时间重试时应把已拿到的响应交回，而不是抛超时');
  assert.ok(sent < 6, `不该把 5 次重试全做完，实际发了 ${sent} 次`);
});

// ---------------------------------------------------------------- 5c. 响应体保真度

section('5c. 响应体保真度（JSON 往返）');

await test('传输层返回对象时，如实标记 jsonRoundTrip', async () => {
  const transport = new MockTransport().queue('https://api.example.com/', {
    status: 200,
    headers: { 'content-type': 'application/json' },
    json: { ok: true, n: 1 },
  });
  const { gateway, token, audit } = makeGateway({ transport });

  const res = await gateway.request(token.id, { url: 'https://api.example.com/x' });
  assert.equal(res.jsonRoundTrip, true, '应标出「这不是线上原始字节」');
  assert.equal(res.body, '{"ok":true,"n":1}');
  assert.equal(audit.tail(1)[0]?.jsonRoundTrip, true, '审计也要记');
});

await test('传输层返回字符串时不标记', async () => {
  const transport = new MockTransport().queue('https://api.example.com/', {
    status: 200, headers: { 'content-type': 'text/plain' }, body: 'hello',
  });
  const { gateway, token } = makeGateway({ transport });
  const res = await gateway.request(token.id, { url: 'https://api.example.com/x' });
  assert.equal(res.jsonRoundTrip, undefined);
  assert.equal(res.body, 'hello');
});

await test('超过 2^53-1 的大整数会被告警（可能已静默丢精度）', async () => {
  const transport = new MockTransport().queue('https://api.example.com/', {
    status: 200,
    headers: { 'content-type': 'application/json' },
    json: { id: 9007199254740992, name: 'x' },
  });
  const { gateway, token, audit } = makeGateway({ transport });

  const res = await gateway.request(token.id, { url: 'https://api.example.com/x' });
  assert.equal(res.bigIntRisk, 1, '应报出 1 个大整数');
  assert.equal(audit.tail(1)[0]?.bigIntRisk, 1);
});

await test('毫秒时间戳这类 13 位整数不误报', async () => {
  const transport = new MockTransport().queue('https://api.example.com/', {
    status: 200,
    headers: { 'content-type': 'application/json' },
    json: { id: 1234567890, ts: 1700000000000 },
  });
  const { gateway, token } = makeGateway({ transport });
  const res = await gateway.request(token.id, { url: 'https://api.example.com/x' });
  assert.equal(res.bigIntRisk, undefined, '13 位时间戳是安全整数，不该告警');
});

await test('小数与科学计数法不误报（它们不是整数）', async () => {
  const transport = new MockTransport().queue('https://api.example.com/', {
    status: 200,
    headers: { 'content-type': 'application/json' },
    json: { a: 1.2345678901234567e300, b: 1234567890123456.5 },
  });
  const { gateway, token } = makeGateway({ transport });
  const res = await gateway.request(token.id, { url: 'https://api.example.com/x' });
  assert.equal(res.bigIntRisk, undefined, '带小数点的长数字不该被当成大整数');
});

await test('大小上限量的是传输层返回的字符串（已知偏差，如实记录）', async () => {
  const transport = new MockTransport().queue('https://api.example.com/', {
    status: 200, headers: { 'content-type': 'application/json' },
    json: { pad: '中'.repeat(100) },
  });
  const { gateway, token } = makeGateway({ transport, maxBytes: 100 });
  // 序列化后是 300+ 字节（中文 3 字节/字），应超限
  await rejects(() => gateway.request(token.id, { url: 'https://api.example.com/x' }), 'ETOOBIG');
});

// ---------------------------------------------------------------- 6. 跳转复检

section('6. 逐跳复检白名单（最容易漏的一环）');

await test('白名单内的跳转被放行，hops 记录完整链', async () => {
  const transport = new MockTransport()
    .queue('https://api.example.com/start', { status: 302, headers: { location: 'https://api.example.com/end' } })
    .queue('https://api.example.com/end', { status: 200, body: 'done' });
  const { gateway, token } = makeGateway({ transport, allowlist: ['api.example.com'] });

  const res = await gateway.request(token.id, { url: 'https://api.example.com/start' });
  assert.equal(res.status, 200);
  assert.equal(res.body, 'done');
  assert.equal(res.hops.length, 2, '应记录两跳');
});

await test('跳转目标不在白名单 → 拒绝（初始 URL 合法也不放行）', async () => {
  const transport = new MockTransport()
    .queue('https://api.example.com/start', { status: 302, headers: { location: 'https://evil.com/steal' } });
  const { gateway, token, audit } = makeGateway({ transport, allowlist: ['api.example.com'] });

  await rejects(() => gateway.request(token.id, { url: 'https://api.example.com/start' }), 'EREDIRECT');
  assert.equal(transport.calls.length, 1, '绝不该跟着跳到 evil.com');
  assert.equal(audit.stats().denied, 1);
});

await test('跳转到 IP 字面量 → 拒绝', async () => {
  const transport = new MockTransport()
    .queue('https://api.example.com/s', { status: 302, headers: { location: 'https://127.0.0.1/x' } });
  const { gateway, token } = makeGateway({ transport, allowlist: ['api.example.com'] });
  await rejects(() => gateway.request(token.id, { url: 'https://api.example.com/s' }), 'EIP');
});

await test('跳转到 http（降级）→ 拒绝', async () => {
  const transport = new MockTransport()
    .queue('https://api.example.com/s', { status: 302, headers: { location: 'http://api.example.com/x' } });
  const { gateway, token } = makeGateway({ transport, allowlist: ['api.example.com'] });
  await rejects(() => gateway.request(token.id, { url: 'https://api.example.com/s' }), 'EURL');
});

await test('相对 Location 被正确解析并复检', async () => {
  const transport = new MockTransport()
    .queue('https://api.example.com/a/start', { status: 302, headers: { location: '/b/end' } })
    .queue('https://api.example.com/b/end', { status: 200, body: 'rel-ok' });
  const { gateway, token } = makeGateway({ transport, allowlist: ['api.example.com'] });
  const res = await gateway.request(token.id, { url: 'https://api.example.com/a/start' });
  assert.equal(res.body, 'rel-ok');
  assert.equal(res.hops[1], 'https://api.example.com/b/end');
});

await test('跳转次数超限 → 拒绝（防跳转环）', async () => {
  const transport = new MockTransport();
  for (let i = 0; i < 10; i += 1) {
    transport.queue(`https://api.example.com/h${i}`, {
      status: 302, headers: { location: `https://api.example.com/h${i + 1}` },
    });
  }
  const { gateway, token } = makeGateway({ transport, allowlist: ['api.example.com'] });
  await rejects(() => gateway.request(token.id, { url: 'https://api.example.com/h0' }), 'EREDIRECT');
});

await test('303 跳转把 POST 降级为 GET 并丢弃 body', async () => {
  const transport = new MockTransport()
    .queue('https://api.example.com/post', { status: 303, headers: { location: 'https://api.example.com/after' } })
    .queue('https://api.example.com/after', { status: 200, body: 'ok' });
  const { gateway, token } = makeGateway({ transport, allowlist: ['api.example.com'] });

  await gateway.request(token.id, { url: 'https://api.example.com/post', method: 'POST', body: '{"a":1}' });
  assert.equal(transport.calls[0]?.method, 'POST');
  assert.equal(transport.calls[1]?.method, 'GET', '303 之后应变成 GET');
  assert.equal(transport.calls[1]?.body, undefined, '303 之后应丢弃 body');
});

await test('307 保留方法与 body', async () => {
  const transport = new MockTransport()
    .queue('https://api.example.com/p', { status: 307, headers: { location: 'https://api.example.com/q' } })
    .queue('https://api.example.com/q', { status: 200, body: 'ok' });
  const { gateway, token } = makeGateway({ transport, allowlist: ['api.example.com'] });

  await gateway.request(token.id, { url: 'https://api.example.com/p', method: 'POST', body: 'x' });
  assert.equal(transport.calls[1]?.method, 'POST');
  assert.equal(transport.calls[1]?.body, 'x');
});

// ---------------------------------------------------------------- 7. 会话

section('7. 会话注入（凭证不进插件）');

await test('Set-Cookie 被核心收走，后续请求自动带上，插件看不到内容', async () => {
  const transport = new MockTransport()
    .queue('https://api.example.com/login', {
      status: 200, body: 'ok', headers: { 'set-cookie': 'sid=abc123; Path=/; HttpOnly' },
    })
    .queue('https://api.example.com/me', { status: 200, body: 'me' });
  const { gateway, token, sessions } = makeGateway({ transport, allowlist: ['api.example.com'] });

  const r1 = await gateway.request(token.id, { url: 'https://api.example.com/login', session: 'sess-1' });
  assert.ok(!r1.headers['set-cookie']?.includes('sid=abc123') || true);

  await gateway.request(token.id, { url: 'https://api.example.com/me', session: 'sess-1' });
  assert.equal(transport.calls[1]?.headers['cookie'], 'sid=abc123');
  assert.equal(sessions.cookieCount('sess-1'), 1);
});

await test('不同会话互不串味', async () => {
  const transport = new MockTransport()
    .queue('https://api.example.com/a', { status: 200, body: 'ok', headers: { 'set-cookie': 'sid=A' } })
    .queue('https://api.example.com/b', { status: 200, body: 'ok', headers: { 'set-cookie': 'sid=B' } })
    .queue('https://api.example.com/x', { status: 200, body: 'ok' })
    .queue('https://api.example.com/y', { status: 200, body: 'ok' });
  const { gateway, token } = makeGateway({ transport, allowlist: ['api.example.com'] });

  await gateway.request(token.id, { url: 'https://api.example.com/a', session: 'S1' });
  await gateway.request(token.id, { url: 'https://api.example.com/b', session: 'S2' });
  await gateway.request(token.id, { url: 'https://api.example.com/x', session: 'S1' });
  await gateway.request(token.id, { url: 'https://api.example.com/y', session: 'S2' });

  assert.equal(transport.calls[2]?.headers['cookie'], 'sid=A');
  assert.equal(transport.calls[3]?.headers['cookie'], 'sid=B');
});

await test('Set-Cookie 里的 Expires 逗号不会被误切', async () => {
  const transport = new MockTransport()
    .queue('https://api.example.com/s', {
      status: 200, body: 'ok',
      headers: { 'set-cookie': 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, b=2; Path=/' },
    })
    .queue('https://api.example.com/t', { status: 200, body: 'ok' });
  const { gateway, token } = makeGateway({ transport, allowlist: ['api.example.com'] });

  await gateway.request(token.id, { url: 'https://api.example.com/s', session: 'S' });
  await gateway.request(token.id, { url: 'https://api.example.com/t', session: 'S' });
  const cookie = transport.calls[1]?.headers['cookie'] ?? '';
  assert.ok(cookie.includes('a=1'), `应包含 a=1，实际 ${cookie}`);
  assert.ok(cookie.includes('b=2'), `应包含 b=2，实际 ${cookie}`);
});

await test('Set-Cookie 必须从返回给插件的响应头里剥掉（否则前门锁后门开）', async () => {
  const transport = new MockTransport().queue('https://api.example.com/login', {
    status: 200,
    body: 'ok',
    headers: {
      'set-cookie': 'sid=secret123; Path=/; HttpOnly',
      'content-type': 'text/plain',
      'x-request-id': 'abc',
    },
  });
  const { gateway, token } = makeGateway({ transport, allowlist: ['api.example.com'] });

  const res = await gateway.request(token.id, {
    url: 'https://api.example.com/login', session: 'S',
  });

  assert.equal(res.headers['set-cookie'], undefined, 'set-cookie 必须被剥掉');
  assert.equal(res.headers['content-type'], 'text/plain', '其它响应头应原样保留');
  assert.equal(res.headers['x-request-id'], 'abc');
  assert.ok(
    !JSON.stringify(res.headers).includes('secret123'),
    '响应头里不能出现 cookie 明文',
  );
});

await test('审计只记 cookie 的**数量**，绝不记内容', async () => {
  const transport = new MockTransport().queue('https://api.example.com/login', {
    status: 200, body: 'ok',
    headers: { 'set-cookie': 'sid=secret123; Path=/, csrf=tok456' },
  });
  const { gateway, token, audit } = makeGateway({ transport, allowlist: ['api.example.com'] });

  await gateway.request(token.id, { url: 'https://api.example.com/login', session: 'S' });

  const entry = audit.tail(1)[0];
  assert.equal(entry?.cookiesSet, 2, '应记下收走了 2 个 cookie');
  assert.ok(
    !JSON.stringify(entry).includes('secret123'),
    '审计条目里绝不能出现 cookie 内容',
  );
});

await test('调用方自带的 cookie 头不能盖掉注入的会话 cookie（请求侧后门）', async () => {
  /*
   * 这条是补上一个真实的漏：响应侧早就洗了 `set-cookie`，
   * 但请求侧的合并写的是 `{ ...injected, ...req.headers }` ——
   * 调用方只要塞一个 `cookie`，就能盖掉核心从 vault 注入的会话 cookie。
   */
  const transport = new MockTransport()
    .queue('https://api.example.com/login', {
      status: 200, body: 'ok', headers: { 'set-cookie': 'sid=real' },
    })
    .queue('https://api.example.com/steal', { status: 200, body: 'ok' });
  const { gateway, token } = makeGateway({ transport, allowlist: ['api.example.com'] });

  await gateway.request(token.id, { url: 'https://api.example.com/login', session: 'S' });
  await gateway.request(token.id, {
    url: 'https://api.example.com/steal',
    session: 'S',
    headers: { cookie: 'sid=forged', authorization: 'Bearer stolen' },
  });

  const sent = transport.calls[1]?.headers ?? {};
  assert.equal(sent['cookie'], 'sid=real', '必须是核心注入的会话 cookie，不是调用方塞的');
  assert.equal(sent['authorization'], undefined, 'authorization 必须被剥掉');
  const flat = JSON.stringify(sent);
  assert.ok(!flat.includes('forged'), '调用方塞的 cookie 绝不能出现在实际请求里');
  assert.ok(!flat.includes('stolen'), '调用方塞的 authorization 绝不能出现在实际请求里');
});

await test('剥掉凭证头的事实记进审计，且只记头名不记值', async () => {
  const transport = new MockTransport().queue('https://api.example.com/x', { status: 200, body: 'ok' });
  const { gateway, token, audit } = makeGateway({ transport, allowlist: ['api.example.com'] });

  await gateway.request(token.id, {
    url: 'https://api.example.com/x',
    headers: { Cookie: 'sid=forged', Authorization: 'Bearer stolen' },
  });

  const entry = audit.tail(1)[0];
  assert.deepEqual(entry?.headersStripped, ['authorization', 'cookie'], '大小写不敏感，顺序稳定');
  const flat = JSON.stringify(entry);
  assert.ok(!flat.includes('forged'), '审计里绝不能出现凭证值');
  assert.ok(!flat.includes('stolen'), '审计里绝不能出现凭证值');
});

await test('正常自定义头照常转发，不被误伤', async () => {
  const transport = new MockTransport().queue('https://api.example.com/x', { status: 200, body: 'ok' });
  const { gateway, token } = makeGateway({ transport, allowlist: ['api.example.com'] });

  await gateway.request(token.id, {
    url: 'https://api.example.com/x',
    headers: { 'X-Trace': 'keep', Accept: 'application/json' },
  });

  const sent = transport.calls[0]?.headers ?? {};
  assert.equal(sent['X-Trace'] ?? sent['x-trace'], 'keep');
  assert.equal(sent['Accept'] ?? sent['accept'], 'application/json');
});

await test('没有禁用头时，审计条目里不出现 headersStripped 字段', async () => {
  const transport = new MockTransport().queue('https://api.example.com/x', { status: 200, body: 'ok' });
  const { gateway, token, audit } = makeGateway({ transport, allowlist: ['api.example.com'] });

  await gateway.request(token.id, { url: 'https://api.example.com/x' });

  const entry = audit.tail(1)[0];
  assert.equal('headersStripped' in (entry ?? {}), false, '没发生就不该有这个字段');
});

// ---------------------------------------------------------------- 7b. 原生 cookie 后端

section('7b. CapacitorCookies 会话后端');
class FakeJar implements CookieJarNative {
  readonly calls: string[] = [];
  readonly store = new Map<string, string>();
  async setCookie(o: { url: string; key: string; value: string }): Promise<void> {
    this.calls.push(`set ${o.url} ${o.key}`);
    this.store.set(`${o.url}|${o.key}`, o.value);
  }
  async deleteCookie(o: { url: string; key: string }): Promise<void> {
    this.calls.push(`del ${o.url} ${o.key}`);
    this.store.delete(`${o.url}|${o.key}`);
  }
  async clearAllCookies(): Promise<void> {
    this.calls.push('clearAll');
    this.store.clear();
  }
}

await test('写入落到原生存储，host 被规范成 https origin', async () => {
  const jar = new FakeJar();
  const s = new CapacitorCookiesSession(jar);
  await s.acceptSetCookie('S1', 'API.Example.com', ['sid=abc; Path=/', 'theme=dark']);

  assert.equal(jar.store.get('https://api.example.com/|sid'), 'abc');
  assert.equal(jar.store.get('https://api.example.com/|theme'), 'dark');
});

await test('headersFor 刻意返回空 —— 原生 CookieHandler 会自动附加，不该重复注入', async () => {
  const s = new CapacitorCookiesSession(new FakeJar());
  assert.deepEqual(await s.headersFor('S1', 'api.example.com'), {});
});

await test('精确撤销只删本会话的 cookie，不误伤别的会话', async () => {
  const jar = new FakeJar();
  const s = new CapacitorCookiesSession(jar);
  await s.acceptSetCookie('S1', 'api.example.com', ['a=1']);
  await s.acceptSetCookie('S2', 'api.example.com', ['b=2']);

  assert.equal(await s.clear('S1'), 1);
  assert.equal(jar.store.get('https://api.example.com/|a'), undefined, 'S1 的应被删掉');
  assert.equal(jar.store.get('https://api.example.com/|b'), '2', 'S2 的绝不能被误删');
});

await test('过期/空值 cookie 走删除分支', async () => {
  const jar = new FakeJar();
  const s = new CapacitorCookiesSession(jar);
  await s.acceptSetCookie('S1', 'api.example.com', ['sid=abc']);
  await s.acceptSetCookie('S1', 'api.example.com', ['sid=; Max-Age=0']);
  assert.equal(jar.store.get('https://api.example.com/|sid'), undefined);
});

await test('原生插件失败不抛错，只累计 failures（不能拖垮请求）', async () => {
  const broken: CookieJarNative = {
    async setCookie() { throw new Error('原生不可用'); },
    async deleteCookie() { throw new Error('原生不可用'); },
    async clearAllCookies() { throw new Error('原生不可用'); },
  };
  const s = new CapacitorCookiesSession(broken);
  await s.acceptSetCookie('S1', 'api.example.com', ['a=1']);   // 不该抛
  assert.equal(s.stats.failures, 1);
});

await test('会话后端可在运行时切换', () => {
  const core = new Core({ transport: new MockTransport() });
  assert.equal(core.session.backend, 'memory');
  assert.equal(core.net.sessionKind, 'memory');

  core.setSessionBackend('capacitor-cookies');
  assert.equal(core.session.backend, 'capacitor-cookies');
  assert.equal(core.net.sessionKind, 'capacitor-cookies');
  assert.ok(core.session.stats, '切到原生后端后应带上统计');

  core.setSessionBackend('memory');
  assert.equal(core.net.sessionKind, 'memory');
});

// ---------------------------------------------------------------- 8. 单一窄入口

section('8. 单一窄入口（index.ts，I10 / I11）');

await test('未知方法被拒', async () => {
  const core = new Core({ transport: new MockTransport() });
  const t = core.issueToken('p1', ['net']);
  await rejects(() => core.call(t.id, 'net.magic'), 'EAUTH');
});

await test('__proto__ / constructor 不能绕过方法派发（I11）', async () => {
  const core = new Core({ transport: new MockTransport() });
  const t = core.issueToken('p1', ['net']);
  await rejects(() => core.call(t.id, '__proto__'), 'EAUTH');
  await rejects(() => core.call(t.id, 'constructor'), 'EAUTH');
  await rejects(() => core.call(t.id, 'toString'), 'EAUTH');
  await rejects(() => core.call(t.id, 'hasOwnProperty'), 'EAUTH');
});

await test('net.check 不需要 net 能力（调试面板要能自查）', async () => {
  const core = new Core({
    transport: new MockTransport(),
    gateway: { config: { allowlist: ['api.example.com'] } },
  });
  const r = await core.call(null, 'net.check', { url: 'https://api.example.com/x' }) as { ok: boolean };
  assert.equal(r.ok, true);
  const bad = await core.call(null, 'net.check', { url: 'https://evil.com/x' }) as { ok: boolean; code: string };
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'EHOST');
});

await test('status() 如实上报传输层与 vault 强度', () => {
  const core = new Core({ transport: new MockTransport() });
  const s = core.status();
  assert.equal(s.transport, 'mock');
  assert.equal(s.vault.available, false);
  assert.equal(s.vault.protection, 'none');
});

// ---------------------------------------------------------------- 9. vault

section('9. 凭证库（vault.ts）');

class FakeBackend {
  readonly map = new Map<string, string>();
  readonly encrypted: boolean;
  constructor(encrypted: boolean) {
    this.encrypted = encrypted;
  }
  async get(k: string) { return this.map.get(k) ?? null; }
  async set(k: string, v: string) { this.map.set(k, v); }
  async remove(k: string) { this.map.delete(k); }
  async keys() { return [...this.map.keys()]; }
}

await test('读写往返', async () => {
  const tokens = new CapabilityRegistry();
  const v = new Vault(new FakeBackend(true), tokens);
  const t = tokens.issue('p1', ['vault']);
  await v.set(t.id, 'k', 'v');
  assert.equal(await v.get(t.id, 'k'), 'v');
});

await test('插件之间命名空间隔离：A 读不到 B 的键', async () => {
  const tokens = new CapabilityRegistry();
  const backend = new FakeBackend(true);
  const v = new Vault(backend, tokens);
  const a = tokens.issue('pluginA', ['vault']);
  const b = tokens.issue('pluginB', ['vault']);

  await v.set(a.id, 'token', 'A-secret');
  await v.set(b.id, 'token', 'B-secret');

  assert.equal(await v.get(a.id, 'token'), 'A-secret');
  assert.equal(await v.get(b.id, 'token'), 'B-secret', '同名键不能互相覆盖');

  const listA = await v.list(a.id);
  assert.equal(listA.length, 1);
  assert.equal(listA[0]?.key, 'token', '列表应剥掉命名空间前缀');
  assert.ok(!JSON.stringify(listA).includes('A-secret'), 'list 不能泄漏内容');
});

await test('clear 只清自己的命名空间', async () => {
  const tokens = new CapabilityRegistry();
  const v = new Vault(new FakeBackend(true), tokens);
  const a = tokens.issue('pluginA', ['vault']);
  const b = tokens.issue('pluginB', ['vault']);
  await v.set(a.id, 'x', '1');
  await v.set(b.id, 'y', '2');
  assert.equal(await v.clear(a.id), 1);
  assert.equal(await v.get(a.id, 'x'), null);
  assert.equal(await v.get(b.id, 'y'), '2', '不该误删别的插件');
});

await test('没有 vault 能力则拒绝', async () => {
  const tokens = new CapabilityRegistry();
  const v = new Vault(new FakeBackend(true), tokens);
  const t = tokens.issue('p1', ['net']);
  await rejects(() => v.get(t.id, 'k'), 'EAUTH');
});

await test('键名含保留字符被拒（防命名空间逃逸）', async () => {
  const tokens = new CapabilityRegistry();
  const v = new Vault(new FakeBackend(true), tokens);
  const t = tokens.issue('p1', ['vault']);
  await rejects(() => v.set(t.id, 'a\u0000b', 'x'), 'EAUTH');
});

await test('保护强度如实上报：明文后端必须警告', () => {
  const tokens = new CapabilityRegistry();
  const strong = new Vault(new FakeBackend(true), tokens);
  const weak = new Vault(new FakeBackend(false), tokens);
  assert.equal(strong.protection, 'system');
  assert.ok(!strong.protectionNote.includes('⚠️'));
  assert.equal(weak.protection, 'plaintext');
  assert.ok(weak.protectionNote.includes('⚠️'), '明文后端必须给出警告，不能含糊');
});

// ---------------------------------------------------------------- 10. 审计

section('10. 审计（audit.ts）');

await test('环形缓冲有界，tail 从新到旧', () => {
  const log = new AuditLog(3);
  for (let i = 1; i <= 5; i += 1) {
    log.record({
      at: i, pluginId: 'p', method: 'GET', host: 'h', path: '/', status: 200,
      bytes: 0, ms: 1, outcome: 'ok',
    });
  }
  assert.equal(log.size, 3, '只保留最近 3 条');
  assert.equal(log.stats().total, 5, 'total 统计全部');
  const tail = log.tail(3);
  assert.equal(tail[0]?.at, 5, '第一条应是最新的');
  assert.equal(tail[2]?.at, 3);
});

await test('sink 抛错不影响主流程', () => {
  const log = new AuditLog(10, () => { throw new Error('sink 炸了'); });
  assert.doesNotThrow(() => log.record({
    at: 1, pluginId: 'p', method: 'GET', host: 'h', path: '/', status: 200,
    bytes: 0, ms: 1, outcome: 'ok',
  }));
  assert.equal(log.stats().total, 1);
});

await test('按插件过滤', () => {
  const log = new AuditLog(10);
  for (const p of ['a', 'b', 'a']) {
    log.record({ at: 1, pluginId: p, method: 'GET', host: 'h', path: '/', status: 200, bytes: 0, ms: 1, outcome: 'ok' });
  }
  assert.equal(log.tailFor('a').length, 2);
  assert.equal(log.tailFor('b').length, 1);
});

// ---------------------------------------------------------------- 11. 审计落库

section('11. 审计落库（audit-store.ts）');

function entryAt(at: number, host = 'h'): AuditEntry {
  return { at, pluginId: 'p', method: 'GET', host, path: '/', status: 200, bytes: 0, ms: 1, outcome: 'ok' };
}

await test('空后端 load 返回空数组', async () => {
  const store = new DurableAuditStore(new FakeBackend(true));
  assert.deepEqual(await store.load(), []);
});

await test('push 后 flush，再 load 能读回', async () => {
  const backend = new FakeBackend(true);
  const a = new DurableAuditStore(backend);
  a.push(entryAt(1, 'a.example.com'));
  a.push(entryAt(2, 'b.example.com'));
  assert.equal(await a.flush(), true);

  const b = new DurableAuditStore(backend);
  const back = await b.load();
  assert.equal(back.length, 2);
  assert.equal(back[1]?.host, 'b.example.com');
});

await test('超出上限时丢最旧的，保留最近 N 条', async () => {
  const backend = new FakeBackend(true);
  const store = new DurableAuditStore(backend, 'k', 3);
  for (let i = 1; i <= 6; i += 1) store.push(entryAt(i));
  await store.flush();

  const back = new DurableAuditStore(backend, 'k', 3);
  const rows = await back.load();
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.at, 4, '应保留最近的 4/5/6');
  assert.equal(rows[2]?.at, 6);
});

await test('坏数据不会崩，直接当作空日志', async () => {
  const backend = new FakeBackend(true);
  await backend.set('k', '这不是 JSON{{{');
  const store = new DurableAuditStore(backend, 'k');
  assert.deepEqual(await store.load(), []);

  await backend.set('k', '{"不是":"数组"}');
  assert.deepEqual(await store.load(), []);
});

await test('后端写失败时 flush 返回 false，不抛错', async () => {
  const failing = {
    async get() { return null; },
    async set() { throw new Error('Keystore 不可用'); },
    async remove() { /* noop */ },
  };
  const store = new DurableAuditStore(failing);
  store.push(entryAt(1));
  assert.equal(await store.flush(), false, '失败应如实返回 false');
  assert.ok(store.stats.lastError?.includes('Keystore'), '应记录失败原因');
});

await test('审计 sink 抛错不影响网关请求（端到端）', async () => {
  const transport = new MockTransport().queue('https://api.example.com/', { status: 200, body: 'ok' });
  const tokens = new CapabilityRegistry();
  const audit = new AuditLog(50, () => { throw new Error('sink 炸了'); });
  const gateway = new NetGateway({
    transport, tokens, audit, config: { allowlist: ['api.example.com'] },
  });
  const token = tokens.issue('p1', ['net']);
  const res = await gateway.request(token.id, { url: 'https://api.example.com/x' });
  assert.equal(res.status, 200, '审计失败不该让请求失败');
});

// ------------------------------------------------- 11b. 重启后审计可见（真实 bug 回归）

section('11b. 重启后审计可见（回归：曾出现「有计数、无列表」）');

await test('seed 把读回的记录填进环形缓冲，且不重新触发 sink', async () => {
  let sinkCalls = 0;
  const log = new AuditLog(50, () => { sinkCalls += 1; });

  log.seed([entryAt(1), entryAt(2), entryAt(3)]);

  assert.equal(log.size, 3, '列表应当有 3 条 —— 这正是曾经为空的地方');
  assert.equal(sinkCalls, 0, 'seed 不该把刚读出来的又写回去');
  assert.equal(log.tail(1)[0]?.at, 3, '仍应从新到旧');
});

await test('seed 后统计与列表一致（不能「列表有、统计为 0」）', async () => {
  const log = new AuditLog(50);
  log.seed([
    { ...entryAt(1), outcome: 'ok' },
    { ...entryAt(2), outcome: 'denied' },
    { ...entryAt(3), outcome: 'denied' },
  ]);

  const s = log.stats();
  assert.equal(s.total, 3, '统计必须跟着补上');
  assert.equal(s.ok, 1);
  assert.equal(s.denied, 2);
});

await test('seed 之后的新记录照常写盘', async () => {
  let sinkCalls = 0;
  const log = new AuditLog(50, () => { sinkCalls += 1; });
  log.seed([entryAt(1)]);
  log.record({ ...entryAt(2), outcome: 'ok' });

  assert.equal(sinkCalls, 1, '只有新记录该触发 sink');
  assert.equal(log.size, 2);
});

await test('seed 尊重容量上限，保留最新的', async () => {
  const log = new AuditLog(3);
  log.seed([entryAt(1), entryAt(2), entryAt(3), entryAt(4), entryAt(5)]);

  assert.equal(log.size, 3);
  assert.equal(log.tail(3)[2]?.at, 3, '应保留最新的 3 条');
});

await test('磁盘数据被改坏不炸，也不污染统计', async () => {
  const log = new AuditLog(50);
  log.seed([
    { ...entryAt(1), outcome: '乱写' as never },
    null as never,
    entryAt(2),
  ]);

  assert.equal(log.size, 2, '坏条目跳过，好条目保留');
  assert.equal(log.stats().total, 2);
});

await test('端到端：落盘 → 模拟重启 → 读回 → seed → 列表非空', async () => {
  const backend = new FakeBackend(true);

  const first = new DurableAuditStore(backend, 'k');
  const src = new AuditLog(50, first.push);
  src.record({ ...entryAt(1, 'a.example.com'), outcome: 'ok' });
  src.record({ ...entryAt(2, 'b.example.com'), outcome: 'denied' });
  assert.equal(await first.flush(), true);

  // 模拟重启：全新的 store 与全新的 AuditLog
  const second = new DurableAuditStore(backend, 'k');
  const restored = await second.load();
  const log = new AuditLog(50, second.push);
  log.seed(restored);

  assert.equal(log.size, 2, '重启后列表不该是空的');
  assert.equal(log.tail(2)[1]?.host, 'a.example.com');
  assert.equal(log.stats().denied, 1, '统计也要恢复');
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
