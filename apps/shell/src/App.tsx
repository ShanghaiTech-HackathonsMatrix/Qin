/// <reference types="vite/client" />
import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { EVENT_KIND_LABEL, type Course, type Task } from './domain/types';
import { PlatformInitError, type Platform } from './platform/bootstrap';
import { saveOverrides, type Overrides } from './platform/overrides';
import type { ResolutionReport } from './platform/strategies/types';
import { applySettings, DEFAULT_SETTINGS, loadSettings, saveSettings, type AppSettings } from './app/settings';
import { loadPlatform } from './app/platform';
import { uid } from './app/format';
import { createDemoData, type DemoClassSession } from './app/demo-data';
import ScheduleView, { atDay, buildScheduleDays, dayLabelOf, hhmm, type ScheduleEntry } from './views/ScheduleView';
import TimelineViewPlaceholder from './views/TimelineView';
// 手写时间线视图已由插件页面取代（见「时间线」标签的 `PageView`）。
// 保留导入只为让文件继续参与类型检查 —— 里面的分组逻辑将来可能被文档归并。
void TimelineViewPlaceholder;
import CoursesView from './views/CoursesView';
import SettingsView from './views/SettingsView';
import TaskEditor from './components/TaskEditor';
import QuickAdd from './components/QuickAdd';
import WeekStrip from './components/WeekStrip';
import { PROVIDER_LABEL, ddlMeta, ddlsFromTasks, pickUrgent, platformDdls, sortByDue, type DdlItem } from './app/ddl-items';
import AssignmentSheet, { type AssignmentDraft } from './components/AssignmentSheet';
import SwipeRow from './components/SwipeRow';
import {
  HOME_CARD_META,
  HOME_CARD_ORDER,
  HOME_WEIGHT_BUDGET,
  defaultHomeCards,
  homeCardWeight,
  normalizeHomeCards,
  type HomeCardConfig,
  type HomeCardId,
  type HomeCardSize,
} from './app/home-cards';
import DebugPanel from './components/DebugPanel';
import { LayoutStore } from './ui/layout';
import { PageView, WidgetPage } from './ui/WidgetPage';
import { PLUGIN_ID as TIMELINE_PLUGIN_ID, SLOT_NAME } from './plugins/builtin/timeline/constants';
import IcsImportView from './plugins/builtin/importer-ics/IcsImportView';
import type { CourseCard, CourseDraft } from './core/course-cards';
import { MatrixNotify } from '@matrix/capacitor-notify';

type Tab = 'home' | 'timeline' | 'courses' | 'settings';
const DEMO_MODE = import.meta.env.DEV && new URLSearchParams(window.location.search).get('demo') === '1';
const DEMO_DATA = DEMO_MODE ? createDemoData() : null;

/** 演示课次 → epoch。放在组件外，`useMemo` 里就不用每次重建函数 */
const demoSessionEpoch = (
  session: DemoClassSession,
  hour = session.startHour,
  minute = session.startMinute,
) => atDay(session.dayOffset, hour, minute);

type Boot =
  | { status: 'loading' }
  | { status: 'ready'; platform: Platform }
  | { status: 'error'; error: unknown; report?: ResolutionReport };

export default function App() {
  const [boot, setBoot] = useState<Boot>({ status: 'loading' });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  /**
   * 「课程」页的数据：核心课程 + 插件课程，来自 DataBus（T15）。
   *
   * 和上面 `courses`（`TaskStore` 的领域对象）**不是同一份**：
   * 那份给任务编辑器选课程用，是**可写**的真相；
   * 这份是给页面看的合并视图，插件课程在里面是只读的。
   * 两套并存是当前架构的实情，不是疏忽 —— 见 `course-cards.ts` 文件头。
   */
  const [courseCards, setCourseCards] = useState<CourseCard[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [tab, setTab] = useState<Tab>(() => {
    if (!DEMO_MODE) return 'home';
    const requested = new URLSearchParams(window.location.search).get('page');
    return requested === 'timeline' || requested === 'courses' || requested === 'settings' ? requested : 'home';
  });
  const [debugOpen, setDebugOpen] = useState(false);
  const [editor, setEditor] = useState<{ open: boolean; task: Task | null }>({ open: false, task: null });
  /** 右下角「＋」弹出的快速添加面板 */
  const [quickAdd, setQuickAdd] = useState(false);
  /**
   * 演示模式下「＋」添加的任务只活在这一份内存里。
   *
   * 演示数据的设计约束是**不写本机**，所以不能落库；
   * 但又要让人真的能点一下看看效果，于是放在 state 里，
   * 界面上明确标成「仅本次会话有效」。
   */
  const [demoExtraTasks, setDemoExtraTasks] = useState<Task[]>([]);
  /**
   * 演示态里被**改过**的虚构任务。
   *
   * 演示数据是每次刷新现生成的常量，不能就地改写；
   * 但用户点了「标记完成」或改了截止时间，界面得立刻反映出来。
   * 所以按 id 存一份覆盖层，读的时候盖在 DEMO_DATA.tasks 上面。
   */
  const [demoOverrides, setDemoOverrides] = useState<Record<string, Task>>({});

  /** 首页卡片定制：编辑态、正在拖的那一张、添加卡片面板 */
  const [homeEditing, setHomeEditing] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [cardPicker, setCardPicker] = useState(false);
  /** 左滑展开操作的那一条。同时只允许一条展开 */
  const [swipedId, setSwipedId] = useState<string | null>(null);
  /**
   * 学业服务的版本号。
   *
   * `AcademicService` 把快照和修正存在自己身上（不是 React state），
   * 订阅它、用一个计数强制重算，比把整个服务塞进 state 更省事，
   * 也不会因为对象引用不变而漏掉更新。
   */
  const [academicTick, setAcademicTick] = useState(0);
  /** 正在编辑的平台作业 id；null = 没开弹层 */
  const [assignmentId, setAssignmentId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /**
   * `?ddl=<id>` 直接打开某条演示 DDL 的详情。
   *
   * 存在的理由很实际：详情是一个弹层，静态截图/无头浏览器点不到它，
   * 没有深链接就只能靠人手动点，设计评审时没法一次看全。
   */
  const initialDemoDdl = DEMO_MODE ? new URLSearchParams(window.location.search).get('ddl') : null;
  const [demoOverlay, setDemoOverlay] = useState<'ddl' | null>(initialDemoDdl !== null ? 'ddl' : null);
  const [selectedDemoDdl, setSelectedDemoDdl] = useState<string | null>(initialDemoDdl);

  // ---------------------------------------------------------------- 启动

  const start = useCallback(async (force = false): Promise<Platform | null> => {
    setBoot({ status: 'loading' });
    try {
      const platform = await loadPlatform(force);
      const s = await loadSettings(platform.kv, DEMO_MODE);
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
  useEffect(() => {
    if (!platform?.notify.isSupported()) return;
    const consume = () => { void MatrixNotify.consumeTap?.().then(r => {
      // 平台相关的东西都在设置里，通知点开就落到那儿
      if (r.payload === 'academic') setTab('settings');
    }).catch(() => undefined); };
    consume();
    window.addEventListener('matrix-notification', consume);
    document.addEventListener('visibilitychange', consume);
    return () => { window.removeEventListener('matrix-notification', consume); document.removeEventListener('visibilitychange', consume); };
  }, [platform]);

  /*
    学业服务的快照与「个人修正」都存在服务对象里，不是 React state。
    订阅一下、拿计数强制重算 —— 同步完成、改了截止时间、标记完成，
    首页和任务日志都会跟着动。
  */
  useEffect(() => {
    if (platform === null) return;
    return platform.academic.subscribe(() => setAcademicTick((n) => n + 1));
  }, [platform]);

  // ---------------------------------------------------------------- 数据

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((cur) => (cur === m ? null : cur)), 2200);
  }, []);

  const reload = useCallback(async () => {
    if (!platform) return;
    // C 段之后 `store` 是门面，读的就是 DataBus 里的真相 —— 不需要再「投影」。
    // 以前这里有一次 `projectCore()`，漏调就是「界面改了、时间线没改」。
    const [t, c] = await Promise.all([platform.store.listTasks(), platform.store.listCourses()]);
    setTasks(t);
    setCourses(c);

    // 「课程」页要合并各插件贡献的课程（T15）
    setCourseCards(platform.listCourseCards());
  }, [platform]);

  useEffect(() => { void reload(); }, [reload]);

  /**
   * 保存任务。
   *
   * 演示态**不写库** —— 只改内存里的两份 state。
   * 这里原来无条件 `platform.store.putTask()`，于是演示模式下用「＋」
   * 新建的任务直接进了本机数据库，而界面读的是 DEMO_DATA + demoExtraTasks，
   * 根本看不见它：表现为「加了没反应、右上角的计数也不动」，
   * 顺带还违反了「演示不落盘」的约定。
   */
  const saveTask = useCallback(async (t: Task) => {
    setEditor({ open: false, task: null });

    if (DEMO_DATA !== null) {
      const isDemoTask = DEMO_DATA.tasks.some((d) => d.id === t.id);
      if (isDemoTask) {
        setDemoOverrides((prev) => ({ ...prev, [t.id]: t }));
      } else {
        setDemoExtraTasks((prev) =>
          prev.some((p) => p.id === t.id) ? prev.map((p) => (p.id === t.id ? t : p)) : [...prev, t],
        );
      }
      flash('已保存 · 演示数据，仅本次会话有效');
      return;
    }

    if (!platform) return;
    await platform.store.putTask(t);
    await reload();
  }, [platform, reload, flash]);

  const deleteTask = useCallback(async (id: string) => {
    setEditor({ open: false, task: null });

    if (DEMO_DATA !== null) {
      setDemoExtraTasks((prev) => prev.filter((p) => p.id !== id));
      setDemoOverrides((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      flash('已删除 · 演示数据，仅本次会话有效');
      return;
    }

    if (!platform) return;
    await platform.store.deleteTask(id);
    await reload();
  }, [platform, reload, flash]);

  /**
   * 批量添加（「＋ → 导入文字」按行拆出来的标题）。
   *
   * 演示模式下**不写库** —— 只塞进这一份内存 state，
   * 否则演示数据会污染本机存储，跟「演示不落盘」的约定冲突。
   */
  const addTaskLines = useCallback(async (lines: string[]) => {
    const now = Date.now();
    const created: Task[] = lines.map((title, i) => ({
      id: uid('task'),
      kind: 'custom' as const,
      title,
      courseId: null,
      dueAt: null,
      status: 'open',
      createdAt: now + i,
      updatedAt: now + i,
    }));

    setQuickAdd(false);

    if (DEMO_DATA !== null) {
      setDemoExtraTasks((prev) => [...prev, ...created]);
      flash(`已添加 ${created.length} 条 · 演示数据，仅本次会话有效`);
      return;
    }
    if (platform === null) return;
    for (const t of created) await platform.store.putTask(t);
    await reload();
    flash(`已添加 ${created.length} 条任务`);
  }, [platform, reload, flash]);

  /**
   * 切换完成状态。
   *
   * ⚠️ **暂时没有 UI 入口**：时间线已经插件化（`PageView` 只读），
   * 而插件回写数据需要「命令通道」（dev.md T14）。这条函数先留着，
   * 它是 `TaskStore` 真实的写入路径，等 T14 做完由插件动作驱动。
   *
   * 不删的理由：删了下一次做 T14 的人还得重写一遍顺序（读 → 改 → 写 → 重载 → 投影）。
   */
  const toggleDone = useCallback(async (t: Task) => {
    if (!platform) return;
    await platform.store.putTask({
      ...t,
      status: t.status === 'done' ? 'open' : 'done',
      updatedAt: Date.now(),
    });
    await reload();
  }, [platform, reload]);

  // 兑现上面注释里的「留着」：不加这一句 tsc 会把未使用的函数删掉（TS6133）
  void toggleDone;

  const saveCourse = useCallback(async (c: Course) => {
    if (!platform) return;
    await platform.store.putCourse(c);
    await reload();
  }, [platform, reload]);

  /**
   * 新建课程。id 与时间戳由**宿主**给 —— 视图不该造主键。
   *
   * `draft.title` → `Course.name` 是这里唯一需要记住的不对称：
   * 领域模型历史上叫 `name`，DataBus 里叫 `title`（见 `core-entities.ts` 的
   * `projectCourse`）。收敛点就这两处，别在别处再写一遍映射。
   */
  const createCourse = useCallback(async (draft: CourseDraft) => {
    if (!platform) return;
    const now = Date.now();
    await platform.store.putCourse({
      id: uid('course'),
      name: draft.title,
      ...(draft.code !== undefined ? { code: draft.code } : {}),
      ...(draft.color !== undefined ? { color: draft.color } : {}),
      createdAt: now,
      updatedAt: now,
    });
    await reload();
  }, [platform, reload]);

  /** 改课程。先读回原对象再覆盖 —— `putCourse` 是全量写，不读会把字段抹掉 */
  const updateCourse = useCallback(async (id: string, draft: CourseDraft) => {
    if (!platform) return;
    const all = await platform.store.listCourses();
    const existing = all.find((c) => c.id === id);
    // 找不到就什么都不做：可能是别的设备删了。报错只会让用户困惑
    if (!existing) return;
    await platform.store.putCourse({
      ...existing,
      name: draft.title,
      ...(draft.code !== undefined ? { code: draft.code } : {}),
      ...(draft.color !== undefined ? { color: draft.color } : {}),
      updatedAt: Date.now(),
    });
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

  // ---------------------------------------------------------------- 首页卡片
  /*
    首页摆什么，真相在设置里（KV），视图只按它渲染。
    「整宽打头就回到原来的单列」这条让默认排布仍然是一屏 ——
    也就是这次改动不会破坏上一步刚验证过的那条性质。
  */
  const homeCards = settings.homeCards;
  const homeMode = homeCards.some((c) => c.size === 'half') ? 'grid' : 'stack';
  /** 出厂是 4 张整宽 = 8 格。超了就不能再硬裁，得允许滚动。 */
  const homeScrolls = homeCardWeight(homeCards) > HOME_WEIGHT_BUDGET;
  /*
    这里原来会把「最近的 DDL」和「冒险图鉴」在真实模式下过滤掉，
    理由是「没有数据来源」。现在两张卡都接上了真实数据（核心任务 + 课程表），
    再过滤就是白白少两块内容，所以照配置原样渲染。
  */
  const visibleHomeCards = homeCards;

  const commitHomeCards = useCallback((next: HomeCardConfig[]) => {
    void updateSettings({ homeCards: normalizeHomeCards(next) });
  }, [updateSettings]);

  const moveCard = useCallback((from: number, to: number) => {
    if (from === to || to < 0 || to >= homeCards.length) return;
    const next = homeCards.slice();
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    commitHomeCards(next);
  }, [homeCards, commitHomeCards]);

  const resizeCard = useCallback((index: number) => {
    commitHomeCards(homeCards.map((c, i) => (
      i === index ? { ...c, size: (c.size === 'half' ? 'full' : 'half') as HomeCardSize } : c
    )));
  }, [homeCards, commitHomeCards]);

  const removeCard = useCallback((index: number) => {
    commitHomeCards(homeCards.filter((_, i) => i !== index));
  }, [homeCards, commitHomeCards]);

  const addCard = useCallback((id: HomeCardId) => {
    if (homeCards.some((c) => c.id === id)) return;
    commitHomeCards([...homeCards, { id, size: 'full' }]);
  }, [homeCards, commitHomeCards]);

  const startDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>, index: number) => {
    event.preventDefault();
    setDragIndex(index);
  }, []);

  /*
    拖拽排序用指针事件而不是 HTML5 拖放：
    HTML5 DnD 在触屏上根本不触发，而这是个手机应用。
    拖动时**实时**重排（不是松手才生效）—— 手指底下卡片跟着走才算拖得动。
  */
  useEffect(() => {
    if (dragIndex === null) return;
    const onMove = (event: PointerEvent) => {
      const slots = [...document.querySelectorAll('.home-slot[data-card]')];
      const target = slots.findIndex((el) => {
        const r = el.getBoundingClientRect();
        return event.clientY >= r.top && event.clientY <= r.bottom;
      });
      if (target !== -1 && target !== dragIndex) {
        moveCard(dragIndex, target);
        setDragIndex(target);
      }
    };
    const stop = () => setDragIndex(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [dragIndex, moveCard]);

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
    await platform.academic.clearData();
    await reload();
    flash('数据已清空');
  }, [platform, reload, flash]);

  // ---------------------------------------------------------------- 统计

  /**
   * 统计段用到的两个「当前值」。
   *
   * `pluginsRef` 必须在这里取：下面的 `useMemo` 在 `const p = boot.platform`
   * 之前就执行了，直接引用 `p` 会踩暂时性死区。
   * `nowMs` 每次渲染取一次，避免同一次渲染里前后两个 `Date.now()` 不一致。
   */
  const pluginsRef = boot.status === 'ready' ? boot.platform.plugins : null;
  const nowMs = Date.now();

  /**
   * 存储是否**真的**降级了。
   *
   * 判据是 store 槽最终选了谁，而不是「有没有警告」——
   * 警告里还混着「KV 未加密」「没有通知桥」这类能力缺口，
   * 它们不代表数据层退化了。
   */
  const storeSlotId = boot.status === 'ready'
    ? boot.platform.report.slots.find((s) => s.slot === 'store')?.selectedId ?? ''
    : '';
  const storeDegraded = storeSlotId === 'store.json';

  const visibleTasks = DEMO_DATA !== null
    ? [...DEMO_DATA.tasks.map((t) => demoOverrides[t.id] ?? t), ...demoExtraTasks]
    : tasks;
  const visibleCourses = DEMO_DATA?.courses ?? courses;
  const visibleCourseCount = DEMO_DATA?.courses.length ?? courseCards.length;
  const openCount = visibleTasks.filter((t) => t.status === 'open').length;
  const overdueCount = visibleTasks.filter((t) => t.status === 'open' && t.dueAt !== null && t.dueAt < nowMs).length;
  const demoClasses = DEMO_DATA?.classes ?? [];
  const demoDdls = DEMO_DATA?.ddls ?? [];
  /**
   * 首页与任务日志共用的 DDL 列表。
   *
   * 演示模式用虚构的 DDL（带平台来源与详情链接）；
   * 真实模式从**核心任务**里挑 `kind === 'ddl'` 且带截止时间的那些 ——
   * 这些任务宿主本来就通过 `platform.store.listTasks()` 读进了 `tasks`。
   * 之前这里只读演示数据，于是「接入平台同步后才有 DDL」变成了一句空话：
   * 功能其实一直有，只是视图没去读。
   */
  /**
   * 平台同步回来的快照。
   *
   * `academicTick` 是订阅计数器，放在依赖里是为了「同步完就重算」——
   * 快照数组本身是可变的，引用不变 React 就不会更新。
   */
  const academicSnapshots = useMemo(
    () => (platform === null ? [] : platform.academic.snapshots),
    [platform, academicTick],
  );
  /** 有没有同步到真数据。有的话演示用的虚构样本让位 —— 两套并存只会互相打架 */
  const hasAcademic = academicSnapshots.length > 0;

  /** 从三个学习平台拉回来的作业，形状和本机任务完全一样 */
  const platformItems = useMemo<DdlItem[]>(
    () => (platform === null
      ? []
      : platformDdls(
          platform.academic.snapshots,
          platform.academic.settings.selectedCourses,
          platform.academic.corrections.assignments,
        )),
    [platform, academicTick],
  );

  const ddlItems = useMemo<DdlItem[]>(() => {
    const local = DEMO_DATA !== null
      ? [
          // 演示态的虚构 DDL 是占位：一旦真同步到数据就让位，否则两套平台数据打架
          ...(hasAcademic ? [] : DEMO_DATA.ddls.map((d) => ({ ...d, selfMade: false }))),
          // 用「＋」加的也算数：填了时间就该跟平台提取的那些排在一起
          ...ddlsFromTasks(demoExtraTasks, true),
        ]
      : ddlsFromTasks(visibleTasks);
    return [...platformItems, ...local];
  }, [visibleTasks, demoExtraTasks, platformItems, hasAcademic]);
  const courseFor = useCallback((courseId: string) => visibleCourses.find((course) => course.id === courseId)?.name ?? '个人任务', [visibleCourses]);
  const formatDemoTime = (session: DemoClassSession) => `${String(session.startHour).padStart(2, '0')}:${String(session.startMinute).padStart(2, '0')}–${String(session.endHour).padStart(2, '0')}:${String(session.endMinute).padStart(2, '0')}`;
  const formatDue = (at: number) => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(at);

  /**
 * 底部栏图标。
 *
 * 和人物卡上那张手绘是同一套语言：只有线条、没有填充，
 * 1.7 的描边、圆角端点，缩到 21px 也不糊。
 */
const TAB_ICONS = {
  // 帐篷：首页是「营地」
  home: (
    <>
      <path d="M4 19h16" />
      <path d="M12 5 4.5 19h15L12 5z" />
      <path d="M12 12.5 9 19h6l-3-6.5z" />
    </>
  ),
  // 三行清单，第三行打个勾：任务
  timeline: (
    <>
      <path d="M4 7h11M4 12h9M4 17h6" />
      <path d="M15.5 17.5l1.8 1.8 3.2-3.6" />
    </>
  ),
  // 日历：日程
  courses: (
    <>
      <rect x="4" y="6" width="16" height="14" rx="2.5" />
      <path d="M4 10.5h16M8.5 4v3.5M15.5 4v3.5" />
      <path d="M8.5 14.5h3" />
    </>
  ),
  // 行囊：设置
  settings: (
    <>
      <path d="M5.5 9.5h13l-1.2 10.5H6.7L5.5 9.5z" />
      <path d="M9 9.5V7a3 3 0 0 1 6 0v2.5" />
      <path d="M9.5 14h5" />
    </>
  ),
} as const;

/** 插件槽里的课次（ICS 导入的课表）。演示模式下不读，避免和虚构数据混在一起 */
  const slotEntries = useMemo(
    () => (DEMO_MODE && !hasAcademic ? [] : (pluginsRef?.readSlot(SLOT_NAME) ?? [])),
    [pluginsRef, hasAcademic],
  );

  /**
   * 下一节课。两种数据源归一成同一个形状，卡片因此只有一份渲染逻辑。
   *
   * 上一版只比较「今天 + 分钟数」，今天没课或今天的课都上完了就整块消失；
   * 现在跨天比较完整时间戳，明天/后天的课也能接上。
   */
  const nextSession = useMemo<{ title: string; time: string; location: string } | null>(() => {
    if (DEMO_MODE && !hasAcademic) {
      const session = demoClasses.reduce<DemoClassSession | null>((best, current) => {
        const at = demoSessionEpoch(current);
        if (at < nowMs) return best;
        return best === null || at < demoSessionEpoch(best) ? current : best;
      }, null);
      return session === null
        ? null
        : { title: session.title, time: formatDemoTime(session), location: session.location };
    }

    const upcoming = slotEntries
      .filter((entry) => entry.data.type === 'session'
        && typeof entry.data.startAt === 'number'
        && entry.data.startAt > nowMs)
      .sort((a, b) => (a.data.startAt as number) - (b.data.startAt as number))[0];
    if (upcoming === undefined) return null;

    const start = upcoming.data.startAt as number;
    const end = typeof upcoming.data.endAt === 'number' ? upcoming.data.endAt : null;
    return {
      title: typeof upcoming.data.title === 'string' ? upcoming.data.title : '下一节课',
      time: end !== null ? `${hhmm(start)}–${hhmm(end)}` : hhmm(start),
      location: typeof upcoming.data.detail === 'string' ? upcoming.data.detail : '',
    };
  }, [demoClasses, slotEntries, nowMs, hasAcademic]);

  /**
   * 最近的 DDL：**以「天」为基准**。
   *
   * 优先级是「今天 → 最近的有事的那天 → 最久没处理的逾期那天」。
   * 上一版直接取全表最早的一天，于是昨天的逾期任务会把今天的 DDL 挤掉；
   * 用户看到的「最近」应该是今天该交的东西。
   * 同一天有多条就全留下 —— 一天的截止压力本来就该一起看。
   */
  /**
   * 点开一条 DDL。
   *
   * 演示数据走样式化的详情抽屉（那是设计展示）；
   * 真实任务走 `TaskEditor` —— 它有改状态、改截止时间、删除，
   * 换成只读抽屉会让「标记完成」这个功能凭空消失。
   */
  const openDdl = useCallback((ddl: DdlItem) => {
    /*
      这里原来查的是 `tasks`（真实库），而演示态的任务在 `visibleTasks` 里 ——
      于是自建任务永远查不到，一路落到演示详情抽屉，而抽屉里
      `demoDdls.find(...) ?? demoDdls[0]` 又把它兜底成了**第一条虚构 DDL**：
      点什么都显示「提交界面线框草图」。两个 bug 叠在一起。
    */
    // 拉回来的作业不是本机任务，改的是「个人修正」，走另一个弹层
    if (ddl.provider !== undefined) {
      setAssignmentId(ddl.id);
      return;
    }
    const target = visibleTasks.find((t) => t.id === (ddl.taskId ?? ddl.id));
    if (target !== undefined) {
      setEditor({ open: true, task: target });
      return;
    }
    // 只有演示里那批虚构 DDL 才走样式化详情；它们是数据，不是任务
    if (demoDdls.some((item) => item.id === ddl.id)) {
      setSelectedDemoDdl(ddl.id);
      setDemoOverlay('ddl');
    }
  }, [visibleTasks, demoDdls]);

  /** 平台作业的原始记录（未叠个人修正）。找不到说明同步数据变了 */
  const rawAssignment = assignmentId === null
    ? undefined
    : platform?.academic.snapshots.flatMap((snap) => snap.assignments).find((a) => a.id === assignmentId);

  /**
   * 弹层要显示的内容 = 平台原文 + 个人修正。
   * 直接读服务，而不是读列表里的那一行 —— 列表可能因为筛选/隐藏没有它。
   */
  const assignmentDraft = useMemo<AssignmentDraft | null>(() => {
    if (assignmentId === null || rawAssignment === undefined) return null;
    const fix = platform?.academic.corrections.assignments[assignmentId];
    const merged = { ...rawAssignment, ...fix };
    const snapshot = platform?.academic.snapshots.find((snap) => snap.assignments.some((a) => a.id === assignmentId));
    return {
      id: merged.id,
      title: merged.title,
      dueAt: merged.dueAt,
      note: fix?.note ?? '',
      done: fix?.done ?? (merged.status === 'submitted' || merged.status === 'graded'),
      dueText: merged.dueText,
      courseTitle: snapshot?.courses.find((c) => c.id === merged.courseId)?.title ?? '',
      source: PROVIDER_LABEL[merged.provider] ?? merged.provider,
      status: merged.status,
    };
  }, [assignmentId, rawAssignment, platform, academicTick]);

  const saveAssignment = useCallback(async (id: string, patch: {
    title?: string; dueAt?: number | null; note?: string; done?: boolean;
  }) => {
    if (platform === null) return;
    try {
      await platform.academic.editAssignment(id, patch);
      setAssignmentId(null);
      flash('已保存 · 只改本机，不动平台原文');
    } catch (e) {
      flash(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [platform, flash]);

  /**
   * 隐藏一条平台作业。
   *
   * 平台上的作业删不掉（那是学校的记录），能做的只有「我不看它」。
   * 所以按钮写「隐藏」而不是「删除」—— 写删除就是在骗人。
   */
  const hideAssignment = useCallback(async (id: string) => {
    if (platform === null) return;
    try {
      await platform.academic.editAssignment(id, { hidden: true });
      flash('已隐藏 · 平台上的记录还在');
    } catch (e) {
      flash(`隐藏失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [platform, flash]);

  const resetAssignment = useCallback(async (id: string) => {
    if (platform === null) return;
    try {
      await platform.academic.resetAssignment(id);
      setAssignmentId(null);
      flash('已恢复平台数据');
    } catch (e) {
      flash(`恢复失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [platform, flash]);

  /** 挑选规则已抽到 app/ddl-items.ts，那里有 13 项断言盯着 */
  const urgentDdls = useMemo(() => pickUrgent(ddlItems, nowMs), [ddlItems, nowMs]);

  /**
   * 「自建任务」= 没有截止时间的那批。
   *
   * 演示模式只有「＋」当场加的那几条；真实模式从核心任务里挑 dueAt 为空的。
   * 已完成的也留着 —— 用户需要看见自己做过什么。
   */
  /**
   * 「自建任务」段 = 主列表没收录的那些任务。
   *
   * 判据故意写成「不在主列表里」而不是「没有截止时间」：
   * 前者不可能漏，后者会。比如一条 kind 是「课程」的任务填了截止时间，
   * 它既进不了 DDL 主列表（课程不算要交的事），又不满足「没有截止时间」，
   * 于是两段都不显示 —— 界面上凭空少一条。这类静默丢失比排错序难查得多。
   */
  const undatedTasks = useMemo(() => {
    const listed = new Set(ddlItems.map((d) => d.id));
    const source = DEMO_DATA !== null ? demoExtraTasks : visibleTasks;
    return source.filter((t) => t.status !== 'dismissed' && !listed.has(t.id));
  }, [ddlItems, visibleTasks, demoExtraTasks]);
  /** 首页与「日程」页共用同一份条目，避免两处各写一遍映射 */
  const scheduleEntries = useMemo<ScheduleEntry[]>(() => {
    const fromClasses: ScheduleEntry[] = DEMO_MODE && !hasAcademic
      ? demoClasses.map((session) => ({
        id: session.id,
        at: demoSessionEpoch(session),
        endAt: demoSessionEpoch(session, session.endHour, session.endMinute),
        title: session.title,
        meta: session.location,
        kind: 'class',
      }))
      // 只收课次。带截止时间的作业统一从 ddlItems 来 —— 两边都收会重复一行
      : slotEntries.flatMap((entry, i) => {
        const v = entry.data;
        if (v.type !== 'session') return [];
        if (typeof v.startAt !== 'number' || typeof v.title !== 'string') return [];
        return [{
          id: `slot-${i}-${v.startAt}`,
          at: v.startAt,
          ...(typeof v.endAt === 'number' ? { endAt: v.endAt } : {}),
          title: v.title,
          meta: typeof v.detail === 'string' ? v.detail : '',
          kind: 'class' as const,
        }];
      });
    /*
      带截止时间的东西进日程，按时间参与排序。
      演示态原来只取 `demoDdls`（虚构的平台 DDL），自己用「＋」加的那些
      压根没进来 —— 于是「任务日志里有、日程里没有」。
      现在直接复用 ddlItems：它已经把两种来源并成了一份。
    */
    const fromDated: ScheduleEntry[] = ddlItems.map((ddl) => ({
      id: ddl.id,
      at: ddl.dueAt,
      title: ddl.title,
      meta: ddlMeta(ddl, courseFor(ddl.courseId ?? '')),
      kind: ddl.provider !== undefined || ddl.selfMade !== true ? ('ddl' as const) : ('task' as const),
      state: ddl.done === true
        ? ('done' as const)
        : ddl.dueAt < nowMs ? ('overdue' as const) : ('open' as const),
      ...(ddl.selfMade === true ? { selfMade: true } : {}),
    }));
    return [...fromClasses, ...fromDated];
  }, [slotEntries, demoClasses, ddlItems, courseFor, nowMs, hasAcademic]);
  /**
   * 日程只排「昨天 → 未来两周」。
   *
   * 教务同步回来的是整个学期（15 周 × 每周几节），全铺出来是五十多条 ——
   * 那不是日程，是档案。这一页要回答的是「接下来干什么」，
   * 所以留一个滚动窗口，界面上也写明只看两周。
   */
  const SCHEDULE_AHEAD_DAYS = 14;
  const scheduleWindow = useMemo(() => {
    const from = nowMs - 86_400_000;
    const to = nowMs + SCHEDULE_AHEAD_DAYS * 86_400_000;
    return scheduleEntries.filter((entry) => {
      // 逾期且还没做完的事必须留下 —— 那正是最该被看见的一条
      if (entry.kind !== 'class' && entry.state !== 'done' && entry.at < from) return true;
      return entry.at >= from && entry.at <= to;
    });
  }, [scheduleEntries, nowMs]);
  const scheduleDays = useMemo(() => buildScheduleDays(scheduleWindow, nowMs), [scheduleWindow, nowMs]);
  const today = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());

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

  /**
   * 首页每张卡片的内容。
   *
   * 整宽与半宽**各写一套排法**，不是把整宽等比缩小 ——
   * 半宽只有一百多像素，横排的标题加箭头会挤成两行，只能改成竖排摘要。
   */
  const renderHomeCard = (id: HomeCardId, size: HomeCardSize) => {
    switch (id) {
      case 'hero':
        return (
          <section className="quest-intro" aria-label="今日概览">
            <div className="quest-intro__eyebrow">FIELD NOTES <span>NO. 001</span></div>
            <div className="quest-intro__main">
              <div><div className="quest-intro__date">{today}</div><h1>今天，继续你的冒险。</h1><p>先处理眼前的一件事，其余的慢慢来。</p></div>
              {/* 手绘人物：全部由线条构成，没有填充，缩到 80px 也不会糊成一团 */}
              <svg className="quest-intro__drawing" viewBox="0 0 140 150" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M16 129c28 9 78 9 108-1" />
                <path d="M38 134l-5 7M52 136l-4 7M92 136l-4 7M106 134l-5 7" strokeWidth="1.4" />
                <path d="M52 52c-1-13 7-23 18-23s19 10 18 23" />
                <path d="M53 48c4-6 9-9 17-9s13 3 17 9" strokeWidth="1.6" />
                <path d="M60 40l-2-9M70 37l1-9M80 40l3-9" strokeWidth="1.4" />
                <path d="M55 50c0 11 6 19 15 19s15-8 15-19" />
                <path d="M62 52q2.5 2.5 5 0M74 52q2.5 2.5 5 0" />
                <path d="M67 61q3 2.5 6 0" strokeWidth="1.6" />
                <path d="M60 69l10 9 10-9" />
                <path d="M58 70c-3 6-2 11 1 14M82 70c3 6 2 11-1 14" strokeWidth="1.6" />
                <path d="M56 129c-6-25-4-44 4-51M84 129c6-25 4-44-4-51" />
                <path d="M63 96c-2 9-2 20-1 30M77 96c2 9 2 20 1 30" strokeWidth="1.4" />
                <path d="M57 88c-4 7-4 12 0 16M83 88c4 7 4 12 0 16" strokeWidth="1.6" />
                <path d="M54 100h32v16H54z" />
                <path d="M70 100v16" strokeWidth="1.4" />
                <path d="M58 106h9M58 110h9M73 106h9M73 110h9" strokeWidth="1.2" />
                <path d="M54 106c-3 1-4 4-2 6M86 106c3 1 4 4 2 6" strokeWidth="1.4" />
                <path d="M22 40l2-6 2 6 6 2-6 2-2 6-2-6-6-2z" strokeWidth="1.3" />
                <path d="M114 58l1.5-4.5L117 58l4.5 1.5L117 61l-1.5 4.5L114 61l-4.5-1.5z" strokeWidth="1.2" />
              </svg>
            </div>
            <div className="quest-intro__stats">
              <span><b>{String(openCount).padStart(2, '0')}</b> 待办任务</span><span><b>{String(overdueCount).padStart(2, '0')}</b> 已逾期</span><span><b>{String(visibleCourseCount).padStart(2, '0')}</b> 门课程</span>
              {/* 加号就长在这张人物卡上，不再是浮在屏幕右下角、挡住内容的圆按钮 */}
              <button className="quest-intro__add" onClick={() => setQuickAdd(true)} aria-label="添加任务">
                <span aria-hidden="true">＋</span>
              </button>
            </div>
          </section>
        );

      case 'next-class':
        if (nextSession === null) {
          return <div className="home-empty">暂无可显示的课次</div>;
        }
        return (
          <button className="next-class-card" data-size={size} onClick={() => setTab('courses')}>
            <span className="next-class-card__index">NEXT CLASS / 下一节课</span>
            <span className="next-class-card__main">
              <span>
                <span className="next-class-card__title">{nextSession.title}</span>
                <span className="next-class-card__meta">
                  {nextSession.time}
                  {nextSession.location !== '' && ` · ${nextSession.location}`}
                </span>
              </span>
              {size === 'full' && <span className="next-class-card__arrow" aria-hidden="true">↗</span>}
            </span>
            {size === 'full' && <span className="next-class-card__hint">点击查看每日日程</span>}
          </button>
        );

      case 'schedule':
        return (
          <section className="quest-section home-week" aria-label="本周日程">
            <div className="quest-section__head">
              <h2>本周</h2>
              <span className="quest-section__ornament">可视化</span>
            </div>
            <WeekStrip entries={scheduleEntries} now={nowMs} onPickDay={() => setTab('courses')} />
          </section>
        );

      case 'ddl':
        return (
          <section className="quest-section" aria-label="最近的 DDL">
            <div className="quest-section__head">
              <h2>{size === 'half' ? 'DDL' : '最近的 DDL'}</h2>
              <span className="quest-section__ornament">{urgentDdls.length} 条</span>
            </div>
            <div className="ddl-list">
              {urgentDdls.slice(0, size === 'half' ? 2 : urgentDdls.length).map((ddl) => {
                const overdue = ddl.dueAt < nowMs;
                return (
                  <button
                    className="ddl-card"
                    key={ddl.id}
                    data-overdue={overdue}
                    data-size={size}
                    onClick={() => openDdl(ddl)}
                  >
                    <span className="ddl-card__time">
                      <strong>{hhmm(ddl.dueAt)}</strong>
                      <em>{overdue ? '已逾期' : dayLabelOf(ddl.dueAt, nowMs).label}</em>
                    </span>
                    <span className="ddl-card__body">
                      <strong>
                        {ddl.title}
                        {ddl.selfMade === true && (
                          <span className="tag-self" title="自己添加的，不是平台同步来的">自建</span>
                        )}
                      </strong>
                      <small>{ddlMeta(ddl, courseFor(ddl.courseId ?? ''))}</small>
                    </span>
                    {size === 'full' && <span className="ddl-card__arrow" aria-hidden="true">↗</span>}
                  </button>
                );
              })}
            </div>
          </section>
        );

      case 'atlas':
        /* 这两项数据真实模式下本来就有（openCount / visibleCourseCount），没有理由只在演示里画 */        /*
          原来这里有一个「冒险图鉴」标题行，为了首页一屏把它去掉了 ——
          两张卡自己带了 PROGRESS / COURSES 标签，标题是重复的。
          现在卡片有了编辑栏，命名交给编辑栏，正文继续省这 40px。
        */
        return (
          <div className="demo-atlas">
            <div className="demo-atlas__tile"><span className="demo-atlas__symbol" aria-hidden="true">✦</span><span><small>PROGRESS / 冒险进度</small><strong>还剩 {openCount} 件事没做完</strong><em>一步一步，也在向前。</em></span></div>
            <div className="demo-atlas__tile"><span className="demo-atlas__symbol" aria-hidden="true">◇</span><span><small>COURSES / 在册课程</small><strong>{visibleCourseCount} 门课程</strong><em>{visibleCourses.map((c) => c.name).join(' · ')}</em></span></div>
          </div>
        );

      case 'widgets':
        /*
          插件清单里声明「放首页」的控件。
          以前这块是硬挂在首页最下面的，现在它是一张可选卡片 ——
          用户在定制里能把它挪走、缩成半宽，或者干脆不加。
        */
        if (layoutStore === null) return <div className="home-empty">布局存储未就绪</div>;
        return (
          <WidgetPage
            host={p.plugins}
            layout={layoutStore}
            onNavigate={goTab}
            onDataChanged={() => void reload()}
          />
        );
    }
  };

  return (
    <div className="app" style={{ ['--font-scale' as string]: String(settings.fontScale) } as CSSProperties}>
      <div className="topbar">
        <div className="topbar__identity">
          <span className="topbar__sigil" aria-hidden="true">✳</span>
          <div>
            <div className="topbar__title">秦 <span>/ QIN</span></div>
            <div className="topbar__sub">{tab === 'home' ? '冒险日志' : tab === 'timeline' ? '任务日志' : tab === 'courses' ? '每日日程' : '行囊设置'}</div>
          </div>
        </div>
        <div className="topbar__spacer" />
        {tab === 'home' && (
          <button className="btn btn--sm" data-active={homeEditing} onClick={() => setHomeEditing((v) => !v)}>
            {homeEditing ? '完成' : '定制'}
          </button>
        )}
        {tab === 'timeline' && (
          <button className="btn btn--primary btn--sm" onClick={() => setEditor({ open: true, task: null })}>
            ＋ 新建
          </button>
        )}
      </div>

      <div className="app__body" data-page={tab}>
        {tab === 'timeline' && !DEMO_MODE && p.warnings.length > 0 && (
          <div className="notice" data-tone={storeDegraded ? 'warn' : 'info'} style={{ marginBottom: 'var(--gap)' }}>
            {/*
              只有**存储真的退到 JSON 文档库**时才算「已降级」。
              其它条目（KV 未加密、没有通知桥）是如实告知的能力缺口，
              把它们统统标成「已降级运行」会让人以为数据层出了问题。
            */}
            <strong>{storeDegraded ? '已降级运行' : '运行提示'}</strong>
            <ul>
              {p.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}

        {DEMO_MODE && <div className="demo-ribbon" role="status">演示预览 · 虚构数据 · 不写入本机</div>}
        {tab === 'home' && (
          <div
            className="home-grid"
            data-mode={homeMode}
            data-scroll={homeScrolls ? 'yes' : 'no'}
            data-editing={homeEditing}
          >
            {visibleHomeCards.map((card, index) => {
              const meta = HOME_CARD_META[card.id];
              /*
                半宽卡是「占一列」的：它后面那张如果不是半宽，这一行的另一列就空着。
                编辑态里把这个空位画成虚线框，用户才知道为什么旁边少了半张 ——
                否则看起来像排坏了。
              */
              const next = visibleHomeCards[index + 1];
              const loneHalf = card.size === 'half' && (next === undefined || next.size === 'full');
              return (
                <Fragment key={card.id}>
                <section
                  className="home-slot"
                  data-card={card.id}
                  data-size={card.size}
                  data-dragging={dragIndex === index}
                >
                  {homeEditing && (
                    <div className="home-slot__bar">
                      <button
                        className="home-slot__handle"
                        aria-label={`拖动「${meta.name}」`}
                        onPointerDown={(event) => startDrag(event, index)}
                      >
                        <span aria-hidden="true">⠿</span>
                      </button>
                      <span className="home-slot__name">{meta.name}</span>
                      <span className="home-slot__tools">
                        <button className="icon-btn" aria-label="上移" disabled={index === 0} onClick={() => moveCard(index, index - 1)}>↑</button>
                        <button className="icon-btn" aria-label="下移" disabled={index === visibleHomeCards.length - 1} onClick={() => moveCard(index, index + 1)}>↓</button>
                        {meta.fullOnly !== true && (
                          <button className="icon-btn icon-btn--wide" aria-label="切换整宽与半宽" onClick={() => resizeCard(index)}>
                            {card.size === 'half' ? '半宽' : '整宽'}
                          </button>
                        )}
                        <button className="icon-btn" aria-label="移除卡片" onClick={() => removeCard(index)}>×</button>
                      </span>
                    </div>
                  )}
                  {renderHomeCard(card.id, card.size)}
                </section>
                {homeEditing && loneHalf && (
                  <div className="home-slot home-slot--gap" aria-hidden="true">空位</div>
                )}
                </Fragment>
              );
            })}

            {homeEditing && (
              <button className="home-slot home-slot--add" onClick={() => setCardPicker(true)}>
                <span aria-hidden="true">＋</span> 添加卡片
              </button>
            )}
          </div>
        )}

        {/*
          任务日志 = **各平台识别到的 DDL**。
          以前这里是「所有任务」的平铺列表，看不出东西是哪来的、什么时候截止。
          现在按截止时间排序，左边直接是截止时间，点一下进详情。

          两种数据来源走同一套视图：演示用虚构 DDL，真实模式用核心任务里
          `kind === 'ddl'` 的那些。来源一栏真实模式下如实写「本机记录」——
          平台同步接上之前不该编平台名。
        */}
        {tab === 'timeline' && (
          <>
            <div className="quest-section__head">
              <h2>任务日志</h2>
              <span className="quest-section__ornament">
                {ddlItems.length} 条 · {DEMO_MODE ? '来自 2 个平台' : '本机记录'}
              </span>
            </div>

            {ddlItems.length === 0 ? (
              <div className="home-empty">
                还没有 DDL。用右下角的「＋」添加，或等平台同步接入后自动汇总。
              </div>
            ) : (
              <div className="log-list">
                {sortByDue(ddlItems).map((ddl) => {
                  const overdue = ddl.dueAt < nowMs;
                  const task = visibleTasks.find((t) => t.id === (ddl.taskId ?? ddl.id));
                  return (
                    <SwipeRow
                      key={ddl.id}
                      open={swipedId === ddl.id}
                      onOpenChange={(next) => setSwipedId(next ? ddl.id : null)}
                      actions={ddl.provider !== undefined
                        ? [
                            { label: '编辑', onClick: () => setAssignmentId(ddl.id) },
                            { label: '隐藏', danger: true, onClick: () => void hideAssignment(ddl.id) },
                          ]
                        : task === undefined
                          ? []
                          : [
                              { label: '编辑', onClick: () => setEditor({ open: true, task }) },
                              { label: '删除', danger: true, onClick: () => void deleteTask(task.id) },
                            ]}
                    >
                    <button
                      className="log-row"
                      data-overdue={overdue}
                      onClick={() => openDdl(ddl)}
                    >
                      <span className="log-row__due">
                        <b>{formatDue(ddl.dueAt)}</b>
                        <em>{overdue ? '已逾期' : dayLabelOf(ddl.dueAt, nowMs).label}</em>
                      </span>
                      <span className="log-row__body">
                        <strong>
                          {ddl.title}
                          {ddl.selfMade === true && (
                            <span className="tag-self" title="自己添加的，不是平台同步来的">自建</span>
                          )}
                        </strong>
                        <small>{ddlMeta(ddl, courseFor(ddl.courseId ?? ''))}</small>
                      </span>
                      <span className="log-row__arrow" aria-hidden="true">↗</span>
                    </button>
                    </SwipeRow>
                  );
                })}
              </div>
            )}

            {/* 自建任务：没有截止时间的那批，单独一段，不跟有期限的混在一起 */}
            {undatedTasks.length > 0 && (
              <>
                <div className="quest-section__head quest-section__head--spaced">
                  <h2>自建任务</h2>
                  <span className="quest-section__ornament">
                    {DEMO_MODE ? '仅本次会话' : `${undatedTasks.length} 条`}
                  </span>
                </div>
                <div className="log-list">
                  {undatedTasks.map((t) => (
                    <SwipeRow
                      key={t.id}
                      open={swipedId === t.id}
                      onOpenChange={(next) => setSwipedId(next ? t.id : null)}
                      actions={[
                        { label: '编辑', onClick: () => setEditor({ open: true, task: t }) },
                        { label: '删除', danger: true, onClick: () => void deleteTask(t.id) },
                      ]}
                    >
                    <button
                      className="log-row"
                      onClick={() => setEditor({ open: true, task: t })}
                    >
                      <span className="log-row__due">
                        <b>{t.dueAt === null ? '—' : formatDue(t.dueAt)}</b>
                        <em>{t.dueAt === null ? '无期限' : EVENT_KIND_LABEL[t.kind]}</em>
                      </span>
                      <span className="log-row__body">
                        <strong>
                          {t.title}
                          <span className="tag-self">自建</span>
                        </strong>
                        <small>
                          {t.dueAt === null ? '手动添加 · 待补充截止时间' : `${EVENT_KIND_LABEL[t.kind]} · 不进 DDL 列表`}
                        </small>
                      </span>
                      <span className="log-row__arrow" aria-hidden="true">↗</span>
                    </button>
                    </SwipeRow>
                  ))}
                </div>
              </>
            )}

            {/*
              插件自己声明的「时间线」页面仍然留着，收在折叠区里。
              新的日志列表是宿主层视图，但插件那条路是项目的架构承诺 ——
              直接删掉等于把「插件能贡献整页 UI」这个能力从应用里摘了。
            */}
            {!DEMO_MODE && (
              <details className="plugin-page">
                <summary>插件视图（时间线）</summary>
                <PageView
                  host={p.plugins}
                  pluginId={TIMELINE_PLUGIN_ID}
                  viewId="timeline"
                  onNavigate={goTab}
                  // 命令改了核心任务后，App 的 tasks/courseCards 要重新读一遍
                  onDataChanged={() => void reload()}
                />
              </details>
            )}
          </>
        )}

        {tab === 'courses' && (
          <>
            {/* 「课程」改成每日日程：课次与 DDL 混排，按天分组。 */}
            <div className="quest-section__head quest-section__head--spaced"><h2>每日日程</h2><span className="quest-section__ornament">{hasAcademic ? '未来两周' : DEMO_MODE ? '演示课表' : '按天分组'}</span></div>
            <ScheduleView
              days={scheduleDays}
              emptyText={DEMO_MODE
                ? '演示数据里这段时间还没有安排。'
                : '导入 .ics 课表，或在「任务」页添加带时间的任务，它们会出现在这里。'}
              onOpenEntry={(entry) => {
                // 课程条目不是任务，点了不该有反应；其余按 id 找回对应条目
                const item = ddlItems.find((d) => d.id === entry.id);
                if (item !== undefined) openDdl(item);
              }}
            />
          </>
        )}

        {tab === 'courses' && DEMO_MODE && <section className="demo-list demo-list--spaced"><div className="quest-section__head"><h2>在册课程</h2><span className="quest-section__ornament">{visibleCourseCount} 门</span></div>{visibleCourses.map((c, i) => <div className="demo-list__row" key={c.id}><span className="demo-list__mark" aria-hidden="true">{['✳', '◇', '✦'][i]}</span><span><strong>{c.name}</strong><small>{c.code} · {visibleTasks.filter((t) => t.courseId === c.id).length} 件任务</small></span></div>)}</section>}
        {tab === 'courses' && !DEMO_MODE && (
          <details className="schedule-manage">
            <summary>课程与课表导入</summary>
            <CoursesView
              courses={courseCards}
              tasks={tasks}
              onCreate={(d) => void createCourse(d)}
              onUpdate={(id, d) => void updateCourse(id, d)}
              onDelete={(id) => void deleteCourse(id)}
            />

            {/*
              导入入口。**必须在这一页**，不是塞在调试面板里 ——
              「课程」是用户想加课的地方，而 .ics 就是加课最省事的方式。

              ⚠️ 诚实说明：`IcsImportView` 是**第一方插件的 React 侧**，不是控件契约的产物。
              它被硬编码挂载，因为它需要文件输入 —— 而 `UiNode` 没有 file 原语。
              控件化的前提是给契约加一个 `file` 原语（或让宿主统一提供文件选择），
              在那之前第一方插件的 IO 类 UI 只能这样挂。
            */}
            <div className="section-title">导入 .ics 课表</div>
            <div className="card">
              <IcsImportView platform={p} onImported={() => void reload()} />
            </div>
          </details>
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
          ['home', '首页', TAB_ICONS.home],
          ['timeline', `任务${openCount ? ` · ${openCount}` : ''}`, TAB_ICONS.timeline],
          ['courses', '日程', TAB_ICONS.courses],
          ['settings', '设置', TAB_ICONS.settings],
        ] as const).map(([id, label, icon]) => (
          <button key={id} data-active={tab === id} onClick={() => setTab(id)} aria-label={label}>
            <svg
              className="tabbar__icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {icon}
            </svg>
            <span>{label}</span>
          </button>
        ))}
      </div>

      {demoOverlay === 'ddl' && DEMO_MODE && (() => {
        // 兜底成 demoDdls[0] 会让「点任意一条都显示第一条」这种 bug 静默发生
        const ddl = demoDdls.find((item) => item.id === selectedDemoDdl);
        if (ddl === undefined) return null;
        const overdue = ddl.dueAt < nowMs;
        return (
          <div className="ddl-detail-backdrop" onClick={() => setDemoOverlay(null)}>
            <section
              className="ddl-detail"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ddl-detail-title"
              onClick={(event) => event.stopPropagation()}
            >
              <header className="ddl-detail__band">
                <span className="ddl-detail__kicker">DEADLINE / 作业详情</span>
                <button className="ddl-detail__close" onClick={() => setDemoOverlay(null)} aria-label="关闭">×</button>
              </header>

              <div className="ddl-detail__scroll">
                <span className="ddl-detail__source">{ddl.source}</span>
                <h2 className="ddl-detail__title" id="ddl-detail-title">{ddl.title}</h2>

                <dl className="ddl-detail__rows">
                  <div><dt>课程</dt><dd>{courseFor(ddl.courseId)}</dd></div>
                  <div><dt>截止</dt><dd>{formatDue(ddl.dueAt)}</dd></div>
                  <div><dt>状态</dt><dd data-tone={overdue ? 'bad' : 'normal'}>{overdue ? '已逾期' : '待提交'}</dd></div>
                </dl>

                <p className="ddl-detail__body">{ddl.description}</p>

                <div className="ddl-detail__link">
                  <span>来源链接</span>
                  <code>{ddl.url}</code>
                </div>

                <div className="ddl-detail__actions">
                  <button className="btn btn--primary grow" onClick={() => flash('演示链接不会打开真实平台')}>
                    打开来源（演示） ↗
                  </button>
                  <button className="btn" onClick={() => setDemoOverlay(null)}>关闭</button>
                </div>

                <p className="ddl-detail__foot">
                  演示数据。真实同步接入前，这里不会跳转到任何外部平台，也不会改动本机任务。
                </p>
              </div>
            </section>
          </div>
        );
      })()}


      {cardPicker && (
        <div className="sheet-backdrop" onClick={() => setCardPicker(false)}>
          <div className="sheet quick" onClick={(e) => e.stopPropagation()}>
            <div className="sheet__head">
              <div className="sheet__title">添加卡片</div>
              <div className="grow" />
              <button className="btn btn--sm" onClick={() => setCardPicker(false)}>关闭</button>
            </div>
            <div className="quick__menu">
              {HOME_CARD_ORDER.map((id) => {
                const meta = HOME_CARD_META[id];
                const on = homeCards.some((c) => c.id === id);
                return (
                  <button
                    className="quick__option"
                    key={id}
                    disabled={on}
                    data-on={on}
                    onClick={() => addCard(id)}
                  >
                    <span className="quick__mark" aria-hidden="true">{on ? '✓' : '＋'}</span>
                    <span className="quick__body">
                      <strong>{meta.name}</strong>
                      <small>{meta.hint}</small>
                    </span>
                    <span className="quick__state">{on ? '已在首页' : '添加'}</span>
                  </button>
                );
              })}
              <p className="quick__foot">
                首页一共 {HOME_WEIGHT_BUDGET} 格，整宽算 2 格、半宽算 1 格。
                超出去之后首页会允许上下滚动，不再硬挤。
              </p>
              <button className="btn btn--sm" onClick={() => commitHomeCards(defaultHomeCards(DEMO_MODE))}>
                恢复默认排布
              </button>
            </div>
          </div>
        </div>
      )}

      {quickAdd && (
        <QuickAdd
          demo={DEMO_MODE}
          onClose={() => setQuickAdd(false)}
          onAddLines={(lines) => void addTaskLines(lines)}
          onManual={() => { setQuickAdd(false); setEditor({ open: true, task: null }); }}
        />
      )}

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

      {assignmentId !== null && assignmentDraft !== null && (
        <AssignmentSheet
          draft={assignmentDraft}
          busy={platform?.academic.busy === true}
          onClose={() => setAssignmentId(null)}
          onSave={(patch) => void saveAssignment(assignmentId, patch)}
          onReset={() => void resetAssignment(assignmentId)}
        />
      )}

      {debugOpen && (
        <DebugPanel
          platform={p}
          onClose={() => setDebugOpen(false)}
          onApply={(o) => void applyOverrideChange(o)}
        />
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
