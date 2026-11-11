import {useEffect,useRef,useState} from 'react';
import {CustomerMerchandisersSaveSchema,type CustomerMerchandiserDefault,type CustomerMerchandisersPage,type CustomerMerchandisersSave} from '@dx-rework/contracts/digital-customer-merchandisers';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';
import {trapCockpitDialogFocus} from './cockpit-dialog-focus.js';
import {SearchableSelect} from './search-select.js';
type Person={id:string;displayName:string;roles:string[]};
type Pending={body:CustomerMerchandisersSave;key:string};
export function CustomerDefaultMerchandisers({readOnly=false,onChanged}:{readOnly?:boolean;onChanged():void}){
 const [page,setPage]=useState<CustomerMerchandisersPage|null>(null),[pageNumber,setPageNumber]=useState(1),[q,setQ]=useState(''),[selection,setSelection]=useState<Record<string,CustomerMerchandiserDefault>>({}),[people,setPeople]=useState<Person[]>([]);
 const [targets,setTargets]=useState<CustomerMerchandiserDefault[]>([]),[open,setOpen]=useState(false),[primary,setPrimary]=useState(''),[secondary,setSecondary]=useState<string[]>([]),[mode,setMode]=useState<'append'|'replace'>('replace');
 const [busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[conflict,setConflict]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const modal=useRef<HTMLDialogElement|null>(null),active=useRef(false),live=useRef(true),readGeneration=useRef(0),pending=useRef<Pending|null>(null);
 const endpoint='customers/default-merchandisers',checked=Object.values(selection),disabled=busy||uncertain;
 const read=async(nextPage=pageNumber,search=q)=>{const generation=++readGeneration.current;const next=await digitalRequest<CustomerMerchandisersPage>(endpoint+'?page='+nextPage+'&q='+encodeURIComponent(search),'GET',undefined,undefined);if(live.current&&generation===readGeneration.current){setPage(next);setPageNumber(next.page);}};
 useEffect(()=>{live.current=true;return()=>{live.current=false;readGeneration.current++;};},[]);
 useEffect(()=>{setError('');const timer=setTimeout(()=>{void read(1,q).catch(reason=>{if(live.current)setError(reason.message);});},200);return()=>clearTimeout(timer);},[q]);
 useEffect(()=>{if(!open)return;const dialog=modal.current,prior=document.activeElement as HTMLElement|null;if(dialog&&!dialog.open)dialog.showModal();return()=>{dialog?.close();if(prior?.isConnected)prior.focus();};},[open]);
 const choose=async(items:CustomerMerchandiserDefault[])=>{
  if(readOnly||active.current||!items.length||uncertain)return;active.current=true;setBusy(true);setError('');setNotice('');
  try{const candidates=await digitalRequest<Person[]>('access/candidates');if(!live.current)return;setPeople(candidates.filter(p=>p.roles.includes('order_merchandiser')));
   setTargets(items);setPrimary(items.every(p=>p.primary?.id===items[0]?.primary?.id)?items[0]?.primary?.id??'':'');setSecondary(items.length===1?items[0]!.secondary.map(p=>p.id):[]);setMode(items.length===1?'replace':'append');setConflict(false);setOpen(true);
  }catch(reason){if(live.current)setError((reason as Error).message);}finally{active.current=false;if(live.current)setBusy(false);}
 };
 const payload={customers:targets.map(t=>({code:t.code,expectedVersion:t.version})),primaryMerchandiserId:primary,secondaryMerchandiserIds:secondary.filter(Boolean),mode};
 const validation=CustomerMerchandisersSaveSchema.safeParse(payload);
 const invalidPerson=[primary,...secondary.filter(Boolean)].some(id=>id&&!people.some(p=>p.id===id));
 const save=async()=>{
  if(readOnly||active.current)return;const operation=pending.current??(validation.success?{body:validation.data,key:createClientRequestId()}:null);if(!operation)return;
  active.current=true;pending.current=operation;setBusy(true);setError('');setNotice('');
  try{const result=await digitalRequest<{items:CustomerMerchandiserDefault[];existingOrdersChanged:number;changedCustomerCount:number}>(endpoint,'POST',operation.body,operation.key);
   if(result.existingOrdersChanged!==0||!Array.isArray(result.items)||result.items.length!==operation.body.customers.length)throw new DigitalRequestError('保存回执不完整，请核对上次保存结果',null);
   pending.current=null;setUncertain(false);setConflict(false);if(!live.current)return;
   setSelection(before=>Object.fromEntries(Object.entries(before).map(([code,old])=>[code,result.items.find(row=>row.code===code)??old])));setTargets(result.items);setOpen(false);setNotice('已保存'+result.changedCustomerCount+'个客户的默认跟单，已有订单不变。');onChanged();
   try{await read();}catch{if(live.current)setError('保存已成功，列表刷新失败。请刷新，不要重复保存。');}
  }catch(reason){if(live.current)setError((reason as Error).message);if(reason instanceof DigitalRequestError&&reason.resultUnknown)setUncertain(true);else{pending.current=null;setUncertain(false);if(reason instanceof DigitalRequestError&&reason.status===409)setConflict(true);}}
  finally{active.current=false;if(live.current)setBusy(false);}
 };
 const reloadTargets=async()=>{if(active.current||uncertain)return;active.current=true;setBusy(true);setError('');try{
  const next=await digitalRequest<{items:CustomerMerchandiserDefault[]}>(endpoint+'/selected','POST',{codes:targets.map(t=>t.code)});if(!live.current)return;
  if(next.items.length!==targets.length)throw Error('有客户已不可用，本次填写已保留，请重新选择客户');setTargets(next.items);setConflict(false);setNotice('已读取所选客户的最新安排，请核对后保存。');
 }catch(reason){if(live.current)setError((reason as Error).message);}finally{active.current=false;if(live.current)setBusy(false);}};
 const name=(id:string)=>people.find(p=>p.id===id)?.displayName??targets.flatMap(t=>[...(t.primary?[t.primary]:[]),...t.secondary]).find(p=>p.id===id)?.name??'原人员已失效';
 const close=()=>{if(!busy){setOpen(false);if(!uncertain)setError('');}};
 return <section className="r5-customer-defaults" aria-label="客户默认跟单">
  <header><div><h2>客户默认跟单</h2><p>设置客户的新订单默认跟单人</p></div>{!readOnly&&<button className="r5-button r5-primary" disabled={disabled||!checked.length} onClick={()=>void choose(checked)}>批量设置</button>}</header>
  <div className="r5-customer-tools"><input type="search" aria-label="搜索客户" placeholder="搜索客户名称" value={q} onChange={e=>setQ(e.target.value)}/><button className="r5-link" disabled={disabled} onClick={()=>void read().catch(e=>setError(e.message))}>刷新</button></div>
  <div className="r5-selection-summary">已选择{checked.length}个客户{checked.length>0&&<button className="r5-link" disabled={disabled} onClick={()=>setSelection({})}>清空</button>}</div>
  {!open&&error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {uncertain&&!open&&<p role="status">上次保存结果待核对，填写内容已保留。<button className="r5-button" onClick={()=>setOpen(true)}>核对上次保存结果</button></p>}
  <div className="r5-node-list r5-table-scroll">{page?<table><thead><tr>{!readOnly&&<th><input type="checkbox" aria-label="选择本页客户" disabled={disabled||!page.items.length} checked={page.items.length>0&&page.items.every(t=>!!selection[t.code])} onChange={e=>setSelection(before=>{const next={...before};for(const t of page.items)if(e.target.checked)next[t.code]=t;else delete next[t.code];return next;})}/></th>}<th>客户</th><th>主跟单</th><th>副跟单</th>{!readOnly&&<th>操作</th>}</tr></thead><tbody>{page.items.map(customer=><tr key={customer.code} className={selection[customer.code]?'is-selected':''}>{!readOnly&&<td><input type="checkbox" aria-label={'选择客户'+customer.code} disabled={disabled} checked={!!selection[customer.code]} onChange={e=>setSelection(before=>{const next={...before};if(e.target.checked)next[customer.code]=customer;else delete next[customer.code];return next;})}/></td>}<th>{customer.code}<small>{customer.name===customer.code?'':customer.name}</small></th><td>{customer.primary?.name??(customer.primary?'姓名待读取':'未设置')}</td><td>{customer.secondary.length?customer.secondary.map(p=>p.name??'姓名待读取').join('、'):'未设置'}</td>{!readOnly&&<td><button className="r5-link" disabled={disabled} onClick={()=>void choose([customer])}>设置</button></td>}</tr>)}</tbody></table>:<p role="status">正在读取客户…</p>}</div>
  {page&&<div className="r5-pagination"><span>共{page.totalCount}个客户</span><button disabled={disabled||page.page===1} onClick={()=>void read(page.page-1).catch(e=>setError(e.message))}>上一页</button><span>第{page.page}页</span><button disabled={disabled||page.page*15>=page.totalCount} onClick={()=>void read(page.page+1).catch(e=>setError(e.message))}>下一页</button></div>}
  <footer className="r5-customer-footer">仅影响新订单，已有订单不变。</footer>
  {open&&<dialog ref={modal} className="r5-customer-dialog" aria-label={targets.length>1?'批量设置默认跟单':'设置默认跟单'} onKeyDown={trapCockpitDialogFocus} onCancel={e=>{e.preventDefault();close();}}><header><h2>{targets.length>1?'批量设置默认跟单':'设置默认跟单'}</h2><button className="r5-dialog-close" aria-label="关闭" disabled={busy} onClick={close}>×</button></header><div className="r5-selected-customers">已选择{targets.length}个客户</div>
   <form onSubmit={e=>{e.preventDefault();void save();}}>{error&&<p role="alert">{error}</p>}{conflict&&<p role="alert">本次填写已保留，请核对所选客户的新安排。<button type="button" className="r5-link" disabled={disabled} onClick={()=>void reloadTargets()}>核对最新安排</button></p>}
    {uncertain&&<p role="status">上次保存结果待核对。<button type="button" className="r5-button r5-primary" disabled={busy} onClick={()=>void save()}>核对上次保存结果</button></p>}
    <fieldset disabled={disabled}><div className="r5-customer-assignment"><label htmlFor="r5-default-primary">主跟单 <em>*</em></label><SearchableSelect id="r5-default-primary" aria-label="主跟单" required value={primary} onChange={e=>setPrimary(e.target.value)}><option value="">请选择</option>{primary&&!people.some(p=>p.id===primary)&&<option value={primary} disabled>{name(primary)}</option>}{people.map(p=><option key={p.id} value={p.id}>{p.displayName}</option>)}</SearchableSelect>
     <span>副跟单（选填）</span><div className="r5-secondary-rows">{secondary.map((id,index)=><div key={index}><SearchableSelect aria-label={'副跟单'+(index+1)} value={id} onChange={e=>setSecondary(before=>before.map((old,i)=>i===index?e.target.value:old))}><option value="">请选择</option>{id&&!people.some(p=>p.id===id)&&<option value={id} disabled>{name(id)}</option>}{people.map(p=><option key={p.id} value={p.id} disabled={p.id===primary||secondary.some((s,i)=>i!==index&&s===p.id)}>{p.displayName}</option>)}</SearchableSelect><button type="button" className="r5-link r5-danger" aria-label={'移除副跟单'+(index+1)} onClick={()=>setSecondary(before=>before.filter((_,i)=>i!==index))}>移除</button></div>)}<button type="button" className="r5-add-secondary" onClick={()=>setSecondary(before=>[...before,''])}>＋ 新增副跟单</button><small>从已有人员中选择，可添加多人</small></div>
     {targets.length>1&&<><label htmlFor="r5-default-mode">副跟单处理</label><select id="r5-default-mode" value={mode} onChange={e=>setMode(e.target.value as 'append'|'replace')}><option value="append">追加，保留原副跟单</option><option value="replace">替换为本次选择</option></select></>}
    </div>{targets.length>1&&<p>主跟单统一设为本次选择；副跟单{mode==='append'?'追加到原安排':'替换为本次选择'}。</p>}
    {!validation.success&&primary&&<p role="alert">{validation.error.issues[0]?.message}</p>}{invalidPerson&&<p role="alert">原人员已失效，请重新选择当前有效人员。</p>}
    <p className="r5-assignment-note">保存后，仅新订单使用此设置，已有订单不变。</p></fieldset><footer><button type="button" className="r5-button" disabled={busy} onClick={close}>{uncertain?'关闭':'取消'}</button><button type="submit" className="r5-button r5-primary" disabled={disabled||conflict||invalidPerson||!validation.success}>{busy?'正在保存…':'保存设置'}</button></footer>
   </form></dialog>}
 </section>;
}
