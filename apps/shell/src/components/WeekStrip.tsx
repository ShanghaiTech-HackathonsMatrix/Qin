import { dayKeyOf, dayLabelOf, type ScheduleEntry } from '../views/ScheduleView';

const WEEK_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
/** 一列最多画几道，再多就折成 +n —— 半宽时一列只有十几个像素宽 */
const MAX_MARKS = 4;

interface Props {
  entries: readonly ScheduleEntry[];
  now: number;
  /**
   * 点某一天。带上日期键和「8月22日 周六」这样的标签：
   * 日程页要靠键定位到那一段，靠标签在「那天没有安排」时说清楚是哪天。
   */
  onPickDay?: (dayKey: string, label: string) => void;
}

/**
 * 本周日程的**可视化**呈现：七列格子，不写文字时间线。
 *
 * 为什么不用文字：首页上的日程需要的是「这周哪几天满、哪几天空」这一眼，
 * 「09:00–11:30 算法设计 @ 三教 305」那是日程页要回答的问题。
 * 所以这里一根竖列 = 一天，每道横杠 = 一件事，形状和深浅带上类型与状态：
 *
 *   ▬ 实心   课程
 *   ▭ 空心   作业 / 任务
 *   ▬ 实心矮  已逾期
 *   ▬ 淡     已完成
 *
 * 今天是第 0 列，加下划线强调。点某一天跳到日程页那一段。
 */
export default function WeekStrip({ entries, now, onPickDay }: Props) {
  const base = new Date(now);
  const days = Array.from({ length: 7 }, (_, i) => {
    // 用日期构造而不是加 86400000：跨月、跨年、夏令时都不会错位
    const at = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i).getTime();
    const key = dayKeyOf(at);
    const items = entries
      .filter((e) => dayKeyOf(e.at) === key)
      .sort((a, b) => a.at - b.at);
    return { key, name: WEEK_NAMES[new Date(at).getDay()], label: dayLabelOf(at, now).date, items, isToday: i === 0 };
  });

  return (
    <div className="week-strip">
      {days.map((day) => (
        <button
          type="button"
          className="week-day"
          key={day.key}
          data-today={day.isToday}
          onClick={onPickDay ? () => onPickDay(day.key, day.label) : undefined}
          disabled={onPickDay === undefined}
          aria-label={`${day.label} · ${day.items.length} 项`}
        >
          <span className="week-day__name">{day.name}</span>
          <span className="week-day__marks">
            {day.items.slice(0, MAX_MARKS).map((item) => (
              <i
                className="week-day__mark"
                key={item.id}
                data-kind={item.kind}
                data-state={item.state ?? 'open'}
              />
            ))}
            {day.items.length > MAX_MARKS && (
              <em className="week-day__more">+{day.items.length - MAX_MARKS}</em>
            )}
          </span>
          <span className="week-day__count">{day.items.length > 0 ? day.items.length : ''}</span>
        </button>
      ))}
    </div>
  );
}