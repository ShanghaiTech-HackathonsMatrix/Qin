import { useEffect, useRef, useState } from 'react';
import type { Platform } from '../platform/bootstrap';
import type { AcademicService } from '../core/academic-service.ts';
import {
  DENSITY_LABEL, FONT_SCALE_MAX, FONT_SCALE_MIN, FONT_SCALE_STEP, LAYOUT_LABEL,
  type AppSettings, type Density, type Layout,
} from '../app/settings';

interface Props {
  platform: Platform;
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  onOpenDebug: () => void;
  onResetData: () => void;
}

const APP_VERSION = '0.1.0-p0';

/**
 * 三个真实存在的学习平台。
 *
 * 这一版**有真的适配器**了（`plugins/builtin/academic/`）：登录在原生侧开
 * WebView，凭证留在系统里；同步走连接器抓页面、解析器读 HTML。
 * 所以这里的按钮是真的会发请求的 —— 不是演示态里那种按下去必然失败的假表单。
 *
 * 网页端没有原生会话，只能看不能登录；dev 的 `?demo=1` 走模拟通道，
 * 那时按钮可用，但界面上会写明「模拟」。
 */
const PROVIDERS_UI = [
  { id: 'gradescope', name: 'Gradescope', mark: 'G', hint: '作业与截止时间' },
  { id: 'blackboard', name: '互动教学平台', mark: '教', hint: '课程与作业' },
  { id: 'eams', name: '教务课表', mark: '课', hint: '课表与节次' },
] as const;

type ProviderId = (typeof PROVIDERS_UI)[number]['id'];

const stamp = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false });

function PlatformConnections({ academic, simulated }: { academic: AcademicService; simulated: boolean }) {
  const [note, setNote] = useState<{ tone: 'info' | 'bad' | 'ok'; text: string } | null>(null);
  const [, bump] = useState(0);

  // 服务把快照/状态存在自己身上，订阅一下才能跟着刷新
  useEffect(() => academic.subscribe(() => bump((n) => n + 1)), [academic]);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setNote(null);
    try {
      await fn();
      if (done !== undefined) setNote({ tone: 'ok', text: done });
    } catch (e) {
      setNote({ tone: 'bad', text: e instanceof Error ? e.message : String(e) });
    }
  };

  const busy = academic.busy;

  return (
    <>
      {!academic.available && (
        <p className="conn__note" data-tone="info">
          网页端登录不了学校平台。真机上点「登录」会打开对应站点，登录完成后回到这里点「同步」。
        </p>
      )}
      {simulated && (
        <p className="conn__note" data-tone="info">
          模拟模式：同步不会联网，用的是内置样本页面走真实解析器。数据是合成的。
        </p>
      )}

      {PROVIDERS_UI.map((item) => {
        const snapshot = academic.snapshots.find((s) => s.provider === item.id);
        return (
          <div className="conn" key={item.id}>
            <div className="conn__head">
              <span className="conn__mark" aria-hidden="true">{item.mark}</span>
              <span className="conn__title">
                <strong>{item.name}</strong>
                <small>{item.hint}</small>
              </span>
              <span className="conn__status" data-tone={snapshot === undefined ? 'off' : 'on'}>
                {snapshot === undefined ? '未同步' : '已同步'}
              </span>
            </div>

            <p className="conn__note" data-tone={academic.statuses[item.id]?.startsWith('同步成功') === true ? 'ok' : 'info'}>
              {academic.statuses[item.id] ?? '尚未同步'}
            </p>
            {snapshot !== undefined && (
              <p className="conn__note" data-tone="info">
                上次成功：{stamp(snapshot.syncedAt)} · 课程 {snapshot.courses.length} · 作业 {snapshot.assignments.length}
                {item.id === 'eams' ? ` · 排课 ${snapshot.rules.length}` : ''}
              </p>
            )}

            <div className="conn__actions">
              <button
                className="btn btn--sm btn--primary"
                disabled={busy || !academic.available}
                onClick={() => void run(() => academic.login(item.id as ProviderId))}
              >
                登录
              </button>
              <button
                className="btn btn--sm"
                disabled={busy || !academic.available}
                onClick={() => void run(() => academic.sync(item.id as ProviderId), '同步完成')}
              >
                {busy ? '处理中…' : '同步'}
              </button>
            </div>
          </div>
        );
      })}

      {note !== null && <p className="conn__note" data-tone={note.tone}>{note.text}</p>}

      <div className="conn__actions">
        <button
          className="btn btn--sm"
          disabled={busy || !academic.available}
          onClick={() => void run(() => academic.clearLogin(), '已清除平台登录状态，课表保留')}
        >
          清除全部平台登录状态
        </button>
      </div>
    </>
  );
}

/**
 * 课表基准。
 *
 * 教务给的是「第几周、星期几、第几节」，没有真实日期 —— 必须有人告诉它
 * 第 1 教学周从哪天开始，否则课次展开不出来。填错了整张课表就整体错位，
 * 所以这里不猜默认值，空着就明说「填了才会出现在日程里」。
 */
function TimetableSetup({ academic }: { academic: AcademicService }) {
  const [weekOne, setWeekOne] = useState(academic.settings.weekOne);
  const [totalWeeks, setTotalWeeks] = useState(String(academic.settings.totalWeeks));
  const [note, setNote] = useState<{ tone: 'info' | 'bad' | 'ok'; text: string } | null>(null);

  const save = async () => {
    setNote(null);
    try {
      const weeks = Number(totalWeeks);
      if (!Number.isInteger(weeks)) throw new Error('总周数要填整数');
      await academic.saveSettings({ ...academic.settings, weekOne, totalWeeks: weeks });
      setNote({ tone: 'ok', text: '已保存' });
    } catch (e) {
      setNote({ tone: 'bad', text: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="conn">
      <div className="conn__head">
        <span className="conn__mark" aria-hidden="true">周</span>
        <span className="conn__title">
          <strong>课表基准</strong>
          <small>第 1 教学周从哪天开始</small>
        </span>
      </div>
      <label className="conn__field">
        <span>第 1 教学周的周一</span>
        <input type="date" value={weekOne} onChange={(e) => setWeekOne(e.target.value)} />
      </label>
      <label className="conn__field">
        <span>学期总周数</span>
        <input type="number" min={1} max={60} value={totalWeeks} onChange={(e) => setTotalWeeks(e.target.value)} />
      </label>
      <p className="conn__note" data-tone="info">
        {academic.settings.weekOne === ''
          ? '还没填。不填的话，教务同步回来的课次不会出现在日程里。'
          : '改完保存后，日程里的课次会立刻按新基准重排。'}
      </p>
      {note !== null && <p className="conn__note" data-tone={note.tone}>{note.text}</p>}
      <div className="conn__actions">
        <button className="btn btn--sm btn--primary" disabled={academic.busy} onClick={() => void save()}>保存</button>
      </div>
    </div>
  );
}

export default function SettingsView({ platform, settings, onChange, onOpenDebug, onResetData }: Props) {
  const taps = useRef<{ n: number; at: number }>({ n: 0, at: 0 });
  const [diag, setDiag] = useState<Record<string, string> | null>(null);

  // 连点版本号 5 次进入调试面板（比长按可靠，触屏和鼠标都能用）
  const onVersionTap = () => {
    const now = Date.now();
    if (now - taps.current.at > 3000) taps.current = { n: 0, at: now };
    taps.current.at = now;
    taps.current.n += 1;
    if (taps.current.n >= 5) {
      taps.current = { n: 0, at: 0 };
      onOpenDebug();
    }
  };

  return (
    <>
      <div className="section-title">平台连接</div>
      <div className="conn-grid">
        <PlatformConnections academic={platform.academic} simulated={platform.academicSimulated} />
        <TimetableSetup academic={platform.academic} />
      </div>

      <div className="section-title">外观</div>

      <div className="card stack">
        <div>
          <label className="lbl">配色</label>
          <div className="faint">黑与白。让任务本身成为焦点。</div>
        </div>

        <div>
          <label className="lbl">密度</label>
          <div className="seg">
            {(Object.keys(DENSITY_LABEL) as Density[]).map((d) => (
              <button key={d} data-active={settings.density === d} onClick={() => onChange({ density: d })}>
                {DENSITY_LABEL[d]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="lbl">字体大小</label>
          <div className="slider">
            <input
              type="range"
              min={FONT_SCALE_MIN}
              max={FONT_SCALE_MAX}
              step={FONT_SCALE_STEP}
              value={settings.fontScale}
              onChange={(event) => onChange({ fontScale: Number(event.target.value) })}
              aria-label="字体大小"
            />
            <span className="slider__value">{Math.round(settings.fontScale * 100)}%</span>
          </div>
          <div className="faint" style={{ marginTop: 6 }}>
            只放大正文与截止时间，不放大图标和间距。调到 100% 是设计稿原尺寸。
          </div>
        </div>

        <div>
          <label className="lbl">列表样式</label>
          <div className="seg">
            {(Object.keys(LAYOUT_LABEL) as Layout[]).map((l) => (
              <button key={l} data-active={settings.layout === l} onClick={() => onChange({ layout: l })}>
                {LAYOUT_LABEL[l]}
              </button>
            ))}
          </div>
          <div className="faint" style={{ marginTop: 6 }}>
            「列表」用发丝线分行，一屏能看更多；「卡片」每项独立成卡。影响任务页与各类列表。
          </div>
        </div>
      </div>

      <div className="section-title">运行状态</div>

      <div className="card stack">
        <div className="row row--between">
          <span className="muted">存储后端</span>
          <span className="mono">{platform.store.backend}</span>
        </div>
        <div className="row row--between">
          <span className="muted">键值存储</span>
          <span className="mono">
            {platform.report.slots.find((s) => s.slot === 'kv')?.selectedId ?? '—'}
          </span>
        </div>
        <div className="row row--between">
          <span className="muted">索引策略</span>
          <span className="mono">
            {platform.report.slots.find((s) => s.slot === 'indexing')?.selectedId ?? '—'}
          </span>
        </div>

        {platform.warnings.length > 0 && (
          <div className="alert alert--warn">
            {platform.warnings.map((w, i) => <div key={i}>{w}</div>)}
          </div>
        )}

        <button
          className="btn btn--sm"
          onClick={() => {
            void platform.store.info().then(setDiag);
          }}
        >
          读取数据库诊断信息
        </button>
        {diag && <pre className="diag">{JSON.stringify(diag, null, 2)}</pre>}
      </div>

      <div className="section-title">数据</div>

      <div className="card stack">
        <div className="faint">
          所有数据都保存在本机。清空后无法恢复。
        </div>
        <button
          className="btn btn--danger"
          onClick={() => { if (confirm('确定清空全部数据？此操作不可撤销。')) onResetData(); }}
        >
          清空全部数据
        </button>
      </div>

      <div className="section-title">关于</div>

      <div className="card stack">
        <div className="row row--between">
          <span className="muted">版本</span>
          {/* 连点 5 次进入调试面板 */}
          <span className="mono" onClick={onVersionTap} style={{ cursor: 'default' }}>
            {APP_VERSION}
          </span>
        </div>
        <div className="row row--between">
          <span className="muted">平台</span>
          <span className="mono">{platform.report.platform}</span>
        </div>
        <div className="row row--between">
          <span className="muted">策略指纹</span>
          <span className="mono truncate" style={{ maxWidth: '60%' }}>{platform.report.fingerprint}</span>
        </div>
        <div className="faint">
          这是 P0 验证版：核心尚未下沉到原生层，网络未收口，插件系统未接入。
          它的用途是验证运行时、存储策略与数据持久化。
        </div>
      </div>
    </>
  );
}
