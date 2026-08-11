import {
  AttachmentResponseSchema,
  MAX_REWORK_ATTACHMENTS,
  ReworkInitiationOptionsResponseSchema,
  ReworkOrderResponseSchema,
  UploadIntentResponseSchema,
  type CreateReworkDraft,
  type ReworkInitiationOptionsResponse,
  type ReworkOrderResponse,
} from "@dx-rework/contracts";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { FactorySearch } from "./factory-search.js";
import { SearchSelect } from "./search-select.js";
import {
  executeReworkSubmit,
  isReworkFormMutationAllowed,
  type PendingSubmitAttempt,
} from "./rework-submission.js";
import {
  isImageAttachment,
  isSupportedAttachment,
  mapWithConcurrency,
  prepareAttachmentForUpload,
  sha256Hex,
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

const statusText = (status: ReworkOrderResponse["status"]): string => {
  if (status === "pending_process_configuration") return "已提交 · 待李同生配置工序";
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

export function ReworkInitiationForm() {
  const initialDraftId = new URLSearchParams(window.location.search).get("draft");
  const [form, setForm] = useState<FormState>(emptyForm);
  const [options, setOptions] = useState<ReworkInitiationOptionsResponse>({
    merchandisers: [],
    factories: [],
  });
  const [order, setOrder] = useState<ReworkOrderResponse | null>(null);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [uploadedAttachments, setUploadedAttachments] = useState<UploadedAttachment[]>([]);
  const [message, setMessage] = useState(initialDraftId ? "草稿加载中…" : "填写中，尚未保存");
  const [busy, setBusy] = useState(false);
  const [restoringDraft, setRestoringDraft] = useState(Boolean(initialDraftId));
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
    const onVisibility = () => {
      if (document.visibilityState === "visible") loadOptions();
    };
    loadOptions();
    window.addEventListener("focus", loadOptions);
    document.addEventListener("visibilitychange", onVisibility);
    if (initialDraftId) {
      void request(
        `rework-orders/${initialDraftId}`,
        ReworkOrderResponseSchema,
        { signal: controller.signal },
      ).then((loaded) => {
        if (!active) return;
        setOrder(loaded);
        setForm(toForm(loaded));
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
      window.removeEventListener("focus", loadOptions);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

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

  const payload = (): CreateReworkDraft => ({
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
    problemPart: optionalText(form.problemPart),
    problemDescription: optionalText(form.problemDescription),
    reworkQuantity: form.reworkQuantity === ""
      ? null
      : Number(form.reworkQuantity),
    attachmentIds,
  });

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
    if (!order) {
      const url = new URL(window.location.href);
      url.searchParams.set("draft", saved.reworkOrderId);
      window.history.replaceState({}, "", url);
    }
    return saved;
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
    if (!window.confirm("确认提交返工单？")) return;
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
      setOrder(submitted);
      setMessage(`${submitted.reworkNo ?? ""} 已提交，待李同生配置工序`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "返工单提交失败");
    } finally {
      setBusy(false);
    }
  };

  const transition = async (action: "withdraw" | "cancel") => {
    if (!order || !isReworkFormMutationAllowed({ busy, uploading, restoringDraft })) return;
    const reason = window.prompt(action === "withdraw" ? "请输入撤回原因" : "请输入取消原因");
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
    setMessage(`正在优化并上传 ${selected.length} 份 QC 附件…`);
    try {
      const prepared = await mapWithConcurrency(selected, 2, prepareAttachmentForUpload);
      const uploaded = await mapWithConcurrency(prepared, 2, async (file): Promise<UploadedAttachment> => {
        const sha256 = await sha256Hex(file);
        const intent = await request(
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
        );
        const upload = new FormData();
        for (const [name, value] of Object.entries(intent.uploadFields)) upload.append(name, value);
        upload.append("file", file);
        const response = await fetch(intent.uploadUrl, { method: "POST", body: upload });
        if (!response.ok) throw new Error(`${file.name} 上传失败`);
        const finalized = await request(
          `tools/attachments/${intent.attachmentId}/finalize`,
          AttachmentResponseSchema,
          { method: "POST" },
        );
        const previewUrl = isImageAttachment(file) ? URL.createObjectURL(file) : null;
        if (previewUrl) previewUrls.current.push(previewUrl);
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
      setMessage(`${nextIds.length} 份 QC 附件已就绪，请保存草稿`);
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
  const complete = Boolean(
    form.styleNo.trim()
    && form.merchandiserUserId
    && form.factory
    && form.problemPart.trim()
    && form.problemDescription.trim()
    && Number.isInteger(Number(form.reworkQuantity))
    && Number(form.reworkQuantity) > 0,
  );
  const badgeTone = order?.status === "cancelled"
    ? "danger"
    : order?.status === "pending_process_configuration"
      ? "success"
      : "info";
  const showStatus = Boolean(order) || message !== "填写中，尚未保存";

  return (
    <div className="mobile-page">
      <div className="mobile-hero">
        <div className="mobile-title">
          <h1>发起返工</h1>
          {order?.reworkNo && <StatusBadge tone="info">{order.reworkNo}</StatusBadge>}
        </div>
        <StatusBadge tone={badgeTone}>{statusText(order?.status ?? "draft")}</StatusBadge>
      </div>

      <Surface>
        <div className="section-title">
          <h2>返工基本信息</h2>
          <StatusBadge tone={locked ? "warning" : "info"}>
            一张返工单一个款号
          </StatusBadge>
        </div>
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
            label="款号（必填）"
            value={form.styleNo}
            disabled={formDisabled}
            onChange={(event) => setForm({ ...form, styleNo: event.target.value })}
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
      </Surface>

      <Surface>
        <h2>返工问题与数量</h2>
        <div className="qc-form-grid">
          <InsetField
            label="返工原因（可补充）"
            value={form.reworkReason}
            disabled={formDisabled}
            onChange={(event) => setForm({ ...form, reworkReason: event.target.value })}
          />
          <InsetField
            label="返工工序（可补充）"
            value={form.reworkProcess}
            disabled={formDisabled}
            placeholder="例如：车缝、锁眼、后整；多项用逗号分隔"
            onChange={(event) => setForm({ ...form, reworkProcess: event.target.value })}
          />
          <InsetField
            label="问题部位（必填）"
            value={form.problemPart}
            disabled={formDisabled}
            onChange={(event) => setForm({ ...form, problemPart: event.target.value })}
          />
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
          <label className="dx-field qc-wide">
            <span>问题描述（必填）</span>
            <span className="dx-field__control qc-textarea-control">
              <textarea
                aria-label="问题描述"
                rows={4}
                value={form.problemDescription}
                disabled={formDisabled}
                onChange={(event) => setForm({ ...form, problemDescription: event.target.value })}
              />
            </span>
          </label>
        </div>
      </Surface>

      <Surface className="share-preview">
        <div className="section-title">
          <h2>QC 证据</h2>
          <StatusBadge tone={attachmentIds.length > 0 ? "success" : "info"}>
            {attachmentIds.length} 份
          </StatusBadge>
        </div>
        <p>支持 JPG、PNG、WebP 与 PDF；每张返工单最多 {MAX_REWORK_ATTACHMENTS} 张。图片会先在本机压缩，保留清晰度后再上传。</p>
        {!formDisabled && (
          <>
            <label className="qc-file-button">
              <span>{uploading ? "正在优化并上传…" : attachmentIds.length >= MAX_REWORK_ATTACHMENTS ? `已达到 ${MAX_REWORK_ATTACHMENTS} 张上限` : "选择 QC 图片 / PDF"}</span>
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
                  ? <img src={attachment.previewUrl} alt={attachment.filename} />
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
      </Surface>

      {showStatus && (
        <Surface className="qc-status">
          <p role="status">{message}</p>
        </Surface>
      )}

      {!locked && (
        <div className="mobile-actions">
          <Button disabled={mutationDisabled} onClick={() => void save()}>
            {busy ? "处理中…" : restoringDraft ? "草稿加载中…" : "保存草稿"}
          </Button>
          <Button
            variant="primary"
            disabled={mutationDisabled || !complete}
            onClick={() => void submit()}
          >
            提交返工
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
    </div>
  );
}
