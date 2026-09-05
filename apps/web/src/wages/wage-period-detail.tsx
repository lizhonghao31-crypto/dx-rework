import {
  WagePeriodDetailSchema,
  type WagePeriodDetail,
} from "@dx-rework/contracts/wages";
import { formatBusinessCurrency, formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { Button, Surface } from "@dx-rework/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import { createWebUrls } from "../../url-contract.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const responseError = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? "工资操作失败";
  } catch {
    return "工资操作失败";
  }
};

export function WagePeriodDetailPage({ periodId }: { periodId: string }) {
  const [detail, setDetail] = useState<WagePeriodDetail | null>(null);
  const [message, setMessage] = useState("");
  const refreshing = useRef(false);
  const mounted = useRef(true);

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

  if (!detail) {
    return (
      <div className="wage-page">
        <header className="page-heading"><div><h1>工资详情</h1></div></header>
        <Surface><p>{message || "正在加载工资月份…"}</p></Surface>
      </div>
    );
  }

  const { period, items } = detail;
  return (
    <div className="wage-page">
      <header className="page-heading">
        <div>
          <h1>返工工资对数明细</h1>
          <p>工资期间：{period.periodMonth.slice(0, 7)}</p>
        </div>
      </header>

      <Surface className="wage-summary">
        <dl>
          <dt>工人 / 明细</dt><dd>{formatBusinessDecimal(period.personCount)} / {formatBusinessDecimal(period.sourceItemCount)}</dd>
          <dt>工资总额</dt><dd><strong>{formatBusinessCurrency(period.totalAmount)}</strong></dd>
        </dl>
        <div className="wage-actions">
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

    </div>
  );
}
