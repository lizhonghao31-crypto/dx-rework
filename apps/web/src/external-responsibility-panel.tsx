import {
  ExternalResponsibilityBatchResponseSchema,
  ExternalResponsibilityCaseResponseSchema,
  type ExternalResponsibilityBatchResponse,
  type ExternalResponsibilityCaseResponse,
  type ExternalResponsibilityRequestedChange,
} from "@dx-rework/contracts/external-responsibility";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { shanghaiBusinessDate } from "./business-date.js";
import { ExternalEvidenceUploader } from "./external-evidence-uploader.js";
import { SearchSelect } from "./search-select.js";
import { confirmInApp } from "./system-dialog.js";
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
type CaseStatus =
  NonNullable<ExternalResponsibilityBatchResponse>["cases"][number]["status"];
type ResponsibilityType =
  NonNullable<ExternalResponsibilityBatchResponse>["items"][number]["responsibilityType"];
type DeductionEntryType =
  ExternalResponsibilityCaseResponse["deductions"][number]["entryType"];
type ClosureResult = NonNullable<ExternalResponsibilityCaseResponse["closure"]>["result"];

const caseLabel: Record<CaseStatus, string> = {
  pending_business_signoff: "待补充资料",
  pending_payables_confirmation: "待记录扣款",
  deduction_follow_up: "扣款跟进中",
  returned: "资料已退回",
  pending_responsibility_revision: "待责任变更审核",
  closed: "扣款已关闭",
  superseded: "已由新责任版本替代",
};

const responsibilityTypeLabel: Record<ResponsibilityType, string> = {
  processing_factory: "加工厂",
  embroidery_factory: "印绣花厂",
  washing_factory: "洗水厂",
  fabric_supplier: "面料供应商",
};

const deductionEntryLabel: Record<DeductionEntryType, string> = {
  deduction: "实际扣款",
  adjustment: "扣款调整",
  reversal: "扣款冲销",
};

const closureResultLabel: Record<ClosureResult, string> = {
  full: "已全额扣款",
  partial: "部分扣款",
  not_deducted: "未扣成功",
};

const bpsToPercent = (bps: number): string => {
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
};

const processName = (snapshot: Record<string, unknown>): string => {
  const value = snapshot.processName;
  return typeof value === "string" && value.trim() ? value.trim() : "工序";
};

const formatBusinessTime = (value: string | null): string => {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
};

const requiredSupplierType = (
  type: ResponsibilityType,
): Supplier["supplierType"] =>
  type === "processing_factory"
    ? "factory"
    : type === "fabric_supplier"
      ? "fabric"
      : "embroidery_washing";

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
  readOnly = false,
}: {
  reworkOrderId: string | null;
  focusCaseId?: string;
  readOnly?: boolean;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [temporarySupplierName, setTemporarySupplierName] = useState<Partial<Record<ResponsibilityType, string>>>({});
  const [processingOverrideReason, setProcessingOverrideReason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [remark, setRemark] = useState<Record<string, string>>({});
  const [supplierFeedback, setSupplierFeedback] = useState<Record<string, string>>({});
  const [nextFollowUpAt, setNextFollowUpAt] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState<Record<string, string>>({});
  const [deductedOn, setDeductedOn] = useState<Record<string, string>>({});
  const [deductionReference, setDeductionReference] = useState<Record<string, string>>({});
  const [attachments, setAttachments] =
    useState<Record<string, string[]>>({});
  const [differenceDisposition, setDifferenceDisposition] =
    useState<Record<string, string>>({});
  const [revisionToOwnFactory, setRevisionToOwnFactory] =
    useState<Record<string, boolean>>({});
  const pendingMutationKeys = useRef<Record<string, string>>({});

  const load = async (): Promise<ExternalResponsibilityBatchResponse> => {
    if (!reworkOrderId) return null;
    const response = await fetch(
      apiUrl(`rework-orders/${reworkOrderId}/external-responsibilities`),
      {
        credentials: "include",
        headers: { accept: "application/json" },
      },
    );
    if (response.status === 403) {
      setState({ kind: "hidden" });
      return null;
    }
    if (!response.ok) throw new Error(await requestError(response));
    const value = ExternalResponsibilityBatchResponseSchema.parse(
      await response.json(),
    );
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
      if (!batch || !hasUnassigned) return [] as Supplier[];
      const response = await fetch(
        apiUrl(`rework-orders/${reworkOrderId}/external-responsibilities/supplier-options`),
        {
          credentials: "include",
          signal: controller.signal,
          headers: { accept: "application/json" },
        },
      );
      if (response.status === 403) return [] as Supplier[];
      if (!response.ok) throw new Error(await requestError(response));
      return await response.json() as Supplier[];
    }).then((catalog) => {
      setSuppliers(catalog);
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setState({
          kind: "unavailable",
          message: error instanceof Error
            ? error.message
            : "外部责任台账加载失败",
        });
      }
    });
    return () => controller.abort();
  }, [readOnly, reworkOrderId]);

  const unassigned = useMemo(
    () =>
      state.kind === "ready" && state.value
        ? state.value.items.filter(
            (item) =>
              !state.value!.cases.some((entry) =>
                entry.items.some(
                  (mapped) => mapped.externalItemId === item.externalItemId,
                )
              ),
          )
        : [],
    [state],
  );

  const createTemporarySupplier = async (
    item: NonNullable<ExternalResponsibilityBatchResponse>["items"][number],
  ): Promise<void> => {
    const supplierName = temporarySupplierName[item.responsibilityType]?.trim() ?? "";
    if (!supplierName) {
      setMessage(`请先填写${responsibilityTypeLabel[item.responsibilityType]}名称。`);
      return;
    }
    const supplierType = requiredSupplierType(item.responsibilityType);
    const signature = `temporary-supplier:${reworkOrderId}:${supplierType}:${supplierName}`;
    const idempotencyKey = pendingMutationKeys.current[signature] ?? crypto.randomUUID();
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
      const selected = catalog.find(
        (supplier) => supplier.supplierId === created.supplierId,
      );
      if (!selected) {
        throw new Error("供应商已新增，但未能重新读取可选名录，请刷新后重试。");
      }
      delete pendingMutationKeys.current[signature];
      setSuppliers(catalog);
      setSelection((current) => ({ ...current, [item.externalItemId]: selected.supplierId }));
      setTemporarySupplierName((current) => ({ ...current, [item.responsibilityType]: "" }));
      setMessage(`${supplierName} 已新增到供应商名录并自动选中。`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "新增供应商失败");
    } finally {
      setBusy(false);
    }
  };

  const mutationKey = (signature: string): string => {
    const existing = pendingMutationKeys.current[signature];
    if (existing) return existing;
    const next = crypto.randomUUID();
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
    const result = ExternalResponsibilityCaseResponseSchema.parse(
      await response.json(),
    );
    delete pendingMutationKeys.current[signature];
    return result;
  };

  const refresh = async (success: string): Promise<void> => {
    await load();
    setMessage(success);
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
        setMessage("请为每个外部责任项目选择实际拟扣供应商。");
        return;
      }
      const key = `${item.responsibilityType}:${supplierId}`;
      let current = grouped.get(key);
      if (!current) {
        current = {
          responsibilityType: item.responsibilityType,
          supplierId,
          externalItemIds: [],
        };
        const reason = processingOverrideReason.trim();
        if (item.responsibilityType === "processing_factory" && reason) {
          current.processingFactoryOverrideReason = reason;
        }
        grouped.set(key, current);
      }
      current.externalItemIds.push(item.externalItemId);
    }
    setBusy(true);
    setMessage("");
    const path = `external-responsibility-batches/${state.value.batchId}/allocate-suppliers`;
    const body = {
      expectedBatchVersion: state.value.batchVersion,
      allocations: [...grouped.values()],
    };
    const signature = `batch:${path}:${JSON.stringify(body)}`;
    try {
      const response = await fetch(
        apiUrl(path),
        {
          method: "POST",
          credentials: "include",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": mutationKey(signature),
          },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) throw new Error(await requestError(response));
      const value = ExternalResponsibilityBatchResponseSchema.parse(
        await response.json(),
      );
      delete pendingMutationKeys.current[signature];
      setState({ kind: "ready", value });
      setMessage(
        "供应商与拟扣台账已锁定，下一步已直接交给对应应付记录扣款。",
      );
    } catch (error: unknown) {
      setMessage(
        error instanceof Error ? error.message : "供应商分配失败",
      );
    } finally {
      setBusy(false);
    }
  };

  const requestedChange = (
    caseItem: ExternalResponsibilityCaseResponse,
    note: string,
  ): ExternalResponsibilityRequestedChange => {
    const configurationItemIds = caseItem.items.map(
      (item) => item.configurationItemId,
    );
    if (
      caseItem.closure
      && caseItem.closure.remainingAmount !== "0.00"
      && revisionToOwnFactory[caseItem.caseId] === true
    ) {
      return {
        kind: "remaining_difference_to_own_factory",
        configurationItemIds,
      };
    }
    return {
      kind: "other",
      configurationItemIds,
      summary: note,
    };
  };

  const operation = async (
    caseItem: ExternalResponsibilityCaseResponse,
    kind:
      | "submit"
      | "return"
      | "follow"
      | "deduct"
      | "close-full"
      | "close-partial"
      | "close-none"
      | "revision"
      | "revision-approve"
      | "revision-reject",
  ): Promise<void> => {
    if (busy) return;
    const note = remark[caseItem.caseId]?.trim() ?? "";
    const files = attachments[caseItem.caseId] ?? [];
    const disposition = differenceDisposition[caseItem.caseId]?.trim() ?? "";
    if (
      ["return", "follow", "close-partial", "close-none", "revision"].includes(kind)
      && !note
    ) {
      setMessage("当前操作必须填写原因或跟进内容。");
      return;
    }
    if (kind === "follow") {
      const nextValue = nextFollowUpAt[caseItem.caseId]?.trim() ?? "";
      if (nextValue) {
        const nextDate = new Date(nextValue);
        if (Number.isNaN(nextDate.getTime()) || nextDate.getTime() <= Date.now()) {
          setMessage("下次跟进时间必须有效且晚于当前时间。");
          return;
        }
      }
    }
    if (kind === "deduct") {
      const deductionAmount = amount[caseItem.caseId]?.trim() ?? "";
      const deductionDate = deductedOn[caseItem.caseId] ?? shanghaiBusinessDate();
      if (!/^\d+(?:\.\d{1,2})?$/.test(deductionAmount) || Number(deductionAmount) <= 0) {
        setMessage("请先填写大于 0、最多两位小数的实际扣款金额。");
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deductionDate) || deductionDate > shanghaiBusinessDate()) {
        setMessage("实际扣款日期必须有效且不能晚于今天。");
        return;
      }
    }
    if (kind === "close-partial" || kind === "close-none") {
      if (files.length === 0) {
        setMessage("部分扣款或未扣成功关闭必须先上传扣款结果证据。");
        return;
      }
      if (!disposition) {
        setMessage("部分扣款或未扣成功关闭必须填写剩余差额最终处理方式。");
        return;
      }
    }
    if (kind.startsWith("close")) {
      const closeLabel = kind === "close-full"
        ? "按全额扣款关闭"
        : kind === "close-partial"
          ? "按部分扣款关闭"
          : "按未扣成功关闭";
      if (!(await confirmInApp(`确认${closeLabel}？关闭后本条扣款台账进入终局状态；如后续需要改责任，必须通过责任变更重新进入 N07。`))) {
        return;
      }
    }
    if (
      kind === "revision-approve"
      && !(await confirmInApp("确认通过责任变更？通过后会生成新的 N07 判责草稿，并按新责任版本重新进入后续处理。"))
    ) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      if (kind === "submit") {
        await send(
          `external-responsibility-cases/${caseItem.caseId}/submit`,
          {
            expectedCaseVersion: caseItem.caseVersion,
            remark: note || undefined,
            attachmentIds: files,
          },
        );
      }
      if (kind === "return") {
        await send(
          `external-responsibility-cases/${caseItem.caseId}/payables-return`,
          {
            expectedCaseVersion: caseItem.caseVersion,
            reason: note,
            attachmentIds: files,
          },
        );
      }
      if (kind === "follow") {
        const feedback = supplierFeedback[caseItem.caseId]?.trim() ?? "";
        const nextValue = nextFollowUpAt[caseItem.caseId]?.trim() ?? "";
        await send(
          `external-responsibility-cases/${caseItem.caseId}/follow-ups`,
          {
            expectedCaseVersion: caseItem.caseVersion,
            content: note,
            ...(feedback ? { supplierFeedback: feedback } : {}),
            ...(nextValue ? { nextFollowUpAt: new Date(nextValue).toISOString() } : {}),
            attachmentIds: files,
          },
        );
        setSupplierFeedback((current) => ({ ...current, [caseItem.caseId]: "" }));
        setNextFollowUpAt((current) => ({ ...current, [caseItem.caseId]: "" }));
      }
      if (kind === "deduct") {
        const referenceNo = deductionReference[caseItem.caseId]?.trim() ?? "";
        await send(
          `external-responsibility-cases/${caseItem.caseId}/deductions`,
          {
            expectedCaseVersion: caseItem.caseVersion,
            entryType: "deduction",
            amount: amount[caseItem.caseId]!.trim(),
            deductedOn: deductedOn[caseItem.caseId] ?? shanghaiBusinessDate(),
            ...(referenceNo ? { referenceNo } : {}),
            attachmentIds: files,
          },
        );
        setAmount((current) => ({ ...current, [caseItem.caseId]: "" }));
        setDeductedOn((current) => ({ ...current, [caseItem.caseId]: shanghaiBusinessDate() }));
        setDeductionReference((current) => ({ ...current, [caseItem.caseId]: "" }));
      }
      if (kind.startsWith("close")) {
        const result = kind === "close-full"
          ? "full"
          : kind === "close-partial"
            ? "partial"
            : "not_deducted";
        await send(
          `external-responsibility-cases/${caseItem.caseId}/close`,
          {
            expectedCaseVersion: caseItem.caseVersion,
            result,
            reason: result === "full" ? undefined : note,
            evidenceAttachmentIds: result === "full" ? [] : files,
            remainingDifferenceDisposition: result === "full" ? undefined : disposition,
          },
        );
      }
      if (kind === "revision") {
        await send(
          `external-responsibility-cases/${caseItem.caseId}/revision-requests`,
          {
            expectedCaseVersion: caseItem.caseVersion,
            requestedChange: requestedChange(caseItem, note),
            reason: note,
            attachmentIds: files,
          },
        );
      }
      if (kind === "revision-approve" || kind === "revision-reject") {
        const pending = caseItem.revisionRequests.find(
          (request) => request.status === "pending",
        );
        if (!pending) throw new Error("当前责任变更申请已被处理");
        await send(
          `external-responsibility-revision-requests/${pending.revisionRequestId}/${
            kind === "revision-approve" ? "approve" : "reject"
          }`,
          {
            expectedCaseVersion: caseItem.caseVersion,
            expectedRevisionVersion: pending.revisionVersion,
            reason: note || undefined,
          },
        );
      }
      setAttachments((current) => ({
        ...current,
        [caseItem.caseId]: [],
      }));
      setRemark((current) => ({ ...current, [caseItem.caseId]: "" }));
      setRevisionToOwnFactory((current) => ({ ...current, [caseItem.caseId]: false }));
      await refresh(
        kind === "revision-approve"
          ? "责任变更已批准，并已生成可继续编辑的 N07 判责草稿。"
          : kind === "follow"
            ? "扣款跟进已记录；设置了下次跟进时间的事项会在到期未更新时进入逾期提示。"
            : "操作已写入服务端台账；金额、权限与当前责任版本已重新核验。",
      );
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === "hidden") return null;
  if (state.kind === "loading") {
    return <Surface className="external-state">正在核验外部责任台账权限…</Surface>;
  }
  if (state.kind === "unavailable") {
    return <Surface className="external-state">{state.message}</Surface>;
  }
  if (!state.value) {
    return <Surface className="external-state">本单没有供应商责任金额，无需供应商扣款。</Surface>;
  }

  const batch = state.value;
  const visibleCases = focusCaseId
    ? batch.cases.filter((caseItem) => caseItem.caseId === focusCaseId)
    : batch.cases;
  const visibleUnassigned = readOnly || focusCaseId ? [] : unassigned;
  if (focusCaseId && visibleCases.length === 0) {
    return <Surface className="external-state">该供应商扣款任务不在当前有效台账中。</Surface>;
  }
  return (
    <Surface className="external-responsibility-panel">
      <div className="section-title">
        <div>
          <h2>{readOnly ? "责任结算台账" : "供应商扣款处理"}</h2>
          <p>{readOnly
            ? `责任版本 V${batch.finalizedDeterminationVersion} 已由系统自动生成；供应商与倍率已在 N07 核验、N08 签字，台账不可改写。`
            : `责任版本 V${batch.finalizedDeterminationVersion} · 每个责任方独立记录实际扣款；资料有误可申请责任变更返回 N07。`}</p>
        </div>
        <StatusBadge tone={batch.status === "active" ? "info" : "warning"}>
          {batch.status === "active" ? "当前责任版本" : "已替代历史"}
        </StatusBadge>
      </div>
      {message && <div className="own-factory-approval-message" role="status">{message}</div>}

      {visibleUnassigned.length > 0 && (
        <section className="external-operation">
          <h3>选择实际拟扣供应商</h3>
          <p>每个正式责任项目只能覆盖到一个有效供应商台账；系统不接受浏览器传入的拟扣金额。</p>
          {visibleUnassigned.map((item) => {
            const matchingSuppliers = suppliers.filter(
              (supplier) => supplier.supplierType === requiredSupplierType(item.responsibilityType),
            );
            return (
              <div className="external-operation-grid" key={item.externalItemId}>
                <span>{processName(item.processSnapshot)} · {responsibilityTypeLabel[item.responsibilityType]} · 服务端拟扣 ¥{item.proposedAmount}</span>
                <SearchSelect
                  options={matchingSuppliers.map((supplier) => ({
                    value: supplier.supplierId,
                    label: supplier.supplierName,
                  }))}
                  value={selection[item.externalItemId] ?? ""}
                  placeholder={matchingSuppliers.length ? "输入供应商名称搜索" : "没有匹配类型的供应商"}
                  emptyText="没有匹配的供应商"
                  ariaLabel={`供应商 ${processName(item.processSnapshot)}`}
                  disabled={busy || matchingSuppliers.length === 0}
                  onChange={(supplierId) => setSelection((current) => ({
                    ...current,
                    [item.externalItemId]: supplierId,
                  }))}
                />
                {matchingSuppliers.length === 0 && (
                  <div className="external-temporary-supplier">
                    <InsetField
                      label={`新增${responsibilityTypeLabel[item.responsibilityType]}名称`}
                      value={temporarySupplierName[item.responsibilityType] ?? ""}
                      disabled={busy}
                      onChange={(event) => setTemporarySupplierName((current) => ({
                        ...current,
                        [item.responsibilityType]: event.target.value,
                      }))}
                      placeholder="名录中暂无可选项时，在此临时新增"
                    />
                    <Button disabled={busy} onClick={() => void createTemporarySupplier(item)}>
                      新增并选择
                    </Button>
                    <small>新增后保留在供应商名录，供后续返工和扣款复用。</small>
                  </div>
                )}
              </div>
            );
          })}
          {visibleUnassigned.some((item) => item.responsibilityType === "processing_factory") && (
            <InsetField
              label="加工厂改选原因"
              value={processingOverrideReason}
              onChange={(event) => setProcessingOverrideReason(event.target.value)}
              placeholder="仅当实际拟扣加工厂不同于返工单加工厂时必填"
            />
          )}
          <Button variant="primary" disabled={busy} onClick={() => void allocate()}>锁定供应商与拟扣台账</Button>
        </section>
      )}

      {visibleCases.length === 0 && visibleUnassigned.length === 0 && (
        <StatusBadge tone="info">当前外部责任项目金额均为 0.00，不创建无意义扣款台账。</StatusBadge>
      )}

      <section className="external-case-list">
        {visibleCases.map((caseItem) => {
          const pendingRevision = caseItem.revisionRequests.find((request) => request.status === "pending");
          const evidence = attachments[caseItem.caseId] ?? [];
          const canSign = !readOnly && caseItem.canSign;
          const canPayablesConfirm = !readOnly && caseItem.canPayablesConfirm;
          const canFollowUp = !readOnly && caseItem.canFollowUp;
          const canRecordDeduction = !readOnly && caseItem.canRecordDeduction;
          const canClose = !readOnly && caseItem.canClose;
          const canRequestRevision = !readOnly && caseItem.canRequestRevision;
          const canApproveRevision = !readOnly && caseItem.canApproveRevision;
          const canEditRemark = canSign
            || canPayablesConfirm
            || canFollowUp
            || canClose
            || canRequestRevision
            || canApproveRevision;
          const canEditDisposition = canClose || canRequestRevision;
          const canAttachEvidence = canSign
            || canPayablesConfirm
            || canFollowUp
            || canRecordDeduction
            || canClose
            || canRequestRevision;
          const hasEditableFields = canEditRemark
            || canEditDisposition
            || canRecordDeduction
            || canAttachEvidence;
          return (
            <article className="external-case" key={caseItem.caseId}>
              <div>
                <div className="section-title">
                  <b>{caseLabel[caseItem.status]} · {caseItem.supplier.name}</b>
                  <StatusBadge tone={caseItem.status === "returned" ? "danger" : caseItem.status === "deduction_follow_up" ? "warning" : "info"}>
                    {responsibilityTypeLabel[caseItem.responsibilityType]}
                  </StatusBadge>
                </div>
                <small>拟扣 ¥{caseItem.proposedDeductionAmount} · 累计实扣 ¥{caseItem.actualDeductedAmount} · 未扣差额 ¥{caseItem.remainingAmount}</small>
                <div className="external-ledger-list">
                  {caseItem.items.map((item) => (
                    <div key={item.externalItemId}>
                      <span>{processName(item.processSnapshot)} · 倍率 ×{item.multiplierSnapshot} · 责任 {bpsToPercent(item.shareBpsSnapshot)}</span>
                      <b>¥{item.proposedAmount}</b>
                    </div>
                  ))}
                </div>
              </div>

              {!readOnly && <div className="external-case-actions">
                {canSign && (
                  <Button disabled={busy} onClick={() => void operation(caseItem, "submit")}>
                    {caseItem.status === "returned" ? "资料已修正，重新交应付" : "补充资料并交应付"}
                  </Button>
                )}
                {canPayablesConfirm && (
                  <Button disabled={busy} onClick={() => void operation(caseItem, "return")}>退回资料问题</Button>
                )}
                {canFollowUp && <Button disabled={busy} onClick={() => void operation(caseItem, "follow")}>新增跟进</Button>}
                {canRecordDeduction && <Button variant="primary" disabled={busy} onClick={() => void operation(caseItem, "deduct")}>记录实际扣款</Button>}
                {canClose && <>
                  <Button disabled={busy} onClick={() => void operation(caseItem, "close-full")}>按全额关闭</Button>
                  <Button disabled={busy} onClick={() => void operation(caseItem, "close-partial")}>按部分关闭</Button>
                  <Button disabled={busy} onClick={() => void operation(caseItem, "close-none")}>登记未扣成功</Button>
                </>}
                {canRequestRevision && <Button disabled={busy} onClick={() => void operation(caseItem, "revision")}>申请责任变更</Button>}
                {canApproveRevision && pendingRevision && <>
                  <Button disabled={busy} onClick={() => void operation(caseItem, "revision-approve")}>通过责任变更</Button>
                  <Button disabled={busy} onClick={() => void operation(caseItem, "revision-reject")}>驳回责任变更</Button>
                </>}
              </div>}

              {hasEditableFields && <div className="external-operation">
                {canEditRemark && <InsetField
                  label="处理说明 / 跟进内容"
                  value={remark[caseItem.caseId] ?? ""}
                  onChange={(event) => setRemark((current) => ({ ...current, [caseItem.caseId]: event.target.value }))}
                  placeholder="退回资料、跟进、部分/未扣或责任变更时填写"
                />}
                {canFollowUp && <>
                  <InsetField
                    label="供应商反馈（选填）"
                    value={supplierFeedback[caseItem.caseId] ?? ""}
                    onChange={(event) => setSupplierFeedback((current) => ({ ...current, [caseItem.caseId]: event.target.value }))}
                    placeholder="例如：已确认，预计本周五完成扣款"
                  />
                  <InsetField
                    label="下次跟进时间（选填）"
                    type="datetime-local"
                    value={nextFollowUpAt[caseItem.caseId] ?? ""}
                    onChange={(event) => setNextFollowUpAt((current) => ({ ...current, [caseItem.caseId]: event.target.value }))}
                  />
                  <small>设置下次跟进时间后，如到期仍没有新的跟进记录，外部扣款队列会提示逾期。</small>
                </>}
                {canEditDisposition && <InsetField
                  label="未扣差额最终处理"
                  value={differenceDisposition[caseItem.caseId] ?? caseItem.closure?.remainingDifferenceDisposition ?? ""}
                  onChange={(event) => setDifferenceDisposition((current) => ({ ...current, [caseItem.caseId]: event.target.value }))}
                  placeholder="部分/未扣关闭时必填，例如：申请转本厂承担并进入责任重判"
                />}
                {canRequestRevision && caseItem.closure && caseItem.closure.remainingAmount !== "0.00" && (
                  <label className="external-revision-choice">
                    <input
                      type="checkbox"
                      checked={revisionToOwnFactory[caseItem.caseId] === true}
                      onChange={(event) => setRevisionToOwnFactory((current) => ({
                        ...current,
                        [caseItem.caseId]: event.target.checked,
                      }))}
                      disabled={busy}
                    />
                    <span>将未扣差额转为本厂承担，并进入 N07 重新判责</span>
                  </label>
                )}
                {canRecordDeduction && <>
                  <InsetField
                    label="实际扣款金额"
                    inputMode="decimal"
                    value={amount[caseItem.caseId] ?? ""}
                    onChange={(event) => setAmount((current) => ({ ...current, [caseItem.caseId]: event.target.value }))}
                    placeholder="仅记录本次实际扣款；系统自动累计"
                  />
                  <InsetField
                    label="实际扣款日期"
                    type="date"
                    max={shanghaiBusinessDate()}
                    value={deductedOn[caseItem.caseId] ?? shanghaiBusinessDate()}
                    onChange={(event) => setDeductedOn((current) => ({ ...current, [caseItem.caseId]: event.target.value }))}
                  />
                  <InsetField
                    label="扣款凭证号（选填）"
                    maxLength={200}
                    value={deductionReference[caseItem.caseId] ?? ""}
                    onChange={(event) => setDeductionReference((current) => ({ ...current, [caseItem.caseId]: event.target.value }))}
                    placeholder="例如：付款单号、对账单号或银行流水号"
                  />
                </>}
                {canAttachEvidence && <ExternalEvidenceUploader
                  attachmentIds={evidence}
                  disabled={busy}
                  onChange={(value) => setAttachments((current) => ({ ...current, [caseItem.caseId]: value }))}
                  onMessage={setMessage}
                />}
              </div>}

              {caseItem.followUps.length > 0 && <div className="external-ledger-list">
                {caseItem.followUps.map((followUp) => (
                  <div key={followUp.followUpId}>
                    <span>
                      跟进 {formatBusinessTime(followUp.createdAt)} · {followUp.content}
                      {followUp.supplierFeedback ? ` · 供应商反馈：${followUp.supplierFeedback}` : ""}
                    </span>
                    <b>{followUp.nextFollowUpAt ? `下次 ${formatBusinessTime(followUp.nextFollowUpAt)}` : "已记录"}</b>
                  </div>
                ))}
              </div>}
              {caseItem.deductions.length > 0 && <div className="external-ledger-list">
                {caseItem.deductions.map((entry) => (
                  <div key={entry.deductionEntryId}>
                    <span>{deductionEntryLabel[entry.entryType]} · {entry.deductedOn} · {entry.referenceNo ?? "无凭证号"}</span>
                    <b>¥{entry.amount}</b>
                  </div>
                ))}
              </div>}
              {caseItem.closure && <StatusBadge tone={caseItem.closure.result === "full" ? "success" : "warning"}>
                {closureResultLabel[caseItem.closure.result]} · 剩余 ¥{caseItem.closure.remainingAmount}
              </StatusBadge>}
              {caseItem.revisionRequests.filter((item) => item.seededDeterminationId).map((item) => (
                <StatusBadge key={item.revisionRequestId} tone="success">责任变更已通过，已生成新的 N07 判责草稿</StatusBadge>
              ))}
            </article>
          );
        })}
      </section>
    </Surface>
  );
}
