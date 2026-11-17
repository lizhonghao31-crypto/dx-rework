import {useEffect,useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import {BulkWashingCommandSchema,bulkWashingLabels,type BulkWashingSheet,type BulkWashingScopeView,type BulkWashingCommand} from '@dx-rework/contracts/bulk-washing';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {washingActionRecords,washingFactLabel,type WashingAction} from './bulk-washing-actions.js';
import {createWebUrls} from '../url-contract.js';
import {productionWorkspaceDomainHref} from './digital-detail-route.js';
const display=(at:string|null)=>at?new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'时间待核';
const time=(value:FormDataEntryValue|null)=>value?new Date(`${String(value)}+08:00`).toISOString():null;
export function BulkWashingPanel({orderId,initialOpen=false}:{orderId:string;initialOpen?:boolean}){
 const [open,setOpen]=useState(initialOpen),[sheet,setSheet]=useState<BulkWashingSheet|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 const readSequence=useRef(0);
 const visible=sheet?.orderId===orderId?sheet:null;
 const reload=async()=>{const sequence=++readSequence.current;setLoading(true);setError('');try{const value=await digitalRequest<BulkWashingSheet>(`orders/${orderId}/bulk-washing`);
  if(value.orderId!==orderId||!Array.isArray(value.scopes))throw Error('洗水资料回执不完整');if(sequence===readSequence.current)setSheet(value);
 }catch(e){if(sequence===readSequence.current){if(e instanceof DigitalRequestError&&[401,403,404].includes(e.status??0))setSheet(null);setError(e instanceof Error?e.message:'洗水资料读取失败');}throw e;}finally{if(sequence===readSequence.current)setLoading(false);}};
 useEffect(()=>{setSheet(null);setOpen(initialOpen);setError('');setLoading(false);if(initialOpen)void reload().catch(()=>undefined);return()=>{readSequence.current++;};},[orderId,initialOpen]);
 return <section id="factory-washing"><Button aria-expanded={open} onClick={()=>{setOpen(!open);if(!open&&!visible)void reload().catch(()=>undefined);}}>大货洗水</Button>
 {open&&<>{error&&<p role="alert">{error}</p>}{loading&&<p role="status">正在读取洗水记录…</p>}
 {!loading&&<Button onClick={()=>void reload().catch(()=>undefined)}>刷新洗水记录</Button>}
 {visible?.scopes.length===0&&<p>本单当前没有可办理的洗水批次。</p>}
 {visible?.scopes.map(scope=><WashingScope key={`${orderId}:${scope.scopeId}`} orderId={orderId} scope={scope} reload={reload}/>)}</>}</section>;
}
function WashingScope({orderId,scope,reload}:{orderId:string;scope:BulkWashingScopeView;reload:()=>Promise<void>}){
 const [kind,setKind]=useState<WashingAction>(scope.canLogistics?scope.mode==='factory'?'factory_start':'send':scope.canInspect?'inspection':'void');
 const [parentId,setParentId]=useState('');
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[dirty,setDirty]=useState(false);
 const writing=useRef(false),pending=useRef<{body:BulkWashingCommand;key:string}|null>(null);
 useDigitalDetailNavigationGuard(uncertain||dirty,busy,writing,'洗水记录尚未保存或回执未确认，离开不会撤销已发送内容。仍要离开？');
 const send=async(body?:BulkWashingCommand)=>{
  if(writing.current||uncertain&&body)return;
  if(body)pending.current={body,key:createClientRequestId()};const attempt=pending.current;if(!attempt)return;
  writing.current=true;setBusy(true);setError('');let confirmed=false;
  try{const result=await digitalRequest<{eventId:string;scopeId:string;revision:number}>(`orders/${orderId}/bulk-washing`,'POST',attempt.body,attempt.key);
   if(!result.eventId||result.scopeId!==scope.scopeId||result.revision!==attempt.body.expectedRevision+1)throw Error('洗水提交回执不完整');
   confirmed=true;pending.current=null;setUncertain(false);setDirty(false);await reload();
  }catch(e){setUncertain(!confirmed&&(!(e instanceof DigitalRequestError)||e.resultUnknown));setError((confirmed?'记录已保存，重新读取失败：':'')+(e instanceof Error?e.message:'提交失败'));}
  finally{writing.current=false;setBusy(false);}
  return confirmed;
 };
 const candidates=washingActionRecords(scope,kind),selected=candidates.find(record=>record.id===parentId);
 const plannedRewash=(scope.rewashPlans??[]).filter(plan=>plan.inspectionId===parentId&&plan.remaining>0);
 const round=(id:string)=>scope.ledger.rework?.rounds[id.replace(/:qc$/,'')]??0;
 return <details><summary>{scope.label} · {bulkWashingLabels[scope.mode]} · {scope.ledger.conflict?'范围待核':scope.ledger.complete?'洗水与检查已完成':`合格 ${scope.ledger.qualified??'待核'} / ${scope.quantity}`}</summary>
 {scope.ledger.reasons.map(reason=><p role="status" key={reason}>{reason}</p>)}
 <p>送洗 {scope.ledger.sent} · 洗回／洗好 {scope.ledger.washed} · 合格 {scope.ledger.qualified??'待核'} · 剩余 {scope.ledger.remaining??'待核'}</p>
 {scope.ledger.rework&&scope.ledger.rework.sent>0&&<p>返洗发出／开始 {scope.ledger.rework.sent} · 返洗洗回／洗好 {scope.ledger.rework.washed} · 复检合格 {scope.ledger.rework.qualified}（不增加原收货数量）</p>}
 {scope.facts.some(fact=>!fact.voided&&(fact.kind==='send'||fact.kind==='factory_start')&&fact.reworkOfInspectionId&&!fact.rewashWorkId)&&<p role="status">历史返洗已保留真实办理记录；当时未登记独立计划，计划时间待核。</p>}
 {scope.windows.map(w=><p key={w.id}>{round(w.id)?`返洗第${round(w.id)}轮 · `:''}{w.kind==='washing'?'洗水':'洗后检查'}：{display(w.startedAt)} — {display(w.dueAt)} · {w.state==='voided'?'原记录已撤销':w.state==='completed'?`已完成 · ${display(w.completedAt)}`:'尚未完成'}</p>)}
 {scope.fee&&<p>洗水费用：{scope.fee.state==='referenced'?`${scope.fee.name} · 预算第${scope.fee.version}版 · 单价${scope.fee.unitPrice||'待补'} · 用量${scope.fee.consumption||'待补'}`:'沿原预算补齐费用依据'} <a href={productionWorkspaceDomainHref(`${createWebUrls(import.meta.env.BASE_URL).pageUrl('ui/digital-production')}?budget=${orderId}&documentChapter=budget-washing-fees`,window.location.search)}>本单预算费用补充</a></p>}
 {error&&<p role="alert">{error}</p>}
 {uncertain?<><p role="status">提交结果未确认，请用原内容核对，勿重复登记。</p><Button disabled={busy} onClick={()=>void send()}>核对原提交</Button></>:(scope.canLogistics||scope.canInspect||scope.canCorrect)&&<form onChange={()=>setDirty(true)} onSubmit={event=>{
  event.preventDefault();const form=event.currentTarget;try{const data=new FormData(form),base={planId:scope.planId,scopeId:scope.scopeId,quantityVersion:scope.quantityVersion,expectedRevision:scope.revision,occurredAt:time(data.get('occurredAt')),note:String(data.get('note')??'')};
   const value=kind==='rework'?{...base,kind:scope.mode==='factory'?'factory_start':'send',quantity:Number(data.get('quantity')),reworkOfInspectionId:data.get('parentId'),...(data.get('rewashWorkId')?{rewashWorkId:String(data.get('rewashWorkId'))}:{})}:kind==='void'?{...base,kind,factId:data.get('parentId'),reason:data.get('reason')}
    :{...base,kind,quantity:Number(data.get('quantity')),...(kind==='return'?{sendId:data.get('parentId')}:kind==='inspection'?{completionId:data.get('parentId'),qualifiedQuantity:Number(data.get('qualifiedQuantity'))}:kind==='receipt_link'?{completionId:data.get('parentId'),receiptId:data.get('receiptId'),receiptQuantityVersion:scope.receipts?.find(r=>r.receiptId===data.get('receiptId'))?.quantityVersion}:kind==='factory_complete'?{startId:data.get('parentId')}:{})};
   void send(BulkWashingCommandSchema.parse(value)).then(saved=>{if(saved){form.reset();setParentId('');if(kind==='rework')setKind(scope.mode==='factory'?'factory_complete':'return');}});
  }catch(e){setError(e instanceof Error?e.message:'请核对填写内容');}
 }}><fieldset disabled={busy}><legend>登记本批洗水</legend><label>办理<select aria-label="办理" value={kind} onChange={e=>{setKind(e.target.value as WashingAction);setParentId('');}}>
 {scope.canLogistics&&scope.mode==='after_receipt'&&<><option value="send">送洗</option><option value="return">洗回</option></>}
 {scope.canLogistics&&scope.mode==='factory'&&<><option value="factory_start">工厂开始洗水</option><option value="factory_complete">工厂洗好</option><option value="receipt_link">关联已收货批次</option></>}
 {scope.canLogistics&&(scope.ledger.rework?.available.length??0)>0&&<option value="rework">不合格返洗</option>}
 {scope.canInspect&&<option value="inspection">洗后检查</option>}{scope.canCorrect&&<option value="void">撤销错误记录</option>}</select></label>
 {['return','factory_complete','inspection','receipt_link','void','rework'].includes(kind)&&<label>{kind==='rework'?'对应不合格检查':'对应记录'}<select aria-label={kind==='rework'?'对应不合格检查':'对应记录'} name="parentId" value={parentId} onChange={e=>setParentId(e.target.value)} required><option value="">请选择</option>{candidates.map(f=><option key={f.id} value={f.id}>{f.label} · {f.quantity}件 · {display(f.at)}</option>)}</select></label>}
 {kind==='rework'&&<><label>本轮正式计划<select aria-label="本轮正式计划" name="rewashWorkId" required={scope.requireRewashPlan}><option value="">请选择已生效计划</option>{plannedRewash.map(plan=><option key={plan.intentId} value={plan.intentId}>第{plan.round}轮 · 尚可开始{plan.remaining}件 · 计划检查完成 {display(plan.inspectionPlannedAt)}</option>)}</select></label>{scope.requireRewashPlan&&!plannedRewash.length&&<p role="status">请先由有权人员在本单时效确定本轮返洗计划，再登记实际开始。</p>}</>}
 {kind==='receipt_link'&&<label>原收货批次<select aria-label="原收货批次" name="receiptId" required><option value="">请选择</option>{scope.receipts?.map(r=><option key={r.receiptId} value={r.receiptId}>{r.receiptId.slice(0,8)} · 实收{r.quantity}件</option>)}</select></label>}
 {kind!=='void'&&<label>本次数量<input key={`${kind}:${parentId}`} name="quantity" type="number" min={kind==='inspection'&&selected?selected.quantity:1} max={selected?.quantity??scope.quantity} defaultValue={kind==='inspection'?selected?.quantity:undefined} required/></label>}
 {kind==='inspection'&&<label>合格数量<input name="qualifiedQuantity" type="number" min="0" max={selected?.quantity??scope.quantity} required/></label>}
 <label>实际发生时间（北京时间，未知留空）<input name="occurredAt" type="datetime-local" step="0.001"/></label>
 {kind==='void'&&<label>撤销原因<input name="reason" required maxLength={2000}/></label>}
 <label>说明<input name="note" maxLength={2000}/></label><Button type="submit" disabled={scope.ledger.conflict&&kind!=='void'||kind==='rework'&&scope.requireRewashPlan&&!plannedRewash.length}>保存</Button></fieldset></form>}
 <details><summary>洗水记录</summary>{scope.facts.map(f=><p key={f.id}>{round(f.id)?`返洗第${round(f.id)}轮 · `:''}{washingFactLabel(f)} · {display(f.occurredAt)} · {f.operator} · {f.quantity}件{f.kind==='inspection'?` · 合格${f.qualifiedQuantity} · 不合格${f.quantity-f.qualifiedQuantity}`:''}{f.voided?' · 已撤销':''} · {f.note}</p>)}</details>
 </details>;
}
