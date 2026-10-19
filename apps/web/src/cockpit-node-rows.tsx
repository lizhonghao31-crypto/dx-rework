import type {ReactNode} from "react";
import {CockpitDate} from "./cockpit-date.js";
import {StatusBadge,type Tone} from "@dx-rework/ui";
import {NodeTable} from "@dx-rework/ui/production";
import type {JourneyNode,JourneyRecord} from "@dx-rework/contracts/digital-production-journey";
import {createWebUrls} from "../url-contract.js";
import {journeyRecordHref,journeyStateLabels,nodeStatus,type CockpitContext} from "./digital-journey-cockpit-model.js";
const urls=createWebUrls(import.meta.env.BASE_URL);
export const cockpitPerson=(person:JourneyNode["owner"])=>person?.name??(person?.id?"姓名未登记":"未指派");
export const cockpitNodeTone=(node:JourneyNode):Tone=>node.risks.includes("overdue")?"danger":node.risks.includes("due_soon")?"warning":node.state==="completed"||node.state==="inherited"?"success":node.state==="active"?"info":"neutral";
export const cockpitNodeStatus=(node:JourneyNode)=>node.state==="completed"?"已完成":node.state==="inherited"||node.state==="unavailable"?nodeStatus(node):journeyStateLabels[node.state]+(node.risks.includes("overdue")?" · 逾期":node.risks.includes("due_soon")?" · 临期":"");
const recordLabels:Record<string,string>={task:"节点记录",development:"开发单",order:"订购信息",instruction:"大货制单",budget:"预算",sourcing:"外发审批 / 合同",cutting:"裁床实裁",receiving:"回货记录",closure:"回货与结案",production:"实际生产记录",preparation:"产前准备",rework:"返工记录",development_material:"面辅料记录"};
export const cockpitRecordLabel=(record:JourneyRecord)=>recordLabels[record.domain]??"业务记录";
export function CockpitRecordLink({record,context,children,disabled=false}:{record:JourneyRecord;context:CockpitContext;children:ReactNode;disabled?:boolean}){
  const href=record.url?journeyRecordHref(record.url,context,record.mode):"";
  return href&&!disabled?<a href={urls.pageUrl(href)}>{children}</a>:<span className="journey-muted" aria-disabled="true">{disabled?children:"记录暂不可用"}</span>;
}
export function CockpitNodeRows({nodes,selectedId,context,onSelect}:{nodes:JourneyNode[];selectedId:string|undefined;context:CockpitContext;asOf:string|undefined;onSelect:(node:JourneyNode)=>void}){
  return <NodeTable className="journey-node-table"><colgroup><col className="node-name"/><col className="node-owner"/><col className="node-status"/><col className="node-time"/><col className="node-time"/><col className="node-record"/></colgroup>
    <thead><tr><th>节点 / 轮次</th><th>负责人</th><th>状态</th><th>预计完成时间</th><th>实际完成时间</th><th>记录</th></tr></thead>
    <tbody>{nodes.map(node=>{
      const historical=!node.current||["completed","cancelled","inherited"].includes(node.state);
      return <tr key={node.instanceId} id={`journey-node-${node.instanceId}`} className={selectedId===node.instanceId?"is-focused":undefined}>
        <td><button type="button" className="journey-node-toggle" aria-pressed={selectedId===node.instanceId} onClick={()=>onSelect(node)}>{node.label}</button><small>{node.subject||(node.round?`第 ${node.round} 轮`:"")}{!node.current?" · 历史":""}</small></td>
        <td title={cockpitPerson(node.owner)}>{cockpitPerson(node.owner)}</td><td><StatusBadge tone={cockpitNodeTone(node)}>{cockpitNodeStatus(node)}</StatusBadge></td>
        <td>{node.state==="not_applicable"?"不适用":node.state==="unavailable"?"无可见时间":<CockpitDate value={node.expectedAt} precision={node.expectedPrecision} stacked/>}</td>
        <td>{node.state==="not_applicable"?"不适用":<CockpitDate value={node.actualAt} missing={node.state==="completed"?"完成时间待核实":"—"} stacked/>}{node.actualAt&&node.actualQuality!=="verified"&&<small>待核实</small>}</td>
        <td>{historical&&node.records.length===1?<CockpitRecordLink record={{...node.records[0]!,mode:"read"}} context={context}>查看记录</CockpitRecordLink>:historical&&node.records.length>1?<details><summary>查看记录（{node.records.length}）</summary>{node.records.map((record,index)=><CockpitRecordLink key={record.domain+record.id+index} record={{...record,mode:"read"}} context={context}>{cockpitRecordLabel(record)}{record.version?` · v${record.version}`:""}</CockpitRecordLink>)}</details>:<span className="journey-muted">{node.state==="unavailable"?node.unavailableReason==="permission"?"无权限查看":"尚无原事实":historical?"尚无记录":"选择节点"}</span>}</td>
      </tr>;
    })}</tbody>
  </NodeTable>;
}
