import { formatBusinessCurrency } from "@dx-rework/contracts/business-display";
import type { ExternalResponsibilityCaseResponse } from "@dx-rework/contracts/external-responsibility";
import { ExternalEvidenceView } from "./external-evidence-view.js";

type Request = NonNullable<ExternalResponsibilityCaseResponse["specialApproval"]>;
const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function Explanation({ text }: { text: string }) {
  return text.length > 160 ? <details className="external-special-explanation"><summary>{text.slice(0, 80)}… <span>展开全文</span></summary><p>{text}</p></details> : <>{text}</>;
}

export function ExternalSpecialHistory({ caseItem }: { caseItem: ExternalResponsibilityCaseResponse }) {
  const requests = [...new Map([
    ...(caseItem.specialApprovalHistory ?? []),
    ...(caseItem.specialApproval ? [caseItem.specialApproval] : []),
  ].map(request => [request.requestId, request])).values()].sort((a, b) => b.requestVersion - a.requestVersion);
  const latest = requests[0];
  if (!latest) return null;
  const label = (request: Request) => request.decision?.decision === "approved" ? "已批准"
    : request.decision?.decision === "returned" ? "已退回" : "待财务总监审批";
  const record = (request: Request, current: boolean) => <div className="external-special-record" key={request.requestId}>
    <div className="external-special-heading"><b>{current ? "最新特批" : "特批申请"} · 第 {request.requestVersion} 轮</b><strong>{label(request)}</strong></div>
    <div className="external-special-meta">
      <span>申请时间 <time dateTime={request.requestedAt}>{dateFormat.format(new Date(request.requestedAt))}</time></span>
      {request.decision && <span>处理时间 <time dateTime={request.decision.decidedAt}>{dateFormat.format(new Date(request.decision.decidedAt))}</time></span>}
    </div>
    {!(current && caseItem.status === "closed") && <p>{request.requestMode === "proposed_entry" ? "申请金额" : "申请时累计已扣"} <b>{formatBusinessCurrency(request.requestMode === "proposed_entry" ? request.requestedAmount ?? "0.00" : request.actualDeductedAmount)}</b></p>}
    <dl>
      <dt>申请说明</dt><dd><Explanation text={request.reason.trim() || "未填写"} /></dd>
      {request.decision?.decision === "returned" && <><dt>退回原因</dt><dd><Explanation text={request.decision.reason?.trim() || "未记录退回原因"} /></dd></>}
      {request.decision?.decision === "approved" && request.decision.reason?.trim() && <><dt>批准说明</dt><dd><Explanation text={request.decision.reason} /></dd></>}
    </dl>
    <ExternalEvidenceView attachmentIds={request.attachmentIds} files={caseItem.evidenceAttachments ?? []} />
  </div>;
  return <section className="external-special-history" aria-label="财务特批记录">
    {record(latest, true)}
    {requests.length > 1 && <details className="external-special-older"><summary>历史申请（{requests.length - 1}）</summary>
      {requests.slice(1).map(request => record(request, false))}
    </details>}
  </section>;
}
