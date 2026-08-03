import { WagePeriodSchema, type WagePeriod } from "@dx-rework/contracts/wages";
import { StatusBadge, Surface } from "@dx-rework/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { createWebUrls } from "../../url-contract.js";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
const PeriodListSchema = z.array(WagePeriodSchema);

const statusLabel: Record<WagePeriod["status"], string> = {
  pending_tail_review: "待李同生初核",
  pending_admin_review: "待梁少萍复核",
  ready_to_lock: "待欧阳俊珺月结",
  locked: "已锁定",
};

export function WagePeriodList() {
  const [periods, setPeriods] = useState<WagePeriod[]>([]);
  const [message, setMessage] = useState("");
  const busy = useRef(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const response = await fetch(apiUrl("wage-periods"), {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error("工资月份加载失败");
      const rows = PeriodListSchema.parse(await response.json());
      if (mounted.current) {
        setPeriods(rows);
        setMessage("");
      }
    } catch (error: unknown) {
      if (mounted.current) {
        setMessage(error instanceof Error ? error.message : "工资月份加载失败");
      }
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [load]);

  return (
    <main className="wage-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">N10-A · 工资核对与月结</p>
          <h1>返工工资月份</h1>
        </div>
        <StatusBadge tone="info">15 秒自动刷新</StatusBadge>
      </header>
      {message && <p role="alert" className="form-message">{message}</p>}
      <div className="wage-grid">
        {periods.map((period) => (
          <Surface key={period.periodId} className="wage-period-card">
            <div className="wage-period-card__heading">
              <a href={pageUrl(`ui/wages/${period.periodId}`)}>
                <strong>{period.periodMonth.slice(0, 7)}</strong>
              </a>
              <StatusBadge tone={period.status === "locked" ? "success" : "info"}>
                {statusLabel[period.status]}
              </StatusBadge>
            </div>
            <dl>
              <dt>工人 / 明细</dt>
              <dd>{period.personCount} / {period.sourceItemCount}</dd>
              <dt>原始金额</dt>
              <dd>¥{period.originalTotal}</dd>
              <dt>调整金额</dt>
              <dd>¥{period.adjustmentTotal}</dd>
              <dt>最终金额</dt>
              <dd><strong>¥{period.finalTotal}</strong></dd>
            </dl>
          </Surface>
        ))}
      </div>
      {periods.length === 0 && !message && (
        <Surface><p>暂无已通过整单审核的工资来源。</p></Surface>
      )}
    </main>
  );
}
