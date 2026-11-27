import {Button} from '@astryxdesign/core/Button';
import {FileInput} from '@astryxdesign/core/FileInput';
import {Selector} from '@astryxdesign/core/Selector';
import {TextArea} from '@astryxdesign/core/TextArea';
import {TextInput} from '@astryxdesign/core/TextInput';
import {useCallback,useEffect,useRef,useState} from 'react';
import {WarehouseReceiptBatchSchema,type PreparationResource,type WarehouseReceiptWorkItem,type WarehouseReceiptContinuation} from '@dx-rework/contracts/production-readiness';
import {designerAstryxCss} from './designer-astryx.js';
import {createClientRequestId} from './client-request-id.js';
import {uploadDevelopmentMaterial} from './digital-development-upload.js';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {DigitalReadFailure} from './digital-read-failure.js';
import {useForegroundWait} from './foreground-loading.js';
import {SubmissionAttempt} from './submission-attempt.js';
import {SubmissionRequestError} from './submission-validation.js';
import {WarehouseReceiptReconciliationPanel} from './warehouse-receipt-reconciliation-panel.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';

const itemKey=(item:WarehouseReceiptWorkItem)=>JSON.stringify([item.materialId,item.lineId,item.scopeRef,item.kind]);
const lineText=(item:WarehouseReceiptWorkItem)=>item.lineId?'按实际 PO 范围':'共享物料';
const asBeijingLocal=(stamp:string)=>new Date(Date.parse(stamp)+8*3600000).toISOString().slice(0,19);
const asBusinessInstant=(local:string)=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)?local+':00+08:00':
 /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(local)?local+'+08:00':local;

export function WarehouseReceiptBatchPanel({resource,onClose}:{resource:PreparationResource;onClose:()=>void}){
 const base=`${resource.kind==='order'?'orders':'sources'}/${resource.id}/production-readiness`;
 const [wanted]=useState(()=>{
  const search=new URLSearchParams(window.location.search);
  const id=search.get('warehouseMaterial'),scope=search.get('warehouseScope'),kind=search.get('warehouseKind');
  const keys=['warehouseMaterial','warehouseScope','warehouseKind','warehouseLine'];
  const requested=keys.some(key=>search.has(key));
  if(keys.some(key=>search.getAll(key).length>1)||requested&&(!id||!scope||!kind))return 'invalid-warehouse-scope';
  return id&&scope&&kind?JSON.stringify([id,search.get('warehouseLine')||null,scope,kind]):null;
 });
 const [items,setItems]=useState<WarehouseReceiptWorkItem[]|null>(null),[selected,setSelected]=useState(''),
  [correction,setCorrection]=useState(''),[quantity,setQuantity]=useState(''),[occurredAt,setOccurredAt]=useState(''),[note,setNote]=useState('');
 const [busy,setBusy]=useState(false),[reading,setReading]=useState(true),[readError,setReadError]=useState<Error|null>(null);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[file,setFile]=useState<File|null>(null),[evidence,setEvidence]=useState<string[]>([]);
 const [legacy,setLegacy]=useState<WarehouseReceiptContinuation|null>(null),[documentNumber,setDocumentNumber]=useState(''),
  [documentLine,setDocumentLine]=useState(''),[proofAttachment,setProofAttachment]=useState('');
 const [reconciliationPending,setReconciliationPending]=useState(false);
 const active=useRef(true),inflight=useRef<AbortController|null>(null),operation=useRef(new SubmissionAttempt()),writing=useRef(false);
 const current=items?.find(item=>itemKey(item)===selected),prior=current?.activeBatches.find(batch=>String(batch.ref.version)===correction);
 const pending=operation.current.hasPending,dirty=Boolean(quantity||occurredAt||note||file||evidence.length||legacy||documentNumber||documentLine);
 useDigitalDetailNavigationGuard(dirty,busy||pending||reconciliationPending,writing,'本次收料尚未保存或结果待核，确认离开？');
 useForegroundWait(reading?`warehouse-receipts:${resource.id}`:undefined);

 const reload=useCallback(async()=>{
  inflight.current?.abort();const call=new AbortController();inflight.current=call;
  setReadError(null);setReading(true);
  try{
   const rows=await digitalRequest<WarehouseReceiptWorkItem[]>(`${base}/warehouse-receipt-work`,'GET',undefined,undefined,{signal:call.signal});
   if(!call.signal.aborted&&active.current){
    setItems(rows);setSelected(value=>rows.some(row=>itemKey(row)===value)?value:wanted?rows.some(row=>itemKey(row)===wanted)?wanted:'':rows.length?itemKey(rows[0]!):'');
   }
  }catch(reason){if(!call.signal.aborted&&active.current)setReadError(reason instanceof Error?reason:new Error('收料范围读取失败'));}
  finally{if(!call.signal.aborted&&active.current)setReading(false);}
 },[base,wanted]);
 useEffect(()=>{active.current=true;void reload();return()=>{active.current=false;inflight.current?.abort();};},[reload]);

 const clearInput=()=>{setLegacy(null);setDocumentNumber('');setDocumentLine('');setProofAttachment('');setCorrection('');setQuantity('');setOccurredAt('');setNote('');setFile(null);setEvidence([]);};
 const submit=async(retry=false)=>{
  if(writing.current||reconciliationPending||!current)return;
  if(!retry&&(readError||reading||pending||file||current.cutover?.mode==='safe_read'))return;
  const exactTime=prior?.occurredAt??legacy?.input.occurredAt;
  const when=exactTime&&occurredAt===asBeijingLocal(exactTime)?exactTime:asBusinessInstant(occurredAt);
  const attachmentId=proofAttachment||(evidence.length===1?evidence[0]:undefined);
  const parsed=WarehouseReceiptBatchSchema.safeParse({kind:current.kind,scopeRef:current.scopeRef,materialId:current.materialId,lineId:current.lineId,
   supplierId:current.basis.supplierId,unit:current.basis.unit,investment:current.purchase.original,materialFingerprint:current.basis.adoptedRef,expectedReceiptVersion:current.receiptVersion,
   ...(prior?{replaces:prior.ref}:{}),...(legacy?{continuesReceipt:{resource:legacy.resource,key:legacy.key}}:{}),
   ...(documentNumber&&documentLine&&attachmentId?{receiptEvidenceLine:{attachmentId,documentNumber,line:documentLine}}:{}),
   quantity,occurredAt:when,note,evidenceIds:evidence});
  if(!retry&&!parsed.success){setError(parsed.error.issues[0]?.message??'请填写实际收料数量、时间和说明');return;}
  writing.current=true;setBusy(true);setError('');setNotice('');
  try{
   const key=createClientRequestId();
   const result=retry?await operation.current.retry():await operation.current.run(async()=>{
    try{await digitalRequest(`${base}/warehouse-receipts`,'POST',parsed.data,key);}
    catch(reason){
     if(reason instanceof DigitalRequestError&&!reason.resultUnknown)throw new SubmissionRequestError(reason.message,reason.code,reason.status??500);
     throw reason;
    }
   });
   if(!active.current)return;
   if(result.kind==='success'){clearInput();setNotice('本次实收已保存，正在读取当前累计');await reload();}
   if(result.kind==='expired')setError('原请求已超过安全恢复窗口，请核对原收料记录后处理。');
   if(result.kind==='failure')setError(result.uncertain?'提交结果待核，请重试原提交，不要另建一笔。':result.failure.message);
   if(result.kind==='needs-recovery')setError('请先核对并重试原提交。');
  }finally{writing.current=false;if(active.current)setBusy(false);}
 };
 const upload=async()=>{
  if(!file||writing.current||pending||reconciliationPending)return;
  writing.current=true;setBusy(true);setError('');
  try{
   const limits=await digitalRequest<{maxUploadBytes:number}>(`${base}/upload-limits`);
   const id=await uploadDevelopmentMaterial(base,file,'工艺开发板',limits.maxUploadBytes);
   if(active.current){setFile(null);setEvidence(ids=>[...new Set([...ids,id])]);}
  }catch(reason){if(active.current)setError(reason instanceof Error?reason.message:'凭证上传未完成，原文件已保留');}
  finally{writing.current=false;if(active.current)setBusy(false);}
 };
 const readOrWriteDisabled=busy||pending||reading||Boolean(readError);
 const paused=current?.cutover?.mode==='safe_read',disabled=readOrWriteDisabled||Boolean(paused)||reconciliationPending;
 const continueFrom=(request:WarehouseReceiptContinuation)=>{
  const exact=request.input.quantities.filter(row=>row.unit===current?.basis.unit&&(!row.materialId||row.materialId===current?.materialId)&&
    (!row.lineId||row.lineId===current?.lineId));
  clearInput();setLegacy(request);setAtLegacy(request,exact.length===1?String(exact[0]!.quantity):'');
 };
 const setAtLegacy=(request:WarehouseReceiptContinuation,qty:string)=>{
  setQuantity(qty);setOccurredAt(request.input.occurredAt?asBeijingLocal(request.input.occurredAt):'');
  setNote(request.input.note);setEvidence(request.input.evidenceIds);
 };
 return <section className="dx-production-panel dx-designer-astryx" aria-label="仓库实际收料">
  <style>{designerAstryxCss}</style>
  <header><Button type="button" label="返回来源" variant="secondary" onClick={onClose}/><h1>仓库实际收料</h1></header>
  {readError&&<DigitalReadFailure error={readError} onRetry={()=>void reload()} retryLabel="重试读取收料范围"/>}
  {notice&&<p role="status">{reading?notice:'本次实收已保存。'}</p>}
  {error&&<p role="alert">{error}</p>}
  {items&&!items.length&&!readError&&<p>当前没有已核实、由本人办理的待收物料。</p>}
  {wanted&&items&&!current&&items.length>0&&<p>所选物料的原范围已变化，请返回仓库列表核对。</p>}
  {items&&items.length>0&&(!wanted||current)&&<Selector label="原投料范围" value={selected} options={items.map(row=>({value:itemKey(row),label:`${row.name} · ${lineText(row)}`}))}
   isDisabled={disabled||dirty||Boolean(wanted)} onChange={value=>{setSelected(value);clearInput();}}/>}
  {current&&<form className="development-technical-editor" onSubmit={event=>{event.preventDefault();void submit();}}>
   <h2>{current.name} · {current.kind==='fabric_receipt'?'实收面料':'实收辅料'}</h2>
   <p>供应方：{current.supplier||'原资料未登记'} · 原投料 {current.purchase.invested.quantity} {current.basis.unit}</p>
   <p>已实收：{current.received?`${current.received.quantity} ${current.basis.unit}`:'实际数量待核'} · 采购待收：{current.balance.procurementRemaining??'待核'}</p>
   <WarehouseReceiptReconciliationPanel key={itemKey(current)} item={current} resource={resource}
    base={base} reload={reload} disabled={readOrWriteDisabled||dirty} onPendingChange={setReconciliationPending}/>
   <p>生产需用：{current.productionRequired?`${current.productionRequired.quantity} ${current.productionRequired.unit}`:'待核'} · 生产欠料：{current.balance.productionShortage??'待核'}</p>
   <p>原验布、预缩及质量放行保持原办理入口。</p>
   {paused&&<p role="status">本采购范围暂停新增或订正，原批和原提交仍可查看。</p>}
   {current.pendingReceipts?.length?<section aria-label="原未过账收布">
    <h3>原未过账收布</h3>
    {current.pendingReceipts.map(request=><div key={request.resource.id+':'+request.key}>
     <p>{request.input.occurredAt?asBeijingLocal(request.input.occurredAt).replace('T',' '):'实际时间待核'} · {request.input.note}</p>
     <Button type="button" label="继续这笔原提交" variant="secondary" isDisabled={disabled||dirty} onClick={()=>continueFrom(request)}/>
    </div>)}
    {legacy&&<p role="status">已带回原填写内容，核准本物料和实际批次后补齐凭证明细或选择准确订正目标。</p>}
   </section>:null}
   <Selector label="选择新增或订正原批次" value={correction} options={[{value:'',label:'新增独立收料批次'},...current.activeBatches.map(row=>({
     value:String(row.ref.version),label:`订正第 ${row.ref.version} 批 · ${row.quantity.quantity} ${row.quantity.unit} · ${asBeijingLocal(row.occurredAt).replace('T',' ')}`,
    }))]} isDisabled={disabled} onChange={value=>{
     const row=current.activeBatches.find(item=>String(item.ref.version)===value);
     setCorrection(value);
     if(!legacy){setQuantity(row?.quantity.quantity??'');setOccurredAt(row?asBeijingLocal(row.occurredAt):'');setNote('');setFile(null);setEvidence([]);}
    }}/>
   <TextInput label={`本次数量（${current.basis.unit}）`} inputMode="decimal" value={quantity} onChange={setQuantity} isDisabled={disabled}/>
   <label>实际收料时间（北京时间）<input type="datetime-local" step={1} value={occurredAt} disabled={disabled}
    onChange={event=>setOccurredAt(event.currentTarget.value)}/></label>
   <TextArea label="本次收料说明 / 订正原因" value={note} maxLength={1000} isDisabled={disabled} onChange={setNote}/>
   <FileInput label="原实收凭证（可选）" accept="image/jpeg,image/png,image/webp,application/pdf" isDisabled={disabled}
    value={file} onChange={value=>setFile(Array.isArray(value)?value[0]??null:value)}/>
   {file&&<Button type="button" label="上传所选凭证" isDisabled={disabled} onClick={()=>void upload()}/>}
   {evidence.length>0&&<p>原凭证已就绪 {evidence.length} 个</p>}
   {current.cutover&&<>
    {evidence.length>1&&<Selector label="原凭证明细所用文件" value={proofAttachment} options={evidence.map((id,i)=>({value:id,label:`凭证 ${i+1}`}))}
     isDisabled={disabled} onChange={setProofAttachment}/>}
    <TextInput label="原收货凭证号" value={documentNumber} onChange={setDocumentNumber} isDisabled={disabled}/>
    <TextInput label="原收货凭证明细行" value={documentLine} onChange={setDocumentLine} isDisabled={disabled}/>
   </>}
   <div className="development-technical-actions">
    <Button type="button" label="清空未提交输入" variant="secondary" isDisabled={disabled||!dirty} onClick={clearInput}/>
    <Button type="submit" label={prior?'保存本次订正':'保存实际收料'} variant="primary" isDisabled={disabled||!quantity||!occurredAt||!note.trim()||Boolean(file)}/>
    {pending&&<Button type="button" label="核对并重试原提交" isDisabled={busy} onClick={()=>void submit(true)}/>}
   </div>
  </form>}
 </section>;
}
