import { useEffect, useRef, useState } from 'react';
import type { Platform } from '../platform/bootstrap';
import {
  DENSITY_LABEL, LAYOUT_LABEL,
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
 * 两个待接入的平台。
 *
 * ⚠️ 诚实说明：这一版**没有**这两个平台的登录与同步适配器。
 * 表单、按钮与状态机是真的（能填、能校验、会失败），
 * 但「登录」不会发出任何网络请求，也不会把凭证写到任何地方 ——
 * 凭证只存在组件的 state 里，刷新即丢。
 * 等 `ConnectorPlugin` 真的接了这两个站点，这里换成调用插件即可，UI 不用重写。
 */
const PLATFORMS = [
  {
    id: 'interactive',
    name: '互动教学平台',
    mark: '教',
    hint: '课程、课表与 DDL',
    placeholder: 'https://courses.example.edu',
  },
  {
    id: 'gradescope',
    name: 'Gradescope',
    mark: 'G',
    hint: '作业、提交与截止时间',
    placeholder: 'https://www.gradescope.com',
  },
] as const;

type PlatformId = (typeof PLATFORMS)[number]['id'];

interface ConnState {
  url: string;
  account: string;
  password: string;
  open: boolean;
  phase: 'idle' | 'signing' | 'signed' | 'syncing';
  note: { tone: 'info' | 'bad' | 'ok'; text: string } | null;
}

const EMPTY_CONN: ConnState = {
  url: '',
  account: '',
  password: '',
  open: false,
  phase: 'idle',
  note: null,
};

function statusOf(conn: ConnState): { label: string; tone: 'off' | 'on' | 'warn' } {
  if (conn.phase === 'signed') return { label: '已登录', tone: 'on' };
  if (conn.phase === 'signing') return { label: '登录中', tone: 'warn' };
  if (conn.phase === 'syncing') return { label: '同步中', tone: 'warn' };
  if (conn.account !== '') return { label: '待登录', tone: 'warn' };
  return { label: '未配置', tone: 'off' };
}

function PlatformConnections() {
  const [conns, setConns] = useState<Record<PlatformId, ConnState>>({
    interactive: { ...EMPTY_CONN },
    gradescope: { ...EMPTY_CONN },
  });
  /** 计时器在组件卸载时要清掉，否则 setState 打到已卸载的组件上 */
  const timers = useRef<number[]>([]);
  useEffect(() => () => {
    for (const id of timers.current) window.clearTimeout(id);
  }, []);

  const patch = (id: PlatformId, next: Partial<ConnState>) => {
    setConns((current) => ({ ...current, [id]: { ...current[id], ...next } }));
  };

  const signIn = (id: PlatformId) => {
    const conn = conns[id];
    const name = PLATFORMS.find((p) => p.id === id)?.name ?? id;

    if (conn.url.trim() === '' || conn.account.trim() === '' || conn.password === '') {
      patch(id, { note: { tone: 'bad', text: '请先填写平台地址、账号和密码。' } });
      return;
    }
    if (!/^https?:\/\//i.test(conn.url.trim())) {
      patch(id, { note: { tone: 'bad', text: '平台地址需要以 http:// 或 https:// 开头。' } });
      return;
    }

    patch(id, { phase: 'signing', note: { tone: 'info', text: `正在连接 ${name}…` } });
    const timer = window.setTimeout(() => {
      patch(id, {
        phase: 'idle',
        note: {
          tone: 'bad',
          text: `连接失败：当前构建没有 ${name} 的登录适配器。凭证没有发送，也没有保存。`,
        },
      });
    }, 900);
    timers.current.push(timer);
  };

  const runSync = (id: PlatformId) => {
    const conn = conns[id];
    const name = PLATFORMS.find((p) => p.id === id)?.name ?? id;

    if (conn.phase !== 'signed') {
      patch(id, { note: { tone: 'bad', text: '请先登录，再同步。' } });
      return;
    }
    patch(id, { phase: 'syncing', note: { tone: 'info', text: `正在从 ${name} 拉取作业…` } });
    const timer = window.setTimeout(() => {
      patch(id, {
        phase: 'signed',
        note: { tone: 'bad', text: '同步不可用：尚未实现该平台的数据适配器，本地数据没有被改动。' },
      });
    }, 900);
    timers.current.push(timer);
  };

  return (
    <>
      {PLATFORMS.map((platform) => {
        const conn = conns[platform.id];
        const status = statusOf(conn);
        const busy = conn.phase === 'signing' || conn.phase === 'syncing';

        return (
          <div className="conn" key={platform.id}>
            <div className="conn__head">
              <span className="conn__mark" aria-hidden="true">{platform.mark}</span>
              <span className="conn__title">
                <strong>{platform.name}</strong>
                <small>{platform.hint}</small>
              </span>
              <span className="conn__status" data-tone={status.tone}>{status.label}</span>
            </div>

            <button
              type="button"
              className="conn__toggle"
              aria-expanded={conn.open}
              onClick={() => patch(platform.id, { open: !conn.open })}
            >
              {conn.open ? '收起配置 −' : '登录配置 ＋'}
            </button>

            {conn.open && (
              <div className="conn__form">
                <label className="conn__field">
                  <span>平台地址</span>
                  <input
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    placeholder={platform.placeholder}
                    value={conn.url}
                    onChange={(e) => patch(platform.id, { url: e.target.value })}
                  />
                </label>
                <label className="conn__field">
                  <span>账号</span>
                  <input
                    type="text"
                    autoComplete="username"
                    placeholder="学号或邮箱"
                    value={conn.account}
                    onChange={(e) => patch(platform.id, { account: e.target.value })}
                  />
                </label>
                <label className="conn__field">
                  <span>密码</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    placeholder="不会保存"
                    value={conn.password}
                    onChange={(e) => patch(platform.id, { password: e.target.value })}
                  />
                </label>
                <p className="conn__warning">
                  这一版没有该平台的登录适配器。点「登录」不会发送凭证，密码也不会离开这个页面。
                </p>
              </div>
            )}

            <div className="conn__actions">
              <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => signIn(platform.id)}>
                {busy && conn.phase === 'signing' ? '登录中…' : conn.phase === 'signed' ? '重新登录' : '登录'}
              </button>
              <button className="btn btn--sm" disabled={busy} onClick={() => runSync(platform.id)}>
                {busy && conn.phase === 'syncing' ? '同步中…' : '同步'}
              </button>
            </div>

            {conn.note !== null && (
              <p className="conn__note" data-tone={conn.note.tone}>{conn.note.text}</p>
            )}
          </div>
        );
      })}
    </>
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
        <PlatformConnections />
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
