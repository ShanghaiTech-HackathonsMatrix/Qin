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
    真实模式：三张有真实数据的卡。
    插件控件区（`widgets`）不再默认摆上来 —— 它当前唯一的内容是一张
    「课程」卡，而课程已经有了自己的「课表」页，摆在首页是重复的。
    想要的话在「定制 → 添加卡片」里加回来，路没堵死。
  */
  return [
    { id: 'hero', size: 'full' },
    { id: 'next-class', size: 'full' },
    { id: 'ddl', size: 'full' },
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

/**
 * 出厂排布的迁移版本。
 *
 * 改出厂排布时要 +1，并在 `migrateHomeCards` 里补一条 —— 否则已经装过
 * 应用的机器会一直用着存下来的旧排布，改了等于没改。
 */
export const HOME_CARDS_VERSION = 2;

/**
 * 把旧版本存下来的排布迁移到当前版本。
 *
 * 迁移只做**一次**：靠 `homeCardsVersion` 记着迁过没有。所以「摘掉某张卡」
 * 不会被解释成「用户永远不能有这张卡」—— 之后在定制里加回来是用户的自由。
 */
export function migrateHomeCards(
  cards: readonly HomeCardConfig[],
  from: number,
  demo: boolean,
): HomeCardConfig[] {
  let out = [...cards];
  if (from < 2) {
    /*
      v2：课程有了自己的「课表」页。首页那张「插件卡片」当前唯一的内容
      就是一张「课程」卡，同一件事在首页和课表页各说一遍，去掉。
    */
    const kept = out.filter((c) => c.id !== 'widgets');
    out = kept.length > 0 ? kept : defaultHomeCards(demo);
  }
  return out;
}

/** 一张卡在屏幕上的矩形 —— `getBoundingClientRect()` 里判定要用的那四个数。 */
export interface SlotRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 手指（或鼠标）当前压在第几张卡上。`-1` = 一张卡都没沾到。
 *
 * 拖动排序时每动一下就问它一次，所以判定必须是**纯函数**：
 * 这里错一格，用户看到的就是「拖 A 动了 B」，而这件事跟 React、
 * 跟指针事件都无关，可以在 Node 里直接钉住。
 *
 * 两条规则合起来用，缺一条都会出事：
 *   · **先看命中框** —— 点在某张卡里就是它。只按 Y 判的话，
 *     同一行左右两张半宽卡 Y 完全一样，横着拖过去永远不换位。
 *   · **没命中就取中心最近的那张** —— 手指落在卡片之间的缝里、
 *     或者拖到列表上方的空白处时，总得有个落点；
 *     返回 -1 等于「拖到缝里就松手不算」，手感会莫名其妙地断掉。
 */
export function pickDropIndex(rects: readonly SlotRect[], x: number, y: number): number {
  let nearest = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < rects.length; i += 1) {
    const r = rects[i]!;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;

    const dx = x - (r.left + r.right) / 2;
    const dy = y - (r.top + r.bottom) / 2;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      nearest = i;
    }
  }

  return nearest;
}

/** 一整行算 2 格，半宽算 1 格。用来判断这一屏还装不装得下。 */
export function homeCardWeight(cards: readonly HomeCardConfig[]): number {
  return cards.reduce((n, c) => n + (c.size === 'half' ? 1 : 2), 0);
}

/** 出厂排布是 4 张整宽 = 8 格。超出就要允许滚动，不能再硬裁。 */
export const HOME_WEIGHT_BUDGET = 8;