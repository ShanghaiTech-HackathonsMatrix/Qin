# `@matrix/capacitor-notify` —— 通知桥

> **状态：接口与骨架已就位，行为「诚实地说没有」。**
> 宿主侧 `Platform.notify` 仍然是 `UnsupportedNotifyPort`，
> 各方法要么如实报 `unsupported`，要么直接抛错。**没有任何通知会被排上，也没有假装排上。**

---

## 1. 当前进度（已实测 / 未验证 分开写）

| 项 | 状态 | 证据 |
|---|---|---|
| `apps/shell/src/core/notify/port.ts`（`NotifyPort`） | ✅ 已就位 | `notify.test.ts` 26 项断言 |
| `UnsupportedNotifyPort`（诚实降级） | ✅ 已就位 | 同上，`schedule()` 抛错有测试 |
| **`capacitor-port.ts`（两端统一适配层）** | ✅ **已就位并接线** | 同上；用真实 `MatrixNotifyWeb` 跑过一遍降级路径 |
| `bootstrap.ts` 装配 + `probe()` | ✅ 已接线 | 探测失败不中断启动，写进 `warnings` |
| 本包加进 `apps/shell` 依赖 | ✅ 已接线 | `package.json` 有 `@matrix/capacitor-notify` |
| `cap sync` 识别本包 | ✅ 已实测 | 输出 `Found 4 Capacitor plugins`，含本包 |
| gradle 路径解析（workspace 软链） | ✅ 已实测 | 生成的 `capacitor.settings.gradle` 指向真实路径，不经软链 |
| Android Java 骨架编译进 APK | ✅ 已实测 | `build-apk.ps1 -Variant debug` 通过，`EXIT=0` |
| **适配层在 APK 里生效** | ✅ 已实测 | bundle 里能找到 `没有可用的通知桥` / `capacitor:` 等字样 |
| Android 运行时插件注册 | ⚠️ **未验证** | 本机没有连接设备 |
| iOS 端任何东西 | ⚠️ **未验证** | 本机是 Windows，无 Xcode；`ios/` 目录只是骨架 |

**所以现在的真实能力是：这个构建没有通知。** 而且它会明说 ——
`Platform.notify.isSupported()` 为 false，`schedule()` 抛错，启动时往 `warnings`
里写一条「本构建没有可用的通知桥」。

---

## 2. 为什么是一个独立包，而不是塞进 `apps/shell/android`

因为协作方式是「一个人做 Android、另一个人做 iOS」。包的形式让两边都能**单独编译**：

| 谁 | 打开哪 | 怎么验证 |
|---|---|---|
| Android | `android/` | 已被宿主 include，`gradlew assembleDebug` 会编它 |
| iOS | `ios/` | Xcode → *Open Package*，直接编 `MatrixNotify` + 跑单测 |
| 公共 | `src/definitions.ts` | 两边共同遵守的契约 |

塞进 `apps/shell/android/...` 和 `apps/shell/ios/...` 的话，iOS 的同伴必须先把整个
Capacitor 工程跑起来才能编译一行 Swift，两个人的节奏就被绑在一起了。

---

## 3. 三层，各自的位置

```
插件（纯函数）  reminders(records, now) → 提醒描述        ← 尚未定义
      ↓
宿主调度器      apps/shell/src/core/notify/scheduler.ts   ← 尚未创建，跨端共用
      ↓
宿主接缝        apps/shell/src/core/notify/port.ts        ← ✅ NotifyPort
      ↓
各端 bridge     packages/capacitor-notify/               ← 本包
      ├─ src/definitions.ts   过桥后的契约（与 NotifyPort 一一对应）
      ├─ src/web.ts           浏览器：诚实地说不支持
      ├─ android/             Java（宿主没配 Kotlin 插件）
      └─ ios/                 Swift + SPM
```

**平台差异是数据，不是 `if`。** `capabilities()` 报四件事，调度器据此调整策略：

| | `exact` | `maxPending` | `lostOnReboot` | `requiresPermission` |
|---|---|---|---|---|
| Android | 看用户给不给精确闹钟权限 | 无硬上限 | **true** | true（13+） |
| iOS | **true** | **64** | false | true |
| web / 当前构建 | false | 0 | false | false |

`maxPending` 那个 64 是全局设计约束：滚动窗口必须按**最小的**上限来设计。

---

## 4. 待做（4.1 已完成；还剩 4.2 / 4.3 两步）

### 4.1 ✅ 已完成：适配层

`apps/shell/src/core/notify/capacitor-port.ts` —— 两端统一的翻译层。它做三件事：

1. **同步 → 异步的落差**：`isSupported()` / `capabilities()` 是同步的，原生只能异步回答，
   所以 `probe()` 探一次、缓存起来。`probe()` 之前一律报「不支持」。
2. **过桥前先校验**：形状不对、超 `maxPending` 的**直接拒**（不是静默丢）。
3. **原生返回值正规化**：布尔只认 `=== true`，`maxPending` 夹成非负整数，
   权限字符串只认四个值。

两条硬规则，都写在代码注释里：

- **探测失败不抛错** —— 通知不可用不该让 App 启动失败，降级为「不支持」并写进 `warnings`
- **自相矛盾时以「不支持」为准** —— 说支持却 `maxPending === 0`，说明 bridge 没写完，
  让它安静地什么都不做，好过排出一批注定被丢的通知

**超上限为什么是抛错而不是截断**：iOS 超 64 条系统静默丢弃，Android 不会。
如果这里悄悄截断，两端行为就分叉了，而且用户只会看到「有些提醒就是不响」——
查不出来。所以让调度器负责收窄（滚动窗口），适配层只负责在越界时**当场喊出来**。

### 4.2 实现 Android（`android/`）

- 授权：Android 13+ 运行时权限 `POST_NOTIFICATIONS`，用 Capacitor 的 `@Permission` 注解流程
- 排程：`AlarmManager.setExactAndAllowWhileIdle()` + 能唤醒的 `PendingIntent`
- 精确闹钟在 Android 12+ 需要 `SCHEDULE_EXACT_ALARM`，用户可在设置里关掉；
  `canScheduleExactAlarms()` 为 false 时**降级到 `setWindow()` 并把 `exact` 报成 false**
- 闹钟**重启即丢** → 注册 `BOOT_COMPLETED` receiver 在开机后重排
- 展示：Android 8+ 必须先建 channel，没有 channel 的通知会被**静默丢弃**
- 语言：**Java**。`apps/shell/android` 没配 Kotlin 插件（`MainActivity` 就是 Java），
  用 Kotlin 就得往根 `build.gradle` 加 `kotlin-gradle-plugin`，那是另一件事
- 权限：等代码真的用了再往 `AndroidManifest.xml` 里加（文件里有注释），先加就是假开关

### 4.3 实现 iOS（`ios/`）

- 授权：`requestAuthorization(options: [.alert, .sound, .badge])`，只能在用户操作后调用
- 排程：`UNCalendarNotificationTrigger` / `UNTimeIntervalNotificationTrigger`，
  identifier 就是我们的 id —— 同 id 再 add 天然是覆盖
- **系统只保留最近 64 条**未触发的本地通知，超出**静默丢弃**
- 通知由系统持久化，重启不丢 → `lostOnReboot = false`
- 比 Android 简单，代价就是那个 64

---

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
