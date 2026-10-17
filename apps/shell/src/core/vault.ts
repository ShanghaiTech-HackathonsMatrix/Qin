/**
 * 凭证库（DESIGN.md §8.2 的 vault 侧）。
 *
 * 两条硬约束：
 *
 *  1. **按插件命名空间隔离。** 底层是一个扁平 KV，但每个插件只能看到自己前缀下的键。
 *     没有这层隔离，插件 A 就能读到插件 B 的会话 cookie 与口令。
 *  2. **口令不落明文。** 具体由注入的 backend 决定；核心只负责选一个可用的 backend
 *     并把它的保护强度如实上报（`protection`），绝不把「能读写」谎报成「已加密」。
 *
 * 这里不重复实现 Keystore 存取 —— 那是 `src/platform/strategies/kv/` 的职责，
 * 已经有完整的降级链（Keystore → Preferences → localStorage）与真实往返探测。
 * 本模块只在其上加能力校验与命名空间。
 */

import { CoreError } from './types.ts';
import type { CapabilityRegistry } from './tokens.ts';

/** 与 `src/platform/strategies/kv` 的 `SecureStore` 结构兼容（结构化类型，不硬依赖） */
export interface VaultBackend {
  readonly encrypted: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** 底层保护强度的**如实**描述 */
export type ProtectionLevel = 'system' | 'plaintext';

export interface VaultEntryInfo {
  /** 插件视角的键名（已剥掉命名空间前缀） */
  key: string;
  /** 值长度，不返回内容本身 */
  length: number;
}

const NS_SEP = '\u0000';

export class Vault {
  private readonly backend: VaultBackend;
  private readonly tokens: CapabilityRegistry;

  constructor(backend: VaultBackend, tokens: CapabilityRegistry) {
    this.backend = backend;
    this.tokens = tokens;
  }

  /** 如实上报：底层是系统级加密，还是明文存储 */
  get protection(): ProtectionLevel {
    return this.backend.encrypted ? 'system' : 'plaintext';
  }

  /**
   * 保护强度的**人话**说明。
   * 之所以要做这个，是因为「能读写」和「真的安全」是两件事 ——
   * 降级到 Preferences/localStorage 时，加密收益接近零，必须让用户看见。
   */
  get protectionNote(): string {
    return this.backend.encrypted
      ? '由系统安全存储（Keystore / Keychain）保护'
      : '⚠️ 明文存储 —— 同设备上的其它程序或备份可能读到，加密收益接近零';
  }

  private ns(pluginId: string, key: string): string {
    if (!key) throw new CoreError('EAUTH', 'vault 键名不能为空');
    if (key.includes(NS_SEP)) throw new CoreError('EAUTH', 'vault 键名不能包含保留字符');
    return `p${NS_SEP}${pluginId}${NS_SEP}${key}`;
  }

  private async who(tokenId: string | null | undefined): Promise<string> {
    return this.tokens.verify(tokenId, 'vault').pluginId;
  }

  async get(tokenId: string | null | undefined, key: string): Promise<string | null> {
    const pluginId = await this.who(tokenId);
    return this.backend.get(this.ns(pluginId, key));
  }

  async set(tokenId: string | null | undefined, key: string, value: string): Promise<void> {
    const pluginId = await this.who(tokenId);
    await this.backend.set(this.ns(pluginId, key), value);
  }

  async remove(tokenId: string | null | undefined, key: string): Promise<void> {
    const pluginId = await this.who(tokenId);
    await this.backend.remove(this.ns(pluginId, key));
  }

  /** 只列本插件自己的键，且只返回键名与长度 —— 不返回内容 */
  async list(tokenId: string | null | undefined): Promise<VaultEntryInfo[]> {
    const pluginId = await this.who(tokenId);
    const prefix = `p${NS_SEP}${pluginId}${NS_SEP}`;
    const all = await this.backend.keys();
    const out: VaultEntryInfo[] = [];
    for (const k of all) {
      if (!k.startsWith(prefix)) continue;
      const short = k.slice(prefix.length);
      const v = await this.backend.get(k);
      out.push({ key: short, length: v?.length ?? 0 });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  /** 清空本插件的全部条目（卸载插件时用） */
  async clear(tokenId: string | null | undefined): Promise<number> {
    const pluginId = await this.who(tokenId);
    const prefix = `p${NS_SEP}${pluginId}${NS_SEP}`;
    const all = await this.backend.keys();
    let n = 0;
    for (const k of all) {
      if (k.startsWith(prefix)) {
        await this.backend.remove(k);
        n += 1;
      }
    }
    return n;
  }
}
