import {
  ExternalResponsibilityQueueResponseSchema,
  type ExternalResponsibilityQueueResponse,
} from "@dx-rework/contracts/external-responsibility";
import { formatBusinessCurrency, formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { Header, Shell, TaskCard } from "./components.js";
import { ListPagination, usePaginatedItems } from "./list-pagination.js";
import "./external-responsibility.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
type State = { kind: "loading" } | { kind: "ready"; value: ExternalResponsibilityQueueResponse } | { kind: "unavailable"; message: string };
const statusLabel: Record<ExternalResponsibilityQueueResponse["items"][number]["status"], string> = {
  pending_business_signoff: "待交财务", pending_payables_confirmation: "待扣款", deduction_follow_up: "扣款中", pending_special_approval: "待财务总监特批", returned: "资料退回", pending_responsibility_revision: "待重判", closed: "扣款完成", superseded: "历史台账",
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
  const page = usePaginatedItems(items, q);
  return <Shell active="外部扣款"><Header title="供应商扣款处理" subtitle="记录每次实际扣款；扣足后系统自动完成" badge={state.kind === "ready" ? `${formatBusinessDecimal(items.length)} 条当前结果` : "加载中"} />
    <Surface className="external-queue-summary"><div><h2>供应商扣款工作台</h2><p>查看应扣、累计已扣和剩余金额，录入本次扣款即可。</p></div><StatusBadge tone="info">扣款台账</StatusBadge></Surface>
    <Surface className="reporting-filters"><InsetField label="搜索当前节点事项" type="search" value={q} onChange={(event) => setQ(event.target.value)} placeholder="单号 / 款号 / 订单号 / 供应商 / 状态" /></Surface>
    {state.kind === "loading" && <Surface className="external-state">正在加载外部责任队列…</Surface>}
    {state.kind === "unavailable" && <Surface className="external-state">{state.message}</Surface>}
    {state.kind === "ready" && items.length === 0 && <Surface className="external-state">当前没有符合条件的外部责任事项。</Surface>}
    {state.kind === "ready" && <><div className="task-grid external-queue-grid">{page.items.map((item) => <a className="responsibility-task-link" href={`${basePath}/ui/tasks/${item.reworkOrderId}`} key={item.caseId}><TaskCard task={{ id: item.reworkNo ?? "返工单", title: `${statusLabel[item.status]} · ${item.supplierName}`, meta: [item.styleNo ?? "款号未填写", item.orderNo ?? "订单号未填写", `应扣 ${formatBusinessCurrency(item.proposedDeductionAmount)}`, `累计已扣 ${formatBusinessCurrency(item.actualDeductedAmount)}`, `剩余 ${formatBusinessCurrency(item.remainingAmount)}`, item.overdue ? "已逾期" : item.canAct ? "可处理" : "仅查看"].join(" · "), tone: item.overdue ? "danger" : item.canAct ? "warning" : "info", stateLabel: item.overdue ? "已逾期" : item.canAct ? "待处理" : "仅查看" }} /><span>打开扣款台账 →</span></a>)}</div><ListPagination page={page.page} totalPages={page.totalPages} onPageChange={page.setPage} ariaLabel="供应商扣款分页" /></>}
  </Shell>;
}
