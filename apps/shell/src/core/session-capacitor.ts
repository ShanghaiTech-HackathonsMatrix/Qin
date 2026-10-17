/**
 * 用 `CapacitorCookies` 支撑的会话（目标里「会话注入复用 CapacitorCookies」的落点）。
 *
 * ── 先说清楚这件事的真实情况，因为它和纸面设想不一样 ──
 *
 * 核查源码后发现：`CapacitorCookies.load()` 会执行 `CookieHandler.setDefault(this.cookieManager)`
 * （`CapacitorCookies.java:26`）。这是 **JVM 全局**的默认 cookie handler，而 `HttpURLConnection`
 * ——也就是 `CapacitorHttp` 的底层——会自动使用它。而 `Bridge.java:661` 无条件注册该插件，
 * `PluginHandle` 构造函数（`PluginHandle.java:64-65`）无条件调用 `load()`。
 *
 * **结论**：原生 cookie 存储是**进程全局、开机即生效**的，我们从 JS 关不掉。
 * 因此：
 *   · cookie 的**自动持久化与自动附加**是白送的，不需要我们做
 *   · 但也意味着**跨插件的 cookie 隔离在传输层不成立** —— 见 DESIGN.md §8.2 的说明
 *
 * ── 那这个类到底提供了什么价值 ──
 *
 * 两件内存 jar 做不到的事：
 *   1. **显式注入**：从别处（如登录流程）拿到的 cookie，塞进原生存储让后续请求自动带上
 *   2. **精确撤销**：维护 (会话, 主机) → cookie 名 的索引，登出时能**只删自己那几个**，
 *      而不是 `clearAllCookies()` 把全进程的 cookie 一锅端
 *
 * `headersFor()` 返回空对象是**故意的**：原生层会自动附加 cookie，
 * 我们再去手工拼一个 Cookie 头只会造成重复。见 DESIGN.md §8.2。
 */

import { CapacitorCookies } from '@capacitor/core';
import { jarKey, originOf, parseCookie, type SessionProvider } from './session.ts';

/**
 * 原生 cookie 存储的最小接口。
 *
 * 抽成接口而不是直接绑 `CapacitorCookies`，是为了能在 Node 里测 ——
 * 原生插件在 Node 下会落到 Web 实现，而 Web 实现要 `document`，直接调用会炸。
 * 生产路径的默认值就是真的 `CapacitorCookies`。
 */
export interface CookieJarNative {
  setCookie(options: { url: string; key: string; value: string; expires?: string; path?: string }): Promise<void>;
  deleteCookie(options: { url: string; key: string }): Promise<void>;
  clearAllCookies(): Promise<void>;
}

export class CapacitorCookiesSession implements SessionProvider {
  readonly kind = 'capacitor-cookies';

  /** (会话, 主机) → 本会话在该主机上写入的 cookie 名。用于精确撤销 */
  private readonly index = new Map<string, Set<string>>();
  /** 调用原生插件失败的次数，供调试面板显示 */
  private failures = 0;
  private readonly jar: CookieJarNative;

  constructor(jar: CookieJarNative = CapacitorCookies) {
    this.jar = jar;
  }

  // 形参故意保留（用 _ 前缀标为未使用）以匹配 SessionProvider 的签名 ——
  // 实现上确实不需要它们，因为原生 CookieHandler 会自己按 URL 匹配 cookie
  async headersFor(_sessionId: string, _host: string): Promise<Record<string, string>> {
    // 原生 CookieHandler 会自己附加，这里刻意不重复注入
    return {};
  }

  async acceptSetCookie(sessionId: string, host: string, cookies: string[]): Promise<void> {
    if (cookies.length === 0) return;
    const key = jarKey(sessionId, host);
    let names = this.index.get(key);
    if (!names) {
      names = new Set();
      this.index.set(key, names);
    }

    for (const raw of cookies) {
      const c = parseCookie(raw);
      if (!c) continue;
      const url = originOf(host);
      try {
        if (c.value === '' || /max-age=0/i.test(raw)) {
          await this.jar.deleteCookie({ url, key: c.name });
          names.delete(c.name);
        } else {
          await this.jar.setCookie({ url, key: c.name, value: c.value });
          names.add(c.name);
        }
      } catch {
        // 原生失败绝不能拖垮请求 —— 原生 CookieHandler 其实已经自己存过了，
        // 我们这一步是「显式登记」，失败只影响后续能否精确撤销
        this.failures += 1;
      }
    }
  }

  /** 显式注入一个 cookie（登录流程拿到凭证后调用） */
  async inject(sessionId: string, host: string, name: string, value: string): Promise<void> {
    const key = jarKey(sessionId, host);
    let names = this.index.get(key);
    if (!names) {
      names = new Set();
      this.index.set(key, names);
    }
    try {
      await this.jar.setCookie({ url: originOf(host), key: name, value });
      names.add(name);
    } catch {
      this.failures += 1;
      throw new Error('注入 cookie 失败（原生插件不可用？）');
    }
  }

  /** 撤销某个会话写入的全部 cookie，返回删除条数 */
  async clear(sessionId: string): Promise<number> {
    let n = 0;
    for (const [key, names] of [...this.index.entries()]) {
      if (!key.startsWith(`${sessionId}\u0000`)) continue;
      const host = key.slice(key.indexOf('\u0000') + 1);
      for (const name of names) {
        try {
          await this.jar.deleteCookie({ url: originOf(host), key: name });
          n += 1;
        } catch {
          this.failures += 1;
        }
      }
      this.index.delete(key);
    }
    return n;
  }

  /** 清空**整个进程**的 cookie（含其它插件留下的）。慎用 —— 这是核选项 */
  async clearAll(): Promise<void> {
    try {
      await this.jar.clearAllCookies();
    } catch {
      this.failures += 1;
    }
    this.index.clear();
  }

  cookieCount(sessionId: string): number {
    let n = 0;
    for (const [key, names] of this.index) {
      if (key.startsWith(`${sessionId}\u0000`)) n += names.size;
    }
    return n;
  }

  get stats(): { sessions: number; failures: number } {
    return { sessions: this.index.size, failures: this.failures };
  }
}
