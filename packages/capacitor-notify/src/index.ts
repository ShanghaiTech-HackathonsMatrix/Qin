/**
 * 通知桥的 JS 入口。
 *
 * Android / iOS 由宿主 CapacitorNotifyPort 探测后装配，Web 明确返回不支持。
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
