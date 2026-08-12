import {
  ExternalResponsibilityQueueResponseSchema,
  type ExternalResponsibilityQueueResponse,
} from "@dx-rework/contracts/external-responsibility";
import { InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { Header, Shell, TaskCard } from "./components.js";
import "./external-responsibility.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
type State = { kind: "loading" } | { kind: "ready"; value: ExternalResponsibilityQueueResponse } | { kind: "unavailable"; message: string };
const statusLabel: Record<ExternalResponsibilityQueueResponse["items"][number]["status"], string> = {
  pending_business_signoff: "待补充资料", pending_payables_confirmation: "待记录扣款", deduction_follow_up: "扣款跟进中", returned: "资料已退回", pending_responsibility_revision: "待责任变更", closed: "已关闭", superseded: "已替代",
};

export function ExternalResponsibilityQueuePage() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [q, setQ] = useState("");
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
    void load(true);
    return () => controller.abort();
  }, []);
  const allItems = state.kind === "ready" ? state.value.items : [];
  const items = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return allItems;
    return allItems.filter((item) => [item.reworkNo, item.styleNo, item.orderNo, item.supplierName, statusLabel[item.status]]
      .filter(Boolean).join(" ").toLocaleLowerCase("zh-CN").includes(needle));
  }, [allItems, q]);
  return <Shell active="外部扣款"><Header title="供应商扣款处理" subtitle="供应商确定后直接由对应应付记录扣款；资料有误可退回经办人修正" badge={state.kind === "ready" ? `${items.length} 条当前结果` : "实时队列"} />
    <Surface className="external-queue-summary"><div><h2>供应商扣款工作台</h2><p>应付直接记录实际扣款或退回资料问题；经办人只在资料退回后修正并重新提交。</p></div><StatusBadge tone="info">扣款台账</StatusBadge></Surface>
    <Surface className="reporting-filters"><InsetField label="搜索当前节点事项" type="search" value={q} onChange={(event) => setQ(event.target.value)} placeholder="单号 / 款号 / 订单号 / 供应商 / 状态" /></Surface>
    {state.kind === "loading" && <Surface className="external-state">正在加载外部责任队列…</Surface>}
    {state.kind === "unavailable" && <Surface className="external-state">{state.message}</Surface>}
    {state.kind === "ready" && items.length === 0 && <Surface className="external-state">当前没有符合条件的外部责任事项。</Surface>}
    {state.kind === "ready" && <div className="task-grid external-queue-grid">{items.map((item) => <a className="responsibility-task-link" href={`${basePath}/ui/tasks/${item.reworkOrderId}`} key={item.caseId}><TaskCard task={{ id: item.reworkNo ?? "返工单", title: `${statusLabel[item.status]} · ${item.supplierName}`, meta: [item.styleNo ?? "款号未填写", item.orderNo ?? "订单号未填写", `拟扣 ¥${item.proposedDeductionAmount}`, `实扣 ¥${item.actualDeductedAmount}`, `差额 ¥${item.remainingAmount}`, item.overdue ? "已逾期" : item.canAct ? "可处理" : "仅查看"].join(" · "), tone: item.overdue ? "danger" : item.canAct ? "warning" : "info", stateLabel: item.overdue ? "已逾期" : item.canAct ? "待处理" : "仅查看" }} /><span>打开服务端锁定台账 →</span></a>)}</div>}
  </Shell>;
}
