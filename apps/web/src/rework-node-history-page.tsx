import { reworkHistorySource } from "./rework-return-path.js";
import {digitalDetailReturnUrl} from "./digital-detail-route.js";
import { ProcessWorkerAssignmentForm } from './process-worker-assignment-form.js';
import { WholeOrderReviewPanel } from './whole-order-review-panel.js';
import { ResponsibilityDeterminationPanel } from './responsibility-determination-panel.js';
import { ReworkInitiationV2Form } from './rework-v2-form.js';
import { WorkReportingForm } from './work-reporting-form.js';
import { formatBusinessDecimal } from '@dx-rework/contracts/business-display';
import { ReworkNodeHistorySchema, type ReworkNodeHistory, type FinanceNodeKey } from '@dx-rework/contracts/reporting';
import { WorkflowRail, Surface } from '@dx-rework/ui';
import { useEffect, useRef, useState } from 'react';
import { Header, Shell } from './components.js';
import { InspectionReportReadonly } from './inspection-report-readonly.js';
import { ImageViewer } from './image-viewer.js';
import { createWebUrls } from '../url-contract.js';
import './rework-governed.css';
const {apiUrl,pageUrl}=createWebUrls(import.meta.env.BASE_URL);
const labels: Record<string,string>={approved:'同意',rejected:'驳回',pending_ie_review:'待 IE 核价',draft:'草稿',piece:'件',hour:'小时',own_factory:'本厂',processing_factory:'加工厂',embroidery_factory:'印绣花厂',washing_factory:'洗水厂',fabric_supplier:'面料商',internal:'正式工',temporary:'临时工'};
const display=(value:string|null)=>value===null?'历史未记录':labels[value]??(/^-?\d+(?:\.\d+)?$/.test(value)?formatBusinessDecimal(value,2):/^\d{4}-\d{2}-\d{2}[T ]/.test(value)?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):value);
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
 const motherReturn=digitalDetailReturnUrl(new URLSearchParams(window.location.search).get("returnTo"),import.meta.env.BASE_URL);
 const sourceBack=reworkHistorySource(window.location.search,window.history.state?.dxReworkReturnTo);
 const entryId=new URLSearchParams(window.location.search).get('entryId');
 useEffect(()=>{const controller=new AbortController();setData(null);setError('');
  const query=entryId?`?${new URLSearchParams({entryId})}`:'';
  void fetch(apiUrl(`rework-orders/${orderId}/history/${node}${query}`),{credentials:'include',signal:controller.signal,cache:'no-store'})
   .then(async response=>{if(!response.ok){const body=await response.json().catch(()=>null) as {error?:{message?:string}}|null;throw new Error(body?.error?.message??'历史页面加载失败');}return ReworkNodeHistorySchema.parse(await response.json());})
   .then(value=>{if(!controller.signal.aborted)setData(value);}).catch((reason:unknown)=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'历史页面加载失败');});
  return()=>controller.abort();
 },[orderId,node,entryId]);
 useEffect(()=>{if(!image)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setImage(null);};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[image]);
 return <Shell active="全部订单"><div className="rework-governed rework-history rework-history-readonly" data-dx-ui="governed">
  {motherReturn?<a className="dx-button" href={motherReturn}>返回这张订单</a>:<a className="dx-button" href={pageUrl(sourceBack.path)}>{sourceBack.label}</a>}
  {!data?<div aria-busy={!error}><p role="status">{error||'正在加载历史页面…'}</p>{error?<a className="dx-button" href={reworkHistoryHref(orderId)}>返回当前节点</a>:null}</div>:<>
   <ReworkNodeHistoryView key={data.entry.id} data={data} currentHref={reworkHistoryHref(orderId)} onVersion={id=>{window.location.href=reworkHistoryHref(orderId,node,id);}} onImage={setImage} />
   {image?<div className="rework-image-modal"><section className="rework-image-modal__content" role="dialog" aria-modal="true" aria-label={image.filename}><div className="rework-image-modal__heading"><strong>{image.filename}</strong><button type="button" onClick={()=>setImage(null)}>关闭</button></div><ImageViewer src={apiUrl(`tools/attachments/${image.attachmentId}/download?mode=preview`)} alt={image.filename} /></section></div>:null}
  </>}
 </div></Shell>;
}
const historyNodes = [
 ['initiation','发起返工','质检'],['process_configuration','分配工序 &工人','尾部主管'],['ie_review','IE 核价','IE'],
 ['work_reporting','返工执行报数','返工人员 / 整查'],['whole_order_review','尾部最终数量确认','尾部主管'],
 ['final_quantity_ie_review','IE 最终数量复核','IE'],['responsibility','责任判定','供应链总监'],['owner_signature','老板确认签字','老板'],['settlement_followup','返工业务完成','系统'],
] as const;
const finishingHistoryNodes=[
 ['initiation','本厂做尾','尾部主管'],['process_configuration','分配工序 &工人','尾部主管'],['ie_review','IE 核价','IE'],
 ['work_reporting','做尾执行报数','做尾人员'],['whole_order_review','尾部最终数量确认','尾部主管'],['final_quantity_ie_review','IE 最终数量复核','IE'],
] as const;
export function ReworkNodeHistoryView({data,currentHref,onVersion,onImage}:{data:ReworkNodeHistory;currentHref:string;onVersion:(id:string)=>void;onImage:(image:ReworkNodeHistory['attachments'][number])=>void}) {
 const [expanded,setExpanded]=useState(false);
 const [readingFilename,setReadingFilename]=useState<string | null>(null);
 const mobileRail=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(expanded) mobileRail.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({block:'nearest',inline:'center'});},[expanded,data.node]);
 const orderId=data.orderId ?? currentHref.split('/').at(-1)?.split('?')[0] ?? '';
 const page=data.page;
 const configuration=page?.configuration;
 const workerPlan=page?.workerPlan;
 const nodes=data.reworkKind==='inhouse_finishing'?finishingHistoryNodes:historyNodes;
 const content=data.node==='initiation'
  ? data.reworkKind==='inhouse_finishing'?<section><h2>本厂做尾来源资料</h2><dl>{data.fields.filter(field=>field.value!==null).map(field=><div key={field.label}><dt>{field.label}</dt><dd>{display(field.value)}</dd></div>)}</dl></section>
   : <><ReworkInitiationV2Form reworkOrderId={orderId} embedded existingAttachmentCount={data.attachments.length} history={data.fields}/>{data.inspectionReport?<InspectionReportReadonly report={data.inspectionReport}/>:null}</>
  : (data.node==='process_configuration'||data.node==='ie_review') && configuration && workerPlan
   ? <ProcessWorkerAssignmentForm reworkOrderId={orderId} embedded workspaceNode={data.node} history={{configuration,plan:workerPlan}} />
   : (data.node==='whole_order_review'||data.node==='final_quantity_ie_review') && page?.wholeOrderReview
    ? <WholeOrderReviewPanel reworkOrderId={orderId} embedded iePrecounts={page.iePrecounts} onChanged={async()=>{}} history={{data:page.wholeOrderReview,tail:page.tailInspection,node:data.node}} />
    : (data.node==='responsibility'||data.node==='owner_signature') && page?.responsibility
     ? <ResponsibilityDeterminationPanel reworkOrderId={orderId} embedded history={page.responsibility}/>
     : (data.node==='work_reporting'||data.node==='task_assignment') && page?.workTasks
      ? <WorkReportingForm reworkOrderId={orderId} embedded taskMode={data.node==='task_assignment'?'task_assignment':'work_reporting'} history={page.workTasks}/>
      : <p role="status">该次提交未保存足够资料，无法完整还原原页面。</p>;
 const renderNode=(item:typeof nodes[number],index:number)=>{
  const record=data.navigation?.find(n=>n.node===item[0]);
  const selected=item[0]===data.node;
  const inner=<><b aria-hidden="true">{selected?index+1:record?.completed?'✓':index+1}</b><span><strong>{item[1]}</strong><small>{item[2]}</small></span><em>{selected?'正在回看':record?.completed?'已提交':'—'}</em></>;
  const state=selected?'current':record?.completed?'completed':'future';
  return record?.available||item[0]==='settlement_followup'?<a key={item[0]} className={`rework-workflow-step is-${state}`} aria-current={selected?'page':undefined} href={typeof window==='undefined'||item[0]==='settlement_followup'?currentHref:reworkHistoryHref(orderId,item[0])}>{inner}</a>:<div className={`rework-workflow-step is-${state}`} key={item[0]}>{inner}</div>;
 };
 return <>
  <Header title={data.fields.find(field=>field.label==='款号')?.value??'返工历史'} subtitle={data.entry.label} badge="历史节点 · 只读" badgePlacement="subtitle" />
  <div className="rework-history-navigation"><span>{display(data.entry.at)} · {data.entry.actor}</span>{data.versions.length>1?<label>历史版本<select value={data.entry.id} onChange={event=>onVersion(event.target.value)}>{data.versions.map((entry,index)=><option key={entry.id} value={entry.id}>第 {index+1} 次 · {display(entry.at)}</option>)}</select></label>:null}{data.currentStatus==='completed'&&data.reworkKind==='inhouse_finishing'?<span role="status">本单已完成，当前为历史资料</span>:<a className="dx-button" href={currentHref}>{data.currentStatus==='completed'?'查看业务完成资料':'返回当前节点'}</a>}</div>
  <Surface className="rework-detail-target-layout">
    <dl className="rework-detail-core-facts" aria-label="历史订单信息">{data.fields.filter(field=>['加工厂','返工工序','发起时间','发起人','订单跟单','订单数量','返工数量'].includes(field.label)&&field.value!==null).map(field=><div className="rework-detail-core-fact" key={field.label}><dt>{field.label}</dt><dd>{display(field.value)}</dd></div>)}</dl>
    <div className="order-layout-workspace"><div className="rework-order-support"><aside className="order-layout-aside">
        <div className="rework-detail-overview-grid order-overview--compact"><section className="rework-detail-images"><div className="section-title rework-detail-panel-title rework-governed-image-heading"><h2>订单图片</h2><span className="rework-governed-image-count">{data.attachments.length} 张</span></div><div className="rework-detail-image-grid">{data.attachments.map(attachment=>attachment.mimeType.startsWith('image/')?<button className="rework-detail-image-card" type="button" key={attachment.attachmentId} aria-label={`放大查看 ${attachment.filename}`} onClick={()=>onImage(attachment)} title={attachment.filename} onMouseEnter={() => setReadingFilename(attachment.filename)} onMouseLeave={() => setReadingFilename(null)} onFocus={() => setReadingFilename(attachment.filename)} onBlur={() => setReadingFilename(null)}><img src={apiUrl(`tools/attachments/${attachment.attachmentId}/download?mode=preview`)} alt={attachment.filename} loading="lazy" /><span className="rework-detail-image-card__filename">{attachment.filename}</span></button>:<a key={attachment.attachmentId} href={apiUrl(`tools/attachments/${attachment.attachmentId}/download`)}>{attachment.filename}</a>)}</div>{readingFilename ? <p className="rework-order-filename" role="status">{readingFilename}</p> : null}</section></div>
      </aside><div className="rework-detail-overview-grid order-overview--compact order-layout-flow">
          <section className="rework-workflow" aria-label="订单流程">
           <div className="rework-workflow__heading rework-detail-panel-title"><h2>订单流程</h2><span>历史节点 · 只读</span></div>
           <button className="rework-detail-mobile-panel-toggle rework-detail-mobile-workflow-toggle" type="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><strong>订单流程</strong><span>{data.entry.label} {expanded?'−':'+'}</span></button>
           <div className={`rework-detail-mobile-collapsible${expanded?' is-expanded':''}`}><WorkflowRail className="rework-workflow__desktop-grid" data-node-count={nodes.length} aria-label="电脑端流程节点">{nodes.map(renderNode)}{nodes.length > 5 ? <span className="rework-workflow-row-bridge" aria-hidden="true" /> : null}</WorkflowRail><WorkflowRail ref={mobileRail} className="rework-workflow__mobile-rail" aria-label="移动端流程节点">{nodes.map(renderNode)}</WorkflowRail></div>
          </section>
        </div></div><div className="order-layout-main">
        {data.notices.map(notice=><p key={notice} role="status">{notice}</p>)}
        {content}

      </div></div>
  </Surface>
 </>;
}
