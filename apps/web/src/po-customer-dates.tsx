import { useState } from "react";
import { Button } from "@dx-rework/ui";
import type { InstructionSheet } from "@dx-rework/contracts/production-instruction";
import { DocumentSection } from "./document-editor.js";
export function PoCustomerDates({sheet,busy,dirty,historical,onAct}:{sheet:InstructionSheet;busy:boolean;dirty:boolean;historical:boolean;onAct:(path:string,method:string,body:unknown)=>Promise<boolean|undefined>}){
  const [selected,setSelected]=useState<string[]>([]),[date,setDate]=useState(""),[reason,setReason]=useState("");
  const lines=sheet.customerPoDates??[];
  return <DocumentSection id="instruction-delivery" title="PO 客户仓到货日" detail={historical?"当前交期另列；打印保留该版原快照":"日期审批与制单版本分开；变更仅作用于选中的 PO"}>
    {sheet.cutStarted&&<p className="instruction-note">已经开裁。仅可按权限申请、批准客户交期变更；制单内容仍冻结。</p>}
    <div className="instruction-po-dates-scroll"><table className="instruction-po-dates-table"><thead><tr><th>PO / 颜色</th><th>客户仓到货日</th><th>登记来源</th></tr></thead><tbody>{lines.map(line=><tr key={line.lineId}>
      <td>{!historical&&sheet.canRequestDate&&<input aria-label={`选择 ${line.poNumber||"待补 PO"} ${line.color}`} type="checkbox" disabled={busy||dirty} checked={selected.includes(line.lineId)} onChange={e=>setSelected(current=>e.target.checked?[...current,line.lineId]:current.filter(id=>id!==line.lineId))}/>} {line.poNumber||"待补 PO"} / {line.color}</td><td>{line.date||"未登记"}</td><td>{line.source==="legacy_unregistered"?"历史约定，待逐 PO 登记":line.source==="initial_po"?"设计师登记":line.source==="approved_customer_change"?"已批准变更":"未登记"}</td></tr>)}</tbody></table></div>
    {!historical&&sheet.canRequestDate&&<div className="instruction-date-request"><p>已选择 {selected.length} 个 PO。新日期统一应用于本次选中的 PO。</p>
      <label>新客户仓到货日<input aria-label="新客户仓到货日" type="date" disabled={busy||dirty} value={date} onChange={e=>setDate(e.target.value)}/></label>
      <label>变更原因<textarea aria-label="交期变更原因" maxLength={500} disabled={busy||dirty} value={reason} onChange={e=>setReason(e.target.value)}/></label>
      <Button type="button" disabled={busy||dirty||!selected.length||!date||!reason.trim()} onClick={()=>void onAct("/date-requests","POST",{orderVersion:sheet.currentOrderVersion,reason,changes:lines.filter(line=>selected.includes(line.lineId)).map(line=>({lineId:line.lineId,expectedVersion:line.version,date}))}).then(ok=>{if(ok){setSelected([]);setDate("");setReason("");}})}>申请所选 PO 变更</Button>
      {dirty&&<p>请先保存制单修改，再办理交期。</p>}
    </div>}
    {sheet.dateRequests.map(request=><div className="instruction-date-history" key={request.requestId}>
      <p>{request.source==="po"?"逐 PO 申请":"历史整单申请"} · {request.status}</p>
      {request.changes?.length?request.changes.map(change=><p key={change.lineId}>{change.poNumber||"待补 PO"} / {change.color}：{change.oldDate||"未登记"} → {change.date}</p>):<p>{request.oldDate||"未登记"} → {request.date}</p>}
      <p>{request.reason}</p><small>{request.requestedBy} · {request.requestedAt&&new Date(request.requestedAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})}{request.decidedBy&&` · ${request.decidedBy} ${new Date(request.decidedAt!).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})}`}</small>
      {request.approvalBlockedReason&&<p>{request.approvalBlockedReason}</p>}
      {!historical&&sheet.canApproveDate&&request.status==="待批准"&&<div className="instruction-date-actions"><Button type="button" disabled={busy||dirty||Boolean(request.approvalBlockedReason)} onClick={()=>void onAct(`/date-requests/${request.requestId}/decision`,"POST",{approved:true})}>同意</Button><Button type="button" disabled={busy||dirty} onClick={()=>void onAct(`/date-requests/${request.requestId}/decision`,"POST",{approved:false})}>驳回</Button></div>}
    </div>)}
  </DocumentSection>;
}
