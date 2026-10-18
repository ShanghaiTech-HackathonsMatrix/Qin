import { useEffect, useRef, useState } from 'react';
import { AndroidWidget, widgetAvailable } from '../platform/android-widget';
import type { Platform } from '../platform/bootstrap';
import './widget-settings.css';

export default function WidgetSettings({ platform }: { platform: Platform }) {
  const available = widgetAvailable();
  const [state, setState] = useState<{ enabled: boolean; status: string } | null>(null);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const locked = useRef(false);

  useEffect(() => {
    if (!available) return;
    let active = true;
    const read = async () => {
      if (locked.current) return;
      try {
        const next = await AndroidWidget.state();
        if (active && !locked.current) setState(next);
      } catch (e) {
        if (active) setNote({ error: true, text: e instanceof Error ? e.message : String(e) });
      }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [available]);

  const run = async (key: string, fn: () => Promise<unknown>, text: string) => {
    if (locked.current) return;
    locked.current = true;
    setAction(key);
    setNote(null);
    try {
      await fn();
      setNote({ error: false, text });
      setState(await AndroidWidget.state());
    } catch (e) {
      setNote({ error: true, text: e instanceof Error ? e.message : String(e) });
    } finally {
      locked.current = false;
      setAction(null);
    }
  };
  const disabled = !available || action !== null;

  return (
    <section className="widget-settings" aria-label="桌面挂件设置" aria-busy={action !== null}>
      <div className="widget-settings__intro">
        <span className="widget-settings__badge">桌面速览</span>
        <h3>课程和待办，抬眼就能看</h3>
        <p>放到手机桌面，不打开应用也能查看今日安排。</p>
        <button className="btn btn--primary widget-settings__add" disabled={disabled}
          onClick={() => void run('add', () => AndroidWidget.pinWidget(), '请在弹出的系统窗口中确认添加。')}>
          <span aria-hidden="true">＋</span> {action === 'add' ? '正在请求添加…' : '添加到桌面'}
        </button>
        <small>{available ? '点击后，在系统窗口中确认即可。' : '目前仅支持 Android；此处可预览使用说明。'}</small>
      </div>

      <div className="widget-settings__section">
        <h4>添加后，这样用</h4>
        <ul className="widget-settings__gestures">
          <li><span className="widget-settings__gesture" aria-hidden="true">↕</span><div><strong>上下滑动 · 切换内容</strong><p>上滑看今日课程，下滑看待办。</p></div></li>
          <li><span className="widget-settings__gesture" aria-hidden="true">×2</span><div><strong>双击条目 · 查看详情</strong><p>双击课程打开课表；双击作业打开对应网页或应用内详情。</p></div></li>
          <li><span className="widget-settings__gesture" aria-hidden="true">↻</span><div><strong>单击内容 · 联网更新</strong><p>获取互动教学平台（BB）和 Gradescope 的最新作业信息。</p></div></li>
        </ul>
        <p className="widget-settings__tip">滑动时请完整翻到下一页，避免停在两页之间。放大挂件可显示更多条目。</p>
      </div>

      <div className="widget-settings__section">
        <h4>数据更新</h4>
        <label className="widget-settings__toggle-row">
          <span><strong>自动更新</strong><small>{state === null ? (available ? '正在读取设置…' : '在 Android 上可开启') : state.enabled ? '已开启 · 在后台定期获取新数据' : '已关闭 · 需要时可手动更新'}</small></span>
          <input className="widget-settings__switch" type="checkbox" role="switch" aria-label="自动更新"
            disabled={disabled || state === null} checked={state?.enabled ?? false}
            onChange={(e) => {
              const enabled = e.target.checked;
              void run('auto', () => AndroidWidget.configure({ enabled }), enabled ? '已开启自动更新。' : '已关闭自动更新，可随时手动更新。');
            }} />
        </label>
        <p className="widget-settings__tip">省电模式可能延迟更新。想现在获取新内容？点下方按钮。</p>
        <button className="btn widget-settings__sync" disabled={disabled}
          onClick={() => void run('sync', () => AndroidWidget.syncNow(), '已请求联网更新，请稍候查看结果。')}>
          {action === 'sync' ? '正在请求更新…' : '立即联网更新'}
        </button>
      </div>

      {note && <p className="widget-settings__feedback" data-error={note.error} role={note.error ? 'alert' : 'status'}>{note.text}</p>}

      <details className="widget-settings__help">
        <summary>内容没更新？</summary>
        <div className="widget-settings__help-body">
          <p><strong>应用里已更新，挂件还没变</strong><br />刷新挂件显示即可，不会重新联网获取数据。</p>
          <button className="btn" disabled={disabled}
            onClick={() => void run('refresh', async () => { await platform.academic.refreshBackground(); await AndroidWidget.requestRefresh(); }, '已用本机数据刷新挂件显示。')}>
            {action === 'refresh' ? '正在刷新…' : '刷新挂件显示'}
          </button>
          <p><strong>提示登录过期</strong><br />到「设置 → 用户与账号」重新登录对应平台。</p>
          {state?.status && <p className="widget-settings__status">运行状态：{state.status}</p>}
        </div>
      </details>
    </section>
  );
}
