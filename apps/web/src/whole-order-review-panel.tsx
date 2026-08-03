import {
  QuantityAdjustmentResponseSchema,
  WholeOrderReviewResponseSchema,
  type WholeOrderReviewResponse,
} from "@dx-rework/contracts";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const request = async <T,>(path: string, parse: (value: unknown) => T, init?: RequestInit): Promise<T> => {
  const response = await fetch(apiUrl(path), { credentials: "include", ...init, headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  if (!response.ok) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw new Error(body?.error?.message ?? "请求未完成，请稍后重试"); }
  return parse(await response.json());
};

export function WholeOrderReviewPanel({ reworkOrderId, onChanged }: { reworkOrderId: string; onChanged: () => Promise<void> }) {
  const [data, setData] = useState<WholeOrderReviewResponse | null>(null);
  const [message, setMessage] = useState("正在加载整单审核…");
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const attempts = useRef<Record<string, string>>({});
  const load = async () => {
    const overview = await request("rework-orders/" + reworkOrderId + "/whole-order-review", WholeOrderReviewResponseSchema.parse);
    setData(overview);
    setMessage(overview.reviewId ? "整单已审核，已进入待责任判定。" : "数量与驳回均以服务端当前有效记录为准。");
  };
  useEffect(() => { void load().catch(() => setData(null)); }, [reworkOrderId]);
  const call = async <T,>(path: string, parse: (value: unknown) => T, body: unknown, method = "POST") => {
    const signature = path + JSON.stringify(body);
    const idempotencyKey = attempts.current[signature] ?? crypto.randomUUID();
    attempts.current[signature] = idempotencyKey;
    setBusy(true);
    try {
      const result = await request(path, parse, { method, headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(body) });
      delete attempts.current[signature];
      await load();
      await onChanged();
      return result;
    } finally { setBusy(false); }
  };
  const adjust = async (configurationItemId: string, kind: "decrease" | "increase") => {
    if (!data) return;
    const target = Number(targets[configurationItemId]);
    if (!Number.isFinite(target) || target <= 0) { setMessage("请填写有效的新计划数量。"); return; }
    const reason = window.prompt(kind === "decrease" ? "请填写减少原因" : "请填写增加原因");
    if (!reason?.trim()) return;
    try {
      const body = kind === "decrease"
        ? { expectedOrderVersion: data.orderVersion, configurationItemId, newPlannedQuantity: target, reason }
        : { expectedOrderVersion: data.orderVersion, configurationItemId, newPlannedQuantity: target, reason, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), requiresIeReview: true };
      await call("rework-orders/" + reworkOrderId + "/quantity-adjustments/" + kind, QuantityAdjustmentResponseSchema.parse, body);
      setMessage(kind === "decrease" ? "计划数量已减少并留存历史版本。" : "增加申请已创建，未改变有效计划，等待订单跟单确认。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "数量调整失败"); }
  };
  const reject = async (reportId: string, personId: string | null) => {
    if (!data) return;
    const reason = window.prompt("请填写驳回原因");
    if (!reason?.trim()) return;
    try { await call("work-reports/" + reportId + "/reject", WholeOrderReviewResponseSchema.parse, { expectedOrderVersion: data.orderVersion, rejectedPersonId: personId, reason }); setMessage(personId ? "已驳回个人上数；其余记录未变。" : "已驳回整条集体上数及其完整成员分摊；其余记录未变。"); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "驳回失败"); }
  };
  const confirm = async (adjustmentId: string, decision: "confirmed" | "rejected") => {
    if (!data) return;
    const adjustment = data.adjustments.find((item) => item.adjustmentId === adjustmentId);
    if (!adjustment) return;
    const actualCutQuantity = Number(window.prompt("确认实裁数量", String(adjustment.requestedPlannedQuantity)));
    const actualReturnQuantity = Number(window.prompt("确认回货数量", String(adjustment.requestedPlannedQuantity)));
    const allowedMaximumQuantity = Number(window.prompt("确认允许的计划数量上限", String(adjustment.requestedPlannedQuantity)));
    const reason = decision === "rejected" ? window.prompt("请填写拒绝原因") : undefined;
    if (![actualCutQuantity, actualReturnQuantity, allowedMaximumQuantity].every(Number.isFinite) || (decision === "rejected" && !reason?.trim())) return;
    try { await call("quantity-adjustments/" + adjustmentId + "/confirm", QuantityAdjustmentResponseSchema.parse, { expectedOrderVersion: data.orderVersion, expectedAdjustmentVersion: adjustment.adjustmentVersion, decision, actualCutQuantity, actualReturnQuantity, allowedMaximumQuantity, ...(reason ? { reason } : {}) }); setMessage(decision === "confirmed" ? "跟单确认已留痕；若涉及工序或改价，下一步由IE复核。" : "增加申请已拒绝，当前有效计划未改变。"); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "确认失败"); }
  };
  const reviewIncrease = async (adjustmentId: string, decision: "approved" | "rejected") => {
    if (!data) return;
    const adjustment = data.adjustments.find((item) => item.adjustmentId === adjustmentId);
    if (!adjustment) return;
    const reason = decision === "rejected" ? window.prompt("请填写IE驳回原因") : undefined;
    if (decision === "rejected" && !reason?.trim()) return;
    try { await call("quantity-adjustments/" + adjustmentId + "/ie-review", QuantityAdjustmentResponseSchema.parse, { expectedOrderVersion: data.orderVersion, expectedAdjustmentVersion: adjustment.adjustmentVersion, decision, ...(reason ? { reason } : {}) }); setMessage(decision === "approved" ? "IE已通过增加调整，返工单已回到上数补齐。" : "IE已驳回增加调整，当前有效计划未改变。"); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "IE复核失败"); }
  };
  const approve = async () => {
    if (!data || !window.confirm("确认所有有效上数和成员快照无误，并进入待责任判定？")) return;
    try { await call("rework-orders/" + reworkOrderId + "/whole-order-review/approve", WholeOrderReviewResponseSchema.parse, { expectedOrderVersion: data.orderVersion }); setMessage("整单审核已通过，已进入待责任判定。 "); } catch (cause) { setMessage(cause instanceof Error ? cause.message : "整单审核失败"); }
  };
  if (!data) return null;
  return <><Surface><div className="section-title"><div><h2>整单审核与数量调整</h2><p>{message}</p></div><StatusBadge tone={data.reworkStatus === "pending_order_review" ? "warning" : "info"}>{data.reworkStatus}</StatusBadge></div><p>当前有效计划与未驳回上数逐工序校验；任何驳回都会使整单重新补齐。</p></Surface>
    <Surface><h2>工序完成判断</h2>{data.processes.map((process) => <div className="section-title" key={process.configurationItemId}><div><b>{process.processName}</b><p>有效上数 {process.completedQuantity} / 当前计划 {process.plannedQuantity} {process.pricingUnit === "piece" ? "件" : "小时"}</p></div><StatusBadge tone={process.complete ? "success" : "warning"}>{process.complete ? "已完成" : "未完成"}</StatusBadge>{data.canAdjustQuantity && <div className="mobile-actions"><InsetField label="新计划数量" inputMode="decimal" value={targets[process.configurationItemId] ?? ""} onChange={(event) => setTargets((current) => ({ ...current, [process.configurationItemId]: event.target.value }))} disabled={busy} /><Button onClick={() => void adjust(process.configurationItemId, "decrease")} disabled={busy}>减少计划</Button><Button onClick={() => void adjust(process.configurationItemId, "increase")} disabled={busy}>申请增加</Button></div>}</div>)}</Surface>
    <Surface><h2>上数记录与单条驳回</h2>{data.reports.map((report) => <div className="section-title" key={report.workReportId}><div><b>上数 {report.actualQuantity}</b><p>{report.members.map((member) => member.displayName).join("、")} · {report.rejected ? "已驳回：" + report.rejectionReason : "当前有效"}</p></div>{data.canReview && !report.rejected && <div className="mobile-actions">{report.members.length > 1 ? <Button onClick={() => void reject(report.workReportId, null)} disabled={busy}>驳回整条集体记录</Button> : report.members.map((member) => <Button key={member.personId} onClick={() => void reject(report.workReportId, member.personId)} disabled={busy}>驳回 {member.displayName}</Button>)}</div>}</div>)}{data.reports.length === 0 && <p>尚无上数记录。</p>}</Surface>
    <Surface><h2>数量调整记录</h2>{data.adjustments.map((adjustment) => <div className="section-title" key={adjustment.adjustmentId}><div><b>{adjustment.kind === "increase" ? "增加" : "减少"}：{adjustment.previousPlannedQuantity} → {adjustment.requestedPlannedQuantity}</b><p>{adjustment.status} · {adjustment.reason}</p></div>{data.canConfirmQuantity && adjustment.status === "pending_merchandiser_confirmation" && <div className="mobile-actions"><Button variant="primary" onClick={() => void confirm(adjustment.adjustmentId, "confirmed")} disabled={busy}>确认实裁/回货</Button><Button onClick={() => void confirm(adjustment.adjustmentId, "rejected")} disabled={busy}>拒绝申请</Button></div>}{data.canReviewQuantityIncrease && adjustment.status === "pending_ie_review" && <div className="mobile-actions"><Button variant="primary" onClick={() => void reviewIncrease(adjustment.adjustmentId, "approved")} disabled={busy}>IE通过</Button><Button onClick={() => void reviewIncrease(adjustment.adjustmentId, "rejected")} disabled={busy}>IE驳回</Button></div>}</div>)}{data.adjustments.length === 0 && <p>尚无数量调整。</p>}</Surface>
    {data.canReview && <div className="mobile-actions"><Button variant="primary" onClick={() => void approve()} disabled={busy || data.reworkStatus !== "pending_order_review" || data.processes.some((process) => !process.complete)}>整单审核通过</Button></div>}
  </>;
}
