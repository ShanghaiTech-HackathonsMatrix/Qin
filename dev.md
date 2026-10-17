# 开发待办

> 依据：`docs/design/GAPS.md`（逐项核实过代码的缺口分析）。
> 项目定位：**短期实验性项目** —— 目标是验证「插件体系能不能用」，不是交付产品。
>
> 标记：🔴 P0 必做 · 🟡 P1 该做可缓 · ⚪ 短期实验明确搁置
>
> **当前状态**：`npm run check` = 115 + 87 + 87 + 28 + 11 + 13 + 26 + 36 + 22 + 21 = **446 项断言全绿**，`vite build` 通。
> 已完成：T1、T2a–T2c + T2f、**U1–U6（控件组件 UI 系统）**、
> **A–E（核心实体投影 + 槽机制 + Timeline 插件化 + ICS 接槽 + 游标持久化）**、
> **T14（命令通道）、T15（课程页读 DataBus）**、
> T3（第一个插件）、T4（插件手册）、T9（`contributes.views` 校验）、T10（游标持久化）。
> **P0 / P1 的数据与 UI 主干全部打通**：插件能读、能写、能互相插入、能被点击改数据。
>
> **短期实验的三个明确决定**（已落地）：
> ① 能力探测**不做**（插件拿不到 `capabilities`，零成本延后）
> ② 签名校验**不做**（准入靠「代码在不在包里」，见 §3.2）
> ③ 沙箱**不做**（没有第三方代码能进来，连桩都没有）

---

## 0. 「能不能搁置」的三条标准

1. 不影响「第一个插件端到端跑通」
2. 不构成**假安全**（不是「看起来在保护、实际没保护」）
3. 搁置时**不会骗人** —— 文档写明、能力清单里不出现

第 3 条是硬约束，前两条可以商量。理由很实际：
**「没有」会让人来问，「假的」会让人基于它做决定。**

这条标准当初决定了顺序 —— **T1（能力清单说真话）是唯一一件「不做就不能开工」的事**。
它**已经做完了**，所以下面所有 ⚪ 项现在都是安全的：搁置的能力根本不出现在 `capabilities()` 里。

> ⚠️ **一个例外，T1 修不了**：第三方代码的**准入**。它既不是能力探测，也不是验签 ——
> 真正的闸门是「代码在不在这个应用包里」（`InProcessRuntime` → `ENOTFOUND`）。
> 所以它单独算一条，见 §3.2。

---

## 1. 🔴 P0 —— 现在做

### T1 能力清单说真话 ✅ 已完成

| | |
|---|---|
| **做了什么** | ① `HOST_CAPABILITIES_V1` 语义改为「v1 规范的**上限**」<br>② 新增 `IMPLEMENTED_CAPABILITIES`（`plugin-host.ts`），只列插件真能用的三项<br>③ `RegistryDeps.capabilities` 注入，`capabilities()` 返回它，**缺省空数组**（`registry.ts:191`）<br>④ 差分测试新增断言：`⊆ HOST_CAPABILITIES_V1` 且**不含**未实现项 |
| **验收** | `host.registry.capabilities()` === `['net.request','local.request','bus.emit']`；`db.namespaced` / `notify.local` 一律 `false` ✅ |
| **残留** | 清单真了，但**插件还拿不到它** —— 已决定短期不做，见 §3.1 |

`bus.read` / `secrets.namespaced` 刻意**不列**：内核与核心层都有相关代码，
但插件**没有调用路径**。能力清单说的是「插件能用什么」，不是「宿主内部有什么」。

### T2 数据持久化 + DataBus / TaskStore 收敛

#### 先回答前置问题：这两层是什么关系

| | `TaskStore` | `DataBus` |
|---|---|---|
| 类型 | **编译期固定**：`Task` / `Course` 两个 | **运行时任意**：manifest 声明 |
| 接口 | **async**，typed 方法（`listTasks` / `putTask`） | **同步**（D8：插件没有异步宿主 API） |
| 隔离 | 无（单一命名空间 `NS = 'app_matrix_timeline'`） | `pluginId` 命名空间 + schema + 配额 |
| 物理位置 | SQLite / SQLCipher / JSON(KV)，三级降级 | **纯内存 `Map`** |
| 谁在用 | `App.tsx` / `CoursesView` / `TimelineView` | 插件（ICS 导入） |

#### 实测出来的真问题：`course` 有两个，而且不是一个东西

| | 领域 `Course`（TaskStore） | ICS 实体 `course`（DataBus） |
|---|---|---|
| 主字段 | `name` | `title` |
| 其余 | `code?` `color?` `createdAt` `updatedAt` | `code?` `location?` `source?` |

后果比「刷新丢数据」更糟：**ICS 导入成功、数据在 DataBus 内存里，而 `CoursesView`
一个字都看不到** —— 它读的是 TaskStore。所以现在「导入成功」和「用户看见」之间
断了一整条链，而不只是断了持久化。

`importer-ics/manifest.ts:28` 的注释其实早就写了这件事：
「`course` 是**全局类型名**……等核心表出现时再收敛」。**T2 就是那个「收敛」。**

#### 三条路

| | 做法 | 代价 | 判断 |
|---|---|---|---|
| **A** | DataBus 加后端，TaskStore 不动 | 小 | ✅ **先做** —— 两种终局都要用到它 |
| B | 视图层合并两个数据源 | 小但脏 | ❌ 掩盖问题；「编辑写回哪边」说不清 |
| C | ~~DataBus 成唯一数据层，TaskStore 退化成门面~~ | ✅ **已完成**（C 段，见 §1 末尾） | 已完成 |

选 A 的核心理由：**它不浪费**。C 最终要落到的就是「DataBus + 一个后端」这个形状，
A 正好是它的地基。而且 A 做完，「数据活过刷新」就能验收，不必等收敛。

#### 任务细分

| # | 任务 | 做什么 | 规模 | 本批 |
|---|---|---|---|---|
| **T2a** | 内核：`DataBackend` + write-behind | `DataBus` 接可选后端；**`emit()` 保持同步**，变更进队列；新增 `flush()` / `restore()` | 小 | ✅ |
| **T2b** | 宿主：接上 flush / restore | `sync()` / `uninstall()` 后 flush；bootstrap 里 restore；删掉「数据在内存里」的警告 | 小 | ✅ |
| **T2c** | shell：KV 后端实现 | `entity.<pluginId>.<type>` → JSON 数组；用 `SecureStore.keys()` 枚举；**一批一写**避免 O(n²) | 中 | ✅ |
| **T2d** | 类型收敛：`course` 只留一个形状 | 定 `title` 还是 `name`；让 ICS 写进领域能认的形状（或加显式映射） | 小 | ✅ 投影里做映射（`name` → `title`） |
| **T2e** | 视图能看见插件数据 | `App.tsx` 把插件实体并入状态（A 路最小桥），或直接做 C | 中 | ✅ T15 |
| **T2f** | 测试 | 内核后端契约 + KV 往返 + 「emit → flush → 新 bus → restore → read 相同」 | 中 | ✅ |

**为什么 T2a 用 write-behind 而不是让 `emit` 变 async**：插件契约是同步的（D8），
`bus.emit` 一旦要 `await`，整个插件 API 就得改成异步，S4b 已经证明这条路会崩。
所以**内存仍是唯一真相**，持久化是内存的投影，由宿主在 `sync()` 之后 `await flush()`。

**为什么 T2c 走 KV 而不是新开 SQLite 表**：`TaskStore` 的 `SqlDb` 是私有的，硬接要么
开第二个连接、要么把抽象捅个洞；而新开一张 `plugin_<ns>_entity` 表就是**第三套表**
（`schema.sql` 那 18 张已经闲置了）。KV 一条代码路径同时覆盖 web 与 Android，
预览量级（几百条）完全够用。**代价写清楚**：实体走 KV、任务走 SQLite，
在 SQL 后端下这是个不对称；等 C 收敛时一起消掉。

#### 验收（本批）

导入 `.ics` → **刷新页面** → `IcsImportView` 里记录还在 → `bus.stats()` 与
`usageOf()` 的行数/字节数与重载后一致。全程 `transport.calls === 0`。

### T3 第一个插件端到端 ✅ 基本完成

| | |
|---|---|
| **现状** | `apps/shell/src/plugins/builtin/importer-ics/` 已齐：`manifest.ts` / `parse-ics.ts` / `index.ts` / `IcsImportView.tsx` / `conformance.test.ts`（22 项断言），已在 `bootstrap.ts:103` 注册进 `modules` |
| **还差** | ~~① 插件实体进了课程页~~ ✅ T15 已解决<br>~~② 游标仍未持久化~~ ✅ T10 已解决 |
| **验收** | 选 `.ics` → 实体落库 → **刷新仍在** → 视图列出；全程 `transport.calls === 0` |
| **规模** | 已完成 |

> 这个插件证明的是「本地文档 → 纯函数解析 → 落库 → 持久化 → 控件渲染」这条链通了。
> 它**不**证明：跨插件读取（T6）、第三方插件（§3.1 的沙箱与 `.mtp`，目前靠「不存在」强制）。
> 数据持久化（T2a–T2c）与控件渲染（U1–U6）**已经补上了**。

### T4 插件作者手册 ✅ 已完成

| | |
|---|---|
| **做了什么** | `packages/plugin-api/README.md` 从 1000 行 / 14 节扩到 **1241 行 / 15 节**，10 项缺口全补 |
| **硬阻塞三项** | ① **README §1.1** 可复制骨架（两个文件复制就能跑）② **README §1.2** 宿主加载契约 ③ **README §9** 能力探测真相（整节重写） |
| **次要七项** | `baseUrl` 是**响应最终 URL** / parser 抛异常**整轮失败** / 三个配额**后果不同** / `bus.emit` 是**按 id 覆盖** / `EntitySchema` 逐条表 / `shared` 投影边界 / `syncIntervalMin` 不触发任何东西 |
| **残留** | 无 —— 唯一缺口是「能力探测交付通道」，已决定短期不做（§3.1），那是改契约不是改文档 |

> 判断标准：**另一个会话只读这份文档，能不能写出一个能跑的插件。**
> 现在能了，前提是它接受「只有本地导入 + 网络请求这两条路」。

---

### 控件组件 UI 系统 ✅ 已完成（原 T5，U1–U6）

**核心决定**：插件**不持有 UI**，它产出一棵 `UiNode` 树；输入**不回调插件**，
输入变成 `Action` 由宿主路由。

```
数据 → render(纯函数) → UiNode → 宿主渲染 → 用户操作
     → Action → 宿主路由 → 改数据 → 重新 render
```

为什么不用 React 组件：**D8** 不允许回调（插件是纯函数、无状态、无异步宿主 API）；
**沙箱**里 React 组件跨不过去而 JSON 树可以；**可测** —— 渲染器用 `createElement`
写成 `.ts`，整套 UI 在 Node 里就能断言，不需要 jsdom。

| # | 做了什么 | 落点 |
|---|---|---|
| U1 | 契约：`UiNode` / `Action` / `ViewContribution` / `ViewContext` / `parseUiNode`（校验并**重建**，节点数/深度/文本长度设上限） | `plugin-api/src/v1/ui.ts` |
| U2 | 渲染器：8 个原语（stack / card / text / button / list / badge / empty / divider）+ 8 个内联图标 | `apps/shell/src/ui/render.ts` |
| U3 | 布局文档：`layout.<profileId>` 存 KV，坏数据退回默认并备份原内容 | `apps/shell/src/ui/layout.ts` |
| U4 | 目录从 manifest 派生（**不落盘**）+ 交叉核对「声明了没实现 / 实现了没声明」+ 动作路由 | `ui/catalog.ts`、`ui/WidgetPage.ts` |
| U5 | 第一个控件：ICS 课程列表（只读 + `navigate` / `setUi`） | `importer-ics/views.ts` |
| U6 | 21 项断言：渲染器、目录、布局、控件纯度、**「控件产出的每个 Action 宿主都认得」** | `apps/shell/src/ui/ui.test.ts` |

**自由度（已与用户确认接受）**：组合几乎不限（任意嵌套），但原语封闭、样式只能选
语义档位（`tone` / `gap` / `size`）、图标只能是核心枚举、**不能引网络图片**。
换来「插件 UI 一定长得像 Matrix」+「沙箱里能跑」+「Node 里能测」。

**刻意没做的**：
- **没有「任意命令」动作**。v1 只有 `navigate` / `setUi` / `sync`，因为宿主端没有
  `contributes.commands` 的执行入口 —— 加了就是点了没反应的假开关。见 T14。
- **没有用户改布局的 UI**。布局能存能读能校验，但改它还得手改 KV。默认布局是
  `autoLayout(catalog)`，装了插件就自动出现。

---

### 核心实体投影 + 槽机制 + Timeline 插件化 ✅ 已完成（A–E）

**这一轮解决的问题**：插件之间怎么共享数据，而不互相调用。

| 段 | 做了什么 | 落点 |
|---|---|---|
| **A** | 核心命名空间 `dev.matrix.core` 的规范实体；宿主把 `TaskStore` 的**只读镜像**投影进 DataBus。`Course.name` → `title` 在投影处收敛 | `core/core-entities.ts`、`core/core-projection.ts` |
| **B** | 槽机制：`contributes.slots`（带 `fields` schema）+ `consumesSlots`（带 `map`）+ `permissions.ui.slots`（授权）+ `PluginExports.slotValidators`（`CheckEvent` 的纯函数形态） | `plugin-api/src/v1/slot.ts`、`core/slot-resolver.ts` |
| **C** | Timeline 插件：定义 `app.matrix.timeline.event` 槽 + `kind: 'page'` 只读视图 | `plugins/builtin/timeline/` |
| **D** | ICS 声明往槽里塞 `session`。**没有 import Timeline**，只写了个槽名字符串 | `importer-ics/manifest.ts` 的 `consumesSlots` |
| **E** | 游标持久化（T10）：`cursor.<pluginId>` 存 KV，重启后读回 | `core/cursor-store.ts` |

**关键决定：不做插件互相调用。**

曾经的提案是 `Core.accessPlugin(id).invoke('insert', ...)`。它同时破 D8（回调/状态）、
D3（插件写存储）、可复现性（A 的输出依赖 B 的状态），而且沙箱里同步跨实例调用不成立。
槽改成**纯数据**的协议：`map` 是 `{'槽字段': '实体字段'}`，JSON 能过边界。

**代价说清楚**：`contributes.consumesSlots`（我想写）和 `permissions.ui.slots`（用户批准）
**两处都要写**。这是刻意的 —— 和 `data.write` 同一套思路 —— 但也确实容易漏，
所以 README §7.10.7 的自查清单里单列了一条。

**已知的不对称**：TaskStore 是可写真相，DataBus 里那份是派生镜像。用户改任务后
`reload()` 会重新投影一次。等 T14（命令通道）做完，UI 写入也能走 DataBus，
TaskStore 才能退化成门面 —— 在那之前**不要**把 DataBus 里的核心实体当成可写。

**「勾选完成」暂时没有 UI 入口**：Timeline 现在只读，而插件回写需要 T14。
`App.tsx` 里的 `toggleDone` 保留但没人调用，注释写明了为什么留着。

---

### T14 命令通道 + T15 课程页 ✅ 已完成

**T14：控件怎么改数据，而不变成假开关。**

```
button.onPress = { kind:'command', id:'toggleTask', input:{taskId, to} }
        ↓ 用户点
宿主：contributes.commands 里有 toggleTask？→ 没有就 ENOTFOUND
        ↓
宿主：exports.commands.toggleTask 存在？→ 没有就 EMANIFEST（打包缺陷）
        ↓
宿主：跑纯函数 → { coreOps:[{op:'task.setStatus',...}], message }
        ↓
宿主：校验返回值（插件交回来的是不可信数据）→ 未知 op 就 ESCHEMA，且什么都不执行
        ↓
宿主：coreOp 碰的 'task' 在 permissions.data.write 里吗？→ 没有就 EPERM
        ↓
宿主：写 TaskStore → 重新投影 → 重新收集槽 → 界面刷新
```

**关键决定：命令也是纯函数。** `(input, ctx) => 要做什么`，不写存储、不发请求。
最省事的 `setData()` 回调同时破 D8（回调有状态）、D3（插件能写）、可测试性
（有状态的命令没法用「同样输入 → 同样输出」钉住）。

**`coreOps` 是封闭清单**（现在只有 `task.setStatus` / `task.delete`）。
让插件提交任意补丁等于把 D3 从后门还回去。加新操作 = 改核心 + 改契约 + 加测试，
这个摩擦是刻意的。

**T15：课程页改读 DataBus。**

`CoursesView` 原来直接读 `TaskStore`，所以 ICS 导入的课一个字都看不见 ——
数据明明落了盘，界面却是空的。现在它读 `plugins.readShared('course')`：
`DataBus.read()` 不带 `owner` 时跨命名空间，每条记录按**自己所有者**的 schema 裁剪字段，
所以核心的 `color` 和 ICS 的 `location` 不会互相污染。

**插件课程只读。** 它的真相在插件那边，下次 `sync()` 会整体重写。
让用户在这里改、改完被覆盖，那是骗人。所以编辑 / 删除按钮只对核心课程出现。

**两处新的权限扩张，都是真实的：**

| 扩张 | 为什么必须 |
|---|---|
| Timeline `data.write: ['task']` | `toggleTask` 要改核心任务状态。没有它，命令会被 EPERM 拒掉 |
| `readShared()` 只给宿主用 | 插件读别人的记录要走 `permissions.data.read`，那条闸还没做（T6） |

**已知的不对称（仍然存在）**：`TaskStore` 是可写真相，DataBus 里那份是派生镜像。
命令改完 `TaskStore` 后必须重新投影，否则插件读到的是旧数据 ——
`applyCoreOps` 里那一步不能省，省了就是「操作成功了但界面没变」。

---

### 真机反馈修掉的两个缺陷

用户在 APK 上验证时报告「勾选完成没问题，但**找不到导入课表的入口**」。查出两个问题，
其中一个是 T15 引入的回归：

**① 导入入口只在调试面板里。**
`IcsImportView` 只被 `DebugPanel` 挂载，而调试面板要连点版本号 5 次才出来。
从正常界面确实找不到。**修法**：把它挂到「课程」页（用户想加课的地方），
并把控件空态的「去导入」从 `navigate: 'settings'` 改成 `navigate: 'courses'` ——
原来指向设置页，而设置页里根本没有导入入口，点了就是死胡同。

**② `recordsFor` 给 `course` 限定了 `owner: CORE_NS`（我的回归）。**
T15 时为了「避免和插件同名类型混淆」加的。但 `course` 是**共享类型名**：
核心写自己那份，ICS 也写自己那份。限死核心命名空间后，ICS 的控件
`requires: ['course','session']` 拿到的是**核心**课程（用户没建过 → 空）+ 跨命名空间的课时，
于是「有课时、零课程」→ 控件**永远停在空态**。

用户看到的现象是「导入了课表，首页还是让我去导入」。
**修法**：不带 `owner`（跨命名空间，每条记录按自己所有者的 schema 裁剪字段）。
同时把这段逻辑从 `WidgetPage.ts` 搬到 `ui/record-selection.ts` —— 原来它和
`import React` 住在一起，Node 测试根本 import 不进来，所以这个 bug 没有被测试拦住。

> **教训**：这段逻辑决定「插件能看到哪些数据」，是最该被测试的东西，
> 却因为住在一个 React 文件里而测试不可达。**能测的逻辑不要和框架绑在一个文件里。**

另外顺手删掉了 ICS manifest 里的 `commands: [{id:'import'}]` ——
它从来没有 `exports.commands` 实现。T14 之前没人读这个字段所以无害，
T14 之后命令是真会被执行的，留着就是埋了一个「点了必然 `EMANIFEST`」。

---

### C 段 ✅ 已完成：DataBus 成唯一数据层

**要解决的问题**：核心数据存两份。`TaskStore` 是可写真相，DataBus 里那份是投影出来的镜像，
每次写完都要记得重新投影一遍 —— 漏一次就是「界面改了、时间线没改」。漏调是迟早的事。

**改法：把投影去掉，让总线成为真相。**

```
之前：  UI → TaskStore（真相） → projectCore() → DataBus（镜像） → 插件
现在：  UI → BusTaskStore（门面） → DataBus（真相） → flush → CompositeBackend
                                                              ├→ 核心命名空间 → SQLite/JSON
                                                              └→ 其它命名空间 → KV
```

三块新东西：

| 文件 | 职责 |
|---|---|
| `core/core-data-backend.ts` | `CoreStoreBackend`（记录 ↔ 领域对象，落物理层）+ `CompositeBackend`（按命名空间分流） |
| `core/bus-task-store.ts` | `BusTaskStore`：给 UI 的 `TaskStore` 门面，读写都走总线 |
| `core/core-entities.ts` | 新增 `unprojectTask` / `unprojectCourse`，与 `project*` **成对** |

**消失的东西**（这是重点）：

- `core-projection.ts` 与它的 15 项断言 —— 投影这个动作不存在了
- `PluginHost.projectCoreEntities()` —— 投影时代唯一的「宿主绕过权限写核心数据」入口
- `Platform.projectCore` —— 旧调用方现在**编译不过**，而不是静默不做事
- `App.reload()` 里的重新投影调用 —— 它现在是一次纯读

**顺带修掉一个内核缺陷**：`bus.drop()` 只从内存删记录、**从不入队持久化**。
所以「用户删了一条任务，重启后它又回来了」。`DataChange` 增加了 `{kind:'drop'}` 一档，
`drop()` 现在会入队，两个后端都会处理。这个缺陷以前被掩盖着：槽数据每次同步都整体重写，
所以看起来「删掉了」；核心任务没有这种重写，一删就露馅。

**`await putTask(t)` 的语义是「落盘了」**：门面里每条写操作都 `await bus.flush()`。
总线是 write-behind 的，不 flush 就返回等于骗人。

**历史包袱已处理**：投影时代核心记录也被写进过 KV（键 `entity.dev.matrix.core`）。
`CompositeBackend.loadAll()` 会识别并**删掉**那份过期快照 —— 否则旧版本里删掉的任务
会从快照里复活。有测试钉着。

**集成验证**（真实装配顺序，Node 里跑）：

```
① 门面写入后 —— 物理层: 1 条，总线: 1 条
② 命令 toggleTask: applied=1 → 物理层 done，门面读到 done
③ 重启后 —— 交作业/done
④ ICS sync: ok → 课程卡: 线性代数(只读)
⑤ 删除后物理层 0 条 → 再重启仍是 0 条（删掉的不复活）
⑥ KV 里的核心键: 无（干净）  只剩 entity.app.matrix.importer.ics / entity.dev.matrix.timeline
```

**仍然存在的不对称**：物理层还是两个（核心走 SQLite、插件走 KV）。
但那是**存储实现**的差异，对外只有一个 `DataBus`，调用方看不出区别 ——
和之前「两个真相、两条写路径」是两回事。

---

| # | 项 | 现状 | 做什么 | 规模 |
|---|---|---|---|---|
| ~~T5~~ | ~~视图渲染层（最小版）~~ | **✅ 已由 U1–U6 取代并完成**（见 §1 末尾「控件组件 UI 系统」） | — | — |
| T6 | **`bus.read` 读闸** | `data.read` 不检查（TODO 已标） | **⏸ 二期**：用户决定先跳过，以加快成型。风险已记录（见下） | 小 |
| T7 | **授予 / 撤销信任 UI + 受限徽章** | 状态机与联动都在，用户点不到 | 一个列表 + 两个按钮 + 徽章。**注意 `signed` 这个等级名对第一方名不副实，做 UI 时必须换说法** | 中 |
| T8 | **内核审计与核心审计合并** | 两套 schema，`bootstrap.ts:97` 写明是 P2 | 统一条目形状，一个 sink | 中 |
| ~~T9~~ | ~~`contributes.views` 校验~~ | **✅ 已完成**（U1）：形状已定死，`validateContributes` 会校验 id / kind / requires / defaultSize | — | — |
| T10 | ~~**游标持久化**~~ | ✅ **已完成**（E 段）：`cursor.<pluginId>` 存 KV，`restoreData()` 时读回 | — | 已完成 |
| T11 | **`installBuiltin()`** | `allowReservedPrefix` 是裸布尔 | 收成独立入口，让开关在类型上不可从第三方路径触达 | 小 |
| T12 | **文档债清理** | `api-v1.d.ts` 过期且与源码冲突；`schema.sql` 无人用；`DESIGN.md` §2 描述不存在的目录结构 | 删 `api-v1.d.ts`；`schema.sql` 按 T2 决策处置；§2 按实际树重写 | 小 |
| T14 | ~~**控件「任意命令」通道**~~ | ✅ **已完成**：`Action.command` + `PluginExports.commands`（纯函数）+ 宿主 `runCommand` + `coreOps` 封闭清单 + `applyCoreOps` 注入 | 见下方小节 | 已完成 |
| T15 | ~~**`CoursesView` 改读 DataBus**~~ | ✅ **已完成**：宿主跨命名空间读 `course`，插件课程以只读形式显示 | 见下方小节 | 已完成 |

> **能力探测已决定不做**（短期实验）。它不在上表里 —— 见 §3.1 的搁置行，
> 以及那里写的扩展路径（纯加法，老插件不受影响）。

T12 里 **`api-v1.d.ts` 建议直接删** —— 它是设计阶段的草案，现在与
`packages/plugin-api/src/v1/` 冲突。留着只会让下一个会话抄错。

---

### iOS 与多端通知桥（预留，未实现）

#### 当前代码能不能编成 iOS App

**能，代码层没有 Android 绑定。** 依据：

| 检查项 | 结论 |
|---|---|
| TS 层有没有 `if (platform === 'android')` | 没有。`getPlatform()` 只在一处用来判断是不是 web |
| 存储策略 | `@capacitor-community/sqlite` / `@capacitor/preferences` / `@aparajita/capacitor-secure-storage` 三个都有 iOS 实现 |
| SQLite 版本差异（生成列要 3.31+） | 已有探针 + 影子表退路，`indexing` 策略本来就是为这个设计的 |
| 出网 | 核心层只走 `https`，iOS 的 ATS 不需要开例外 |

**已经补掉的三处 iOS 前置**：

1. `@capacitor/ios` 加进 `apps/shell` 的 devDependencies —— 否则 `cap add ios` 跑不起来
2. `capacitor.config.ts` 补 `ios` 块与 `server.iosScheme: 'https'`
   （默认值是 `capacitor`，而 CSP 和鉴权都按 `https` 写的，两端必须一致）
3. ICS 插件 manifest 的 `engines.platform` 补上 `'ios'`
   （这个字段目前只校验形状、不做运行时拦截，但写着 `['android','web','windows']` 就是文档撒谎）

**还没做、且本机做不了的**：`npx cap add ios` 生成 Xcode 工程 —— 需要 macOS。
这一步留给协作的同伴，之后 `npx cap sync ios` 即可。

#### 通知桥：接口先定，各端各自实现

通知是这个项目**第一个「界面没打开也要干活」**的能力，所以它不该直接长在某个平台上。

```
插件（纯函数）→ 提醒描述                    ← 尚未定义
      ↓
NotifyScheduler（宿主，跨端共用）           ← 尚未创建
      ↓  NotifyPort  ← 平台差异到此为止     ← ✅ 已就位
      ↓
CapacitorNotifyPort（两端统一适配层）       ← ✅ 已接线，26 项断言
      ↓
packages/capacitor-notify/                ← 骨架已接线，行为「诚实地说没有」
   ├─ src/definitions.ts   过桥后的契约
   ├─ android/             Java，已编进 APK（实测 EXIT=0）
   └─ ios/                 Swift + SPM，未验证
```

**适配层做三件事**：把「同步问能力」翻译成「异步探一次再缓存」；过桥前先校验
（形状不对、超上限的**直接拒**，不是静默丢）；把原生返回值正规化
（布尔只认 `=== true`，`maxPending` 夹成非负整数）。

两条硬规则：

- **探测失败不抛错** —— 通知不可用不该让 App 启动失败，降级为「不支持」并写进 `warnings`
- **自相矛盾时以「不支持」为准** —— 说支持却 `maxPending === 0`，说明 bridge 没写完；
  让它安静地什么都不做，好过排出一批注定被丢的通知

**超上限为什么抛错而不是截断**：iOS 超 64 条系统静默丢弃，Android 不会。
悄悄截断会让两端行为分叉，用户只看到「有些提醒就是不响」，查不出来。
收窄是调度器的责任（滚动窗口），适配层只负责越界时**当场喊出来**。

**核心设计**：平台差异做成**数据**，不是分支。

```ts
capabilities(): { exact, maxPending, lostOnReboot, requiresPermission }
```

| | `exact` | `maxPending` | `lostOnReboot` |
|---|---|---|---|
| Android | 看精确闹钟权限 | 无硬上限 | **true**（闹钟重启即丢） |
| iOS | **true** | **64** | false |

调度器读这四个字段调整策略，于是**只写一遍**。那个 64 是全局约束：
滚动窗口必须按最小的上限设计。

**当前状态是「诚实地说没有」**：`Platform.notify` 是 `CapacitorNotifyPort`，
但原生骨架如实报告 `supported: false`，于是 `isSupported()` 为 false、
`schedule()` 抛错，启动时往 `warnings` 里写一条「本构建没有可用的通知桥」。
宿主**没有**把 `notify.local` 放进 `IMPLEMENTED_CAPABILITIES` ——
等各端 bridge 真能排程了再一起加。

#### 实测踩到的两个坑

**① `exports` 字段让 `cap sync` 静默漏掉插件包。**

本包的 `package.json` 写了 `"exports": { ".": "./src/index.ts" }`，
`cap sync` 就只报 3 个插件、**不报任何错**。

原因：Capacitor CLI 用 `require.resolve('<包名>/package.json', {paths:[rootDir]})`
定位插件，而 `exports` 是白名单，没列 `./package.json` 就 `ERR_PACKAGE_PATH_NOT_EXPORTED`；
CLI 外层 `try/catch` 把异常吞了。

修法：`"exports": { ".": "./src/index.ts", "./package.json": "./package.json" }`。
**验收点就是 `cap sync` 的 `Found N` 那行**，加插件前后各看一眼。

**② 子模块 `build.gradle` 里不能写 `rootProject.ext.<自己设的变量>`。**

先试的写法是 `ext { matrixCompileSdk = … }` + `android { compileSdk rootProject.ext.matrixCompileSdk }`
—— 变量设在**子项目**的 ext 上，却去**根项目**找，报
`Cannot get property 'matrixCompileSdk'`，还附带一条误导性的 `does not specify compileSdk`。

照抄 `@capacitor/preferences/android/build.gradle` 即可。

**顺带一个反直觉的结论**：担心的「workspace 软链导致 gradle 解析不到」**不存在** ——
CLI 生成的是到真实目录的相对路径（`../../../packages/capacitor-notify/android`），
软链被完全绕开。

---

## 2. 🟡 P1 —— 该做，但可以等第一个插件跑通

> 本节的内容已经并入 §1 的表格（T6 / T7 / T8 / T11 / T12 / T14 / T15）。
> 保留标题是为了让外部链接不失效；**新的任务一律登记在 §1**。

---

## 3. ⚪ 短期实验明确搁置

### 3.1 可以安全搁置的

「安全」= 能力清单里没有 + **插件也探测不到**（探测通道本来就没建）。
两条同时成立，所以搁置是「没有」而不是「假的」。

| 项 | 为什么可以搁置 | 搁置期间的补偿 |
|---|---|---|
| **`net.stream`** | 二期能力，从没进过 v1 清单 | 无（清单里本来就没有） |
| **QuickJS 沙箱** | 所有插件都是第一方、编译进应用、进程内运行；**连桩都没有** | 准入闸门是 `InProcessRuntime.load()` → 不在 `modules` 里就 `ENOTFOUND`，有测试钉着 —— **靠「不存在」而非「文档」强制** |
| **`.mtp` 包格式 + 插件 CLI** | 插件只能编译进应用 | 同上（同一道闸门） |
| **能力探测（`PlanInput.capabilities`）** | 插件根本没有提问的渠道；短期实验里只有第一方插件，它们**本来就知道**宿主有什么 | 扩展是**纯加法**：`PlanInput` 加一个可选字段，老插件一行不用改；`capabilities()` 已经说真话了，等要用时直接接上。**现在不做不影响将来做** |
| **`db.*`（5 个方法）** | 插件不需要直接碰 SQL（D3 本来就禁止） | `capabilities()` 不含 `db.namespaced` |
| **`auth.login`** | 第一个插件零网络 | 不含 `auth.login` |
| **`notify.local` / `schedule.*`** | 第一个插件不提醒 | 不含这两项；README 写明 `syncIntervalMin` **现在不触发任何东西** |
| **`fs.*`（3 个方法）** | 本地导入走 `source: 'host'`，不需要文件系统 | 不含 |
| **`llm.complete`** | 未实现，且需要新的信任模型（数据出网到模型商） | 不含 |
| **`ui.registerComponent`** | **不是「还没做」，是刻意不做** —— 原语是封闭集，插件只能组合、不能发明新控件。要新原语就是改核心 | 不含；README 里写明这是**设计决定**而非缺口 |
| **`schedule.*` / 后台同步** | `syncIntervalMin` 没有调度器执行 | 字段保留但**明说**「不触发任何东西」；同步只能由用户操作或启动触发 |
| **`trust.evalRemote` / `trust.loadModule`** | 没有远程代码加载 | 不含；`dependencies` 只做形状校验 |
| **信任记录持久化** | 短期实验里重启重装可接受 | 文档写明「重启即失」 |
| **iOS / Electron** | 原始需求的多端，但不是实验目标 | 文档写明「只有 Android + Web」 |
| **不变量 I7–I11 的 CI 守卫** | 没有 CI | 人工检查清单（见 §5） |
| **`tools/conformance` 适配器套件** | 跨包差分测试（**27 项**）已经在跑，覆盖了同类风险 | 无 |
| **`TaskStore` ↔ `DataBus` 合并** | T2 的薄封装够用 | 两套表并存，文档写明 |

### 3.2 签名校验：明确「不做」，但闸门在别处

| | |
|---|---|
| **现状** | `compiledInVerifier`（`plugin-host.ts:143`）**不做任何密码学校验**，只回答一个问题：`modules.has(manifest.id)` —— 即「这段代码在不在这个应用包里」。第一方 → `signed` |
| **真正的准入闸门** | **不是验签，是加载。** `InProcessRuntime.load()` 对不在 `modules` 里的 id 直接 `ENOTFOUND`，连 manifest 校验都到不了。差分测试有一条断言钉住这件事 |
| **所以「签名不核查」安全吗** | **在当前架构里安全** —— 能装进来的只有编译进应用的第一方代码，与宿主同权限，验不验签本来就没区别 |
| **什么时候变成不安全** | 一旦出现「从文件 / 网络装插件」的路径。那时验签与沙箱**同时**变成硬前置，不是优先级问题 |
| **硬性约束** | ① **不得分发任何第三方插件**（分发就意味着有人会去装）<br>② `signed` 这个等级名对第一方**名不副实** —— T7 做信任 UI 时必须换说法，否则徽章会骗人 |

### 3.3 一句话

搁置清单里除了「第三方准入」，其余全部满足「没有而不是假的」。

签名这件事的特殊之处在于：**我们没有假装它在工作，也没有假装它在保护。**
真正的保护是「第三方进不来」，而这条由 `InProcessRuntime` 的 `ENOTFOUND` 守着，
有测试钉着。只要这条还在，签名不做就是**没有**，不是**假的**。
一旦那条闸门被打开（`.mtp` 安装），签名与沙箱立刻从「搁置」变成「硬前置」。

---

## 4. 依赖顺序

```
T2a–c ✅ 数据持久化 ──→ A ✅ 核心实体投影 ──→ B ✅ 槽机制 ──→ C ✅ Timeline 插件
                                                    │                    │
                                                    └──→ D ✅ ICS 接槽    └──→ T14 ✅ 命令通道
                                                                                  │
T15 ✅ 课程页读 DataBus ────────────────────────────────────────────────────────┘

T6 读闸 ── 等读方有了插件身份（Timeline 现在就是，可以开始了）
T7 / T8 / T11 / T12 ── 互相独立，随时可插
T11 签名 / .mtp ── 第三方插件的一切
```

**数据与 UI 的主干已经通了。** 插件能读（投影）、能写（sync）、能互相插入（槽）、
能被点击改数据（命令），宿主界面也能看到插件的数据（课程页）。

**下一个真正的缺口是 T6（读闸）**：`DataBus.read()` 现在没有 `permissions.data.read`
检查，任何插件读任何类型都能拿到。Timeline 已经是真实的读方了，现在可以做了。

---

## 5. 人工检查清单（替代不存在的 CI 守卫）

没有 CI，这些不变量**没有测试会替你红**。当前**逐条实测**状态：

| 不变量 | 现状 | 怎么保住的 / 为什么没有 |
|---|---|---|
| **I7** 不开 `CapacitorHttp` | ✅ 成立 | `capacitor.config.ts` 里根本没有 `CapacitorHttp.enabled: true`（缺省即关闭），旁边写着为什么不能开 |
| **I8** 无 `RTCPeerConnection` / `RTCDataChannel` | ✅ 成立 | 全仓 **0 命中** |
| **I9** bootstrap 删 `eval` / `SharedArrayBuffer` | ❌ **没做** | `apps/shell/src` 里没有任何相关处理。它只在**第三方代码进来之后**才有意义 —— 沙箱搁置（§3.1）则它随之搁置，但**别在清单上打勾** |
| **I10** 原生桥单一窄入口 + 逐调用能力令牌 | 🔶 **只做了一半** | 网络出口确实只有 `dispatchFetch` 一条；但能力令牌机制随沙箱一起搁置 |
| **I11** 名字→表一律 `Object.hasOwn` / `Map` | ✅ 成立 | 内核与 shell 共 6 处 `Object.hasOwn`；`DataBus` 与注册表全用 `Map` |
| 插件数据不落 `localStorage` 明文 | ✅ 成立 | `DataBus` 纯内存；`TaskStore` 的 JSON 降级路径有加密探针与警告（`bootstrap.ts` 的 `buildWarnings()`） |

每次提交前仍要人工过一遍 —— 尤其 **I9 / I10 现在是「明确未做」，不是「已做待验证」**。
这两条只对「不可信代码」有意义，所以搁置是诚实的；但一旦沙箱或 `.mtp` 安装开始做，
它们就从「搁置」变成「硬前置」。

---

## 6. 本轮不做（留作下次讨论）

- 插件的**自动更新**与版本回滚
- 插件市场的任何形式（分发、审核、评分）
- 多设备同步
- 用户自建插件（可视化搭建）
- `net.stream` 的流式解析（大文件导入真正需要它，但第一个插件不需要）
