import {useCallback} from 'react';
import {Button} from '@astryxdesign/core/Button';
import {Link} from '@astryxdesign/core/Link';
import {DigitalIdSchema} from '@dx-rework/contracts/digital-production';
import type {BulkWashingSheet} from '@dx-rework/contracts/bulk-washing';
import type {FactoryFlowSheet} from '@dx-rework/contracts/factory-flow';
import type {QcProductionProgressSheet, QcProgressRecord} from '@dx-rework/contracts/qc-production-progress';
import {createWebUrls} from '../url-contract.js';
import {digitalRequest} from './digital-production-api.js';
import {useForegroundRead} from './use-foreground-read.js';
import {useForegroundWait} from './foreground-loading.js';
import {DesignerOriginalShell} from './designer-original-shell.js';
import {washingFactLabel} from './bulk-washing-actions.js';

const kinds=['fact','check','ship'] as const;
type Kind=typeof kinds[number];
type FactoryTarget={kind:Kind;id:string};
type QcTarget={kind:'qc';id:string;productionId:string;decisionId:string|null;revision:number};
type WashingTarget={kind:'washing';id:string;scopeId:string};
type Target=FactoryTarget|QcTarget|WashingTarget;
const urls=createWebUrls(import.meta.env.BASE_URL);
export function readFactoryOriginalSearch(search:string):Target|null|undefined{
 const query=new URLSearchParams(search);
 const qualifierKeys=['qcProductionId','qcDecisionId','qcRevision'];
 const scopeKey='originalWashingScope';
 if(!['originalFactory','originalFactoryId',scopeKey,...qualifierKeys].some(key=>query.has(key)))return undefined;
 const id=DigitalIdSchema.safeParse(query.get('originalFactoryId'));
 if(!id.success||query.getAll('originalFactory').length!==1||query.getAll('originalFactoryId').length!==1)return null;
 if(query.get('originalFactory')==='washing'){
  const scopeId=query.get(scopeKey);
  return scopeId&&scopeId.length<=300&&query.getAll(scopeKey).length===1&&!qualifierKeys.some(key=>query.has(key))
   ?{kind:'washing',id:id.data,scopeId}:null;
 }
 if(query.has(scopeKey))return null;
 if(query.get('originalFactory')==='qc'){
  const productionId=DigitalIdSchema.safeParse(query.get('qcProductionId'));
  const decisionValue=query.get('qcDecisionId');
  const decisionId=decisionValue==='original'?null:DigitalIdSchema.safeParse(decisionValue);
  const rawRevision=query.get('qcRevision')??'',revision=Number(rawRevision);
  if(qualifierKeys.some(key=>query.getAll(key).length!==1)||!productionId.success||
   (decisionId!==null&&!decisionId.success)||!/^[1-9]\d*$/.test(rawRevision)||!Number.isSafeInteger(revision))return null;
  return {kind:'qc',id:id.data,productionId:productionId.data,decisionId:decisionId?.data??null,revision};
 }
 if(qualifierKeys.some(key=>query.has(key)))return null;
 const kind=kinds.find(value=>value===query.get('originalFactory'));
 return kind?{kind,id:id.data}:null;
}

function selectOriginal(sheet:FactoryFlowSheet,target:FactoryTarget){
 const lineLabel=(lineId:string)=>{
  const line=sheet.lines.find(value=>value.lineId===lineId);
  return line?[line.poNumber??'待补PO',line.color].filter(Boolean).join(' · '):null;
 };
 if(target.kind==='ship'){
  const shipment=sheet.shipSamples?.find(item=>item.eventId===target.id);
  return shipment?{label:'船样寄出',at:shipment.occurredAt,by:shipment.operatorName,
   lines:shipment.lineIds.flatMap(id=>lineLabel(id)??[]),details:[['快递单号',shipment.trackingNumber] as const],attachments:[]}:null;
 }
 if(target.kind==='check'){
  const check=sheet.checks.find(item=>item.checkId===target.id),line=check&&lineLabel(check.lineId);
  return check&&line?{label:'原工艺检查',at:check.checkedAt,by:check.checkedBy,lines:[line],
   details:[['原检查结果',check.result],['问题',check.problem],['处理',check.treatment]] as const,attachments:check.attachmentIds}:null;
 }
 const fact=sheet.facts.find(item=>item.factId===target.id);
 if(!fact)return null;
 const rows=Array.isArray(fact.payload.lines)?fact.payload.lines:[];
 const lines=rows.flatMap(item=>{
  if(!item||typeof item!=='object'||typeof item.lineId!=='string')return [];
  const line=lineLabel(item.lineId);
  if(!line)return [];
  return [typeof item.quantity==='number'?`${line} · ${item.quantity} 件`:line];
 });
 const fields=[['原加工厂',fact.payload.supplier],['原记录说明',fact.payload.note]] as const;
 const details=fields.flatMap(([label,value])=>typeof value==='string'&&value?[[label,value] as const]:[]);
 return {label:fact.kind,at:fact.occurredAt,by:fact.actorName,lines,details,attachments:[]};
}

type Props={orderId:string;onClose():void};
export function FactoryFlowOriginal({target,...props}:Props&{target:Target|null}){
 if(target?.kind==='washing')return <WashingOriginal {...props} target={target}/>;
 return target?.kind==='qc'?<QcProgressOriginal {...props} target={target}/>:<OperationalFactoryOriginal {...props} target={target}/>;
}

function WashingOriginal({orderId,target,onClose}:Props&{target:WashingTarget}){
 const load=useCallback(async(signal:AbortSignal)=>{
  const sheet=await digitalRequest<BulkWashingSheet>(`orders/${orderId}/bulk-washing`,'GET',undefined,undefined,{signal});
  if(sheet.orderId!==orderId||!Array.isArray(sheet.scopes))throw Error('洗水原记录与本单不一致。');
  return sheet;
 },[orderId]);
 const reader=useForegroundRead(orderId,JSON.stringify(target),load);
 useForegroundWait(reader.foregroundKey);
 const scope=reader.value?.scopes.find(item=>item.scopeId===target.scopeId);
 const original=scope?.facts.find(item=>item.id===target.id&&item.scopeId===scope.scopeId);
 return <DesignerOriginalShell title={`${original?washingFactLabel(original):'洗水原记录'} · 只读`} onClose={onClose}>
  {reader.error?<p role="alert">{reader.error.message}<Button label="重新读取洗水原记录" size="sm" onClick={reader.retry}/></p>:
   original&&scope?<dl>
    <div><dt>原批次</dt><dd>{scope.label}</dd></div>
    <div><dt>实际发生</dt><dd>{original.occurredAt?qcTime(original.occurredAt):'未登记'}</dd></div>
    <div><dt>登记时间及人员</dt><dd>{qcTime(original.recordedAt)} · {original.operator}</dd></div>
    <div><dt>本次数量</dt><dd>{original.quantity} 件</dd></div>
    {original.kind==='inspection'&&<div><dt>本次合格</dt><dd>{original.qualifiedQuantity} 件</dd></div>}
    {original.note&&<div><dt>原记录说明</dt><dd>{original.note}</dd></div>}
    {original.voided&&<div><dt>原记录状态</dt><dd>已作废</dd></div>}
   </dl>:reader.value?<p role="alert">找不到所选批次的洗水原记录，请返回原单核对。</p>:<p role="status">正在读取所选洗水原记录…</p>}
 </DesignerOriginalShell>;
}

function OperationalFactoryOriginal({orderId,target,onClose}:Props&{target:FactoryTarget|null}){
 const load=useCallback(async(signal:AbortSignal)=>{
  const sheet=await digitalRequest<FactoryFlowSheet>(`orders/${orderId}/factory-flow`,'GET',undefined,undefined,{signal});
  if(sheet.orderId!==orderId||!Array.isArray(sheet.lines)||!Array.isArray(sheet.facts)||!Array.isArray(sheet.checks))
   throw Error('工厂原记录与本单不一致。');
  return sheet;
 },[orderId]);
 const reader=useForegroundRead(orderId,target?`${target.kind}:${target.id}`:null,load);
 useForegroundWait(reader.foregroundKey);
 const original=reader.value&&target?selectOriginal(reader.value,target):null;
 return <DesignerOriginalShell onClose={onClose} title={`${original?.label??'工厂原记录'} · 只读`}>
  {!target||reader.value&&!original?<p role="alert">找不到选中的工厂原记录，请返回原单核对。</p>:reader.error?
   <p role="alert">{reader.error.message}<Button label="重新读取工厂原记录" size="sm" onClick={reader.retry}/></p>:original?
   <><p>{original.at?new Date(original.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'实际时间未登记'} · {original.by}</p>
    {original.lines.length>0&&<ul>{original.lines.map(line=><li key={line}>{line}</li>)}</ul>}
    {original.details.some(([,value])=>value)&&<dl>{original.details.filter(([,value])=>value).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
    {original.attachments.map(id=><Link key={id} href={urls.apiUrl(`digital-production/orders/${orderId}/factory-flow/attachments/${id}`)} target="_blank" rel="noreferrer">查看检查图片</Link>)}
   </>:<p role="status">正在读取所选工厂原记录…</p>}
 </DesignerOriginalShell>;
}

const qcObservationLabels={not_started:'尚未开工',working:'进行中',stopped:'暂停',finished:'已完成'};
const qcTime=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});
const qcPercent=(value:number|null)=>value===null?'—':`${value}%`;

function QcProgressOriginal({orderId,target,onClose}:Props&{target:QcTarget}){
 const load=useCallback(async(signal:AbortSignal)=>{
  const sheet=await digitalRequest<QcProductionProgressSheet>(`orders/${orderId}/qc-progress`,'GET',undefined,undefined,{signal});
  if(sheet.orderId!==orderId||!Array.isArray(sheet.executions)||
   (sheet.archivedExecutions!==undefined&&!Array.isArray(sheet.archivedExecutions)))throw Error('QC资料与当前订单不一致。');
  return sheet;
 },[orderId]);
 const reader=useForegroundRead(orderId,JSON.stringify(target),load);
 useForegroundWait(reader.foregroundKey);
 const matches=reader.value&&[...reader.value.executions,...(reader.value.archivedExecutions??[])].filter(execution=>
  execution.productionId===target.productionId&&execution.factoryDecisionId===target.decisionId);
 const execution=matches?.length===1?matches[0]:undefined;
 const matchingRecords=execution?.records.filter(record=>record.kind==='progress'&&record.recordId===target.id&&record.revision===target.revision);
 const record=matchingRecords?.length===1?matchingRecords[0]:undefined;
 const photos=record&&execution?.records.filter(item=>item.kind==='photos'&&item.relatedProgressRecordId===record.recordId)||[];
 const photoLinks=(item:QcProgressRecord)=>item.attachmentIds.map((id,index)=>
  <Link key={id} href={urls.apiUrl(`digital-production/orders/${orderId}/qc-progress/attachments/${id}`)} target="_blank" rel="noreferrer">现场照片 {index+1}</Link>);
 return <DesignerOriginalShell onClose={onClose} title={`QC进度 · 第 ${target.revision} 版 · 只读`}>
  {reader.error?<p role="alert">{reader.error.message}<Button label="重新读取QC原记录" size="sm" onClick={reader.retry}/></p>:
   record&&execution?<>
    <p>{execution.supplierName} · {record.actorName}</p>
    <dl>
     <div><dt>实际采集</dt><dd>{record.collectedAt?qcTime(record.collectedAt):'未登记'}</dd></div>
     <div><dt>记录时间</dt><dd>{qcTime(record.recordedAt)}</dd></div>
     {record.note&&<div><dt>原记录说明</dt><dd>{record.note}</dd></div>}
     {record.criticalEvents.length>0&&<div><dt>关键事件</dt><dd>{record.criticalEvents.map(event=>event==='cut_start'?'开裁':event==='first_piece'?'首件':event).join('、')}</dd></div>}
    </dl>
    <ul>{record.observations.map(observation=>{
     const line='lines'in execution?execution.lines.find(item=>item.lineId===observation.lineId):undefined;
     return <li key={observation.lineId}>
      <strong>{line?[line.poNumber??'PO待补',line.color].filter(Boolean).join(' · '):'原记录PO／款色'}</strong>
      <p>{qcObservationLabels[observation.state]} · 记录范围 {observation.allocationQuantity} 件 · 裁剪 {qcPercent(observation.cuttingPercent)} · 车缝 {qcPercent(observation.sewingPercent)} · 整烫 {qcPercent(observation.ironingPercent)}</p>
      {observation.additionalFinishedQuantity!==undefined&&<p>本次新增成品 {observation.additionalFinishedQuantity} 件</p>}
      {observation.reason&&<p>{observation.reason}</p>}
     </li>;
    })}</ul>
    {photoLinks(record)}
    {photos.map(photo=><section key={photo.recordId}>
     <h3>本次采集的补传照片</h3><p>{qcTime(photo.recordedAt)} · {photo.actorName}</p>
     {photo.note&&<p>{photo.note}</p>}{photoLinks(photo)}
    </section>)}
   </>:reader.value?<p role="alert">找不到所选厂单的QC原记录或版本，请返回原单核对。</p>:<p role="status">正在读取所选QC原记录…</p>}
 </DesignerOriginalShell>;
}
