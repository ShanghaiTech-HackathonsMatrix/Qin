import type { Course, Task } from '../domain/types';
import { EVENT_KIND_LABEL } from '../domain/types';
import { dayKey, dayLabel, relLabel, timeLabel } from '../app/format';

interface Props {
  tasks: Task[];
  courses: Course[];
  onToggle: (t: Task) => void;
  onEdit: (t: Task) => void;
}

export default function TimelineView({ tasks, courses, onToggle, onEdit }: Props) {
  const courseById = new Map(courses.map((c) => [c.id, c]));

  const groups = new Map<string, Task[]>();
  const undated: Task[] = [];
  for (const t of tasks) {
    if (t.dueAt === null) { undated.push(t); continue; }
    const k = dayKey(t.dueAt);
    const arr = groups.get(k);
    if (arr) arr.push(t); else groups.set(k, [t]);
  }
  const dayKeys = [...groups.keys()].sort();

  if (tasks.length === 0) {
    return (
      <div className="tl-empty">
        还没有任何条目。
        <br />
        点右上角「＋ 新建」加一条 DDL 或课程试试。
        <br />
        <span className="tiny">数据保存在本机，飞行模式下也能用。</span>
      </div>
    );
  }

  const now = Date.now();

  const renderItem = (t: Task) => {
    const course = t.courseId ? courseById.get(t.courseId) : undefined;
    const overdue = t.status === 'open' && t.dueAt !== null && t.dueAt < now;
    return (
      <div
        key={t.id}
        className="tl-item"
        data-done={t.status === 'done'}
        style={course?.color ? { borderLeftColor: course.color } : undefined}
        onClick={() => onEdit(t)}
      >
        <button
          className="btn btn--sm"
          style={{
            borderRadius: '50%', width: 26, height: 26, padding: 0,
            display: 'grid', placeItems: 'center', flexShrink: 0,
            borderColor: t.status === 'done' ? 'var(--ok)' : 'var(--line)',
            color: t.status === 'done' ? 'var(--ok)' : 'transparent',
          }}
          onClick={(e) => { e.stopPropagation(); onToggle(t); }}
          aria-label={t.status === 'done' ? '标记未完成' : '标记完成'}
        >
          ✓
        </button>

        <div className="grow">
          <div className="tl-item__title">{t.title}</div>
          <div className="tl-item__meta">
            <span className="badge badge--plain">{EVENT_KIND_LABEL[t.kind]}</span>
            {course && <span>{course.name}</span>}
            {t.dueAt !== null && (
              <span style={overdue ? { color: 'var(--bad)' } : undefined}>
                {timeLabel(t.dueAt)} · {relLabel(t.dueAt)}
              </span>
            )}
            {t.status === 'dismissed' && <span>已忽略</span>}
          </div>
          {t.note && <div className="faint" style={{ marginTop: 4 }}>{t.note}</div>}
        </div>
      </div>
    );
  };

  return (
    <>
      {dayKeys.map((k) => {
        const list = groups.get(k)!;
        const overdue = list.some((t) => t.status === 'open' && t.dueAt !== null && t.dueAt < now);
        return (
          <div key={k}>
            <div className="tl-day" data-overdue={overdue || undefined} style={overdue ? { color: 'var(--bad)' } : undefined}>
              {dayLabel(list[0]!.dueAt!)}
            </div>
            {list.map(renderItem)}
          </div>
        );
      })}

      {undated.length > 0 && (
        <div>
          <div className="tl-day">无期限</div>
          {undated.map(renderItem)}
        </div>
      )}
    </>
  );
}
