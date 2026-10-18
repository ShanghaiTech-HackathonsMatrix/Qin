/**
 * 课程信息表 —— 课表页下方那张「一门课一行」的表。
 *
 * 和上面那张周课表分工不同：周课表回答「这周哪天几点有课」，这张表回答
 * 「这门课是谁上、在哪、哪几周、一共几个时段」。教务系统页面下方也是这么列的，
 * 所以形状照抄：课程（名称 + 课程号）/ 教师 / 地点 / 上课时间。
 *
 * 之前这里是一个「全部排课与课程备注」折叠块，把每条课时摊成一枚按钮 ——
 * 一门课三门时段的课会出现三次，看着像三门课。聚合之后一行一门课，
 * 时段仍然可以点，点进课程详情写备注。
 */

import { weeksText, slotLabel, type CourseInfoRow } from '../app/timetable.ts';

interface Props {
  rows: readonly CourseInfoRow[];
  onOpenLesson?: (id: string) => void;
}

export default function CourseInfoTable({ rows, onOpenLesson }: Props) {
  if (rows.length === 0) return null;

  return (
    <div className="ct">
      <div className="ct__scroll">
        <table className="ct__grid">
          <thead>
            <tr>
              <th scope="col">课程</th>
              <th scope="col">教师</th>
              <th scope="col">地点</th>
              <th scope="col">上课时间</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" className="ct__course">
                  <strong>{row.title}</strong>
                  {row.code !== '' && <em>{row.code}</em>}
                </th>
                <td>{row.teacher === '' ? '—' : row.teacher}</td>
                <td>{row.location === '' ? '—' : row.location}</td>
                <td>
                  {/* 时段要竖排，所以套一层 div —— 直接给 td 设 display:grid 会让它脱离表格布局 */}
                  <div className="ct__slots">
                    {row.slots.map((slot) => (
                      <button
                        key={slot.id}
                        type="button"
                        className="ct__slot"
                        onClick={() => onOpenLesson?.(slot.id)}
                      >
                        <b>{slotLabel(slot)}</b>
                        <em>{weeksText(slot.weeks)}</em>
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ct__legend">共 {rows.length} 门课 · 点上课时间看详情</p>
    </div>
  );
}
