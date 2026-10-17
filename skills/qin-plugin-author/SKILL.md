---
name: qin-plugin-author
description: 为 Qin 时间信息平台编写纯函数插件，生成和验证可从设置页导入的 .mtp 包。适用于新增解析器、连接器或声明式控件。
---

# Qin 插件作者

需要 Qin 源码检出及其 npm 依赖。此 Skill 随 Qin 仓库分发；先定位包含 `packages/plugin-api`、`tools/plugin-cli.ts` 的仓库根目录。不要假定用户机器有固定绝对路径。

## 读取与确定范围

1. 先读仓库 `docs/plugins/README.md` 的支持范围，再按需读 `packages/plugin-api/README.md` 的 manifest、plan/parsers/next、UI、槽章节；类型以 `packages/plugin-api/src` 的公开导出为准。
2. 以 `examples/plugins/hello-deadline` 为最小可运行模板。询问无法从用户需求和现有材料确定的数据格式、时区及目标输出；不自行猜测学校或服务接口。
3. 首版外部插件没有网页登录、Cookie、secrets、通知、文件导入、后台定时、数据库或模型能力。需求依赖这些能力时说明缺口；不要用空实现或嵌入凭证假装完成。

## 实现规则

- 产出根目录 `manifest.json` 与 `bundle.js`；entry 必须 `bundle.js`，ID 使用自己的反向域名，不得用 `app.matrix.*`、`dev.matrix.*`。kind 选择 logic/connector/ui。
- 代码用 `globalThis.plugin` 导出同步函数；最小结构为 `{plan(input) { return {requests: [], entities: []}; }, parsers: {}}`。无 ESM import、require、async/await 或 Promise。
- 插件不能直接访问 fetch、DOM、Capacitor、Node、Date、定时器或 Math.random。时间使用 input.now；IO 返回请求描述交给宿主，响应由 parsers/next 处理。所有边界传递 JSON。
- manifest 按实际用途声明 net 域名/方式、data read/write、实体 schema、控件与槽映射；不要为了省事扩大权限。不要申请 remoteCode、first-party 或未开放权限。
- 实体用来源稳定 ID；明确解析失败、登录失效与合法空结果。时区和跨年推断必须有来源依据或明确由用户设置。
- 控件返回 UiNode，不能返回 HTML/React。控件 requires 必须属于 data.read；实体字段必须匹配 schema。需要投影到日程时参考示例的 consumesSlots。
- 资源预算：包 2 MiB、单文件展开 1 MiB、最多 8 个已装外部插件；VM 16 MiB 堆、单调用约 200 ms。大页分批处理，别把整个历史反复塞回状态。

## 交付与验证

在仓库根目录运行：

```sh
node tools/plugin-cli.ts pack <插件目录> dist-apk/<名称>.mtp
node tools/plugin-cli.ts validate dist-apk/<名称>.mtp
```

Node 需支持直接运行可擦除类型的 TypeScript；工具不会替你编译源码依赖。含依赖的源码先自行打包为一个脚本。

为真实解析逻辑准备脱敏的成功、空列表、失效登录、异常日期样本，检查幂等同步和权限拒绝；可参考 `apps/shell/src/core/external-plugins.test.ts` 的真实 QuickJS 执行方法。格式校验通过不能替代运行测试。

交付源码、`.mtp`、安装步骤、权限说明及验证范围。用户在“设置 → 插件管理”选择文件、确认权限、运行同步、查看插件视图。文件选择器展示所有文件，应用只接受并校验 `.mtp`。明确标记合成数据和未验证的真实服务行为。未验签是当前宿主状态，不要宣传插件已获官方认证。未经用户要求不发布到仓库或插件市场。
