/**
 * 会话：插件只拿句柄，凭证由核心保管并注入（DESIGN.md §8.2）。
 *
 * 句柄是一串随机标识，插件可以随便持有、随便传；
 * 真正的 cookie 存在这里，**永远不进入插件的可见范围**。
 *
 * 当前实现是内存 cookie jar。它刻意保持简单，已知限制：
 *   · 不处理 Path / Domain 作用域（按 host 精确归档）
 *   · 不处理 Expires / Max-Age（句柄生命周期由调用方管理）
 *   · 不处理 SameSite / Secure 语义
 * 这些都是「够用即可」的取舍 —— 真正的持久化与作用域规则留给 vault 集成时补齐。
 */

export interface SessionProvider {
  /** 供调试面板与审计区分后端实现 */
  readonly kind?: string;
  /** 取出发往该主机的请求头（通常只有 Cookie） */
  headersFor(sessionId: string, host: string): Promise<Record<string, string>>;
  /** 把响应里的 Set-Cookie 写回会话 */
  acceptSetCookie?(sessionId: string, host: string, cookies: string[]): Promise<void>;
  /**
   * 该会话当前持有多少条 cookie —— **只给调试面板看数量，不暴露内容**。
   * 可选：后端可以不实现，面板会显示「未知」。
   */
  cookieCount?(sessionId: string): number;
}

export function jarKey(sessionId: string, host: string): string {
  return `${sessionId}\u0000${host.toLowerCase()}`;
}

/** `api.example.com` → `https://api.example.com/` */
export function originOf(host: string): string {
  return `https://${host.toLowerCase()}/`;
}

/** 从 `name=value; Path=/; HttpOnly` 里取出 name 与 value */
export function parseCookie(raw: string): { name: string; value: string } | null {
  const first = raw.split(';')[0]?.trim();
  if (!first) return null;
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;
  return { name, value };
}

export class MemorySessions implements SessionProvider {
  readonly kind = 'memory';
  private readonly jars = new Map<string, Map<string, string>>();

  async headersFor(sessionId: string, host: string): Promise<Record<string, string>> {
    const jar = this.jars.get(jarKey(sessionId, host));
    if (!jar || jar.size === 0) return {};
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    return { cookie };
  }

  async acceptSetCookie(sessionId: string, host: string, cookies: string[]): Promise<void> {
    if (cookies.length === 0) return;
    const key = jarKey(sessionId, host);
    let jar = this.jars.get(key);
    if (!jar) {
      jar = new Map();
      this.jars.set(key, jar);
    }
    for (const raw of cookies) {
      const c = parseCookie(raw);
      if (!c) continue;
      // 空值 + 立即过期 = 删除
      if (c.value === '' || /max-age=0/i.test(raw)) jar.delete(c.name);
      else jar.set(c.name, c.value);
    }
  }

  /** 只给调试面板看数量，不暴露 cookie 内容 */
  cookieCount(sessionId: string): number {
    let n = 0;
    for (const [k, jar] of this.jars) {
      if (k.startsWith(`${sessionId}\u0000`)) n += jar.size;
    }
    return n;
  }

  clear(sessionId?: string): void {
    if (!sessionId) {
      this.jars.clear();
      return;
    }
    for (const k of [...this.jars.keys()]) {
      if (k.startsWith(`${sessionId}\u0000`)) this.jars.delete(k);
    }
  }
}
