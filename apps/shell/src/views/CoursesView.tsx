import {confirmAction} from '../components/ConfirmDialog';
/**
 * 「课程」页。
 *
 * ## T15 之后它读的是 DataBus，不是 `TaskStore`
 *
 * 课程有两个来源：核心（用户自己建的）和插件（ICS 导入的）。
 * 页面只关心「有哪些课」，不关心谁存的 —— 那个区别由 `CourseCard.owner` 表达。
 *
 * ## 插件课程只读
 *
 * 它的真相在插件那边：下次 `sync()` 会整体重写。让用户在这里改，改完就被覆盖，
 * 那是骗人。所以编辑 / 删除按钮只对核心课程出现，插件课程显示一个来源标记。
 */

import { useState } from 'react';

import { ownerLabel, type CourseCard, type CourseDraft } from '../core/course-cards';
import type { Task } from '../domain/types';

interface Props {
  courses: CourseCard[];
  tasks: Task[];
  onCreate: (draft: CourseDraft) => void;
  onUpdate: (id: string, draft: CourseDraft) => void;
  onDelete: (id: string) => void;
}

export default function CoursesView({ courses, tasks, onCreate, onUpdate, onDelete }: Props) {
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);

  const countFor = (id: string) => tasks.filter((t) => t.courseId === id).length;

  const reset = () => {
    setTitle('');
    setCode('');
    setEditingKey(null);
  };

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    const draft: CourseDraft = {
      title: t,
      ...(code.trim() !== '' ? { code: code.trim() } : {}),
      ...(editingKey !== null ? { color: courses.find((c) => c.key === editingKey)?.color } : {}),
    };

    if (editingKey !== null) {
      const target = courses.find((c) => c.key === editingKey);
      if (target && target.editable) onUpdate(target.id, draft);
    } else {
      onCreate(draft);
    }
    reset();
  };

  const beginEdit = (c: CourseCard) => {
    setEditingKey(c.key);
    setTitle(c.title);
    setCode(c.code ?? '');
  };

  const editableCount = courses.filter((c) => c.editable).length;

  return (
    <>
      <div className="section-title">
        我的课程（{courses.length}）
        {courses.length > editableCount && (
          <span className="faint"> · 其中 {courses.length - editableCount} 门来自插件</span>
        )}
      </div>

      {courses.length === 0 && (
        <div className="card faint">还没有课程。在下面添加一门，之后就能把 DDL 挂到它下面。</div>
      )}

      {courses.map((c) => (
        <div className="card" key={c.key}>
          <div className="row row--between">
            <div className="row grow">
              <span className="course-inkmark" aria-hidden="true">✳</span>
              <div className="grow">
                <div className="truncate" style={{ fontWeight: 570 }}>
                  {c.title}
                </div>
                <div className="faint">
                  {c.code ? `${c.code} · ` : ''}
                  {countFor(c.id)} 个条目
                  {!c.editable && <> · 来自 {ownerLabel(c.owner)}</>}
                </div>
              </div>
            </div>
            {c.editable ? (
              <>
                <button className="btn btn--sm" onClick={() => beginEdit(c)}>
                  编辑
                </button>
                <button
                  className="btn btn--sm btn--danger"
                  onClick={async () => {
                    if (
                      await confirmAction(
                        `删除课程「${c.title}」？挂在其下的条目不会被删除，但会失去课程归属。`,
                      )
                    ) {
                      onDelete(c.id);
                    }
                  }}
                >
                  删除
                </button>
              </>
            ) : (
              // 只读来源标记。**不画灰掉的按钮** —— 那会让用户以为点不了是 bug
              <span className="faint" title="由插件提供，改动会在下次同步时被覆盖">
                只读
              </span>
            )}
          </div>
        </div>
      ))}

      <div className="section-title">{editingKey ? '编辑课程' : '添加课程'}</div>
      <div className="card stack">
        <div>
          <label className="lbl">课程名</label>
          <input
            className="field"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：数据结构"
          />
        </div>
        <div>
          <label className="lbl">课程号（可选）</label>
          <input
            className="field"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="例如：CS101"
          />
        </div>
        <div className="row">
          <button className="btn btn--primary grow" onClick={submit} disabled={!title.trim()}>
            {editingKey ? '保存修改' : '添加'}
          </button>
          {editingKey && (
            <button className="btn" onClick={reset}>
              取消
            </button>
          )}
        </div>
      </div>
    </>
  );
}
