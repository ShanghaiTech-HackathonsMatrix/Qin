import {confirmAction} from '../components/ConfirmDialog';
import { useEffect, useRef, useState } from 'react';
import type { Platform } from '../platform/bootstrap';
import type { AcademicService } from '../core/academic-service.ts';
import { PROVIDER_LABEL } from '../app/ddl-items';
import ExternalPluginsView from './ExternalPluginsView';
import ExternalAccountsView from './ExternalAccountsView';
import WidgetSettings from './WidgetSettings';
import type {Manifest} from '@matrix/plugin-api';
import {openExternal} from '../platform/open-external';
import {
  DENSITY_LABEL, FONT_SCALE_MAX, FONT_SCALE_MIN, FONT_SCALE_STEP, LAYOUT_LABEL,
  type AppSettings, type Density, type Layout,
} from '../app/settings';

/*
 * 设置页的排版语法，全页只有三条：
 *
 * 1. `.section-title` —— 一组设置的名字，**永远在卡片外面**，卡片里不再有标题。
 *    之前「外观」在卡片外、「提醒与日期」在卡片里、「用户与账号」套了一层卡片
 *    又往里面塞卡片，同一页出现三种层级画法，看起来就是乱的。
 * 2. `.card` —— 一组设置的容器，里面只有内容，不套卡片。
 * 3. `.conn` —— 一条「连着外部东西」的项（平台、课表基准、上课时间），
 *    带边框、自带图标和状态；折叠的也是 `.conn`，展开箭头统一在右边。
 *
 * 换句话说：标题在外、卡片在中、条目在内。三层各自只干一件事。
 */

interface Props {
  platform: Platform;
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  onOpenDebug: () => void;
  onResetData: () => void;
  onNavigate:(to:string)=>void;onAddHome:(manifest:Manifest)=>Promise<void>;
}

const APP_VERSION = '0.2.0-dev';

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
  { id: 'gradescope', name: PROVIDER_LABEL.gradescope, mark: 'G', hint: '作业与截止时间' },
  { id: 'blackboard', name: PROVIDER_LABEL.blackboard, mark: '教', hint: '课程与作业' },
  { id: 'eams', name: PROVIDER_LABEL.eams, mark: '课', hint: '课表与节次' },
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
    <div className="stack">
      {!academic.available && (
        <p className="conn__note" data-tone="info">
          网页登录暂不支持，请在手机应用中登录并同步。
        </p>
      )}
      {simulated && (
        <p className="conn__note" data-tone="info">
          模拟模式：使用示例数据，不会联网。
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

            {/*
              有状态就显示状态，没有就看快照。
              早先这里写死 `?? '尚未同步'`，于是恢复出上次同步的快照后，
              徽标写「已同步」、下面一行写「尚未同步」，自相矛盾。
            */}
            {academic.statuses[item.id] !== undefined && (
              <p className="conn__note" data-tone={academic.statuses[item.id]?.startsWith('同步成功') === true ? 'ok' : 'info'}>
                {academic.statuses[item.id]}
              </p>
            )}
            {snapshot !== undefined && (
              <p className="conn__note" data-tone="info">
                最近同步：{stamp(snapshot.syncedAt)} · {snapshot.courses.length} 门课 · {snapshot.assignments.length} 项作业
                {item.id === 'eams' ? ` · 排课 ${snapshot.rules.length}` : ''}
              </p>
            )}

            <div className="conn__actions">
              <button
                className="btn btn--sm btn--primary"
                disabled={busy || !academic.available || academic.enabled[item.id]===false}
                onClick={() => void run(() => academic.login(item.id as ProviderId))}
              >
                登录
              </button>
              <button
                className="btn btn--sm"
                disabled={busy || !academic.available || academic.enabled[item.id]===false}
                onClick={() => void run(() => academic.sync(item.id as ProviderId), '同步完成')}
              >
                {busy ? '处理中…' : '同步'}
              </button>
              <button className="btn btn--sm" disabled={busy} onClick={()=>void run(()=>academic.setEnabled(item.id,academic.enabled[item.id]===false))}>{academic.enabled[item.id]===false?'启用':'停用'}</button>
              {item.id==='blackboard'&&<button className="btn btn--sm" disabled={busy||!academic.available||academic.enabled.blackboard===false} onClick={()=>void run(()=>academic.sync('blackboard',true),'目录扫描完成')}>扫描课程目录</button>}
            </div>
            {item.id==='blackboard'&&snapshot&&<details><summary>打开 BB 课程网页</summary>{snapshot.courses.map(c=><p key={c.id}><button className="btn btn--sm" onClick={()=>void run(()=>openExternal(c.url))}>{c.title}</button></p>)}</details>}
          </div>
        );
      })}

      {note !== null && <p className="conn__note" data-tone={note.tone}>{note.text}</p>}
      {busy&&<button className="btn" onClick={()=>{academic.cancel();setNote({tone:'info',text:'正在停止，请稍候。已读取的内容会保留。'});}}>停止同步</button>}

      <div className="conn__actions">
        <button
          className="btn btn--sm"
          disabled={busy || !academic.available}
          onClick={() => void run(() => academic.clearLogin(), '已清除平台登录状态，课表保留')}
        >
          清除全部平台登录状态
        </button>
      </div>
    </div>
  );
}

/**
 * 课表基准。
 *
 * 教务给的是「第几周、星期几、第几节」，没有真实日期 —— 必须有人告诉它
 * 第 1 教学周从哪天开始，否则课次展开不出来。填错了整张课表就整体错位，
 * 所以这里不猜默认值，空着就明说「填了才会出现在日程里」。
 *
 * 和「上课时间与课间」同一个形状：折叠的 `.conn`，右边一枚状态徽标。
 * 没填时默认展开 —— 这是必须处理的空档，藏起来只会让人以为课表坏了。
 */
function TimetableSetup({ academic }: { academic: AcademicService }) {
  const [weekOne, setWeekOne] = useState(academic.settings.weekOne);
  const [totalWeeks, setTotalWeeks] = useState(String(academic.settings.totalWeeks));
  const [note, setNote] = useState<{ tone: 'info' | 'bad' | 'ok'; text: string } | null>(null);
  const filled = academic.settings.weekOne !== '';

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
    <details className="conn" open={!filled}>
      <summary className="conn__head">
        <span className="conn__mark" aria-hidden="true">周</span>
        <span className="conn__title">
          <strong>课表基准</strong>
          <small>第 1 教学周从哪天开始</small>
        </span>
        <span className="conn__status" data-tone={filled ? 'on' : 'off'}>{filled ? '已设置' : '未设置'}</span>
        <span className="conn__chev" aria-hidden="true">▾</span>
      </summary>

      <div className="conn__grid">
        <label className="conn__field">
          <span>第 1 教学周的周一</span>
          <input type="date" value={weekOne} onChange={(e) => setWeekOne(e.target.value)} />
        </label>
        <label className="conn__field">
          <span>学期总周数</span>
          <input type="number" min={1} max={60} value={totalWeeks} onChange={(e) => setTotalWeeks(e.target.value)} />
        </label>
      </div>

      <p className="conn__note" data-tone="info">
        {filled ? '保存后，日程与课表中的课程日期会随之更新。' : '请填写第 1 教学周的周一，课程才会出现在日程与课表里。'}
      </p>
      {note !== null && <p className="conn__note" data-tone={note.tone}>{note.text}</p>}

      <div className="conn__actions">
        <button className="btn btn--sm btn--primary" disabled={academic.busy} onClick={() => void save()}>保存</button>
      </div>
    </details>
  );
}

/**
 * 上课时间与课间。
 *
 * 和「课表基准」同一个形状：折叠的 `.conn`、同样的标题行、同样的状态徽标。
 * 默认收起 —— 十几节课的起止时间摊开来比这一页其它内容加起来还长。
 */
function PeriodSettings({academic:s}:{academic:AcademicService}){
  const [periods,setPeriods]=useState(()=>s.settings.periods.map(p=>({...p}))),[note,setNote]=useState('');
  return <details className="conn">
    <summary className="conn__head">
      <span className="conn__mark" aria-hidden="true">节</span>
      <span className="conn__title"><strong>上课时间与课间</strong><small>每节课的起止时间</small></span>
      <span className="conn__status">{periods.length} 节</span>
      <span className="conn__chev" aria-hidden="true">▾</span>
    </summary>

    <div className="conn__grid">
      {periods.map((p,i)=><div className="conn__pair" key={i}>
        <span>第 {i+1} 节 · {p.group}</span>
        <div className="conn__pair-inputs">
          <input type="time" aria-label={`第${i+1}节开始`} value={p.start} onChange={e=>setPeriods(rows=>rows.map((q,j)=>i===j?{...q,start:e.target.value}:q))}/>
          <span aria-hidden="true">–</span>
          <input type="time" aria-label={`第${i+1}节结束`} value={p.end} onChange={e=>setPeriods(rows=>rows.map((q,j)=>i===j?{...q,end:e.target.value}:q))}/>
        </div>
      </div>)}
    </div>

    <p className="conn__note" data-tone="info">改完保存即可，重新同步不会覆盖这里的时间。</p>
    {note!==''&&<p className="conn__note" data-tone="ok">{note}</p>}

    <div className="conn__actions">
      <button className="btn btn--sm btn--primary" disabled={s.busy} onClick={()=>void(async()=>{try{await s.saveSettings({...s.settings,periods});setNote('上课时间已保存');}catch(e){setNote(String(e));}})()}>保存上课时间</button>
    </div>
  </details>;
}

function ReminderSettings({academic:s}:{academic:AcademicService}){
  const [d,setD]=useState(s.settings),[note,setNote]=useState('');
  return <div className="card stack">
    <label><input type="checkbox" checked={d.reminders} onChange={e=>setD({...d,reminders:e.target.checked})}/> 开启课表和作业提醒</label>
    <label>课前提前（分钟）<input className="field" type="number" min="0" max="43200" value={d.lessonLead} onChange={e=>setD({...d,lessonLead:Number(e.target.value)})}/></label>
    <label>DDL 提前（分钟）<input className="field" type="number" min="0" max="43200" value={d.dueLead} onChange={e=>setD({...d,dueLead:Number(e.target.value)})}/></label>
    <label>Gradescope 无时区日期的时区<input className="field" placeholder="例如 Asia/Shanghai" value={d.gradescopeTimezone} onChange={e=>setD({...d,gradescopeTimezone:e.target.value})}/></label>
    <p className="faint">{s.reminderStatus}</p><button className="btn" disabled={s.busy} onClick={()=>void(async()=>{try{if(d.reminders)await s.requestReminderPermission();await s.saveSettings({...s.settings,reminders:d.reminders,lessonLead:d.lessonLead,dueLead:d.dueLead,gradescopeTimezone:d.gradescopeTimezone});setNote('已保存');}catch(e){setNote(String(e));}})()}>保存提醒设置</button>{note&&<p role="status">{note}</p>}
  </div>;
}

export default function SettingsView({ platform, settings, onChange, onOpenDebug, onResetData,onNavigate,onAddHome }: Props) {
  const [page,setPage]=useState<'root'|'account'|'general'|'plugins'|'runtime'>('root');
  const names={account:'用户与账号',general:'通用设置',plugins:'插件管理',runtime:'运行与关于'};
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
      {page==='root'
        ? <div className="settings-menu">{(Object.keys(names) as (keyof typeof names)[]).map(key=><button className="settings-menu__item" key={key} onClick={()=>setPage(key)}><strong>{names[key]}</strong><span>›</span></button>)}</div>
        : <button className="btn" onClick={()=>setPage('root')}>‹ 设置 · {names[page]}</button>}

      {page==='account'&&<>
        <p className="faint">Gradescope 用邮箱登录，互动教学平台和教务课表用学校账号。登录信息只保存在本机。</p>

        <div className="section-title">平台连接</div>
        <PlatformConnections academic={platform.academic} simulated={platform.academicSimulated}/>

        <div className="section-title">课表</div>
        <div className="stack">
          <TimetableSetup academic={platform.academic} />
          <PeriodSettings academic={platform.academic}/>
        </div>

        <div className="section-title">插件账号</div>
        <ExternalAccountsView platform={platform}/>
      </>}

      {page==='general'&&<>
        <div className="section-title">桌面挂件</div>
        <WidgetSettings platform={platform}/>

        <div className="section-title">提醒</div>
        <ReminderSettings academic={platform.academic}/>

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
              只放大正文和截止时间。100% 为默认大小。
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
              列表更紧凑，卡片更清晰。适用于任务页和其他列表。
            </div>
          </div>
        </div>
      </>}

      {page==='plugins'&&<>
        <div className="section-title">内置插件</div>
        <div className="card stack">
          <p className="faint">课表、作业与 ICS 导入由应用内置，不需要单独安装。</p>
          {/* 平台连接的登录与同步只在「用户与账号」里出现一次，这里不再复制一份 */}
          <button className="btn" onClick={()=>setPage('account')}>平台连接（Gradescope / 互动教学平台 / 教务课表）在「用户与账号」里 ›</button>
        </div>

        <div className="section-title">外部插件</div>
        <ExternalPluginsView platform={platform} onNavigate={onNavigate} onAddHome={onAddHome}/>
      </>}

      {page==='runtime'&&<>
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
            onClick={async () => { if (await confirmAction('确定清空全部数据？此操作不可撤销。')) onResetData(); }}
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
            外部插件独立运行，数据保存在本机。
          </div>
        </div>
      </>}
    </>
  );
}
