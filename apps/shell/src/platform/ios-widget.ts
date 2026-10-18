import { Capacitor, registerPlugin } from '@capacitor/core';
import { widgetSnapshot, type WidgetData } from './widget-data.ts';
import type { Platform } from './bootstrap.ts';
import { PROVIDERS } from '../plugins/builtin/academic/model.ts';
import { submissionEffectTracker, type SubmissionEffect } from './ios-submission-events.ts';

interface IOSWidgetBridge {
  setSnapshot(input: { snapshot: string; hasSyncedPlatforms: boolean }): Promise<void>;
  refreshRequest(): Promise<{ requested: boolean; requestedAt: number | null }>;
  finishRefresh(input: { requestedAt: number; error?: string }): Promise<void>;
  showSubmitted(input: { items: SubmissionEffect[] }): Promise<void>;
}

const IOSWidget = registerPlugin<IOSWidgetBridge>('MatrixWidget');
let disconnect: (() => void) | undefined;

/** Publishes the same task projection used by Android into the iOS App Group. */
export async function connectIOSWidget(platform: Platform): Promise<void> {
  disconnect?.();
  if (Capacitor.getPlatform() !== 'ios' || platform.academicSimulated) return;

  const detectSubmissions = submissionEffectTracker();
  let publishTail: Promise<void> = Promise.resolve();
  const publish = () => {
    const pending = publishTail.then(async () => {
      const data: WidgetData = {
        snapshots: platform.academic.snapshots,
        settings: platform.academic.settings,
        corrections: platform.academic.corrections,
        enabled: platform.academic.enabled,
        tasks: await platform.store.listTasks(),
        courses: await platform.store.listCourses(),
      };
      await IOSWidget.setSnapshot({ snapshot: JSON.stringify(widgetSnapshot(data, Date.now())),
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

  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    if (platform.academic.busy) return;
    clearTimeout(timer);
    timer = setTimeout(() => void safePublish(), 250);
  };
  const unsubscribeAcademic = platform.academic.subscribe(changed);
  const unsubscribeBus = platform.plugins.bus.subscribe(changed);
  const onVisibility = () => {
    if (document.visibilityState === 'visible') changed();
  };
  document.addEventListener('visibilitychange', onVisibility);

  // Foreground consumer only. Background execution still requires a native sync
  // service; an App Intent flag alone cannot start the Capacitor runtime.
  let refreshing = false;
  let reportedReadError = false;
  const requestPoll = setInterval(async () => {
    if (document.visibilityState !== 'visible' || refreshing || platform.academic.busy) return;
    refreshing = true;
    try {
      const request = await IOSWidget.refreshRequest();
      reportedReadError = false;
      if (request.requested && request.requestedAt !== null) {
        const providers = PROVIDERS.filter(provider => platform.academic.enabled[provider] !== false
          && platform.academic.snapshots.some(snapshot => snapshot.provider === provider));
        const errors: string[] = [];
        if (!providers.length) errors.push('请先在 App 登录平台并完成首次同步');
        for (const provider of providers) {
          try { await platform.academic.sync(provider); }
          catch (error) { errors.push(`${provider}：${String(error)}`); }
        }
        await publish();
        await IOSWidget.finishRefresh({ requestedAt: request.requestedAt,
          ...(errors.length ? { error: errors.join('；') } : {}) });
      }
    } catch (error) {
      if (!reportedReadError) platform.warnings.push(`iOS 小组件刷新失败：${String(error)}`);
      reportedReadError = true;
    } finally {
      refreshing = false;
    }
  }, 3000);

  disconnect = () => {
    unsubscribeAcademic();
    unsubscribeBus();
    clearTimeout(timer);
    clearInterval(requestPoll);
    document.removeEventListener('visibilitychange', onVisibility);
  };
  await safePublish();
}
