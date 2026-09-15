import { useRef, useState } from "react";
import { Button } from "@dx-rework/ui";
import { DeletePatternOrderResponseSchema } from "@dx-rework/contracts/pattern-orders";
import { confirmInApp } from "./system-dialog.js";
import { createClientRequestId } from "./client-request-id.js";
import { patternRequest } from "./pattern-order-client.js";

export function PatternOrderDelete({ orderId, version, label, disabled = false, onDeleted, onBusy }: { orderId: string; version: number; label: string; disabled?: boolean; onDeleted(): void; onBusy?(busy: boolean): void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const attempt = useRef<{ version: number; key: string } | null>(null);
  const remove = async () => {
    if (busy || disabled || !(await confirmInApp(`确认删除订单 ${label}？删除后将从看板和工资查询中移除。`))) return;
    if (attempt.current?.version !== version) attempt.current = { version, key: createClientRequestId() };
    setBusy(true); onBusy?.(true); setError("");
    try {
      await patternRequest(`orders/${orderId}/delete`, DeletePatternOrderResponseSchema, { method: "POST", body: JSON.stringify({ version }), headers: { "idempotency-key": attempt.current.key } });
      onDeleted();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "删除失败，请重试"); }
    finally { setBusy(false); onBusy?.(false); }
  };
  return <div className="pattern-delete"><Button type="button" className="pattern-delete-button" disabled={disabled || busy} onClick={() => void remove()}>{busy ? "删除中…" : "删除订单"}</Button>{error && <p role="alert">{error}</p>}</div>;
}
