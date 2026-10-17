# `@matrix/plugin-api` v1 —— 插件作者 API 参考

> 对应 `CURRENT_API_VERSION = '1.0.0'`。宿主支持窗口 **N-2**（当前 = 1.x，最老 = 1.x）。
>
> 这份文档描述的是**已经落地的实现**（`packages/plugin-api/src/v1/`），
> 外部文件安装的当前支持子集见 [外部插件指南](../../docs/plugins/README.md)。
> 不是设计草案。凡是**提案**或**尚未实现**的内容，都单独标了 ⚠️。

---

## 0. 先读这一段

**插件不碰网络，不碰存储，不碰凭证，不碰时钟。插件是纯函数。**

这不是风格偏好，是被实测证伪逼出来的架构决定。插件侧写
`await ctx.net.request(...)` 在顺序调用第二次时**必崩** ——
QuickJS 的 asyncify 状态是 WASM 模块实例级的全局状态，一处损坏全局连坐
（证据：`spikes/p0/REPORT.md` §4）。

所以插件只**产出请求描述**，宿主代跑一切 IO，把响应体当普通字符串传回来。
全程同步，没有 Promise，没有 `await`，没有回调。

如果你写过 VS Code 插件或 Service Worker，需要主动忘掉几件事：

| 你可能习惯 | 在 Matrix 里 |
|---|---|
| `async` 处理器 | ❌ 契约里全是同步函数 |
| 自己 `fetch()` | ❌ 返回 `PlannedRequest`，宿主去发 |
| 直接读写数据库 | ❌ 只经 `DataBus` 的 `emit` / `read` |
| 自己读 `Date.now()` | ❌ 宿主通过 `PlanInput.now` 给你 |
| 在插件里存 token | ❌ 凭证由宿主持有，插件只给「用哪个会话」 |

---

## 1. 三十秒上手

一个最小的连接器插件。它拉一页 JSON，落成 `course` 实体。

```ts
import type { PluginExports, PlanInput, ParseInput, ParseResult } from '@matrix/plugin-api';

/** 累积状态留在**模块作用域**。为什么必须这样，见 §6。 */
let page = 1;

export const plan = (input: PlanInput) => ({
  requests: [
    {
      id: 'courses',
      method: 'GET' as const,
      url: `https://ecloud.example.edu/api/courses?page=${page}`,
      parse: 'courses',          // ← 用哪个 parser 处理这个响应
    },
  ],
});

export const parsers = {
  courses: (input: ParseInput): ParseResult => {
    const rows = JSON.parse(input.body) as Array<{ name: string; teacher: string }>;
    page += 1;                    // 状态留在自己这里，不要跨边界传
    return {
      entities: rows.map((r) => ({
        type: 'course',
        id: r.name,               // 稳定主键；不给则宿主按内容哈希生成
        data: { title: r.name, teacher: r.teacher },
      })),
      cursor: String(page),       // 只回传**增量**
      summary: `拉到 ${rows.length} 门课`,
    };
  },
} satisfies PluginExports;
```

配套的 `manifest.json`：

```json
{
  "id": "org.shtu.ecloud",
  "name": "E云课堂连接器",
  "version": "1.2.0",
  "apiVersion": "^1.0.0",
  "kind": "connector",
  "entry": "bundle.js",
  "permissions": {
    "data": { "write": ["course"], "read": ["course"] },
    "net": { "domains": ["ecloud.example.edu"], "methods": ["GET", "POST"] }
  },
  "contributes": {
    "entityTypes": [
      {
        "name": "course",
        "schema": {
          "type": "object",
          "properties": {
            "title": { "type": "string", "maxLength": 200 },
            "teacher": { "type": "string" }
          },
          "required": ["title"]
        }
      }
    ]
  }
}
```

宿主驱动这一轮的顺序是：

```
plan(input)  →  校验每个 URL  →  发请求  →  parsers[name](响应)  →  next(step)  →  回到「校验 URL」
```

`next` 返回 `null` 或不再产出请求，循环结束。

### 1.1 最小可复制骨架

内置插件是一个目录 + **一个导出对象**，由应用构建并注册。外部插件打包为 `.mtp`，入口为 `globalThis.plugin`；格式与命令见 [插件指南](../../docs/plugins/README.md)。

```
my-plugin/
  manifest.ts   ← 导出 manifest 对象
  index.ts      ← 导出 { plan, parsers }
```

**`manifest.ts`**

```ts
import type { EntitySchema, Manifest } from '@matrix/plugin-api';

export const PLUGIN_ID = 'org.example.myplugin';

const thingSchema: EntitySchema = {
  type: 'object',
  properties: { title: { type: 'string', maxLength: 200 } },
  required: ['title'],
  additionalProperties: false,   // 默认就是 false，写出来是为了提醒自己
};

export const manifest: Manifest = {
  id: PLUGIN_ID,
  name: '我的插件',
  version: '0.1.0',
  apiVersion: '^1.0.0',
  kind: 'first-party',           // 见 §2 的形态表
  permissions: {
    data: { write: ['thing'], read: [] },
    // 需要网络再加：net: { domains: ['api.example.com'], methods: ['GET'] }
  },
  contributes: { entityTypes: [{ name: 'thing', schema: thingSchema }] },
};
```

**`index.ts`**

```ts
import type {
  ParseInput, ParseResult, PlanInput, PluginExports, RequestPlan,
} from '@matrix/plugin-api';

export function plan(input: PlanInput): RequestPlan {
  return {
    requests: [
      { id: 'r1', method: 'GET', url: 'https://api.example.com/things', parse: 'things' },
    ],
  };
}

export const parsers: PluginExports['parsers'] = {
  things: (input: ParseInput): ParseResult => ({
    entities: (JSON.parse(input.body) as Array<{ name: string }>).map((t) => ({
      type: 'thing',
      data: { title: t.name },
    })),
  }),
};

/** ← 这一行就是整个契约。宿主拿到的就是它 */
export const myPlugin: PluginExports = { plan, parsers };
```

> **`kind` 与 `entry` 的一处别扭**：进程内运行时**根本不读** `entry`，
> 但除了 `declarative` / `first-party` 之外的形态都**强制要求**它。
> 所以用 `logic` / `connector` 写第一方插件时，你得填一个不存在的文件名。
> 已知的契约毛刺 —— 要么用 `kind: 'first-party'`，要么随便填个名字。

### 1.2 宿主怎么加载我

宿主侧只有三步，**都不在插件里**：

```ts
// ① 把模块对象登记进进程内运行时。键是 manifest 的 id
const host = new PluginHost({
  core,
  modules: new Map([[PLUGIN_ID, myPlugin]]),   // ← 上面那个导出对象
});

// ② 安装 manifest
await host.install(manifest, {
  activate: true,
  allowReservedPrefix: true,   // ← 只有编译进应用的插件才传，见 §3.1
});

// ③ 跑一轮
await host.sync(PLUGIN_ID, { trigger: 'manual', now: Date.now() });
```

四个必须知道的事实：

- `modules` 是内置插件的 `ReadonlyMap<string, PluginExports>`；匹配失败时可进入外部 QuickJS 运行时。内置模块继续进程内执行。
- 设置页支持导入 `.mtp`（ZIP 根目录 manifest.json + bundle.js），确认权限后安装。外部入口使用 `globalThis.plugin`；签名尚未验证。首版支持范围见 [外部插件指南](../../docs/plugins/README.md)。
- `kind` 参与契约核对，但不是来源证明或密码学认证；外部入口另行拒绝内置身份及保留 ID。
- `sync()` 由宿主驱动；外部插件没有定时器、订阅或后台主动入口。`syncIntervalMin` 不会自动产生调度。

---

## 2. 插件形态

```ts
type PluginKind = 'declarative' | 'logic' | 'connector' | 'ui' | 'first-party';
```

| 形态 | 有代码？ | 典型用途 | 入口 |
|---|---|---|---|
| `declarative` | ❌ 纯数据 | 只贡献视图/命令，无逻辑 | **不需要** `entry` |
| `logic` | ✅ | 纯计算：解析、格式化、规则 | 需要 |
| `connector` | ✅ | 对接外部平台，`plan`/`parsers`/`next` | 需要 |
| `ui` | ✅ | 贡献声明式 UiNode（外部代码在 QuickJS 内执行） | 需要 |
| `first-party` | ✅ | 编译进应用的宿主内置 / 官方插件 | 可选 |

⚠️ **`kind` 会被严格核对。** 宿主加载插件后，运行时自报的 `kind` 必须与 manifest 声明的
`kind` **逐字相同**，否则以 `EMANIFEST` 拒绝激活。

> 这条核对在进程内运行时（第一方插件）里是以 manifest 为准的 —— 模块本来就是宿主自己塞进去的，
> 它没有独立知识。当前 QuickJS 运行器也按 manifest 返回 kind；核对只保证契约一致，
> 不提供来源认证。外部路径、保留命名空间校验与独立解释器另行承担准入和执行隔离。

---

## 3. Manifest v1 完整参考

```ts
interface Manifest {
  id: string;                 // 反向域名风格，见下方规则
  name: string;
  version: string;            // 严格 semver，不含 range 语法
  apiVersion: string;         // semver **range**，如 "^1.0.0"
  kind: PluginKind;
  entry?: string;             // declarative 可省略
  engines?: { platform?: string[] };
  permissions?: ManifestPermissions;
  capabilities?: ManifestCapabilities;
  contributes?: ManifestContributes;
  dependencies?: string[];    // 依赖的插件 id
  integrity?: ManifestIntegrity;
}
```

### 3.1 `id` 的规则

正则：`^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$`

- 至少**两段**，点分隔；每段必须以**小写字母**开头
- 后续段可含数字与 `-`（首段不可含 `-`）
- 全小写，无下划线

**保留前缀**（默认 `EMANIFEST` 拒绝）：

| 前缀 | 归属 |
|---|---|
| `dev.matrix.*` | 宿主内置插件（与 `appId: dev.matrix.shell` 同命名空间） |
| `app.matrix.*` | 官方第一方插件 |
| 其它 | 第三方自由取，推荐反向域名 |

**唯一的开锁方式**：宿主在加载「编译进应用的」插件时显式传 `allowReservedPrefix: true`
（`validateManifest(raw, { allowReservedPrefix: true })`）。

> 为什么不是看 `kind === 'first-party'`：`kind` 是 manifest **自己声称**的东西，
> 第三方照抄就能绕过（运行时自报的 kind 本来就以 manifest 为准）。而「这个文件是编译进应用的」
> 是**宿主知道、manifest 无法声称**的事实。拿前者当豁免条件，那就是个假开关。
>
> 第三方安装流程永远不传这个开关。TODO(签名)：签名落地后它应被「官方密钥签名验证通过」取代。

> 保留的**只是自命名**。第三方插件**可以依赖** `app.matrix.*` 或 `dev.matrix.*` 的插件 ——
> `dependencies: ["dev.matrix.core"]` 完全合法。「我叫什么」和「我依赖谁」是两件事。

### 3.2 `permissions`

```ts
interface ManifestPermissions {
  data?:   { write?: string[]; read?: string[] };
  net?:    { domains?: string[]; methods?: string[] };
  auth?:   { providers?: string[] };
  notify?: boolean;
  background?: { periodic?: boolean; exact?: boolean };
  secrets?: boolean;
  fs?:     'none' | 'sandbox';
  ui?:     { components?: string[]; slots?: string[] };
  db?:     { raw?: boolean };
  llm?:    { local?: boolean };
  local?: boolean;            // 宿主提供的本地资源（用户选的文件、剪贴板、分享进来的文本）
  stream?: boolean;           // ⚠️ 二期能力，声明了宿主也会拒
}
```

**默认全部拒绝。** 没声明的能力一律拿不到，报 `EPERM`。

`net.domains` 的写法（`isValidDomainPattern()`）：

- ✅ `example.com` —— 精确匹配，**不含**子域
- ✅ `*.example.com` —— 匹配任意层子域，**不含**根域 `example.com` 本身
- ❌ 带 scheme（`https://…`）、带路径、带端口、IP 字面量、大写字母

> 这里只拦「明显写错了」，目的是让你在**打包时**就收到明确报错。
> **权威的匹配规则**在核心层 `apps/shell/src/core/allowlist.ts`。
> 两处目前是重复实现 —— **这是已知的技术债**，待 `packages/net` 抽出后改为单向依赖。
> 已有跨包差分测试（`plugin-api-diff.test.ts`）守着两份实现不漂移。

`net.methods` 若留空 = 不限制方法。

### 3.3 `capabilities`

```ts
interface ManifestCapabilities {
  untrustedRemote?: false | 'limited';
  restrictedSettings?: string[];
  remoteCode?: {
    reason: string;                        // 必须展示给用户：为什么需要远程代码
    origins: string[];                     // 至少一个，否则用户批不了
    signature?: 'required' | 'optional';
  };
}
```

`remoteCode` 是「我要在运行时下载并执行代码」的声明。**默认拒绝**（D7）。
声明了也只是「可以申请」；用户显式授予后才进 `remote-trusted`。

### 3.4 `contributes`

```ts
interface ManifestContributes {
  entityTypes?: unknown[];                                   // 见 §7
  views?: unknown[];
  commands?: Array<{ id: string; title: string }>;
  connectors?: Array<{ id: string; authProvider?: string; syncIntervalMin?: number }>;
  accounts?: AccountContribution[];                         // Android外部网页登录，最多一个，见下文
}
```

### 当前宿主的外部账号与页面

`AccountContribution` 由本包公开导出，形状为 `{id, title, loginUrl, authOrigins, dataOrigins}`。精确 HTTPS origin 可含端口、不含路径、通配符和 IP，每组 1–8 个。`permissions.auth.providers` 必须与账号 ID 一致，数据主机还须精确出现在 `net.domains`。完整 JSON 示例见 [插件指南](../../docs/plugins/README.md)。

宿主负责打开官方网页、保存隔离 Profile 和携带会话请求；纯函数不接触 Cookie/密码，不增加异步登录 API。每插件一个账号；仅 Android 且 WebView 支持 MULTI_PROFILE 时可用，不支持 popup 或旧 WebView 共享会话回退。点击完成登录后仍由同步判断认证是否有效。

外部 `contributes.views` 的每个视图必须有同 ID 的 `renders`。widget 可独立加入首页，page 可作专属页；按钮 `navigate` 可用自身 page ID 或 `home/timeline/timetable/courses/settings`，不能进入其他插件页面。示例提供 summary、details 两个实际渲染器。

`entityTypes` 的形状**已被 `validateManifest` 校验**（必须是数组、每项 `{ name, schema }`、
名字 snake_case 且不重复、`schema.type === 'object'`、字段类型拼写），
所以写错会在**打包时**就收到带路径的报错，而不是等到 install 才一句 `ESCHEMA`。

⚠️ 但**这个形状本身是提案**，未经真实插件检验：

```ts
entityTypes: Array<{ name: string; schema: EntitySchema }>   // 每项带名字
```

而不是 `{ course: {...}, ddl: {...} }` 这样的映射。理由是 `DataBus.declareSchema()`
需要 `type` 作为一等参数（参与键构造、配额统计、跨插件读取）。

**其余三项的校验程度不一样，别指望它们保护你：**

| 项 | 校验 | 运行时行为 |
|---|---|---|
| `entityTypes` | ✅ 完整形状校验 | ✅ 真正参与落库 |
| `commands` | ✅ `{ id, title }` 都是非空字符串 | ✅ **真的会被执行**（T14）：`Action.kind === 'command'` → 宿主找 `exports.commands[id]` |
| `connectors` | ✅ `id` 非空、`syncIntervalMin` 为正数 | ❌ **没有任何东西读它** —— 没有调度器 |
| `views` | ✅ 目录形状校验（U1） | ✅ 宿主渲染（U2–U4） |
| `slots` / `consumesSlots` | ✅ 形状 + 命名空间 + 上限 | ✅ 宿主写入与校验（B 段，§7.10） |

> `connectors[].syncIntervalMin: 30` **不会**让你的插件每 30 分钟跑一次。
> 现在唯一的驱动方式是宿主显式调 `sync()`。写上它是为将来准备，不是现在生效。

### 3.5 `integrity`

```ts
interface ManifestIntegrity {
  algo: 'ed25519';
  hash: string;
  sig: string;
}
```

⚠️ **签名校验尚未实现**。宿主侧的验签器目前是「全部放行」并报 `fullySigned: false`，
所以所有插件目前都被判定为 `restricted`。真实验签属于 P2。

### 3.6 校验

```ts
function validateManifest(raw: unknown): ManifestValidation;   // 不抛，返回 issue 列表
function loadManifest(raw: unknown): PluginResult<Manifest>;  // 薄包装，失败即 PluginFailure
```

```ts
interface ManifestIssue { path: string; message: string }       // path 便于安装页精确定位
interface ManifestValidation { ok: boolean; issues: ManifestIssue[]; manifest?: Manifest }
```

`validateManifest` **不抛异常** —— 因为它要服务安装页，那里需要**一次列出全部问题**，
而不是修一个报一个。

---

## 4. 权限矩阵

宿主对每一次 RPC 调用判定 `checkPermission(ctx, method, args)`。
**默认拒绝**：表里没有的方法一律 `EPERM`。

| 方法 | 需要声明 | 运行时附加约束（不由本矩阵管） |
|---|---|---|
| `db.get` `db.query` `db.put` `db.delete` | — | 只能碰自己的命名空间（由 Vault / 表名前缀强制） |
| `db.raw` | `db.raw` | 需**人工审核** + 签名白名单 |
| `bus.emit` | `data.write` 含该 `entityType` | Schema 校验、配额、去重合并 |
| `bus.read` | `data.read` 含该 `entityType` | 跨插件读取时按 `shared` 裁字段 |
| `net.request` | 主机在 `net.domains` 内；方法在 `net.methods` 内 | 核心网关白名单、限流、逐跳复检、大小上限 |
| `local.request` | `local` | 宿主侧按 `(pluginId, url)` 分键；**不出网**，不查域名白名单 |
| `auth.login` | `auth.providers` 含该 provider | 凭证永不过边界 |
| `notify.local` | `notify` | 系统通知权限 |
| `schedule.periodic` | `background.periodic` | — |
| `schedule.exact` | `background.exact` | 需系统授权，否则**降级** |
| `secrets.get/set/delete` | `secrets` | 只能碰自己的命名空间 |
| `fs.read/write/list` | `fs: "sandbox"` | 沙箱目录内 |
| `ui.registerComponent` | `ui.components` 含该组件 | — |
| `llm.complete` | `llm.local` | — |
| `trust.evalRemote` | `capabilities.remoteCode` **且** 信任等级 = `remote-trusted` | 两把锁（不变量 I4） |
| `trust.loadModule` | 目标在 `dependencies` 里 | 目标须已安装、已验签 |

**`trust.loadModule` 不会提权**（不变量 I5）：被加载的代码用**调用方自己的权限**执行。

> ⚠️ **这张表在 v0.5 之前有两条是纸闸**，修了之后才真的成立：
>
> - `bus.emit` —— 宿主当时把 emit 直接转给 `DataBus.emit`，`data.write` **根本没被查**
>   （`DataBus` 只查 schema 声明与配额，它不知道 `granted`）。于是 `net` 路径拦得住、
>   写数据那条谁也拦不住，同一个权限引擎两条路径两个行为。
> - `bus.read` —— 同样没查 `data.read`，**现在仍然没查**。原因是唯一调用方是宿主自己的
>   Timeline 视图，它没有插件身份，一加闸就把现有功能掐死。等 Timeline 真的变成插件
>   （拿到 `dev.matrix.timeline` 这个 id）时才补得动。**这条仍然是纸闸，请按「没有读闸」来设计。**
「我依赖你」不等于「我继承你的权限」。

### 受限模式

`trustLevel === 'restricted'` 时，除权限外还有一层硬阻断（`isBlockedInRestrictedMode`）：

- `trust.evalRemote` —— 全禁
- `net.request` —— 连 `remoteCode.origins` 上的请求也禁

### 归一化后的权限集

判定不直接读 manifest（里面全是可选的，每次 `?.` 容易漏），而是先归一化：

```ts
interface GrantedPermissions {
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
  stream: boolean;
}
```

`intersectPermissions(declared, requested)` 校验 `granted ⊆ declared`。
这条不变式必须由**宿主**强制，不能信安装页 —— 安装页只是 UI，用户可以改它。
返回的违规项属于**篡改迹象**，要写审计。

---

## 5. 契约：`plan` / `parsers` / `next`

```ts
interface PluginExports {
  views?: Record<string, unknown>;                    // declarative / ui 形态
  plan?(input: PlanInput): RequestPlan;               // connector / logic 形态
  parsers?: Record<string, (input: ParseInput) => ParseResult>;
  next?(input: StepInput): StepDirective | null;

  onActivate?(): void;
  onSuspend?(): void;
  onDeactivate?(): void;
}
```

### 5.1 产出请求

```ts
interface PlannedRequest {
  id: string;                     // 本次 plan 内唯一；宿主用它对应响应
  method: 'GET' | 'POST';         // ← 只有这两个
  url: string;                    // 网络请求：必须落在 manifest 声明的 domains 内
  headers?: Record<string, string>;
  body?: string;                  // 只能是字符串
  parse: string;                  // ← 必填！用哪个 parser
  source?: 'net' | 'host';        // 缺省 'net'；'host' = 宿主自行满足，不出网
}
```

三个容易踩的点：

1. **`method` 只有 `GET` / `POST`**。契约里就是这样定的，不是笔误。
2. **`parse` 是必填的**。忘了它 → `ESCHEMA`。
3. **`headers` 里不能放凭证头**。`cookie` / `authorization` / `host` / `content-length` 等
   会被宿主**拒绝并报 `EPERM`**（网关还会再剥一次，那是纵深防御）。
   凭证走 vault + 会话句柄，插件永远不自己拼。

> **`source` 写错会当场 `ESCHEMA`**（`source: 'nett'`、`source: 1` 之类）。
> 这一点值得说明：早期不校验，写错的值会**静默退化**成 `'net'` ——
> 打在已授权的 URL 上就当作网络请求正常发出（拼写错误无人发现），
> 打在未授权的 URL 上则以 `ENETDENIED` 报出来，把用户指向「域名不在白名单」这个错误方向。

### 5.2 输入

```ts
interface PlanInput {
  trigger: 'initial' | 'scheduled' | 'manual';
  cursor?: string;                // 上次 sync 留下的**增量**游标（宿主回填，见 §5.3 末）
  now: number;                    // 宿主给的当前时间（epoch ms）
  settings?: Record<string, string>;   // 非敏感配置
}

interface StepInput {
  step: string;                   // 上一步 next 给出的步骤名
  result: ParseResult;            // 上一步的解析结果
  status: number;                 // 上一步那个请求的 HTTP 状态码
}
```

> **插件不得自己读时钟。** 用 `PlanInput.now`。沙箱内读到的时钟不可信，
> 而且自读时钟会让插件难以单测。

两个现在拿不到东西的字段（写插件时别指望）：

| 字段 | 现状 |
|---|---|
| `settings` | ❌ **宿主永远不填** —— 还没有「插件设置页 + 存储」。你拿到的是 `undefined` |
| `trigger: 'scheduled'` | ❌ 没有调度器，永远不会出现。实际只会看到 `'manual'`（或宿主自己传的值） |

### 5.3 输出

```ts
interface ParseResult {
  entities?: ParsedEntity[];
  cursor?: string;                // **增量**游标，不是累积状态（下一轮会回传给你）
  summary?: string;               // 给 UI / 审计看的摘要
  error?: string;                 // 解析失败时填；宿主计入审计，不让插件崩
}

interface ParsedEntity {
  type: string;                   // 必须在 permissions.data.write 里声明过
  id?: string;                    // 缺省时宿主按内容哈希生成
  data: Record<string, unknown>;
}

interface StepDirective {
  next: string;
  requests: PlannedRequest[];
}
```

```ts
interface ParseInput {
  body: string;                   // 就是一段普通字符串
  status: number;
  baseUrl: string;                // ⚠️ 是**响应最终 URL**，不是请求 URL
  credentials?: never;            // ← 类型层面保证「插件想拿凭证」写不出来
}
```

`credentials?: never` 是刻意的：不是文档里说「别拿凭证」，是**类型系统里写不出来**。

**`baseUrl` 的确切语义**（以前没写清，容易猜错）：它是**响应体最终落地的 URL**，
即经过重定向之后的那个地址（宿主传的是 `res.url`）。所以：

- 没有重定向时，它等于你请求的 URL；
- 有重定向时，它是**最后那一跳**的地址 —— 你可以用它来解析相对链接
  （`new URL(href, input.baseUrl)`），这是它存在的主要理由；
- 它**不是**目录，不会自动补 `/`。要拼路径请用 `new URL()`，别用字符串拼接。

**parser 抛异常会怎样**：宿主 `callPlugin()` 会捕获它，转成 `EINTERNAL`，
message 是 `插件 X 的 parsers() 抛出异常: ...`。**这一轮同步整体失败**
（不是「这一个请求失败、继续下一个」），因为 parser 崩了通常意味着插件状态已经不可信。
若只是「这份数据解析不了」，**不要抛** —— 返回 `{ error: '...' }`，
那样只记进 `SyncReport.errors`，其它请求继续。

#### 游标是怎么走通的

`cursor` 曾经是个**死字段** —— 契约里有，宿主从不读，于是 `PlanInput.cursor` 永远填不上，
分页永远不续上，而且**不报错**。现在是接通的：

```
parsers 返回 { cursor: 'page=2' }
      ↓
SyncReport.cursor = 'page=2'          ← 本轮**最后一个**非空值
      ↓
宿主存进 Map<pluginId, string>
      ↓
下一次 sync() → PlanInput.cursor = 'page=2'
```

三条要知道的：

- **一轮里多个请求只留一个游标**（最后一个非空值）。契约只给了一个游标位 ——
  真要按请求分别记进度，那是二期的事。
- **调用方显式传 `cursor` 时优先**（比如用户点了「从头同步」）。
- ⚠️ **目前只有进程内持久化**，重启即失 —— 与信任记录是同一个缺口。
  也就是说：分页在**一次应用运行期间**是可靠的，跨重启不保证。

---

### 5.4 本地导入与「无需 IO 的产出」

两件事经常一起出现，但成因不同。

#### ① 本地导入：文档不从网络来

插件声明一个 `source: 'host'` 的请求，宿主自己满足它 —— 用户在界面上选了文件、
从剪贴板粘贴、或者系统把文本分享进来。

```ts
export const plan = (input: PlanInput) => ({
  requests: [
    {
      id: 'ics',
      method: 'GET',
      url: 'host://import',     // ← 不透明键，不是文件路径
      parse: 'ics',
      source: 'host',
    },
  ],
});

export const parsers = {
  ics: (input: ParseInput): ParseResult => ({
    entities: parseIcs(input.body),   // input.body 就是文件内容
  }),
};
```

四个要点：

- **`url` 是宿主的查找键，不是路径。** 插件无法通过它指到文件系统上的任何文件，
  只能取到宿主**主动放进来**的东西。真正选择哪个文件的是用户。
- **不出网，所以不查域名白名单。** 但仍需要声明 `permissions.local: true`。
- **隔离靠 `(pluginId, url)` 分键。** 插件 A 读不到插件 B 导入的东西。
- **`parsers` 的语义完全不变。** 本地文档在插件眼里就是一份响应体 ——
  这也是为什么这里只加了一个**来源判别位**，而不是给插件开第二个入口。

宿主侧对应的 API 是 `host.provideLocal(pluginId, url, text)`，返回 `PluginResult<void>`：

- 超过 `maxLocalBytes`（默认 8 MiB）→ **当场** `ETOOBIG`。不检查的话，50 MB 的文件会
  先进内存、再跨沙箱边界、最后才被 broker 的 `maxBodyBytes` 拒 —— 拒是拒了，代价已经付了。
- ⚠️ **导入完成后请由 UI 调 `host.clearLocal(pluginId, url)`。** 否则之后每一次 `sync()`
  都会再解析同一份文件 —— 用户会看到数据被重复导入，而且**没有任何报错**。
  卸载时会自动清掉。

#### ② 无需 IO 的产出：`plan()` 可以直接返回实体

```ts
export const plan = (input: PlanInput): RequestPlan => ({
  requests: [],
  entities: [{ type: 'course', data: { title: '算出来的' } }],
  summary: '本地计算，没有出网',
});
```

为什么必须有它：`bus.emit` 是插件写入数据的**唯一**通路，而它挂在请求循环里。
没有这个字段的话，一个不发请求的 `kind: 'logic'` 插件**永远产不出数据** ——
而且同步会返回 `ok`，**静默**什么都不做。

需要文档时不要用它，走 `requests` + `parsers`。

## 6. 状态机写法纪律（实测，别跳）

多步流程（分页、先登录再拉数据、跟随游标）用 `next`：

```ts
export const next = (input: StepInput): StepDirective | null => {
  if (input.step === 'login') {
    return { next: 'courses', requests: [coursesRequest(1)] };
  }
  return null;                     // 结束
};
```

**硬性纪律：累积状态留在插件模块作用域内，跨边界只传增量与摘要。**

这条有实测数据支撑（`spikes/p0/REPORT.md` §5.3）。把累积状态每步传进传出，
会让单步耗时**随步数线性上升**，合计 O(n²)：

| 步数 | 朴素写法（状态跨边界） | 状态留沙箱 | 差距 |
|---|---|---|---|
| 20 | 95.8 µs/步 | ~19 µs/步 | 5× |
| 100 | 304.7 µs/步 | ~19 µs/步 | 16× |
| 400 | **1.04 ms/步** | 19.0 µs/步 | **54.7×** |

原因是每次跨边界都要把整个累积状态序列化一遍。400 步的朴素写法总耗时是「留沙箱」的 **54.7 倍**。

同一份纪律也写在代码里（`STEP_STATE_GUIDANCE`），这样它在**类型提示里**可见，
而不只是躺在文档某一行。

相关实测事实（都来自 P0）：

- 沙箱实例在多次调用之间是**存活**的 —— 连续 3000 次同步回调后状态完好。
- 固定调用开销 ≈ **16 µs/次**。
- 1 MiB 载荷：`newString` + 沙箱内 `JSON.parse` 比 `evalCode(JSON 字面量)` 快 **3.56×**
  （54.9 MB/s vs 15.4 MB/s），吞吐饱和点 ≈ 185 MB/s。

---

## 7. 数据总线

插件**永远不写 SQL**（决策 D3）。写入经 `bus.emit`，读取经 `bus.read`。

### 7.1 声明实体类型

写入前**必须**在 manifest 的 `contributes.entityTypes` 里声明过，否则 `ESCHEMA`。

> 下面这两个类型**定义在本包里**（`src/v1/schema.ts`），内核 `import` 它们。
> 为什么：`EntitySchema` 出现在 manifest 的 `contributes.entityTypes` 里 ——
> 它是**插件契约的一部分**，不是内核的内部结构。放在内核里的话，
> manifest 校验只能把它当 `unknown[]`，形状错了查不出来，
> 而 `registry` 还得写一句 `decl.schema as EntitySchema` 的强制转换。

```ts
interface FieldSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  enum?: unknown[];
  maxLength?: number;
  items?: FieldSchema;            // 数组元素
  nullable?: boolean;             // 默认 false
  shared?: boolean;               // 默认 true，见 §7.3
}

interface EntitySchema {
  type: 'object';
  properties?: Record<string, FieldSchema>;
  required?: string[];
  additionalProperties?: boolean; // 默认 false —— 多出来的字段一律拒绝
}
```

类型名必须是 `snake_case`：`/^[a-z][a-z0-9_]*$/`。

几个容易踩的点：

- **`type` 是可选的**。不写 `type` 的字段只做 `enum` / `null` 检查，不做类型检查。
- **`additionalProperties` 默认 `false`**。schema 里没声明的字段会被**拒绝**（`ESCHEMA`），
  而不是被忽略。这是刻意的：宁可让作者补 schema，也不要静默丢弃数据。
  想放宽就显式写 `"additionalProperties": true`。
- **`null` 默认不允许**，要显式 `"nullable": true`。
- **`maxLength` 数的是 UTF-16 码元**（即 `value.length`），不是字节，也不是码点。
  对中文等价于「字数」；但一个 emoji 算 2。注意它和 §7.4 的**配额**口径不同 ——
  配额按 UTF-8 字节算，`maxLength` 按码元算。

**运行时到底怎么判**（逐条照 `validateEntity` 抄的，不用猜）：

| 声明 | 实际检查 | 会被拒的例子 |
|---|---|---|
| `required: [...]` | 键**存在**即可（`Object.hasOwn`），值可以是 `undefined` | 少了 `title` 键 |
| `additionalProperties: false`（默认） | 多出来的键**逐个报错**，不会静默丢 | 写了 `teacher` 但没在 schema 里声明 |
| `type: 'string'` | `typeof === 'string'`，再查 `maxLength` | `42`、`null`（除非 `nullable`） |
| `type: 'number'` | `typeof === 'number'` **且** `Number.isFinite` | `NaN`、`Infinity`、`'1.5'` |
| `type: 'integer'` | `Number.isInteger` —— **`1.5` 会被拒** | `1.5`、`NaN` |
| `type: 'boolean'` | `typeof === 'boolean'` | `0`、`'true'` |
| `type: 'array'` | `Array.isArray`；**给了 `items` 就逐项递归校验**（错误路径带下标 `tags[2]`） | `'[]'`、类数组对象；元素类型不符 |
| `type: 'object'` | 只查「是普通对象」，**不递归校验内部字段** | `[]`、`'{}'` |
| `enum: [...]` | `Array.includes(value)` —— **严格 `===`** | `enum: [1]` 时传 `'1'` |
| `nullable: true` | 允许 `null`，且**跳过后续所有检查** | — |

三个由此推出的写法建议：

- **`enum` 别混类型**。`enum: ['a', 1]` 合法但很危险，`1` 和 `'1'` 是两个值。
- **`array` 的 `items` 是支持的，`object` 的不是。** 数组可以逐项校验
  （`items` 递归，所以 `array of array` 也行），但 `type: 'object'` 的字段**完全不检查** ——
  要嵌套结构，要么拍平成多个实体，要么 `JSON.stringify` 成 string 字段自己解析。
- **`required` 只查键存在**。要「不能为空串」得靠 `enum` 或自己校验。

### 7.2 命名空间隔离

**记录键是 `pluginId \0 type \0 id`。** 两个插件写同一个 `type` + `id` **不会**互相覆盖。

> 这一条是修补出来的：原实现的键不含 `pluginId`，后写的会静默覆盖先写的。
> 更糟的是，没给 `id` 时宿主按**内容哈希**生成 id —— 攻击者只要猜到对方的内容
> 就能刻意碰撞，跨插件篡改别人的数据。
>
> 跨插件**读**不受影响（`read()` 按 `type` 遍历整张表），所以 Timeline 聚合照旧可用。

### 7.3 跨插件读取与字段裁剪

`read(readerPluginId, type)` 在**跨插件**读取时按 `shared` 裁字段；读自己写的记录**不裁**
（否则你拿不回自己存的东西）。

```jsonc
"properties": {
  "title":        { "type": "string" },
  "internalNote": { "type": "string", "shared": false }   // 跨插件读取时被裁掉
}
```

**为什么需要它**：Timeline 要读别的插件的数据，但「能读这门课」不等于
「能读这门课的内部备注」。没有字段级裁剪，跨插件读取就只有「全给」和「全不给」两个选项，
前者迟早泄漏内部字段。

⚠️ **这是提案，未经真实插件检验**。`shared` 的默认值（缺省视为共享）也是提案 ——
更保守的默认是「缺省不共享」，但那会让绝大多数插件作者踩坑，所以选了显式 `false` 才裁。

### 7.4 配额

```ts
const DEFAULT_QUOTA = {
  maxRowsPerPlugin: 20_000,
  maxBytesPerPlugin: 8 * 1024 * 1024,   // 8 MiB
};
```

超限 → `EQUOTA`。

**字节按 UTF-8 真实字节算，不是 `String.length`。** 一个汉字在 UTF-8 里占 3 字节，
`.length` 只算 1 —— 按码元算的话中文内容的实际占用会被**低估到三分之一**，配额形同虚设。

### 7.5 写入语义：按 `id` 覆盖（upsert）

`bus.emit` **不是 append**：

| 情况 | 行为 |
|---|---|
| 给了 `id`，该 `id` 已存在 | **整体覆盖** `data`，`revision` 加 1 |
| 给了 `id`，不存在 | 新增一行 |
| **没给 `id`** | 按**内容哈希**生成（`h...`）—— 同样的内容永远落到同一行 |
| 载荷不合 schema | `ESCHEMA`，带逐字段 issue，不写 |
| 超出配额 | `EQUOTA`，不写（先算新状态再决定） |

由此得到两条实践：

- **重复导入不会产生重复行** —— 前提是你给了**稳定的 `id`**（比如 ICS 的 `UID`）。
  不给 id 时靠内容哈希，改了任何一个字就是新行。
- **这是覆盖，不是合并。** 后一次写入会整体替换 `data`，没有字段级 merge。
  想「只改一个字段」就得先读出来、改、再整体写回。

> ⚠️ §4 权限矩阵里 `bus.emit` 那一行写着「去重合并」—— 那是设计意图。
> **实现是按 `id` 覆盖**，没有合并。以本节为准。

---

## 7.9 控件（UI）：把数据画成界面

> 编号说明：本节插在 §7（数据总线）与 §8（错误码）之间。**后面各节编号刻意不动**，
> 这样已有的交叉引用全部保持有效。

### 7.9.1 一句话

插件**不持有 UI**。它产出一棵 `UiNode` 树，宿主把树渲染成 DOM。
输入**不回调插件**，输入变成 `Action` 由宿主路由。

```
数据 → render(纯函数) → UiNode → 宿主渲染 → 用户操作
     → Action → 宿主路由 → 改数据 → 重新 render
```

### 7.9.2 为什么是数据不是代码

三个理由，缺一个这个设计就不成立：

1. **D8 不允许回调。** 插件是纯函数，没有异步宿主 API，也不持有状态。
   一个「处理点击」的 React 组件必须有回调，有回调就得有活的插件对象 —— 那就把 D8 拆了。
2. **沙箱只能传 JSON。** 当前第三方插件跑在 QuickJS 里，React 组件跨不过去，
   JSON 树天然可以，因此内置与外部插件共用声明式 UI 契约。
3. **能在 Node 里测。** `render()` 是纯函数，断言输出树就行 —— 不需要 jsdom、不需要浏览器。
   宿主的渲染器也是用 `createElement` 写成 `.ts` 的，所以「UI 能测」不是口号。

### 7.9.3 目录在 manifest，实现在代码

两处必须对上，宿主会**交叉核对**（对不上会记警告，不会崩）：

```ts
// manifest.ts —— 纯数据，可校验、可序列化
contributes: {
  views: [
    {
      id: 'course-list',          // kebab-case，插件内唯一
      title: '课程',
      kind: 'widget',             // 'page' 占整屏 | 'widget' 嵌进布局格子
      requires: ['course', 'session'],   // 要读哪些实体类型
      defaultProps: {},                  // 布局没配参数时用这份
      defaultSize: { w: 12, h: 1 },      // 栅格尺寸，1..12
    },
  ],
}
```

```ts
// index.ts —— 实现，键是同一个 id
import type { PluginExports, UiNode, ViewContext } from '@matrix/plugin-api';

export const renders = {
  'course-list': (ctx: ViewContext): UiNode => ({ /* … */ }),
};

export const myPlugin: PluginExports = { plan, parsers, renders };
```

> ⚠️ `requires` **不会**放宽你自己的 `permissions.data.read`。
> 宿主按你的权限过滤，缺权限的类型会让控件被画成「缺少 data.read 权限」的提示。
> 这条是刻意的：控件不能借宿主的读取能力绕过插件权限。

### 7.9.4 原语完整参考

**封闭集** —— 不在表里的 `type` 一律 `ESCHEMA`。

| `type` | 字段 | 说明 |
|---|---|---|
| `stack` | `children`（必填）、`direction?: 'row'\|'column'`、`gap?`、`align?: 'start'\|'center'\|'end'\|'stretch'`、`wrap?: boolean` | 唯一的布局容器。可任意嵌套 |
| `card` | `children`（必填）、`title?: string`、`tone?` | 带边框的分组块 |
| `text` | `text`（必填）、`tone?`、`size?: 'sm'\|'md'\|'lg'`、`weight?: 'normal'\|'bold'` | 文本，`\n` 会保留 |
| `button` | `label`（必填）、`onPress`（必填 `Action`）、`tone?`、`icon?`、`disabled?` | 缺 `onPress` 会被拒 —— 不允许点不动的按钮 |
| `list` | `items`（必填）、`empty?: UiNode` | `items` 为空且有 `empty` 时渲染 `empty` |
| `badge` | `text`（必填）、`tone?` | 小圆角标签 |
| `empty` | `text`（必填）、`action?: { label, onPress }` | 空态，可带一个动作 |
| `divider` | — | 分隔线 |

**`tone`**（语义色，**不是**颜色值）：`normal` `faint` `accent` `danger` `success` `warning`

**`gap`**：`none` `sm` `md` `lg`（默认 `md`）

**`icon`**（核心图标，**不是**图片 URL —— 插件零网络）：`calendar` `clock` `check`
`close` `plus` `search` `book` `warning`

### 7.9.5 Action：控件唯一的输出通道

```ts
type Action =
  | { kind: 'navigate'; to: string }                       // 切标签页
  | { kind: 'setUi'; key: string; value: string | number | boolean | null }
  | { kind: 'sync'; settings?: Record<string, string> }    // 让宿主对你跑一次同步
  | { kind: 'command'; id: string; input?: Record<string, string | number | boolean> };
```

**`setUi` 的值只能是 JSON 标量**（字符串 / 有限数字 / 布尔 / null）。
瞬时 UI 状态要保持可序列化 —— 将来存进布局文档、跨 iframe 传递都不需要改协议。

**`setUi` 写到哪里去了？** 宿主按 `(instanceId, key)` 存。下一次 `render()` 时
你能在 `ctx.ui[key]` 读到它。**插件自己不持有状态**，这就是 D8 在 UI 上的样子。

**`command` 是唯一能改数据的一档**，但它自己不改数据：宿主找到
`exports.commands[id]`（必须已在 `contributes.commands` 里声明），跑那个纯函数，
拿到「要做什么」，校验完再自己动手。详见 §7.11。

> ⚠️ **没有「任意命令」这一档。** `id` 必须是 manifest 里声明过的命令；
> 没声明 → `ENOTFOUND`，声明了没实现 → `EMANIFEST`。
> 两处都不给，用户点下去一定会得到一句明确的错误，而不是静默无事发生。

### 7.9.6 `ViewContext`：`render()` 的全部输入

| 字段 | 类型 | 说明 |
|---|---|---|
| `instanceId` | `string` | 布局里的实例 id。同一个视图被摆两次也不会串状态 |
| `props` | `Record<string, unknown>` | 布局配的参数，已与 `defaultProps` 合并 |
| `records` | `readonly ViewRecord[]` | 宿主按 `requires` 取好的实体。没数据是 `[]`，不是 `undefined` |
| `ui` | `Record<string, string\|number\|boolean\|null>` | 这个实例的瞬时状态 |
| `locale` | `string` | 如 `'zh-CN'` |
| `capabilities` | `readonly string[]` | 宿主能力清单（之前搁置的探测通道，在这里终于有用） |
| `now` | `number` | 宿主时间。**插件没有自己的时钟**，别用 `Date.now()` |

`ViewRecord` = `{ type, id, data, updatedAt }`。`data` 是实体字段（已经过 schema 校验）。

### 7.9.7 自由度：组合几乎不限，积木和样式受限

**能做的**：任意嵌套（`stack` 里套 `card` 里套 `list`，层数不限，受 24 层上限约束）、
条件渲染（你自己算好树）、列表、徽章、空态、语义色、核心图标。

**做不到的**（明确列出来，别试）：

| 想做的事 | 为什么不行 |
|---|---|
| 任意 CSS、自定义颜色 / 间距数值 | 只能从 `tone` / `gap` / `size` 枚举里选。开放任意样式会立刻丢掉「UI 一致」+「沙箱能跑」+「能测」三样 |
| 网络图片、任意图标 | 插件零网络（D2）。图标只能从 `ICON_NAMES` 里挑 |
| 图表、canvas、拖拽、富文本、万行虚拟列表 | 没有这些原语 |
| 发明新原语 | 原语是封闭集。要新原语 = 改核心（这是**设计决定**，不是缺口） |
| 直接监听 DOM 事件 | 只能通过 `Action` |

**限额**（`UI_LIMITS`）：节点数 2000、嵌套 24 层、单个文本 8000 字符。
超了就是 `ESCHEMA`。这些不是建议，是硬上限 —— 一个 `while` 循环就能撞到。

### 7.9.8 最小完整示例

```ts
// views.ts
import type { UiNode, ViewContext, ViewContribution, ViewRender } from '@matrix/plugin-api';

export const views: ViewContribution[] = [
  { id: 'my-list', title: '我的列表', kind: 'widget', requires: ['note'], defaultSize: { w: 12, h: 2 } },
];

export const renders: Record<string, ViewRender> = {
  'my-list': (ctx: ViewContext): UiNode => {
    const notes = ctx.records.filter((r) => r.type === 'note');
    const showAll = ctx.ui.showAll === true;

    if (notes.length === 0) {
      return {
        type: 'card',
        title: '笔记',
        children: [
          {
            type: 'empty',
            text: '还没有笔记。',
            action: { label: '去设置', onPress: { kind: 'navigate', to: 'settings' } },
          },
        ],
      };
    }

    return {
      type: 'card',
      title: `笔记（${notes.length}）`,
      children: [
        {
          type: 'button',
          label: showAll ? '收起' : '展开',
          icon: 'search',
          // 点一下改瞬时状态，宿主会带着新的 ctx.ui 再调你一次
          onPress: { kind: 'setUi', key: 'showAll', value: !showAll },
        },
        {
          type: 'list',
          items: notes.map((n) => ({
            type: 'text',
            text: String(n.data.title ?? '无标题'),
          })),
        },
      ],
    };
  },
};
```

### 7.9.9 自查清单

写完控件，逐条过：

- [ ] `render()` 里**没有** `Date.now()` / `Math.random()` / 模块级变量读写 —— 它必须是纯的
- [ ] `manifest.contributes.views` 的 id 和 `renders` 的键**完全一致**
- [ ] `requires` 里的每个类型都在自己的 `permissions.data.read` 里
- [ ] 空数据有 `empty` 节点，不是一片空白
- [ ] 没有引用网络图片、没有试图写 CSS
- [ ] 每个 `button.onPress` 都是宿主认识的三种 `Action` 之一
- [ ] 节点数远低于 2000，嵌套远低于 24 层

---

## 7.10 槽（Slot）：插件之间怎么「互相插入内容」

> 编号说明：本节插在 §7.9（控件）之后、§8（错误码）之前。**后面各节编号刻意不动。**

### 7.10.1 一句话

**定义方**声明一个槽（名字 + 字段 schema），**使用方**声明「我往这个槽写，字段这样映射」，
**宿主**在中间校验、落库、读给定义方。两边谁都不知道对方存在。

```
①定义方  manifest.slots: [{ name, fields, orderBy }]
      │
②使用方  manifest.consumesSlots: [{ slot, from, map }]
         permissions.ui.slots: [同一个槽名]      ← 声明 ≠ 授权
      │
③宿主    读使用方的实体 → 按 map 映射 → 逐字段校验 → slotValidators → 写进定义方的命名空间
      │
④定义方  render() 从 ctx.records 里读到 type === 'slot_entry' 的条目
```

### 7.10.2 为什么不是「插件互相调函数」

最直觉的写法是：

```ts
Core.accessPlugin('app.matrix.timeline').invoke('insert', event)   // ❌ 不采用
```

它同时破三件事：

| 破了什么 | 为什么 |
|---|---|
| **D8**（插件是纯函数） | `invoke` 要么是同步函数（那就得持有跨调用状态）、要么是回调；沙箱里同步跨实例调用根本不成立 |
| **D3**（插件不写存储） | `insert` 内部要落库的话，插件就得碰 DataBus，而插件拿不到 bus |
| **可复现** | 插件 A 的执行会依赖插件 B 的当前状态，`render()` 就不再是 `ctx` 的函数 |

槽把这些换成**纯数据**：`map` 是 `{ '槽字段': '实体字段' }`，JSON 能表达，
所以可校验、可序列化、能过沙箱边界。

### 7.10.3 定义方怎么写

```ts
// manifest.ts
contributes: {
  entityTypes: [
    // 槽条目落在**你自己**的命名空间下，所以要声明这个容器类型
    { name: 'slot_entry', schema: slotEntryContainer },
  ],
  slots: [{
    name: 'app.matrix.timeline.event',   // 前两段必须是你的 id 命名空间
    description: '时间线上的一个事件',
    fields: {
      startAt: { type: 'number', required: true },
      endAt:   { type: 'number' },
      title:   { type: 'string', required: true, maxLength: 200 },
      detail:  { type: 'string', maxLength: 300 },
    },
    maxItems: 2000,
    orderBy: 'startAt',            // 必须是 number 字段
  }],
}
```

```ts
// index.ts —— 跨字段校验，就是 CheckEvent() 的纯函数形态
export const slotValidators = {
  'app.matrix.timeline.event': (values) => {
    if (typeof values.endAt === 'number' && values.endAt < values.startAt) {
      return { ok: false, reason: 'endAt 早于 startAt' };
    }
    return { ok: true };
  },
};
```

**单字段的检查（类型 / 必填 / 超长）由 `fields` 做，不需要写校验函数。**
`slotValidators` 只处理「两个字段之间的关系」。

### 7.10.4 使用方怎么写

```ts
// manifest.ts
permissions: {
  data: { write: ['session'], read: ['session'] },
  ui: { slots: ['app.matrix.timeline.event'] },   // ← 用户批准
},
contributes: {
  entityTypes: [{ name: 'session', schema: sessionSchema }],
  consumesSlots: [{
    slot: 'app.matrix.timeline.event',
    from: 'session',                              // 你自己的实体类型
    map: {
      startAt: 'startAt',
      endAt:   'endAt',
      title:   'title',
      detail:  'location',                        // ← 换个名字也行
    },
    // where: { type: 'session' },                // 可选：只取满足常量条件的
  }],
}
```

**注意两处都要写**：`contributes.consumesSlots` 是「我想写」，`permissions.ui.slots`
是「用户批准了」。和 `data.write` 是同一套思路。

### 7.10.5 宿主做了什么（你可能需要知道的细节）

| 行为 | 说明 |
|---|---|
| **整体重写** | 每次 `sync()` 后，宿主把你在这个槽里的条目**全部清掉重写**。所以源实体删了，槽条目也会消失，不用你操心 |
| **跳过而非失败** | 缺必填字段 / 类型不符 / `where` 不匹配 / 校验器拒绝 → 跳过这一条并记原因，**不影响其余条目和整次同步** |
| **截断而非拒收** | 字符串超 `maxLength` 会被截断。一条超长备注不该让整节课消失 |
| **命名空间** | 槽条目存在**定义方**的命名空间下。你和定义方的同名类型不会串 |
| **`source` 由宿主填** | 你改不了，所以「这条是谁塞进来的」永远可查 |
| **孤儿槽** | 定义方卸载后，槽消失、数据保留、**不再接受写入**（没有 schema 就没法校验）。定义方重装即恢复 |

### 7.10.6 限制

| 做不到 | 为什么 |
|---|---|
| 往任意槽里写 | 必须在 `permissions.ui.slots` 里被授权，否则 `EPERM` |
| 定义别人命名空间下的槽 | 槽名前两段必须是你 id 的前两段，否则被顶替 |
| 在 `map` 里做计算 | `map` 只能挑字段。要算就在自己的实体里先算好（`sync()` 时算） |
| 调用定义方的函数 | 这就是本节开头否掉的东西 |
| 让槽条目嵌套对象 | 槽字段只有 `string` / `number` / `boolean` |

### 7.10.7 自查清单

- [ ] 槽名前两段是我自己的 id 命名空间
- [ ] 我在 `contributes.entityTypes` 里声明了 `slot_entry` 容器类型
- [ ] 必填字段真的必填（少了会被跳过，不会报错，所以很容易漏）
- [ ] 使用方那边：`consumesSlots` 和 `permissions.ui.slots` **两处都写了**
- [ ] `map` 里的源字段在我实体的 schema 里存在，且类型对得上
- [ ] 定义方渲染时对脏数据有防御（旧版本写的条目可能不合新 schema）

---

## 7.11 命令（Command）：控件怎么改数据

### 7.11.1 一句话

控件点击 → `Action{kind:'command', id, input}` → 宿主调你的**纯函数**
→ 它返回「要改什么」→ 宿主校验后自己动手。

```
render() 画出 button{onPress:{kind:'command', id:'toggleTask', input:{taskId:'k1', to:'done'}}}
    ↓ 用户点
宿主：contributes.commands 里有 toggleTask 吗？→ 有
    ↓
宿主：exports.commands.toggleTask 存在吗？→ 存在
    ↓
宿主：handler({taskId:'k1',to:'done'}, {pluginId, now}) → { coreOps:[{op:'task.setStatus',...}], message }
    ↓
宿主：这个 coreOp 允许吗？→ 查 permissions.data.write 有没有 'task'
    ↓
宿主：写 TaskStore → 重新投影 → 重新收集槽 → 刷新界面
```

### 7.11.2 为什么命令也是纯函数

最省事的做法是给插件一个 `setData()` 回调。**不行**，它同时破三件事：

| 破了什么 | 为什么 |
|---|---|
| **D8**（插件是纯函数） | 回调异步、有副作用；同一个 `render()` 可能因回调被调过而返回不同结果 |
| **D3**（插件不写存储） | 插件一旦能写，`data.write` 权限就形同虚设 |
| **可测试** | 有状态的命令没法用「同样输入 → 同样输出」钉住 |

所以命令只**描述**改动，宿主**执行**。和槽的 `map`、控件的 `Action` 是同一个思路。

### 7.11.3 怎么写

```ts
// manifest.ts
contributes: {
  commands: [{ id: 'toggleTask', title: '切换任务完成状态' }],
},
permissions: {
  // ⚠️ coreOps 要改核心数据，必须有对应类型的 data.write
  data: { read: ['task'], write: ['task'] },
},
```

```ts
// index.ts
export const commands = {
  toggleTask: (input, ctx) => {
    const id = typeof input.taskId === 'string' ? input.taskId : '';
    if (id === '') return { message: '缺少任务 id' };
    if (input.to !== 'open' && input.to !== 'done') return { message: '目标状态不合法' };
    return {
      coreOps: [{ op: 'task.setStatus', id, status: input.to }],
      message: input.to === 'done' ? '已标记完成' : '已标记未完成',
    };
  },
};
```

```ts
// render() 里
{ type: 'button', label: '标记完成',
  onPress: { kind: 'command', id: 'toggleTask', input: { taskId: t.id, to: 'done' } } }
```

**目标状态由你在渲染时算好**（`ctx.records` 里已经能看到当前状态）。
不要指望宿主提供 `toggle` —— 那是带读-改-写语义的操作，会让命令变成有状态的调用。

### 7.11.4 `CommandResult` 能返回什么

| 字段 | 作用 | 约束 |
|---|---|---|
| `entities` | 写进**你自己**命名空间的实体 | 受 `permissions.data.write` + 你的 `entityTypes` schema |
| `coreOps` | 对**核心数据**的改动意图 | 封闭清单 + `permissions.data.write` |
| `message` | 给用户看的一行回执 | 超过 300 字符会截断，不拒收 |

`input` 只能是**标量**（字符串 / 有限数字 / 布尔），最多 20 个键，字符串最长 300。
要传结构就说明你该把它放进自己的实体里。

### 7.11.5 `coreOps` 是封闭清单

目前只有这两项：

| op | 参数 | 对应实体类型 |
|---|---|---|
| `task.setStatus` | `id`, `status: 'open' \| 'done'` | `task` |
| `task.delete` | `id` | `task` |

**加新操作 = 改核心 + 改契约 + 加测试。** 这是刻意的摩擦：
核心数据模型不该被插件悄悄扩张。提交未知的 `op` 会被 `ESCHEMA` 拒掉，
而且**在宿主执行任何东西之前**就拒掉。

### 7.11.6 失败都是显式的

| 情况 | 结果 |
|---|---|
| `contributes.commands` 里没这个 id | `ENOTFOUND` |
| 声明了但 `exports.commands` 没有 | `EMANIFEST`（打包缺陷，不是运行期状况） |
| 入参不合法（嵌套对象、键太多） | `ESCHEMA` |
| handler 抛异常 | `EINTERNAL`，message 带原始错误 |
| 返回值不合法（未知 coreOp） | `ESCHEMA`，**且什么都不执行** |
| `coreOps` 缺 `data.write` | `EPERM`，**且什么都不执行** |

没有一档是「点了没反应」。这是本项目的一条硬规矩：**「假的」比「没有」贵**。

### 7.11.7 自查清单

- [ ] 命令 id 在 `contributes.commands` 里声明了，`exports.commands` 里也实现了
- [ ] 要改核心数据 → `permissions.data.write` 里有那个类型（否则 `EPERM`）
- [ ] `input` 只有标量，键数 ≤ 20
- [ ] 目标状态在 `render()` 时算好，不在命令里查数据
- [ ] 命令跑完后宿主会重新收集槽 —— 如果你的槽依赖你写的实体，它会自动跟上

---

## 8. 错误码

**跨边界一律不抛异常，改传结构化结果。**

```ts
type PluginResult<T> = { ok: true; data: T } | { ok: false; code: PluginErrorCode; message: string; detail?: Record<string, unknown> };
```

不抛的理由：沙箱内外的异常语义不同。宿主异常直接穿进沙箱会把宿主堆栈、
甚至宿主对象带进去；插件异常也不该让宿主崩。所以边界上**只有数据**。

### 8.1 两套码空间

**这不是重命名，是两类不同的失败。**

```ts
// 契约码 —— 「插件用错了 API」
type PluginContractCode =
  | 'EPERM'        // 未声明 / 未授权（含试图自带凭证头）
  | 'EAPIVERSION'  // API 版本协商失败
  | 'EQUOTA'       // 超出配额（含 maxSteps、单轮请求数）
  | 'ENETDENIED'   // 域名不在**该插件被授予的**白名单内
  | 'EAUTH'        // 令牌无效 / 凭据不足
  | 'ESCHEMA'      // 实体或 plan 校验失败
  | 'ETIMEOUT'     // 状态机步数超限
  | 'ETRUST'       // 信任等级不允许该操作
  | 'EMANIFEST'    // manifest 非法，或运行时自报 kind 与 manifest 不符
  | 'ENOTFOUND'    // 插件 / 导出 / 实体类型不存在
  | 'EINTERNAL';   // 宿主内部错误

// 传输码 —— 「出网时怎么失败的」，由核心网关抛出
type CoreTransportCode =
  | 'EURL'         // URL 无法解析 / 非 https / 含 userinfo
  | 'EIP'          // 不允许 IP 字面量直连
  | 'EHOST'        // 主机不在平台白名单
  | 'EREDIRECT'    // 重定向越界或次数超限
  | 'ETIMEOUT'     // HTTP 超时
  | 'ETOOBIG'      // 响应体超过单次上限
  | 'ERATELIMIT'   // 触发限流
  | 'EAUTH'        // 认证失败
  | 'ENET'         // 传输层失败（DNS / 连接 / 底层报错）
  | 'EUNKNOWN';    // 未归类

type PluginErrorCode = PluginContractCode | CoreTransportCode;
```

**为什么必须分开**：插件发起的一次请求可能因为「URL 写错了」失败（`EURL`），
也可能因为「域名没被授权」失败（`ENETDENIED`）。如果边界类型只表达得了后者，
宿主就只能把前者**谎报**成后者 —— 而失败原因是用户排查问题的唯一线索。

`EAUTH` 与 `ETIMEOUT` **刻意同时属于两套空间**，因为它们是真正的双语义：
令牌无效（核心）／凭据不足（契约）；HTTP 超时（核心）／状态机步数超限（契约）。
合并成一个码反而会让「到底是网络超时还是插件死循环」不可分辨。

### 8.2 工具函数

```ts
function ok<T>(data: T): PluginSuccess<T>;
function fail(code: PluginErrorCode, message: string, detail?: Record<string, unknown>): PluginFailure;
function isOk<T>(r: PluginResult<T>): r is PluginSuccess<T>;
function isPluginErrorCode(v: unknown): v is PluginErrorCode;
function codeOf(e: unknown): PluginErrorCode;   // 不是已知码时给 EINTERNAL
```

`fail()` 的 `detail` **不得**含凭证、cookie、token、完整 URL 的查询串。

---

## 9. 版本协商

```ts
const CURRENT_API_VERSION = '1.0.0';
const OLDEST_SUPPORTED_MAJOR = 1;         // 支持窗口 N-2
```

`apiVersion` 支持的是 semver range 的**受限子集**（不是完整 semver range 语法）：

| 写法 | 含义 |
|---|---|
| `^1.0.0` | `>=1.0.0 <2.0.0` |
| `~1.2.0` | `>=1.2.0 <1.3.0` |
| `1.2.3` | 精确等于 |
| `*` | 任意 |

**不支持** `>=`、`||`、`1.x`、`>1.0.0`。写别的 → `EAPIVERSION`。

```ts
function negotiateApiVersion(pluginRange: string): PluginResult<HandshakeResult>;

interface HandshakeResult {
  apiVersion: string;
  hostVersion: string;
  negotiated: string;
}
```

失败信息是**给用户看的**（安装页会原样展示），所以它会说清「你要求的」和「我支持的」。

### 宿主能力探测

**能力探测优于版本探测** —— 但在照这句话写代码之前，有一个必须先说清的区分，
和一个必须先承认的限制。

#### 两个同名不同义的东西

| 名字 | 是什么 | 谁该用 |
|---|---|---|
| `HOST_CAPABILITIES_V1`（本包常量） | v1 规范定义的**上限** | 宿主开发者、契约测试 |
| `registry.capabilities()`（运行时） | **这台机器真的有什么** —— 上面那份的子集 | 宿主 / UI 决定要不要显示某个功能 |

> 这个区分曾经是**坏的**：宿主直接把 `HOST_CAPABILITIES_V1` 当能力清单交出去，
> 于是 `db.namespaced` 探测为真，而核心层连 `db.*` 方法都不存在。
> 现在 `capabilities()` 由装配点如实申报，**缺省是空数组** ——
> 忘了申报的宿主会让插件退化成「不用」，而不是「踩空」。

#### ⚠️ 但插件现在**没法**探测

`HandshakeOk.capabilities` 是设计上的交付通道，可是：

- **没有任何代码构造过 `HandshakeOk`**；
- 插件是**纯函数**（D8），`plan()` 只收到 `PlanInput`（`trigger` / `cursor` / `now` / `settings`），
  里面**没有** `capabilities`。

所以「查 `capabilities.includes(...)`」这句话**现在对插件不成立**。
要落地得先把它塞进 `PlanInput`。**短期实验已明确决定不做**（`dev.md` §3.1）——
所以下面这段「怎么退化」的写法只是**将来**的样子，现在不用写。在那之前，
唯一的「探测」方式是**试一次、看错误码**：

```ts
// 现在能做的：写死一条路，让宿主如实报错
export const plan = (): RequestPlan => ({
  requests: [{ id: 'r1', method: 'GET', url: 'host://import', parse: 'x', source: 'host' }],
});
// 宿主没准备文档 → ENOTFOUND
// 没声明 permissions.local → EPERM
// 两者都会进 SyncReport.errors，不会静默
```

插件**读不到** `SyncReport`（它是宿主侧的对象），所以「退化」要发生在
**宿主 / UI 那一层**：宿主看到 `ENOTFOUND` 就把那个功能藏起来，而不是给用户报错。

#### 早期内核宿主的三项基础能力

> 本小节描述早期 `PluginHost` 内核基线。当前 Android 外部插件安装器已扩展声明式首页卡片、专属页面和宿主管理的独立网页账号；准确接入方法以 [外部插件指南](../../docs/plugins/README.md) 为准。这些扩展由宿主提供，不会给沙箱开放 DOM、Cookie 或任意原生调用。

| 能力 | 对应做法 |
|---|---|
| `net.request` | `plan()` 里发网络请求 |
| `local.request` | `plan()` 里声明 `source: 'host'` |
| `bus.emit` | 从 `plan().entities` 或 parser 返回实体 |

其余一律**没有**：`db.namespaced` · `notify.local` · `schedule.periodic` ·
`schedule.exact` · `auth.login` · `ui.registerComponent` · `llm.complete` ·
`fs.*` · `trust.evalRemote` · `trust.loadModule`。

还有两项是「宿主内部有、插件够不到」，**也不算**：
`bus.read`（只有宿主自己的 Timeline 在用）、`secrets.namespaced`
（核心层 vault 有，但 `PluginHost` 没暴露）。能力清单说的是「**插件能用什么**」，
不是「宿主内部有什么」。

> **两条实用推论**：
> 1. 需要某项能力时，先核对所用宿主：上表是早期内核基线，§4 是规范，当前安装器实现见外部插件指南。
> 2. 现在能写的插件类型很窄：**本地文档进来 → 解析 → 落库**，
>    加上可选的网络请求。其余方向都缺实现。

---

## 10. 信任与生命周期

### 10.1 信任等级

```ts
type TrustLevel = 'signed' | 'restricted' | 'remote-trusted';
```

| 等级 | 界面文案 | 含义 |
|---|---|---|
| `signed` | 已验签 | 全部代码被签名覆盖 |
| `restricted` | 受限模式 | 未验签，或声明了远程代码但未授权 |
| `remote-trusted` | 已信任远程代码 | 用户**显式**授予 |

判定顺序很重要：**先看「远程代码 + 已授权」，再看签名**。
一个声明了远程代码的插件，即便主包已验签，也仍然有**未签名的代码路径** ——
所以未授权时必须是 `restricted`，不能因为主包签了就放成 `signed`。

三条不变量：

- **I4** —— 信任**不能替代**权限。`remote-trusted` 也不给你没声明的 `net.domains`。
- **I5** —— 信任**不能通过依赖提权**。`trust.loadModule` 用调用方自己的权限执行。
- **I6** —— 信任只决定「**能不能进来**」，不决定「**在哪里跑**」。

### 10.2 生命周期钩子

```ts
onActivate?(): void;
onSuspend?(): void;
onDeactivate?(): void;
```

全部**同步**。宿主负责调度，插件只负责「现在该做什么」。

宿主会捕获钩子里的异常（不让你把宿主带崩），但会记 `EINTERNAL` 并把插件标为失败状态。

插件状态机：

```
installed → active ⇄ suspended
                ⇄ deactivated
                → uninstalled
```

**信任变更会触发重载**：宿主先 `deactivate`，再 `activate`。

---

## 11. 宿主侧 API（给宿主实现者）

插件作者可以跳过这一节。宿主用的是 `@matrix/kernel`：

```ts
class PluginHost {
  readonly trust: TrustStore;
  readonly bus: DataBus;
  readonly registry: PluginRegistry;

  install(raw: unknown, opts?: { requested?: unknown; activate?: boolean }): Promise<PluginResult<PluginRecord>>;
  uninstall(pluginId: string, opts?: { keepData?: boolean }): Promise<PluginResult<PluginRecord>>;
  sync(pluginId: string, input: PlanInput): Promise<PluginResult<SyncReport>>;
  read(readerPluginId: string, type: string, opts?: { limit?: number }): PluginResult<EntityRecord[]>;
  snapshot(): { plugins: [...]; data: {...}; audit: readonly HostAuditEntry[] };
}
```

### 11.1 宿主对插件的保证

- **出网唯一出口**：`SyncBroker` 的 `fetch` → 适配器 → 核心网关。插件够不到 `CapacitorHttp`。
- **错误码如实透传**：核心层的 `CoreError.code` 就是传输码，适配器**照原样**上报，
  绝不谎报成 `ENETDENIED`。
- **单个请求失败不终止整轮同步**：原因进 `SyncReport.errors`，由插件决定怎么办。
- **响应头不进沙箱**：只把 `body` / `status` / `url` 交给插件。`set-cookie` 永远看不到。

### 11.2 纵深防御：两层白名单

必须**同时**满足：

| 层 | 管什么 | 在哪配 |
|---|---|---|
| 内核层 | 「**这个插件**准不准」 | manifest `permissions.net.domains` |
| 网关层 | 「**这台机器**准不准」 | 核心 `config.allowlist` |

插件被授予了 `evil.example.com`，但平台白名单里没有 → 内核放行、网关以 `EHOST` 拒绝。
反过来，manifest 没声明 → 内核以 `ENETDENIED` 拒绝，**请求根本到不了网关**。

### 11.3 信任撤销联动能力令牌

用户在界面上点「撤销信任」时，宿主必须同时撤销该插件的**能力令牌**
（`CapabilityRegistry.revokePlugin`）。两者不联动的话，插件手里已签发的令牌照样能用 ——
那这个开关就是**假的**（D7 要求「逐插件可撤销」）。

⚠️ 联动规则**只认一种降级**：`remote-trusted` → 其它。
写成「凡是 `to !== 'remote-trusted'` 就撤销」是错的：第一方插件登记时等级是 `signed`，
那条规则会把它们统统标成 revoked，`issueToken` 从此抛 `EAUTH` ——
**所有第一方插件的网络能力被永久掐死**。这个 bug 不报错，只表现为「请求全都返回 EAUTH」。

### 11.4 宿主强制执行的限额

```ts
const DEFAULT_MAX_STEPS = 16;        // 单轮同步的状态机步数上限 → ETIMEOUT
// SyncBroker 另有：
//   maxRequestsPerRound = 32       → EQUOTA
//   maxBodyBytes        = 5 MiB    → ETOOBIG
```

**超限之后发生什么，三个不一样**（这一点以前没写清）：

| 限额 | 超了之后 |
|---|---|
| `maxSteps`（16） | **整轮同步失败**，返回 `ETIMEOUT`。已落库的实体**不会回滚** |
| `maxRequestsPerRound`（32） | **整轮同步失败**，返回 `EQUOTA` |
| `maxBodyBytes`（5 MiB） | **只有那一个请求失败**，原因进 `SyncReport.errors`，其它请求继续 |

前两个是「插件写错了」（状态机跑飞 / 一轮塞一万条），所以整轮掐掉；
第三个是「这一份数据太大」，不值得连坐其它请求。

> 因此：**别用「发很多小请求」来实现分页**。一轮 32 个是硬上限，
> 要更多就靠 `cursor` 跨轮（见 §5.3），那才是它存在的理由。

`SyncReport.boundaryBytes` 会统计跨沙箱边界传输的字节数。
**它是给宿主观测用的**：如果它随步数超线性增长，说明插件在用朴素的状态机写法（见 §6）。

---

## 12. 现状：已实现 / 提案 / 未实现

诚实清单。写插件前请看一眼，免得按文档写完发现跑不起来。

### ✅ 已实现并有测试守护

| 能力 | 位置 |
|---|---|
| Manifest v1 校验（含保留命名空间、域名形状、`entry`、`contributes` 形状） | `manifest.ts` |
| `EntitySchema` / `ManifestEntityType`（manifest 与 DataBus 共用一份定义） | `schema.ts` |
| 权限矩阵与授权判定 | `permissions.ts` |
| 契约 `plan` / `parsers` / `next`（含 `source: 'host'` 与 `plan().entities`） | `contract.ts` |
| 两套错误码 + `PluginResult` | `errors.ts` |
| 版本协商（N-2） | `version.ts` |
| 注册表与生命周期 | `packages/kernel/src/registry.ts` |
| 同步 broker（宿主驱动状态机） | `packages/kernel/src/broker.ts` |
| 信任状态机 | `packages/kernel/src/trust.ts` |
| 数据总线（命名空间隔离、UTF-8 配额、增量占用） | `packages/kernel/src/databus.ts` |
| **本地导入**（`source: 'host'` + 宿主文档表，按 `pluginId` 隔离） | `broker.ts` / `plugin-host.ts` |
| **游标跨轮延续**（`SyncReport.cursor` → 宿主存下 → `PlanInput.cursor`） | `broker.ts` / `plugin-host.ts` |
| **能力清单由装配点申报**（`registry.capabilities()` 缺省空数组，不再拿规范当实现） | `registry.ts` / `plugin-host.ts` |
| **写闸**：`bus.emit` 查 `permissions.data.write`（与 `net` / `local` 同一条规则） | `plugin-host.ts` 的 `emitEntity` |
| **控件（UI）**：`UiNode` 8 原语 + `parseUiNode` 安全边界 + `renders` 交叉核对 | `ui.ts` / `apps/shell/src/ui/` |
| **布局文档**：`layout.<profileId>` 存 KV，带版本与校验 | `apps/shell/src/ui/layout.ts` |
| 内核 ↔ 核心层接线（含信任撤销联动） | `apps/shell/src/core/plugin-host.ts` |

### ⚠️ 提案（未经真实插件检验，改起来便宜）

- `contributes.entityTypes` 用 `Array<{ name, schema }>` 形状
- 字段级 `shared` 投影，以及「缺省视为共享」的默认值

### 当前外部插件实现

`.mtp` 校验、权限确认、QuickJS 纯函数、启停、卸载、代码与启用状态持久化已落地。`CursorStore` 已持久化游标。控件通过 `requires ⊆ permissions.data.read` 检查后选择记录；底层 `bus.read` 不单独查声明权限，属于宿主内部口，VM 无直接引用。

外部包必须为 logic/connector/ui，entry 为 bundle.js；auth 仅开放上述声明式宿主账号，不开放 secrets、notify、local文件导入、fs、db.raw、后台、模型、stream、remoteCode 或 first-party/declarative 包。详见 [安装与开发指南](../../docs/plugins/README.md)。内置插件不受这个外部包限制。

### 尚未实现

| 项 | 说明 |
|---|---|
| 独立 Worker | 当前每插件独占 WASM 模块，调用仍在主线程；单调用约200ms预算 |
| 密码学签名、自动更新、市场 | 外部插件明确标为未验签；更新需卸载后重新安装确认 |
| installBuiltin 类型隔离 | 内部仍有 allowReservedPrefix 布尔；外部安装器从不传入且包预检拒保留ID |
| 能力探测交付 | 契约能力上限不代表外部首版全部开放；以安装器支持清单为准 |
| 信任记录持久化 | 插件包/启停持久化不等于完整信任历史持久化 |
| iframe、用户布局编辑器 | 当前外部视图返回 UiNode，无任意HTML/React/iframe |
| 完整 CLI | 已有 pack/validate，没有 create/build/sign/dev；validate不会执行代码 |
| 更多 coreOp | 保持封闭清单，按需增加 |

### 已知边界

- BB/GS/EAMS 登录 Cookie 在独立原生进程，外部插件无法获得其会话；外部声明账号路径使用独立 Profile，无账号的通用 CapacitorHttp 路径隔离尚未完成。
- QuickJS 全局隐藏 eval/Function/SharedArrayBuffer/Atomics，但 VM 内动态代码构造并非全部消失；独立解释器与无宿主引用才是边界。
- 域名匹配仍有两份实现，由跨包差分测试守护。
- Android 原生桥可能对所有 frame 可见，因此本版不运行任意外部 iframe。

---

## 13. 一致性测试

```bash
# 仓库根
npm test              # 全部工作区测试，数量以当次输出为准
npm run typecheck     # 工作区类型检查
npm run check         # 上面两个
```

单独跑：

```bash
node packages/plugin-api/src/v1/conformance.test.ts
node packages/kernel/src/conformance.test.ts
node apps/shell/src/core/conformance.test.ts
node apps/shell/src/core/plugin-api-diff.test.ts
```

无需构建 —— Node 24 的原生类型擦除直接跑 `.ts`。

> ⚠️ **类型擦除不做类型检查。** `node` 会照样跑类型有错的代码。
> 只有 `tsc --noEmit` 能发现类型错误。所以两个命令都要跑。

`plugin-api-diff.test.ts` 是**跨包**差分测试，测的不是「某个函数对不对」，
而是两个包之间的**一致性**（错误码空间、凭证头策略、端到端链路）。
它抓到过两个只有跨包才暴露的真实缺陷，详见 `docs/design/DESIGN.md` §15.1。

---

## 14. 相关文档

| 文档 | 内容 |
|---|---|
| `docs/design/DESIGN.md` §5.1–§5.7 | 插件系统的设计依据与决策记录 |
| `docs/design/DESIGN.md` §5.5.1 | QuickJS 硬性纪律 R1–R6（写沙箱相关代码必读） |
| `spikes/p0/REPORT.md` §5 | 跨边界调用的实测数据（开销、吞吐、O(n²)） |
| `docs/design/api-v1.d.ts` | 早期契约草案 ⚠️ **已过时**，以本包源码为准 |
