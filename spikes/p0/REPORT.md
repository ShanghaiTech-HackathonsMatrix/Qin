# Matrix P0 技术验证报告

> 版本：v1 · 对应 `docs/design/DESIGN.md` v0.3
> 运行环境：Windows / Node 24.22.0 / SQLite 3.53.4（`node:sqlite`）/ quickjs-emscripten 0.32.0
> 复现：`cd spikes/p0 && npm install && npm test`（55 条断言，全绿）

---

## 0. 结论摘要

三个 P0 验证里，**两个按预期通过，一个推翻了原设计**。

| 编号 | 验证项 | 结论 | 对设计的影响 |
|---|---|---|---|
| **S1** | SQLite 生成列 / 索引 / 查询 DSL 编译 | ✅ 通过（23 条） | 主方案成立；退路方案也已实证，风险清零 |
| **S2** | 移动端 UI 层零网络 + `connect-src 'none'` | ✅ 静态通过（10 条） | 可行，但新增 3 条硬约束 |
| **S4** | QuickJS 沙箱边界 | ✅ 通过（12 条） | 边界真实，但**暴露出 1 个未记录的残留面** |
| **S4-异步** | 插件侧 `await` 宿主 RPC | ❌ **证伪** | **推翻 §5.5 RPC 协议，改为纯函数模型** |

**最重要的一条**：原设计里「插件通过 `ctx.net.request()` 自己发起异步请求」这条路走不通。
quickjs-emscripten 的 asyncify 机制无法可靠支撑「顺序 await 多次宿主调用」。
因此插件运行时改为**纯函数模型**（S4b，10/10 通过）：

> 沙箱内**不存在任何异步宿主 API**。插件是纯函数：宿主把数据当普通 JSON 传进去，
> 插件算完返回普通 JSON。所有 IO（网络/数据库/凭证）由宿主在沙箱外代跑。
> 多步流程用「插件返回下一步指令 → 宿主执行 → 再调插件一次」的状态机表达。

这个改动**降低了复杂度**而不是提高：插件变成可单测的纯函数，asyncify 相关的整类风险消失。

---

## 1. S1 —— SQLite 与查询 DSL

### 1.1 验证内容

`spikes/p0/src/s1-query-compiler.test.ts`，23 条断言。

实现了一个宿主侧查询编译器：插件的查询 DSL（`{ and: [{field:'dueAt', gte: 2000}, ...] }`）
编译成**全参数化 SQL**，并在真实 SQLite 上验证。

### 1.2 结果

**A. 主方案（JSON 文档 + 生成列 + 索引）成立**

```sql
CREATE TABLE plugin_app_matrix_timeline_task (
  id TEXT PRIMARY KEY,
  doc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  due_at INTEGER GENERATED ALWAYS AS (json_extract(doc, '$.dueAt')) VIRTUAL,
  ...
);
CREATE INDEX ix_app_matrix_timeline_task_due_at ON plugin_app_matrix_timeline_task(due_at);
```

`EXPLAIN QUERY PLAN` 确认命中索引：
```
SEARCH plugin_app_matrix_timeline_task USING INDEX ix_app_matrix_timeline_task_due_at (due_at>?)
```

**B. 退路方案（影子索引表 + 触发器）与主方案结果完全一致**

这一点是本轮最有价值的 S1 产出。原设计把「生成列不被支持」列为风险，
现在的处理是：**不等真机结论，直接证明退路可用**。

影子表方案：主表只存 `doc`，索引列放独立表，由 `AFTER INSERT/UPDATE/DELETE` 触发器维护，
查询走 `JOIN`。测试断言两种策略在 5 组查询上返回**完全相同**的行集合，且同样命中索引。

→ 即使 sqlcipher-android 4.17.0 的内嵌 SQLite 不支持生成列，S1 也不阻塞，只需切换策略。
（生成列需 SQLite ≥ 3.31，partial index ≥ 3.8，FTS5 ≥ 3.9；4.17.0 是 2025 年版本，几乎必然满足。）

**C. 注入与越界全部被拒（9 条）**

| 攻击 | 结果 |
|---|---|
| 集合名 `task; DROP TABLE event--` | EPERM |
| 字段名 `dueAt) OR 1=1 --` | EPERM |
| 排序方向 `asc; DROP TABLE event` | ESCHEMA |
| 对象/数组参数 | ESCHEMA |
| `IN` 子句 501 项 | EQUOTA |
| 未知算子 | ESCHEMA |
| 排序字段 `doc`（未声明） | EPERM |

并断言**编译出的 SQL 文本里不含任何字面量** —— 载荷只可能出现在 `params` 里。

**D. `LIKE` 元字符转义**

`contains` 算子把 `%` `_` `\` 转义并加 `ESCAPE '\'`。
不加这一步，插件可以用 `contains: '%'` 做全表扫描式探测。

### 1.3 抓到的真实 bug：原型污染

测试最初**没有**拦住 `{ field: '__proto__', eq: 1 }`。原因：

```ts
spec.fields['__proto__']   // → Object.prototype（真值！）
spec.fields['constructor'] // → Function（同样是真值）
```

朴素的白名单写法 `if (!spec.fields[field]) throw` 会被直接绕过 —— `Object.prototype` 是真值。
这印证了 DESIGN.md §11 里那条关于原型污染的警告不是理论担忧。

**修正**（已写进实现）：
1. 字段表一律用 `Object.create(null)` 归一化；
2. 判定必须用 `Object.hasOwn(spec.fields, field)`，不能只做真值判断。

> 这条要作为**规范**推广到所有「按名字查表」的地方：插件声明的字段名、权限名、
> 集合名、方法名、i18n key、资源类型 —— 只要是从插件输入到宿主查找表的路径，
> 都必须 `Object.hasOwn` / `Map`，禁止裸 `obj[key]` 真值判断。

---

## 2. S2 —— 移动端桥接与 CSP

### 2.1 为什么只能做静态审查

本机**没有 Android SDK、没有 gradle**（已确认），无法构建 APK 或做真机动态验证。
因此 S2 的结论全部建立在**可复查的源码证据**上，并明确标注了哪些必须真机确认。

`spikes/p0/src/s2-inspect-bridge.ts`，10 条断言，每条都指向具体文件与代码事实。

### 2.2 核心结论：`connect-src 'none'` 可行

**证据链：**

1. **`@capacitor/core` 的 JS 产物不使用任何网络 API。**
   对 `dist/*.js` 全文检索 `XMLHttpRequest` / `WebSocket` / `sendBeacon` / `EventSource` ——
   **零命中**。

2. **插件调用走的是原生桥，不是网络请求。**
   `registerPlugin` 内部通过 `cap.nativePromise(...)` / `cap.nativeCallback(...)` 分发，
   Android 侧是 `androidBridge`（`@JavascriptInterface`），iOS 侧是
   `webkit.messageHandlers.bridge`（`WKScriptMessageHandler`）。
   两者都不是 HTTP 请求，**不受 CSP `connect-src` 约束**。

3. **`CapacitorHttp` 是唯一的网络旁路，且默认关闭。**
   `CapacitorHttp.java`：
   ```java
   public boolean isEnabled() {
     PluginConfig pluginConfig = getBridge().getConfig().getPluginConfiguration("CapacitorHttp");
     return pluginConfig.getBoolean("enabled", false);   // ← 默认 false
   }
   ```

**因此 CSP 建议：**

```
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';   /* 布局/主题需要内联样式 */
img-src 'self' data: blob:;         /* 远端图片一律由核心代理成 blob: */
font-src 'self';
connect-src 'none';                 /* ← 可行 */
frame-src 'self' blob:';            /* 第三方 UI：不透明源 iframe + srcdoc */
worker-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
frame-ancestors 'none';
```

### 2.3 新增的三条硬约束

**约束 1：`plugins.CapacitorHttp.enabled` 必须永远保持 `false`。**

一旦打开，`window.fetch` / `XMLHttpRequest` 会被补丁成走原生 HTTP，
而**原生 HTTP 不受 WebView CSP 约束** —— `connect-src 'none'` 当场失效。
这条要写进架构不变量，并在 CI 里对 `capacitor.config.*` 做断言。

**约束 2：不透明源 iframe **不是**对原生桥的隔离边界。**

Android 的 `addJavascriptInterface` 会把对象注入 WebView 中**所有 frame**（含 iframe）。
第三方插件 UI 即使跑在 `sandbox="allow-scripts"`（无 `allow-same-origin`）的 iframe 里，
也可能直接够到原生桥。

→ 原生桥**只能暴露一个窄入口**，且授权**不能靠 frame 来源判定**（拿不到可靠来源），
必须靠「每次调用携带的能力令牌」。令牌由受信父框架按次下发，iframe 永远拿不到长期令牌。

**约束 3：应用跑在 `https://localhost` 这个「假源」上。**

`CapConfig` 默认 `hostname = "localhost"`、`androidScheme = "https"`，
本地资源由 `WebViewLocalServer.shouldInterceptRequest` 拦截返回。
**不匹配的请求返回 `null`，交给系统网络栈** —— 这正是外域 `<img>`、CSS `url()`、
字体、`@import` 的逃逸路径，必须靠 CSP 收口（`img-src 'self' data: blob:`）。

### 2.4 旁证：Capacitor 自己在防同一类攻击

`WebViewLocalServer.java` 里有一段：

```java
if (null != loadingUrl.getPath() && loadingUrl.getPath().startsWith(Bridge.CAPACITOR_HTTP_INTERCEPTOR_START)) {
    // Only fetch/XHR should reach the proxy; a document would run remote content at the app origin.
    boolean httpEnabled = ...;
    if (!httpEnabled || isDocumentRequest(request)) {
        return null;
    }
```

注释原文 *"a document would run remote content at the app origin"* —— 这正是
「远端内容在应用源下执行 = 完全 XSS」这一类威胁。Capacitor 独立地做了同样的防御。
这为我们的「第三方 UI 必须放不透明源 iframe」提供了来自上游的独立印证。

### 2.5 SQLCipher

`@capacitor-community/sqlite` 的 `android/build.gradle`：

```
implementation 'net.zetetic:sqlcipher-android:4.17.0@aar'   ← 真 SQLCipher
implementation "androidx.sqlite:sqlite:2.4.0"
implementation 'androidx.room:room-runtime:2.6.1'
minSdkVersion ... : 24
compileSdk = ... : 36
```

✅ Android 侧确认使用真正的 SQLCipher（非 Android 平台自带的加密缺失版本）。

❗ **未能离线确定 4.17.0 内嵌的 SQLite 版本号。** 必须在真机上跑一次
`PRAGMA compile_options;` / `SELECT sqlite_version();` 确认生成列支持。
**此项不阻塞** —— S1 已证明影子索引退路可用。

---

## 3. S4 —— QuickJS 沙箱

### 3.1 边界是真的（这是最重要的正面结论）

`spikes/p0/src/s4-sandbox.test.ts`，12 条断言。在沙箱里枚举 `globalThis` 的全部自有属性：

```
AggregateError, Array, ArrayBuffer, BigInt, BigInt64Array, BigUint64Array, Boolean,
DataView, Date, Error, EvalError, FinalizationRegistry, Float16Array, Float32Array,
Float64Array, Function, Infinity, Int16Array, Int32Array, Int8Array, InternalError,
Iterator, JSON, Map, Math, NaN, Number, Object, Promise, Proxy, RangeError,
ReferenceError, Reflect, RegExp, Set, SharedArrayBuffer, String, Symbol, SyntaxError,
TypeError, URIError, Uint16Array, Uint32Array, Uint8Array, Uint8ClampedArray, WeakMap,
WeakRef, WeakSet, decodeURI, decodeURIComponent, encodeURI, encodeURIComponent,
escape, eval, globalThis, isFinite, isNaN, parseFloat, parseInt, undefined, unescape
```

**纯 ECMAScript 内建，一个宿主对象都没有。** 逐项验证：

| 探测 | 结果 |
|---|---|
| `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `importScripts` | `undefined` |
| `require` / `process` / `module` | `undefined` |
| `document` / `window` / `navigator` / `location` | `undefined` |
| `localStorage` / `indexedDB` | `undefined` |
| `WebAssembly` | `undefined` |
| `setTimeout` / `setInterval` / `queueMicrotask` | `undefined` |
| `(function(){}).constructor('return typeof fetch')()` | `'undefined'` |
| `(function(){}).constructor('return typeof process')()` | `'undefined'` |
| 动态 `import('node:fs')` | 失败 |

`Function` 构造器存在，但**作用域内没有任何宿主能力可取回** —— 这是沙箱设计的正确形态。

资源熔断同样验证通过：
- `shouldInterruptAfterDeadline(Date.now() + 200)` → 死循环在 204ms 被中断
- `setMemoryLimit(8MB)` → 内存爆炸被拦住

### 3.2 发现的残留面（需收窄）

**残留 1：`SharedArrayBuffer` 是存在的（`typeof === 'function'`）。**
`Atomics` 不在全局列表里，所以实际危害有限，但**应在 bootstrap 里显式删除**。

**残留 2：`eval` 存在。**
当前作用域内无宿主对象，所以取不到东西；但按最小权限原则，**应显式删除**。

**残留 3：`WebRTC`（`RTCPeerConnection`）不受 CSP 约束。**
这条是 S2 的推论 —— 若宿主 UI 层残留该构造器，它可绕过 `connect-src 'none'`。
沙箱内已确认不存在（QuickJS 无此内建），但**渲染层必须显式删除**。

### 3.3 抓到的真实 bug：JSON 对象字面量不能直接求值

我自己在 `docs/design/sandbox-sketch.ts` 里写的 `ctxNewJson` 有 bug：

```ts
// ❌ 错误
ctx.evalCode(JSON.stringify(value ?? null))
```

`evalCode('{"a":1}')` 会把 `{...}` 当作**块语句**解析，
块里的 `"a":` 不是合法标签 → 报 `expecting ';'`。
数组 `[1,2]`、数字、字符串、`null` 在语句位置是合法的，**只有 `{...}` 会踩这个坑**。

```ts
// ✅ 修正
ctx.evalCode(`(${JSON.stringify(value ?? null)})`)
```

已修回设计稿。

---

## 4. S4-异步 —— 被推翻的那条路（本轮最重要的发现）

### 4.1 现象

原设计 §5.5 的 RPC 协议是：插件侧 `await ctx.net.request(...)`，宿主用
`ctx.newAsyncifiedFunction` 提供异步实现，`evalCodeAsync` 驱动。

实测（quickjs-emscripten 0.32.0 / `@jitl/quickjs-wasmfile-release-asyncify`）：

| 调用形态 | 结果 |
|---|---|
| 顶层直接调用 asyncified 函数 | ✅ 可用 |
| `Promise.all([rpc(a), rpc(b)])` 同一 tick 并发 | ✅ 可用 |
| **顺序 `await rpc(a); await rpc(b);`** | ❌ **必崩** |

崩溃表现为 `memory access out of bounds` / `null function or function signature mismatch`。
而且**审计轨迹显示两次 RPC 在宿主侧都真的执行了** —— 崩在「恢复之后再次挂起」这一步。

### 4.2 根因

`evalCodeAsync` 能驱动「同一 tick 内发起的多个 asyncify 挂起」，
但**无法处理「恢复之后再次挂起」**。

更麻烦的是下面这条：

### 4.3 asyncify 状态是 WASM 模块实例级的全局状态

```
runtime A：同步 evalCode 碰到 asyncified 函数 → 打坏
runtime B：同一模块实例下的全新 runtime，只用 async 路径 → 同样报废
           报 "Already suspended at: QuickJSAsyncifySuspended"
新模块实例：✅ 完全恢复
```

**一个 runtime 打坏，同一模块实例下所有 runtime 连坐。** 这是设计上必须正面处理的约束。

### 4.4 其他踩到的坑

| 坑 | 现象 | 纪律 |
|---|---|---|
| `ctx.resolvePromise()` | 即使 promise 已 settle 也**挂死** | 不要用 |
| 求值结果返回 pending promise | 宿主 `dump` 后 `dispose` 它 → 后续回调踩空，`Lifetime not alive` | 求值结果必须是 `undefined` |
| 宿主回调里用 `evalCode` 造返回值 | 会重入 asyncify | 只能用 `newObject`/`newString`/`newNumber` 拼 |
| 宿主回调里 `await` 后再 `dump` 参数 handle | handle 可能已失效 | 参数必须在第一个 `await` 前取完 |
| 异常状态下 `dispose()` | 触发 WASM abort（`gc_obj_list` / `ref_count` 断言） | **可被 try/catch 捕获，进程存活**，但模块实例已污染，必须整块丢弃 |
| `ctx.callFunction` 返回值 | 是 `DisposableSuccess`（Either），不是 handle | 必须 `.unwrap()` |

### 4.5 决定：改用纯函数模型

`spikes/p0/src/s4b-sync-runtime.test.ts`，**10/10 通过**，含「连续 50 次调用稳定」。

```
┌─────────────── 宿主（受信）────────────────┐
│  1. 按插件的「请求计划」发起网络/DB 操作     │
│  2. 把结果当普通 JSON 传进沙箱               │
│  3. 同步调用插件导出的纯函数                 │
│  4. 取回普通 JSON，落库                      │
└─────────────────────────────────────────────┘
                    ↓ 只有 JSON 跨越边界
┌─────────────── 沙箱（不受信）──────────────┐
│  plugin.plan(input)      → { requests: [...] }        │
│  plugin.parseTasks(input) → { items: [...] }          │
│  没有 Promise，没有 await，没有异步宿主 API            │
└─────────────────────────────────────────────────────────┘
```

多步流程（fetch → parse → 再 fetch）用**状态机**表达：
插件返回 `{ requests: [...], next: 'parseDetail' }`，宿主执行后带着结果再调一次。
这是沙箱化不可信代码的标准做法，且让插件完全可单测。

**带来的简化：**
- 用**同步** `newQuickJSWASMModule` + `newFunction`，彻底不碰 asyncify
- 整类 WASM 崩溃风险消失
- 插件是纯函数 → 确定性、易测试、易版本化
- 与既有决策天然一致：**网络出口唯一**（原来说 UI 层零网络，现在插件层也零网络）

**代价（诚实说明）：**
- 插件不能表达「边解析边决定下一次请求」的复杂控制流，必须显式拆成状态机的多个步骤。
  对课程/DDL/Quiz 这类连接器足够了，但如果将来要做真正的交互式爬虫，需要重新评估。
- 每次跨边界都是一次 JSON 序列化，大文档（如整页 HTML）会有拷贝开销。
  缓解：解析在沙箱内做，跨边界的只是提取后的小结果。

---

## 5. S5 —— 插件网络请求的形态（定量回答「声明式够不够用」）

**为什么要做这个 spike。** D8 把插件改成纯函数 + 声明式请求后，§5.5 诚实地记了两个代价：
插件无法表达「边解析边决定下一次请求」的隐式控制流；每次跨边界都要序列化，大文档有拷贝开销。
但这两个代价**有多大、能不能规避**，当时只有定性判断。这一节把「纸面取舍」变成「实测数字」。

**运行**：`node src/s5-request-shape.test.ts`（8 项断言全过）

### 5.1 A —— 同步流式回调可行（本 spike 最重要的正面结论）

S4 崩掉的是 **asyncified** 调用 —— 沙箱内 `await` 导致挂起，asyncify 状态是 WASM 模块实例级的。
而**同步**回调走的是一次普通 `ctx.callFunction`，**完全不碰 asyncify**。实测：

| 断言 | 结果 |
|---|---|
| 宿主连续调用沙箱内同步回调 **3000 次** | ✅ 不崩，结果正确 |
| 早期中止真的生效 | ✅ 第 1 块就判定出 HTML，只处理了 1 块 |
| 沙箱内闭包状态跨调用存活 | ✅ VM 是持久的，状态不必每步重传 |
| 大量同步回调之后，同模块内其他 VM 仍正常 | ✅ 无全局污染 |

**结论**：`onChunk(chunk) → decision` 这种**同步**流式回调是安全的，
可以在不重新引入 asyncify 的前提下拿回「增量处理」与「提前中止」。
**硬性约束：回调必须是同步的。** 一旦允许回调里 `await`，立刻回到 S4 的崩溃。

### 5.2 B —— 编组开销（决定分块大小与编组方式）

| 项目 | 实测 |
|---|---|
| 固定调用开销（空载荷） | **≈ 16 µs/次**（约 63,000 次/秒） |
| 1 MiB 载荷，`evalCode(JSON 字面量)` | 12.7 ms → **15.4 MB/s** |
| 1 MiB 载荷，`newString` + 沙箱内 `JSON.parse` | 3.6 ms → **54.9 MB/s** |
| 两者差距 | **3.56×** |

吞吐随载荷上升并饱和（固定开销被摊薄后稳定在 ~185 MB/s）：

| 载荷 | 每次调用耗时 | 吞吐 |
|---|---|---|
| 0 KiB | 8.6 µs | — |
| 1 KiB | 13.4 µs | 72.9 MB/s |
| 64 KiB | 348.8 µs | 179.2 MB/s |
| 512 KiB | 2.70 ms | 185.3 MB/s |
| 2048 KiB | 10.68 ms | 187.3 MB/s |

**结论**：
1. **大载荷必须用 `newString` + 沙箱内 `JSON.parse`，不要用 `evalCode('(' + JSON + ')')`。**
   差 3.56× —— 原因是前者把 JSON 当 **JS 字面量**解析（走 JS 语法分析器），后者走高度优化的 `JSON.parse`。
2. 「把整页 HTML 传进沙箱」完全可行：1 MiB 只要 3.6 ms，对一次网络请求而言是噪声。
3. 分块不宜过细：每块至少 64 KiB，否则固定开销（16 µs）会主导。

### 5.3 C —— 状态机是 O(n²)（**这条推翻了 §5.5 的一句指导**）

§5.5 原话是：「每次跨边界都是一次 JSON 序列化，**大文档（整页 HTML）**有拷贝开销」。
实测表明真正的问题不在大文档，而在**累积状态每步往返**：

| 步数 | 状态跨边界（朴素写法） | 状态留沙箱 | 差距 |
|---|---|---|---|
| 20 步 | 95.8 µs/步（合计 1.9 ms） | 20.2 µs/步（合计 0.4 ms） | 4.7× |
| 100 步 | 304.7 µs/步（合计 30.5 ms） | 22.1 µs/步（合计 2.2 ms） | 13.8× |
| 400 步 | 1.04 ms/步（合计 415.7 ms） | 19.0 µs/步（合计 7.6 ms） | **54.7×** |

「跨边界」那列的**单步**耗时随 N 线性上升 —— 合计即 O(n²)。而「留沙箱」那列恒定在 ~20 µs/步。

**修正后的指导**：
- 声明式状态机**不要**把累积状态每步传进传出，否则 O(n²)。
- 沙箱内的模块级/闭包状态在多次调用间**是存活的**（5.1 已证），
  所以正确做法是**累积状态留在沙箱内，每步只传增量与摘要**。
- 这一条必须写进插件 API 的契约里，否则插件作者会用朴素写法，然后在几百步时莫名其妙变慢。

### 5.4 对「暴露原 Response」的判断

同一批数据可以回答另一个问题：如果放开权限，让插件「注入函数到 request 处理器」并
「接触原 Response」，代价如何？

| 提案 | 判断 | 依据 |
|---|---|---|
| 允许插件注入**同步**回调到 request 处理器 | ✅ **可行且值得做** | 5.1：同步回调不走 asyncify，3000 次稳定；开销仅 16 µs/块；拿回增量与早停 |
| 允许插件**接触原 Response 对象** | ❌ **不建议** | QuickJS 是独立解释器，宿主对象进不去。要「接触」只能包成代理，每个属性访问都变成宿主函数调用（~16 µs/次），`.body.getReader()` 之类基本不可用。更严重的是边界从**纯数据**退化成**代理对象图** —— 任何一处泄漏（方法返回 `this`、异常携带宿主对象、原型链可达）都是越界。收益 ≈ 0（数据一样），代价是安全模型从「结构性不可能」退化为「靠实现正确」 |

**一句话**：把最干净的数据边界换成最脏的对象边界，换来的只是「语法更顺手」。不值得。

### 5.5 建议写入设计的四条

1. **默认保持声明式**（D8 不变），它覆盖连接器的绝大多数需求。
2. **新增一个独立权限项 `net.stream`**：授予后插件可注册**同步**的
   `onChunk(chunk) → { stop, next? }` 回调，由宿主驱动循环。拿回增量处理与提前中止。
   不授予则退化为当前的「整包交给插件」。**回调必须同步**是硬约束，要写进契约。
3. **绝不把宿主对象暴露进沙箱**（Response / Headers / AbortController 一律不给）。
4. **修正 §5.5 的两处表述**：
   - 状态机指导：累积状态留沙箱内，只传增量/摘要（否则 O(n²)，400 步时差 55×）。
   - 编组规范：大 body 用 `newString` + 沙箱内 `JSON.parse`（比 `evalCode(JSON 字面量)` 快 3.56×）。

### 5.6 这个 spike 的边界（如实说明）

- 数据来自 **Node 24 + quickjs-emscripten（桌面 CPU）**，不是 Android WebView。
  同一份 WASM，**相对比例应当成立**，绝对数字在手机上会更差。
- 未测：真机上的分块网络流（`CapacitorHttp` 不暴露 body 流，见 §8.1 —— 所以 `net.stream`
  若要落地，分块得由**宿主**在拿到完整响应后切分，而不是真正的网络流式）。
  这一点很重要：`net.stream` 给的是**解析**层面的增量，不是**传输**层面的增量。
  真正的传输层流式需要换掉 `CapacitorHttp`，属于「必须自写原生」的范畴。

---

## 6. 对 DESIGN.md 的具体修改

| 位置 | 修改 |
|---|---|
| §0 决策表 | 新增 **D8**（插件纯函数化，沙箱内无异步宿主 API）、**D9**（一个插件 VM 独占一个 WASM 模块实例） |
| §0 决策表 | 修订 **D2**：网络出口唯一 —— 不仅 UI 层零网络，**插件层也零网络**，插件只能「声明请求」 |
| §5.5 RPC 协议 | **重写**为「声明式请求计划 + 纯函数解析 + 状态机多步」 |
| §5.8（新增） | QuickJS 硬性纪律 R1–R6 |
| §7.4 | 补充：原生桥只能有窄入口；授权靠能力令牌，不靠 frame 来源 |
| §11 安全 | 新增架构不变量：`CapacitorHttp.enabled` 永远 false；bootstrap 显式删除 `eval`/`SharedArrayBuffer`；渲染层删除 `RTCPeerConnection` |
| §11 安全 | 新增规范：所有「按名字查表」必须 `Object.hasOwn`/`Map` |
| §13 P0 表 | 填入 S1/S2/S4 结论 |
| 附录 A | 更新版本事实与「仍待验证」 |

`docs/design/sandbox-sketch.ts` 已同步修正（`ctxNewJson` 括号 bug、`callPlugin` 重写、
新增 `poisoned` 标志与 R1–R6 注释）。

---

## 7. 仍未验证 / 残余风险

| 项 | 状态 | 缓解 |
|---|---|---|
| sqlcipher-android 4.17.0 内嵌 SQLite 版本与编译选项 | ❗ 需真机 `PRAGMA compile_options` | 影子索引退路已实证 |
| Capacitor 桥接在真机上的实际 CSP 行为 | ❗ 需真机验证 | 源码证据链完整 |
| Android `addJavascriptInterface` 对 iframe 的实际可见性 | ❗ 需真机验证 | 已按「可能可见」设计（能力令牌） |
| iOS WKWebView 的对应行为 | ❗ 完全未验证（无 macOS） | 同上 |
| 微信 Windows 4.x 本地库解密 | ❗ 未验证（需抓进程内存） | 降级为手动分享 |
| `NotificationListenerService` 手写原生代码 | ❗ 未开始 | 无可用插件，必须自研 |
| 上海科技大学各平台无公开 API | ❗ 已确认无 API | 连接器必须按「会坏」设计 |
| 第三方 UI 的 `postMessage` 通道完整性 | ❗ 未验证 | 需在 P1 做协议 fuzzing |
| 桌面端 `utilityProcess` + `safeStorage` | ❗ 未验证 | Electron 44 文档确认存在 |

---

## 8. 复现方式

```powershell
cd spikes/p0
npm install
npm test
```

单跑：

| 命令 | 内容 | 断言数 |
|---|---|---|
| `npm run s1` | 查询 DSL → 参数化 SQL、索引命中、注入拒绝、原型污染 | 23 |
| `npm run s2` | Capacitor 桥接/CSP/SQLCipher 源码审查 | 10 |
| `npm run s4` | QuickJS 沙箱逃逸面、资源熔断、两个已知陷阱 | 12 |
| `npm run s4b` | 同步纯函数插件模型（推荐基座） | 10 |

依赖：`quickjs-emscripten@0.32.0`、`@capacitor/core@^8`、`@capacitor/android@^8`、
`@capacitor-community/sqlite@^8.1.1`。Node 24 原生类型擦除直接跑 `.ts`，无需构建步骤。

---

## 9. 下一步建议

1. **按纯函数模型重写 §5.5**，并据此定稿 `api-v1.d.ts`（去掉 `PluginContext` 上的异步网络方法，
   改为 `plan()` / `parse()` 契约）。
2. **搭 P0 可运行骨架**：monorepo + 原生 `CorePlugin` Kotlin 骨架 + `core-client` + `web` adapter
   + 一个能跑的 Timeline。
3. **补 S3**：SQLCipher 密钥在 Android Keystore 的往返（需真机）。
4. **在 CI 加两条守卫**：`capacitor.config.*` 里 `CapacitorHttp.enabled` 必须为 false；
   渲染层代码不得出现 `RTCPeerConnection`。
