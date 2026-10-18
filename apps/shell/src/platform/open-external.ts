import { Capacitor } from '@capacitor/core';
import { PlatformSessions } from '../core/academic-transport';

/** 外部浏览器独立登录，永远不复制应用内的 Cookie。 */
export async function openExternal(value:string):Promise<void> {
  const url=new URL(value);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('仅支持普通 HTTP(S) 网页');
  if(['android','ios'].includes(Capacitor.getPlatform()))await PlatformSessions.openExternal({url:url.href});
  else window.open(url.href,'_blank','noopener,noreferrer');
}
