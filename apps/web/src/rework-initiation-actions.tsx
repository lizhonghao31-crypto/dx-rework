import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { useState } from "react";
import { createWebUrls } from "../url-contract.js";
import { createClientRequestId } from "./client-request-id.js";
import { promptInApp } from "./system-dialog.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

export function InitiationFollowUpActions({
  detail,
  canHandleInitiation,
  ownershipNotice,
  statusLabel,
  onChanged,
}: {
  detail: Readonly<{ reworkOrderId: string; status: string; version: number }>;
  canHandleInitiation: boolean;
  ownershipNotice?: string | undefined;
  statusLabel: string;
  onChanged: () => void | Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [busyAction, setBusyAction] = useState<"withdraw" | "cancel" | null>(null);
  const canWithdraw = detail.status === "pending_process_configuration";
  const canCancel = detail.status === "pending_process_configuration";

  const transition = async (action: "withdraw" | "cancel") => {
    if (!canHandleInitiation || busyAction !== null) return;
    const promptText = action === "withdraw" ? "请输入撤回原因" : "请输入取消原因";
    const reason = await promptInApp(promptText);
    if (!reason?.trim()) return;
    setBusyAction(action);
    try {
      const response = await fetch(apiUrl(`rework-orders/${detail.reworkOrderId}/${action}`), {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": createClientRequestId(),
        },
        body: JSON.stringify({ expectedVersion: detail.version, reason: reason.trim() }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? "状态变更失败");
      }
      setMessage(action === "withdraw" ? "已撤回为草稿，可在本节点继续修改后再次提交。" : "返工单已取消，历史记录继续保留。");
      await onChanged();
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "状态变更失败");
    } finally {
      setBusyAction(null);
    }
  };

  return <Surface className="rework-detail-node-preview rework-detail-initiation-actions">
    <StatusBadge tone={detail.status === "cancelled" ? "danger" : "info"}>{statusLabel}</StatusBadge>
    <h2>01 · 发起返工</h2>
    <p>{detail.status === "cancelled"
      ? "该返工单已取消，历史资料和操作记录继续保留。"
      : "提交后的撤回、取消及撤回后的再次提交，统一在订单详情的本节点处理。"}</p>
    {(canHandleInitiation || ownershipNotice) && (canWithdraw || canCancel) ? (
      <div className="rework-detail-initiation-actions__buttons">
        {canWithdraw ? <Button disabled={!canHandleInitiation || busyAction !== null} onClick={() => void transition("withdraw")}>{busyAction === "withdraw" ? "撤回中…" : "撤回修改"}</Button> : null}
        {canCancel ? <Button disabled={!canHandleInitiation || busyAction !== null} onClick={() => void transition("cancel")}>{busyAction === "cancel" ? "取消中…" : "取消返工单"}</Button> : null}
      </div>
    ) : null}
    {!canHandleInitiation && ownershipNotice ? <p role="status">{ownershipNotice}</p> : null}
    {message ? <p role="status">{message}</p> : null}
  </Surface>;
}

