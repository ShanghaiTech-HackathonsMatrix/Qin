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
 * 前半段是 `broker` 拼的请求 id（`page-${n}`），后半段是网关的错误码。
 *
 * 这里用**白名单**而不是「凡 E 开头就放行」—— 教训是踩出来的：
 * `EREDIRECT` 意味着平台把请求转去了登录页（会话过期），网关不放行跨域跳转。
 * 这种错误放行下去，整轮就会「成功」地读回零页，然后抛一句
 * 「本次未得到有效数据」，把真正的原因（登录过期）埋掉。
 * 所以只有下面这三个算「这一页没回来」。
 */
const SOFT_CODES = new Set(['ENET', 'ETIMEDOUT', 'EHTTP']);
const PAGE_ERROR = /^page-\d+:\s*(E[A-Z]{2,})\b/;

export interface SyncErrorSplit {
  /** 某一页没发出去或没回来。这一轮仍然有效，只是可能少几条。 */
  soft: string[];
  /** 其它一切：解析器抛错、落盘失败、槽未定义…… 一律算失败。 */
  hard: string[];
}

export function splitSyncErrors(errors: readonly string[]): SyncErrorSplit {
  const soft: string[] = [];
  const hard: string[] = [];
  for (const e of errors) {
    const code = PAGE_ERROR.exec(e)?.[1];
    (code !== undefined && SOFT_CODES.has(code) ? soft : hard).push(e);
  }
  return { soft, hard };
}

/**
 * 把网关/解析器的错误码翻成人话。
 *
 * 用户看到的最后一句话往往就是这个函数的结果 —— 所以它必须说清楚
 * **下一步该干什么**，而不是把 `EREDIRECT` 这种内部码原样甩出去。
 */
/**
 * 「同步」失败后该不该自动改走深度扫描。
 *
 * 互动教学平台的快路走页面上那个「待完成作业」模块。有些学期/有些账号上这个
 * 模块根本不在，快路只能失败 —— 以前这是单独的「扫描课程目录」按钮，让用户
 * 自己判断该点哪个。合并成一个「同步」之后，判断交回给代码：只有确实是
 * 「待完成作业模块读不到」才改走逐门课扫描，其它错误照常抛出，不掩盖。
 *
 * 抽成纯函数是为了能测 —— 这条补救路径在真实站点上很难复现。
 */
export function needsDeepScan(provider: string, message: string): boolean {
  return provider === 'blackboard' && message.includes('待完成作业模块');
}

export function explainSyncError(raw: string): string {
  if (/EREDIRECT/i.test(raw)) return `${raw}\n（平台把请求转去了登录页，多半是登录已过期 —— 重新点「登录」走一遍再同步）`;
  if (/LOGIN_REQUIRED/i.test(raw)) return '登录已过期，请重新登录';
  if (/EAUTH/i.test(raw)) return `${raw}\n（平台不认这次会话，重新登录再同步）`;
  if (/ENET|ETIMEDOUT/i.test(raw)) return `${raw}\n（网络没通或太慢，换个网络再试）`;
  return raw;
}
