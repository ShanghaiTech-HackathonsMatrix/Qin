/**
 * Timeline 插件的常量 —— **单独一个文件**，不放在 `index.ts` 里。
 *
 * 原因很实际：`manifest.ts` 需要 `PLUGIN_ID` / `SLOT_NAME` / `views`，
 * 而 `index.ts` 又要 re-export `manifest`。两边互相 import 会形成循环，
 * 在 ESM 里表现为「Cannot access 'X' before initialization」。
 *
 * 常量下沉到没有依赖的第三文件，环就断了。
 */

import type { SlotDefinition, ViewContribution } from '@matrix/plugin-api';

export const PLUGIN_ID = 'dev.matrix.timeline';

/** 槽名：别的插件往这里写，Timeline 从这里读 */
export const SLOT_NAME = 'app.matrix.timeline.event';

/** 槽条目的实体类型名。定义方（本插件）的命名空间下，统一叫这个 */
export const SLOT_ENTRY_TYPE = 'slot_entry';

export const EVENT_TYPES = ['session', 'task', 'custom'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * 槽定义 —— **`CheckEvent()` 的纯数据部分**。
 *
 * `startAt` / `title` 必填，其余可选。`orderBy` 告诉宿主按开始时间排。
 */
export const eventSlot: SlotDefinition = {
  name: SLOT_NAME,
  description: '时间线上的一个事件。课表塞课时，作业管理器塞 DDL。',
  fields: {
    startAt: { type: 'number', required: true, description: 'epoch 毫秒' },
    endAt: { type: 'number', description: 'epoch 毫秒；纯时间点事件可省略' },
    title: { type: 'string', required: true, maxLength: 200 },
    /** 给了就画成对应语义色 */
    type: { type: 'string', maxLength: 20, description: `建议取值：${EVENT_TYPES.join(' / ')}` },
    /** 地点、作业细节……都往这里塞 */
    detail: { type: 'string', maxLength: 300 },
    /** 课程 id，用来取课程颜色 */
    courseId: { type: 'string', maxLength: 200 },
  },
  maxItems: 2000,
  orderBy: 'startAt',
};

export const views: ViewContribution[] = [
  {
    id: 'timeline',
    title: '时间线',
    // 页面级：占整屏，不参与首页格子布局
    kind: 'page',
    requires: ['task', 'course'],
  },
];
