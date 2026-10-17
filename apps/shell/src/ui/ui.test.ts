/**
 * 控件 UI 系统（dev.md U1–U6）。
 *
 * 运行：node src/ui/ui.test.ts
 *
 * 这个文件能在 Node 里跑、不需要 jsdom，是因为渲染器用 `createElement` 而不是 JSX ——
 * 那是刻意的：UI 的可验证性不该依赖浏览器。
 */

import { strict as assert } from 'node:assert';

import type { ReactElement } from 'react';

import { parseAction, parseUiNode, type Action, type PluginExports, type UiNode, type ViewContext } from '@matrix/plugin-api';

import { MockTransport, createCore } from '../core/index.ts';
import { PluginHost } from '../core/plugin-host.ts';
import { LOCAL_URL, PLUGIN_ID, icsImporter, manifest, renders, views } from '../plugins/builtin/importer-ics/index.ts';
import type { SecureStore } from '../platform/strategies/kv/types.ts';
import { autoLayout, buildCatalog, instanceIdFor } from './catalog.ts';
import { LayoutStore, LAYOUT_LIMITS, parseLayout } from './layout.ts';
import { UiNodeView } from './render.ts';

// ---------------------------------------------------------------- 迷你测试框架

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  \u2713 ${name}`);
    })
    .catch((e: unknown) => {
      failures.push(name);
      console.log(`  \u2717 ${name}`);
      console.log(`      ${e instanceof Error ? e.message : String(e)}`);
    });
}

function section(t: string): void {
  console.log(`\n${t}`);
}

// ---------------------------------------------------------------- 夹具

class MemoryKv implements SecureStore {
  readonly encrypted = false;
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

const NOW = 1_700_000_000_000;

async function makeHost(): Promise<PluginHost> {
  const core = createCore({
    transport: new MockTransport(),
    gateway: { config: { allowlist: [] } },
  });
  const host = new PluginHost({
    core,
    modules: new Map<string, PluginExports>([[PLUGIN_ID, icsImporter]]),
    now: () => NOW,
  });
  const r = await host.install(manifest, { allowReservedPrefix: true });
  assert.equal(r.ok, true, r.ok ? '' : `${r.code} ${r.message}`);
  return host;
}

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'X-WR-CALNAME:高等数学',
  'BEGIN:VEVENT',
  'UID:e1@t',
  'SUMMARY:第一讲',
  'DTSTART;TZID=Asia/Shanghai:20250901T080000',
  'DTEND;TZID=Asia/Shanghai:20250901T094000',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

async function importIcs(host: PluginHost): Promise<void> {
  const p = host.provideLocal(PLUGIN_ID, LOCAL_URL, ICS);
  assert.equal(p.ok, true, p.ok ? '' : p.message);
  const r = await host.sync(PLUGIN_ID, { trigger: 'manual', now: NOW });
  host.clearLocal(PLUGIN_ID, LOCAL_URL);
  assert.equal(r.ok, true, r.ok ? '' : `${r.code} ${r.message}`);
}

/** 把 React 元素当普通对象看。React 元素就是 `{ type, props }`，不需要 DOM */
function propsOf(el: ReactElement | null): Record<string, any> {
  assert.ok(el !== null, '元素不该是 null');
  return (el as unknown as { props: Record<string, any> }).props;
}

function typeOf(el: ReactElement | null): unknown {
  assert.ok(el !== null, '元素不该是 null');
  return (el as unknown as { type: unknown }).type;
}

/** 递归收集一棵 UI 树里所有 Action —— 用来证明控件产出的动作宿主都认 */
function collectActions(node: UiNode, out: Action[] = []): Action[] {
  switch (node.type) {
    case 'button':
      out.push(node.onPress);
      break;
    case 'empty':
      if (node.action !== undefined) out.push(node.action.onPress);
      break;
    case 'stack':
    case 'card':
      for (const c of node.children) collectActions(c, out);
      break;
    case 'list':
      for (const c of node.items) collectActions(c, out);
      if (node.empty !== undefined) collectActions(node.empty, out);
      break;
    default:
      break;
  }
  return out;
}

function ctxOf(over: Partial<ViewContext> = {}): ViewContext {
  return {
    instanceId: 'w-test',
    props: {},
    records: [],
    ui: {},
    locale: 'zh-CN',
    capabilities: [],
    now: NOW,
    ...over,
  };
}

// ================================================================ 1. 渲染器

section('1. 渲染器：UiNode → React（不需要 jsdom）');

await test('text：tone 映射到 CSS 变量，不是裸色值', () => {
  const el = UiNodeView({ node: { type: 'text', text: 'hi', tone: 'danger' }, onAction: () => {} });
  assert.equal(typeOf(el), 'div');
  assert.equal(propsOf(el).style.color, 'var(--bad)');
  assert.equal(propsOf(el).children, 'hi');
});

await test('button：点击把 Action 原样递给宿主，渲染器不解释它', () => {
  const seen: Action[] = [];
  const action: Action = { kind: 'navigate', to: 'courses' };
  const el = UiNodeView({
    node: { type: 'button', label: '去课程', onPress: action },
    onAction: (a) => seen.push(a),
  });
  assert.equal(typeOf(el), 'button');
  propsOf(el).onClick();
  assert.deepEqual(seen, [action]);
});

await test('button：icon 是核心图标，不是 <img src>', () => {
  const el = UiNodeView({
    node: { type: 'button', label: 'x', icon: 'calendar', onPress: { kind: 'sync' } },
    onAction: () => {},
  });
  const kids = propsOf(el).children as ReactElement[];
  // 图标是函数组件，调用一次才拿到真正的 svg 元素
  const iconFn = typeOf(kids[0]!) as (p: { name: string }) => ReactElement;
  assert.equal(typeof iconFn, 'function', '图标必须是核心组件');
  const svg = iconFn({ name: 'calendar' });
  assert.equal(typeOf(svg), 'svg', '图标必须是内联 svg，不能是 img');
  assert.equal(propsOf(svg).stroke, 'currentColor', '必须跟着 color 走，才能适配主题');
});

await test('stack：gap / align 走档位表，插件拿不到裸数值', () => {
  const el = UiNodeView({
    node: { type: 'stack', direction: 'row', gap: 'lg', align: 'center', children: [] },
    onAction: () => {},
  });
  const s = propsOf(el).style;
  assert.equal(s.flexDirection, 'row');
  assert.equal(s.gap, 'calc(var(--gap) * 1.7)');
  assert.equal(s.alignItems, 'center');
});

await test('list：空列表且给了 empty 时渲染 empty', () => {
  const el = UiNodeView({
    node: { type: 'list', items: [], empty: { type: 'text', text: '空空如也' } },
    onAction: () => {},
  });
  // empty 是 UiNodeView 的递归调用，元素类型是函数本身
  assert.equal(propsOf(el).node.type, 'text');
});

await test('未知节点类型返回 null 而不是抛异常（不白屏）', () => {
  const el = UiNodeView({ node: { type: 'nope' } as unknown as UiNode, onAction: () => {} });
  assert.equal(el, null);
});

// ================================================================ 2. 目录

section('2. 控件目录：从 manifest 派生，不落盘');

await test('已装插件的视图出现在目录里，且有实现', async () => {
  const host = await makeHost();
  const cat = buildCatalog(host);

  const entry = cat.find(PLUGIN_ID, 'course-list');
  assert.ok(entry !== undefined, '目录里应当有 ICS 的 course-list');
  assert.equal(entry!.view.kind, 'widget');
  assert.equal(typeof entry!.render, 'function');
  assert.deepEqual(cat.issues, [], `不该有交叉核对警告，实际：${cat.issues.join('; ')}`);
});

await test('声明了没实现 / 实现了没声明，都会进 issues 而不是静默', async () => {
  const core = createCore({ transport: new MockTransport(), gateway: { config: { allowlist: [] } } });
  const host = new PluginHost({
    core,
    modules: new Map<string, PluginExports>([
      [PLUGIN_ID, { renders: { 'ghost-view': () => ({ type: 'divider' }) } }],
    ]),
    now: () => NOW,
  });
  await host.install(manifest, { allowReservedPrefix: true });

  const cat = buildCatalog(host);
  assert.ok(
    cat.issues.some((i) => i.includes('course-list') && i.includes('没有实现')),
    `应当报「声明了没实现」，实际：${cat.issues.join('; ')}`,
  );
  assert.ok(
    cat.issues.some((i) => i.includes('ghost-view') && i.includes('没在 manifest')),
    `应当报「实现了没声明」，实际：${cat.issues.join('; ')}`,
  );
});

await test('autoLayout 产出的 instanceId 都合法（能过 parseLayout）', async () => {
  const host = await makeHost();
  const cat = buildCatalog(host);
  const auto = autoLayout(cat);

  assert.ok(auto.length > 0, '至少要自动排出一个控件');
  const v = parseLayout({ version: 1, widgets: auto });
  assert.equal(v.ok, true, v.ok ? '' : v.message);
});

await test('instanceIdFor 对任意 id 都产出合法实例名', () => {
  for (const [p, v] of [
    ['app.matrix.importer.ics', 'course-list'],
    ['A.B/C', 'x y'],
    ['---', '---'],
  ] as const) {
    const id = instanceIdFor(p, v);
    assert.match(id, /^[a-z0-9][a-z0-9_-]*$/, `${p}/${v} → ${id}`);
  }
});

// ================================================================ 3. 布局文档

section('3. 布局文档：KV 存储 + 校验');

await test('合法布局被重建，未知字段被丢弃', () => {
  const v = parseLayout({
    version: 1,
    evil: 'x',
    widgets: [
      { instanceId: 'w1', pluginId: 'p', viewId: 'v', props: { a: 1 }, grid: { w: 6, h: 2 }, evil: 1 },
    ],
  });
  assert.equal(v.ok, true, v.ok ? '' : v.message);
  assert.deepEqual(v.data, {
    version: 1,
    widgets: [{ instanceId: 'w1', pluginId: 'p', viewId: 'v', props: { a: 1 }, grid: { w: 6, h: 2 } }],
  });
});

await test('布局校验：版本 / 重复实例 / 尺寸越界 / 数量超限 都被拒', () => {
  assert.equal(parseLayout({ version: 99, widgets: [] }).ok, false, '版本不对必须拒');
  assert.equal(
    parseLayout({
      version: 1,
      widgets: [
        { instanceId: 'a', pluginId: 'p', viewId: 'v' },
        { instanceId: 'a', pluginId: 'p', viewId: 'v' },
      ],
    }).ok,
    false,
    '重复 instanceId 必须拒 —— 否则两个控件会共享瞬时状态',
  );
  assert.equal(
    parseLayout({ version: 1, widgets: [{ instanceId: 'a', pluginId: 'p', viewId: 'v', grid: { w: 99, h: 1 } }] }).ok,
    false,
    '尺寸越界必须拒',
  );
  const many = Array.from({ length: LAYOUT_LIMITS.maxWidgets + 1 }, (_, i) => ({
    instanceId: `w${i}`,
    pluginId: 'p',
    viewId: 'v',
  }));
  assert.equal(parseLayout({ version: 1, widgets: many }).ok, false, '数量超限必须拒');
});

await test('LayoutStore 往返：存进去的读得回来', async () => {
  const kv = new MemoryKv();
  const store = new LayoutStore(kv);
  const doc = {
    version: 1,
    widgets: [{ instanceId: 'w1', pluginId: 'p', viewId: 'v', props: {}, grid: { w: 12, h: 1 } }],
  };
  const saved = await store.save(doc);
  assert.equal(saved.ok, true);

  const loaded = await store.load();
  assert.equal(loaded.issue, null);
  assert.deepEqual(loaded.doc, doc);
});

await test('LayoutStore：坏数据退回默认布局，并把原内容备份下来', async () => {
  const kv = new MemoryKv();
  const store = new LayoutStore(kv);
  await kv.set(store.key, '{ 这不是 JSON');

  const loaded = await store.load();
  assert.equal(loaded.issue !== null, true, '必须带出原因，不能静默');
  assert.deepEqual(loaded.doc, { version: 1, widgets: [] });
  assert.equal(
    (await kv.keys()).some((k) => k.includes('.corrupt.')),
    true,
    '用户手改过的内容是他唯一的一份，坏了也要留证',
  );
});

await test('LayoutStore：没有布局时返回默认，不算错误', async () => {
  const loaded = await new LayoutStore(new MemoryKv()).load();
  assert.equal(loaded.issue, null);
  assert.equal(loaded.doc.widgets.length, 0);
});

// ================================================================ 4. 第一个控件

section('4. 第一个控件：ICS 课程列表');

await test('render 是纯函数：同样 ctx 得到同样的树', async () => {
  const host = await makeHost();
  await importIcs(host);
  const records = host.bus.read('dev.matrix.shell', 'course').ok
    ? (host.bus.read('dev.matrix.shell', 'course') as { data: any[] }).data
    : [];
  const ctx = ctxOf({ records });

  const a = renders['course-list']!(ctx);
  const b = renders['course-list']!(ctx);
  assert.deepEqual(a, b);
  assert.notEqual(a, b, '不得返回同一个对象（那意味着内部缓存了状态）');
});

await test('控件产出的树能过 parseUiNode（安全边界）', async () => {
  const host = await makeHost();
  await importIcs(host);
  const read = host.bus.read('dev.matrix.shell', 'course');
  const records = read.ok ? read.data : [];
  const tree = renders['course-list']!(ctxOf({ records }));

  const parsed = parseUiNode(tree);
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.message);
});

await test('控件产出的**每一个** Action 宿主都认得', async () => {
  const host = await makeHost();
  await importIcs(host);
  const read = host.bus.read('dev.matrix.shell', 'course');
  const records = read.ok ? read.data : [];

  // 两种状态都要覆盖：有数据 / 无数据，showAll 开 / 关
  const trees = [
    renders['course-list']!(ctxOf({ records })),
    renders['course-list']!(ctxOf({ records, ui: { showAll: true } })),
    renders['course-list']!(ctxOf({ records: [] })),
  ];

  const actions = trees.flatMap((t) => collectActions(t));
  assert.ok(actions.length > 0, '控件应当至少产出一个动作');
  for (const a of actions) {
    const r = parseAction(a);
    assert.equal(r.ok, true, `控件产出了宿主不认的动作：${JSON.stringify(a)} → ${r.ok ? '' : r.message}`);
  }
});

await test('没数据时给出「去导入」按钮，且指向**真有导入入口**的那一页', () => {
  const tree = renders['course-list']!(ctxOf({ records: [] }));
  const actions = collectActions(tree);
  assert.equal(actions.length, 1);
  // 曾经指向 'settings'，而设置页里并没有导入入口（只在调试面板里）——
  // 用户点了等于走进死胡同。导入面板现在挂在「课程」页，所以必须指这里。
  assert.deepEqual(actions[0], { kind: 'navigate', to: 'courses' });
});

await test('控件 requires ⊆ 插件 permissions.data.read（否则会被画成权限提示）', () => {
  const granted = manifest.permissions?.data?.read ?? [];
  for (const v of views) {
    for (const t of v.requires ?? []) {
      assert.ok(
        granted.includes(t),
        `视图 ${v.id} 要求 ${t}，但 manifest 的 data.read 里没有 —— WidgetPage 会画成权限提示`,
      );
    }
  }
});

await test('同一份数据，showAll 开关真的改变输出（证明 ui 状态被用上了）', () => {
  const course = { type: 'course', id: 'c1', data: { title: '高等数学' }, updatedAt: NOW };
  const base = ctxOf({ records: [course] });
  const off = renders['course-list']!(base);
  const on = renders['course-list']!(ctxOf({ records: [course], ui: { showAll: true } }));

  // 关：这门课没有课时 → 被过滤掉；开：显示
  const textOf = (n: UiNode): string => JSON.stringify(n);
  assert.notEqual(textOf(off), textOf(on), 'ui 状态必须影响输出，否则 setUi 就是假的');
});

// ---------------------------------------------------------------- 收尾

console.log(
  failures.length === 0
    ? `\n全部通过：${passed} 项断言`
    : `\n失败 ${failures.length} 项 / 通过 ${passed} 项\n  ${failures.join('\n  ')}`,
);

if (failures.length > 0) process.exit(1);
