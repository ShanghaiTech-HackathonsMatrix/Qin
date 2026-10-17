/**
 * 能力令牌（对应不变量 I10）。
 *
 * 为什么不用 frame origin 做鉴权：Android 的 `addJavascriptInterface` 会注入到**所有 frame**，
 * 包括 opaque-origin 的 iframe。也就是说 iframe 根本不是边界，
 * 任何「按来源授权」的方案在这个平台上都是假的。
 *
 * 所以改成：核心层只暴露一个窄入口，每次调用都必须出示令牌；
 * 令牌绑定到 pluginId 与一组能力，可过期、可按插件撤销（对应 D7 的可撤销信任）。
 */

import { CoreError, type Capability, type CapabilityToken } from './types.ts';

const DEFAULT_TTL_MS = 30 * 60 * 1000;

function randomId(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class CapabilityRegistry {
  private readonly tokens = new Map<string, CapabilityToken>();
  /** tokenId → 签发时的「信任代」。与当前代不符即失效 */
  private readonly tokenGen = new Map<string, number>();
  /** pluginId → 当前信任代。撤销即 +1 */
  private readonly generations = new Map<string, number>();
  /** 当前处于撤销状态的插件 */
  private readonly revoked = new Set<string>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  private genOf(pluginId: string): number {
    return this.generations.get(pluginId) ?? 0;
  }

  issue(
    pluginId: string,
    caps: readonly Capability[],
    ttlMs: number = DEFAULT_TTL_MS,
  ): CapabilityToken {
    if (!pluginId) throw new Error('pluginId 不能为空');
    if (caps.length === 0) throw new Error('至少要授予一项能力');
    // 处于撤销状态的插件不能拿到新令牌 —— 否则「撤销」会被一次 issue 直接绕开
    if (this.revoked.has(pluginId)) {
      throw new CoreError('EAUTH', `插件 ${pluginId} 的信任已被撤销，无法签发令牌`);
    }

    const t = this.now();
    const token: CapabilityToken = {
      id: randomId(),
      pluginId,
      caps: new Set(caps),
      issuedAt: t,
      expiresAt: t + ttlMs,
    };
    this.tokens.set(token.id, token);
    this.tokenGen.set(token.id, this.genOf(pluginId));
    return token;
  }

  /**
   * 校验令牌。任何一项不满足都抛 `EAUTH` —— 不给调用方任何「部分可用」的余地。
   *
   * 用「信任代」而不是「撤销时间戳」来判断失效：时间戳方案在
   * 撤销 → 恢复 → 重新签发的组合下会出现旧令牌复活，代际计数没有这个问题。
   */
  verify(tokenId: string | null | undefined, need: Capability): CapabilityToken {
    if (!tokenId) throw new CoreError('EAUTH', '缺少能力令牌');
    const token = this.tokens.get(tokenId);
    if (!token) throw new CoreError('EAUTH', '能力令牌无效');

    if (this.revoked.has(token.pluginId)) {
      throw new CoreError('EAUTH', `插件 ${token.pluginId} 的信任已被撤销`, {
        pluginId: token.pluginId,
      });
    }

    if (this.tokenGen.get(tokenId) !== this.genOf(token.pluginId)) {
      throw new CoreError('EAUTH', '能力令牌已被撤销', { pluginId: token.pluginId });
    }

    if (this.now() >= token.expiresAt) {
      this.tokens.delete(tokenId);
      this.tokenGen.delete(tokenId);
      throw new CoreError('EAUTH', '能力令牌已过期', { pluginId: token.pluginId });
    }

    if (!token.caps.has(need)) {
      throw new CoreError('EAUTH', `令牌不含所需能力「${need}」`, {
        pluginId: token.pluginId,
        has: [...token.caps],
      });
    }
    return token;
  }

  /**
   * 撤销某个插件的全部令牌（对应 D7 的「逐插件可撤销」）。
   *
   * 只提升代际、不删除令牌 —— 这样 `verify` 能给出「已被撤销」这种有用的错误，
   * 而不是含糊的「无效」。令牌本身由 `sweep()` 在过期时回收。
   *
   * @returns 该插件当前持有的令牌数
   */
  revokePlugin(pluginId: string): number {
    this.revoked.add(pluginId);
    this.generations.set(pluginId, this.genOf(pluginId) + 1);

    let n = 0;
    for (const t of this.tokens.values()) {
      if (t.pluginId === pluginId) n += 1;
    }
    return n;
  }

  /**
   * 恢复某插件的信任。**旧令牌不会复活** —— 代际已经提升过，
   * 必须重新 `issue` 才能用。
   */
  restorePlugin(pluginId: string): void {
    this.revoked.delete(pluginId);
  }

  isRevoked(pluginId: string): boolean {
    return this.revoked.has(pluginId);
  }

  /** 回收过期令牌，避免长期运行后内存堆积 */
  sweep(): number {
    const t = this.now();
    let n = 0;
    for (const [id, token] of this.tokens) {
      if (t >= token.expiresAt) {
        this.tokens.delete(id);
        this.tokenGen.delete(id);
        n += 1;
      }
    }
    return n;
  }

  get activeCount(): number {
    return this.tokens.size;
  }
}
