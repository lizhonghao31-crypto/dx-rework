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
import {
  ReworkSupplyContextOptionsResponseSchema,
  ReworkSupplyContextResponseSchema,
  type ReworkSupplyContextOptionsResponse,
} from "@dx-rework/contracts/rework-supply-context";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import {
  currentQcUploadConcurrency,
  currentUploadClientProfile,
  isImageAttachment,
  measureAttachmentUploadStage,
  prepareAndUploadWithConcurrency,
  prepareAttachmentForUpload,
  sha256Hex,
  type AttachmentUploadTimingContext,
} from "./attachment-upload.js";
import { FactorySearch } from "./factory-search.js";
import {
  executeReworkSubmit,
  type PendingSubmitAttempt,
} from "./rework-submission.js";
import { SearchSelect } from "./search-select.js";
import { confirmInApp } from "./system-dialog.js";
import "./rework-v2-form.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

type ApiSchema<T> = Readonly<{ parse(value: unknown): T }>;
type PendingSave = Readonly<{ fingerprint: string; key: string }>;
type UploadedImage = Readonly<{
  attachmentId: string;
  filename: string;
  mimeType: string;
  previewUrl: string;
}>;
type ReworkInitiationV2FormProps = Readonly<{
  reworkOrderId?: string;
  embedded?: boolean;
  existingAttachmentCount?: number;
  onOrderChanged?: () => Promise<void> | void;
}>;

type V2FormState = Readonly<{
  styleNo: string;
  factory: string;
  merchandiserUserId: string;
  washingSupplierId: string;
  embroiderySupplierId: string;
  fabricSupplierId: string;
  embroideryMerchandiserUserId: string;
}>;

const initialStyleNo = (): string => {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("styleNo")?.trim() ?? "";
};

const emptyForm = (useUrlStyle = true): V2FormState => ({
  styleNo: useUrlStyle ? initialStyleNo() : "",
  factory: "",
  merchandiserUserId: "",
  washingSupplierId: "",
  embroiderySupplierId: "",
  fabricSupplierId: "",
  embroideryMerchandiserUserId: "",
});

const factoryValue = (order: ReworkOrderResponse): string => {
  if (order.processingFactory?.type === "own_factory") return "own_factory";
  if (order.processingFactory?.type === "supplier") return `supplier:${order.processingFactory.supplierId}`;
  return "";
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

export function ReworkInitiationV2Form({
  reworkOrderId,
  embedded = false,
  existingAttachmentCount = 0,
  onOrderChanged,
}: ReworkInitiationV2FormProps = {}) {
  const [form, setForm] = useState<V2FormState>(() => emptyForm(!reworkOrderId));
  const [options, setOptions] = useState<ReworkInitiationOptionsResponse>({ merchandisers: [], factories: [] });
  const [supplyOptions, setSupplyOptions] = useState<ReworkSupplyContextOptionsResponse>({
    embroideryWashingMerchandisers: [],
    embroideryWashingSuppliers: [],
    fabricSuppliers: [],
  });
  const [order, setOrder] = useState<ReworkOrderResponse | null>(null);
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState(
    reworkOrderId
      ? "正在读取返工草稿…"
      : initialStyleNo()
        ? "已从订单看板带入款号，请补充返工资料"
        : "填写三项核心资料并上传现场图片",
  );
  const pendingSave = useRef<PendingSave | null>(null);
  const pendingSubmit = useRef<PendingSubmitAttempt | null>(null);
  const previewUrls = useRef<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const coreOptions = request(
      "rework-orders/initiation-options",
      ReworkInitiationOptionsResponseSchema,
      { signal: controller.signal },
    );
    const optionalOptions = request(
      "rework-orders/supply-context-options",
      ReworkSupplyContextOptionsResponseSchema,
      { signal: controller.signal },
    );

    if (reworkOrderId) {
      void Promise.all([
        coreOptions,
        optionalOptions,
        request(
          `rework-orders/${reworkOrderId}/draft-v2`,
          ReworkOrderResponseSchema,
          { signal: controller.signal },
        ),
        request(
          `rework-orders/${reworkOrderId}/supply-context`,
          ReworkSupplyContextResponseSchema,
          { signal: controller.signal },
        ),
      ]).then(([core, supply, draft, context]) => {
        if (!active) return;
        setOptions(core);
        setSupplyOptions(supply);
        setOrder(draft);
        setForm({
          styleNo: draft.styleNo ?? "",
          factory: factoryValue(draft),
          merchandiserUserId: draft.merchandiserUserId ?? "",
          washingSupplierId: context.washingSupplier?.supplierId ?? "",
          embroiderySupplierId: context.embroiderySupplier?.supplierId ?? "",
          fabricSupplierId: context.fabricSupplier?.supplierId ?? "",
          embroideryMerchandiserUserId: context.embroideryMerchandiserUserId ?? "",
        });
        setMessage(`草稿已读取 · 当前已有 ${draft.attachmentIds.length} 张现场图片`);
      }).catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
        setMessage(error instanceof Error ? error.message : "返工草稿加载失败");
      });
    } else {
      void Promise.all([coreOptions, optionalOptions]).then(([core, supply]) => {
        if (!active) return;
        setOptions(core);
        setSupplyOptions(supply);
      }).catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
        setMessage(error instanceof Error ? error.message : "下拉资料加载失败");
      });
    }

    return () => { active = false; controller.abort(); };
  }, [reworkOrderId]);

  useEffect(() => () => {
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.current = [];
  }, []);

  const availableImageCount = reworkOrderId
    ? order?.attachmentIds.length ?? existingAttachmentCount
    : images.length;
  const complete = Boolean(
    form.styleNo.trim()
    && form.factory
    && form.merchandiserUserId
    && availableImageCount > 0,
  );

  const coreFactory = (): CreateReworkDraft["processingFactory"] => {
    if (form.factory === "own_factory") return { type: "own_factory" };
    if (!form.factory.startsWith("supplier:")) return undefined;
    const supplierId = form.factory.slice("supplier:".length);
    const selected = options.factories.find((factory) => factory.supplierId === supplierId);
    return selected ? { type: "supplier", supplierId: selected.supplierId } : undefined;
  };

  const fingerprint = (): string => JSON.stringify({
    reworkOrderId: reworkOrderId ?? null,
    styleNo: form.styleNo.trim(),
    factory: form.factory,
    merchandiserUserId: form.merchandiserUserId,
    attachmentIds: images.map((image) => image.attachmentId),
  });

  const saveKey = (): string => {
    const nextFingerprint = fingerprint();
    if (pendingSave.current?.fingerprint === nextFingerprint) return pendingSave.current.key;
    const key = crypto.randomUUID();
    pendingSave.current = { fingerprint: nextFingerprint, key };
    return key;
  };

  const saveSupplyContext = async (targetOrderId: string): Promise<void> => {
    await request(
      `rework-orders/${targetOrderId}/supply-context`,
      ReworkSupplyContextResponseSchema,
      {
        method: "PUT",
        body: JSON.stringify({
          washingSupplierId: form.washingSupplierId || null,
          embroiderySupplierId: form.embroiderySupplierId || null,
          fabricSupplierId: form.fabricSupplierId || null,
          embroideryMerchandiserUserId: form.embroideryMerchandiserUserId || null,
        }),
      },
    );
  };

  const persistDraft = async (clearPendingSubmit = true): Promise<ReworkOrderResponse> => {
    const processingFactory = coreFactory();
    const key = saveKey();
    let saved: ReworkOrderResponse;

    if (reworkOrderId) {
      if (!order) throw new Error("草稿仍在加载，请稍后重试");
      saved = await request(
        `rework-orders/${reworkOrderId}/draft-v2`,
        ReworkOrderResponseSchema,
        {
          method: "PUT",
          headers: { "idempotency-key": key },
          body: JSON.stringify({
            expectedVersion: order.version,
            styleNo: form.styleNo.trim() || null,
            merchandiserUserId: form.merchandiserUserId || null,
            processingFactory: processingFactory ?? null,
          }),
        },
      );
    } else {
      const payload = {
        styleNo: form.styleNo.trim() || null,
        merchandiserUserId: form.merchandiserUserId || null,
        processingFactory: processingFactory ?? null,
        attachmentIds: images.map((image) => image.attachmentId),
      };
      saved = order
        ? await request(
            `rework-orders/${order.reworkOrderId}/draft`,
            ReworkOrderResponseSchema,
            {
              method: "PUT",
              headers: { "idempotency-key": key },
              body: JSON.stringify({ expectedVersion: order.version, ...payload }),
            },
          )
        : await request(
            "rework-orders/drafts",
            ReworkOrderResponseSchema,
            {
              method: "POST",
              headers: { "idempotency-key": key },
              body: JSON.stringify(payload),
            },
          );
    }

    setOrder(saved);
    pendingSave.current = null;
    if (clearPendingSubmit) pendingSubmit.current = null;
    await saveSupplyContext(saved.reworkOrderId);
    return saved;
  };

  const save = async (): Promise<void> => {
    if (busy || uploading) return;
    setBusy(true);
    setMessage("正在保存草稿…");
    try {
      const saved = await persistDraft();
      setMessage(saved.hasOtherOpenStyleOrder
        ? "同款号存在其他未完结单；系统仅提示，不会自动合并"
        : `草稿已保存 · ${saved.styleNo ?? "未填款号"}`);
      await onOrderChanged?.();
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "草稿保存失败");
    } finally {
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (busy || uploading || !complete) return;
    if (!(await confirmInApp("确认提交返工单？"))) return;
    setBusy(true);
    setMessage("正在提交返工…");
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
          `rework-orders/${attempt.reworkOrderId}/submit-v2`,
          ReworkOrderResponseSchema,
          {
            method: "POST",
            headers: { "idempotency-key": attempt.key },
            body: JSON.stringify(attempt.body),
          },
        ),
      );
      pendingSubmit.current = null;
      setOrder(submitted);
      if (embedded) {
        setMessage(`已提交 ${submitted.reworkNo ?? "返工单"}`);
        await onOrderChanged?.();
      } else {
        setMessage(`已提交 ${submitted.reworkNo ?? "返工单"}，正在进入订单详情…`);
        window.setTimeout(() => window.location.assign(pageUrl(`ui/tasks/${submitted.reworkOrderId}`)), 250);
      }
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "提交返工失败");
    } finally {
      setBusy(false);
    }
  };

  const uploadFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0 || uploading || busy || embedded) return;
    const selected = Array.from(files);
    if (images.length + selected.length > MAX_REWORK_ATTACHMENTS) {
      setMessage(`每张返工单最多上传 ${MAX_REWORK_ATTACHMENTS} 张图片`);
      return;
    }
    if (selected.some((file) => !isImageAttachment(file))) {
      setMessage("仅支持 JPEG / PNG / WebP 图片");
      return;
    }
    setUploading(true);
    setMessage(`正在上传 ${selected.length} 张现场图片…`);
    const uploadConcurrency = currentQcUploadConcurrency();
    try {
      const profile = currentUploadClientProfile();
      const uploaded = await prepareAndUploadWithConcurrency(
        selected,
        uploadConcurrency,
        async (file, index) => {
          const baseTiming: AttachmentUploadTimingContext = {
            diagnosticId: crypto.randomUUID(),
            ...profile,
            originalBytes: file.size,
            uploadBytes: file.size,
            mimeType: file.type,
          };
          const prepared = await measureAttachmentUploadStage(
            baseTiming,
            "prepare",
            () => prepareAttachmentForUpload(file),
          );
          const timing = { ...baseTiming, uploadBytes: prepared.size };
          const sha256 = await measureAttachmentUploadStage(timing, "hash", () => sha256Hex(prepared));
          return { file: prepared, timing, sha256, index };
        },
        async ({ file, timing, sha256 }, _source, index): Promise<UploadedImage> => {
          setMessage(`正在上传第 ${index + 1}/${selected.length} 张图片…`);
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
          const previewUrl = URL.createObjectURL(file);
          previewUrls.current.push(previewUrl);
          return {
            attachmentId: finalized.attachmentId,
            filename: finalized.filename,
            mimeType: finalized.mimeType,
            previewUrl,
          };
        },
      );
      setImages((current) => [...current, ...uploaded]);
      pendingSave.current = null;
      pendingSubmit.current = null;
      setMessage(`图片上传完成，共 ${images.length + uploaded.length} 张`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "图片上传失败");
    } finally {
      setUploading(false);
    }
  };

  const removeImage = (attachmentId: string): void => {
    setImages((current) => {
      const removed = current.find((image) => image.attachmentId === attachmentId);
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl);
        previewUrls.current = previewUrls.current.filter((url) => url !== removed.previewUrl);
      }
      return current.filter((image) => image.attachmentId !== attachmentId);
    });
    pendingSave.current = null;
    pendingSubmit.current = null;
  };

  const embroiderySupplierOptions = useMemo(() => supplyOptions.embroideryWashingSuppliers.map((supplier) => ({
    value: supplier.supplierId,
    label: supplier.supplierName,
  })), [supplyOptions.embroideryWashingSuppliers]);
  const fabricSupplierOptions = useMemo(() => supplyOptions.fabricSuppliers.map((supplier) => ({
    value: supplier.supplierId,
    label: supplier.supplierName,
  })), [supplyOptions.fabricSuppliers]);

  return <div className={`rework-v2-page${embedded ? " is-embedded" : ""}`}>
    {!embedded ? <div className="rework-v2-heading">
      <div>
        <h1>发起返工</h1>
        <p>只填返工真正需要的资料；从订单看板进入时仅自动带入款号。</p>
      </div>
      <StatusBadge tone={complete ? "success" : "info"}>{complete ? "可以提交" : "填写中"}</StatusBadge>
    </div> : null}

    <Surface className="rework-v2-core">
      <div className="rework-v2-section-heading">
        <div><h2>{embedded ? "返工核心资料" : "核心资料"}</h2><p><strong>*</strong> 为必填；其他供应商没有就留空。</p></div>
        {embedded ? <StatusBadge tone={availableImageCount ? "success" : "info"}>{availableImageCount} 张现场图片</StatusBadge> : null}
      </div>
      <div className="rework-v2-grid">
        <label><span>款号 <b>*</b></span><input value={form.styleNo} disabled={busy} onChange={(event) => { setForm({ ...form, styleNo: event.target.value }); pendingSubmit.current = null; }} placeholder="输入款号" /></label>
        <label><span>加工厂 <b>*</b></span><div className="rework-v2-control"><FactorySearch factories={options.factories} value={form.factory} disabled={busy} onChange={(factory) => { setForm({ ...form, factory }); pendingSubmit.current = null; }} /></div></label>
        <label><span>订单跟单 <b>*</b></span><div className="rework-v2-control"><SearchSelect options={options.merchandisers.map((item) => ({ value: item.userId, label: item.displayName }))} value={form.merchandiserUserId} placeholder="搜索订单跟单" emptyText="没有匹配的订单跟单" disabled={busy} onChange={(merchandiserUserId) => { setForm({ ...form, merchandiserUserId }); pendingSubmit.current = null; }} /></div></label>
        <label><span>洗水厂</span><div className="rework-v2-control"><SearchSelect options={embroiderySupplierOptions} value={form.washingSupplierId} placeholder="没有可留空" emptyText="没有匹配的洗水厂" disabled={busy} onChange={(washingSupplierId) => setForm({ ...form, washingSupplierId })} /></div></label>
        <label><span>印绣花厂</span><div className="rework-v2-control"><SearchSelect options={embroiderySupplierOptions} value={form.embroiderySupplierId} placeholder="没有可留空" emptyText="没有匹配的印绣花厂" disabled={busy} onChange={(embroiderySupplierId) => setForm({ ...form, embroiderySupplierId })} /></div></label>
        <label><span>面辅料供应商</span><div className="rework-v2-control"><SearchSelect options={fabricSupplierOptions} value={form.fabricSupplierId} placeholder="没有可留空" emptyText="没有匹配的面辅料供应商" disabled={busy} onChange={(fabricSupplierId) => setForm({ ...form, fabricSupplierId })} /></div></label>
        <label><span>印绣花跟单</span><div className="rework-v2-control"><SearchSelect options={supplyOptions.embroideryWashingMerchandisers.map((item) => ({ value: item.userId, label: item.displayName }))} value={form.embroideryMerchandiserUserId} placeholder="没有可留空" emptyText="没有匹配的印绣花跟单" disabled={busy} onChange={(embroideryMerchandiserUserId) => setForm({ ...form, embroideryMerchandiserUserId })} /></div></label>
      </div>
      {order?.hasOtherOpenStyleOrder ? <p className="rework-v2-same-style-warning">同款号存在其他未完结单；系统仅提示，不会自动合并</p> : null}
    </Surface>

    {!embedded ? <Surface className="rework-v2-images">
      <div className="rework-v2-section-heading">
        <div><h2>现场图片 <b>*</b></h2><p>至少 1 张，最多 {MAX_REWORK_ATTACHMENTS} 张；支持 JPEG / PNG / WebP。</p></div>
        <StatusBadge tone={images.length ? "success" : "info"}>{images.length}/{MAX_REWORK_ATTACHMENTS}</StatusBadge>
      </div>
      <label className="rework-v2-upload">
        <span>{uploading ? "正在上传…" : "＋ 添加现场图片"}</span>
        <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy || uploading || images.length >= MAX_REWORK_ATTACHMENTS} onChange={(event) => { void uploadFiles(event.target.files); event.target.value = ""; }} />
      </label>
      {images.length ? <div className="rework-v2-image-grid">
        {images.map((image) => <article key={image.attachmentId}>
          <a href={image.previewUrl} target="_blank" rel="noreferrer"><img src={image.previewUrl} alt={image.filename} /></a>
          <button type="button" disabled={busy || uploading} onClick={() => removeImage(image.attachmentId)}>移除</button>
        </article>)}
      </div> : null}
    </Surface> : null}

    <Surface className="rework-v2-status"><p role="status">{message}</p></Surface>
    <div className="rework-v2-actions">
      <Button disabled={busy || uploading || (Boolean(reworkOrderId) && !order)} onClick={() => void save()}>{busy ? "处理中…" : "保存草稿"}</Button>
      <Button variant="primary" disabled={busy || uploading || !complete || (Boolean(reworkOrderId) && !order)} onClick={() => void submit()}>提交返工</Button>
    </div>
  </div>;
}
