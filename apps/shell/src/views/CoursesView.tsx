import { useState } from 'react';
import type { Course, Task } from '../domain/types';
import { ACCENTS } from '../app/settings';
import { uid } from '../app/format';

interface Props {
  courses: Course[];
  tasks: Task[];
  onSave: (c: Course) => void;
  onDelete: (id: string) => void;
}

export default function CoursesView({ courses, tasks, onSave, onDelete }: Props) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [color, setColor] = useState(ACCENTS[0]!);
  const [editingId, setEditingId] = useState<string | null>(null);

  const countFor = (id: string) => tasks.filter((t) => t.courseId === id).length;

  const reset = () => { setName(''); setCode(''); setColor(ACCENTS[0]!); setEditingId(null); };

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    const now = Date.now();
    const existing = editingId ? courses.find((c) => c.id === editingId) : undefined;
    onSave({
      id: existing?.id ?? uid('course'),
      name: n,
      code: code.trim() || undefined,
      color,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    reset();
  };

  const beginEdit = (c: Course) => {
    setEditingId(c.id);
    setName(c.name);
    setCode(c.code ?? '');
    setColor(c.color ?? ACCENTS[0]!);
  };

  return (
    <>
      <div className="section-title">我的课程（{courses.length}）</div>

      {courses.length === 0 && (
        <div className="card faint">还没有课程。在下面添加一门，之后就能把 DDL 挂到它下面。</div>
      )}

      {courses.map((c) => (
        <div className="card" key={c.id}>
          <div className="row row--between">
            <div className="row grow">
              <span style={{
                width: 10, height: 10, borderRadius: '50%',
                background: c.color ?? 'var(--accent)', flexShrink: 0,
              }} />
              <div className="grow">
                <div className="truncate" style={{ fontWeight: 570 }}>{c.name}</div>
                <div className="faint">
                  {c.code ? `${c.code} · ` : ''}{countFor(c.id)} 个条目
                </div>
              </div>
            </div>
            <button className="btn btn--sm" onClick={() => beginEdit(c)}>编辑</button>
            <button
              className="btn btn--sm btn--danger"
              onClick={() => {
                if (confirm(`删除课程「${c.name}」？挂在其下的条目不会被删除，但会失去课程归属。`)) onDelete(c.id);
              }}
            >
              删除
            </button>
          </div>
        </div>
      ))}

      <div className="section-title">{editingId ? '编辑课程' : '添加课程'}</div>
      <div className="card stack">
        <div>
          <label className="lbl">课程名</label>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：数据结构" />
        </div>
        <div>
          <label className="lbl">课程号（可选）</label>
          <input className="field" value={code} onChange={(e) => setCode(e.target.value)} placeholder="例如：CS101" />
        </div>
        <div>
          <label className="lbl">颜色</label>
          <div className="row">
            {ACCENTS.map((a) => (
              <span
                key={a}
                className="swatch"
                data-active={a === color}
                style={{ background: a }}
                onClick={() => setColor(a)}
              />
            ))}
          </div>
        </div>
        <div className="row">
          <button className="btn btn--primary grow" onClick={submit} disabled={!name.trim()}>
            {editingId ? '保存修改' : '添加'}
          </button>
          {editingId && <button className="btn" onClick={reset}>取消</button>}
        </div>
      </div>
    </>
  );
}
