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

const reworkStatusLabel = (status: WholeOrderReviewResponse["reworkStatus"]): string => ({
  draft: "草稿",
  pending_process_configuration: "待配置工序",
  pending_ie_review: "待 IE 审核",
  pending_task_assignment: "待分工",
  in_progress: "返工执行中",
  pending_order_review: "待整单审核",
  pending_quantity_adjustment_ie_review: "数量调整待 IE",
  pending_responsibility_determination: "待责任判定",
  pending_owner_signature: "待老板确认签字",
  pending_responsibility_action: "责任处理中",
  completed: "已完成",
  cancelled: "已取消",
  deleted: "已删除",
})[status] ?? status;

const adjustmentStatusLabel = (status: WholeOrderReviewResponse["adjustments"][number]["status"]): string => ({
  effective: "已生效",
  pending_merchandiser_confirmation: "待订单跟单确认",
  pending_ie_review: "待 IE 复核",
  rejected: "已拒绝",
  expired: "已过期",
})[status] ?? status;

const oneDecimalQuantity = /^\d+(?:\.\d)?$/;

export function WholeOrderReviewPanel({ reworkOrderId, onChanged }: { reworkOrderId: string; onChanged: () => Promise<void> }) {
  const [data, setData] = useState<WholeOrderReviewResponse | null>(null);
  const [message, setMessage] = useState("正在加载整单完成状态…");
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const attempts = useRef<Record<string, string>>({});
  const load = async () => {
    const overview = await request("rework-orders/" + reworkOrderId + "/whole-order-review", WholeOrderReviewResponseSchema.parse);
    setData(overview);
    if (overview.reviewId) {
      setMessage("本单已完成整单确认并进入责任判定。完成记录继续保留供追溯。");
    } else if (overview.reworkStatus === "pending_order_review") {
      setMessage("所有工序均已达到当前有效计划。请尾部主管核对完成记录后确认本单返工全部完成。");
    } else if (overview.reworkStatus === "in_progress") {
      setMessage("当前仍在 N05 · 返工执行中。系统会自动判断各工序是否完成；全部完成后才进入整单确认。");
    } else {
      setMessage(`当前状态：${reworkStatusLabel(overview.reworkStatus)}。`);
    }
  };
  useEffect(() => {
    let requestInFlight = false;
    let hasLoaded = false;
    const refresh = async (): Promise<void> => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        await load();
        hasLoaded = true;
      } catch {
        if (!hasLoaded) setData(null);
      } finally {
        requestInFlight = false;
      }
    };
    void refresh();
  }, [reworkOrderId]);

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
    const process = data.processes.find((item) => item.configurationItemId === configurationItemId);
    if (!process) { setMessage("当前工序已刷新，请重新进入订单。"); return; }
    const rawTarget = targets[configurationItemId]?.trim() ?? "";
    const target = Number(rawTarget);
    if (!Number.isFinite(target) || target <= 0) { setMessage("请填写有效的新计划数量。"); return; }
    if (!oneDecimalQuantity.test(rawTarget)) {
      setMessage("计划数量最多保留一位小数。");
      return;
    }
    if (kind === "decrease" && target >= process.plannedQuantity) {
      setMessage(`减少后的计划数量必须小于当前计划 ${process.plannedQuantity}。`);
      return;
    }
    if (kind === "decrease" && target < process.completedQuantity) {
      setMessage(`计划数量不能低于已经完成的 ${process.completedQuantity}。`);
      return;
    }
    if (kind === "increase" && target <= process.plannedQuantity) {
      setMessage(`增加后的计划数量必须大于当前计划 ${process.plannedQuantity}。`);
      return;
    }
    const reason = window.prompt(kind === "decrease" ? "请填写减少计划数量的业务原因" : "请填写增加计划数量的业务原因");
    if (!reason?.trim()) return;
    try {
      const body = kind === "decrease"
        ? { expectedOrderVersion: data.orderVersion, configurationItemId, newPlannedQuantity: target, reason }
        : { expectedOrderVersion: data.orderVersion, configurationItemId, newPlannedQuantity: target, reason, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), requiresIeReview: true };
      await call("rework-orders/" + reworkOrderId + "/quantity-adjustments/" + kind, QuantityAdjustmentResponseSchema.parse, body);
      setMessage(kind === "decrease" ? "异常数量调整已生效并留存历史版本。" : "增加申请已创建；当前有效计划暂不改变，等待订单跟单确认。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "数量调整失败"); }
  };

  const reject = async (reportId: string, personId: string | null) => {
    if (!data) return;
    const reason = window.prompt("请填写驳回这条完成记录的原因");
    if (!reason?.trim()) return;
    try {
      await call("work-reports/" + reportId + "/reject", WholeOrderReviewResponseSchema.parse, { expectedOrderVersion: data.orderVersion, rejectedPersonId: personId, reason });
      setMessage(personId ? "已驳回该人员的完成记录；订单将按有效完成数量重新判断是否补齐。" : "已驳回整条集体完成记录；订单将按有效完成数量重新判断是否补齐。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "完成记录驳回失败"); }
  };

  const confirm = async (adjustmentId: string, decision: "confirmed" | "rejected") => {
    if (!data) return;
    const adjustment = data.adjustments.find((item) => item.adjustmentId === adjustmentId);
    if (!adjustment) return;
    const cutInput = window.prompt("确认实裁数量", String(adjustment.requestedPlannedQuantity));
    if (cutInput === null) return;
    const returnInput = window.prompt("确认回货数量", String(adjustment.requestedPlannedQuantity));
    if (returnInput === null) return;
    const maximumInput = window.prompt("确认允许的计划数量上限", String(adjustment.requestedPlannedQuantity));
    if (maximumInput === null) return;
    const quantityInputs = [cutInput.trim(), returnInput.trim(), maximumInput.trim()];
    const actualCutQuantity = Number(quantityInputs[0]);
    const actualReturnQuantity = Number(quantityInputs[1]);
    const allowedMaximumQuantity = Number(quantityInputs[2]);
    if (
      !quantityInputs.every((value) => oneDecimalQuantity.test(value))
      || ![actualCutQuantity, actualReturnQuantity, allowedMaximumQuantity].every(Number.isFinite)
      || actualCutQuantity < 0
      || actualReturnQuantity < 0
      || allowedMaximumQuantity <= 0
    ) {
      setMessage("实裁、回货和允许上限最多保留一位小数；数量不能为负数，允许上限必须大于 0。");
      return;
    }
    const reason = decision === "rejected" ? window.prompt("请填写拒绝原因") : undefined;
    if (decision === "rejected" && !reason?.trim()) return;
    try {
      await call("quantity-adjustments/" + adjustmentId + "/confirm", QuantityAdjustmentResponseSchema.parse, { expectedOrderVersion: data.orderVersion, expectedAdjustmentVersion: adjustment.adjustmentVersion, decision, actualCutQuantity, actualReturnQuantity, allowedMaximumQuantity, ...(reason ? { reason } : {}) });
      setMessage(decision === "confirmed" ? "跟单确认已留痕；下一步由 IE 复核增加数量。" : "增加申请已拒绝，当前有效计划未改变。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "确认失败"); }
  };

  const reviewIncrease = async (adjustmentId: string, decision: "approved" | "rejected") => {
    if (!data) return;
    const adjustment = data.adjustments.find((item) => item.adjustmentId === adjustmentId);
    if (!adjustment) return;
    const reason = decision === "rejected" ? window.prompt("请填写 IE 驳回原因") : undefined;
    if (decision === "rejected" && !reason?.trim()) return;
    try {
      await call("quantity-adjustments/" + adjustmentId + "/ie-review", QuantityAdjustmentResponseSchema.parse, { expectedOrderVersion: data.orderVersion, expectedAdjustmentVersion: adjustment.adjustmentVersion, decision, ...(reason ? { reason } : {}) });
      setMessage(decision === "approved" ? "IE 已通过增加调整，订单已回到返工执行节点补齐新增数量。" : "IE 已驳回增加调整，当前有效计划未改变。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "IE 复核失败"); }
  };

  const approve = async () => {
    if (!data || !window.confirm("确认本单所有有效完成记录无误，并进入责任判定？")) return;
    try {
      await call("rework-orders/" + reworkOrderId + "/whole-order-review/approve", WholeOrderReviewResponseSchema.parse, { expectedOrderVersion: data.orderVersion });
      setMessage("本单返工已确认全部完成，已流转到 N07 · 待责任判定。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "整单完成确认失败"); }
  };

  if (!data || ["draft", "pending_process_configuration", "pending_ie_review", "pending_task_assignment"].includes(data.reworkStatus)) return null;

  const allComplete = data.processes.length > 0 && data.processes.every((process) => process.complete);
  const hasAdjustmentWork = data.canAdjustQuantity
    || data.canConfirmQuantity
    || data.canReviewQuantityIncrease
    || data.adjustments.length > 0;

  return <div className="whole-order-review-flow">
    <Surface>
      <div className="section-title">
        <div>
          <h2>{data.reworkStatus === "pending_order_review" ? "N06 · 整单完成确认" : "返工完成进度"}</h2>
          <p>{message}</p>
        </div>
        <StatusBadge tone={data.reworkStatus === "pending_order_review" ? "warning" : allComplete ? "success" : "info"}>{reworkStatusLabel(data.reworkStatus)}</StatusBadge>
      </div>
      <div className="workflow-queue-guide">
        <div><small>谁来处理</small><strong>{data.reworkStatus === "pending_order_review" ? "尾部主管" : "系统自动判断 / 授权主管查看"}</strong></div>
        <div><small>当前要做什么</small><strong>{data.reworkStatus === "pending_order_review" ? "核对所有有效完成记录，确认整张返工单已经做完" : "等待工人把各工序实际完成数量补齐"}</strong></div>
        <div><small>完成后去哪里</small><strong>{data.reworkStatus === "pending_order_review" ? "确认后进入 N07 · 责任判定" : "全部工序完成后自动进入 N06 · 整单审核"}</strong></div>
      </div>
    </Surface>

    <Surface>
      <h2>工序完成状态（系统自动计算）</h2>
      <p>这里只显示结果，不需要人工再次判断。系统按“有效完成数量 / 当前有效计划”自动决定是否完成。</p>
      {data.processes.map((process) => <div className="section-title whole-order-row" key={process.configurationItemId}>
        <div>
          <b>{process.processName}</b>
          <p>有效完成 {process.completedQuantity} / 当前计划 {process.plannedQuantity} {process.pricingUnit === "piece" ? "件" : "小时"}</p>
        </div>
        <StatusBadge tone={process.complete ? "success" : "warning"}>{process.complete ? "已完成" : "未完成"}</StatusBadge>
      </div>)}
    </Surface>

    {(data.canReview || data.reports.length > 0) && <Surface>
      <h2>完成记录与驳回</h2>
      <p>主管只在记录确有错误时驳回；正常情况下无需逐条重复确认。</p>
      {data.reports.map((report) => <div className="section-title whole-order-row" key={report.workReportId}>
        <div>
          <b>完成 {report.actualQuantity}</b>
          <p>{report.members.map((member) => member.displayName).join("、")} · {report.rejected ? "已驳回：" + report.rejectionReason : "当前有效"}</p>
        </div>
        {data.canReview && !report.rejected && <div className="mobile-actions whole-order-actions">
          {report.assignmentMode === "collective"
            ? <Button onClick={() => void reject(report.workReportId, null)} disabled={busy}>驳回整条集体记录</Button>
            : report.members.map((member) => <Button key={member.personId} onClick={() => void reject(report.workReportId, member.personId)} disabled={busy}>驳回 {member.displayName}</Button>)}
        </div>}
      </div>)}
      {data.reports.length === 0 && <p>尚无完成记录。</p>}
    </Surface>}

    {data.canReview && data.reworkStatus === "pending_order_review" && <Surface>
      <h2>确认本单返工全部完成</h2>
      <p>确认后生产返工部分结束并流转到责任判定。若发现完成数量错误，请先在上方驳回对应记录。</p>
      <div className="mobile-actions">
        <Button variant="primary" onClick={() => void approve()} disabled={busy || !allComplete}>{busy ? "确认中…" : "确认本单返工全部完成，进入责任判定"}</Button>
      </div>
    </Surface>}

    {hasAdjustmentWork && <Surface>
      <details className="quantity-exception-panel">
        <summary><b>异常处理：数量调整</b>（正常返工无需进入）</summary>
        <p>只有计划数量与真实业务事实不一致时才使用。减少计划直接留痕；增加计划需要按现有确认/IE 复核流程处理。</p>
        {data.processes.map((process) => data.canAdjustQuantity ? <div className="section-title whole-order-row" key={process.configurationItemId}>
          <div>
            <b>{process.processName}</b>
            <p>当前计划 {process.plannedQuantity} · 已有效完成 {process.completedQuantity}</p>
          </div>
          <div className="mobile-actions whole-order-actions">
            <InsetField label="调整后的计划数量" type="number" min="0.1" step="0.1" inputMode="decimal" value={targets[process.configurationItemId] ?? ""} onChange={(event) => setTargets((current) => ({ ...current, [process.configurationItemId]: event.target.value }))} disabled={busy} />
            <Button onClick={() => void adjust(process.configurationItemId, "decrease")} disabled={busy}>减少计划</Button>
            <Button onClick={() => void adjust(process.configurationItemId, "increase")} disabled={busy}>申请增加</Button>
          </div>
        </div> : null)}

        <h3>数量调整记录</h3>
        {data.adjustments.map((adjustment) => <div className="section-title whole-order-row" key={adjustment.adjustmentId}>
          <div>
            <b>{adjustment.kind === "increase" ? "增加" : "减少"}：{adjustment.previousPlannedQuantity} → {adjustment.requestedPlannedQuantity}</b>
            <p>{adjustmentStatusLabel(adjustment.status)} · {adjustment.reason}</p>
          </div>
          {data.canConfirmQuantity && adjustment.status === "pending_merchandiser_confirmation" && <div className="mobile-actions whole-order-actions">
            <Button variant="primary" onClick={() => void confirm(adjustment.adjustmentId, "confirmed")} disabled={busy}>确认实裁/回货</Button>
            <Button onClick={() => void confirm(adjustment.adjustmentId, "rejected")} disabled={busy}>拒绝申请</Button>
          </div>}
          {data.canReviewQuantityIncrease && adjustment.status === "pending_ie_review" && <div className="mobile-actions whole-order-actions">
            <Button variant="primary" onClick={() => void reviewIncrease(adjustment.adjustmentId, "approved")} disabled={busy}>IE 通过</Button>
            <Button onClick={() => void reviewIncrease(adjustment.adjustmentId, "rejected")} disabled={busy}>IE 驳回</Button>
          </div>}
        </div>)}
        {data.adjustments.length === 0 && <p>暂无数量调整记录。</p>}
      </details>
    </Surface>}
  </div>;
}
