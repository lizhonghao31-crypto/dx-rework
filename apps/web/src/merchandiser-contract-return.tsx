import {useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Link} from '@astryxdesign/core/Link';
import {SourcingContractReturnResponseSchema,SourcingContractStateResponseSchema} from '@dx-rework/contracts';
import {createWebUrls} from '../url-contract.js';
import {registerSessionInvalidator,verifySession} from './auth-session.js';
import {toolsAttachmentApi,uploadAttachmentWithRecovery} from './attachment-upload-recovery.js';
import {createClientRequestId} from './client-request-id.js';
import {useForegroundWait} from './foreground-loading.js';
import {request,SourcingRequestError} from './sourcing-api-client.js';
import {sourcingContractReturnLabel} from './sourcing-contract-return-presentation.js';
import {contractReturnFileError,finishContractReturnUpload,submitSourcingContractReturn,type ContractReturnUpload,type SourcingContractReturnSubmission} from './sourcing-contract-return-upload.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {useForegroundRead} from './use-foreground-read.js';

const urls=createWebUrls(import.meta.env.BASE_URL);
const attachment=(id:string,mode:'preview'|'download')=>urls.apiUrl(`tools/attachments/${id}/download?mode=${mode}`);
const dateTime=(value:string|null|undefined)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';

export function MerchandiserContractReturn({caseId,requestedDocumentId,onClose,onSaved}:{caseId:string;requestedDocumentId:string|null;onClose:()=>void;onSaved:()=>void}){
 const epoch=useRef(0),writing=useRef(false),fileInput=useRef<HTMLInputElement>(null);
 const pending=useRef<ContractReturnUpload|null>(null),submission=useRef<SourcingContractReturnSubmission|null>(null);
 const [busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(''),[canReadFiles,setCanReadFiles]=useState(false);
 useEffect(()=>{
  const verify=()=>{const identity=epoch.current;void verifySession().then(session=>{
   if(identity!==epoch.current||session==='denied'||session.status!=='authorized')return;
   setCanReadFiles(session.user.isRoot||session.user.capabilities.includes('supplier_contract_data:read'));
  }).catch(()=>undefined);};
  const invalidate=()=>{epoch.current++;pending.current=null;submission.current=null;writing.current=false;setBusy(false);setUnknown(false);setError('');setSaved('');setCanReadFiles(false);verify();};
  const unregister=registerSessionInvalidator(invalidate);
  verify();
  return()=>{epoch.current++;unregister();};
 },[]);
 const load=useCallback(async(signal:AbortSignal)=>{
  const path=`sourcing/cases/${caseId}`;
  const [{item},result]=await Promise.all([request(path+'/contract',SourcingContractStateResponseSchema,{signal}),
   request(path+'/contract-return',SourcingContractReturnResponseSchema,{signal})]);
  if(item&&item.sourcingContractDocumentId!==result.currentContractDocumentId)throw Error('合同版本或范围已变化，请重新读取。');
  return {item,result};
 },[caseId]);
 const read=useForegroundRead(caseId,requestedDocumentId??caseId,load);
 useForegroundWait(read.foregroundKey);
 useDigitalDetailNavigationGuard(unknown,busy,writing,'这次回签还没有核对结果，仍要离开？');
 const contract=read.value?.item,version=read.value?.result,documentId=contract?.sourcingContractDocumentId;
 const replaced=Boolean(requestedDocumentId&&documentId!==requestedDocumentId);
 const allowed=Boolean(documentId&&!replaced&&version?.contractReturnMonitoring&&version.canUpload);
 const canEdit=allowed&&!read.waiting&&!read.error&&!busy&&!pending.current&&!submission.current;

 const continueSave=async()=>{
  if(writing.current||!(pending.current||submission.current))return;
  const identity=epoch.current;
  const current=()=>identity===epoch.current;
  writing.current=true;setBusy(true);setError('');setSaved('');
  try{
   if(pending.current){
    const upload=pending.current;
    const data=await finishContractReturnUpload(upload,async file=>{
     if(!current())throw Error('请从当前账号重新进入合同。');
     return (await uploadAttachmentWithRecovery(file,`contract-return:${caseId}:${upload.key}`,toolsAttachmentApi)).attachmentId;
    });
    if(!current())return;
    pending.current=null;submission.current=data;
   }
   const attempt=submission.current!;
   const receipt=await submitSourcingContractReturn(caseId,attempt);
   if(!current())return;
   const records=(receipt.versions??receipt.history).filter(row=>row.signedContractDocumentId===attempt.expectedContractDocumentId);
   const confirmed=attempt.attachmentIds.every(id=>records.some(row=>row.attachments.some(file=>file.attachmentId===id))||
    (receipt.currentContractDocumentId===attempt.expectedContractDocumentId&&receipt.attachments.some(file=>file.attachmentId===id)));
   if(!confirmed)throw Error('此版本的回签结果尚未核实。');
   submission.current=null;setUnknown(false);setSaved('本版回签已保存。');read.refreshSilently();onSaved();
  }catch(reason){
   if(!current())return;
   const message=reason instanceof Error?reason.message:'原合同回签未完成。';
   if(reason instanceof SourcingRequestError&&[401,403,404,409].includes(reason.status)&&
    reason.code!=='IDEMPOTENCY_IN_PROGRESS'&&reason.code!=='IDEMPOTENCY_CONFLICT'){
    pending.current=null;submission.current=null;setUnknown(false);read.refreshSilently();
   }else setUnknown(Boolean(submission.current));
   setError(pending.current?`${message} 已上传 ${pending.current.attachmentIds.length}/${pending.current.files.length} 个文件，尚未保存。`:message);
  }finally{if(current()){writing.current=false;setBusy(false);}}
 };
 const choose=(chosen:FileList|null)=>{
  if(!canEdit||!documentId||!version||!chosen?.length)return;
  const files=Array.from(chosen),problem=contractReturnFileError(files,version.uploadedFileCount??version.attachments.length,
   version.uploadedTotalBytes??version.attachments.reduce((sum,file)=>sum+file.sizeBytes,0));
  if(problem){setError(problem);return;}
  pending.current={files,key:createClientRequestId(),attachmentIds:[],expectedContractDocumentId:documentId};
  void continueSave();
 };
 return <section aria-label="本单合同回传"><h2>本单合同回传</h2>
  <Button label="返回跟单列表" variant="secondary" isDisabled={busy||unknown} onClick={onClose}/>
  {read.error&&<p role="alert">{read.error.message} <Button label="重读本单合同" variant="secondary" isDisabled={busy||unknown} onClick={read.retry}/></p>}
  {error&&<p role="alert">{error}</p>}{saved&&<p role="status">{saved}</p>}
  {read.value&&replaced?<p role="status">原待办合同已换版。请返回列表重新选择当前合同，先前文件不会改绑。</p>:
   contract&&version?<>
    <dl aria-label="本单当前合同"><div><dt>合同编号</dt><dd>{contract.contractNumber} · V{contract.contractVersion}</dd></div>
     <div><dt>回签截止</dt><dd>{dateTime(version.contractReturnDueAt)}</dd></div>
     <div><dt>原回签状态</dt><dd>{sourcingContractReturnLabel(version)}</dd></div></dl>
    {canReadFiles&&contract.status==='ready'&&contract.pdfAttachmentId&&<Link href={attachment(contract.pdfAttachmentId,'download')} target="_blank" rel="noreferrer">下载本版合同</Link>}
    {allowed&&<><input ref={fileInput} type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" multiple hidden
     onChange={event=>{choose(event.target.files);event.target.value='';}}/>
     <Button label={(version.uploadedFileCount??version.attachments.length)>0?'补传本版回签':'上传本版回签'}
      isDisabled={!canEdit} isLoading={busy} onClick={()=>fileInput.current?.click()}/></>}
    {canReadFiles&&(version.versions??version.history).length>0&&<details><summary>原回签历史 · {(version.versions??version.history).length} 次</summary><ul>{(version.versions??version.history).map(row=><li key={row.revision}>
     第 {row.revision} 次 · {row.signedContractVersion?`V${row.signedContractVersion}`:'原版本未记录'} · {dateTime(row.submittedAt)} · {row.uploadedByName}
     <ul>{row.attachments.map(file=><li key={file.attachmentId}><Link href={attachment(file.attachmentId,'preview')} target="_blank" rel="noreferrer">{file.filename}</Link></li>)}</ul>
    </li>)}</ul></details>}
   </>:!read.waiting&&!read.error?<p>没有可办理的本单合同及已授权版本。</p>:null}
  {(pending.current||submission.current)&&error&&<Button label={submission.current?'核对同一次回签':'继续本次附件上传'} isDisabled={busy} onClick={()=>void continueSave()}/>}
 </section>;
}
