import {
  ResponsibilityDeterminationResponseSchema,
  type ResponsibilityDeterminationResponse,
  type ResponsibilityType,
} from "@dx-rework/contracts";
import { ResponsibilityTransferOptionsResponseSchema } from "@dx-rework/contracts/responsibility-transfer";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { SearchSelect } from "./search-select.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

const responsibilityTypes: ReadonlyArray<{
  value: ResponsibilityType;
  label: string;
}> = [
  { value: "own_factory", label: "本厂" },
  { value: "processing_factory", label: "外发加工厂" },
  { value: "embroidery_factory", label: "印绣花厂" },
  { value: "washing_factory", label: "洗水厂" },
  { value: "fabric_supplier", label: "面料商" },
];

type AllocationForm = {
  responsibilityType: ResponsibilityType;
  sharePercent: string;
};

type ProcessForm = {
  configurationItemId: string;
  processName: string;
  pricingUnit: "piece" | "hour";
  baseAmount: string;
  multiplier: string;
  highMultiplierReason: string;
  allocations: AllocationForm[];
};

type TransferOption = Readonly<{ userId: string; displayName: string }>;

const requestError = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? "请求未完成，请稍后重试";
  } catch {
    return "请求未完成，请稍后重试";
  }
};

async function request(
  path: string,
  init: RequestInit = {},
): Promise<ResponsibilityDeterminationResponse> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(await requestError(response));
  return ResponsibilityDeterminationResponseSchema.parse(await response.json());
}

async function requestTransferOptions(
  reworkOrderId: string,
): Promise<TransferOption[]> {
  const response = await fetch(
    apiUrl(`rework-orders/${reworkOrderId}/responsibility-determinations/transfer-options`),
    { credentials: "include", headers: { accept: "application/json" } },
  );
  if (!response.ok) throw new Error(await requestError(response));
  return ResponsibilityTransferOptionsResponseSchema.parse(await response.json()).items;
}

const parsePercentToBps = (value: string): bigint | null => {
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const parsed = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  return parsed <= 10000n ? parsed : null;
};

const bpsToPercent = (value: number | bigint): string => {
  const parsed = BigInt(value);
  const whole = parsed / 100n;
  const fraction = (parsed % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
};

const multiplierScaled = (value: string): bigint | null => {
  if (!/^[1-9]\d{0,4}(?:\.\d{1,3})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const parsed = BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, "0"));
  return parsed <= 99_999_999n ? parsed : null;
};

const displayMoney = (value: string): string => `¥${value}`;

const formsFromResponse = (
  response: ResponsibilityDeterminationResponse,
): ProcessForm[] => {
  const determinationProcesses = response.determination?.processes ?? [];
  return response.sourceProcesses.map((source) => {
    const current = determinationProcesses.find(
      (process) => process.configurationItemId === source.configurationItemId,
    );
    return {
      configurationItemId: source.configurationItemId,
      processName: source.processName,
      pricingUnit: source.pricingUnit,
      baseAmount: source.baseAmount,
      multiplier: current?.multiplier ?? "1.000",
      highMultiplierReason: current?.highMultiplierReason ?? "",
      allocations: responsibilityTypes.map(({ value }) => ({
        responsibilityType: value,
        sharePercent: bpsToPercent(
          current?.allocations.find(
            (allocation) => allocation.responsibilityType === value,
          )?.shareBps ?? (value === "own_factory" ? 10000 : 0),
        ),
      })),
    };
  });
};

const processValid = (process: ProcessForm): boolean => {
  const scaled = multiplierScaled(process.multiplier);
  if (scaled === null || scaled < 1000n) return false;
  if (scaled > 2000n && !process.highMultiplierReason.trim()) return false;
  let total = 0n;
  for (const allocation of process.allocations) {
    const share = parsePercentToBps(allocation.sharePercent);
    if (share === null) return false;
    total += share;
  }
  return total === 10000n;
};

export function ResponsibilityDeterminationPanel({
  reworkOrderId,
}: {
  reworkOrderId: string | null;
}) {
  const [response, setResponse] =
    useState<ResponsibilityDeterminationResponse | null>(null);
  const [processes, setProcesses] = useState<ProcessForm[]>([]);
  const [changeReason, setChangeReason] = useState("");
  const [transferUserId, setTransferUserId] = useState("");
  const [transferOptions, setTransferOptions] = useState<TransferOption[]>([]);
  const [transferReason, setTransferReason] = useState("");
  const [takeoverReason, setTakeoverReason] = useState("");
  const [confirmationReason, setConfirmationReason] = useState("");
  const [message, setMessage] = useState("正在加载责任判定…");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const pendingMutationKeys = useRef<Record<string, string>>({});

  const applyResponse = (next: ResponsibilityDeterminationResponse): void => {
    setResponse(next);
    setProcesses(formsFromResponse(next));
    if (
      next.canDetermine
      && next.reworkStatus === "pending_responsibility_determination"
      && next.determination?.stage === "draft"
    ) {
      void requestTransferOptions(next.reworkOrderId)
        .then(setTransferOptions)
        .catch(() => setTransferOptions([]));
    } else {
      setTransferOptions([]);
      setTransferUserId("");
    }
  };

  const reload = async (): Promise<void> => {
    if (!reworkOrderId) return;
    const loaded = await request(
      `rework-orders/${reworkOrderId}/responsibility-determination`,
    );
    applyResponse(loaded);
    setMessage(
      loaded.determination
        ? `已加载不可变版本 V${loaded.determination.version}`
        : "尚未保存责任判定草稿",
    );
  };

  useEffect(() => {
    if (!reworkOrderId) {
      setMessage("缺少有效的返工单编号，请从返工单详情进入责任处理。");
      return;
    }
    void reload().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : "责任判定加载失败");
    });
  }, [reworkOrderId]);

  const allProcessesValid =
    processes.length > 0 && processes.every(processValid);
  const determination = response?.determination ?? null;
  const hasUnsavedChanges = useMemo(
    () => response !== null
      && JSON.stringify(processes) !== JSON.stringify(formsFromResponse(response)),
    [processes, response],
  );
  const highMultiplierPending = Boolean(
    determination?.stage === "draft"
    && determination.processes.some(
      (process) => (multiplierScaled(process.multiplier) ?? 0n) > 2000n,
    )
    && !determination.highMultiplierConfirmed,
  );
  const editable = Boolean(
    response?.canDetermine &&
      response.reworkStatus === "pending_responsibility_determination",
  );
  const saveNeeded = determination === null || hasUnsavedChanges;
  const finalizable = Boolean(
    editable
      && determination?.stage === "draft"
      && !hasUnsavedChanges
      && !highMultiplierPending,
  );
  const transferable = Boolean(
    editable && determination?.stage === "draft",
  );

  const totalLabel = useMemo(() => {
    if (!determination) return "尚未计算";
    return displayMoney(determination.calculationTotal);
  }, [determination]);

  const setProcess = (
    configurationItemId: string,
    update: Partial<ProcessForm>,
  ): void => {
    setProcesses((current) =>
      current.map((process) =>
        process.configurationItemId === configurationItemId
          ? { ...process, ...update }
          : process,
      ),
    );
  };

  const setShare = (
    configurationItemId: string,
    responsibilityType: ResponsibilityType,
    sharePercent: string,
  ): void => {
    setProcesses((current) =>
      current.map((process) =>
        process.configurationItemId === configurationItemId
          ? {
              ...process,
              allocations: process.allocations.map((allocation) =>
                allocation.responsibilityType === responsibilityType
                  ? { ...allocation, sharePercent }
                  : allocation,
              ),
            }
          : process,
      ),
    );
  };

  const runWrite = async (
    action: string,
    path: string,
    payload: unknown,
    successMessage: string,
  ): Promise<void> => {
    if (!response || busyAction) return;
    const signature = `${action}:${path}:${JSON.stringify(payload)}`;
    const idempotencyKey = pendingMutationKeys.current[signature] ?? crypto.randomUUID();
    pendingMutationKeys.current[signature] = idempotencyKey;
    setBusyAction(action);
    try {
      const next = await request(path, {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: JSON.stringify(payload),
      });
      delete pendingMutationKeys.current[signature];
      applyResponse(next);
      setMessage(successMessage);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusyAction(null);
    }
  };

  const save = async (): Promise<void> => {
    if (!response || !editable || !allProcessesValid || !saveNeeded) return;
    const existingVersion = determination?.version ?? null;
    await runWrite(
      "save",
      `rework-orders/${response.reworkOrderId}/responsibility-determinations/drafts`,
      {
        expectedOrderVersion: response.orderVersion,
        expectedCurrentDeterminationVersion: existingVersion,
        handlerUserId: response.handlerUserId,
        ...(existingVersion !== null && changeReason.trim()
          ? { reason: changeReason.trim() }
          : {}),
        processes: processes.map((process) => ({
          configurationItemId: process.configurationItemId,
          multiplier: process.multiplier,
          ...(process.highMultiplierReason.trim()
            ? { highMultiplierReason: process.highMultiplierReason.trim() }
            : {}),
          allocations: process.allocations
            .map((allocation) => ({
              responsibilityType: allocation.responsibilityType,
              shareBps: parsePercentToBps(allocation.sharePercent),
            }))
            .filter(
              (allocation): allocation is {
                responsibilityType: ResponsibilityType;
                shareBps: bigint;
              } => allocation.shareBps !== null && allocation.shareBps > 0n,
            )
            .map((allocation) => ({
              responsibilityType: allocation.responsibilityType,
              shareBps: Number(allocation.shareBps),
            })),
        })),
      },
      "责任判定草稿已保存；金额已由服务器逐行四舍五入并汇总。",
    );
  };

  const finalize = async (): Promise<void> => {
    if (!response || !determination) return;
    if (hasUnsavedChanges) {
      setMessage("当前页面有未保存修改，请先保存草稿，再正式判定。");
      return;
    }
    if (highMultiplierPending) {
      setMessage("当前草稿含超过 2 倍的倍率，必须先由另一位老板独立确认。");
      return;
    }
    if (!finalizable) return;
    if (!window.confirm("确认正式判定？正式版本将原样复制当前草稿并进入责任处理。")) {
      return;
    }
    await runWrite(
      "finalize",
      `rework-orders/${response.reworkOrderId}/responsibility-determinations/finalize`,
      {
        expectedOrderVersion: response.orderVersion,
        expectedCurrentDeterminationVersion: determination.version,
      },
      "责任已正式判定，当前草稿快照已生成不可变正式版本。",
    );
  };

  const transfer = async (): Promise<void> => {
    if (hasUnsavedChanges) {
      setMessage("当前页面有未保存修改，请先保存草稿，再转交处理人。");
      return;
    }
    if (!transferable || !transferUserId || !transferReason.trim()) {
      setMessage("请选择新的责任处理人并填写转交原因。");
      return;
    }
    await runWrite(
      "transfer",
      `rework-orders/${response!.reworkOrderId}/responsibility-determinations/transfer`,
      {
        expectedOrderVersion: response!.orderVersion,
        expectedCurrentDeterminationVersion: determination!.version,
        toUserId: transferUserId,
        reason: transferReason.trim(),
      },
      "责任处理已转交，原处理人不再拥有本单处理权。",
    );
    setTransferUserId("");
    setTransferReason("");
  };

  const takeover = async (): Promise<void> => {
    if (!response?.canTakeover || !takeoverReason.trim()) {
      setMessage("老板接管必须填写原因。");
      return;
    }
    await runWrite(
      "takeover",
      `rework-orders/${response.reworkOrderId}/responsibility-determinations/takeover`,
      {
        expectedOrderVersion: response.orderVersion,
        expectedCurrentDeterminationVersion: determination?.version ?? null,
        reason: takeoverReason.trim(),
      },
      "老板已接管，当前处理人已更新并写入不可变处理事件。",
    );
  };

  const confirmHighMultiplier = async (): Promise<void> => {
    if (
      !response?.canConfirmHighMultiplier ||
      !determination ||
      !confirmationReason.trim()
    ) {
      setMessage("高倍率确认必须由不同的直接老板填写复核原因。");
      return;
    }
    await runWrite(
      "confirm",
      `responsibility-determinations/${determination.determinationId}/high-multiplier-confirm`,
      {
        expectedOrderVersion: response.orderVersion,
        expectedCurrentDeterminationVersion: determination.version,
        reason: confirmationReason.trim(),
      },
      "高倍率已由不同老板独立确认，确认快照已锁定。",
    );
  };

  const currentHandlerLabel = response?.handlerUserId
    ? response.canDetermine ? "当前账号" : "其他已授权处理人"
    : "尚未分配";

  return (
    <Surface className="responsibility-panel">
      <div className="section-title responsibility-heading">
        <div>
          <h2>责任判定与金额</h2>
          <p>当前处理人：{currentHandlerLabel}</p>
        </div>
        <StatusBadge
          tone={determination?.stage === "finalized" ? "success" : "warning"}
        >
          {determination
            ? `${determination.stage === "finalized" ? "正式" : "草稿"} V${determination.version}`
            : "待创建草稿"}
        </StatusBadge>
      </div>

      <div className="responsibility-message" role="status">
        {message}
      </div>

      {processes.map((process) => {
        const current = determination?.processes.find(
          (row) => row.configurationItemId === process.configurationItemId,
        );
        const shareTotal = process.allocations.reduce(
          (sum, allocation) => sum + (parsePercentToBps(allocation.sharePercent) ?? 0n),
          0n,
        );
        const highMultiplier =
          (multiplierScaled(process.multiplier) ?? 0n) > 2000n;
        return (
          <section
            className="responsibility-process"
            key={process.configurationItemId}
          >
            <div className="responsibility-process__title">
              <div>
                <h3>{process.processName}</h3>
                <p>
                  基础金额 {displayMoney(process.baseAmount)} · 计价单位
                  {process.pricingUnit === "piece" ? "件" : "小时"}
                </p>
              </div>
              <b>
                责任金额 {current ? displayMoney(current.responsibilityAmount) : "待保存"}
              </b>
            </div>

            <div className="multiplier-tools">
              <InsetField
                label="倍率"
                value={process.multiplier}
                inputMode="decimal"
                disabled={!editable || Boolean(busyAction)}
                onChange={(event) =>
                  setProcess(process.configurationItemId, {
                    multiplier: event.target.value,
                  })
                }
              />
              {["1.000", "1.200", "1.300", "1.500", "2.000"].map(
                (value) => (
                  <Button
                    key={value}
                    disabled={!editable || Boolean(busyAction)}
                    onClick={() =>
                      setProcess(process.configurationItemId, {
                        multiplier: value,
                      })
                    }
                  >
                    {value}×
                  </Button>
                ),
              )}
            </div>

            {highMultiplier && (
              <div className="high-multiplier-box">
                <InsetField
                  label="高倍率原因"
                  value={process.highMultiplierReason}
                  disabled={!editable || Boolean(busyAction)}
                  placeholder="超过 2 倍必须填写"
                  onChange={(event) =>
                    setProcess(process.configurationItemId, {
                      highMultiplierReason: event.target.value,
                    })
                  }
                />
                <StatusBadge
                  tone={
                    determination?.highMultiplierConfirmed
                      ? "success"
                      : "warning"
                  }
                >
                  {determination?.highMultiplierConfirmed
                    ? "老板已确认"
                    : "待不同老板确认"}
                </StatusBadge>
              </div>
            )}

            <div className="responsibility-allocations">
              {process.allocations.map((allocation) => {
                const persisted = current?.allocations.find(
                  (row) =>
                    row.responsibilityType === allocation.responsibilityType,
                );
                const label = responsibilityTypes.find(
                  (row) => row.value === allocation.responsibilityType,
                )!.label;
                return (
                  <div key={allocation.responsibilityType}>
                    <span>{label}</span>
                    <InsetField
                      label="比例（%）"
                      value={allocation.sharePercent}
                      inputMode="decimal"
                      disabled={!editable || Boolean(busyAction)}
                      onChange={(event) =>
                        setShare(
                          process.configurationItemId,
                          allocation.responsibilityType,
                          event.target.value,
                        )
                      }
                    />
                    <b>
                      {persisted
                        ? `${bpsToPercent(persisted.shareBps)}% · ${displayMoney(persisted.roundedAmount)}`
                        : "保存后由服务器计算"}
                    </b>
                  </div>
                );
              })}
            </div>
            <p className={shareTotal === 10000n ? "share-ok" : "share-error"}>
              比例合计 {bpsToPercent(shareTotal)}%
              {shareTotal === 10000n ? " · 校验通过" : " · 必须严格等于 100%"}
            </p>
          </section>
        );
      })}

      {determination?.stage === "finalized" && (
        <div className="responsibility-final-total">
          <span>正式整单责任金额</span>
          <strong>{totalLabel}</strong>
        </div>
      )}

      {editable && determination && (
        <InsetField
          label="新版本原因"
          value={changeReason}
          disabled={Boolean(busyAction)}
          placeholder="修改已有正式版本时必填"
          onChange={(event) => setChangeReason(event.target.value)}
        />
      )}

      <div className="responsibility-actions">
        <Button
          onClick={() => void save()}
          disabled={!editable || !allProcessesValid || !saveNeeded || Boolean(busyAction)}
        >
          {busyAction === "save" ? "保存中…" : determination && !hasUnsavedChanges ? "草稿已保存" : "保存草稿"}
        </Button>
        <Button
          variant="primary"
          onClick={() => void finalize()}
          disabled={!finalizable || Boolean(busyAction)}
        >
          {busyAction === "finalize"
            ? "判定中…"
            : hasUnsavedChanges
              ? "请先保存草稿"
              : highMultiplierPending
                ? "等待高倍率复核"
                : "正式判定"}
        </Button>
      </div>

      {transferable && (
        <div className="responsibility-command-box">
          <h3>转交当前责任处理</h3>
          {hasUnsavedChanges && <p>当前有未保存修改；请先保存草稿再转交，避免丢失本次编辑。</p>}
          <label className="dx-field">
            <span>新的责任处理人</span>
            <span className="dx-field__control search-select-control">
              <SearchSelect
                options={transferOptions.map((item) => ({
                  value: item.userId,
                  label: item.displayName,
                }))}
                value={transferUserId}
                placeholder={transferOptions.length ? "输入姓名搜索" : "没有其他可转交处理人"}
                emptyText="没有匹配的处理人"
                disabled={Boolean(busyAction) || transferOptions.length === 0 || hasUnsavedChanges}
                onChange={setTransferUserId}
              />
            </span>
          </label>
          <InsetField
            label="转交原因"
            value={transferReason}
            disabled={Boolean(busyAction) || hasUnsavedChanges}
            onChange={(event) => setTransferReason(event.target.value)}
          />
          <Button
            onClick={() => void transfer()}
            disabled={Boolean(busyAction) || hasUnsavedChanges || !transferUserId || !transferReason.trim()}
          >
            {busyAction === "transfer" ? "转交中…" : "确认转交"}
          </Button>
        </div>
      )}

      {response?.canTakeover && (
        <div className="responsibility-command-box">
          <h3>老板接管</h3>
          <InsetField
            label="接管原因"
            value={takeoverReason}
            disabled={Boolean(busyAction)}
            onChange={(event) => setTakeoverReason(event.target.value)}
          />
          <Button
            onClick={() => void takeover()}
            disabled={Boolean(busyAction)}
          >
            {busyAction === "takeover" ? "接管中…" : "接管责任处理"}
          </Button>
        </div>
      )}

      {response?.canConfirmHighMultiplier && determination && (
        <div className="responsibility-command-box high-multiplier-box">
          <h3>高倍率独立确认</h3>
          <InsetField
            label="复核原因"
            value={confirmationReason}
            disabled={Boolean(busyAction)}
            onChange={(event) => setConfirmationReason(event.target.value)}
          />
          <Button
            variant="primary"
            onClick={() => void confirmHighMultiplier()}
            disabled={Boolean(busyAction)}
          >
            {busyAction === "confirm" ? "确认中…" : "确认高倍率"}
          </Button>
        </div>
      )}
    </Surface>
  );
}