import { useEffect, useMemo, useState } from 'react';
import type { Platform } from '../platform/bootstrap';
import type { Overrides } from '../platform/overrides';
import type { SlotId, SlotReport, Tier } from '../platform/strategies/types';
import { parseAllowlistText, saveAllowlist } from '../app/core-config';
import { errorCode } from '../core/index';
import type { AuditEntry } from '../core/types';
import IcsImportView from '../plugins/builtin/importer-ics/IcsImportView';

const SLOT_LABEL: Record<SlotId, string> = {
  kv: '键值 / 密钥存储',
  store: '业务数据存储',
  indexing: '索引策略',
};

const SLOT_HINT: Record<SlotId, string> = {
  kv: '存数据库口令、应用设置等。理想实现走系统 Keystore / Keychain。',
  store: '存任务与课程。理想实现是 SQLCipher 加密库。每个后端各自持有数据；切换时会自动把数据搬到新后端（仅当新后端为空）。',
  indexing: '决定「按截止时间等字段过滤」怎么实现。生成列要求 SQLite ≥ 3.31。',
};

const TIER_LABEL: Record<Tier, string> = { ideal: '理想', fallback: '降级', dev: '开发' };

interface Props {
  platform: Platform;
  onClose: () => void;
  onApply: (o: Overrides) => void;
}

export default function DebugPanel({ platform, onClose, onApply }: Props) {
  const [pending, setPending] = useState<Overrides>(platform.overrides);
  const [copied, setCopied] = useState(false);

  // 平台重新解析后（report.at 变了）同步一次待应用值
  useEffect(() => {
    setPending(platform.overrides);
  }, [platform.report.at, platform.overrides]);

  const dirty = useMemo(
    () =>
      pending.kv !== platform.overrides.kv ||
      pending.store !== platform.overrides.store ||
      pending.indexing !== platform.overrides.indexing,
    [pending, platform.overrides],
  );

  const diagnostics = useMemo(() => JSON.stringify({
    at: new Date(platform.report.at).toISOString(),
    platform: platform.report.platform,
    fingerprint: platform.report.fingerprint,
    active: {
      store: platform.store.backend,
      kvEncrypted: platform.kv.encrypted,
      indexing: platform.indexing?.id ?? null,
    },
    overrides: platform.overrides,
    warnings: platform.warnings,
    slots: platform.report.slots,
  }, null, 2), [platform]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diagnostics);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
      alert('剪贴板不可用，请手动选择下面的文本复制。');
    }
  };

  const pick = (slot: SlotId, id: string) => {
    setPending((cur) => ({ ...cur, [slot]: cur[slot] === id ? null : id }));
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <div className="sheet__title">策略调试面板</div>
          <div className="grow" />
          <button className="btn btn--sm" onClick={onClose}>关闭</button>
        </div>

        <div className="alert alert--info" style={{ marginBottom: 'var(--gap)' }}>
          启动时按 <strong>理想 → 降级 → 开发</strong> 顺序逐个探测，首个通过者胜出。
          点任意策略可强制指定；再点一次取消，回到自动。改动会持久化。
        </div>

        {platform.warnings.length > 0 && (
          <div className="alert alert--warn" style={{ marginBottom: 'var(--gap)' }}>
            <strong>当前配置的隐患</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {platform.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}

        {platform.report.slots.map((slot) => (
          <SlotBlock
            key={slot.slot}
            slot={slot}
            pending={pending[slot.slot]}
            onPick={pick}
          />
        ))}

        <div className="row" style={{ marginTop: 'var(--gap)' }}>
          <button
            className="btn btn--primary grow"
            disabled={!dirty}
            onClick={() => onApply(pending)}
          >
            {dirty ? '应用并重新自检' : '无改动'}
          </button>
          <button
            className="btn"
            onClick={() => { setPending({ kv: null, store: null, indexing: null }); onApply({ kv: null, store: null, indexing: null }); }}
          >
            恢复自动
          </button>
          <button className="btn" onClick={() => onApply(pending)}>重新自检</button>
        </div>

        <CoreBlock platform={platform} />

        <div className="section-title">诊断 JSON</div>
        <div className="row" style={{ marginBottom: 6 }}>
          <button className="btn btn--sm" onClick={() => void copy()}>
            {copied ? '已复制' : '复制'}
          </button>
        </div>
        <pre className="diag">{diagnostics}</pre>
      </div>
    </div>
  );
}

function SlotBlock({
  slot, pending, onPick,
}: {
  slot: SlotReport;
  pending: string | null;
  onPick: (slot: SlotId, id: string) => void;
}) {
  return (
    <>
      <div className="section-title">{SLOT_LABEL[slot.slot]}</div>
      <div className="faint" style={{ marginTop: -6, marginBottom: 8 }}>{SLOT_HINT[slot.slot]}</div>

      {slot.error && <div className="alert alert--bad" style={{ marginBottom: 8 }}>{slot.error}</div>}
      {slot.overrideFailed && (
        <div className="alert alert--warn" style={{ marginBottom: 8 }}>
          {slot.overrideFailed}　（已回退到自动选择）
        </div>
      )}

      {slot.candidates.map((c) => {
        const isPending = pending === c.id;
        return (
          <div
            key={c.id}
            className="strat"
            data-selected={c.selected}
            data-ok={c.ok}
            onClick={() => onPick(slot.slot, c.id)}
            style={isPending ? { outline: '2px solid var(--accent)', outlineOffset: -2 } : undefined}
          >
            <div className="row" style={{ gap: 6 }}>
              <span className={`badge badge--${c.tier}`}>{TIER_LABEL[c.tier]}</span>
              <span className="grow truncate" style={{ fontWeight: 560 }}>{c.label}</span>
              {c.selected && <span className="badge badge--accent">使用中</span>}
              {isPending && !c.selected && <span className="badge badge--plain">待应用</span>}
            </div>
            <div className="probe-detail">
              <span style={{ color: c.ok ? 'var(--ok)' : 'var(--bad)' }}>
                {c.ok ? '✓ 探测通过' : '✗ 探测失败'}
              </span>
              {' — '}{c.detail}
            </div>
            <div className="probe-detail faint">{c.note}</div>
            <div className="probe-detail faint mono">{c.id}</div>
          </div>
        );
      })}
    </>
  );
}

/**
 * 调试面板自己的会话标识。
 *
 * 为什么要给调试请求带上会话：不带的话 Set-Cookie 根本不会被收进任何会话，
 * 于是「收走 N 个 cookie」这条审计信息永远看不到 —— 看起来像功能没生效。
 * 带上之后，访问任何会种 cookie 的站点都能观察到它。
 */
const DEBUG_SESSION = 'debug-panel';

/**
 * 核心层观察窗（DESIGN.md §8.1）。
 *
 * 三件事：
 *   1. 如实展示当前传输层、vault 保护强度、白名单与各项限额
 *   2. 白名单可**当场改**并立即生效（不用重启平台），改完存起来
 *   3. 审计记录列表 —— 每一次放行/拒绝都能看到，包括被拒的原因码
 */
function CoreBlock({ platform }: { platform: Platform }) {
  const core = platform.core;
  const [text, setText] = useState(() => core.net.allowlist.join('\n'));
  const [url, setUrl] = useState('https://api.example.com/zen');
  const [verdict, setVerdict] = useState<string | null>(null);
  const [rows, setRows] = useState<AuditEntry[]>(() => core.audit.tail(20));
  const [busy, setBusy] = useState(false);
  const [cookies, setCookies] = useState<number | null>(
    () => core.sessions.cookieCount?.(DEBUG_SESSION) ?? null,
  );

  const status = core.status();

  const refresh = () => {
    setRows(core.audit.tail(20));
    setCookies(core.sessions.cookieCount?.(DEBUG_SESSION) ?? null);
  };

  const applyAllowlist = () => {
    const list = parseAllowlistText(text);
    try {
      core.net.setAllowlist(list);          // 编译失败会抛错，且不改动现有白名单
      saveAllowlist(list);
      setVerdict(list.length === 0
        ? '白名单已清空 —— 现在任何请求都会被拒绝（默认拒绝）。'
        : `已生效，共 ${list.length} 条规则。`);
    } catch (e) {
      setVerdict(`规则有误，未改动现有白名单：${e instanceof Error ? e.message : String(e)}`);
    }
    refresh();
  };

  const check = async () => {
    const r = await core.call(null, 'net.check', { url }) as
      { ok: true; host: string; path: string } | { ok: false; code: string; message: string };
    setVerdict(r.ok
      ? `✓ 允许：${r.host}${r.path}`
      : `✗ 拒绝（${r.code}）：${r.message}`);
  };

  const fire = async () => {
    setBusy(true);
    setVerdict(null);
    // 调试面板是本进程内的可信代码，可以直接签发令牌 —— 插件拿不到这个能力
    const token = core.issueToken('app.matrix.debug', ['net'], 60_000);
    try {
      const res = await core.call(token.id, 'net.request', {
        url,
        // 带上会话：否则 Set-Cookie 不会被收走，「收走 N 个 cookie」也就永远看不到
        session: DEBUG_SESSION,
      }) as {
        status: number; bytes: number; ms: number; hops: string[];
        jsonRoundTrip?: boolean; bigIntRisk?: number;
      };
      let msg = `✓ HTTP ${res.status} · ${res.bytes} 字节 · ${res.ms}ms · ${res.hops.length} 跳`;
      if (res.jsonRoundTrip) msg += ' · 响应体经 JSON 往返（不是线上原始字节）';
      if (res.bigIntRisk) msg += ` · ⚠️ ${res.bigIntRisk} 个大整数可能已丢精度`;
      setVerdict(msg);
    } catch (e) {
      setVerdict(`✗ 失败（${errorCode(e)}）：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const auditStats = status.audit;
  const disk = platform.auditStore.stats;

  return (
    <>
      <div className="section-title">核心层（网络出口 / 凭证库）</div>
      <div className="faint" style={{ marginTop: -6, marginBottom: 8 }}>
        全系统唯一允许出网的地方。插件运行在沙箱里，够不到这里；
        所有请求都要先过白名单、限流、大小上限，并留下审计。
      </div>

      <div className="probe-detail">
        <strong>传输层</strong>：<span className="mono">{status.transport}</span>
        {status.transportAvailable ? '（原生可用）' : '（原生插件不可用 —— 将拒绝一切请求）'}
      </div>

      <div className="probe-detail" style={{ alignItems: 'center' }}>
        <strong>会话后端</strong>：{' '}
        <button
          className={`btn btn--sm ${core.session.backend === 'memory' ? 'btn--primary' : ''}`}
          onClick={() => { core.setSessionBackend('memory'); refresh(); }}
        >
          memory（隔离）
        </button>{' '}
        <button
          className={`btn btn--sm ${core.session.backend === 'capacitor-cookies' ? 'btn--primary' : ''}`}
          onClick={() => { core.setSessionBackend('capacitor-cookies'); refresh(); }}
        >
          capacitor-cookies（原生）
        </button>
      </div>
      <div className="faint" style={{ marginBottom: 6 }}>
        ⚠️ <span className="mono">CapacitorHttp</span> 的原生 cookie 存储是<strong>进程全局</strong>的
        （<span className="mono">CapacitorCookies.java:26</span> 装了全局
        <span className="mono">CookieHandler</span>，插件注册时无条件执行），
        <strong>从 JS 关不掉</strong>。所以即使用 memory 后端，
        原生层仍会自动附加它自己的 cookie —— 跨插件隔离在传输层不成立。
        两种后端的区别是：memory 的 cookie 不进原生存储，capacitor-cookies 能<strong>精确撤销</strong>。
      </div>

      <div className="probe-detail">
        <strong>调试会话</strong>：<span className="mono">{DEBUG_SESSION}</span> ·
        当前持有 {cookies === null ? '未知（该后端不上报）' : `${cookies} 条 cookie`}
        {cookies === 0 ? '（访问会种 cookie 的站点后这里会变）' : ''}
      </div>

      <div className="probe-detail">
        <strong>凭证库</strong>：{status.vault.protection} — {status.vault.note}
      </div>
      <div className="probe-detail">
        <strong>限额</strong>：超时 {status.gateway.defaultTimeoutMs / 1000}s ·
        响应上限 {(status.gateway.defaultMaxBytes / 1024 / 1024).toFixed(1)}MB ·
        最多 {status.gateway.maxRedirects} 跳 ·
        幂等方法重试 {status.gateway.retryCount} 次 ·
        限流 {status.gateway.rateCapacity} 次 / 每 {(status.gateway.rateCapacity / status.gateway.rateRefillPerSec).toFixed(0)}s 补满
      </div>

      <div className="section-title" style={{ fontSize: 13 }}>域名白名单</div>
      <div className="faint" style={{ marginTop: -6, marginBottom: 6 }}>
        每行一条。<span className="mono">example.com</span> 精确匹配；
        <span className="mono">*.example.com</span> 匹配任意层子域（<strong>不含</strong>根域）。
        IP 字面量、http、带 userinfo 的 URL 一律拒绝，改不了。
      </div>
      <textarea
        className="diag"
        style={{ minHeight: 76, width: '100%', resize: 'vertical' }}
        value={text}
        placeholder={'例如：\napi.example.com\n*.cdn.example.com'}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn btn--sm btn--primary" onClick={applyAllowlist}>保存并生效</button>
        <button className="btn btn--sm" onClick={() => setText('')}>清空</button>
        <div className="grow" />
        <span className="faint">{core.net.allowlist.length} 条生效中</span>
      </div>

      <div className="section-title" style={{ fontSize: 13 }}>试一下</div>
      <input
        className="diag"
        style={{ width: '100%', minHeight: 0, padding: '8px 10px' }}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn btn--sm" onClick={() => void check()}>只判定（不发请求）</button>
        <button className="btn btn--sm" onClick={() => void fire()} disabled={busy}>
          {busy ? '请求中…' : '真发一次请求'}
        </button>
      </div>
      {verdict && (
        <div className="alert alert--info" style={{ marginTop: 6, wordBreak: 'break-all' }}>{verdict}</div>
      )}

      <div className="section-title" style={{ fontSize: 13 }}>
        审计记录　<span className="faint" style={{ fontWeight: 400 }}>
          放行 {auditStats.ok} · 拒绝 {auditStats.denied} · 出错 {auditStats.error}
        </span>
      </div>
      <div className="faint" style={{ marginTop: -6, marginBottom: 6 }}>
        落盘：缓冲 {disk.buffered} 条 · 已写 {disk.writes} 次
        {disk.lastError ? ` · ⚠️ 上次写入失败：${disk.lastError}` : ''}
      </div>
      <div className="row" style={{ marginBottom: 6 }}>
        <button className="btn btn--sm" onClick={refresh}>刷新</button>
        <button
          className="btn btn--sm"
          onClick={() => { void platform.auditStore.flush(); refresh(); }}
        >
          立即落盘
        </button>
      </div>
      {rows.length === 0
        ? <div className="faint">还没有记录。上面「真发一次请求」后会出现在这里。</div>
        : rows.map((e, i) => (
          <div key={`${e.at}-${i}`} className="probe-detail" style={{ borderTop: i ? '1px solid var(--line)' : undefined, paddingTop: i ? 6 : 0 }}>
            <span
              className={`badge badge--${e.outcome === 'ok' ? 'ideal' : e.outcome === 'denied' ? 'fallback' : 'dev'}`}
            >
              {e.outcome === 'ok' ? '放行' : e.outcome === 'denied' ? '拒绝' : '出错'}
            </span>
            {' '}
            <span className="mono">{e.method} {e.host}{e.path}</span>
            <div className="faint">
              {new Date(e.at).toLocaleTimeString()}
              {e.status !== null ? ` · HTTP ${e.status}` : ''}
              {` · ${e.bytes} 字节 · ${e.ms}ms`}
              {e.code ? ` · ${e.code}` : ''}
              {e.hops && e.hops.length > 1 ? ` · 经 ${e.hops.length} 跳` : ''}
              {e.cookiesSet ? ` · 收走 ${e.cookiesSet} 个 cookie` : ''}
              {e.jsonRoundTrip ? ' · JSON 往返' : ''}
              {e.bigIntRisk ? ` · ⚠️ ${e.bigIntRisk} 个大整数可能丢精度` : ''}
              {` · ${e.pluginId}`}
            </div>
          </div>
        ))}

      <div className="section-title" style={{ fontSize: 13 }}>插件</div>
      <IcsImportView platform={platform} />
    </>
  );
}
