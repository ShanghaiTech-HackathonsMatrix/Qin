/**
 * 课次详情（课程详情）。
 *
 * ## 为什么长这样
 *
 * 和 `AssignmentSheet` 共用**同一套 `.ddl-detail` 版式**：黑标题带 + 来源标记 +
 * 大号标题 + 定义列表 + 底部动作。早先这里是朴素的 `.sheet` 表单（一个 h3 加
 * 几行 `<p>`），于是同一份数据在「作业」和「课程」两个入口长得完全不同 ——
 * 一个像设计稿，一个像后台管理页。两处现在共用同一套 class。
 *
 * 和作业详情的差别只有一处：**这里只有备注能改**。教务给的是课时规则
 * （周几、第几节、哪几周），改它没有意义 —— 下次同步就重写。所以标题是
 * 只读的 `<h2>`，可编辑的只有底部那块备注。
 *
 * ## 保存的语义
 *
 * `editLesson` 只落 `note` 一项到本机修正表（见 `core/academic-service.ts`），
 * 平台原文不动，重新同步也不会覆盖备注。
 */

import { useState } from 'react';

import type { AcademicService } from '../core/academic-service';
import { PROVIDER_LABEL } from '../app/ddl-items';
import { weeksText } from '../app/timetable';

const WEEKDAY = '一二三四五六日';

export default function LessonSheet({ id, service: s, close }: { id: string; service: AcademicService; close: () => void }) {
  const raw = s.snapshots.flatMap((x) => x.rules).find((x) => x.id === id);
  const [note, setNote] = useState(s.corrections.lessons[id]?.note ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (raw === undefined) return null;

  // 显示的是「修正后的样子」：用户在别处改过教师/地点，这里要跟着变
  const r = { ...raw, ...s.corrections.lessons[id] };
  const provider = s.snapshots.find((x) => x.rules.some((rule) => rule.id === id))?.provider;
  const start = s.settings.periods[r.first - 1]?.start;
  const end = s.settings.periods[r.last - 1]?.end;

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      await s.editLesson(id, { note });
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ddl-detail-backdrop" onClick={close}>
      <section
        className="ddl-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lesson-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ddl-detail__band">
          <span className="ddl-detail__kicker">COURSE / 课程详情</span>
          {/* 黑标题带上放黑圆会看不见，沿用作业详情那颗白描边圆 */}
          <button type="button" className="ddl-detail__close" onClick={close} aria-label="关闭">×</button>
        </header>

        <form
          className="ddl-detail__scroll"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <span className="ddl-detail__source">
            {provider === undefined ? '课程' : (PROVIDER_LABEL[provider] ?? provider)}
          </span>

          <h2 className="ddl-detail__title" id="lesson-title">{r.title}</h2>

          <dl className="ddl-detail__rows">
            <div>
              <dt>教师</dt>
              <dd>{r.teacher === '' ? '待补充' : r.teacher}</dd>
            </div>
            <div>
              <dt>地点</dt>
              <dd>{r.location === '' ? '待补充' : r.location}</dd>
            </div>
            <div>
              <dt>上课时间</dt>
              <dd>周{WEEKDAY[r.weekday - 1]} · 第 {r.first}–{r.last} 节</dd>
            </div>
            {start !== undefined && end !== undefined && (
              <div>
                <dt>节次时间</dt>
                <dd>{start}–{end}</dd>
              </div>
            )}
            <div>
              <dt>教学周</dt>
              <dd>{weeksText(r.weeks)}</dd>
            </div>
            {r.code !== '' && (
              <div>
                <dt>课程号</dt>
                <dd>{r.code}</dd>
              </div>
            )}
          </dl>

          <label className="ddl-detail__note">
            个人备注
            <textarea
              maxLength={1000}
              value={note}
              placeholder="例如：这门课要带电脑"
              aria-label="个人备注"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>

          {error !== '' && <p className="ddl-detail__foot" role="alert">{error}</p>}

          <div className="ddl-detail__actions">
            <button type="button" className="btn" onClick={close}>关闭</button>
            <button type="submit" className="btn btn--primary grow" disabled={busy || s.busy}>保存备注</button>
          </div>

          <p className="ddl-detail__foot">
            备注只存在本机，重新同步不会覆盖。课程时间以教务为准。
          </p>
        </form>
      </section>
    </div>
  );
}
