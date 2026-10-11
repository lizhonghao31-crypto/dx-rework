import { useState, type ReactElement } from "react";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { createWebUrls } from "../url-contract.js";
import { createClientRequestId } from "./client-request-id.js";
import "./work-reporting-form.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
export type IePrecountEntry = Readonly<{
  configurationItemId: string;
  quantity: number;
  note: string | null;
  recordedBy: string;
  recordedAt: string;
}>;
export type IePrecountOverview = Readonly<{
  canRecord?: boolean;
  entries: readonly IePrecountEntry[];
}>;

const requestNoContent = async (path: string, init?: RequestInit): Promise<void> => {
  const response = await fetch(apiUrl(path), {
    credentials: "include", ...init,
    headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? "请求未完成，请稍后重试");
  }
};


const formatIePrecountTime = (value: string): string =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));

export function IePrecountCell({
  reworkOrderId,
  configurationItemId,
  processName,
  overview,
  onChanged,
}: Readonly<{
  reworkOrderId: string;
  configurationItemId: string;
  processName: string;
  overview: IePrecountOverview;
  onChanged?: () => Promise<void> | void;
}>): ReactElement {
  const [editing, setEditing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const latest = overview.entries.find((entry) =>
    entry.configurationItemId === configurationItemId);

  const record = async (): Promise<void> => {
    if (!overview.canRecord || busy) return;
    const parsedQuantity = Number(quantity);
    if (!Number.isInteger(parsedQuantity) || parsedQuantity < 1) {
      setMessage("数量必须是大于0的整数");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await requestNoContent(`rework-orders/${reworkOrderId}/ie-precounts`, {
        method: "POST",
        headers: { "idempotency-key": createClientRequestId() },
        body: JSON.stringify({
          configurationItemId,
          quantity: parsedQuantity,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      setQuantity("");
      setNote("");
      setEditing(false);
      setMessage("已记录");
      await onChanged?.();
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "记录失败");
    } finally {
      setBusy(false);
    }
  };

  return <div className={`n04-progress-ie-precount${editing ? " is-editing" : ""}`}>
    {overview.canRecord && !editing
      ? <button type="button" className="n04-ie-precount-button" onClick={() => { setEditing(true); setMessage(""); }}>IE预核</button>
      : null}
    {latest && !editing
      ? <button type="button" className="n04-ie-precount-latest" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>{formatBusinessDecimal(latest.quantity)}件</button>
      : null}
    {editing && overview.canRecord ? <form className="n04-ie-precount-editor" onSubmit={(event) => { event.preventDefault(); void record(); }}>
      <input aria-label={`${processName}预核数量`} autoFocus inputMode="numeric" min="1" step="1" type="number" placeholder="数量" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
      <input aria-label={`${processName}预核备注`} maxLength={200} placeholder="备注（选填）" value={note} onChange={(event) => setNote(event.target.value)} />
      <button type="submit" className="n04-ie-precount-confirm" disabled={busy}>{busy ? "确认中…" : "确认"}</button>
      <button type="button" className="n04-ie-precount-cancel" disabled={busy} onClick={() => { setEditing(false); setQuantity(""); setNote(""); setMessage(""); }}>取消</button>
    </form> : null}
    {latest && detailsOpen && !editing ? <small className="n04-ie-precount-detail">{latest.recordedBy} · {formatIePrecountTime(latest.recordedAt)}{latest.note ? ` · ${latest.note}` : ""}</small> : null}
    {message ? <small className="n04-ie-precount-message" role="status">{message}</small> : null}
  </div>;
}


