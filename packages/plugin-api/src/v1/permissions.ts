/**
 * 插件 API v1 —— 权限矩阵（DESIGN.md §5.3）
 *
 * **默认拒绝。** 表里没有的方法一律拒；表里有但没声明的也一律拒。
 *
 * 分工要说清楚，否则会误以为这里就是安全边界：
 *
 *   · **本文件是「声明层」的判定** —— 插件有没有声明、用户有没有授予。
 *     它的价值是**尽早失败**：让插件作者在开发时就收到明确的 `EPERM`，
 *     而不是等到运行时某个 RPC 莫名其妙被拒。
 *   · **真正的强制点在核心层**：网络出口是 `apps/shell/src/core/gateway.ts`，
 *     那里做重定向逐跳复检、真实白名单、配额、审计。即使本文件被绕过，
 *     核心层仍然拦得住 —— 这是「纵深防御」，不是二选一。
 *
 * 域名匹配规则**刻意与核心层 `allowlist.ts` 的 `matchHost` 保持一致**。
 * 目前是重复实现（技术债）：待 `packages/net` 抽出后应改为单向依赖。
 * 在那之前，conformance.test.ts 里有一个**差分测试**直接对比两边的行为，
 * 一旦漂移就会红。
 */

import { fail, ok, type PluginErrorCode, type PluginResult } from './errors.ts';
import type { Manifest, ManifestPermissions } from './manifest.ts';

// ------------------------------------------------------------ 信任等级

/**
 * 信任等级（DESIGN.md §5.7）。
 *
 * ⚠️ **权限与信任是正交的**（I4）：
 *   · 权限回答「能做什么」—— 安装时确认，绑定在**沙箱实例**上。
 *   · 信任回答「代码是否被审核过」—— 决定代码**能不能进来**，不决定它**在哪跑**。
 *
 * 所以授予 `remote-trusted` **不等于**授予网络权限；两者必须都满足。
 */
export type TrustLevel = 'signed' | 'restricted' | 'remote-trusted';

export const TRUST_LEVELS: readonly TrustLevel[] = ['signed', 'restricted', 'remote-trusted'];

export const TRUST_LABELS: Record<TrustLevel, string> = {
  signed: '已验签',
  restricted: '受限模式',
  'remote-trusted': '已信任远程代码',
};

// ------------------------------------------------------------ 已授予权限集

/**
 * **归一化**后的已授予权限集。
 *
 * 为什么不用 manifest 的原始形状：manifest 里全是可选的，
 * 每次判定都要 `?.` 一遍既啰嗦又容易漏。归一化成确定形状后，判定就是纯查表。
 */
export interface GrantedPermissions {
  dataWrite: ReadonlySet<string>;
  dataRead: ReadonlySet<string>;
  netDomains: readonly string[];
  netMethods: ReadonlySet<string>;
  authProviders: ReadonlySet<string>;
  notify: boolean;
  backgroundPeriodic: boolean;
  backgroundExact: boolean;
  secrets: boolean;
  fs: 'none' | 'sandbox';
  uiComponents: ReadonlySet<string>;
  uiSlots: ReadonlySet<string>;
  dbRaw: boolean;
  llmLocal: boolean;
  /** 二期能力，默认 false */
  stream: boolean;
  /**
   * 宿主提供的本地资源（用户选的文件、剪贴板、分享进来的文本）。
   * 对应 `PlannedRequest.source === 'host'`。
   */
  local: boolean;
}

export function normalizePermissions(p: ManifestPermissions | undefined): GrantedPermissions {
  return {
    dataWrite: new Set(p?.data?.write ?? []),
    dataRead: new Set(p?.data?.read ?? []),
    netDomains: Object.freeze([...(p?.net?.domains ?? [])]),
    netMethods: new Set(p?.net?.methods ?? []),
    authProviders: new Set(p?.auth?.providers ?? []),
    notify: p?.notify === true,
    backgroundPeriodic: p?.background?.periodic === true,
    backgroundExact: p?.background?.exact === true,
    secrets: p?.secrets === true,
    fs: p?.fs === 'sandbox' ? 'sandbox' : 'none',
    uiComponents: new Set(p?.ui?.components ?? []),
    uiSlots: new Set(p?.ui?.slots ?? []),
    dbRaw: p?.db?.raw === true,
    llmLocal: p?.llm?.local === true,
    stream: p?.stream === true,
    local: p?.local === true,
  };
}

/** 权限集为空（受限模式下的默认授予） */
export function emptyPermissions(): GrantedPermissions {
  return normalizePermissions(undefined);
}

// ------------------------------------------------------------ 子集关系

export interface SubsetViolation {
  field: string;
  value: string;
}

/**
 * 校验 `granted ⊆ declared`。
 *
 * 这条不变式必须由**宿主**强制，不能信前端安装页 ——
 * 安装页只是 UI，用户可以改它，但改不出声明的权限之外的东西。
 * 这里返回的是「用户批了什么、作者没声明什么」，属于**篡改迹象**，要写审计。
 */
export function intersectPermissions(
  declared: ManifestPermissions | undefined,
  requested: ManifestPermissions | undefined,
): PluginResult<GrantedPermissions> {
  const d = normalizePermissions(declared);
  const r = normalizePermissions(requested);
  const bad: SubsetViolation[] = [];

  const subset = (name: string, req: ReadonlySet<string>, dec: ReadonlySet<string>) => {
    for (const v of req) if (!dec.has(v)) bad.push({ field: name, value: v });
  };

  subset('data.write', r.dataWrite, d.dataWrite);
  subset('data.read', r.dataRead, d.dataRead);
  subset('auth.providers', r.authProviders, d.authProviders);
  subset('ui.components', r.uiComponents, d.uiComponents);
  subset('ui.slots', r.uiSlots, d.uiSlots);
  subset('net.methods', r.netMethods, d.netMethods);

  // 域名是列表不是集合，单独比
  const declaredDomains = new Set(d.netDomains);
  for (const dom of r.netDomains) {
    if (!declaredDomains.has(dom)) bad.push({ field: 'net.domains', value: dom });
  }

  // 布尔位只能「要更少」，不能「要更多」
  if (r.notify && !d.notify) bad.push({ field: 'notify', value: 'true' });
  if (r.backgroundPeriodic && !d.backgroundPeriodic) bad.push({ field: 'background.periodic', value: 'true' });
  if (r.backgroundExact && !d.backgroundExact) bad.push({ field: 'background.exact', value: 'true' });
  if (r.secrets && !d.secrets) bad.push({ field: 'secrets', value: 'true' });
  if (r.dbRaw && !d.dbRaw) bad.push({ field: 'db.raw', value: 'true' });
  if (r.llmLocal && !d.llmLocal) bad.push({ field: 'llm.local', value: 'true' });
  if (r.stream && !d.stream) bad.push({ field: 'stream', value: 'true' });
  if (r.local && !d.local) bad.push({ field: 'local', value: 'true' });
  if (r.fs === 'sandbox' && d.fs !== 'sandbox') bad.push({ field: 'fs', value: 'sandbox' });

  if (bad.length > 0) {
    return fail('EPERM', '授予的权限超出 manifest 声明的范围（可能是被篡改的安装请求）', {
      violations: bad.map((b) => `${b.field}=${b.value}`),
    });
  }
  return ok(r);
}

// ------------------------------------------------------------ 域名匹配

/**
 * 归一化主机名：小写、去**全部**尾点。
 * 与核心层 `normalizeHost` 逐字一致 —— 只去一个尾点就是绕过手段。
 */
export function normalizeHost(host: string): string {
  let h = host.toLowerCase();
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/** 是否是 IP 字面量（含非点分写法）。与核心层 `isIpLiteral` 一致。 */
export function isIpLiteral(host: string): boolean {
  const h = normalizeHost(host);
  if (!h) return true;
  if (h.startsWith('[') || h.includes(':')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (/^(0x[0-9a-f]+|\d+)$/.test(h)) return true;
  if (/^[\d.]+$/.test(h)) return true;
  return false;
}

/**
 * 主机是否命中**插件的**域名声明。
 *
 * `*.example.com` 匹配 `a.example.com`，**不匹配** `example.com` ——
 * 根域与子域是不同信任级别（与核心层同规则）。
 */
export function matchDomainPattern(host: string, patterns: readonly string[]): boolean {
  const h = normalizeHost(host);
  if (!h || isIpLiteral(h)) return false;

  for (const raw of patterns) {
    const wildcard = raw.startsWith('*.');
    const ruleHost = normalizeHost(wildcard ? raw.slice(2) : raw);
    if (!ruleHost) continue;
    if (!wildcard) {
      if (h === ruleHost) return true;
      continue;
    }
    if (h.length > ruleHost.length + 1 && h.endsWith(`.${ruleHost}`)) return true;
  }
  return false;
}

export interface ParsedTarget {
  /** 归一化后的主机名 */
  host: string;
  /** 仅路径与查询串 —— 审计里不放完整 URL，免得把敏感参数写进日志 */
  path: string;
}

/**
 * 解析并校验插件给出的 URL。
 *
 * 策略与核心层 `parseTarget` **逐字一致**：只允许 https、拒绝 userinfo、拒绝 IP 字面量。
 * 这是「声明层」的早失败；真正的强制点仍是核心层网关（纵深防御，不是二选一）。
 * 两边的一致性由 conformance.test.ts 的差分测试守着。
 */
export function parsePluginTarget(raw: string): PluginResult<ParsedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('EURL', `URL 无法解析: ${raw}`);
  }
  if (url.protocol !== 'https:') {
    return fail('EURL', `只允许 https，收到 ${url.protocol}`);
  }
  if (url.username || url.password) {
    return fail('EURL', 'URL 不允许包含 userinfo（user:pass@host）');
  }
  const host = normalizeHost(url.hostname);
  if (!host) return fail('EURL', 'URL 缺少主机名');
  if (isIpLiteral(host)) {
    return fail('EIP', `不允许直接访问 IP 字面量: ${host}`);
  }
  return ok({ host, path: `${url.pathname}${url.search}` });
}

/** 便捷包装：只关心主机名时用它（IP 字面量会返回 null） */
export function hostOf(rawUrl: string): string | null {
  const r = parsePluginTarget(rawUrl);
  return r.ok ? r.data.host : null;
}

// ------------------------------------------------------------ RPC 方法

export type RpcMethod =
  | 'db.get' | 'db.query' | 'db.put' | 'db.delete' | 'db.raw'
  | 'bus.emit' | 'bus.read'
  | 'net.request'
  | 'local.request'
  | 'auth.login'
  | 'notify.local'
  | 'schedule.periodic' | 'schedule.exact'
  | 'secrets.get' | 'secrets.set' | 'secrets.delete'
  | 'fs.read' | 'fs.write' | 'fs.list'
  | 'ui.registerComponent'
  | 'llm.complete'
  | 'trust.evalRemote' | 'trust.loadModule';

export const RPC_METHODS: readonly RpcMethod[] = [
  'db.get', 'db.query', 'db.put', 'db.delete', 'db.raw',
  'bus.emit', 'bus.read',
  'net.request',
  'local.request',
  'auth.login',
  'notify.local',
  'schedule.periodic', 'schedule.exact',
  'secrets.get', 'secrets.set', 'secrets.delete',
  'fs.read', 'fs.write', 'fs.list',
  'ui.registerComponent',
  'llm.complete',
  'trust.evalRemote', 'trust.loadModule',
];

export interface PermissionContext {
  manifest: Manifest;
  granted: GrantedPermissions;
  trustLevel: TrustLevel;
}

export type PermissionVerdict =
  | { ok: true }
  | { ok: false; code: PluginErrorCode; message: string };

const allow: PermissionVerdict = { ok: true };
const deny = (code: PluginErrorCode, message: string): PermissionVerdict => ({ ok: false, code, message });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * 判定一次 RPC 调用是否被允许。
 *
 * 注意：这里**只管权限与信任**，不管配额、频次、Schema 校验、路径白名单 ——
 * 那些是执行期的附加约束，由核心层与 kernel 在执行时施加（见 §5.3 第三列）。
 */
export function checkPermission(
  ctx: PermissionContext,
  method: string,
  args?: unknown,
): PermissionVerdict {
  const { granted: g, trustLevel } = ctx;
  const a = isRecord(args) ? args : {};

  switch (method) {
    // --- 数据库：隐式允许，但只能碰自己的命名空间
    // 命名空间隔离由核心层的 Vault / 表名前缀强制，这里不判。
    case 'db.get':
    case 'db.query':
    case 'db.put':
    case 'db.delete':
      return allow;

    case 'db.raw':
      // §5.3：默认拒绝，需人工审核 + 签名白名单
      if (!g.dbRaw) {
        return deny('EPERM', 'db.raw 需要显式声明并人工审核，默认拒绝');
      }
      return allow;

    // --- 数据总线
    case 'bus.emit': {
      const t = str(a.entityType);
      if (!t) return deny('ESCHEMA', 'bus.emit 必须给出 entityType');
      if (!g.dataWrite.has(t)) {
        return deny('EPERM', `未声明 data.write: ${t}`);
      }
      return allow;
    }
    case 'bus.read': {
      const t = str(a.entityType);
      if (!t) return deny('ESCHEMA', 'bus.read 必须给出 entityType');
      if (!g.dataRead.has(t)) {
        return deny('EPERM', `未声明 data.read: ${t}`);
      }
      return allow;
    }

    // --- 网络：唯一的出网口，且必须落在插件自己声明的域名内
    case 'net.request': {
      const url = str(a.url);
      if (!url) return deny('ESCHEMA', 'net.request 必须给出 url');

      // EURL / EIP 统一映射成 ENETDENIED，但保留可读原因
      const target = parsePluginTarget(url);
      if (!target.ok) return deny('ENETDENIED', target.message);

      const host = target.data.host;
      if (!matchDomainPattern(host, g.netDomains)) {
        return deny('ENETDENIED', `主机不在插件声明的域名内: ${host}`);
      }

      const m = str(a.method).toUpperCase() || 'GET';
      if (g.netMethods.size > 0 && !g.netMethods.has(m)) {
        return deny('ENETDENIED', `未声明该 HTTP 方法: ${m}`);
      }
      return allow;
    }

    // --- 认证：插件不接触凭证，只发起宿主托管的登录
    case 'auth.login': {
      const p = str(a.provider);
      if (!p) return deny('ESCHEMA', 'auth.login 必须给出 provider');
      if (!g.authProviders.has(p)) {
        return deny('EPERM', `未声明 auth.providers: ${p}`);
      }
      return allow;
    }

    // --- 通知
    case 'notify.local':
      if (!g.notify) return deny('EPERM', '未声明 notify');
      return allow;

    // --- 调度
    case 'schedule.periodic':
      if (!g.backgroundPeriodic) return deny('EPERM', '未声明 background.periodic');
      return allow;
    case 'schedule.exact':
      if (!g.backgroundExact) {
        // §5.3：需系统授权，否则自动降级 —— 降级由调用方处理，这里只判声明
        return deny('EPERM', '未声明 background.exact');
      }
      return allow;

    // --- 密钥：命名空间隔离由 Vault 强制
    case 'secrets.get':
    case 'secrets.set':
    case 'secrets.delete':
      if (!g.secrets) return deny('EPERM', '未声明 secrets');
      return allow;

    // --- 文件系统
    case 'fs.read':
    case 'fs.write':
    case 'fs.list':
      if (g.fs !== 'sandbox') return deny('EPERM', '未声明 fs: "sandbox"');
      return allow;

    // --- UI 组件
    case 'ui.registerComponent': {
      const c = str(a.component);
      if (!c) return deny('ESCHEMA', 'ui.registerComponent 必须给出 component');
      if (!g.uiComponents.has(c)) return deny('EPERM', `未声明 ui.components: ${c}`);
      return allow;
    }

    // --- 本地推理
    case 'llm.complete':
      if (!g.llmLocal) return deny('EPERM', '未声明 llm.local');
      return allow;

    // --- 信任：这里同时用到「权限」与「信任」两把锁（I4）
    case 'trust.evalRemote': {
      if (!ctx.manifest.capabilities?.remoteCode) {
        return deny('ETRUST', 'manifest 未声明 capabilities.remoteCode');
      }
      if (trustLevel !== 'remote-trusted') {
        return deny('ETRUST', '信任等级不足：需要用户显式授予「已信任远程代码」');
      }
      return allow;
    }
    case 'trust.loadModule': {
      const id = str(a.pluginId);
      if (!id) return deny('ESCHEMA', 'trust.loadModule 必须给出 pluginId');
      if (!(ctx.manifest.dependencies ?? []).includes(id)) {
        return deny('EPERM', `未在 manifest dependencies 中声明: ${id}`);
      }
      // I5：用**调用方自己的权限**执行被加载的代码，因此不存在权限提升。
      // 目标是否已安装、是否已验签，由 kernel 在加载时检查。
      return allow;
    }

    case 'local.request': {
      // 宿主提供的本地资源。注意它**不查域名白名单** —— 它根本不出网。
      // 隔离靠的是宿主侧按 (pluginId, url) 分键，不是靠这里。
      if (!ctx.granted.local) return deny('EPERM', '未声明 permissions.local');
      return allow;
    }

    default:
      // 默认拒绝：表里没有的方法
      return deny('EPERM', `未知或未开放的方法: ${method}`);
  }
}

/** 受限模式下被硬性阻断的方法（§5.7：remoteCode.origins 上的网络请求也要拦） */
export function isBlockedInRestrictedMode(ctx: PermissionContext, method: string, args?: unknown): boolean {
  if (ctx.trustLevel !== 'restricted') return false;
  if (method === 'trust.evalRemote') return true;

  if (method === 'net.request') {
    const a = isRecord(args) ? args : {};
    const host = hostOf(str(a.url));
    if (!host) return false;
    const remoteOrigins = ctx.manifest.capabilities?.remoteCode?.origins ?? [];
    // 受限模式下，通向「远程代码来源域」的请求一律拦 ——
    // 因为那些响应会变成可执行代码，而用户还没批准
    return matchDomainPattern(host, remoteOrigins);
  }
  return false;
}

/** 便捷入口：先查受限模式硬拦，再查权限矩阵 */
export function authorize(
  ctx: PermissionContext,
  method: string,
  args?: unknown,
): PermissionVerdict {
  if (isBlockedInRestrictedMode(ctx, method, args)) {
    return deny('ETRUST', '受限模式：该操作需要先授予「已信任远程代码」');
  }
  return checkPermission(ctx, method, args);
}

/** 供安装确认页展示：把声明翻译成人类可读的条目 */
export function describePermissions(p: ManifestPermissions | undefined): string[] {
  const g = normalizePermissions(p);
  const out: string[] = [];
  if (g.dataWrite.size) out.push(`写入数据：${[...g.dataWrite].join('、')}`);
  if (g.dataRead.size) out.push(`读取数据：${[...g.dataRead].join('、')}`);
  if (g.netDomains.length) out.push(`访问网络：${g.netDomains.join('、')}`);
  if (g.authProviders.size) out.push(`使用登录方式：${[...g.authProviders].join('、')}`);
  if (g.local) out.push('读取你主动提供的本地文件');
  if (g.notify) out.push('发送本地通知');
  if (g.backgroundPeriodic) out.push('后台定期运行');
  if (g.backgroundExact) out.push('精确定时唤醒');
  if (g.secrets) out.push('保存密钥（仅限自身）');
  if (g.fs === 'sandbox') out.push('读写自身沙箱目录内的文件');
  if (g.uiComponents.size) out.push(`注册界面组件：${[...g.uiComponents].join('、')}`);
  if (g.dbRaw) out.push('执行原生 SQL（高风险）');
  if (g.llmLocal) out.push('使用本地推理');
  if (g.stream) out.push('流式处理响应（二期能力）');
  if (out.length === 0) out.push('（无额外权限）');
  return out;
}
