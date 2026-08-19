import {
  OwnFactoryApprovalResponseSchema,
  type OwnFactoryApprovalResponse,
} from "@dx-rework/contracts";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { confirmInApp } from "./system-dialog.js";
import "./own-factory-approval.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
type PanelState =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "ready"; value: OwnFactoryApprovalResponse }
  | { kind: "unavailable"; message: string };

const requestError = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? "请求未完成，请稍后重试";
  } catch {
    return "请求未完成，请稍后重试";
  }
};

const formatBusinessTime = (value: string): string =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));

const bpsToPercent = (value: number): string => {
  const percent = value / 100;
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
};

const reviewSnapshotSummary = (snapshot: unknown): string => {
  if (!snapshot || typeof snapshot !== "object") return "整单审核快照已锁定";
  const source = snapshot as {
    processes?: unknown;
    reports?: Array<{ members?: unknown }>;
  };
  const processes = Array.isArray(source.processes) ? source.processes.length : 0;
  const reports = Array.isArray(source.reports) ? source.reports : [];
  const members = reports.reduce(
    (total, report) => total + (Array.isArray(report.members) ? report.members.length : 0),
    0,
  );
  return `已锁定 ${processes} 道工序、${reports.length} 条上数、${members} 位成员快照`;
};

export function OwnFactoryApprovalPanel({
  reworkOrderId,
}: {
  reworkOrderId: string | null;
}) {
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  const [opinion, setOpinion] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const pendingDecisionKeys = useRef<Record<string, string>>({});

  const load = async (): Promise<void> => {
    if (!reworkOrderId) return;
    const response = await fetch(
      apiUrl(`rework-orders/${reworkOrderId}/own-factory-approval`),
      { credentials: "include", headers: { accept: "application/json" } },
    );
    if (response.status === 403) {
      setState({ kind: "hidden" });
      return;
    }
    if (!response.ok) throw new Error(await requestError(response));
    setState({
      kind: "ready",
      value: OwnFactoryApprovalResponseSchema.parse(await response.json()),
    });
  };

  useEffect(() => {
    if (!reworkOrderId) {
      setState({ kind: "hidden" });
      return;
    }
    let requestInFlight = false;
    let hasLoaded = false;
    const refresh = async (): Promise<void> => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        await load();
        hasLoaded = true;
      } catch (error: unknown) {
        if (!hasLoaded) {
          setState({
            kind: "unavailable",
            message: error instanceof Error ? error.message : "本厂承担审批加载失败",
          });
        }
      } finally {
        requestInFlight = false;
      }
    };
    void refresh();
  }, [reworkOrderId]);

  const decide = async (decision: "approved" | "rejected"): Promise<void> => {
    if (state.kind !== "ready" || !state.value.approval || !state.value.canDecide || busy) return;
    if (decision === "rejected" && !opinion.trim()) {
      setMessage("驳回必须填写原因。");
      return;
    }
    if (!(await confirmInApp(decision === "approved" ? "确认通过本厂承担？" : "确认驳回并退回责任判定？"))) return;
    setBusy(decision);
    setMessage("");
    try {
      const approval = state.value.approval;
      const body = {
        expectedOrderVersion: state.value.orderVersion,
        expectedApprovalVersion: approval.approvalVersion,
        ...(opinion.trim() ? { opinion: opinion.trim() } : {}),
      };
      const signature = JSON.stringify({
        approvalId: approval.approvalId,
        decision,
        body,
      });
      const idempotencyKey = pendingDecisionKeys.current[signature] ?? crypto.randomUUID();
      pendingDecisionKeys.current[signature] = idempotencyKey;
      const response = await fetch(
        apiUrl(`own-factory-approvals/${approval.approvalId}/${decision === "approved" ? "approve" : "reject"}`),
        {
          method: "POST",
          credentials: "include",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) throw new Error(await requestError(response));
      const next = OwnFactoryApprovalResponseSchema.parse(await response.json());
      delete pendingDecisionKeys.current[signature];
      setState({ kind: "ready", value: next });
      setOpinion("");
      setMessage(decision === "approved" ? "审批已通过，另一位老板的结果知会已进入发送队列。" : "已驳回并退回 N07；另一位老板的结果知会已进入发送队列。请形成新的责任版本后重新发起审批。");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "审批操作失败");
    } finally {
      setBusy(null);
    }
  };

  if (state.kind === "hidden") return null;
  if (state.kind === "loading") {
    return <Surface className="own-factory-approval-state">正在核验本厂承担审批权限…</Surface>;
  }
  if (state.kind === "unavailable") {
    return <Surface className="own-factory-approval-state">{state.message}</Surface>;
  }

  const { value } = state;
  const approval = value.approval;
  if (!approval) {
    return (
      <Surface className="own-factory-approval-state">
        当前正式责任版本没有本厂承担金额，因此不创建 N08-A 审批。
      </Surface>
    );
  }
  const pending = approval.status === "pending";
  const decisionTone = approval.status === "approved" ? "success" : approval.status === "rejected" ? "danger" : "warning";

  return (
    <Surface className="own-factory-approval-panel">
      <div className="section-title own-factory-approval-heading">
        <div>
          <h2>本厂承担审批</h2>
          <p>
            N08-A · 锁定责任正式版本 V{approval.finalizedDeterminationVersion}，金额和工人快照均由服务端保存。
          </p>
        </div>
        <StatusBadge tone={decisionTone}>
          {approval.status === "pending" ? "待审批" : approval.status === "approved" ? "已通过" : "已驳回"}
        </StatusBadge>
      </div>

      {message && <div className="own-factory-approval-message" role="status">{message}</div>}

      <div className="own-factory-approval-total">
        <span>本厂承担合计</span>
        <strong>¥{approval.ownFactoryTotalAmount}</strong>
      </div>

      <section className="own-factory-approval-section">
        <h3>QC 与整单审核来源</h3>
        <p>QC 发起记录 · {formatBusinessTime(approval.sourceSnapshot.qualityControl.initiatedAt)}</p>
        <p>整单审核记录 · {formatBusinessTime(approval.sourceSnapshot.wholeOrderReview.reviewedAt)}</p>
        <small>{reviewSnapshotSummary(approval.sourceSnapshot.wholeOrderReview.reviewSnapshot)}</small>
      </section>

      <section className="own-factory-approval-section">
        <h3>锁定工序与责任金额</h3>
        <div className="own-factory-processes">
          {approval.sourceSnapshot.processes.map((process) => (
            <div key={process.configurationItemId}>
              <span>{process.processName}</span>
              <small>{process.pricingUnit === "piece" ? "件" : "小时"} · 倍率 {process.multiplier} · 本厂 {bpsToPercent(process.ownFactoryShareBps)}%</small>
              <b>¥{process.ownFactoryRoundedAmount}</b>
            </div>
          ))}
        </div>
      </section>

      <section className="own-factory-approval-section">
        <h3>工人上数快照</h3>
        <div className="own-factory-amount-lines">
          {approval.sourceSnapshot.amountLines.map((line) => (
            <div key={`${line.workReportId}:${line.personId}`}>
              <span>{line.workerDisplayName}</span>
              <small>{line.taskMode === "collective" ? "集体上数" : "个人上数"} · 倍率 {line.multiplier} · {bpsToPercent(line.shareBps)}%</small>
              <b>¥{line.roundedAmount}</b>
            </div>
          ))}
        </div>
      </section>

      {approval.sourceSnapshot.finalizedDetermination.highMultiplierConfirmation && (
        <section className="own-factory-approval-section">
          <h3>高倍率独立确认</h3>
          <p>已锁定确认记录：{approval.sourceSnapshot.finalizedDetermination.highMultiplierConfirmation.reason}</p>
        </section>
      )}

      {approval.decision && (
        <section className="own-factory-approval-section own-factory-decision">
          <h3>终局决定</h3>
          <p>
            {approval.decision.decision === "approved" ? "通过" : "驳回"} · {formatBusinessTime(approval.decision.decidedAt)}
            {approval.decision.opinion ? ` · ${approval.decision.opinion}` : ""}
          </p>
        </section>
      )}

      {pending && value.canDecide && (
        <div className="own-factory-approval-actions">
          <InsetField
            label="审批意见 / 驳回原因"
            value={opinion}
            disabled={Boolean(busy)}
            placeholder="驳回时必填；通过时可选"
            onChange={(event) => setOpinion(event.target.value)}
          />
          <div>
            <Button variant="primary" disabled={Boolean(busy)} onClick={() => void decide("approved")}>通过</Button>
            <Button disabled={Boolean(busy) || !opinion.trim()} onClick={() => void decide("rejected")}>驳回并退回 N07</Button>
          </div>
        </div>
      )}
      {pending && !value.canDecide && <StatusBadge tone="info">当前仅可查看；终局审批由直接有效老板或有效订单范围代理执行。</StatusBadge>}

      <section className="own-factory-approval-section">
        <h3>审批历史</h3>
        <div className="own-factory-history">
          {value.history.map((item) => (
            <div key={item.approvalId}>
              <span>责任版本 V{item.finalizedDeterminationVersion}</span>
              <small>{item.status === "pending" ? "待审批" : item.status === "approved" ? "已通过" : "已驳回"} · {formatBusinessTime(item.createdAt)}</small>
              <b>¥{item.ownFactoryTotalAmount}</b>
            </div>
          ))}
        </div>
      </section>
    </Surface>
  );
}
