/**
 * ICS 导入的宿主视图（第一方插件的 React 侧）。
 *
 * ## 它为什么长这样
 *
 * 宿主侧**没有组件注册表**（`contributes.views` 会被解析但不会渲染，§12 的未实现项）。
 * 所以第一方插件的 UI 现在是**硬编码挂载**的：这个组件被 `DebugPanel` 直接 import。
 * 等组件注册表 + 布局引擎落地后，这里会变成「注册一个组件，由布局 JSON 引用它」——
 * 但那时改的是**挂载方式**，不是这个组件本身。
 *
 * ## 视图不认识插件内部
 *
 * 它只知道三件事：插件 id、本地文档键、以及「DataBus 里有 `course` / `session`」。
 * 解析逻辑一行都不在这里 —— 这正是「宿主渲染、插件纯函数」的分工。
 */

import { useCallback, useEffect, useState } from 'react';

import type { EntityRecord, SyncReport } from '@matrix/kernel';
import type { Platform } from '../../../platform/bootstrap';

import { LOCAL_URL, PLUGIN_ID } from './manifest.ts';

/** 宿主视图没有插件身份，借宿主自己的命名空间读（与 conformance 测试同一个常量） */
const HOST_VIEW_ID = 'dev.matrix.shell';

interface CourseData {
  title?: unknown;
  code?: unknown;
}

interface SessionData {
  courseId?: unknown;
  title?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  location?: unknown;
  rrule?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function formatWhen(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} 周${'日一二三四五六'[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Props {
  platform: Platform;
}

export default function IcsImportView({ platform }: Props) {
  const [text, setText] = useState('');
  const [courseTitle, setCourseTitle] = useState('');
  const [offset, setOffset] = useState('480');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [courses, setCourses] = useState<EntityRecord[]>([]);
  const [sessions, setSessions] = useState<EntityRecord[]>([]);

  const refresh = useCallback(() => {
    const c = platform.plugins.bus.read(HOST_VIEW_ID, 'course');
    const s = platform.plugins.bus.read(HOST_VIEW_ID, 'session');
    setCourses(c.ok ? c.data : []);
    setSessions(s.ok ? s.data : []);
  }, [platform]);

  // DataBus 的订阅是**同步**回调，emit 当场触发 → 这里直接重渲染，不需要轮询
  useEffect(() => {
    refresh();
    return platform.plugins.bus.subscribe(() => refresh());
  }, [platform, refresh]);

  const doImport = useCallback(async () => {
    if (text.trim() === '') {
      setError('先粘贴一份 ICS 内容');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // ① 宿主把文档放进「本地文档表」，键是 (pluginId, host://import)
      const provided = platform.plugins.provideLocal(PLUGIN_ID, LOCAL_URL, text);
      if (!provided.ok) {
        setError(`${provided.code}：${provided.message}`);
        return;
      }

      // ② 宿主驱动状态机。插件只产出请求描述，文档由宿主喂回去
      const r = await platform.plugins.sync(PLUGIN_ID, {
        trigger: 'manual',
        now: Date.now(),
        settings: {
          ...(courseTitle.trim() !== '' ? { courseTitle: courseTitle.trim() } : {}),
          utcOffsetMinutes: offset.trim() === '' ? '480' : offset.trim(),
        },
      });

      // ③ 无论成败都要清掉 —— 否则下一次 sync 会把同一份文件再解析一遍
      platform.plugins.clearLocal(PLUGIN_ID, LOCAL_URL);

      if (!r.ok) {
        setError(`${r.code}：${r.message}`);
        return;
      }
      setReport(r.data);
      refresh();
    } finally {
      setBusy(false);
    }
  }, [platform, text, courseTitle, offset, refresh]);

  const byCourse = new Map<string, EntityRecord[]>();
  for (const s of sessions) {
    const key = str((s.data as SessionData).courseId);
    const list = byCourse.get(key) ?? [];
    list.push(s);
    byCourse.set(key, list);
  }
  for (const list of byCourse.values()) {
    list.sort((a, b) => (num((a.data as SessionData).startAt) ?? 0) - (num((b.data as SessionData).startAt) ?? 0));
  }

  const pluginRec = platform.plugins.registry.get(PLUGIN_ID);

  return (
    <>
      <div className="section-title" style={{ fontSize: 13 }}>
        插件：{PLUGIN_ID}{' '}
        <span className="faint" style={{ fontWeight: 400 }}>
          {pluginRec ? `${pluginRec.state} · 信任 ${pluginRec.trust.level}` : '未安装'}
        </span>
      </div>
      <div className="faint" style={{ marginTop: -6, marginBottom: 6 }}>
        第一方插件，进程内运行。插件<strong>不碰任何 IO</strong>：文件由宿主读、时间由宿主给、
        落库由宿主做 —— 它只把文本算成实体。
        <strong>数据已落盘</strong>（宿主的 KV），刷新 / 重启后自动读回。
        但<strong>目前只在本页显示</strong>，还没并进「课程」页。
      </div>

      <div className="row" style={{ marginBottom: 6 }}>
        <input
          className="diag"
          style={{ flex: 1, minHeight: 0, padding: '8px 10px' }}
          value={courseTitle}
          onChange={(e) => setCourseTitle(e.target.value)}
          placeholder="课程名（留空则用 ICS 的 X-WR-CALNAME）"
          spellCheck={false}
        />
        <input
          className="diag"
          style={{ width: 96, minHeight: 0, padding: '8px 10px' }}
          value={offset}
          onChange={(e) => setOffset(e.target.value)}
          placeholder="UTC 偏移"
          title="墙钟时间按这个偏移换算成 epoch ms。中国为 480（+8），无夏令时。"
          spellCheck={false}
        />
      </div>

      <textarea
        className="diag"
        style={{ minHeight: 110, width: '100%', resize: 'vertical' }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'粘贴 .ics 内容，例如：\nBEGIN:VCALENDAR\n…\nEND:VCALENDAR'}
        spellCheck={false}
      />

      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn btn--sm btn--primary" onClick={() => void doImport()} disabled={busy}>
          {busy ? '导入中…' : '导入'}
        </button>
        <button className="btn btn--sm" onClick={() => { setText(''); setReport(null); setError(null); }}>
          清空输入
        </button>
        <div className="grow" />
        <span className="faint">
          {courses.length} 门课 · {sessions.length} 节课
        </span>
      </div>

      {error !== null && (
        <div className="alert alert--info" style={{ marginTop: 6 }}>{error}</div>
      )}

      {report !== null && (
        <div className="probe-detail" style={{ marginTop: 6 }}>
          <strong>上一轮</strong>：{report.summaries.join('；') || '（无摘要）'}
          <div className="faint">
            请求 {report.requests} · 落库 {report.entities} · 被拒 {report.rejectedEntities} ·
            跨边界 {report.boundaryBytes} 字节 · {report.durationMs}ms
          </div>
          {report.errors.length > 0 && (
            <div className="faint">⚠️ {report.errors.join('；')}</div>
          )}
        </div>
      )}

      {courses.length === 0 ? (
        <div className="faint" style={{ marginTop: 8 }}>还没有数据。粘贴一份 ICS 后点「导入」。</div>
      ) : (
        courses.map((c) => {
          const data = c.data as CourseData;
          const key = c.id;
          const list = byCourse.get(key) ?? [];
          return (
            <div key={key} className="probe-detail" style={{ marginTop: 8 }}>
              <strong>{str(data.title) || '(无标题)'}</strong>
              {str(data.code) !== '' && <span className="mono"> · {str(data.code)}</span>}
              <span className="faint"> · {list.length} 节</span>
              {list.map((s) => {
                const sd = s.data as SessionData;
                const startAt = num(sd.startAt);
                return (
                  <div key={s.id} className="faint" style={{ paddingLeft: 10 }}>
                    <span className="mono">
                      {startAt === null ? '时间未知' : formatWhen(startAt)}
                    </span>
                    {' · '}
                    {str(sd.title) || '(无标题)'}
                    {str(sd.location) !== '' ? ` · ${str(sd.location)}` : ''}
                    {str(sd.rrule) !== '' ? ' · 🔁 周期（未展开）' : ''}
                  </div>
                );
              })}
            </div>
          );
        })
      )}
    </>
  );
}
