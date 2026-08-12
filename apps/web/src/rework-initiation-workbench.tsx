import {
  ReworkOrderResponseSchema,
  type ReworkOrderResponse,
} from "@dx-rework/contracts";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { useCallback, useEffect, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { ReworkInitiationForm } from "./rework-form.js";
import "./rework-workbench.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

type LoadState = "loading" | "ready" | "error";

const editableStatuses = new Set<ReworkOrderResponse["status"]>([
  "draft",
  "pending_process_configuration",
  "cancelled",
]);

const statusLabel = (status: ReworkOrderResponse["status"]): string => {
  if (status === "draft") return "草稿";
  if (status === "pending_process_configuration") return "待配置工序";
  if (status === "cancelled") return "已取消";
  return "已进入后续流程";
};

const statusTone = (status: ReworkOrderResponse["status"]): "info" | "success" | "danger" => {
  if (status === "pending_process_configuration") return "success";
  if (status === "cancelled") return "danger";
  return "info";
};

const parseList = (value: unknown): ReworkOrderResponse[] => {
  if (!Array.isArray(value)) throw new Error("返工单列表格式无效");
  return value.map((item) => ReworkOrderResponseSchema.parse(item));
};

const errorMessage = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? "返工单列表加载失败";
  } catch {
    return "返工单列表加载失败";
  }
};

export function ReworkInitiationWorkbench() {
  const initialOrderId = new URLSearchParams(window.location.search).get("draft");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(initialOrderId);
  const [newFormVersion, setNewFormVersion] = useState(0);
  const [orders, setOrders] = useState<ReworkOrderResponse[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadMessage, setLoadMessage] = useState("正在读取已发起返工单…");

  const loadOrders = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(apiUrl("rework-orders"), {
        credentials: "include",
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: signal ?? null,
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const next = parseList(await response.json())
        .filter((item) => editableStatuses.has(item.status));
      setOrders(next);
      setLoadState("ready");
      setLoadMessage(next.length ? "" : "当前还没有草稿或待配置工序的返工单。");
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadState("error");
      setLoadMessage(error instanceof Error ? error.message : "返工单列表加载失败");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadOrders(controller.signal);
    return () => controller.abort();
  }, [loadOrders]);

  const setDraftQuery = (orderId: string | null) => {
    const url = new URL(window.location.href);
    if (orderId) url.searchParams.set("draft", orderId);
    else url.searchParams.delete("draft");
    window.history.replaceState({}, "", url);
  };

  const openOrder = (orderId: string) => {
    setDraftQuery(orderId);
    setSelectedOrderId(orderId);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const newOrder = () => {
    setDraftQuery(null);
    setSelectedOrderId(null);
    setNewFormVersion((value) => value + 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <>
      <div className="rework-order-switcher">
        <Surface>
          <div className="rework-order-switcher__header">
            <div>
              <h2>我的返工单</h2>
              <p>可同时维护多张返工单；点击任意记录继续查看、撤回或修改。</p>
            </div>
            <Button variant="primary" onClick={newOrder}>新建返工</Button>
          </div>

          {loadState === "loading" && <p>正在读取已发起返工单…</p>}
          {loadMessage && <p className={loadState === "error" ? "rework-order-switcher__error" : undefined}>{loadMessage}</p>}

          {orders.length > 0 && (
            <div className="rework-order-switcher__list">
              {orders.map((item) => (
                <button
                  type="button"
                  className={`rework-order-switcher__item${selectedOrderId === item.reworkOrderId ? " is-active" : ""}`}
                  key={item.reworkOrderId}
                  onClick={() => openOrder(item.reworkOrderId)}
                >
                  <span className="rework-order-switcher__item-main">
                    <b>{item.reworkNo ?? "未提交草稿"}</b>
                    <small>
                      {[item.styleNo ?? "款号未填", item.orderNo ?? "订单号未填", item.problemPart ?? "问题部位未填"].join(" · ")}
                    </small>
                  </span>
                  <StatusBadge tone={statusTone(item.status)}>{statusLabel(item.status)}</StatusBadge>
                </button>
              ))}
            </div>
          )}

          <div className="rework-order-switcher__footer">
            <Button onClick={() => void loadOrders()}>刷新列表</Button>
          </div>
        </Surface>
      </div>

      <ReworkInitiationForm
        key={selectedOrderId ? `order:${selectedOrderId}` : `new:${newFormVersion}`}
      />
    </>
  );
}
