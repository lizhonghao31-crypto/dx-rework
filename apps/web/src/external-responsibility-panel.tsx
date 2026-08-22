import {
  ExternalResponsibilityBatchResponseSchema,
  ExternalResponsibilityCaseResponseSchema,
  type ExternalResponsibilityBatchResponse,
  type ExternalResponsibilityCaseResponse,
  type ExternalResponsibilityRequestedChange,
} from "@dx-rework/contracts/external-responsibility";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { ExternalEvidenceUploader } from "./external-evidence-uploader.js";
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

const caseLabel: Record<CaseStatus, string> = {
  pending_business_signoff: "待业务签收",
  pending_payables_confirmation: "待应付确认",
  deduction_follow_up: "扣款跟进中",
  pending_special_approval: "待财务总监特批",
  returned: "应付已退回",
  pending_responsibility_revision: "待责任变更审核",
  closed: "扣款已关闭",
  superseded: "已由新责任版本替代",
};

const requiredSupplierType = (
  type: NonNullable<
    ExternalResponsibilityBatchResponse
  >["items"][number]["responsibilityType"],
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
}: {
  reworkOrderId: string | null;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [processingOverrideReason, setProcessingOverrideReason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [remark, setRemark] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState<Record<string, string>>({});
  const [attachments, setAttachments] =
    useState<Record<string, string[]>>({});
  const [differenceDisposition, setDifferenceDisposition] =
    useState<Record<string, string>>({});

  const load = async (): Promise<void> => {
    if (!reworkOrderId) return;
    const response = await fetch(
      apiUrl(`rework-orders/${reworkOrderId}/external-responsibilities`),
      {
        credentials: "include",
        headers: { accept: "application/json" },
      },
    );
    if (response.status === 403) {
      setState({ kind: "hidden" });
      return;
    }
    if (!response.ok) throw new Error(await requestError(response));
    setState({
      kind: "ready",
      value: ExternalResponsibilityBatchResponseSchema.parse(
        await response.json(),
      ),
    });
  };

  useEffect(() => {
    if (!reworkOrderId) {
      setState({ kind: "hidden" });
      return;
    }
    const controller = new AbortController();
    void Promise.all([
      load(),
      fetch(apiUrl("master-data/suppliers"), {
        credentials: "include",
        signal: controller.signal,
        headers: { accept: "application/json" },
      }).then(async (response) => {
        if (!response.ok) throw new Error(await requestError(response));
        return await response.json() as Supplier[];
      }),
    ]).then(([, catalog]) => {
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
  }, [reworkOrderId]);

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

  const send = async (
    path: string,
    body: unknown,
  ): Promise<ExternalResponsibilityCaseResponse> => {
    const response = await fetch(apiUrl(path), {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await requestError(response));
    return ExternalResponsibilityCaseResponseSchema.parse(
      await response.json(),
    );
  };

  const refresh = async (success: string): Promise<void> => {
    await load();
    setMessage(success);
  };

  const allocate = async (): Promise<void> => {
    if (state.kind !== "ready" || !state.value || busy) return;
    const grouped = new Map<string, {
      responsibilityType:
        NonNullable<
          ExternalResponsibilityBatchResponse
        >["items"][number]["responsibilityType"];
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
    try {
      const response = await fetch(
        apiUrl(
          `external-responsibility-batches/${state.value.batchId}/allocate-suppliers`,
        ),
        {
          method: "POST",
          credentials: "include",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            expectedBatchVersion: state.value.batchVersion,
            allocations: [...grouped.values()],
          }),
        },
      );
      if (!response.ok) throw new Error(await requestError(response));
      setState({
        kind: "ready",
        value: ExternalResponsibilityBatchResponseSchema.parse(
          await response.json(),
        ),
      });
      setMessage(
        "供应商与拟扣台账已由服务端锁定，下一步由业务经办人提交签收。",
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
      && (
        caseItem.closure.remainingDifferenceDisposition?.includes("本厂")
        || differenceDisposition[caseItem.caseId]?.includes("本厂")
      )
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
      | "accept"
      | "return"
      | "follow"
      | "deduct"
      | "close-full"
      | "special-request"
      | "special-approve"
      | "special-return"
      | "revision"
      | "revision-approve"
      | "revision-reject",
  ): Promise<void> => {
    if (busy) return;
    const note = remark[caseItem.caseId]?.trim() ?? "";
    const files = attachments[caseItem.caseId] ?? [];
    if (
      ["return", "follow", "special-request", "special-return", "revision"]
        .includes(kind)
      && !note
    ) {
      setMessage("当前操作必须填写原因或跟进内容。");
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
      if (kind === "accept") {
        await send(
          `external-responsibility-cases/${caseItem.caseId}/payables-accept`,
          { expectedCaseVersion: caseItem.caseVersion },
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
        await send(
          `external-responsibility-cases/${caseItem.caseId}/follow-ups`,
          {
            expectedCaseVersion: caseItem.caseVersion,
            content: note,
            attachmentIds: files,
          },
        );
      }
      if (kind === "deduct") {
        await send(
          `external-responsibility-cases/${caseItem.caseId}/deductions`,
          {
            expectedCaseVersion: caseItem.caseVersion,
            entryType: "deduction",
            amount: amount[caseItem.caseId],
            deductedOn: new Date().toISOString().slice(0, 10),
            attachmentIds: files,
          },
        );
      }
      if (kind.startsWith("close")) {
        await send(
          `external-responsibility-cases/${caseItem.caseId}/close`,
          {
            expectedCaseVersion: caseItem.caseVersion,
            result: "full",
            evidenceAttachmentIds: [],
          },
        );
      }
      if (kind === "special-request") {
        await send(
          `external-responsibility-cases/${caseItem.caseId}/special-approval-requests`,
          {
            expectedCaseVersion: caseItem.caseVersion,
            reason: note,
            attachmentIds: files,
          },
        );
      }
      if (kind === "special-approve" || kind === "special-return") {
        const request = caseItem.specialApproval;
        if (!request || request.decision) throw new Error("当前扣款特批已被处理");
        await send(
          `external-responsibility-cases/${caseItem.caseId}/special-approval/${
            kind === "special-approve" ? "approve" : "return"
          }`,
          {
            expectedCaseVersion: caseItem.caseVersion,
            expectedRequestVersion: request.requestVersion,
            reason: note || undefined,
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
      if (
        kind === "revision-approve"
        || kind === "revision-reject"
      ) {
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
      await refresh(
        kind === "revision-approve"
          ? "责任变更已批准，并已生成可继续编辑的 N07 判责草稿。"
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
    return (
      <Surface className="external-state">
        正在核验外部责任台账权限…
      </Surface>
    );
  }
  if (state.kind === "unavailable") {
    return <Surface className="external-state">{state.message}</Surface>;
  }
  if (!state.value) {
    return (
      <Surface className="external-state">
        当前正式责任版本不存在外部责任金额，因此不创建 N08-B 台账。
      </Surface>
    );
  }

  const batch = state.value;
  return (
    <Surface className="external-responsibility-panel">
      <div className="section-title">
        <div>
          <h2>外部责任签收与扣款跟进</h2>
          <p>
            N08-B · 正式责任版本 V{batch.finalizedDeterminationVersion}；
            拟扣、实扣和差额均为独立的服务端事实。
          </p>
        </div>
        <StatusBadge tone={batch.status === "active" ? "info" : "warning"}>
          {batch.status === "active" ? "当前责任版本" : "已替代历史"}
        </StatusBadge>
      </div>
      {message && (
        <div className="own-factory-approval-message" role="status">
          {message}
        </div>
      )}

      {unassigned.length > 0 && (
        <section className="external-operation">
          <h3>选择实际拟扣供应商</h3>
          <p>
            每个正式责任项目只能覆盖到一个有效供应商台账；
            系统不接受浏览器传入的拟扣金额。
          </p>
          {unassigned.map((item) => (
            <div
              className="external-operation-grid"
              key={item.externalItemId}
            >
              <span>
                {String(
                  item.processSnapshot.processName
                    ?? item.configurationItemId,
                )} · {item.responsibilityType} · 服务端拟扣
                ¥{item.proposedAmount}
              </span>
              <select
                aria-label={`供应商 ${item.externalItemId}`}
                value={selection[item.externalItemId] ?? ""}
                onChange={(event) =>
                  setSelection((current) => ({
                    ...current,
                    [item.externalItemId]: event.target.value,
                  }))}
              >
                <option value="">选择匹配供应商</option>
                {suppliers
                  .filter(
                    (supplier) =>
                      supplier.supplierType
                      === requiredSupplierType(item.responsibilityType),
                  )
                  .map((supplier) => (
                    <option
                      key={supplier.supplierId}
                      value={supplier.supplierId}
                    >
                      {supplier.supplierName}
                    </option>
                  ))}
              </select>
            </div>
          ))}
          {unassigned.some(
            (item) => item.responsibilityType === "processing_factory",
          ) && (
            <InsetField
              label="加工厂改选原因"
              value={processingOverrideReason}
              onChange={(event) =>
                setProcessingOverrideReason(event.target.value)}
              placeholder="仅当实际拟扣加工厂不同于返工单加工厂时必填"
            />
          )}
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void allocate()}
          >
            锁定供应商与拟扣台账
          </Button>
        </section>
      )}

      {batch.cases.length === 0 && unassigned.length === 0 && (
        <StatusBadge tone="info">
          当前外部责任项目金额均为 0.00，不创建无意义扣款台账。
        </StatusBadge>
      )}

      <section className="external-case-list">
        {batch.cases.map((caseItem) => {
          const pendingRevision = caseItem.revisionRequests.find(
            (request) => request.status === "pending",
          );
          const evidence = attachments[caseItem.caseId] ?? [];
          return (
            <article className="external-case" key={caseItem.caseId}>
              <div>
                <div className="section-title">
                  <b>
                    {caseLabel[caseItem.status]} · {caseItem.supplier.name}
                  </b>
                  <StatusBadge
                    tone={
                      caseItem.status === "returned"
                        ? "danger"
                        : caseItem.status === "deduction_follow_up"
                          ? "warning"
                          : "info"
                    }
                  >
                    {caseItem.responsibilityType}
                  </StatusBadge>
                </div>
                <small>
                  拟扣 ¥{caseItem.proposedDeductionAmount} · 累计实扣
                  ¥{caseItem.actualDeductedAmount} · 未扣差额
                  ¥{caseItem.remainingAmount} · 版本 {caseItem.caseVersion}
                </small>
                <div className="external-ledger-list">
                  {caseItem.items.map((item) => (
                    <div key={item.externalItemId}>
                      <span>
                        {String(
                          item.processSnapshot.processName
                            ?? item.configurationItemId,
                        )} · 倍率 {item.multiplierSnapshot} ·
                        {" "}{item.shareBpsSnapshot} bps
                      </span>
                      <b>¥{item.proposedAmount}</b>
                    </div>
                  ))}
                </div>
                {caseItem.specialApproval && (
                  <div className="external-special-approval">
                    <b>财务特批：{caseItem.specialApproval.reason}</b>
                    <span>
                      申请时实扣 ¥{caseItem.specialApproval.actualDeductedAmount}
                      ，差额 ¥{caseItem.specialApproval.remainingAmount}
                    </span>
                    {caseItem.specialApproval.decision && (
                      <span>
                        结果：{caseItem.specialApproval.decision.decision === "approved"
                          ? "已确认（不可修改）"
                          : "已退回"}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="external-case-actions">
                {caseItem.canSign && (
                  <Button
                    disabled={busy}
                    onClick={() => void operation(caseItem, "submit")}
                  >
                    提交业务签收
                  </Button>
                )}
                {caseItem.canPayablesConfirm && (
                  <>
                    <Button
                      disabled={busy}
                      onClick={() => void operation(caseItem, "accept")}
                    >
                      应付接受
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => void operation(caseItem, "return")}
                    >
                      退回业务经办
                    </Button>
                  </>
                )}
                {caseItem.canFollowUp && (
                  <Button
                    disabled={busy}
                    onClick={() => void operation(caseItem, "follow")}
                  >
                    新增跟进
                  </Button>
                )}
                {caseItem.canRecordDeduction && (
                  <Button
                    disabled={busy}
                    onClick={() => void operation(caseItem, "deduct")}
                  >
                    记录实际扣款
                  </Button>
                )}
                {caseItem.canClose && (
                  <Button
                    disabled={busy}
                    onClick={() => void operation(caseItem, "close-full")}
                  >
                    确认扣款完成
                  </Button>
                )}
                {caseItem.canRequestSpecialApproval && (
                  <Button
                    disabled={busy}
                    onClick={() => void operation(caseItem, "special-request")}
                  >
                    转财务总监特批
                  </Button>
                )}
                {caseItem.canDecideSpecialApproval && (
                  <>
                    <Button
                      disabled={busy}
                      onClick={() => void operation(caseItem, "special-approve")}
                    >
                      特批确认
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => void operation(caseItem, "special-return")}
                    >
                      退回
                    </Button>
                  </>
                )}
                {caseItem.canRequestRevision && (
                  <Button
                    disabled={busy}
                    onClick={() => void operation(caseItem, "revision")}
                  >
                    申请责任变更
                  </Button>
                )}
                {caseItem.canApproveRevision && pendingRevision && (
                  <>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void operation(caseItem, "revision-approve")}
                    >
                      通过责任变更
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void operation(caseItem, "revision-reject")}
                    >
                      驳回责任变更
                    </Button>
                  </>
                )}
              </div>

              <div className="external-operation">
                <InsetField
                  label="原因 / 退回、特批、变更或审核意见"
                  value={remark[caseItem.caseId] ?? ""}
                  onChange={(event) =>
                    setRemark((current) => ({
                      ...current,
                      [caseItem.caseId]: event.target.value,
                    }))}
                  placeholder="退回、扣款异常特批、责任变更时必填；确认意见可选"
                />
                <InsetField
                  label="未扣差额最终处理"
                  value={
                    differenceDisposition[caseItem.caseId]
                    ?? caseItem.closure?.remainingDifferenceDisposition
                    ?? ""
                  }
                  onChange={(event) =>
                    setDifferenceDisposition((current) => ({
                      ...current,
                      [caseItem.caseId]: event.target.value,
                    }))}
                  placeholder="部分/未扣关闭时必填，例如：申请转本厂承担并进入责任重判"
                />
                <InsetField
                  label="实际扣款金额（仅应付会计）"
                  value={amount[caseItem.caseId] ?? ""}
                  onChange={(event) =>
                    setAmount((current) => ({
                      ...current,
                      [caseItem.caseId]: event.target.value,
                    }))}
                  placeholder="仅记录单笔实际扣款；不计算累计"
                />
                <ExternalEvidenceUploader
                  attachmentIds={evidence}
                  disabled={busy}
                  onChange={(value) =>
                    setAttachments((current) => ({
                      ...current,
                      [caseItem.caseId]: value,
                    }))}
                  onMessage={setMessage}
                />
              </div>

              {caseItem.deductions.length > 0 && (
                <div className="external-ledger-list">
                  {caseItem.deductions.map((entry) => (
                    <div key={entry.deductionEntryId}>
                      <span>
                        {entry.entryType} · {entry.deductedOn} ·
                        {" "}{entry.referenceNo ?? "无凭证号"}
                      </span>
                      <b>¥{entry.amount}</b>
                    </div>
                  ))}
                </div>
              )}
              {caseItem.closure && (
                <StatusBadge
                  tone={
                    caseItem.closure.result === "full"
                      ? "success"
                      : "warning"
                  }
                >
                  关闭结果：{caseItem.closure.result} · 剩余
                  ¥{caseItem.closure.remainingAmount}
                </StatusBadge>
              )}
              {caseItem.revisionRequests
                .filter((item) => item.seededDeterminationId)
                .map((item) => (
                  <StatusBadge
                    key={item.revisionRequestId}
                    tone="success"
                  >
                    已生成 N07 草稿 {item.seededDeterminationId}
                  </StatusBadge>
                ))}
            </article>
          );
        })}
      </section>
    </Surface>
  );
}
