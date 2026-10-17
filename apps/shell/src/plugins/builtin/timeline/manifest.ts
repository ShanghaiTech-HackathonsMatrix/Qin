/**
 * Timeline 插件的 manifest。
 *
 * 这里最值得注意的是 **`slots`** —— Timeline 不实现「被别人调用」的入口，
 * 它只**定义**一个槽。别的插件往槽里写，两边互不知道对方存在。
 */

import type { EntitySchema, Manifest } from '@matrix/plugin-api';

import { PLUGIN_ID, SLOT_ENTRY_TYPE, SLOT_NAME, eventSlot, views } from './constants.ts';

/**
 * 槽条目的容器 schema。
 *
 * 只看「形状对」—— 具体字段的合法性由 `eventSlot.fields` 在写入时逐条校验
 * （见 `buildSlotEntry`）。两处都声明字段就是第二个真相源，必然漂移。
 */
const slotEntryContainer: EntitySchema = {
  type: 'object',
  required: ['slot', 'values', 'source', 'from', 'ref'],
  properties: {
    slot: { type: 'string', maxLength: 120 },
    values: { type: 'object' },
    source: { type: 'string', maxLength: 200 },
    from: { type: 'string', maxLength: 60 },
    ref: { type: 'string', maxLength: 200 },
  },
  additionalProperties: false,
};

export const manifest: Manifest = {
  id: PLUGIN_ID,
  name: 'Timeline',
  version: '0.1.0',
  apiVersion: '^1.0.0',
  kind: 'ui',
  entry: 'index.js',

  permissions: {
    // 读核心的 task / course（宿主投影进 DataBus 的那份）
    // 槽条目是**自己的**命名空间下，不需要额外声明
    //
    // `write: ['task']` 是 T14 命令通道要的：`toggleTask` 提交 `task.setStatus`
    // 这个 coreOp，宿主会拿它来查授权。没有它，「标记完成」会被 EPERM 拒掉 ——
    // 这是刻意的：能改用户的任务状态，是一次**真实的**权限扩张。
    data: { read: ['task', 'course'], write: ['task'] },
  },

  contributes: {
    /**
     * 槽条目落在**定义方**的命名空间下，所以定义方必须声明这个实体类型 ——
     * `DataBus.emit()` 不认没有 schema 的类型。
     *
     * 它的 schema 就是「槽条目的容器」：具体字段由 `slots[].fields` 逐条校验，
     * 在这里再声明一遍只会多一份会漂移的真相。
     */
    entityTypes: [{ name: SLOT_ENTRY_TYPE, schema: slotEntryContainer }],
    // 目录：这个槽长什么样。定义方的**唯一**对外接口就是它
    slots: [eventSlot],
    views,
    /**
     * 命令目录。实现在 `index.ts` 的 `commands` 里，宿主交叉核对两边：
     * 声明了没实现 → 用户点了会得到 `EMANIFEST`，不是静默无事发生。
     */
    commands: [{ id: 'toggleTask', title: '切换任务完成状态' }],
  },
};

export { PLUGIN_ID, SLOT_NAME };
