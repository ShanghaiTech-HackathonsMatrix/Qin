import type { ProbeResult, Strategy } from '../types';
import { probeKey, type SecureStore } from './types';

const PREFIX = 'matrix_';

/**
 * 兜底 / 开发用：浏览器 localStorage。
 * 用途有二：(1) 桌面浏览器里跑 `npm run dev` 时的持久化；
 * (2) Preferences 也挂掉时的最后退路（此时数据可能随缓存被清理，会明确告警）。
 */
export const localStorageKv: Strategy<SecureStore> = {
  slot: 'kv',
  id: 'kv.localstorage',
  label: 'localStorage（兜底，数据可能被系统清理）',
  tier: 'dev',
  order: 10,
  note: '仅浏览器/WebView 的 localStorage，无加密、无持久性保证',

  async probe(): Promise<ProbeResult> {
    try {
      if (typeof localStorage === 'undefined') {
        return { ok: false, reason: '当前环境没有 localStorage' };
      }
      const k = probeKey();
      const sentinel = `v${Date.now()}`;
      localStorage.setItem(PREFIX + k, sentinel);
      const back = localStorage.getItem(PREFIX + k);
      localStorage.removeItem(PREFIX + k);
      if (back !== sentinel) return { ok: false, reason: '往返值不一致' };
      return { ok: true, detail: '写-读-删往返正常（无加密）' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: `localStorage 不可用: ${msg}` };
    }
  },

  async create(): Promise<SecureStore> {
    return {
      encrypted: false,
      async get(key) {
        return localStorage.getItem(PREFIX + key);
      },
      async set(key, value) {
        localStorage.setItem(PREFIX + key, value);
      },
      async remove(key) {
        localStorage.removeItem(PREFIX + key);
      },
      async keys() {
        const out: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
        }
        return out;
      },
    };
  },
};
