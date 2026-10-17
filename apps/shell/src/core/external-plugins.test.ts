import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {zipSync,strToU8} from 'fflate';
import {readPluginPackage} from './external-package.ts';
import {SandboxRuntime} from './sandbox-runtime.ts';
import {ExternalPlugins} from './external-plugins.ts';
import {PluginHost} from './plugin-host.ts';
import {createCore,MockTransport} from './index.ts';
import {KvEntityBackend} from './kv-entity-backend.ts';
import {normalizePermissions,type Manifest} from '@matrix/plugin-api';
import {manifest as timelineManifest,timelinePlugin} from '../plugins/builtin/timeline/index.ts';
import type {SecureStore} from '../platform/strategies/kv/types.ts';
import {buildCatalog} from '../ui/catalog.ts';

const root=new URL('../../../../examples/plugins/hello-deadline/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8')) as Manifest;
const source=await readFile(new URL('bundle.js',root),'utf8');
const pack=(m:unknown=manifest,s=source,extra:Record<string,Uint8Array>={})=>zipSync({'manifest.json':strToU8(JSON.stringify(m)),'bundle.js':strToU8(s),...extra});
class MemoryKv implements SecureStore{
  encrypted=false;map=new Map<string,string>();fail=false;
  async get(k:string){return this.map.get(k)??null;}async set(k:string,v:string){if(this.fail&&k==='external.plugins.v1')throw Error('模拟存储失败');this.map.set(k,v);}async remove(k:string){this.map.delete(k);}async keys(){return [...this.map.keys()];}
}
async function setup(kv=new MemoryKv()){
  const runtime=new SandboxRuntime(),host=new PluginHost({externalRuntime:runtime,dataBackend:new KvEntityBackend(kv),core:createCore({transport:new MockTransport()}),modules:new Map([[timelineManifest.id,timelinePlugin]])});
  assert.ok((await host.install(timelineManifest,{allowReservedPrefix:true})).ok);
  const manager=new ExternalPlugins(host,kv,runtime,()=>{});await manager.restore();await host.restoreData();
  return {runtime,host,manager,kv};
}
test('MTP roundtrip；拒绝路径穿越、超展开、保留身份及未实现能力',()=>{
  assert.equal(readPluginPackage(pack()).source,source);
  assert.throws(()=>readPluginPackage(pack(manifest,source,{'../escape':strToU8('x')})),/路径/);
  assert.throws(()=>readPluginPackage(pack(manifest,'x'.repeat(1024*1024+1))),/大小超限/);
  assert.throws(()=>readPluginPackage(pack({...manifest,kind:'first-party'})),/内置/);
  assert.throws(()=>readPluginPackage(pack({...manifest,id:'app.matrix.fake'})));
  assert.throws(()=>readPluginPackage(pack({...manifest,apiVersion:'^9.0.0'})));
  assert.throws(()=>readPluginPackage(pack({...manifest,permissions:{notify:true}})),/不支持/);
  assert.throws(()=>readPluginPackage(pack({...manifest,permissions:{local:true}})),/不支持/);
  // 中央目录同名覆盖也必须拒绝。
  const duplicate=pack(manifest,source,{'manifest.jsox':strToU8('{}')});
  const needle=strToU8('manifest.jsox');for(let i=0;i<=duplicate.length-needle.length;i++)if(needle.every((b,j)=>duplicate[i+j]===b))duplicate[i+needle.length-1]='n'.charCodeAt(0);
  assert.throws(()=>readPluginPackage(duplicate),/重复/);
});
test('沙箱限制初始化/函数死循环、内存耗尽，宿主对象不可达',async()=>{
  const runtime=new SandboxRuntime();
  for(const code of ['while(true){}','globalThis.plugin={plan(){while(true){}}};','const a=[];while(true)a.push("x".repeat(100000));']){
    runtime.provide(manifest.id,code);const r=await runtime.load(manifest,normalizePermissions({}));
    if(r.ok){assert.throws(()=>r.data.exports.plan!({trigger:'manual',now:1}));await runtime.unload(manifest.id);}else assert.equal(r.code,'EINTERNAL');
  }
  runtime.provide(manifest.id,`globalThis.plugin={plan(){return {requests:[],summary:[typeof window,typeof document,typeof process,typeof require,typeof fetch,typeof Capacitor,typeof Date,typeof Promise].join(',')}}}`);
  const r=await runtime.load(manifest,normalizePermissions({}));assert.ok(r.ok);assert.equal(r.data.exports.plan!({trigger:'manual',now:1}).summary,Array(8).fill('undefined').join(','));await runtime.unload(manifest.id);
});
test('真实宿主：外部沙箱与内置共存，实体/槽/视图，停用、重启、卸载、重装',async()=>{
  const x=await setup();await x.manager.install(readPluginPackage(pack()));
  assert.match(await x.manager.sync(manifest.id),/1 条/);
  const rows=x.host.bus.read(manifest.id,'notice',{owner:manifest.id});assert.ok(rows.ok);assert.equal(rows.data.length,1);
  const slots=x.host.bus.read(timelineManifest.id,'slot_entry',{owner:timelineManifest.id});assert.ok(slots.ok);assert.equal(slots.data.length,1);
  const exports=x.host.registry.exportsOf(manifest.id)!;assert.ok(exports.renders?.summary);
  await x.manager.enable(manifest.id,false);assert.equal(x.host.registry.exportsOf(manifest.id),undefined);
  assert.equal(buildCatalog(x.host).entries.some(e=>e.pluginId===manifest.id),false,'停用插件不渲染控件');
  assert.equal(buildCatalog(x.host).issues.some(e=>e.includes(manifest.id)),false,'停用不误报实现缺失');
  const restarted=await setup(x.kv);assert.equal(restarted.manager.list()[0].enabled,false);
  await restarted.manager.enable(manifest.id,true);assert.match(await restarted.manager.sync(manifest.id),/1 条/);
  await restarted.manager.uninstall(manifest.id,true);
  assert.equal(restarted.host.readSlot('app.matrix.timeline.event').length,1,'保留数据也保留槽投影');
  await restarted.manager.install(readPluginPackage(pack()));
  await restarted.manager.uninstall(manifest.id,false);assert.equal(restarted.manager.list().length,0);
  assert.equal(restarted.host.readSlot('app.matrix.timeline.event').length,0,'删除数据不能留下日程幽灵条目');
  const afterDelete=await setup(x.kv);assert.equal(afterDelete.host.readSlot('app.matrix.timeline.event').length,0,'删除后的槽不能在重启时恢复');
  await restarted.manager.install(readPluginPackage(pack()));assert.match(await restarted.manager.sync(manifest.id),/1 条/);
  await restarted.manager.uninstall(manifest.id,false);await x.host.registry.deactivate(manifest.id);
});
test('外部插件管理持久化失败时回滚启停与卸载',async()=>{
  const x=await setup();await x.manager.install(readPluginPackage(pack()));x.kv.fail=true;
  await assert.rejects(x.manager.enable(manifest.id,false));assert.equal(x.host.registry.get(manifest.id)?.state,'active');assert.equal(x.manager.list()[0].enabled,true);
  await assert.rejects(x.manager.uninstall(manifest.id,false));assert.equal(x.manager.list().length,1);assert.equal(x.host.registry.get(manifest.id)?.state,'active');x.kv.fail=false;await x.manager.uninstall(manifest.id,false);
});
