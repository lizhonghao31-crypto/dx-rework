import {originalNodeDeadlineLabel} from './journey-sla-details.js';
import {StatusBadge} from '@dx-rework/ui';
import {type JourneyNode,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {cockpitVisibleBlockers} from './cockpit-node-rows.js';
import {journeyRiskLabels,matchingPoDeliveryRisks,type CockpitContext} from './digital-journey-cockpit-model.js';
import {poDeliveryKindLabels} from './po-delivery-dates.js';
import {CockpitHomeDialog} from './cockpit-home-dialog.js';
import {cockpitReceiptGap} from './cockpit-home-progress.js';

export function cockpitHomeRisks(order:OrderJourney,context:CockpitContext){
 const nodes=[...new Map(order.stages.flatMap(stage=>stage.nodes).filter(node=>node.current&&!['completed','inherited','cancelled','not_applicable','unavailable'].includes(node.state)&&(!context.stage||node.stage===context.stage)&&(!context.node||node.key===context.node)&&(!context.state||node.state===context.state)&&(!context.risk||node.risks.includes(context.risk))&&(node.risks.length>0||node.state==='blocked'||cockpitVisibleBlockers(node).length>0)).map(node=>[node.instanceId,node])).values()];
 const rank=(node:JourneyNode)=>node.risks.includes('overdue')?0:node.risks.includes('due_soon')?1:2;
 nodes.sort((a,b)=>rank(a)-rank(b)||(a.expectedAt??'z').localeCompare(b.expectedAt??'z')||a.instanceId.localeCompare(b.instanceId));
 const deliveries=[...new Map(matchingPoDeliveryRisks(order,{...context,kpi:'all'}).map(risk=>[`${risk.lineId}:${risk.kind}`,risk])).values()].sort((a,b)=>(a.risk==='overdue'?0:1)-(b.risk==='overdue'?0:1)||a.date.localeCompare(b.date)||a.lineId.localeCompare(b.lineId)||a.kind.localeCompare(b.kind));
 return {nodes,deliveries,total:nodes.length+deliveries.length};
}

export function CockpitHomeRisks({order,context,onClose,onNode,onOrder}:{order:OrderJourney;context:CockpitContext;onClose:()=>void;onNode:(node:JourneyNode)=>void;onOrder:()=>void}){
 const risks=cockpitHomeRisks(order,context),gap=cockpitReceiptGap(order),receiptNode=order.stages.flatMap(stage=>stage.nodes).find(node=>node.current&&node.key==='receipts'&&node.state!=='unavailable');
 return <CockpitHomeDialog title="风险明细" onClose={onClose}>
  <p className="cockpit-home-dialog-order">{order.designStyleNo}</p>
  {gap&&gap.gap>0&&<section aria-label="回货差额"><h3>{gap.full?'':'可见范围'}回货欠收 {gap.gap.toLocaleString()}件</h3>{order.businessProgress!.quantities!.lines.filter(line=>line.remainingReceipt>0).map(line=>{
   const po=order.lines.find(value=>value.id===line.lineId);
   return <article className="cockpit-home-risk-entry" key={line.lineId}><strong>{po?.po||'PO待补'} / {po?.color||'颜色待核'}</strong><p>应收 {line.demand.toLocaleString()}件 · 已收 {line.received.toLocaleString()}件 · 欠收 {line.remainingReceipt.toLocaleString()}件</p><button type="button" className="journey-text-action" onClick={()=>receiptNode?onNode(receiptNode):onOrder()}>{receiptNode?'查看回货节点':'查看订单详情'}</button></article>;
  })}</section>}
  {risks.nodes.length>0&&<section aria-label="节点风险"><h3>{order.display?.mainState==='completed'?'已收口订单保留的节点风险':'节点风险'}</h3>{risks.nodes.map(node=><article className="cockpit-home-risk-entry" key={node.instanceId}>
   <div><strong>{node.label}</strong><StatusBadge tone={node.risks.includes('overdue')?'danger':node.risks.includes('due_soon')?'warning':'neutral'}>{node.risks.map(key=>journeyRiskLabels[key]).join(' / ')||'受阻'}</StatusBadge></div>
   <p>{node.owner?.name??'负责人未指派'} · 截止 {originalNodeDeadlineLabel(node)}</p>
   {cockpitVisibleBlockers(node).map(blocker=><p key={blocker.key}>{blocker.label}</p>)}
   <button type="button" className="journey-text-action" onClick={()=>onNode(node)}>查看节点</button>
  </article>)}</section>}
  {risks.deliveries.length>0&&<section aria-label="PO交期风险"><h3>PO 交期</h3>{risks.deliveries.map(risk=><article className="cockpit-home-risk-entry" key={`${risk.lineId}:${risk.kind}`}>
   <strong>{risk.poNumber||'PO待补'} / {risk.color}</strong><p>{poDeliveryKindLabels[risk.kind]} <time dateTime={risk.date}>{risk.date}</time> <StatusBadge tone={risk.risk==='overdue'?'danger':'warning'}>{risk.risk==='overdue'?'约定日期已过':'今天到期'}</StatusBadge></p>
  </article>)}</section>}
  <footer><button type="button" className="journey-text-action" onClick={onOrder}>进入订单详情</button></footer>
 </CockpitHomeDialog>;
}
