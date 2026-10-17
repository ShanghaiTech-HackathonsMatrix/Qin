/**
 * @matrix/plugin-api —— v1 契约的唯一入口
 *
 * 这个包是**纯数据 + 纯函数**，没有任何运行时依赖，也不碰 DOM / Node API
 * （只有 `URL` 与 `Object` / `Set` / `Map` 这些两边都有的东西）。
 *
 * 为什么这么苛求：同一份代码要能被宿主、插件脚手架、沙箱引导脚本、
 * 以及将来的 CI 校验器复用。任何一边引入平台依赖都会逼出分叉。
 */

export * from './errors.ts';
export * from './schema.ts';
export * from './manifest.ts';
export * from './accounts.ts';
export * from './permissions.ts';
export * from './contract.ts';
export * from './ui.ts';
export * from './slot.ts';
export * from './command.ts';
export * from './version.ts';
