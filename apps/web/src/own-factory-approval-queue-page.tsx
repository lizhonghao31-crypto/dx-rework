import {
  OwnFactoryApprovalQueueResponseSchema,
} from "@dx-rework/contracts";
import { formatBusinessCurrency, formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import {useRemoteQueue} from "./use-remote-queue.js";

import { createWebUrls } from "../url-contract.js";
import { Header, Shell, TaskCard } from "./components.js";
import { ListPagination } from "./list-pagination.js";
import "./responsibility-queue.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
export function OwnFactoryApprovalQueuePage() {
  const {state,q,setQ,searchInput,total,page,retry}=useRemoteQueue(apiUrl("own-factory-approvals/queue"),OwnFactoryApprovalQueueResponseSchema,"本厂承担审批队列加载失败");
  const items=state.kind==="ready"?state.value.items:[];
  const basePath=import.meta.env.BASE_URL.replace(/\/$/,"");

  return (
    <Shell active="本厂审批">
      <Header
        title="本厂承担审批"
        subtitle="需要审批的本厂承担事项集中在这里"
        badge={state.kind === "ready" ? `${formatBusinessDecimal(total)} 条当前结果` : "加载中"}
      />
      <Surface className="responsibility-queue-summary">
        <div>
          <h2>本厂承担审批工作台</h2>
          <p>核对责任金额与明细后决定通过或驳回。</p>
        </div>
        <StatusBadge tone="warning">待审批</StatusBadge>
      </Surface>
      <Surface className="reporting-filters">
        <InsetField label="搜索当前节点订单" type="search" {...searchInput} value={q} onChange={(event) => setQ(event.target.value)} placeholder="单号 / 款号 / 订单号 / 问题部位" />
      </Surface>
      {state.kind === "loading" && <Surface className="responsibility-queue-state">正在加载本厂承担审批…</Surface>}
      {state.kind === "unavailable" && <Surface className="responsibility-queue-state">{state.message}<Button onClick={retry}>重试读取本页</Button></Surface>}
      {state.kind === "ready" && items.length === 0 && <Surface className="responsibility-queue-state">当前没有符合条件的本厂承担审批。</Surface>}
      {state.kind === "ready" && items.length > 0 && (
        <div className="task-grid responsibility-queue-grid">
          {items.map((item) => (
            <a className="responsibility-task-link" href={`${basePath}/ui/tasks/${item.reworkOrderId}`} key={item.approvalId}>
              <TaskCard task={{
                id: item.reworkNo ?? "返工单",
                title: item.canDecide ? "本厂承担待审批" : "本厂承担待查看",
                meta: [item.styleNo ?? "款号未填写", item.orderNo ?? "订单号未填写", item.problemPart ?? "问题部位未填写", `本厂 ${formatBusinessCurrency(item.ownFactoryTotalAmount)}`, item.canDecide ? "可审批" : "仅查看"].join(" · "),
                tone: item.canDecide ? "warning" : "info",
                stateLabel: item.canDecide ? "待审批" : "仅查看",
              }} />
              <span>打开审批 →</span>
            </a>
          ))}
        </div>
      )}
      {state.kind === "ready" && <ListPagination page={page.page} totalPages={page.totalPages} onPageChange={page.setPage} ariaLabel="本厂承担审批分页" />}
    </Shell>
  );
}
