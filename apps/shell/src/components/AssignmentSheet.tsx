/**
 * 拉回来的作业的详情。
 *
 * 刻意**不复用** `views/AcademicView.tsx` 里那个 `AssignmentEditor`：
 * 那个是给「课业」整页用的，自带一套密集表单和网格样式。这一版界面是
 * 单色手绘风，弹层里只留四件事 —— 名字、截止时间、备注、完成。
 *
 * 保存的语义要写清楚：改的是**本应用里的个人修正**，
 * 平台原文一个字节都不动。所以「恢复平台数据」永远可用。
 */

import { useState } from 'react';
import { openExternal } from '../platform/open-external';
import {taskTarget} from '../platform/widget-data';

export interface AssignmentDraft {
  id: string;
  title: string;
  /** epoch 毫秒；`null` = 平台没给明确时间 */
  dueAt: number | null;
  note: string;
  done: boolean;
  needsReview: boolean;
  provider: string;
  /** 平台原文，用来对照「我改了什么」 */
  dueText: string;
  courseTitle: string;
  source: string;
  status: string;
  url?: string;
  courseUrl?: string;
}

const STATUS_TEXT: Readonly<Record<string, string>> = {
  not_submitted: '未提交',
  submitted: '已提交',
  graded: '已评分',
  unknown: '状态待确认',
};

const PAD = (n: number) => String(n).padStart(2, '0');

/** epoch → `<input type="datetime-local">` 认的本地时间串 */
export function toLocalInput(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}T${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
}

interface Props {
  draft: AssignmentDraft;
  busy: boolean;
  onSave: (patch: { title?: string; dueAt?: number | null; note?: string; done?: boolean; needsReview?:boolean }) => void;
  onReset: () => void;
  onClose: () => void;
}

export default function AssignmentSheet({ draft, busy, onSave, onReset, onClose }: Props) {
  const [error,setError]=useState('');
  const open=async(url:string)=>{try{await openExternal(url);}catch(e){setError(String(e));}};
  const [title, setTitle] = useState(draft.title);
  const [due, setDue] = useState(toLocalInput(draft.dueAt));
  const [note, setNote] = useState(draft.note);
  const [confirmation, setConfirmation] = useState(draft.done?'done':draft.needsReview?'review':'open');
  const target=taskTarget(draft);

  const submit = () => {
    const patch: { title?: string; dueAt?: number | null; note?: string; done?: boolean; needsReview?:boolean } = {};
    if (title !== draft.title) patch.title = title;
    if (due !== toLocalInput(draft.dueAt)) patch.dueAt = due === '' ? null : new Date(due).getTime();
    if(patch.dueAt!==undefined&&patch.dueAt!==null&&!Number.isFinite(patch.dueAt)){setError('请选择有效的截止时间');return;}
    if (note !== draft.note) patch.note = note;
    patch.done = confirmation==='done';
    patch.needsReview = confirmation==='review';
    onSave(patch);
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form
        className="sheet"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="sheet__head">
          <h2>作业详情</h2>
          <button type="button" className="btn btn--sm" onClick={onClose}>关闭</button>
        </div>

        <div className="assign-meta">
          <span>{draft.courseTitle === '' ? draft.source : `${draft.courseTitle} · ${draft.source}`}</span>
          <span>{STATUS_TEXT[draft.status] ?? draft.status}</span>
        </div>

        <div className="conn__actions">
          {target && <button type="button" className="btn" onClick={()=>void open(target)}>{draft.provider==='blackboard'?'打开 BB 课程 ↗':'打开 Gradescope 作业 ↗'}</button>}
        </div>
        {error && <p role="alert">{error}</p>}
        <label className="field-label">
          名称
          <input className="field" value={title} maxLength={200} required onChange={(e) => setTitle(e.target.value)} />
        </label>

        <label className="field-label">
          截止时间
          <input
            className="field"
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </label>
        <p className="assign-hint">
          平台原文：{draft.dueText === '' ? '未提供明确日期' : draft.dueText}
        </p>

        <label className="field-label">
          个人备注
          <textarea className="field" value={note} maxLength={1000} rows={2} onChange={(e) => setNote(e.target.value)} />
        </label>

        <label className="field-label">个人确认状态
          <select className="field" value={confirmation} onChange={e=>setConfirmation(e.target.value)}>
            <option value="review">待确认</option><option value="open">确认未完成 / 未提交</option><option value="done">确认已完成 / 已提交</option>
          </select>
        </label>
        <p className="assign-hint">仅修改本机记录，不会向平台提交作业。恢复平台数据可撤销个人确认。</p>

        <div className="sheet__actions">
          <button type="button" className="btn" disabled={busy} onClick={onReset}>恢复平台数据</button>
          <button type="submit" className="btn btn--primary" disabled={busy}>保存</button>
        </div>
      </form>
    </div>
  );
}
