/**
 * C 段（DataBus 成唯一数据层）的一致性测试。
 *
 * 这里钉的是**接缝**，不是实现细节：
 *
 * 1. 记录 ↔ 领域对象两个方向必须成对（`project*` / `unproject*`）
 * 2. 按命名空间分流：核心 → 物理层，插件 → KV
 * 3. **删除要落盘**（`bus.drop` 曾经只删内存，重启后记录会复活）
 * 4. 重启后数据还在 —— 这是「真的存住了」的唯一证据
 * 5. 旧版本把核心记录写进过 KV，那份过期快照必须被清掉
 */

import { strict as assert } from 'node:assert';

import { DataBus, type DataBackend, type DataChange, type EntityRecord } from '@matrix/kernel';

import { BusTaskStore, type PhysicalStore } from './bus-task-store.ts';
import { CompositeBackend, CoreStoreBackend, type CoreStore } from './core-data-backend.ts';
import {
  CORE_ENTITY,
  CORE_NS,
  courseSchema,
  projectCourse,
  projectTask,
  taskSchema,
  unprojectCourse,
  unprojectTask,
} from './core-entities.ts';
import type { Course, Task } from '../domain/types.ts';

// ---------------------------------------------------------------- 测试框架

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (e: unknown) {
    failures.push(name);
    console.log(`  \u2717 ${name}`);
    console.log(`      ${e instanceof Error ? e.message : String(e)}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------- 假件

/** 物理持久化层的最小实现 —— 就是 `TaskStore` 去掉平台相关部分 */
class MemStore implements CoreStore, PhysicalStore {
  readonly backend = 'mem';
  tasks: Task[] = [];
  courses: Course[] = [];
  clears = 0;

  async info(): Promise<Record<string, string>> {
    return { backend: this.backend };
  }
  async close(): Promise<void> {
    return undefined;
  }

  async listTasks(): Promise<Task[]> {
    return this.tasks.map((t) => ({ ...t }));
  }
  async putTask(t: Task): Promise<void> {
    const i = this.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) this.tasks[i] = { ...t };
    else this.tasks.push({ ...t });
  }
  async deleteTask(id: string): Promise<void> {
    this.tasks = this.tasks.filter((x) => x.id !== id);
  }
  async listCourses(): Promise<Course[]> {
    return this.courses.map((c) => ({ ...c }));
  }
  async putCourse(c: Course): Promise<void> {
    const i = this.courses.findIndex((x) => x.id === c.id);
    if (i >= 0) this.courses[i] = { ...c };
    else this.courses.push({ ...c });
  }
  async deleteCourse(id: string): Promise<void> {
    this.courses = this.courses.filter((x) => x.id !== id);
  }
  async clearAll(): Promise<void> {
    this.clears += 1;
    this.tasks = [];
    this.courses = [];
  }
}

/** 模拟 KV 那一侧 */
class MemBackend implements DataBackend {
  records: EntityRecord[] = [];
  batches: DataChange[][] = [];

  async loadAll(): Promise<EntityRecord[]> {
    return this.records.map((r) => ({ ...r }));
  }
  async save(changes: readonly DataChange[]): Promise<void> {
    this.batches.push([...changes]);
    for (const c of changes) {
      if (c.kind === 'dropPlugin') {
        this.records = this.records.filter((r) => r.pluginId !== c.pluginId);
      } else if (c.kind === 'drop') {
        this.records = this.records.filter(
          (r) => !(r.pluginId === c.pluginId && r.type === c.type && r.id === c.id),
        );
      } else {
        const i = this.records.findIndex(
          (r) => r.pluginId === c.record.pluginId && r.type === c.record.type && r.id === c.record.id,
        );
        if (i >= 0) this.records[i] = c.record;
        else this.records.push(c.record);
      }
    }
  }
}

const NOW = Date.UTC(2025, 8, 1, 2, 0, 0);

const aTask = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  kind: 'ddl',
  title: `任务 ${id}`,
  courseId: null,
  dueAt: NOW + 3_600_000,
  status: 'open',
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});

const aCourse = (id: string, name: string): Course => ({
  id,
  name,
  code: 'MATH101',
  color: '#abc',
  createdAt: NOW,
  updatedAt: NOW,
});

/** 造一套「总线 + 分流后端 + 门面」 */
function makeLayer(): {
  store: MemStore;
  plugins: MemBackend;
  backend: CompositeBackend;
  bus: DataBus;
  facade: BusTaskStore;
} {
  const store = new MemStore();
  const plugins = new MemBackend();
  const backend = new CompositeBackend(new CoreStoreBackend(store), plugins);
  const bus = new DataBus({ backend });
  bus.declareSchema(CORE_NS, CORE_ENTITY.task, taskSchema);
  bus.declareSchema(CORE_NS, CORE_ENTITY.course, courseSchema);
  const facade = new BusTaskStore(store, bus);
  return { store, plugins, backend, bus, facade };
}

// ---------------------------------------------------------------- 1. 映射

section('1. 记录 ↔ 领域对象：两个方向必须成对');

await test('task 往返不丢字段', () => {
  const t = aTask('t1', { note: '带备注', courseId: 'c9' });
  const back = unprojectTask({ id: t.id, data: projectTask(t).data });
  assert.deepEqual(back, t);
});

await test('course 往返时 name ↔ title 互相翻译', () => {
  const c = aCourse('c1', '高等数学');
  const rec = projectCourse(c);
  assert.equal(rec.data.title, '高等数学', '记录里必须叫 title');
  assert.equal('name' in rec.data, false, '记录里不能还留着 name');

  const back = unprojectCourse({ id: c.id, data: rec.data });
  assert.deepEqual(back, c, '回到领域层必须还叫 name');
});

await test('脏数据降级而不是抛异常', () => {
  const t = unprojectTask({ id: 'x', data: { kind: 'zzz', status: '???', title: 42 } });
  assert.equal(t.kind, 'custom', '未知 kind 退到 custom');
  assert.equal(t.status, 'open', '未知 status 退到 open');
  assert.equal(t.title, '', '非字符串标题退成空串');
  assert.equal(t.dueAt, null);
});

await test('空字符串的可选字段不落键（schema 是 additionalProperties:false）', () => {
  const t = aTask('t1', { note: '' });
  assert.equal('note' in projectTask(t).data, false);
  const c: Course = { id: 'c1', name: 'x', code: '', color: '', createdAt: NOW, updatedAt: NOW };
  const d = projectCourse(c).data;
  assert.equal('code' in d, false);
  assert.equal('color' in d, false);
});

// ---------------------------------------------------------------- 2. 分流

section('2. 按命名空间分流');

await test('loadAll：核心记录来自物理层，且带上 CORE_NS', async () => {
  const store = new MemStore();
  store.tasks = [aTask('t1')];
  store.courses = [aCourse('c1', '课')];
  const recs = await new CoreStoreBackend(store).loadAll();

  assert.equal(recs.length, 2);
  assert.ok(recs.every((r) => r.pluginId === CORE_NS), '所有者必须是核心命名空间');
  assert.deepEqual(recs.map((r) => r.type).sort(), ['course', 'task']);
});

await test('save：核心变更进物理层，插件变更进 KV', async () => {
  const store = new MemStore();
  const kv = new MemBackend();
  const backend = new CompositeBackend(new CoreStoreBackend(store), kv);

  await backend.save([
    { kind: 'upsert', record: { type: 'task', id: 't1', pluginId: CORE_NS, data: projectTask(aTask('t1')).data, updatedAt: NOW, revision: 1 } },
    { kind: 'upsert', record: { type: 'session', id: 's1', pluginId: 'app.matrix.importer.ics', data: { title: 'x' }, updatedAt: NOW, revision: 1 } },
  ]);

  assert.equal(store.tasks.length, 1, '任务落进物理层');
  assert.equal(kv.records.length, 1, '插件实体落进 KV');
  assert.equal(kv.records[0]!.pluginId, 'app.matrix.importer.ics');
});

// ---------------------------------------------------------------- 3. 端到端

section('3. 门面：写入 / 删除 / 重启');

await test('putTask 之后物理层立刻有数据（await 的语义是「落盘了」）', async () => {
  const { store, facade } = makeLayer();
  await facade.putTask(aTask('t1'));

  assert.equal(store.tasks.length, 1, 'await 返回时就必须已经落盘');
  assert.equal(store.tasks[0]!.title, '任务 t1');
});

await test('listTasks 读的是总线，不是物理层', async () => {
  const { store, facade } = makeLayer();
  await facade.putTask(aTask('t1'));

  // 直接改物理层，总线不该看见 —— 反过来证明读路径走的是总线
  store.tasks = [];
  const list = await facade.listTasks();
  assert.equal(list.length, 1, '物理层被清空后，门面读到的仍是总线里的');
});

await test('删除会落盘 —— 重启后不会复活（内核 drop 入队的回归）', async () => {
  const { store, plugins, facade } = makeLayer();
  await facade.putTask(aTask('t1'));
  await facade.putTask(aTask('t2'));
  await facade.deleteTask('t1');

  assert.equal(store.tasks.length, 1, '物理层里只剩一条');
  assert.equal(store.tasks[0]!.id, 't2');

  // 模拟重启：全新总线 + 同一套后端
  const bus2 = new DataBus({ backend: new CompositeBackend(new CoreStoreBackend(store), plugins) });
  bus2.declareSchema(CORE_NS, CORE_ENTITY.task, taskSchema);
  bus2.declareSchema(CORE_NS, CORE_ENTITY.course, courseSchema);
  bus2.restore(await new CompositeBackend(new CoreStoreBackend(store), plugins).loadAll());

  const facade2 = new BusTaskStore(store, bus2);
  const list = await facade2.listTasks();
  assert.deepEqual(list.map((t) => t.id), ['t2'], '删掉的那条不该复活');
});

await test('课程走同一条路，且 name ↔ title 不丢', async () => {
  const { store, facade } = makeLayer();
  await facade.putCourse(aCourse('c1', '线性代数'));

  assert.equal(store.courses.length, 1);
  assert.equal(store.courses[0]!.name, '线性代数', '物理层拿到的是领域形状');

  const list = await facade.listCourses();
  assert.equal(list[0]!.name, '线性代数');
  assert.equal(list[0]!.code, 'MATH101');
});

await test('clearAll 清空两边，且只走一条路径', async () => {
  const { store, facade } = makeLayer();
  await facade.putTask(aTask('t1'));
  await facade.putCourse(aCourse('c1', '课'));
  await facade.clearAll();

  assert.equal(store.tasks.length, 0);
  assert.equal(store.courses.length, 0);
  assert.equal(store.clears, 1, '物理层是被 dropPlugin 触发的 clearAll 清的');
  assert.equal((await facade.listTasks()).length, 0, '总线也要空');
});

await test('stats 取自总线（flush 失败时物理层会落后，不能报它）', async () => {
  const { facade } = makeLayer();
  await facade.putTask(aTask('t1'));
  await facade.putCourse(aCourse('c1', '课'));
  assert.deepEqual(await facade.stats(), { tasks: 1, courses: 1 });
});

// ---------------------------------------------------------------- 4. 历史包袱

section('4. 旧版本残留在 KV 里的核心快照要清掉');

await test('loadAll 丢掉 KV 里的核心记录，并主动删除那个键', async () => {
  const store = new MemStore();
  store.tasks = [aTask('t1')];

  const kv = new MemBackend();
  // 模拟投影时代写进 KV 的核心记录（含一条用户在旧版本里已删掉的任务）
  kv.records = [
    { type: 'task', id: 't1', pluginId: CORE_NS, data: projectTask(aTask('t1')).data, updatedAt: NOW, revision: 3 },
    { type: 'task', id: 'ghost', pluginId: CORE_NS, data: projectTask(aTask('ghost')).data, updatedAt: NOW, revision: 1 },
    { type: 'session', id: 's1', pluginId: 'app.matrix.importer.ics', data: { title: '课时' }, updatedAt: NOW, revision: 1 },
  ];

  const recs = await new CompositeBackend(new CoreStoreBackend(store), kv).loadAll();

  const coreTaskIds = recs.filter((r) => r.pluginId === CORE_NS && r.type === 'task').map((r) => r.id);
  assert.deepEqual(coreTaskIds, ['t1'], '只能有物理层那条；ghost 是过期快照，必须消失');
  assert.equal(recs.some((r) => r.id === 's1'), true, '插件记录不受影响');

  assert.equal(kv.records.some((r) => r.pluginId === CORE_NS), false, 'KV 里那份要真的被删掉');
  assert.equal(kv.batches.length, 1);
  assert.equal(kv.batches[0]![0]!.kind, 'dropPlugin');
});

// ---------------------------------------------------------------- 收尾

console.log('\n============================================================');
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项断言`);
  process.exit(0);
} else {
  console.log(`失败 ${failures.length} 项 / 通过 ${passed} 项`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
