import { Capacitor, registerPlugin } from '@capacitor/core';
import { CoreError, type Transport, type TransportRequest, type TransportResponse } from './types.ts';
import { ENTRY, PLUGIN_IDS, PROVIDERS, type Provider } from '../plugins/builtin/academic/model.ts';

export interface PlatformSessionBridge {
  login(input: { provider: Provider }): Promise<{ completed: boolean }>;
  clear(): Promise<void>;
  request(input: { provider: Provider; url: string; method: string; body?: string; timeout: number }): Promise<TransportResponse>;
}
export const PlatformSessions = registerPlugin<PlatformSessionBridge>('PlatformSessions');
export function academicSessionFor(pluginId: string): string | undefined {
  const provider = PROVIDERS.find(p => PLUGIN_IDS[p] === pluginId);
  return provider ? `academic:${provider}` : undefined;
}
export class AcademicTransport implements Transport {
  readonly kind = 'native-academic-session';
  private readonly fallback: Transport;
  private readonly native: PlatformSessionBridge;
  constructor(fallback: Transport, native: PlatformSessionBridge = PlatformSessions) { this.fallback = fallback; this.native = native; }
  async request(req: TransportRequest): Promise<TransportResponse> {
    if (!req.session?.startsWith('academic:')) return this.fallback.request(req);
    const provider = req.session.slice(9) as Provider;
    if (!PROVIDERS.includes(provider)) throw new CoreError('EAUTH', '未知平台会话');
    const target = new URL(req.url), expected = new URL(ENTRY[provider]);
    if (target.origin !== expected.origin || target.username || target.password) throw new CoreError('EAUTH', '平台会话不能用于其他站点');
    try {
      return await this.native.request({ provider, url: req.url, method: req.method, body: req.body, timeout: req.readTimeoutMs });
    } catch (e) {
      const message = e instanceof Error ? e.message : '原生会话请求失败';
      throw new CoreError(message.includes('LOGIN_REQUIRED') ? 'EAUTH' : 'ENET', message);
    }
  }
}
export function academicNativeAvailable(): boolean { return Capacitor.getPlatform() === 'android'; }
