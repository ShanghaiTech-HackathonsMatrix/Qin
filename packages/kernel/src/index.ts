/**
 * @matrix/kernel —— 内核：注册表 / 生命周期 / 信任 / 数据总线 / 同步 broker
 *
 * 这一层是**宿主侧**代码。它与插件的关系是：
 *
 *   · 内核**拥有**全部状态（注册表、信任、数据、审计）
 *   · 插件通过 `@matrix/plugin-api` 的契约与内核对话
 *   · 插件**永远不**直接读写存储、不直接出网、不直接接触凭证
 *
 * 内核不负责 UI，也不负责具体的执行环境（QuickJS 沙箱 / 进程内对象）——
 * 后者通过 `PluginRuntime` 注入。这样同一套内核既能跑第一方插件（进程内），
 * 也能跑第三方插件（沙箱），符合 D4「内置插件调用的 API 与第三方完全一致」。
 */

export * from './bytes.ts';
export * from './trust.ts';
export * from './databus.ts';
export * from './broker.ts';
export * from './registry.ts';
