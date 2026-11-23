import {useCallback,useState} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Link} from '@astryxdesign/core/Link';
import {createWebUrls} from '../url-contract.js';
import {useForegroundRead} from './use-foreground-read.js';
import {useForegroundWait} from './foreground-loading.js';
import {loadExactTechnicalOriginal,loadTechnicalEntry} from './cockpit-documents-technical.js';
import type {CockpitDocumentEntry,CockpitDocumentReader} from './cockpit-document-data.js';
import {feedbackFetch,feedbackJson} from './request-response-feedback.js';
import {readTechnicalOriginalSearch} from './technical-original-route.js';
import {DesignerOriginalShell} from './designer-original-shell.js';
import {digitalChildDetailHref} from './digital-detail-route.js';
import {DigitalIdSchema} from '@dx-rework/contracts/digital-production';

const urls=createWebUrls(import.meta.env.BASE_URL);
const read:CockpitDocumentReader=async(path,signal)=>feedbackJson(
 await feedbackFetch(urls.apiUrl(path),{credentials:'include',cache:'no-store',signal}),'GET',value=>value,
);

function OriginalEvidence({entry}:{entry:CockpitDocumentEntry}){
 const [requested,request]=useState(false);
 const load=useCallback((signal:AbortSignal)=>loadTechnicalEntry(entry,read,signal),[entry]);
 const loaded=useForegroundRead(entry.id,requested&&entry.load?entry.id:null,load);
 useForegroundWait(loaded.foregroundKey);
 const current=loaded.value??entry;
 const originalTask=current.url?.startsWith('/ui/digital-production?task=')?new URL(current.url,'https://local.invalid'):null;
 const task=DigitalIdSchema.safeParse(originalTask?.searchParams.get('task'));
 const taskLink=task.success&&originalTask?.searchParams.get('taskView')==='read'
  ?digitalChildDetailHref(`/ui/digital-production?task=${task.data}&taskView=read`,location.pathname+location.search,urls.base):null;
 return <>
  {current.note&&<p>{current.note}</p>}
  {current.metadata?.map(meta=><p key={meta.label}>{meta.label} {meta.at||'未登记'}{meta.by&&` · ${meta.by}`}</p>)}
  {current.files?.length?<ul>{current.files.map(file=><li key={file.id}>{file.path?
   <Link href={urls.apiUrl(file.path)} target="_blank" rel="noreferrer">{file.name}</Link>:file.name}
  </li>)}</ul>:null}
  {current.load&&!requested&&<Button label="查看此原件" size="sm" onClick={()=>request(true)}/>}
  {taskLink&&<p><Link href={taskLink}>查看原尺寸复核</Link></p>}
  {loaded.waiting&&<p role="status">正在读取选中的原件…</p>}
  {loaded.error&&<p role="alert">{loaded.error.message}<Button label="重新读取原件" size="sm" onClick={loaded.retry}/></p>}
  {current.children?.length?<ul>{current.children.map(child=><li key={child.id}>
   <strong>{child.label}</strong><OriginalEvidence entry={child}/>
  </li>)}</ul>:null}
 </>;
}

export function DevelopmentTechnicalOriginal({sourceId,onClose}:{sourceId:string;onClose():void}){
 const search=window.location.search,target=readTechnicalOriginalSearch(search);
 const load=useCallback((signal:AbortSignal)=>{
  const selection=readTechnicalOriginalSearch(search);
  if(!selection)throw Error('找不到选中的技术原件。');
  return loadExactTechnicalOriginal(sourceId,selection,read,signal);
 },[sourceId,search]);
 const reader=useForegroundRead(sourceId,target?search:null,load);
 useForegroundWait(reader.foregroundKey);
 const title=(target?.kind==='comment'?'原客户评语':'原技术成果')+(target?` · 第 ${target.round} 轮 v${target.version}`:'')+' · 只读';
 return <DesignerOriginalShell title={title} onClose={onClose}>
  {!target?<p role="alert">原件编号、轮次或版本无效，请返回原单选择。</p>:reader.error?
   <p role="alert">{reader.error.message}<Button label="重新读取原件" size="sm" onClick={reader.retry}/></p>:reader.value?
   <OriginalEvidence key={`${sourceId}:${search}`} entry={reader.value}/>:<p role="status">正在读取选中的技术原件…</p>}
 </DesignerOriginalShell>;
}
