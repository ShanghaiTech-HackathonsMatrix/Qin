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
  homeCardWeight,
  normalizeHomeCards,
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

test('真实模式的出厂排布：有数据的卡 + 插件控件区', () => {
  const ids = defaultHomeCards(false).map((c) => c.id);
  assert.ok(ids.includes('ddl'), 'DDL 卡已接上核心任务，该有默认位置');
  assert.ok(ids.includes('widgets'), '插件控件区要有个默认位置（首次使用靠它引导导入课表）');
  assert.ok(!ids.includes('atlas'), '图鉴是装饰性的，留给用户自己加');
  assert.ok(homeCardWeight(defaultHomeCards(false)) <= HOME_WEIGHT_BUDGET);
});

test('脏输入在真实模式下也退回真实模式的出厂排布', () => {
  assert.deepEqual(normalizeHomeCards(null, false), defaultHomeCards(false));
});

console.log(
  failures.length === 0
    ? `\n全部通过：${passed} 项断言`
    : `\n失败 ${failures.length} 项 / 通过 ${passed} 项\n  ${failures.join('\n  ')}`,
);

if (failures.length > 0) process.exit(1);