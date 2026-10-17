import { useMemo } from 'react';

import type { TimetableDay } from '../app/timetable.ts';

interface Props {
  days: readonly TimetableDay[];
  week: number;
  totalWeeks: number;
  /** 相对当前周的偏移，用来在标题下面写「本周 / 下一周」这类提示 */
  weekOffset: number;
  onWeekChange: (offset: number) => void;
  /** 一条课时都没有时的说明。没同步和同步了但这周没课，理由不一样 */
  emptyText: string;
}

/**
 * 周课表。
 *
 * 为什么不做成「时间 × 星期」的网格：手机竖屏就 390px 宽，摊成七列之后
 * 每格不到 50px，课名只能挤成一两个字。这一页回答的是「这周哪天有课、
 * 几点、在哪」，所以按天竖排成卡片，和其它页的卡片是同一套观感。
 */
export default function TimetableView({ days, week, totalWeeks, weekOffset, onWeekChange, emptyText }: Props) {
  const total = useMemo(() => days.reduce((n, d) => n + d.lessons.length, 0), [days]);
  const canPrev = week > 1;
  const canNext = week < totalWeeks;

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
        </div>
      ) : (
        days.map((day) => (
          <section className="timetable-day" key={day.weekday} data-today={day.isToday} data-empty={day.lessons.length === 0}>
            <div className="timetable-day__head">
              <h3>{day.label}</h3>
              <span className="timetable-day__date">{day.date}</span>
              {day.isToday && <span className="timetable-day__today">今天</span>}
              <span className="timetable-day__count">{day.lessons.length === 0 ? '无课' : `${day.lessons.length} 节`}</span>
            </div>

            {day.lessons.length > 0 && (
              <div className="timetable-day__rows">
                {day.lessons.map((lesson) => (
                  <div className="timetable-lesson" key={lesson.id}>
                    <span className="timetable-lesson__time">
                      <b>{lesson.start}</b>
                      <em>{lesson.end}</em>
                    </span>
                    <span className="timetable-lesson__body">
                      <strong>{lesson.title}</strong>
                      <small>
                        {[lesson.location, lesson.teacher].filter((v) => v !== '').join(' · ')}
                      </small>
                    </span>
                    <span className="timetable-lesson__periods">{lesson.periods}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))
      )}
    </div>
  );
}
