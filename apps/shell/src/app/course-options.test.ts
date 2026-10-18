/**
 * 「所属课程」下拉栏的候选合并。
 *
 * 运行：node src/app/course-options.test.ts
 *
 * 这段必须单独测：它把**本机课程**和**教务课表同步回来的课程**合到一起，
 * 而这两边的 id 来自完全不同的命名空间。合错了的表现很安静 ——
 * 下拉栏里多一条或少一条，没人会立刻发现，直到某条任务挂错了课。
 */

import { strict as assert } from 'node:assert';

import { groupCourseOptions, mergeCourseOptions } from './course-options.ts';

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

test('只有本机课程时，全部归到「本机」组', () => {
  const out = mergeCourseOptions(
    [{ id: 'course-1', name: '数据结构' }],
    [],
  );
  assert.deepEqual(out, [{ id: 'course-1', name: '数据结构', code: undefined, source: '本机' }]);
});

test('平台侧只认教务课表：互动教学平台、Gradescope 的课一律不进', () => {
  const out = mergeCourseOptions(
    [],
    [
      { provider: 'blackboard', courses: [{ id: 'bb:1', title: '操作系统' }] },
      { provider: 'gradescope', courses: [{ id: 'gs:1', title: '交互设计' }] },
      { provider: 'eams', courses: [{ id: 'eams:1', title: '编译原理', code: 'CS301' }] },
    ],
  );
  assert.deepEqual(out.map((c) => c.name), ['编译原理'], '只有教务课表的课能进来');
  assert.deepEqual(out.map((c) => c.source), ['教务课表']);
});

test('同一门课在别的平台也有，也只按教务课表那一条算 —— 列表里不会出现两条', () => {
  const out = mergeCourseOptions(
    [],
    [
      { provider: 'blackboard', courses: [{ id: 'bb:os', title: '操作系统' }] },
      { provider: 'eams', courses: [{ id: 'eams:os', title: '操作系统', code: 'CS101' }] },
    ],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'eams:os');
  assert.equal(out[0].code, 'CS101');
});

test('本机课程排前面，教务课表的课跟在后面', () => {
  const out = mergeCourseOptions(
    [{ id: 'course-1', name: '数据结构' }],
    [{ provider: 'eams', courses: [{ id: 'eams:1', title: '编译原理', code: 'CS301' }] }],
  );
  assert.deepEqual(out.map((c) => c.name), ['数据结构', '编译原理']);
  assert.deepEqual(out.map((c) => c.source), ['本机', '教务课表']);
});

test('同 id 只留一条，本机的名字赢（用户改过的不被同步覆盖）', () => {
  const out = mergeCourseOptions(
    [{ id: 'shared', name: '我改过的名字' }],
    [{ provider: 'eams', courses: [{ id: 'shared', title: '平台原名' }] }],
  );
  assert.equal(out.length, 1, '重复的课程不该出现两次');
  assert.equal(out[0].name, '我改过的名字');
  assert.equal(out[0].source, '本机');
});

test('教务课表自己给了重复 id 时也只留第一条', () => {
  const out = mergeCourseOptions(
    [],
    [{ provider: 'eams', courses: [{ id: 'dup', title: '甲' }, { id: 'dup', title: '乙' }] }],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, '甲');
});

test('空字符串的 code 变成 undefined，不留一个空的「· 」', () => {
  const out = mergeCourseOptions(
    [{ id: 'a', name: '甲', code: '' }],
    [{ provider: 'eams', courses: [{ id: 'b', title: '乙', code: '' }] }],
  );
  assert.equal(out[0].code, undefined);
  assert.equal(out[1].code, undefined);
});

test('分组：本机在前、教务课表在后，组内顺序不乱', () => {
  const out = mergeCourseOptions(
    [{ id: 'own', name: '本机的课' }],
    [{ provider: 'eams', courses: [{ id: 'e1', title: '甲' }, { id: 'e2', title: '乙' }] }],
  );
  const groups = groupCourseOptions(out);
  assert.deepEqual(groups.map(([label]) => label), ['本机', '教务课表']);
  assert.deepEqual(groups[1][1].map((c) => c.name), ['甲', '乙']);
});

test('没有课程时不崩，返回空数组（界面自己显示提示）', () => {
  assert.deepEqual(mergeCourseOptions([], []), []);
  assert.deepEqual(groupCourseOptions([]), []);
});

test('平台一门课都没同步到、只有别的平台有数据时，列表是空的而不是混进来', () => {
  const out = mergeCourseOptions([], [{ provider: 'blackboard', courses: [{ id: 'b1', title: '操作系统' }] }]);
  assert.deepEqual(out, []);
});

console.log('');
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：${failures.join('、')}`);
  process.exitCode = 1;
} else {
  console.log(`全部通过：${passed} 项断言`);
}
