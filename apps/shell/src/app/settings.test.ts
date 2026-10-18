/**
 * 排布的出厂值与迁移。
 *
 * 运行：node src/app/settings.test.ts
 *
 * 这一段必须单独测：迁移写错的表现是「用户明明选了列表，下次打开又变回卡片」
 * 或者反过来 —— 界面看着完全正常，只有用户自己发现设置不听话。
 */

import { strict as assert } from 'node:assert';

import { DEFAULT_SETTINGS, LAYOUT_VERSION, migrateLayout } from './settings.ts';

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

test('出厂排布是卡片', () => {
  assert.equal(DEFAULT_SETTINGS.layout, 'cards');
  assert.equal(DEFAULT_SETTINGS.layoutVersion, LAYOUT_VERSION);
});

test('从没存过设置 → 卡片', () => {
  assert.equal(migrateLayout(undefined, undefined), 'cards');
});

test('第 1 版存下的 list 迁到卡片（那时开关是死的，不算用户选择）', () => {
  assert.equal(migrateLayout('list', undefined), 'cards');
  assert.equal(migrateLayout('list', 1), 'cards');
});

test('第 1 版存下的 cards 保持卡片', () => {
  assert.equal(migrateLayout('cards', 1), 'cards');
});

test('第 2 版之后用户自己选的列表被尊重', () => {
  assert.equal(migrateLayout('list', LAYOUT_VERSION), 'list');
  assert.equal(migrateLayout('cards', LAYOUT_VERSION), 'cards');
});

test('更早的版本号（0 或负数）也按老版本处理', () => {
  assert.equal(migrateLayout('list', 0), 'cards');
  assert.equal(migrateLayout('list', -3), 'cards');
});

test('存了垃圾值 → 回落到出厂值', () => {
  assert.equal(migrateLayout('grid', LAYOUT_VERSION), 'cards');
  assert.equal(migrateLayout(null, 2), 'cards');
  assert.equal(migrateLayout(42, 2), 'cards');
});

test('版本号不是数字时按第 1 版处理', () => {
  assert.equal(migrateLayout('list', '2'), 'cards');
  assert.equal(migrateLayout('list', null), 'cards');
});

test('迁移是幂等的 —— 反复跑不会来回翻', () => {
  const once = migrateLayout('list', 1);
  assert.equal(migrateLayout(once, LAYOUT_VERSION), once);
});

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} 项失败：${failures.join('、')}`);
  process.exitCode = 1;
} else {
  console.log(`全部通过：${passed} 项断言`);
}
