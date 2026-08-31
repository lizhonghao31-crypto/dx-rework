import {
  WagePeriodDetailSchema,
  type WagePeriod,
  type WagePeriodDetail,
} from "@dx-rework/contracts/wages";
import { formatBusinessCurrency, formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import { createWebUrls } from "../../url-contract.js";
import { createClientRequestId } from "../client-request-id.js";
import { confirmInApp } from "../system-dialog.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const WAGE_MONTH_CLOSE_ENABLED: boolean = false;

const responseError = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? "工资操作失败";
  } catch {
    return "工资操作失败";
  }
};

const formatBusinessTime = (value: string | null): string => {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
};

export function WagePeriodDetailPage({ periodId }: { periodId: string }) {
  const [detail, setDetail] = useState<WagePeriodDetail | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const refreshing = useRef(false);
  const mounted = useRef(true);
  const pendingMutationKeys = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const response = await fetch(apiUrl(`wage-periods/${periodId}`), {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(await responseError(response));
      const nextDetail = WagePeriodDetailSchema.parse(await response.json());
      if (mounted.current) setDetail(nextDetail);
    } catch (error: unknown) {
      if (mounted.current) setMessage(error instanceof Error ? error.message : "工资详情加载失败");
    } finally {
      refreshing.current = false;
    }
  }, [periodId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  const lockPeriod = async (period: WagePeriod): Promise<void> => {
    if (busy) return;
    if (!(await confirmInApp("确认锁定本月工资？锁定后本月工资不可修改。"))) return;
    const path = `wage-periods/${period.periodId}/lock`;
    const body = { expectedVersion: period.periodVersion, lockNote: null };
    const signature = `${path}:${JSON.stringify(body)}`;
    const idempotencyKey = pendingMutationKeys.current[signature] ?? createClientRequestId();
    pendingMutationKeys.current[signature] = idempotencyKey;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(apiUrl(path), {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await responseError(response));
      delete pendingMutationKeys.current[signature];
      await load();
      setMessage("工资月份已锁定。");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "工资操作失败");
    } finally {
      setBusy(false);
    }
  };

  if (!detail) {
    return (
      <div className="wage-page">
        <header className="page-heading"><div><h1>工资详情</h1></div></header>
        <Surface><p>{message || "正在加载工资月份…"}</p></Surface>
      </div>
    );
  }

  const { period, items } = detail;
  const statusLabel = period.status === "locked" ? "已月结" : "可月结";

  return (
    <div className="wage-page">
      <header className="page-heading">
        <div>
          <h1>返工工资对数明细</h1>
          <p>工资期间：{period.periodMonth.slice(0, 7)}</p>
        </div>
        {WAGE_MONTH_CLOSE_ENABLED ? <StatusBadge tone={period.status === "locked" ? "success" : "info"}>{statusLabel}</StatusBadge> : null}
      </header>

      <Surface className="wage-summary">
        <dl>
          <dt>工人 / 明细</dt><dd>{period.personCount} / {period.sourceItemCount}</dd>
          <dt>工资总额</dt><dd><strong>{formatBusinessCurrency(period.totalAmount)}</strong></dd>
        </dl>
        <div className="wage-actions">
          {WAGE_MONTH_CLOSE_ENABLED && period.canLock ? (
            <Button variant="primary" disabled={busy} onClick={() => void lockPeriod(period)}>月结锁定</Button>
          ) : null}
          {period.canExport ? (
            <a href={apiUrl(`wage-periods/${period.periodId}/export.xlsx`)} download className="wage-export-link">
              <Button>导出 Excel</Button>
            </a>
          ) : null}
        </div>
      </Surface>

      {message && <p role="status" className="form-message">{message}</p>}

      <section className="wage-grid">
        {items.map((item) => (
          <Surface key={item.wageItemId} className="wage-item-card">
            <h2>{item.personNameSnapshot} · 应付 {formatBusinessCurrency(item.payableAmount)}</h2>
            <p>{item.supplierNameSnapshot} · {item.personTypeSnapshot === "temporary" ? "临时工" : "正式工"} · {item.reworkNoSnapshot} · {item.styleNoSnapshot}</p>
            <p>{item.processNameSnapshot} · {formatBusinessDecimal(item.actualQuantitySnapshot)} {item.pricingUnitSnapshot === "piece" ? "件" : "小时"} · 基础单价 {formatBusinessCurrency(item.unitPriceSnapshot)}</p>
            <p>工资系数 ×{formatBusinessDecimal(item.temporaryWageMultiplier, 3)} · 应付金额 {formatBusinessCurrency(item.payableAmount)}</p>
            <p>{item.assignmentMode === "collective" ? "集体计件" : "个人计件"} · 组总额 {formatBusinessCurrency(item.groupAmount)}</p>
            <details className="wage-calculation-detail">
              <summary>查看分摊计算</summary>
              <p>个人分摊原值 {formatBusinessDecimal(item.exactPersonShare, 4)} · 尾差顺序 {item.remainderRank}/{item.memberCount}</p>
            </details>
          </Surface>
        ))}
      </section>

      {WAGE_MONTH_CLOSE_ENABLED ? <Surface>
        <h2>月结状态</h2>
        {period.lockedAt
          ? <p>已月结，锁定时间：{formatBusinessTime(period.lockedAt)}</p>
          : <p>工资已经汇总，可在自然月结束后直接月结锁定。</p>}
      </Surface> : null}
    </div>
  );
}
