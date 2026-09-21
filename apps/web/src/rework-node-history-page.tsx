import { ReworkNodeHistorySchema, type ReworkNodeHistory, type FinanceNodeKey } from '@dx-rework/contracts/reporting';
import { ResponsiveFactsTable, Surface } from '@dx-rework/ui';
import { useEffect, useState } from 'react';
import { Header, Shell } from './components.js';
import { InspectionReportReadonly } from './inspection-report-readonly.js';
import { ImageViewer } from './image-viewer.js';
import { createWebUrls } from '../url-contract.js';
import './rework-governed.css';
const {apiUrl,pageUrl}=createWebUrls(import.meta.env.BASE_URL);
const labels: Record<string,string>={approved:'同意',rejected:'驳回',pending_ie_review:'待 IE 核价',draft:'草稿',piece:'件',hour:'小时',own_factory:'本厂',processing_factory:'加工厂',embroidery_factory:'印绣花厂',washing_factory:'洗水厂',fabric_supplier:'面料商',internal:'正式工',temporary:'临时工'};
const display=(value:string|null)=>value===null?'历史未记录':labels[value]??(/^\d{4}-\d{2}-\d{2}[T ]/.test(value)?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):value);
export function reworkHistoryHref(orderId:string,node?:string,entryId?:string) {
 const query=new URLSearchParams(window.location.search);
 query.delete('node');query.delete('view');query.delete('entryId');
 if(node){query.set('node',node);query.set('view','node-history');}
 if(entryId)query.set('entryId',entryId);
 return `${pageUrl(`ui/tasks/${orderId}`)}${query.size?`?${query}`:''}`;
}
export function ReworkNodeHistoryPage({orderId,node}:{orderId:string;node:FinanceNodeKey}) {
 const [data,setData]=useState<ReworkNodeHistory|null>(null);const [error,setError]=useState('');
 const [image,setImage]=useState<ReworkNodeHistory['attachments'][number]|null>(null);
 const entryId=new URLSearchParams(window.location.search).get('entryId');
 useEffect(()=>{const controller=new AbortController();setData(null);setError('');
  const query=entryId?`?${new URLSearchParams({entryId})}`:'';
  void fetch(apiUrl(`rework-orders/${orderId}/history/${node}${query}`),{credentials:'include',signal:controller.signal,cache:'no-store'})
   .then(async response=>{if(!response.ok){const body=await response.json().catch(()=>null) as {error?:{message?:string}}|null;throw new Error(body?.error?.message??'历史页面加载失败');}return ReworkNodeHistorySchema.parse(await response.json());})
   .then(value=>{if(!controller.signal.aborted)setData(value);}).catch((reason:unknown)=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'历史页面加载失败');});
  return()=>controller.abort();
 },[orderId,node,entryId]);
 useEffect(()=>{if(!image)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setImage(null);};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[image]);
 return <Shell active="全部订单"><div className="rework-governed rework-history" data-dx-ui="governed">
  {!data?<div aria-busy={!error}><p role="status">{error||'正在加载历史页面…'}</p>{error?<a className="dx-button" href={reworkHistoryHref(orderId)}>返回当前节点</a>:null}</div>:<>
   <ReworkNodeHistoryView data={data} currentHref={reworkHistoryHref(orderId)} onVersion={id=>{window.location.href=reworkHistoryHref(orderId,node,id);}} onImage={setImage} />
   {image?<div className="rework-image-modal"><section className="rework-image-modal__content" role="dialog" aria-modal="true" aria-label={image.filename}><div className="rework-image-modal__heading"><strong>{image.filename}</strong><button type="button" onClick={()=>setImage(null)}>关闭</button></div><ImageViewer src={apiUrl(`tools/attachments/${image.attachmentId}/download?mode=preview`)} alt={image.filename} /></section></div>:null}
  </>}
 </div></Shell>;
}
export function ReworkNodeHistoryView({data,currentHref,onVersion,onImage}:{data:ReworkNodeHistory;currentHref:string;onVersion:(id:string)=>void;onImage:(image:ReworkNodeHistory['attachments'][number])=>void}) {
 return <>
  <Header title={data.fields.find(field=>field.label==='款号')?.value??'返工历史'} subtitle={data.entry.label} badge="历史节点 · 只读" badgePlacement="subtitle" />
  <div className="rework-history-navigation"><span>{display(data.entry.at)} · {data.entry.actor}</span>{data.versions.length>1?<label>历史版本<select value={data.entry.id} onChange={event=>onVersion(event.target.value)}>{data.versions.map((entry,index)=><option key={entry.id} value={entry.id}>第 {index+1} 次 · {display(entry.at)}</option>)}</select></label>:null}<a className="dx-button dx-button--primary" href={currentHref}>返回当前节点</a></div>
  {data.notices.map(notice=><p key={notice} role="status">{notice}</p>)}
  <Surface className="rework-history-fields"><h2>订单资料</h2><div>{data.fields.map(field=><label key={field.label}><span>{field.label}</span>{field.value && field.value.length>36?<textarea readOnly rows={3} value={display(field.value)} />:<input readOnly value={display(field.value)} />}</label>)}</div></Surface>
  <section><div className="section-title"><h2>订单图片</h2><span>{data.attachments.length} 张</span></div><div className="rework-history-images">{data.attachments.map(attachment=>attachment.mimeType.startsWith('image/')?<button type="button" key={attachment.attachmentId} onClick={()=>onImage(attachment)}><img src={apiUrl(`tools/attachments/${attachment.attachmentId}/download?mode=preview`)} alt={attachment.filename} loading="lazy" /></button>:<a key={attachment.attachmentId} href={apiUrl(`tools/attachments/${attachment.attachmentId}/download`)}>{attachment.filename}</a>)}</div></section>
  {data.inspectionReport?<InspectionReportReadonly report={data.inspectionReport}/>:null}
  {data.sections.map(section=><section key={section.title}><h2>{section.title}</h2>{section.rows.length?<ResponsiveFactsTable
    caption={section.title} mobileLayout="compact" columns={section.columns.map((label,index)=>({key:String(index),label,mobileHeading:index===0,render:(row:{id:number;cells:string[]})=>row.cells[index]}))}
    rows={section.rows.map((row,id)=>({id,cells:row.map(display)}))} rowKey={row=>row.id}
   />:<p>该版本未留存此项明细。</p>}</section>)}
 </>;
}
