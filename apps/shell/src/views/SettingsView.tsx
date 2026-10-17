import { useRef, useState } from 'react';
import type { Platform } from '../platform/bootstrap';
import {
  ACCENTS, DENSITY_LABEL, LAYOUT_LABEL,
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
      <div className="section-title">外观</div>

      <div className="card stack">
        <div>
          <label className="lbl">主题色</label>
          <div className="row">
            {ACCENTS.map((a) => (
              <span
                key={a}
                className="swatch"
                data-active={a === settings.accent}
                style={{ background: a }}
                onClick={() => onChange({ accent: a })}
              />
            ))}
          </div>
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
          <label className="lbl">时间线布局</label>
          <div className="seg">
            {(Object.keys(LAYOUT_LABEL) as Layout[]).map((l) => (
              <button key={l} data-active={settings.layout === l} onClick={() => onChange({ layout: l })}>
                {LAYOUT_LABEL[l]}
              </button>
            ))}
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
