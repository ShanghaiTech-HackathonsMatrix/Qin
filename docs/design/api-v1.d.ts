/**
 * Matrix Plugin API —— v1 契约（讨论稿）
 *
 * 定位：宿主与插件之间唯一的契约。此文件对插件作者发布为
 * `@matrix/plugin-api`，但其**运行时实现不存在于插件侧** ——
 * 沙箱内只有一个由宿主注入的 `ctx` 对象，所有方法调用都经 RPC 转发。
 *
 * 兼容承诺：宿主同时提供 v1 与 v2 实现，支持 N-2 个大版本。
 * 破坏性变更必须升大版本，且旧版本方法先 warn 一个版本周期再移除。
 */

export declare const API_VERSION: '1.0.0';

// ============================================================ 基础类型

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };
export type Unsubscribe = () => void;

/** 平台能力标识。插件应探测能力，而不是判断平台名。 */
export type Capability =
  | 'db.encrypted'
  | 'net.native'          // HTTP 由原生层发出（可绕过 WebView）
  | 'notify.local'
  | 'bg.periodic'
  | 'bg.exact'            // 精确闹钟（需系统授权，运行时可能降级）
  | 'secrets.keystore'
  | 'fs.sandbox'
  | 'share.receive'
  | 'chat.notification'   // 通知监听（Android）
  | 'chat.localdb'        // 本地聊天库读取（桌面，实验性）
  | 'llm.local'           // 端侧模型推理
  | 'html.parse'          // 宿主提供受限 HTML 解析
  | 'ui.iframe';

export type PlatformKind = 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'web';

export interface HostInfo {
  readonly hostVersion: string;
  readonly apiVersion: string;
  readonly platform: PlatformKind;
  readonly locale: string;
  readonly timeZone: string;
  readonly capabilities: readonly Capability[];
}

export type ErrorCode =
  | 'EPERM'          // 权限未声明或未授予
  | 'ETRUST'         // 未授予「远程代码信任」（见 DESIGN §5.7）
  | 'EAPIVERSION'    // apiVersion 不满足
  | 'EQUOTA'         // 超出配额
  | 'ENETDENIED'     // 域名不在白名单 / 重定向越界 / 非 https
  | 'EAUTH'          // 会话失效或认证失败
  | 'ESCHEMA'        // 实体未通过 JSON Schema 校验
  | 'ENOTFOUND'
  | 'ETIMEOUT'
  | 'ECANCELLED'
  | 'EINTERNAL';

export interface PluginError { code: ErrorCode; message: string; data?: JsonValue }

// ============================================================ Manifest

export type PluginKind = 'declarative' | 'logic' | 'connector' | 'ui' | 'first-party';

export interface Permissions {
  /** 不声明则完全隔离在自己的命名空间内 */
  data?: {
    /** 允许写入的实体类型（由宿主定义的或本插件声明的） */
    write?: string[];
    /** 允许跨插件只读的实体类型 */
    read?: string[];
  };
  net?: {
    /** 精确域名或后缀通配（`*.shanghaitech.edu.cn`）。禁止 IP 字面量。 */
    domains: string[];
    methods?: Array<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>;
    /** 单次响应体上限，默认 5MB，上限 20MB */
    maxResponseBytes?: number;
  };
  auth?: { providers: string[] };
  notify?: boolean;
  background?: { periodic?: boolean; exact?: boolean; minIntervalMin?: number };
  secrets?: boolean;
  fs?: 'none' | 'read' | 'write';
  ui?: { components?: string[]; slots?: string[] };
  llm?: { local: true };
  html?: { parse: boolean };
  /** 需人工审核 + 官方签名才可授予 */
  privileged?: Array<'db.raw' | 'fs.absolute' | 'notify.unlimited'>;
}

export interface EntityTypeDecl {
  /** 实体类型名，例如 'ddl' */
  name: string;
  /** JSON Schema，写入前宿主强制校验 */
  schema: JsonObject;
  /** 合并/去重策略 */
  dedupe?: { keys: string[]; windowMs?: number; strategy: 'replace' | 'merge' | 'candidate' };
  /** 生命周期：保留多久后清理 */
  retention?: { ms?: number; keepRaw?: boolean };
}

export interface ViewDecl { id: string; title: string; slot?: string; schema: SchemaNode; propsSchema?: JsonObject }

export interface CommandDecl { id: string; title: string; icon?: string; shortcut?: string }

export interface ConnectorDecl {
  id: string;
  displayName: string;
  authProvider: string;
  syncIntervalMin: number;
  /** 声明式能力：宿主据此决定是否需要交互式登录 */
  interactiveAuth: boolean;
}

export interface ParserDecl {
  id: string;
  displayName: string;
  /** 支持的输入来源 */
  inputs: Array<'share' | 'clipboard' | 'notification' | 'localdb' | 'file'>;
  /** 输出的实体类型 */
  emits: string[];
}

/**
 * 信任等级（见 DESIGN §5.7）。权限回答「能做什么」，信任回答「代码是否被审核过」。
 *  - signed          包内全部可执行代码被签名覆盖 → 正常激活
 *  - restricted      存在未签名代码路径且用户未授权 → 只跑声明式部分
 *  - remote-trusted  用户显式授予 → 允许执行声明的远程代码（仍在沙箱内）
 */
export type TrustLevel = 'signed' | 'restricted' | 'remote-trusted';

export interface PluginCapabilities {
  /** 受限模式下是否仍可激活：false = 完全不激活；'limited' = 只提供声明式功能 */
  untrustedRemote?: boolean | 'limited';
  /** 受限模式下不读写的配置项（对应 VS Code 的 restrictedConfigurations） */
  restrictedSettings?: string[];
  /** 需要运行时获取远程代码时声明；宿主据此生成用户确认页 */
  remoteCode?: {
    /** 必须展示给用户的原因 */
    reason: string;
    /** 允许加载代码的域名，同时是 ETRUST 的判定范围 */
    origins: string[];
    /** 是否要求远程子资源随包签名（建议 'required'） */
    signature?: 'required' | 'none';
  };
}

export interface PluginManifest {
  id: string;                 // 反域名，唯一且不可变
  name: string;
  description?: string;
  author?: string;
  version: string;            // semver
  apiVersion: string;         // semver range，例如 '^1.0.0'
  kind: PluginKind;
  entry?: string;             // logic/connector/ui 必填；declarative 可省略
  icon?: string;
  engines?: { platform?: PlatformKind[]; hostVersion?: string };
  permissions: Permissions;
  /** 信任与受限模式声明（见 DESIGN §5.7） */
  capabilities?: PluginCapabilities;
  contributes?: {
    entityTypes?: EntityTypeDecl[];
    views?: ViewDecl[];
    commands?: CommandDecl[];
    connectors?: ConnectorDecl[];
    parsers?: ParserDecl[];
    /** declarative 插件的渲染 Schema 与数据映射（无代码） */
    declarative?: { mapping: JsonObject };
  };
  integrity?: { algo: 'ed25519'; hash: string; sig: string };
}

// ============================================================ 数据访问

export type Where =
  | { and: Where[] }
  | { or: Where[] }
  | { not: Where }
  | { field: string; eq: JsonValue }
  | { field: string; ne: JsonValue }
  | { field: string; in: JsonValue[] }
  | { field: string; gt: number }
  | { field: string; gte: number }
  | { field: string; lt: number }
  | { field: string; lte: number }
  | { field: string; contains: string }
  | { field: string; exists: boolean };

export interface FindOpts {
  orderBy?: Array<{ field: string; dir: 'asc' | 'desc' }>;
  limit?: number;
  offset?: number;
  /** 只取这些字段（减少跨沙箱序列化开销） */
  select?: string[];
}

export interface Collection<T extends JsonObject = JsonObject> {
  insert(doc: T & { id?: string }): Promise<string>;
  upsert(doc: T & { id: string }): Promise<void>;
  get(id: string): Promise<T | null>;
  find(where?: Where, opts?: FindOpts): Promise<T[]>;
  count(where?: Where): Promise<number>;
  update(id: string, patch: Partial<T>): Promise<void>;
  delete(id: string): Promise<void>;
  /** 订阅自身命名空间内的变更；宿主负责在 Worker 重启后重放 */
  subscribe(where: Where | undefined, cb: (docs: T[]) => void): Unsubscribe;
}

export interface DbTx {
  collection<T extends JsonObject = JsonObject>(name: string): Collection<T>;
}

export interface DbClient {
  /** 集合名由 manifest 声明；实际表名由宿主加前缀生成 */
  collection<T extends JsonObject = JsonObject>(name: string): Collection<T>;
  transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;
  /** 需要 privileged: ['db.raw']，默认拒绝。仅官方插件可用。 */
  raw?<T = JsonObject>(sql: string, params?: JsonValue[]): Promise<T[]>;
  /** 声明集合（首次激活时由宿主执行建表迁移） */
  declare(spec: { name: string; schema: JsonObject; indexes?: Array<{ fields: string[]; unique?: boolean }> }): Promise<void>;
}

// ============================================================ 数据总线

export interface BusEvent<T = JsonObject> {
  entity: string;
  op: 'upsert' | 'delete' | 'patch';
  ids: string[];
  payload?: T[];
  /** 来源插件 id；'user' 表示用户手动操作 */
  origin: string;
  ts: number;
}

export interface BusClient {
  /** 写入核心实体。宿主：权限 → 配额 → Schema 校验 → 去重/合并 → 落库 → 广播 */
  emit<T extends JsonObject>(entity: string, op: 'upsert' | 'delete' | 'patch', payload: T | T[]): Promise<{ accepted: string[]; merged: string[]; rejected: Array<{ index: number; reason: string }> }>;
  /** 跨插件只读，需 data.read 声明 */
  read<T extends JsonObject>(entity: string, where?: Where, opts?: FindOpts): Promise<T[]>;
  subscribe(entity: string, cb: (ev: BusEvent) => void): Unsubscribe;
  /** 命名空间化的共享状态 */
  state: {
    get<T extends JsonValue>(key: string): Promise<T | null>;
    set<T extends JsonValue>(key: string, value: T): Promise<void>;
    subscribe<T extends JsonValue>(key: string, cb: (v: T | null) => void): Unsubscribe;
  };
}

// ============================================================ 网络

export type SessionHandle = string & { readonly __brand: 'SessionHandle' };

export interface NetRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: { json: JsonValue } | { form: Record<string, string> } | { text: string };
  session?: SessionHandle;
  timeoutMs?: number;
  responseType?: 'text' | 'json' | 'base64';
  maxBytes?: number;
  /** 幂等请求可开启宿主重试（指数退避，最多 2 次） */
  retry?: boolean;
}

export interface NetResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  finalUrl: string;
  bytes: number;
  fromCache: boolean;
}

export interface NetClient {
  request(req: NetRequest): Promise<NetResponse>;
  /** 下载到插件沙箱目录，返回相对路径（大文件不要走 JSON 通道） */
  download(req: NetRequest & { toPath: string }): Promise<{ path: string; bytes: number; mime?: string }>;
  /** 宿主受限 HTML 解析：把 cheerio 留在宿主，避免沙箱性能与体积问题 */
  parseHtml?(html: string, spec: { selector: string; attr?: string; limit?: number }): Promise<Array<{ text?: string; attrs: Record<string, string> }>>;
}

// ============================================================ 认证（插件永不接触凭证）

export interface SessionInfo {
  provider: string;
  accountLabel?: string;
  expiresAt?: number;
  state: 'active' | 'expired' | 'revoked';
}

export interface AuthClient {
  /** 需要交互时由宿主弹出自己的登录界面（OAuth / CAS / 表单代填） */
  login(provider: string, opts?: { account?: string; interactive?: boolean }): Promise<SessionHandle>;
  /** 静默获取已有会话；Worker 重启后句柄失效时用它续期 */
  session(provider: string): Promise<SessionHandle>;
  sessions(provider?: string): Promise<SessionInfo[]>;
  logout(provider: string, accountLabel?: string): Promise<void>;
}

// ============================================================ 通知 / 调度 / 文件 / 密钥

export interface LocalNotification {
  id?: string;
  title: string;
  body?: string;
  /** 点击后宿主打开的 deep link，例如 matrix://event/<id> */
  deepLink?: string;
  /** 数据通路，通知点击后回传插件 */
  data?: JsonObject;
  /** 用于分组与去重 */
  groupKey?: string;
}

export interface NotifyClient {
  show(n: LocalNotification): Promise<string>;
  cancel(id: string): Promise<void>;
  cancelGroup(groupKey: string): Promise<void>;
  permission(): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission(): Promise<'granted' | 'denied'>;
}

export interface ScheduleClient {
  /** 一次性任务（精确需要 bg.exact，未授权时宿主自动降级并回报 precision） */
  at(when: number, taskId: string, payload?: JsonObject): Promise<{ id: string; precision: 'exact' | 'inexact' }>;
  /** 周期任务（Android WorkManager 最小 15 分钟） */
  periodic(intervalMin: number, taskId: string, payload?: JsonObject): Promise<{ id: string; actualIntervalMin: number }>;
  cancel(id: string): Promise<void>;
  list(): Promise<Array<{ id: string; at?: number; intervalMin?: number; precision: string }>>;
}

export interface FsClient {
  /** root 由宿主决定：plugin-data（持久）/ cache（可清理）/ temp */
  read(root: 'plugin-data' | 'cache' | 'temp', path: string): Promise<Uint8Array>;
  write(root: 'plugin-data' | 'cache' | 'temp', path: string, data: Uint8Array | string): Promise<void>;
  list(root: 'plugin-data' | 'cache' | 'temp', dir: string): Promise<Array<{ name: string; dir: boolean; bytes: number; mtime: number }>>;
  remove(root: 'plugin-data' | 'cache' | 'temp', path: string): Promise<void>;
  /** 交给系统打开（宿主负责 MIME 判定与安全提示） */
  openWithSystem(root: 'plugin-data' | 'cache', path: string): Promise<void>;
}

export interface SecretsClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// ============================================================ 信任（见 DESIGN §5.7）

export interface TrustClient {
  /** 当前信任等级 */
  level(): Promise<TrustLevel>;
  /** 请求用户授予「远程代码信任」。宿主负责弹出说明页（来源域名 + 原因 + 风险）。 */
  requestRemoteCodeTrust(): Promise<'granted' | 'denied'>;
  /**
   * 加载**已安装且已验签**的其他插件模块。
   * 注意：代码在**调用方**的沙箱内、用**调用方**的权限执行 —— 不产生权限提升（不变量 I5）。
   * 需要把目标插件声明在 manifest 的 dependencies 中。
   */
  loadModule(pluginId: string, entry?: string): Promise<void>;
  /**
   * 执行运行时获取的代码。未授予信任时抛 ETRUST。
   * 即使在已信任状态下，代码也只在当前沙箱内运行（不变量 I6）。
   */
  evalRemote(source: string, opts?: { url?: string }): Promise<unknown>;
}

// ============================================================ LLM（强制本地）

export interface LlmClient {
  /** 宿主保证本地推理；无本地模型时抛 ENOTFOUND，插件应降级为规则解析 */
  complete(req: {
    prompt: string;
    system?: string;
    /** 期望的输出 JSON Schema，宿主可据此约束解码 */
    schema?: JsonObject;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ text: string; json?: JsonObject; model: string; ms: number }>;
}

// ============================================================ UI

export interface SchemaNode {
  /** 只能引用宿主或已安装插件注册的组件 */
  component: string;
  /** 组件归属：'host' | 'plugin:<id>' */
  from?: string;
  id?: string;
  props?: JsonObject;
  /** 声明式数据绑定，不是表达式代码 */
  bind?: Record<string, string>;
  style?: { card?: 'flat' | 'elevated' | 'outlined'; accent?: 'primary' | 'neutral' | 'danger'; density?: 'compact' | 'comfortable' | 'spacious' };
  span?: { mobile?: number; desktop?: number };
  children?: SchemaNode[];
  when?: string;
}

export interface ComponentDecl {
  name: string;
  owner: string;
  propsSchema: JsonObject;
  /** first-party：宿主内直接渲染；remote：宿主分配 iframe 矩形 */
  render?: (props: JsonObject, ctx: { navigate(route: string): void; emit(event: string, payload?: JsonValue): void }) => unknown;
  remote?: { entry: string; minHeight?: number };
}

export interface UiClient {
  registerComponent(decl: ComponentDecl): void;
  /** 注册命令，可在布局里作为按钮动作引用 */
  registerCommand(decl: CommandDecl & { run: () => void | Promise<void> }): void;
  navigate(route: string): Promise<void>;
  openView(viewId: string, params?: JsonObject): Promise<void>;
  /** 在宿主预留的插槽里放一个 Schema（例如首页卡片区） */
  setSlot(slotId: string, schema: SchemaNode | null): void;
  toast(message: string, level?: 'info' | 'warn' | 'error'): void;
  confirm(req: { title: string; body?: string; actions: string[] }): Promise<number>;
  theme(): { mode: 'light' | 'dark'; seed: string; density: string; tokens: Record<string, string> };
}

// ============================================================ 日志

export interface LogClient {
  debug(msg: string, data?: JsonObject): void;
  info(msg: string, data?: JsonObject): void;
  warn(msg: string, data?: JsonObject): void;
  error(msg: string, data?: JsonObject): void;
}

// ============================================================ 插件入口契约

export interface PluginContext {
  readonly host: HostInfo;
  readonly log: LogClient;
  readonly db: DbClient;
  readonly bus: BusClient;
  readonly net: NetClient;
  readonly auth: AuthClient;
  readonly notify: NotifyClient;
  readonly schedule: ScheduleClient;
  readonly fs: FsClient;
  readonly secrets: SecretsClient;
  readonly trust: TrustClient;
  readonly ui: UiClient;
  readonly llm: LlmClient;
}

export interface PluginModule {
  /** 插件激活：注册 contributes、建立订阅、准备同步 */
  activate(ctx: PluginContext): void | Promise<void>;
  /** 宿主即将回收 Worker：尽力保存状态，不要做长任务 */
  suspend?(ctx: PluginContext): void | Promise<void>;
  /** 用户停用插件 */
  deactivate?(ctx: PluginContext): void | Promise<void>;

  // ---- connector 形态 ----
  connectors?: Record<string, {
    /** 首次全量同步 */
    fullSync(ctx: PluginContext, session: SessionHandle): Promise<void>;
    /** 增量同步；cursor 由宿主在 sync_state 中持久化 */
    deltaSync(ctx: PluginContext, session: SessionHandle, cursor: string | null): Promise<{ cursor: string | null }>;
    /** 健康检查：宿主据此在 UI 上标记「连接器可能已失效」 */
    health?(ctx: PluginContext, session: SessionHandle): Promise<{ ok: boolean; detail?: string }>;
  }>;

  // ---- parser 形态 ----
  parsers?: Record<string, {
    parse(ctx: PluginContext, input: { source: string; text: string; ts: number; meta?: JsonObject })
      : Promise<Array<{ title: string; dueAt?: number; courseHint?: string; links?: string[]; confidence: number; evidence?: string }>>;
  }>;

  // ---- 后台任务 ----
  tasks?: Record<string, (ctx: PluginContext, payload: JsonObject) => Promise<void>>;
}

// ============================================================ RPC 线协议（沙箱内部使用）

export interface RpcRequest { id: number; method: string; params: unknown }
export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: PluginError };

/** 握手：宿主在激活插件前发送，插件返回其实际需要的 API 版本 */
export interface Handshake {
  host: HostInfo;
  pluginId: string;
  granted: Permissions;
  /** 被拒绝的声明，插件可据此禁用部分功能而不是崩溃 */
  denied: Permissions;
  /** 当前信任等级；受限模式下插件应只启用声明式功能 */
  trust: TrustLevel;
}
