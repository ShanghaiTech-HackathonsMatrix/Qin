import { Preferences } from '@capacitor/preferences';
import type { ProbeResult, Strategy } from '../types';
import { probeKey, type SecureStore } from './types';

const PREFIX = 'matrix_';

/**
 * 降级实现：@capacitor/preferences。
 * Android 上落在 SharedPreferences（应用私有目录，未加密）。
 * 安全性弱于 Keystore，但可用性极高。
 */
export const preferencesKv: Strategy<SecureStore> = {
  slot: 'kv',
  id: 'kv.preferences',
  label: 'Preferences（应用私有存储，未加密）',
  tier: 'fallback',
  order: 10,
  note: 'Android SharedPreferences / iOS UserDefaults / web localStorage',

  async probe(): Promise<ProbeResult> {
    const k = probeKey();
    try {
      const sentinel = `v${Date.now()}`;
      await Preferences.set({ key: PREFIX + k, value: sentinel });
      const { value } = await Preferences.get({ key: PREFIX + k });
      await Preferences.remove({ key: PREFIX + k });
      if (value !== sentinel) {
        return { ok: false, reason: `往返值不一致（读回 ${String(value)}）` };
      }
      return { ok: true, detail: '写-读-删往返正常' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: `往返失败: ${msg}` };
    }
  },

  async create(): Promise<SecureStore> {
    return {
      encrypted: false,
      async get(key) {
        const { value } = await Preferences.get({ key: PREFIX + key });
        return value ?? null;
      },
      async set(key, value) {
        await Preferences.set({ key: PREFIX + key, value });
      },
      async remove(key) {
        await Preferences.remove({ key: PREFIX + key });
      },
      async keys() {
        const { keys } = await Preferences.keys();
        return keys.filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length));
      },
    };
  },
};
