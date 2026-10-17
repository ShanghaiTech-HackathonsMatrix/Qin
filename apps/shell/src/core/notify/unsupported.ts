import { NO_CAPABILITIES, type NotifyCapabilities, type NotifyPermission, type NotifyPort, type ScheduledNotification } from './port.ts';

/**
 * 「这个构建没有通知能力」。
 *
 * ## 为什么不写成静默空实现
 *
 * 空实现会让调用方以为排上了 —— 到点不响，而且没有任何地方报错。
 * 那是本项目最忌讳的形状：**假的比没有贵**。
 *
 * 所以：
 * - `isSupported()` → false，宿主据此**不对外宣称**支持 `notify.local`
 * - 查询类方法返回 `'unsupported'`（诚实的答案）
 * - 写入类方法**抛错**（有人真的用了就立刻炸，而不是悄悄吞掉）
 *
 * 等某个平台的 bridge 落地，把 `Platform.notify` 换成它即可，调用方一行不改。
 */
export class UnsupportedNotifyPort implements NotifyPort {
  readonly backend = 'unsupported';

  /** 没什么可探测的：这个实现的存在本身就在说「不支持」 */
  async probe(): Promise<void> {
    return undefined;
  }

  isSupported(): boolean {
    return false;
  }

  capabilities(): NotifyCapabilities {
    return NO_CAPABILITIES;
  }

  async checkPermission(): Promise<NotifyPermission> {
    return 'unsupported';
  }

  async requestPermission(): Promise<NotifyPermission> {
    return 'unsupported';
  }

  async schedule(_items: readonly ScheduledNotification[]): Promise<void> {
    throw new Error('当前构建没有通知桥（Platform.notify 还是 UnsupportedNotifyPort）');
  }

  async cancel(_ids: readonly string[]): Promise<void> {
    throw new Error('当前构建没有通知桥（Platform.notify 还是 UnsupportedNotifyPort）');
  }

  async cancelAll(): Promise<void> {
    throw new Error('当前构建没有通知桥（Platform.notify 还是 UnsupportedNotifyPort）');
  }

  async pending(): Promise<readonly string[]> {
    // 什么都没排，所以空数组是**真话**，不是敷衍
    return [];
  }
}
