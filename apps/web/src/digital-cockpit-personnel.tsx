import { SearchableSelect } from "./search-select.js";
import {useEffect,useId,useRef,useState} from "react";
import {Button} from "@dx-rework/ui";
import type {DigitalCustomer,DigitalOrder} from "@dx-rework/contracts/digital-production";
import type {DigitalAccessOptions} from "./digital-production-access-panel.js";
import {digitalRequest} from "./digital-production-api.js";
import {trapCockpitDialogFocus} from './cockpit-dialog-focus.js';
import {CustomerDefaultMerchandisers} from './customer-default-merchandisers.js';

type Candidate={id:string;displayName:string;roles:string[]};
type PersonnelDialog={kind:"customer";customers:DigitalCustomer[]}|{kind:"order";order:DigitalOrder};
type PersonnelProps={orderId:string|null;onChanged():void;showCustomer?:boolean;readOnly?:boolean};
export function DigitalCockpitPersonnel(props:PersonnelProps){
 if(props.orderId===null&&props.showCustomer!==false)return <CustomerDefaultMerchandisers readOnly={props.readOnly??false} onChanged={props.onChanged}/>;
 return <DigitalOrderPersonnel {...props}/>;
}
function DigitalOrderPersonnel({orderId,onChanged,showCustomer=true,readOnly=false}:PersonnelProps){
  const [customerFacts,setCustomerFacts]=useState<DigitalCustomer[]|null>(null);
  const [access,setAccess]=useState<DigitalAccessOptions|null>(null),[dialog,setDialog]=useState<PersonnelDialog|null>(null);
  const [people,setPeople]=useState<Candidate[]>([]),[customerCode,setCustomerCode]=useState(""),[personId,setPersonId]=useState("");
  const [busy,setBusy]=useState(false),[error,setError]=useState("");const writing=useRef(false),currentOrder=useRef(orderId);currentOrder.current=orderId;
  const modal=useRef<HTMLDialogElement>(null),fieldId=useId();
  useEffect(()=>{if(!dialog)return;const node=modal.current,prior=document.activeElement as HTMLElement|null;if(node&&!node.open)node.showModal();return()=>{node?.close();if(prior?.isConnected)prior.focus();};},[dialog]);
  useEffect(()=>{if(readOnly)return;let live=true;void digitalRequest<DigitalAccessOptions>("access/options").then(value=>{if(live)setAccess(value);}).catch(()=>undefined);return()=>{live=false;};},[readOnly]);
  useEffect(()=>{if(!readOnly||!showCustomer)return;let live=true;const controller=new AbortController();setCustomerFacts(null);setError('');
    void digitalRequest<{customers:DigitalCustomer[]}>('options','GET',undefined,undefined,{signal:controller.signal}).then(value=>{if(live)setCustomerFacts(value.customers);}).catch(reason=>{if(live&&reason.name!=='AbortError')setError(reason instanceof Error?reason.message:'读取客户默认跟单失败');});
    return()=>{live=false;controller.abort();};
  },[readOnly,showCustomer]);
  // A changed selection closes the old order's form instead of sending its version to a new mother.
  useEffect(()=>{setDialog(null);setError("");},[orderId]);
  const open=async(kind:"customer"|"order")=>{
    if(readOnly||writing.current)return;writing.current=true;setBusy(true);setError("");
    try{
      const current=await digitalRequest<DigitalAccessOptions>("access/options");setAccess(current);
      if(kind==="customer"&&!current.customers||kind==="order"&&(!current.manage||!orderId))throw new Error("当前岗位不能调整跟单");
      const candidates=await digitalRequest<Candidate[]>("access/candidates");setPeople(candidates.filter(person=>person.roles.includes("order_merchandiser")));
      if(kind==="customer"){
        const options=await digitalRequest<{customers:DigitalCustomer[]}>("options");
        const customer=options.customers[0];setCustomerCode(customer?.code??"");setPersonId(customer?.defaultMerchandiserId??"");setDialog({kind,customers:options.customers});
      }else if(orderId){const selected=orderId,order=await digitalRequest<DigitalOrder>(`orders/${selected}`);if(currentOrder.current!==selected)return;setPersonId(order.primaryMerchandiserId??"");setDialog({kind,order});}
    }catch(reason){setError(reason instanceof Error?reason.message:"读取失败");}finally{writing.current=false;setBusy(false);}
  };
  const save=async()=>{
    if(readOnly||!dialog||writing.current)return;writing.current=true;setBusy(true);setError("");
    try{
      if(personId&&!people.some(person=>person.id===personId))throw new Error("请选择在职有效订单跟单；原人员可能已失效");
      if(dialog.kind==="customer"){
        await digitalRequest(`customers/${encodeURIComponent(customerCode)}/default-merchandiser`,"PUT",{merchandiserId:personId||null});
      }else{
        if(!personId)throw new Error("请选择主跟单");
        await digitalRequest(`orders/${dialog.order.productionOrderId}/merchandiser`,"PUT",{merchandiserId:personId,expectedVersion:dialog.order.version});
      }
      setDialog(null);onChanged();
    }catch(reason){setError(reason instanceof Error?reason.message:"保存失败");}finally{writing.current=false;setBusy(false);}
  };
  const invalidPerson=personId&&!people.some(person=>person.id===personId);
  return <>{readOnly&&showCustomer&&(customerFacts?customerFacts.length?<dl>{customerFacts.map(customer=><div key={customer.code}><dt>{customer.code}{customer.name&&customer.name!==customer.code?` · ${customer.name}`:''}</dt><dd>{customer.defaultMerchandiserId?customer.defaultMerchandiserName||'已指定（姓名未读取）':'未指定'}</dd></div>)}</dl>:<p>暂无已启用客户。</p>:!error&&<p role="status">正在读取客户默认跟单…</p>)}
    {!readOnly&&showCustomer&&access?.customers&&<Button variant="secondary" disabled={busy} onClick={()=>void open("customer")}>客户跟单配置</Button>}
    {!readOnly&&access?.manage&&orderId&&<Button variant="secondary" disabled={busy} onClick={()=>void open("order")}>调整主跟单</Button>}
    {error&&!dialog&&<small role="alert">{error}</small>}
    {dialog&&<dialog ref={modal} className="cockpit-policy-dialog digital-personnel-dialog" aria-label={dialog.kind==="customer"?"客户跟单配置":"调整主跟单"} onKeyDown={trapCockpitDialogFocus} onCancel={event=>{event.preventDefault();if(!busy){setDialog(null);setError('');}}}>
      <header><h2>{dialog.kind==="customer"?"客户跟单配置":"调整主跟单"}</h2><Button variant="secondary" disabled={busy} onClick={()=>{setDialog(null);setError("");}}>关闭</Button></header>
      <p>{dialog.kind==="customer"?"仅影响以后创建的母单，已有订单与任务不变。":"交接未完成的主跟单任务与合同办理权，保留历史记录与原时钟。"}</p>
      {error&&<p role="alert">{error}</p>}
      <form onSubmit={event=>{event.preventDefault();void save();}}><fieldset disabled={busy||readOnly}>
        {dialog.kind==="customer"?<div className="digital-personnel-field"><label htmlFor={`${fieldId}-customer`}>客户 *</label><SearchableSelect id={`${fieldId}-customer`} required value={customerCode} onChange={event=>{setCustomerCode(event.target.value);setPersonId(dialog.customers.find(customer=>customer.code===event.target.value)?.defaultMerchandiserId??"");}}>{dialog.customers.map(customer=><option key={customer.code} value={customer.code}>{customer.code}{customer.name&&customer.name!==customer.code?` · ${customer.name}`:''}</option>)}</SearchableSelect></div>:<p>{dialog.order.designStyleNo} · 当前主跟单：{people.find(person=>person.id===dialog.order.primaryMerchandiserId)?.displayName??(dialog.order.primaryMerchandiserId?"原人员未在有效候选中":"待指派")}</p>}
        <div className="digital-personnel-field"><label htmlFor={`${fieldId}-person`}>主跟单{dialog.kind==="order" ? " *" : "（选填）"}</label><SearchableSelect id={`${fieldId}-person`} required={dialog.kind==="order"} value={personId} onChange={event=>setPersonId(event.target.value)}><option value="">{dialog.kind==="customer"?"未指定":"请选择"}</option>{invalidPerson&&<option value={personId} disabled>原人员已失效，请重新选择</option>}{people.map(person=><option key={person.id} value={person.id}>{person.displayName}</option>)}</SearchableSelect></div>
        <footer><Button type="button" variant="secondary" onClick={()=>{setDialog(null);setError('');}}>取消</Button><Button type="submit" disabled={Boolean(invalidPerson)||dialog.kind==="customer"&&!customerCode}>{busy?"保存中…":"保存"}</Button></footer>
      </fieldset></form>
    </dialog>}
  </>;
}
