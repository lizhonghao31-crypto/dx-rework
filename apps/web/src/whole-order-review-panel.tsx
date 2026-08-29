import {
  TailInspectionResponseSchema,
  WholeOrderReviewResponseSchema,
  type TailInspectionResponse,
  type WholeOrderReviewResponse,
} from "@dx-rework/contracts";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { createClientRequestId } from "./client-request-id.js";
import { confirmInApp, promptInApp } from "./system-dialog.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const request = async <T,>(path: string, parse: (value: unknown) => T, init?: RequestInit): Promise<T> => {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? "请求未完成，请稍后重试");
  }
  return parse(await response.json());
};

const reworkStatusLabel = (status: WholeOrderReviewResponse["reworkStatus"]): string => ({
  draft: "草稿",
  pending_process_configuration: "待配置工序",
  pending_ie_review: "待 IE 核价",
  pending_task_assignment: "待启动任务",
  in_progress: "返工执行中",
  pending_order_review: "待尾部确认",
  pending_final_quantity_ie_review: "待 IE 复核",
  pending_quantity_adjustment_ie_review: "历史数量调整待 IE",
  pending_responsibility_determination: "待责任判定",
  pending_owner_signature: "待老板确认签字",
  pending_responsibility_action: "责任处理中",
  completed: "已完成",
  cancelled: "已取消",
  deleted: "已删除",
})[status] ?? status;

type ReviewReport = WholeOrderReviewResponse["reports"][number];
type IePrecountEntry = Readonly<{
  configurationItemId: string;
  quantity: number;
  note: string | null;
  recordedBy: string;
  recordedAt: string;
}>;
type IePrecountOverview = Readonly<{ entries: readonly IePrecountEntry[] }>;

const formatIePrecountTime = (value: string): string =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));

export function WholeOrderReviewPanel({
  reworkOrderId,
  onChanged,
  embedded = false,
  iePrecounts,
}: {
  reworkOrderId: string;
  onChanged: () => Promise<void>;
  embedded?: boolean;
  iePrecounts?: IePrecountOverview;
}) {
  const [data, setData] = useState<WholeOrderReviewResponse | null>(null);
  const [tailData, setTailData] = useState<TailInspectionResponse | null>(null);
  const [message, setMessage] = useState("正在加载数量确认状态…");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [tailExpanded, setTailExpanded] = useState(false);
  const [coefficientSectionExpanded, setCoefficientSectionExpanded] = useState(false);
  const [coefficientExpanded, setCoefficientExpanded] = useState<Record<string, boolean>>({});
  const [correctionInputs, setCorrectionInputs] = useState<Record<string, string>>({});
  const [multipliers, setMultipliers] = useState<Record<string, string>>({});
  const [multiplierReasons, setMultiplierReasons] = useState<Record<string, string>>({});
  const attempts = useRef<Record<string, string>>({});
  const requestInFlight = useRef(false);

  const applyOverview = (overview: WholeOrderReviewResponse) => {
    setData(overview);
    setCorrectionInputs((current) => Object.fromEntries(overview.reports.map((report) => [
      report.workReportId,
      current[report.workReportId] ?? String(report.effectiveQuantity),
    ])));
    setMultipliers((current) => Object.fromEntries(overview.temporaryWorkers.map((worker) => {
      const id = `${worker.configurationItemId}:${worker.personId}`;
      return [id, current[id] ?? String(worker.multiplier)];
    })));
    setMultiplierReasons((current) => Object.fromEntries(overview.temporaryWorkers.map((worker) => {
      const id = `${worker.configurationItemId}:${worker.personId}`;
      return [id, current[id] ?? worker.reason ?? ""];
    })));
  };

  const load = async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    try {
      const overview = await request(
        "rework-orders/" + reworkOrderId + "/whole-order-review",
        WholeOrderReviewResponseSchema.parse,
      );
      const tail = overview.unifiedExecutionRequired || !overview.tailInspectionRequired
        ? null
        : await request(
          "rework-orders/" + reworkOrderId + "/tail-inspection",
          TailInspectionResponseSchema.parse,
        );
      applyOverview(overview);
      setTailData(tail);
      if (overview.reviewId) setMessage("IE 已复核通过，工资已按有效数量锁定并进入责任判定。");
      else if (overview.reworkStatus === "pending_final_quantity_ie_review") setMessage("请 IE 只读核对各工序数量；通过或退回，不在本节点修改。");
      else if (overview.reworkStatus === "pending_order_review") {
        const rejected = overview.finalConfirmation?.status === "rejected"
          ? overview.finalConfirmation.reviewReason
          : null;
        setMessage(rejected
          ? `IE 已退回上一版：${rejected}。请修正报数并重新提交。`
          : overview.tailInspectionRequired ? "逐工序核对工序与整查有效数量；工序数量不超过整查即可提交。" : "本单无需整查；逐工序核对工人有效数量后提交。");
      } else if (overview.reworkStatus === "in_progress") {
        setMessage(overview.tailInspectionRequired ? "返工人员与整查全部完成报数后进入尾部确认。" : "返工人员全部完成报数后进入尾部确认。");
      } else setMessage("");
    } finally {
      requestInFlight.current = false;
    }
  };

  useEffect(() => {
    void load().catch((cause) => setMessage(cause instanceof Error ? cause.message : "读取失败"));
  }, [reworkOrderId]);

  const call = async <T,>(
    path: string,
    parse: (value: unknown) => T,
    body: unknown,
    applyResult?: (result: T) => void,
  ) => {
    const signature = path + JSON.stringify(body);
    const idempotencyKey = attempts.current[signature] ?? createClientRequestId();
    attempts.current[signature] = idempotencyKey;
    setBusy(true);
    try {
      const result = await request(path, parse, {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: JSON.stringify(body),
      });
      delete attempts.current[signature];
      if (applyResult) applyResult(result);
      else await load();
      await onChanged();
      return result;
    } finally {
      setBusy(false);
    }
  };

  const reject = async (
    reportId: string,
    personId: string | null,
    executionKind: "worker" | "tail_inspection" = "worker",
  ) => {
    if (!data || data.reworkStatus !== "pending_order_review") return;
    const reason = await promptInApp(
      executionKind === "tail_inspection" ? "请填写驳回这条整查报数的原因" : "请填写驳回这条上数的原因",
    );
    if (!reason?.trim()) return;
    try {
      await call("work-reports/" + reportId + "/reject", WholeOrderReviewResponseSchema.parse, {
        expectedOrderVersion: data.orderVersion,
        rejectedPersonId: personId,
        reason: reason.trim(),
      }, applyOverview);
      setMessage("已驳回该报数；原记录保留，执行人可在 N04 重新报数。");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "报数驳回失败");
    }
  };

  const canCorrectReport = (report: ReviewReport): boolean =>
    data?.reworkStatus === "pending_order_review"
    && data.canReview
    && !report.rejected
    && report.assignmentMode === "individual"
    && report.members.length === 1;

  const hasChangedCorrection = (report: ReviewReport): boolean =>
    canCorrectReport(report)
    && (correctionInputs[report.workReportId]?.trim() ?? "") !== String(report.effectiveQuantity);

  const correctProcess = async (
    configurationItemId: string,
    reports: ReviewReport[],
    processName: string,
  ) => {
    if (!data || data.reworkStatus !== "pending_order_review") return;
    const editableReports = reports.filter(canCorrectReport);
    const invalid = editableReports.find((report) => {
      const value = correctionInputs[report.workReportId]?.trim() ?? "";
      return !/^\d+$/.test(value) || Number(value) <= 0;
    });
    if (invalid) {
      setMessage(`${invalid.members[0]?.displayName ?? "执行人"}的有效数量必须是正整数。`);
      return;
    }
    const corrections = editableReports
      .filter(hasChangedCorrection)
      .map((report) => ({
        workReportId: report.workReportId,
        effectiveQuantity: Number(correctionInputs[report.workReportId]!.trim()),
      }));
    if (corrections.length === 0) {
      setMessage("本工序的有效数量没有变化，无需保存。");
      return;
    }
    try {
      await call(
        "rework-orders/" + reworkOrderId + "/work-report-quantity-corrections",
        WholeOrderReviewResponseSchema.parse,
        { expectedOrderVersion: data.orderVersion, configurationItemId, corrections },
        (overview) => {
          applyOverview(overview);
          const savedIds = new Set(corrections.map((correction) => correction.workReportId));
          setCorrectionInputs((current) => ({
            ...current,
            ...Object.fromEntries(overview.reports
              .filter((report) => savedIds.has(report.workReportId))
              .map((report) => [report.workReportId, String(report.effectiveQuantity)])),
          }));
        },
      );
      setMessage(`已一次保存${processName}的 ${corrections.length} 条数量修正；原值永久保留。`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "整组有效数量修正失败");
    }
  };

  const rejectTailInspection = async (assignmentId: string, inspectorName: string) => {
    if (!data || data.reworkStatus !== "pending_order_review") return;
    const reason = await promptInApp(`请填写驳回 ${inspectorName} 整查报数的原因`);
    if (!reason?.trim()) return;
    try {
      await call(
        "tail-inspection-assignments/" + assignmentId + "/reject",
        TailInspectionResponseSchema.parse,
        { expectedOrderVersion: data.orderVersion, reason: reason.trim() },
      );
      setMessage(`已驳回 ${inspectorName} 的整查报数；原记录保留，整查可重新报数。`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "整查报数驳回失败");
    }
  };

  const confirmQuantities = async () => {
    if (!data) return;
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
    if (!(await confirmInApp(data.tailInspectionRequired ? "确认各工序有效数量均未超过整查，并提交 IE 复核？" : "确认各工序工人有效数量无误，并提交 IE 复核？"))) return;
    try {
      await call(
        "rework-orders/" + reworkOrderId + "/whole-order-review/approve",
        WholeOrderReviewResponseSchema.parse,
        {
          expectedOrderVersion: data.orderVersion,
          temporaryCoefficients: coefficients.map(({ worker, text, reason }) => ({
            configurationItemId: worker.configurationItemId,
            personId: worker.personId,
            multiplier: Number(text),
            ...(reason ? { reason } : {}),
          })),
        },
        applyOverview,
      );
      setMessage("系统已生成最终数量，等待 IE 复核。");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "数量提交失败");
    }
  };

  const reviewQuantities = async (decision: "approved" | "rejected") => {
    if (!data) return;
    const reason = decision === "rejected" ? await promptInApp("请填写退回尾部主管的原因") : undefined;
    if (decision === "rejected" && !reason?.trim()) return;
    if (decision === "approved" && !(await confirmInApp("确认数量事实无误？通过后按每个人的有效数量生成工资。"))) return;
    try {
      await call(
        "rework-orders/" + reworkOrderId + "/whole-order-review/ie-review",
        WholeOrderReviewResponseSchema.parse,
        { expectedOrderVersion: data.orderVersion, decision, ...(reason?.trim() ? { reason: reason.trim() } : {}) },
        applyOverview,
      );
      setMessage(decision === "approved"
        ? "IE 复核已通过，工资已按有效数量锁定并进入责任判定。"
        : "已退回尾部最终数量确认。");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "IE 复核失败");
    }
  };

  if (!data || ["draft", "pending_process_configuration", "pending_ie_review", "pending_task_assignment"].includes(data.reworkStatus)) return null;
  const tailStage = data.reworkStatus === "pending_order_review";
  const ieStage = data.reworkStatus === "pending_final_quantity_ie_review";
  const allComplete = data.processes.length > 0 && data.processes.every((process) => process.complete);
  const submittedTailAssignments = tailData?.assignments.filter((assignment) => assignment.submittedAt !== null) ?? [];
  const coefficientIssue = data.temporaryWorkers.some((worker) => {
    const id = `${worker.configurationItemId}:${worker.personId}`;
    const value = multipliers[id]?.trim() ?? "";
    const reason = multiplierReasons[id]?.trim() ?? "";
    return !/^\d+(?:\.\d{1,3})?$/.test(value)
      || Number(value) <= 0
      || Number(value) > 10
      || (Number(value) !== 1 && !reason);
  });
  const ready = allComplete && !coefficientIssue;
  const tailReports = data.reports.filter((report) => report.executionKind === "tail_inspection");
  const temporaryWorkerGroups = data.temporaryWorkers.reduce<Array<{
    configurationItemId: string;
    processName: string;
    workers: Array<(typeof data.temporaryWorkers)[number]>;
  }>>((groups, worker) => {
    const group = groups.find((candidate) => candidate.configurationItemId === worker.configurationItemId);
    if (group) group.workers.push(worker);
    else groups.push({ configurationItemId: worker.configurationItemId, processName: worker.processName, workers: [worker] });
    return groups;
  }, []);

  const reportRow = (report: ReviewReport) => {
    const canCorrect = canCorrectReport(report);
    return <div className="quantity-report-row" key={report.workReportId}>
      <div className="quantity-report-person">
        <b>{report.members.map((member) => member.displayName).join("、") || "执行人员"}</b>
        <span className={report.rejected ? "is-danger" : ""}>
          {report.rejected ? "已驳回：" + report.rejectionReason : "当前有效"}
        </span>
      </div>
      <div className="quantity-report-value">
        <strong>{report.effectiveQuantity} 件</strong>
        {report.corrected && <small>主管修改，原值 {report.actualQuantity}</small>}
      </div>
      {canCorrect && <div className="quantity-report-actions">
        <InsetField
          label="有效数量"
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          value={correctionInputs[report.workReportId] ?? String(report.effectiveQuantity)}
          disabled={busy}
          onChange={(event) => setCorrectionInputs((current) => ({
            ...current,
            [report.workReportId]: event.target.value,
          }))}
        />
        <Button
          disabled={busy}
          onClick={() => void reject(report.workReportId, report.members[0]?.personId ?? null, report.executionKind)}
        >驳回</Button>
      </div>}
      {tailStage && data.canReview && !report.rejected && !canCorrect && <Button
        disabled={busy}
        onClick={() => void reject(report.workReportId, null, report.executionKind)}
      >驳回整条记录</Button>}
    </div>;
  };

  return <div className="whole-order-review-flow">
    {embedded && message && <p role="status">{message}</p>}
    {!embedded && <Surface>
      <div className="section-title">
        <div>
          <h2>{tailStage ? "N05 · 尾部最终数量确认" : ieStage ? "N06 · IE复核" : "返工完成进度"}</h2>
          {message && <p role="status">{message}</p>}
        </div>
        <StatusBadge tone={tailStage || ieStage ? "warning" : allComplete ? "success" : "info"}>
          {reworkStatusLabel(data.reworkStatus)}
        </StatusBadge>
      </div>
    </Surface>}

    <Surface>
      <div className="quantity-review-heading">
        <div>
          <h2>按工序核对</h2>
          <p>{tailStage ? "主管可修正个人有效数量；原始上数始终保留。" : "IE 只读核对系统锁定的数量事实。"}</p>
        </div>
        <StatusBadge tone={allComplete ? "success" : "warning"}>
          {allComplete ? "全部可确认" : "存在异常"}
        </StatusBadge>
      </div>
      <div className="quantity-process-list">
        {data.processes.map((process) => {
          const open = expanded[process.configurationItemId] === true;
          const reports = data.reports.filter((report) =>
            report.executionKind === "worker"
            && report.configurationItemId === process.configurationItemId);
          const iePrecount = iePrecounts?.entries.reduce<IePrecountEntry | undefined>((latest, entry) => {
            if (entry.configurationItemId !== process.configurationItemId) return latest;
            if (!latest || Date.parse(entry.recordedAt) > Date.parse(latest.recordedAt)) return entry;
            return latest;
          }, undefined);
          return <section className={`quantity-process-card${process.complete ? " is-complete" : " is-mismatch"}`} key={process.configurationItemId}>
            <button
              className="quantity-process-toggle"
              type="button"
              aria-expanded={open}
              onClick={() => setExpanded((current) => ({
                ...current,
                [process.configurationItemId]: !open,
              }))}
            >
              <span className="quantity-process-name">{process.processName}</span>
              <span><small>工人合计</small><strong>{process.completedQuantity}</strong></span>
              {iePrecounts ? <span><small>IE预核</small><strong>{iePrecount?.quantity ?? "—"}</strong></span> : null}
              {data.tailInspectionRequired ? <>
                <span><small>整查</small><strong>{process.tailCheckedQuantity}</strong></span>
                <span><small>整查余量</small><strong>{process.tailCheckedQuantity - process.completedQuantity}</strong></span>
              </> : null}
              <StatusBadge tone={process.complete ? "success" : "danger"}>
                {data.tailInspectionRequired
                  ? process.complete ? "✓ 可确认" : process.completedQuantity <= 0 || process.tailCheckedQuantity <= 0 ? "⚠ 待报数" : "⚠ 工序超数"
                  : process.complete ? "✓ 已上报" : "⚠ 待完成"}
              </StatusBadge>
              <b className="quantity-process-expander">{open ? "−" : "+"}</b>
            </button>
            {open && <div className="quantity-process-detail">
              {tailStage && data.canReview && reports.some(canCorrectReport) && <div className="quantity-report-actions quantity-process-save">
                <strong>{process.completedQuantity} 件</strong>
                <Button
                  disabled={busy || !reports.some(hasChangedCorrection)}
                  onClick={() => void correctProcess(process.configurationItemId, reports, process.processName)}
                >保存修正</Button>
              </div>}
              {reports.length ? reports.map(reportRow) : <p>暂无有效工人报数。</p>}
              {iePrecount ? <div className="quantity-report-row">
                <div className="quantity-report-person">
                  <b>IE预核</b>
                  <span>{iePrecount.recordedBy} · {formatIePrecountTime(iePrecount.recordedAt)}</span>
                </div>
                <div className="quantity-report-value">
                  <strong>{iePrecount.quantity} 件</strong>
                  {iePrecount.note ? <small>{iePrecount.note}</small> : null}
                </div>
              </div> : null}
              {data.tailInspectionRequired ? <div className="quantity-report-row quantity-tail-summary">
                <div className="quantity-report-person"><b>整查</b><span>有效合计</span></div>
                <div className="quantity-report-value"><strong>{process.tailCheckedQuantity} 件</strong></div>
              </div> : null}
            </div>}
          </section>;
        })}
      </div>
    </Surface>

    {data.tailInspectionRequired && data.unifiedExecutionRequired && tailReports.length > 0 && <Surface>
      <button
        className="quantity-tail-toggle"
        type="button"
        aria-expanded={tailExpanded}
        onClick={() => setTailExpanded((value) => !value)}
      >
        <span><b>整查报数</b><small>{tailReports.length} 人/条记录</small></span>
        <strong>{data.processes[0]?.tailCheckedQuantity ?? 0} 件</strong>
        <b>{tailExpanded ? "−" : "+"}</b>
      </button>
      {tailExpanded && <div className="quantity-process-detail">
        {tailStage && data.canReview && tailReports.some(canCorrectReport) && <div className="quantity-report-actions quantity-process-save">
          <strong>{data.processes[0]?.tailCheckedQuantity ?? 0} 件</strong>
          <Button
            disabled={busy || !tailReports.some(hasChangedCorrection)}
            onClick={() => void correctProcess(tailReports[0]!.configurationItemId, tailReports, "整查报数")}
          >保存修正</Button>
        </div>}
        {tailReports.map(reportRow)}
      </div>}
    </Surface>}

    {data.tailInspectionRequired && !data.unifiedExecutionRequired && tailStage && submittedTailAssignments.length > 0 && <Surface>
      <h2>历史整查报数记录</h2>
      {submittedTailAssignments.map((assignment) => <div className="section-title whole-order-row" key={assignment.assignmentId}>
        <div><b>{assignment.tailInspectorName}</b><p>返件总数 {assignment.returnedQuantity ?? 0} 件</p></div>
        {data.canReview && <Button disabled={busy} onClick={() => void rejectTailInspection(assignment.assignmentId, assignment.tailInspectorName)}>驳回整查</Button>}
      </div>)}
    </Surface>}

    {tailStage && data.canReview && temporaryWorkerGroups.length > 0 && <Surface>
      <button
        className="quantity-coefficient-section-toggle"
        type="button"
        aria-controls="temporary-wage-adjustment-content"
        aria-expanded={coefficientSectionExpanded}
        onClick={() => setCoefficientSectionExpanded((value) => !value)}
      >
        <strong>临时工工资调整</strong>
        <StatusBadge tone={coefficientIssue ? "danger" : "success"}>{coefficientIssue ? "待完善" : `${data.temporaryWorkers.length} 人`}</StatusBadge>
        <b className="quantity-process-expander" aria-hidden="true">{coefficientSectionExpanded ? "−" : "+"}</b>
      </button>
      {coefficientSectionExpanded && <div className="quantity-process-list" id="temporary-wage-adjustment-content">
        {temporaryWorkerGroups.map((group) => {
          const open = coefficientExpanded[group.configurationItemId] === true;
          const groupIssue = group.workers.some((worker) => {
            const id = `${worker.configurationItemId}:${worker.personId}`;
            const value = multipliers[id]?.trim() ?? "";
            const reason = multiplierReasons[id]?.trim() ?? "";
            return !/^\d+(?:\.\d{1,3})?$/.test(value)
              || Number(value) <= 0
              || Number(value) > 10
              || (Number(value) !== 1 && !reason);
          });
          return <section className={`quantity-process-card quantity-coefficient-card${groupIssue ? " is-mismatch" : " is-complete"}`} key={group.configurationItemId}>
            <button
              className="quantity-process-toggle quantity-coefficient-toggle"
              type="button"
              aria-expanded={open}
              onClick={() => setCoefficientExpanded((current) => ({
                ...current,
                [group.configurationItemId]: !open,
              }))}
            >
              <span className="quantity-process-name">{group.processName}</span>
              <span><small>临时工</small><strong>{group.workers.length} 人</strong></span>
              <StatusBadge tone={groupIssue ? "danger" : "success"}>{groupIssue ? "待完善" : "已完整"}</StatusBadge>
              <b className="quantity-process-expander">{open ? "−" : "+"}</b>
            </button>
            {open && <div className="quantity-process-detail">
              {group.workers.map((worker) => {
                const id = `${worker.configurationItemId}:${worker.personId}`;
                return <div className="quantity-report-row quantity-coefficient-row" key={id}>
                  <div className="quantity-report-person"><b>{worker.displayName}</b><span>临时工</span></div>
                  <div className="mobile-actions whole-order-actions">
                    <InsetField
                      label="实发系数"
                      type="number"
                      min="0.001"
                      max="10"
                      step="0.001"
                      inputMode="decimal"
                      value={multipliers[id] ?? "1"}
                      disabled={busy}
                      onChange={(event) => setMultipliers((current) => ({ ...current, [id]: event.target.value }))}
                    />
                    <InsetField
                      label="调整原因（非 1.0 必填）"
                      value={multiplierReasons[id] ?? ""}
                      disabled={busy}
                      onChange={(event) => setMultiplierReasons((current) => ({ ...current, [id]: event.target.value }))}
                    />
                  </div>
                </div>;
              })}
            </div>}
          </section>;
        })}
      </div>}
    </Surface>}

    {tailStage && data.canReview && <Surface>
      <div className="quantity-submit-row">
        <div>
          <h2>提交 IE 复核</h2>
          <p>{data.tailInspectionRequired ? "系统按各工序有效数量生成最终数量；工序数量不得超过整查数量。" : "本单无需整查；系统按工人有效数量生成最终数量。"}</p>
        </div>
        <Button variant="primary" onClick={() => void confirmQuantities()} disabled={busy || !ready}>
          {busy ? "提交中…" : data.tailInspectionRequired ? "确认数量并提交 IE" : "确认数量并提交 IE"}
        </Button>
      </div>
      {!ready && <p role="status">{data.tailInspectionRequired ? "还需完成：补齐有效报数、处理工序超数，并检查临时工工资调整。" : "还需完成：等待全部返工报数，并检查临时工工资调整。"}</p>}
    </Surface>}

    {ieStage && data.canIeReview && <Surface>
      <div className="quantity-submit-row">
        <div>
          <h2>IE 复核决定</h2>
          <p>通过后按每个人的有效数量生成工资；退回后保留本版审计记录。</p>
        </div>
        <div className="quantity-review-actions">
          <Button onClick={() => void reviewQuantities("rejected")} disabled={busy}>退回</Button>
          <Button variant="primary" onClick={() => void reviewQuantities("approved")} disabled={busy}>通过</Button>
        </div>
      </div>
    </Surface>}
  </div>;
}
