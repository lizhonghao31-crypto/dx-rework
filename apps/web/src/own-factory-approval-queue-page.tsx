import {
  OwnFactoryApprovalQueueResponseSchema,
  type OwnFactoryApprovalQueueResponse,
} from "@dx-rework/contracts";
import { StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { Header, Shell, TaskCard } from "./components.js";
import "./responsibility-queue.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const queueRefreshMilliseconds = 15_000;

type QueueState =
  | { kind: "loading" }
  | { kind: "ready"; value: OwnFactoryApprovalQueueResponse }
  | { kind: "unavailable"; message: string };

export function OwnFactoryApprovalQueuePage() {
  const [state, setState] = useState<QueueState>({ kind: "loading" });
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  useEffect(() => {
    const controller = new AbortController();
    let requestInFlight = false;

    const load = async (initial: boolean): Promise<void> => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const response = await fetch(apiUrl("own-factory-approvals/queue"), {
          credentials: "include",
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error("本厂承担审批队列加载失败");
        const value = OwnFactoryApprovalQueueResponseSchema.parse(
          await response.json(),
        );
        setState({ kind: "ready", value });
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (initial) {
          setState({
            kind: "unavailable",
            message: error instanceof Error
              ? error.message
              : "本厂承担审批队列加载失败",
          });
        }
      } finally {
        requestInFlight = false;
      }
    };

    const refresh = (): void => {
      void load(false);
    };

    void load(true);
    const intervalId = window.setInterval(refresh, queueRefreshMilliseconds);
    window.addEventListener("focus", refresh);

    return () => {
      controller.abort();
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  const items = state.kind === "ready" ? state.value.items : [];
  return (
    <Shell active="本厂审批">
      <Header
        title="本厂承担审批"
        subtitle="N08-A 仅显示当前登录人按服务端角色、在职状态和订单范围代理可见的待审批事项"
        badge={state.kind === "ready" ? `${items.length} 条 · 实时队列` : "实时队列"}
        action="返回责任处理"
        actionHref="/ui/responsibility"
      />
      <Surface className="responsibility-queue-summary">
        <div>
          <h2>终局审批入口</h2>
          <p>金额和工人上数均是正式责任版本的不可变服务端快照；不在浏览器重算。</p>
        </div>
        <StatusBadge tone="warning">N08-A · 待审批</StatusBadge>
      </Surface>
      {state.kind === "loading" && <Surface className="responsibility-queue-state">正在加载本厂承担审批…</Surface>}
      {state.kind === "unavailable" && <Surface className="responsibility-queue-state">{state.message}</Surface>}
      {state.kind === "ready" && items.length === 0 && <Surface className="responsibility-queue-state">当前没有你可查看的本厂承担审批。</Surface>}
      {state.kind === "ready" && items.length > 0 && (
        <div className="task-grid responsibility-queue-grid">
          {items.map((item) => (
            <a className="responsibility-task-link" href={`${basePath}/ui/tasks/${item.reworkOrderId}`} key={item.approvalId}>
              <TaskCard task={{
                id: item.reworkNo ?? "返工单",
                title: item.canDecide ? "本厂承担待终局审批" : "本厂承担待查看",
                meta: [item.styleNo ?? "款号未填写", item.orderNo ?? "订单号未填写", item.problemPart ?? "问题部位未填写", `本厂 ¥${item.ownFactoryTotalAmount}`, item.canDecide ? "可审批" : "仅查看"].join(" · "),
                tone: item.canDecide ? "warning" : "info",
                stateLabel: item.canDecide ? "待审批" : "仅查看",
              }} />
              <span>打开锁定审批快照 →</span>
            </a>
          ))}
        </div>
      )}
    </Shell>
  );
}
