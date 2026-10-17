import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Course, Task } from './domain/types';
import { PlatformInitError, type Platform } from './platform/bootstrap';
import { saveOverrides, type Overrides } from './platform/overrides';
import type { ResolutionReport } from './platform/strategies/types';
import { applySettings, DEFAULT_SETTINGS, loadSettings, saveSettings, type AppSettings } from './app/settings';
import { loadPlatform } from './app/platform';
import { uid } from './app/format';
import TimelineView from './views/TimelineView';
import CoursesView from './views/CoursesView';
import SettingsView from './views/SettingsView';
import TaskEditor from './components/TaskEditor';
import DebugPanel from './components/DebugPanel';
import { LayoutStore } from './ui/layout';
import { WidgetPage } from './ui/WidgetPage';

type Tab = 'home' | 'timeline' | 'courses' | 'settings';

type Boot =
  | { status: 'loading' }
  | { status: 'ready'; platform: Platform }
  | { status: 'error'; error: unknown; report?: ResolutionReport };

export default function App() {
  const [boot, setBoot] = useState<Boot>({ status: 'loading' });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [tab, setTab] = useState<Tab>('home');
  const [debugOpen, setDebugOpen] = useState(false);
  const [editor, setEditor] = useState<{ open: boolean; task: Task | null }>({ open: false, task: null });
  const [toast, setToast] = useState<string | null>(null);

  // ---------------------------------------------------------------- 启动

  const start = useCallback(async (force = false): Promise<Platform | null> => {
    setBoot({ status: 'loading' });
    try {
      const platform = await loadPlatform(force);
      const s = await loadSettings(platform.kv);
      setSettings(s);
      applySettings(s);
      setBoot({ status: 'ready', platform });
      return platform;
    } catch (e) {
      setBoot({
        status: 'error',
        error: e,
        report: e instanceof PlatformInitError ? e.report : undefined,
      });
      return null;
    }
  }, []);

  useEffect(() => { void start(); }, [start]);

  const platform = boot.status === 'ready' ? boot.platform : null;

  // ---------------------------------------------------------------- 数据

  const reload = useCallback(async () => {
    if (!platform) return;
    const [t, c] = await Promise.all([platform.store.listTasks(), platform.store.listCourses()]);
    setTasks(t);
    setCourses(c);
  }, [platform]);

  useEffect(() => { void reload(); }, [reload]);

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((cur) => (cur === m ? null : cur)), 2200);
  }, []);

  const saveTask = useCallback(async (t: Task) => {
    if (!platform) return;
    await platform.store.putTask(t);
    setEditor({ open: false, task: null });
    await reload();
  }, [platform, reload]);

  const deleteTask = useCallback(async (id: string) => {
    if (!platform) return;
    await platform.store.deleteTask(id);
    setEditor({ open: false, task: null });
    await reload();
  }, [platform, reload]);

  const toggleDone = useCallback(async (t: Task) => {
    if (!platform) return;
    await platform.store.putTask({
      ...t,
      status: t.status === 'done' ? 'open' : 'done',
      updatedAt: Date.now(),
    });
    await reload();
  }, [platform, reload]);

  const saveCourse = useCallback(async (c: Course) => {
    if (!platform) return;
    await platform.store.putCourse(c);
    await reload();
  }, [platform, reload]);

  const deleteCourse = useCallback(async (id: string) => {
    if (!platform) return;
    await platform.store.deleteCourse(id);
    await reload();
  }, [platform, reload]);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    if (!platform) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    applySettings(next);
    await saveSettings(platform.kv, next);
  }, [platform, settings]);

  // ---------------------------------------------------------------- 策略切换

  /**
   * 应用策略覆盖并重新自检。
   *
   * 换「业务数据存储」后端时会把旧后端的数据**自动搬到新后端** ——
   * 但只在目标后端为空时搬。否则容易让人以为「切一下就丢数据了」。
   *
   * 之所以要显式关闭旧后端：SQLite 按名字复用连接，
   * 不先放开旧句柄的话，新后端可能拿到旧后端的连接。
   */
  const applyOverrideChange = useCallback(async (o: Overrides) => {
    const prev = platform;
    const storeChanged = o.store !== (prev?.overrides.store ?? null);

    let snap: { tasks: Task[]; courses: Course[] } | null = null;
    if (storeChanged && prev) {
      try {
        snap = {
          tasks: await prev.store.listTasks(),
          courses: await prev.store.listCourses(),
        };
      } catch {
        snap = null;   // 旧后端读不出来就算了，不能因此挡住切换
      }
    }

    saveOverrides(o);
    flash('正在重新自检并切换策略…');

    if (storeChanged && prev) {
      await prev.store.close().catch(() => undefined);
    }

    const next = await start(true);
    if (!next) return;

    if (snap && (snap.tasks.length > 0 || snap.courses.length > 0)) {
      try {
        const stats = await next.store.stats();
        if (stats.tasks === 0 && stats.courses === 0) {
          for (const t of snap.tasks) await next.store.putTask(t);
          for (const c of snap.courses) await next.store.putCourse(c);
          // 直接读新后端刷新界面，避免和 boot 触发的 reload 抢时序
          const [t, c] = await Promise.all([next.store.listTasks(), next.store.listCourses()]);
          setTasks(t);
          setCourses(c);
          flash(`已迁移 ${snap.tasks.length} 条任务、${snap.courses.length} 门课程`);
          return;
        }
        flash(`新后端已有数据（${stats.tasks} 条任务），未自动迁移`);
        return;
      } catch (e) {
        flash(`迁移失败：${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }

    flash('策略已重新解析');
  }, [start, flash, platform]);

  const resetAllData = useCallback(async () => {
    if (!platform) return;
    await platform.store.clearAll();
    await reload();
    flash('数据已清空');
  }, [platform, reload, flash]);

  // ---------------------------------------------------------------- 统计

  const openCount = useMemo(
    () => tasks.filter((t) => t.status === 'open').length,
    [tasks],
  );

  // 布局文档的读写口。用户「这一页摆什么」的真相在 KV 里，不在代码里
  const layoutStore = useMemo(
    () => (boot.status === 'ready' ? new LayoutStore(boot.platform.kv) : null),
    [boot],
  );

  // 控件里的 `navigate` 动作只能递一个字符串过来，这里把它收窄成合法标签页
  const goTab = useCallback((to: string) => {
    setTab(to === 'timeline' || to === 'courses' || to === 'settings' ? to : 'home');
  }, []);

  // ---------------------------------------------------------------- 渲染

  if (boot.status === 'loading') {
    return (
      <div className="boot">
        <div className="spinner" />
        <div className="muted">正在启动自检…</div>
        <div className="faint">逐个探测存储与加密策略，首个可用者胜出</div>
      </div>
    );
  }

  if (boot.status === 'error') {
    const msg = boot.error instanceof Error ? boot.error.message : String(boot.error);
    return (
      <div className="boot">
        <div className="alert alert--bad">
          <strong>启动失败</strong>
          <div style={{ marginTop: 6 }}>{msg}</div>
        </div>
        {boot.report && (
          <pre className="diag" style={{ textAlign: 'left', width: '100%' }}>
            {JSON.stringify(boot.report, null, 2)}
          </pre>
        )}
        <button className="btn btn--primary" onClick={() => void start(true)}>重试</button>
      </div>
    );
  }

  const p = boot.platform;

  return (
    <div className="app">
      <div className="topbar">
        <div>
          <div className="topbar__title">
            {tab === 'timeline' ? '时间线' : tab === 'courses' ? '课程' : '设置'}
          </div>
          <div className="topbar__sub">
            {p.store.backend} · {p.kv.encrypted ? '密钥受系统保护' : '密钥未受保护'}
          </div>
        </div>
        <div className="topbar__spacer" />
        {tab === 'timeline' && (
          <button className="btn btn--primary btn--sm" onClick={() => setEditor({ open: true, task: null })}>
            ＋ 新建
          </button>
        )}
      </div>

      <div className="app__body">
        {p.warnings.length > 0 && tab === 'timeline' && (
          <div className="alert alert--warn" style={{ marginBottom: 'var(--gap)' }}>
            <strong>已降级运行</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {p.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}

        {tab === 'home' && layoutStore !== null && (
          <WidgetPage host={p.plugins} layout={layoutStore} onNavigate={goTab} />
        )}

        {tab === 'timeline' && (
          <TimelineView
            tasks={tasks}
            courses={courses}
            onToggle={(t) => void toggleDone(t)}
            onEdit={(t) => setEditor({ open: true, task: t })}
          />
        )}

        {tab === 'courses' && (
          <CoursesView
            courses={courses}
            tasks={tasks}
            onSave={(c) => void saveCourse(c)}
            onDelete={(id) => void deleteCourse(id)}
          />
        )}

        {tab === 'settings' && (
          <SettingsView
            platform={p}
            settings={settings}
            onChange={(patch) => void updateSettings(patch)}
            onOpenDebug={() => setDebugOpen(true)}
            onResetData={() => void resetAllData()}
          />
        )}
      </div>

      <div className="tabbar">
        {([
          ['home', '首页'],
          ['timeline', `时间线${openCount ? ` (${openCount})` : ''}`],
          ['courses', '课程'],
          ['settings', '设置'],
        ] as const).map(([id, label]) => (
          <button key={id} data-active={tab === id} onClick={() => setTab(id)}>
            <span className="tabbar__dot" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {editor.open && (
        <TaskEditor
          task={editor.task}
          courses={courses}
          onClose={() => setEditor({ open: false, task: null })}
          onSave={(t) => void saveTask(t)}
          onDelete={(id) => void deleteTask(id)}
          onNewCourse={async (name) => {
            const c: Course = { id: uid('course'), name, createdAt: Date.now(), updatedAt: Date.now() };
            await saveCourse(c);
            return c;
          }}
        />
      )}

      {debugOpen && (
        <DebugPanel
          platform={p}
          onClose={() => setDebugOpen(false)}
          onApply={(o) => void applyOverrideChange(o)}
        />
      )}

      {toast && (
        <div style={{
          position: 'fixed', left: '50%', transform: 'translateX(-50%)',
          bottom: 'calc(84px + env(safe-area-inset-bottom))',
          background: 'var(--bg-3)', border: '1px solid var(--line)',
          padding: '9px 16px', borderRadius: 999, zIndex: 90,
          fontSize: 'var(--fs-sm)', boxShadow: '0 4px 20px rgb(0 0 0 / 0.4)',
        }}>
          {toast}
        </div>
      )}
    </div>
  );
}
