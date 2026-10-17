/**
 * 核心层 v1 契约。
 *
 * 这一层是「唯一允许出网」的地方（见 DESIGN.md §8.1）。它把三件事收拢到一起：
 *   · 网络出口（net）—— 域名白名单、逐跳复检、限流、超时、大小上限、审计
 *   · 凭证库（vault）—— 密钥与口令，插件永远拿不到明文
 *   · 数据权威（db）—— 由查询编译器与策略层承担，不在本文件
 *
 * 设计约束（对应 DESIGN.md §11.1 的不变量）：
 *   I7  `plugins.CapacitorHttp.enabled` 必须保持 false —— 我们只把它当**传输层**直接调用，
 *       绝不让它去补丁 WebView 的 fetch/XHR。这样 WebView 自身依旧零网络。
 *   I10 每次调用都要出示能力令牌。**不用 frame origin 做鉴权** ——
 *       Android 的 addJavascriptInterface 会注入到所有 frame，iframe 不是边界。
 */

// ---------------------------------------------------------------- 错误

export type CoreErrorCode =
  /** URL 本身不合法：非 https、含 userinfo、格式错误 */
  | 'EURL'
  /** 目标是 IP 字面量 —— 白名单机制对 IP 无意义，一律拒绝 */
  | 'EIP'
  /** 主机不在白名单内 */
  | 'EHOST'
  /** 重定向次数超限，或跳到了白名单外的主机 */
  | 'EREDIRECT'
  /** 超时 */
  | 'ETIMEOUT'
  /** 响应体超过上限 */
  | 'ETOOBIG'
  /** 触发限流 */
  | 'ERATELIMIT'
  /** 能力令牌缺失、过期或不含所需能力 */
  | 'EAUTH'
  /** 传输层失败（DNS、连接被拒等） */
  | 'ENET';

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: CoreErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.detail = detail;
  }
}

/** 便于在 catch 里安全取码 */
export function errorCode(e: unknown): CoreErrorCode | 'EUNKNOWN' {
  return e instanceof CoreError ? e.code : 'EUNKNOWN';
}

// ---------------------------------------------------------------- 网络

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

export interface NetRequest {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  /** 只能是字符串。复杂类型（FormData/Blob）需自行序列化后声明 Content-Type */
  body?: string;
  /**
   * 会话句柄。**凭证不进 JS 堆** —— 这里只是一串随机标识，
   * 真正的 cookie 由 vault 保管、由核心注入。
   */
  session?: string | null;
  /** 覆盖默认超时 */
  timeoutMs?: number;
  /** 覆盖默认响应体上限 */
  maxBytes?: number;
}

export interface NetResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** 跳转结束后的最终 URL（用于核对是否发生了跳转） */
  url: string;
  /** 实际读取的字节数 */
  bytes: number;
  /** 耗时（毫秒） */
  ms: number;
  /** 完整跳转链，便于调试与审计 */
  hops: string[];
  /**
   * 响应体经历了「解析成对象 → 重新序列化」的往返。
   *
   * 为什么会这样：`CapacitorHttp` 在 content-type 是 JSON 时**忽略 `responseType`**，
   * 强制把响应体 parse 成对象 —— 原生（`HttpRequestHandler.java:250-252`）
   * 与 Web（`@capacitor/core` dist 的 `CapacitorHttpPluginWeb.request`）行为一致。
   * 后果是响应体不再是原始字节：大整数可能丢精度、键序可能变化、`1.0` 会变成 `1`。
   * 这里如实标出来，让调用方知道「拿到的不是线上原始字节」。
   */
  jsonRoundTrip?: boolean;
  /**
   * 往返后仍在文中出现的、超过 `Number.MAX_SAFE_INTEGER` 的整数个数。
   * 大于 0 意味着**可能有静默精度损失**（原始值可能更大）。只报数量，不报值。
   */
  bigIntRisk?: number;
}

/** 网关的对外配置 */
export interface GatewayConfig {
  /** 白名单规则：`example.com` 精确匹配；`*.example.com` 匹配任意层子域（不含根域） */
  allowlist: readonly string[];
  /** 单次请求默认超时 */
  defaultTimeoutMs: number;
  /** 单次请求默认响应体上限 */
  defaultMaxBytes: number;
  /** 最大跳转次数 */
  maxRedirects: number;
  /** 幂等方法的额外重试次数（总共 1 + retryCount 次尝试） */
  retryCount: number;
  /** 指数退避基数：第 n 次重试等 retryBaseMs * 2^(n-1) */
  retryBaseMs: number;
  /** 限流：每个 (pluginId, host) 的桶容量 */
  rateCapacity: number;
  /** 限流：每秒补充的令牌数 */
  rateRefillPerSec: number;
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  allowlist: [],
  defaultTimeoutMs: 15_000,
  defaultMaxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  retryCount: 2,
  retryBaseMs: 200,
  rateCapacity: 20,
  rateRefillPerSec: 2,
};

// ---------------------------------------------------------------- 审计

export type AuditOutcome = 'ok' | 'denied' | 'error';

export interface AuditEntry {
  at: number;
  pluginId: string;
  method: string;
  /** 只记主机名，不记完整 URL —— 路径里可能含敏感参数 */
  host: string;
  path: string;
  status: number | null;
  bytes: number;
  ms: number;
  outcome: AuditOutcome;
  code?: CoreErrorCode | 'EUNKNOWN';
  /** 跳转链（发生跳转时才有） */
  hops?: string[];
  /** 本次收走了几个 Set-Cookie。只记数量，**绝不记内容** */
  cookiesSet?: number;
  /** 响应体经历了 JSON 往返（可能丢精度） */
  jsonRoundTrip?: boolean;
  /** 往返后仍出现的大整数个数（>0 意味着可能已静默丢精度） */
  bigIntRisk?: number;
  /**
   * 本次被剥掉的禁用请求头（小写名）。
   *
   * 调用方试图自行设置 `cookie` / `authorization` 这类凭证头是**安全事件**，
   * 必须在审计里留痕。只记头名，**绝不记值**。
   */
  headersStripped?: string[];
}

// ---------------------------------------------------------------- 能力令牌

/** 核心层可授予的能力。粒度故意做得很粗，细粒度靠白名单与策略层 */
export type Capability = 'net' | 'vault';

export interface CapabilityToken {
  /** 随机串，进程内有效 */
  readonly id: string;
  readonly pluginId: string;
  readonly caps: ReadonlySet<Capability>;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

// ---------------------------------------------------------------- 传输层

export interface TransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  connectTimeoutMs: number;
  readTimeoutMs: number;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** 传输层报告的最终 URL（原生实现会带回来） */
  url: string;
  /** 底层是否已跟随跳转 */
  followedRedirects: boolean;
  /** 原始 `data` 不是字符串 —— 说明传输层把 JSON 解析掉又序列化回来了 */
  bodyWasJson?: boolean;
}

/**
 * 传输层抽象。
 *
 * 移动端/桌面端由 `CapacitorTransport` 落到原生实现；
 * 测试与纯 Web dev 用 `FetchTransport`。两者接口完全一致，
 * 由 `conformance.test.ts` 用同一套用例跑两边。
 */
export interface Transport {
  readonly kind: string;
  request(req: TransportRequest): Promise<TransportResponse>;
}
