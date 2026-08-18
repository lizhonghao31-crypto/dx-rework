import {
  AttachmentResponseSchema,
  MAX_REWORK_ATTACHMENTS,
  ReworkInitiationOptionsResponseSchema,
  ReworkOrderResponseSchema,
  UploadIntentResponseSchema,
  type CreateReworkDraft,
  type InspectionReportDraft,
  type ReworkInitiationOptionsResponse,
  type ReworkOrderResponse,
} from "@dx-rework/contracts";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { FactorySearch } from "./factory-search.js";
import { HistorySearchInput } from "./history-search-input.js";
import { confirmInApp, promptInApp } from "./system-dialog.js";
import {
  createEmptyInspectionReport,
  InspectionReportStepOne,
  InspectionReportStepThree,
  InspectionReportStepTwo,
  inspectionStepComplete,
} from "./inspection-report-form.js";
import { SearchSelect } from "./search-select.js";
import {
  executeReworkSubmit,
  isReworkFormMutationAllowed,
  type PendingSubmitAttempt,
} from "./rework-submission.js";
import {
  currentUploadClientProfile,
  isImageAttachment,
  currentQcUploadConcurrency,
  isSupportedAttachment,
  measureAttachmentUploadStage,
  prepareAndUploadWithConcurrency,
  prepareAttachmentForUpload,
  sha256Hex,
  type AttachmentUploadTimingContext,
} from "./attachment-upload.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

type FormState = {
  styleNo: string;
  customerSupplyCode: string;
  factoryStyleNo: string;
  orderNo: string;
  orderQuantity: string;
  merchandiserUserId: string;
  factory: string;
  reworkReason: string;
  reworkProcess: string;
  problemPart: string;
  problemDescription: string;
  reworkQuantity: string;
};
type PendingKey = { action: string; fingerprint: string; key: string };
type ManualEntryPage = 1 | 2 | 3 | 4 | 5;
type ApiSchema<T> = { parse(value: unknown): T };
type UploadedAttachment = Readonly<{
  attachmentId: string;
  filename: string;
  mimeType: string;
  previewUrl: string | null;
}>;

const emptyForm: FormState = {
  styleNo: "",
  customerSupplyCode: "",
  factoryStyleNo: "",
  orderNo: "",
  orderQuantity: "",
  merchandiserUserId: "",
  factory: "",
  reworkReason: "",
  reworkProcess: "",
  problemPart: "",
  problemDescription: "",
  reworkQuantity: "",
};

const optionalText = (value: string): string | null => {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const createDefaultInspectionReport = (): InspectionReportDraft => ({
  ...createEmptyInspectionReport(),
  inspectionLocation: "仓库",
});

const manualEntryPageTitles = ["订单补充", "尺寸核验", "资料与面辅料", "问题与结论", "返工补充"] as const;

const statusText = (status: ReworkOrderResponse["status"]): string => {
  if (status === "pending_process_configuration") return "已提交 · 待当前有效尾部主管配置工序";
  if (status === "cancelled") return "已取消 · 资料保留";
  return "可保存草稿";
};

const errorMessage = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? "请求未完成，请稍后重试";
  } catch {
    return "请求未完成，请稍后重试";
  }
};

async function request<T>(
  path: string,
  schema: ApiSchema<T>,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return schema.parse(await response.json());
}

const toForm = (order: ReworkOrderResponse): FormState => ({
  styleNo: order.styleNo ?? "",
  customerSupplyCode: order.customerSupplyCode ?? "",
  factoryStyleNo: order.factoryStyleNo ?? "",
  orderNo: order.orderNo ?? "",
  orderQuantity: order.orderQuantity?.toString() ?? "",
  merchandiserUserId: order.merchandiserUserId ?? "",
  factory: order.processingFactory?.type === "supplier"
    ? `supplier:${order.processingFactory.supplierId}`
    : order.processingFactory?.type === "own_factory"
      ? "own_factory"
      : "",
  reworkReason: order.reworkReason ?? "",
  reworkProcess: order.reworkProcess ?? "",
  problemPart: order.problemPart ?? "",
  problemDescription: order.problemDescription ?? "",
  reworkQuantity: order.reworkQuantity?.toString() ?? "",
});

export function ReworkInitiationForm({
  reworkOrderId,
  onOrderChanged,
  embedded = false,
}: {
  reworkOrderId?: string;
  onOrderChanged?: (order: ReworkOrderResponse) => void;
  embedded?: boolean;
} = {}) {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [inspectionReport, setInspectionReport] = useState<InspectionReportDraft>(createDefaultInspectionReport);
  const [formStep, setFormStep] = useState<1 | 2 | 3>(1);
  const [manualEntryPage, setManualEntryPage] = useState<ManualEntryPage>(1);
  const [options, setOptions] = useState<ReworkInitiationOptionsResponse>({
    merchandisers: [],
    factories: [],
  });
  const [order, setOrder] = useState<ReworkOrderResponse | null>(null);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [uploadedAttachments, setUploadedAttachments] = useState<UploadedAttachment[]>([]);
  const [message, setMessage] = useState(reworkOrderId ? "草稿加载中…" : "填写中，尚未保存");
  const [busy, setBusy] = useState(false);
  const [restoringDraft, setRestoringDraft] = useState(Boolean(reworkOrderId));
  const [uploading, setUploading] = useState(false);
  const pendingKey = useRef<PendingKey | null>(null);
  const previewUrls = useRef<string[]>([]);
  const pendingSubmit = useRef<PendingSubmitAttempt | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const loadOptions = () => {
      void request(
        "rework-orders/initiation-options",
        ReworkInitiationOptionsResponseSchema,
        { signal: controller.signal, cache: "no-store" },
      ).then((next) => {
        if (active) setOptions(next);
      }).catch((error: unknown) => {
        if (active && !(error instanceof DOMException && error.name === "AbortError")) {
          setMessage(error instanceof Error ? error.message : "基础资料加载失败");
        }
      });
    };
    loadOptions();
    setForm(emptyForm);
    setInspectionReport(createDefaultInspectionReport());
    setFormStep(1);
    setManualEntryPage(1);
    setOrder(null);
    setAttachmentIds([]);
    setUploadedAttachments([]);
    setMessage(reworkOrderId ? "草稿加载中…" : "填写中，尚未保存");
    setRestoringDraft(Boolean(reworkOrderId));
    if (reworkOrderId) {
      void request(
        `rework-orders/${reworkOrderId}`,
        ReworkOrderResponseSchema,
        { signal: controller.signal },
      ).then((loaded) => {
        if (!active) return;
        setOrder(loaded);
        setForm(toForm(loaded));
        setInspectionReport(loaded.inspectionReport ?? createDefaultInspectionReport());
        setAttachmentIds(loaded.attachmentIds);
        setMessage(statusText(loaded.status));
      }).catch((error: unknown) => {
        if (active && !(error instanceof DOMException && error.name === "AbortError")) {
          setMessage(error instanceof Error ? error.message : "草稿加载失败");
        }
      }).finally(() => {
        if (active) setRestoringDraft(false);
      });
    }
    return () => {
      active = false;
      controller.abort();
    };
  }, [reworkOrderId]);

  useEffect(() => () => {
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const mutationKey = (action: string, payload: unknown): string => {
    const fingerprint = JSON.stringify(payload);
    if (
      pendingKey.current?.action === action
      && pendingKey.current.fingerprint === fingerprint
    ) {
      return pendingKey.current.key;
    }
    const key = crypto.randomUUID();
    pendingKey.current = { action, fingerprint, key };
    return key;
  };

  const payload = (): CreateReworkDraft => {
    const derivedProblemPart = inspectionReport.issues
      .map((issue) => issue.category?.trim())
      .filter((value): value is string => Boolean(value))
      .join("、")
      .slice(0, 200);
    const derivedProblemDescription = inspectionReport.issues
      .map((issue) => issue.description?.trim())
      .filter((value): value is string => Boolean(value))
      .join("；")
      .slice(0, 2000);
    return ({
    styleNo: optionalText(form.styleNo),
    customerSupplyCode: optionalText(form.customerSupplyCode),
    factoryStyleNo: optionalText(form.factoryStyleNo),
    orderNo: optionalText(form.orderNo),
    orderQuantity: form.orderQuantity === "" ? null : Number(form.orderQuantity),
    merchandiserUserId: optionalText(form.merchandiserUserId),
    processingFactory: form.factory === "own_factory"
      ? { type: "own_factory" }
      : form.factory.startsWith("supplier:")
        ? { type: "supplier", supplierId: form.factory.slice("supplier:".length) }
        : null,
    reworkReason: optionalText(form.reworkReason),
    reworkProcess: optionalText(form.reworkProcess),
    problemPart: optionalText(derivedProblemPart || form.problemPart),
    problemDescription: optionalText(derivedProblemDescription || form.problemDescription),
    reworkQuantity: form.reworkQuantity === ""
      ? null
      : Number(form.reworkQuantity),
    inspectionReport,
    attachmentIds,
    });
  };

  const persistDraft = async (clearPendingSubmit = true): Promise<ReworkOrderResponse> => {
    const draftPayload = payload();
    const action = order ? `update:${order.reworkOrderId}` : "create";
    const body = order
      ? { ...draftPayload, expectedVersion: order.version }
      : draftPayload;
    const saved = await request(
      order
        ? `rework-orders/${order.reworkOrderId}/draft`
        : "rework-orders/drafts",
      ReworkOrderResponseSchema,
      {
        method: order ? "PUT" : "POST",
        headers: { "idempotency-key": mutationKey(action, body) },
        body: JSON.stringify(body),
      },
    );
    pendingKey.current = null;
    if (clearPendingSubmit) pendingSubmit.current = null;
    setOrder(saved);
    setAttachmentIds(saved.attachmentIds);
    setMessage(saved.reworkNo ? `${saved.reworkNo} · 草稿已保存` : "草稿已安全保存");
    onOrderChanged?.(saved);
    return saved;
  };

  const resetSubmittedForm = (submitted: ReworkOrderResponse): void => {
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.current = [];
    pendingSubmit.current = null;
    pendingKey.current = null;
    setForm(emptyForm);
    setInspectionReport(createDefaultInspectionReport());
    setFormStep(1);
    setManualEntryPage(1);
    setOrder(null);
    setAttachmentIds([]);
    setUploadedAttachments([]);
    setMessage(`${submitted.reworkNo ?? "返工单"} 已提交，可以直接填写下一张返工单`);
  };

  const save = async () => {
    if (!isReworkFormMutationAllowed({ busy, uploading, restoringDraft })) return;
    setBusy(true);
    try {
      await persistDraft();
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "草稿保存失败");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!isReworkFormMutationAllowed({ busy, uploading, restoringDraft })) return;
    if (!(await confirmInApp("确认提交返工单？"))) return;
    setBusy(true);
    try {
      const submitted = await executeReworkSubmit(
        order,
        pendingSubmit.current,
        () => persistDraft(false),
        (saved) => {
          const attempt: PendingSubmitAttempt = {
            reworkOrderId: saved.reworkOrderId,
            body: { expectedVersion: saved.version },
            key: crypto.randomUUID(),
          };
          pendingSubmit.current = attempt;
          return attempt;
        },
        (attempt) => request(
          `rework-orders/${attempt.reworkOrderId}/submit`,
          ReworkOrderResponseSchema,
          {
            method: "POST",
            headers: { "idempotency-key": attempt.key },
            body: JSON.stringify(attempt.body),
          },
        ),
      );
      pendingSubmit.current = null;
      pendingKey.current = null;
      if (embedded) {
        setOrder(submitted);
        setMessage(`${submitted.reworkNo ?? ""} 已提交，待当前有效尾部主管配置工序`);
        onOrderChanged?.(submitted);
      } else {
        resetSubmittedForm(submitted);
      }
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "返工单提交失败");
    } finally {
      setBusy(false);
    }
  };

  const transition = async (action: "withdraw" | "cancel") => {
    if (!order || !isReworkFormMutationAllowed({ busy, uploading, restoringDraft })) return;
    const reason = await promptInApp(action === "withdraw" ? "请输入撤回原因" : "请输入取消原因");
    if (!reason?.trim()) return;
    setBusy(true);
    const body = { expectedVersion: order.version, reason: reason.trim() };
    try {
      const updated = await request(
        `rework-orders/${order.reworkOrderId}/${action}`,
        ReworkOrderResponseSchema,
        {
          method: "POST",
          headers: { "idempotency-key": mutationKey(`${action}:${order.reworkOrderId}`, body) },
          body: JSON.stringify(body),
        },
      );
      pendingKey.current = null;
      setOrder(updated);
      setMessage(statusText(updated.status));
      onOrderChanged?.(updated);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "状态变更失败");
    } finally {
      setBusy(false);
    }
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length || !isReworkFormMutationAllowed({ busy, uploading, restoringDraft })) return;
    const selected = Array.from(files);
    const firstUnsupported = selected.find((file) => !isSupportedAttachment(file));
    if (firstUnsupported) {
      setMessage(`${firstUnsupported.name} 不是支持的图片或 PDF`);
      return;
    }
    if (attachmentIds.length + selected.length > MAX_REWORK_ATTACHMENTS) {
      setMessage(`每张返工单最多上传 ${MAX_REWORK_ATTACHMENTS} 张附件；请先移除现有图片后再选择。`);
      return;
    }

    setUploading(true);
    setMessage(`正在上传 ${selected.length} 份订单附件…`);
    const uploadConcurrency = currentQcUploadConcurrency();
    let completedUploadCount = 0;
    try {
      const uploaded = await prepareAndUploadWithConcurrency(selected, uploadConcurrency, async (file, index) => {
        setMessage(`正在准备第 ${index + 1}/${selected.length} 份订单附件…`);
        const baseTiming = {
          diagnosticId: crypto.randomUUID(),
          ...currentUploadClientProfile(),
          originalBytes: file.size,
          uploadBytes: file.size,
          mimeType: file.type,
        } satisfies AttachmentUploadTimingContext;
        const prepared = await measureAttachmentUploadStage(
          baseTiming,
          "prepare",
          () => prepareAttachmentForUpload(file),
        );
        const timing = { ...baseTiming, uploadBytes: prepared.size } satisfies AttachmentUploadTimingContext;
        const sha256 = await measureAttachmentUploadStage(timing, "hash", () => sha256Hex(prepared));
        return { file: prepared, sha256, timing };
      }, async ({ file, sha256, timing }, _sourceFile, index): Promise<UploadedAttachment> => {
        setMessage(`正在上传第 ${index + 1}/${selected.length} 份订单附件…`);
        const intent = await measureAttachmentUploadStage(
          timing,
          "intent",
          () => request(
            "tools/attachments/upload-intents",
            UploadIntentResponseSchema,
            {
              method: "POST",
              body: JSON.stringify({
                filename: file.name,
                mimeType: file.type,
                sizeBytes: file.size,
                sha256,
              }),
            },
          ),
        );
        const upload = new FormData();
        for (const [name, value] of Object.entries(intent.uploadFields)) upload.append(name, value);
        upload.append("file", file);
        const response = await measureAttachmentUploadStage(
          timing,
          "oss",
          () => fetch(intent.uploadUrl, { method: "POST", body: upload }),
        );
        if (!response.ok) throw new Error(`${file.name} 上传失败`);
        const finalized = await measureAttachmentUploadStage(
          timing,
          "finalize",
          () => request(
            `tools/attachments/${intent.attachmentId}/finalize`,
            AttachmentResponseSchema,
            { method: "POST" },
          ),
        );
        const previewUrl = isImageAttachment(file) ? URL.createObjectURL(file) : null;
        if (previewUrl) previewUrls.current.push(previewUrl);
        completedUploadCount += 1;
        setMessage(`已完成 ${completedUploadCount}/${selected.length} 份订单附件上传…`);
        return {
          attachmentId: finalized.attachmentId,
          filename: finalized.filename,
          mimeType: finalized.mimeType,
          previewUrl,
        };
      });
      const nextIds = [...attachmentIds, ...uploaded.map((attachment) => attachment.attachmentId)];
      setAttachmentIds(nextIds);
      setUploadedAttachments((current) => [...current, ...uploaded]);
      pendingKey.current = null;
      setMessage(`${nextIds.length} 份订单附件已上传，请保存草稿`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "附件上传失败");
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = (attachment: UploadedAttachment): void => {
    setAttachmentIds((current) => current.filter((id) => id !== attachment.attachmentId));
    setUploadedAttachments((current) => current.filter((item) => item.attachmentId !== attachment.attachmentId));
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
      previewUrls.current = previewUrls.current.filter((url) => url !== attachment.previewUrl);
    }
    pendingKey.current = null;
    setMessage("附件已从当前表单移除，请保存草稿确认");
  };

  const clearAttachments = (): void => {
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.current = [];
    setAttachmentIds([]);
    setUploadedAttachments([]);
    pendingKey.current = null;
    setMessage("附件已从当前表单移除，请保存草稿确认");
  };

  const locked = order?.status === "pending_process_configuration"
    || order?.status === "cancelled";
  const formDisabled = locked || restoringDraft;
  const mutationDisabled = !isReworkFormMutationAllowed({ busy, uploading, restoringDraft });
  const requiredFieldsComplete = [
    Boolean(form.styleNo.trim()),
    Boolean(form.factory),
    Boolean(inspectionReport.styleName?.trim()),
    Boolean(inspectionReport.color?.trim()),
    Boolean(inspectionReport.inspectionStage),
    Boolean(inspectionReport.inspectionLocation?.trim()),
    Number.isInteger(Number(form.orderQuantity)) && Number(form.orderQuantity) > 0,
    Number.isInteger(inspectionReport.sampleQuantity) && (inspectionReport.sampleQuantity ?? 0) > 0,
    attachmentIds.length > 0,
  ];
  const requiredCompletionCount = requiredFieldsComplete.filter(Boolean).length;
  const complete = requiredCompletionCount === requiredFieldsComplete.length;
  const badgeTone = order?.status === "cancelled"
    ? "danger"
    : order?.status === "pending_process_configuration"
      ? "success"
      : "info";
  const showStatus = Boolean(order) || message !== "填写中，尚未保存";
  const paperEntryMode = true;

  return (
    <div className={`mobile-page rework-initiation-page${embedded ? " rework-initiation-page--embedded" : ""}`}>
      {paperEntryMode ? (
        <>
          <div className="mobile-hero rework-initiation-hero">
            <div className="mobile-title">
              <h1>发起返工</h1>
              <StatusBadge tone={badgeTone}>{order?.reworkNo ?? "草稿未保存"}</StatusBadge>
            </div>
            <p className="rework-initiation-hero__progress">填写下方八项基本资料即可创建订单；图片统一作为订单附件保存。</p>
          </div>

          <Surface className="rework-paper-entry">
            <div className="section-title">
              <div><h2>订单附件</h2><p>提交前至少上传 1 张验货或问题图片；PDF 仅作补充附件，最多 6 份。</p></div>
              <StatusBadge tone={attachmentIds.length ? "success" : "info"}>{attachmentIds.length} 份</StatusBadge>
            </div>
            {!formDisabled && (
              <label className="qc-file-button rework-paper-entry__upload">
                  <span>{uploading ? "正在上传…" : attachmentIds.length >= MAX_REWORK_ATTACHMENTS ? "已达到 " + MAX_REWORK_ATTACHMENTS + " 份上限" : "上传验货 / 问题图片"}</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  disabled={mutationDisabled || attachmentIds.length >= MAX_REWORK_ATTACHMENTS}
                  onChange={(event) => {
                    void uploadFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
              </label>
            )}
            {uploadedAttachments.length > 0 && (
              <div className="qc-upload-preview-list" aria-label="已上传的订单附件">
                {uploadedAttachments.map((attachment) => (
                  <article className="qc-upload-preview" key={attachment.attachmentId}>
                    {attachment.previewUrl
                      ? <a href={attachment.previewUrl} rel="noreferrer" target="_blank" aria-label={"预览 " + attachment.filename}><img src={attachment.previewUrl} alt={attachment.filename} /></a>
                      : <span className="qc-upload-preview__pdf">PDF</span>}
                    <div><strong title={attachment.filename}>{attachment.filename}</strong><small>{attachment.mimeType.startsWith("image/") ? "图片可在订单详情查看" : "PDF 附件"}</small></div>
                    {!formDisabled && <div className="rework-paper-entry__item-actions">
                      <Button disabled={mutationDisabled} onClick={() => removeAttachment(attachment)}>移除</Button>
                    </div>}
                  </article>
                ))}
              </div>
            )}
          </Surface>

          <Surface className="rework-initiation-required rework-core-fields">
            <div className="section-title">
              <div><h2>订单基本资料</h2><p>以下资料与至少一张验货或问题图片为创建订单的必填内容。</p></div>
              <StatusBadge tone={complete ? "success" : "info"}>已填 {requiredCompletionCount}/{requiredFieldsComplete.length}</StatusBadge>
            </div>
            <div className="qc-form-grid rework-core-fields__grid">
              <label className="dx-field"><span>供应商（必填）</span><span className="dx-field__control factory-search-control"><FactorySearch factories={options.factories} value={form.factory} disabled={formDisabled} onChange={(factory) => setForm({ ...form, factory })} /></span></label>
              <InsetField label="款号（必填）" value={form.styleNo} disabled={formDisabled} onChange={(event) => setForm({ ...form, styleNo: event.target.value })} />
              <InsetField label="款式（必填）" value={inspectionReport.styleName ?? ""} disabled={formDisabled} onChange={(event) => setInspectionReport({ ...inspectionReport, styleName: optionalText(event.target.value) })} />
              <label className="dx-field"><span>颜色（必填）</span><span className="dx-field__control search-select-control"><HistorySearchInput options={options.colorSuggestions ?? []} value={inspectionReport.color ?? ""} placeholder="输入或选择历史颜色" ariaLabel="颜色" disabled={formDisabled} onChange={(color) => setInspectionReport({ ...inspectionReport, color: optionalText(color) })} /></span></label>
              <label className="dx-field"><span>验货阶段（必填）</span><span className="dx-field__control"><select value={inspectionReport.inspectionStage ?? ""} disabled={formDisabled} onChange={(event) => setInspectionReport({ ...inspectionReport, inspectionStage: event.target.value ? event.target.value as InspectionReportDraft["inspectionStage"] : null })}><option value="">请选择</option><option value="midline">中查</option><option value="final">尾查</option><option value="warehouse">仓检</option><option value="reinspection">复检</option></select></span></label>
              <InsetField label="验货地址（必填）" value={inspectionReport.inspectionLocation ?? ""} disabled={formDisabled} onChange={(event) => setInspectionReport({ ...inspectionReport, inspectionLocation: optionalText(event.target.value) })} />
              <InsetField label="订单数量（必填）" type="number" min="1" step="1" suffix="件" value={form.orderQuantity} disabled={formDisabled} onChange={(event) => setForm({ ...form, orderQuantity: event.target.value })} />
              <InsetField label="抽检数量（必填）" type="number" min="1" step="1" suffix="件" value={inspectionReport.sampleQuantity?.toString() ?? ""} disabled={formDisabled} onChange={(event) => setInspectionReport({ ...inspectionReport, sampleQuantity: event.target.value === "" ? null : Number(event.target.value) })} />
            </div>
          </Surface>

          <Surface className="rework-initiation-optional rework-manual-entry">
            <details>
              <summary><span>手动录入</span><small className="rework-manual-entry__toggle" aria-hidden="true" /></summary>
              <p>按页面补充完整报告；左右切换时不会丢失已填写内容，也不影响八项资料创建订单。</p>
              <div className="rework-manual-entry__page-heading">
                <strong>{manualEntryPageTitles[manualEntryPage - 1]}</strong>
                <span>{manualEntryPage}/5</span>
              </div>
              <div className="rework-manual-entry__viewport">
                {manualEntryPage === 1 && <div className="qc-form-grid rework-manual-entry__order-fields">
                  <label className="dx-field"><span>订单跟单（可补充）</span><span className="dx-field__control search-select-control"><SearchSelect options={options.merchandisers.map((item) => ({ value: item.userId, label: item.displayName }))} value={form.merchandiserUserId} placeholder={options.merchandisers.length ? "输入姓名搜索订单跟单" : "暂无可选订单跟单"} emptyText="没有匹配的订单跟单" disabled={formDisabled} onChange={(merchandiserUserId) => setForm({ ...form, merchandiserUserId })} /></span></label>
                  <InsetField label="订单号（可补充）" maxLength={100} value={form.orderNo} disabled={formDisabled} onChange={(event) => setForm({ ...form, orderNo: event.target.value })} />
                  <InsetField label="客供代号（可补充）" value={form.customerSupplyCode} disabled={formDisabled} onChange={(event) => setForm({ ...form, customerSupplyCode: event.target.value })} />
                  <InsetField label="工厂货号（可补充）" value={form.factoryStyleNo} disabled={formDisabled} onChange={(event) => setForm({ ...form, factoryStyleNo: event.target.value })} />
                </div>}
                {manualEntryPage === 2 && <InspectionReportStepOne report={inspectionReport} disabled={formDisabled} onChange={setInspectionReport} hideBasicFields />}
                {manualEntryPage === 3 && <InspectionReportStepTwo report={inspectionReport} disabled={formDisabled} onChange={setInspectionReport} />}
                {manualEntryPage === 4 && <InspectionReportStepThree report={inspectionReport} disabled={formDisabled} onChange={setInspectionReport} />}
                {manualEntryPage === 5 && <div className="qc-form-grid rework-manual-entry__order-fields">
                  <InsetField label="返工数量（可补充）" type="number" min="1" step="1" suffix="件" value={form.reworkQuantity} disabled={formDisabled} onChange={(event) => setForm({ ...form, reworkQuantity: event.target.value })} />
                  <InsetField label="返工原因（可补充）" value={form.reworkReason} disabled={formDisabled} onChange={(event) => setForm({ ...form, reworkReason: event.target.value })} />
                  <InsetField label="返工工序（可补充）" value={form.reworkProcess} disabled={formDisabled} onChange={(event) => setForm({ ...form, reworkProcess: event.target.value })} />
                </div>}
              </div>
              <nav className="rework-manual-entry__navigation" aria-label="手动录入分页">
                <Button disabled={manualEntryPage === 1} onClick={() => setManualEntryPage((manualEntryPage - 1) as ManualEntryPage)}>← 上一页</Button>
                <div>
                  {manualEntryPageTitles.map((title, index) => {
                    const page = (index + 1) as ManualEntryPage;
                    return <button key={title} type="button" className={manualEntryPage === page ? "is-active" : ""} aria-label={`第 ${page} 页：${title}`} onClick={() => setManualEntryPage(page)}>{page}</button>;
                  })}
                </div>
                <Button disabled={manualEntryPage === 5} onClick={() => setManualEntryPage((manualEntryPage + 1) as ManualEntryPage)}>下一页 →</Button>
              </nav>
            </details>
          </Surface>

          {showStatus && <Surface className="qc-status"><p role="status">{message}</p></Surface>}
          {!locked && <div className="mobile-actions rework-initiation-actions"><Button disabled={mutationDisabled} onClick={() => void save()}>{busy ? "处理中…" : restoringDraft ? "草稿加载中…" : "保存草稿"}</Button><Button variant="primary" disabled={mutationDisabled || !complete} onClick={() => void submit()}>提交返工</Button></div>}
        </>
      ) : (
        <>
      {embedded ? (
        <div className="rework-initiation-embedded-heading">
          <div>
            <h2>编辑返工草稿</h2>
            <p>保存后可继续填写；正式提交后将进入下一处理节点。</p>
          </div>
          <StatusBadge tone={badgeTone}>{order?.reworkNo ?? "草稿"}</StatusBadge>
        </div>
      ) : (
        <div className="mobile-hero rework-initiation-hero">
          <div className="mobile-title">
            <h1>发起返工</h1>
            <StatusBadge tone={badgeTone}>{order?.reworkNo ?? "草稿未保存"}</StatusBadge>
          </div>
          <p className="rework-initiation-hero__progress">
            第 {formStep}/3 步 · 完成度 {requiredCompletionCount}/{requiredFieldsComplete.length} · {complete ? "可以提交" : "可随时保存草稿"}
          </p>
        </div>
      )}

      {formStep === 1 && <Surface className="rework-initiation-required">
        <div className="section-title">
          <div><h2>订单与责任资料</h2><p>先确认款号、跟单和加工厂。</p></div>
          <StatusBadge tone={locked ? "warning" : "info"}>必填</StatusBadge>
        </div>
        <div className="qc-form-grid">
          <InsetField
            label="款号（必填）"
            value={form.styleNo}
            disabled={formDisabled}
            onChange={(event) => setForm({ ...form, styleNo: event.target.value })}
          />
          <small className="rework-initiation-style-hint">一张返工单一个款号</small>
          <label className="dx-field">
            <span>订单跟单（必填）</span>
            <span className="dx-field__control search-select-control">
              <SearchSelect
                options={options.merchandisers.map((item) => ({ value: item.userId, label: item.displayName }))}
                value={form.merchandiserUserId}
                placeholder={options.merchandisers.length ? "输入姓名搜索订单跟单" : "暂无可选订单跟单"}
                emptyText="没有匹配的订单跟单"
                disabled={formDisabled}
                onChange={(merchandiserUserId) => setForm({ ...form, merchandiserUserId })}
              />
            </span>
            {!formDisabled && options.merchandisers.length === 0 ? (
              <small>暂无可选订单跟单；请先在权限管理分配“订单跟单”角色。</small>
            ) : null}
          </label>
          <label className="dx-field">
            <span>加工厂（必填）</span>
            <span className="dx-field__control factory-search-control">
              <FactorySearch
                factories={options.factories}
                value={form.factory}
                disabled={formDisabled}
                onChange={(factory) => setForm({ ...form, factory })}
              />
            </span>
            {!formDisabled && options.factories.length === 0 ? (
              <small>除本厂外暂无加工厂；可在“基础资料”维护。</small>
            ) : null}
          </label>
        </div>
        {order?.hasOtherOpenStyleOrder && (
          <p className="qc-warning">同款号存在其他未完结单；系统仅提示，不会自动合并。</p>
        )}
      </Surface>}

      {formStep === 1 && <Surface className="rework-initiation-optional">
        <details>
          <summary>
            <span>更多订单资料（可补充）</span>
            <small>展开</small>
          </summary>
          <p>客供代号、工厂货号、订单数量与订单号不影响先保存草稿。</p>
          <div className="qc-form-grid">
            <InsetField
              label="客供代号（可补充）"
              value={form.customerSupplyCode}
              disabled={formDisabled}
              onChange={(event) => setForm({ ...form, customerSupplyCode: event.target.value })}
            />
            <InsetField
              label="工厂货号（可补充）"
              value={form.factoryStyleNo}
              disabled={formDisabled}
              onChange={(event) => setForm({ ...form, factoryStyleNo: event.target.value })}
            />
            <InsetField
              label="订单数量（可补充）"
              type="number"
              min="1"
              step="1"
              value={form.orderQuantity}
              disabled={formDisabled}
              suffix="件"
              onChange={(event) => setForm({ ...form, orderQuantity: event.target.value })}
            />
            <InsetField
              label="订单号（可填多个，知道时填写）"
              maxLength={100}
              value={form.orderNo}
              disabled={formDisabled}
              placeholder="多个订单号用逗号分隔，例如：PO001，PO002"
              onChange={(event) => setForm({ ...form, orderNo: event.target.value })}
            />
          </div>
        </details>
      </Surface>}

      {formStep === 1 && (
        <InspectionReportStepOne report={inspectionReport} disabled={formDisabled} onChange={setInspectionReport} />
      )}

      {formStep === 2 && (
        <InspectionReportStepTwo report={inspectionReport} disabled={formDisabled} onChange={setInspectionReport} />
      )}

      {formStep === 3 && (
        <>
          <InspectionReportStepThree report={inspectionReport} disabled={formDisabled} onChange={setInspectionReport} />
          <Surface className="inspection-section">
            <div className="section-title"><div><h2>返工处理</h2><p>问题部位和描述由上方验货问题自动生成，继续补充返工数量与处理要求。</p></div></div>
            <div className="qc-form-grid">
              <InsetField
                label="返工数量（必填）"
                type="number"
                min="1"
                step="1"
                value={form.reworkQuantity}
                disabled={formDisabled}
                suffix="件"
                onChange={(event) => setForm({ ...form, reworkQuantity: event.target.value })}
              />
              <InsetField label="返工原因（可补充）" value={form.reworkReason} disabled={formDisabled} onChange={(event) => setForm({ ...form, reworkReason: event.target.value })} />
              <InsetField label="返工工序（可补充）" value={form.reworkProcess} disabled={formDisabled} placeholder="例如：车缝、锁眼、后整" onChange={(event) => setForm({ ...form, reworkProcess: event.target.value })} />
            </div>
          </Surface>
        </>
      )}

      {formStep === 3 && <Surface className="share-preview rework-initiation-evidence">
        <div className="section-title">
          <h2>QC 证据</h2>
          <StatusBadge tone={attachmentIds.length > 0 ? "success" : "info"}>
            {attachmentIds.length} 份
          </StatusBadge>
        </div>
        <p>支持 JPG、PNG、WebP 与 PDF；上传后请保存草稿。</p>
        {!formDisabled && (
          <>
            <label className="qc-file-button">
              <span>{uploading ? "正在上传…" : attachmentIds.length >= MAX_REWORK_ATTACHMENTS ? "已达到 " + MAX_REWORK_ATTACHMENTS + " 份上限" : "选择 QC 图片 / PDF"}</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                multiple
                disabled={mutationDisabled || attachmentIds.length >= MAX_REWORK_ATTACHMENTS}
                onChange={(event) => {
                  void uploadFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
            {attachmentIds.length > 0 && (
              <Button
                className="qc-clear-attachments"
                disabled={mutationDisabled}
                onClick={clearAttachments}
              >
                移除全部附件
              </Button>
            )}
          </>
        )}
        {uploadedAttachments.length > 0 && (
          <div className="qc-upload-preview-list" aria-label="已选择的 QC 附件">
            {uploadedAttachments.map((attachment) => (
              <article className="qc-upload-preview" key={attachment.attachmentId}>
                {attachment.previewUrl
                  ? <a href={attachment.previewUrl} rel="noreferrer" target="_blank" aria-label={"预览 " + attachment.filename}>
                    <img src={attachment.previewUrl} alt={attachment.filename} />
                  </a>
                  : <span className="qc-upload-preview__pdf">PDF</span>}
                <div>
                  <strong title={attachment.filename}>{attachment.filename}</strong>
                  <small>{attachment.mimeType.startsWith("image/") ? "图片可在订单详情继续查看" : "PDF 附件"}</small>
                </div>
                {!formDisabled && (
                  <Button disabled={mutationDisabled} onClick={() => removeAttachment(attachment)}>移除</Button>
                )}
              </article>
            ))}
          </div>
        )}
      </Surface>}

      <nav className="inspection-step-navigation" aria-label="验货报告步骤">
        <Button disabled={formStep === 1} onClick={() => setFormStep((formStep - 1) as 1 | 2 | 3)}>← 上一步</Button>
        <div>
          {[1, 2, 3].map((step) => (
            <button
              key={step}
              type="button"
              className={formStep === step ? "is-active" : inspectionStepComplete(inspectionReport, step as 1 | 2 | 3) ? "is-complete" : ""}
              aria-label={`第 ${step} 步`}
              onClick={() => setFormStep(step as 1 | 2 | 3)}
            >{step}</button>
          ))}
        </div>
        <Button disabled={formStep === 3} onClick={() => setFormStep((formStep + 1) as 1 | 2 | 3)}>下一步 →</Button>
      </nav>

      {showStatus && (
        <Surface className="qc-status">
          <p role="status">{message}</p>
        </Surface>
      )}

      {!locked && (
        <div className="mobile-actions rework-initiation-actions">
          <Button disabled={mutationDisabled} onClick={() => void save()}>
            {busy ? "处理中…" : restoringDraft ? "草稿加载中…" : "保存草稿"}
          </Button>
          <Button
            variant="primary"
            disabled={mutationDisabled || (formStep === 3 && !complete)}
            onClick={() => formStep < 3 ? setFormStep((formStep + 1) as 1 | 2 | 3) : void submit()}
          >
            {formStep < 3 ? "下一步" : "提交返工"}
          </Button>
        </div>
      )}

      {order?.status === "pending_process_configuration" && (
        <div className="qc-secondary-actions">
          <Button disabled={mutationDisabled} onClick={() => void transition("withdraw")}>撤回修改</Button>
          <Button disabled={mutationDisabled} onClick={() => void transition("cancel")}>取消返工单</Button>
        </div>
      )}
      {order?.status === "draft" && order.reworkOrderId && (
        <div className="qc-cancel-draft">
          <Button disabled={mutationDisabled} onClick={() => void transition("cancel")}>取消此草稿</Button>
        </div>
      )}
        </>
      )}
    </div>
  );
}
