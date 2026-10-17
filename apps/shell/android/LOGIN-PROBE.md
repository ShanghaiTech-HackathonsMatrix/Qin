# 安卓网页登录验证（仅 debug）

本文件记录前一阶段的独立 debug 登录探针。正式插件、认证代理与通知调度现已另行接线，见 `../../src/plugins/builtin/academic/README.md`。探针和正式插件使用不同 WebView 数据目录，探针登录结果不代表正式插件已验证，需在正式入口重新登录。

## 入口

`app/src/debug` 中的 `LoginProbeActivity` 只进入 debug APK。通过 ADB 启动：

```powershell
adb shell am start -n dev.matrix.shell/.LoginProbeActivity --es provider gradescope
adb shell am start -n dev.matrix.shell/.LoginProbeActivity --es provider blackboard
```

用户在手机官方页面手动输入凭证，登录后点击“关闭网页并验证”。该按钮销毁登录 WebView，再以原生 HTTP 请求账号/门户页；结果为认证状态、HTTP 状态与去重后的课程入口数量。`UNKNOWN` 不当作成功。

强停后，只验证持久会话，不重新打开登录页：

```powershell
adb shell am force-stop dev.matrix.shell
adb shell am start -n dev.matrix.shell/.LoginProbeActivity --es provider gradescope --ez verify true
```

读取经过限制的测试输出：

```powershell
adb logcat -d -v brief -s QinLoginProbe:I
```

## 边界

- 独立 `:loginprobe` 进程、Android 9+ 独立 WebView 数据目录，无 Capacitor/JavaScript 桥；不改主 WebView 的 CSP。
- 不保存密码，不导出 Cookie、网页 HTML、账号或含查询参数的 URL；不忽略 TLS 证书错误。
- 登录主框架仅允许 HTTPS 的平台域名；BB 允许学校域下跳转。原生验证请求仅跟随同源重定向，最多 10 次、响应最多 5 MiB。
- Cookie 由 Android WebView 管理；本验证不代表生产所需的加密会话库、账号隔离与登出逻辑已经完成。
- 原生请求是 debug 验证路径，尚未接入 Qin 核心网关或插件请求。
- 本次不拉取作业内容、不排程通知。网页登录成功、原生请求成功、会话恢复分别记录，不相互替代。

## 本机构建环境

- Node `26.1.0`，`npm ci` 安装锁定依赖。
- Android SDK：保留 SDK/Build Tools 35，增装 Platform 36 与 Build Tools 36.0.0。使用者自行配置本地 SDK 路径，不提交机器路径。
- 本次使用 JDK 21.0.12.1 和 Gradle 8.14.3，不更改系统 Java 或仓库 Wrapper。
- Gradle 使用 `-Pandroid.overridePathCheck=true` 处理当前中文工作区路径。

## 验证记录

2026-10-17，vivo V2352A，Android API 36，USB 真机：

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 通过 |
| `npm run check` | 全部测试、类型检查通过 |
| Gradle `assembleDebug` | 通过，216 个任务，首次约 4 分 45 秒 |
| `adb install -r -t --user 0` | Success |
| Gradescope 无会话基线 | `LOGIN_REQUIRED`，HTTP 200，登录表单，课程入口 0 |
| Gradescope 邮箱登录后关闭网页、原生请求 | `AUTHENTICATED`，HTTP 200，课程入口 7，无密码表单，有登出入口 |
| Gradescope 强停应用后不打开网页、只请求账号页 | `AUTHENTICATED`，HTTP 200，课程入口仍为 7 |
| BB 无会话基线 | `LOGIN_REQUIRED redirect=true`，未把统一认证重定向当成功 |
| BB 首轮打开统一认证 | 复现空白页：学校跳转到 HTTP 认证入口，被 HTTPS 限制拦截；加载完成提示曾覆盖错误 |
| BB 修复后打开统一认证 | 新 APK 安装成功，真机已显示认证站登录表单，检测到密码输入框 |
| BB 统一认证后关闭网页、原生请求 | `AUTHENTICATED`，HTTP 200，课程入口 1，无密码表单，有登出入口 |
| BB 强停应用后不打开网页、只请求门户 | `AUTHENTICATED`，HTTP 200，课程入口仍为 1 |
| 修复版重新安装后 Gradescope 回归 | 不打开网页，原生请求仍 `AUTHENTICATED`，HTTP 200，课程入口 7 |

本机后续进程的 `Log.i` 未能稳定从 logcat 取得，因此上述认证结果以原生结果页的可见状态为证据。读取结果时只提取 `provider result=...` 一行，不保留页面层级、课程名称或账号信息。

两个平台的结果支持继续开发宿主会话接线，不能代替作业 DDL 解析验证，也不代表长期不过期或手机重启后一定恢复。课程入口数量只是认证探测结果，不代表账号全部课程已完整同步，尤其 BB 门户中的 1 个入口不能据此推断只有 1 门课。

## BB 空白页排查

真机复现与独立无会话 HTTP 请求均确认：BB 门户返回两次 302 后指向 `http://ids.shanghaitech.edu.cn/authserver/login`。验证页原先拦截了该跳转，但 `onPageFinished` 覆盖了拦截提示。将同一认证入口升级到 HTTPS 后，独立请求返回 HTTP 200，存在密码表单。

修复仅针对该域名、路径、默认 HTTP 端口的主框架 GET 导航：保持查询参数，将地址升级到 HTTPS；不放开 HTTP、不忽略证书错误。补充 HTTP/TLS 加载错误显示，并避免“加载完成”覆盖错误。使用真机原始跳转链作为回归验证：增量构建成功，安装成功，原空白区域出现登录表单（认证域名、登录按钮、密码输入框）；单独测试 URL 字符串不能证明学校页面可用。此结果尚不等于登录成功。

另修复同一进程再次打开验证 Activity 时重复设置 WebView 数据目录的问题。所有改动仅在 debug 源集中。

最终真机流程已完成：用户在 HTTPS 学校认证页登录后关闭 WebView，原生请求验证通过；强停进程后仅原生请求仍通过。此次修复没有启用明文传输或跳过 TLS 校验。

构建副作用中的已跟踪生成文件已恢复。新增 Gradle transform 缓存目录保留本地并排除，不进入提交。本文记录探针阶段；当前正式插件与真机验收结果见学业连接器说明。
