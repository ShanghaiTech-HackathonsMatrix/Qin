import { newQuickJSWASMModule, type QuickJSWASMModule } from 'quickjs-emscripten';
import { fail,ok,type Manifest,type GrantedPermissions,type PluginExports,type PluginResult } from '@matrix/plugin-api';
import type { LoadedPlugin,PluginRuntime } from '@matrix/kernel';

/** 每插件独立 WASM 实例；VM 只接收 JSON，没有宿主引用或网络桥。 */
export class SandboxRuntime implements PluginRuntime {
  private sources=new Map<string,string>();
  private disposers=new Map<string,()=>void>();
  private factory:()=>Promise<QuickJSWASMModule>;
  constructor(factory:()=>Promise<QuickJSWASMModule>=()=>newQuickJSWASMModule()){this.factory=factory;}
  provide(id:string,source:string){this.sources.set(id,source);}
  remove(id:string){this.sources.delete(id);}
  async unload(id:string){this.disposers.get(id)?.();this.disposers.delete(id);}
  async load(manifest:Manifest,_granted:GrantedPermissions):Promise<PluginResult<LoadedPlugin>> {
    await this.unload(manifest.id);
    const source=this.sources.get(manifest.id);if(!source)return fail('ENOTFOUND','插件代码不存在');
    let dispose:undefined|(()=>void);
    try{
      const module=await this.factory(),runtime=module.newRuntime();
      runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(256*1024);
      let deadline=0;runtime.setInterruptHandler(()=>Date.now()>deadline);
      const context=runtime.newContext();let disposed=false;
      dispose=()=>{if(!disposed){disposed=true;context.dispose();runtime.dispose();}};
      const evaluate=(code:string)=>{
        if(disposed)throw new Error('插件已停用');
        deadline=Date.now()+200;
        const result=context.evalCode(code,'plugin.js');
        if(result.error){result.error.dispose();throw new Error('插件执行失败或超过时间/内存限制');}
        try{const text=context.getString(result.value);if(text.length>2*1024*1024)throw new Error('插件输出超限');return text;}finally{result.value.dispose();}
      };
      // JSON 桥在插件执行前捕获原生函数；VM 中不存在宿主对象引用。
      evaluate(`(()=>{const parse=JSON.parse,stringify=JSON.stringify,keys=Object.keys;
        Object.defineProperty(globalThis,'__qinBridge',{value:Object.freeze({
          shape:p=>stringify(Object.fromEntries(['plan','next','onActivate','onSuspend','onDeactivate','parsers','renders','commands','slotValidators'].map(k=>[k,typeof p[k]==='function'?true:p[k]&&typeof p[k]==='object'?keys(p[k]).filter(n=>typeof p[k][n]==='function'):null]))),
          call:(p,path,payload)=>{let fn=p;for(const k of parse(path))fn=fn[k];const out=fn(...parse(payload));if(out&&typeof out.then==='function')throw Error('插件函数必须同步');return stringify(out===undefined?null:out);}
        }),writable:false,configurable:false});})();
        globalThis.fetch=undefined;globalThis.XMLHttpRequest=undefined;globalThis.WebSocket=undefined;globalThis.Promise=undefined;globalThis.Date=undefined;globalThis.SharedArrayBuffer=undefined;globalThis.Atomics=undefined;Math.random=()=>{throw Error('请使用宿主提供的数据')};globalThis.eval=undefined;globalThis.Function=undefined;''`);
      evaluate(`${source}\n;''`);
      evaluate(`if(!globalThis.plugin||typeof globalThis.plugin!=='object')throw Error('缺少 globalThis.plugin');''`);
      const json=evaluate(`__qinBridge.shape(plugin)`);
      const shape=JSON.parse(json) as Record<string,true|string[]|null>;
      for(const view of manifest.contributes?.views??[])if(!Array.isArray(shape.renders)||!shape.renders.includes(view.id))throw new Error(`视图 ${view.id} 缺少 renders 函数，无法启用插件`);
      const invoke=(path:string[],args:unknown[])=>{
        const payload=JSON.stringify(args);if(payload.length>6*1024*1024)throw new Error('插件输入超限');
        const result=evaluate(`__qinBridge.call(plugin,${JSON.stringify(JSON.stringify(path))},${JSON.stringify(payload)})`);
        return JSON.parse(result);
      };
      const exports:Record<string,unknown>={};
      for(const key of ['plan','next','onActivate','onSuspend','onDeactivate','parsers','renders','commands','slotValidators']){const value=shape[key];if(value===true&&['plan','next','onActivate','onSuspend','onDeactivate'].includes(key))exports[key]=(...args:unknown[])=>invoke([key],args);else if(Array.isArray(value)&&value.length<=100&&['parsers','renders','commands','slotValidators'].includes(key))exports[key]=Object.fromEntries(value.filter(name=>typeof name==='string'&&name.length<=100&&!['__proto__','constructor','prototype'].includes(name)).map(name=>[name,(...args:unknown[])=>invoke([key,name],args)]));}
      this.disposers.set(manifest.id,dispose);
      return ok({exports:exports as PluginExports,kind:manifest.kind});
    }catch(e){dispose?.();return fail('EINTERNAL',e instanceof Error?e.message:'沙箱加载失败');}
  }
}
