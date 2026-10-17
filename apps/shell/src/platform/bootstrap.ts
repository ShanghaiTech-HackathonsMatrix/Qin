import { Capacitor } from '@capacitor/core';
import {connectWidget} from './android-widget.ts';
import { MatrixNotify } from '@matrix/capacitor-notify';
import { fail, ok } from '@matrix/plugin-api';
import type { PluginExports } from '@matrix/plugin-api';
import { loadAllowlist } from '../app/core-config';
import { DurableAuditStore } from '../core/audit-store';
import { BusTaskStore } from '../core/bus-task-store';
import { CompositeBackend, CoreStoreBackend } from '../core/core-data-backend';
import { toCourseCards, type CourseCard } from '../core/course-cards';
import { CORE_ENTITY } from '../core/core-entities';
import { createCore, type Core } from '../core/index';
import { KvEntityBackend } from '../core/kv-entity-backend';
import { CapacitorNotifyPort } from '../core/notify/capacitor-port.ts';
import type { NotifyPort } from '../core/notify/index.ts';
import { PluginHost } from '../core/plugin-host';
import { AcademicTransport, academicSessionFor, academicNativeAvailable, PlatformSessions } from '../core/academic-transport.ts';
import { AcademicService } from '../core/academic-service.ts';
import { SandboxRuntime } from '../core/sandbox-runtime.ts';
import { ExternalPlugins } from '../core/external-plugins.ts';
import {ExternalAccountRegistry,ExternalAccountTransport} from '../core/external-accounts.ts';
import {PersonalSchedule} from '../core/personal-schedule.ts';
import { sandboxModule } from './sandbox-module.ts';
import { CapacitorTransport } from '../core/transport.ts';
import { createConnector, connectorManifest } from '../plugins/builtin/academic/connectors.ts';
import { PROVIDERS, PLUGIN_IDS, ENTRY, type Provider } from '../plugins/builtin/academic/model.ts';
import { ACADEMIC_ID, projectionManifest, projectionPlugin } from '../plugins/builtin/academic/projection.ts';
import { EphemeralStore, SIMULATE_ACADEMIC, SimulatedAcademicTransport, simulatedWeekOne } from '../plugins/builtin/academic/simulate.ts';
import { icsImporter, PLUGIN_ID as ICS_PLUGIN_ID, manifest as icsManifest } from '../plugins/builtin/importer-ics/index.ts';
import {
  PLUGIN_ID as TIMELINE_PLUGIN_ID,
  manifest as timelineManifest,
  timelinePlugin,
} from '../plugins/builtin/timeline/index.ts';
import { loadOverrides, type Overrides } from './overrides';
import { createRegistry } from './strategies';
import type { IndexingStrategy } from './strategies/indexing/types';
import type { SecureStore } from './strategies/kv/types';
import { fingerprint } from './strategies/registry';
import type { TaskStore } from './strategies/store/types';
import type { ResolutionReport } from './strategies/types';

export interface Platform {
  personal:PersonalSchedule;
  externalPlugins:ExternalPlugins;
  academic: AcademicService;
  /**
   * 学业同步是不是跑在模拟通道上（dev + `?demo=1`）。
   *
   * 界面必须能说清楚「这些数据是合成的」—— 一个演示用的开关最怕的就是
   * 哪天被当成真的用起来，所以这个标记要一路传到设置页。
   */
  academicSimulated: boolean;
  kv: SecureStore;
  indexing: IndexingStrategy | null;
  /**
   * 业务数据的读写口。
   *
   * ⚠️ 它现在是**门面**（`BusTaskStore`），不是真相：真相在 `plugins.bus` 里，
   * 物理存储（SQLite/JSON）在 `bus.flush()` 时被写。所以
   * **不需要**任何「写完再投影一遍」的调用 —— 那一步已经不存在了。
   */
  store: TaskStore;
  /**
   * 核心层：唯一允许出网的地方（DESIGN.md §8.1）。
   * 纯 TypeScript 实现，传输层直接复用 `CapacitorHttp`（见 §7.4 的 D6 修订）。
   */
  core: Core;
  /**
   * 插件宿主：内核（注册表 / 信任 / 数据总线 / 同步 broker）与核心层的接线。
   *
   * 内置 ICS、Timeline、三平台学业连接器及课表作业投影插件。
   * 插件实体经 `KvEntityBackend` 落到 KV，核心实体经 `CoreStoreBackend` 落到
   * SQLite/JSON —— 分流发生在 `CompositeBackend` 里，对外只有一个数据层。
   */
  plugins: PluginHost;
  /**
   * 「课程」页的数据（T15）：核心课程 + 各插件贡献的课程，跨命名空间合并。
   *
   * 读的是 DataBus 而不是 `TaskStore` —— 这是 ICS 导入的课能显示出来的唯一原因。
   */
  listCourseCards: () => CourseCard[];
  /**
   * 通知桥 —— **平台无关**的接缝。
   *
   * 装配的是 `CapacitorNotifyPort`（两端统一的适配层），原生实现来自
   * `packages/capacitor-notify/`。Android 提供原生闹钟与通知，其他端如实报告不支持，
   * 不支持的平台 `isSupported()` 为 false、`schedule()` 抛错，不伪装成排程成功。
   *
   * 学业服务与个人日程调用此接口；外部插件暂不开放 notify.local。
   */
  notify: NotifyPort;
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

  // 提成非空局部量：`st.value` 的收窄不会跨进闭包，
  // 而 `applyCoreOps` 就是个闭包，直接用 `st.value` 会一直被判成可空。
  const store = st.value;

  // 核心层：vault 直接用已解析出的 kv 后端（它已经有完整的降级链与真实往返探测），
  // 审计走同一个后端的持久化封装。两者都不额外探测，避免重复初始化。
  const auditStore = new DurableAuditStore(kv.value);
  const restored = await auditStore.load();

  /*
    三条路：
      · dev + `?demo=1` → 模拟通道，只伪造网络那一层，解析与投影都是真的
      · Android / iOS   → 原生会话（WebView 登录 + 凭证留在原生侧）
      · 其它           → 不传 transport，用默认实现
  */
  const academicNative = academicNativeAvailable();
  const externalAccounts=new ExternalAccountRegistry();
  const simulated = SIMULATE_ACADEMIC && !academicNative;
  const academicTransport = SIMULATE_ACADEMIC
    ? new SimulatedAcademicTransport(new CapacitorTransport())
    : academicNative ? new AcademicTransport(new CapacitorTransport()) : null;

  const core = createCore({
    transport:new ExternalAccountTransport(academicTransport??new CapacitorTransport(),externalAccounts),
    vaultBackend: kv.value,
    auditSink: auditStore.push,
    gateway: { config: {
      allowlist: [...new Set([...loadAllowlist(), ...PROVIDERS.map(p=>new URL(ENTRY[p]).hostname)])],
      /*
        单页预算 45 秒（默认 15 秒）。校园网上的课表/课程页面偶尔会卡十几秒，
        15 秒一刀切会在第 50 多个页面莫名其妙地失败，而整次同步是全有或全无。
      */
      defaultTimeoutMs: 45_000,
    } },
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
  //
  // `store` 现在**只是物理持久化层**：核心记录在 `bus.flush()` 时经
  // `CoreStoreBackend` 落进去。`coreStore` 是给 UI 的门面，它依赖 `plugins`，
  // 所以只能在这之后建 —— 先用这个持有者把入口留给 `applyCoreOps`。
  // 初值是 null：命令若在装配完成前跑，会显式失败而不是静默不生效。
  let coreStore: TaskStore | null = null;

  /*
    模拟态换一个只在内存里的库：合成的快照绝不能落进真库，
    否则下次用正常模式打开，假数据看起来和真数据一模一样。
  */
  const dataKv = simulated ? new EphemeralStore() : kv.value;

  const sandbox=new SandboxRuntime(sandboxModule);
  const plugins = new PluginHost({
    externalRuntime:sandbox,
    maxSteps: 605,
    sessionFor:id=>academicSessionFor(id)??externalAccounts.sessionFor(id),
    core,
    modules: new Map<string, PluginExports>([
      [ICS_PLUGIN_ID, icsImporter],
      [TIMELINE_PLUGIN_ID, timelinePlugin],
      ...PROVIDERS.map(p=>[PLUGIN_IDS[p],createConnector(p)] as [string,PluginExports]),
      [ACADEMIC_ID, projectionPlugin],
    ]),
    // 数据层的分流点：核心命名空间 → 物理存储（SQLite/JSON，有加密与索引），
    // 其它命名空间 → KV。对外只有一个 `DataBus`，差异只在这一个后端里。
    dataBackend: new CompositeBackend(
      new CoreStoreBackend(store),
      new KvEntityBackend(dataKv),
    ),
    // 游标要活过重启（T10）：分页同步靠它，丢了会静默重复 / 跳过数据
    kv: dataKv,
    /**
     * 命令里的 `coreOps`（T14）。
     *
     * 核心数据的写入权在这里 —— 不在 `PluginHost` 里，因为它不认识业务模型；
     * 也不在插件里，因为那是 D3。插件只交「意图」，翻译成存储调用的是这一段。
     *
     * ⚠️ 每一条 op 都**先读后写**：`putTask` 是全量覆盖，不先读回原对象
     * 就会把 `title` / `note` 这些没被改的字段抹成 undefined。
     *
     * C 段之后这里短了：写入走门面 → 总线 → 落盘，**不需要再重新投影**。
     * 以前那一步漏了就是「勾上了但界面没变」，现在它在结构上不存在。
     */
    applyCoreOps: async (ops) => {
      const s = coreStore;
      if (s === null) {
        // 装配顺序异常。**不能假装成功** —— 那会让用户以为勾上了，实际什么都没发生。
        return fail('EINTERNAL', '核心数据层尚未装配，无法确认改动已生效');
      }
      let applied = 0;
      try {
        for (const op of ops) {
          if (op.op === 'task.setStatus') {
            const all = await s.listTasks();
            const t = all.find((x) => x.id === op.id);
            // 任务不存在就跳过，不报错：可能是别的设备删掉了。
            // 让整个命令失败会让用户看到「操作失败」但其实无事可做。
            if (!t) continue;
            await s.putTask({ ...t, status: op.status, updatedAt: Date.now() });
            applied += 1;
            continue;
          }
          if (op.op === 'task.delete') {
            await s.deleteTask(op.id);
            applied += 1;
            continue;
          }
        }
      } catch (e) {
        return fail('EINTERNAL', `核心数据写入失败：${e instanceof Error ? e.message : String(e)}`);
      }
      return ok(applied);
    },
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

  // Timeline 是**槽的定义方**，必须比使用方先装 —— 否则 ICS 的第一次写入
  // 会落进「槽还没人定义」的空档（`collectSlotsFor` 会报错，数据白丢一轮）。
  const timelineInstalled = await plugins.install(timelineManifest, { allowReservedPrefix: true });
  if (!timelineInstalled.ok) {
    warnings.push(
      `内置插件 ${TIMELINE_PLUGIN_ID} 安装失败：${timelineInstalled.code} ${timelineInstalled.message}。` +
        `时间线不可用，课表会进不了时间轴。`,
    );
  }

  // 把数据读回内存。**必须在 install 之后** —— `bus.read()` 的跨插件字段裁剪
  // 依赖 install 时注册的 schema；也必须在 UI 订阅之前 —— `restore()` 刻意不发事件
  // （几千条记录逐条发事件会把界面冲垮，而启动时本来就没人订阅）。
  //
  // 这一步同时把**核心记录**从物理层读进总线（`CoreStoreBackend.loadAll()`），
  // 所以它取代了原来的 `projectCore()` —— 启动时不再有「投影」这个动作，
  // 只有「读回」。之后所有写入都直接进总线，落盘由 flush 负责。
  for (const manifest of [...PROVIDERS.map(connectorManifest),projectionManifest]) {
    const result=await plugins.install(manifest,{allowReservedPrefix:true});
    if(!result.ok) warnings.push(`学业插件安装失败：${result.message}`);
  }
  const externalPlugins=new ExternalPlugins(plugins,dataKv,sandbox,domains=>core.net.setAllowlist([...new Set([...loadAllowlist(),...PROVIDERS.map(p=>new URL(ENTRY[p]).hostname),...domains])]),externalAccounts);
  try{await externalPlugins.restore();warnings.push(...externalPlugins.warnings);}catch(e){warnings.push(`外部插件恢复失败：${e instanceof Error?e.message:String(e)}`);}
  const restoredEntities = await plugins.restoreData();
  if (!restoredEntities.ok) {
    warnings.push(`读取已存的数据失败：${restoredEntities.message}。本次以空数据启动。`);
  }

  // 给 UI 的门面。它必须在 `restoreData()` 之后建：之前总线里还没有核心记录，
  // 那会儿建出来读到的就是空表。
  coreStore = new BusTaskStore(store, plugins.bus);

  // 通知桥：先探测再交出去。`probe()` 不会抛错（探测失败就是「不支持」），
  // 所以装配流程不会因为通知不可用而中断。
  const notify = new CapacitorNotifyPort(MatrixNotify, { label: Capacitor.getPlatform() });
  await notify.probe();
  if (!notify.isSupported()) {
    // 不是错误，是事实。写进 warnings 让调试面板与顶栏看得见。
    warnings.push('本平台没有可用的本地通知桥，不能安排提醒。');
  }

  // 模拟时登录/清除都是空操作：没有真会话要开，也没有真会话要清
  const academicLogin = async (_provider: Provider): Promise<{completed: boolean}> => simulated
    ? {completed: true}
    : PlatformSessions.login({provider: _provider});
  const academicClear = async (): Promise<void> => {
    if (!simulated) await PlatformSessions.clear();
  };
  const academic=new AcademicService({host:plugins,kv:dataKv,notify,
    available: academicNative || simulated,
    login: academicLogin,
    clear: academicClear});
  try {
    await academic.init();
    /*
      模拟时顺手把「第 1 教学周」填成两周前的周一。
      不填的话 `expandLessons` 会直接返回空数组 —— 同步成功、课表却是空的，
      演示起来像是坏了。真实模式不动这个值，仍然由用户自己确认。
    */
    if (simulated && academic.settings.weekOne === '') {
      await academic.saveSettings({...academic.settings, weekOne: simulatedWeekOne(Date.now())});
    }
  } catch(e) {warnings.push(`学业数据恢复失败：${e instanceof Error?e.message:String(e)}`);}

  const platform:Platform={
    personal:await (async()=>{const personal=new PersonalSchedule(dataKv,notify);try{await personal.init();}catch(e){warnings.push(`个人日程恢复失败：${String(e)}`);}return personal;})(),
    externalPlugins,
    academic,
    /** 是否在跑模拟同步（dev + `?demo=1`）。界面据此写明「数据是合成的」 */
    academicSimulated: simulated,
    kv: kv.value,
    indexing: idx.value,
    store: coreStore,
    core,
    plugins,
    listCourseCards: () => toCourseCards(plugins.readShared(CORE_ENTITY.course)),
    notify,
    auditStore,
    report,
    warnings,
    overrides,
  };
  try{await connectWidget(platform);}catch(e){warnings.push(`挂件初始化失败：${String(e)}`);}
  return platform;
}

/**
 * 构造「把 TaskStore 投影进 DataBus」的函数 —— **已删除**。
 *
 * C 段之后不再有投影：DataBus 是唯一数据层，物理存储由 `CoreStoreBackend`
 * 在 flush 时写入。旧调用方写 `platform.projectCore()` 现在会**编译不过** ——
 * 这是有意的：静默不做事比报错难查得多。
 */

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
