import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { refreshNativeWidget } from './ios-widget-runtime.ts';
import { syncProvider } from './widget-runner.ts';
import { defaultSettings, PROVIDERS } from '../plugins/builtin/academic/model.ts';
import { simulatedPage } from '../plugins/builtin/academic/simulate.ts';
import type { WidgetData } from './widget-data.ts';

const now = Date.now();
const empty = (): WidgetData => ({ snapshots: [], settings: defaultSettings(),
  corrections: { assignments: {}, lessons: {} }, enabled: {}, tasks: [], courses: [] });
async function fixture() {
  const data = empty();
  for (const provider of PROVIDERS) data.snapshots.push(await syncProvider(provider, data,
    async r => ({ body: simulatedPage(r.url, now) ?? '', status: 200, url: r.url }), now));
  return data;
}

test('原生后台连接器独立检查三个平台；失败平台保留旧快照且不改输入', async () => {
  const data = await fixture(), before = JSON.stringify(data), calls: string[] = [];
  const result = await refreshNativeWidget(data, async (provider, r) => {
    calls.push(provider);
    if (provider === 'blackboard') throw new Error('LOGIN_REQUIRED');
    return { body: simulatedPage(r.url, now) ?? '', status: 200, url: r.url };
  }, now + 1000);
  for (const provider of PROVIDERS) assert.ok(calls.includes(provider));
  assert.equal(result.statuses.blackboard, '需要重新登录');
  assert.equal(result.statuses.gradescope, '同步成功');
  assert.equal(result.statuses.eams, '同步成功');
  assert.deepEqual(result.data.snapshots.find(s => s.provider === 'blackboard'), data.snapshots.find(s => s.provider === 'blackboard'));
  assert.equal(JSON.stringify(data), before);
});

test('离线不清空DDL；未登录不发请求；只有新确认的提交触发特效', async () => {
  const data = await fixture();
  const failed = await refreshNativeWidget(data, async () => { throw new Error('offline'); }, now + 1000);
  assert.deepEqual(failed.data, data); assert.deepEqual(failed.submissions, []);
  await assert.rejects(refreshNativeWidget(empty(), async () => { throw new Error('不应调用'); }), /首次同步/);
  data.enabled = { blackboard: false, eams: false };
  const request = async (_provider: unknown, r: { url: string }) => ({
    body: (simulatedPage(r.url, now) ?? '').replaceAll('Not Submitted', 'Submitted'), status: 200, url: r.url,
  });
  const submitted = await refreshNativeWidget(data, request, now + 1000);
  assert.ok(submitted.submissions.length > 0);
  assert.ok(submitted.snapshot.items.length < failed.snapshot.items.length);
  const repeated = await refreshNativeWidget(submitted.data, request, now + 2000);
  assert.deepEqual(repeated.submissions, []);
});

test('发布用IIFE和URL桥在无浏览器上下文运行，异步请求与错误能完成', async () => {
  const data = await fixture(), calls: string[] = [];
  const shim = readFileSync(new URL('../../ios/App/App/MatrixWidgetURL.js', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../../dist/ios-widget-runtime.js', import.meta.url), 'utf8');
  let finish!: (raw: string) => void;
  const finished = new Promise<string>(resolve => { finish = resolve; });
  const context = vm.createContext({
    _matrixURL(raw: string, base: string) {
      const u = new URL(raw, base || undefined);
      return JSON.stringify({ protocol: u.protocol, hostname: u.hostname, origin: u.origin,
        authority: u.origin, username: u.username, password: u.password,
        pathname: u.pathname, search: u.search, hash: u.hash });
    },
    MatrixNative: {
      finish,
      request(provider: string, raw: string, id: string) {
        calls.push(provider); const r = JSON.parse(raw);
        setImmediate(() => {
          const page = provider === 'blackboard' ? { error: 'LOGIN_REQUIRED' }
            : { body: simulatedPage(r.url, now) ?? '', status: 200, url: r.url };
          vm.runInContext(`MatrixWidgetRuntime.receive(${JSON.stringify(id)}, ${JSON.stringify(JSON.stringify(page))})`, context);
        });
      },
    },
  });
  vm.runInContext(shim, context); vm.runInContext(script, context);
  vm.runInContext(`MatrixWidgetRuntime.start(${JSON.stringify(JSON.stringify(data))})`, context);
  const result = JSON.parse(await finished);
  assert.equal(result.statuses.gradescope, '同步成功');
  assert.equal(result.statuses.eams, '同步成功');
  assert.equal(result.statuses.blackboard, '需要重新登录');
  assert.ok(calls.length > 3);
});
