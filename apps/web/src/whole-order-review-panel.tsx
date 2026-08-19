import { WholeOrderReviewResponseSchema, type WholeOrderReviewResponse } from "@dx-rework/contracts";
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
  pending_ie_review: "待 IE 审核",
  pending_task_assignment: "待分工",
  in_progress: "返工执行中",
  pending_order_review: "待尾部核量",
  pending_quantity_adjustment_ie_review: "历史订单数量调整待 IE",
  pending_responsibility_determination: "待责任判定",
  pending_owner_signature: "待老板确认签字",
  pending_responsibility_action: "责任处理中",
  completed: "已完成",
  cancelled: "已取消",
  deleted: "已删除",
})[status] ?? status;

export function WholeOrderReviewPanel({ reworkOrderId, onChanged }: { reworkOrderId: string; onChanged: () => Promise<void> }) {
  const [data, setData] = useState<WholeOrderReviewResponse | null>(null);
  const [message, setMessage] = useState("正在加载整单完成状态…");
  const [busy, setBusy] = useState(false);
  const [multipliers, setMultipliers] = useState<Record<string, string>>({});
  const [multiplierReasons, setMultiplierReasons] = useState<Record<string, string>>({});
  const attempts = useRef<Record<string, string>>({});
  const load = async () => {
    const overview = await request("rework-orders/" + reworkOrderId + "/whole-order-review", WholeOrderReviewResponseSchema.parse);
    setData(overview);
    setMultipliers((current) => Object.fromEntries(overview.temporaryWorkers.map((worker) => {
      const id = `${worker.configurationItemId}:${worker.personId}`;
      return [id, current[id] ?? String(worker.multiplier)];
    })));
    setMultiplierReasons((current) => Object.fromEntries(overview.temporaryWorkers.map((worker) => {
      const id = `${worker.configurationItemId}:${worker.personId}`;
      return [id, current[id] ?? worker.reason ?? ""];
    })));
    if (overview.reviewId) {
      setMessage("本单已完成整单确认并进入责任判定。完成记录继续保留供追溯。");
    } else if (overview.reworkStatus === "pending_order_review") {
      setMessage("N07：请逐工序核对工人上数不得超过尾查汇总；临时工可调整实发系数，确认后进入责任判定。");
    } else if (overview.reworkStatus === "in_progress") {
      setMessage("当前仍在 N05 / N06 并行报数中。工人上数和尾查报数都完成后，自动进入 N07 尾部主管整单确认。");
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

  const reject = async (reportId: string, personId: string | null) => {
    if (!data) return;
    const reason = await promptInApp("请填写驳回这条完成记录的原因");
    if (!reason?.trim()) return;
    try {
      await call("work-reports/" + reportId + "/reject", WholeOrderReviewResponseSchema.parse, { expectedOrderVersion: data.orderVersion, rejectedPersonId: personId, reason });
      setMessage(personId ? "已驳回该人员的完成记录；订单将按有效完成数量重新判断是否补齐。" : "已驳回整条集体完成记录；订单将按有效完成数量重新判断是否补齐。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "完成记录驳回失败"); }
  };

  const approve = async () => {
    if (!data) return;
    const coefficientRows = data.temporaryWorkers.map((worker) => {
      const id = `${worker.configurationItemId}:${worker.personId}`;
      return { worker, text: multipliers[id]?.trim() ?? "", reason: multiplierReasons[id]?.trim() ?? "" };
    });
    if (coefficientRows.some((row) => !/^\d+(?:\.\d{1,3})?$/.test(row.text) || Number(row.text) <= 0 || Number(row.text) > 10)) {
      setMessage("临时工实发系数必须大于 0 且不超过 10，最多三位小数。");
      return;
    }
    if (coefficientRows.some((row) => Number(row.text) !== 1 && !row.reason)) {
      setMessage("临时工实发系数不是 1.0 时，必须填写调整原因。");
      return;
    }
    if (!(await confirmInApp("确认本单有效上数和临时工实发系数无误，并进入责任判定？"))) return;
    try {
      await call("rework-orders/" + reworkOrderId + "/whole-order-review/approve", WholeOrderReviewResponseSchema.parse, {
        expectedOrderVersion: data.orderVersion,
        temporaryCoefficients: coefficientRows.map(({ worker, text, reason }) => ({
          configurationItemId: worker.configurationItemId,
          personId: worker.personId,
          multiplier: Number(text),
          ...(reason ? { reason } : {}),
        })),
      });
      setMessage("本单返工已完成 N07 整单确认，已流转到 N08 · 待责任判定。");
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "整单完成确认失败"); }
  };

  if (!data || ["draft", "pending_process_configuration", "pending_ie_review", "pending_task_assignment"].includes(data.reworkStatus)) return null;

  const allComplete = data.processes.length > 0 && data.processes.every((process) => process.complete);
  const temporaryCoefficientRows = data.temporaryWorkers.map((worker) => {
    const id = `${worker.configurationItemId}:${worker.personId}`;
    return { text: multipliers[id]?.trim() ?? "", reason: multiplierReasons[id]?.trim() ?? "" };
  });
  const temporaryCoefficientIssue = temporaryCoefficientRows.some((row) => !/^\d+(?:\.\d{1,3})?$/.test(row.text) || Number(row.text) <= 0 || Number(row.text) > 10)
    ? "还需完成：临时工实发系数须大于 0、不超过 10，最多三位小数"
    : temporaryCoefficientRows.some((row) => Number(row.text) !== 1 && !row.reason)
      ? "还需完成：非 1.0 的临时工实发系数必须填写调整原因"
      : "";
  const wholeOrderReady = allComplete && temporaryCoefficientIssue === "";
  return <div className="whole-order-review-flow">
    <Surface>
      <div className="section-title">
        <div>
          <h2>{data.reworkStatus === "pending_order_review" ? "N07 · 尾部主管整单确认" : "返工完成进度"}</h2>
          <p>{message}</p>
        </div>
        <StatusBadge tone={data.reworkStatus === "pending_order_review" ? "warning" : allComplete ? "success" : "info"}>{reworkStatusLabel(data.reworkStatus)}</StatusBadge>
      </div>
      <div className="workflow-queue-guide">
        <div><small>谁来处理</small><strong>{data.reworkStatus === "pending_order_review" ? "尾部主管" : "系统自动判断 / 授权主管查看"}</strong></div>
        <div><small>当前要做什么</small><strong>{data.reworkStatus === "pending_order_review" ? "核对工人上数不超过尾查汇总，确认临时工实发系数" : "等待工人上数与尾查报数同时完成"}</strong></div>
        <div><small>完成后去哪里</small><strong>{data.reworkStatus === "pending_order_review" ? "确认后直接进入 N08 · 责任判定" : "两项报数完成后自动进入 N07 整单确认"}</strong></div>
      </div>
    </Surface>

    <Surface>
      <h2>{data.reworkStatus === "pending_order_review" ? "工人上数与尾查汇总对照" : "并行报数状态"}</h2>
      <p>{data.reworkStatus === "pending_order_review" ? "以尾查汇总为准：每道工序的工人有效上数必须小于或等于尾查件数。少报允许并显示缺口；超过时须驳回调整。" : "N05 工人上数与 N06 尾查报数互不等待；两项全部提交后，系统才开放 N07。"}</p>
      {data.processes.map((process) => <div className="section-title whole-order-row" key={process.configurationItemId}>
        <div>
          <b>{process.processName}</b>
          <p>工人有效上数 {process.completedQuantity} 件 · 尾查汇总 {process.tailCheckedQuantity} 件 · {process.countGap >= 0 ? `未上数差额 ${process.countGap} 件` : `超出 ${Math.abs(process.countGap)} 件`}</p>
        </div>
        <StatusBadge tone={process.complete ? "success" : "danger"}>{process.complete ? data.reworkStatus === "pending_order_review" ? "可确认" : "待两项完成" : "需驳回调整"}</StatusBadge>
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

    {data.canReview && data.reworkStatus === "pending_order_review" && data.temporaryWorkers.length > 0 && <Surface>
      <h2>临时工实发系数</h2>
      <p>默认 1.0。旺季加价时按“人员 + 工序”调整；非 1.0 必须填写原因。该系数只影响实发工资；外部扣款倍率在责任环节另行调整。</p>
      {data.temporaryWorkers.map((worker) => {
        const id = `${worker.configurationItemId}:${worker.personId}`;
        return <div className="section-title whole-order-row" key={id}>
          <div><b>{worker.displayName} · {worker.processName}</b><p>实发工资 = 有效上数 × IE 核准单价 × 临时工系数。</p></div>
          <div className="mobile-actions whole-order-actions">
            <InsetField label="实发系数" type="number" min="0.001" max="10" step="0.001" inputMode="decimal" value={multipliers[id] ?? "1"} disabled={busy} onChange={(event) => setMultipliers((current) => ({ ...current, [id]: event.target.value }))} />
            <InsetField label="调整原因（非 1.0 必填）" value={multiplierReasons[id] ?? ""} disabled={busy} onChange={(event) => setMultiplierReasons((current) => ({ ...current, [id]: event.target.value }))} />
          </div>
        </div>;
      })}
    </Surface>}


    {data.canReview && data.reworkStatus === "pending_order_review" && data.processes.every((process) => process.finalUnitPrice !== null) && <Surface>
      <h2>确认整单并生成工资</h2>
      <p>确认后系统按个人有效上数、N03 IE 核准单价及临时工实发系数生成工资，并直接进入责任判定。若工人上数超过尾查汇总，请先驳回对应记录。</p>
      {temporaryCoefficientIssue && <p role="status">{temporaryCoefficientIssue}</p>}
      <div className="mobile-actions">
        <Button variant="primary" onClick={() => void approve()} disabled={busy || !wholeOrderReady}>{busy ? "确认中…" : "确认整单并进入责任判定"}</Button>
      </div>
    </Surface>}
  </div>;
}
