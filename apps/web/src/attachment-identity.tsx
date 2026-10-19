import {useEffect,useState} from 'react';
import {Button} from '@dx-rework/ui';
import {digitalRequest} from './digital-production-api.js';
import './attachment-identity.css';
export type AttachmentIdentityData={filename:string;mimeType:string;sizeBytes:number};
/** Disclosure supplies visible full text on keyboard/touch; title is only a hover convenience. */
export function AttachmentName({filename}:{filename:string}){
 return <details className="attachment-name"><summary title={filename}><span>{filename}</span></summary><div className="attachment-name__full">{filename}</div></details>;
}
const typeLabel=(mime:string)=>({'application/pdf':'PDF','image/jpeg':'JPG','image/png':'PNG','image/webp':'WebP'}[mime]??'文件');
export function AttachmentIdentity({local,metadataPath,label}:{local?:AttachmentIdentityData|undefined;metadataPath?:string|undefined;label:string}){
 const [result,setResult]=useState<{path:string;value:AttachmentIdentityData}|null>(null),[failure,setFailure]=useState<{path:string}|null>(null),[retry,setRetry]=useState(0);
 useEffect(()=>{if(local||!metadataPath)return;let live=true;setFailure(null);void digitalRequest<AttachmentIdentityData>(metadataPath).then(value=>{if(live)setResult({path:metadataPath,value});}).catch(()=>{if(live)setFailure({path:metadataPath});});return()=>{live=false;};},[metadataPath,Boolean(local),retry]);
 const identity=local??(result&&result.path===metadataPath?result.value:null),error=failure?.path===metadataPath&&Boolean(metadataPath);
 return <div className="attachment-identity"><small>{label}</small>{identity?<><AttachmentName filename={identity.filename}/><small>{typeLabel(identity.mimeType)} · {identity.sizeBytes<1024?`${identity.sizeBytes} B`:`${(identity.sizeBytes/1024).toFixed(1)} KB`}</small></>:error?<><p role="status">未能读取附件名称，请重试或核对当前查看权限。</p><Button type="button" onClick={()=>setRetry(value=>value+1)}>重试读取附件名称</Button></>:<span role="status">{metadataPath?'正在读取附件名称…':'附件名称尚未取得'}</span>}</div>;
}
