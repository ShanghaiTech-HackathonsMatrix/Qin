/**
 * 插件 API v1 —— 错误码（DESIGN.md §5.5）
 *
 * 约定：跨沙箱边界**一律不抛异常，改传结构化结果**。
 *
 * 为什么不抛：沙箱内外的异常语义不同。宿主异常若直接穿进沙箱，
 * 会把宿主堆栈、甚至宿主对象带进去（S4 已实测「插件抛错不带出宿主堆栈」是必须守住的性质）。
 * 反过来，插件异常也不该让宿主崩。所以边界上只有数据。
 *
 * ## 两套码，一个出口
 *
 * 仓库里存在**两个**错误码空间，它们不是同一个东西：
 *
 * - **契约码**（`PluginContractCode`）—— 插件 API 自己产生的：权限、配额、
 *   版本、schema、生命周期、信任。
 * - **传输码**（`CoreTransportCode`）—— 核心网关产生的：URL 非法、IP 字面量、
 *   主机不在白名单、重定向越界、响应过大、限流、超时、传输失败。
 *   这套码的定义源是 `apps/shell/src/core/types.ts` 的 `CoreErrorCode`。
 *
 * 插件边界**必须能如实承载两套**。理由很直接：插件让宿主去取一个 URL，
 * 这个动作可能因为「URL 写错了」失败，也可能因为「域名没授权」失败 ——
 * 如果边界类型只装得下后者，宿主就只能把前者**谎报**成后者，
 * 而错误的原因是用户排查问题的唯一线索。
 *
 * 注意 `EAUTH` / `ETIMEOUT` 同时出现在两套里，语义一致，不是重复定义。
 */

/** 插件 API 契约自身产生的失败码 */
export type PluginContractCode =
  /** 未声明或未授权 */
  | 'EPERM'
  /** API 版本不兼容 */
  | 'EAPIVERSION'
  /** 超出配额（含 maxSteps） */
  | 'EQUOTA'
  /** 域名不在白名单 / 重定向越界 */
  | 'ENETDENIED'
  /** 认证失败 */
  | 'EAUTH'
  /** 实体校验失败 */
  | 'ESCHEMA'
  /** 超时 */
  | 'ETIMEOUT'
  /** 信任等级不足（§5.7） */
  | 'ETRUST'
  /** manifest 本身不合法 */
  | 'EMANIFEST'
  /** 目标不存在（插件 / 模块 / 实体类型） */
  | 'ENOTFOUND'
  /** 宿主内部错误 */
  | 'EINTERNAL';

/**
 * 核心传输层的失败码。**必须与 `apps/shell/src/core/types.ts` 的
 * `CoreErrorCode` 逐字一致** —— 由 `apps/shell/src/core/plugin-api-diff.test.ts`
 * 的差分测试守着。
 */
export type CoreTransportCode =
  /** URL 无法解析 / 非 https / 含 userinfo */
  | 'EURL'
  /** 不允许 IP 字面量直连 */
  | 'EIP'
  /** 主机不在白名单 */
  | 'EHOST'
  /** 重定向越界或次数超限 */
  | 'EREDIRECT'
  /** 超时 */
  | 'ETIMEOUT'
  /** 响应体超过单次上限 */
  | 'ETOOBIG'
  /** 触发限流 */
  | 'ERATELIMIT'
  /** 认证失败 */
  | 'EAUTH'
  /** 传输层失败（DNS / 连接 / 底层报错） */
  | 'ENET'
  /** 未归类的失败 */
  | 'EUNKNOWN';

/** 传输码的运行时清单，供差分测试与文档生成使用 */
export const CORE_TRANSPORT_CODES: readonly CoreTransportCode[] = [
  'EURL', 'EIP', 'EHOST', 'EREDIRECT', 'ETIMEOUT',
  'ETOOBIG', 'ERATELIMIT', 'EAUTH', 'ENET', 'EUNKNOWN',
];

/** 契约码的运行时清单 */
export const PLUGIN_CONTRACT_CODES: readonly PluginContractCode[] = [
  'EPERM', 'EAPIVERSION', 'EQUOTA', 'ENETDENIED', 'EAUTH', 'ESCHEMA',
  'ETIMEOUT', 'ETRUST', 'EMANIFEST', 'ENOTFOUND', 'EINTERNAL',
];

/** 插件边界上可能出现的全部失败码 = 契约码 ∪ 传输码 */
export type PluginErrorCode = PluginContractCode | CoreTransportCode;

/** 判断一个字符串是不是已知的边界失败码 */
export function isPluginErrorCode(v: unknown): v is PluginErrorCode {
  if (typeof v !== 'string') return false;
  return (PLUGIN_CONTRACT_CODES as readonly string[]).includes(v)
    || (CORE_TRANSPORT_CODES as readonly string[]).includes(v);
}

export interface PluginFailure {
  ok: false;
  code: PluginErrorCode;
  message: string;
  /** 便于排查的结构化上下文。**不得**含凭证、cookie、token、完整 URL 的查询串 */
  detail?: Record<string, unknown>;
}

export interface PluginSuccess<T> {
  ok: true;
  data: T;
}

export type PluginResult<T> = PluginSuccess<T> | PluginFailure;

export function ok<T>(data: T): PluginSuccess<T> {
  return { ok: true, data };
}

export function fail(
  code: PluginErrorCode,
  message: string,
  detail?: Record<string, unknown>,
): PluginFailure {
  return detail ? { ok: false, code, message, detail } : { ok: false, code, message };
}

export function isOk<T>(r: PluginResult<T>): r is PluginSuccess<T> {
  return r.ok === true;
}

/** 从任意抛出物里取错误码；不是已知码时给 EINTERNAL */
export function codeOf(e: unknown): PluginErrorCode {
  if (e && typeof e === 'object' && 'code' in e) {
    const c = (e as { code: unknown }).code;
    if (isPluginErrorCode(c)) return c;
  }
  return 'EINTERNAL';
}
