import {useEffect,useRef,useState} from 'react';
import {Button} from '@dx-rework/ui';
import type {FactoryFlowSheet} from '@dx-rework/contracts/factory-flow';
import {createWebUrls} from '../url-contract.js';
import {useScopedQualityPhotos} from './garment-quality-photos.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';

type PhotoDraft={attachmentIds:string[];blocked:boolean};
type Check=NonNullable<FactoryFlowSheet['productionChecks']>[number];
type Inspection=NonNullable<FactoryFlowSheet['productionInspectionHistory']>[number];
export type FactoryInspectionFocus=Pick<Check,'productionId'|'factoryDecisionId'|'lineId'>;
const {apiUrl}=createWebUrls(import.meta.env.BASE_URL);
const scopePath=(orderId:string,productionId:string,factoryDecisionId:string|null,lineId:string)=>
 `orders/${orderId}/factory-flow/production-qc/${productionId}/${factoryDecisionId??'original'}/${lineId}`;
const scopeKey=(row:FactoryInspectionFocus)=>JSON.stringify([row.productionId,row.factoryDecisionId,row.lineId]);

function FactoryQcPhotoDraft({orderId,row,savedPhotos,register,saving}:{orderId:string;row:Check;savedPhotos:ReadonlySet<string>;register:Map<string,PhotoDraft>;saving:boolean}){
 const key=scopeKey(row),photos=useScopedQualityPhotos(scopePath(orderId,row.productionId,row.factoryDecisionId,row.lineId),'工厂检查报告图片');
 const local=photos.attachmentIds.filter(id=>!savedPhotos.has(id));
 useDigitalDetailNavigationGuard(local.length>0||photos.unready,saving||photos.busy,photos.inFlight,'加工检查报告图片尚未保存，仍要离开？');
 useEffect(()=>{
  register.set(key,{attachmentIds:local,blocked:photos.busy||photos.unready});
  return()=>{register.delete(key);};
 });
 useEffect(()=>{
  if(!photos.attachmentIds.length||photos.unready||photos.busy||local.length!==0)return;
  // Clear only the draft photos actually present on an acknowledged original
  // check. An unrelated refresh or another PO never discards unsaved files.
  photos.clear();
 });
 return photos.controls;
}

function InspectionHistory({orderId,events,lines}:{orderId:string;events:readonly Inspection[];lines:FactoryFlowSheet['lines']}){
 if(!events.length)return null;
 return <details><summary>工厂检查历史</summary>{events.map(event=><section key={event.eventId}>
  <p>{event.supplierName??'原检查工厂待核'} · {event.occurredAt?new Date(event.occurredAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'实际时间未知'} · {event.operator}</p>
  {event.checks.map(check=><div key={check.lineId}><p>{lines.find(line=>line.lineId===check.lineId)?.poNumber??'待补PO'} · {check.result} {check.problem}</p>
   {event.productionId&&check.attachmentIds?.map((id,index)=><a key={id} href={apiUrl(`digital-production/${scopePath(orderId,event.productionId!,event.factoryDecisionId,check.lineId)}/history/${event.eventId}/attachments/${id}`)} target="_blank" rel="noreferrer">查看原质检图片 {index+1}</a>)}
  </div>)}
 </section>)}</details>;
}

export function FactoryProductionQcPanel({sheet,busy,paused,open,save,focus}:{sheet:FactoryFlowSheet;busy:boolean;paused:boolean;open:boolean;save:(path:string,body:Record<string,unknown>)=>Promise<void>;focus?:FactoryInspectionFocus}){
 const rows=focus?(sheet.productionChecks??[]).filter(row=>scopeKey(row)===scopeKey(focus)):(sheet.productionChecks??[]);
 const history=focus?(sheet.productionInspectionHistory??[]).filter(event=>event.productionId===focus.productionId&&event.factoryDecisionId===focus.factoryDecisionId&&event.checks.some(check=>check.lineId===focus.lineId))
  .map(event=>({...event,checks:event.checks.filter(check=>check.lineId===focus.lineId)})):(sheet.productionInspectionHistory??[]);
 const factories=[...new Set(rows.map(row=>row.factoryDecisionId))],register=useRef(new Map<string,PhotoDraft>());
 const [error,setError]=useState(''),savedPhotos=new Set(history.flatMap(event=>event.checks.flatMap(check=>check.attachmentIds??[])));
 if(focus&&rows.length!==1)return <p role="alert">原加工检查的工厂或 PO 范围已变更，请返回质量中心刷新。</p>;
 return <details className="factory-production-qc" open={open}><summary>工厂成衣QC</summary><p>检查完成与质量结论分别记录。</p>
  {error&&<p role="alert">{error}</p>}
  {factories.map(factory=>{
   const lines=rows.filter(row=>row.factoryDecisionId===factory);
   return <section key={factory??'original'}><h3>{lines[0]?.supplierName}</h3>{sheet.canProductionQc?<form onSubmit={event=>{
    event.preventDefault();setError('');
    const fields=new FormData(event.currentTarget),selected=lines.filter(row=>fields.get(`result:${row.lineId}`));
    if(selected.some(row=>register.current.get(scopeKey(row))?.blocked)){setError('本次检查所选 PO 还有未就绪的报告图片，请重试或移除。');return;}
    const checks=selected.map(row=>{
     const ids=register.current.get(scopeKey(row))?.attachmentIds??[];
     return {lineId:row.lineId,result:String(fields.get(`result:${row.lineId}`)),problem:String(fields.get(`problem:${row.lineId}`)??''),...(ids.length?{attachmentIds:ids}:{})};
    });
    if(checks.reduce((total,row)=>total+(row.attachmentIds?.length??0),0)>10){setError('每次检查最多10张图片，请按实际 PO 分次办理。');return;}
    void save('/production-qc',{factoryDecisionId:factory,occurredAt:new Date(`${String(fields.get('at'))}+08:00`).toISOString(),checks,note:''});
   }}><fieldset disabled={busy||paused}><legend>本次检查</legend><label>检查完成时间（北京时间）<input name="at" type="datetime-local" required/></label>
    {lines.map(row=><section key={scopeKey(row)} className="factory-batch-qc"><h4>{row.poNumber??'待补PO'} · {row.color} · 原生产范围 {row.quantity} 件 · {row.result??'未检查'}</h4><label>本次结论<select name={`result:${row.lineId}`} defaultValue=""><option value="">本次不登记</option><option>合格</option><option>需处理</option></select></label><label>质量问题／处理说明<input name={`problem:${row.lineId}`} maxLength={2000}/></label>{row.problem&&<p>{row.problem}</p>}
     <FactoryQcPhotoDraft orderId={sheet.orderId} row={row} savedPhotos={savedPhotos} register={register.current} saving={busy}/>
    </section>)}<Button type="submit">保存工厂检查</Button></fieldset></form>:lines.map(row=><p key={scopeKey(row)}>{row.poNumber??'待补PO'} · {row.color} · {row.inspected?'已检查':'未检查'} · {row.result??'—'} {row.problem}</p>)}</section>;
  })}<InspectionHistory orderId={sheet.orderId} events={history} lines={sheet.lines}/>
 </details>;
}
