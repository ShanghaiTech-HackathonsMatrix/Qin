/**
 * 通知能力的宿主侧接缝。
 *
 * 今天只有 `UnsupportedNotifyPort`（诚实地说「没有」）。
 * 各平台 bridge 落地后，在 `bootstrap.ts` 里把 `Platform.notify` 换掉即可。
 *
 * 刻意**不**从这里导出任何平台实现 —— 导入 `@matrix/capacitor-notify` 的地方
 * 只该有 `bootstrap.ts` 一处，否则平台依赖会渗进核心层。
 */
export * from './port.ts';
export { UnsupportedNotifyPort } from './unsupported.ts';
