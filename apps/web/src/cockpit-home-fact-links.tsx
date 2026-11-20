import type {ReactNode} from 'react';
import type {CockpitFact,JourneyRecord,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {CockpitBadge} from './cockpit-astryx.js';
import {CockpitRecordLink} from './cockpit-record-link.js';
import {cockpitReceiptGap} from './cockpit-home-progress.js';
import type {CockpitContext} from './digital-journey-cockpit-model.js';

const badgeTones={gray:'neutral',blue:'info',green:'success',neutral:'neutral'} as const;

export function CockpitHomeFactLinks({order,context,onReceipts}:{order:OrderJourney;context:CockpitContext;onReceipts:()=>void}){
 const facts=order.cockpitFacts,nodes=order.stages.flatMap(stage=>stage.nodes);
 const dashboard=facts?.production.dashboardLinks??[];
 const productionRecord=facts?.production.dashboardRecord??(dashboard.length===1?dashboard[0]?.record:undefined);
 const productionChoices=!productionRecord&&dashboard.length>1?<details className="cockpit-production-choices">
  <summary>生产进度</summary>
  {dashboard.map(({factoryName,record})=><div key={record.url}><CockpitRecordLink record={record} context={context}>{factoryName}</CockpitRecordLink></div>)}
 </details>:null;
 const sampleRecord=nodes.find(node=>node.current&&node.key==='bulk_ship_sample')?.records.find(record=>record.url);
 const receipts=facts?.receiving,hasGap=Boolean(cockpitReceiptGap(order)?.gap);
 const receiptRecord=nodes.find(node=>node.current&&node.key==='receipts')?.records.find(record=>record.url);
 const render=(title:string,fact:CockpitFact|undefined,record?:JourneyRecord,quantity?:string,open?:()=>void,choices?:ReactNode)=>{
  const line=<><span>{title}</span><CockpitBadge tone={badgeTones[fact?.tone??'neutral']} className="cockpit-home-fact-status">{fact?.label??'暂不可用'}</CockpitBadge></>;
  const detail=(quantity||fact?.scope==='visible')&&<span className="cockpit-home-fact-quantity">{quantity&&` · ${quantity} 件`}{fact?.scope==='visible'&&` · 可见${title==='生产进度'?'范围':' PO'}`}</span>;
  const linkBody=<><span className="cockpit-home-fact-line">{line}</span>{detail}</>;
  return <div className="cockpit-home-fact" data-fact-tone={fact?.tone??'neutral'}>
   {open?<button type="button" className="journey-text-action" onClick={open}>{linkBody}</button>
    :record?<CockpitRecordLink record={record} context={context}>{linkBody}</CockpitRecordLink>
    :<><div className="cockpit-home-fact-line">{choices?<>{choices}<CockpitBadge tone={badgeTones[fact?.tone??'neutral']} className="cockpit-home-fact-status">{fact?.label??'暂不可用'}</CockpitBadge></>:line}</div>{detail}</>}
  </div>;
 };
 return <div className="cockpit-home-facts">
  {render('生产进度',facts?.production,productionRecord,undefined,undefined,productionChoices)}
  {render('收货数量',receipts,receiptRecord,receipts?.received!=null&&receipts.demand!=null?`${receipts.received.toLocaleString()}/${receipts.demand.toLocaleString()}`:undefined,hasGap?onReceipts:undefined)}
  {render('船样寄出',facts?.shipSample,sampleRecord)}
 </div>;
}
