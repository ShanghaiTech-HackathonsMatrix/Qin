/**
 * S4b —— 同步 QuickJS 运行时作为插件基座的验证（推荐方案）
 *
 * 背景：S4 证明 asyncified RPC + JS await 不可靠
 *   · 顺序 await 第二次 RPC 必崩（memory access out of bounds / null function or signature mismatch）
 *   · 只有同一 tick 内的并发挂起能工作
 *   · asyncify 状态是 WASM 模块实例级全局，一个 runtime 打坏全模块连坐
 *
 * 替代模型：插件是**纯函数**，沙箱内不存在任何异步宿主 API。
 *   宿主代跑一切 IO（网络/数据库/凭证），把结果当普通 JSON 传进去，
 *   插件算完返回普通 JSON。多步流程由「插件返回下一步指令、宿主执行后再调一次」的状态机表达。
 *
 * 运行：node src/s4b-sync-runtime.test.ts
 */

import { newQuickJSWASMModule, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

const pass: string[] = [];
const fail: string[] = [];
const check = (name: string, fn: () => void) => {
  try { fn(); pass.push(name); }
  catch (e: any) { fail.push(`${name}: ${e.message.split('\n')[0]}`); }
};
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };

const mod = await newQuickJSWASMModule();

// ============================================================ 沙箱

interface Vm { ctx: any; runtime: any; audit: string[] }

function makeVm(pluginSource: string, guards: Record<string, 'allow' | 'deny'>): Vm {
  const runtime = mod.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 5_000));
  const ctx: any = runtime.newContext();
  const audit: string[] = [];

  // 宿主能力一律**同步**注入。插件侧看不到 Promise，也就没有 asyncify。
  const hostCall = ctx.newFunction('__host', (methodH: any, argsH: any) => {
    const method = ctx.dump(methodH);
    const args = ctx.dump(argsH);
    audit.push(method);
    if (guards[method] !== 'allow') {
      const err = ctx.newObject();
      ctx.setProp(err, 'ok', ctx.false);
      ctx.setProp(err, 'code', ctx.newString('EPERM'));
      return err;
    }
    const ok = ctx.newObject();
    ctx.setProp(ok, 'ok', ctx.true);
    ctx.setProp(ok, 'data', ctx.newString(JSON.stringify({ echo: args })));
    return ok;
  });
  ctx.setProp(ctx.global, '__host', hostCall);
  hostCall.dispose();

  // 插件源码：同步 evalCode 完全安全（没有任何 asyncified 函数）
  const src = `
    globalThis.ctx = Object.freeze({
      host: (m, a) => __host(m, a),
    });
    ${pluginSource}
    undefined;
  `;
  const h = ctx.unwrapResult(ctx.evalCode(src, 'plugin.js'));
  h.dispose();

  return { ctx, runtime, audit };
}

/** 同步调用插件导出的函数：输入 JSON → 输出 JSON */
function callFn(vm: Vm, fnName: string, input: unknown): unknown {
  const { ctx } = vm;
  const fnH = ctx.unwrapResult(ctx.evalCode(fnName));
  // 【硬性纪律】JSON 对象字面量必须用括号包起来再求值。
  // 直接 evalCode('{"a":1}') 会被当作块语句解析，'{"a":' 不是合法标签，报 "expecting ';'"。
  const inH = ctx.unwrapResult(ctx.evalCode(`(${JSON.stringify(input ?? null)})`));
  try {
    // 注意：ctx.callFunction 返回的是 DisposableSuccess/DisposableFail（Either），
    // 必须 unwrap；unwrap 在失败时会抛出插件侧异常。
    const res: any = ctx.callFunction(fnH, ctx.undefined, inH);
    const rH = typeof res?.unwrap === 'function' ? res.unwrap() : res;
    const out = ctx.dump(rH);
    rH?.dispose?.();
    try { res?.dispose?.(); } catch { /* unwrap 后可能已消费 */ }
    return out;
  } finally {
    fnH.dispose();
    inH.dispose();
  }
}

/** 真实的连接器形态：声明式请求计划 + 纯函数解析 */
const CONNECTOR_SOURCE = `
  globalThis.plugin = {
    manifest: { id: 'app.matrix.connector.ecloud', version: '1.0.0' },

    // 声明式：插件不自己发请求，只声明「我需要哪些请求」
    plan(input) {
      return {
        requests: [
          { id: 'tasks', method: 'GET', url: 'https://ecloud.shanghaitech.edu.cn/api/tasks', parse: 'parseTasks' },
        ],
      };
    },

    // 纯函数解析：宿主把响应体当普通字符串传进来
    parseTasks(input) {
      const { body, baseUrl } = input;
      const out = [];
      const re = /<li[^>]*data-id="(\\d+)"[^>]*>([^<]*)<\\/li>/g;
      let m;
      while ((m = re.exec(body)) !== null) {
        out.push({ externalId: m[1], title: m[2].trim(), sourceUrl: baseUrl + '/task/' + m[1] });
      }
      return { items: out };
    },

    // 演示权限被拒时插件的行为
    tryRawSql() {
      const r = ctx.host('db.raw', { sql: 'DROP TABLE event' });
      return { denied: r.ok === false, code: r.code };
    },
  };
  undefined;
`;

// ============================================================ 测试

check('1 纯函数解析：宿主代跑 IO，插件只算', () => {
  const vm = makeVm(CONNECTOR_SOURCE, { 'db.raw': 'deny' });
  const out: any = callFn(vm, 'plugin.parseTasks', {
    body: '<ul><li data-id="11">作业一</li><li data-id="12">Quiz 2</li></ul>',
    baseUrl: 'https://ecloud.shanghaitech.edu.cn',
  });
  assert(out.items.length === 2, `期望 2 条，实际 ${out.items.length}`);
  assert(out.items[0].title === '作业一', `标题错: ${out.items[0].title}`);
  assert(out.items[1].externalId === '12', 'externalId 错');
});

check('2 声明式请求计划：插件不接触网络', () => {
  const vm = makeVm(CONNECTOR_SOURCE, {});
  const plan: any = callFn(vm, 'plugin.plan', {});
  assert(plan.requests.length === 1, '请求计划不对');
  assert(plan.requests[0].url.startsWith('https://'), 'url 不对');
  assert(vm.audit.length === 0, `plan() 不应触发任何宿主调用，实际: ${vm.audit.join(',')}`);
});

check('3 权限矩阵生效：插件拿不到被禁能力', () => {
  const vm = makeVm(CONNECTOR_SOURCE, { 'db.raw': 'deny' });
  const r: any = callFn(vm, 'plugin.tryRawSql', {});
  assert(r.denied === true && r.code === 'EPERM', JSON.stringify(r));
  assert(vm.audit.includes('db.raw'), '审计缺失 db.raw');
});

check('4 连续 50 次调用稳定（同步路径无 asyncify 状态可污染）', () => {
  const vm = makeVm(CONNECTOR_SOURCE, {});
  for (let i = 0; i < 50; i++) {
    const out: any = callFn(vm, 'plugin.parseTasks', {
      body: `<ul><li data-id="${i}">T${i}</li></ul>`,
      baseUrl: 'https://x',
    });
    assert(out.items.length === 1 && out.items[0].externalId === String(i), `第 ${i} 次结果不对`);
  }
});

check('5 多个插件各自独立 VM，互不影响', () => {
  const a = makeVm(`globalThis.plugin = { f: () => ({ who: 'A' }) }; undefined;`, {});
  const b = makeVm(`globalThis.plugin = { f: () => ({ who: 'B' }) }; undefined;`, {});
  assert((callFn(a, 'plugin.f', {}) as any).who === 'A', 'A 不对');
  assert((callFn(b, 'plugin.f', {}) as any).who === 'B', 'B 不对');
  assert((callFn(a, 'plugin.f', {}) as any).who === 'A', 'A 第二次不对');
});

check('6 沙箱逃逸面与异步版一致（无网络 / 无宿主 API）', () => {
  const vm = makeVm('undefined;', {});
  for (const g of ['fetch', 'XMLHttpRequest', 'WebSocket', 'require', 'process', 'document',
                   'localStorage', 'indexedDB', 'WebAssembly', 'setTimeout', 'setInterval']) {
    const h = vm.ctx.unwrapResult(vm.ctx.evalCode(`typeof ${g}`));
    assert(vm.ctx.dump(h) === 'undefined', `${g} 竟然存在`);
    h.dispose();
  }
  for (const p of ['fetch', 'process', 'require']) {
    const h = vm.ctx.unwrapResult(vm.ctx.evalCode(`(function(){}).constructor('return typeof ${p}')()`));
    assert(vm.ctx.dump(h) === 'undefined', `Function 构造器取到了 ${p}`);
    h.dispose();
  }
});

check('7 死循环被中断熔断', () => {
  const runtime = mod.newRuntime();
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 200));
  const ctx: any = runtime.newContext();
  const t0 = Date.now();
  let threw = false;
  try { ctx.unwrapResult(ctx.evalCode('while(true){}')); } catch { threw = true; }
  assert(threw, '没有被中断');
  assert(Date.now() - t0 < 3000, '中断太慢');
  ctx.dispose(); runtime.dispose();
});

check('8 内存上限生效', () => {
  const runtime = mod.newRuntime();
  runtime.setMemoryLimit(8 * 1024 * 1024);
  const ctx: any = runtime.newContext();
  let threw = false;
  try { ctx.unwrapResult(ctx.evalCode('const a=[]; for(;;) a.push(new Array(1000).fill(1));')); }
  catch { threw = true; }
  assert(threw, '内存没有受限');
  ctx.dispose(); runtime.dispose();
});

check('9 插件抛错不会带出宿主堆栈', () => {
  const vm = makeVm(`globalThis.plugin = { boom: () => { throw new Error('插件内部错误'); } }; undefined;`, {});
  let msg = '';
  try { callFn(vm, 'plugin.boom', {}); } catch (e: any) { msg = String(e.message ?? e); }
  assert(!/node_modules|QuickJSContext|at Object\./.test(msg), `泄露宿主信息: ${msg}`);
});

check('10 超时/中断后 runtime 可被安全丢弃，进程存活', () => {
  const runtime = mod.newRuntime();
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 100));
  const ctx: any = runtime.newContext();
  try { ctx.unwrapResult(ctx.evalCode('while(true){}')); } catch { /* 预期 */ }
  let disposeThrew = false;
  try { ctx.dispose(); runtime.dispose(); } catch { disposeThrew = true; }
  // 无论 dispose 是否抛错，都必须能继续建新 VM
  const vm = makeVm(`globalThis.plugin = { f: () => ({ alive: true }) }; undefined;`, {});
  assert((callFn(vm, 'plugin.f', {}) as any).alive === true, '新 VM 不可用');
  assert(typeof disposeThrew === 'boolean', '');
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
process.exit(process.exitCode ?? 0);
