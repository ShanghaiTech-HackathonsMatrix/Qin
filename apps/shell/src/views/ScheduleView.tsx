import { useMemo } from 'react';

import { dayKeyOf } from '../app/date-keys.ts';

/**
 * 每日日程的条目。
 *
 * 刻意做成**宿主无关的普通对象**：课表来自插件槽、DDL 来自核心任务、
 * 演示数据来自虚构样本 —— 三种来源进到这一层时形状必须一样，
 * 否则视图里又要按来源分叉，最后一定会出现「演示能看、真数据白屏」。
 */
export interface ScheduleEntry {
  id: string;
  /** epoch 毫秒 */
  at: number;
  endAt?: number;
  title: string;
  /** 地点 / 课程名 / 来源平台，一行灰字 */
  meta: string;
  kind: 'class' | 'ddl' | 'task' | 'custom';
  state?: 'open' | 'done' | 'overdue';
  /** 用户自己加的，不是课表/平台来的。视图挂一个很小的「自建」标记 */
  selfMade?: boolean;
}

export interface ScheduleDay {
  key: string;
  label: string;
  date: string;
  items: ScheduleEntry[];
}

const PAD = (n: number) => String(n).padStart(2, '0');

/** 把「第 N 天 + 时分」换算成 epoch 毫秒。跨天课次因此也能正确排序。 */
export function atDay(dayOffset: number, hour: number, minute = 0, now = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, hour, minute).getTime();
}

/**
 * `dayKeyOf` 本体在 `app/date-keys.ts`：纯逻辑那边（`app/ddl-items.ts`）
 * 也要用它，而 Node 跑测试时读不了 `.tsx`。这里转出去，调用方不必改。
 */
export { dayKeyOf } from '../app/date-keys.ts';

export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 天的标签。`now` 由调用方传入而不是读 `Date.now()` ——
 * 同一份数据在不同时刻渲染出不同文案是测试里最难查的一类不稳定。
 */
export function dayLabelOf(ms: number, now: number): { label: string; date: string } {
  const d = new Date(ms);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const t = new Date(now);
  const t0 = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const diff = Math.round((target - t0) / 86_400_000);
  const date = `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}`;

  if (diff === 0) return { label: '今天', date };
  if (diff === 1) return { label: '明天', date };
  if (diff === 2) return { label: '后天', date };
  if (diff === -1) return { label: '昨天', date };
  if (diff < 0) return { label: `已过 ${-diff} 天`, date };
  return { label: `${diff} 天后`, date };
}

/** 按天分组并按时间排序。已完成的沉到当天末尾，但不隐藏。 */
export function buildScheduleDays(entries: readonly ScheduleEntry[], now: number): ScheduleDay[] {
  const groups = new Map<string, ScheduleEntry[]>();
  for (const entry of entries) {
    if (!Number.isFinite(entry.at)) continue;
    const key = dayKeyOf(entry.at);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [entry]);
    else list.push(entry);
  }

  return [...groups.keys()].sort().map((key) => {
    const items = (groups.get(key) ?? []).slice().sort((a, b) => {
      const doneA = a.state === 'done' ? 1 : 0;
      const doneB = b.state === 'done' ? 1 : 0;
      if (doneA !== doneB) return doneA - doneB;
      return a.at - b.at;
    });
    const { label, date } = dayLabelOf(items[0]?.at ?? now, now);
    return { key, label, date, items };
  });
}

const KIND_LABEL: Record<ScheduleEntry['kind'], string> = {
  class: '课程',
  ddl: 'DDL',
  task: '任务',
  custom: '事项',
};

interface Props {
  days: readonly ScheduleDay[];
  /** 空日程时的说明；不同来源的空状态理由不一样，不能写死 */
  emptyText: string;
  /** 空态里的行动按钮：没连平台时给一个直接去登录的出口 */
  emptyAction?: { label: string; onClick: () => void };
  onOpenEntry?: (entry: ScheduleEntry) => void;
}

/**
 * 每日日程：按天分组的单列列表。
 *
 * 参考了同系列项目 `apps/web` 的 TimelinePage 做法 —— 按天分组、
 * 今天/明天/后天这样的相对标签、当天条目按时间升序。
 * 但**没有**照搬它的事件筛选器与查询层：Qin 这一版的数据来自
 * 核心任务 + 插件槽，不是 `timeline.list` 那个查询端口。
 */
export default function ScheduleView({ days, emptyText, emptyAction, onOpenEntry }: Props) {
  const total = useMemo(() => days.reduce((n, d) => n + d.items.length, 0), [days]);

  if (total === 0) {
    return (
      <div className="schedule">
        <div className="schedule-empty">
          <span aria-hidden="true">☰</span>
          <strong>这段时间没有安排</strong>
          <p>{emptyText}</p>
          {emptyAction && (
            <button type="button" className="go-pill" onClick={emptyAction.onClick}>
              {emptyAction.label}
              <span aria-hidden="true">›</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="schedule">
      {days.map((day) => (
        <section className="schedule-day" key={day.key}>
          <div className="schedule-day__head">
            <h2>{day.label}</h2>
            <span className="schedule-day__date">{day.date}</span>
            <span className="schedule-day__count">{day.items.length} 项</span>
          </div>

          <div className="schedule-day__rows">
            {day.items.map((entry) => {
              const time = entry.endAt !== undefined && entry.endAt > entry.at
                ? `${hhmm(entry.at)}–${hhmm(entry.endAt)}`
                : hhmm(entry.at);
              return (
                <button
                  type="button"
                  className="schedule-entry"
                  key={entry.id}
                  data-kind={entry.kind}
                  data-state={entry.state ?? 'open'}
                  onClick={onOpenEntry ? () => onOpenEntry(entry) : undefined}
                  disabled={onOpenEntry === undefined}
                >
                  <span className="schedule-entry__time">{time}</span>
                  <span className="schedule-entry__body">
                    <strong>
                      {entry.title}
                      {entry.selfMade === true && (
                        <span className="tag-self" title="自己添加的，不是课表或平台同步来的">自建</span>
                      )}
                    </strong>
                    {entry.meta !== '' && <small>{entry.meta}</small>}
                  </span>
                  <span className="schedule-entry__tag">
                    {entry.state === 'overdue' ? '逾期' : entry.state === 'done' ? '完成' : KIND_LABEL[entry.kind]}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
