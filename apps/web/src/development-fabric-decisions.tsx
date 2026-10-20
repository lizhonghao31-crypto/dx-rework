import {Button} from "@dx-rework/ui";
import type {useDevelopmentExecution} from "./digital-development-execution-panel.js";
import {createWebUrls} from "../url-contract.js";
export type FabricCase={reportId:string;reportedAt:string;reportedBy:string;payload:{note:string;attachmentIds:string[]};decisionId:string|null;decision:{decision:string;note:string}|null;decidedAt:string|null;decidedBy:string|null;status:string;scope:{roundNumber:number;documentVersion:number;materials:Array<{materialId:string;name:string;label:string}>}|null;responsible:Array<{id:string;name:string}>};
export function DevelopmentFabricDecisions({controller}:{controller:ReturnType<typeof useDevelopmentExecution>}){
 const {state,busy,run}=controller;
 if(!state?.fabricCases?.length)return null;
 const urls=createWebUrls(import.meta.env.BASE_URL);
 return <section aria-label="问题面料报告与决定"><h3>问题面料报告与决定</h3>{state.fabricCases.map(report=><article key={report.reportId}>
  <h4>{report.status==="等待决定"?"等待供应链总监决定":report.status==="停止使用"?"已决定停止使用，不能以核料勾选放行":"已明确允许使用，仍须完成实际核料"}</h4>
  <p>{report.payload.note}</p><p>报告人：{report.reportedBy} · {new Date(report.reportedAt).toLocaleString("zh-CN")}</p>
  <p>{report.scope?`报告依据：第 ${report.scope.roundNumber} 轮、资料版本 ${report.scope.documentVersion}；材料：${report.scope.materials.map(m=>m.name||m.label).join("、")}`:"历史报告未登记具体材料／轮次范围；请有权决定人对照原报告核实，不因到货或改版自动失效。"}</p>
  {report.payload.attachmentIds.map(id=><a key={id} href={urls.apiUrl(`digital-production/sources/${state.sheet.sourceId}/development/attachments/${id}`)} target="_blank" rel="noreferrer">查看检测报告附件 </a>)}
  <p>负责人员：{report.responsible.length?report.responsible.map(p=>p.name).join("、"):"尚无有效供应链总监，请由 Root 核实岗位或明确办理"}。{!report.decisionId&&"待供应链总监或 Root 在本页作出明确决定。"}</p>
  {report.decision&&<p>决定：{report.decision.decision} · {report.decision.note} · {report.decidedBy} · {report.decidedAt&&new Date(report.decidedAt).toLocaleString("zh-CN")}</p>}
  {state.canDecideFabric&&<form onSubmit={e=>{e.preventDefault();const data=new FormData(e.currentTarget);void run("fabric-decisions",{reportId:report.reportId,expectedDecisionId:report.decisionId,decision:data.get("decision"),note:data.get("note")});}}><fieldset disabled={busy}><label>本次明确决定<select name="decision" required defaultValue=""><option value="" disabled>请选择</option><option>允许使用</option><option>停止使用</option></select></label><label>决定依据与说明<input name="note" required maxLength={1000}/></label><Button type="submit">确认面料决定</Button></fieldset></form>}
 </article>)}<p>允许使用只解除对应报告的质量阻断；文员仍需核实本轮使用情况和四项结果，再提交核料。停止使用不会自动完成核料。</p></section>;
}
