import {Button} from '@astryxdesign/core/Button';
import {FileInput} from '@astryxdesign/core/FileInput';
import {Link} from '@astryxdesign/core/Link';
import {Selector} from '@astryxdesign/core/Selector';
import {TextArea} from '@astryxdesign/core/TextArea';
import {TextInput} from '@astryxdesign/core/TextInput';
import {useRef,useState} from 'react';
import {WarehouseReceiptAttestationSchema,WarehouseReceiptReconciliationSchema,type PreparationResource,
 type WarehouseReceiptWorkItem} from '@dx-rework/contracts/production-readiness';
import {createWebUrls} from '../url-contract.js';
import {createClientRequestId} from './client-request-id.js';
import {uploadDevelopmentMaterial} from './digital-development-upload.js';
import {digitalRequest,DigitalRequestError} from './digital-production-api.js';
import {SubmissionAttempt} from './submission-attempt.js';
import {SubmissionRequestError} from './submission-validation.js';

const urls=createWebUrls(import.meta.env.BASE_URL);
type Work=NonNullable<WarehouseReceiptWorkItem['reconciliation']>;
type ReceiptRef=Work['pending'][number]['ref'];
type SignedLine={attachmentId:string;documentNumber:string;line:string};
const emptyLine=():SignedLine=>({attachmentId:'',documentNumber:'',line:''});
const refKey=(ref:ReceiptRef)=>`${ref.recordId}/${ref.version}`;
const originalUrl=(resource:PreparationResource,ref:ReceiptRef)=>urls.pageUrl('/ui/digital-production?'+new URLSearchParams({
 [resource.kind==='order'?'materialOrder':'materialSource']:resource.id,originalMaterial:ref.recordId,originalMaterialVersion:String(ref.version),
}));
const attachmentUrl=(base:string,id:string)=>urls.apiUrl(`digital-production/${base}/attachments/${id}`);

export function WarehouseReceiptReconciliationPanel({item,resource,base,reload,disabled,onPendingChange}:{
 item:WarehouseReceiptWorkItem;resource:PreparationResource;base:string;reload:()=>Promise<void>;disabled:boolean;onPendingChange:(busy:boolean)=>void;
}){
 const proof=item.reconciliation;
 const [show,setShow]=useState(false),[rowKey,setRowKey]=useState(''),[batchKey,setBatchKey]=useState(''),
  [relation,setRelation]=useState<'independent'|'same_batch'|' '>(' '),[mode,setMode]=useState<'document'|'acceptance_attestation'>('document'),
  [note,setNote]=useState(''),[file,setFile]=useState<File|null>(null),[left,setLeft]=useState(emptyLine),[right,setRight]=useState(emptyLine),
  [signedLeft,setSignedLeft]=useState(''),[signedRight,setSignedRight]=useState(''),[busy,setBusy]=useState(false),
  [error,setError]=useState(''),[notice,setNotice]=useState('');
 const operation=useRef(new SubmissionAttempt()),writing=useRef(false);
 const response=useRef<{generation?:number;attestationId?:string}|null>(null);
 const chosen=proof?.pending.find(row=>JSON.stringify([row.ref,row.quantityRowKey])===rowKey);
 const counterpart=item.activeBatches.find(row=>refKey(row.ref)===batchKey);
 const attempt=operation.current.hasPending;
 const lock=disabled||busy||attempt;
 const withWrite=async(fn:()=>Promise<void>)=>{
  if(disabled||writing.current)return;
  writing.current=true;setBusy(true);setError('');setNotice('');onPendingChange(true);
  try{await fn();}
  catch(reason){setError(reason instanceof Error?reason.message:'凭证处理未完成');}
  finally{writing.current=false;setBusy(false);onPendingChange(operation.current.hasPending);}
 };
 const upload=(side:'legacy'|'batch')=>withWrite(async()=>{
  if(!file||attempt)return;
  const limits=await digitalRequest<{maxUploadBytes:number}>(`${base}/upload-limits`);
  const attachmentId=await uploadDevelopmentMaterial(base,file,'工艺开发板',limits.maxUploadBytes);
  const setter=side==='legacy'?setLeft:setRight;
  setter(line=>({...line,attachmentId}));setFile(null);
 });
 const send=(action:'confirm'|'revoke'|'attest_legacy'|'attest_batch',target:{ref:ReceiptRef;quantityRowKey:string;generation:number},retry=false)=>withWrite(async()=>{
  const scope={scopeRef:item.scopeRef,materialId:item.materialId,lineId:item.lineId,supplierId:item.basis.supplierId,unit:item.basis.unit,
   investment:item.purchase.original,materialFingerprint:item.basis.adoptedRef,legacy:{ref:target.ref,quantityRowKey:target.quantityRowKey}};
  const attesting=action==='attest_legacy'||action==='attest_batch';
  const request=attesting?WarehouseReceiptAttestationSchema.safeParse({...scope,batch:counterpart?.ref,relation,
   side:action==='attest_legacy'?'legacy':'batch',note}):WarehouseReceiptReconciliationSchema.safeParse(action==='revoke'
   ?{...scope,action,expectedGeneration:target.generation,note}
   :{...scope,action,batch:counterpart?.ref,relation,expectedGeneration:target.generation,note,
    proof:mode==='document'?{mode,legacy:left,batch:right}:{mode,legacy:signedLeft,batch:signedRight}});
  if(!retry&&!request.success){setError('请选准确原数量行和对照批，填写说明及两边各自凭证明细。');return;}
  const key=createClientRequestId();
  const result=retry?await operation.current.retry():await operation.current.run(async()=>{
   const endpoint=`${base}/warehouse-receipt-reconciliation${attesting?'/attest':''}`;
   try{response.current=await digitalRequest<{generation?:number;attestationId?:string}>(endpoint,'POST',request.data,key);}
   catch(reason){
    if(reason instanceof DigitalRequestError&&!reason.resultUnknown)throw new SubmissionRequestError(reason.message,reason.code,reason.status??500);
    throw reason;
   }
  });
  if(result.kind==='success'){
   if(response.current?.attestationId){
    if(action==='attest_legacy')setSignedLeft(response.current.attestationId);else setSignedRight(response.current.attestationId);
    setNotice('本人签认已保存。可复制回执，由当前指派仓管汇合两笔签认。');
   }else{setNote('');setFile(null);setRowKey('');setBatchKey('');setLeft(emptyLine());setRight(emptyLine());setSignedLeft('');setSignedRight('');
    setNotice('核对关系已保存。没有新增或订正实收。');await reload();}
  }
  if(result.kind==='failure')setError(result.uncertain?'核对结果待确认，请重试原提交，不要另建一笔。':result.failure.message);
  if(result.kind==='expired')setError('原提交恢复窗口已过，请先刷新核对关系。');
  if(result.kind==='needs-recovery')setError('请先重试原提交。');
 });
 // Keep the retry bound to the existing request and its displayed outcome.
 const last=useRef<{action:Parameters<typeof send>[0];target:Parameters<typeof send>[1]}|null>(null);
 const start=(action:Parameters<typeof send>[0],target:Parameters<typeof send>[1])=>{last.current={action,target};void send(action,target);};
 if(!proof)return null;
 if(!show&&!proof.pending.length&&!proof.confirmed.length&&!proof.nativeNeedsReview)return null;
 const meter=(value:{quantity:string;unit:string})=>`${value.quantity} ${value.unit}`;
 const pendingText=proof.pending.length===1?`另有 ${meter(proof.pending[0]!.quantity)}待核`:`另有 ${proof.pending.length} 个原数量行待核`;
 return <section aria-label="历史实收核对">
  {proof.pending.length>0&&<p>{proof.verified?`已核 ${meter(proof.verified)}，`:''}{pendingText}。累计实收及待收待核。</p>}
  {proof.nativeNeedsReview&&<p>现有原批或订正凭证需要核对，暂不能确认累计。</p>}
  <Button type="button" variant="secondary" label={show?'收起历史实收核对':'核对历史实收'} isDisabled={lock} onClick={()=>setShow(!show)}/>
  {show&&<>
   <h3>历史实收核对</h3>
   <p>用于核对原批。这里的试算不变更原收料、验布或制单。</p>
   {proof.received&&<p>对账试算：采购 {meter(item.purchase.invested)}，实收 {meter(proof.received)}，待收 {proof.procurementRemaining??'待核'} {item.basis.unit}。</p>}
   {proof.pending.map(row=><p key={JSON.stringify([row.ref,row.quantityRowKey])}>
    <Link href={originalUrl(resource,row.ref)} target="_blank" rel="noreferrer">原数量行 · {meter(row.quantity)} · 第 {row.ref.version} 版</Link> · {row.reason}
   </p>)}
   {proof.confirmed.map(row=><p key={JSON.stringify([row.ref,row.quantityRowKey])}>
    <Link href={originalUrl(resource,row.ref)} target="_blank" rel="noreferrer">已核原件 · {meter(row.quantity)}</Link> · {row.relation==='independent'?'独立到货':'同批引用'}
    {row.attachmentIds.map((id,index)=><Link key={id} href={attachmentUrl(base,id)} target="_blank" rel="noreferrer"> 凭证 {index+1}</Link>)}
    <Button type="button" label="撤销该核对" variant="secondary" isDisabled={lock||!note.trim()} onClick={()=>start('revoke',row)}/>
   </p>)}
   <TextArea label="核对说明或撤销原因" value={note} onChange={setNote} isDisabled={lock} maxLength={1000}/>
   {proof.pending.length>0&&<Selector label="核对哪个原数量行" value={rowKey} onChange={setRowKey} isDisabled={lock}
    options={proof.pending.map(row=>({value:JSON.stringify([row.ref,row.quantityRowKey]),label:`${meter(row.quantity)} · 第 ${row.ref.version} 版 · ${row.occurredAt??'发生时间待核'}`}))}/>}
   {chosen?.bindingState==='confirmed'&&<Button type="button" variant="secondary" label="撤销已失效的原核对" isDisabled={lock||!note.trim()}
    onClick={()=>start('revoke',chosen)}/>}
   {chosen&&chosen.bindingState!=='confirmed'&&<>
    <Selector label="对照原批次" value={batchKey} onChange={setBatchKey} isDisabled={lock}
     options={item.activeBatches.filter(row=>Number(row.quantity.quantity)>0).map(row=>({value:refKey(row.ref),label:`第 ${row.ref.version} 批 · ${meter(row.quantity)}`}))}/>
    {counterpart&&<Link href={originalUrl(resource,counterpart.ref)} target="_blank" rel="noreferrer">查看所选对照批原件</Link>}
    <Selector label="认定批次关系" value={relation} onChange={v=>setRelation(v==='independent'||v==='same_batch'?v:' ')} isDisabled={lock}
     options={[{value:'independent',label:'独立到货'},{value:'same_batch',label:'同一批，仅引用'}]}/>
    <Selector label="使用哪种原凭证" value={mode} onChange={v=>setMode(v==='acceptance_attestation'?'acceptance_attestation':'document')} isDisabled={lock}
     options={[{value:'document',label:'原送货、签收或入库凭证明细'},...(proof.allowOperatorAttestation?[{value:'acceptance_attestation',label:'仅隔离 Acceptance 样本：原操作人签认'}]:[])]}/>
    {mode==='document'?<>
     <p>逐笔核对原凭证号和明细行。两笔可引用同一张文件，但不要把同一行当两次到货。</p>
     {chosen.evidenceIds.map((id,index)=><Button key={id} type="button" variant="secondary" label={`引用原数量行凭证 ${index+1}`}
      isDisabled={lock} onClick={()=>setLeft({...left,attachmentId:id})}/>)}
     {counterpart?.evidenceIds?.map((id,index)=><Button key={id} type="button" variant="secondary" label={`引用对照批原凭证 ${index+1}`}
      isDisabled={lock} onClick={()=>setRight({...right,attachmentId:id})}/>)}
     <FileInput label="选取原凭证" accept="image/jpeg,image/png,image/webp,application/pdf" isDisabled={lock} value={file}
      onChange={v=>setFile(Array.isArray(v)?v[0]??null:v)}/>
     {file&&<><Button type="button" label="上传为原数量行凭证" isDisabled={lock} onClick={()=>void upload('legacy')}/>
      <Button type="button" label="上传为对照批凭证" isDisabled={lock} onClick={()=>void upload('batch')}/></>}
     {left.attachmentId&&<Link href={attachmentUrl(base,left.attachmentId)} target="_blank" rel="noreferrer">原数量行所选凭证</Link>}
     <TextInput label="原数量行凭证编号" value={left.documentNumber} onChange={documentNumber=>setLeft({...left,documentNumber})} isDisabled={lock}/>
     <TextInput label="原数量行明细行号" value={left.line} onChange={line=>setLeft({...left,line})} isDisabled={lock}/>
     {left.attachmentId&&<Button type="button" variant="secondary" label="对照批引用同一文件" isDisabled={lock}
      onClick={()=>setRight({...right,attachmentId:left.attachmentId})}/>}
     {right.attachmentId&&<Link href={attachmentUrl(base,right.attachmentId)} target="_blank" rel="noreferrer">对照批所选凭证</Link>}
     <TextInput label="对照批凭证编号" value={right.documentNumber} onChange={documentNumber=>setRight({...right,documentNumber})} isDisabled={lock}/>
     <TextInput label="对照批明细行号" value={right.line} onChange={line=>setRight({...right,line})} isDisabled={lock}/>
    </>:<>
     <p>本替代凭证只用于隔离 Acceptance 的合成样本。两笔由各自实际操作者签认，不能代签。</p>
     <Button type="button" label="本人签认原数量行" isDisabled={lock||!counterpart||relation===' '||!note.trim()} onClick={()=>start('attest_legacy',chosen)}/>
     <Button type="button" label="本人签认对照批" isDisabled={lock||!counterpart||relation===' '||!note.trim()} onClick={()=>start('attest_batch',chosen)}/>
     <TextInput label="原数量行签认回执" value={signedLeft} onChange={setSignedLeft} isDisabled={lock}/>
     <TextInput label="对照批签认回执" value={signedRight} onChange={setSignedRight} isDisabled={lock}/>
    </>}
    <Button type="button" label="确认核对关系" isDisabled={lock||!counterpart||relation===' '||!note.trim()||Boolean(file)} onClick={()=>start('confirm',chosen)}/>
   </>}
   {attempt&&last.current&&<Button type="button" label="重试原核对提交" isDisabled={disabled||busy}
    onClick={()=>{const prior=last.current;if(prior)void send(prior.action,prior.target,true);}}/>}
   {error&&<p role="alert">{error}</p>}
   {notice&&<p role="status">{notice}</p>}
  </>}
 </section>;
}
