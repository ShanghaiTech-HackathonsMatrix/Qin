import { syncProvider } from './widget-runner.ts';
import { widgetSnapshot, type WidgetData } from './widget-data.ts';
import { submissionEffectTracker } from './ios-submission-events.ts';
import { PROVIDERS, type Provider } from '../plugins/builtin/academic/model.ts';
import type { PlannedRequest } from '@matrix/plugin-api';

export type NativePage = { body: string; status: number; url: string; headers?: Record<string, string> };
export type NativeRequest = (provider: Provider, request: PlannedRequest) => Promise<NativePage>;

/** Same connectors and projection as the app. Only the native transport differs. */
export async function refreshNativeWidget(data: WidgetData, request: NativeRequest, now = Date.now()) {
  // Never mutate the published input: a failed provider keeps its exact old snapshot.
  const next = JSON.parse(JSON.stringify(data)) as WidgetData;
  const track = submissionEffectTracker();
  track(data, now);
  const statuses: Record<string, string> = {};
  await Promise.all(PROVIDERS.filter(p => data.enabled[p] !== false && data.snapshots.some(s => s.provider === p)).map(async provider => {
    try {
      const snapshot = await syncProvider(provider, data, req => request(provider, req), now);
      next.snapshots = next.snapshots.filter(s => s.provider !== provider).concat(snapshot);
      statuses[provider] = '同步成功';
    } catch (error) {
      statuses[provider] = String(error).includes('LOGIN_REQUIRED') ? '需要重新登录' : `同步失败：${String(error)}`;
    }
  }));
  if (!Object.keys(statuses).length) throw new Error('请先在 App 登录平台并完成首次同步');
  return { data: next, snapshot: widgetSnapshot(next, Date.now()), statuses, submissions: track(next, now) };
}

declare const MatrixNative: {
  request(provider: string, request: string, id: string): void;
  finish(result: string): void;
};
let counter = 0;
const pending = new Map<string, { resolve: (page: NativePage) => void; reject: (error: Error) => void }>();
export function receive(id: string, raw: string) {
  const callback = pending.get(id);
  if (!callback) return;
  pending.delete(id);
  try {
    const response = JSON.parse(raw);
    if (response.error) callback.reject(new Error(response.error));
    else callback.resolve(response);
  } catch (error) { callback.reject(error instanceof Error ? error : new Error(String(error))); }
}
export function start(raw: string) {
  void refreshNativeWidget(JSON.parse(raw), (provider, request) => new Promise((resolve, reject) => {
    const id = String(++counter);
    pending.set(id, { resolve, reject });
    MatrixNative.request(provider, JSON.stringify(request), id);
  })).then(result => MatrixNative.finish(JSON.stringify(result)))
    .catch(error => MatrixNative.finish(JSON.stringify({ error: String(error) })));
}
