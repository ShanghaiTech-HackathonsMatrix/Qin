import { useMemo, useState } from 'react';
import type { EventKind, Task, TaskStatus } from '../domain/types';
import { groupCourseOptions, type CourseOption } from '../app/course-options';
import { EVENT_KIND_LABEL, STATUS_LABEL } from '../domain/types';
import { fromLocalInput, toLocalInput, uid } from '../app/format';

interface Props {
  task: Task | null;
  courses: readonly CourseOption[];
  onClose: () => void;
  onSave: (t: Task) => void;
  onDelete: (id: string) => void;
  onNewCourse: (name: string) => Promise<{ id: string; name: string }>;
}

export default function TaskEditor({ task, courses, onClose, onSave, onDelete, onNewCourse }: Props) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [kind, setKind] = useState<EventKind>(task?.kind ?? 'ddl');
  const [courseId, setCourseId] = useState<string>(task?.courseId ?? '');
  const [due, setDue] = useState(toLocalInput(task?.dueAt ?? null));
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? 'open');
  const [note, setNote] = useState(task?.note ?? '');
  const [busy, setBusy] = useState(false);

  /**
   * 按来源分组。同步回来的课可能几十门，一股脑塞进一个平铺列表里，
   * 用户根本分不清哪门是本机建的、哪门是教务同步的。
   */
  const groups = useMemo(() => groupCourseOptions(courses), [courses]);

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    const now = Date.now();
    onSave({
      id: task?.id ?? uid('task'),
      kind,
      title: t,
      courseId: courseId || null,
      dueAt: fromLocalInput(due),
      status,
      note: note.trim() || undefined,
      createdAt: task?.createdAt ?? now,
      updatedAt: now,
    });
  };

  const addCourse = async () => {
    const name = prompt('新课程名称');
    if (!name?.trim()) return;
    setBusy(true);
    try {
      const c = await onNewCourse(name.trim());
      setCourseId(c.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <div className="sheet__title">{task ? '编辑条目' : '新建条目'}</div>
          <div className="grow" />
          <button className="btn btn--sm" onClick={onClose}>关闭</button>
        </div>

        <div className="stack">
          <div>
            <label className="lbl">标题</label>
            <input
              className="field"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：数据结构第三次作业"
              autoFocus={!task}
            />
          </div>

          <div>
            <label className="lbl">类型</label>
            <div className="seg">
              {(Object.keys(EVENT_KIND_LABEL) as EventKind[]).map((k) => (
                <button key={k} data-active={kind === k} onClick={() => setKind(k)}>
                  {EVENT_KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="lbl">所属课程</label>
            <div className="row">
              <select
                className="field grow"
                value={courseId}
                onChange={(e) => setCourseId(e.target.value)}
              >
                <option value="">（无）</option>
                {groups.map(([label, items]) => (
                  <optgroup key={label} label={label}>
                    {items.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.code ? `${c.name} · ${c.code}` : c.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <button className="btn" onClick={() => void addCourse()} disabled={busy}>＋课程</button>
            </div>
            {courses.length === 0 && (
              <p className="tiny" style={{ marginTop: 6 }}>
                还没有可选的课程。去「设置 → 平台连接」登录教务课表并同步，课会自动出现在这里。
              </p>
            )}
          </div>

          <div>
            <label className="lbl">截止时间（留空表示无期限）</label>
            <input
              className="field"
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
            {due && (
              <button className="btn btn--sm" style={{ marginTop: 6 }} onClick={() => setDue('')}>
                清除时间
              </button>
            )}
          </div>

          <div>
            <label className="lbl">状态</label>
            <div className="seg">
              {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => (
                <button key={s} data-active={status === s} onClick={() => setStatus(s)}>
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="lbl">备注</label>
            <textarea
              className="field"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="可选"
            />
          </div>

          <div className="row">
            <button className="btn btn--primary grow" onClick={submit} disabled={!title.trim()}>
              保存
            </button>
            {task && (
              <button
                className="btn btn--danger"
                onClick={() => onDelete(task.id)}
              >
                删除
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
