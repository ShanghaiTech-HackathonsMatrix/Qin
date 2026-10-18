/**
 * 拉回来的作业的详情。
 *
 * ## 为什么长这样
 *
 * 这版界面沿用**演示预览里那张 DDL 详情卡**（`App.tsx` 的 `.ddl-detail`）：
 * 黑色标题带 + 大号标题 + 定义列表 + 底部动作。之前这里是一个朴素的表单弹层，
 * 于是同一份作业在电脑预览和手机上长得完全不一样 —— 用户看到的就是
 * 「为什么和预览网页大相径庭」。两处现在共用同一套 class。
 *
 * 和预览的差别只有一处：**这里的值是可以改的**。所以标题是一个看起来像标题的
 * `<input>`，截止时间和确认状态嵌在行里 —— 平时看着像正文，点进去才露出可编辑的样子。
 *
 * ## 保存的语义
 *
 * 改的是**本应用里的个人修正**，平台原文一个字节都不动。所以「恢复平台数据」
 * 永远可用。没有「个人备注」：这个弹层是「核对平台作业、标一下做没做」，
 * 想写笔记该去用任务那边的备注。
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
  onSave: (patch: { title?: string; dueAt?: number | null; done?: boolean; needsReview?:boolean }) => void;
  onReset: () => void;
  onClose: () => void;
}

export default function AssignmentSheet({ draft, busy, onSave, onReset, onClose }: Props) {
  const [error,setError]=useState('');
  const open=async(url:string)=>{try{await openExternal(url);}catch(e){setError(String(e));}};
  const [title, setTitle] = useState(draft.title);
  const [due, setDue] = useState(toLocalInput(draft.dueAt));
  const [confirmation, setConfirmation] = useState(draft.done?'done':draft.needsReview?'review':'open');
  const target=taskTarget(draft);

  const overdue = draft.dueAt !== null && draft.dueAt < Date.now() && !draft.done;

  const submit = () => {
    const patch: { title?: string; dueAt?: number | null; done?: boolean; needsReview?:boolean } = {};
    if (title !== draft.title) patch.title = title;
    if (due !== toLocalInput(draft.dueAt)) patch.dueAt = due === '' ? null : new Date(due).getTime();
    if(patch.dueAt!==undefined&&patch.dueAt!==null&&!Number.isFinite(patch.dueAt)){setError('请选择有效的截止时间');return;}
    patch.done = confirmation==='done';
    patch.needsReview = confirmation==='review';
    onSave(patch);
  };

  return (
    <div className="ddl-detail-backdrop" onClick={onClose}>
      <section
        className="ddl-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="assignment-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ddl-detail__band">
          <span className="ddl-detail__kicker">DEADLINE / 作业详情</span>
          {/* 黑标题带上放黑圆会看不见，这里沿用预览页那颗白描边圆 */}
          <button type="button" className="ddl-detail__close" onClick={onClose} aria-label="关闭">×</button>
        </header>

        <form
          className="ddl-detail__scroll"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <span className="ddl-detail__source">{draft.source}</span>

          {/* 标题平时看着就是标题，点进去才能改 —— 不在「展示」和「编辑」之间二选一 */}
          <input
            className="ddl-detail__title ddl-detail__title--edit"
            id="assignment-title"
            value={title}
            maxLength={200}
            required
            aria-label="作业名称"
            onChange={(e) => setTitle(e.target.value)}
          />

          <dl className="ddl-detail__rows">
            <div>
              <dt>课程</dt>
              <dd>{draft.courseTitle === '' ? '未归入课程' : draft.courseTitle}</dd>
            </div>
            <div>
              <dt>截止</dt>
              <dd>
                <input
                  className="ddl-detail__inline"
                  type="datetime-local"
                  value={due}
                  aria-label="截止时间"
                  onChange={(e) => setDue(e.target.value)}
                />
              </dd>
            </div>
            <div>
              <dt>平台状态</dt>
              <dd data-tone={overdue ? 'bad' : 'normal'}>
                {overdue ? '已逾期' : (STATUS_TEXT[draft.status] ?? draft.status)}
              </dd>
            </div>
            <div>
              <dt>我的确认</dt>
              <dd>
                <select
                  className="ddl-detail__inline"
                  value={confirmation}
                  aria-label="个人确认状态"
                  onChange={(e) => setConfirmation(e.target.value)}
                >
                  <option value="review">待确认</option>
                  <option value="open">确认未完成</option>
                  <option value="done">确认已完成</option>
                </select>
              </dd>
            </div>
          </dl>

          <p className="ddl-detail__body">
            平台原文：{draft.dueText === '' ? '未提供明确日期' : draft.dueText}
          </p>

          {target && (
            <div className="ddl-detail__actions">
              <button type="button" className="btn grow" onClick={() => void open(target)}>
                {draft.provider==='blackboard'?'打开 BB 课程 ↗':'打开 Gradescope 作业 ↗'}
              </button>
            </div>
          )}

          {error !== '' && <p className="ddl-detail__foot" role="alert">{error}</p>}

          <div className="ddl-detail__actions">
            <button type="button" className="btn" disabled={busy} onClick={onReset}>恢复平台数据</button>
            <button type="submit" className="btn btn--primary grow" disabled={busy}>保存</button>
          </div>

          <p className="ddl-detail__foot">
            只改本机记录，不会向平台提交作业。恢复平台数据可撤销个人确认。
          </p>
        </form>
      </section>
    </div>
  );
}
