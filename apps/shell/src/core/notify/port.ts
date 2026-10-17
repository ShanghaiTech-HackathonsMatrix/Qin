/**
 * 通知桥 —— 宿主侧唯一的平台无关接缝。
 *
 * ## 为什么要有这一层
 *
 * 通知是本项目第一个**「界面没打开也要干活」**的能力。它的实现必然按平台分叉
 * （Android 的 AlarmManager + NotificationManager、iOS 的 UNUserNotificationCenter、
 * 桌面各自一套），但**调用方不该知道这些**。
 *
 * 所以：上面是 `NotifyScheduler`（写一次，纯逻辑 + 调本接口），
 * 下面是各平台 bridge（一个平台一个实现）。
 *
 * ```
 *   插件（纯函数）→ 提醒描述
 *          ↓
 *   NotifyScheduler（宿主，跨端共用：滚动窗口、去重、对账）
 *          ↓  NotifyPort   ← 本文件。**平台差异到此为止**
 *          ↓
 *   ┌──────────┬──────────┬─────────┬─────────┐
 * Android     iOS       Windows   macOS     Linux
 * ```
 *
 * ## 平台差异是**数据**，不是 `if`
 *
 * 各平台真正的不同只有四件事：能不能准点、最多挂几条、重启会不会丢、要不要授权。
 * 这些由 `capabilities()` 以数据形式报上来，调度器据此调整策略 ——
 * 而不是在每个调用点写 `if (platform === 'ios')`。
 *
 * 这条约束是硬的：**接口里不允许出现平台名**。一旦出现，说明差异没被抽象干净。
 */

/** 一条要排进系统的通知。**时刻已经算好**，不含「多久之后」的相对语义 */
export interface ScheduledNotification {
  /**
   * 稳定 id —— 同一 id 重复排程是**覆盖**，不是新增。
   *
   * 必须是宿主生成的确定性字符串（建议 `插件id#记录id#档位`），
   * 这样「任务改了时间」只要重排同一个 id 就行，不会留下幽灵通知。
   */
  id: string;
  /** 触发时刻（epoch ms），必须在未来 */
  at: number;
  /** 标题，一行。过长由 bridge 截断，不报错 */
  title: string;
  /** 正文，可选 */
  body?: string;
  /**
   * 点击后带回宿主的**不透明**字符串。
   *
   * 刻意不定义结构：那是宿主与它自己的路由之间的事，bridge 只负责原样送达。
   * 一旦在这里约定 `{pluginId, recordId}`，各平台就得解析它 —— 那是耦合。
   */
  payload?: string;
}

/**
 * 权限状态。
 *
 * `unsupported` 和 `denied` 必须分开：前者是「这个平台/这个构建根本没有通知」，
 * 后者是「用户拒绝了」。混在一起会让 UI 给出错误引导（去设置里开权限 vs 无能为力）。
 */
export type NotifyPermission = 'granted' | 'denied' | 'prompt' | 'unsupported';

/**
 * 平台约束，由 bridge 自报。
 *
 * 调度器读它来决定「排多少条、要不要留余量、启动时要不要重排」。
 */
export interface NotifyCapabilities {
  /** 能准点触发。false = 系统可以推迟几分钟到几十分钟（Android 非精确闹钟、Doze） */
  exact: boolean;
  /**
   * 系统最多同时挂多少条。
   *
   * iOS 是 64（超出会被系统静默丢弃，不报错）—— 这是本接口存在的主要理由：
   * 滚动窗口必须按**最小的那个上限**来设计。
   */
  maxPending: number;
  /** 重启后已排的闹钟会丢，宿主启动时必须重排（Android 会，iOS 不会） */
  lostOnReboot: boolean;
  /** 需要用户显式授权（桌面端通常不需要） */
  requiresPermission: boolean;
}

/**
 * 各平台 bridge 要实现的全部。
 *
 * 注意 `pending()` —— 它不是「调试用」。系统**会**单方面丢掉通知
 * （iOS 超上限、Android 重启、用户在设置里清掉）。宿主算出来的和系统里真挂着的
 * 会不一致，必须能对账，否则「明明排了却不响」永远查不出来。
 */
export interface NotifyPort {
  /** 自述名字，进日志与调试面板。如 `android-alarm` / `ios-un` / `unsupported` */
  readonly backend: string;

  /**
   * 探测能力，装配时调用一次（`bootstrap()` 里 `await`）。
   *
   * 为什么必须有这一步：`isSupported()` 与 `capabilities()` 是**同步**的
   * （调用方是纯逻辑，不该被 Promise 污染），但原生桥只能异步回答。
   * 所以能力必须**先探测、后缓存**。
   *
   * `probe()` 之前的 `isSupported()` 一律返回 false —— 「还没问过」和「不支持」
   * 在这个阶段是等价的，因为宿主绝不会在探测前对外宣称支持 `notify.local`。
   *
   * 实现方**不得抛错**：探测失败就是「不支持」，装配流程不该因此中断。
   */
  probe(): Promise<void>;

  /** 这个构建到底有没有通知能力。false 时宿主**不得**对外宣称支持 `notify.local` */
  isSupported(): boolean;

  /** 平台约束。`isSupported()` 为 false 时可以返回一份「什么都不支持」的 */
  capabilities(): NotifyCapabilities;

  /** 只查不问 —— 不弹系统弹窗 */
  checkPermission(): Promise<NotifyPermission>;

  /**
   * 弹系统授权弹窗。
   *
   * 只能在用户主动操作后调用（Android 13+ / iOS 都是这个要求），
   * 启动时静默调用会被系统直接判 denied，且很难恢复。
   */
  requestPermission(): Promise<NotifyPermission>;

  /** 覆盖式排程：同 id 覆盖。整批要么全成功，要么抛错（不留半批） */
  schedule(items: readonly ScheduledNotification[]): Promise<void>;

  /** 按 id 取消。不存在的 id 静默忽略 */
  cancel(ids: readonly string[]): Promise<void>;

  /** 取消全部（退出插件、清空数据时用） */
  cancelAll(): Promise<void>;

  /** 系统里**当前真的挂着**的 id，用于对账 */
  pending(): Promise<readonly string[]>;
}

/** 「什么都不支持」的约束，给 unsupported 实现与降级路径复用 */
export const NO_CAPABILITIES: NotifyCapabilities = {
  exact: false,
  maxPending: 0,
  lostOnReboot: false,
  requiresPermission: false,
};

/**
 * 一批通知的**形状**校验 —— 纯函数，不碰平台。
 *
 * 各平台 bridge 都会重复做这件事（系统对 title/body 长度、时间范围各有脾气），
 * 所以在这里统一一次，bridge 只需处理「系统特有的那部分」。
 *
 * 返回被拒的 id 与原因，**不抛异常**：一条坏数据不该让整批失败。
 */
export function lintNotifications(
  items: readonly ScheduledNotification[],
  now: number,
): { ok: ScheduledNotification[]; rejected: { id: string; reason: string }[] } {
  const ok: ScheduledNotification[] = [];
  const rejected: { id: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const it of items) {
    if (typeof it.id !== 'string' || it.id.length === 0) {
      rejected.push({ id: String(it.id), reason: 'id 为空' });
      continue;
    }
    if (seen.has(it.id)) {
      rejected.push({ id: it.id, reason: '同一批里 id 重复' });
      continue;
    }
    if (!Number.isFinite(it.at)) {
      rejected.push({ id: it.id, reason: 'at 不是有限数' });
      continue;
    }
    if (it.at <= now) {
      // 过期的直接丢：排进过去只会立刻触发或永不触发，两种都是错的
      rejected.push({ id: it.id, reason: 'at 已经过去' });
      continue;
    }
    if (typeof it.title !== 'string' || it.title.trim().length === 0) {
      rejected.push({ id: it.id, reason: 'title 为空' });
      continue;
    }
    seen.add(it.id);
    ok.push(it);
  }

  return { ok, rejected };
}
