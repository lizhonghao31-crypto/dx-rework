import {useEffect,useRef,useState} from 'react';
type Preview={file:File;url:string;id?:string;error?:string;purpose?:string|undefined};
/** Local byte previews only; original upload and save commands own persistence. */
export function useDocumentUploadPreviews(){
 const entries=useRef<Preview[]>([]),[,render]=useState(0);
 useEffect(()=>()=>{for(const entry of entries.current)URL.revokeObjectURL(entry.url);},[]);
 const refresh=()=>render(value=>value+1);
 const start=(files:File[],purpose?:string)=>{for(const file of files)if(!entries.current.some(entry=>entry.file===file))entries.current.push({file,url:URL.createObjectURL(file),purpose});refresh();};
 const uploaded=(file:File,id:string)=>{const entry=entries.current.find(value=>value.file===file);if(entry){entry.id=id;delete entry.error;refresh();}};
 const failed=(file:File,error:string)=>{const entry=entries.current.find(value=>value.file===file);if(entry&&!entry.id){entry.error=error;refresh();}};
 const saved=(ids?:string[])=>{entries.current=entries.current.filter(entry=>{if(!entry.id||ids&&!ids.includes(entry.id))return true;URL.revokeObjectURL(entry.url);return false;});refresh();};
 const url=(id:string,fallback:string)=>entries.current.find(entry=>entry.id===id)?.url??fallback;
 const view=entries.current.length?<div className="document-upload-previews" aria-label="本次附件上传状态">{entries.current.map((entry,index)=><figure key={index}>{entry.file.type.startsWith('image/')?<img src={entry.url} alt={entry.file.name} style={{maxWidth:120,maxHeight:100}}/>:<a href={entry.url} target="_blank" rel="noreferrer">预览 {entry.file.name}</a>}<figcaption>{entry.purpose?`${entry.purpose} · `:''}{entry.error?`上传失败：${entry.error}`:entry.id?'已上传，尚未保存引用':'待上传 / 上传中'}</figcaption></figure>)}</div>:null;
 return {start,uploaded,failed,saved,url,view};
}
