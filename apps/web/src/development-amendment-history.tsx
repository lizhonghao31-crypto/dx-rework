import {useRef,useState} from "react";
import {Button} from "@dx-rework/ui";
import type {DevelopmentDocument,DevelopmentSheet} from "@dx-rework/contracts/digital-development";
import {digitalRequest} from "./digital-production-api.js";
import {DevelopmentPrint} from "./digital-development-print.js";
type Snapshot={version:number;document:DevelopmentDocument;published_at:string;reason?:string};
type History={original:Snapshot|null;revisions:Snapshot[]};
export function DevelopmentAmendmentHistory({sheet,imageUrl}:{sheet:DevelopmentSheet;imageUrl:(id:string)=>string}){
 const [history,setHistory]=useState<History|null>(null),[error,setError]=useState(""),[version,setVersion]=useState<number|null>(null),[busy,setBusy]=useState(false),loading=useRef(false);
 const load=async()=>{if(loading.current)return;loading.current=true;setBusy(true);try{setHistory(await digitalRequest<History>(`sources/${sheet.sourceId}/development/amendment/history?round=${sheet.roundNumber??1}`));setError("");}catch(cause){setError(cause instanceof Error?cause.message:"资料修订记录未读取成功");}finally{loading.current=false;setBusy(false);}};
 const snapshots=history?[...(history.original?[history.original]:[]),...history.revisions]:[],selected=snapshots.find(row=>row.version===version)??snapshots[0];
 return <details className="development-amendment-history" onToggle={event=>{if(event.currentTarget.open&&!history)void load();}}><summary>本轮原发布快照与资料修订记录</summary>{error&&<><p role="alert">{error}</p><Button type="button" disabled={busy} onClick={()=>void load()}>重读资料修订记录</Button></>}{busy&&<p role="status">正在读取本轮资料记录…</p>}{history&&<><p>原发布快照保留；补正只追加资料修订，不增加制作轮次。</p><label>查看资料快照<select value={selected?.version??""} onChange={event=>setVersion(Number(event.target.value))}>{snapshots.map((row,index)=><option key={row.version} value={row.version}>{index===0?"原发布快照":"补正修订"} {row.version} · {new Date(row.published_at).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}</option>)}</select></label>{selected&&<><p>{selected.reason||"原始发布资料，未被补正覆盖"}</p><DevelopmentPrint sheet={{...sheet,version:selected.version,materialEvents:[]}} document={selected.document} imageUrl={imageUrl}/></>}</>}</details>;
}
