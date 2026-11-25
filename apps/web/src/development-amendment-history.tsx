import {useEffect,useRef,useState} from "react";
import {Button} from "@dx-rework/ui";
import type {DevelopmentPublishedVersion,DevelopmentSheet} from "@dx-rework/contracts/digital-development";
import {digitalRequest} from "./digital-production-api.js";
import {DevelopmentPrint} from "./digital-development-print.js";
import {developmentPrintAttachmentMime,useDevelopmentPrint} from "./development-print-preview.js";
import {publishedDevelopmentPrintSheet} from "./development-published-document.js";
import {createWebUrls} from "../url-contract.js";

type Snapshot={version:number;published_at:string;reason?:string};
type History={original:Snapshot|null;revisions:Snapshot[]};
const urls=createWebUrls(import.meta.env.BASE_URL);

export function DevelopmentAmendmentHistory({sheet}:{sheet:DevelopmentSheet}){
 return <RoundHistory key={`${sheet.sourceId}:${sheet.roundNumber??1}`} sourceId={sheet.sourceId} round={sheet.roundNumber??1}/>;
}
function RoundHistory({sourceId,round}:{sourceId:string;round:number}){
 const [history,setHistory]=useState<History|null>(null),[error,setError]=useState(""),[version,setVersion]=useState<number|null>(null),[busy,setBusy]=useState(false),loading=useRef(false);
 const load=async()=>{
  if(loading.current)return;
  loading.current=true;setBusy(true);
  try{setHistory(await digitalRequest<History>(`sources/${sourceId}/development/amendment/history?round=${round}`));setError("");}
  catch(cause){setError(cause instanceof Error?cause.message:"资料修订记录未读取成功");}
  finally{loading.current=false;setBusy(false);}
 };
 const snapshots=history?[...(history.original?[history.original]:[]),...history.revisions]:[],selected=snapshots.find(row=>row.version===version)??snapshots[0];
 return <details className="development-amendment-history" onToggle={event=>{if(event.currentTarget.open&&!history)void load();}}>
  <summary>本轮原发布快照与资料修订记录</summary>
  {error&&<><p role="alert">{error}</p><Button type="button" disabled={busy} onClick={()=>void load()}>重读资料修订记录</Button></>}
  {busy&&<p role="status">正在读取本轮资料记录…</p>}
  {history&&<><p>原发布快照保留；补正只追加资料修订，不增加制作轮次。</p>
   <label>查看资料快照<select value={selected?.version??""} onChange={event=>setVersion(Number(event.target.value))}>{snapshots.map((row,index)=><option key={row.version} value={row.version}>{index===0?"原发布快照":"补正修订"} {row.version} · {new Date(row.published_at).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}</option>)}</select></label>
   {selected&&<><p>{selected.reason||"原始发布资料，未被补正覆盖"}</p>
    <SelectedVersion key={selected.version} sourceId={sourceId} round={round} version={selected.version}/>
   </>}
  </>}
 </details>;
}
function SelectedVersion({sourceId,round,version}:{sourceId:string;round:number;version:number}){
 const print=useDevelopmentPrint();
 const [value,setValue]=useState<DevelopmentPublishedVersion|null>(null),[error,setError]=useState(""),[attempt,setAttempt]=useState(0);
 const path=`sources/${sourceId}/development/versions/${version}`;
 useEffect(()=>{
  let live=true;
  const read=async()=>{
   try{
    const data=await digitalRequest<DevelopmentPublishedVersion>(`${path}?round=${round}`);
    if(data.sourceId!==sourceId||data.roundNumber!==round||data.documentVersion!==version)throw Error("未取得所选原版，不能用其他资料替代打印。");
    if(live)setValue(data);
   }catch(reason){if(live)setError(reason instanceof Error?reason.message:"所选资料快照未读取成功");}
  };
  void read();
  return()=>{live=false;};
 },[path,sourceId,round,version,attempt]);
 const attachmentPath=(id:string)=>`${path}/attachments/${id}`;
 return <>
  {!value&&!error&&<p role="status">正在读取所选原版…</p>}
  {error&&<><p role="alert">{error}</p><Button type="button" onClick={()=>{setError("");setAttempt(count=>count+1);}}>重读所选版本</Button></>}
  <Button type="button" disabled={!value||print.busy}
   onClick={()=>void print.preview(developmentPrintAttachmentMime(id=>`${attachmentPath(id)}/metadata?round=${round}`))}>
   {print.busy?"正在准备打印…":"打印所选版本 / 保存 PDF"}
  </Button>
  {print.error&&<p role="alert">{print.error}</p>}
  {value&&<DevelopmentPrint printRef={print.ref} sheet={publishedDevelopmentPrintSheet(value)} document={value.document}
   imageUrl={id=>urls.apiUrl(`digital-production/${attachmentPath(id)}?round=${round}`)}/>}
 </>;
}
