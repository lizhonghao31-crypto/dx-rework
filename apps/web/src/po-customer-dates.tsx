import { customerPoDateLabel } from "./digital-workspace-copy.js";
import { useState } from "react";
import { Button } from "@dx-rework/ui";
import type { CustomerDateHistory, InstructionSheet } from "@dx-rework/contracts/production-instruction";
import { DocumentSection } from "./document-editor.js";
export function PoCustomerDateHistory({requests,canApprove,busy,onDecide}:{requests:readonly CustomerDateHistory[];canApprove:boolean;busy:boolean;onDecide:(requestId:string,approved:boolean)=>void}){
  return <>{requests.map(request=>{
    const blocked=request.approvalBlockedReason||(request.source==="po"&&!request.changes?.length?"申请缺少明确 PO，请刷新":null);
    return <div className="instruction-date-history" key={request.requestId}>
      <p>{request.source==="po"?"逐 PO 申请":"历史整单申请"} · {request.status}</p>
      {request.changes?.length?request.changes.map(change=><p key={change.lineId}>{change.poNumber||"待补 PO"} / {change.color}：{change.oldDate||"未登记"} → {change.date}</p>):<p>{request.oldDate||"未登记"} → {request.date}</p>}
      <p>{request.reason}</p><small>{request.requestedBy} · {request.requestedAt&&new Date(request.requestedAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})}{request.decidedBy&&` · ${request.decidedBy} ${new Date(request.decidedAt!).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})}`}</small>
      {blocked&&<p role="status">{blocked}</p>}
      {canApprove&&request.status==="待批准"&&<div className="instruction-date-actions"><Button type="button" disabled={busy||Boolean(blocked)} onClick={()=>onDecide(request.requestId,true)}>同意</Button><Button type="button" disabled={busy} onClick={()=>onDecide(request.requestId,false)}>驳回</Button></div>}
    </div>;
  })}</>;
}
export function PoCustomerDates({sheet,busy,dirty,historical,onAct}:{sheet:InstructionSheet;busy:boolean;dirty:boolean;historical:boolean;onAct:(path:string,method:string,body:unknown)=>Promise<boolean|undefined>}){
  const [selected,setSelected]=useState<string[]>([]),[date,setDate]=useState(""),[reason,setReason]=useState("");
  const lines=sheet.customerPoDates??[];
  return <DocumentSection id="instruction-delivery" title={`PO 当前${customerPoDateLabel}`} detail={historical?"当前日期用于对照；打印保留该版原快照":"变更仅作用于选中的 PO；加工厂交货日及历史计时不自动改变"}>
    {sheet.cutStarted&&<p className="instruction-note">已经开裁。按原主跟单申请、供应链总监批准流程变更所选 PO 的出货日期；制单内容仍冻结。</p>}
    <div className="instruction-po-dates-scroll"><table className="instruction-po-dates-table"><thead><tr><th>PO / 颜色</th><th>{historical?"客户仓到货日":customerPoDateLabel}</th><th>登记来源</th></tr></thead><tbody>{lines.map(line=><tr key={line.lineId}>
      <td>{!historical&&sheet.canRequestDate&&<input aria-label={`选择 ${line.poNumber||"待补 PO"} ${line.color}`} type="checkbox" disabled={busy||dirty} checked={selected.includes(line.lineId)} onChange={e=>setSelected(current=>e.target.checked?[...current,line.lineId]:current.filter(id=>id!==line.lineId))}/>} {line.poNumber||"待补 PO"} / {line.color}</td><td>{line.date||"未登记"}</td><td>{line.source==="legacy_unregistered"?"历史约定，待逐 PO 登记":line.source==="initial_po"?"设计师登记":line.source==="approved_customer_change"?"已批准变更":"未登记"}</td></tr>)}</tbody></table></div>
    {!historical&&sheet.canRequestDate&&<div className="instruction-date-request"><p>已选择 {selected.length} 个 PO。新日期统一应用于本次选中的 PO。</p>
      <label>新{customerPoDateLabel}<input aria-label={`新${customerPoDateLabel}`} type="date" disabled={busy||dirty} value={date} onChange={e=>setDate(e.target.value)}/></label>
      <label>变更原因<textarea aria-label="交期变更原因" maxLength={500} disabled={busy||dirty} value={reason} onChange={e=>setReason(e.target.value)}/></label>
      <Button type="button" disabled={busy||dirty||!selected.length||!date||!reason.trim()} onClick={()=>void onAct("/date-requests","POST",{orderVersion:sheet.currentOrderVersion,reason,changes:lines.filter(line=>selected.includes(line.lineId)).map(line=>({lineId:line.lineId,expectedVersion:line.version,date}))}).then(ok=>{if(ok){setSelected([]);setDate("");setReason("");}})}>申请所选 PO 变更</Button>
      {dirty&&<p>请先保存制单修改，再办理交期。</p>}
    </div>}
    <PoCustomerDateHistory requests={sheet.dateRequests} canApprove={!historical&&sheet.canApproveDate} busy={busy||dirty} onDecide={(requestId,approved)=>void onAct(`/date-requests/${requestId}/decision`,"POST",{approved})}/>
  </DocumentSection>;
}
