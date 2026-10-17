import { bootstrap, type Platform } from '../platform/bootstrap';

/**
 * bootstrap 只跑一次并缓存。
 * 调试面板切换策略时用 loadPlatform(true) 强制重跑。
 */
let cached: Promise<Platform> | null = null;

export function loadPlatform(force = false): Promise<Platform> {
  if (force || !cached) cached = bootstrap();
  return cached;
}
