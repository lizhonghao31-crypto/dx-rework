import {
  ResponsibilityDeterminationResponseSchema,
  ResponsibilitySupplierOptionsResponseSchema,
  type ResponsibilityDeterminationResponse,
  type ResponsibilityType,
} from "@dx-rework/contracts";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { SearchSelect } from "./search-select.js";
import { confirmInApp } from "./system-dialog.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const responsibilityTypes: ReadonlyArray<{
  value: ResponsibilityType;
  label: string;
  supplierType: "factory" | "embroidery_washing" | "fabric" | null;
}> = [
  { value: "own_factory", label: "本厂承担", supplierType: null },
  { value: "processing_factory", label: "加工厂承担", supplierType: "factory" },
  { value: "embroidery_factory", label: "印绣花厂承担", supplierType: "embroidery_washing" },
  { value: "washing_factory", label: "洗水厂承担", supplierType: "embroidery_washing" },
  { value: "fabric_supplier", label: "面料商承担", supplierType: "fabric" },
];
type Supplier = Readonly<{
  supplierId: string;
  supplierType: "factory" | "embroidery_washing" | "fabric";
  supplierName: string;
}>;
type AllocationForm = { responsibilityType: ResponsibilityType; sharePercent: string; multiplier: string; supplierId: string };
type ProcessForm = { configurationItemId: string; processName: string; pricingUnit: "piece" | "hour"; baseAmount: string; allocations: AllocationForm[] };

const requestError = async (response: Response): Promise<string> => {
  try { return ((await response.json()) as { error?: { message?: string } }).error?.message ?? "请求未完成，请稍后重试"; }
  catch { return "请求未完成，请稍后重试"; }
};
async function request(path: string, init: RequestInit = {}): Promise<ResponsibilityDeterminationResponse> {
  const response = await fetch(apiUrl(path), { credentials: "include", ...init, headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  if (!response.ok) throw new Error(await requestError(response));
  return ResponsibilityDeterminationResponseSchema.parse(await response.json());
}
const requestCurrentUserId = async (): Promise<string> => {
  const response = await fetch(apiUrl("auth/me"), { credentials: "include", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(await requestError(response));
  const body = await response.json() as { user?: { id?: string } };
  if (!body.user?.id) throw new Error("无法读取当前登录用户");
  return body.user.id;
};
const requestSuppliers = async (orderId: string): Promise<Supplier[]> => {
  const response = await fetch(apiUrl(`rework-orders/${orderId}/responsibility-determinations/supplier-options`), { credentials: "include", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(await requestError(response));
  return ResponsibilitySupplierOptionsResponseSchema.parse(await response.json()).items;
};
const parsePercentToBps = (value: string): bigint | null => {
  if (value === "") return 0n;
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const parsed = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  return parsed <= 10000n ? parsed : null;
};
const shareTotalBps = (allocations: readonly AllocationForm[]): bigint | null => {
  let total = 0n;
  for (const allocation of allocations) {
    const value = parsePercentToBps(allocation.sharePercent);
    if (value === null) return null;
    total += value;
  }
  return total;
};
const multiplierScaled = (value: string): bigint | null => {
  if (!/^[1-9]\d{0,4}(?:\.\d{1,3})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, "0"));
};
const isExternal = (type: ResponsibilityType): boolean => type !== "own_factory";
const typeMeta = (type: ResponsibilityType) => responsibilityTypes.find((item) => item.value === type)!;
const displayMoney = (value: string): string => `¥${value}`;
const estimatedAllocationAmount = (baseAmount: string, allocation: AllocationForm): string => {
  const shareBps = parsePercentToBps(allocation.sharePercent);
  const multiplier = Number(allocation.multiplier);
  const base = Number(baseAmount);
  if (shareBps === null || !Number.isFinite(multiplier) || !Number.isFinite(base)) return "—";
  return displayMoney((base * Number(shareBps) / 10_000 * multiplier).toFixed(2));
};
const formsFromResponse = (response: ResponsibilityDeterminationResponse): ProcessForm[] => {
  const persisted = response.determination?.processes ?? [];
  return response.sourceProcesses.map((source) => {
    const current = persisted.find((process) => process.configurationItemId === source.configurationItemId);
    return {
      configurationItemId: source.configurationItemId,
      processName: source.processName,
      pricingUnit: source.pricingUnit,
      baseAmount: source.baseAmount,
      allocations: current?.allocations.length
        ? current.allocations.map((allocation) => ({
            responsibilityType: allocation.responsibilityType,
            sharePercent: String(allocation.shareBps / 100),
            multiplier: allocation.multiplier,
            supplierId: allocation.supplier?.supplierId ?? "",
          }))
        : [{
            responsibilityType: "own_factory",
            sharePercent: "100",
            multiplier: "1.000",
            supplierId: "",
          }],
    };
  });
};
const canEditDetermination = (response: ResponsibilityDeterminationResponse): boolean => {
  const determination = response.determination;
  const rejectedCurrentVersion = determination?.stage === "finalized"
    && response.ownerSignature?.decision === "rejected"
    && response.ownerSignature.determinationId === determination.determinationId;
  return response.canDetermine
    && response.reworkStatus === "pending_responsibility_determination"
    && (determination === null || determination.stage === "draft" || rejectedCurrentVersion);
};
const processValid = (process: ProcessForm): boolean => {
  if (process.allocations.length === 0) return false;
  if (new Set(process.allocations.map((allocation) => allocation.responsibilityType)).size !== process.allocations.length) return false;
  if (shareTotalBps(process.allocations) !== 10000n) return false;
  return process.allocations.every((allocation) => {
    const share = parsePercentToBps(allocation.sharePercent) ?? 0n;
    if (share === 0n) return false;
    const multiplier = multiplierScaled(allocation.multiplier);
    if (multiplier === null || multiplier < 1000n) return false;
    return !isExternal(allocation.responsibilityType) || (multiplier >= 1200n && allocation.supplierId.length > 0);
  });
};

export function ResponsibilityDeterminationPanel({ reworkOrderId, onOrderChanged }: { reworkOrderId: string | null; onOrderChanged?: () => void }) {
  const [response, setResponse] = useState<ResponsibilityDeterminationResponse | null>(null);
  const [processes, setProcesses] = useState<ProcessForm[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [changeReason, setChangeReason] = useState("");
  const [currentUserId, setCurrentUserId] = useState("");
  const [message, setMessage] = useState("正在加载责任判定…");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const pendingMutationKeys = useRef<Record<string, string>>({});

  const applyResponse = (next: ResponsibilityDeterminationResponse): void => {
    setResponse(next);
    setProcesses(formsFromResponse(next));
    setChangeReason(next.determination?.reason ?? "");
    if (canEditDetermination(next)) {
      void requestSuppliers(next.reworkOrderId).then(setSuppliers).catch(() => setSuppliers([]));
    } else {
      setSuppliers([]);
    }
  };
  const reload = async (): Promise<void> => {
    if (!reworkOrderId) return;
    const [next, userId] = await Promise.all([
      request(`rework-orders/${reworkOrderId}/responsibility-determination`),
      requestCurrentUserId(),
    ]);
    setCurrentUserId(userId);
    applyResponse(next);
    setMessage("");
  };
  useEffect(() => {
    if (!reworkOrderId) {
      setMessage("缺少有效的返工单编号，请从返工单详情进入责任处理。");
      return;
    }
    void reload().catch((error: unknown) => setMessage(error instanceof Error ? error.message : "责任判定加载失败"));
  }, [reworkOrderId]);

  const determination = response?.determination ?? null;
  const editable = response !== null && canEditDetermination(response);
  const allProcessesValid = processes.length > 0 && processes.every(processValid);
  const hasUnsavedChanges = useMemo(
    () => response !== null && JSON.stringify(processes) !== JSON.stringify(formsFromResponse(response)),
    [processes, response],
  );
  const handlerUserId = response?.handlerUserId ?? currentUserId;

  const setAllocation = (configurationItemId: string, allocationIndex: number, update: Partial<AllocationForm>): void => setProcesses((current) => current.map((process) => process.configurationItemId !== configurationItemId ? process : {
    ...process,
    allocations: process.allocations.map((allocation, index) => index === allocationIndex ? { ...allocation, ...update } : allocation),
  }));
  const addAllocation = (configurationItemId: string): void => setProcesses((current) => current.map((process) => {
    if (process.configurationItemId !== configurationItemId) return process;
    const nextType = responsibilityTypes.find((type) => !process.allocations.some((allocation) => allocation.responsibilityType === type.value))?.value;
    if (!nextType) return process;
    return {
      ...process,
      allocations: [...process.allocations, {
        responsibilityType: nextType,
        sharePercent: "",
        multiplier: isExternal(nextType) ? "1.200" : "1.000",
        supplierId: "",
      }],
    };
  }));
  const removeAllocation = (configurationItemId: string, allocationIndex: number): void => setProcesses((current) => current.map((process) => process.configurationItemId !== configurationItemId ? process : {
    ...process,
    allocations: process.allocations.filter((_, index) => index !== allocationIndex),
  }));
  const payloadProcesses = () => processes.map((process) => ({
    configurationItemId: process.configurationItemId,
    multiplier: "1.000",
    allocations: process.allocations
      .map((allocation) => ({
        responsibilityType: allocation.responsibilityType,
        shareBps: parsePercentToBps(allocation.sharePercent),
        multiplier: allocation.multiplier,
        ...(isExternal(allocation.responsibilityType) ? { supplierId: allocation.supplierId || undefined } : {}),
      }))
      .filter((allocation): allocation is { responsibilityType: ResponsibilityType; shareBps: bigint; multiplier: string; supplierId?: string } => allocation.shareBps !== null && allocation.shareBps > 0n)
      .map((allocation) => ({ ...allocation, shareBps: Number(allocation.shareBps) })),
  }));
  const write = async (action: string, path: string, payload: unknown): Promise<ResponsibilityDeterminationResponse> => {
    const signature = `${action}:${path}:${JSON.stringify(payload)}`;
    const idempotencyKey = pendingMutationKeys.current[signature] ?? crypto.randomUUID();
    pendingMutationKeys.current[signature] = idempotencyKey;
    const next = await request(path, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(payload),
    });
    delete pendingMutationKeys.current[signature];
    return next;
  };
  const runWrite = async (action: string, path: string, payload: unknown, successMessage: string): Promise<void> => {
    if (!response || busyAction) return;
    setBusyAction(action);
    try {
      const next = await write(action, path, payload);
      applyResponse(next);
      setMessage(successMessage);
      onOrderChanged?.();
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusyAction(null);
    }
  };
  const submit = async (): Promise<void> => {
    if (!response || !editable || !allProcessesValid || !handlerUserId || busyAction) return;
    const includesOwnFactory = processes.some((process) => process.allocations.some((allocation) => allocation.responsibilityType === "own_factory"));
    if (!(await confirmInApp(includesOwnFactory
      ? "提交责任判定并进入老板确认？提交后将锁定责任比例、供应商和外部扣款倍率。"
      : "提交纯外部责任判定？系统将跳过老板确认并直接生成供应商扣款台账。"))) return;
    setBusyAction("submit");
    try {
      let working = response;
      const needsSave = determination === null || determination.stage === "finalized" || hasUnsavedChanges;
      if (needsSave) {
        working = await write(
          "save-before-submit",
          `rework-orders/${response.reworkOrderId}/responsibility-determinations/drafts`,
          {
            expectedOrderVersion: response.orderVersion,
            expectedCurrentDeterminationVersion: determination?.version ?? null,
            handlerUserId,
            ...(changeReason.trim() ? { reason: changeReason.trim() } : {}),
            processes: payloadProcesses(),
          },
        );
      }
      const draft = working.determination;
      if (!draft || draft.stage !== "draft") throw new Error("责任判定未准备完成，请刷新后重试");
      const finalized = await write(
        "finalize",
        `rework-orders/${working.reworkOrderId}/responsibility-determinations/finalize`,
        {
          expectedOrderVersion: working.orderVersion,
          expectedCurrentDeterminationVersion: draft.version,
        },
      );
      applyResponse(finalized);
      setMessage(finalized.reworkStatus === "pending_owner_signature"
        ? "责任判定已提交老板确认。"
        : "纯外部责任判定已完成，已跳过老板确认并生成供应商扣款台账。");
      onOrderChanged?.();
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "责任判定提交失败");
    } finally {
      setBusyAction(null);
    }
  };
  const takeover = async (): Promise<void> => {
    if (!response?.canTakeover || busyAction) return;
    if (!(await confirmInApp("确认接管当前责任处理？"))) return;
    await runWrite(
      "takeover",
      `rework-orders/${response.reworkOrderId}/responsibility-determinations/takeover`,
      {
        expectedOrderVersion: response.orderVersion,
        expectedCurrentDeterminationVersion: determination?.version ?? null,
        reason: "老板主动接管",
      },
      "老板已接管责任处理。",
    );
  };
  const ownerDecision = async (decision: "approve" | "reject"): Promise<void> => {
    if (!response?.canOwnerSign) return;
    if (!(await confirmInApp(decision === "approve" ? "确认同意本次责任判定并完成返工业务？" : "直接驳回并退回责任判定？"))) return;
    await runWrite(
      `owner-${decision}`,
      `rework-orders/${response.reworkOrderId}/responsibility-owner-signature/${decision}`,
      { expectedOrderVersion: response.orderVersion },
      decision === "approve" ? "老板已确认同意，返工业务已完成。" : "老板已驳回，订单已退回责任判定。",
    );
  };

  const ownerSigning = response?.reworkStatus === "pending_owner_signature";
  const statusText = ownerSigning || determination?.stage === "finalized" ? "已提交" : editable ? "待提交" : "待处理";
  return <Surface className="responsibility-panel">
    <div className="section-title responsibility-heading">
      <div>
        <h2>{ownerSigning ? "N08 · 老板签字" : "N07 · 责任判定"}</h2>
        <p>{ownerSigning ? "仅包含本厂责任时需要老板确认；核对后同意或驳回。" : "每道工序可添加多个责任方，比例合计必须为 100%；金额由工资基础、比例和倍率自动计算。"}</p>
      </div>
      <StatusBadge tone={ownerSigning || determination?.stage === "finalized" ? "success" : "warning"}>{statusText}</StatusBadge>
    </div>
    {message && <p className="responsibility-message" role="status">{message}</p>}

    {processes.map((process) => {
      const persisted = determination?.processes.find((item) => item.configurationItemId === process.configurationItemId);
      const totalBps = shareTotalBps(process.allocations);
      return <section className="responsibility-process" key={process.configurationItemId}>
        <div className="responsibility-process__title">
          <div><h3>{process.processName}</h3><p>工资基础 {displayMoney(process.baseAmount)} · {process.pricingUnit === "piece" ? "按件" : "按小时"}</p></div>
          <b className={totalBps === 10000n ? "share-ok" : "share-error"}>责任比例 {totalBps === null ? "格式有误" : `${Number(totalBps) / 100}%`}</b>
        </div>
        <div className="responsibility-party-list">
          {process.allocations.map((allocation, allocationIndex) => {
            const meta = typeMeta(allocation.responsibilityType);
            const supplierOptions = suppliers.filter((supplier) => supplier.supplierType === meta.supplierType);
            const persistedAllocation = persisted?.allocations.find((item) => item.responsibilityType === allocation.responsibilityType);
            const availableTypes = responsibilityTypes.filter((item) => item.value === allocation.responsibilityType || !process.allocations.some((current) => current.responsibilityType === item.value));
            return <div className="responsibility-party" key={`${process.configurationItemId}:${allocation.responsibilityType}`}>
              {editable ? <>
                <label className="dx-field"><span>责任方</span><span className="dx-field__control"><select value={allocation.responsibilityType} disabled={Boolean(busyAction)} onChange={(event) => {
                  const nextType = event.target.value as ResponsibilityType;
                  setAllocation(process.configurationItemId, allocationIndex, {
                    responsibilityType: nextType,
                    multiplier: isExternal(nextType) ? "1.200" : "1.000",
                    supplierId: "",
                  });
                }}>{availableTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></span></label>
                <InsetField label="承担比例（%）" value={allocation.sharePercent} inputMode="decimal" disabled={Boolean(busyAction)} placeholder="例如 70" onChange={(event) => setAllocation(process.configurationItemId, allocationIndex, { sharePercent: event.target.value })} />
                {isExternal(allocation.responsibilityType) ? <>
                  <label className="dx-field"><span>责任供应商</span><span className="dx-field__control search-select-control"><SearchSelect options={supplierOptions.map((supplier) => ({ value: supplier.supplierId, label: supplier.supplierName }))} value={allocation.supplierId} placeholder={supplierOptions.length ? "选择供应商" : "没有可用供应商"} emptyText="没有匹配的供应商" onChange={(supplierId: string) => setAllocation(process.configurationItemId, allocationIndex, { supplierId })} /></span></label>
                  <InsetField label="扣款倍率（最低 1.2）" value={allocation.multiplier} inputMode="decimal" disabled={Boolean(busyAction)} onChange={(event) => setAllocation(process.configurationItemId, allocationIndex, { multiplier: event.target.value })} />
                </> : <div className="responsibility-party__fixed"><span>责任倍率</span><b>1.000×</b></div>}
                <div className="responsibility-party__amount"><span>自动计算金额</span><strong>{estimatedAllocationAmount(process.baseAmount, allocation)}</strong></div>
                <Button disabled={Boolean(busyAction) || process.allocations.length === 1} onClick={() => removeAllocation(process.configurationItemId, allocationIndex)}>移除</Button>
              </> : <>
                <div><b>{meta.label}</b><p>{allocation.sharePercent}% · {allocation.multiplier}×</p></div>
                {isExternal(allocation.responsibilityType) && <div><span>责任供应商</span><p>{persistedAllocation?.supplier?.name ?? "未填写"}</p></div>}
                <div className="responsibility-party__amount"><span>责任金额</span><strong>{persistedAllocation ? displayMoney(persistedAllocation.roundedAmount) : estimatedAllocationAmount(process.baseAmount, allocation)}</strong></div>
              </>}
            </div>;
          })}
        </div>
        {editable && <div className="responsibility-process__footer">
          <Button disabled={Boolean(busyAction) || process.allocations.length === responsibilityTypes.length} onClick={() => addAllocation(process.configurationItemId)}>+ 添加责任方</Button>
          <span className={totalBps === 10000n ? "share-ok" : "share-error"}>{totalBps === 10000n ? "比例合计正确，可以提交" : "比例合计必须为 100%"}</span>
        </div>}
      </section>;
    })}

    {editable && <InsetField label="共同责任记录 / 修改说明（可选）" value={changeReason} disabled={Boolean(busyAction)} placeholder="有需要时填写" onChange={(event) => setChangeReason(event.target.value)} />}
    {!editable && determination?.reason && <p className="responsibility-message">共同责任记录 / 修改说明：{determination.reason}</p>}

    {response?.canTakeover && !ownerSigning && <div className="responsibility-actions">
      <Button disabled={Boolean(busyAction)} onClick={() => void takeover()}>{busyAction === "takeover" ? "接管中…" : "接管责任处理"}</Button>
    </div>}
    {editable && <div className="responsibility-actions">
      <Button variant="primary" onClick={() => void submit()} disabled={!allProcessesValid || !handlerUserId || Boolean(busyAction)}>{busyAction === "submit" ? "提交中…" : "提交责任判定"}</Button>
    </div>}
    {ownerSigning && response?.canOwnerSign && <div className="responsibility-actions responsibility-actions--owner">
      <Button variant="primary" disabled={Boolean(busyAction)} onClick={() => void ownerDecision("approve")}>{busyAction === "owner-approve" ? "确认中…" : "确认同意并完成返工"}</Button>
      <Button disabled={Boolean(busyAction)} onClick={() => void ownerDecision("reject")}>{busyAction === "owner-reject" ? "驳回中…" : "驳回，返回判责"}</Button>
    </div>}
    {ownerSigning && !response?.canOwnerSign && <p>等待有审批权限的老板处理。</p>}
  </Surface>;
}
