import type { WageItem, WagePeriod } from "@dx-rework/contracts/wages";
import { Button, InsetField, Surface } from "@dx-rework/ui";
import { useMemo, useState } from "react";

import { createWebUrls } from "../../url-contract.js";
import { ExternalEvidenceUploader } from "../external-evidence-uploader.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

export function WageAdjustmentForm({
  item,
  sourcePeriod,
  periods,
  disabled,
  onCompleted,
}: {
  item: WageItem;
  sourcePeriod: WagePeriod;
  periods: readonly WagePeriod[];
  disabled: boolean;
  onCompleted(message: string): Promise<void>;
}) {
  const targets = useMemo(
    () => periods.filter((period) =>
      period.status !== "locked"
      && (sourcePeriod.status === "locked"
        ? period.periodMonth > sourcePeriod.periodMonth
        : period.periodId === sourcePeriod.periodId),
    ),
    [periods, sourcePeriod],
  );
  const [targetPeriodId, setTargetPeriodId] = useState(
    targets[0]?.periodId ?? "",
  );
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const target = targets.find((period) => period.periodId === targetPeriodId);
    if (!target || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(apiUrl("wage-adjustments"), {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          originalWageItemId: item.wageItemId,
          targetPeriodId,
          adjustmentAmount: amount,
          reason,
          attachmentIds,
          expectedVersion: target.periodVersion,
        }),
      });
      if (!response.ok) {
        const body = await response.json() as { error?: { message?: string } };
        throw new Error(body.error?.message ?? "工资调整提交失败");
      }
      setAmount("");
      setReason("");
      setAttachmentIds([]);
      await onCompleted("工资调整已提交，等待梁少萍复核。");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "工资调整提交失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Surface className="wage-adjustment-form">
      <h3>发起工资调整</h3>
      <p>{item.personNameSnapshot} · {item.processNameSnapshot} · 原金额 ¥{item.payableAmount}</p>
      {targets.length > 0 ? (
        <>
          <label className="dx-field">
            <span>计入工资月份</span>
            <span className="dx-field__control">
              <select
                value={targetPeriodId}
                disabled={disabled || busy}
                onChange={(event) => setTargetPeriodId(event.target.value)}
              >
                {targets.map((period) => (
                  <option value={period.periodId} key={period.periodId}>
                    {period.periodMonth.slice(0, 7)}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <InsetField
            label="有符号调整金额"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            suffix="元"
          />
          <InsetField
            label="调整原因"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <ExternalEvidenceUploader
            attachmentIds={attachmentIds}
            disabled={disabled || busy}
            onChange={setAttachmentIds}
            onMessage={setMessage}
          />
          <Button
            variant="primary"
            disabled={
              disabled
              || busy
              || !/^-?(?:0|[1-9]\d*)\.\d{2}$/.test(amount)
              || amount === "0.00"
              || amount === "-0.00"
              || !reason.trim()
            }
            onClick={() => void submit()}
          >
            {busy ? "提交中" : "提交调整"}
          </Button>
        </>
      ) : (
        <p>暂无符合规则的未锁定目标月份。</p>
      )}
      {message && <p role="status" className="form-message">{message}</p>}
    </Surface>
  );
}
