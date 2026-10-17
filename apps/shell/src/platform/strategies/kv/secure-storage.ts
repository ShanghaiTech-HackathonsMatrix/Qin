import { Capacitor } from '@capacitor/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import type { ProbeResult, Strategy } from '../types';
import { probeKey, type SecureStore } from './types';

const PREFIX = 'matrix_';

/**
 * 理想实现：Android Keystore / iOS Keychain 支撑的系统级安全存储。
 *
 * probe 做一次真实的写-读-删往返，而不是只查插件是否存在 ——
 * 因为「插件注册了但底层 KeyStore 不可用」是实机上真实会发生的失败模式。
 */
export const secureStorageKv: Strategy<SecureStore> = {
  slot: 'kv',
  id: 'kv.secure-storage',
  label: '系统安全存储（Keystore / Keychain）',
  tier: 'ideal',
  order: 10,
  note: '经 @aparajita/capacitor-secure-storage 落到 Android Keystore / iOS Keychain',

  async probe(): Promise<ProbeResult> {
    if (Capacitor.getPlatform() === 'web') {
      return { ok: false, reason: 'web 平台没有系统安全存储' };
    }
    if (!Capacitor.isPluginAvailable('SecureStorage')) {
      return { ok: false, reason: 'SecureStorage 插件未注册（原生侧可能没同步）' };
    }

    const k = probeKey();
    try {
      await SecureStorage.setKeyPrefix(PREFIX);
      const sentinel = `v${Date.now()}`;
      await SecureStorage.set(k, sentinel);
      const back = await SecureStorage.get(k);
      if (back !== sentinel) {
        await SecureStorage.remove(k).catch(() => undefined);
        return { ok: false, reason: `往返值不一致（写入 ${sentinel}，读回 ${String(back)}）` };
      }
      await SecureStorage.remove(k);
      const after = await SecureStorage.get(k);
      if (after !== null) {
        return { ok: false, reason: 'remove 之后仍能读到值' };
      }
      return { ok: true, detail: '写-读-删往返正常' };
    } catch (e) {
      await SecureStorage.remove(k).catch(() => undefined);
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: string })?.code;
      return { ok: false, reason: `往返失败${code ? ` [${code}]` : ''}: ${msg}` };
    }
  },

  async create(): Promise<SecureStore> {
    await SecureStorage.setKeyPrefix(PREFIX);
    return {
      encrypted: true,
      async get(key) {
        const v = await SecureStorage.get(PREFIX + key);
        return v === null || v === undefined ? null : String(v);
      },
      async set(key, value) {
        await SecureStorage.set(PREFIX + key, value);
      },
      async remove(key) {
        await SecureStorage.remove(PREFIX + key);
      },
      async keys() {
        const all = await SecureStorage.keys();
        return all.filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length));
      },
    };
  },
};
