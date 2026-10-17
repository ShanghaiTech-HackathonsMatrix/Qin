import { useState } from 'react';

interface Props {
  /** 演示模式下要如实说明「不写入本机」 */
  demo: boolean;
  onClose: () => void;
  /** 把一段文字按行拆成若干条任务标题 */
  onAddLines: (lines: string[]) => void;
  /** 打开完整的手动编辑表单 */
  onManual: () => void;
}

type Mode = 'menu' | 'text';

/**
 * 右下角「＋」弹出的快速添加入口。
 *
 * 两个入口：
 *   · 导入文字 —— 粘贴一段话，按行拆成多条任务
 *   · 自主添加 —— 交给完整的 TaskEditor 表单
 *
 * ⚠️ 这里**没有**语义识别。所谓「从一句话里读出截止时间和课程」属于自然语言理解，
 * 当前版本只做按行切分，界面上如实标成待开发，不假装已经会了。
 */
export default function QuickAdd({ demo, onClose, onAddLines, onManual }: Props) {
  const [mode, setMode] = useState<Mode>('menu');
  const [draft, setDraft] = useState('');

  const lines = draft
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet quick" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <div className="sheet__title">{mode === 'menu' ? '添加任务' : '导入文字'}</div>
          <div className="grow" />
          {mode === 'text' && (
            <button className="btn btn--sm" onClick={() => setMode('menu')}>返回</button>
          )}
          <button className="btn btn--sm" onClick={onClose}>关闭</button>
        </div>

        {mode === 'menu' && (
          <div className="quick__menu">
            <button className="quick__option" onClick={() => setMode('text')}>
              <span className="quick__mark" aria-hidden="true">✎</span>
              <span className="quick__body">
                <strong>导入文字</strong>
                <small>粘贴一段话，按行拆成多条任务</small>
              </span>
              <span className="quick__arrow" aria-hidden="true">›</span>
            </button>

            <button className="quick__option" onClick={onManual}>
              <span className="quick__mark" aria-hidden="true">＋</span>
              <span className="quick__body">
                <strong>自主添加</strong>
                <small>填标题、课程与截止时间</small>
              </span>
              <span className="quick__arrow" aria-hidden="true">›</span>
            </button>

            <p className="quick__foot">
              智能识别（从文字里自动读出截止时间与课程）尚未开发，当前只按换行切分。
            </p>
          </div>
        )}

        {mode === 'text' && (
          <div className="quick__text">
            <textarea
              className="quick__input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={'一行一条，例如：\n算法设计 第三次作业 周五交\n读完《交互设计》第三章'}
              rows={6}
              autoFocus
            />
            <div className="quick__count">
              将添加 <b>{lines.length}</b> 条任务
              {demo && <span className="quick__demo"> · 演示模式，仅本次会话有效</span>}
            </div>
            <button
              className="btn btn--primary"
              disabled={lines.length === 0}
              onClick={() => {
                onAddLines(lines);
                setDraft('');
                setMode('menu');
              }}
            >
              按行添加
            </button>
            <p className="quick__foot">
              截止时间与课程的自动识别待开发；这里只会把每一行原样存成任务标题。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
