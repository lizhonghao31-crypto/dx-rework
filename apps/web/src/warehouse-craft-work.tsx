import {useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Selector} from '@astryxdesign/core/Selector';
import {TextInput} from '@astryxdesign/core/TextInput';
import type {FactoryFlowSheet,WarehouseCraftWorkSheet} from '@dx-rework/contracts/factory-flow';
import {DigitalRequestError,digitalRequest} from './digital-production-api.js';
import {designerAstryxCss} from './designer-astryx.js';
import {createClientRequestId} from './client-request-id.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {useForegroundWait} from './foreground-loading.js';

export function WarehouseCraftWork({orderId,onClose}:{orderId:string;onClose:()=>void}){
 const path=`orders/${orderId}/factory-flow`,[model,setModel]=useState<WarehouseCraftWorkSheet|null>(null),[loading,setLoading]=useState(true),
  [selected,setSelected]=useState(''),[error,setError]=useState(''),[saved,setSaved]=useState(false),[unknown,setUnknown]=useState(false),[busy,setBusy]=useState(false);
 const [quantities,setQuantities]=useState<Record<string,string>>({}),[note,setNote]=useState('');
 const pending=useRef<{payload:Record<string,unknown>;key:string}|null>(null),writing=useRef(false);
 const load=useCallback(async(signal?:AbortSignal)=>{
  setLoading(true);setError('');
  try{const value=await digitalRequest<WarehouseCraftWorkSheet>(path+'/warehouse-craft','GET',undefined,undefined,signal?{signal}:undefined);
   if(signal?.aborted)return;
   if(value.orderId!==orderId||!Array.isArray(value.choices))throw Error('没有读到本单原工艺范围');
   setModel(value);setSelected(selected=>value.choices.some(choice=>choice.id===selected)?selected:'');
  }catch(reason){if(!signal?.aborted)setError(reason instanceof Error?reason.message:'原工艺收发读取失败');}
  finally{if(!signal?.aborted)setLoading(false);}
 },[path,orderId]);
 useEffect(()=>{const abort=new AbortController();void load(abort.signal);return()=>abort.abort();},[load]);
 useForegroundWait(loading&&!model?`warehouse-craft:${orderId}`:undefined);
 useDigitalDetailNavigationGuard(unknown,busy,writing,'原仓库收发回执尚未确认，仍要离开？');
 const choice=model?.choices.find(item=>item.id===selected);
 const submit=async(fields?:FormData)=>{
  if(writing.current)return;
  if(fields&&!unknown){
   if(!model||!choice)return;
   const raw=String(fields.get('occurredAt')??''),time=raw?new Date(`${raw}+08:00`):null;
   const lines=choice.lines.flatMap(row=>{const value=Number(quantities[row.lineId]??'');return value!==0?[{lineId:row.lineId,quantity:value,max:row.remaining}]:[];});
   if(!time||!Number.isFinite(time.getTime())||!lines.length||lines.some(row=>!Number.isSafeInteger(row.quantity)||row.quantity<1||row.quantity>row.max)){
    setError('请填写本次实际时间和各 PO 实际数量，不得超过本批余量。');return;
   }
   const payload={expectedRevision:model.revision,stepRef:choice.stepRef,kind:choice.kind==='send'?'工艺发出':'工艺回仓',
    ...(choice.kind==='send'&&choice.sourceFactId?{fromReturnId:choice.sourceFactId}:{}),...(choice.kind==='return'?{sendFactId:choice.sourceFactId}:{}),
    occurredAt:time.toISOString(),note,lines:lines.map(({lineId,quantity})=>({lineId,quantity})),
    warehouse:{taskId:choice.taskId,preparationId:model.preparationId,factoryId:choice.factoryId,...(choice.reworkId?{reworkId:choice.reworkId}:{})}};
   pending.current={payload,key:createClientRequestId()};
  }
  if(!pending.current)return;
  writing.current=true;setBusy(true);setSaved(false);setError('');
  try{
   const result=await digitalRequest<FactoryFlowSheet>(path+'/logistics','POST',pending.current.payload,pending.current.key);
   if(result.orderId!==orderId||result.preparationId!==model?.preparationId||result.revision<=Number(pending.current.payload.expectedRevision))throw new DigitalRequestError('原仓库收发结果待核对。',200,'INVALID_RESPONSE');
   pending.current=null;setUnknown(false);setSaved(true);setQuantities({});setNote('');await load();
  }catch(reason){setUnknown(!(reason instanceof DigitalRequestError)||reason.resultUnknown);setError(reason instanceof Error?reason.message:'原收发结果尚未确认。');}
  finally{writing.current=false;setBusy(false);}
 };
 return <div className="dx-designer-astryx" lang="zh-CN"><style>{designerAstryxCss}</style>
  <div className="pattern-actions"><Button type="button" label="返回来源" variant="secondary" isDisabled={busy} onClick={onClose}/>
   <Button type="button" label="重新读取原收发" variant="secondary" isDisabled={busy||loading||unknown} onClick={()=>void load()}/></div>
  <h2>仓库实际工艺收发</h2>{error&&<p role="alert">{error}</p>}{saved&&<p role="status">已保存原仓库收发记录。</p>}
  {unknown?<Button type="button" label="核对同一次原收发" isDisabled={busy} onClick={()=>void submit()}/>:model?<>
   {model.choices.length?<Selector label="实际办理工艺与批次" value={selected} isDisabled={busy||loading}
    options={model.choices.map(item=>({value:item.id,label:`${item.title} · ${item.reworkId?'原返工 · ':''}${item.kind==='send'?'发出':'回仓'} · ${item.factoryName} · ${item.lines.reduce((sum,line)=>sum+line.remaining,0)} 片`}))}
    onChange={value=>{if(selected===(value??''))return;setSelected(value??'');setQuantities({});setNote('');}}/>:<p>当前没有可办理的真实收发范围，请核对原工艺、检查和返工。</p>}
   {choice&&<form key={`${model.revision}:${choice.id}`} onSubmit={event=>{event.preventDefault();void submit(new FormData(event.currentTarget));}}>
    <fieldset disabled={busy||loading}><legend>{choice.kind==='send'?'登记本批实际发出':'登记本批实际回仓'}</legend><p>实际工厂 {choice.factoryName}</p>
     {choice.lines.map(row=><TextInput key={row.lineId} label={`${row.poNumber??'PO 待核'} · ${row.color} · 可办 ${row.remaining} 片`}
      inputMode="numeric" value={quantities[row.lineId]??''} onChange={value=>setQuantities(values=>({...values,[row.lineId]:value}))}/>)}
     <label>实际发生时间（北京时间）<input name="occurredAt" type="datetime-local" step="0.001" required/></label>
     <TextInput label="本次实际说明" value={note} onChange={setNote}/><Button type="submit" label="保存本批原收发"/>
    </fieldset>
   </form>}
  </>:null}
 </div>;
}
