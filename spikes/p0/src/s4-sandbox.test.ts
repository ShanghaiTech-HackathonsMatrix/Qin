/**
 * S4 —— QuickJS 沙箱边界与逃逸回归测试
 *
 * 全部姿势均来自 spikes/p0 的探针实证（见 REPORT.md「QuickJS 硬性纪律」）：
 *   · 只用 evalCodeAsync，绝不用同步 evalCode
 *   · wrapped 代码必须以 `undefined;` 结尾（否则宿主会 dispose 掉 pending promise 的 handle）
 *   · 宿主回调返回值只用底层构造器拼（newObject/newString/newNumber/ctx.true）
 *   · 不用 ctx.resolvePromise（即使已 settle 也会挂住），改用「.then 写全局 + pump」
 *
 * 运行：node src/s4-sandbox.test.ts
 */

import { newQuickJSAsyncWASMModule, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

const pass: string[] = [];
const fail: string[] = [];
const check = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); pass.push(name); }
  catch (e: any) { fail.push(`${name}: ${e.message.split('\n')[0]}`); }
};
const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

const tick = () => new Promise((r) => setTimeout(r, 0));

// ============================================================ 权限矩阵（与 docs/design/sandbox-sketch.ts 的 GUARDS 同构）

type Guard = 'allow' | 'deny' | 'prompt';

const GUARDS: Record<string, Guard> = {
  'db.find': 'allow',
  'db.insert': 'allow',
  'db.raw': 'deny',            // 插件永远不能写 SQL
  'net.request': 'prompt',     // 需要域名白名单 + 用户授权
  'net.parseHtml': 'allow',
  'auth.getToken': 'deny',     // 凭证永不进 JS 堆
  'secrets.read': 'deny',
  'llm.complete': 'prompt',
  'fs.read': 'deny',
  'system.exec': 'deny',
};

const ALLOWED_ORIGINS = ['https://ecloud.shanghaitech.edu.cn'];

function authorize(method: string, args: unknown): { ok: true } | { ok: false; code: string; message: string } {
  const guard = GUARDS[method];
  if (!guard) return { ok: false, code: 'ENOTFOUND', message: `未知方法 ${method}` };
  if (guard === 'deny') return { ok: false, code: 'EPERM', message: `方法 ${method} 未授权` };
  if (method === 'net.request') {
    const url = (args as any)?.url;
    if (typeof url !== 'string') return { ok: false, code: 'ESCHEMA', message: 'url 必须是字符串' };
    let host: string;
    try { host = new URL(url).origin; } catch { return { ok: false, code: 'ESCHEMA', message: 'url 无法解析' }; }
    if (!ALLOWED_ORIGINS.includes(host)) return { ok: false, code: 'ENETDENIED', message: `域名不在白名单: ${host}` };
  }
  return { ok: true };
}

// ============================================================ 沙箱工厂

interface Sandbox { mod: any; runtime: any; ctx: any; ev: (code: string) => Promise<unknown>; invoke: (expr: string) => Promise<{ ok: boolean; value?: unknown; error?: string }>; audit: string[] }

async function makeSandbox(): Promise<Sandbox> {
  const mod = await newQuickJSAsyncWASMModule();
  const runtime = mod.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 60_000));
  const ctx: any = runtime.newContext();

  const audit: string[] = [];

  // 唯一的宿主出口：__rpc。插件拿到的一切宿主能力都必须经过它。
  const rpc = ctx.newAsyncifiedFunction('__rpc', async (methodH: any, argsH: any) => {
    // 【硬性纪律】宿主回调必须让出至少一个宏任务再返回。
    // 纯同步完成的 async 回调会让 asyncify 在未让出事件循环的情况下重入，
    // 第二次 RPC 起就会崩在 "null function or function signature mismatch"（WASM 表损坏）。
    await tick();

    const method = ctx.dump(methodH);
    const args = ctx.dump(argsH);
    audit.push(method);

    const verdict = authorize(method, args);
    const out = ctx.newObject();
    if (!verdict.ok) {
      ctx.setProp(out, 'ok', ctx.false);
      ctx.setProp(out, 'code', ctx.newString(verdict.code));
      ctx.setProp(out, 'message', ctx.newString(verdict.message));
      return out;
    }
    // 桩实现：真实实现由原生核心提供
    ctx.setProp(out, 'ok', ctx.true);
    ctx.setProp(out, 'data', ctx.newString(JSON.stringify({ echo: args })));
    return out;
  });
  ctx.setProp(ctx.global, '__rpc', rpc);
  rpc.dispose();

  // 沙箱内门面：插件只看到这个对象
  const boot = `
    globalThis.ctx = Object.freeze({
      db: Object.freeze({
        find: (c, q, o) => __rpc('db.find', { collection: c, where: q, opts: o }),
        insert: (c, d) => __rpc('db.insert', { collection: c, doc: d }),
        raw: (sql) => __rpc('db.raw', { sql }),
      }),
      net: Object.freeze({
        request: (url, init) => __rpc('net.request', { url, init }),
        parseHtml: (html, sel) => __rpc('net.parseHtml', { html, sel }),
      }),
      auth: Object.freeze({ getToken: (id) => __rpc('auth.getToken', { id }) }),
      secrets: Object.freeze({ read: (k) => __rpc('secrets.read', { key: k }) }),
      llm: Object.freeze({ complete: (p) => __rpc('llm.complete', { prompt: p }) }),
      fs: Object.freeze({ read: (p) => __rpc('fs.read', { path: p }) }),
      system: Object.freeze({ exec: (c) => __rpc('system.exec', { cmd: c }) }),
    });
    undefined;
  `;
  const bh = ctx.unwrapResult(ctx.evalCode(boot));
  bh.dispose();

  /** 唯一求值入口：只用 evalCodeAsync */
  const ev = async (code: string): Promise<unknown> => {
    const r: any = await ctx.evalCodeAsync(code);
    const h = r.unwrap ? r.unwrap() : r;
    const v = ctx.dump(h);
    h?.dispose?.();
    return v;
  };

  /** 调用一段可能 await 的表达式，结果经全局哨兵取回 */
  const invoke = async (expr: string) => {
    await ev(`
      globalThis.__R__ = undefined; globalThis.__E__ = undefined;
      Promise.resolve(${expr}).then(
        (v) => { globalThis.__R__ = v; },
        (e) => { globalThis.__E__ = (e && e.message) || String(e); }
      );
      undefined;
    `);
    for (let i = 0; i < 400; i++) {
      ctx.runtime.executePendingJobs();
      if (await ev('globalThis.__R__ !== undefined || globalThis.__E__ !== undefined')) break;
      await tick();
    }
    const err = await ev('globalThis.__E__ === undefined ? null : globalThis.__E__');
    if (err !== null) return { ok: false, error: String(err) };
    return { ok: true, value: await ev('globalThis.__R__') };
  };

  return { mod, runtime, ctx, ev, invoke, audit };
}

const S = await makeSandbox();

// ============================================================ A. 逃逸面

await check('A1 沙箱内不存在任何网络 API', async () => {
  for (const g of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'navigator', 'location']) {
    assert(await S.ev(`typeof ${g}`) === 'undefined', `${g} 竟然存在`);
  }
});

await check('A2 沙箱内不存在任何宿主/Node API', async () => {
  for (const g of ['require', 'process', 'module', 'document', 'window', 'localStorage', 'indexedDB', 'WebAssembly', 'setTimeout', 'setInterval', 'queueMicrotask']) {
    assert(await S.ev(`typeof ${g}`) === 'undefined', `${g} 竟然存在`);
  }
});

await check('A3 Function 构造器无法取回宿主能力', async () => {
  for (const p of ['fetch', 'process', 'require', 'XMLHttpRequest']) {
    const got = await S.ev(`(function(){}).constructor('return typeof ${p}')()`);
    assert(got === 'undefined', `Function 构造器取到了 ${p}`);
  }
});

await check('A4 globalThis 只有纯 ECMAScript 内建 + 我们的注入', async () => {
  const names = String(await S.ev('Object.getOwnPropertyNames(globalThis).sort().join(",")')).split(',');
  const suspicious = names.filter((n) =>
    /fetch|XMLHttp|WebSocket|require|process|document|window|storage|indexedDB|WebAssembly|setTimeout/i.test(n));
  assert(suspicious.length === 0, `可疑全局: ${suspicious.join(', ')}`);
  assert(names.includes('__rpc') && names.includes('ctx'), '注入的门面不见了');
});

await check('A5 动态 import 不可用', async () => {
  const r = await S.invoke(`(async()=>{ try { const m = await import('node:fs'); return 'IMPORTED'; } catch(e){ return 'blocked'; } })()`);
  assert(!String(r.value ?? '').includes('IMPORTED'), `动态 import 竟然成功: ${JSON.stringify(r)}`);
});

await check('A6 eval 存在但作用域内无宿主对象（已知残留，需显式删除）', async () => {
  assert(await S.ev('typeof eval') === 'function', 'eval 不存在');
  assert(await S.ev(`eval('typeof process')`) === 'undefined', 'eval 能取到 process');
});

await check('A7 SharedArrayBuffer 存在（需在 bootstrap 里显式删除）', async () => {
  const t = await S.ev('typeof SharedArrayBuffer');
  assert(t === 'function', `预期存在（记录为待收窄项），实际 ${t}`);
});

// ============================================================ B. 异步 RPC 路径（已证伪，见 s4b）

/**
 * 这里原本有一组「插件侧 await 宿主 RPC」的用例（单次/串行/并发/权限拒绝）。
 * P0 实测结论：**该路径不可靠，已从设计中移除**，因此不再作为测试保留。
 *
 * 实测现象（quickjs-emscripten 0.32.0 / @jitl/quickjs-wasmfile-release-asyncify）：
 *   · 单次 RPC（顶层直接调用 asyncified 函数）           → 可用
 *   · Promise.all 并发多次 RPC（同一 tick 内发起挂起）    → 可用
 *   · 顺序 `await rpc(); await rpc();`                  → **必崩**
 *       报 "memory access out of bounds" / "null function or function signature mismatch"
 *   · ctx.resolvePromise() 即使 promise 已 settle        → 挂死
 *
 * 根因：evalCodeAsync 能驱动「同一 tick 内的多个 asyncify 挂起」，
 *       但无法处理「恢复之后再次挂起」。且 asyncify 状态是 WASM 模块实例级的，
 *       一旦损坏，同实例下所有 runtime 全部报废。
 *
 * 替代方案见 s4b-sync-runtime.test.ts：插件是**纯函数**，沙箱内不存在任何异步宿主 API，
 * 宿主代跑一切 IO。该方案 10/10 通过，且连续 50 次调用稳定。
 */

// ============================================================ C. 资源熔断

await check('C1 插件侧 catch 宿主错误，且拿不到宿主堆栈', async () => {
  const r = await S.invoke(`(async()=>{
    try { await ctx.system.exec('x'); return 'no-throw'; }
    catch(e) { return 'caught:' + e.message; }
  })()`);
  // 当前实现是返回 {ok:false} 而非抛错，这里断言两条路径都不会泄露宿主信息
  assert(r.ok, `调用失败: ${r.error}`);
  assert(!/node_modules|at Object\.|QuickJS/i.test(String(r.value)), `泄露了宿主堆栈: ${r.value}`);
});

await check('C2 死循环被中断熔断', async () => {
  const mod2 = await newQuickJSAsyncWASMModule();
  const rt2 = mod2.newRuntime();
  rt2.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 200));
  const c2: any = rt2.newContext();
  const t0 = Date.now();
  let threw = false;
  try { c2.unwrapResult(c2.evalCode('while(true){}')); } catch { threw = true; }
  const dt = Date.now() - t0;
  assert(threw, '死循环没有被中断');
  assert(dt < 5000, `中断太慢: ${dt}ms`);
  try { c2.dispose(); } catch { /* 异常状态下 dispose 可能抛错，可接受 */ }
  try { rt2.dispose(); } catch { /* 同上 */ }
});

await check('C3 内存上限生效', async () => {
  const mod3 = await newQuickJSAsyncWASMModule();
  const rt3 = mod3.newRuntime();
  rt3.setMemoryLimit(8 * 1024 * 1024);
  const c3: any = rt3.newContext();
  let threw = false;
  try { c3.unwrapResult(c3.evalCode('const a=[]; for(;;) a.push(new Array(1000).fill(1));')); }
  catch { threw = true; }
  assert(threw, '内存没有受限');
  try { c3.dispose(); } catch { /* 同上 */ }
  try { rt3.dispose(); } catch { /* 同上 */ }
});

// ============================================================ D. 已知陷阱（记录为设计约束）

await check('D1 [陷阱] 同步 evalCode 碰到 asyncified 函数会打坏 VM', async () => {
  const mod4 = await newQuickJSAsyncWASMModule();
  const rt4 = mod4.newRuntime();
  const c4: any = rt4.newContext();
  const af = c4.newAsyncifiedFunction('h', async () => c4.newNumber(1));
  c4.setProp(c4.global, 'h', af);
  af.dispose();

  let syncFailed = false;
  try { c4.unwrapResult(c4.evalCode('h()')); } catch { syncFailed = true; }
  assert(syncFailed, '同步 evalCode 竟然成功了 —— 那说明纪律假设有误，需重新评估');

  // 关键：打坏之后，async 路径也不可用了（asyncify 状态是模块实例级的）
  let asyncAlsoFailed = false;
  try { await c4.evalCodeAsync('h()'); } catch { asyncAlsoFailed = true; }
  assert(asyncAlsoFailed, '同步打坏后 async 仍然可用 —— 与探针结论不符');
});

await check('D2 [陷阱] 换新模块实例可恢复（隔离策略依据）', async () => {
  const mod5 = await newQuickJSAsyncWASMModule();
  const rt5 = mod5.newRuntime();
  const c5: any = rt5.newContext();
  const af5 = c5.newAsyncifiedFunction('h', async () => c5.newNumber(9));
  c5.setProp(c5.global, 'h', af5);
  af5.dispose();
  const r: any = await c5.evalCodeAsync('h()');
  const h = r.unwrap();
  assert(c5.dump(h) === 9, '新模块实例不可用');
  h.dispose();
});

// ============================================================ 输出

console.log(`\n通过 ${pass.length} 项：`);
for (const p of pass) console.log('  ✓', p);
if (fail.length) {
  console.log(`\n失败 ${fail.length} 项：`);
  for (const f of fail) console.log('  ✗', f);
  process.exitCode = 1;
} else {
  console.log('\n全部通过。');
}

try { S.ctx.dispose(); } catch { /* 异常状态下的 dispose 可抛错 */ }
try { S.runtime.dispose(); } catch { /* 同上 */ }
process.exit(process.exitCode ?? 0);
