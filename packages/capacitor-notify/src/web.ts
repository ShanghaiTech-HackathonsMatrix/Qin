import { WebPlugin } from '@capacitor/core';

import type {
  MatrixNotifyPlugin,
  NotifyCapabilities,
  NotifyPermission,
  ScheduledNotification,
} from './definitions.ts';

/**
 * Web 实现：**诚实地说不支持**。
 *
 * 浏览器有 Notification API 和 Service Worker，理论上能做，但：
 * 1. 它只在页面活着时可靠，和「App 关着也要响」是两回事
 * 2. 这个项目的主目标是移动端原生，web 只是开发/预览形态
 *
 * 所以不做。`supported: false` 会让宿主不宣称支持 `notify.local`，
 * 插件因此不会以为自己排上了提醒 —— 这正是想要的结果。
 */
export class MatrixNotifyWeb extends WebPlugin implements MatrixNotifyPlugin {
  async isSupported(): Promise<{ supported: boolean }> {
    return { supported: false };
  }

  async capabilities(): Promise<NotifyCapabilities> {
    return { exact: false, maxPending: 0, lostOnReboot: false, requiresPermission: false };
  }

  async checkPermission(): Promise<{ permission: NotifyPermission }> {
    return { permission: 'unsupported' };
  }

  async requestPermission(): Promise<{ permission: NotifyPermission }> {
    return { permission: 'unsupported' };
  }

  async schedule(_options: { items: ScheduledNotification[] }): Promise<void> {
    throw this.unimplemented('web 构建没有通知桥');
  }

  async cancel(_options: { ids: string[] }): Promise<void> {
    throw this.unimplemented('web 构建没有通知桥');
  }

  async cancelAll(): Promise<void> {
    throw this.unimplemented('web 构建没有通知桥');
  }

  async pending(): Promise<{ ids: string[] }> {
    return { ids: [] };
  }
}
