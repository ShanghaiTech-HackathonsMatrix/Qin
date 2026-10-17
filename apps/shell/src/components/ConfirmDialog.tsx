import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
type Request={text:string;resolve:(answer:boolean)=>void};
const pending:Request[]=[];
let changed=()=>{};
/** 宿主统一确认弹层；所有取消路径都返回 false。 */
export function confirmAction(text:string):Promise<boolean>{
  return new Promise(resolve=>{pending.push({text,resolve});changed();});
}
export function ConfirmDialog(){
  const [,tick]=useState(0);const cancel=useRef<HTMLButtonElement>(null);
  const request=pending[0];
  const finish=(yes:boolean)=>{pending.shift()?.resolve(yes);tick(n=>n+1);};
  useEffect(()=>{changed=()=>tick(n=>n+1);return()=>{changed=()=>{};for(const r of pending.splice(0))r.resolve(false);};},[]);
  useEffect(()=>{if(!request)return;cancel.current?.focus();
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();finish(false);}
      if(e.key==='Tab'){e.preventDefault();const buttons=cancel.current?.parentElement?.querySelectorAll('button');const target=document.activeElement===buttons?.[0]?buttons?.[1]:buttons?.[0];target?.focus();}};
    const back=()=>finish(false);
    window.addEventListener('keydown',key);window.addEventListener('popstate',back);
    return()=>{window.removeEventListener('keydown',key);window.removeEventListener('popstate',back);};
  },[request]);
  return request?createPortal(<div className="sheet-backdrop confirm-backdrop" onClick={()=>finish(false)}><section className="sheet confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-text" onClick={e=>e.stopPropagation()}><h2 id="confirm-title">请确认</h2><p id="confirm-text">{request.text}</p><div className="sheet__actions"><button ref={cancel} className="btn" onClick={()=>finish(false)}>取消</button><button className="btn btn--primary" onClick={()=>finish(true)}>确认</button></div></section></div>,document.body):null;
}
