import {createConnector,type AcademicSnapshot} from '../plugins/builtin/academic/connectors.ts';
import {ENTRY,type Provider} from '../plugins/builtin/academic/model.ts';
import {widgetSnapshot,type WidgetData} from './widget-data.ts';
import {academicReminders} from './academic-reminders.ts';
import type {PlannedRequest,ParseResult} from '@matrix/plugin-api';
declare const MatrixBackground:{input():string;request(provider:string,request:string):string;finish(result:string):void};
/** 仅打包内置连接器，无 React、外部插件、SQLite 或远程脚本。 */
export async function syncProvider(provider:Provider,data:WidgetData,request:(r:PlannedRequest)=>Promise<{body:string;status:number;url:string;headers?:Record<string,string>}>,now:number):Promise<AcademicSnapshot>{
  const mod=createConnector(provider);
  let plan=await mod.plan!({trigger:'manual',now,settings:{semesterId:data.settings.semesterId,gradescopeTimezone:data.settings.gradescopeTimezone,
    previousSnapshot:JSON.stringify(data.snapshots.find(s=>s.provider===provider)??null),scanMode:'pending',
    ...(data.settings.selectedCourses[provider]?{selectedCourses:JSON.stringify(data.settings.selectedCourses[provider])}:{})}});
  let latest:AcademicSnapshot|undefined;
  let count=0;
  while(plan&&plan.requests.length){
    let last:ParseResult={},status=0,step='page';
    for(const req of plan.requests){
      if(++count>605)throw new Error('读取页数超限');
      let current=req,res;
      for(let redirects=0;redirects<6;redirects++){
        if(new URL(current.url).origin!==new URL(ENTRY[provider]).origin)throw new Error('LOGIN_REQUIRED');
        res=await request(current);
        if(res.status<300||res.status>=400)break;
        const location=res.headers?.location;
        if(!location||redirects===5)throw new Error('重定向失败');
        const url=new URL(location,current.url).href;
        current=res.status===303||((res.status===301||res.status===302)&&current.method==='POST')?{...current,url,method:'GET',body:undefined,headers:undefined}:{...current,url};
      }
      if(!res)throw new Error('页面无响应');
      if(new URL(res.url).origin!==new URL(ENTRY[provider]).origin)throw new Error('LOGIN_REQUIRED');
      const parsed=await mod.parsers![req.parse]({body:res.body,status:res.status,baseUrl:res.url});
      if(parsed.error)throw new Error(parsed.error);
      for(const e of parsed.entities??[])if(e.type==='academic_snapshot')latest=JSON.parse(String(e.data.json));
      last=parsed;status=res.status;step=req.parse;
    }
    const next=await mod.next?.({step,result:last,status});
    plan=next?{requests:next.requests}:{requests:[]};
  }
  if(!latest||!latest.courses.length)throw new Error('未读取到课程，保留旧数据');
  return latest;
}
async function run(){
  const input=JSON.parse(MatrixBackground.input()) as {data:WidgetData;providers:Provider[]};
  const statuses:Record<string,string>={};
  for(const provider of input.providers){
    if(input.data.enabled[provider]===false||!input.data.snapshots.some(s=>s.provider===provider))continue;
    try{
      const snapshot=await syncProvider(provider,input.data,async req=>{
        const result=JSON.parse(MatrixBackground.request(provider,JSON.stringify(req)));if(result.error)throw new Error(result.error);return result;
      },Date.now());
      input.data.snapshots=input.data.snapshots.filter(s=>s.provider!==provider).concat(snapshot);statuses[provider]='同步成功';
    }catch(e){statuses[provider]=String(e).includes('LOGIN_REQUIRED')?'需要重新登录':`同步失败：${String(e)}`;}
  }
  const now=Date.now();
  MatrixBackground.finish(JSON.stringify({data:input.data,snapshot:widgetSnapshot(input.data,now),statuses,reminders:academicReminders(input.data.snapshots,input.data.settings,input.data.corrections,input.data.enabled,now)}));
}
if(typeof MatrixBackground!=='undefined')void run().catch(e=>MatrixBackground.finish(JSON.stringify({error:String(e)})));
