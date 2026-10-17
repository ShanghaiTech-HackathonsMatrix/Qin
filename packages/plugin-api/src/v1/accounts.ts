/** 宿主管理的单账号网页登录声明。插件仅提供元数据，不接触 Cookie 或密码。 */
export interface AccountContribution {
  id:string;
  title:string;
  loginUrl:string;
  authOrigins:string[];
  dataOrigins:string[];
}
export function validateAccounts(raw:unknown,providers:unknown,domains:unknown,add:(path:string,message:string)=>void):void {
  if(raw===undefined){if(Array.isArray(providers)&&providers.length)add('contributes.accounts','使用认证须声明账号');return;}
  if(!Array.isArray(raw)||raw.length>1){add('contributes.accounts','首版最多声明一个账号');return;}
  const ids:string[]=[];
  for(const [i,value] of raw.entries()){
    const at=`contributes.accounts[${i}]`;
    if(!value||typeof value!=='object'||Array.isArray(value)){add(at,'账号必须是对象');continue;}
    const a=value as Record<string,unknown>;
    if(typeof a.id!=='string'||!(/^[a-z][a-z0-9_-]{0,63}$/).test(a.id))add(`${at}.id`,'账号 id 格式无效');else ids.push(a.id);
    if(typeof a.title!=='string'||!a.title.trim())add(`${at}.title`,'须填写账号名称');
    const origins=(key:string)=>{
      const items=a[key];if(!Array.isArray(items)||!items.length||items.length>8){add(`${at}.${key}`,'须填写 1–8 个精确 HTTPS origin');return [] as string[];}
      return items.filter((s):s is string=>{try{const u=new URL(String(s));if(typeof s!=='string'||u.origin!==s||u.protocol!=='https:'||u.username||u.password||!u.hostname.includes('.')||/[\[\]*]/.test(u.hostname)||/^\d+(\.\d+){3}$/.test(u.hostname))throw Error();return true;}catch{add(`${at}.${key}`,'须为精确 HTTPS 域名 origin（可带端口，不含路径）');return false;}});
    };
    const auth=origins('authOrigins'),data=origins('dataOrigins');
    try{const u=new URL(String(a.loginUrl));if(u.protocol!=='https:'||u.username||u.password||!auth.includes(u.origin))throw Error();}catch{add(`${at}.loginUrl`,'登录页须位于 authOrigins');}
    for(const origin of data)if(!Array.isArray(domains)||!domains.includes(new URL(origin).hostname))add(`${at}.dataOrigins`,'数据站点须同时精确声明在 net.domains');
  }
  if(!Array.isArray(providers)||providers.length!==ids.length||ids.some(id=>!providers.includes(id)))add('permissions.auth.providers','须与声明的账号 id 完全一致');
}
