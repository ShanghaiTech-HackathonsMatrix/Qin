/**
 * 同步失败后的分类与补救判断。
 *
 * 运行：node src/core/sync-errors.test.ts
 *
 * `needsDeepScan` 决定「同步」失败后要不要自动改走逐门课扫描 —— 也就是原来那个
 * 单独的「扫描课程目录」按钮。写错的两个方向都很难在真实站点上复现：
 * 判太宽会把真实错误吞掉、改成慢扫描，用户只看到「怎么这么慢」；
 * 判太窄则该补救时不补救，互动教学平台整块同步直接失败。
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { needsDeepScan } from './sync-errors.ts';

test('互动教学平台读不到待完成作业模块 → 改走深度扫描', () => {
  assert.equal(needsDeepScan('blackboard', '未识别 BB 待完成作业模块，已保留历史数据'), true);
});

test('其它平台的同类文案不触发 —— 只有 BB 有这条路', () => {
  assert.equal(needsDeepScan('gradescope', '未识别 BB 待完成作业模块'), false);
  assert.equal(needsDeepScan('eams', '未识别 BB 待完成作业模块'), false);
});

test('登录过期、网络错误这类真实故障不吞掉，照常抛出', () => {
  assert.equal(needsDeepScan('blackboard', '平台返回 HTTP 401'), false);
  assert.equal(needsDeepScan('blackboard', '登录已过期，请重新登录'), false);
  assert.equal(needsDeepScan('blackboard', '请求超时'), false);
});

test('空字符串不触发', () => {
  assert.equal(needsDeepScan('blackboard', ''), false);
});
