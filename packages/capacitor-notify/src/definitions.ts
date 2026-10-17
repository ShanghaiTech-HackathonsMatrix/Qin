/**
 * 原生侧契约 —— 与 `apps/shell/src/core/notify/port.ts` 的 `NotifyPort` **一一对应**。
 *
 * ## 为什么两份而不是一份
 *
 * `NotifyPort` 是**宿主内部**的接缝：方法可以同步（`isSupported`、`capabilities`），
 * 可以抛异常，返回值可以是 TS 联合类型。
 *
 * Capacitor 的桥只能传 JSON，且**所有方法都是 Promise**。所以必须有一份
 * 「过了桥之后的形状」：
 *
 * | `NotifyPort` | 这里 |
 * |---|---|
 * | `isSupported(): boolean` | `isSupported(): Promise<{supported:boolean}>` |
 * | `schedule(items)` 抛错 | `schedule({items})` → `reject(message)` |
 * | `NotifyPermission` 联合类型 | 同样联合类型（字符串，能过桥） |
 *
 * **两边必须同步改。** 这条不是靠纪律保证的：`port.ts` 的实现方
 * （各平台 bridge 的 TS 适配层）负责把这份契约翻译成 `NotifyPort`，
 * 类型不匹配就编译不过。
 */

/** 一条要排进系统的通知。字段与 `port.ts` 的 `ScheduledNotification` 完全一致 */
export interface ScheduledNotification {
  id: string;
  at: number;
  title: string;
  body?: string;
  payload?: string;
}

/** 权限状态。`unsupported` 与 `denied` 必须分开，原因见 `port.ts` */
export type NotifyPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

/** 平台约束。由原生侧自报，宿主调度器据此调整策略 */
export interface NotifyCapabilities {
  exact: boolean;
  maxPending: number;
  lostOnReboot: boolean;
  requiresPermission: boolean;
}

/** 原生插件暴露的全部方法。**新增方法必须同时改 android/ 与 ios/** */
export interface MatrixNotifyPlugin {
  isSupported(): Promise<{ supported: boolean }>;
  capabilities(): Promise<NotifyCapabilities>;
  checkPermission(): Promise<{ permission: NotifyPermission }>;
  requestPermission(): Promise<{ permission: NotifyPermission }>;
  /** 覆盖式排程：同 id 覆盖。整批要么全成功，要么 reject */
  schedule(options: { items: ScheduledNotification[] }): Promise<void>;
  cancel(options: { ids: string[] }): Promise<void>;
  cancelAll(): Promise<void>;
  /** 系统里当前真的挂着的 id，用于对账 */
  pending(): Promise<{ ids: string[] }>;
  /** 读取并消费最近一次通知点击；旧桥可缺省。 */
  consumeTap?(): Promise<{ payload: string | null }>;
}

/** Capacitor 里注册用的名字，必须与原生侧 `@CapacitorPlugin(name = ...)` 一致 */
export const PLUGIN_NAME = 'MatrixNotify';
