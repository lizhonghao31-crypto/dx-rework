import {
  AttachmentResponseSchema,
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
import { executeReworkSubmit, type PendingSubmitAttempt } from "./rework-submission.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

type FormState = {
  styleNo: string;
  orderNo: string;
  merchandiserUserId: string;
  factory: string;
  problemPart: string;
  problemDescription: string;
  reworkQuantity: string;
};
type PendingKey = { action: string; fingerprint: string; key: string };
type ApiSchema<T> = { parse(value: unknown): T };

const emptyForm: FormState = {
  styleNo: "",
  orderNo: "",
  merchandiserUserId: "",
  factory: "",
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
  orderNo: order.orderNo ?? "",
  merchandiserUserId: order.merchandiserUserId ?? "",
  factory: order.processingFactory?.type === "supplier"
    ? `supplier:${order.processingFactory.supplierId}`
    : order.processingFactory?.type === "own_factory"
      ? "own_factory"
      : "",
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
  const [uploadedNames, setUploadedNames] = useState<string[]>([]);
  const [message, setMessage] = useState("填写中，尚未保存");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const pendingKey = useRef<PendingKey | null>(null);
  const pendingSubmit = useRef<PendingSubmitAttempt | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void request(
      "rework-orders/initiation-options",
      ReworkInitiationOptionsResponseSchema,
      { signal: controller.signal },
    ).then(setOptions).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setMessage(error instanceof Error ? error.message : "基础资料加载失败");
      }
    });
    if (initialDraftId) {
      void request(
        `rework-orders/${initialDraftId}`,
        ReworkOrderResponseSchema,
        { signal: controller.signal },
      ).then((loaded) => {
        setOrder(loaded);
        setForm(toForm(loaded));
        setAttachmentIds(loaded.attachmentIds);
        setMessage(statusText(loaded.status));
      }).catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setMessage(error instanceof Error ? error.message : "草稿加载失败");
        }
      });
    }
    return () => controller.abort();
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
    orderNo: optionalText(form.orderNo),
    merchandiserUserId: optionalText(form.merchandiserUserId),
    processingFactory: form.factory === "own_factory"
      ? { type: "own_factory" }
      : form.factory.startsWith("supplier:")
        ? { type: "supplier", supplierId: form.factory.slice("supplier:".length) }
        : null,
    problemPart: optionalText(form.problemPart),
    problemDescription: optionalText(form.problemDescription),
    reworkQuantity: form.reworkQuantity === ""
      ? null
      : Number(form.reworkQuantity),
    attachmentIds,
  });

  const persistDraft = async (): Promise<ReworkOrderResponse> => {
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
    pendingSubmit.current = null;
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
    if (!window.confirm("确认提交返工单并通知李同生配置工序？")) return;
    setBusy(true);
    try {
      const submitted = await executeReworkSubmit(
        order,
        pendingSubmit.current,
        persistDraft,
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
    if (!order) return;
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
    if (!files?.length) return;
    setUploading(true);
    try {
      const nextIds = [...attachmentIds];
      const nextNames = [...uploadedNames];
      for (const file of Array.from(files)) {
        if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.type)) {
          throw new Error(`${file.name} 不是支持的图片或PDF`);
        }
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
        const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
        const uploaded = await fetch(intent.uploadUrl, { method: "POST", body: upload });
        if (!uploaded.ok) throw new Error(`${file.name} 上传失败`);
        const finalized = await request(
          `tools/attachments/${intent.attachmentId}/finalize`,
          AttachmentResponseSchema,
          { method: "POST" },
        );
        nextIds.push(finalized.attachmentId);
        nextNames.push(file.name);
      }
      setAttachmentIds(nextIds);
      setUploadedNames(nextNames);
      pendingKey.current = null;
      setMessage(`${nextIds.length} 份QC附件已就绪，请保存草稿`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "附件上传失败");
    } finally {
      setUploading(false);
    }
  };

  const locked = order?.status === "pending_process_configuration"
    || order?.status === "cancelled";
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

  return (
    <main className="mobile-page">
      <div className="mobile-hero">
        <div className="mobile-title">
          <h1>发起返工</h1>
          {order?.reworkNo && <StatusBadge tone="info">{order.reworkNo}</StatusBadge>}
        </div>
        <p>品控现场录入 · 提交后通知李同生</p>
        <StatusBadge tone={badgeTone}>{statusText(order?.status ?? "draft")}</StatusBadge>
      </div>

      <Surface>
        <div className="section-title">
          <h2>返工基本信息</h2>
          <StatusBadge tone={locked ? "warning" : "info"}>
            一单一个款号
          </StatusBadge>
        </div>
        <div className="qc-form-grid">
          <InsetField
            label="款号（必填）"
            value={form.styleNo}
            disabled={locked}
            onChange={(event) => setForm({ ...form, styleNo: event.target.value })}
          />
          <InsetField
            label="订单号（知道时填写）"
            value={form.orderNo}
            disabled={locked}
            onChange={(event) => setForm({ ...form, orderNo: event.target.value })}
          />
          <label className="dx-field">
            <span>订单跟单（必填）</span>
            <span className="dx-field__control">
              <select
                aria-label="订单跟单"
                value={form.merchandiserUserId}
                disabled={locked}
                onChange={(event) => setForm({ ...form, merchandiserUserId: event.target.value })}
              >
                <option value="">请选择订单跟单</option>
                {options.merchandisers.map((item) => (
                  <option key={item.userId} value={item.userId}>{item.displayName}</option>
                ))}
              </select>
            </span>
          </label>
          <label className="dx-field">
            <span>加工厂（必填）</span>
            <span className="dx-field__control">
              <select
                aria-label="加工厂"
                value={form.factory}
                disabled={locked}
                onChange={(event) => setForm({ ...form, factory: event.target.value })}
              >
                <option value="">请选择加工厂</option>
                <option value="own_factory">本厂</option>
                {options.factories.map((item) => (
                  <option key={item.supplierId} value={`supplier:${item.supplierId}`}>
                    {item.supplierName}
                  </option>
                ))}
              </select>
            </span>
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
            label="问题部位（必填）"
            value={form.problemPart}
            disabled={locked}
            onChange={(event) => setForm({ ...form, problemPart: event.target.value })}
          />
          <InsetField
            label="返工数量（必填）"
            type="number"
            min="1"
            step="1"
            value={form.reworkQuantity}
            disabled={locked}
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
                disabled={locked}
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
        <p>支持 JPG、PNG、WebP 与 PDF；上传完成后随草稿一并绑定。</p>
        {!locked && (
          <>
            <label className="qc-file-button">
              <span>{uploading ? "附件上传中…" : "选择QC图片 / PDF"}</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                multiple
                disabled={uploading || busy}
                onChange={(event) => void uploadFiles(event.target.files)}
              />
            </label>
            {attachmentIds.length > 0 && (
              <Button
                className="qc-clear-attachments"
                disabled={uploading || busy}
                onClick={() => {
                  setAttachmentIds([]);
                  setUploadedNames([]);
                  pendingKey.current = null;
                  setMessage("附件已从当前表单移除，请保存草稿确认");
                }}
              >
                移除全部附件
              </Button>
            )}
          </>
        )}
        {uploadedNames.length > 0 && (
          <ul className="qc-upload-list">
            {uploadedNames.map((name, index) => <li key={`${name}-${index}`}>{name}</li>)}
          </ul>
        )}
      </Surface>

      <Surface className="qc-status">
        <h2>当前结果</h2>
        <p role="status">{message}</p>
      </Surface>

      {!locked && (
        <div className="mobile-actions">
          <Button disabled={busy || uploading} onClick={() => void save()}>
            {busy ? "处理中…" : "保存草稿"}
          </Button>
          <Button
            variant="primary"
            disabled={busy || uploading || !complete}
            onClick={() => void submit()}
          >
            预览提交并通知
          </Button>
        </div>
      )}

      {order?.status === "pending_process_configuration" && (
        <div className="qc-secondary-actions">
          <Button disabled={busy} onClick={() => void transition("withdraw")}>撤回修改</Button>
          <Button disabled={busy} onClick={() => void transition("cancel")}>取消返工单</Button>
        </div>
      )}
      {order?.status === "draft" && order.reworkOrderId && (
        <div className="qc-cancel-draft">
          <Button disabled={busy} onClick={() => void transition("cancel")}>取消此草稿</Button>
        </div>
      )}
    </main>
  );
}
