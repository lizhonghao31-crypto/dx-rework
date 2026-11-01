import {useTodoContentRead} from "./todo-content-read.js";
import {useState} from 'react';
import {Button} from '@dx-rework/ui';
import type {BulkPreparationSheet} from '@dx-rework/contracts/bulk-preparation';
const local=(value:string|null|undefined)=>value?new Date(Date.parse(value)+8*3600000).toISOString().slice(0,16):'';
const instant=(value:string)=>value?new Date(`${value}:00+08:00`).toISOString():null;
export function BulkFabricPanel({sheet,busy,readonly,onSave}:{sheet:BulkPreparationSheet;busy:boolean;readonly:boolean;onSave:(path:string,input:unknown)=>Promise<void>}){
 const fabric=sheet.fabric,report=fabric?.report;
 const receipt=sheet.readiness?.facts.find(f=>f.kind==='fabric_receipt'&&f.scopeRef==='whole');
 const [material,setMaterial]=useState(report?.material??''),[arrival,setArrival]=useState(local(receipt?.occurredAt??report?.arrivedAt)),[inspection,setInspection]=useState(local(report?.inspectedAt));
 const [receiptVersion,setReceiptVersion]=useState(receipt?.version??0);
 const receiptChanged=Boolean(sheet.readiness&&(receipt?.version??0)!==receiptVersion);
 const [result,setResult]=useState(report?.result??''),[note,setNote]=useState(report?.note??''),[reason,setReason]=useState(''),[expanded,setExpanded]=useState(false);
 const readRef=useTodoContentRead({routeName:'digital_bulk_preparation',entityId:sheet.orderId,reportIds:report?[report.reportId]:[]},Boolean(expanded&&fabric?.report?.result==='不合格'&&!fabric.decision&&sheet.canDecideFabric));
 if(!fabric)return null;
 return <details ref={readRef} onToggle={e=>setExpanded(e.currentTarget.open)} className="bulk-fabric-panel"><summary>面料验布 · {fabric.usable?'可预缩':fabric.decision?'待处理':report?.result==='不合格'?'等待质量决定':report?'待完成验布':'未记录'}</summary>
 {report&&<p>{report.material} · {report.result??'检验中'}{fabric.decision&&` · ${fabric.decision.allowUse?'允许继续使用':'先处理'}：${fabric.decision.note}`}</p>}
 {!readonly&&sheet.canReportFabric&&<fieldset disabled={busy}><legend>验布报告</legend><div className="bulk-fabric-fields">
 <label>本单面料<input value={material} maxLength={200} onChange={e=>setMaterial(e.target.value)}/></label>
 <label>到仓时间（北京时间）<input type="datetime-local" readOnly={Boolean(receipt)} value={arrival} onChange={e=>setArrival(e.target.value)}/></label>
 <label>验布完成（北京时间）<input type="datetime-local" value={inspection} onChange={e=>setInspection(e.target.value)}/></label>
 <label>检验结论<select value={result} onChange={e=>setResult(e.target.value as typeof result)}><option value="">检验中</option><option>合格</option><option>不合格</option></select></label>
 </div><label>检验情况<textarea rows={2} maxLength={1000} value={note} onChange={e=>setNote(e.target.value)}/></label>
 <p>{receipt?`到仓依据引用原物料第${receiptVersion}版；到仓时间更正请在物料办理追加订正。`:"尚无到仓记录，可在此登记实际到仓并办理验布。"}</p>{receiptChanged&&<p role="alert">到仓依据已变化，原验布输入仍保留。<Button variant="secondary" onClick={()=>{setReceiptVersion(receipt?.version??0);setArrival(local(receipt?.occurredAt));setResult('');setInspection('');}}>按最新到仓依据重新办理验布</Button></p>}
 <Button disabled={receiptChanged||!material.trim()||!note.trim()||Boolean(result)!==Boolean(inspection)} onClick={()=>void onSave('/fabric-report',{expectedReportId:report?.reportId??null,...(sheet.readiness?{expectedReceiptVersion:receiptVersion}:{}),material,arrivedAt:instant(arrival),inspectedAt:instant(inspection),result:result||null,note})}>保存验布报告</Button></fieldset>}
 {!readonly&&sheet.canDecideFabric&&report?.result==='不合格'&&<fieldset disabled={busy}><legend>质量决定</legend><label>原因及后续安排<textarea rows={2} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label><div className="pattern-actions">{[false,true].map(allowUse=><Button key={String(allowUse)} variant={allowUse?'primary':'secondary'} disabled={!reason.trim()} onClick={()=>void onSave('/fabric-decision',{reportId:report.reportId,expectedDecisionId:fabric.decision?.decisionId??null,allowUse,note:reason})}>{allowUse?'允许继续使用':'先处理'}</Button>)}</div></fieldset>}
 </details>;
}
