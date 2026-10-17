import type { PluginHost } from './plugin-host.ts';
import type { SecureStore } from '../platform/strategies/kv/types.ts';
import type { SandboxRuntime } from './sandbox-runtime.ts';
import type { ExternalPackage } from './external-package.ts';
import type {ExternalAccountRegistry} from './external-accounts.ts';

interface SavedPlugin extends ExternalPackage {enabled:boolean}
export class ExternalPlugins {
  private saved:SavedPlugin[]=[];
  private listeners=new Set<()=>void>();
  private busy=false;
  warnings:string[]=[];
  private host:PluginHost;private kv:SecureStore;private runtime:SandboxRuntime;private allowDomains:(domains:string[])=>void;
  private accounts?:ExternalAccountRegistry;
  constructor(host:PluginHost,kv:SecureStore,runtime:SandboxRuntime,allowDomains:(domains:string[])=>void,accounts?:ExternalAccountRegistry){this.host=host;this.kv=kv;this.runtime=runtime;this.allowDomains=allowDomains;this.accounts=accounts;}
  list(){return this.saved.map(p=>({...p,source:undefined,state:this.host.registry.get(p.manifest.id)?.state??'error'}));}
  subscribe(fn:()=>void){this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
  private changed(){for(const fn of this.listeners)fn();}
  private async persist(){await this.kv.set('external.plugins.v1',JSON.stringify(this.saved));this.refreshDomains();this.changed();}
  private refreshDomains(){this.allowDomains(this.saved.filter(p=>p.enabled).flatMap(p=>p.manifest.permissions?.net?.domains??[]));}
  async restore(){
    const raw=await this.kv.get('external.plugins.v1');
    if(raw)this.saved=JSON.parse(raw);
    for(const p of this.saved){
      try{await this.accounts?.configure(p.manifest,p.enabled);}catch(e){this.warnings.push(`${p.manifest.name} 账号恢复失败：${String(e)}`);continue;}
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
      await this.accounts?.configure(pkg.manifest,true);
      this.runtime.provide(pkg.manifest.id,pkg.source);
      const r=await this.host.install(pkg.manifest,{requested:pkg.manifest.permissions??{}});
      if(!r.ok){await this.host.uninstall(pkg.manifest.id);this.runtime.remove(pkg.manifest.id);await this.accounts?.clear(pkg.manifest.id);throw new Error(r.message);}
      this.saved.push({...pkg,enabled:true});
      try{await this.persist();}catch(e){this.saved.pop();await this.host.uninstall(pkg.manifest.id);this.runtime.remove(pkg.manifest.id);await this.accounts?.clear(pkg.manifest.id);throw e;}
    }finally{this.busy=false;}
  }
  async enable(id:string,enabled:boolean){
    if(this.busy)throw new Error('另一个插件操作正在进行');
    const p=this.saved.find(p=>p.manifest.id===id);if(!p)throw new Error('插件不存在');
    this.busy=true;
    const previous=p.enabled;
    try{await this.accounts?.configure(p.manifest,enabled);const r=enabled?await this.host.registry.activate(id):await this.host.registry.deactivate(id);if(!r.ok){await this.accounts?.configure(p.manifest,previous);throw new Error(r.message);}p.enabled=enabled;try{await this.persist();}catch(e){p.enabled=previous;await this.accounts?.configure(p.manifest,previous);if(previous)await this.host.registry.activate(id);else await this.host.registry.deactivate(id);throw e;}}finally{this.busy=false;}
  }
  async sync(id:string){if(this.busy)throw new Error('另一个插件操作正在进行');this.busy=true;try{const r=await this.host.sync(id,{trigger:'manual',now:Date.now()});if(!r.ok)throw new Error(r.message);if(r.data.errors.length)throw new Error(r.data.errors.join('；'));return `已读取 ${r.data.entities} 条数据`;}finally{this.busy=false;}}
  async accountState(id:string){return this.accounts?.state(id)??'当前平台不支持账号';}
  async login(id:string){
    if(this.busy)throw Error('另一个插件操作正在进行');
    const p=this.saved.find(p=>p.manifest.id===id);if(!p?.enabled||!p.manifest.contributes?.accounts?.length||!this.accounts)throw Error('插件账号未启用');
    this.busy=true;try{await this.accounts.login(p.manifest);}finally{this.busy=false;}
    return this.sync(id);
  }
  async logout(id:string){
    if(this.busy)throw Error('另一个插件操作正在进行');
    const p=this.saved.find(p=>p.manifest.id===id);if(!p||!this.accounts)throw Error('插件不存在');
    this.busy=true;try{await this.accounts.clear(id);await this.accounts.configure(p.manifest,p.enabled);this.changed();}finally{this.busy=false;}
  }
  async uninstall(id:string,keepData:boolean){
    if(this.busy)throw new Error('另一个插件操作正在进行');this.busy=true;
    const previous=this.saved;
    try{
      const item=this.saved.find(p=>p.manifest.id===id);
      if(item?.manifest.contributes?.accounts?.length)await this.accounts?.clear(id);
      this.saved=this.saved.filter(p=>p.manifest.id!==id);
      try{await this.persist();}catch(e){this.saved=previous;if(item)await this.accounts?.configure(item.manifest,item.enabled);this.refreshDomains();this.changed();throw e;}
      const r=await this.host.uninstall(id,{keepData});
      if(!r.ok){this.saved=previous;if(item)await this.accounts?.configure(item.manifest,item.enabled);await this.persist();throw new Error(r.message);}
      this.runtime.remove(id);this.changed();
    }finally{this.busy=false;}
  }
  async clear(){for(const p of [...this.saved])await this.uninstall(p.manifest.id,false);}
}
