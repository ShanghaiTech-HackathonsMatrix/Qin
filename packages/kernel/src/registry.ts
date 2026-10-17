/**
 * 内核 —— 插件注册表与生命周期（DESIGN.md §5.6）
 *
 * ```
 * install → verify(sig) → 权限确认页 → granted ⊆ declared → 落 plugin_registry
 *         → (首次) migrate 自身命名空间 → activate
 * activate → 握手 → 注入 ctx → onActivate() → 注册 contributes
 * suspend  → 宿主回收 Worker（移动端后台被杀）→ onSuspend() 尽力保存
 * deactivate → 注销 → 停止调度 → 释放 VM
 * uninstall → 询问是否保留数据 → 删表 or 保留 orphan
 * ```
 *
 * ⚠️ **关于「权限确认页」的位置**：内核**不**负责弹 UI。
 * `install()` 收到的 `requestedPermissions` 就是「用户在确认页上勾了什么」。
 * 内核只做一件事：**强制** `granted ⊆ declared`，并且把越权的请求当成篡改迹象写审计。
 * 前端安装页可以随便被改，但改不出声明之外的东西。
 *
 * ⚠️ **关于 §5.6 里没写清的地方**：`contributes.entityTypes` 在文档里只有一句
 * 「JSON Schema：写入前宿主校验」，没给结构。这里定为 `{ name, schema }`，
 * 是一个**待评审的具体化**，不是文档既有结论。
 */

import {
  negotiateApiVersion,
  intersectPermissions,
  emptyPermissions,
  validateManifest,
  type GrantedPermissions,
  type Manifest,
  type PluginErrorCode,
  type PluginExports,
  type PluginKind,
  type PluginResult,
  type TrustLevel,
  fail,
  ok,
} from '@matrix/plugin-api';

import { DataBus } from './databus.ts';
import { TrustStore, type TrustRecord } from './trust.ts';

// ------------------------------------------------------------ 状态

export type PluginState =
  /** 已安装，尚未激活（首次安装后会立刻激活，除非用户选择暂不启用） */
  | 'installed'
  /** 正在运行 */
  | 'active'
  /** 被宿主回收（移动端后台被杀），可随时重新激活 */
  | 'suspended'
  /** 用户停用 */
  | 'deactivated'
  /** 已卸载（记录保留一段时间用于审计） */
  | 'uninstalled';

export interface PluginRecord {
  manifest: Manifest;
  /** 用户实际授予的集合（declared 的子集） */
  granted: GrantedPermissions;
  trust: TrustRecord;
  state: PluginState;
  installedAt: number;
  activatedAt?: number;
  suspendedAt?: number;
  lastError?: { code: PluginErrorCode; message: string };
}

export interface RegistryAuditEntry {
  at: number;
  pluginId: string;
  action: string;
  detail?: string;
}

export type LifecycleEvent =
  | { kind: 'installed'; pluginId: string; at: number }
  | { kind: 'activated'; pluginId: string; at: number }
  | { kind: 'suspended'; pluginId: string; at: number }
  | { kind: 'deactivated'; pluginId: string; at: number }
  | { kind: 'uninstalled'; pluginId: string; at: number; keptData: boolean }
  | { kind: 'error'; pluginId: string; at: number; code: PluginErrorCode; message: string }
  | { kind: 'reloaded'; pluginId: string; at: number; reason: string };

// ------------------------------------------------------------ 宿主侧依赖

/** 执行环境。第三方插件是 QuickJS WASM 实例，第一方插件是进程内对象。 */
export interface PluginRuntime {
  /** 准备执行环境并取回插件导出。失败不抛，返回 PluginFailure。 */
  load(manifest: Manifest, granted: GrantedPermissions): Promise<PluginResult<LoadedPlugin>>;
  /** 释放执行环境（沙箱实例、Worker）。幂等。 */
  unload(pluginId: string): Promise<void>;
}

export interface LoadedPlugin {
  exports: PluginExports;
  /** 运行时自报的形态 —— 用于与 manifest 交叉核对 */
  kind: PluginKind;
}

/** 签名校验。第一方插件可以返回 `fullySigned: true` 而无需真验。 */
export interface SignatureVerifier {
  verify(manifest: Manifest): Promise<PluginResult<{ fullySigned: boolean }>>;
}

export interface RegistryDeps {
  runtime: PluginRuntime;
  verifier: SignatureVerifier;
  trust: TrustStore;
  bus: DataBus;
  /** 首次安装时的数据迁移（建表 / 建命名空间）。失败则安装失败。 */
  migrate?: (pluginId: string) => Promise<PluginResult<void>>;
  /**
   * 本宿主**真的**实现了的能力。缺省空数组 —— 宁少不多。
   *
   * 以前这里直接返回 `HOST_CAPABILITIES_V1`（v1 规范的**上限**），于是插件探测
   * `db.namespaced` 拿到 `true`，然后去调一个根本不存在的方法。
   * 「能力清单」说的是**插件能用什么**，必须由装配点如实申报，不能拿规范当实现。
   */
  capabilities?: readonly string[];
  audit?: (e: RegistryAuditEntry) => void;
  now?: () => number;
}

export interface InstallOptions {
  /** 用户在权限确认页勾选的子集。缺省 = 声明多少给多少（仅用于第一方 / 测试） */
  requested?: unknown;
  /** 是否安装后立刻激活 */
  activate?: boolean;
  /**
   * 允许该插件占用保留 id 前缀（`dev.matrix.*` / `app.matrix.*`）。
   *
   * **只在加载「编译进应用的」插件时传 true。** 这是宿主知道、manifest 无法声称的事实；
   * 第三方安装流程永远不传。详见 plugin-api 的 `ManifestValidationOptions`。
   */
  allowReservedPrefix?: boolean;
}

// ------------------------------------------------------------ 注册表

const ACTIVE_STATES: readonly PluginState[] = ['installed', 'suspended', 'deactivated'];

export class PluginRegistry {
  private readonly deps: RegistryDeps;
  private readonly records = new Map<string, PluginRecord>();
  private readonly exports = new Map<string, PluginExports>();
  private readonly listeners = new Set<(e: LifecycleEvent) => void>();
  private readonly clock: () => number;

  constructor(deps: RegistryDeps) {
    this.deps = deps;
    this.clock = deps.now ?? (() => Date.now());

    // §5.7：每次信任变更**触发插件重载**
    this.deps.trust.onChange((change) => {
      void this.onTrustChanged(change.pluginId, change.to, change.reason);
    });
  }

  // ---------------------------------------------------------- 查询

  get(pluginId: string): PluginRecord | undefined {
    return this.records.get(pluginId);
  }

  list(): PluginRecord[] {
    return [...this.records.values()];
  }

  stateOf(pluginId: string): PluginState | null {
    return this.records.get(pluginId)?.state ?? null;
  }

  /** 取插件导出（仅 active 状态可见） */
  exportsOf(pluginId: string): PluginExports | undefined {
    if (this.records.get(pluginId)?.state !== 'active') return undefined;
    return this.exports.get(pluginId);
  }

  on(fn: (e: LifecycleEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 宿主能力清单 —— 握手时给插件看。
   *
   * **只列真实实现的**（见 `RegistryDeps.capabilities`）。缺省是空数组：
   * 一个忘了申报能力的宿主，会让插件探测不到、从而退化成不用 ——
   * 比一个谎报能力的宿主安全得多。
   */
  capabilities(): string[] {
    return [...(this.deps.capabilities ?? [])];
  }

  // ---------------------------------------------------------- 安装

  /**
   * 安装一个插件。
   *
   * 顺序刻意如此：**先验 manifest，再验 API 版本，再验签，最后才谈权限**。
   * 理由：前几步不需要用户参与，能在弹确认页之前就把明显不行的挡掉，
   * 不让用户为一个根本装不上的插件做安全决策。
   */
  async install(rawManifest: unknown, opts: InstallOptions = {}): Promise<PluginResult<PluginRecord>> {
    // 1. manifest 形状
    const v = validateManifest(rawManifest, {
      allowReservedPrefix: opts.allowReservedPrefix === true,
    });
    if (!v.ok || !v.manifest) {
      return fail('EMANIFEST', 'manifest 校验未通过', {
        issues: v.issues.map((i) => `${i.path || '<root>'}: ${i.message}`),
      });
    }
    const manifest = v.manifest;

    if (this.records.has(manifest.id) && this.records.get(manifest.id)?.state !== 'uninstalled') {
      return fail('EMANIFEST', `插件 ${manifest.id} 已安装`);
    }

    // 2. API 版本握手
    const hs = negotiateApiVersion(manifest.apiVersion);
    if (!hs.ok) return hs;

    // 3. 签名
    const verified = await this.deps.verifier.verify(manifest);
    if (!verified.ok) return verified;

    // 4. 权限子集（默认拒绝：没勾就没给）
    const requested = opts.requested ?? manifest.permissions ?? {};
    const granted = intersectPermissions(manifest.permissions, requested as never);
    if (!granted.ok) {
      this.audit(manifest.id, 'install.rejected', granted.message);
      return granted;
    }

    // 5. 数据迁移（建命名空间 / 建表）
    if (this.deps.migrate) {
      const m = await this.deps.migrate(manifest.id);
      if (!m.ok) {
        this.audit(manifest.id, 'install.migrate_failed', m.message);
        return m;
      }
    }

    // 6. 登记 contributes 的实体 schema
    //    形状由上面的 validateManifest 保证（entityTypes 现在是具名类型）。
    //    这里原来有一句 `decl.schema as EntitySchema` 的强制转换 ——
    //    那是 EntitySchema 还定义在内核里、manifest 只能把它当 unknown 时的补偿。
    for (const decl of manifest.contributes?.entityTypes ?? []) {
      const r = this.deps.bus.declareSchema(manifest.id, decl.name, decl.schema);
      if (!r.ok) {
        this.audit(manifest.id, 'install.schema_rejected', `${decl.name}: ${r.message}`);
        return r as PluginResult<PluginRecord>;
      }
    }

    // 7. 信任基线
    const trustResult = await this.deps.trust.register(manifest.id, {
      fullySigned: verified.data.fullySigned,
      hasRemoteCode: manifest.capabilities?.remoteCode !== undefined,
      remoteCodeGranted: false,
    }, {
      restrictedSettings: manifest.capabilities?.restrictedSettings ?? [],
      remoteOrigins: manifest.capabilities?.remoteCode?.origins ?? [],
    });
    if (!trustResult.ok) return trustResult;

    const at = this.clock();
    const record: PluginRecord = {
      manifest,
      granted: granted.data,
      trust: trustResult.data,
      state: 'installed',
      installedAt: at,
    };
    this.records.set(manifest.id, record);
    this.emitEvent({ kind: 'installed', pluginId: manifest.id, at });
    this.audit(manifest.id, 'install.ok', `trust=${record.trust.level}`);

    if (opts.activate !== false) {
      const a = await this.activate(manifest.id);
      if (!a.ok) return a;
      return ok(this.records.get(manifest.id) as PluginRecord);
    }
    return ok(record);
  }

  // ---------------------------------------------------------- 激活

  async activate(pluginId: string): Promise<PluginResult<PluginRecord>> {
    const rec = this.records.get(pluginId);
    if (!rec) return fail('ENOTFOUND', `未安装的插件: ${pluginId}`);
    if (rec.state === 'active') return ok(rec);
    if (!ACTIVE_STATES.includes(rec.state)) {
      return fail('EINTERNAL', `状态 ${rec.state} 不允许激活`);
    }

    // §5.7：受限模式 + `untrustedRemote: false` ⇒ 完全不激活
    const untrusted = rec.manifest.capabilities?.untrustedRemote;
    if (rec.trust.level === 'restricted' && untrusted === false) {
      return this.failState(rec, 'ETRUST', '该插件声明了 untrustedRemote: false，在受限模式下不得激活');
    }

    const loaded = await this.deps.runtime.load(rec.manifest, rec.granted);
    if (!loaded.ok) return this.failState(rec, loaded.code, loaded.message);

    // 握手核对：运行时报的形态必须与 manifest 一致
    if (loaded.data.kind !== rec.manifest.kind) {
      await this.deps.runtime.unload(pluginId);
      return this.failState(
        rec,
        'EMANIFEST',
        `运行时自报 kind=${loaded.data.kind}，manifest 声明 kind=${rec.manifest.kind}`,
      );
    }

    // onActivate 同步调用，异常不让宿主崩
    try {
      loaded.data.exports.onActivate?.();
    } catch (e) {
      await this.deps.runtime.unload(pluginId);
      return this.failState(rec, 'EINTERNAL', `onActivate() 抛出异常: ${e instanceof Error ? e.message : String(e)}`);
    }

    this.exports.set(pluginId, loaded.data.exports);
    rec.state = 'active';
    rec.activatedAt = this.clock();
    delete rec.lastError;

    this.emitEvent({ kind: 'activated', pluginId, at: rec.activatedAt });
    this.audit(pluginId, 'activate.ok');
    return ok(rec);
  }

  // ---------------------------------------------------------- 挂起 / 停用 / 卸载

  /**
   * 挂起：宿主回收执行环境，但**保留记录**。
   * `onSuspend()` 是尽力而为 —— 移动端后台被杀时可能根本没机会调。
   */
  async suspend(pluginId: string): Promise<PluginResult<PluginRecord>> {
    const rec = this.records.get(pluginId);
    if (!rec) return fail('ENOTFOUND', `未安装的插件: ${pluginId}`);
    if (rec.state !== 'active') return ok(rec);

    const ex = this.exports.get(pluginId);
    try {
      ex?.onSuspend?.();
    } catch (e) {
      this.audit(pluginId, 'suspend.hook_failed', e instanceof Error ? e.message : String(e));
    }
    await this.deps.runtime.unload(pluginId);
    this.exports.delete(pluginId);

    rec.state = 'suspended';
    rec.suspendedAt = this.clock();
    this.emitEvent({ kind: 'suspended', pluginId, at: rec.suspendedAt });
    this.audit(pluginId, 'suspend.ok');
    return ok(rec);
  }

  async deactivate(pluginId: string): Promise<PluginResult<PluginRecord>> {
    const rec = this.records.get(pluginId);
    if (!rec) return fail('ENOTFOUND', `未安装的插件: ${pluginId}`);
    if (rec.state === 'deactivated' || rec.state === 'uninstalled') return ok(rec);

    const ex = this.exports.get(pluginId);
    try {
      ex?.onDeactivate?.();
    } catch (e) {
      this.audit(pluginId, 'deactivate.hook_failed', e instanceof Error ? e.message : String(e));
    }
    await this.deps.runtime.unload(pluginId);
    this.exports.delete(pluginId);

    rec.state = 'deactivated';
    this.emitEvent({ kind: 'deactivated', pluginId, at: this.clock() });
    this.audit(pluginId, 'deactivate.ok');
    return ok(rec);
  }

  /**
   * 卸载。`keepData: true` 时保留记录（orphan），否则删掉该插件的全部数据。
   * 无论哪种，schema 注册都会被撤掉 —— 否则卸载后还能往「无人认领」的类型里写。
   */
  async uninstall(
    pluginId: string,
    opts: { keepData?: boolean } = {},
  ): Promise<PluginResult<PluginRecord>> {
    const rec = this.records.get(pluginId);
    if (!rec) return fail('ENOTFOUND', `未安装的插件: ${pluginId}`);

    await this.deactivate(pluginId);

    const keepData = opts.keepData === true;
    if (!keepData) this.deps.bus.dropPlugin(pluginId);
    this.deps.bus.forgetSchemas(pluginId);
    await this.deps.trust.forget(pluginId);

    rec.state = 'uninstalled';
    this.emitEvent({ kind: 'uninstalled', pluginId, at: this.clock(), keptData: keepData });
    this.audit(pluginId, 'uninstall.ok', keepData ? 'keptData' : 'dataDropped');
    return ok(rec);
  }

  // ---------------------------------------------------------- 内部

  /** §5.7：信任变更触发重载 */
  private async onTrustChanged(pluginId: string, to: TrustLevel, reason: string): Promise<void> {
    const rec = this.records.get(pluginId);
    if (!rec) return;

    const wasActive = rec.state === 'active';
    if (wasActive) await this.deactivate(pluginId);

    const t = this.deps.trust.get(pluginId);
    if (t) rec.trust = t;

    if (wasActive) {
      const a = await this.activate(pluginId);
      if (!a.ok) {
        this.audit(pluginId, 'reload.failed', a.message);
        return;
      }
    }
    this.emitEvent({ kind: 'reloaded', pluginId, at: this.clock(), reason: `${to}: ${reason}` });
  }

  private failState(
    rec: PluginRecord,
    code: PluginErrorCode,
    message: string,
  ): PluginResult<PluginRecord> {
    rec.lastError = { code, message };
    this.audit(rec.manifest.id, 'error', `${code}: ${message}`);
    this.emitEvent({ kind: 'error', pluginId: rec.manifest.id, at: this.clock(), code, message });
    return fail(code, message, { pluginId: rec.manifest.id });
  }

  private emitEvent(e: LifecycleEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  private audit(pluginId: string, action: string, detail?: string): void {
    this.deps.audit?.({ at: this.clock(), pluginId, action, ...(detail ? { detail } : {}) });
  }
}

/** 一个最小的、什么都不给的授予集 —— 测试与「最小权限」场景用 */
export const NO_PERMISSIONS: GrantedPermissions = emptyPermissions();
