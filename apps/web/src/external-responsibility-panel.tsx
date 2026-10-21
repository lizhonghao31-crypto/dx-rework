import { currentModuleCanWrite } from "./member-module-policy.js";
import {
  ExternalResponsibilityBatchResponseSchema,
  ExternalResponsibilityCaseResponseSchema,
  type ExternalResponsibilityBatchResponse,
  type ExternalResponsibilityCaseResponse,
} from "@dx-rework/contracts/external-responsibility";
import { fixedBusinessCurrency as formatBusinessCurrency } from "./fixed-business-currency.js";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { createClientRequestId } from "./client-request-id.js";
import { shanghaiBusinessDate } from "./business-date.js";
import { confirmDeductionException, deductionInputState } from "./external-deduction-confirmation.js";
import { ExternalEvidenceView } from "./external-evidence-view.js";
import { ExternalEvidenceUploader } from "./external-evidence-uploader.js";
import { readExternalResponsibilityResponse } from "./external-responsibility-response.js";
import { SearchSelect } from "./search-select.js";
import { alertInApp, confirmInApp, promptInApp } from "./system-dialog.js";
import "./external-responsibility.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

type State =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "ready"; value: ExternalResponsibilityBatchResponse }
  | { kind: "unavailable"; message: string };
type Supplier = {
  supplierId: string;
  supplierType: "factory" | "embroidery_washing" | "fabric" | "other";
  supplierName: string;
};
type CaseStatus = NonNullable<ExternalResponsibilityBatchResponse>["cases"][number]["status"];
type ResponsibilityType = NonNullable<ExternalResponsibilityBatchResponse>["items"][number]["responsibilityType"];
type DeductionEntryType = ExternalResponsibilityCaseResponse["deductions"][number]["entryType"];

const caseLabel: Record<CaseStatus, string> = {
  pending_business_signoff: "待交财务",
  pending_payables_confirmation: "待扣款",
  deduction_follow_up: "扣款中",
  pending_special_approval: "待财务总监特批",
  returned: "资料退回",
  pending_responsibility_revision: "待重判",
  closed: "扣款完成",
  superseded: "历史台账",
};

const responsibilityTypeLabel: Record<ResponsibilityType, string> = {
  processing_factory: "加工厂",
  embroidery_factory: "印绣花厂",
  washing_factory: "洗水厂",
  fabric_supplier: "面料供应商",
};

const deductionEntryLabel: Record<DeductionEntryType, string> = {
  deduction: "扣款",
  adjustment: "调整",
  reversal: "冲销",
};

const processName = (snapshot: Record<string, unknown>): string => {
  const value = snapshot.processName;
  return typeof value === "string" && value.trim() ? value.trim() : "工序";
};

const requiredSupplierType = (type: ResponsibilityType): Supplier["supplierType"] =>
  type === "processing_factory"
    ? "factory"
    : type === "fabric_supplier"
      ? "fabric"
      : "embroidery_washing";

const parseMoneyToCents = (value: string): bigint | null => {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole = "0", fraction = ""] = normalized.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
};

const moneyFromCents = (value: bigint): string => `${value / 100n}.${(value % 100n).toString().padStart(2,"0")}`;

const requestError = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? "操作未完成，请稍后重试";
  } catch {
    return "操作未完成，请稍后重试";
  }
};

export function ExternalResponsibilityPanel({
  reworkOrderId,
  focusCaseId,
  readOnly: requestedReadOnly = false,
  embedded = false,
  onOrderChanged,
}: {
  reworkOrderId: string | null;
  focusCaseId?: string;
  readOnly?: boolean;
  embedded?: boolean;
  onOrderChanged?: () => Promise<void>;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [temporarySupplierName, setTemporarySupplierName] = useState<Partial<Record<ResponsibilityType, string>>>({});
  const [processingOverrideReason, setProcessingOverrideReason] = useState("");
  const [moduleWritable, setModuleWritable] = useState(false);
  const readOnly = requestedReadOnly || !moduleWritable;
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<Record<string, string[]>>({});
  const [uploadingCases, setUploadingCases] = useState<Record<string, boolean>>({});
  const pendingMutationKeys = useRef<Record<string, string>>({});

  const load = async (): Promise<ExternalResponsibilityBatchResponse> => {
    if (!reworkOrderId) return null;
    setModuleWritable(await currentModuleCanWrite("rework"));
    const response = await fetch(
      apiUrl(`rework-orders/${reworkOrderId}/external-responsibilities`),
      { credentials: "include", headers: { accept: "application/json" } },
    );
    if (response.status === 403) {
      setState({ kind: "hidden" });
      return null;
    }
    if (!response.ok) throw new Error(await requestError(response));
    const value = await readExternalResponsibilityResponse(response, ExternalResponsibilityBatchResponseSchema, "read");
    setState({ kind: "ready", value });
    return value;
  };

  useEffect(() => {
    if (!reworkOrderId) {
      setState({ kind: "hidden" });
      return;
    }
    const controller = new AbortController();
    void load().then(async (batch) => {
      if (readOnly) return [] as Supplier[];
      const hasUnassigned = batch?.items.some(
        (item) => !batch.cases.some((entry) =>
          entry.items.some((mapped) => mapped.externalItemId === item.externalItemId),
        ),
      ) ?? false;
      if (!batch || !hasUnassigned || batch.canAllocateSuppliers !== true) return [] as Supplier[];
      const response = await fetch(
        apiUrl(`rework-orders/${reworkOrderId}/external-responsibilities/supplier-options`),
        { credentials: "include", signal: controller.signal, headers: { accept: "application/json" } },
      );
      if (response.status === 403) return [] as Supplier[];
      if (!response.ok) throw new Error(await requestError(response));
      return await response.json() as Supplier[];
    }).then(setSuppliers).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setState({
          kind: "unavailable",
          message: error instanceof Error ? error.message : "扣款资料加载失败，请刷新重试。",
        });
      }
    });
    return () => controller.abort();
  }, [readOnly, reworkOrderId]);

  const unassigned = useMemo(
    () => state.kind === "ready" && state.value
      ? state.value.items.filter(
          (item) => !state.value!.cases.some((entry) =>
            entry.items.some((mapped) => mapped.externalItemId === item.externalItemId),
          ),
        )
      : [],
    [state],
  );

  const mutationKey = (signature: string): string => {
    const existing = pendingMutationKeys.current[signature];
    if (existing) return existing;
    const next = createClientRequestId();
    pendingMutationKeys.current[signature] = next;
    return next;
  };

  const send = async (
    path: string,
    body: unknown,
  ): Promise<ExternalResponsibilityCaseResponse> => {
    const signature = `case:${path}:${JSON.stringify(body)}`;
    const response = await fetch(apiUrl(path), {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": mutationKey(signature),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await requestError(response));
    const result = await readExternalResponsibilityResponse(response, ExternalResponsibilityCaseResponseSchema, "write");
    delete pendingMutationKeys.current[signature];
    return result;
  };

  const refresh = async (success: string): Promise<void> => {
    setMessage(success);
    let refreshed = true;
    try { await load(); } catch { refreshed = false; }
    try { await onOrderChanged?.(); } catch { refreshed = false; }
    if (!refreshed) setMessage(`${success} 页面状态刷新失败，请刷新页面核对最新状态。`);
  };

  const createTemporarySupplier = async (
    item: NonNullable<ExternalResponsibilityBatchResponse>["items"][number],
  ): Promise<void> => {
    const supplierName = temporarySupplierName[item.responsibilityType]?.trim() ?? "";
    if (!supplierName) {
      const issue = `请先填写${responsibilityTypeLabel[item.responsibilityType]}名称。`;
      setMessage(issue);
      await alertInApp(issue, { title: "供应商暂不能新增", confirmLabel: "知道了" });
      return;
    }
    const supplierType = requiredSupplierType(item.responsibilityType);
    const signature = `temporary-supplier:${reworkOrderId}:${supplierType}:${supplierName}`;
    const idempotencyKey = pendingMutationKeys.current[signature] ?? createClientRequestId();
    pendingMutationKeys.current[signature] = idempotencyKey;
    setBusy(true);
    setMessage("");
    try {
      const createResponse = await fetch(
        apiUrl(`rework-orders/${reworkOrderId}/external-responsibilities/temporary-suppliers`),
        {
          method: "POST",
          credentials: "include",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({ supplierType, supplierName }),
        },
      );
      if (!createResponse.ok) throw new Error(await requestError(createResponse));
      const created = await createResponse.json() as Supplier;
      const optionsResponse = await fetch(
        apiUrl(`rework-orders/${reworkOrderId}/external-responsibilities/supplier-options`),
        { credentials: "include", headers: { accept: "application/json" } },
      );
      if (!optionsResponse.ok) throw new Error(await requestError(optionsResponse));
      const catalog = await optionsResponse.json() as Supplier[];
      if (!catalog.some((supplier) => supplier.supplierId === created.supplierId)) {
        throw new Error("供应商已新增，但未能重新读取可选名录，请刷新后重试。");
      }
      delete pendingMutationKeys.current[signature];
      setSuppliers(catalog);
      setSelection((current) => ({ ...current, [item.externalItemId]: created.supplierId }));
      setTemporarySupplierName((current) => ({ ...current, [item.responsibilityType]: "" }));
      setMessage(`${supplierName} 已新增到供应商名录并自动选中。`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "新增供应商失败");
    } finally {
      setBusy(false);
    }
  };

  const allocate = async (): Promise<void> => {
    if (state.kind !== "ready" || !state.value || busy) return;
    const grouped = new Map<string, {
      responsibilityType: ResponsibilityType;
      supplierId: string;
      externalItemIds: string[];
      processingFactoryOverrideReason?: string;
    }>();
    for (const item of unassigned) {
      const supplierId = selection[item.externalItemId];
      if (!supplierId) {
        const issue = "请为每个外部责任项目选择实际拟扣供应商。";
        setMessage(issue);
        await alertInApp(issue, { title: "供应商分配暂不能提交", confirmLabel: "知道了" });
        return;
      }
      const key = `${item.responsibilityType}:${supplierId}`;
      let current = grouped.get(key);
      if (!current) {
        current = { responsibilityType: item.responsibilityType, supplierId, externalItemIds: [] };
        const reason = processingOverrideReason.trim();
        if (item.responsibilityType === "processing_factory" && reason) {
          current.processingFactoryOverrideReason = reason;
        }
        grouped.set(key, current);
      }
      current.externalItemIds.push(item.externalItemId);
    }
    const path = `external-responsibility-batches/${state.value.batchId}/allocate-suppliers`;
    const body = { expectedBatchVersion: state.value.batchVersion, allocations: [...grouped.values()] };
    const signature = `batch:${path}:${JSON.stringify(body)}`;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(apiUrl(path), {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": mutationKey(signature),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await requestError(response));
      const value = await readExternalResponsibilityResponse(response, ExternalResponsibilityBatchResponseSchema, "write");
      delete pendingMutationKeys.current[signature];
      setState({ kind: "ready", value });
      setMessage("供应商已锁定，可进入扣款。 ");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "供应商分配失败");
    } finally {
      setBusy(false);
    }
  };

  const closeFull = async (caseItem: ExternalResponsibilityCaseResponse): Promise<void> => {
    const closed = await send(
      `external-responsibility-cases/${caseItem.caseId}/close`,
      {
        expectedCaseVersion: caseItem.caseVersion,
        result: "full",
        evidenceAttachmentIds: [],
      },
    );
    if (closed.status !== "closed") throw new Error("扣款已足额，但自动结案未完成");
    setState((current) => current.kind === "ready" && current.value
      ? { ...current, value: { ...current.value, cases: current.value.cases.map((entry) => entry.caseId === closed.caseId ? closed : entry) } }
      : current);
  };

  const recordDeduction = async (caseItem: ExternalResponsibilityCaseResponse): Promise<void> => {
    if (busy || readOnly || uploadingCases[caseItem.caseId] || !caseItem.canRecordDeduction) return;
    const text = amount[caseItem.caseId]?.trim() ?? "";
    const cents = parseMoneyToCents(text);
    if (cents === null || cents <= 0n) {
      const issue = "本次扣款金额必须大于 0，最多两位小数。";
      setMessage(issue);
      await alertInApp(issue, { title: "扣款暂不能提交", confirmLabel: "知道了" });
      return;
    }
    const actualCents = parseMoneyToCents(caseItem.actualDeductedAmount);
    const proposedCents = parseMoneyToCents(caseItem.proposedDeductionAmount);
    if (actualCents === null || proposedCents === null) {
      setMessage("扣款金额读取失败，请刷新后重试。");
      return;
    }
    if (actualCents+cents>proposedCents) {
      setMessage("累计扣款超出拟扣，请转财务总监特批。");
      return;
    }
    const files = attachments[caseItem.caseId] ?? [];
    setBusy(true);
    setMessage("");
    try {
      const recorded = await send(
        `external-responsibility-cases/${caseItem.caseId}/deductions`,
        {
          expectedCaseVersion: caseItem.caseVersion,
          entryType: "deduction",
          amount: text,
          deductedOn: shanghaiBusinessDate(),
          attachmentIds: files,
        },
      );
      setState((current) => current.kind === "ready" && current.value
        ? { ...current, value: { ...current.value, cases: current.value.cases.map((entry) => entry.caseId === recorded.caseId ? recorded : entry) } }
        : current);
      setAmount((current) => ({ ...current, [caseItem.caseId]: "" }));
      setAttachments((current) => ({ ...current, [caseItem.caseId]: [] }));
      if (recorded.remainingAmount === "0.00" && recorded.canClose) {
        try {
          await closeFull(recorded);
          await refresh("本次扣款已记录，累计金额已达到应扣金额，扣款已自动完成。");
        } catch {
          await refresh("本次扣款已记录且已足额，但自动完成未成功，请点击“完成扣款”。");
        }
        return;
      }
      await refresh("本次扣款已记录，累计金额已更新。");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "扣款记录失败");
    } finally {
      setBusy(false);
    }
  };

  const finishDeduction = async (caseItem: ExternalResponsibilityCaseResponse): Promise<void> => {
    if (busy || caseItem.remainingAmount !== "0.00" || !caseItem.canClose) return;
    setBusy(true);
    setMessage("");
    try {
      await closeFull(caseItem);
      await refresh("扣款已完成。");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "扣款完成失败");
    } finally {
      setBusy(false);
    }
  };

  const requestSpecialApproval = async (caseItem: ExternalResponsibilityCaseResponse): Promise<void> => {
    if (busy || readOnly || uploadingCases[caseItem.caseId]) return;
    const text=amount[caseItem.caseId]?.trim()??"";
    const hasAmount=text.length>0;
    if (!caseItem.canRequestSpecialApproval && !caseItem.canRecordDeduction) return;
    let reason: string | undefined;
    if (hasAmount) {
      const inputState=deductionInputState(text,caseItem.actualDeductedAmount,caseItem.proposedDeductionAmount);
      if (!caseItem.canRecordDeduction || !inputState.valid) return;
      const result=await confirmDeductionException({amount:parseMoneyToCents(text)!,actual:parseMoneyToCents(caseItem.actualDeductedAmount)!,proposed:parseMoneyToCents(caseItem.proposedDeductionAmount)!,forceSpecial:true},{confirmInApp,promptInApp,alertInApp});
      if (result.kind!=="special") return;
      reason=result.reason;
    } else {
      reason=(await promptInApp("请填写部分扣款或未扣的特批原因"))?.trim();
      if (!reason || reason.length>500) return;
    }
    setBusy(true);
    setMessage("");
    try {
      await send(`external-responsibility-cases/${caseItem.caseId}/special-approval-requests`, {
        expectedCaseVersion:caseItem.caseVersion,
        requestMode:hasAmount?"proposed_entry":"existing_ledger",
        ...(hasAmount?{requestedAmount:text,deductedOn:shanghaiBusinessDate()}:{}),
        reason,attachmentIds:attachments[caseItem.caseId]??[],
      });
      setAmount(current=>({...current,[caseItem.caseId]:""}));
      setAttachments(current=>({...current,[caseItem.caseId]:[]}));
      await refresh("已提交财务总监审批。");
    } catch (error:unknown) {
      setMessage(error instanceof Error?error.message:"扣款特批申请失败");
    } finally {setBusy(false);}
  };

  const decideSpecialApproval = async (
    caseItem: ExternalResponsibilityCaseResponse,
    approved: boolean,
  ): Promise<void> => {
    if (busy || !caseItem.canDecideSpecialApproval || !caseItem.specialApproval) return;
    const opinion = await promptInApp(approved ? "特批确认意见（可留空）" : "请输入退回原因");
    if (opinion === null) return;
    const reason = opinion.trim();
    if (!approved && !reason) return;
    setBusy(true);
    setMessage("");
    try {
      await send(
        `external-responsibility-cases/${caseItem.caseId}/special-approval/${approved ? "approve" : "return"}`,
        {
          expectedCaseVersion: caseItem.caseVersion,
          expectedRequestVersion: caseItem.specialApproval.requestVersion,
          reason: reason || undefined,
        },
      );
      await refresh(approved ? "扣款特批已确认并关闭台账。" : "扣款特批已退回应付继续处理。");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "扣款特批处理失败");
    } finally {
      setBusy(false);
    }
  };

  const requestRevision = async (caseItem: ExternalResponsibilityCaseResponse): Promise<void> => {
    if (busy || !caseItem.canRequestRevision) return;
    const reason = (await promptInApp("请输入重判责任原因"))?.trim() ?? "";
    if (!reason) return;
    const files = attachments[caseItem.caseId] ?? [];
    setBusy(true);
    setMessage("");
    try {
      await send(
        `external-responsibility-cases/${caseItem.caseId}/revision-requests`,
        {
          expectedCaseVersion: caseItem.caseVersion,
          requestedChange: {
            kind: "other",
            configurationItemIds: caseItem.items.map((item) => item.configurationItemId),
            summary: reason,
          },
          reason,
          attachmentIds: files,
        },
      );
      setAttachments((current) => ({ ...current, [caseItem.caseId]: [] }));
      await refresh("已申请重判责任。");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "重判责任申请失败");
    } finally {
      setBusy(false);
    }
  };

  const decideRevision = async (
    caseItem: ExternalResponsibilityCaseResponse,
    approved: boolean,
  ): Promise<void> => {
    if (busy) return;
    const pending = caseItem.revisionRequests.find((request) => request.status === "pending");
    if (!pending) return;
    if (approved && !(await confirmInApp("确认通过重判责任？通过后重新进入 N08 判责。"))) return;
    setBusy(true);
    setMessage("");
    try {
      await send(
        `external-responsibility-revision-requests/${pending.revisionRequestId}/${approved ? "approve" : "reject"}`,
        {
          expectedCaseVersion: caseItem.caseVersion,
          expectedRevisionVersion: pending.revisionVersion,
        },
      );
      await refresh(approved ? "重判责任已通过，已重新进入 N08。" : "重判责任已驳回。");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "重判责任处理失败");
    } finally {
      setBusy(false);
    }
  };

  const submitLegacyCase = async (caseItem: ExternalResponsibilityCaseResponse): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await send(
        `external-responsibility-cases/${caseItem.caseId}/submit`,
        {
          expectedCaseVersion: caseItem.caseVersion,
          attachmentIds: attachments[caseItem.caseId] ?? [],
        },
      );
      setAttachments((current) => ({ ...current, [caseItem.caseId]: [] }));
      await refresh("已交财务扣款。");
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "提交财务失败");
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === "hidden") return null;
  if (state.kind === "loading") return <Surface className="external-state">正在加载扣款台账…</Surface>;
  if (state.kind === "unavailable") return <Surface className="external-state">{state.message}<Button type="button" disabled={busy} onClick={() => {
    setBusy(true);
    void load().catch((error: unknown) => setState({ kind: "unavailable", message: error instanceof Error ? error.message : "扣款资料加载失败，请刷新重试。" })).finally(() => setBusy(false));
  }}>刷新</Button></Surface>;
  if (!state.value) return <Surface className="external-state">无本类扣款事项。</Surface>;

  const batch = state.value;
  const allCases = [...batch.cases, ...(batch.historicalCases ?? [])];
  const visibleCases = focusCaseId
    ? allCases.filter((caseItem) => caseItem.caseId === focusCaseId)
    : allCases;
  const visibleUnassigned = readOnly || focusCaseId || batch.status !== "active" || batch.canAllocateSuppliers !== true ? [] : unassigned;
  const supplierAllocationReady = visibleUnassigned.length > 0
    && visibleUnassigned.every((item) => Boolean(selection[item.externalItemId]));

  if (focusCaseId && visibleCases.length === 0) {
    return <Surface className="external-state">该供应商扣款任务不在当前有效台账中。</Surface>;
  }

  return <Surface className="external-responsibility-panel">
    {!embedded && <div className="section-title">
      <div>
        <h2>{readOnly ? "责任结算台账" : "供应商扣款"}</h2>
        <p>{readOnly ? "查看供应商实际扣款记录。" : "只记录本次扣款金额；系统自动累计，扣足后自动完成。"}</p>
      </div>
      <StatusBadge tone={batch.status === "active" ? "info" : "warning"}>{batch.status === "active" ? "当前台账" : "历史台账"}</StatusBadge>
    </div>}
    {message && <div className="own-factory-approval-message" role="status">{message}</div>}

    {visibleUnassigned.length > 0 && <section className="external-operation">
      <h3>待补充供应商</h3>
      {visibleUnassigned.map((item) => {
        const matchingSuppliers = suppliers.filter(
          (supplier) => supplier.supplierType === requiredSupplierType(item.responsibilityType),
        );
        const temporaryNameReady = Boolean(temporarySupplierName[item.responsibilityType]?.trim());
        return <div className="external-operation-grid" key={item.externalItemId}>
          <span>{processName(item.processSnapshot)} · {responsibilityTypeLabel[item.responsibilityType]} · 应扣 {formatBusinessCurrency(item.proposedAmount)}</span>
          <SearchSelect
            options={matchingSuppliers.map((supplier) => ({ value: supplier.supplierId, label: supplier.supplierName }))}
            value={selection[item.externalItemId] ?? ""}
            placeholder={matchingSuppliers.length ? "输入供应商名称搜索" : "没有匹配类型的供应商"}
            emptyText="没有匹配的供应商"
            ariaLabel={`供应商 ${processName(item.processSnapshot)}`}
            disabled={busy || matchingSuppliers.length === 0}
            onChange={(supplierId) => setSelection((current) => ({ ...current, [item.externalItemId]: supplierId }))}
          />
          {matchingSuppliers.length === 0 && <div className="external-temporary-supplier">
            <InsetField
              label={`新增${responsibilityTypeLabel[item.responsibilityType]}名称`}
              value={temporarySupplierName[item.responsibilityType] ?? ""}
              disabled={busy}
              onChange={(event) => setTemporarySupplierName((current) => ({ ...current, [item.responsibilityType]: event.target.value }))}
            />
            <Button data-ready={temporaryNameReady ? "true" : "false"} disabled={busy} onClick={() => void createTemporarySupplier(item)}>新增并选择</Button>
          </div>}
        </div>;
      })}
      {visibleUnassigned.some((item) => item.responsibilityType === "processing_factory") && <InsetField
        label="加工厂改选原因"
        value={processingOverrideReason}
        onChange={(event) => setProcessingOverrideReason(event.target.value)}
        placeholder="仅改选加工厂时填写"
      />}
      <Button variant="primary" data-ready={supplierAllocationReady ? "true" : "false"} disabled={busy} onClick={() => void allocate()}>确认供应商</Button>
    </section>}

    {visibleCases.length === 0 && visibleUnassigned.length === 0 && <StatusBadge tone="info">无本类扣款事项。</StatusBadge>}

    <section className="external-case-list">
      {visibleCases.map((caseItem) => {
        const historical = caseItem.batchId !== batch.batchId || batch.status !== "active";
        const caseReadOnly = readOnly || historical;
        const evidence = attachments[caseItem.caseId] ?? [];
        const inputState=deductionInputState(amount[caseItem.caseId]??"",caseItem.actualDeductedAmount,caseItem.proposedDeductionAmount);
        const deductionReady=inputState.ordinary && !uploadingCases[caseItem.caseId];
        const specialReady=!uploadingCases[caseItem.caseId] && (!(amount[caseItem.caseId]??"").trim() || inputState.valid);
        const canRecordDeduction = !caseReadOnly && caseItem.canRecordDeduction;
        const canRequestRevision = !caseReadOnly && caseItem.canRequestRevision;
        const canApproveRevision = !caseReadOnly && caseItem.canApproveRevision;
        const canRequestSpecialApproval = !caseReadOnly && (caseItem.canRequestSpecialApproval || caseItem.canRecordDeduction);
        const canDecideSpecialApproval = !caseReadOnly && caseItem.canDecideSpecialApproval;
        const canLegacySubmit = !caseReadOnly && caseItem.canSign;
        const recoveryClose = !caseReadOnly && caseItem.canClose && caseItem.remainingAmount === "0.00";
        const canAttachEvidence = canRecordDeduction || canRequestSpecialApproval || canRequestRevision || canLegacySubmit;
        const pendingRevision = caseItem.revisionRequests.find((request) => request.status === "pending");
        return <article className="external-case" key={caseItem.caseId}>
          <div className="section-title">
            <div><b>{caseItem.supplier.name}</b><p>{historical ? "历史台账" : caseLabel[caseItem.status]} · {responsibilityTypeLabel[caseItem.responsibilityType]}</p></div>
            <StatusBadge tone={caseItem.status === "closed" ? "success" : caseItem.status === "pending_responsibility_revision" ? "warning" : "info"}>{historical ? "历史台账" : caseLabel[caseItem.status]}</StatusBadge>
          </div>

          <div className="external-finance-summary">
            <div><span>应扣金额</span><strong>{formatBusinessCurrency(caseItem.proposedDeductionAmount)}</strong></div>
            <div><span>累计已扣</span><strong>{formatBusinessCurrency(caseItem.actualDeductedAmount)}</strong></div>
            <div><span>{caseItem.remainingAmount.startsWith("-") ? "超出拟扣" : "剩余"}</span><strong>{formatBusinessCurrency(caseItem.remainingAmount.replace(/^-/u,""))}</strong></div>
          </div>

          {!caseReadOnly && (canRecordDeduction || canRequestSpecialApproval || canDecideSpecialApproval || canRequestRevision || canLegacySubmit || recoveryClose || canApproveRevision) && <div className="external-finance-operation">
            {canRecordDeduction && <InsetField
              label="本次扣款金额"
              inputMode="decimal"
              value={amount[caseItem.caseId] ?? ""}
              onChange={(event) => setAmount((current) => ({ ...current, [caseItem.caseId]: event.target.value }))}
              placeholder="填写本次金额"
            />}
            {canAttachEvidence && <ExternalEvidenceUploader
              scope={caseItem.caseId}
              attachmentIds={evidence}
              disabled={busy}
              onChange={(value) => setAttachments((current) => ({ ...current, [caseItem.caseId]: value }))}
              onMessage={setMessage}
              onUploadingChange={value=>setUploadingCases(current=>({...current,[caseItem.caseId]:value}))}
            />}
            <div className="external-case-actions">
              {canRecordDeduction && <Button variant="primary" data-ready={deductionReady ? "true" : "false"} disabled={busy || !deductionReady} onClick={() => void recordDeduction(caseItem)}>扣款</Button>}
              {recoveryClose && <Button variant="primary" disabled={busy} onClick={() => void finishDeduction(caseItem)}>完成扣款</Button>}
              {canRequestSpecialApproval && <Button disabled={busy || !specialReady} onClick={() => void requestSpecialApproval(caseItem)}>转财务总监特批</Button>}
              {canDecideSpecialApproval && <>
                <Button variant="primary" disabled={busy} onClick={() => void decideSpecialApproval(caseItem, true)}>通过特批</Button>
                <Button disabled={busy} onClick={() => void decideSpecialApproval(caseItem, false)}>退回</Button>
              </>}
              {canRequestRevision && <Button disabled={busy} onClick={() => void requestRevision(caseItem)}>重判责任</Button>}
              {canLegacySubmit && <Button disabled={busy} onClick={() => void submitLegacyCase(caseItem)}>交财务扣款</Button>}
              {canApproveRevision && pendingRevision && <>
                <Button disabled={busy} onClick={() => void decideRevision(caseItem, true)}>通过重判</Button>
                <Button disabled={busy} onClick={() => void decideRevision(caseItem, false)}>驳回重判</Button>
              </>}
            </div>
            {canRecordDeduction && inputState.over && <small role="status">累计超出拟扣 {formatBusinessCurrency(inputState.excess)}，请转财务总监特批。</small>}
            {canRecordDeduction && !inputState.valid && amount[caseItem.caseId]?.trim() && <small role="status">请输入大于 0、最多两位小数的本次金额。</small>}
          </div>}

          {caseItem.deductions.length > 0 && <div className="external-ledger-list external-deduction-history">
            <h4>{historical ? "历史台账扣款记录" : "扣款记录"}</h4>
            {caseItem.deductions.map((entry) => <div key={entry.deductionEntryId}>
              <span>{entry.deductedOn} · {deductionEntryLabel[entry.entryType]}</span>
              <b>{formatBusinessCurrency(entry.amount)}</b>
              <ExternalEvidenceView attachmentIds={entry.attachmentIds} files={caseItem.evidenceAttachments ?? []} />
            </div>)}
          </div>}

          {(caseItem.specialApprovalHistory ?? (caseItem.specialApproval ? [caseItem.specialApproval] : [])).map(request => <div className="external-special-approval" key={request.requestId}>
            <b>财务特批：{request.reason}</b>
            {request.requestMode==="proposed_entry" ? <span>申请金额 {formatBusinessCurrency(request.requestedAmount??"0.00")}，批准后累计 {formatBusinessCurrency(moneyFromCents((parseMoneyToCents(request.actualDeductedAmount)??0n)+(parseMoneyToCents(request.requestedAmount??"0.00")??0n)))} · {request.decision?"总监处理结果如下":"待财务总监审批"}</span> : <span>申请时累计已扣 {formatBusinessCurrency(request.actualDeductedAmount)}，差额 {formatBusinessCurrency(request.remainingAmount)}</span>}
            {request.decision && <span>结果：{request.decision.decision === "approved" ? "已确认（不可修改）" : "已退回"}</span>}
            <ExternalEvidenceView attachmentIds={request.attachmentIds} files={caseItem.evidenceAttachments ?? []} />
          </div>)}

          {caseItem.closure && caseItem.closure.evidenceAttachmentIds.length > 0 && <div className="external-special-approval">
            <b>结案凭证{caseItem.closure.reason ? `：${caseItem.closure.reason}` : ""}</b>
            <ExternalEvidenceView attachmentIds={caseItem.closure.evidenceAttachmentIds} files={caseItem.evidenceAttachments ?? []} />
          </div>}
          {caseItem.followUps.filter(follow => follow.attachmentIds.length > 0).map(follow => <div className="external-special-approval" key={follow.followUpId}>
            <b>跟进凭证：{follow.content}</b>
            <ExternalEvidenceView attachmentIds={follow.attachmentIds} files={caseItem.evidenceAttachments ?? []} />
          </div>)}

          {caseItem.closure?.result === "full" && <StatusBadge tone="success">已足额扣款</StatusBadge>}
          {caseItem.closure?.result === "over_deducted" && <StatusBadge tone="success">超额扣款已特批结案</StatusBadge>}
          {caseItem.revisionRequests.filter((item) => item.seededDeterminationId).map((item) => (
            <StatusBadge key={item.revisionRequestId} tone="success">已进入 N08 重新判责</StatusBadge>
          ))}
        </article>;
      })}
    </section>
  </Surface>;
}
