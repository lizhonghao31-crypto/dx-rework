import { useRef, useState } from "react";
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
  return <><button type="button" className="reporting-order-delete" aria-label={`删除订单 ${label}`} title={busy ? "删除中…" : "删除订单"} disabled={disabled || busy} onClick={() => void remove()}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M9 7l1-2h4l1 2m-9 0 1 13h10l1-13" /></svg>
  </button>{error && <p className="pattern-delete-error" role="alert">{error}</p>}</>;
}
