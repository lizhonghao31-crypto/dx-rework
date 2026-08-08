import {
  ExternalResponsibilityQueueResponseSchema,
  type ExternalResponsibilityQueueResponse,
} from "@dx-rework/contracts/external-responsibility";
import { StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { Header, Shell, TaskCard } from "./components.js";
import "./external-responsibility.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const queueRefreshMilliseconds = 15_000;
type State = { kind: "loading" } | { kind: "ready"; value: ExternalResponsibilityQueueResponse } | { kind: "unavailable"; message: string };
const statusLabel: Record<ExternalResponsibilityQueueResponse["items"][number]["status"], string> = {
  pending_business_signoff: "待业务签收", pending_payables_confirmation: "待应付确认", deduction_follow_up: "扣款跟进中", returned: "已退回", pending_responsibility_revision: "待责任变更", closed: "已关闭", superseded: "已替代",
};

export function ExternalResponsibilityQueuePage() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  useEffect(() => {
    const controller = new AbortController(); let requestInFlight = false;
    const load = async (initial: boolean): Promise<void> => {
      if (requestInFlight) return; requestInFlight = true;
      try {
        const response = await fetch(apiUrl("external-responsibilities/queue"), { credentials: "include", signal: controller.signal, headers: { accept: "application/json" } });
        if (!response.ok) throw new Error("外部责任队列加载失败");
        setState({ kind: "ready", value: ExternalResponsibilityQueueResponseSchema.parse(await response.json()) });
      } catch (error: unknown) {
        if (!(error instanceof DOMException && error.name === "AbortError") && initial) setState({ kind: "unavailable", message: error instanceof Error ? error.message : "外部责任队列加载失败" });
      } finally { requestInFlight = false; }
    };
    const refresh = (): void => { void load(false); };
    void load(true); const intervalId = window.setInterval(refresh, queueRefreshMilliseconds); window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.clearInterval(intervalId); window.removeEventListener("focus", refresh); };
  }, []);
  const items = state.kind === "ready" ? state.value.items : [];
  return <Shell active="外部扣款"><Header title="外部责任签收与扣款" subtitle="N08-B 签收与应付确认完成后，生产返工可完结；N10-B 实扣继续独立跟进" badge={state.kind === "ready" ? `${items.length} 条 · 实时队列` : "实时队列"} />
    <Surface className="external-queue-summary"><div><h2>外部责任双阶段台账</h2><p>拟扣对象和金额均由服务端正式责任快照生成；实际扣款流水不覆盖原始责任，也不阻塞生产完结。</p></div><StatusBadge tone="info">N08-B / N10-B</StatusBadge></Surface>
    {state.kind === "loading" && <Surface className="external-state">正在加载外部责任队列…</Surface>}
    {state.kind === "unavailable" && <Surface className="external-state">{state.message}</Surface>}
    {state.kind === "ready" && items.length === 0 && <Surface className="external-state">当前没有你可查看的外部责任事项。</Surface>}
    {state.kind === "ready" && <div className="task-grid external-queue-grid">{items.map((item) => <a className="responsibility-task-link" href={`${basePath}/ui/tasks/${item.reworkOrderId}`} key={item.caseId}><TaskCard task={{ id: item.reworkNo ?? "返工单", title: `${statusLabel[item.status]} · ${item.supplierName}`, meta: [item.styleNo ?? "款号未填写", item.orderNo ?? "订单号未填写", `拟扣 ¥${item.proposedDeductionAmount}`, `实扣 ¥${item.actualDeductedAmount}`, `差额 ¥${item.remainingAmount}`, item.overdue ? "已逾期" : item.canAct ? "可处理" : "仅查看"].join(" · "), tone: item.overdue ? "danger" : item.canAct ? "warning" : "info", stateLabel: item.overdue ? "已逾期" : item.canAct ? "待处理" : "仅查看" }} /><span>打开服务端锁定台账 →</span></a>)}</div>}
  </Shell>;
}
