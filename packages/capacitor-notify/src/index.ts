/**
 * 通知桥的 JS 入口。
 *
 * ⚠️ **当前未接线**：`apps/shell` 还没有依赖这个包，`bootstrap.ts` 里的
 * `Platform.notify` 是 `UnsupportedNotifyPort`。激活步骤见 `README.md`。
 *
 * 现在把文件放在这里而不是等到要用时再建，是为了让**各端 bridge 能独立开工**：
 * iOS 的同伴可以直接打开 `ios/` 编译一个 Swift Package，
 * Android 的可以直接打开 `android/` 编译一个 library 模块，
 * 两边都不需要先跑通整个 App。
 */

import { registerPlugin } from '@capacitor/core';

import type { MatrixNotifyPlugin } from './definitions.ts';
import { PLUGIN_NAME } from './definitions.ts';

export * from './definitions.ts';

/**
 * 原生实现。在 web 上没有原生层，`registerPlugin` 会回落到 `WebPlugin`
 * （见 `web.ts`），行为是「诚实地说不支持」。
 */
export const MatrixNotify = registerPlugin<MatrixNotifyPlugin>(PLUGIN_NAME, {
  web: () => import('./web.ts').then((m) => new m.MatrixNotifyWeb()),
});
