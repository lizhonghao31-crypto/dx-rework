import {useEffect,useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import {BudgetWashingFeeSchema,calculateBudget,budgetDisplayAmount,type BudgetSheet,type BudgetWashingFees,type BudgetWashingFeeInput} from '@dx-rework/contracts/digital-budget';
import {compareQuotationBudget} from '@dx-rework/contracts/digital-quotation';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {createClientRequestId} from './client-request-id.js';
import {DocumentSection,DocumentField} from './document-editor.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {confirmInApp} from './system-dialog.js';
import {budgetWashingFeeResult} from './budget-washing-fee-result.js';

/** A narrow original-budget action; the published document stays read-only. */
export function BudgetWashingFeesPanel({sheet,quantity,onPublished}:{sheet:BudgetSheet;quantity:number;onPublished():Promise<void>}){
 const id=sheet.productionOrderId,base=`orders/${id}/budget/washing-fees`;
 const [value,setValue]=useState<BudgetWashingFees|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),[dirty,setDirty]=useState(false);
 const [lineId,setLineId]=useState(''),[kind,setKind]=useState<'existing'|'new'|'adjust'>('existing'),[rowId,setRowId]=useState('');
 const [row,setRow]=useState({name:'大货洗水',specification:'',unit:'件',supplier:'',consumption:'1',unitPrice:''}),[reason,setReason]=useState('');
 const writing=useRef(false),pending=useRef<{body:BudgetWashingFeeInput;key:string}|null>(null),live=useRef(true);
 useDigitalDetailNavigationGuard(dirty||unknown,busy,writing,'洗水费用尚未保存或回执未确认，仍要离开？');
 const read=async()=>{const data=await digitalRequest<BudgetWashingFees>(base);if(!data||data.productionOrderId!==id||!Array.isArray(data.lines)||!Array.isArray(data.rows)||!Array.isArray(data.history)||!Array.isArray(data.references)||!Number.isSafeInteger(data.budgetVersion))throw Error('洗水费用资料回执不完整');if(live.current){setValue(data);setLineId(current=>data.lines.some(line=>line.lineId===current)?current:data.lines[0]?.lineId??'');}return data;};
 useEffect(()=>{live.current=true;void read().catch(cause=>{if(live.current)setError(cause instanceof Error?cause.message:'费用读取失败');});return()=>{live.current=false;};},[base]);
 const line=value?.lines.find(line=>line.lineId===lineId),currentRow=line?.fee.kind==='budget_row'?value?.rows.find(row=>row.rowId===(line.fee.kind==='budget_row'?line.fee.rowId:'')):undefined;
 const preview=sheet.document&&value?.budgetVersion===sheet.version&&kind!=='existing'&&row.unitPrice!==''&&row.consumption!==''?(()=>{try{
  const added={...row,rowId:kind==='adjust'&&currentRow?currentRow.rowId:'preview',section:'外发工序' as const,category:'洗水'},next={...sheet.document!,rows:kind==='adjust'?sheet.document!.rows.map(old=>old.rowId===added.rowId?added:old):[...sheet.document!.rows,added]};
  return {cost:calculateBudget(next).cost,comparison:value.comparison?.confirmation?compareQuotationBudget(next,value.comparison.confirmation,quantity):null};
 }catch{return null;}})():null;
 const send=async(body?:BudgetWashingFeeInput)=>{
  if(writing.current||unknown&&body)return;if(body)pending.current={body:structuredClone(body),key:createClientRequestId()};const command=pending.current;if(!command)return;
  writing.current=true;setBusy(true);setError('');let confirmed=false;
  try{const result=await digitalRequest<unknown>(base,'POST',command.body,command.key);
   if(!budgetWashingFeeResult(result,id,command.body))throw new DigitalRequestError('费用提交回执不完整或不匹配，请核对原提交',200,'INVALID_RESPONSE');
   const fee=result.lines.find(line=>line.lineId===command.body.lineId)!.fee;if(fee.kind!=='budget_row')throw new DigitalRequestError('费用关联待核',200,'INVALID_RESPONSE');
   confirmed=true;pending.current=null;setUnknown(false);setDirty(false);setValue(result);setKind('existing');setRowId(fee.rowId);setReason('');await onPublished();
  }catch(cause){if(!live.current)return;setUnknown(!confirmed&&(!(cause instanceof DigitalRequestError)||cause.resultUnknown));setError((confirmed?'费用已保存，预算重新读取失败：':'')+(cause instanceof Error?cause.message:'费用提交未完成'));}
  finally{writing.current=false;if(live.current)setBusy(false);}
 };
 const refresh=async()=>{
  if(writing.current)return;
  if(dirty&&!unknown&&!await confirmInApp('保留当前输入，读取最新费用版本？'))return;
  if(writing.current)return;writing.current=true;setBusy(true);setError('');
  try{await read();await onPublished();}
  catch(cause){if(cause instanceof DigitalRequestError&&[401,403,404].includes(cause.status??0))setValue(null);setError(cause instanceof Error?cause.message:'费用读取失败');}
  finally{writing.current=false;if(live.current)setBusy(false);}
 };
 return <DocumentSection id="budget-washing-fees" title="洗水费用补充">
  <p>已有费用行可直接关联；新增或调整洗水行会发布新预算版本。原预算历史、已采用报价及外发合同保留，费用不按返洗次数自动增加。</p>
  {error&&<p role="alert">{error}</p>}{!value&&!error&&<p role="status">正在读取洗水费用…</p>}
  <Button disabled={busy} onClick={()=>void refresh()}>重新读取洗水费用</Button>
  {value?.reason&&<p>{value.reason}</p>}
  {value?.comparison?.confirmation&&<p>沿已采用客户确认报价 v{value.comparison.quoteVersion} 核验上限 {value.comparison.confirmedQuoteTotal} 元，后续报价不自动采用。</p>}
  {value?.canPublish&&(unknown?<><p role="status">原费用提交结果尚未确认，输入和原操作标识保留，请勿另建提交。</p><Button disabled={busy} onClick={()=>void send()}>用原内容核对费用提交</Button></>:<form onChange={()=>setDirty(true)} onSubmit={event=>{event.preventDefault();try{
   if(!line)throw Error('请选择本单适用洗水PO');const source=kind==='existing'?{kind,version:value.budgetVersion,rowId}:kind==='adjust'?{kind,rowId:currentRow?.rowId,row}:{kind,row};
   void send(BudgetWashingFeeSchema.parse({expectedVersion:value.budgetVersion,lineId,expectedWashingVersion:line.version,reason,source}));
  }catch(cause){const issues=(cause as {issues?:Array<{message:string}>})?.issues;setError(issues?.length?(issues[0]!.message.match(/[\u3400-\u9fff]/)?issues[0]!.message:'请核对费用名称、单位、用量、单价和原因'):cause instanceof Error?cause.message:'请核对费用资料');}}}><fieldset disabled={busy}>
   <label>洗水PO<select aria-label="洗水PO" value={lineId} onChange={event=>{setLineId(event.target.value);setKind('existing');setRowId('');}}>{value.lines.map(line=><option key={line.lineId} value={line.lineId}>{line.label}</option>)}</select></label>
   <p>{line?.fee.kind==='budget_row'?`当前引用预算 v${line.fee.version}`:'当前费用尚未关联预算行'}</p>
   <label>费用办理<select aria-label="费用办理" value={kind} onChange={event=>{const next=event.target.value as typeof kind;setKind(next);if(next==='adjust'&&currentRow)setRow({name:currentRow.name,specification:currentRow.specification,unit:currentRow.unit,supplier:currentRow.supplier,consumption:currentRow.consumption,unitPrice:currentRow.unitPrice});}}><option value="existing">关联已有外发工序行</option><option value="new">新增洗水费用行</option>{currentRow?.category==='洗水'&&<option value="adjust">调整本PO已引用洗水行</option>}</select></label>
   {kind==='existing'?<label>已发布费用行<select aria-label="已发布费用行" required value={rowId} onChange={event=>setRowId(event.target.value)}><option value="">请选择，已有费用不要重复新增</option>{value.rows.filter(row=>row.unitPrice!==''&&row.consumption!=='').map(row=><option key={row.rowId} value={row.rowId}>{row.name} · 用量{row.consumption} · 单价{row.unitPrice}</option>)}</select></label>:<div className="budget-basic-body">{Object.entries({name:'洗水费用名称',unit:'洗水计价单位',consumption:'单件洗水用量',unitPrice:'洗水单价',supplier:'洗水供应商',specification:'洗水费用规格'}).map(([key,label])=><label key={key}>{label}<DocumentField id={`budget-washing-${key}`} label={label} value={row[key as keyof typeof row]} numeric={['consumption','unitPrice'].includes(key)} maxLength={['unitPrice','consumption'].includes(key)?21:100} onValue={value=>setRow({...row,[key]:value})}/></label>)}</div>}
   {preview&&<p role="status">补充后预算成本 {budgetDisplayAmount(preview.cost)} 元{preview.comparison?` · ${preview.comparison.reason}`:''}</p>}
   <label>费用依据与原因<DocumentField id="budget-washing-reason" label="费用依据与原因" value={reason} maxLength={2000} multiline onValue={setReason}/></label>
   <Button type="submit" variant="primary" disabled={kind==='existing'&&line?.fee.kind==='budget_row'&&line.fee.version===value.budgetVersion&&line.fee.rowId===rowId}>{kind==='existing'?'关联已发布费用行':'发布并关联洗水费用'}</Button>
  </fieldset></form>)}
  {value&&value.history.length>0&&<details><summary>洗水费用补充历史</summary>{value.history.map(item=><p key={item.version}>预算 v{item.baseVersion} → v{item.version} · {item.action==='new'?'新增':'调整'} · {item.reason} · {new Date(item.publishedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</p>)}</details>}
  {value&&value.references.length>0&&<details><summary>费用引用历史</summary>{value.references.map(item=><p key={`${item.lineId}:${item.planVersion}`}>{value.lines.find(line=>line.lineId===item.lineId)?.label??'原PO'} · 洗水安排 v{item.planVersion} · 预算 v{item.budgetVersion} · {item.name} · 用量{item.consumption||'待核'} · 单价{item.unitPrice||'待核'}</p>)}</details>}
 </DocumentSection>;
}
