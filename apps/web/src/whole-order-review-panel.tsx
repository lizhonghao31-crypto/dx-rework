import {
  TailInspectionResponseSchema,
  WholeOrderReviewResponseSchema,
  type TailInspectionResponse,
  type WholeOrderReviewResponse,
} from "@dx-rework/contracts";
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

const reworkStatusLabel = (status: WholeOrderReviewResponse["reworkStatus"]): string => ({
  draft: "草稿",
  pending_process_configuration: "待配置工序",
  pending_ie_review: "待 IE 核价",
  pending_task_assignment: "待启动任务",
  in_progress: "返工执行中",
  pending_order_review: "待尾部确认最终数量",
  pending_final_quantity_ie_review: "最终数量待 IE 复核",
  pending_quantity_adjustment_ie_review: "历史数量调整待 IE",
  pending_responsibility_determination: "待责任判定",
  pending_owner_signature: "待老板确认签字",
  pending_responsibility_action: "责任处理中",
  completed: "已完成",
  cancelled: "已取消",
  deleted: "已删除",
})[status] ?? status;

export function WholeOrderReviewPanel({ reworkOrderId, onChanged }: { reworkOrderId: string; onChanged: () => Promise<void> }) {
  const [data, setData] = useState<WholeOrderReviewResponse | null>(null);
  const [tailData, setTailData] = useState<TailInspectionResponse | null>(null);
  const [message, setMessage] = useState("正在加载最终数量确认状态…");
  const [busy, setBusy] = useState(false);
  const [finalQuantities, setFinalQuantities] = useState<Record<string, string>>({});
  const [multipliers, setMultipliers] = useState<Record<string, string>>({});
  const [multiplierReasons, setMultiplierReasons] = useState<Record<string, string>>({});
  const attempts = useRef<Record<string, string>>({});
  const requestInFlight = useRef(false);

  const load = async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      const overview = await request("rework-orders/" + reworkOrderId + "/whole-order-review", WholeOrderReviewResponseSchema.parse);
    const tail = overview.unifiedExecutionRequired || !overview.tailInspectionRequired
      ? null
      : await request("rework-orders/" + reworkOrderId + "/tail-inspection", TailInspectionResponseSchema.parse);
    const confirmedByProcess = new Map(overview.finalConfirmation?.quantities.map((quantity) => [quantity.configurationItemId, quantity.finalConfirmedQuantity]) ?? []);
    setData(overview);
    setTailData(tail);
    setFinalQuantities((current) => Object.fromEntries(overview.processes.map((process) => [
      process.configurationItemId,
      current[process.configurationItemId] ?? String(confirmedByProcess.get(process.configurationItemId) ?? process.completedQuantity),
    ])));
    setMultipliers((current) => Object.fromEntries(overview.temporaryWorkers.map((worker) => {
      const id = `${worker.configurationItemId}:${worker.personId}`;
      return [id, current[id] ?? String(worker.multiplier)];
    })));
    setMultiplierReasons((current) => Object.fromEntries(overview.temporaryWorkers.map((worker) => {
      const id = `${worker.configurationItemId}:${worker.personId}`;
      return [id, current[id] ?? worker.reason ?? ""];
    })));
    if (overview.reviewId) setMessage("IE 已复核通过，正式工资数量已锁定并进入责任判定。");
    else if (overview.reworkStatus === "pending_final_quantity_ie_review") setMessage("请 IE 核对最终数量与质量事实；IE 只能通过或退回，不能在这里改价。");
    else if (overview.reworkStatus === "pending_order_review") {
      const rejected = overview.finalConfirmation?.status === "rejected" ? overview.finalConfirmation.reviewReason : null;
      setMessage(rejected ? `IE 已退回上一版：${rejected}。请修正最终数量后重新提交。` : overview.tailInspectionRequired ? "请核对工人上数和尾查数量，并填写每道工序的最终确认数量。" : "本单无需整查，请核对工人有效上数并填写每道工序的最终确认数量。");
      } else if (overview.reworkStatus === "in_progress") setMessage(overview.tailInspectionRequired ? "返工人员与尾查全部完成报数后进入最终数量确认。" : "返工人员全部完成报数后进入最终数量确认。");
      else setMessage("");
    } finally {
      requestInFlight.current = false;
    }
  };

  useEffect(() => { void load().catch((cause) => setMessage(cause instanceof Error ? cause.message : "读取失败")); }, [reworkOrderId]);

  const call = async <T,>(path: string, parse: (value: unknown) => T, body: unknown) => {
    const signature = path + JSON.stringify(body);
    const idempotencyKey = attempts.current[signature] ?? crypto.randomUUID();
    attempts.current[signature] = idempotencyKey;
    setBusy(true);
    try {
      const result = await request(path, parse, { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(body) });
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
      await call("work-reports/" + reportId + "/reject", WholeOrderReviewResponseSchema.parse, { expectedOrderVersion: data.orderVersion, rejectedPersonId: personId, reason: reason.trim() });
      setMessage("已驳回该执行报数；原记录保留，执行人可在 N04 重新报数。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "完成记录驳回失败"); }
  };

  const rejectTailInspection = async (assignmentId: string, inspectorName: string) => {
    if (!data || data.reworkStatus !== "pending_order_review") return;
    const reason = await promptInApp(`请填写驳回 ${inspectorName} 尾查报数的原因`);
    if (!reason?.trim()) return;
    try {
      await call("tail-inspection-assignments/" + assignmentId + "/reject", TailInspectionResponseSchema.parse, { expectedOrderVersion: data.orderVersion, reason: reason.trim() });
      setMessage(`已驳回 ${inspectorName} 的尾查报数；原记录保留，尾查可重新报数。`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "尾查报数驳回失败"); }
  };

  const confirmFinalQuantities = async () => {
    if (!data) return;
    const quantities = data.processes.map((process) => ({
      process,
      text: finalQuantities[process.configurationItemId]?.trim() ?? "",
    }));
    if (quantities.some(({ process, text }) => !/^\d+$/.test(text) || Number(text) <= 0 || Number(text) > (data.tailInspectionRequired ? process.tailCheckedQuantity : process.completedQuantity))) {
      setMessage(data.tailInspectionRequired ? "最终确认数量必须是正整数，且不能超过对应尾查数量；无有效完成量时请驳回上数。" : "最终确认数量必须是正整数，且不能超过工人有效上数；无有效完成量时请驳回上数。");
      return;
    }
    const coefficients = data.temporaryWorkers.map((worker) => {
      const id = `${worker.configurationItemId}:${worker.personId}`;
      return { worker, text: multipliers[id]?.trim() ?? "", reason: multiplierReasons[id]?.trim() ?? "" };
    });
    if (coefficients.some((row) => !/^\d+(?:\.\d{1,3})?$/.test(row.text) || Number(row.text) <= 0 || Number(row.text) > 10)) {
      setMessage("临时工实发系数必须大于 0 且不超过 10，最多三位小数。");
      return;
    }
    if (coefficients.some((row) => Number(row.text) !== 1 && !row.reason)) {
      setMessage("临时工实发系数不是 1.0 时，必须填写调整原因。");
      return;
    }
    if (!(await confirmInApp("确认提交本版最终数量给 IE 复核？提交后工资仍不会正式生成。"))) return;
    try {
      await call("rework-orders/" + reworkOrderId + "/whole-order-review/approve", WholeOrderReviewResponseSchema.parse, {
        expectedOrderVersion: data.orderVersion,
        finalQuantities: quantities.map(({ process, text }) => ({ configurationItemId: process.configurationItemId, finalConfirmedQuantity: Number(text) })),
        temporaryCoefficients: coefficients.map(({ worker, text, reason }) => ({
          configurationItemId: worker.configurationItemId, personId: worker.personId, multiplier: Number(text), ...(reason ? { reason } : {}),
        })),
      });
      setMessage("最终数量已提交，等待 IE 复核。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "最终数量提交失败"); }
  };

  const reviewFinalQuantities = async (decision: "approved" | "rejected") => {
    if (!data) return;
    const reason = decision === "rejected" ? await promptInApp("请填写退回尾部主管的原因") : undefined;
    if (decision === "rejected" && !reason?.trim()) return;
    if (decision === "approved" && !(await confirmInApp("确认数量与质量事实无误？通过后正式生成工资并进入责任判定。"))) return;
    try {
      await call("rework-orders/" + reworkOrderId + "/whole-order-review/ie-review", WholeOrderReviewResponseSchema.parse, {
        expectedOrderVersion: data.orderVersion, decision, ...(reason?.trim() ? { reason: reason.trim() } : {}),
      });
      setMessage(decision === "approved" ? "IE 复核已通过，工资数量已锁定并进入责任判定。" : "已退回尾部最终数量确认。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "IE 复核失败"); }
  };

  if (!data || ["draft", "pending_process_configuration", "pending_ie_review", "pending_task_assignment"].includes(data.reworkStatus)) return null;
  const tailStage = data.reworkStatus === "pending_order_review";
  const ieStage = data.reworkStatus === "pending_final_quantity_ie_review";
  const allComplete = data.processes.length > 0 && data.processes.every((process) => process.complete);
  const submittedTailAssignments = tailData?.assignments.filter((assignment) => assignment.submittedAt !== null) ?? [];
  const quantityIssue = data.processes.some((process) => {
    const value = finalQuantities[process.configurationItemId]?.trim() ?? "";
    return !/^\d+$/.test(value) || Number(value) <= 0 || Number(value) > (data.tailInspectionRequired ? process.tailCheckedQuantity : process.completedQuantity);
  });
  const coefficientIssue = data.temporaryWorkers.some((worker) => {
    const id = `${worker.configurationItemId}:${worker.personId}`;
    const value = multipliers[id]?.trim() ?? "";
    const reason = multiplierReasons[id]?.trim() ?? "";
    return !/^\d+(?:\.\d{1,3})?$/.test(value) || Number(value) <= 0 || Number(value) > 10 || (Number(value) !== 1 && !reason);
  });
  const ready = allComplete && !quantityIssue && !coefficientIssue;

  return <div className="whole-order-review-flow">
    <Surface>
      <div className="section-title">
        <div>
          <h2>{tailStage ? "N05 · 尾部最终数量确认" : ieStage ? "N06 · IE 最终数量复核" : "返工完成进度"}</h2>
          {message && <p role="status">{message}</p>}
        </div>
        <StatusBadge tone={tailStage || ieStage ? "warning" : allComplete ? "success" : "info"}>{reworkStatusLabel(data.reworkStatus)}</StatusBadge>
      </div>
    </Surface>

    <Surface>
      <h2>{data.tailInspectionRequired ? "工人上数、尾查数与最终确认数" : "工人上数与最终确认数"}</h2>
      <p>{tailStage ? (data.tailInspectionRequired ? "最终确认数可修正工人原报数，但不得超过尾查数；系统完整保留每一版前后值和操作者。" : "本单无需整查；最终确认数不得超过工人有效上数，系统完整保留每一版前后值和操作者。") : "IE 复核只确认数量和质量事实，不在本节点改价。"}</p>
      {data.processes.map((process) => {
        const confirmed = data.finalConfirmation?.quantities.find((quantity) => quantity.configurationItemId === process.configurationItemId);
        return <div className="section-title whole-order-row" key={process.configurationItemId}>
          <div className="whole-order-process-main">
            <b className="whole-order-process-name">{process.processName}</b>
            <div className="whole-order-metrics">
              <span className="whole-order-metric"><span className="whole-order-metric-label">工人原报</span><strong className="whole-order-metric-value">{process.completedQuantity} 件</strong></span>
              {data.tailInspectionRequired ? <span className="whole-order-metric"><span className="whole-order-metric-label">尾查报数</span><strong className="whole-order-metric-value">{process.tailCheckedQuantity} 件</strong></span> : null}
              {tailStage
                ? <InsetField label="最终确认数量" type="number" min="1" step="1" inputMode="numeric" value={finalQuantities[process.configurationItemId] ?? ""} disabled={busy} onChange={(event) => setFinalQuantities((current) => ({ ...current, [process.configurationItemId]: event.target.value }))} />
                : <span className="whole-order-metric"><span className="whole-order-metric-label">最终确认</span><strong className="whole-order-metric-value">{confirmed?.finalConfirmedQuantity ?? "—"} 件</strong></span>}
            </div>
          </div>
          <StatusBadge tone={confirmed?.changed ? "warning" : process.complete ? "success" : "danger"}>{confirmed?.changed ? "已调整" : process.complete ? "数量可确认" : "需驳回调整"}</StatusBadge>
        </div>;
      })}
    </Surface>

    {tailStage && (data.canReview || data.reports.length > 0) && <Surface>
      <h2>执行报数原始记录</h2>
      <p>原始上数不修改；有误时驳回并由执行人重新报数。</p>
      {data.reports.map((report) => <div className="section-title whole-order-row" key={report.workReportId}>
        <div className="whole-order-report-main">
          <b className="whole-order-person-name">{report.executionKind === "tail_inspection" ? "尾查 · " : ""}{report.members.map((member) => member.displayName).join("、")}</b>
          <div className="whole-order-report-meta"><span className="whole-order-report-label">原报数</span><strong className="whole-order-report-value">{report.actualQuantity} 件</strong><span className={`whole-order-report-state${report.rejected ? " is-danger" : ""}`}>{report.rejected ? "已驳回：" + report.rejectionReason : "当前有效"}</span></div>
        </div>
        {data.canReview && !report.rejected && <div className="mobile-actions whole-order-actions">
          {report.assignmentMode === "collective"
            ? <Button onClick={() => void reject(report.workReportId, null, report.executionKind)} disabled={busy}>驳回整条记录</Button>
            : report.members.map((member) => <Button key={member.personId} onClick={() => void reject(report.workReportId, member.personId, report.executionKind)} disabled={busy}>驳回 {member.displayName}</Button>)}
        </div>}
      </div>)}
    </Surface>}

    {data.tailInspectionRequired && !data.unifiedExecutionRequired && tailStage && submittedTailAssignments.length > 0 && <Surface>
      <h2>历史尾查报数记录</h2>
      {submittedTailAssignments.map((assignment) => <div className="section-title whole-order-row" key={assignment.assignmentId}>
        <div><b>{assignment.tailInspectorName}</b><p>返件总数 {assignment.returnedQuantity ?? 0} 件</p></div>
        {data.canReview && <Button disabled={busy} onClick={() => void rejectTailInspection(assignment.assignmentId, assignment.tailInspectorName)}>驳回尾查</Button>}
      </div>)}
    </Surface>}

    {tailStage && data.canReview && data.temporaryWorkers.length > 0 && <Surface>
      <h2>临时工实发系数</h2>
      <p>默认 1.0；非 1.0 必须填写调整原因，并随本版最终数量一并送 IE 复核。</p>
      {data.temporaryWorkers.map((worker) => {
        const id = `${worker.configurationItemId}:${worker.personId}`;
        return <div className="section-title whole-order-row" key={id}>
          <b>{worker.displayName} · {worker.processName}</b>
          <div className="mobile-actions whole-order-actions">
            <InsetField label="实发系数" type="number" min="0.001" max="10" step="0.001" inputMode="decimal" value={multipliers[id] ?? "1"} disabled={busy} onChange={(event) => setMultipliers((current) => ({ ...current, [id]: event.target.value }))} />
            <InsetField label="调整原因（非 1.0 必填）" value={multiplierReasons[id] ?? ""} disabled={busy} onChange={(event) => setMultiplierReasons((current) => ({ ...current, [id]: event.target.value }))} />
          </div>
        </div>;
      })}
    </Surface>}

    {tailStage && data.canReview && <Surface>
      <h2>提交 IE 复核</h2>
      <p>提交后不会提前生成正式工资；IE 通过才锁定最终数量工资口径。</p>
      <Button variant="primary" onClick={() => void confirmFinalQuantities()} disabled={busy || !ready}>{busy ? "提交中…" : "确认最终数量并提交 IE"}</Button>
      {!ready && <p role="status">还需完成：每道工序填写有效最终数量，并检查临时工系数。</p>}
    </Surface>}

    {ieStage && data.canIeReview && <Surface>
      <h2>IE 复核决定</h2>
      <p>通过后按最终确认数量生成正式工资事实并进入责任判定；退回后保留本版记录并回到 N05。</p>
      <div className="mobile-actions">
        <Button onClick={() => void reviewFinalQuantities("rejected")} disabled={busy}>退回尾部确认</Button>
        <Button variant="primary" onClick={() => void reviewFinalQuantities("approved")} disabled={busy}>通过并进入责任判定</Button>
      </div>
    </Surface>}
  </div>;
}
