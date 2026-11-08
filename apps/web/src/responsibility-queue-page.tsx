import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import {
  ResponsibilityQueueResponseSchema,
} from "@dx-rework/contracts/responsibility-queue";
import { Button, InsetField, Surface } from "@dx-rework/ui";
import {useRemoteQueue} from "./use-remote-queue.js";

import { createWebUrls } from "../url-contract.js";
import { Header, Shell, TaskCard } from "./components.js";
import { ListPagination } from "./list-pagination.js";
import "./responsibility-queue.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
export function ResponsibilityQueuePage() {
  const {state,q,setQ,searchInput,total,page,retry}=useRemoteQueue(apiUrl("responsibility-determinations/queue"),ResponsibilityQueueResponseSchema,"待判责队列加载失败");
  const items=state.kind==="ready"?state.value.items:[];
  const basePath=import.meta.env.BASE_URL.replace(/\/$/,"");

  return (
    <Shell active="责任处理">
      <Header
        title="待责任判定"
        subtitle="处理责任方、供应商与倍率；本厂责任及订单重新判责需老板确认。提交后按当前节点流转"
        badge={state.kind === "ready" ? `${formatBusinessDecimal(total)} 条当前结果` : "加载中"}
      />
      <Surface className="reporting-filters">
        <InsetField label="搜索当前节点订单" type="search" {...searchInput} value={q} onChange={(event) => setQ(event.target.value)} placeholder="单号 / 款号 / 订单号 / 问题部位" />
      </Surface>

      {state.kind === "loading" && <Surface className="responsibility-queue-state">正在加载待判责返工单…</Surface>}
      {state.kind === "unavailable" && <Surface className="responsibility-queue-state">{state.message}<Button onClick={retry}>重试读取本页</Button></Surface>}
      {state.kind === "ready" && items.length === 0 && <Surface className="responsibility-queue-state">当前没有符合条件的待判责返工单。</Surface>}
      {state.kind === "ready" && items.length > 0 && (
        <div className="task-grid responsibility-queue-grid">
          {items.map((item) => {
            const title = item.highMultiplierPending
              ? item.canConfirmHighMultiplier
                ? "高倍率待你独立确认"
                : "高倍率待独立确认"
              : item.determinationStage === "draft"
                ? "责任草稿待处理"
                : "待创建责任草稿";
            const permission = item.canConfirmHighMultiplier
              ? "可独立确认高倍率"
              : item.canDetermine
                ? "可处理"
                : item.canTakeover
                  ? "可接管"
                  : "可查看";
            const meta = [
              item.styleNo ?? "款号未填写",
              item.orderNo ?? "订单号未填写",
              item.problemPart ?? "问题部位未填写",
              item.handlerUserId ? "已分配处理人" : "尚未分配处理人",
              permission,
            ].join(" · ");
            const tone = item.highMultiplierPending ? "danger" : item.canDetermine || item.canTakeover ? "warning" : "info";
            const stateLabel = item.canConfirmHighMultiplier
              ? "待你独立确认"
              : item.highMultiplierPending
                ? "待独立确认"
                : item.canDetermine
                  ? "待处理"
                  : item.canTakeover
                    ? "可接管"
                    : "仅查看";
            return (
              <a className="responsibility-task-link" href={`${basePath}/ui/tasks/${item.reworkOrderId}`} key={item.reworkOrderId}>
                <TaskCard task={{ id: item.reworkNo ?? "返工单", title, meta, tone, stateLabel }} />
                <span>进入责任判定 →</span>
              </a>
            );
          })}
        </div>
      )}
      {state.kind === "ready" && <ListPagination page={page.page} totalPages={page.totalPages} onPageChange={page.setPage} ariaLabel="待责任判定分页" />}
    </Shell>
  );
}
