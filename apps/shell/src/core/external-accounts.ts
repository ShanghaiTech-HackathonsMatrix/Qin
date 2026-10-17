import {Capacitor,registerPlugin} from '@capacitor/core';
import type {Manifest} from '@matrix/plugin-api';
import {CoreError,type Transport,type TransportRequest,type TransportResponse} from './types.ts';
interface AccountBridge {
  configure(input:{pluginId:string;account:string;enabled:boolean;methods:string[]}):Promise<void>;
  login(input:{pluginId:string}):Promise<{completed:boolean}>;
  clear(input:{pluginId:string}):Promise<void>;
  state(input:{pluginId:string}):Promise<{supported:boolean;status:string}>;
  request(input:{pluginId:string;url:string;method:string;headers:Record<string,string>;body?:string;timeout:number}):Promise<TransportResponse>;
}
export const ExternalAccounts=registerPlugin<AccountBridge>('ExternalAccounts');
export class ExternalAccountRegistry {
  private accounts=new Map<string,boolean>();
  async configure(manifest:Manifest,enabled:boolean){
    const account=manifest.contributes?.accounts?.[0];if(!account)return;
    // 在原生配置完成前不放行带凭证请求。
    this.accounts.set(manifest.id,false);
    if(Capacitor.getPlatform()==='android')await ExternalAccounts.configure({pluginId:manifest.id,account:JSON.stringify(account),enabled,methods:manifest.permissions?.net?.methods??['GET']});
    this.accounts.set(manifest.id,enabled);
  }
  sessionFor=(id:string)=>this.accounts.has(id)?`external:${id}`:undefined;
  async clear(id:string){if(!this.accounts.has(id))return;if(Capacitor.getPlatform()==='android')await ExternalAccounts.clear({pluginId:id});this.accounts.delete(id);}
  async login(manifest:Manifest){
    if(Capacitor.getPlatform()!=='android')throw Error('账号登录目前仅支持 Android');
    await this.configure(manifest,true);
    const result=await ExternalAccounts.login({pluginId:manifest.id});
    if(!result.completed)throw Error('已取消登录');
  }
  async state(id:string){return Capacitor.getPlatform()==='android'?(await ExternalAccounts.state({pluginId:id})).status:'账号登录目前仅支持 Android';}
  allowed(id:string){return this.accounts.get(id)===true;}
}
export class ExternalAccountTransport implements Transport {
  readonly kind='isolated-external-accounts';
  private fallback:Transport;private accounts:ExternalAccountRegistry;
  constructor(fallback:Transport,accounts:ExternalAccountRegistry){this.fallback=fallback;this.accounts=accounts;}
  async request(req:TransportRequest):Promise<TransportResponse>{
    if(!req.session?.startsWith('external:'))return this.fallback.request(req);
    const pluginId=req.session.slice(9);
    if(!this.accounts.allowed(pluginId)||Capacitor.getPlatform()!=='android')throw new CoreError('EAUTH','外部账号未启用或当前平台不支持');
    try{return await ExternalAccounts.request({pluginId,url:req.url,method:req.method,headers:req.headers,body:req.body,timeout:req.readTimeoutMs});}
    catch(e){throw new CoreError('EAUTH',e instanceof Error?e.message:'外部账号请求失败');}
  }
}
