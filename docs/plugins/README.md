# Qin 插件使用与开发

本说明对应 2026-10-18 的本地开发版。完整纯函数契约见 [Plugin API](../../packages/plugin-api/README.md)，可运行示例见 [hello-deadline](../../examples/plugins/hello-deadline)。

## 在应用内使用

设置 → 插件管理：

- 内置 Gradescope、Blackboard、教务课表支持登录、同步、停用与启用；系统内置组件单独列出。
- 外部插件选择 `.mtp` 文件，核对名称、版本、ID、联网域名及完整权限后安装。Android 文件选择器展示所有文件，应用只接受 `.mtp` 并校验包结构与权限。
- 安装时可选择加入首页；安装后点“运行同步”。首页可独立显示插件卡片，插件管理也可打开它声明的专属页面。安装不会自动开始联网同步。
- 停用会停止后续执行；重启后保持停用状态。
- 卸载时可选择保留或删除数据。更新目前采用“卸载并保留数据 → 安装同 ID 新版本”，需重新确认权限；没有自动更新。

外部插件均显示“签名未验证”。`.mtp` 只是文件格式，不代表官方认证。内置插件无需转换为 `.mtp`，继续使用进程内运行时。外部插件无法覆盖 `app.matrix.*`、`dev.matrix.*` 等保留 ID。

## 包格式与工具

`.mtp` 是 ZIP，根目录包含 UTF-8 的 `manifest.json` 和 `bundle.js`，不要多套一层目录。当前运行器只读取这两个文件；额外资源不提供运行时加载。限制：压缩包 2 MiB，最多 64 文件，单文件展开 1 MiB，总展开 4 MiB。拒绝路径穿越、重复路径、加密包及不支持的压缩格式。

仓库根目录安装依赖后，使用支持 TypeScript 类型擦除的 Node.js（本机使用 Node 26）：

```sh
node tools/plugin-cli.ts pack examples/plugins/hello-deadline dist-apk/hello-deadline.mtp
node tools/plugin-cli.ts validate dist-apk/hello-deadline.mtp
npm run test:extensions -w matrix-shell
```

`pack` 不编译 TypeScript 或 npm 依赖。开发者需先把入口打包为无外部 import/require 的单个脚本，入口设置 `globalThis.plugin = { ... }`。`validate` 检查包结构、manifest 和 API 版本，**不会执行插件，也不是安全认证**。

## 当前支持范围

| 功能 | 外部插件首版 |
|---|---|
| `logic`、`connector`、`ui` | 支持，统一在 QuickJS 执行 |
| `plan` / `parsers` / `next` | 支持同步纯函数；即使没有请求也提供 `parsers: {}` |
| 网络 | 返回请求计划，宿主按声明域名、方式与网关规则执行；插件不能直接 fetch |
| 实体与槽 | 声明读写权限、schema、consumesSlots；由宿主验证、投影并持久化 |
| 界面、命令 | 首页独立 widget、专属 page；返回受限 `UiNode` 和命令结果，无 DOM、React、HTML、iframe 或宿主引用 |
| 自有账号登录 | Android 支持一个宿主管理的网页登录账号，按插件隔离 WebView Profile；需系统 WebView 支持 MULTI_PROFILE |
| 内置学校 Cookie、secrets | 不开放给外部插件；外部账号也不会获得 BB/GS/EAMS 会话 |
| 本地文件导入、文件系统、原始 SQL | 暂不开放 |
| 通知、后台/精确定时、模型、流式处理 | 暂不开放；个人日程和学业提醒由宿主处理 |
| 远程代码、内置身份、declarative 包 | 安装时拒绝 |
| 签名、市场、自动更新 | 未实现 |

manifest 声明未开放权限会被拒绝，不会显示安装成功后静默忽略。最多安装 8 个外部插件。

## 编写纯函数

复制示例后修改 ID、名称、schema 和逻辑；详细参数以 API 文档与类型定义为准。

- 时间取 `input.now`；随机 ID、设备信息等需要由输入或稳定源 ID 得出。不能调用 Date、Math.random、Promise 或宿主 API。
- `plan(input)` 返回请求计划或直接生成实体；`parsers` 解析宿主返回的响应；多页工作由 `next` 返回下一步计划。
- 用来源稳定 ID 去重，别每次同步生成新 ID。同步失败不得靠返回空集合伪装成功。
- `renders` 返回 JSON `UiNode`。读取数据必须在 `permissions.data.read` 与控件 `requires` 声明，宿主执行字段投影。
- 每个 `contributes.views` 声明都须有同 ID 的 `renders` 函数，缺失会拒绝加载。`kind: "widget"` 可加入首页，`kind: "page"` 可作为专属页。
- 按钮的 `navigate` 可填写自身声明的 page ID，或核心页 `home`、`timeline`、`timetable`、`courses`、`settings`。不能跳到其他插件的路由。停用插件后其卡片和页面停止运行。
- 日程类输出可消费 `app.matrix.timeline.event` 槽；示例生成的是合成事项，与真实课程或作业无关。

## 接入插件自己的账号

在 `contributes.accounts` 声明一个账号，并在 `permissions.auth.providers` 声明其 ID。示例为虚构站点，不能直接用于真实登录：

```json
{
  "permissions": {
    "net": { "domains": ["portal.example.edu"], "methods": ["GET"] },
    "auth": { "providers": ["portal"] }
  },
  "contributes": {
    "accounts": [{
      "id": "portal", "title": "平台账号",
      "loginUrl": "https://portal.example.edu/login",
      "authOrigins": ["https://portal.example.edu", "https://sso.example.edu"],
      "dataOrigins": ["https://portal.example.edu"]
    }]
  }
}
```

origin 必须是精确 HTTPS 域名，可带端口，不带路径、通配符或 IP；每组 1–8 个。`loginUrl` 属于 authOrigins，数据主机还须精确出现在 net.domains。填写真实登录链需要的来源，不能猜测或用通配符放开学校所有站点。

用户在“用户与账号”中打开官方网页，自己输入账号密码；插件不读取密码、Cookie 或响应凭证头。宿主为声明账号的插件请求自动选择隔离会话，逐跳检查 dataOrigins。登录页“完成”只表示用户完成操作，真实认证状态由随后同步结果判断。停用阻止请求；退出/卸载清理该插件会话，不能恢复已清除的 Cookie。

首版每插件只有一个账号，不支持多账号切换、登录 popup、自定义登录 HTML 或任意原生页面；不支持 MULTI_PROFILE 的设备明确报不支持，不回退共享会话。Web/iOS 未提供该登录能力。账号路径已编译且真机探测支持；任意第三方站点的完整登录、退出和隔离行为尚待专项验收。

每个插件独占 QuickJS WASM 实例，当前设置 16 MiB 堆、256 KiB 栈、单次调用约 200 ms，中断超时与内存耗尽会报错。输入 JSON 最多 6 MiB，输出最多 2 MiB。VM 内没有网络、DOM、Capacitor 或 Node 引用。全局 eval/Function 被隐藏，但不宣称消除了 VM 内所有动态代码构造途径；边界是独立解释器与无宿主引用。

当前沙箱调用仍在主线程，尚无 Worker 调度；200 ms 上限不是“完全无卡顿”的保证。声明账号的外部插件走独立 Profile；没有声明账号的通用原生网络路径，其 Cookie 隔离仍需后续完善。三个内置学业平台继续使用原有独立进程会话。

## 交给 AI 编写

把仓库中的 [qin-plugin-author Skill](../../skills/qin-plugin-author/SKILL.md) 文件夹交给支持 Skill 的 AI 工具，并说明希望导入的数据来源、输出字段、更新方式和目标页面。Skill 用于生成代码与 `.mtp`，应用安装的是 `.mtp`，不是 `SKILL.md`。不要把账号、Cookie 或真实网页提交进插件示例。
