import {
  ResponsibilityQueueResponseSchema,
  type ResponsibilityQueueResponse,
} from "@dx-rework/contracts/responsibility-queue";
import { StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useState } from "react";

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
    <Shell active="责任处理">
      <Header
        title="待责任判定"
        subtitle="仅展示当前登录人按角色、组织状态与订单级代理可见的 N07 返工单"
        badge={state.kind === "ready" ? `${items.length} 条 · 实时队列` : "实时队列"}
      />
      <Surface className="responsibility-queue-summary">
        <div>
          <h2>责任处理入口</h2>
          <p>
            点击返工单进入责任详情；金额、处理人、接管和高倍率权限继续由服务端逐单校验。
          </p>
        </div>
        <StatusBadge tone="info">N07 · 待判责</StatusBadge>
      </Surface>

      {state.kind === "loading" && (
        <Surface className="responsibility-queue-state">正在加载待判责返工单…</Surface>
      )}
      {state.kind === "unavailable" && (
        <Surface className="responsibility-queue-state">{state.message}</Surface>
      )}
      {state.kind === "ready" && items.length === 0 && (
        <Surface className="responsibility-queue-state">
          当前没有你可处理或可接管的待判责返工单。
        </Surface>
      )}
      {state.kind === "ready" && items.length > 0 && (
        <div className="task-grid responsibility-queue-grid">
          {items.map((item) => {
            const title = item.highMultiplierPending
              ? "高倍率待独立确认"
              : item.determinationStage === "draft"
                ? `责任草稿 V${item.determinationVersion}`
                : "待创建责任草稿";
            const permission = item.canDetermine
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
            const tone = item.highMultiplierPending
              ? "danger"
              : item.canDetermine || item.canTakeover
                ? "warning"
                : "info";
            const stateLabel = item.highMultiplierPending
              ? "待独立确认"
              : item.canDetermine
                ? "待处理"
                : item.canTakeover
                  ? "可接管"
                  : "仅查看";
            return (
              <a
                className="responsibility-task-link"
                href={`${basePath}/ui/tasks/${item.reworkOrderId}`}
                key={item.reworkOrderId}
              >
                <TaskCard
                  task={{
                    id: item.reworkNo ?? "返工单",
                    title,
                    meta,
                    tone,
                    stateLabel,
                  }}
                />
                <span>打开责任判定 →</span>
              </a>
            );
          })}
        </div>
      )}
    </Shell>
  );
}
