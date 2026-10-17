# 缺口清单与第一批插件候选

> **核实方式**：逐项读代码 + 跑测试（`npm run check`，**417 项断言**全绿），
> 不是照抄 `DESIGN.md` 的承诺。凡标了 `文件:行号` 的都可以自己去看。
>
> **本轮已复核**：能力清单那条已经修好（§1 现在是 ✅），各套件断言数重新数过，
> 改过代码处的行号已重新核对（`registry.ts` / `plugin-host.ts` / `bootstrap.ts` 都变长了）。
>
> **标记**：
> - ❌ **完全没做** —— 连半成品都没有
> - ⚠️ **是假的** —— 有代码、有测试、文档也写了，但**行为与承诺不符**（最危险的一类）
> - 🔶 **做了但有已知残留**

---

## 0. 一句话结论

**内核与契约层是扎实的，宿主的能力面仍然很窄。**

| 套件 | 断言数 |
|---|---|
| `packages/plugin-api` | 115 |
| `packages/kernel` | 87 |
| `apps/shell` 核心层 | 87 |
| 跨包差分 | 28 |
| 数据持久化 | 11 |
| 核心数据层（C 段） | 13 |
| 通知桥（接口 + 适配层 + 各端骨架） | 26 |
| 槽 + Timeline + 游标 + 命令 + 课程卡 + 控件取数 | 36 |
| ICS 插件 | 22 |
| 控件 UI 系统 | 21 |
| **合计** | **446** |

这些覆盖了「插件怎么被描述、怎么被校验、怎么被驱动、怎么被隔离」，可以放心依赖。

但从内核往上一层看：**权限矩阵有 23 行，宿主真正实现并能让插件用到的只有 3 行。**
所以现在能写的插件类型很窄 —— 恰好就是「本地文档进来 → 解析 → 落内存」这一条，
而第一个插件（ICS 导入）正好落在那个位置，**并且已经跑通**。

---

## 1. 能力清单：已修好 ✅（留档，它曾经很坏）

> 这一节记录一个**已经修掉**的问题，因为它是个典型样本：
> 有代码、有测试、文档也写了，但行为与承诺不符 —— 这类问题测试永远抓不到，
> 因为测试是顺着实现写的。

**修之前**：`PluginRegistry.capabilities()` 返回静态常量，与实现无关。

```ts
// 修之前的 registry.ts
capabilities(): string[] {
  return [...HOST_CAPABILITIES_V1];   // ← v1 规范的**上限**，不是本机能力
}
```

`HOST_CAPABILITIES_V1`（`contract.ts:231`）列了 11 项，宿主实际只有 3 项。
README §9 又反复教作者「查 `capabilities.includes(...)`」——
于是 `db.namespaced` 探测为真，而核心层连 `db.*` 方法都不存在。

**现在**：`capabilities()` 由装配点如实申报，**缺省空数组**（`registry.ts:191`）。
`PluginHost.IMPLEMENTED_CAPABILITIES` 只列插件真能用的三项；差分测试里有一条断言
把它锁死在「⊆ v1 规范 且不含未实现项」，否则它会慢慢长回原样。

**但清单真了不等于探测通了** —— 见 §1.2。

### 1.1 23 个 RPC 方法，宿主实现 3 个

`RPC_METHODS`（`packages/plugin-api/src/v1/permissions.ts:264-277`）是权限矩阵的全集。
对照宿主实际能响应的东西：

| RPC 方法 | 状态 | 依据 |
|---|---|---|
| `net.request` | ✅ 可用 | `plugin-host.ts` `dispatchFetch` |
| `local.request` | ✅ 可用 | `plugin-host.ts` `serveLocal` |
| `bus.emit` | ✅ 可用（v0.5.1 起有闸） | `plugin-host.ts` `emitEntity` |
| `bus.read` | 🔶 宿主内部可用，**插件够不到**；且不查 `data.read` | `plugin-host.ts:387`，TODO 已标注 |
| `secrets.get/set/delete` | 🔶 核心层 `vault` 有实现，**`PluginHost` 没有暴露** | `core/index.ts:44-48` 有 `vault.*`，但插件路径不通 |
| `db.get` `db.query` `db.put` `db.delete` `db.raw` | ❌ 无任何实现 | 核心层 `METHODS`（`core/index.ts:41-48`）只有 `net.*` / `vault.*` |
| `auth.login` | ❌ 无（§8.2 鉴权代理只搭了半截） | 同上 |
| `notify.local` | ❌ 无（连 `@capacitor/local-notifications` 都没装） | `apps/shell/package.json` |
| `schedule.periodic` `schedule.exact` | ❌ 无（无 `background-runner`，无调度器） | 同上 |
| `fs.read/write/list` | ❌ 无 | 同上 |
| `ui.registerComponent` | ❌ 无（没有 iframe 宿主） | `apps/shell/src/` 无相关代码 |
| `llm.complete` | ❌ 无 | 同上 |
| `trust.evalRemote` `trust.loadModule` | ❌ 无（`dependencies` 只做了 manifest 形状校验，`manifest.ts:383`） | `registry.ts` 无加载逻辑 |

**已按 A 修完**：`HOST_CAPABILITIES_V1` 降级为「v1 规范的**上限**」，
`capabilities()` 改由装配点申报。B 方案被否，理由仍然成立 ——
两份东西同名没人分得清，所以现在名字刻意分开：
`HOST_CAPABILITIES_V1`（规范）vs `capabilities()`（实际）。

### 1.2 但「探测」这条路本身还不通 ⚠️

清单真了，只是**还没有人能把它给插件看**。

`HandshakeOk.capabilities` 是设计上的交付通道，可是**没有任何代码构造过 `HandshakeOk`**；
而插件是纯函数（D8），`plan()` 只收到 `PlanInput`（`trigger` / `cursor` / `now` / `settings`），
**里面没有 `capabilities`**。

所以 README 里「能力探测优于版本探测」这句话目前**对插件不成立** ——
插件没有提问的渠道。现在唯一的「探测」是试一次、看错误码（`EPERM` / `ENOTFOUND`），
而且插件读不到 `SyncReport`，退化只能发生在宿主 / UI 那一层。

要落地得把 `capabilities: readonly string[]` 放进 `PlanInput`。
**短期实验已明确决定不做** —— 因为现在只有第一方插件，它们本来就知道宿主有什么。
扩展是**纯加法**（可选字段，老插件不受影响），所以推迟没有代价。见 `dev.md` §3.1。
**注意顺序**：必须先修好清单（已完成）再开这个通道，否则塞进去的就是假清单。

### 1.3 `contributes.views` 已修好 ✅（U1–U6）

原来 `views?: unknown[]` —— 唯一一个完全没被 `validateContributes` 碰过的贡献项，
而且渲染器一行都没有。现在：

| | |
|---|---|
| **形状** | `ViewContribution[]`：`{ id, title, kind: 'page' \| 'widget', requires?, defaultProps?, defaultSize? }`，由 `validateContributes` 全量校验（id kebab-case 且不重复、kind 枚举、requires 是字符串数组、defaultSize 1..12） |
| **实现** | `PluginExports.renders`：`Record<viewId, (ctx) => UiNode>`。目录在 manifest、实现在代码，宿主**交叉核对**两边 |
| **渲染** | `apps/shell/src/ui/render.ts`：8 个封闭原语 → React。用 `createElement` 写成 `.ts`，所以**在 Node 里能断言，不需要 jsdom** |
| **布局** | `layout.<profileId>` 存 KV（D5 的布局 JSON 是纯数据），带版本号与校验，坏数据退回默认并备份 |
| **安全边界** | `parseUiNode()` 把插件产出的树**重建**一遍：节点数 2000 / 深度 24 / 文本 8000 字符上限，未知字段全部丢弃 |
| **第一个控件** | ICS 课程列表（只读 + `navigate` / `setUi`），21 项断言钉住「控件产出的每个 Action 宿主都认得」 |

**自由度是有意的限制**：原语封闭、样式只能选语义档位（`tone` / `gap` / `size`）、
图标只能是核心枚举、不能引网络图片。换来「插件 UI 一定长得像 Matrix」+
「沙箱里能跑」+「Node 里能测」。

**仍然缺的**：`contributes.commands` 没有执行入口，所以 v1 的 `Action` 里
**没有**「任意命令」这一档（见 `dev.md` T14）。用户改布局也还没有 UI。

---

## 2. 数据层：两条互不相通的路 ✅ **已收敛**（C 段）

这是**写完第一个插件后立刻会撞上**的问题，比沙箱更早。

| | `TaskStore`（`platform/strategies/store/`） | `DataBus`（`packages/kernel/src/databus.ts`） |
|---|---|---|
| 谁在用 | ~~`App.tsx` / `CoursesView`~~ → **只有 `BusTaskStore` 门面** | 插件 + **核心实体** |
| 持久化 | ✅ SQLite / SQLCipher / JSON 三级降级 + 加密探针 | ✅ write-behind |
| 键隔离 | 无插件概念 | ✅ 按 `pluginId` 命名空间 |
| 配额 | 无 | ✅ 行数 + 字节 |
| Schema | 无 | ✅ `EntitySchema` 校验 |
| **类型形状** | ~~`Course.name`~~ → 门面里翻译 | ✅ `course.title` —— **对外只有这一个形状** |

### 2.1 已修好 ✅（T2a–T2c）

`bootstrap.ts` 现在是
`new PluginHost({ core, modules, dataBackend: new CompositeBackend(new CoreStoreBackend(store), new KvEntityBackend(kv)) })`。

| 层 | 做了什么 |
|---|---|
| 内核 | `DataBus` 接受可选 `DataBackend`；**`emit()` 仍然同步**（D8），变更进队列；`flush()` 落盘、`restore()` 重建内存索引与配额计数 |
| 宿主 | `sync()` / `uninstall()` 结束前 `await bus.flush()`；`restoreData()` 在 install 之后、UI 订阅之前跑（`restore` 刻意不发事件） |
| shell | `CompositeBackend` 按命名空间分流：核心 → `CoreStoreBackend`（SQLite/JSON），其它 → `KvEntityBackend`（KV，一个插件一个键、一次批量只读改写一次） |
| 验收 | `data-persistence.test.ts` **11 项** + `core-data-backend.test.ts` **13 项**：建**新宿主接同一套后端**模拟重启，内容对得上；重复导入幂等；卸载后重启数据不复活；**删除也会落盘** |

**为什么用 write-behind 而不是让 `emit` 变 async**：插件契约是同步的（D8），
`bus.emit` 一旦要 `await`，整个插件 API 就得改成异步，S4b 已经证明那条路会崩。
所以**内存仍是唯一真相**，持久化是内存的投影。

**为什么核心实体不也走 KV**：任务数据有 SQLCipher 加密与索引策略，换 KV 是倒退。
分流只发生在**存储实现**层，对外只有一个 `DataBus`。

> **顺带修掉的内核缺陷**：`bus.drop()` 原来只删内存、**不入队持久化** ——
> 于是「删了一条任务，重启后它又回来了」。`DataChange` 增加了 `{kind:'drop'}`，
> 两个后端都会处理。以前没露馅是因为槽数据每次同步都整体重写。

### 2.2 `course` 的形状收敛 ✅ **已收敛**

原来有两个形状：

| | 领域 `Course`（物理层） | ICS 实体 `course`（DataBus） |
|---|---|---|
| 主字段 | `name` ← 历史遗留 | `title` ← 与插件契约一致 |
| 其余 | `code?` `color?` `createdAt` `updatedAt` | `code?` `location?` `source?` |

**现在**：`name ↔ title` 的翻译只发生在 `core-entities.ts` 的
`projectCourse()` / `unprojectCourse()` 这一对函数里 —— 它们是互逆的，
改动其中一个必须同时改另一个（有往返测试钉着）。

**`TaskStore` 不再是可写真相**：它退化成物理持久化层，UI 通过 `BusTaskStore`
门面读写总线。所以「同一个名字两个形状」只存在于**存储边界**上，
出了那个边界只有一种形状。

> ⚠️ 顺带一个必须记住的坑：`DataBus.read()` **默认跨命名空间可见**
> （按 `type` 遍历整张表）。如果插件也声明了一个叫 `course` 的类型，
> 宿主不传 `opts.owner` 就会把两边的记录混在一起。核心实体的读一律要带
> `{ owner: CORE_NS }`；**只有**「课程页」那种刻意要合并的地方才不带。

### 2.3 顺带的坑

- ~~**游标只在内存**~~ ✅ **已修**（E 段 / T10）：`cursor.<pluginId>` 存 KV，
  `restoreData()` 时读回。落盘失败不回滚内存，只记审计。
- **类型名没有归属仲裁**：只有**记录键**含 `pluginId`，类型名是全局的。两个插件各自
  声明 `course` 且 schema 不同时行为未定义（`ownersOf()` 只用于挑 schema）。
  用**槽**绕开了定义方这一侧：槽条目存在定义方命名空间下，读的时候带 `owner`。
  但「插件 A 和插件 B 各自声明 `course`」这件事本身仍然没有仲裁规则。

> 📌 `DataBus.read()` 有个**容易被忽略的默认**：不传 `opts.owner` 时它按 `type`
> 遍历整张表，**跨插件可见**。这是「插件间共享实体类型」的基础，但也意味着
> 「只想读自己/核心的」必须显式传 owner。这一轮至少踩过一次（见 §2.2 的警告）。

> 📌 `docs/design/schema.sql` 里还有 **18 张表**的完整设计（`course` / `session` /
> `plugin_registry` / `sync_state` / `plugin_quota` / `layout_profile` / `audit_log` …），
> `verify-schema.py` 能把它建出来并校验外键。但**没有任何代码在用** —— `TaskStore` 走
> 策略层的另一套表，插件实体走 KV。做 T2e 收敛时先决定：**认领这份设计，还是删掉**。别留第三套。

---

## 3. 沙箱与第三方插件：整块未开始 ❌

这是 DESIGN.md 的 P1 主干，目前**一行都没有**。`package.json` 里连 `quickjs-emscripten` 都没装。

| 项 | 状态 | 说明 |
|---|---|---|
| QuickJS(WASM) 沙箱运行时 | ❌ | 只有 `InProcessRuntime`，即**所有插件都是第一方** |
| 插件签名校验 | ❌ **完全不做**（短期实验的明确决定） | `compiledInVerifier`（`plugin-host.ts:143`）返回 `fullySigned: modules.has(id)` —— 它回答的是「**代码在不在这个应用包里**」，不是「签名对不对」。准入的真正闸门**不是验签，是加载**：`InProcessRuntime.load()` 对不在 `modules` 里的 id 直接 `ENOTFOUND`，连 manifest 校验都到不了（差分测试有一条断言钉住）。⚠️ 但 `signed` 这个等级名对第一方**名不副实**，T7 做 UI 时必须换说法 |
| 从文件 / `.mtp` 包安装 | ❌ | 插件只能编译进应用（`modules: ReadonlyMap`） |
| 信任记录持久化 | ❌ | `MemoryTrustBackend` 默认，重启即失 |
| `installBuiltin()` 独立入口 | ❌ | `allowReservedPrefix` 是裸布尔，任何 `install()` 调用方都能传 true（TODO 已标） |
| 不变量 I7–I11 的 CI 守卫 | ❌ | 没有 CI，全靠人工。**逐条实测**：I7 ✅（`capacitor.config.ts` 里没有 `CapacitorHttp.enabled: true`，缺省即关闭）、I8 ✅（全仓 0 命中 `RTCPeerConnection`）、I11 ✅（`Object.hasOwn` / `Map`）；**I9 ❌ 连实现都没有** —— `apps/shell/src` 里没有任何 `delete eval` / `SharedArrayBuffer` 处理，它只在第三方代码进来之后才有意义；I10 🔶 只做到「网络出口单一」，能力令牌随沙箱一起搁置 |
| `tools/conformance` 适配器套件 | ❌ | 跨包差分测试存在，但它比的是「两个 TS 包」，不是「JS 实现 vs 原生实现」 |
| 插件 CLI（`create`/`build`/`sign`/`dev`） | ❌ | `tools/` 只有两个 `.ps1` |

**顺序建议**：签名校验与 `.mtp` 安装格式应该**先于**沙箱。
理由：沙箱是「不可信代码怎么跑」，而如果没有验签，你根本不知道哪些代码是不可信的 ——
先有「谁可信」，再谈「在哪跑」。这也是不变量 I6 的原话。

---

## 4. 平台与打包 🔶（iOS 已铺路，未生成工程）

| 项 | 状态 |
|---|---|
| Android | ✅ 真机验证过（`tools/build-apk.ps1`，minSdk 24 / targetSdk 36） |
| Web | ✅ `vite build` 通 |
| **iOS** | 🔶 **代码层已就绪，工程未生成**。缺 `apps/shell/ios/` —— `npx cap add ios` 需要 macOS，留给协作同伴。前置已补齐（见下） |
| **通知** | 🔶 接口已定（`NotifyPort`），各端 bridge 是骨架，**行为是「诚实地说没有」** |
| **Electron（Windows EXE）** | ❌ 没有 electron 依赖，没有 `apps/desktop/` |
| **桌面卡片（widget）** | ❌ 未开始。Android 用 `RemoteViews`、iOS 用 SwiftUI，**都是独立 UI 实现**，`UiNode` 用不上 |

`apps/` 下只有 `shell` 一个。多端是原始需求里明确写的（Android → iOS → Windows），
所以这是**功能缺口**，不是「锦上添花」。好消息：D6 的纯 TS 修订让这件事变便宜了 ——
Electron 端只需要换传输层与存储后端。

### 4.1 iOS 前置已补齐

| 项 | 说明 |
|---|---|
| `@capacitor/ios` | 已进 `apps/shell` devDependencies，否则 `cap add ios` 跑不起来 |
| `capacitor.config.ts` | 补 `ios` 块与 `server.iosScheme: 'https'`（默认是 `capacitor`，与 CSP/鉴权不一致） |
| `engines.platform` | ICS 插件补 `'ios'`（该字段目前只校验形状、不做运行时拦截，但不写就是文档撒谎） |
| 代码层可移植性 | 无 `if (platform === 'android')`；三个存储插件都有 iOS 实现；索引策略本就有探针 + 影子表退路 |

### 4.2 通知桥：平台差异是数据，不是分支

`NotifyPort` 只暴露一个 `capabilities()`，各端自报四件事：

| | `exact` | `maxPending` | `lostOnReboot` | `requiresPermission` |
|---|---|---|---|---|
| Android | 看精确闹钟权限 | 无硬上限 | **true**（闹钟重启即丢） | true（13+） |
| iOS | **true** | **64** | false | true |
| web / 当前构建 | false | 0 | false | false |

于是调度器只写一遍。那个 64 是**全局设计约束**：滚动窗口必须按最小的上限设计。

**状态诚实说明**：`Platform.notify` 是 `CapacitorNotifyPort`（两端统一适配层），
但原生骨架如实报告 `supported: false` —— 所以 `isSupported()` 为 false、
`schedule()` 抛错，启动时往 `warnings` 里写一条「本构建没有可用的通知桥」。
宿主**没有**把 `notify.local` 放进 `IMPLEMENTED_CAPABILITIES`。
详见 `packages/capacitor-notify/README.md`。

---

## 5. 契约层残留（小口子，但都标了）

| 项 | 说明 |
|---|---|
| `bus.read` 无读闸 🔶 | `data.read` 不检查。补不了的原因：唯一调用方是 shell 自己的 Timeline，没有插件身份。等 Timeline 变插件才补得动 |
| `contributes.views` 无校验 ~~❌~~ | ✅ 已修好（U1），见 §1.3 |
| `EntitySchema` 无 `oneOf` / 嵌套对象 🔶 | 扁平字段 + 数组。注意：`array.items` **会**逐项递归校验，`object` **不**递归 —— 复杂实体要降级成字符串或拍平成多个实体 |
| 内核审计与核心审计未合并 🔶 | 两套 schema 不同，`bootstrap.ts:95-97` 明确写了这是 P2 |
| 授予 / 撤销信任的 UI ❌ | 状态机与联动都在，用户点不到 |
| 受限模式徽章渲染 ❌ | 同上 |

---

## 6. 文档债

| 文件 | 状态 | 处置建议 |
|---|---|---|
| `docs/design/api-v1.d.ts` | ❌ **过期草案**，与 `packages/plugin-api/src/v1/` 冲突 | **删掉**。真实源码 + README 才是唯一来源，留着只会误导 |
| `docs/design/schema.sql` | ❌ 没接（内核没有数据库） | 等 §2 持久化落地时重写，现在删掉或标注「未使用」 |
| `docs/design/sandbox-sketch.ts` | 🔶 草图，未实现 | 保留，但标注「草图」 |
| `docs/design/verify-schema.py` | 🔶 脚本本身能跑，但它验证的是 `schema.sql` —— 而那个 schema **没有任何代码在用** | 保留（它是「打算建成什么样」的参考，见 §2.3 的 📌），但标注「未接线」 |
| `DESIGN.md` §2 仓库结构 | ❌ 描述的是 `src/plugins/builtin/`、`plugins/` 根目录等**不存在的结构** | 按实际树重写 |
| `packages/plugin-api/README.md` | ✅ **1442 行 / 16 节**，本轮新增 §7.9「控件（UI）」整节（含原语表、Action、`ViewContext`、自由度限制、最小示例、自查清单） | 只剩「能力探测交付通道」一个缺口 —— 已决定短期不做（`dev.md` §3.1），那是改契约不是改文档 |

---

## 7. 建议路线（按「阻塞什么」排序）

| 顺序 | 缺口 | 阻塞什么 | 规模 |
|---|---|---|---|
| 1 | ~~能力清单说真话~~ ✅ **已完成** | — | 已完成 |
| 2 | ~~§2 数据持久化~~ ✅ **已完成**（T2a–T2c） | — | 已完成 |
| 3 | ~~第一个插件端到端~~ ✅ **已完成** | — | 小 |
| 4 | ~~§1.3 视图渲染层~~ ✅ **已完成**（U1–U6） | — | 已完成 |
| 4b | ~~§2.2 类型收敛~~ ✅ **已收敛**（A 段：投影处 `name → title`） | — | 已完成 |
| 4g | ~~**C 段：DataBus 成唯一数据层**~~ ✅ **已完成**：`CompositeBackend` 分流 + `BusTaskStore` 门面 + 投影删除 | — | 已完成 |
| 4c | ~~§2.2 收尾：`CoursesView` 改读 DataBus~~ ✅ **已完成**（T15） | — | 已完成 |
| 4d | ~~插件互操作（槽机制）~~ ✅ **已完成**（B–D） | — | 已完成 |
| 4e | ~~控件改数据（命令通道）~~ ✅ **已完成**（T14） | — | 已完成 |
| 4h | ~~**通知桥接口 + 适配层 + 各端骨架**~~ ✅ **接口与适配层已完成**：`NotifyPort` + `CapacitorNotifyPort`（26 项断言）+ `packages/capacitor-notify/`（Android 已编进 APK，iOS 未验证） | 各端原生实现 | 二期 |
| 4i | **`npx cap add ios` 生成 Xcode 工程** —— 需要 macOS，本机做不了 | 无（代码层已就绪） | 协作同伴 |
| **4f** | **T6 读闸（`permissions.data.read`）** | 插件主动读任何类型都能拿到。**用户决定推迟到二期** | 小，但二期第一件 |
| 5 | **签名校验 + `.mtp` 安装** | 第三方插件的一切 | 中大 |
| 6 | **QuickJS 沙箱** | 第三方代码真正跑起来 | 大（S1–S5 的结论已经铺好路） |
| 7 | **iOS / Electron** | 原始需求里的多端 | 中大 |
| 8 | 通知 / 调度 / 鉴权代理 / `db.*` | 连接器类插件 | 大，可并行 |

**T6（`DataBus.read()` 的 `permissions.data.read` 闸）用户已决定推迟到二期**，
理由是加快成型。这条缺口如实记录在这里：

> 现在任何插件读任何类型都能拿到数据，`permissions.data.read` 只在**控件取数**
> （`ui/record-selection.ts`）那一处被检查。也就是说权限声明在「插件主动读」
> 这条路上是**装饰性的**。
>
> 之所以现在还不致命：能跑起来的插件只有第一方的 Timeline 和 ICS，两者都是我们自己写的。
> 一旦第三方插件（沙箱 + `.mtp`）上线，这条必须先补，否则「插件 A 偷看插件 B 的数据」
> 就是一行代码的事。

**所以二期开工的第一件事是 T6，不是沙箱。** 沙箱解决的是「代码跑不出去」，
读闸解决的是「数据不串门」——后者更便宜，且是前者的前提。

---

## 8. First-Party Plugins 候选

**挑选原则**：一个插件应该只压出一个核心缺口。
需要四个缺口的插件不是「第一个插件」，是「第一个里程碑」—— 它会同时失败在四个地方，而你分不清是哪一处坏了。

| 插件 id | 干什么 | 卡在哪个缺口 | 建议 |
|---|---|---|---|
| `app.matrix.importer.ics` | ICS 课表导入 | **无** —— 本地导入链路已通 | ① ✅ **已完成**（`manifest` / `parse-ics` / `index` / `IcsImportView` / 22 项断言，已注册）。唯一残留：数据活不过刷新（§2） |
| `app.matrix.importer.csv` | 通用 CSV 导入（成绩 / 名单） | 无（换一个解析器，走同一条 `source: 'host'` 路） | ② 几乎零成本，用来证明「本地导入不是只为 ICS 写的」 |
| `app.matrix.timetable` | 周课表视图 | 控件层（✅ U1–U6）+ §2 持久化（✅） | ③ **控件层的第一个真消费者**，现在就能写 |
| `app.matrix.timeline` | 时间轴聚合 | 控件层（✅）+ `bus.read` 读闸 | ③ 与 timetable 共用控件层，一起做才划算 |
| `app.matrix.notifier` | 上课提醒 | `notify.local` + `schedule.*` | ④ 会逼出通知与调度两条线 |
| `app.matrix.connector.ecloud` | 上科大 E云课堂连接器 | `auth.login` + §2 持久化 + `schedule.periodic` | ⑤ **压轴**。它一次性需要三个缺口，不能早做 |
| `app.matrix.exporter.json` | 全量导出 / 备份 | §2 + 跨插件读 | ⑥ 等数据层稳了才有意义 |
| `app.matrix.search` | 全局搜索 | §2 + `bus.read` 读闸 | ⑦ 同上 |

### 8.1 为什么第一个插件是 ICS 导入

不是因为它重要，是因为它**只压出一个缺口**（本地文档进来），而那条路刚修好。
它是「本地导入」这个核心能力的验收用例，顺便给用户一个真实可用的功能。

### 8.2 什么时候才算「插件体系真的能用」

三个判据，缺一不可：

1. 一个**第三方**（不是编译进应用的）插件能装上、跑起来、被撤销
2. 插件的数据**活过重启**
3. 插件能**画东西**（否则只有导入、没有呈现）

现在 1 ❌、2 ❌、3 ❌。第一个插件只覆盖了「导入」这一段。

### 8.3 不建议做成插件的

- `app.matrix.core` / `dev.matrix.settings` —— 与内核/宿主重复，做成插件只是给自己加一层转发
- `app.matrix.llm.*` —— `llm.complete` 完全没实现，且需要新的信任模型（数据出网到模型商）
- 「主题 / 字体」之类 —— 声明式布局（D5）本来就该覆盖，做成插件是错位

---

## 9. 插件作者手册：本轮已补齐 ✅

下一个会话要**只靠文档**写出插件。`packages/plugin-api/README.md`（1241 行 / 15 节）
本轮把下面 10 项全补了：

| # | 原来缺什么 | 现在在哪（**README** 节号） |
|---|---|---|
| 1 | 可复制的最小骨架 | **§1.1**（`manifest.ts` + `index.ts`，两个文件复制就能跑） |
| 2 | 宿主加载契约 | **§1.2**（`modules: ReadonlyMap<string, PluginExports>`、`allowReservedPrefix`、`kind` 与 `entry` 的毛刺） |
| 3 | 哪些能力探测会骗你 | **§9** 整节重写（规范上限 vs 运行时实际两张表 + **插件现在根本没法探测**） |
| 4 | `ParseInput.baseUrl` 语义 | **§5.3**（是**响应最终 URL**，重定向之后那一跳；不是目录，别字符串拼接） |
| 5 | parser 抛异常会怎样 | **§5.3**（`EINTERNAL`、**整轮失败**；只想记一条就返回 `{ error }`） |
| 6 | 三个配额的默认值与超限行为 | **§11.4**（16 / 32 / 5 MiB，且**三者超限后果不同**） |
| 7 | `bus.emit` 到底怎么合 | **§7.5**（**按 `id` 覆盖，不是合并**；权限矩阵那四个字是设计意图，以 §7.5 为准） |
| 8 | `EntitySchema` 运行时行为 | **§7.1** 逐条表（`integer` 拒 `1.5`、`enum` 严格 `===`、`array.items` 递归、`object` 不递归） |
| 9 | `shared` 投影规则 | **§7.3**（补了「读自己写的不裁」这条边界） |
| 10 | `syncIntervalMin` 不触发任何东西 | **§3.4** 新表（`commands` / `connectors` **都没人读**；`views` 已经有人读了） |

**判断标准**：另一个会话只读这份文档，能不能写出一个能跑的插件。
现在能了 —— 前提是它接受「只有本地导入 + 网络请求这两条路」。

剩下的文档缺口只有一个：**能力探测的交付通道**（§1.2）。那不是文档问题，
是要改契约 —— 但短期实验已决定不做（`dev.md` §3.1），因为只有第一方插件，
它们本来就知道宿主有什么。

---

## 10. 一句话总结

内核可信、契约可信、**宿主仍然很窄，但已经不说谎了**。

本轮净收益三件：**第一个插件端到端跑通**（22 项断言）、**能力清单说真话**
（23 项声明 → 3 项实际，其余干脆不存在）、**插件手册能照着写**（10 项缺口补齐）。

下一个会话应该只做一件事：**把数据持久化补掉**（§2），让 ICS 导入的数据活过刷新。
其余（沙箱、签名、视图引擎、多端）都不该在这一轮碰 ——
它们现在都**不在能力清单里**，所以搁置是诚实的，而不是骗人的。
