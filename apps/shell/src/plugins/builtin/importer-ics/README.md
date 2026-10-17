# `app.matrix.importer.ics` —— ICS 课表导入（第一方插件）

第一个**真实**的第一方插件。它的用途不只是「把 .ics 导进来」，更是**反向验证插件 API v1 是否够用**
（DESIGN §15.2 记的六个缺口就是写它之前撞出来的）。

## 它证明的事

```
宿主读文件 → 宿主递文档（source: 'host'）→ 插件纯函数解析 → 宿主落库 → 视图订阅重渲染
```

插件这一侧**零 IO**：不读文件、不读时钟、不碰网络、不认识 `PluginHost`。
这是 D8「插件是纯函数、宿主代跑一切 IO」的完整闭环。

## 目录

| 文件 | 职责 |
|---|---|
| `manifest.ts` | manifest + `course` / `session` 的实体 schema |
| `parse-ics.ts` | iCalendar 解析，**纯函数**（零 IO / 零时钟 / 零 `Intl`） |
| `index.ts` | 契约导出面：`plan` / `parsers` |
| `IcsImportView.tsx` | 宿主侧只读视图（当前硬编码挂在 `DebugPanel`） |
| `conformance.test.ts` | 22 项验收断言 |

## 跑测试

```bash
cd apps/shell
node src/plugins/builtin/importer-ics/conformance.test.ts
```

## 已知限制（都是刻意的，不是没做完）

1. **数据在内存里**。DataBus 尚未接存储层，重启即失。`bootstrap()` 会把这条写进 `warnings`。
2. **`RRULE` 不展开**。周期课只有首节，原始规则原样存进 `rrule` 字段。展开（含 `EXDATE` /
   `RECURRENCE-ID` 例外）属于 timetable 插件的事 —— 放在导入器里会让「周期语义归谁」永久含混。
3. **只支持固定 UTC 偏移**，不处理夏令时。`TZID` 原样保留进 `tzid` 字段但不参与换算。
   默认 `+8`（中国无夏令时，因此是**精确**的而非近似）。
   为什么不直接用 `Intl`：插件将来要搬进 QuickJS 沙箱，那里没有时区数据库 ——
   现在图方便，沙箱化那天就会静默算错时间。
4. **`course` / `session` 是暂借的全局类型名**。DataBus 只按插件隔离**记录键**，不隔离**类型名**。
   等 Timeline 落地、核心表出现时，这两个名字需要收敛。
5. **UI 是硬编码挂载的**。宿主没有组件注册表（`contributes.views` 会被解析但不渲染），
   所以 `IcsImportView` 由 `DebugPanel` 直接 import。等布局引擎落地，改的是挂载方式。
6. **manifest 是 `.ts` 对象而非 `manifest.json`**。现阶段没有打包步骤，`install()` 吃的就是这个对象。
   等 `tools/plugin-cli` 能打 `.mtp` 时由它序列化 —— 两份并存必然漂移，所以现在只留一份。

## 写这个插件时撞到的两处契约别扭（已记，未改）

- **`settings` 只到 `plan()`，不到 `parsers()`**。`PlanInput` 有 `settings`，`ParseInput` 只有
  `body` / `status` / `baseUrl`。但解析器确实需要「用户选了哪门课」「UTC 偏移多少」。
  当前用**模块作用域**转交（`index.ts` 的 `pendingSettings`）—— 这是契约明确允许的写法
  （§6 的纪律就是「状态留在插件模块作用域」），但第一次写插件的人会在这里愣一下。
- **`method` 对本地文档没有意义**，却仍必须填 `GET` 或 `POST`。`source: 'host'` 的请求
  根本不出网，`method` / `headers` / `body` 全是死字段。为了让 `validateRequests` 保持单一规则，
  没有给本地请求开特例 —— 这是有意的取舍（一个校验函数比两个好），但契约里可以写得更明白。
