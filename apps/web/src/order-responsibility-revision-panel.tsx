import { useEffect, useState } from "react";
import type { OrderResponsibilityRevision } from "@dx-rework/contracts";
import { fixedBusinessCurrency as formatBusinessCurrency } from "./fixed-business-currency.js";
import { Button, Surface } from "@dx-rework/ui";
import { createWebUrls } from "../url-contract.js";
import { createClientRequestId } from "./client-request-id.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const time = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

type ExternalRevisionAvailability = Readonly<{
  cases?: readonly Readonly<{ canRequestRevision?: boolean }>[];
}> | null;

export const hasLowerExternalRevisionAction = (value: ExternalRevisionAvailability): boolean =>
  value?.cases?.some((item) => item.canRequestRevision === true) ?? false;

export function OrderResponsibilityRevisionPanel({
  orderId,
  orderVersion,
  onChanged,
  readOnly = false,
}: {
  readOnly?: boolean;
  orderId: string;
  orderVersion: number;
  onChanged: () => Promise<void>;
}) {
  const [value, setValue] = useState<OrderResponsibilityRevision | null>(null);
  const [lowerRevisionAvailable, setLowerRevisionAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const url = apiUrl(`rework-orders/${orderId}/responsibility-revisions`);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setLowerRevisionAvailable(null);
    const revision = fetch(url, { credentials: "include", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("责任历史暂时无法读取，请刷新重试");
      return await response.json() as OrderResponsibilityRevision;
    });
    const lowerAction = fetch(apiUrl(`rework-orders/${orderId}/external-responsibilities`), {
      credentials: "include",
      signal: controller.signal,
      headers: { accept: "application/json" },
    }).then(async (response) => {
      if (!response.ok) return false;
      return hasLowerExternalRevisionAction(await response.json() as ExternalRevisionAvailability);
    }).catch(() => false);
    void Promise.all([revision, lowerAction]).then(([nextValue, hasLowerAction]) => {
      if (controller.signal.aborted) return;
      setValue(nextValue);
      setLowerRevisionAvailable(hasLowerAction);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "责任历史读取失败");
    });
    return () => controller.abort();
  }, [url, orderId, orderVersion]);

  const reopen = async () => {
    if (!value?.currentVersion || !reason.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "idempotency-key": createClientRequestId() },
        body: JSON.stringify({
          expectedOrderVersion: value.orderVersion,
          expectedDeterminationVersion: value.currentVersion,
          reason: reason.trim(),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "重新判责失败");
      setValue(body as OrderResponsibilityRevision);
      setOpen(false);
      setReason("");
      await onChanged();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "重新判责失败");
    } finally {
      setBusy(false);
    }
  };

  if (!value?.currentVersion && !error) return null;
  const canDirectReopen = !readOnly && value?.canReopen === true && lowerRevisionAvailable === false;

  return <Surface className="rework-responsibility-result rework-responsibility-result--compact">
    {canDirectReopen ? <div className="rework-responsibility-result__actions">
      <Button onClick={() => setOpen(!open)}>重新判责</Button>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
    {open ? <form onSubmit={(event) => { event.preventDefault(); void reopen(); }} className="rework-responsibility-result__form">
      <label>重判原因<textarea required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <p>回到责任判定，由原处理人调整后提交老板确认。原工资与已扣款记录保留，新责任继续处理剩余金额。</p>
      <Button type="submit" disabled={busy || !reason.trim()}>{busy ? "正在创建新责任版本…" : "确认重新判责"}</Button>
      <Button type="button" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
    </form> : null}
    {(value?.history.length ?? 0) > 0 ? <details>
      <summary>责任历史 · {value!.history.length} 个版本</summary>
      {value!.revisions.map((row) => <p key={row.id}>{time(row.at)} · {row.actor ?? "未记录"} 发起重判：{row.reason}</p>)}
      {value!.history.map((row) => <div className="rework-responsibility-result__version" key={row.id}>
        <b>V{row.version} · {row.stage === "draft" ? "草稿" : "定稿"}</b>
        <span>{time(row.at)} · {row.actor ?? "未记录"} · 本厂 {formatBusinessCurrency(row.ownAmount)} / 外厂 {formatBusinessCurrency(row.externalAmount)}</span>
        {row.reason ? <span>原因：{row.reason}</span> : null}
        {row.signature ? <span>老板{row.signature.decision === "approved" ? "确认" : "驳回"}：{row.signature.actor ?? "未记录"} · {time(row.signature.at)}</span> : null}
      </div>)}
    </details> : null}
  </Surface>;
}
