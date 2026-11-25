import {useEffect,useRef,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import type {ReceiptQualityFact} from '@dx-rework/contracts/order-closure';
import {createWebUrls} from '../url-contract.js';
import {prepareImageUploadCandidate,uploadImageWithNormalizationRetry,isImageUploadCandidate} from './attachment-upload.js';
import {localFileScope,uploadAttachmentWithRecovery} from './attachment-upload-recovery.js';
import {digitalRequest} from './digital-production-api.js';
import {designerAstryxCss} from './designer-astryx.js';

type Scope={orderId:string;receiptId:string;quantityVersion:string};
type Pending={file:File;key:string;preview:string;attachmentId?:string;error?:string};
const path=(scope:Scope)=>`orders/${scope.orderId}/closure/quality/${scope.receiptId}/${scope.quantityVersion}`;
const {apiUrl}=createWebUrls(import.meta.env.BASE_URL);

export function OriginalGarmentQualityPhotos({orderId,receipt}:{orderId:string;receipt:ReceiptQualityFact}){
 if(!receipt.eventId||!receipt.attachmentIds?.length)return null;
 const origin=path({orderId,receiptId:receipt.receiptId,quantityVersion:receipt.quantityVersion});
 return <ul aria-label="原到仓质检报告">{receipt.attachmentIds.map((id,i)=><li key={id}><a href={apiUrl(`digital-production/${origin}/history/${receipt.eventId}/attachments/${id}`)} target="_blank" rel="noreferrer">查看原质检图片 {i+1}</a></li>)}</ul>;
}

/** Original upload recovery reuses the same file and server intent on a
 * single-image retry. A ready photo is not an inspection completion. */
export function useGarmentQualityPhotos(scope:Scope){
 return useScopedQualityPhotos(path(scope),'到仓质检报告图片');
}
export function useScopedQualityPhotos(origin:string,label:string){
 const [files,setFiles]=useState<Pending[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const inFlight=useRef(false),urls=useRef(new Set<string>());
 const release=(url:string)=>{URL.revokeObjectURL(url);urls.current.delete(url);};
 const clear=()=>{for(const url of urls.current)release(url);setFiles([]);setError('');};
 useEffect(()=>()=>{for(const url of urls.current)URL.revokeObjectURL(url);urls.current.clear();},[]);
 useEffect(()=>{for(const url of urls.current)URL.revokeObjectURL(url);urls.current.clear();setFiles([]);setError('');},[origin]);
 const upload=async(entries:Pending[])=>{
  if(inFlight.current||!entries.length)return;
  inFlight.current=true;setBusy(true);
  try{
   for(const entry of entries){
    try{
     const normalized=await prepareImageUploadCandidate(entry.file);
     const result=await uploadImageWithNormalizationRetry(entry.file,normalized,file=>uploadAttachmentWithRecovery(file,`${origin}:${entry.key}`,{
      createIntent:body=>digitalRequest(`${origin}/upload-intents`,'POST',body),
      finalize:id=>digitalRequest(`${origin}/attachments/${id}/finalize`,'POST',{}),
     },undefined,undefined,entry.file));
     setFiles(current=>current.map(row=>row.key===entry.key?{file:row.file,key:row.key,preview:row.preview,attachmentId:result.attachmentId}:row));
    }catch(cause){setFiles(current=>current.map(row=>row.key===entry.key?{...row,error:cause instanceof Error?cause.message:'原图片上传未完成'}:row));}
   }
  }finally{inFlight.current=false;setBusy(false);}
 };
 const select=(images:File[])=>{
  if(!images.length||inFlight.current)return;
  if(files.length+images.length>10){setError('每次原检查最多上传10张图片');return;}
  if(images.some(file=>!isImageUploadCandidate(file))){setError('请选择有效的 JPG、PNG、WebP 图片');return;}
  setError('');
  const added=images.map(file=>{const preview=URL.createObjectURL(file);urls.current.add(preview);return {file,key:localFileScope(file),preview};});
  setFiles(current=>[...current,...added]);void upload(added);
 };
 const controls=<section className="dx-designer-astryx" lang="zh-CN" aria-label={label}>
  <style>{designerAstryxCss}</style>
  <label>质检报告图片（选填）<input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy}
   onChange={event=>{select(Array.from(event.target.files??[]));event.currentTarget.value='';}}/></label>
  {error&&<p role="alert">{error}</p>}
  <ul>{files.map(file=><li key={file.key}><img width={84} height={64} style={{objectFit:'contain'}} src={file.preview} alt={file.file.name}/>
   <span>{file.file.name} · {file.attachmentId?'文件已就绪，尚未登记检查':file.error??'上传中'}</span>
   {file.error&&<Button type="button" label={`重试 ${file.file.name}`} isDisabled={busy} onClick={()=>void upload([file])}/>}
   <Button type="button" label={`移除 ${file.file.name}`} isDisabled={busy} onClick={()=>{release(file.preview);setFiles(current=>current.filter(row=>row.key!==file.key));}}/>
  </li>)}</ul>
 </section>;
 return {controls,busy,unready:files.some(file=>!file.attachmentId),dirty:files.length>0,clear,
  attachmentIds:files.flatMap(file=>file.attachmentId?[file.attachmentId]:[])};
}
