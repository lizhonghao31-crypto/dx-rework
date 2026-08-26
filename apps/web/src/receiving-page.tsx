import { Button, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import {
  isImageAttachment,
  isReceivingImageCandidate,
  normalizeReceivingImageForUpload,
  prepareAttachmentForUpload,
  sha256Hex,
} from "./attachment-upload.js";
import { mapWithConcurrency } from "./concurrency.js";
import "./receiving-page.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const MAX_RECEIVING_IMAGES = 3;

const businessDateDaysAgo = (daysAgo: number): string => {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [year, month, day] = today.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! - daysAgo)).toISOString().slice(0, 10);
};

type StyleOptions = Readonly<{ styles: readonly string[] }>;
type Receipt = Readonly<{
  receiptId: string;
  receivingBatchId: string;
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  differenceQuantity: number;
  receivedAt: string;
}>;
type UploadIntent = Readonly<{
  attachmentId: string;
  uploadUrl: string;
  uploadFields: Readonly<Record<string, string>>;
}>;
type FinalizedAttachment = Readonly<{ attachmentId: string }>;
type SelectedImage = Readonly<{ file: File; previewUrl: string }>;

const errorMessage = async (response: Response): Promise<string> => {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message ?? "提交失败，请稍后重试";
};

const requestJson = async <T,>(path: string, init: RequestInit): Promise<T> => {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<T>;
};

const INVALID_DECLARED_IMAGE_MESSAGE = "Uploaded object is not a valid file of the declared type";

const uploadPreparedReceivingImage = async (file: File, sourceName: string): Promise<string> => {
  const sha256 = await sha256Hex(file);
  const intent = await requestJson<UploadIntent>("tools/attachments/upload-intents", {
    method: "POST",
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      sha256,
    }),
  });
  const upload = new FormData();
  for (const [name, value] of Object.entries(intent.uploadFields)) upload.append(name, value);
  upload.append("file", file);
  const uploaded = await fetch(intent.uploadUrl, { method: "POST", body: upload });
  if (!uploaded.ok) throw new Error(`${sourceName} 上传失败`);
  const finalized = await requestJson<FinalizedAttachment>(
    `tools/attachments/${intent.attachmentId}/finalize`,
    { method: "POST" },
  );
  return finalized.attachmentId;
};

const hasInvalidDeclaredImageError = (error: unknown): boolean =>
  error instanceof Error && error.message === INVALID_DECLARED_IMAGE_MESSAGE;

const uploadReceivingImage = async (source: File): Promise<string> => {
  const prepared = isImageAttachment(source)
    ? await prepareAttachmentForUpload(source)
    : await normalizeReceivingImageForUpload(source);
  try {
    return await uploadPreparedReceivingImage(prepared, source.name);
  } catch (error) {
    if (!hasInvalidDeclaredImageError(error)) throw error;
  }

  try {
    const normalized = await normalizeReceivingImageForUpload(source);
    return await uploadPreparedReceivingImage(normalized, source.name);
  } catch (error) {
    if (hasInvalidDeclaredImageError(error)) {
      throw new Error(`${source.name} 图片格式无法识别，请重新选择图片`);
    }
    throw error;
  }
};

export function ReceivingPage() {
  const [open, setOpen] = useState(false);
  const [backfill, setBackfill] = useState(false);
  const [receivedDate, setReceivedDate] = useState(businessDateDaysAgo(1));
  const [styles, setStyles] = useState<readonly string[]>([]);
  const [styleNo, setStyleNo] = useState("");
  const [documentQuantity, setDocumentQuantity] = useState("");
  const [actualQuantity, setActualQuantity] = useState("");
  const [images, setImages] = useState<readonly SelectedImage[]>([]);
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pendingKey = useRef<string | null>(null);
  const uploadedIds = useRef(new Map<string, string>());
  const previewUrls = useRef(new Set<string>());

  const loadStyles = async () => {
    const response = await fetch(apiUrl("receiving/style-options"), { credentials: "include" });
    if (!response.ok) return;
    const body = await response.json() as StyleOptions;
    setStyles(body.styles);
  };

  useEffect(() => { void loadStyles(); }, []);
  useEffect(() => () => {
    for (const previewUrl of previewUrls.current) URL.revokeObjectURL(previewUrl);
    previewUrls.current.clear();
  }, []);

  const matches = useMemo(() => {
    const needle = styleNo.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return styles.slice(0, 10);
    return styles.filter((item) => item.toLocaleLowerCase("zh-CN").includes(needle)).slice(0, 10);
  }, [styleNo, styles]);

  const clearImages = () => {
    setImages((current) => {
      for (const image of current) {
        URL.revokeObjectURL(image.previewUrl);
        previewUrls.current.delete(image.previewUrl);
        uploadedIds.current.delete(image.previewUrl);
      }
      return [];
    });
  };

  const selectImages = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const selected = Array.from(files);
    if (images.length + selected.length > MAX_RECEIVING_IMAGES) {
      setMessage("收货单图片最多3张");
      return;
    }
    if (selected.some((file) => !isReceivingImageCandidate(file))) {
      setMessage("请选择手机相册中的图片文件");
      return;
    }
    const additions = selected.map((file) => {
      const previewUrl = URL.createObjectURL(file);
      previewUrls.current.add(previewUrl);
      return { file, previewUrl };
    });
    setImages((current) => [...current, ...additions]);
    pendingKey.current = null;
    setMessage("");
  };

  const removeImage = (index: number) => {
    setImages((current) => {
      const removed = current[index];
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl);
        previewUrls.current.delete(removed.previewUrl);
        uploadedIds.current.delete(removed.previewUrl);
      }
      return current.filter((_, itemIndex) => itemIndex !== index);
    });
    pendingKey.current = null;
  };

  const submit = async () => {
    const trimmedStyle = styleNo.trim();
    const documentCount = Number(documentQuantity);
    const actualCount = Number(actualQuantity);
    if (!trimmedStyle) { setMessage("请选择或填写款号"); return; }
    if (!/^\d+$/.test(documentQuantity) || documentCount <= 0) { setMessage("收货单数量请输入大于0的整数"); return; }
    if (!/^\d+$/.test(actualQuantity) || actualCount < 0) { setMessage("实际收货数量请输入大于等于0的整数"); return; }
    if (backfill && receivedDate !== businessDateDaysAgo(1) && receivedDate !== businessDateDaysAgo(2)) {
      setMessage("补录仅支持昨天和前天");
      return;
    }

    setBusy(true);
    setMessage(images.length ? `正在上传 ${images.length} 张收货单图片…` : "正在提交收货…");
    try {
      const attachmentIds = await mapWithConcurrency(images, 2, async (image) => {
        let attachmentId = uploadedIds.current.get(image.previewUrl);
        if (!attachmentId) {
          attachmentId = await uploadReceivingImage(image.file);
          uploadedIds.current.set(image.previewUrl, attachmentId);
        }
        return attachmentId;
      });

      const key = pendingKey.current ?? crypto.randomUUID();
      pendingKey.current = key;
      const response = await fetch(apiUrl("receiving/receipts"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({
          styleNo: trimmedStyle,
          documentQuantity: documentCount,
          actualQuantity: actualCount,
          attachmentIds,
          ...(backfill ? { receivedDate } : {}),
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const receipt = await response.json() as Receipt;
      pendingKey.current = null;
      const sign = receipt.differenceQuantity > 0 ? "+" : "";
      setMessage(`${backfill ? "补录" : "收货"}成功 · 差异 ${sign}${receipt.differenceQuantity} 件`);
      setStyleNo("");
      setDocumentQuantity("");
      setActualQuantity("");
      clearImages();
      setStyleMenuOpen(false);
      setOpen(false);
      setBackfill(false);
      void loadStyles();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "提交失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return <main className="receiving-shell">
    <section className="receiving-hero">
      <div className="receiving-brand">达兴 · 仓库收货</div>
      {!open ? (
        <div className="receiving-entry-actions">
          <button className="receiving-start" type="button" onClick={() => { setBackfill(false); setOpen(true); setMessage(""); }}>
            <span aria-hidden="true">＋</span>
            <strong>点击收货</strong>
          </button>
          <button className="receiving-backfill-start" type="button" onClick={() => { setBackfill(true); setReceivedDate(businessDateDaysAgo(1)); setOpen(true); setMessage(""); }}>
            补录
          </button>
        </div>
      ) : (
        <Surface className="receiving-form-card">
          <h1>{backfill ? "补录收货" : "收货"}</h1>
          {backfill ? <label className="receiving-field">
            <span>收货日期</span>
            <input
              type="date"
              min={businessDateDaysAgo(2)}
              max={businessDateDaysAgo(1)}
              value={receivedDate}
              disabled={busy}
              onChange={(event) => { setReceivedDate(event.target.value); pendingKey.current = null; }}
            />
          </label> : null}
          <label className="receiving-field">
            <span>款号</span>
            <div className="receiving-style-input">
              <input
                type="search"
                autoComplete="off"
                inputMode="text"
                placeholder="搜索或填写款号"
                value={styleNo}
                disabled={busy}
                onFocus={() => setStyleMenuOpen(true)}
                onBlur={() => window.setTimeout(() => setStyleMenuOpen(false), 120)}
                onChange={(event) => { setStyleNo(event.target.value); setStyleMenuOpen(true); pendingKey.current = null; }}
              />
              {styleMenuOpen && matches.length > 0 ? <div className="receiving-style-menu" role="listbox">
                {matches.map((item) => <button
                  type="button"
                  key={item}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => { setStyleNo(item); setStyleMenuOpen(false); pendingKey.current = null; }}
                >{item}</button>)}
              </div> : null}
            </div>
          </label>
          <label className="receiving-field">
            <span>收货单数量</span>
            <input type="number" min="1" step="1" inputMode="numeric" placeholder="0" value={documentQuantity} disabled={busy} onChange={(event) => { setDocumentQuantity(event.target.value); pendingKey.current = null; }} />
          </label>
          <label className="receiving-field">
            <span>实际收货数量</span>
            <input type="number" min="0" step="1" inputMode="numeric" placeholder="0" value={actualQuantity} disabled={busy} onChange={(event) => { setActualQuantity(event.target.value); pendingKey.current = null; }} />
          </label>
          <div className="receiving-images">
            <div className="receiving-images-heading">
              <span>收货单图片</span>
              <small>{backfill ? "补录订单必须上传收货单图片，最多3张" : "首次收货必传，最多3张；同款追加收货可复用已上传单据"}</small>
            </div>
            <label className="receiving-image-upload">
              <span>{images.length >= MAX_RECEIVING_IMAGES ? "已达3张" : "＋ 选择图片"}</span>
              <input
                type="file"
                accept="image/*"
                multiple
                disabled={busy || images.length >= MAX_RECEIVING_IMAGES}
                onChange={(event) => { selectImages(event.target.files); event.target.value = ""; }}
              />
            </label>
            {images.length ? <div className="receiving-image-list">
              {images.map((image, index) => <article key={`${image.file.name}-${image.file.lastModified}-${index}`}>
                <img src={image.previewUrl} alt={`收货单图片 ${index + 1}`} />
                <button type="button" disabled={busy} onClick={() => removeImage(index)}>移除</button>
              </article>)}
            </div> : null}
          </div>
          <Button variant="primary" className="receiving-submit" disabled={busy} onClick={() => void submit()}>{busy ? "提交中…" : backfill ? "提交补录" : "提交收货"}</Button>
          <button className="receiving-cancel" type="button" disabled={busy} onClick={() => { pendingKey.current = null; clearImages(); setBackfill(false); setOpen(false); }}>返回</button>
        </Surface>
      )}
      {message ? <p className="receiving-message" role="status">{message}</p> : null}
    </section>
  </main>;
}

