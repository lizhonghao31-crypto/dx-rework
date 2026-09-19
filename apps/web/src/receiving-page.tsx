import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { Button, Surface } from "@dx-rework/ui";
import { useEffect, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { createClientRequestId } from "./client-request-id.js";
import {
  isImageAttachment,
  isReceivingImageCandidate,
  normalizeReceivingImageForUpload,
  prepareAttachmentForUpload,
  sha256Hex,
} from "./attachment-upload.js";
import { mapWithConcurrency } from "./concurrency.js";
import { useDebouncedValue } from "./use-debounced-value.js";
import "./receiving-page.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
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

type CuttingOption = Readonly<{
  cuttingOrderId: string;
  styleNo: string;
  color: string | null;
  supplierName: string;
  actualCutCount: number;
  styleConflictCount: number;
}>;
type CuttingOptions = Readonly<{ orders: readonly CuttingOption[] }>;
type RepeatOrder = Readonly<{
  receivingBatchId: string;
  documentQuantity: number;
  styleNo: string;
  cuttingOrderId?: string;
  color?: string | null;
  supplierName?: string;
  actualCutCount?: number;
  styleConflictCount?: number;
}>;
type RepeatOptions = Readonly<{ orders: readonly RepeatOrder[] }>;
type Receipt = Readonly<{
  receiptId: string;
  receivingBatchId: string;
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  defectiveQuantity: number;
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
  const [repeat, setRepeat] = useState(false);
  const [repeatSource, setRepeatSource] = useState<"jiashun" | "other_factory" | null>(null);
  const [repeatQuery, setRepeatQuery] = useState("");
  const debouncedRepeatQuery = useDebouncedValue(repeatQuery, 180);
  const [repeatOrders, setRepeatOrders] = useState<readonly RepeatOrder[]>([]);
  const [repeatOptionsQuery, setRepeatOptionsQuery] = useState("");
  const [selectedRepeatOrder, setSelectedRepeatOrder] = useState<RepeatOrder | null>(null);
  const [repeatMenuOpen, setRepeatMenuOpen] = useState(false);
  const [repeatSearching, setRepeatSearching] = useState(false);
  const [receivedDate, setReceivedDate] = useState(businessDateDaysAgo(1));
  const [styleNo, setStyleNo] = useState("");
  const debouncedStyleNo = useDebouncedValue(styleNo, 180);
  const [cuttingOptions, setCuttingOptions] = useState<readonly CuttingOption[]>([]);
  const [cuttingOptionsQuery, setCuttingOptionsQuery] = useState("");
  const [selectedCutting, setSelectedCutting] = useState<CuttingOption | null>(null);
  const [cuttingSearching, setCuttingSearching] = useState(false);
  const [documentQuantity, setDocumentQuantity] = useState("");
  const [actualQuantity, setActualQuantity] = useState("");
  const [defectiveQuantity, setDefectiveQuantity] = useState("0");
  const [images, setImages] = useState<readonly SelectedImage[]>([]);
  const [styleMenuOpen, setStyleMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pendingKey = useRef<string | null>(null);
  const submitting = useRef(false);
  const uploadedIds = useRef(new Map<string, string>());
  const previewUrls = useRef(new Set<string>());

  useEffect(() => {
    const needle = debouncedRepeatQuery.trim();
    if (!repeat || !repeatSource || needle.length < 4) {
      setRepeatOrders([]);
      setRepeatOptionsQuery("");
      setRepeatSearching(false);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({ q: needle });
    setRepeatSearching(true);
    void requestJson<RepeatOptions>(`receiving/repeat-options?${params.toString()}`, {
      method: "GET",
      signal: controller.signal,
    })
      .then((body) => {
        if (controller.signal.aborted) return;
        setRepeatOrders(body.orders);
        setRepeatOptionsQuery(needle.toUpperCase());
        const exactMatches = body.orders.filter(
          (order) => order.styleNo.trim().toUpperCase() === needle.toUpperCase(),
        );
        if (exactMatches.length === 1) {
          setRepeatQuery(exactMatches[0]!.styleNo);
          setSelectedRepeatOrder(exactMatches[0]!);
          setRepeatMenuOpen(false);
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setRepeatOrders([]);
        setRepeatOptionsQuery("");
        setMessage(cause instanceof Error ? cause.message : "可追加收货订单加载失败");
      })
      .finally(() => { if (!controller.signal.aborted) setRepeatSearching(false); });
    return () => { controller.abort(); };
  }, [repeat, repeatSource, debouncedRepeatQuery]);
  useEffect(() => {
    const needle = debouncedStyleNo.trim();
    if (!open || repeat || needle.length < 4) {
      setCuttingOptions([]);
      setCuttingOptionsQuery("");
      setCuttingSearching(false);
      return;
    }
    const controller = new AbortController();
    setCuttingSearching(true);
    void requestJson<CuttingOptions>(
      `receiving/cutting-options?${new URLSearchParams({ q: needle }).toString()}`,
      { method: "GET", signal: controller.signal },
    ).then((body) => {
      if (controller.signal.aborted) return;
      setCuttingOptions(body.orders);
      setCuttingOptionsQuery(needle.toUpperCase());
      const exactMatches = body.orders.filter(
        (order) => order.styleNo.trim().toUpperCase() === needle.toUpperCase(),
      );
      if (exactMatches.length === 1) {
        setStyleNo(exactMatches[0]!.styleNo);
        setSelectedCutting(exactMatches[0]!);
        setStyleMenuOpen(false);
      }
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setCuttingOptions([]);
      setCuttingOptionsQuery("");
      setMessage(cause instanceof Error ? cause.message : "已裁正式款号加载失败");
    }).finally(() => {
      if (!controller.signal.aborted) setCuttingSearching(false);
    });
    return () => controller.abort();
  }, [open, repeat, debouncedStyleNo]);

  useEffect(() => () => {
    for (const previewUrl of previewUrls.current) URL.revokeObjectURL(previewUrl);
    previewUrls.current.clear();
  }, []);

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

  const clearNormalDraft = () => {
    setStyleNo("");
    setCuttingOptions([]);
    setCuttingOptionsQuery("");
    setSelectedCutting(null);
    setDocumentQuantity("");
    setActualQuantity("");
    setDefectiveQuantity("0");
    clearImages();
    setStyleMenuOpen(false);
  };

  const selectImages = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const selected = Array.from(files);
    if (images.length + selected.length > MAX_RECEIVING_IMAGES) {
      setMessage("送货单图片最多3张");
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

  const submitRepeated = async () => {
    const actualCount = Number(actualQuantity);
    const defectiveCount = Number(defectiveQuantity);
    const addedDocumentCount = Number(documentQuantity);
    if (!repeatSource) { setMessage("请先选择嘉顺收货或其他工厂收货"); return; }
    if (!selectedRepeatOrder) { setMessage("请先搜索并选择要追加收货的订单"); return; }
    if (repeatSource === "other_factory" && (!/^\d+$/.test(documentQuantity) || addedDocumentCount <= 0)) { setMessage("本次送货单数量请输入大于0的整数"); return; }
    if (!/^\d+$/.test(actualQuantity) || actualCount < 0) { setMessage("实际收货数量请输入大于等于0的整数"); return; }
    if (!/^\d+$/.test(defectiveQuantity) || defectiveCount < 0) { setMessage("次品数量请输入大于等于0的整数"); return; }
    if (defectiveCount > actualCount) { setMessage("次品数量不能超过实际收货数量"); return; }

    setBusy(true);
    setMessage("正在提交多次收货…");
    try {
      const key = pendingKey.current ?? createClientRequestId();
      pendingKey.current = key;
      const receipt = await requestJson<Receipt>("receiving/repeat-receipts", {
        method: "POST",
        headers: { "idempotency-key": key },
        body: JSON.stringify({
          ...(selectedRepeatOrder.cuttingOrderId
            ? { cuttingOrderId: selectedRepeatOrder.cuttingOrderId }
            : {}),
          receivingBatchId: selectedRepeatOrder.receivingBatchId,
          source: repeatSource,
          ...(repeatSource === "other_factory" ? { documentQuantity: addedDocumentCount } : {}),
          actualQuantity: actualCount,
          defectiveQuantity: defectiveCount,
        }),
      });
      pendingKey.current = null;
      setMessage(`多次收货成功 · ${receipt.styleNo} · 实收 ${formatBusinessDecimal(receipt.actualQuantity)} 件 · 次品 ${formatBusinessDecimal(receipt.defectiveQuantity)} 件`);
      setRepeatQuery("");
      setRepeatOrders([]);
      setSelectedRepeatOrder(null);
      setRepeatMenuOpen(false);
      clearNormalDraft();
      setRepeatSource(null);
      setRepeat(false);
      setOpen(false);
    } catch (cause) {
      const nextMessage = cause instanceof Error ? cause.message : "提交失败，请稍后重试";
      if (nextMessage.includes("重新搜索")) setSelectedRepeatOrder(null);
      setMessage(nextMessage);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const trimmedStyle = (selectedCutting?.styleNo ?? styleNo).trim();
    const documentCount = Number(documentQuantity);
    const actualCount = Number(actualQuantity);
    const defectiveCount = Number(defectiveQuantity);
    if (!trimmedStyle) { setMessage("款号不能为空"); return; }
    if (!/^\d+$/.test(documentQuantity) || documentCount <= 0) { setMessage("送货单数量请输入大于0的整数"); return; }
    if (!/^\d+$/.test(actualQuantity) || actualCount < 0) { setMessage("实际收货数量请输入大于等于0的整数"); return; }
    if (!/^\d+$/.test(defectiveQuantity) || defectiveCount < 0) { setMessage("次品数量请输入大于等于0的整数"); return; }
    if (defectiveCount > actualCount) { setMessage("次品数量不能超过实际收货数量"); return; }
    if (backfill && receivedDate !== businessDateDaysAgo(1) && receivedDate !== businessDateDaysAgo(2)) {
      setMessage("补录仅支持昨天和前天");
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    if (!backfill && trimmedStyle.length >= 4) {
      try {
        const options = await requestJson<RepeatOptions>(`receiving/repeat-options?${new URLSearchParams({ q: trimmedStyle }).toString()}`, { method: "GET" });
        if (options.orders.some((order) => order.styleNo.trim().toUpperCase() === trimmedStyle.toUpperCase())) {
          setRepeat(true);
          setRepeatSource(null);
          setRepeatQuery("");
          setRepeatOrders([]);
          setSelectedRepeatOrder(null);
          clearNormalDraft();
          setMessage("该款号已有收货记录，请到“多次收货”录入");
          submitting.current = false;
          setBusy(false);
          return;
        }
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : "收货记录核对失败，请稍后重试");
        submitting.current = false;
        setBusy(false);
        return;
      }
    }

    setBusy(true);
    setMessage(images.length ? `正在上传 ${formatBusinessDecimal(images.length)} 张送货单图片…` : "正在提交收货…");
    try {
      const attachmentIds = await mapWithConcurrency(images, 2, async (image) => {
        let attachmentId = uploadedIds.current.get(image.previewUrl);
        if (!attachmentId) {
          attachmentId = await uploadReceivingImage(image.file);
          uploadedIds.current.set(image.previewUrl, attachmentId);
        }
        return attachmentId;
      });

      const key = pendingKey.current ?? createClientRequestId();
      pendingKey.current = key;
      const response = await fetch(apiUrl("receiving/receipts"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({
          ...(selectedCutting
            ? { cuttingOrderId: selectedCutting.cuttingOrderId }
            : { styleNo: trimmedStyle }),
          documentQuantity: documentCount,
          actualQuantity: actualCount,
          defectiveQuantity: defectiveCount,
          attachmentIds,
          ...(backfill ? { receivedDate } : {}),
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const receipt = await response.json() as Receipt;
      
      pendingKey.current = null;
      const sign = receipt.differenceQuantity > 0 ? "+" : "";
      setMessage(`${backfill ? "补录" : "收货"}成功 · 次品 ${formatBusinessDecimal(receipt.defectiveQuantity)} 件 · 差异 ${sign}${formatBusinessDecimal(receipt.differenceQuantity)} 件`);
      setStyleNo("");
      setCuttingOptions([]);
      setCuttingOptionsQuery("");
      setSelectedCutting(null);
      setDocumentQuantity("");
      setActualQuantity("");
      setDefectiveQuantity("0");
      clearImages();
      setStyleMenuOpen(false);
      setOpen(false);
      setBackfill(false);
    } catch (cause) {
      const nextMessage = cause instanceof Error ? cause.message : "提交失败，请稍后重试";
      if (nextMessage.includes("请到“多次收货”录入")) {
        setRepeat(true);
        setRepeatSource(null);
        setRepeatQuery("");
        setRepeatOrders([]);
        setSelectedRepeatOrder(null);
        clearNormalDraft();
      }
      setMessage(nextMessage);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return <main className="receiving-shell">
    <a className="dx-button dx-button--secondary receiving-order-link" href={pageUrl("/ui/orders?returnTo=%2Fui%2Freceiving")}>查看订货回货</a>
    <section className="receiving-hero">
      <div className="receiving-brand">达兴 · 仓库收货</div>
      {!open ? (
        <div className="receiving-entry-actions">
          <button className="receiving-start" type="button" onClick={() => { setRepeat(false); setRepeatSource(null); setBackfill(false); setOpen(true); setMessage(""); }}>
            <span aria-hidden="true">＋</span>
            <strong>点击收货</strong>
          </button>
          <button className="receiving-repeat-start" type="button" onClick={() => {
            setRepeat(true);
            setRepeatSource(null);
            setBackfill(false);
            setRepeatQuery("");
            setRepeatOrders([]);
            setSelectedRepeatOrder(null);
            setActualQuantity("");
            setDefectiveQuantity("0");
            setOpen(true);
            setMessage("");
          }}>
            多次收货
          </button>
          <button className="receiving-backfill-start" type="button" onClick={() => { setRepeat(false); setRepeatSource(null); setBackfill(true); setReceivedDate(businessDateDaysAgo(1)); setOpen(true); setMessage(""); }}>
            补录
          </button>
        </div>
      ) : repeat && !repeatSource ? (
        <Surface className="receiving-form-card">
          <h1>多次收货</h1>
          <p className="receiving-repeat-hint">请选择本次收货来源</p>
          <button className="receiving-source-choice receiving-source-choice-jiashun" type="button" onClick={() => { setRepeatSource("jiashun"); setDocumentQuantity(""); setMessage(""); }}>
            嘉顺收货
          </button>
          <button className="receiving-source-choice receiving-source-choice-other" type="button" onClick={() => { setRepeatSource("other_factory"); setDocumentQuantity(""); setMessage(""); }}>
            其他工厂收货
          </button>
          <button className="receiving-cancel" type="button" onClick={() => { setRepeat(false); setOpen(false); }}>返回</button>
        </Surface>
      ) : repeat ? (
        <Surface className="receiving-form-card">
          <h1>{repeatSource === "jiashun" ? "嘉顺多次收货" : "其他工厂多次收货"}</h1>
          <label className="receiving-field">
            <span>款号</span>
            <div className="receiving-style-input">
              <input
                type="search"
                autoComplete="off"
                inputMode="text"
                placeholder="输入完整款号或末尾至少4位"
                value={repeatQuery}
                disabled={busy}
                onFocus={() => setRepeatMenuOpen(true)}
                onBlur={() => window.setTimeout(() => setRepeatMenuOpen(false), 120)}
                onChange={(event) => {
                  setRepeatQuery(event.target.value);
                  setRepeatOrders([]);
                  setRepeatOptionsQuery("");
                  setSelectedRepeatOrder(null);
                  setRepeatMenuOpen(true);
                  pendingKey.current = null;
                }}
              />
              {repeatMenuOpen && repeatOptionsQuery === repeatQuery.trim().toUpperCase() && repeatOrders.length > 0 ? <div className="receiving-style-menu" role="listbox">
                {repeatOrders.map((order) => <button
                  className="receiving-repeat-option"
                  type="button"
                  key={`${order.receivingBatchId}:${order.cuttingOrderId}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setRepeatQuery(order.styleNo);
                    setSelectedRepeatOrder(order);
                    setRepeatMenuOpen(false);
                    pendingKey.current = null;
                  }}
                ><strong>{order.styleNo}</strong><small>{order.cuttingOrderId && order.supplierName && order.actualCutCount !== undefined
                  ? `${order.supplierName}${order.color ? ` · ${order.color}` : ""} · 实裁 ${formatBusinessDecimal(order.actualCutCount)} 件 · 原送货单 ${formatBusinessDecimal(order.documentQuantity)} 件`
                  : `原送货单 ${formatBusinessDecimal(order.documentQuantity)} 件`}</small></button>)}
              </div> : null}
            </div>
          </label>
          {selectedRepeatOrder ? <p className="receiving-repeat-selected">已选择 {selectedRepeatOrder.styleNo}{selectedRepeatOrder.cuttingOrderId && selectedRepeatOrder.supplierName && selectedRepeatOrder.actualCutCount !== undefined
            ? ` · ${selectedRepeatOrder.supplierName}${selectedRepeatOrder.color ? ` · ${selectedRepeatOrder.color}` : ""} · 实裁 ${formatBusinessDecimal(selectedRepeatOrder.actualCutCount)} 件`
            : ""} · 原送货单 {formatBusinessDecimal(selectedRepeatOrder.documentQuantity)} 件</p> : repeatSearching ? (
            <p className="receiving-repeat-hint">正在搜索…</p>
          ) : null}
          {repeatSource === "other_factory" ? <label className="receiving-field">
            <span>本次送货单数量</span>
            <input type="number" min="1" step="1" inputMode="numeric" placeholder="0" value={documentQuantity} disabled={busy} onChange={(event) => { setDocumentQuantity(event.target.value); pendingKey.current = null; }} />
          </label> : null}
          <label className="receiving-field">
            <span>实际收货数量</span>
            <input type="number" min="0" step="1" inputMode="numeric" placeholder="0" value={actualQuantity} disabled={busy} onChange={(event) => { setActualQuantity(event.target.value); pendingKey.current = null; }} />
          </label>
          <label className="receiving-field">
            <span>次品数量</span>
            <input type="number" min="0" step="1" inputMode="numeric" placeholder="0" value={defectiveQuantity} disabled={busy} onChange={(event) => { setDefectiveQuantity(event.target.value); pendingKey.current = null; }} />
          </label>
          <Button variant="primary" className="receiving-submit" disabled={busy} onClick={() => void submitRepeated()}>{busy ? "提交中…" : "提交多次收货"}</Button>
          <button className="receiving-cancel" type="button" disabled={busy} onClick={() => {
            pendingKey.current = null;
            setRepeatSource(null);
            setRepeatQuery("");
            setRepeatOrders([]);
            setSelectedRepeatOrder(null);
            setOpen(false);
          }}>返回</button>
        </Surface>
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
            <span>正式款号</span>
            <div className="receiving-style-input">
              <input
                type="search"
                autoComplete="off"
                inputMode="text"
                placeholder="输入完整款号或末尾至少4位"
                value={styleNo}
                disabled={busy}
                onFocus={() => setStyleMenuOpen(true)}
                onBlur={() => window.setTimeout(() => setStyleMenuOpen(false), 120)}
                onChange={(event) => {
                  setStyleNo(event.target.value);
                  setSelectedCutting(null);
                  setCuttingOptions([]);
                  setCuttingOptionsQuery("");
                  setStyleMenuOpen(true);
                  pendingKey.current = null;
                }}
              />
              {styleMenuOpen && cuttingOptionsQuery === styleNo.trim().toUpperCase() && cuttingOptions.length > 0 ? <div className="receiving-style-menu" role="listbox">
                {cuttingOptions.map((item) => <button
                  type="button"
                  key={item.cuttingOrderId}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setStyleNo(item.styleNo);
                    setSelectedCutting(item);
                    setStyleMenuOpen(false);
                    pendingKey.current = null;
                  }}
                ><strong>{item.styleNo}</strong><small>{item.supplierName}{item.color ? ` · ${item.color}` : ""} · 实裁 {formatBusinessDecimal(item.actualCutCount)} 件{item.styleConflictCount > 1 ? " · 同款号多条，请核对工厂/颜色" : ""}</small></button>)}
              </div> : null}
            </div>
          </label>
          {selectedCutting ? <p className="receiving-repeat-selected">已选择 {selectedCutting.styleNo} · {selectedCutting.supplierName}{selectedCutting.color ? ` · ${selectedCutting.color}` : ""} · 实裁 {formatBusinessDecimal(selectedCutting.actualCutCount)} 件</p> : cuttingSearching ? (
            <p className="receiving-repeat-hint">正在搜索…</p>
          ) : null}
          <label className="receiving-field">
            <span>送货单数量</span>
            <input type="number" min="1" step="1" inputMode="numeric" placeholder="0" value={documentQuantity} disabled={busy} onChange={(event) => { setDocumentQuantity(event.target.value); pendingKey.current = null; }} />
          </label>
          <label className="receiving-field">
            <span>实际收货数量</span>
            <input type="number" min="0" step="1" inputMode="numeric" placeholder="0" value={actualQuantity} disabled={busy} onChange={(event) => { setActualQuantity(event.target.value); pendingKey.current = null; }} />
          </label>
          <label className="receiving-field">
            <span>次品数量</span>
            <input type="number" min="0" step="1" inputMode="numeric" placeholder="0" value={defectiveQuantity} disabled={busy} onChange={(event) => { setDefectiveQuantity(event.target.value); pendingKey.current = null; }} />
          </label>
          <div className="receiving-images">
            <div className="receiving-images-heading">
              <span>送货单图片</span>
              <small>{backfill ? "补录订单必须上传送货单图片，最多3张" : "首次收货必传，最多3张；同款追加收货可复用已上传单据"}</small>
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
                <img src={image.previewUrl} alt={`送货单图片 ${index + 1}`} />
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
