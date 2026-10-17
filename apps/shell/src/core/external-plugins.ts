import type { PluginHost } from './plugin-host.ts';
import type { SecureStore } from '../platform/strategies/kv/types.ts';
import type { SandboxRuntime } from './sandbox-runtime.ts';
import type { ExternalPackage } from './external-package.ts';

interface SavedPlugin extends ExternalPackage {enabled:boolean}
export class ExternalPlugins {
  private saved:SavedPlugin[]=[];
  private listeners=new Set<()=>void>();
  private busy=false;
  warnings:string[]=[];
  private host:PluginHost;private kv:SecureStore;private runtime:SandboxRuntime;private allowDomains:(domains:string[])=>void;
  constructor(host:PluginHost,kv:SecureStore,runtime:SandboxRuntime,allowDomains:(domains:string[])=>void){Object.assign(this,{host,kv,runtime,allowDomains});this.host=host;this.kv=kv;this.runtime=runtime;this.allowDomains=allowDomains;}
  list(){return this.saved.map(p=>({...p,source:undefined,state:this.host.registry.get(p.manifest.id)?.state??'error'}));}
  subscribe(fn:()=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
  private changed(){for(const fn of this.listeners)fn();}
  private async persist(){await this.kv.set('external.plugins.v1',JSON.stringify(this.saved));this.refreshDomains();this.changed();}
  private refreshDomains(){this.allowDomains(this.saved.filter(p=>p.enabled).flatMap(p=>p.manifest.permissions?.net?.domains??[]));}
  async restore(){
    const raw=await this.kv.get('external.plugins.v1');
    if(raw)this.saved=JSON.parse(raw);
    for(const p of this.saved){
      this.runtime.provide(p.manifest.id,p.source);
      const r=await this.host.install(p.manifest,{requested:p.manifest.permissions??{},activate:false});
      if(!r.ok){this.warnings.push(`${p.manifest.name}：${r.message}`);continue;}
      if(p.enabled){const a=await this.host.registry.activate(p.manifest.id);if(!a.ok)this.warnings.push(`${p.manifest.name}：${a.message}`);}
    }
    this.refreshDomains();
  }
  async install(pkg:ExternalPackage){
    if(this.busy)throw new Error('另一个插件操作正在进行');
    if(this.saved.length>=8)throw new Error('最多安装 8 个外部插件');
    if(this.host.registry.get(pkg.manifest.id)?.state && this.host.registry.get(pkg.manifest.id)?.state!=='uninstalled')throw new Error('同名插件已存在；请先卸载旧版本');
    this.busy=true;
    try{
      this.runtime.provide(pkg.manifest.id,pkg.source);
      const r=await this.host.install(pkg.manifest,{requested:pkg.manifest.permissions??{}});
      if(!r.ok){await this.host.uninstall(pkg.manifest.id);this.runtime.remove(pkg.manifest.id);throw new Error(r.message);}
      this.saved.push({...pkg,enabled:true});
      try{await this.persist();}catch(e){this.saved.pop();await this.host.uninstall(pkg.manifest.id);this.runtime.remove(pkg.manifest.id);throw e;}
    }finally{this.busy=false;}
  }
  async enable(id:string,enabled:boolean){
    if(this.busy)throw new Error('另一个插件操作正在进行');
    const p=this.saved.find(p=>p.manifest.id===id);if(!p)throw new Error('插件不存在');
    this.busy=true;
    const previous=p.enabled;
    try{const r=enabled?await this.host.registry.activate(id):await this.host.registry.deactivate(id);if(!r.ok)throw new Error(r.message);p.enabled=enabled;try{await this.persist();}catch(e){p.enabled=previous;if(previous)await this.host.registry.activate(id);else await this.host.registry.deactivate(id);throw e;}}finally{this.busy=false;}
  }
  async sync(id:string){if(this.busy)throw new Error('另一个插件操作正在进行');this.busy=true;try{const r=await this.host.sync(id,{trigger:'manual',now:Date.now()});if(!r.ok)throw new Error(r.message);if(r.data.errors.length)throw new Error(r.data.errors.join('；'));return `已读取 ${r.data.entities} 条数据`;}finally{this.busy=false;}}
  async uninstall(id:string,keepData:boolean){
    if(this.busy)throw new Error('另一个插件操作正在进行');this.busy=true;
    const previous=this.saved;
    try{
      this.saved=this.saved.filter(p=>p.manifest.id!==id);
      try{await this.persist();}catch(e){this.saved=previous;this.refreshDomains();this.changed();throw e;}
      const r=await this.host.uninstall(id,{keepData});
      if(!r.ok){this.saved=previous;await this.persist();throw new Error(r.message);}
      this.runtime.remove(id);this.changed();
    }finally{this.busy=false;}
  }
  async clear(){for(const p of [...this.saved])await this.uninstall(p.manifest.id,false);}
}
