import type {PluginHost} from '../core/plugin-host.ts';
export const pluginRoute=(pluginId:string,viewId:string)=>`plugin/${encodeURIComponent(pluginId)}/${encodeURIComponent(viewId)}`;
export function pageTarget(host:PluginHost,pluginId:string,to:string):string|null{
  const rec=host.registry.get(pluginId);
  if(rec?.state==='active'&&rec.manifest.contributes?.views?.some(v=>v.kind==='page'&&v.id===to))return pluginRoute(pluginId,to);
  return ['home','timeline','timetable','courses','settings'].includes(to)?to:null;
}
export function parsePluginRoute(to:string){const m=/^plugin\/([^/]+)\/([^/]+)$/.exec(to);if(!m)return null;try{return {pluginId:decodeURIComponent(m[1]!),viewId:decodeURIComponent(m[2]!) };}catch{return null;}}
