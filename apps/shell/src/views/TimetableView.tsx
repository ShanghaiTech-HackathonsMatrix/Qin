import { useMemo } from 'react';

import type { PeriodSlot, TimetableDay } from '../app/timetable.ts';

interface Props {
  days: readonly TimetableDay[];
  /** 每节课的起止时间，表格最左那一列 */
  periods: readonly PeriodSlot[];
  week: number;
  totalWeeks: number;
  /** 相对当前周的偏移，用来在标题下面写「本周 / 下一周」这类提示 */
  weekOffset: number;
  onWeekChange: (offset: number) => void;
  /** 一条课时都没有时的说明。没同步和同步了但这周没课，理由不一样 */
  emptyText: string;
  /** 空态里的行动按钮：没连平台时给一个直接去登录的出口 */
  emptyAction?: { label: string; onClick: () => void };
  onOpenLesson?:(id:string)=>void;
}

/**
 * 周课表 —— 「节次 × 星期」的表格，和教务系统原页面一个形状。
 *
 * 之前这里是按天竖排的卡片，理由是手机竖屏 390px 摊成七列每格不到 50px。
 * 但那个理由只对了一半：表格才是大家看课表的方式 —— 一眼能看出「周三上午
 * 三四节是什么、和周二那门课时间冲不冲」，竖排卡片得上下翻着比对。
 *
 * 所以现在摊成表格，用两个办法解决窄屏：
 * 1. 最左那一列「节次」`position: sticky`，左右滑动时它不动，永远知道这是第几节；
 * 2. 整张表有个最小宽度，装不下就横向滚动，而不是把课名压成一两个字。
 *
 * 跨节的课（第 3-4 节）用 `rowSpan` 占两行，和教务系统一样是一整块。
 */
export default function TimetableView({ days, periods, week, totalWeeks, weekOffset, onWeekChange, emptyText, emptyAction, onOpenLesson }: Props) {
  const total = useMemo(() => days.reduce((n, d) => n + d.lessons.length, 0), [days]);
  const canPrev = week > 1;
  const canNext = week < totalWeeks;
  const rows = Math.max(periods.length, 1);

  return (
    <div className="timetable">
      <div className="timetable__week">
        <button
          type="button"
          className="timetable__nav"
          aria-label="上一周"
          disabled={!canPrev}
          onClick={() => onWeekChange(weekOffset - 1)}
        >
          ‹
        </button>
        <span className="timetable__week-label">
          <strong>第 {week} 周</strong>
          <em>
            共 {totalWeeks} 周 · 这周 {total} 节
            {weekOffset === 0 ? ' · 本周' : ''}
          </em>
        </span>
        <button
          type="button"
          className="timetable__nav"
          aria-label="下一周"
          disabled={!canNext}
          onClick={() => onWeekChange(weekOffset + 1)}
        >
          ›
        </button>
      </div>

      {total === 0 ? (
        <div className="timetable-empty">
          <span aria-hidden="true">☰</span>
          <strong>这周没有课</strong>
          <p>{emptyText}</p>
          {emptyAction && (
            <button type="button" className="go-pill" onClick={emptyAction.onClick}>
              {emptyAction.label}
              <span aria-hidden="true">›</span>
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="tt__scroll">
            <table className="tt__grid" style={{ minWidth: `${44 + days.length * 62}px` }}>
              <thead>
                <tr>
                  <th className="tt__corner" scope="col">
                    节次
                  </th>
                  {days.map((day) => (
                    <th key={day.weekday} scope="col" data-today={day.isToday}>
                      <b>{day.label}</b>
                      <em>{day.date}</em>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: rows }, (_, i) => i + 1).map((p) => {
                  const slot = periods[p - 1];
                  return (
                    <tr key={p}>
                      <th className="tt__period" scope="row">
                        <b>{p}</b>
                        <em>
                          {slot?.start ?? ''}
                          <br />
                          {slot?.end ?? ''}
                        </em>
                      </th>
                      {days.map((day) => {
                        // 上一行的 rowSpan 已经盖到这里了，这一格不能再输出，否则表格会错位
                        if (day.lessons.some((l) => l.first < p && p <= l.last)) return null;
                        const starting = day.lessons.filter((l) => l.first === p);
                        if (starting.length === 0) {
                          return <td key={day.weekday} className="tt__cell" data-today={day.isToday} />;
                        }
                        const span = starting.reduce((m, l) => Math.max(m, Math.min(l.last, rows) - l.first + 1), 1);
                        return (
                          <td key={day.weekday} className="tt__cell" data-today={day.isToday} rowSpan={span}>
                            <div className="tt__stack">
                              {starting.map((lesson) => (
                                <button
                                  key={lesson.id}
                                  type="button"
                                  className="tt__lesson"
                                  onClick={() => onOpenLesson?.(lesson.id)}
                                >
                                  <strong>{lesson.title}</strong>
                                  {lesson.location !== '' && <small>{lesson.location}</small>}
                                  {lesson.teacher !== '' && <small>{lesson.teacher}</small>}
                                </button>
                              ))}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="tt__legend">点课程看详情 · 左右滑动看全周</p>
        </>
      )}
    </div>
  );
}
