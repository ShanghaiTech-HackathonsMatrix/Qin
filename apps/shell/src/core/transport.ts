/**
 * 传输层：把「怎么把字节发出去」与「允不允许发」彻底分开。
 *
 * 网关（gateway.ts）只依赖这里的 `Transport` 接口，因此同一套策略代码
 * 既能跑在真机原生传输上，也能跑在测试用的脚本化传输上 ——
 * 这就是 DESIGN.md §7.4 要的「同构适配器」。
 *
 * ⚠️ 不变量 I7：我们**直接调用** `CapacitorHttp` 插件，但绝不打开
 * `plugins.CapacitorHttp.enabled`。那个开关的作用是让 WebView 去补丁
 * `window.fetch` / `XMLHttpRequest`（见 WebViewLocalServer.java:189），
 * 一旦打开，WebView 自己就有了出网能力，`connect-src 'none'` 随之失效。
 * 关着它，插件依然可用（Bridge.java:663 是无条件注册的）。
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { CoreError, type Transport, type TransportRequest, type TransportResponse } from './types.ts';

/** 响应头统一转小写，避免调用方在 `Location` / `location` 上踩坑 */
function normalizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k.toLowerCase()] = v == null ? '' : String(v);
  }
  return out;
}

/**
 * 把插件返回的 `data` 变成字符串。
 *
 * 关键：`CapacitorHttp` 在 content-type 是 JSON 时**忽略 `responseType`**，强制 parse 成对象。
 * 原生 `HttpRequestHandler.java:250-252` 与 Web 实现行为一致。所以这里的 JSON.stringify
 * **不是我们主动选的**，而是被动补偿 —— 并且是有损的。因此要如实回报 `wasJson`。
 */
function bodyToString(data: unknown): { text: string; wasJson: boolean } {
  if (data == null) return { text: '', wasJson: false };
  if (typeof data === 'string') return { text: data, wasJson: false };
  try {
    return { text: JSON.stringify(data), wasJson: true };
  } catch {
    return { text: String(data), wasJson: true };
  }
}

/**
 * 真机 / 桌面的传输实现。
 * 走 `CapacitorHttp`：Android 是 HttpURLConnection，iOS 是 URLSession，Web 是 fetch。
 */
export class CapacitorTransport implements Transport {
  readonly kind = 'capacitor-http';

  async request(req: TransportRequest): Promise<TransportResponse> {
    let res;
    try {
      res = await CapacitorHttp.request({
        url: req.url,
        method: req.method,
        headers: req.headers,
        data: req.body,
        connectTimeout: req.connectTimeoutMs,
        readTimeout: req.readTimeoutMs,
        // 关键：关掉自动跳转，让我们能逐跳复检白名单（§8.1）
        disableRedirects: true,
        responseType: 'text',
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new CoreError('ENET', `传输失败: ${msg}`, { url: req.url });
    }

    const body = bodyToString(res?.data);

    return {
      status: Number(res?.status ?? 0),
      headers: normalizeHeaders(res?.headers),
      body: body.text,
      url: String(res?.url ?? req.url),
      followedRedirects: false,
      bodyWasJson: body.wasJson,
    };
  }
}

/** 当前环境能否用原生传输（Web 端也能用，会退化为 fetch） */
export function transportAvailable(): boolean {
  return Capacitor.isPluginAvailable('CapacitorHttp');
}

/**
 * 脚本化传输，供一致性测试与调试面板的「自检」使用。
 * 它不是生产路径 —— 生产路径永远是 `CapacitorTransport`。
 */
export interface MockReply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  /**
   * 模拟「传输层把 JSON 解析掉了」：给对象而不是字符串。
   * 真机上 content-type 是 JSON 时就是这个行为，用它来测往返保真度告警。
   */
  json?: unknown;
  /** 让本次调用抛错，用于测试网络故障分支 */
  throw?: string;
}

export class MockTransport implements Transport {
  readonly kind = 'mock';
  readonly calls: TransportRequest[] = [];
  private readonly replies = new Map<string, MockReply[]>();
  private readonly fallback: MockReply;

  /** 按 URL 前缀排队应答；用完则回落到 fallback */
  queue(urlPrefix: string, reply: MockReply): this {
    const list = this.replies.get(urlPrefix) ?? [];
    list.push(reply);
    this.replies.set(urlPrefix, list);
    return this;
  }

  constructor(fallback: MockReply = { status: 404, body: 'no mock reply' }) {
    this.fallback = fallback;
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    this.calls.push(req);

    let reply: MockReply = this.fallback;
    for (const [prefix, list] of this.replies) {
      if (req.url.startsWith(prefix) && list.length > 0) {
        reply = list.shift() as MockReply;
        break;
      }
    }

    if (reply.throw) throw new CoreError('ENET', reply.throw, { url: req.url });

    // `json` 存在时模拟「传输层已解析」：返回对象而非字符串
    if (reply.json !== undefined) {
      const converted = bodyToString(reply.json);
      return {
        status: reply.status,
        headers: normalizeHeaders(reply.headers),
        body: converted.text,
        url: req.url,
        followedRedirects: false,
        bodyWasJson: true,
      };
    }

    return {
      status: reply.status,
      headers: normalizeHeaders(reply.headers),
      body: reply.body ?? '',
      url: req.url,
      followedRedirects: false,
    };
  }
}
