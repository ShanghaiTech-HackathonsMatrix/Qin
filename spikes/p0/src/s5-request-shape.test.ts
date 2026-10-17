/**
 * S5 —— 插件网络请求的形态：把「纸面取舍」变成「实测数字」
 *
 * 背景：S4 证伪了「插件侧 await 宿主 RPC」，D8 因此把插件改成**纯函数 + 声明式请求**，
 * 由宿主代跑一切 IO。设计文档（§5.5）诚实地记了两个代价：
 *   ① 插件无法表达「边解析边决定下一次请求」的隐式控制流
 *   ② 每次跨边界都是一次序列化，大文档有拷贝开销
 * 但「有多大」「有没有别的形态能规避」当时只有定性判断。本 spike 给出定量答案。
 *
 * 三个问题：
 *   A. **同步流式回调可行吗？**
 *      宿主驱动循环、每块调用一次沙箱内的**同步**纯函数。
 *      S4 崩的是 asyncified 调用（沙箱内 await 导致挂起），而同步回调不走 asyncify。
 *      若成立，就能在不碰 asyncify 的前提下拿回增量处理与提前中止。
 *   B. **跨边界调用到底多贵？**
 *      固定开销 + 每字节成本，以及两种编组方式的差距 —— 决定分块大小，
 *      也决定「把整页 HTML 传进沙箱」是否可行。
 *   C. **状态机模型的累计开销是 O(n²) 吗？**
 *      把累积状态留在沙箱内（VM 是持久的）能否避免？
 *
 * 运行：node src/s5-request-shape.test.ts
 */

import { newQuickJSWASMModule, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

const pass: string[] = [];
const fail: string[] = [];
const check = (name: string, fn: () => void) => {
  try { fn(); pass.push(name); }
  catch (e: any) { fail.push(`${name}: ${String(e?.message ?? e).split('\n')[0]}`); }
};
const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };

const mod = await newQuickJSWASMModule();

// ============================================================ 基础设施

interface Vm { ctx: any; runtime: any; audit: string[] }

function makeVm(pluginSource: string): Vm {
  const runtime = mod.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 10_000));
  const ctx: any = runtime.newContext();
  const src = `globalThis.plugin = {}; ${pluginSource} undefined;`;
  const h = ctx.unwrapResult(ctx.evalCode(src, 'plugin.js'));
  h.dispose();
  return { ctx, runtime, audit: [] };
}

/**
 * 缓存函数句柄的调用器 —— 真实宿主会这么做，不会每次重新 evalCode 取函数。
 * 注意：入参用 `evalCode('(' + JSON.stringify(x) + ')')`，这是最朴素的编组方式，
 * 也就是「把 JSON 当 JS 字面量解析」。B2 会拿它跟「传字符串 + 沙箱内 JSON.parse」对比。
 */
function caller(vm: Vm, fnName: string) {
  const fnH = vm.ctx.unwrapResult(vm.ctx.evalCode(fnName));
  return (input: unknown): unknown => {
    const { ctx } = vm;
    const inH = ctx.unwrapResult(ctx.evalCode(`(${JSON.stringify(input ?? null)})`));
    try {
      const res: any = ctx.callFunction(fnH, ctx.undefined, inH);
      const rH = typeof res?.unwrap === 'function' ? res.unwrap() : res;
      const out = ctx.dump(rH);
      rH?.dispose?.();
      try { res?.dispose?.(); } catch { /* unwrap 后可能已消费 */ }
      return out;
    } finally {
      inH.dispose();
    }
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 跑 n 次取中位数（毫秒），先热身 */
function benchMs(n: number, fn: (i: number) => void): number {
  for (let i = 0; i < Math.min(5, n); i += 1) fn(i);
  const runs: number[] = [];
  const reps = 5;
  for (let r = 0; r < reps; r += 1) {
    const t0 = performance.now();
    for (let i = 0; i < n; i += 1) fn(i);
    runs.push(performance.now() - t0);
  }
  return median(runs) / n;
}

const fmtMs = (ms: number) => (ms >= 1 ? `${ms.toFixed(2)}ms` : `${(ms * 1000).toFixed(1)}µs`);
const fmtMBs = (bytes: number, ms: number) => `${(bytes / 1048576 / (ms / 1000)).toFixed(1)} MB/s`;

// ============================================================ A. 同步流式回调

const STREAM_SOURCE = `
  // 同步纯函数：给一块字节，返回一个决策。全程无 Promise、无 await。
  // 状态放在**闭包**里 —— 不能依赖 this：ctx.callFunction 传进去的 this 是 undefined，
  // 非严格模式下会退化成 globalThis，于是 this.head 静默变成 undefined。
  globalThis.plugin = (() => {
    let seen = 0, bytes = 0, head = '';
    return {
      onChunk(chunk) {
        seen += 1;
        bytes += chunk.length;
        if (head.length < 64) head += chunk.slice(0, 64 - head.length);
        // 早期判定：一旦发现不是我们要的格式，立刻要求中止
        const bad = head.includes('<!DOCTYPE html');
        const done = head.includes('"items"') && bytes > 40;
        return { stop: bad || done, reason: bad ? 'html' : (done ? 'enough' : 'more'), bytes, seen };
      },
      stats() { return { seen, bytes, head }; },
    };
  })();
  undefined;
`;

check('A1 同步流式回调：宿主连续调用 3000 次不崩', () => {
  const vm = makeVm(STREAM_SOURCE);
  const onChunk = caller(vm, 'plugin.onChunk');
  let last: any = null;
  for (let i = 0; i < 3000; i += 1) {
    last = onChunk(`x${i};`);
    assert(last && typeof last === 'object', `第 ${i} 次返回非对象`);
  }
  assert(last.seen === 3000, `seen 不对: ${last.seen}`);
  assert(last.bytes > 0, '累计字节数不对');
});

check('A2 早期中止真的能省下后续工作（增量判定生效）', () => {
  const vm = makeVm(STREAM_SOURCE);
  const onChunk = caller(vm, 'plugin.onChunk');
  // 第 1 块就看出是 HTML —— 应当立刻 stop，后面的块不该再被处理
  const first: any = onChunk('<!DOCTYPE html><html>');
  assert(first.stop === true && first.reason === 'html', `未早期中止: ${JSON.stringify(first)}`);
  const seen = vm.ctx.dump(vm.ctx.evalCode('plugin.stats().seen').unwrap());
  assert(seen === 1, `只该处理 1 块，实际 ${seen}`);
});

check('A3 沙箱内状态跨调用存活（VM 是持久的，不必每步重传）', () => {
  const vm = makeVm(STREAM_SOURCE);
  const onChunk = caller(vm, 'plugin.onChunk');
  onChunk('aaa;'); onChunk('bbb;'); onChunk('ccc;');
  const seen = vm.ctx.dump(vm.ctx.evalCode('plugin.stats().seen').unwrap());
  assert(seen === 3, `状态没存活: seen=${seen}`);
});

// ============================================================ B. 编组开销

check('B1 固定调用开销（空载荷）', () => {
  const vm = makeVm('globalThis.plugin = { noop: (x) => 1 }; undefined;');
  const call = caller(vm, 'plugin.noop');
  const ms = benchMs(2000, () => { call(null); });
  // 只报数，不做断言 —— 不同机器差异大，这是参考值
  console.log(`      固定开销 ≈ ${fmtMs(ms)}/次（${Math.round(1 / ms * 1000).toLocaleString()} 次/秒）`);
  assert(ms < 5, `固定开销异常高: ${ms}ms`);
});

check('B2 大载荷编组：JSON 字面量解析 vs 传字符串 + 沙箱内 JSON.parse', () => {
  const SIZE = 1024 * 1024; // 1 MiB
  const bigObj = { items: Array.from({ length: 4000 }, (_, i) => ({ id: i, t: `作业标题 ${i} 带一些中文` })) };
  const jsonStr = JSON.stringify(bigObj);
  const bytes = Buffer.byteLength(jsonStr, 'utf8');

  // 方式一：evalCode('(' + JSON + ')') —— 把 JSON 当 JS 字面量解析
  const vm1 = makeVm('globalThis.plugin = { take: (x) => x.items.length }; undefined;');
  const c1 = caller(vm1, 'plugin.take');
  const ms1 = benchMs(12, () => { c1(bigObj); });

  // 方式二：newString + 沙箱内 JSON.parse —— 只传一个字符串，不做 JS 解析
  const vm2 = makeVm('globalThis.plugin = { take: (s) => JSON.parse(s).items.length }; undefined;');
  const fn2 = vm2.ctx.unwrapResult(vm2.ctx.evalCode('plugin.take'));
  const callStr = (s: string) => {
    const { ctx } = vm2;
    const h = ctx.newString(s);
    try {
      const res: any = ctx.callFunction(fn2, ctx.undefined, h);
      const rH = typeof res?.unwrap === 'function' ? res.unwrap() : res;
      const out = ctx.dump(rH);
      rH?.dispose?.();
      try { res?.dispose?.(); } catch { /* noop */ }
      return out;
    } finally { h.dispose(); }
  };
  const ms2 = benchMs(12, () => { callStr(jsonStr); });

  console.log(`      载荷 ${(bytes / 1048576).toFixed(2)} MiB`);
  console.log(`      ① evalCode(JSON字面量) : ${fmtMs(ms1)}/次  ${fmtMBs(bytes, ms1)}`);
  console.log(`      ② newString + JSON.parse: ${fmtMs(ms2)}/次  ${fmtMBs(bytes, ms2)}`);
  console.log(`      ② 比 ① 快 ${(ms1 / ms2).toFixed(2)}×`);

  assert(callStr(jsonStr) === 4000, '方式二结果不对');
  assert(c1(bigObj) === 4000, '方式一结果不对');
});

check('B3 开销随载荷是否线性（固定开销占比）', () => {
  const vm = makeVm('globalThis.plugin = { len: (s) => s.length }; undefined;');
  const fn = vm.ctx.unwrapResult(vm.ctx.evalCode('plugin.len'));
  const callStr = (s: string) => {
    const { ctx } = vm;
    const h = ctx.newString(s);
    try {
      const res: any = ctx.callFunction(fn, ctx.undefined, h);
      const rH = typeof res?.unwrap === 'function' ? res.unwrap() : res;
      const out = ctx.dump(rH);
      rH?.dispose?.();
      try { res?.dispose?.(); } catch { /* noop */ }
      return out;
    } finally { h.dispose(); }
  };
  const sizes = [0, 1024, 64 * 1024, 512 * 1024, 2 * 1024 * 1024];
  const out: string[] = [];
  for (const n of sizes) {
    const s = 'a'.repeat(n);
    const ms = benchMs(n > 512 * 1024 ? 8 : 40, () => { callStr(s); });
    out.push(`${(n / 1024).toFixed(0).padStart(6)} KiB → ${fmtMs(ms).padStart(9)}  ${n > 0 ? fmtMBs(n, ms) : ''}`);
  }
  console.log('      载荷 → 每次调用耗时 / 吞吐');
  for (const line of out) console.log(`        ${line}`);
});

// ============================================================ C. 状态机累计开销

check('C1 状态跨边界 vs 状态留沙箱：累计开销对比', () => {
  // 模型一：每步把累积数组传进去、传出来（声明式状态机的朴素写法）
  const vmA = makeVm('globalThis.plugin = { step: (st) => { st.acc.push({ id: st.acc.length, t: "第" + st.acc.length + "条" }); return st; } }; undefined;');
  const callA = caller(vmA, 'plugin.step');

  // 模型二：累积状态留在沙箱内，每步只回传一个小摘要
  const vmB = makeVm('globalThis.plugin = { acc: [], step: () => { globalThis.plugin.acc.push({ id: globalThis.plugin.acc.length }); return { n: globalThis.plugin.acc.length }; } }; undefined;');
  const callB = caller(vmB, 'plugin.step');

  const rows: string[] = [];
  for (const N of [20, 100, 400]) {
    const t0 = performance.now();
    let st: any = { acc: [] };
    for (let i = 0; i < N; i += 1) st = callA(st);
    const msA = performance.now() - t0;

    const t1 = performance.now();
    for (let i = 0; i < N; i += 1) callB(null);
    const msB = performance.now() - t1;

    rows.push(`${String(N).padStart(4)} 步 → 状态跨边界 ${fmtMs(msA / N).padStart(9)}/步（合计 ${msA.toFixed(1)}ms）   状态留沙箱 ${fmtMs(msB / N).padStart(9)}/步（合计 ${msB.toFixed(1)}ms）`);
  }
  console.log('      C. 累计状态的开销');
  for (const r of rows) console.log(`        ${r}`);
  console.log('      判读：若「跨边界」那列的单步耗时随 N 明显上升，即为 O(n²)；');
  console.log('            「留沙箱」那列应当基本恒定。');
});

check('C2 同步回调不引入 asyncify：之后仍可正常调用（无全局污染）', () => {
  const vm = makeVm(STREAM_SOURCE);
  const onChunk = caller(vm, 'plugin.onChunk');
  for (let i = 0; i < 500; i += 1) onChunk('x;');
  // 再来一个完全独立的调用，验证模块级 asyncify 状态没被打坏
  const vm2 = makeVm('globalThis.plugin = { f: (x) => ({ ok: x }) }; undefined;');
  const f = caller(vm2, 'plugin.f');
  assert((f(1) as any).ok === 1, '后续调用失败');
  assert((f(2) as any).ok === 2, '后续调用第二次失败');
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
