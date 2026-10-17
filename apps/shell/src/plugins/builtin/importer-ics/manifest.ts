/**
 * ICS 课表导入 —— manifest 与实体 schema。
 *
 * ## 为什么 manifest 是 `.ts` 而不是 `manifest.json`
 *
 * 现阶段没有打包步骤：`PluginHost.install()` 吃的就是这个对象，用 TS 能拿到
 * `Manifest` 类型约束，验收测试也能直接断言 `validateManifest(manifest).ok === true`。
 * 等 `tools/plugin-cli` 能打 `.mtp` 包时，由它把这里序列化成 `manifest.json` ——
 * 那时才是「磁盘上的 JSON 是唯一来源」。两份并存必然漂移，所以现在只留一份。
 */

import type { EntitySchema, Manifest } from '@matrix/plugin-api';

import { views } from './views.ts';

/** `app.matrix.*` 是保留前缀：只有宿主显式传 `allowReservedPrefix: true` 才装得上 */
export const PLUGIN_ID = 'app.matrix.importer.ics';

/**
 * 本地文档的键。
 *
 * **不是文件路径** —— 它只是宿主用来查「要满足哪份文档」的不透明键，
 * 且按 `(pluginId, url)` 隔离，所以插件读不到别的插件导入的东西。
 */
export const LOCAL_URL = 'host://import';

/**
 * 课程。
 *
 * ⚠️ `course` 是**全局类型名**（DataBus 只按插件隔离记录键，不隔离类型名）。
 * 这里等于暂借核心领域模型的名字，等 Timeline 落地、核心表出现时再收敛。
 */
export const courseSchema: EntitySchema = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 200 },
    code: { type: 'string', maxLength: 64 },
    location: { type: 'string', maxLength: 200 },
    source: { type: 'string', maxLength: 32 },
  },
  required: ['title'],
  // 显式写出来：字段就是这些，多一个就 ESCHEMA。
  // 宁可让作者补 schema，也不要静默丢数据（契约 §7.1）。
  additionalProperties: false,
};

/** 一节课。`startAt` / `endAt` 是 epoch ms，用 `integer` 以便宿主校验 `Number.isInteger` */
export const sessionSchema: EntitySchema = {
  type: 'object',
  properties: {
    courseId: { type: 'string', maxLength: 200 },
    title: { type: 'string', maxLength: 200 },
    startAt: { type: 'integer' },
    endAt: { type: 'integer' },
    location: { type: 'string', maxLength: 200 },
    /** ICS 的 UID —— 稳定的平台侧主键，重复导入靠它幂等 */
    uid: { type: 'string', maxLength: 200 },
    /** `RRULE` 原样保留，**不展开**（展开属于 timetable 插件的事） */
    rrule: { type: 'string', maxLength: 512 },
    /** 原始 `TZID`，只作记录，不参与时间换算 */
    tzid: { type: 'string', maxLength: 64 },
  },
  required: ['courseId', 'title', 'startAt', 'endAt'],
  additionalProperties: false,
};

export const manifest: Manifest = {
  id: PLUGIN_ID,
  name: 'ICS 课表导入',
  version: '0.1.0',
  apiVersion: '^1.0.0',
  kind: 'first-party',
  // entry 不填：first-party 在 KINDS_WITHOUT_ENTRY 里，进程内运行时也不读它。
  engines: { platform: ['android', 'web', 'windows'] },
  permissions: {
    // `read` 里要有 session：插件的控件要按课程统计课时数。
    // 少了它，`WidgetPage` 会把该控件画成「缺少 data.read 权限」的提示 —— 那是刻意的，
    // 控件不能借宿主的读取能力绕过插件自己的权限。
    data: { write: ['course', 'session'], read: ['course', 'session'] },
    /** 缺了这一项，`source: 'host'` 的请求会被宿主以 EPERM 拒掉 */
    local: true,
  },
  contributes: {
    entityTypes: [
      { name: 'course', schema: courseSchema },
      { name: 'session', schema: sessionSchema },
    ],
    // 目录在这里（纯数据），实现在 `renders` 里（`index.ts` 导出）。
    // 宿主会交叉核对两边，声明了没实现会报警告。
    views,
    commands: [{ id: 'import', title: '导入 ICS' }],
  },
};
