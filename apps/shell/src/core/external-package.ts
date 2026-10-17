import { unzipSync, strFromU8 } from 'fflate';
import { validateManifest, negotiateApiVersion, type Manifest } from '@matrix/plugin-api';

export interface ExternalPackage { manifest:Manifest; source:string }
export const PACKAGE_LIMIT=2*1024*1024;
/** 在解压前读取中央目录，限制展开大小并拒绝重复文件和路径穿越。 */
export function readPluginPackage(bytes:Uint8Array):ExternalPackage {
  if(bytes.length>PACKAGE_LIMIT||bytes.length<22)throw new Error('插件包须小于 2 MiB，且为有效 ZIP');
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(v.getUint32(i,true)===0x06054b50&&i+22+v.getUint16(i+20,true)===bytes.length){end=i;break;}
  if(end<0||v.getUint16(end+4,true)||v.getUint16(end+6,true))throw new Error('不支持分卷 ZIP');
  const count=v.getUint16(end+10,true),offset=v.getUint32(end+16,true),size=v.getUint32(end+12,true);
  if(count<2||count>64||v.getUint16(end+8,true)!==count||offset+size!==end)throw new Error('插件包目录无效或文件过多');
  const names=new Set<string>(),sizes=new Map<string,number>();let cursor=offset,total=0;
  for(let n=0;n<count;n++){
    if(cursor+46>end||v.getUint32(cursor,true)!==0x02014b50)throw new Error('ZIP 中央目录无效');
    const flags=v.getUint16(cursor+8,true),method=v.getUint16(cursor+10,true),len=v.getUint16(cursor+28,true);
    const expanded=v.getUint32(cursor+24,true),packed=v.getUint32(cursor+20,true),local=v.getUint32(cursor+42,true);
    if(cursor+46+len>end)throw new Error('ZIP 文件名越界');
    const name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(cursor+46,cursor+46+len));
    if(!name||name.length>240||/[\\:\x00]/.test(name)||name.startsWith('/')||name.split('/').some(p=>p==='..'||p==='.')||names.has(name))throw new Error('插件包路径无效或重复');
    if(flags&1||![0,8].includes(method)||local+30>offset||v.getUint32(local,true)!==0x04034b50)throw new Error('不支持加密 ZIP 或此压缩方式');
    const start=local+30+v.getUint16(local+26,true)+v.getUint16(local+28,true);
    if(start+packed>offset||v.getUint16(local+8,true)!==method||v.getUint16(local+6,true)!==flags)throw new Error('ZIP 数据越界');
    const localName=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(local+30,local+30+v.getUint16(local+26,true)));
    if(localName!==name)throw new Error('ZIP 路径不一致');
    total+=expanded;if(expanded>1024*1024||total>4*1024*1024)throw new Error('插件展开大小超限');
    names.add(name);sizes.set(name,expanded);cursor+=46+len+v.getUint16(cursor+30,true)+v.getUint16(cursor+32,true);
  }
  if(cursor!==end||!names.has('manifest.json')||!names.has('bundle.js'))throw new Error('须包含 manifest.json 和 bundle.js');
  const files=unzipSync(bytes,{filter:f=>f.name==='manifest.json'||f.name==='bundle.js'});
  for(const [name,data] of Object.entries(files))if(data.length!==sizes.get(name))throw new Error('ZIP 展开大小不一致');
  const raw=JSON.parse(strFromU8(files['manifest.json']));
  const checked=validateManifest(raw);if(!checked.ok||!checked.manifest)throw new Error(checked.issues.map(i=>`${i.path}: ${i.message}`).join('；'));
  const manifest=checked.manifest;
  const version=negotiateApiVersion(manifest.apiVersion);if(!version.ok)throw new Error(version.message);
  if(manifest.kind==='first-party'||manifest.kind==='declarative'||manifest.entry!=='bundle.js'||manifest.capabilities?.remoteCode)throw new Error('外部插件必须为本地 bundle.js，不得声明内置身份或加载远程代码');
  if(manifest.permissions?.auth?.providers?.length||manifest.permissions?.secrets||manifest.permissions?.fs==='sandbox'||manifest.permissions?.db?.raw||manifest.permissions?.background?.periodic||manifest.permissions?.background?.exact||manifest.permissions?.notify||manifest.permissions?.local||manifest.permissions?.llm?.local||manifest.permissions?.stream)throw new Error('此版本外部插件不支持会话凭证、文件导入、文件系统、原始数据库、通知、后台调度、模型或流式处理');
  const source=strFromU8(files['bundle.js']);if(!source.trim())throw new Error('插件代码为空');
  return {manifest,source};
}
