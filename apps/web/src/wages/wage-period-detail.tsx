import {
  WagePeriodDetailSchema,
  WagePeriodSchema,
  type WageAdjustment,
  type WagePeriod,
  type WagePeriodDetail,
} from "@dx-rework/contracts/wages";
import { formatBusinessDecimal, formatBusinessMoney } from "@dx-rework/contracts/business-display";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { createWebUrls } from "../../url-contract.js";
import { WageAdjustmentForm } from "./wage-adjustment-form.js";
import { confirmInApp, promptInApp } from "../system-dialog.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const PeriodListSchema = z.array(WagePeriodSchema);

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

const adjustmentStatusLabel = (status: WageAdjustment["status"]): string =>
  status === "pending" ? "待审批" : status === "approved" ? "已批准" : "已拒绝";

const reviewStageLabel = (stage: WagePeriodDetail["reviewActions"][number]["stage"]): string =>
  stage === "tail" ? "尾部主管初核" : "行政复核";

const reviewDecisionLabel = (decision: WagePeriodDetail["reviewActions"][number]["decision"]): string =>
  decision === "approved" ? "通过" : "退回";

export function WagePeriodDetailPage({ periodId }: { periodId: string }) {
  const [detail, setDetail] = useState<WagePeriodDetail | null>(null);
  const [periods, setPeriods] = useState<WagePeriod[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [adjustmentItemId, setAdjustmentItemId] = useState<string | null>(null);
  const refreshing = useRef(false);
  const mounted = useRef(true);
  const pendingMutationKeys = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const [detailResponse, periodResponse] = await Promise.all([
        fetch(apiUrl(`wage-periods/${periodId}`), {
          credentials: "include",
          headers: { accept: "application/json" },
        }),
        fetch(apiUrl("wage-periods"), {
          credentials: "include",
          headers: { accept: "application/json" },
        }),
      ]);
      if (!detailResponse.ok) throw new Error(await responseError(detailResponse));
      if (!periodResponse.ok) throw new Error(await responseError(periodResponse));
      const nextDetail = WagePeriodDetailSchema.parse(await detailResponse.json());
      const nextPeriods = PeriodListSchema.parse(await periodResponse.json());
      if (mounted.current) {
        setDetail(nextDetail);
        setPeriods(nextPeriods);
      }
    } catch (error: unknown) {
      if (mounted.current) {
        setMessage(error instanceof Error ? error.message : "工资详情加载失败");
      }
    } finally {
      refreshing.current = false;
    }
  }, [periodId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const command = async (
    path: string,
    body: unknown,
    success: string,
  ): Promise<void> => {
    if (busy) return;
    const signature = `${path}:${JSON.stringify(body)}`;
    const idempotencyKey = pendingMutationKeys.current[signature] ?? crypto.randomUUID();
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
      setMessage(success);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "工资操作失败");
    } finally {
      setBusy(false);
    }
  };

  const decideAdjustment = async (
    adjustment: WageAdjustment,
    approved: boolean,
  ): Promise<void> => {
    const reason = approved
      ? null
      : (await promptInApp("请输入拒绝原因"))?.trim() ?? "";
    if (!approved && !reason) return;
    await command(
      `wage-adjustments/${adjustment.adjustmentId}/${approved ? "approve" : "reject"}`,
      { expectedVersion: adjustment.version, reason },
      approved ? "工资调整已批准，月份已重新进入尾部主管初核。" : "工资调整已拒绝。",
    );
  };

  const returnToTailSupervisor = async (period: WagePeriod): Promise<void> => {
    const reason = (await promptInApp("请输入退回尾部主管的原因"))?.trim();
    if (!reason) return;
    await command(
      `wage-periods/${period.periodId}/administrative-return`,
      { expectedVersion: period.periodVersion, reason },
      "工资月份已退回尾部主管重新初核。",
    );
  };

  const lockPeriod = async (period: WagePeriod): Promise<void> => {
    if (!(await confirmInApp("确认锁定本月工资？锁定后本月不能直接修改，只能在后续未锁定月份生成调整。"))) return;
    await command(
      `wage-periods/${period.periodId}/lock`,
      { expectedVersion: period.periodVersion, lockNote: null },
      "工资月份已锁定。",
    );
  };

  if (!detail) {
    return (
      <div className="wage-page">
        <header className="page-heading"><div><h1>工资详情</h1></div></header>
        <Surface><p>{message || "正在加载工资明细…"}</p></Surface>
      </div>
    );
  }
  const { period, items, adjustments, reviewActions } = detail;
  const statusLabel = period.status === "pending_tail_review"
    ? "待尾部初核"
    : period.status === "pending_admin_review"
      ? "待行政复核"
      : period.status === "ready_to_lock"
        ? "待月结"
        : "已锁定";

  return (
    <div className="wage-page">
      <header className="page-heading">
        <div>
          <h1>返工工资核对</h1>
          <p>工资期间：{period.periodMonth.slice(0, 7)}</p>
        </div>
        <StatusBadge tone={period.status === "locked" ? "success" : "info"}>
          {statusLabel}
        </StatusBadge>
      </header>

      <Surface className="wage-summary">
        <dl>
          <dt>工人 / 明细</dt><dd>{period.personCount} / {period.sourceItemCount}</dd>
          <dt>原始金额</dt><dd>¥{period.originalTotal}</dd>
          <dt>调整金额</dt><dd>¥{period.adjustmentTotal}</dd>
          <dt>最终金额</dt><dd><strong>¥{period.finalTotal}</strong></dd>
        </dl>
        <div className="wage-actions">
          {period.canTailReview && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void command(
                `wage-periods/${period.periodId}/tail-approve`,
                { expectedVersion: period.periodVersion },
                "尾部主管初核已完成，现进入行政复核。",
              )}
            >初核通过</Button>
          )}
          {period.canAdministrativeReview && (
            <>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void command(
                  `wage-periods/${period.periodId}/administrative-approve`,
                  { expectedVersion: period.periodVersion },
                  "行政复核已完成，月份已具备月结条件。",
                )}
              >复核通过</Button>
              <Button
                disabled={busy}
                onClick={() => void returnToTailSupervisor(period)}
              >退回</Button>
            </>
          )}
          {period.canLock && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void lockPeriod(period)}
            >月结锁定</Button>
          )}
          {period.canExport && (
            <a
              href={apiUrl(`wage-periods/${period.periodId}/export.xlsx`)}
              download
              className="wage-export-link"
            >
              <Button>导出 Excel</Button>
            </a>
          )}
        </div>
      </Surface>

      {message && <p role="status" className="form-message">{message}</p>}

      <section className="wage-grid">
        {items.map((item) => (
          <Surface key={item.wageItemId} className="wage-item-card">
            <h2>{item.personNameSnapshot} · 实际应付 ¥{formatBusinessMoney(item.actualPayableAmount)}</h2>
            <p>{item.supplierNameSnapshot} · {item.personTypeSnapshot === "temporary" ? "临时工" : "正式工"} · {item.reworkNoSnapshot} · {item.styleNoSnapshot}</p>
            <p>{item.processNameSnapshot} · {formatBusinessDecimal(item.actualQuantitySnapshot)} {item.pricingUnitSnapshot === "piece" ? "件" : "小时"} · 基础单价 ¥{formatBusinessDecimal(item.unitPriceSnapshot)}</p>
            <p>工资系数 ×{formatBusinessDecimal(item.temporaryWageMultiplier)} · 原始金额 ¥{formatBusinessMoney(item.payableAmount)} · 调整 ¥{formatBusinessMoney(item.adjustmentAmount)}</p>
            <p>{item.assignmentMode === "collective" ? "集体计件" : "个人计件"} · 组总额 ¥{formatBusinessMoney(item.groupAmount)}</p>
            <details className="wage-calculation-detail">
              <summary>查看分摊计算</summary>
              <p>个人分摊原值 {formatBusinessDecimal(item.exactPersonShare, 4)} · 尾差顺序 {item.remainderRank}/{item.memberCount}</p>
            </details>
            {period.canRequestAdjustment && (
              <>
                <Button
                  disabled={busy}
                  onClick={() => setAdjustmentItemId((current) =>
                    current === item.wageItemId ? null : item.wageItemId)}
                >
                  {adjustmentItemId === item.wageItemId ? "收起工资调整" : "发起工资调整"}
                </Button>
                {adjustmentItemId === item.wageItemId ? (
                  <WageAdjustmentForm
                    item={item}
                    sourcePeriod={period}
                    periods={periods}
                    disabled={busy}
                    onCompleted={async (success) => {
                      setAdjustmentItemId(null);
                      await load();
                      setMessage(success);
                    }}
                  />
                ) : null}
              </>
            )}
          </Surface>
        ))}
      </section>

      <Surface>
        <h2>工资调整</h2>
        {adjustments.length === 0 && <p>暂无调整记录。</p>}
        {adjustments.map((adjustment) => (
          <div key={adjustment.adjustmentId} className="wage-history-row">
            <span>{formatBusinessMoney(adjustment.adjustmentAmount)} 元 · {adjustment.reason}</span>
            <StatusBadge tone={adjustment.status === "approved" ? "success" : adjustment.status === "rejected" ? "danger" : "warning"}>
              {adjustmentStatusLabel(adjustment.status)}
            </StatusBadge>
            {adjustment.status === "pending" && period.canApproveAdjustment && (
              <span className="wage-actions">
                <Button disabled={busy} onClick={() => void decideAdjustment(adjustment, true)}>批准</Button>
                <Button disabled={busy} onClick={() => void decideAdjustment(adjustment, false)}>拒绝</Button>
              </span>
            )}
          </div>
        ))}
      </Surface>

      <Surface>
        <h2>核对历史</h2>
        {reviewActions.length === 0 && <p>尚未开始核对。</p>}
        {reviewActions.map((action) => (
          <p key={action.reviewActionId}>
            {formatBusinessTime(action.actedAt)} · {reviewStageLabel(action.stage)} · {reviewDecisionLabel(action.decision)}
            {action.reason ? ` · ${action.reason}` : ""}
          </p>
        ))}
        {period.lockedAt && <p>锁定时间：{formatBusinessTime(period.lockedAt)}</p>}
      </Surface>
    </div>
  );
}
