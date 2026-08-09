import {
  ResponsibilityQueueResponseSchema,
  type ResponsibilityQueueResponse,
} from "@dx-rework/contracts/responsibility-queue";
import { InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { Header, Shell, TaskCard } from "./components.js";
import "./responsibility-queue.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const queueRefreshMilliseconds = 15_000;

type QueueState =
  | { kind: "loading" }
  | { kind: "ready"; value: ResponsibilityQueueResponse }
  | { kind: "unavailable"; message: string };

export function ResponsibilityQueuePage() {
  const [state, setState] = useState<QueueState>({ kind: "loading" });
  const [q, setQ] = useState("");
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  useEffect(() => {
    const controller = new AbortController();
    let requestInFlight = false;

    const load = async (initial: boolean): Promise<void> => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const response = await fetch(apiUrl("responsibility-determinations/queue"), {
          credentials: "include",
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error("待判责队列加载失败");
        const value = ResponsibilityQueueResponseSchema.parse(await response.json());
        setState({ kind: "ready", value });
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (initial) {
          setState({
            kind: "unavailable",
            message: error instanceof Error ? error.message : "待判责队列加载失败",
          });
        }
      } finally {
        requestInFlight = false;
      }
    };

    const refresh = (): void => { void load(false); };
    void load(true);
    const intervalId = window.setInterval(refresh, queueRefreshMilliseconds);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  const allItems = state.kind === "ready" ? state.value.items : [];
  const items = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return allItems;
    return allItems.filter((item) => [item.reworkNo, item.styleNo, item.orderNo, item.problemPart]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("zh-CN")
      .includes(needle));
  }, [allItems, q]);

  return (
    <Shell active="责任处理">
      <Header
        title="待责任判定"
        subtitle="订单进入 N07 后自动出现在这里；责任提交完成后自动离开本队列"
        badge={state.kind === "ready" ? `${items.length} 条当前结果` : "实时队列"}
        action="返工统一查询"
        actionHref="/ui/tasks"
      />
      <Surface className="responsibility-queue-summary">
        <div>
          <h2>责任处理工作台</h2>
          <p>谁来处理：有判责、接管或独立确认权限的人；完成后流向 N08 对应责任分支。</p>
        </div>
        <StatusBadge tone="info">N07 · 待判责</StatusBadge>
      </Surface>
      <Surface className="reporting-filters">
        <InsetField label="搜索当前节点订单" type="search" value={q} onChange={(event) => setQ(event.target.value)} placeholder="单号 / 款号 / 订单号 / 问题部位" />
      </Surface>

      {state.kind === "loading" && <Surface className="responsibility-queue-state">正在加载待判责返工单…</Surface>}
      {state.kind === "unavailable" && <Surface className="responsibility-queue-state">{state.message}</Surface>}
      {state.kind === "ready" && items.length === 0 && <Surface className="responsibility-queue-state">当前没有符合条件的待判责返工单。</Surface>}
      {state.kind === "ready" && items.length > 0 && (
        <div className="task-grid responsibility-queue-grid">
          {items.map((item) => {
            const title = item.highMultiplierPending
              ? item.canConfirmHighMultiplier
                ? "高倍率待你独立确认"
                : "高倍率待独立确认"
              : item.determinationStage === "draft"
                ? `责任草稿 V${item.determinationVersion}`
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
    </Shell>
  );
}
