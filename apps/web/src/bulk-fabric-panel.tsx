import {useTodoContentRead} from "./todo-content-read.js";
import {useState} from 'react';
import {Button} from '@dx-rework/ui';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import type {BulkFabricBatchRef,BulkPreparationSheet} from '@dx-rework/contracts/bulk-preparation';
import {designerAstryxCss} from './designer-astryx.js';
const local=(value:string|null|undefined)=>value?new Date(Date.parse(value)+8*3600000).toISOString().slice(0,16):'';
const instant=(value:string)=>value?new Date(`${value}:00+08:00`).toISOString():null;
const batchId=(value:BulkFabricBatchRef['receipt'])=>JSON.stringify([value.recordId,value.version]);
const lotId=(value:BulkFabricBatchRef)=>value.lineId===undefined?batchId(value.receipt):
 JSON.stringify([value.materialId,value.lineId,value.receipt.recordId,value.receipt.version,value.quantityRowKey??null]);
export function BulkFabricPanel({sheet,busy,readonly,onSave}:{sheet:BulkPreparationSheet;busy:boolean;readonly:boolean;onSave:(path:string,input:unknown)=>Promise<void>}){
 const fabric=sheet.fabric,report=fabric?.report;
 const receipt=sheet.readiness?.facts.find(f=>f.kind==='fabric_receipt'&&f.scopeRef==='whole');
 const [material,setMaterial]=useState(report?.material??''),[arrival,setArrival]=useState(local(receipt?.occurredAt??report?.arrivedAt)),[inspection,setInspection]=useState(local(report?.inspectedAt));
 const [receiptVersion,setReceiptVersion]=useState(receipt?.version??0);
 const receiptChanged=Boolean(sheet.readiness&&(receipt?.version??0)!==receiptVersion);
 const [result,setResult]=useState(report?.result??''),[note,setNote]=useState(report?.note??''),[reason,setReason]=useState(''),[expanded,setExpanded]=useState(false);
 const [selected,setSelected]=useState<Set<string>>(()=>new Set(report?.receiptBatches?.map(lotId)));
 const readRef=useTodoContentRead({routeName:'digital_bulk_preparation',entityId:sheet.orderId,reportIds:report?[report.reportId]:[]},Boolean(expanded&&fabric?.report?.result==='不合格'&&!fabric.decision&&sheet.canDecideFabric));
 if(!fabric)return null;
 const qualification=fabric.warehouseInspection;
 const receipts=(sheet.readiness?.history??[]).filter(row=>row.kind==='fabric_receipt'&&row.warehouseReceipt);
 const replaced=new Set(receipts.flatMap(row=>row.warehouseReceipt?.replaces?[batchId(row.warehouseReceipt.replaces)]:[]));
 const lots:(BulkFabricBatchRef&{name:string;quantity:{quantity:string;unit:string};occurredAt:string})[]=qualification?.lots??receipts.filter(row=>row.valid&&row.occurredAt&&Number(row.warehouseReceipt?.quantity)>0&&!replaced.has(batchId(row)))
  .map(row=>({materialId:row.warehouseReceipt!.materialId,receipt:{recordId:row.recordId,version:row.version},
   name:row.quantities[0]?.name??'面料',quantity:{quantity:row.warehouseReceipt!.quantity,unit:row.warehouseReceipt!.unit},occurredAt:row.occurredAt!}));
 const active=lots.flatMap<BulkFabricBatchRef>(row=>selected.has(lotId(row))?[{
  materialId:row.materialId,receipt:row.receipt,...(row.lineId!==undefined?{lineId:row.lineId}:{}),
  ...(row.quantityRowKey?{quantityRowKey:row.quantityRowKey}:{}),
 }]:[]);
 return <details ref={readRef} onToggle={e=>setExpanded(e.currentTarget.open)} className={`bulk-fabric-panel${lots.length?' dx-designer-astryx':''}`}><summary>面料验布 · {fabric.usable?(fabric.decision?.allowUse?'已获准使用':'已合格'):fabric.decision?'待处理':report?.result==='不合格'?'等待质量决定':report?'待完成验布':qualification?.eligible?'达到验布门槛，待验布':qualification?'暂不可验布':'未记录'}</summary>
 {lots.length>0&&<style>{designerAstryxCss}</style>}
 {report&&<p>{report.material} · {report.result??'检验中'}{fabric.decision&&` · ${fabric.decision.allowUse?'允许继续使用':'先处理'}：${fabric.decision.note}`}</p>}
 {report?.inspectedAt&&fabric.warehouseCoverageCurrent===false&&<p role="alert">验布报告所用实际收料批次或适用范围已变化，原记录保留，请重新验布。</p>}
 {qualification?.writePaused&&<p role="status">{qualification.writePaused}</p>}
 {qualification&&!qualification.eligible&&<ul>{qualification.reasons.map((reason,index)=><li key={index}>{reason}</li>)}</ul>}
 {!readonly&&sheet.canReportFabric&&<fieldset disabled={busy||Boolean(qualification?.writePaused)||qualification?.eligible===false}><legend>验布报告</legend><div className="bulk-fabric-fields">
 <label>本单面料<input value={material} maxLength={200} onChange={e=>setMaterial(e.target.value)}/></label>
 <label>到仓时间（北京时间）<input type="datetime-local" readOnly={Boolean(receipt||qualification)} value={qualification?local(qualification.firstReceiptAt):arrival} onChange={e=>setArrival(e.target.value)}/></label>
 <label>验布完成（北京时间）<input type="datetime-local" value={inspection} onChange={e=>setInspection(e.target.value)}/></label>
 <label>检验结论<select value={result} onChange={e=>setResult(e.target.value as typeof result)}><option value="">检验中</option><option>合格</option><option>不合格</option></select></label>
 </div><label>检验情况<textarea rows={2} maxLength={1000} value={note} onChange={e=>setNote(e.target.value)}/></label>
 {(receipt||qualification)&&lots.length>0&&<fieldset><legend>本报告对应的实际收料批次</legend>{lots.map(row=>{
  const key=lotId(row);
  return <CheckboxInput key={key} label={`${row.name} · 第 ${row.receipt.version} 批 · ${row.quantity.quantity} ${row.quantity.unit} · ${local(row.occurredAt).replace('T',' ')}`}
   value={selected.has(key)} isDisabled={busy} onChange={checked=>setSelected(current=>{const next=new Set(current);if(checked)next.add(key);else next.delete(key);return next;})}/>;
 })}</fieldset>}
 <p>{qualification?'到仓数量和时间取自原实收批次，请在收料办理订正。':receipt?`到仓依据引用原物料第${receiptVersion}版；到仓时间更正请在物料办理追加订正。`:"尚无到仓记录，可在此登记实际到仓并办理验布。"}</p>{receiptChanged&&<p role="alert">到仓依据已变化，原验布输入仍保留。<Button variant="secondary" onClick={()=>{setReceiptVersion(receipt?.version??0);setArrival(local(receipt?.occurredAt));setResult('');setInspection('');}}>按最新到仓依据重新办理验布</Button></p>}
 <Button disabled={receiptChanged||!material.trim()||!note.trim()||Boolean(result)!==Boolean(inspection)||Boolean(active.length&&!inspection)||Boolean((report?.receiptBatches||qualification&&inspection)&&!active.length)||Boolean(qualification?.cutover&&(!inspection||!result))} onClick={()=>void onSave('/fabric-report',{expectedReportId:report?.reportId??null,...(sheet.readiness?{expectedReceiptVersion:receiptVersion}:{}),...(qualification?.basisRevision?{expectedWarehouseBasisRevision:qualification.basisRevision}:{}),material,arrivedAt:qualification?qualification.firstReceiptAt:receipt?.occurredAt??instant(arrival),inspectedAt:instant(inspection),result:result||null,note,...(active.length?{receiptBatches:active}:{})})}>保存验布报告</Button></fieldset>}
 {!readonly&&sheet.canDecideFabric&&report?.result==='不合格'&&<fieldset disabled={busy||Boolean(qualification?.writePaused)||fabric.warehouseCoverageCurrent===false}><legend>质量决定</legend><label>原因及后续安排<textarea rows={2} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label><div className="pattern-actions">{[false,true].map(allowUse=><Button key={String(allowUse)} variant={allowUse?'primary':'secondary'} disabled={!reason.trim()} onClick={()=>void onSave('/fabric-decision',{reportId:report.reportId,expectedDecisionId:fabric.decision?.decisionId??null,allowUse,note:reason})}>{allowUse?'允许继续使用':'先处理'}</Button>)}</div></fieldset>}
 </details>;
}
