/**
 * 网络网关（DESIGN.md §8.1）。
 *
 * 这是整个系统**唯一**允许出网的地方。顺序严格如下，任何一步不过就拒绝并审计：
 *
 *   能力令牌 → URL 校验 → 白名单 → 限流 → 会话注入 → 发出
 *   → 逐跳复检（最多 N 跳）→ 大小上限 → 剥离 Set-Cookie → 审计 → 返回
 *
 * 两个容易做错的地方，这里刻意处理了：
 *
 *  1. **跳转必须逐跳复检。** 只校验初始 URL 是不够的 —— 一个被白名单信任的站点
 *     可以 302 到任意地址。所以 `disableRedirects: true`，自己跟跳，每跳都重新过
 *     完整校验（https / 非 IP / 白名单）。
 *  2. **大小上限要在读取时生效，而不是读完之后。** 这里对每一跳的响应体都做检查，
 *     超限立即中断并审计，避免「先吃满内存再报错」。
 */

import { AuditLog } from './audit.ts';
import { authorizeTarget, compileAllowlist, matchHost, parseTarget, type AllowRule } from './allowlist.ts';
import { TokenBuckets } from './ratelimit.ts';
import { CapabilityRegistry } from './tokens.ts';
import type { SessionProvider } from './session.ts';
import {
  CoreError,
  DEFAULT_GATEWAY_CONFIG,
  IDEMPOTENT_METHODS,
  type GatewayConfig,
  type NetRequest,
  type NetResponse,
  type Transport,
  type TransportResponse,
} from './types.ts';

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** 这些码表示「策略主动拒绝」，而不是「外部世界出错」—— 审计里要分开统计 */
const DENIAL_CODES: ReadonlySet<string> = new Set([
  'EAUTH', 'EHOST', 'EURL', 'EIP', 'ERATELIMIT', 'EREDIRECT', 'ETOOBIG',
]);

/** 服务端临时故障，值得重试（但仅限幂等方法） */
const RETRY_STATUS: ReadonlySet<number> = new Set([502, 503, 504]);

/** 大整数扫描的规模上限：超过这个体量就不扫了，避免为了一个告警把 CPU 吃满 */
const BIGINT_SCAN_MAX_BYTES = 2 * 1024 * 1024;
const BIGINT_SCAN_MAX_HITS = 1000;

/**
 * 统计文本里**超过 `Number.MAX_SAFE_INTEGER` 的整数字面量**个数。
 *
 * 用途：JSON 响应体被传输层 parse 又 stringify 之后，原本 > 2^53-1 的整数
 * 已经静默变成别的数了 —— 我们无法还原原始值，但能从结果里看出
 * 「这个 API 在用大整数」，从而提醒调用方「你拿到的数可能已经不是服务端那个数」。
 *
 * 刻意不用后行断言（lookbehind）：老版本 Android WebView 可能不支持。
 */
function countBigIntRisk(text: string): number {
  if (text.length > BIGINT_SCAN_MAX_BYTES) return 0;
  const re = /\d{16,}/g;
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  let hits = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const before = start > 0 ? text[start - 1] : '';
    const after = end < text.length ? text[end] : '';
    // 前后是小数点或指数符号的，不是纯整数
    if (before === '.' || after === '.' || before === 'e' || before === 'E'
      || after === 'e' || after === 'E') continue;

    try {
      if (BigInt(m[0]) > maxSafe) {
        hits += 1;
        if (hits >= BIGINT_SCAN_MAX_HITS) break;
      }
    } catch {
      /* 不可能失败，保险起见 */
    }
  }
  return hits;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function utf8Bytes(s: string): number {
  // 用 TextEncoder 而不是 s.length：中文一个字算 3 字节，按 length 算会低估
  return new TextEncoder().encode(s).length;
}

export interface GatewayDeps {
  transport: Transport;
  tokens: CapabilityRegistry;
  audit: AuditLog;
  config?: Partial<GatewayConfig>;
  sessions?: SessionProvider;
  now?: () => number;
}

export interface GatewayStatus {
  transport: string;
  /** 当前会话后端：`memory`（隔离）或 `capacitor-cookies`（走原生全局存储） */
  session: string;
  allowlist: readonly string[];
  defaultTimeoutMs: number;
  defaultMaxBytes: number;
  maxRedirects: number;
  retryCount: number;
  retryBaseMs: number;
  rateCapacity: number;
  rateRefillPerSec: number;
}

/** 一次请求最多给重试留这么多余量（毫秒）。见 `send()` 里的说明 */
const RETRY_RESERVE_MS = 15_000;

export class NetGateway {
  private rules: AllowRule[];
  private readonly config: GatewayConfig;
  private readonly buckets: TokenBuckets;
  private readonly now: () => number;
  private readonly deps: GatewayDeps;
  private sessions: SessionProvider | undefined;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    this.sessions = deps.sessions;
    this.config = { ...DEFAULT_GATEWAY_CONFIG, ...deps.config };
    // 规则在这里就编译好：配置写错要早失败，而不是等第一次请求才炸
    this.rules = compileAllowlist(this.config.allowlist);
    this.now = deps.now ?? (() => Date.now());
    this.buckets = new TokenBuckets(this.config.rateCapacity, this.config.rateRefillPerSec, this.now);
  }

  /**
   * 运行时替换会话后端。
   *
   * 之所以需要这个开关：`CapacitorHttp` 的原生 cookie 存储是**进程全局**的
   * （`CapacitorCookies.java:26` 装了全局 `CookieHandler`），
   * 用哪个 provider 会带来**可观察的行为差异**，所以要让它在调试面板里可切换、可对比。
   */
  setSessionProvider(p: SessionProvider | undefined): void {
    this.sessions = p;
  }

  get sessionKind(): string {
    return this.sessions?.kind ?? 'none';
  }

  status(): GatewayStatus {
    return {
      transport: this.deps.transport.kind,
      session: this.sessionKind,
      allowlist: this.config.allowlist,
      defaultTimeoutMs: this.config.defaultTimeoutMs,
      defaultMaxBytes: this.config.defaultMaxBytes,
      maxRedirects: this.config.maxRedirects,
      retryCount: this.config.retryCount,
      retryBaseMs: this.config.retryBaseMs,
      rateCapacity: this.config.rateCapacity,
      rateRefillPerSec: this.config.rateRefillPerSec,
    };
  }

  /**
   * 运行时替换白名单。
   *
   * 之所以做成可变的而不是启动时固定：白名单本来就该由用户按需增删，
   * 为改一条域名重启整个平台（重新探测所有策略）代价太大。
   * 编译失败会抛错且**保持原白名单不变** —— 不能因为一次手滑把防护清空。
   */
  setAllowlist(rules: readonly string[]): void {
    const compiled = compileAllowlist(rules);   // 先编译，成功了才替换
    this.rules = compiled;
    this.config.allowlist = rules;
  }

  get allowlist(): readonly string[] {
    return this.config.allowlist;
  }

  /**
   * 发出一次请求，带**幂等方法**的指数退避重试。
   *
   * 三条纪律：
   *   · 只重试幂等方法（GET/HEAD/PUT/DELETE）。重试 POST 可能造成重复下单、
   *     重复提交表单 —— 宁可失败也不能悄悄做两次。
   *   · 只重试「可能自愈」的失败：网络层错误（ENET）与 502/503/504。
   *     4xx 是请求本身的问题，重试多少次都一样，还会白白消耗配额。
   *   · 重试要**算进总超时**：退避等不完就干脆不重试，绝不让重试把总时长拖爆。
   */
  private async sendWithRetry(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    deadline: number,
    session?: string | null,
  ): Promise<TransportResponse> {
    const idempotent = IDEMPOTENT_METHODS.has(method);
    const maxAttempts = idempotent ? 1 + this.config.retryCount : 1;
    let lastError: unknown = null;
    /** 拿到了「可重试的响应」但没时间再试时，把它交还给调用方，比抛错更有用 */
    let lastRetryableResponse: TransportResponse | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        const delay = this.config.retryBaseMs * 2 ** (attempt - 1);
        const left = deadline - this.now();
        if (left <= delay) break;             // 等不完，放弃重试
        await sleep(delay);
      }

      const left = deadline - this.now();
      if (left <= 0) break;                   // 时间用完，走下面的统一收尾

      /*
        单次尝试的时间 = 剩余预算减去「留给重试的那一份」。
        早先这里直接把 `left` 全给出去，于是一次超时就把预算吃干净，
        循环下一轮 `left <= 0` 直接 break —— 配了 retryCount 也等于没有重试。
        校园网上的课表页面偶尔就是会卡满 15 秒，卡完一次就没机会了。
      */
      const attemptsLeft = maxAttempts - attempt;
      const reserve = attemptsLeft > 1 ? Math.min(Math.floor(left / 3), RETRY_RESERVE_MS) : 0;
      const attemptTimeout = Math.max(1, left - reserve);

      try {
        const res = await this.deps.transport.request({
          session,
          url,
          method,
          headers,
          body,
          connectTimeoutMs: attemptTimeout,
          readTimeoutMs: attemptTimeout,
        });

        if (RETRY_STATUS.has(res.status) && attempt + 1 < maxAttempts) {
          lastRetryableResponse = res;
          continue;
        }
        return res;
      } catch (e) {
        lastError = e;
        const retryable = e instanceof CoreError && e.code === 'ENET';
        if (!retryable || attempt + 1 >= maxAttempts) throw e;
      }
    }

    // 一次都没发出去（时间从一开始就不够）
    if (lastRetryableResponse) return lastRetryableResponse;
    if (lastError instanceof Error) throw lastError;
    throw new CoreError('ETIMEOUT', '超时（含重试）', { url });
  }

  /** 只判定不发送 —— 调试面板与「试一下这个 URL」用得上 */
  check(url: string): { ok: true; host: string; path: string } | { ok: false; code: string; message: string } {
    try {
      const t = authorizeTarget(url, this.rules);
      return { ok: true, host: t.host, path: t.path };
    } catch (e) {
      if (e instanceof CoreError) return { ok: false, code: e.code, message: e.message };
      return { ok: false, code: 'EUNKNOWN', message: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 发起一次受控请求。
   *
   * pluginId **从令牌里取**，不接受调用方自称 —— 否则插件可以冒用别人的身份
   * 去消耗配额、或嫁祸审计记录。
   */
  async request(tokenId: string | null | undefined, req: NetRequest): Promise<NetResponse> {
    const startedAt = this.now();
    let pluginId = '<unknown>';
    let host = '';
    let path = '';
    let method = (req.method ?? 'GET').toUpperCase();
    const hops: string[] = [];

    /**
     * 调用方自带的请求头里，属于「凭证」或「逐跳」的一律**剥掉**。
     *
     * 为什么必须有这一步：下面注入会话 cookie 的合并写的是
     * `{ ...injected, ...callerHeaders }` —— 调用方只要塞一个 `cookie`，
     * 就能**盖掉**核心从 vault 注入的会话 cookie。那等于把「凭证不进插件」
     * 整条设计原则绕过去。响应侧早就洗了 `set-cookie`（见 sanitizeResponseHeaders），
     * 请求侧此前一直是漏的。
     *
     * 这里选择「剥掉」而不是「报错」：网关是最后一道强制点，它的职责是保证
     * **发出去的请求干净**；给调用方可读的错误由上层（内核适配器）负责，那里能写业务审计。
     * 剥掉的事实仍然记进审计，所以这次尝试是**可见**的，不是静默吞掉。
     */
    const { kept: callerHeaders, stripped: strippedHeaders } = stripForbiddenHeaders(req.headers);

    const fail = (e: unknown): never => {
      const code = e instanceof CoreError ? e.code : 'EUNKNOWN';
      // 刻意不把错误文案写进审计：文案里可能夹带主机名之外的上下文，
      // 而且它会随实现变化。审计要的是**稳定可统计**的判定结果。
      this.deps.audit.record({
        at: startedAt,
        pluginId,
        method,
        host,
        path,
        status: null,
        bytes: 0,
        ms: this.now() - startedAt,
        outcome: DENIAL_CODES.has(code) ? 'denied' : 'error',
        code,
        ...(hops.length > 1 ? { hops: [...hops] } : {}),
        ...(strippedHeaders.length > 0 ? { headersStripped: strippedHeaders } : {}),
      });
      throw e;
    };

    // ① 能力令牌（权威判定）
    let token;
    try {
      token = this.deps.tokens.verify(tokenId, 'net');
      pluginId = token.pluginId;
    } catch (e) {
      return fail(e);
    }

    // ② URL 校验 + ③ 白名单
    let current: { url: URL; host: string; path: string };
    try {
      current = authorizeTarget(req.url, this.rules);
      host = current.host;
      path = current.path;
    } catch (e) {
      return fail(e);
    }

    // ④ 限流（按 pluginId + host）
    const bucketKey = TokenBuckets.key(pluginId, current.host);
    const rate = this.buckets.take(bucketKey);
    if (!rate.ok) {
      return fail(new CoreError(
        'ERATELIMIT',
        `触发限流，约 ${rate.retryAfterMs}ms 后可重试`,
        { host: current.host, retryAfterMs: rate.retryAfterMs },
      ));
    }

    const timeoutMs = req.timeoutMs ?? this.config.defaultTimeoutMs;
    const maxBytes = req.maxBytes ?? this.config.defaultMaxBytes;
    const deadline = startedAt + timeoutMs;

    // ⑤ 会话注入：插件只给句柄，真正的凭证由核心从 vault 取
    let injected: Record<string, string> = {};
    if (req.session && this.sessions) {
      try {
        injected = await this.sessions.headersFor(req.session, current.host);
      } catch (e) {
        return fail(new CoreError('EAUTH', `会话不可用: ${e instanceof Error ? e.message : String(e)}`));
      }
    }

    let body = req.body;
    let redirectsLeft = this.config.maxRedirects;
    /** 跨跳累计：整条跳转链一共收走了几个 Set-Cookie */
    let cookiesSet = 0;
    /** 只有最后一跳的响应体会返回给调用方，所以这两个跟着最后一跳走 */
    let jsonRoundTrip = false;
    let bigIntRisk = 0;

    // ⑥~⑨ 请求 → 逐跳复检 → 大小上限
    for (;;) {
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        return fail(new CoreError('ETIMEOUT', `超时（${timeoutMs}ms）`, { url: current.url.href }));
      }

      const headers: Record<string, string> = { ...injected, ...callerHeaders };
      if (body !== undefined && !headers['content-type'] && !headers['Content-Type']) {
        headers['content-type'] = 'application/json';
      }

      hops.push(current.url.href);

      let res;
      try {
        res = await this.sendWithRetry(current.url.href, method, headers, body, deadline, req.session);
      } catch (e) {
        return fail(e);
      }

      // 大小上限：对每一跳都查，而不是等全部读完
      //
      // 注意：这里量的是**传输层返回的字符串**，不是线上原始字节。
      // JSON 响应体已被 parse → stringify 过（见 NetResponse.jsonRoundTrip），
      // 所以这个字节数与服务端实际发出的字节数可能略有出入。对「防超大响应」
      // 这个目的而言足够，但不能拿它当流量计费依据。
      const bytes = utf8Bytes(res.body);
      if (bytes > maxBytes) {
        return fail(new CoreError(
          'ETOOBIG',
          `响应体 ${bytes} 字节，超过上限 ${maxBytes}`,
          { host: current.host, bytes, maxBytes },
        ));
      }

      jsonRoundTrip = res.bodyWasJson === true;
      bigIntRisk = jsonRoundTrip ? countBigIntRisk(res.body) : 0;

      // ⑧ 剥离 Set-Cookie 写回会话（插件永远看不到 cookie）
      //
      // 这里做的是**两层**剥离：
      //   · 交给 session provider 写回（插件看不到内容）
      //   · 返回给插件前从响应头里删掉（否则插件直接读 headers['set-cookie'] 就拿到了）
      // 第二层以前漏了 —— 只写回不删，等于把 cookie 从后门递给插件。
      const setCookie = res.headers['set-cookie'];
      if (setCookie) {
        const parts = splitSetCookie(setCookie);
        cookiesSet += parts.length;
        if (req.session && this.sessions?.acceptSetCookie) {
          try {
            await this.sessions.acceptSetCookie(req.session, current.host, parts);
          } catch {
            /* cookie 写回失败不该让本次请求失败 */
          }
        }
      }

      // ⑦ 跳转：逐跳复检
      const location = res.headers['location'];
      if (REDIRECT_STATUS.has(res.status) && location) {
        if (redirectsLeft <= 0) {
          return fail(new CoreError(
            'EREDIRECT',
            `跳转次数超过上限（${this.config.maxRedirects}）`,
            { hops: [...hops] },
          ));
        }
        redirectsLeft -= 1;

        let next: URL;
        try {
          next = new URL(location, current.url);
        } catch {
          return fail(new CoreError('EREDIRECT', `跳转目标无法解析: ${location}`));
        }

        // 重新过完整校验：https / 非 IP / 白名单。只查初始 URL 是常见漏洞
        //
        // ⚠️ 这里刻意把 `parseTarget` 单独放进 try，`fail()` 放在 try **外面**。
        // 否则 fail 抛出的 CoreError 会被自己的 catch 再抓一次，
        // 导致同一次请求被记两条审计（P0 阶段真的踩到过）。
        let checked;
        try {
          checked = parseTarget(next.href);
        } catch (e) {
          // 跳到了 http 或 IP 字面量：保留原始错误码，调用方才知道具体哪里不对
          return fail(e);
        }

        if (!matchHost(checked.host, this.rules)) {
          return fail(new CoreError(
            'EREDIRECT',
            `跳转目标不在白名单内: ${checked.host}`,
            { from: current.host, to: checked.host, hops: [...hops] },
          ));
        }

        current = checked;
        host = checked.host;
        path = checked.path;

        // 303 一律转 GET；301/302 下的 POST 按惯例也转 GET 并丢弃 body
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }

      const ms = this.now() - startedAt;
      this.deps.audit.record({
        at: startedAt,
        pluginId,
        method,
        host: current.host,
        path: current.path,
        status: res.status,
        bytes,
        ms,
        outcome: 'ok',
        ...(hops.length > 1 ? { hops: [...hops] } : {}),
        ...(cookiesSet > 0 ? { cookiesSet } : {}),
        ...(jsonRoundTrip ? { jsonRoundTrip: true } : {}),
        ...(bigIntRisk > 0 ? { bigIntRisk } : {}),
        ...(strippedHeaders.length > 0 ? { headersStripped: strippedHeaders } : {}),
      });

      return {
        status: res.status,
        headers: sanitizeResponseHeaders(res.headers),
        body: res.body,
        url: res.url || current.url.href,
        bytes,
        ms,
        hops,
        ...(jsonRoundTrip ? { jsonRoundTrip: true } : {}),
        ...(bigIntRisk > 0 ? { bigIntRisk } : {}),
      };
    }
  }
}

/**
 * 调用方**不得**自行设置的请求头（小写比较）。
 *
 * 前五个是凭证：设计里凭证只走 vault + 会话句柄注入，调用方永远不该自己拼。
 * 后五个是逐跳头（hop-by-hop），转发它们会破坏请求语义。
 */
export const FORBIDDEN_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
]);

/**
 * 剥掉调用方自带的禁用请求头。
 *
 * 返回 `stripped` 而不是静默丢弃 —— 调用方试图设置凭证头是**安全事件**，
 * 必须能在审计里看到。
 */
function stripForbiddenHeaders(headers: Record<string, string> | undefined): {
  kept: Record<string, string>;
  stripped: string[];
} {
  const kept: Record<string, string> = {};
  const stripped: string[] = [];
  for (const [k, v] of Object.entries(headers ?? {})) {
    const lower = k.toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(lower)) stripped.push(lower);
    else kept[k] = v;
  }
  stripped.sort();
  return { kept, stripped };
}

/**
 * 返回给插件前清洗响应头。
 *
 * 目前只删 `set-cookie`。理由：cookie 是**凭证**，设计里明确「凭证不进插件」。
 * 只把 cookie 写回会话而不从响应里删掉，插件照样能 `res.headers['set-cookie']` 拿到明文 ——
 * 那等于前门锁了后门开着。
 */
function sanitizeResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'set-cookie') continue;
    out[k] = v;
  }
  return out;
}

/** 有些实现对 Set-Cookie 用逗号拼接，需要小心不要把 Expires 里的逗号切开 */
function splitSetCookie(raw: string): string[] {
  if (!raw) return [];
  const parts: string[] = [];
  let buf = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    // 只在「, 后面紧跟一个 name=」时才认为是分隔符
    if (ch === ',' && /^\s*[A-Za-z0-9_.-]+\s*=/.test(raw.slice(i + 1, i + 40))) {
      if (buf.trim()) parts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}
