import {AttachmentName} from './attachment-identity.js';
import {useEffect,useRef,useState} from 'react';
type Preview={file:File;url:string;id?:string;error?:string;purpose?:string|undefined;retry?:((files:File[])=>unknown)|undefined};
/** Local byte previews only; original upload and save commands own persistence. */
export function useDocumentUploadPreviews(){
 const entries=useRef<Preview[]>([]),[,render]=useState(0);
 useEffect(()=>()=>{for(const entry of entries.current)URL.revokeObjectURL(entry.url);},[]);
 const refresh=()=>render(value=>value+1);
 const reset=()=>{for(const entry of entries.current)URL.revokeObjectURL(entry.url);entries.current=[];refresh();};
 const start=(files:File[],purpose?:string,retry?:(files:File[])=>unknown)=>{for(const file of files){const entry=entries.current.find(entry=>entry.file===file);if(entry){delete entry.error;entry.retry=retry;}else entries.current.push({file,url:URL.createObjectURL(file),purpose,retry});}refresh();};
 const uploaded=(file:File,id:string)=>{const entry=entries.current.find(value=>value.file===file);if(entry){entry.id=id;delete entry.error;refresh();}};
 const failed=(file:File,error:string)=>{const entry=entries.current.find(value=>value.file===file);if(entry&&!entry.id){entry.error=error;refresh();}};
 const saved=(ids?:string[])=>{entries.current=entries.current.filter(entry=>{if(!entry.id||ids&&!ids.includes(entry.id))return true;URL.revokeObjectURL(entry.url);return false;});refresh();};
 const url=(id:string,fallback:string)=>entries.current.find(entry=>entry.id===id)?.url??fallback;
 const identity=(id:string)=>{const file=entries.current.find(entry=>entry.id===id)?.file;return file?{filename:file.name,mimeType:file.type,sizeBytes:file.size}:undefined;};
 const view=entries.current.length?<div className="document-upload-previews" aria-label="本次附件上传状态">{entries.current.map((entry,index)=><figure key={index}>{entry.file.type.startsWith('image/')?<img src={entry.url} alt={entry.file.name} style={{maxWidth:120,maxHeight:100}}/>:<a href={entry.url} target="_blank" rel="noreferrer">预览原附件</a>}<AttachmentName filename={entry.file.name}/><figcaption>{entry.purpose?`${entry.purpose} · `:''}{entry.error?`尚未就绪：${entry.error}`:entry.id?'已上传，尚未保存引用':'待上传 / 上传中'}</figcaption>{entry.error&&entry.retry&&<button type="button" onClick={()=>void entry.retry?.([entry.file])}>重试此附件</button>}</figure>)}</div>:null;
 return {start,uploaded,failed,saved,reset,url,identity,view};
}
