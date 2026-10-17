/**
 * 内核 —— 信任状态机（DESIGN.md §5.7）
 *
 * **权限与信任是两件正交的事**（I4）：
 *   · 权限回答「能做什么」—— 安装时确认，绑定在**沙箱实例**上。
 *   · 信任回答「插件里跑的代码是否被审核过」—— 决定代码**能不能进来**，不决定它**在哪里跑**。
 *
 * 所以本文件**不碰权限**。它只维护 `plugin_registry.trust_level` 这个状态。
 *
 * 三个等级：
 *   `signed`          包内**全部可执行代码**被 Ed25519 签名覆盖 → 正常激活
 *   `restricted`      存在未签名的代码路径且用户未授权 → 只激活声明式视图与自身数据读写
 *   `remote-trusted`  用户对该插件**显式**授予 → 允许加载并执行声明的远程代码（仍在沙箱内，I6）
 *
 * 三条工程要求（§5.7）落在这里：
 *   1. 信任状态常驻可见 → `snapshot()` 供 UI 随时读，`badgeFor()` 给出徽章文案
 *   2. 授予时必须列出「来源域名 + 为什么需要 + 风险」→ `grantRemote` 强制要求
 *      manifest 里写了 `capabilities.remoteCode.reason`（manifest 校验已强制），
 *      并把 origins 一并带进变更记录，UI 直接用
 *   3. 首次运行第三方插件先给统一说明页 → 由 UI 负责，内核只保证
 *      `isFirstRemoteGrant(pluginId)` 能问出「这是不是第一次」
 *
 * 每次变更写审计并**触发插件重载** —— 重载信号通过 `onChange` 抛出，由 registry 订阅。
 */

import {
  TRUST_LABELS,
  type PluginResult,
  type TrustLevel,
  fail,
  ok,
} from '@matrix/plugin-api';

export { TRUST_LABELS };
export type { TrustLevel };

/** 信任判定的输入 —— 全部是**事实**，不是结论 */
export interface TrustInput {
  /** 包内全部可执行代码是否被签名覆盖 */
  fullySigned: boolean;
  /** manifest 是否声明了远程代码路径（`capabilities.remoteCode`） */
  hasRemoteCode: boolean;
  /** 用户是否**显式**授予了「已信任远程代码」 */
  remoteCodeGranted: boolean;
}

/**
 * 由事实推出等级。
 *
 * 注意顺序：先看「远程代码 + 已授权」再看签名 ——
 * 因为一个声明了远程代码的插件，即便主包已验签，也仍然有**未签名的代码路径**，
 * 所以未授权时必须是 `restricted`，不能因为主包签了就放成 `signed`。
 */
export function deriveTrustLevel(i: TrustInput): TrustLevel {
  if (i.hasRemoteCode && i.remoteCodeGranted) return 'remote-trusted';
  if (!i.fullySigned || i.hasRemoteCode) return 'restricted';
  return 'signed';
}

export interface TrustRecord {
  pluginId: string;
  level: TrustLevel;
  /** epoch ms */
  updatedAt: number;
  /** 该等级是怎么来的 —— 给用户看的短句 */
  reason: string;
  /** 受限模式下不读写的配置项（manifest 声明） */
  restrictedSettings: readonly string[];
  /** 远程代码来源域（授予时展示给用户） */
  remoteOrigins: readonly string[];
  /** 用户是否显式授予过远程代码信任 */
  remoteCodeGranted: boolean;
  /** 是否曾经授予过 —— 用于「首次运行先给统一说明页」 */
  everGranted: boolean;
}

export interface TrustChange {
  pluginId: string;
  from: TrustLevel | null;
  to: TrustLevel;
  at: number;
  /** 谁改的 */
  actor: 'user' | 'system';
  reason: string;
}

export interface TrustAuditSink {
  (entry: {
    at: number;
    pluginId: string;
    action: string;
    from: TrustLevel | null;
    to: TrustLevel;
    actor: 'user' | 'system';
    reason: string;
  }): void;
}

/** 持久化后端。内核不关心它落在 SQLite 还是 Preferences。 */
export interface TrustBackend {
  load(): Promise<unknown>;
  save(records: TrustRecord[]): Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseRecord(raw: unknown): TrustRecord | null {
  if (!isRecord(raw)) return null;
  const id = raw.pluginId;
  const level = raw.level;
  if (typeof id !== 'string' || id === '') return null;
  if (level !== 'signed' && level !== 'restricted' && level !== 'remote-trusted') return null;
  return {
    pluginId: id,
    level,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    restrictedSettings: Array.isArray(raw.restrictedSettings)
      ? raw.restrictedSettings.filter((x): x is string => typeof x === 'string')
      : [],
    remoteOrigins: Array.isArray(raw.remoteOrigins)
      ? raw.remoteOrigins.filter((x): x is string => typeof x === 'string')
      : [],
    remoteCodeGranted: raw.remoteCodeGranted === true,
    everGranted: raw.everGranted === true,
  };
}

/**
 * 允许的信任迁移。
 *
 * 刻意做得很窄 —— 信任是安全决策，不该有「顺手」的隐式迁移：
 *   · 任何等级都能降到 `restricted`（撤销、重验签失败、发现未签名代码）
 *   · 任何等级都能升到 `remote-trusted`，但**只能**经 `grantRemote()`（用户显式）
 *   · 只有在确实全签名且无远程代码时才能是 `signed`
 */
const ALLOWED_TRANSITIONS: Record<TrustLevel, readonly TrustLevel[]> = {
  signed: ['restricted', 'remote-trusted'],
  restricted: ['signed', 'remote-trusted'],
  'remote-trusted': ['restricted', 'signed'],
};

export function canTransition(from: TrustLevel, to: TrustLevel): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface TrustStoreOptions {
  backend?: TrustBackend;
  audit?: TrustAuditSink;
  now?: () => number;
}

export class TrustStore {
  private readonly records = new Map<string, TrustRecord>();
  private readonly history = new Map<string, TrustChange[]>();
  private readonly backend: TrustBackend | undefined;
  private readonly audit: TrustAuditSink | undefined;
  private readonly clock: () => number;
  private readonly listeners = new Set<(c: TrustChange) => void>();

  constructor(opts: TrustStoreOptions = {}) {
    this.backend = opts.backend;
    this.audit = opts.audit;
    this.clock = opts.now ?? (() => Date.now());
  }

  /** 装载持久化状态；返回装载条数。坏数据静默丢弃并计数（在返回值里） */
  async load(): Promise<{ loaded: number; dropped: number }> {
    if (!this.backend) return { loaded: 0, dropped: 0 };
    const raw = await this.backend.load();
    if (!Array.isArray(raw)) return { loaded: 0, dropped: 0 };

    let loaded = 0;
    let dropped = 0;
    for (const item of raw) {
      const rec = parseRecord(item);
      if (!rec) {
        dropped += 1;
        continue;
      }
      this.records.set(rec.pluginId, rec);
      loaded += 1;
    }
    return { loaded, dropped };
  }

  /** 订阅信任变更 —— registry 用它触发插件重载 */
  onChange(fn: (c: TrustChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get(pluginId: string): TrustRecord | undefined {
    return this.records.get(pluginId);
  }

  levelOf(pluginId: string): TrustLevel {
    return this.records.get(pluginId)?.level ?? 'restricted';
  }

  /** 徽章文案（工程要求 1：信任状态常驻可见） */
  badgeFor(pluginId: string): { level: TrustLevel; label: string; hint: string } {
    const rec = this.records.get(pluginId);
    const level = rec?.level ?? 'restricted';
    return { level, label: TRUST_LABELS[level], hint: rec?.reason ?? '尚未登记' };
  }

  /** 是否曾经授予过远程代码信任（工程要求 3：首次运行给统一说明页） */
  isFirstRemoteGrant(pluginId: string): boolean {
    return this.records.get(pluginId)?.everGranted !== true;
  }

  /** 受限模式下不读写的配置项 */
  restrictedSettings(pluginId: string): readonly string[] {
    return this.records.get(pluginId)?.restrictedSettings ?? [];
  }

  historyFor(pluginId: string): readonly TrustChange[] {
    return this.history.get(pluginId) ?? [];
  }

  snapshot(): TrustRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  /**
   * 登记/刷新一个插件的信任基线（安装、或重新验签时调用）。
   *
   * 与 `grantRemote` 的区别：这里**不接受**用户授权，只反映事实。
   * 如果当前是 `remote-trusted` 而这次验签发现主包不再全签名，
   * 会保留用户的授权（授权是用户的决定，不该被一次验签悄悄抹掉），
   * 但把 reason 更新为当前事实。
   */
  async register(
    pluginId: string,
    input: TrustInput,
    extra: { restrictedSettings?: string[]; remoteOrigins?: string[] } = {},
  ): Promise<PluginResult<TrustRecord>> {
    const prev = this.records.get(pluginId);
    const wasGranted = prev?.remoteCodeGranted ?? false;

    // 已授予过的，注册时继续保持授予状态
    const level = deriveTrustLevel({
      ...input,
      remoteCodeGranted: wasGranted && input.hasRemoteCode,
    });

    const reason = describeLevel(level, input, wasGranted && input.hasRemoteCode);

    const record: TrustRecord = {
      pluginId,
      level,
      updatedAt: this.clock(),
      reason,
      restrictedSettings: extra.restrictedSettings ?? prev?.restrictedSettings ?? [],
      remoteOrigins: extra.remoteOrigins ?? prev?.remoteOrigins ?? [],
      remoteCodeGranted: wasGranted && input.hasRemoteCode,
      everGranted: prev?.everGranted === true,
    };

    return this.commit(record, prev ?? null, 'system', reason);
  }

  /**
   * 用户显式授予「已信任远程代码」。
   *
   * 前置条件（任一不满足即 `ETRUST`）：
   *   · manifest 确实声明了 `capabilities.remoteCode`
   *   · 至少有一个来源域（否则用户批了个空东西）
   */
  async grantRemote(pluginId: string): Promise<PluginResult<TrustRecord>> {
    const prev = this.records.get(pluginId);
    if (!prev) return fail('ENOTFOUND', `未登记的插件: ${pluginId}`);

    if (prev.remoteOrigins.length === 0) {
      return fail('ETRUST', '该插件未声明远程代码来源域，无需授予远程代码信任');
    }
    if (!canTransition(prev.level, 'remote-trusted')) {
      return fail('ETRUST', `不允许的信任迁移: ${prev.level} → remote-trusted`);
    }

    const record: TrustRecord = {
      ...prev,
      level: 'remote-trusted',
      updatedAt: this.clock(),
      reason: '用户已显式信任该插件的远程代码',
      remoteCodeGranted: true,
      everGranted: true,
    };

    return this.commit(record, prev, 'user', record.reason);
  }

  /** 撤销远程代码信任 —— 回到 `restricted`（若全签名则可回 `signed`，由 register 决定） */
  async revokeRemote(pluginId: string): Promise<PluginResult<TrustRecord>> {
    const prev = this.records.get(pluginId);
    if (!prev) return fail('ENOTFOUND', `未登记的插件: ${pluginId}`);
    if (!prev.remoteCodeGranted) {
      return fail('ETRUST', '该插件当前并未获得远程代码信任');
    }

    const record: TrustRecord = {
      ...prev,
      level: 'restricted',
      updatedAt: this.clock(),
      reason: '用户已撤销远程代码信任',
      remoteCodeGranted: false,
      everGranted: true,
    };

    return this.commit(record, prev, 'user', record.reason);
  }

  /** 卸载时清掉记录 */
  async forget(pluginId: string): Promise<void> {
    this.records.delete(pluginId);
    this.history.delete(pluginId);
    await this.persist();
  }

  private async commit(
    record: TrustRecord,
    prev: TrustRecord | null,
    actor: 'user' | 'system',
    reason: string,
  ): Promise<PluginResult<TrustRecord>> {
    if (prev && !canTransition(prev.level, record.level)) {
      return fail('ETRUST', `不允许的信任迁移: ${prev.level} → ${record.level}`);
    }

    const changed = !prev || prev.level !== record.level;
    this.records.set(record.pluginId, record);

    if (changed) {
      const change: TrustChange = {
        pluginId: record.pluginId,
        from: prev?.level ?? null,
        to: record.level,
        at: record.updatedAt,
        actor,
        reason,
      };
      const h = this.history.get(record.pluginId) ?? [];
      h.push(change);
      // 只留最近 20 条，避免无限增长
      if (h.length > 20) h.splice(0, h.length - 20);
      this.history.set(record.pluginId, h);

      this.audit?.({
        at: change.at,
        pluginId: change.pluginId,
        action: 'trust.change',
        from: change.from,
        to: change.to,
        actor,
        reason,
      });

      for (const fn of this.listeners) fn(change);
      await this.persist();
    }

    return ok({ ...record });
  }

  private async persist(): Promise<void> {
    if (!this.backend) return;
    await this.backend.save(this.snapshot());
  }
}

function describeLevel(level: TrustLevel, input: TrustInput, granted: boolean): string {
  if (level === 'remote-trusted') {
    // 徽章上要同时说清两件事：用户批了，以及主包**现在**是否还全签名。
    // 只写「已信任」会让用户以为一切都验过签了。
    return input.fullySigned
      ? '用户已显式信任该插件的远程代码'
      : '用户已显式信任该插件的远程代码（主包未完全验签）';
  }
  if (level === 'signed') return '包内全部可执行代码均已验签';
  if (granted && !input.fullySigned) return '曾获授权，但主包未完全验签';
  if (input.hasRemoteCode) return '声明了远程代码，用户尚未授权';
  return '存在未签名的代码路径';
}

/** 内存后端 —— 测试与「不落盘」场景用 */
export class MemoryTrustBackend implements TrustBackend {
  private data: unknown = [];

  async load(): Promise<unknown> {
    return this.data;
  }

  async save(records: TrustRecord[]): Promise<void> {
    this.data = records.map((r) => ({ ...r }));
  }

  /** 测试用：注入坏数据，验证加载时的健壮性 */
  poison(raw: unknown): void {
    this.data = raw;
  }
}
