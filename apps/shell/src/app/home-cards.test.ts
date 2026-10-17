/**
 * 首页卡片定制的数据层（app/home-cards.ts）。
 *
 * 运行：node src/app/home-cards.test.ts
 *
 * 为什么这几条值得测：`homeCards` 是**用户可改、且会从旧版本读回来**的数据。
 * 一个未知 id 或者重复项漏进视图，轻则渲染出两张一样的卡，重则整页白屏 ——
 * 所以收敛逻辑（normalizeHomeCards）必须自己扛住脏输入，不能指望调用方先洗干净。
 */

import { strict as assert } from 'node:assert';

import {
  DEFAULT_HOME_CARDS,
  HOME_CARD_META,
  HOME_CARD_ORDER,
  HOME_WEIGHT_BUDGET,
  defaultHomeCards,
  migrateHomeCards,
  homeCardWeight,
  normalizeHomeCards,
  pickDropIndex,
} from './home-cards.ts';

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (e: unknown) {
    failures.push(name);
    console.log(`  \u2717 ${name}`);
    console.log(`      ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log('\n首页卡片：出厂排布');

test('出厂排布必须一屏装得下（不超过格数预算）', () => {
  assert.ok(homeCardWeight(DEFAULT_HOME_CARDS) <= HOME_WEIGHT_BUDGET);
});

test('出厂排布里每张卡都是已知 id 且不重复', () => {
  const ids = DEFAULT_HOME_CARDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(id in HOME_CARD_META);
});

test('每张卡都有中文名与说明，添加面板才不至于出现空白项', () => {
  for (const id of HOME_CARD_ORDER) {
    assert.ok(HOME_CARD_META[id].name.length > 0, `${id} 缺名字`);
    assert.ok(HOME_CARD_META[id].hint.length > 0, `${id} 缺说明`);
  }
});

test('标了 fullOnly 的卡，即使写 half 也会被拉回整宽', () => {
  const only = normalizeHomeCards([{ id: 'hero', size: 'half' }]);
  assert.equal(only[0]?.size, 'full');
});

console.log('\n首页卡片：脏输入');

test('非数组一律退回出厂排布', () => {
  for (const bad of [null, undefined, 42, 'x', {}, []]) {
    assert.deepEqual(normalizeHomeCards(bad), DEFAULT_HOME_CARDS, `输入 ${JSON.stringify(bad)}`);
  }
});

test('未知 id 与坏元素被丢掉，其余保留原顺序', () => {
  const out = normalizeHomeCards([
    { id: 'nope', size: 'full' },
    'garbage',
    null,
    { id: 'ddl', size: 'full' },
    { id: 'schedule', size: 'half' },
  ]);
  assert.deepEqual(out.map((c) => c.id), ['ddl', 'schedule']);
});

test('重复 id 只留第一次出现的那个', () => {
  const out = normalizeHomeCards([
    { id: 'ddl', size: 'half' },
    { id: 'ddl', size: 'full' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.size, 'half');
});

test('非法 size 一律当整宽，不猜', () => {
  const out = normalizeHomeCards([{ id: 'ddl', size: 'huge' }, { id: 'atlas' }]);
  assert.deepEqual(out.map((c) => c.size), ['full', 'full']);
});

test('返回的是新数组，改它不会污染出厂常量', () => {
  const out = normalizeHomeCards(DEFAULT_HOME_CARDS);
  out[0]!.size = 'half';
  assert.equal(DEFAULT_HOME_CARDS[0]!.size, 'full');
});

console.log('\n首页卡片：格数');

test('整宽算 2 格、半宽算 1 格', () => {
  assert.equal(homeCardWeight([{ id: 'ddl', size: 'full' }]), 2);
  assert.equal(homeCardWeight([{ id: 'ddl', size: 'half' }]), 1);
  assert.equal(homeCardWeight([{ id: 'ddl', size: 'half' }, { id: 'atlas', size: 'half' }]), 2);
});

test('多一张整宽就超预算 —— 首页要让位给滚动', () => {
  const extra = [...DEFAULT_HOME_CARDS, { id: 'schedule' as const, size: 'full' as const }];
  assert.ok(homeCardWeight(extra) > HOME_WEIGHT_BUDGET);
});

test('真实模式的出厂排布：只留三张有数据的卡', () => {
  const ids = defaultHomeCards(false).map((c) => c.id);
  assert.ok(ids.includes('ddl'), 'DDL 卡已接上核心任务，该有默认位置');
  assert.ok(ids.includes('next-class'), '下一节课是首页最该先看到的一条');
  assert.ok(!ids.includes('atlas'), '图鉴是装饰性的，留给用户自己加');
  /*
    插件控件区（`widgets`）**不再默认摆上来**：它当前唯一的内容是一张「课程」卡，
    而课程已经有了独立的「课表」页，摆在首页是同一件事说两遍。
    它仍然在可选列表里 —— 下面这条断言就是在钉住「路没堵死」。
  */
  assert.ok(!ids.includes('widgets'), '课程卡不该占着首页，课程已经进了课表页');
  assert.ok(HOME_CARD_ORDER.includes('widgets'), '但用户仍然可以自己把它加回来');
  assert.ok(homeCardWeight(defaultHomeCards(false)) <= HOME_WEIGHT_BUDGET);
});

test('v1 排布迁移：摘掉插件卡片，其余原样保留', () => {
  const old = normalizeHomeCards([
    { id: 'hero', size: 'full' },
    { id: 'widgets', size: 'full' },
    { id: 'ddl', size: 'half' },
  ], false);
  const migrated = migrateHomeCards(old, 1, false);
  assert.deepEqual(migrated.map((c) => c.id), ['hero', 'ddl']);
  assert.equal(migrated[1].size, 'half', '迁移不能顺手改用户调过的尺寸');
});

test('迁过的不再摘：用户之后自己加回来就一直是他的', () => {
  const withWidgets = normalizeHomeCards([
    { id: 'hero', size: 'full' },
    { id: 'widgets', size: 'full' },
  ], false);
  assert.deepEqual(migrateHomeCards(withWidgets, 2, false).map((c) => c.id), ['hero', 'widgets']);
});

test('迁移后一张不剩就退回出厂排布，不给空白首页', () => {
  const onlyWidgets = normalizeHomeCards([{ id: 'widgets', size: 'full' }], false);
  const migrated = migrateHomeCards(onlyWidgets, 1, false);
  assert.ok(migrated.length > 0);
  assert.ok(!migrated.some((c) => c.id === 'widgets'));
});

test('脏输入在真实模式下也退回真实模式的出厂排布', () => {
  assert.deepEqual(normalizeHomeCards(null, false), defaultHomeCards(false));
});

console.log('\n首页卡片：拖动落点');
/*
  这几条钉的是「手指压在哪张卡上」。定制态下整张卡都能拖，每动一下就问
  一次这个函数，所以它错一格，用户看到的就是「拖 A 动了 B」。
  它跟 React、跟指针事件都没关系，正是该在这里测的那种逻辑。
*/

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

test('点在卡里就是那张卡', () => {
  const rects = [rect(0, 0, 360, 100), rect(0, 100, 360, 200)];
  assert.equal(pickDropIndex(rects, 180, 50), 0);
  assert.equal(pickDropIndex(rects, 180, 150), 1);
});

test('同一行左右两张半宽卡：横着拖也能换位', () => {
  // 只看 Y 的判定在这里会永远返回 0，卡片就再也换不了位
  const rects = [rect(0, 0, 180, 100), rect(180, 0, 360, 100)];
  assert.equal(pickDropIndex(rects, 60, 50), 0);
  assert.equal(pickDropIndex(rects, 300, 50), 1);
});

test('边界点算在卡里（左闭右闭），不会掉进「哪儿都不是」', () => {
  const rects = [rect(0, 0, 100, 100), rect(0, 100, 100, 200)];
  assert.equal(pickDropIndex(rects, 0, 0), 0);
  assert.equal(pickDropIndex(rects, 100, 100), 0);
});

test('落在卡片之间的缝里就取最近的那张，不返回 -1', () => {
  // 缝里松手应该是「就近落下」，而不是「这次拖动白做」
  const rects = [rect(0, 0, 100, 100), rect(0, 120, 100, 220)];
  assert.equal(pickDropIndex(rects, 50, 105), 0);
  assert.equal(pickDropIndex(rects, 50, 115), 1);
});

test('拖到列表上方的空白处 → 落到第一张，拖到下方 → 落到最后一张', () => {
  const rects = [rect(0, 100, 100, 200), rect(0, 200, 100, 300)];
  assert.equal(pickDropIndex(rects, 50, 0), 0);
  assert.equal(pickDropIndex(rects, 50, 999), 1);
});

test('一张卡都没有时返回 -1，调用方据此什么都不做', () => {
  assert.equal(pickDropIndex([], 10, 10), -1);
});

console.log(
  failures.length === 0
    ? `\n全部通过：${passed} 项断言`
    : `\n失败 ${failures.length} 项 / 通过 ${passed} 项\n  ${failures.join('\n  ')}`,
);

if (failures.length > 0) process.exit(1);