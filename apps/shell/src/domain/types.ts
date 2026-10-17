/** Matrix 领域模型（最小版） */

export type EventKind = 'ddl' | 'course' | 'quiz' | 'checkin' | 'custom';

export type TaskStatus = 'open' | 'done' | 'dismissed';

export interface Task {
  id: string;
  kind: EventKind;
  title: string;
  courseId: string | null;
  /** epoch 毫秒 */
  dueAt: number | null;
  status: TaskStatus;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Course {
  id: string;
  name: string;
  code?: string;
  color?: string;
  createdAt: number;
  updatedAt: number;
}

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  ddl: 'DDL',
  course: '课程',
  quiz: '测验',
  checkin: '签到',
  custom: '自定义',
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  open: '未完成',
  done: '已完成',
  dismissed: '已忽略',
};
