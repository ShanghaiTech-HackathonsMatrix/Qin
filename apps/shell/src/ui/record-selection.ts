/**
 * 按 `requires` 给控件取实体。
 *
 * ## 为什么单独一个文件
 *
 * 它原来住在 `WidgetPage.ts` 里。那个文件 `import React`，所以任何想测这段逻辑的
 * Node 测试都会被拖进 React 和 vite 的解析规则（相对 import 没有 `.ts` 后缀就崩）。
 * 而这段逻辑恰恰是**最该被测试的**：它决定插件能看到哪些数据。
 *
 * 纯逻辑 + 零 React 依赖 → 可以直接 `node` 跑。
 *
 * ## 为什么**不**限定命名空间（曾经的 bug）
 *
 * 这里原来对 `task` / `course` 加了 `owner: CORE_NS`，理由是「核心实体是宿主写的，
 * 限定一下避免和插件同名类型混淆」。那个理由是错的：
 *
 * `course` 是**共享类型名** —— 核心写自己那份，ICS 也写自己那份。限死核心命名空间后，
 * ICS 的控件 `requires: ['course', 'session']` 只能拿到**核心**的课程（用户从没建过，
 * 所以是空的），而课时拿的是跨命名空间的，于是「有课时、零课程」→ 控件永远停在空态。
 * 用户看到的是「导入了课表，首页还是让我去导入」。
 *
 * 正确做法是不带 `owner`：`bus.read()` 跨命名空间返回，**每条记录按自己所有者的
 * schema 裁剪字段**，所以核心的 `color` 和 ICS 的 `location` 不会互相污染。
 * 这正是共享类型机制的本意。
 *
 * ⚠️ 想「只读核心」的调用方（例如课程页要判断可编辑性）必须自己按 `rec.pluginId` 区分，
 * 不能靠在这里加 owner 过滤。
 */

import type { ViewRecord } from '@matrix/plugin-api';

import type { PluginHost } from '../core/plugin-host.ts';

/**
 * 宿主自己的读者 id。`bus.read()` 要求一个读者 id，宿主不是插件。
 * 与 `core-entities.ts` 的 `HOST_NS` 是同一个值 —— 这里不能 import 那个模块的运行时值，
 * 否则纯逻辑测试又要拖进一串东西；值相同由下面的测试钉住。
 */
const HOST_ID = 'dev.matrix.shell';

/** 单次取数的上限。超过这个量级的控件应当改成聚合视图，而不是把整表塞进渲染树 */
const MAX_RECORDS = 200;

export function recordsFor(
  host: PluginHost,
  pluginId: string,
  types: readonly string[],
): { records: ViewRecord[]; missing: string[] } {
  const granted = host.registry.get(pluginId)?.manifest.permissions?.data?.read ?? [];
  const missing = types.filter((t) => !granted.includes(t));

  const records: ViewRecord[] = [];
  for (const type of types) {
    // 权限闸：`requires` 不是授权，插件没声明 `data.read` 的类型一条也不给
    if (!granted.includes(type)) continue;
    const r = host.bus.read(HOST_ID, type, { limit: MAX_RECORDS });
    if (!r.ok) continue;
    for (const rec of r.data) {
      records.push({ type: rec.type, id: rec.id, data: rec.data, updatedAt: rec.updatedAt });
    }
  }
  return { records, missing };
}
