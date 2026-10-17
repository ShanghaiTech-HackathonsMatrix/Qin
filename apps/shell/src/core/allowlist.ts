/**
 * 域名白名单。
 *
 * 规则（对应 DESIGN.md §8.1 的「URL 校验」）：
 *   · **https only** —— 明文 http 一律拒绝，避免降级攻击
 *   · **拒绝 IP 字面量** —— 白名单是「按名字信任」，对 IP 无意义；
 *     而且各种 IP 写法（十进制整数、八进制、IPv6 映射）很容易绕过朴素校验
 *   · **拒绝 userinfo** —— `https://good.com@evil.com/` 这种视觉欺骗
 *   · `example.com` 精确匹配；`*.example.com` 匹配任意层子域，但**不含根域**
 *
 * 刻意不做的：不解析 DNS、不看 IP 归属。这是名字层的策略，
 * 真正的出口管控由「核心层是唯一出网点」这条架构约束承担。
 */

import { CoreError } from './types.ts';

/** 一条白名单规则 */
export interface AllowRule {
  readonly raw: string;
  /** 是否为 `*.x` 形式 */
  readonly wildcard: boolean;
  /** 归一化后的主机名（小写、去尾点） */
  readonly host: string;
}

/**
 * 归一化主机名：小写、去尾点。
 * `example.com.` 与 `example.com` 必须视为同一台主机，否则尾点就是绕过手段。
 */
export function normalizeHost(host: string): string {
  let h = host.toLowerCase();
  // 去掉**全部**尾点，不是只去一个：`example.com..` 与 `example.com` 必须等价，
  // 否则多打几个点就是绕过白名单的现成手段
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/** 是否是 IP 字面量（含各种非点分写法） */
export function isIpLiteral(host: string): boolean {
  const h = normalizeHost(host);
  if (!h) return true;

  // IPv6：URL 解析后带方括号
  if (h.startsWith('[') || h.includes(':')) return true;

  // 点分十进制 1.2.3.4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;

  // 纯数字/十六进制整数形式：2130706433、0x7f000001
  if (/^(0x[0-9a-f]+|\d+)$/.test(h)) return true;

  // 其它「看起来像 IP」的形态：数字开头且只有数字与点（如 1.2、127.1）
  if (/^[\d.]+$/.test(h)) return true;

  return false;
}

/** 编译一条规则，非法规则直接抛错（配置错误应当早失败） */
export function compileRule(raw: string): AllowRule {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`白名单规则为空`);

  const wildcard = trimmed.startsWith('*.');
  const host = normalizeHost(wildcard ? trimmed.slice(2) : trimmed);

  if (!host) throw new Error(`白名单规则缺少主机名: ${raw}`);
  if (wildcard && host.includes('*')) throw new Error(`只支持最左侧一个通配符: ${raw}`);
  if (!wildcard && host.includes('*')) throw new Error(`通配符必须写成 *.host 形式: ${raw}`);
  // 规则里写 IP 没有意义，且会让「拒绝 IP」形同虚设
  if (isIpLiteral(host)) throw new Error(`白名单规则不能是 IP 字面量: ${raw}`);

  return { raw: trimmed, wildcard, host };
}

export function compileAllowlist(rules: readonly string[]): AllowRule[] {
  return rules.map(compileRule);
}

/**
 * 主机是否命中白名单。
 *
 * `*.example.com` 匹配 `a.example.com`、`a.b.example.com`，**不匹配** `example.com` ——
 * 这是有意的：把「根域」和「子域」当成不同信任级别，避免一条通配符顺带把根域也放开。
 */
export function matchHost(host: string, rules: readonly AllowRule[]): boolean {
  const h = normalizeHost(host);
  if (!h || isIpLiteral(h)) return false;

  for (const r of rules) {
    if (!r.wildcard) {
      if (h === r.host) return true;
      continue;
    }
    // 必须严格多出一个标签：a.example.com 命中，example.com 不命中
    if (h.length > r.host.length + 1 && h.endsWith(`.${r.host}`)) return true;
  }
  return false;
}

export interface Target {
  readonly url: URL;
  readonly host: string;
  /** 仅路径与查询串，用于审计（避免把敏感参数写进日志时还得再裁一次） */
  readonly path: string;
}

/**
 * 解析并校验目标 URL。任何一条不合规都抛 `CoreError`。
 * 这是网关的第一道闸，也是唯一一处允许解释 URL 的地方。
 */
export function parseTarget(raw: string): Target {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CoreError('EURL', `URL 无法解析: ${raw}`);
  }

  if (url.protocol !== 'https:') {
    throw new CoreError('EURL', `只允许 https，收到 ${url.protocol}`, { url: raw });
  }
  if (url.username || url.password) {
    throw new CoreError('EURL', 'URL 不允许包含 userinfo（user:pass@host）', { url: raw });
  }

  const host = normalizeHost(url.hostname);
  if (!host) throw new CoreError('EURL', `URL 缺少主机名: ${raw}`);

  if (isIpLiteral(host)) {
    throw new CoreError('EIP', `不允许直接访问 IP 字面量: ${host}`, { host });
  }

  return { url, host, path: `${url.pathname}${url.search}` };
}

/** 解析 + 白名单判定，一步到位 */
export function authorizeTarget(raw: string, rules: readonly AllowRule[]): Target {
  const target = parseTarget(raw);
  if (!matchHost(target.host, rules)) {
    throw new CoreError('EHOST', `主机不在白名单内: ${target.host}`, { host: target.host });
  }
  return target;
}
