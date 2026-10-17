/**
 * 核心层的**唯一窄入口**（不变量 I10）。
 *
 * 外面（插件、UI）只能通过 `Core.call(token, method, payload)` 进来。
 * 方法名走白名单派发，且用 `Object.hasOwn` 判定 —— 不是裸 `obj[key]` 真值判断。
 * 后者会被 `__proto__` / `constructor` 直接绕过（P0-S1 实测复现过，见 §5.5.2）。
 *
 * 为什么是「一个入口」而不是「一堆导出函数」：
 * 入口越少，需要审查的面越小。将来接原生桥时，也只需要把这一个方法暴露过去。
 */

import { AuditLog } from './audit.ts';
import { NetGateway, type GatewayDeps, type GatewayStatus } from './gateway.ts';
import { MemorySessions } from './session.ts';
import { CapacitorCookiesSession } from './session-capacitor.ts';
import { CapabilityRegistry } from './tokens.ts';
import { CapacitorTransport, MockTransport, transportAvailable } from './transport.ts';
import { Vault, type VaultBackend, type VaultEntryInfo } from './vault.ts';
import { CoreError, type Capability, type NetRequest, type NetResponse, type Transport } from './types.ts';

/**
 * 会话后端。
 *   · `memory` —— cookie 只存在 JS 内存里，插件之间完全隔离（默认）
 *   · `capacitor-cookies` —— 走原生全局存储，能精确撤销，但跨插件共享
 * 取舍详见 DESIGN.md §8.2。
 */
export type SessionBackend = 'memory' | 'capacitor-cookies';

export interface CoreOptions {
  /** vault 的底层存储。不传则 vault 不可用（能力校验会拒掉相关调用） */
  vaultBackend?: VaultBackend;
  /** 传输层。不传则按环境自动选（原生优先，其次 mock） */
  transport?: Transport;
  gateway?: Partial<Omit<GatewayDeps, 'transport' | 'tokens' | 'audit'>>;
  auditCapacity?: number;
  auditSink?: (entry: Parameters<AuditLog['record']>[0]) => void;
  now?: () => number;
}

/** 派发用的方法表。null 原型：避免继承属性被当成方法命中 */
const METHODS: Record<string, true> | null = Object.assign(Object.create(null) as Record<string, true>, {
  'net.request': true,
  'net.check': true,
  'vault.get': true,
  'vault.set': true,
  'vault.remove': true,
  'vault.list': true,
  'vault.clear': true,
});

export class Core {
  readonly tokens: CapabilityRegistry;
  readonly audit: AuditLog;
  readonly net: NetGateway;
  readonly sessions: MemorySessions;
  private readonly nativeSessions: CapacitorCookiesSession;
  private sessionBackend: SessionBackend = 'memory';
  private readonly vaultImpl: Vault | null;

  constructor(opts: CoreOptions = {}) {
    this.tokens = new CapabilityRegistry(opts.now);
    this.audit = new AuditLog(opts.auditCapacity ?? 500, opts.auditSink);
    this.sessions = new MemorySessions();
    this.nativeSessions = new CapacitorCookiesSession();

    const transport = opts.transport ?? defaultTransport();
    this.net = new NetGateway({
      transport,
      tokens: this.tokens,
      audit: this.audit,
      sessions: this.sessions,
      ...opts.gateway,
    });

    this.vaultImpl = opts.vaultBackend ? new Vault(opts.vaultBackend, this.tokens) : null;
  }

  /**
   * 切换会话后端。
   *
   * 这个开关存在的**唯一理由**是让差异可见：`CapacitorHttp` 的原生 cookie 存储
   * 是进程全局的，两种后端的实际行为不同（见 §8.2）。默认用 `memory`，
   * 因为它的隔离性更好。
   */
  setSessionBackend(kind: SessionBackend): void {
    this.sessionBackend = kind;
    this.net.setSessionProvider(kind === 'capacitor-cookies' ? this.nativeSessions : this.sessions);
  }

  get session(): { backend: SessionBackend; kind: string; stats?: { sessions: number; failures: number } } {
    return {
      backend: this.sessionBackend,
      kind: this.net.sessionKind,
      ...(this.sessionBackend === 'capacitor-cookies' ? { stats: this.nativeSessions.stats } : {}),
    };
  }

  /** 精确撤销某个会话写入的 cookie（登出）。仅 `capacitor-cookies` 后端支持 */
  async revokeSession(sessionId: string): Promise<number> {
    if (this.sessionBackend !== 'capacitor-cookies') return 0;
    return this.nativeSessions.clear(sessionId);
  }

  /** 暴露给调试面板的只读状态 */
  status(): {
    transport: string;
    transportAvailable: boolean;
    gateway: GatewayStatus;
    vault: { available: boolean; protection: string; note: string };
    tokens: number;
    audit: ReturnType<AuditLog['stats']>;
  } {
    return {
      transport: this.net.status().transport,
      transportAvailable: transportAvailable(),
      gateway: this.net.status(),
      vault: this.vaultImpl
        ? { available: true, protection: this.vaultImpl.protection, note: this.vaultImpl.protectionNote }
        : { available: false, protection: 'none', note: '未装配 vault 后端' },
      tokens: this.tokens.activeCount,
      audit: this.audit.stats(),
    };
  }

  /**
   * 唯一入口。
   *
   * @param tokenId 能力令牌。每次调用都要出示，**不看 frame origin**
   *                （Android 的 addJavascriptInterface 会注入所有 frame，origin 不可信）
   */
  async call(tokenId: string | null | undefined, method: string, payload?: unknown): Promise<unknown> {
    // I11：用 hasOwn + null 原型表，而不是 `METHODS[method]` 的真值判断
    if (!Object.hasOwn(METHODS as object, method)) {
      throw new CoreError('EAUTH', `未知的核心方法: ${String(method)}`);
    }

    switch (method) {
      case 'net.request':
        return this.net.request(tokenId, (payload ?? {}) as NetRequest) as Promise<NetResponse>;

      case 'net.check':
        // 只判定不发请求，不需要 net 能力（否则调试面板自己都查不了）
        return this.net.check(String((payload as { url?: string } | undefined)?.url ?? ''));

      case 'vault.get':
      case 'vault.set':
      case 'vault.remove':
      case 'vault.list':
      case 'vault.clear':
        return this.callVault(tokenId, method, payload);

      default:
        // 上面的 hasOwn 已挡住未知方法，走到这里说明表与 switch 不同步
        throw new CoreError('EAUTH', `核心方法未接线: ${method}`);
    }
  }

  private async callVault(
    tokenId: string | null | undefined,
    method: string,
    payload: unknown,
  ): Promise<unknown> {
    const v = this.vaultImpl;
    if (!v) throw new CoreError('EAUTH', 'vault 未装配后端，不可用');

    const p = (payload ?? {}) as { key?: string; value?: string };
    switch (method) {
      case 'vault.get':
        return v.get(tokenId, String(p.key ?? ''));
      case 'vault.set':
        await v.set(tokenId, String(p.key ?? ''), String(p.value ?? ''));
        return true;
      case 'vault.remove':
        await v.remove(tokenId, String(p.key ?? ''));
        return true;
      case 'vault.list':
        return v.list(tokenId) as Promise<VaultEntryInfo[]>;
      case 'vault.clear':
        return v.clear(tokenId);
      default:
        throw new CoreError('EAUTH', `vault 方法未接线: ${method}`);
    }
  }

  /** 便捷方法，仅供**本进程内的可信代码**（UI 层）使用，插件拿不到 */
  issueToken(pluginId: string, caps: readonly Capability[], ttlMs?: number) {
    return this.tokens.issue(pluginId, caps, ttlMs);
  }
}

function defaultTransport(): Transport {
  if (transportAvailable()) return new CapacitorTransport();
  // 纯 Web dev 且插件未注册时给一个显式的空传输，避免静默发真实请求
  return new MockTransport({ status: 503, body: 'no transport available' });
}

export function createCore(opts: CoreOptions = {}): Core {
  return new Core(opts);
}

export { CoreError, errorCode } from './types.ts';
export type { Capability, NetRequest, NetResponse } from './types.ts';
export type { AuditEntry } from './types.ts';
export type { VaultBackend, VaultEntryInfo } from './vault.ts';
export { MockTransport, CapacitorTransport } from './transport.ts';
export { MemorySessions, type SessionProvider } from './session.ts';
export { CapacitorCookiesSession } from './session-capacitor.ts';
