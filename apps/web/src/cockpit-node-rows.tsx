import {CockpitDate} from './cockpit-date.js';
import {cockpitOwnStatus,CockpitTargetDifference,CockpitFixedTargetDates,CockpitActualDates} from './cockpit-fixed-schedule.js';
import type {ReactNode} from "react";
import {hasDateOnlyTarget,hasOriginalTaskDeadline,nodeTargetLabel} from './journey-sla-details.js';
import {StatusBadge,type Tone} from "@dx-rework/ui";
import {NodeTable} from "@dx-rework/ui/production";
import type {JourneyNode,JourneyRecord,OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {createWebUrls} from "../url-contract.js";
import {journeyRecordHref,journeyStateLabels,nodeStatus,type CockpitContext} from "./digital-journey-cockpit-model.js";
const urls=createWebUrls(import.meta.env.BASE_URL);
export const cockpitPerson=(person:JourneyNode["owner"],status?:JourneyNode['ownerStatus'])=>person?.name??(person?.id?"姓名未登记":status==='unassigned'?"未指派":status==='unavailable'?"无权限查看":"负责人尚未取得");
export const cockpitNodeTone=(node:JourneyNode):Tone=>cockpitOwnStatus(node)?.tone??(node.risks.includes("overdue")?"danger":node.risks.includes("due_soon")?"warning":node.state==="completed"||node.state==="inherited"?"success":node.state==="active"?"info":"neutral");
export const cockpitNodeStatus=(node:JourneyNode)=>cockpitOwnStatus(node)?.text??(node.state==="completed"?"已完成":node.state==="inherited"||node.state==="unavailable"?nodeStatus(node):journeyStateLabels[node.state]+(node.risks.includes("overdue")?" · 逾期":node.risks.includes("due_soon")?" · 临期":""));
const recordLabels:Record<string,string>={task:"节点记录",development:"开发单",order:"订购信息",instruction:"大货制单",budget:"预算",sourcing:"外发审批 / 合同",cutting:"裁床实裁",receiving:"回货记录",closure:"回货与结案",production:"实际生产记录",preparation:"产前准备",rework:"返工记录",development_material:"面辅料记录"};
export const cockpitRecordLabel=(record:JourneyRecord)=>recordLabels[record.domain]??"业务记录";
/** Submitting an unfinished result is normal work, rather than an activation blocker. */
export const cockpitVisibleBlockers=(node:JourneyNode)=>node.blockers.filter(blocker=>!blocker.key.startsWith('completion:'));

export function CockpitRecordLink({record,context,children,disabled=false,onNavigate}:{record:JourneyRecord;context:CockpitContext;children:ReactNode;disabled?:boolean;onNavigate?:()=>CockpitContext}){
  const href=record.url?journeyRecordHref(record.url,context,record.mode):"";
  return href&&!disabled?<a href={urls.pageUrl(href)} onClick={event=>{if(onNavigate&&record.url)event.currentTarget.href=urls.pageUrl(journeyRecordHref(record.url,onNavigate(),record.mode));}}>{children}</a>:<span className="journey-muted" aria-disabled="true">{disabled?children:"记录暂不可用"}</span>;
}
export function CockpitNodeRows({nodes,selectedId,context,onSelect,asOf,lines=[],idPrefix='journey-node'}:{lines?:OrderJourney['lines'];nodes:JourneyNode[];selectedId:string|undefined;context:CockpitContext;asOf:string|undefined;onSelect:(node:JourneyNode)=>void;idPrefix?:string}){
  return <NodeTable className="journey-node-table"><colgroup><col className="node-name"/><col className="node-owner"/><col className="node-status"/><col className="node-time"/><col className="node-time"/><col className="node-record"/></colgroup>
    <thead><tr><th>节点 / 轮次</th><th>负责人</th><th>状态</th><th>原截止 / 节点目标</th><th>实际完成时间</th><th>记录</th></tr></thead>
    <tbody>{nodes.map(node=>{
      const historical=!node.current||["completed","cancelled","inherited"].includes(node.state);
      return <tr key={node.instanceId} id={`${idPrefix}-${node.instanceId}`} className={selectedId===node.instanceId?"is-focused":undefined}>
        <td><button type="button" className="journey-node-toggle" data-cockpit-focus={'node:'+node.instanceId} aria-pressed={selectedId===node.instanceId} onClick={()=>onSelect(node)}>{node.label}</button><small>{node.subject||(node.round?<span className="cockpit-node-round">{`第 ${node.round} 轮`}</span>:"")}{!node.current?<span className="cockpit-node-round"> · 历史</span>:null}</small></td>
        <td title={cockpitPerson(node.owner,node.ownerStatus)}>{cockpitPerson(node.owner,node.ownerStatus)}</td><td><StatusBadge tone={cockpitNodeTone(node)}>{cockpitNodeStatus(node).split(" · ").map((part,index)=><span className="cockpit-state-part" key={index}>{`${index?" · ":""}${part}`}</span>)}</StatusBadge>{node.productionSupervision?.state==='ended'&&<small>生产监督已结束，查看原记录</small>}{node.fixedTargets?.length?<CockpitTargetDifference nodes={[node]} asOf={asOf} lines={lines}/>:null}</td>
        <td>{node.fixedTargets?.length?<CockpitFixedTargetDates node={node} lines={lines}/>:node.state==="not_applicable"?"不适用":node.state==="unavailable"?"无可见时间":node.nativeWindows?.length?<>{nodeTargetLabel(node)}{hasOriginalTaskDeadline(node)&&<small>原任务截止：{hasDateOnlyTarget(node)?nodeTargetLabel({...node,nativeWindows:undefined}):<CockpitDate value={node.expectedAt} precision={node.expectedPrecision} stacked/>}</small>}</>:hasDateOnlyTarget(node)?nodeTargetLabel(node):<CockpitDate value={node.expectedAt} precision={node.expectedPrecision} stacked/>}</td>
        <td>{node.state==="not_applicable"?"不适用":<CockpitActualDates node={node} lines={lines} stacked/>}</td>
        <td>{historical&&node.records.length===1?<CockpitRecordLink record={{...node.records[0]!,mode:"read"}} context={context}>查看记录</CockpitRecordLink>:historical&&node.records.length>1?<details><summary>查看记录（{node.records.length}）</summary>{node.records.map((record,index)=><CockpitRecordLink key={record.domain+record.id+index} record={{...record,mode:"read"}} context={context}>{cockpitRecordLabel(record)}{record.version?` · v${record.version}`:""}</CockpitRecordLink>)}</details>:<span className="journey-muted">{node.state==="unavailable"?node.unavailableReason==="permission"?"无权限查看":"尚无原事实":historical?"尚无记录":"选择节点"}</span>}</td>
      </tr>;
    })}</tbody>
  </NodeTable>;
}
