/**
 * 内核 —— 同步 broker：宿主驱动的状态机（DESIGN.md §5.5 第 331–340 行的流程）
 *
 * 这是 D8 的落地处。插件**不碰网络**，只产出请求描述；宿主代跑一切 IO。
 *
 * ```
 * 1. 宿主调 plugin.plan(input)                        → { requests: [...] }
 * 2. 宿主校验每个 url 落在插件的域名白名单内            → 不在则 ENETDENIED
 * 3. 宿主发起网络请求（全应用唯一的网络出口）
 * 4. 宿主调 plugin.parsers[name]({ body, status, baseUrl })
 * 5. 宿主取回结果落库 / 广播 dataBus
 * 6. 若返回 StepDirective，回到第 2 步；超过 maxSteps 则 ETIMEOUT
 * ```
 *
 * **为什么不把累积状态传进传出**（S5 实测，见 spikes/p0/REPORT.md §5.3）：
 * 让状态每步跨边界往返会让单步耗时随步数线性上升，合计 O(n²) ——
 * 400 步时 1.04 ms/步，而状态留在插件模块作用域里只要 19.0 µs/步，差 54.7×。
 * 所以本 broker 每次只传**当次的增量**（一个 `ParseResult`），
 * 并把跨边界字节数记进报告，让这条风险**可观测**而不是靠人自觉。
 *
 * ⚠️ **关于「插件是纯函数」的一个诚实限定**：
 * 沙箱实例在多次调用之间是**存活**的（实测连续 3000 次调用后状态完好），
 * 所以插件可以在模块作用域里存累积状态。严格说它不是数学意义的纯函数，
 * 而是「**同步、无副作用外泄、IO 全部经宿主**」的函数。
 * 文档里说「纯函数」是简称；准确的说法是「宿主驱动的同步状态机」。
 */

import {
  DEFAULT_MAX_STEPS,
  matchDomainPattern,
  parsePluginTarget,
  type ParsedEntity,
  type ParseResult,
  type PlanInput,
  type PlannedRequest,
  type PluginExports,
  type PluginResult,
  fail,
  ok,
} from '@matrix/plugin-api';

import { byteLen } from './bytes.ts';

// ------------------------------------------------------------ 宿主侧依赖

export interface BrokerResponse {
  status: number;
  body: string;
  /** 实际落地的 URL（重定向后） */
  url: string;
}

export interface BrokerFetchContext {
  pluginId: string;
  requestId: string;
  /** 宿主应当用哪个会话。凭证由宿主持有，插件永远看不到 */
  session?: string;
}

export interface BrokerAuditEntry {
  at: number;
  pluginId: string;
  action: 'sync.request' | 'sync.denied' | 'sync.done' | 'sync.failed';
  url?: string;
  host?: string;
  status?: number;
  detail?: string;
}

export interface BrokerDeps {
  /**
   * 宿主唯一的网络出口。实现上应当适配核心层的 `NetGateway`，
   * 把 `PlannedRequest` 翻成 `NetRequest` 并出示能力令牌。
   */
  fetch(req: PlannedRequest, ctx: BrokerFetchContext): Promise<PluginResult<BrokerResponse>>;
  /** 该插件被授予的域名白名单 */
  domainsFor(pluginId: string): readonly string[];
  /** 落库 —— 通常是 DataBus.emit 的包装 */
  emit(pluginId: string, entity: ParsedEntity): PluginResult<unknown>;
  maxSteps?: number;
  /** 单轮最多几个请求（防一个 plan 里塞一万条） */
  maxRequestsPerRound?: number;
  /** 单次响应体上限 */
  maxBodyBytes?: number;
  now?: () => number;
  audit?: (e: BrokerAuditEntry) => void;
}

export interface SyncReport {
  pluginId: string;
  /** 实际跑了几轮 */
  steps: number;
  requests: number;
  entities: number;
  /** 被 emit 拒绝的实体数（配额 / schema） */
  rejectedEntities: number;
  summaries: string[];
  errors: string[];
  /**
   * 跨沙箱边界传输的字节数（请求描述 + 响应体 + 解析结果）。
   * 观测用：如果它随步数超线性增长，说明插件在用朴素的状态机写法。
   */
  boundaryBytes: number;
  durationMs: number;
  /**
   * 本轮结束时的游标（本轮**最后一个**非空值）。
   *
   * 宿主存下来，下次 `sync()` 时填进 `PlanInput.cursor` —— 分页 / 增量同步
   * 才能跨轮延续。多请求的一轮里以最后一个为准：契约只给了**一个**游标位。
   *
   * ⚠️ 目前只有**进程内**持久化（宿主的一个 Map），重启即失 ——
   * 与信任记录是同一个缺口。
   */
  cursor?: string;
}

// ------------------------------------------------------------ 校验

export interface PlanIssue {
  index: number;
  field: string;
  message: string;
}

/** 校验 plan / directive 里的 requests 形状 */
export function validateRequests(raw: unknown): PlanIssue[] {
  const issues: PlanIssue[] = [];
  if (!Array.isArray(raw)) {
    return [{ index: -1, field: 'requests', message: 'requests 必须是数组' }];
  }
  const seen = new Set<string>();
  raw.forEach((r, i) => {
    if (typeof r !== 'object' || r === null) {
      issues.push({ index: i, field: '', message: '请求必须是对象' });
      return;
    }
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string' || o.id === '') issues.push({ index: i, field: 'id', message: 'id 必须是非空字符串' });
    else if (seen.has(o.id)) issues.push({ index: i, field: 'id', message: `id 重复: ${o.id}` });
    else seen.add(o.id);

    if (o.method !== 'GET' && o.method !== 'POST') {
      issues.push({ index: i, field: 'method', message: 'method 只能是 GET 或 POST' });
    }
    if (typeof o.url !== 'string' || o.url === '') issues.push({ index: i, field: 'url', message: 'url 必须是非空字符串' });
    if (typeof o.parse !== 'string' || o.parse === '') {
      issues.push({ index: i, field: 'parse', message: 'parse 必须给出 parser 名' });
    }
    if (o.headers !== undefined) {
      if (typeof o.headers !== 'object' || o.headers === null || Array.isArray(o.headers)) {
        issues.push({ index: i, field: 'headers', message: 'headers 必须是对象' });
      }
    }
    if (o.body !== undefined && typeof o.body !== 'string') {
      issues.push({ index: i, field: 'body', message: 'body 必须是字符串' });
    }
    // 不查这一项的话，`source: 'nett'` 会静默退化成 `'net'`：
    //   · 打在**已授权**的 URL 上 → 当作网络请求正常发出，**拼写错误无人发现**
    //   · 打在未授权的 URL 上 → 以 ENETDENIED 报出来，把用户指向「域名不在白名单」
    //     这个错误方向
    // 两条都与本函数存在的目的（尽早 ESCHEMA、把错误指到正确位置）相悖。
    if (o.source !== undefined && o.source !== 'net' && o.source !== 'host') {
      issues.push({ index: i, field: 'source', message: "source 只能是 'net' 或 'host'" });
    }
  });
  return issues;
}

// ------------------------------------------------------------ Broker

export class SyncBroker {
  private readonly deps: BrokerDeps;
  private readonly maxSteps: number;
  private readonly maxRequestsPerRound: number;
  private readonly maxBodyBytes: number;
  private readonly clock: () => number;

  constructor(deps: BrokerDeps) {
    this.deps = deps;
    this.maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
    this.maxRequestsPerRound = deps.maxRequestsPerRound ?? 32;
    this.maxBodyBytes = deps.maxBodyBytes ?? 5 * 1024 * 1024;
    this.clock = deps.now ?? (() => Date.now());
  }

  /**
   * 跑一次完整同步。
   *
   * 全程不抛异常 —— 插件抛错、返回垃圾、超步数，都变成 `PluginFailure`。
   * 这是沙箱边界的基本要求：一个坏插件不能让宿主崩，也不能把宿主堆栈带出去。
   */
  async run(
    pluginId: string,
    exports: PluginExports,
    input: PlanInput,
  ): Promise<PluginResult<SyncReport>> {
    const started = this.clock();
    const report: SyncReport = {
      pluginId,
      steps: 0,
      requests: 0,
      entities: 0,
      rejectedEntities: 0,
      summaries: [],
      errors: [],
      boundaryBytes: 0,
      durationMs: 0,
    };

    /** 本轮最后一个非空游标。契约只给一个游标位，多请求的一轮里以最后一个为准。 */
    let lastCursor: string | undefined;

    if (typeof exports.plan !== 'function') {
      return fail('ENOTFOUND', `插件 ${pluginId} 没有导出 plan()`);
    }
    if (exports.parsers === undefined || typeof exports.parsers !== 'object') {
      return fail('ENOTFOUND', `插件 ${pluginId} 没有导出 parsers`);
    }

    const domains = this.deps.domainsFor(pluginId);

    // ---- 第 1 步：plan()
    report.boundaryBytes += byteLen(JSON.stringify(input));
    const planned = this.callPlugin(pluginId, 'plan', () => exports.plan!(input));
    if (!planned.ok) return planned;

    const planObj = planned.data as { requests?: unknown } | null;
    if (typeof planObj !== 'object' || planObj === null) {
      return fail('ESCHEMA', `插件 ${pluginId} 的 plan() 没有返回对象`);
    }
    const firstIssues = validateRequests(planObj.requests);
    if (firstIssues.length > 0) {
      return fail('ESCHEMA', `插件 ${pluginId} 的 plan() 返回的 requests 不合法`, {
        issues: firstIssues.map((i) => `[${i.index}].${i.field}: ${i.message}`),
      });
    }

    report.boundaryBytes += byteLen(JSON.stringify(planObj.requests));
    let pending = planObj.requests as PlannedRequest[];

    // ---- 第 1.5 步：plan() 直接产出的实体（无需任何 IO 的纯计算形态）
    //
    // 为什么必须有这一步：`bus.emit` 是插件写入数据的**唯一**通路，而它挂在下面的
    // 请求循环里。于是一个不发请求的 `kind: 'logic'` 插件永远产不出数据 ——
    // 更糟的是 `run()` 会返回 `ok`，**静默**什么都不做。
    //
    // 需要文档时不要用它，走 requests + parsers。
    const planExtras = planObj as { entities?: unknown; summary?: unknown; cursor?: unknown };
    if (planExtras.entities !== undefined) {
      if (!Array.isArray(planExtras.entities)) {
        return fail('ESCHEMA', `插件 ${pluginId} 的 plan().entities 不是数组`);
      }
      report.boundaryBytes += byteLen(JSON.stringify(planExtras.entities));
      this.emitEntities(pluginId, planExtras.entities, report);
    }
    if (typeof planExtras.summary === 'string' && planExtras.summary !== '') {
      report.summaries.push(planExtras.summary);
    }
    if (typeof planExtras.cursor === 'string' && planExtras.cursor !== '') {
      lastCursor = planExtras.cursor;
    }

    // ---- 循环：第 2–6 步
    while (pending.length > 0) {
      report.steps += 1;

      if (report.steps > this.maxSteps) {
        this.deps.audit?.({
          at: this.clock(), pluginId, action: 'sync.failed',
          detail: `超过 maxSteps=${this.maxSteps}`,
        });
        return fail('ETIMEOUT', `同步步数超过上限 ${this.maxSteps}`, {
          steps: report.steps,
          maxSteps: this.maxSteps,
        });
      }
      if (pending.length > this.maxRequestsPerRound) {
        return fail('EQUOTA', `单轮请求数 ${pending.length} 超过上限 ${this.maxRequestsPerRound}`, {
          maxRequestsPerRound: this.maxRequestsPerRound,
        });
      }

      // 第 2 步：逐个校验 URL —— 这是插件唯一能发起出网的地方，必须逐条过。
      //
      // 例外：`source: 'host'` 的请求**根本不出网**，由宿主自行满足（本地导入）。
      // 对它做 URL / 域名白名单校验没有意义 —— 但 `url` 仍是必填的，
      // 因为宿主拿它当查找键（`host://import` 这样的**不透明键**，不是文件路径）。
      // 真正的隔离在宿主侧按 (pluginId, url) 分键，不在这一层。
      const authorized: Array<{ req: PlannedRequest; host: string }> = [];
      for (const req of pending) {
        if (req.source === 'host') {
          if (typeof req.url !== 'string' || req.url === '') {
            return fail('ESCHEMA', `请求 ${req.id} 声明了 source: 'host' 但没有 url`, { requestId: req.id });
          }
          authorized.push({ req, host: '(local)' });
          continue;
        }
        const target = parsePluginTarget(req.url);
        if (!target.ok) {
          this.deps.audit?.({
            at: this.clock(), pluginId, action: 'sync.denied',
            detail: `${req.id}: ${target.message}`,
          });
          return fail('ENETDENIED', `请求 ${req.id} 的 URL 不合法: ${target.message}`, { requestId: req.id });
        }
        if (!matchDomainPattern(target.data.host, domains)) {
          this.deps.audit?.({
            at: this.clock(), pluginId, action: 'sync.denied', host: target.data.host,
            detail: `不在插件的域名白名单内`,
          });
          return fail('ENETDENIED', `请求 ${req.id} 的主机不在插件的域名白名单内: ${target.data.host}`, {
            requestId: req.id,
            host: target.data.host,
          });
        }
        authorized.push({ req, host: target.data.host });
      }

      // 第 3 步：发请求（宿主唯一的出网点）
      const pairs: Array<{ req: PlannedRequest; res: BrokerResponse }> = [];
      const failures: Array<{ req: PlannedRequest; code: string; message: string }> = [];
      for (const { req, host } of authorized) {
        this.deps.audit?.({
          at: this.clock(), pluginId, action: 'sync.request', url: req.url, host,
        });
        report.requests += 1;
        report.boundaryBytes += byteLen(req.url) + byteLen(req.body ?? '');

        const res = await this.deps.fetch(req, { pluginId, requestId: req.id });
        if (!res.ok) {
          // 单个请求失败不终止整个同步：把原因记进报告，稍后照样问插件下一步
          report.errors.push(`${req.id}: ${res.code} ${res.message}`);
          failures.push({ req, code: res.code, message: res.message });
          this.deps.audit?.({
            at: this.clock(), pluginId, action: 'sync.failed', url: req.url,
            detail: `${res.code}: ${res.message}`,
          });
          continue;
        }
        if (byteLen(res.data.body) > this.maxBodyBytes) {
          return fail('ETOOBIG', `请求 ${req.id} 的响应体超过上限 ${this.maxBodyBytes} 字节`, {
            requestId: req.id,
            bytes: byteLen(res.data.body),
          });
        }
        report.boundaryBytes += byteLen(res.data.body);
        pairs.push({ req, res: res.data });
      }

      // 第 4–6 步：解析 → 落库 → 问下一步
      const nextRound: PlannedRequest[] = [];
      /*
        问插件下一步。**失败的请求也必须问** —— 这一条是踩出来的。

        学术连接器是「一轮一页」的串行扫描器：它靠 `next()` 从自己的队列里
        取下一页。原来 `next()` 只在解析成功的分支里被调用，于是某一页请求
        失败后，队列里剩下的页面再也没人问起，整轮扫描在第 155 页悄悄停住，
        `finish()` 从没跑过，一个实体都没落 —— 而报告里只有一条被当成
        「可容忍」的传输错误。用户看到的就是「本次未得到有效数据」。

        「单个请求失败不终止整个同步」这句话，只有在这里才真的成立。
      */
      const askNext = (
        req: PlannedRequest, result: ParseResult, status: number,
      ): PluginResult<SyncReport> | undefined => {
        if (typeof exports.next !== 'function') return undefined;
        const dir = this.callPlugin(pluginId, 'next', () =>
          exports.next!({ step: req.parse, result, status }),
        );
        if (!dir.ok) return dir;
        if (dir.data === null || dir.data === undefined) return undefined;

        const d = dir.data as { next?: unknown; requests?: unknown };
        if (typeof d.next !== 'string' || d.next === '') {
          return fail('ESCHEMA', 'next() 返回的 directive 缺少 next 步骤名');
        }
        const dirIssues = validateRequests(d.requests);
        if (dirIssues.length > 0) {
          return fail('ESCHEMA', `next() 返回的 requests 不合法`, {
            issues: dirIssues.map((i) => `[${i.index}].${i.field}: ${i.message}`),
          });
        }
        report.boundaryBytes += byteLen(JSON.stringify(d.requests));
        nextRound.push(...(d.requests as PlannedRequest[]));
        return undefined;
      };
      for (const { req, res } of pairs) {
        const parser = (exports.parsers as Record<string, unknown>)[req.parse];
        if (typeof parser !== 'function') {
          return fail('ENOTFOUND', `请求 ${req.id} 引用了不存在的 parser: "${req.parse}"`, {
            requestId: req.id,
            parser: req.parse,
            available: Object.keys(exports.parsers),
          });
        }

        // credentials 永不进沙箱 —— 传进去的对象里只有这三样
        const parsed = this.callPlugin(pluginId, `parsers.${req.parse}`, () =>
          (parser as (i: unknown) => ParseResult)({
            body: res.body,
            status: res.status,
            baseUrl: res.url,
          }),
        );
        if (!parsed.ok) return parsed;

        const result = parsed.data as ParseResult | null;
        if (typeof result !== 'object' || result === null) {
          return fail('ESCHEMA', `parser "${req.parse}" 没有返回对象`, { parser: req.parse });
        }
        report.boundaryBytes += byteLen(JSON.stringify(result));

        if (typeof result.summary === 'string' && result.summary !== '') {
          report.summaries.push(result.summary);
        }
        if (typeof result.error === 'string' && result.error !== '') {
          report.errors.push(`${req.id}: ${result.error}`);
        }
        // 游标以前是**死字段** —— 从来没被读过，于是 `PlanInput.cursor` 永远填不上，
        // 分页永远不续上，而且不报错。现在在这里收口。
        if (typeof result.cursor === 'string' && result.cursor !== '') lastCursor = result.cursor;

        this.emitEntities(pluginId, result.entities ?? [], report);

        // 第 6 步：问插件下一步
        const bad = askNext(req, result, res.status);
        if (bad) return bad;
      }

      // 没回来的页面同样要问下一步，否则串行扫描器会在这里断掉（见 askNext 上方）。
      // 传进去的 result 是明确的失败形状，插件可以据此决定跳过还是重试。
      for (const f of failures) {
        const bad = askNext(f.req, { error: `${f.code} ${f.message}` }, 0);
        if (bad) return bad;
      }

      pending = nextRound;
    }

    if (lastCursor !== undefined) report.cursor = lastCursor;
    report.durationMs = this.clock() - started;
    this.deps.audit?.({
      at: this.clock(), pluginId, action: 'sync.done',
      detail: `steps=${report.steps} requests=${report.requests} entities=${report.entities}`,
    });
    return ok(report);
  }

  /**
   * 落一批实体，把结果记进报告。
   *
   * `plan().entities` 与 `parsers` 的产出**共用这一段** ——
   * 两处各写一份的话，配额统计或错误记录迟早会分叉。
   */
  private emitEntities(pluginId: string, entities: readonly unknown[], report: SyncReport): void {
    for (const raw of entities) {
      const e = this.deps.emit(pluginId, raw as ParsedEntity);
      if (e.ok) {
        report.entities += 1;
      } else {
        report.rejectedEntities += 1;
        const label = (raw as { type?: unknown })?.type;
        report.errors.push(`实体 ${typeof label === 'string' ? label : '(未知类型)'}: ${e.code} ${e.message}`);
      }
    }
  }

  /**
   * 调一次插件导出，把任何抛出物转成 `PluginFailure`。
   *
   * 沙箱边界上**绝不能**让插件的异常直接冒泡到宿主 ——
   * 那既会让宿主崩，也可能把宿主对象顺着异常带进沙箱（S4 已实测这类风险）。
   */
  private callPlugin<T>(
    pluginId: string,
    what: string,
    fn: () => T,
  ): PluginResult<T> {
    try {
      const value = fn();
      // 插件返回 Promise 是违约（沙箱内不存在异步宿主 API）。
      // 这里显式拒绝，而不是「等它」—— 因为 asyncify 那条路已被证伪。
      if (value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function') {
        return fail('ESCHEMA', `插件 ${pluginId} 的 ${what}() 返回了 Promise —— 契约要求全程同步`, { pluginId });
      }
      return ok(value);
    } catch (e) {
      return fail('EINTERNAL', `插件 ${pluginId} 的 ${what}() 抛出异常: ${e instanceof Error ? e.message : String(e)}`, {
        pluginId,
      });
    }
  }
}
