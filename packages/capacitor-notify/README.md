# `@matrix/capacitor-notify` 通知桥

Android 已实现本地闹钟与通知，宿主通过 `CapacitorNotifyPort` 探测和调用。Web 与 iOS 仍明确返回不支持。

## Android 行为

- Android 13+ 通过用户操作请求通知权限；Android 8+ 创建课程与作业通知渠道。
- 同 ID 覆盖、按 ID 取消、取消全部、查询 pending；应用私有 SharedPreferences 保存待提醒内容。
- 有精确权限时用 `setExactAndAllowWhileIdle`，否则用 `setAndAllowWhileIdle`，如实报告 `exact=false`。
- 最多 400 条。先整批校验再调用系统；系统 API 无事务，失败尽力恢复旧排程，恢复异常随失败返回。
- 开机、应用更新、时区/时间变化后重排未来提醒。`lostOnReboot=false` 表示 receiver 会恢复。
- `pending` 校验对应 PendingIntent 是否仍存在；Android 未向应用开放完整闹钟查询 API。
- 点击通知通过不透明 payload 回宿主；可选 `consumeTap()` 消费一次。
- 渠道关闭、省电限制或强行停止仍可能阻止通知；重新启动宿主会对账重排。

## 使用边界

学业插件只产生普通事件，宿主 `AcademicService` 将事件转为提醒并选择最近 400 条。没有开放通用插件 `notify.local` RPC，没有后台自动联网同步。排程失败须显示错误。

## 验证状态

2026-10-17：接口与适配层测试、全仓类型检查、Android Java 编译通过。vivo V2352A 真机已验证用户授予通知权限、约 15 秒测试通知实际显示、同 ID 覆盖、取消及 pending 对账；从通知栏点击通知可返回“课表作业”。开机恢复及长期后台触发尚未实测。iOS 未实现、未在 Xcode 验证。

## 5. 已踩过的坑（别再踩）

### 5.1 `exports` 字段会让 `cap sync` 看不见这个包

本包最初写的是：

```json
"exports": { ".": "./src/index.ts" }
```

`cap sync` 立刻只报 3 个插件 —— **因为它静默地没认出本包**。

原因：Capacitor CLI 用 `require.resolve('<包名>/package.json', { paths: [rootDir] })`
定位插件，而 `exports` 一旦存在就成了白名单，`./package.json` 不在里面就报
`ERR_PACKAGE_PATH_NOT_EXPORTED`。CLI 外层是 `try { … } catch { /* ignore */ }`，
所以**什么错都不报**，只是少了一个插件。

修法：显式导出它。

```json
"exports": { ".": "./src/index.ts", "./package.json": "./package.json" }
```

**教训**：`cap sync` 的插件数是最便宜的验收点。加插件前后各看一眼 `Found N`。

### 5.2 workspace 软链不是问题，`ext` 作用域才是

担心过「npm 把 workspace 包软链到根 `node_modules`，gradle 会不会解析不到」。
实测：CLI 生成的是到真实目录的相对路径 ——

```gradle
project(':matrix-capacitor-notify').projectDir = new File('../../../packages/capacitor-notify/android')
```

软链完全绕开了，没有问题。

真正踩到的是另一件事：在子模块 `build.gradle` 里写

```gradle
ext { matrixCompileSdk = … }          // 设在**子项目**的 ext 上
android { compileSdk rootProject.ext.matrixCompileSdk }   // 去**根项目**找 → 不存在
```

报错是 `Cannot get property 'matrixCompileSdk' on extra properties extension`，
紧接着还有一条误导性的 `does not specify compileSdk`。

**照抄 `@capacitor/preferences/android/build.gradle` 就好**，别自己发明变量名。

---

## 6. 不要做的事

- **不要**在 `isSupported()` 里返回 `true` 但方法实际抛错 —— 宿主会据此宣称支持 `notify.local`
- **不要**在 `schedule()` 里静默跳过坏数据 —— 用 `lintNotifications()` 先过一遍
- **不要**在 `definitions.ts` 里加平台名或平台分支 —— 契约是两边共同的，出现平台名就说明抽象漏了
- **不要**让 `web.ts` 假装能用浏览器的 `Notification` API —— 它只在页面活着时可靠，
  和「App 关着也要响」是两回事
- **不要**在权限声明里写「将来可能用到」的项 —— 那是假开关
