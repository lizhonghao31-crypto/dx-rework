import {
  ResponsibilityDeterminationResponseSchema,
  type ResponsibilityDeterminationResponse,
  type ResponsibilityType,
} from "@dx-rework/contracts";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useState } from "react";

import { createWebUrls } from "../url-contract.js";

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
  shareBps: string;
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

const parseBps = (value: string): bigint | null => {
  if (!/^\d{1,5}$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= 10000n ? parsed : null;
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
        shareBps: String(
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
  const parsed = process.allocations.map((allocation) =>
    parseBps(allocation.shareBps),
  );
  if (parsed.some((value) => value === null)) return false;
  return parsed.reduce((sum, value) => sum + (value ?? 0n), 0n) === 10000n;
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
  const [transferReason, setTransferReason] = useState("");
  const [takeoverReason, setTakeoverReason] = useState("");
  const [confirmationReason, setConfirmationReason] = useState("");
  const [message, setMessage] = useState("正在加载责任判定…");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const applyResponse = (next: ResponsibilityDeterminationResponse): void => {
    setResponse(next);
    setProcesses(formsFromResponse(next));
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
      setMessage("缺少有效的返工单 UUID，请从返工单详情进入责任处理。");
      return;
    }
    void reload().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : "责任判定加载失败");
    });
  }, [reworkOrderId]);

  const allProcessesValid =
    processes.length > 0 && processes.every(processValid);
  const determination = response?.determination ?? null;
  const editable = Boolean(
    response?.canDetermine &&
      response.reworkStatus === "pending_responsibility_determination",
  );
  const finalizable = Boolean(
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
    shareBps: string,
  ): void => {
    setProcesses((current) =>
      current.map((process) =>
        process.configurationItemId === configurationItemId
          ? {
              ...process,
              allocations: process.allocations.map((allocation) =>
                allocation.responsibilityType === responsibilityType
                  ? { ...allocation, shareBps }
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
    setBusyAction(action);
    try {
      const next = await request(path, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(payload),
      });
      applyResponse(next);
      setMessage(successMessage);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusyAction(null);
    }
  };

  const save = async (): Promise<void> => {
    if (!response || !editable || !allProcessesValid) return;
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
              shareBps: parseBps(allocation.shareBps),
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
    if (!response || !determination || !finalizable) return;
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
    if (!response?.canDetermine || !transferUserId.trim() || !transferReason.trim()) {
      setMessage("转交必须填写目标用户 UUID 和原因。");
      return;
    }
    await runWrite(
      "transfer",
      `rework-orders/${response.reworkOrderId}/responsibility-determinations/transfer`,
      {
        expectedOrderVersion: response.orderVersion,
        expectedCurrentDeterminationVersion: determination?.version ?? null,
        toUserId: transferUserId.trim(),
        reason: transferReason.trim(),
      },
      "责任处理已转交，原处理人不再拥有本单处理权。",
    );
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

  return (
    <Surface className="responsibility-panel">
      <div className="section-title responsibility-heading">
        <div>
          <h2>责任判定与金额</h2>
          <p>
            返工单：{response?.reworkOrderId ?? reworkOrderId ?? "—"}
            <br />
            当前处理人：{response?.handlerUserId ?? "尚未分配"}
          </p>
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
          (sum, allocation) => sum + (parseBps(allocation.shareBps) ?? 0n),
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
                      label="比例（bps）"
                      value={allocation.shareBps}
                      inputMode="numeric"
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
                        ? `${persisted.shareBps} bps · ${displayMoney(persisted.roundedAmount)}`
                        : "保存后由服务器计算"}
                    </b>
                  </div>
                );
              })}
            </div>
            <p className={shareTotal === 10000n ? "share-ok" : "share-error"}>
              比例合计 {shareTotal.toString()} bps
              {shareTotal === 10000n ? " · 校验通过" : " · 必须严格等于 10000"}
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
          disabled={!editable || !allProcessesValid || Boolean(busyAction)}
        >
          {busyAction === "save" ? "保存中…" : "保存草稿"}
        </Button>
        <Button
          variant="primary"
          onClick={() => void finalize()}
          disabled={!finalizable || Boolean(busyAction)}
        >
          {busyAction === "finalize" ? "判定中…" : "正式判定"}
        </Button>
      </div>

      {response?.canDetermine &&
        response.reworkStatus === "pending_responsibility_determination" && (
          <div className="responsibility-command-box">
            <h3>转交当前责任处理</h3>
            <InsetField
              label="目标用户 UUID"
              value={transferUserId}
              disabled={Boolean(busyAction)}
              onChange={(event) => setTransferUserId(event.target.value)}
            />
            <InsetField
              label="转交原因"
              value={transferReason}
              disabled={Boolean(busyAction)}
              onChange={(event) => setTransferReason(event.target.value)}
            />
            <Button
              onClick={() => void transfer()}
              disabled={Boolean(busyAction)}
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
