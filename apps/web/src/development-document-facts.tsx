import {useTodoContentRead} from './todo-content-read.js';
import {DigitalReadFailure} from './digital-read-failure.js';
import {AttachmentIdentity} from './attachment-identity.js';
import {useEffect,useState} from 'react';
import type {DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import {digitalRequest} from './digital-production-api.js';
import {createWebUrls} from '../url-contract.js';
import type {DocumentCategory} from './order-document-container.js';
import type {DevelopmentSheetRead} from './digital-development-panel.js';
import type {useDevelopmentExecution} from './digital-development-execution-panel.js';
type Execution=NonNullable<ReturnType<typeof useDevelopmentExecution>['state']>;
const urls=createWebUrls(import.meta.env.BASE_URL);
/** All identities come from source/task facts. A report's legacy binding kind is not its purpose. */
export function DevelopmentDocumentFacts({sourceId,round,category,onRead}:{sourceId:string;round?:number|undefined;category:DocumentCategory;onRead?:DevelopmentSheetRead|undefined}){
 const [state,setState]=useState<Execution|null>(null),[sheet,setSheet]=useState<DevelopmentSheet|null>(null);
 const [executionError,setExecutionError]=useState<Error|null>(null),[sheetError,setSheetError]=useState<Error|null>(null),[executionRetry,setExecutionRetry]=useState(0),[sheetRetry,setSheetRetry]=useState(0);
 useEffect(()=>{let live=true;setState(null);setExecutionError(null);void digitalRequest<Execution>(`sources/${sourceId}/execution`).then(value=>{if(live)setState(value);}).catch(reason=>{if(live)setExecutionError(reason);});return()=>{live=false;};},[sourceId,round,executionRetry]);
 useEffect(()=>{let live=true;setSheet(null);setSheetError(null);void digitalRequest<DevelopmentSheet>(`sources/${sourceId}/development${round?`?round=${round}`:''}`).then(value=>{if(live){setSheet(value);onRead?.(value,round);}}).catch(reason=>{if(live)setSheetError(reason);});return()=>{live=false;};},[sourceId,round,sheetRetry,onRead]);
 const readRef=useTodoContentRead({routeName:'digital_development',entityId:sourceId,developmentRound:round??sheet?.roundNumber??1,reportIds:category==='materials'?state?.facts.filter(fact=>fact.kind==='面料报告').map(fact=>fact.factId):[]},Boolean(state&&sheet&&!executionError&&!sheetError&&category==='materials'));
 if(executionError||sheetError)return <>{executionError&&<DigitalReadFailure error={executionError} onRetry={()=>setExecutionRetry(value=>value+1)} retryLabel="重试读取办理事实"/>}{sheetError&&<DigitalReadFailure error={sheetError} onRetry={()=>setSheetRetry(value=>value+1)} retryLabel="重试读取开发资料"/>}</>;
 if(!state||!sheet)return <p role="status">正在读取原资料事实…</p>;
 const selectedRound=round??sheet.roundNumber??1;
 const taskIds=new Set(state.tasks.filter(task=>task.routeVersion===selectedRound).map(task=>task.taskId));
 const files=(ids:string[]|undefined)=>ids?.map((id,index)=><div key={id} className="development-result-attachment"><a href={urls.apiUrl(`digital-production/sources/${sourceId}/development/attachments/${id}`)} target="_blank" rel="noreferrer">查看原附件</a><AttachmentIdentity label={`附件 ${index+1}`} metadataPath={`sources/${sourceId}/development/attachments/${id}/metadata`}/></div>);
 if(category==='materials')return <section ref={readRef}><h2>面辅料与检测报告</h2><p>开发第 {selectedRound} 轮；报告按原来源登记，实际决定以原审批事实为准。</p>{sheet.document?.materials.map(item=><p key={item.materialId}>{item.category} · {item.label||item.name} · {item.specification} · 发布时{item.available?'已有实物':'未到'}{sheet.materialEvents.filter(event=>event.materialId===item.materialId).map(event=><span key={event.eventId}>；{event.action} {event.note}</span>)}</p>)}{state.facts.filter(fact=>['面料报告','面料决定'].includes(fact.kind)).map(fact=><article key={fact.factId}><h3>{fact.kind==='面料报告'?'检测报告':'实际决定'}</h3><p>{fact.payload.recommendation??fact.payload.decision} · {fact.payload.note}</p>{files(fact.payload.attachmentIds)}</article>)}</section>;
 if(category==='results'){const facts=[...state.facts.filter(fact=>fact.taskId&&taskIds.has(fact.taskId)),...state.routeFacts.filter(fact=>fact.routeVersion===selectedRound)].filter(fact=>fact.payload.attachmentIds?.length);return <section><h2>第 {selectedRound} 轮工序成果</h2>{state.tasks.filter(task=>task.routeVersion===selectedRound&&task.canExecute&&task.state==='ready'&&['development_pattern','development_sewing'].includes(task.taskKind)).map(task=><p key={task.taskId}><a href={`${urls.pageUrl('ui/digital-production')}?task=${task.taskId}&taskView=handle&workbench=sample`}>{task.label} · 上传并办理本任务成果</a></p>)}{facts.length?facts.map(fact=><article key={fact.factId}><h3>{fact.kind}</h3><p>{fact.payload.note}</p>{files(fact.payload.attachmentIds)}</article>):<p>本轮尚无已提交的成果附件；开发图不作为成果。</p>}</section>;}
 if(category==='customer')return <section><h2>第 {selectedRound} 轮客户确认与寄样资料</h2>{state.routeFacts.filter(fact=>fact.routeVersion===selectedRound&&['最终设计确认','客户样板确认','寄出'].includes(fact.kind)).map(fact=><p key={fact.factId}>{fact.kind} · {fact.payload.note} · {fact.payload.sentDate} {fact.payload.trackingNo}</p>)}{!state.routeFacts.some(fact=>fact.routeVersion===selectedRound&&fact.kind==='寄出')&&<p>本轮尚无寄样记录。</p>}<p>此处仅展示原事实，确认与寄样仍在当前办理执行。</p></section>;
 return <section><h2>其他关联单据</h2>{state.patternOrder?<a href={urls.pageUrl(`ui/pattern-room/orders/${state.patternOrder.orderId}`)}>查看原打板执行记录</a>:<p>没有可见的原打板关联记录。</p>}<p>合同及裁床资料沿原订单的授权关联入口查看。</p></section>;
}
