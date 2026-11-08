import {
  ExternalResponsibilityQueueResponseSchema,
  ExternalResponsibilityQueueStatusLabels as statusLabel,
} from "@dx-rework/contracts/external-responsibility";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { fixedBusinessCurrency as formatBusinessCurrency } from "./fixed-business-currency.js";
import { Button, InsetField, Surface } from "@dx-rework/ui";
import {useRemoteQueue} from "./use-remote-queue.js";

import { createWebUrls } from "../url-contract.js";
import { Header, Shell, TaskCard } from "./components.js";
import { ListPagination } from "./list-pagination.js";
import "./external-responsibility.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
export function ExternalResponsibilityQueuePage() {
  const {state,q,setQ,searchInput,total,page,retry}=useRemoteQueue(apiUrl("external-responsibilities/queue"),ExternalResponsibilityQueueResponseSchema,"外部责任队列加载失败");
  const items=state.kind==="ready"?state.value.items:[];
  const basePath=import.meta.env.BASE_URL.replace(/\/$/,"");

  return <Shell active="外部扣款"><Header title="供应商扣款处理" subtitle="核对应扣、累计已扣与剩余金额；录入本次实际扣款并按现有流程完成" badge={state.kind === "ready" ? `${formatBusinessDecimal(total)} 条当前结果` : "加载中"} />
    <Surface className="reporting-filters"><InsetField label="搜索当前节点事项" type="search" {...searchInput} value={q} onChange={(event) => setQ(event.target.value)} placeholder="单号 / 款号 / 订单号 / 供应商 / 状态" /></Surface>
    {state.kind === "loading" && <Surface className="external-state">正在加载外部责任队列…</Surface>}
    {state.kind === "unavailable" && <Surface className="external-state">{state.message}<Button type="button" onClick={retry}>刷新</Button></Surface>}
    {state.kind === "ready" && items.length === 0 && <Surface className="external-state">当前没有符合条件的外部责任事项。</Surface>}
    {state.kind === "ready" && <><div className="task-grid external-queue-grid">{items.map((item) => <a className="responsibility-task-link" href={`${basePath}/ui/tasks/${item.reworkOrderId}`} key={item.caseId}><TaskCard task={{ id: item.reworkNo ?? "返工单", title: `${statusLabel[item.status]} · ${item.supplierName}`, meta: [item.styleNo ?? "款号未填写", item.orderNo ?? "订单号未填写", `扣款状态 ${statusLabel[item.status]}`, `应扣 ${formatBusinessCurrency(item.proposedDeductionAmount)}`, `累计已扣 ${formatBusinessCurrency(item.actualDeductedAmount)}`, `剩余 ${formatBusinessCurrency(item.remainingAmount)}`, item.overdue ? "已逾期" : item.canAct ? "可处理" : item.status === "closed" ? "已完成" : "仅查看"].join(" · "), tone: item.overdue ? "danger" : item.canAct ? "warning" : "info", stateLabel: item.overdue ? "已逾期" : item.status === "closed" ? "已完成" : item.canAct ? "待处理" : "仅查看" }} /><span>打开扣款台账 →</span></a>)}</div><ListPagination page={page.page} totalPages={page.totalPages} onPageChange={page.setPage} ariaLabel="供应商扣款分页" /></>}
  </Shell>;
}
