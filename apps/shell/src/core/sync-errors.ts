/**
 * 把一轮同步里攒下的错误分成「能忍」和「不能忍」两类。
 *
 * 为什么需要这个分类 —— 这是互动教学平台反复「整轮失败」的真正原因：
 *
 *   · `broker` 对**单个请求失败**的处理是「记一条、跳过、继续扫下一页」
 *     （packages/kernel/src/broker.ts 第 3 步，注释写得很清楚：
 *      「单个请求失败不终止整个同步」）。它认为一页超时不该终止整轮。
 *   · 但 `AcademicService.runSync` 原来对 `report.errors` 是
 *     「有一条就整轮算失败」。
 *
 * 两条规则一对撞，结果就是：一次两百多页的抓取里，只要**任何一页**慢了
 * 45 秒，前面读到的二十几门课、九十多条作业全部作废，界面上只留一句
 * `page-56: ENET 平台请求失败：SocketTimeoutException`。
 * 每次同步都是在赌所有页面都及时返回 —— 这就是「时好时坏」的来源。
 *
 * 所以这里把「某一页没发出去 / 没回来」单独摘出来：这种错误意味着
 * 数据可能少几条，但这一轮抓取本身是有效的，不该连坐。
 * 其余一切（解析器抛错、落盘失败、槽未定义）照旧算失败。
 */

/**
 * `page-56: ENET 平台请求失败：SocketTimeoutException`
 *
 * 前半段是 `broker` 拼的请求 id（`page-${n}`），后半段是网关的错误码
 * （`ENET` / `ETIMEDOUT` / `EHTTP` …）。只认这个形状 —— 宁可少忍，
 * 也不要因为正则太松把真正的失败当成可忽略。
 */
const PAGE_TRANSPORT = /^page-\d+:\s*E[A-Z]{2,}\b/;

export interface SyncErrorSplit {
  /** 某一页没发出去或没回来。这一轮仍然有效，只是可能少几条。 */
  soft: string[];
  /** 其它一切：解析器抛错、落盘失败、槽未定义…… 一律算失败。 */
  hard: string[];
}

export function splitSyncErrors(errors: readonly string[]): SyncErrorSplit {
  const soft: string[] = [];
  const hard: string[] = [];
  for (const e of errors) (PAGE_TRANSPORT.test(e) ? soft : hard).push(e);
  return { soft, hard };
}
