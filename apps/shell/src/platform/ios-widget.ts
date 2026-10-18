import { Capacitor, registerPlugin } from '@capacitor/core';
import { widgetSnapshot, type WidgetData } from './widget-data.ts';
import type { Platform } from './bootstrap.ts';
import { submissionEffectTracker, type SubmissionEffect } from './ios-submission-events.ts';

interface IOSWidgetBridge {
  setSnapshot(input: { data: string; snapshot: string; hasSyncedPlatforms: boolean }): Promise<void>;
  begin(input: { lease: string }): Promise<{ acquired: boolean; pending: string }>;
  end(input: { lease: string }): Promise<void>;
  acknowledge(input: { lease: string }): Promise<void>;
  refreshRequest(): Promise<{ requested: boolean; requestedAt: number | null }>;
  finishRefresh(input: { requestedAt: number; error?: string }): Promise<void>;
  showSubmitted(input: { items: SubmissionEffect[] }): Promise<void>;
}

const IOSWidget = registerPlugin<IOSWidgetBridge>('MatrixWidget');
let disconnect: (() => Promise<void>) | undefined;

/** Publishes the same task projection used by Android into the iOS App Group. */
export async function connectIOSWidget(platform: Platform): Promise<void> {
  await disconnect?.();
  if (Capacitor.getPlatform() !== 'ios' || platform.academicSimulated) return;

  let stopped = false;
  const detectSubmissions = submissionEffectTracker();
  let publishTail: Promise<void> = Promise.resolve();
  const publish = () => {
    const pending = publishTail.then(async () => {
      if(stopped)return;
      const data: WidgetData = {
        snapshots: platform.academic.snapshots,
        settings: platform.academic.settings,
        corrections: platform.academic.corrections,
        enabled: platform.academic.enabled,
        tasks: await platform.store.listTasks(),
        courses: await platform.store.listCourses(),
      };
      await IOSWidget.setSnapshot({ data: JSON.stringify(data), snapshot: JSON.stringify(widgetSnapshot(data, Date.now())),
        hasSyncedPlatforms: platform.academic.snapshots.some(snapshot => platform.academic.enabled[snapshot.provider] !== false) });
      const items = detectSubmissions(data, Date.now());
      if (items.length) await IOSWidget.showSubmitted({ items });
    });
    publishTail = pending.catch(() => undefined);
    return pending;
  };
  const safePublish = async () => {
    try { await publish(); }
    catch (error) { platform.warnings.push(`iOS 小组件发布失败：${String(error)}`); }
  };

  const readData = async (): Promise<WidgetData> => ({
    snapshots: platform.academic.snapshots, settings: platform.academic.settings,
    corrections: platform.academic.corrections, enabled: platform.academic.enabled,
    tasks: await platform.store.listTasks(), courses: await platform.store.listCourses(),
  });
  // Establish history before importing native results, so confirmed changes can
  // still play; the native event-id ledger suppresses duplicates.
  detectSubmissions(await readData(), Date.now());
  const previousGuard = platform.academic.guard;
  const nativeGuard: typeof previousGuard = async fn => {
    const lease = crypto.randomUUID();
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await IOSWidget.begin({ lease });
      if (!state.acquired) {
        await new Promise(resolve => setTimeout(resolve, 400));
        continue;
      }
      try {
        const snapshots = JSON.parse(state.pending);
        if (snapshots.length) {
          await platform.academic.importBackground(snapshots);
          await IOSWidget.acknowledge({ lease });
        }
        try { return await fn(); }
        finally { await safePublish(); }
      } finally { await IOSWidget.end({ lease }); }
    }
    throw new Error('平台后台同步尚未结束，请稍后重试');
  };
  platform.academic.guard = nativeGuard;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let publishing = false;
  let lastAcademic = '';
  const changed = () => {
    if (stopped || platform.academic.busy) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (publishing || stopped) return;
      publishing = true;
      void platform.academic.refreshBackground().catch(error => {
        platform.warnings.push(`iOS 组件数据更新失败：${String(error)}`);
      }).finally(() => { publishing = false; });
    }, 250);
  };
  const unsubscribeAcademic = platform.academic.subscribe(() => {
    const revision = JSON.stringify([platform.academic.settings, platform.academic.corrections,
      platform.academic.enabled, platform.academic.snapshots.map(s => [s.provider, s.syncedAt])]);
    if (revision === lastAcademic) return;
    lastAcademic = revision;
    changed();
  });
  const unsubscribeBus = platform.plugins.bus.subscribe(changed);
  const onVisibility = () => { if (document.visibilityState === 'visible') changed(); };
  document.addEventListener('visibilitychange', onVisibility);
  // No foreground request polling: the App Intent now owns actual networking.
  // Resume imports the durable native journal through the regular academic service.
  disconnect = async () => {
    stopped=true;
    unsubscribeAcademic();
    unsubscribeBus();
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    await publishTail;
    if(platform.academic.guard===nativeGuard)platform.academic.guard=previousGuard;
  };
  await platform.academic.refreshBackground();
}
