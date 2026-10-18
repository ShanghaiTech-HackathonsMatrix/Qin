# iOS 应用、组件与灵动岛

最低部署目标 iOS 17，支持 iPhone 和 iPad 工程目标。原生应用名为 Matrix，前端沿用秦/QIN 的页面品牌与最新仓库 UI。复用项目现有业务、存储与平台连接器，不另建 iOS 业务数据库。

## 功能说明与验收

**项目说明请优先引用 [iOS 已实现功能与验收清单](../../../docs/ios-features.md)**，包含功能表、用户验收口径及不能宣称的能力。更新日期：2026-10-18。

- 官方网页登录：Gradescope、Blackboard、教务。平台使用独立持久化 WebKit 会话，Cookie 不暴露给 JavaScript；登录完成和原生请求后将会话保存至本机钥匙串，WebKit 会话为空时恢复，保留原到期时间；BB 统一认证跳转及登录导航中断已修复。
- App 复用课程、DDL、课表、日程和本学期过滤，前端资源本地打包；iOS 顶栏使用单色图标。
- DDL 与今日课程两个 Widget，提供小、中、大尺寸，可由用户加入系统智能叠放。DDL 单行显示课程、标题与截止时间；今日下一节课在开课 30 分钟后切换。
- 组件正文单击留在桌面，无单独刷新图标。共享 LiveActivityIntent 在 App 后台进程直接发起平台联网检查：JavaScriptCore 执行离线打包的同一套连接器，URLSession 复用各平台 WebKit 会话，不依赖前台 React 轮询。失败保留对应平台缓存。
- 视觉沿用 App 暖白黑灰主色，使用原生磨砂材质、微渐变、圆角与外围高光，跟随系统深浅色。
- ActivityKit 提供短暂刷新反馈；Kill DDL 演示带作业标签、旋转光圈与碎片效果，组件中演示条目可清除并重新加入。使用 USDZ 素材离线渲染图像与 SwiftUI 动画，不是实时 3D 引擎。
- 明确读取到新提交状态时可生成真实完成事件；历史完成、条目消失和个人勾选不触发，重复快照去重。真实平台提交到动画的完整真机闭环未单独记录。
- 原生通知权限、排程、取消、对账与点击回传已接线，实际系统展示和点击待专项验收。

首次须在 App 登录并完成平台同步；会话过期需重新登录。当前不包含密码自动重登、无人点击时持续实时监控或 App Store 发布。iPad 和所有尺寸尚无逐项真机记录。系统控制后台执行、智能叠放、材质透出及 Live Activity 展开时机，不承诺自动展开。

后台同步限时 25 秒，网络超时、认证失效或解析失败时保留旧数据并提示原因；一站失败不覆盖该站快照。原始同步输入与待导入结果保存在受文件保护的 App 私有目录；App Group 仅保存组件展示快照和状态。回到 App 后通过现有 AcademicService 导入后台结果并更新正常数据库和提醒，不另建业务数据库。前台编辑与后台同步共用互斥锁，避免旧结果覆盖设置。

## 构建

在仓库根安装依赖并运行：

```sh
npm run check
npm run sync:ios -w matrix-shell
```

在 Mac 上进入 `apps/shell/ios`，运行 `ruby configure_widget_target.rb`（需要 Ruby 的 xcodeproj），用 Xcode 打开 `App/App.xcodeproj`。App 与 MatrixWidgetExtension 选择同一开发团队，配置 `group.dev.matrix.shell` App Group，然后连接设备构建安装。不要提交个人 Team、证书或生成安装包。

前端资源必须从当前工作树重新构建并同步，不要复制旧 macOS 用户留下的构建缓存替代当前源码，否则可能出现原生构建成功但前端登录仍不可用。

## 测试

- 全仓检查、iOS 前端同步、Mac 模拟器与真机构建、签名校验、iPhone 覆盖安装已通过。
- 原生测试：在本目录运行 `ruby configure_native_tests.rb` 后执行：

```sh
xcodebuild -project App/App.xcodeproj -scheme MatrixNativeTests \
  -destination 'platform=iOS Simulator,name=iPhone 17' CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- test
```

当前 20 项原生测试通过，覆盖 JavaScriptCore 实际执行打包连接器、异步请求桥、超时退出、Foundation URL 解析，以及钥匙串实际读写、平台隔离、显式清除和 Cookie 到期恢复。钥匙串测试需要签名的测试宿主；模拟器可使用上述 ad hoc 签名。模拟器名称以本机安装的设备为准。

- 组件 UI 测试：运行 `ruby configure_widget_ui_tests.rb` 后选择 MatrixWidgetUITests。测试要求已添加 DDL 组件，设备解锁并保持连接；找不到刷新按钮则失败，不以点击普通容器代替。
- 提交事件、组件数据与后台运行时测试纳入 `npm run check`；`npm run test:ios-widget -w matrix-shell` 会先打包运行时再验证三平台、单站失败保留、离线保留、重复提交去重及无浏览器执行。测试使用合成页面，不等于真实平台验收。公开记录不包含真实平台页面、Cookie、账号、设备标识或数据库。

## 交互维护注意

正文点击留在桌面的配置已获用户真机确认。刷新 Intent 为共享的 LiveActivityIntent，同时编入 App 和 Widget；保留 `.buttonStyle(.borderless)` 和当前命中布局。此前多轮问题尚未逐一证明某个 SwiftUI 修饰为唯一根因，修改这些配置必须回归真机，不能仅凭编译通过判断交互正常。

演示按钮与正文刷新为同级独立交互，不嵌套 Intent。演示状态单独放在 App Group，不调用平台提交接口。降低动态效果时减少动画；系统禁用 Live Activities 时组件请求仍可写入。
