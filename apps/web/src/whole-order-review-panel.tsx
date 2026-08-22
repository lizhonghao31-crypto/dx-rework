import {
  TailInspectionResponseSchema,
  WholeOrderReviewResponseSchema,
  type TailInspectionResponse,
} from "@dx-rework/contracts";
import {
  CompletionConfirmationMutationResponseSchema,
  CompletionIeReviewMutationResponseSchema,
  CompletionReviewResponseSchema,
  type CompletionReviewResponse,
} from "@dx-rework/contracts/completion-review";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { confirmInApp, promptInApp } from "./system-dialog.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const request = async <T,>(path: string, parse: (value: unknown) => T, init?: RequestInit): Promise<T> => {
  const response = await fetch(apiUrl(path), { credentials: "include", ...init, headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  if (!response.ok) { const body = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw new Error(body?.error?.message ?? "请求未完成，请稍后重试"); }
  return parse(await response.json());
};

const reworkStatusLabel = (status: CompletionReviewResponse["reworkStatus"]): string => ({
  draft: "草稿",
  pending_process_configuration: "待配置工序",
  pending_ie_review: "待 IE 核价",
  pending_task_assignment: "待分工",
  in_progress: "返工执行中",
  pending_order_review: "待尾部确认",
  pending_quantity_adjustment_ie_review: "历史订单数量调整待 IE",
  pending_completion_ie_review: "待 IE 复核",
  pending_responsibility_determination: "待责任判定",
  pending_owner_signature: "待老板确认签字",
  pending_responsibility_action: "责任处理中",
  completed: "已完成",
  cancelled: "已取消",
  deleted: "已删除",
})[status] ?? status;

export function WholeOrderReviewPanel({ reworkOrderId, onChanged }: { reworkOrderId: string; onChanged: () => Promise<void> }) {
  const [data, setData] = useState<CompletionReviewResponse | null>(null);
  const [tailData, setTailData] = useState<TailInspectionResponse | null>(null);
  const [message, setMessage] = useState("正在加载返工完成状态…");
  const [busy, setBusy] = useState(false);
  const [multipliers, setMultipliers] = useState<Record<string, string>>({});
  const [multiplierReasons, setMultiplierReasons] = useState<Record<string, string>>({});
  const [finalQuantities, setFinalQuantities] = useState<Record<string, string>>({});
  const [ieReviewReason, setIeReviewReason] = useState("");
  const attempts = useRef<Record<string, string>>({});

  const load = async () => {
    const overview = await request(
      "rework-orders/" + reworkOrderId + "/whole-order-review",
      CompletionReviewResponseSchema.parse,
    );
    const tail = overview.unifiedExecutionRequired
      ? null
      : await request(
        "rework-orders/" + reworkOrderId + "/tail-inspection",
        TailInspectionResponseSchema.parse,
      );
    const confirmedByProcess = new Map(
      (overview.completionConfirmation?.processes ?? []).map((process) => [process.configurationItemId, process.finalConfirmedQuantity]),
    );
    setData(overview);
    setTailData(tail);
    setFinalQuantities((current) => Object.fromEntries(overview.processes.map((process) => [
      process.configurationItemId,
      current[process.configurationItemId]
        ?? String(confirmedByProcess.get(process.configurationItemId) ?? process.completedQuantity),
    ])));
    setMultipliers((current) => Object.fromEntries(overview.temporaryWorkers.map((worker) => {
      const id = `${worker.configurationItemId}:${worker.personId}`;
      return [id, current[id] ?? String(worker.multiplier)];
    })));
    setMultiplierReasons((current) => Object.fromEntries(overview.temporaryWorkers.map((worker) => {
      const id = `${worker.configurationItemId}:${worker.personId}`;
      return [id, current[id] ?? worker.reason ?? ""];
    })));
    if (overview.reviewId || overview.reworkStatus === "pending_responsibility_determination") {
      setMessage("IE 已复核通过；最终数量已锁定并进入责任判定。");
    } else if (overview.reworkStatus === "pending_completion_ie_review") {
      setMessage("尾部最终数量已确认；等待 IE 复核数量与质量，工资尚未正式生成。");
    } else if (overview.reworkStatus === "pending_order_review") {
      setMessage(overview.completionConfirmation?.ieReview?.decision === "rejected"
        ? "IE 已退回上一版最终确认；请重新核对最终数量后再次提交。"
        : "请核对工人申报、尾查数量和最终确认数量；原始报数始终保留。",
      );
    } else if (overview.reworkStatus === "in_progress") {
      setMessage("返工人员与尾查执行报数全部完成后进入尾部确认。");
    } else {
      setMessage("");
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

  const reject = async (reportId: string, personId: string | null, executionKind: "worker" | "tail_inspection" = "worker") => {
    if (!data || data.reworkStatus !== "pending_order_review") return;
    const reason = await promptInApp(executionKind === "tail_inspection" ? "请填写驳回这条尾查报数的原因" : "请填写驳回这条完成记录的原因");
    if (!reason?.trim()) return;
    try {
      await call("work-reports/" + reportId + "/reject", WholeOrderReviewResponseSchema.parse, { expectedOrderVersion: data.orderVersion, rejectedPersonId: personId, reason });
      setMessage(executionKind === "tail_inspection"
        ? "已驳回该尾查报数；原记录保留，尾查可重新报数。"
        : personId ? "已驳回该人员的完成记录；原记录保留，等待重新上数。" : "已驳回整条集体完成记录；原记录保留，等待重新上数。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "完成记录驳回失败"); }
  };

  const rejectTailInspection = async (assignmentId: string, inspectorName: string) => {
    if (!data || data.reworkStatus !== "pending_order_review") return;
    const reason = await promptInApp(`请填写驳回 ${inspectorName} 尾查报数的原因`);
    if (!reason?.trim()) return;
    try {
      await call(
        "tail-inspection-assignments/" + assignmentId + "/reject",
        TailInspectionResponseSchema.parse,
        { expectedOrderVersion: data.orderVersion, reason: reason.trim() },
      );
      setMessage(`已驳回 ${inspectorName} 的尾查报数；原记录保留，尾查可重新报数。`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "尾查报数驳回失败");
    }
  };

  const coefficientPayload = () => data?.temporaryWorkers.map((worker) => {
    const id = `${worker.configurationItemId}:${worker.personId}`;
    const reason = multiplierReasons[id]?.trim() ?? "";
    return {
      configurationItemId: worker.configurationItemId,
      personId: worker.personId,
      multiplier: Number(multipliers[id]?.trim() ?? ""),
      ...(reason ? { reason } : {}),
    };
  }) ?? [];

  const confirmCompletion = async () => {
    if (!data || data.reworkStatus !== "pending_order_review") return;
    const coefficientRows = data.temporaryWorkers.map((worker) => {
      const id = `${worker.configurationItemId}:${worker.personId}`;
      return { text: multipliers[id]?.trim() ?? "", reason: multiplierReasons[id]?.trim() ?? "" };
    });
    if (coefficientRows.some((row) => !/^\d+(?:\.\d{1,3})?$/.test(row.text) || Number(row.text) <= 0 || Number(row.text) > 10)) {
      setMessage("临时工实发系数必须大于 0 且不超过 10，最多三位小数。");
      return;
    }
    if (coefficientRows.some((row) => Number(row.text) !== 1 && !row.reason)) {
      setMessage("临时工实发系数不是 1.0 时，必须填写调整原因。");
      return;
    }
    const finalRows = data.processes.map((process) => ({
      process,
      text: finalQuantities[process.configurationItemId]?.trim() ?? "",
    }));
    if (finalRows.some(({ text }) => !/^\d+(?:\.\d{1,2})?$/.test(text) || Number(text) <= 0)) {
      setMessage("最终确认数量必须大于 0，最多两位小数。");
      return;
    }
    if (finalRows.some(({ process, text }) => Number(text) > process.tailCheckedQuantity)) {
      setMessage("最终确认数量不能超过对应尾查数量。");
      return;
    }
    if (!(await confirmInApp("确认当前最终数量并提交 IE 复核？IE 通过前不会正式生成工资。"))) return;
    try {
      await call(
        "rework-orders/" + reworkOrderId + "/completion-confirmation",
        CompletionConfirmationMutationResponseSchema.parse,
        {
          expectedOrderVersion: data.orderVersion,
          finalQuantities: finalRows.map(({ process, text }) => ({
            configurationItemId: process.configurationItemId,
            finalConfirmedQuantity: Number(text),
          })),
          temporaryCoefficients: coefficientPayload(),
        },
      );
      setMessage("最终数量已提交 IE 复核；原始上数与本次修改记录均已保留。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "最终数量确认失败"); }
  };

  const reviewCompletion = async (decision: "approved" | "rejected") => {
    if (!data || data.reworkStatus !== "pending_completion_ie_review" || !data.canCompletionIeReview) return;
    const approved = decision === "approved";
    if (!(await confirmInApp(approved
      ? "确认数量与质量复核通过？通过后按最终确认数量生成工资，并进入责任判定。"
      : "确认退回尾部主管重新确认最终数量？"))) return;
    try {
      await call(
        "rework-orders/" + reworkOrderId + "/completion-ie-review",
        CompletionIeReviewMutationResponseSchema.parse,
        {
          expectedOrderVersion: data.orderVersion,
          decision,
          ...(ieReviewReason.trim() ? { reason: ieReviewReason.trim() } : {}),
        },
      );
      setIeReviewReason("");
      setMessage(approved
        ? "IE 复核通过；工资已按最终确认数量生成并进入责任判定。"
        : "已退回尾部确认；历史确认与退回记录均保留。",
      );
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "IE 复核提交失败"); }
  };

  if (!data || ["draft", "pending_process_configuration", "pending_ie_review", "pending_task_assignment"].includes(data.reworkStatus)) return null;

  const allComplete = data.processes.length > 0 && data.processes.every((process) => process.complete);
  const submittedTailAssignments = tailData?.assignments.filter((assignment) => assignment.submittedAt !== null) ?? [];
  const temporaryCoefficientRows = data.temporaryWorkers.map((worker) => {
    const id = `${worker.configurationItemId}:${worker.personId}`;
    return { text: multipliers[id]?.trim() ?? "", reason: multiplierReasons[id]?.trim() ?? "" };
  });
  const temporaryCoefficientIssue = temporaryCoefficientRows.some((row) => !/^\d+(?:\.\d{1,3})?$/.test(row.text) || Number(row.text) <= 0 || Number(row.text) > 10)
    ? "还需完成：临时工实发系数须大于 0、不超过 10，最多三位小数"
    : temporaryCoefficientRows.some((row) => Number(row.text) !== 1 && !row.reason)
      ? "还需完成：非 1.0 的临时工实发系数必须填写调整原因"
      : "";
  const finalQuantityIssue = data.reworkStatus === "pending_order_review" && data.processes.some((process) => {
    const text = finalQuantities[process.configurationItemId]?.trim() ?? "";
    return !/^\d+(?:\.\d{1,2})?$/.test(text) || Number(text) <= 0 || Number(text) > process.tailCheckedQuantity;
  }) ? "还需完成：最终确认数量须大于 0 且不超过尾查数量" : "";
  const wholeOrderReady = allComplete && temporaryCoefficientIssue === "" && finalQuantityIssue === "";
  const confirmationByProcess = new Map(
    (data.completionConfirmation?.processes ?? []).map((process) => [process.configurationItemId, process]),
  );
  const isTailConfirmation = data.reworkStatus === "pending_order_review";
  const isIeCompletionReview = data.reworkStatus === "pending_completion_ie_review";

  return <div className="whole-order-review-flow">
    <Surface>
      <div className="section-title">
        <div>
          <h2>{isTailConfirmation ? "N07 · 尾部确认" : isIeCompletionReview ? "N08 · IE 复核" : "返工完成进度"}</h2>
          {message && <p>{message}</p>}
        </div>
        <StatusBadge tone={isTailConfirmation || isIeCompletionReview ? "warning" : allComplete ? "success" : "info"}>{reworkStatusLabel(data.reworkStatus)}</StatusBadge>
      </div>
    </Surface>

    {data.completionConfirmation?.ieReview?.decision === "rejected" && isTailConfirmation && <Surface>
      <StatusBadge tone="warning">上一版被 IE 退回</StatusBadge>
      <p>{data.completionConfirmation.ieReview.reason || "IE 未填写退回说明；请重新核对最终生产数量。"}</p>
    </Surface>}

    <Surface>
      <h2>{isTailConfirmation || isIeCompletionReview ? "生产数量事实" : "统一执行报数状态"}</h2>
      <p>{isTailConfirmation
        ? "工人申报和尾查数量保持原始事实；尾部主管只确认最终生产数量，修改会记录修改人和时间。"
        : isIeCompletionReview
          ? "请复核数量真实性与质量真实性；本节点不重新核价。"
          : "返工人员与尾查的执行报数全部完成后进入尾部确认。"}</p>
      {data.processes.map((process) => {
        const confirmed = confirmationByProcess.get(process.configurationItemId);
        const finalValue = confirmed?.finalConfirmedQuantity ?? process.completedQuantity;
        return <div className="section-title whole-order-row" key={process.configurationItemId}>
          <div className="whole-order-process-main">
            <b className="whole-order-process-name">{process.processName}</b>
            <div className="whole-order-metrics">
              <span className="whole-order-metric"><span className="whole-order-metric-label">工人申报</span><strong className="whole-order-metric-value">{process.completedQuantity} 件</strong></span>
              <span className="whole-order-metric"><span className="whole-order-metric-label">尾查数量</span><strong className="whole-order-metric-value">{process.tailCheckedQuantity} 件</strong></span>
              {isTailConfirmation && data.canReview
                ? <InsetField label="最终确认数量" type="number" min="0.01" step="0.01" inputMode="decimal" value={finalQuantities[process.configurationItemId] ?? String(finalValue)} disabled={busy} onChange={(event) => setFinalQuantities((current) => ({ ...current, [process.configurationItemId]: event.target.value }))} />
                : <span className="whole-order-metric"><span className="whole-order-metric-label">最终确认</span><strong className="whole-order-metric-value">{finalValue} 件</strong></span>}
              {confirmed?.modified && <span className="whole-order-gap"><span className="whole-order-gap-label">已调整</span><strong className="whole-order-gap-value">原 {confirmed.originalQuantity} 件</strong></span>}
            </div>
          </div>
          <StatusBadge tone={process.complete ? "success" : "danger"}>{process.complete ? isTailConfirmation ? "待确认" : isIeCompletionReview ? "待 IE 复核" : "已完成" : "需驳回调整"}</StatusBadge>
        </div>;
      })}
    </Surface>

    {(data.canReview || data.canCompletionIeReview || data.reports.length > 0) && <Surface>
      <h2>{data.unifiedExecutionRequired ? "执行原始报数" : "工人原始上数"}</h2>
      <p>{isIeCompletionReview ? "IE 在这里核对原始执行事实；如整体事实不可信，请退回尾部确认，不在本节点改数或改价。" : "原始上数永久保留；尾部确认前发现单条错误，可驳回对应记录重报。"}</p>
      {data.reports.map((report) => <div className="section-title whole-order-row" key={report.workReportId}>
        <div className="whole-order-report-main">
          <b className="whole-order-person-name">{report.executionKind === "tail_inspection" ? "尾查 · " : ""}{report.members.map((member) => member.displayName).join("、")}</b>
          <div className="whole-order-report-meta">
            <span className="whole-order-report-label">申报</span>
            <strong className="whole-order-report-value">{report.actualQuantity} 件</strong>
            <span className={`whole-order-report-state${report.rejected ? " is-danger" : ""}`}>{report.rejected ? "已驳回：" + report.rejectionReason : "当前有效"}</span>
          </div>
        </div>
        {isTailConfirmation && data.canReview && !report.rejected && <div className="mobile-actions whole-order-actions">
          {report.assignmentMode === "collective"
            ? <Button onClick={() => void reject(report.workReportId, null, report.executionKind)} disabled={busy}>驳回整条集体记录</Button>
            : report.members.map((member) => <Button key={member.personId} onClick={() => void reject(report.workReportId, member.personId, report.executionKind)} disabled={busy}>驳回 {report.executionKind === "tail_inspection" ? "尾查 " : ""}{member.displayName}</Button>)}
        </div>}
      </div>)}
      {data.reports.length === 0 && <p>尚无执行报数记录。</p>}
    </Surface>}

    {!data.unifiedExecutionRequired && isTailConfirmation && submittedTailAssignments.length > 0 && <Surface>
      <h2>尾查报数记录</h2>
      <p>尾查数量有误时驳回，原记录保留，尾查重新报数后自动回到本节点核对。</p>
      {submittedTailAssignments.map((assignment) => <div className="section-title whole-order-row" key={assignment.assignmentId}>
        <div className="whole-order-report-main">
          <b className="whole-order-person-name">{assignment.tailInspectorName}</b>
          <div className="whole-order-report-meta">
            <span className="whole-order-report-label">返件总数</span>
            <strong className="whole-order-report-value">{assignment.returnedQuantity ?? 0} 件</strong>
            <span className="whole-order-report-state">当前有效</span>
          </div>
        </div>
        {data.canReview && <div className="mobile-actions whole-order-actions">
          <Button disabled={busy} onClick={() => void rejectTailInspection(assignment.assignmentId, assignment.tailInspectorName)}>驳回尾查</Button>
        </div>}
      </div>)}
    </Surface>}

    {isTailConfirmation && data.canReview && data.temporaryWorkers.length > 0 && <Surface>
      <h2>临时工实发系数</h2>
      <p>默认 1.0；非 1.0 必须填写调整原因。该系数随本次最终确认一起锁定。</p>
      {data.temporaryWorkers.map((worker) => {
        const id = `${worker.configurationItemId}:${worker.personId}`;
        return <div className="section-title whole-order-row" key={id}>
          <div><b>{worker.displayName} · {worker.processName}</b></div>
          <div className="mobile-actions whole-order-actions">
            <InsetField label="实发系数" type="number" min="0.001" max="10" step="0.001" inputMode="decimal" value={multipliers[id] ?? "1"} disabled={busy} onChange={(event) => setMultipliers((current) => ({ ...current, [id]: event.target.value }))} />
            <InsetField label="调整原因（非 1.0 必填）" value={multiplierReasons[id] ?? ""} disabled={busy} onChange={(event) => setMultiplierReasons((current) => ({ ...current, [id]: event.target.value }))} />
          </div>
        </div>;
      })}
    </Surface>}

    {isTailConfirmation && data.canReview && data.processes.every((process) => process.finalUnitPrice !== null) && <Surface>
      <h2>提交最终生产数量</h2>
      <p className="whole-order-confirmation-copy">本次只形成最终生产事实并提交 IE 复核；IE 通过后才按最终确认数量生成正式工资。</p>
      <div className="mobile-actions">
        <Button variant="primary" onClick={() => void confirmCompletion()} disabled={busy || !wholeOrderReady}>{busy ? "提交中…" : "确认最终数量并提交 IE"}</Button>
      </div>
      {(temporaryCoefficientIssue || finalQuantityIssue) && <p role="status">{temporaryCoefficientIssue || finalQuantityIssue}</p>}
    </Surface>}

    {isIeCompletionReview && data.canCompletionIeReview && <Surface>
      <h2>IE 数量与质量复核</h2>
      <p>只确认数量真实性与质量真实性，不重新核价。退回后返回尾部确认，所有历史数量和操作记录继续保留。</p>
      <InsetField label="复核备注（可选）" value={ieReviewReason} disabled={busy} onChange={(event) => setIeReviewReason(event.target.value)} placeholder="通过或退回都可补充说明" />
      <div className="mobile-actions">
        <Button disabled={busy} onClick={() => void reviewCompletion("rejected")}>退回尾部确认</Button>
        <Button variant="primary" disabled={busy} onClick={() => void reviewCompletion("approved")}>数量与质量复核通过</Button>
      </div>
    </Surface>}
  </div>;
}
