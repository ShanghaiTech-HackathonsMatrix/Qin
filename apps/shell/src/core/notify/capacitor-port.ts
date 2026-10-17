/**
 * `NotifyPort` 的 Capacitor 实现 —— **两端统一的适配层**。
 *
 * ## 这一层做什么、不做什么
 *
 * 它把「异步、只能传 JSON、返回值不可信」的原生桥，翻译成
 * 「同步问能力、方法可抛错、返回值有类型」的 `NotifyPort`。
 *
 * 具体三件事：
 *
 * 1. **同步 → 异步的落差**：`isSupported()` / `capabilities()` 是同步的，
 *    原生只能异步回答。所以 `probe()` 探一次、缓存起来。
 * 2. **过桥前先校验**：形状不对、超上限的，**在宿主侧就拦住**，
 *    不让它变成一个「排上了但系统静默丢弃」的幽灵。
 * 3. **原生返回值正规化**：布尔字段只认 `=== true`，`maxPending` 夹成非负整数，
 *    权限字符串只认那四个值。原生是我们自己写的，但一个笔误不该让调度器算出负数。
 *
 * 它**不**做的事：排多少条、什么时候排、什么时候取消 —— 那是 `NotifyScheduler` 的事。
 * 这一层只管「说得清、传得对、错得响」。
 *
 * ## 为什么不在这里 `import { Capacitor }`
 *
 * 原生插件对象由构造参数注入。好处是它在 Node 里能被一个 20 行的假件测起来，
 * 而不用把 Capacitor 运行时拖进测试。平台名由 `bootstrap.ts` 作为 `label` 传进来。
 */

import type {
  MatrixNotifyPlugin,
  NotifyCapabilities as WireCapabilities,
  NotifyPermission as WirePermission,
  ScheduledNotification as WireNotification,
} from '@matrix/capacitor-notify';

import {
  NO_CAPABILITIES,
  lintNotifications,
  type NotifyCapabilities,
  type NotifyPermission,
  type NotifyPort,
  type ScheduledNotification,
} from './port.ts';

/** 构造参数 */
export interface CapacitorNotifyPortOptions {
  /** 平台标签，只进日志。`bootstrap.ts` 传 `Capacitor.getPlatform()` */
  label?: string;
  /** 取当前时间。测试注入固定时钟用 */
  now?: () => number;
}

/**
 * 把原生报上来的能力正规化。
 *
 * 规则：**只认 `=== true`**，其余一律 false。`maxPending` 不是有限数就当 0。
 * 宁可少报，不可多报 —— 多报会让调度器排出一批注定被系统丢掉的通知。
 */
function normalizeCapabilities(raw: WireCapabilities | null | undefined): NotifyCapabilities {
  if (raw === null || raw === undefined || typeof raw !== 'object') return NO_CAPABILITIES;
  const max =
    typeof raw.maxPending === 'number' && Number.isFinite(raw.maxPending)
      ? Math.floor(raw.maxPending)
      : 0;
  return {
    exact: raw.exact === true,
    maxPending: max > 0 ? max : 0,
    lostOnReboot: raw.lostOnReboot === true,
    requiresPermission: raw.requiresPermission === true,
  };
}

/**
 * 权限字符串正规化。只认那四个值，别的一律 `unsupported`。
 *
 * 为什么不是 `denied`：未知状态意味着「问不出来」，而 `denied` 会让 UI
 * 引导用户去设置里找开关 —— 一个可能根本不存在的开关。
 */
function normalizePermission(raw: WirePermission | null | undefined): NotifyPermission {
  return raw === 'granted' || raw === 'denied' || raw === 'prompt' ? raw : 'unsupported';
}

export class CapacitorNotifyPort implements NotifyPort {
  readonly backend: string;

  private readonly native: MatrixNotifyPlugin;
  private readonly now: () => number;

  private supported = false;
  private caps: NotifyCapabilities = NO_CAPABILITIES;
  private probed = false;

  constructor(native: MatrixNotifyPlugin, opts: CapacitorNotifyPortOptions = {}) {
    this.native = native;
    this.now = opts.now ?? (() => Date.now());
    this.backend = opts.label !== undefined && opts.label !== '' ? `capacitor:${opts.label}` : 'capacitor';
  }

  // ---------------------------------------------------------- 能力探测

  async probe(): Promise<void> {
    if (this.probed) return;
    this.probed = true;

    try {
      const r = await this.native.isSupported();
      if (r === null || r === undefined || r.supported !== true) {
        this.supported = false;
        this.caps = NO_CAPABILITIES;
        return;
      }

      const caps = normalizeCapabilities(await this.native.capabilities());

      // 自相矛盾时以「不支持」为准：说支持却一条都排不了，说明 bridge 没写完。
      // 这时候让它安静地什么都不做，比让它排出一批注定被丢的通知要好。
      this.caps = caps;
      this.supported = caps.maxPending > 0;
    } catch {
      // 探测失败 = 不支持。**不**向上抛：装配流程不该因为通知桥而中断。
      this.supported = false;
      this.caps = NO_CAPABILITIES;
    }
  }

  isSupported(): boolean {
    return this.supported;
  }

  capabilities(): NotifyCapabilities {
    return this.caps;
  }

  // ---------------------------------------------------------- 权限

  async checkPermission(): Promise<NotifyPermission> {
    if (!this.supported) return 'unsupported';
    const r = await this.native.checkPermission();
    return normalizePermission(r?.permission);
  }

  async requestPermission(): Promise<NotifyPermission> {
    if (!this.supported) return 'unsupported';
    const r = await this.native.requestPermission();
    return normalizePermission(r?.permission);
  }

  // ---------------------------------------------------------- 排程

  async schedule(items: readonly ScheduledNotification[]): Promise<void> {
    this.requireSupported('schedule');

    // 形状不对的**直接拒**，不是静默丢。
    // 到这一层还出现坏数据，说明上游调度器有 bug —— 那要当场看见。
    // （插件产出的脏数据该由调度器用 `lintNotifications()` 逐条丢掉，见那里的注释。）
    const { ok, rejected } = lintNotifications(items, this.now());
    if (rejected.length > 0) {
      const detail = rejected.map((r) => `${r.id}(${r.reason})`).join('、');
      throw new Error(`拒绝排程：${rejected.length} 条通知形状不合法 —— ${detail}`);
    }

    // 超上限也**直接拒**。
    // iOS 超出 64 条会被系统静默丢弃，Android 不会 —— 如果这里悄悄截断，
    // 两端行为就分叉了，而且用户只会看到「有些提醒就是不响」。
    if (ok.length > this.caps.maxPending) {
      throw new Error(
        `拒绝排程：一批 ${ok.length} 条超过本端上限 ${this.caps.maxPending}。` +
          '调度器应当先按 capabilities().maxPending 收窄（见滚动窗口策略）。',
      );
    }

    if (ok.length === 0) return;

    // 只送有值的字段：`undefined` 过桥会变成 `null`，原生侧还得多判断一次
    const wire: WireNotification[] = ok.map((n) => {
      const w: WireNotification = { id: n.id, at: n.at, title: n.title };
      if (n.body !== undefined) w.body = n.body;
      if (n.payload !== undefined) w.payload = n.payload;
      return w;
    });

    await this.native.schedule({ items: wire });
  }

  async cancel(ids: readonly string[]): Promise<void> {
    this.requireSupported('cancel');
    if (ids.length === 0) return; // 空批不发请求，省一次过桥
    await this.native.cancel({ ids: [...ids] });
  }

  async cancelAll(): Promise<void> {
    this.requireSupported('cancelAll');
    await this.native.cancelAll();
  }

  /**
   * 系统里当前真的挂着的 id。
   *
   * 不支持时返回空数组 —— 这是**真话**：一条都没排上。
   * 支持时原样透传，但挡掉非数组（原生返回 null 不该让调用方崩在 `.length` 上）。
   */
  async pending(): Promise<readonly string[]> {
    if (!this.supported) return [];
    const r = await this.native.pending();
    return Array.isArray(r?.ids) ? r.ids : [];
  }

  // ---------------------------------------------------------- 内部

  private requireSupported(op: string): void {
    if (!this.supported) {
      throw new Error(
        `当前构建没有可用的通知桥（${this.backend} 在 probe() 时报告不支持），已拒绝 ${op}`,
      );
    }
  }
}
