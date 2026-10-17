import { Capacitor } from '@capacitor/core';
import { loadAllowlist } from '../app/core-config';
import { DurableAuditStore } from '../core/audit-store';
import { createCore, type Core } from '../core/index';
import { KvEntityBackend } from '../core/kv-entity-backend';
import { PluginHost } from '../core/plugin-host';
import { icsImporter, PLUGIN_ID as ICS_PLUGIN_ID, manifest as icsManifest } from '../plugins/builtin/importer-ics/index.ts';
import { loadOverrides, type Overrides } from './overrides';
import { createRegistry } from './strategies';
import type { IndexingStrategy } from './strategies/indexing/types';
import type { SecureStore } from './strategies/kv/types';
import { fingerprint } from './strategies/registry';
import type { TaskStore } from './strategies/store/types';
import type { ResolutionReport } from './strategies/types';

export interface Platform {
  kv: SecureStore;
  indexing: IndexingStrategy | null;
  store: TaskStore;
  /**
   * 核心层：唯一允许出网的地方（DESIGN.md §8.1）。
   * 纯 TypeScript 实现，传输层直接复用 `CapacitorHttp`（见 §7.4 的 D6 修订）。
   */
  core: Core;
  /**
   * 插件宿主：内核（注册表 / 信任 / 数据总线 / 同步 broker）与核心层的接线。
   *
   * 现在装了一个内置插件（ICS 导入，见 `plugins/builtin/importer-ics/`）。
   * 它的实体经 `KvEntityBackend` 落到 KV —— 刷新 / 重启后由 `restoreData()` 读回来。
   */
  plugins: PluginHost;
  /** 审计的持久化后端，便于调试面板显示落盘状态 */
  auditStore: DurableAuditStore;
  report: ResolutionReport;
  warnings: string[];
  overrides: Overrides;
}

export class PlatformInitError extends Error {
  readonly report: ResolutionReport;
  constructor(message: string, report: ResolutionReport) {
    super(message);
    this.name = 'PlatformInitError';
    this.report = report;
  }
}

/**
 * 启动自检 + 策略解析。
 *
 * 顺序很重要：indexing 和 kv 必须先解析出来，因为 store 的探针要用它们
 * （加密库探针需要 KV 里的正式口令，建表需要索引策略）。
 */
export async function bootstrap(): Promise<Platform> {
  const overrides = loadOverrides();
  const registry = createRegistry();

  const idx = await registry.resolve<IndexingStrategy, void>(
    'indexing', undefined, overrides.indexing);
  const kv = await registry.resolve<SecureStore, void>(
    'kv', undefined, overrides.kv);
  const st = await registry.resolve<TaskStore, { indexing: IndexingStrategy | null; kv: SecureStore | null }>(
    'store', { indexing: idx.value, kv: kv.value }, overrides.store);

  const report: ResolutionReport = {
    at: Date.now(),
    platform: Capacitor.getPlatform(),
    fingerprint: fingerprint([idx.report, kv.report, st.report]),
    slots: [idx.report, kv.report, st.report],
  };

  if (!kv.value) throw new PlatformInitError('没有任何可用的键值存储策略', report);
  if (!st.value) throw new PlatformInitError('没有任何可用的数据存储策略', report);

  await st.value.init();

  // 核心层：vault 直接用已解析出的 kv 后端（它已经有完整的降级链与真实往返探测），
  // 审计走同一个后端的持久化封装。两者都不额外探测，避免重复初始化。
  const auditStore = new DurableAuditStore(kv.value);
  const restored = await auditStore.load();

  const core = createCore({
    vaultBackend: kv.value,
    auditSink: auditStore.push,
    gateway: { config: { allowlist: loadAllowlist() } },
  });

  // 把读回来的历史记录灌进核心层的环形缓冲。
  // 少了这一步，重启后调试面板只会显示「缓冲 N 条」而列表是空的 —— 审计的全部价值
  // 就在于事后追溯，读回来了却不显示等于没读。
  core.audit.seed(restored);

  // 插件宿主。内核侧的审计先只落到内存环形缓冲 —— 它的条目形状与核心层审计不同
  // （没有 host/path/status），硬塞进同一个 sink 会逼我们编造字段。
  // 合并成一条审计流是 P2 的事，那时候要把两边的 schema 统一设计。
  //
  // `modules` 是「进程内第一方插件」的注册表：插件就是普通对象，
  // 调用的契约与第三方完全一致，只是不做跨进程隔离（D4）。
  const plugins = new PluginHost({
    core,
    modules: new Map([[ICS_PLUGIN_ID, icsImporter]]),
    // 插件实体走 KV：`TaskStore` 的 `SqlDb` 是私有的，硬接要么开第二个连接、
    // 要么捅破抽象；而新开一张 SQLite 表就是第三套表。代价（实体走 KV、任务走
    // SQLite 的不对称）写在 `kv-entity-backend.ts` 顶部，收敛时一起消掉。
    dataBackend: new KvEntityBackend(kv.value),
  });

  const warnings = buildWarnings(st.value, kv.value, idx.value);

  // 装内置插件。`allowReservedPrefix` 是**宿主侧的显式意图**，不是插件自称
  // （`kind` 是 manifest 自己写的东西，第三方照抄 `first-party` 就能绕过）。
  //
  // 装不上**不让 boot 挂掉** —— 一个坏内置插件不该让整个应用起不来。
  // 落进 warnings，用户在调试面板里能看到具体是哪一条。
  const icsInstalled = await plugins.install(icsManifest, { allowReservedPrefix: true });
  if (!icsInstalled.ok) {
    warnings.push(`内置插件 ${ICS_PLUGIN_ID} 安装失败：${icsInstalled.code} ${icsInstalled.message}`);
  }

  // 把插件数据读回内存。**必须在 install 之后** —— `bus.read()` 的跨插件字段裁剪
  // 依赖 install 时注册的 schema；也必须在 UI 订阅之前 —— `restore()` 刻意不发事件
  // （几千条记录逐条发事件会把界面冲垮，而启动时本来就没人订阅）。
  const restoredEntities = await plugins.restoreData();
  if (!restoredEntities.ok) {
    warnings.push(`读取已存的插件数据失败：${restoredEntities.message}。本次以空数据启动。`);
  }

  return {
    kv: kv.value,
    indexing: idx.value,
    store: st.value,
    core,
    plugins,
    auditStore,
    report,
    warnings,
    overrides,
  };
}

/** 把「看起来配了但实际没保护住」的组合显式指出来 */
function buildWarnings(store: TaskStore, kv: SecureStore, idx: IndexingStrategy | null): string[] {
  const w: string[] = [];
  const backend = store.backend;

  if (backend.includes('sqlcipher') && !kv.encrypted) {
    w.push('数据库已加密，但解密口令存放在**明文**存储中 —— 实际保护强度接近没有。建议改回系统安全存储。');
  }
  if (backend === 'json-doc') {
    w.push('已降级到 JSON 文档库：没有事务、没有索引，数据量大了会变慢。');
  }
  if (idx?.mode === 'shadow') {
    w.push('索引使用「影子表 + 触发器」退路方案（生成列在此设备上不可用）。');
  }
  if (!kv.encrypted) {
    w.push('键值存储未受系统级保护（未使用 Keystore / Keychain）。');
  }
  return w;
}
