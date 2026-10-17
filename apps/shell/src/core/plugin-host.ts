/**
 * 内核 ↔ 核心层的接线（P1 入口）。
 *
 * ## 分工
 *
 *   · **核心层**（`./index.ts`）—— 唯一窄入口。出网、凭证、审计。
 *     它**不知道「插件」这个概念**，只知道「有个 pluginId 拿着令牌来要东西」。
 *   · **内核**（`@matrix/kernel`）—— 注册表、信任、数据总线、同步状态机。
 *     它**不知道网络怎么发**，只知道「我需要一个 URL 的响应体」。
 *
 * 这个文件是两者之间**唯一的**接缝，刻意做得很薄：内核要什么就给什么，
 * 中间不做任何「顺手的便利」。每多一层隐式转换，就多一个可以出错的地方。
 *
 * ## 这里必须处理的三件事
 *
 * 1. **错误码如实透传**。核心层抛的 `CoreError.code` 就是传输码
 *    （`EURL` / `EIP` / `EHOST` / `ETOOBIG` / `ENET` …）。插件契约的边界类型
 *    刻意把这两套码都装得下（见 `@matrix/plugin-api` 的 `errors.ts`），
 *    所以这里**照原样映射**，绝不谎报成 `ENETDENIED` ——
 *    失败原因是用户排查问题的唯一线索。
 *
 * 2. **凭证头在适配器这层就拒掉**。契约允许插件在 `PlannedRequest` 里带 `headers`，
 *    但 `cookie` / `authorization` 这类凭证头必须拒。网关（最后一道强制点）
 *    会**静默剥掉**它们 —— 静默剥掉的问题在于插件会以为自己设置成功了。
 *    所以在适配器这层显式报 `EPERM`，插件作者第一次跑就能发现。
 *    两道都在，是纵深防御，不是二选一。
 *
 * 3. **信任撤销要联动能力令牌撤销**。内核的 `TrustStore` 决定「这个插件的远程代码
 *    还能不能跑」，核心层的 `CapabilityRegistry` 决定「这个插件还能不能出网」。
 *    两者不联动的话，用户在界面上点了「撤销信任」，插件手里的令牌照样能用 ——
 *    那这个开关就是**假的**（D7 要求「逐插件可撤销」）。
 *    联动规则见 `onTrustChanged()`，**只认「从 remote-trusted 掉出去」这一种降级**。
 */

import {
  byteLen,
  DataBus,
  MemoryTrustBackend,
  PluginRegistry,
  SyncBroker,
  TrustStore,
  type DataBackend,
  type EntityRecord,
  type LoadedPlugin,
  type QuotaPolicy,
  type SyncReport,
  type TrustBackend,
  type TrustChange,
} from '@matrix/kernel';
import {
  fail,
  ok,
  type GrantedPermissions,
  type Manifest,
  type ParsedEntity,
  type PlanInput,
  type PlannedRequest,
  type PluginExports,
  type PluginKind,
  type PluginResult,
} from '@matrix/plugin-api';

import { FORBIDDEN_REQUEST_HEADERS } from './gateway.ts';
import type { Core } from './index.ts';
import { errorCode, type NetResponse } from './types.ts';

// ------------------------------------------------------------ 审计

export interface HostAuditEntry {
  at: number;
  pluginId: string;
  action: string;
  detail?: string;
}

// ------------------------------------------------------------ 运行环境

/**
 * 进程内第一方插件运行时（对应 D4）。
 *
 * 第一方插件（课表、DDL、Timeline……）就是**进程内的普通对象**，
 * 调用的是与第三方完全一致的 `PluginExports` 契约，只是不做跨进程隔离。
 *
 * 第三方插件将来跑在 QuickJS WASM 沙箱里（D1/D9），实现同一个 `PluginRuntime`
 * 接口即可替换 —— 内核不需要知道插件到底住在哪。
 */
export class InProcessRuntime {
  private readonly modules = new Map<string, PluginExports>();
  /** 显式覆盖的 kind。没给就以 manifest 为准（见 load()） */
  private readonly kindOverrides = new Map<string, PluginKind>();

  constructor(initial?: ReadonlyMap<string, PluginExports>) {
    if (initial) for (const [id, mod] of initial) this.provide(id, mod);
  }

  /**
   * @param kind 仅在「运行时要报一个与 manifest 不同的形态」时才需要 ——
   *             正常情况别传，见 `load()` 的说明。
   */
  provide(pluginId: string, exports: PluginExports, kind?: PluginKind): void {
    this.modules.set(pluginId, exports);
    if (kind) this.kindOverrides.set(pluginId, kind);
    else this.kindOverrides.delete(pluginId);
  }

  remove(pluginId: string): void {
    this.modules.delete(pluginId);
    this.kindOverrides.delete(pluginId);
  }

  has(pluginId: string): boolean {
    return this.modules.has(pluginId);
  }

  /**
   * `granted` 在此实现里用不到 —— 进程内模块是预先注册好的对象，
   * 权限裁剪发生在**调用链**上（数据总线按 pluginId 隔离、网关按令牌校验），
   * 而不是发生在「加载」这一步。沙箱运行时才需要在加载时按 granted 组装 host API。
   *
   * 关于 `kind`：注册表会**严格**比对运行时自报的 kind 与 manifest 声明的 kind
   * （`registry.ts` 的握手核对），不一致直接 `EMANIFEST` 失败。
   * 进程内运行时**没有独立知识** —— 模块就是宿主自己塞进来的，
   * 所以这里以 `manifest.kind` 为准。硬写成 `'first-party'` 会让所有
   * `kind: 'connector'` 的第一方插件装不上。
   *
   * 沙箱运行时（P2）不一样：它**确实**能独立观察到加载进来的东西是不是可执行代码，
   * 那时候的核对才有实质意义。
   */
  async load(manifest: Manifest, _granted: GrantedPermissions): Promise<PluginResult<LoadedPlugin>> {
    const exports = this.modules.get(manifest.id);
    if (!exports) {
      return fail('ENOTFOUND', `未注册的第一方插件: ${manifest.id}`, { pluginId: manifest.id });
    }
    return ok({ exports, kind: this.kindOverrides.get(manifest.id) ?? manifest.kind });
  }

  async unload(): Promise<void> {
    // 进程内对象没有需要回收的执行环境。
    // 沙箱运行时（P2）在这里销毁 QuickJS 模块实例（D9：一个插件一个实例）。
  }
}

/**
 * 第一方（编译进应用）插件的「验签器」。
 *
 * ⚠️ **它不做任何密码学校验。** 但它回答的也不是「签名对不对」，而是另一个
 * **能如实回答**的问题：**这段代码是不是就在这个应用包里？**
 *
 * 判据只有一条：manifest 的 `id` 在进程内 `modules` 表里 —— 也就是它的代码
 * 被编译进了同一个 APK，与宿主同权限。对这种代码，验不验签没有任何区别，
 * 所以返回 `fullySigned: true` **不是假话**，它就是「第一方」这个事实的另一种写法。
 *
 * 反过来，**不在 `modules` 里的一律 `false`**：等 `.mtp` 安装路径真的出现时，
 * 陌生人不会因为「忘了改这里」而静默变成 trusted。fail-closed。
 *
 * 契约明确允许这样做（`packages/kernel/src/registry.ts:100`：
 * 「第一方插件可以返回 `fullySigned: true` 而无需真验」）。
 *
 * 但 `integrity` 字段目前**只校验形状**，没有任何签名验证 ——
 * **在真正的验签落地之前，不得分发任何第三方插件。**
 */
export function compiledInVerifier(modules: ReadonlyMap<string, PluginExports>) {
  return {
    async verify(manifest: Manifest): Promise<PluginResult<{ fullySigned: boolean }>> {
      return ok({ fullySigned: modules.has(manifest.id) });
    },
  };
}

// ------------------------------------------------------------ 适配器

export interface PluginHostOptions {
  core: Core;
  /** 第一方插件模块。第三方走沙箱运行时（P2） */
  modules?: ReadonlyMap<string, PluginExports>;
  /** 信任记录的持久化后端。不传就是内存态（重启即失，P2 接存储层） */
  trustBackend?: TrustBackend;
  quota?: Partial<QuotaPolicy>;
  /** 单份本地文档的上限（UTF-8 字节）。默认 8 MiB */
  maxLocalBytes?: number;
  /**
   * 插件数据的持久化后端。不传 = 纯内存（测试默认）。
   *
   * 传了之后，`sync()` / `uninstall()` 结束时会 `await bus.flush()`，
   * 启动时调 `restoreData()` 把记录读回来。
   */
  dataBackend?: DataBackend;
  /** 覆盖宿主能力清单。默认 `IMPLEMENTED_CAPABILITIES`（测试用） */
  capabilities?: readonly string[];
  now?: () => number;
  audit?: (e: HostAuditEntry) => void;
}

/**
 * 本地文档的键。**必须**含 `pluginId` ——
 * `source: 'host'` 的请求不过域名白名单（它不出网），所以键里少了 pluginId，
 * 插件 A 就能拿到插件 B 导入的东西。与 DataBus 的记录键是同一个教训。
 */
const localKey = (pluginId: string, url: string): string => `${pluginId}\u0000${url}`;

/**
 * 本构建**真的**实现了的能力 —— 不是 v1 规范清单，是 `PluginHost` 这个装配点
 * 对自己能力的主张。`registry.capabilities()` 返回的就是它。
 *
 * 规则：**只列插件真能用到的东西。**
 *
 *   · `net.request`   —— `plan()` 里发网络请求（`dispatchFetch`）
 *   · `local.request` —— `plan()` 里声明 `source: 'host'`（`serveLocal`）
 *   · `bus.emit`      —— 从 `plan().entities` 或 parser 返回实体（`emitEntity`）
 *
 * 刻意**不**列的（虽然内核或核心层里有相关代码）：
 *
 *   · `bus.read`           —— 宿主内部（Timeline 视图）在用，插件**没有调用路径**
 *   · `secrets.namespaced` —— 核心层 vault 有实现，但 `PluginHost` 没暴露给插件
 *   · `db.*` `auth.login` `notify.local` `schedule.*` `fs.*` `ui.registerComponent`
 *     `llm.complete` `trust.*` —— **完全没实现**
 *
 * 为什么这份清单是手写的、而不是自动算出来的：宿主里没有「能力开关」这种结构，
 * 真正的实现就是几个方法。手写清单唯一能保证的是「它在装配点上」——
 * 加能力的人一定会看到它。差分测试里有一条断言把它锁死在
 * 「⊆ HOST_CAPABILITIES_V1 且不含未实现项」。
 */
export const IMPLEMENTED_CAPABILITIES: readonly string[] = [
  'net.request',
  'local.request',
  'bus.emit',
];

export class PluginHost {
  readonly trust: TrustStore;
  readonly bus: DataBus;
  readonly registry: PluginRegistry;

  private readonly core: Core;
  private readonly broker: SyncBroker;
  private readonly runtime: InProcessRuntime;
  /** pluginId → 当前能力令牌 id */
  private readonly tokens = new Map<string, string>();
  /** 宿主为插件准备的**本地文档**，键是 `pluginId \0 url`（见 `localKey`） */
  private readonly localDocs = new Map<string, string>();
  /** pluginId → 上一轮同步结束时的游标（`SyncReport.cursor`），下次 sync 时回填 */
  private readonly cursors = new Map<string, string>();
  private readonly maxLocalBytes: number;
  /** 插件数据的持久化后端。没有 = 纯内存（测试与降级） */
  private readonly dataBackend: DataBackend | undefined;
  private readonly hostAudit: HostAuditEntry[] = [];
  private readonly sink: ((e: HostAuditEntry) => void) | undefined;
  private readonly clock: () => number;

  constructor(opts: PluginHostOptions) {
    this.core = opts.core;
    this.clock = opts.now ?? (() => Date.now());
    this.sink = opts.audit;
    this.maxLocalBytes = opts.maxLocalBytes ?? 8 * 1024 * 1024;
    this.dataBackend = opts.dataBackend;

    const backend = opts.trustBackend ?? new MemoryTrustBackend();
    this.trust = new TrustStore({
      backend,
      now: this.clock,
      audit: (e) => this.record(e.pluginId, `trust.${e.action}`, `${e.from ?? '-'} → ${e.to}`),
    });
    this.bus = new DataBus({
      ...(opts.quota ? { quota: opts.quota } : {}),
      ...(opts.dataBackend ? { backend: opts.dataBackend } : {}),
      now: this.clock,
    });

    this.runtime = new InProcessRuntime(opts.modules);

    this.registry = new PluginRegistry({
      runtime: this.runtime,
      verifier: compiledInVerifier(opts.modules ?? new Map()),
      trust: this.trust,
      bus: this.bus,
      capabilities: opts.capabilities ?? IMPLEMENTED_CAPABILITIES,
      now: this.clock,
      audit: (e) => this.record(e.pluginId, e.action, e.detail),
    });

    this.broker = new SyncBroker({
      fetch: (req, ctx) => this.dispatchFetch(ctx.pluginId, req),
      domainsFor: (pluginId) => this.registry.get(pluginId)?.granted.netDomains ?? [],
      emit: (pluginId, entity) => this.emitEntity(pluginId, entity),
      now: this.clock,
      audit: (e) => this.record(e.pluginId, e.action, e.detail ?? e.url),
    });

    // 信任变更 → 联动能力令牌
    this.trust.onChange((c) => this.onTrustChanged(c));
  }

  // ---------------------------------------------------------- 生命周期

  /**
   * 安装（可选立即激活）。`raw` 直接来自磁盘上的 manifest.json。
   *
   * 安装成功后**解除**能力层的撤销标记：卸载时会把插件标成 revoked
   * （防止已卸载插件手里的令牌继续用），重装时必须清掉，
   * 否则重装后的插件永远拿不到令牌 —— 一个「装过一次就废了」的隐性 bug。
   *
   * TODO(第三方安装路径)：`allowReservedPrefix` 现在是个裸布尔，任何 `install()` 的
   * 调用方都能传 true。目前只有第一方插件走这个入口，所以没问题；等第三方安装流程
   * 也用同一个 `install()` 时，应收成独立的 `installBuiltin()`，让这个开关
   * **在类型上**不可从第三方路径触达 —— 而不是靠调用方自觉。
   */
  async install(
    raw: unknown,
    opts: { requested?: unknown; activate?: boolean; allowReservedPrefix?: boolean } = {},
  ) {
    const r = await this.registry.install(raw, opts);
    if (r.ok) {
      this.core.tokens.restorePlugin(r.data.manifest.id);
      this.tokens.delete(r.data.manifest.id);
    }
    return r;
  }

  async uninstall(pluginId: string, opts: { keepData?: boolean } = {}) {
    const r = await this.registry.uninstall(pluginId, opts);
    if (r.ok) {
      // 卸载即撤销出网能力：否则一个已卸载的插件手里的令牌还能继续用
      this.core.tokens.revokePlugin(pluginId);
      this.tokens.delete(pluginId);
      // 游标与本地文档也要清 —— 否则重装后会从「上一世的进度」继续，
      // 而且可能读到上一次导入的文件
      this.cursors.delete(pluginId);
      this.clearLocal(pluginId);
      // 卸载会 `dropPlugin` 掉记录，同样要落盘 —— 否则重启后它们又回来了
      const flushed = await this.bus.flush();
      if (!flushed.ok) this.record(pluginId, 'data.flush_failed', flushed.message);
    }
    return r;
  }

  // ---------------------------------------------------------- 同步

  /**
   * 跑一轮同步。
   *
   * 注意签名里**没有**「网络」也没有「数据库」—— 插件只是被宿主推着走状态机，
   * IO 全部由宿主完成（D8）。这也是为什么整条链路可以完全同步地跑在沙箱里。
   */
  async sync(pluginId: string, input: PlanInput): Promise<PluginResult<SyncReport>> {
    const exports = this.registry.exportsOf(pluginId);
    if (!exports) {
      return fail('ENOTFOUND', `插件 ${pluginId} 当前不可用（未安装或未激活）`, { pluginId });
    }
    // 调用方没给游标时，用上一轮存下来的。
    // 这是 `PlanInput.cursor` 唯一的来源 —— broker 自己不持久化任何东西。
    const saved = this.cursors.get(pluginId);
    const withCursor: PlanInput =
      input.cursor === undefined && saved !== undefined ? { ...input, cursor: saved } : input;

    const r = await this.broker.run(pluginId, exports, withCursor);
    if (!r.ok) return r;
    if (r.data.cursor !== undefined) this.cursors.set(pluginId, r.data.cursor);

    // **write-behind 的落盘点。** `emit()` 是同步的（D8），所以这一轮写进去的实体
    // 此刻只在内存里 —— 必须在这里等一次刷盘，否则「同步成功」就是一句空话。
    //
    // 刷盘失败**不改判 sync 的成败**：实体确实已经进了内存、用户也确实看见了，
    // 只是还没落盘。所以把原因记进 `report.errors` 与审计，让它在调试面板里可见，
    // 而不是假装这一轮失败了（那会让用户以为导入没成，实际上成了）。
    const flushed = await this.bus.flush();
    if (!flushed.ok) {
      r.data.errors.push(`持久化失败（数据仍在内存中，下次刷新前会重试）：${flushed.message}`);
      this.record(pluginId, 'data.flush_failed', flushed.message);
    }
    return r;
  }

  // ---------------------------------------------------------- 持久化

  /**
   * 启动时把后端里的记录读回内存。
   *
   * ⚠️ **要在 `install()` 之后、UI 订阅之前调**：
   *   · 之后 —— `read()` 的跨插件字段裁剪要用 install 时注册的 schema
   *   · 之前 —— `restore()` 不发事件，订阅了也收不到
   *
   * 没配 `dataBackend` 时返回 `ok(0)`，不是错误：纯内存模式本来就没什么可读。
   */
  async restoreData(): Promise<PluginResult<number>> {
    if (!this.dataBackend) return ok(0);
    try {
      const records = await this.dataBackend.loadAll();
      const n = this.bus.restore(records);
      this.record('*', 'data.restored', `${n} 条记录，${this.bus.stats().types} 种类型`);
      return ok(n);
    } catch (e) {
      const msg = `读取已存数据失败：${e instanceof Error ? e.message : String(e)}`;
      this.record('*', 'data.restore_failed', msg);
      return fail('EINTERNAL', msg);
    }
  }

  /** 把还没落盘的变更写下去（正常情况下 `sync()` / `uninstall()` 已经替你做了） */
  flushData(): Promise<PluginResult<void>> {
    return this.bus.flush();
  }

  // ---------------------------------------------------------- 本地文档

  /**
   * 交给插件一份本地文档，供它用 `PlannedRequest.source === 'host'` 取用。
   *
   * `url` 是**不透明键**（如 `host://import`），不是文件路径 —— 插件无法通过它
   * 指到文件系统上的某个文件，只能取到宿主主动放进来的东西。
   * 由**宿主 UI** 调用（用户在界面上选了文件之后）。
   *
   * ⚠️ **导入完成后请由 UI 调 `clearLocal()`。** 否则之后每一次 `sync()` 都会
   * 再解析同一份文件 —— 用户会看到数据被重复导入，而且没有报错。
   */
  provideLocal(pluginId: string, url: string, text: string): PluginResult<void> {
    // 早失败：不检查的话，50 MB 的文件会先进内存、再跨沙箱边界、
    // 最后才被 broker 的 maxBodyBytes 拒 —— 拒是拒了，但代价已经付了。
    const bytes = byteLen(text);
    if (bytes > this.maxLocalBytes) {
      this.record(pluginId, 'local.rejected', `${url}：${bytes} 字节超过上限 ${this.maxLocalBytes}`);
      return fail('ETOOBIG', `本地文档 ${url} 超过上限 ${this.maxLocalBytes} 字节`, {
        bytes,
        maxLocalBytes: this.maxLocalBytes,
      });
    }
    this.localDocs.set(localKey(pluginId, url), text);
    this.record(pluginId, 'local.provided', `${url} (${bytes} 字节)`);
    return ok(undefined);
  }

  /** 撤掉一份（或该插件的全部）本地文档 */
  clearLocal(pluginId: string, url?: string): void {
    if (url === undefined) {
      for (const k of [...this.localDocs.keys()]) {
        if (k.startsWith(`${pluginId}\u0000`)) this.localDocs.delete(k);
      }
      return;
    }
    this.localDocs.delete(localKey(pluginId, url));
  }

  /** 只读快照，给调试面板用 */
  snapshot(): {
    plugins: Array<{ id: string; state: string; trust: string; netDomains: readonly string[] }>;
    data: { types: number; records: number; plugins: number };
    audit: readonly HostAuditEntry[];
  } {
    return {
      plugins: this.registry.list().map((p) => ({
        id: p.manifest.id,
        state: p.state,
        trust: p.trust.level,
        netDomains: p.granted.netDomains,
      })),
      data: this.bus.stats(),
      audit: this.hostAudit,
    };
  }

  /**
   * 跨插件读取（Timeline 这类消费方用），带字段投影。
   *
   * TODO(与 `emitEntity` 同源)：这里**不查** `permissions.data.read`，和 `emit` 之前
   * 是同一个毛病。现在补不了 —— 唯一调用方是 shell 自己的 Timeline 视图，
   * 它没有插件身份，一加闸就把现有功能掐死。等 Timeline 真的变成插件
   * （拿到 `dev.matrix.timeline` 这个 id）时再补，那时它才有 `granted` 可比。
   */
  read(readerPluginId: string, type: string, opts: { limit?: number } = {}): PluginResult<EntityRecord[]> {
    return this.bus.read(readerPluginId, type, opts);
  }

  // ---------------------------------------------------------- 内部

  /**
   * 把内核的「给我这个 URL」翻译成核心层的「拿令牌调 net.request」。
   *
   * 刻意**不**传 `session`：会话句柄的发放是宿主的事，不是插件能要求的。
   * 按插件准备会话属于鉴权代理那一块（§8.2，目前只搭了半截），P2 再补。
   */
  private async dispatchFetch(
    pluginId: string,
    req: PlannedRequest,
  ): Promise<PluginResult<{ status: number; body: string; url: string }>> {
    // ⓪ 本地资源：不出网，宿主自己满足。这是本地导入（.ics 之类）的落点。
    //
    // 之所以在这里分叉而不是在内核里：内核既不知道权限、也不知道宿主准备了什么。
    // 内核只负责「把请求交给宿主的 fetch」，由宿主决定怎么兑现。
    if (req.source === 'host') return this.serveLocal(pluginId, req);

    // ① 凭证头：在适配器这层显式拒掉（网关还会再剥一次，那是纵深防御）
    const forbidden = forbiddenHeadersIn(req.headers);
    if (forbidden.length > 0) {
      this.record(pluginId, 'net.rejected', `试图设置凭证头: ${forbidden.join(', ')}`);
      return fail('EPERM', `插件不得自行设置凭证头: ${forbidden.join(', ')}`, { headers: forbidden });
    }

    // ② 令牌。插件被撤销信任时 issue 会抛 EAUTH —— 如实映射
    let tokenId: string;
    try {
      tokenId = this.tokenFor(pluginId);
    } catch (e) {
      return fail('EAUTH', e instanceof Error ? e.message : String(e), { pluginId });
    }

    // ③ 出网。核心层会做 URL 校验、白名单、限流、跳转复检、大小上限、审计
    try {
      const res = (await this.core.call(tokenId, 'net.request', {
        url: req.url,
        method: req.method,
        ...(req.body !== undefined ? { body: req.body } : {}),
        ...(req.headers !== undefined ? { headers: req.headers } : {}),
      })) as NetResponse;

      // 只把 body 交给插件。响应头（含 set-cookie）不进沙箱
      return ok({ status: res.status, body: res.body, url: res.url });
    } catch (e) {
      const code = errorCode(e);
      this.record(pluginId, 'net.failed', `${code} ${req.url}`);
      return fail(code, e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 兑现一个 `source: 'host'` 请求。
   *
   * 三道检查：声明了 `permissions.local` → 键按 pluginId 隔离 → 宿主确实准备了这份文档。
   * 缺任何一道都返回结构化失败，不抛异常。
   */
  private serveLocal(
    pluginId: string,
    req: PlannedRequest,
  ): PluginResult<{ status: number; body: string; url: string }> {
    const rec = this.registry.get(pluginId);
    if (!rec) {
      return fail('ENOTFOUND', `插件 ${pluginId} 未安装`, { pluginId });
    }
    if (!rec.granted.local) {
      this.record(pluginId, 'local.rejected', `${req.url}：未声明 permissions.local`);
      return fail('EPERM', '未声明 permissions.local，不得请求宿主本地资源', { url: req.url });
    }
    const doc = this.localDocs.get(localKey(pluginId, req.url));
    if (doc === undefined) {
      this.record(pluginId, 'local.missing', req.url);
      return fail('ENOTFOUND', `宿主没有为该插件准备本地资源: ${req.url}`, { url: req.url });
    }
    this.record(pluginId, 'local.served', req.url);
    // 本地文档没有 HTTP 状态码的概念，统一给 200 —— 插件按正常响应处理
    return ok({ status: 200, body: doc, url: req.url });
  }

  /**
   * 落库前查 `permissions.data.write`。
   *
   * 之前这里直接调 `this.bus.emit(...)` —— 于是 `data.write` 在 emit 路径上是一道
   * **纸闸**：只有 `net` 路径（`dispatchFetch`）是真闸。同一个权限引擎两条路径两个行为，
   * 等于没有引擎。（DataBus 自己只查 schema 声明与配额 —— 它不知道 `granted`。）
   *
   * 注意这里查的是**声明过 + 授予了**的集合，不是 manifest 原文：
   * 用户在安装页可以只批一个子集，`granted` 就是那个子集。
   */
  private emitEntity(pluginId: string, entity: ParsedEntity): PluginResult<unknown> {
    const rec = this.registry.get(pluginId);
    if (!rec) return fail('ENOTFOUND', `插件 ${pluginId} 未安装`, { pluginId });

    const type = (entity as { type?: unknown } | null)?.type;
    if (typeof type !== 'string' || !rec.granted.dataWrite.has(type)) {
      this.record(pluginId, 'bus.emit_rejected', `未声明 permissions.data.write: ${String(type)}`);
      return fail('EPERM', `未在 permissions.data.write 中声明实体类型: ${String(type)}`, {
        type: String(type),
      });
    }
    return this.bus.emit(pluginId, entity);
  }

  private tokenFor(pluginId: string): string {
    const cached = this.tokens.get(pluginId);
    if (cached) {
      // 令牌可能已过期/被撤销，验一次比缓存一个坏值安全
      try {
        this.core.tokens.verify(cached, 'net');
        return cached;
      } catch {
        this.tokens.delete(pluginId);
      }
    }
    const t = this.core.issueToken(pluginId, ['net']);
    this.tokens.set(pluginId, t.id);
    return t.id;
  }

  /**
   * 信任变更 → 联动能力令牌。
   *
   * **只认一种降级**：`remote-trusted` → 其它。这才对应「用户撤销了对该插件远程代码的信任」。
   *
   * 为什么不能写成「凡是 to !== remote-trusted 就撤销」：
   * 第一方插件（`first-party`，没有远程代码）登记时等级是 `signed`，
   * 那条规则会把它们统统标成 revoked，`issueToken` 从此抛 EAUTH ——
   * 结果是**所有第一方插件的网络能力被永久掐死**。这个 bug 不报错，
   * 只表现为「请求全都返回 EAUTH」，很难查。
   */
  private onTrustChanged(c: TrustChange): void {
    if (c.to === 'remote-trusted') {
      // 授予：清掉撤销标记，旧令牌作废，下次调用重新签发
      this.core.tokens.restorePlugin(c.pluginId);
      this.tokens.delete(c.pluginId);
      return;
    }
    if (c.from === 'remote-trusted') {
      // 撤销：这是用户点了「不再信任」的那一步
      this.core.tokens.revokePlugin(c.pluginId);
      this.tokens.delete(c.pluginId);
      this.record(c.pluginId, 'capability.revoked', `信任从 remote-trusted 降为 ${c.to}`);
    }
  }

  private record(pluginId: string, action: string, detail?: string): void {
    const e: HostAuditEntry = { at: this.clock(), pluginId, action, ...(detail ? { detail } : {}) };
    this.hostAudit.push(e);
    if (this.hostAudit.length > 500) this.hostAudit.shift();
    this.sink?.(e);
  }
}

// ------------------------------------------------------------ 头策略

/**
 * 插件**不得**自行设置的请求头（小写）。
 *
 * 与 `gateway.ts` 的 `FORBIDDEN_REQUEST_HEADERS` 是**同一份策略**，这里直接引用而不是
 * 复制一份 —— 两份清单各写各的，迟早会漂移，而漂移的方向通常是把某个头
 * 从「剥掉」的名单里漏掉，也就是把后门重新打开。
 *
 * 两边行为不同但互补：
 *   · 网关**剥掉**（最后一道强制点，保证发出去的请求干净）
 *   · 适配器**拒掉**（让插件作者第一次跑就知道自己越界了）
 */
export const FORBIDDEN_PLUGIN_HEADERS: readonly string[] = [...FORBIDDEN_REQUEST_HEADERS].sort();

export function forbiddenHeadersIn(headers: Record<string, string> | undefined): string[] {
  if (!headers) return [];
  const bad: string[] = [];
  for (const k of Object.keys(headers)) {
    const lower = k.toLowerCase();
    if (FORBIDDEN_PLUGIN_HEADERS.includes(lower) && !bad.includes(lower)) bad.push(lower);
  }
  return bad.sort();
}
