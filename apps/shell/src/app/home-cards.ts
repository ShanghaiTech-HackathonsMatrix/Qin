/**
 * 首页的可定制卡片。
 *
 * 之前首页的排布是**写死在 JSX 里的**：加一块、挪个位置都得改代码。
 * 这里把「首页摆什么、摆多大、什么顺序」抽成一份数据放进设置里，
 * 视图只负责按这份数据渲染。
 *
 * 约束与取舍：
 *   · 尺寸只有「整宽 / 半宽」两档。半宽就是两卡并排占一行 ——
 *     手机上再多一档（三分宽）文字就会挤到读不了。
 *   · 顺序就是数组顺序，拖拽直接改数组，不做额外的 rank 字段，
 *     免得出现「数组顺序和 rank 不一致」这种双份真相。
 *   · 读盘时一律过一遍 `normalizeHomeCards`：设置是用户可改的、
 *     也可能是旧版本写进去的，未知 id 与重复项必须在进视图之前就过滤掉。
 */

export type HomeCardId = 'hero' | 'next-class' | 'schedule' | 'ddl' | 'atlas' | 'widgets';
export type HomeCardSize = 'full' | 'half';

export interface HomeCardConfig {
  id: HomeCardId;
  size: HomeCardSize;
}

export interface HomeCardMeta {
  name: string;
  /** 添加卡片时给的一句说明 */
  hint: string;
  /** 半宽放不下这个内容，只能整宽 */
  fullOnly?: boolean;
}

export const HOME_CARD_META: Record<HomeCardId, HomeCardMeta> = {
  hero: { name: '今日概览', hint: '日期、人物与三项统计', fullOnly: true },
  'next-class': { name: '下一节课', hint: '最近一节课的时间与地点' },
  schedule: { name: '本周日程', hint: '一周七天的可视化格子，不是文字时间线' },
  ddl: { name: '最近的 DDL', hint: '今天（或最近一天）到期的作业' },
  atlas: { name: '冒险图鉴', hint: '进度与在册课程数' },
  widgets: { name: '插件卡片', hint: '插件清单里声明要在首页显示的控件' },
};

/** 添加卡片面板里的顺序 */
export const HOME_CARD_ORDER: HomeCardId[] = ['hero', 'next-class', 'schedule', 'ddl', 'atlas', 'widgets'];

/**
 * 出厂排布（演示态）。
 *
 * 刻意就是**原来那一屏**四块，且都是整宽 ——
 * 这样「首页一屏装下」这条已验证的性质在默认状态下不会被这次改动破坏。
 * 新的「本周日程」放进可选列表，由用户自己加。
 */
export const DEFAULT_HOME_CARDS: HomeCardConfig[] = [
  { id: 'hero', size: 'full' },
  { id: 'next-class', size: 'full' },
  { id: 'ddl', size: 'full' },
  { id: 'atlas', size: 'full' },
];

/**
 * 出厂排布按模式分叉。
 *
 * 演示态有 DDL 与图鉴的数据，所以默认摆它们；
 * 真实模式下这两块**还没有数据来源**（平台同步没接），
 * 摆上去就是两张空卡，所以默认换成「插件卡片」——
 * 那正是这次改动之前硬挂在首页最下面的那块控件区。
 */
export function defaultHomeCards(demo: boolean): HomeCardConfig[] {
  if (demo) return DEFAULT_HOME_CARDS.map((c) => ({ ...c }));
  /*
    真实模式：三张有真实数据的卡 + 插件控件区。
    插件控件区（`widgets`）在没有课表时是一条「去导入 .ics」的引导，
    首次使用要靠它，所以留在默认排布里；
    图鉴是装饰性的，交给用户自己加。
  */
  return [
    { id: 'hero', size: 'full' },
    { id: 'next-class', size: 'full' },
    { id: 'ddl', size: 'full' },
    { id: 'widgets', size: 'full' },
  ];
}

const IDS = new Set<string>(HOME_CARD_ORDER);

/** 把任意来源的数据收敛成一份可用的卡片列表 */
export function normalizeHomeCards(value: unknown, demo = true): HomeCardConfig[] {
  if (!Array.isArray(value)) return defaultHomeCards(demo);

  const seen = new Set<HomeCardId>();
  const out: HomeCardConfig[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const id = (raw as { id?: unknown }).id;
    if (typeof id !== 'string' || !IDS.has(id)) continue;
    if (seen.has(id as HomeCardId)) continue;
    seen.add(id as HomeCardId);

    const meta = HOME_CARD_META[id as HomeCardId];
    const size = (raw as { size?: unknown }).size;
    out.push({
      id: id as HomeCardId,
      size: meta.fullOnly === true || size !== 'half' ? 'full' : 'half',
    });
  }

  // 全删光了就退回出厂排布 —— 空白首页没有任何自救的入口
  return out.length > 0 ? out : defaultHomeCards(demo);
}

/** 一整行算 2 格，半宽算 1 格。用来判断这一屏还装不装得下。 */
export function homeCardWeight(cards: readonly HomeCardConfig[]): number {
  return cards.reduce((n, c) => n + (c.size === 'half' ? 1 : 2), 0);
}

/** 出厂排布是 4 张整宽 = 8 格。超出就要允许滚动，不能再硬裁。 */
export const HOME_WEIGHT_BUDGET = 8;