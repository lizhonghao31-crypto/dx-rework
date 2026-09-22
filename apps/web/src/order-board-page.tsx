import { moduleCanWrite } from "./member-module-policy.js";
import { NavigationIcon } from "./navigation-icons.js";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { KpiInstrument, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import {
  isImageAttachment,
  isReceivingImageCandidate,
  normalizeReceivingImageForUpload,
  prepareAttachmentForUpload,
  sha256Hex,
} from "./attachment-upload.js";
import { verifySession } from "./auth.js";
import { createClientRequestId } from "./client-request-id.js";
import { ReceivingDialog } from "./receiving-dialog.js";
import { ImageViewer } from "./image-viewer.js";
import { ListPagination } from "./list-pagination.js";
import { alertInApp } from "./system-dialog.js";
import { useDebouncedValue } from "./use-debounced-value.js";
import "./order-board-page.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

type ReworkStatus = "draft" | "active" | "completed" | null;
type BoardStatus = "all" | "normal" | "extra" | "short" | "multiple" | "receiving_difference" | "packing_difference" | "missing_packing" | "pending" | "handled" | "stale";

type ReceivingHistoryItem = Readonly<{
  receiptId: string;
  receivingBatchId: string;
  batchVersion: number;
  sequence: number;
  documentQuantity: number;
  receiptDocumentQuantity: number;
  receivingSource: "legacy" | "initial" | "backfill" | "jiashun" | "other_factory";
  actualQuantity: number;
  defectiveQuantity: number;
  cumulativeActualQuantity: number;
  differenceQuantity: number;
  receivedAt: string;
  receiverName: string;
}>;
type ReceivingAttachment = Readonly<{ attachmentId: string; filename: string }>;
type DifferenceResolution = Readonly<{
  resolutionId: string;
  result: string;
  handledBy: string;
  handledAt: string;
  attachments?: readonly ReceivingAttachment[];
}>;
type UploadIntent = Readonly<{
  attachmentId: string;
  uploadUrl: string;
  uploadFields: Readonly<Record<string, string>>;
}>;
type FinalizedAttachment = Readonly<{ attachmentId: string }>;
type BoardRow = Readonly<{
  receivingBatchId: string;
  styleNo: string;
  documentQuantity: number;
  attachments: readonly ReceivingAttachment[];
  priorActualQuantity: number;
  actualQuantity: number;
  defectiveQuantity: number;
  currentActualQuantity: number;
  currentDefectiveQuantity: number;
  cumulativeActualQuantity: number;
  differenceQuantity: number;
  packingRevisionId: string | null;
  packingQuantity: number | null;
  packingDifferenceQuantity: number | null;
  packingRecordedBy: string | null;
  packingRecordedAt: string | null;
  actualCutCount: number | null;
  cuttingRecordedBy: string | null;
  cuttingRecordedAt: string | null;
  receivingDifferenceResolution: DifferenceResolution | null;
  packingDifferenceResolution: DifferenceResolution | null;
  staleResolution?: boolean;
  resolutionHistory?: readonly (DifferenceResolution & { differenceType: "receiving" | "packing"; differenceQuantity: number })[];
  receiptCount: number;
  receivingHistory: readonly ReceivingHistoryItem[];
  lastReceivedAt: string;
  lastReceiverName: string;
  reworkOrderId: string | null;
  reworkStatus: ReworkStatus;
  version: number;
  rootCorrectable: boolean;
  rootDeletable: boolean;
  rootMutable: boolean;
}>;

type BoardResult = Readonly<{
  date: string;
  startDate: string;
  endDate: string;
  mode: "range" | "search";
  status: BoardStatus;
  insights?: Readonly<{ pendingCount: number; missingPackingCount: number; staleCount: number }>;
  kpis: Readonly<{
    orderCount: number;
    receivedQuantity: number;
    abnormalOrderCount: number;
    differenceQuantity: number;
    differenceRate: number;
  }>;
  rows: readonly BoardRow[];
  page: number;
  pageSize: 15;
  totalCount: number;
  totalPages: number;
}>;

const localDate = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const dateTime = (value: string): string => new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
}).format(new Date(value));

const historyDateTime = (value: string): string => new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
}).format(new Date(value));

const quantity = (value: number): string => formatBusinessDecimal(value);
const signedQuantity = (value: number): string => `${value > 0 ? "+" : ""}${quantity(value)}件`;

const reworkLabel = (status: ReworkStatus): string => {
  if (status === "draft") return "继续填写";
  if (status === "active") return "正在返工";
  if (status === "completed") return "返工结束";
  return "发起返工";
};

const responseError = async (response: Response, fallback: string): Promise<string> => {
  const body = await response.json().catch(() => null) as Readonly<{
    message?: string;
    error?: Readonly<{ message?: string }>;
  }> | null;
  return body?.error?.message ?? body?.message ?? fallback;
};

const attachmentUrl = (attachmentId: string, mode: "preview" | "download"): string =>
  apiUrl(`tools/attachments/${attachmentId}/download?mode=${mode}`);

const uploadReplacementImage = async (source: File): Promise<string> => {
  const upload = async (file: File): Promise<string> => {
    const intentResponse = await fetch(apiUrl("tools/attachments/upload-intents"), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        sha256: await sha256Hex(file),
      }),
    });
    if (!intentResponse.ok) throw new Error(await responseError(intentResponse, "替换图片上传准备失败"));
    const intent = await intentResponse.json() as UploadIntent;
    const body = new FormData();
    for (const [name, value] of Object.entries(intent.uploadFields)) body.append(name, value);
    body.append("file", file);
    const uploaded = await fetch(intent.uploadUrl, { method: "POST", body });
    if (!uploaded.ok) throw new Error(`${source.name} 上传失败`);
    const finalizedResponse = await fetch(apiUrl(`tools/attachments/${intent.attachmentId}/finalize`), {
      method: "POST",
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (!finalizedResponse.ok) throw new Error(await responseError(finalizedResponse, "替换图片确认失败"));
    return ((await finalizedResponse.json()) as FinalizedAttachment).attachmentId;
  };
  const prepared = isImageAttachment(source)
    ? await prepareAttachmentForUpload(source)
    : await normalizeReceivingImageForUpload(source);
  try {
    return await upload(prepared);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Uploaded object is not a valid file of the declared type") {
      throw error;
    }
    return upload(await normalizeReceivingImageForUpload(source));
  }
};

export function OrderBoardPage() {
  const [startDate, setStartDate] = useState(localDate);
  const [endDate, setEndDate] = useState(localDate);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<BoardStatus>("all");
  const debouncedQuery = useDebouncedValue(query, 180);
  const [data, setData] = useState<BoardResult | null>(null);
  const [message, setMessage] = useState("正在加载订单回货…");
  const [pageLoading, setPageLoading] = useState(false);
  const [canReceive, setCanReceive] = useState(false);
  const [canInitiate, setCanInitiate] = useState(false);
  const [canExport, setCanExport] = useState(false);
  const [canResolveDifferences, setCanResolveDifferences] = useState(false);
  const [canManagePacking, setCanManagePacking] = useState(false);
  const [isRoot, setIsRoot] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [page, setPage] = useState(1);
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<BoardRow | null>(null);
  const [correctingReceipt, setCorrectingReceipt] = useState<ReceivingHistoryItem | null>(null);
  const [deleting, setDeleting] = useState<BoardRow | null>(null);
  const [editStyleNo, setEditStyleNo] = useState("");
  const [editDocumentQuantity, setEditDocumentQuantity] = useState("");
  const [editActualQuantity, setEditActualQuantity] = useState("");
  const [editDefectiveQuantity, setEditDefectiveQuantity] = useState("");
  const [editImages, setEditImages] = useState<readonly File[]>([]);
  const [receiptSource, setReceiptSource] = useState<"" | "jiashun" | "other_factory">("");
  const [receiptDocumentQuantity, setReceiptDocumentQuantity] = useState("");
  const [receiptActualQuantity, setReceiptActualQuantity] = useState("");
  const [receiptDefectiveQuantity, setReceiptDefectiveQuantity] = useState("");
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationMessage, setMutationMessage] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [packingEditing, setPackingEditing] = useState<BoardRow | null>(null);
  const [packingQuantity, setPackingQuantity] = useState("");
  const [packingRequestKey, setPackingRequestKey] = useState("");
  const [differenceEditing, setDifferenceEditing] = useState<Readonly<{
    row: BoardRow;
    type: "receiving" | "packing";
    resolution: DifferenceResolution | null;
  }> | null>(null);
  const [differenceResult, setDifferenceResult] = useState("");
  const [differenceRequestKey, setDifferenceRequestKey] = useState("");
  const [differenceImages, setDifferenceImages] = useState<readonly { file: File; previewUrl: string }[]>([]);
  const differenceUploaded = useRef(new Map<File, string>());
  const differencePreviewUrls = useRef(new Set<string>());
  const differenceSubmitting = useRef(false);
  useEffect(() => {
    const urls = differencePreviewUrls.current;
    return () => { for (const url of urls) URL.revokeObjectURL(url); };
  }, []);
  const clearDifferenceImages = () => {
    for (const url of differencePreviewUrls.current) URL.revokeObjectURL(url);
    differencePreviewUrls.current.clear();
    differenceUploaded.current.clear();
    setDifferenceImages([]);
  };
  const closeDifference = () => {
    if (differenceSubmitting.current) return;
    clearDifferenceImages();
    setDifferenceEditing(null);
  };
  const selectDifferenceImages = (files: FileList | null) => {
    if (!files?.length || mutationBusy) return;
    const selected = Array.from(files);
    if (differenceImages.length + selected.length > 3) { setMutationMessage("处理凭证最多3张"); return; }
    if (selected.some((file) => !isReceivingImageCandidate(file))) { setMutationMessage("请选择JPEG、PNG、WebP图片"); return; }
    const additions = selected.map((file) => {
      const previewUrl = URL.createObjectURL(file);
      differencePreviewUrls.current.add(previewUrl);
      return { file, previewUrl };
    });
    setDifferenceImages((current) => [...current, ...additions]);
    setMutationMessage("");
  };
  const [attachmentViewer, setAttachmentViewer] = useState<Readonly<{
    attachments: readonly ReceivingAttachment[];
    index: number;
    title?: string;
  }> | null>(null);

  const resetPagination = () => {
    setPage(1);
  };

  useEffect(() => {
    let active = true;
    void verifySession()
      .then((session) => {
        if (!active || session === "denied" || session.status !== "authorized") return;
        const isRoot = session.user.isRoot === true;
        const roles = session.user.businessRoles ?? [];
        const capabilities = session.user.capabilities;
        const warehouseReceiver = roles.includes("warehouse_receiver")
          && capabilities.includes("receiving:create");
        const qualityControl = roles.includes("quality_control")
          && capabilities.includes("rework:initiate");
        setCanReceive(isRoot || warehouseReceiver);
        setCanInitiate(moduleCanWrite(session.user, "rework") && (isRoot || roles.includes("owner_group") || qualityControl));
        setCanExport(isRoot || capabilities.includes("receiving:export"));
        setCanResolveDifferences(isRoot || (
          roles.includes("order_merchandiser") && capabilities.includes("receiving:resolve_difference")
        ));
        setCanManagePacking(isRoot || (
          roles.includes("warehouse_receiver") && capabilities.includes("receiving:packing_manage")
        ));
        setIsRoot(isRoot);
      })
      .catch(() => {
        if (!active) return;
        setCanReceive(false);
        setCanInitiate(false);
        setCanExport(false);
        setCanResolveDifferences(false);
        setCanManagePacking(false);
        setIsRoot(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setPageLoading(true);
    const params = new URLSearchParams({ startDate, endDate });
    params.set("status", status);
    params.set("page", String(page));
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim().toUpperCase());
    void fetch(apiUrl(`receiving/board?${params.toString()}`), { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("订单回货加载失败");
        return response.json() as Promise<BoardResult>;
      })
      .then((body) => {
        if (!active) return;
        setData(body);
        setMessage(body.rows.length
          ? ""
          : body.mode === "search"
            ? "全时间范围内没有匹配的收货记录"
            : "选中日期内没有收货记录");
      })
      .catch(() => {
        if (!active) return;
        setMessage("订单回货加载失败，请刷新后重试");
      })
      .finally(() => {
        if (active) setPageLoading(false);
      });
    return () => { active = false; };
  }, [startDate, endDate, debouncedQuery, status, page, refreshToken]);

  const kpis = useMemo(() => data?.kpis ?? {
    orderCount: 0,
    receivedQuantity: 0,
    abnormalOrderCount: 0,
    differenceQuantity: 0,
    differenceRate: 0,
  }, [data]);
  const selectedAttachment = attachmentViewer?.attachments[attachmentViewer.index] ?? null;
  const dateRangeLabel = startDate === endDate ? startDate : `${startDate} 至 ${endDate}`;
  const searchMode = data?.mode === "search";
  const kpiRangeLabel = searchMode ? "全时间 · 不受所选日期影响" : dateRangeLabel;
  const liveOperationSnapshot = searchMode || endDate >= localDate();

  const downloadExport = async () => {
    if (exportBusy) return;
    setExportBusy(true);
    try {
      const params = new URLSearchParams({ startDate, endDate, status });
      if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim().toUpperCase());
      const response = await fetch(apiUrl(`receiving/board/export?${params.toString()}`), {
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await responseError(response, "订单回货导出失败"));
      const blobUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = `订单回货-${endDate}.xlsx`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (error) {
      const text = error instanceof Error ? error.message : "订单回货导出失败";
      setMutationMessage(text);
      await alertInApp(text, { title: "导出失败" });
    } finally {
      setExportBusy(false);
    }
  };

  const openPacking = (row: BoardRow) => {
    setDifferenceEditing(null);
    setPackingEditing(row);
    setPackingQuantity(row.packingQuantity === null ? "" : String(row.packingQuantity));
    setPackingRequestKey(createClientRequestId());
    setMutationMessage("");
  };

  const submitPacking = async () => {
    if (!packingEditing || mutationBusy) return;
    const value = Number(packingQuantity);
    if (!Number.isInteger(value) || value < 0 || value > 10_000_000) {
      setMutationMessage("装箱数量必须是0到10000000之间的整数");
      return;
    }
    setMutationBusy(true);
    setMutationMessage("");
    try {
      const response = await fetch(apiUrl(`receiving/batches/${packingEditing.receivingBatchId}/packing-revisions`), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "idempotency-key": packingRequestKey },
        body: JSON.stringify({
          expectedVersion: packingEditing.version,
          expectedPackingRevisionId: packingEditing.packingRevisionId,
          packingQuantity: value,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "装箱数量保存失败"));
      setPackingEditing(null);
      setRefreshToken((current) => current + 1);
      setMutationMessage("装箱数量已保存");
    } catch (error) {
      const text = error instanceof Error ? error.message : "装箱数量保存失败";
      setMutationMessage(text);
    } finally {
      setMutationBusy(false);
    }
  };

  const openDifference = (row: BoardRow, type: "receiving" | "packing") => {
    const resolution = type === "receiving"
      ? row.receivingDifferenceResolution
      : row.packingDifferenceResolution;
    setPackingEditing(null);
    clearDifferenceImages();
    setDifferenceEditing({ row, type, resolution });
    setDifferenceResult("");
    setDifferenceRequestKey(createClientRequestId());
    setMutationMessage("");
  };

  const submitDifference = async () => {
    if (!differenceEditing || differenceEditing.resolution || mutationBusy || differenceSubmitting.current) return;
    const result = differenceResult.trim();
    if (!result || result.length > 500) {
      setMutationMessage("处理结果不能为空且不能超过500个字符");
      return;
    }
    differenceSubmitting.current = true;
    setMutationBusy(true);
    setMutationMessage("");
    try {
      const attachmentIds: string[] = [];
      for (const image of differenceImages) {
        let attachmentId = differenceUploaded.current.get(image.file);
        if (!attachmentId) {
          attachmentId = await uploadReplacementImage(image.file);
          differenceUploaded.current.set(image.file, attachmentId);
        }
        attachmentIds.push(attachmentId);
      }
      const row = differenceEditing.row;
      const response = await fetch(apiUrl(`receiving/batches/${row.receivingBatchId}/difference-resolutions`), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "idempotency-key": differenceRequestKey },
        body: JSON.stringify({
          expectedVersion: row.version,
          expectedDocumentQuantity: row.documentQuantity,
          expectedActualQuantity: row.cumulativeActualQuantity,
          expectedPackingRevisionId: row.packingRevisionId,
          differenceType: differenceEditing.type,
          result,
          ...(attachmentIds.length ? { attachmentIds } : {}),
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "差异处理提交失败"));
      clearDifferenceImages();
      setDifferenceEditing(null);
      setRefreshToken((current) => current + 1);
      setMutationMessage("差异处理结果已保存");
    } catch (error) {
      const text = error instanceof Error ? error.message : "差异处理提交失败";
      setMutationMessage(text);
    } finally {
      differenceSubmitting.current = false;
      setMutationBusy(false);
    }
  };

  const reworkControl = (row: BoardRow) => {
    const className = "order-board-rework-link";
    const label = reworkLabel(row.reworkStatus);
    if (row.reworkStatus === null) {
      if (!canInitiate) return null;
      const params = new URLSearchParams({ receivingBatchId: row.receivingBatchId });
      return <a className={className} href={`${pageUrl("ui/qc/new")}?${params.toString()}`}>{label}</a>;
    }
    if (row.reworkOrderId && canInitiate) {
      return <a className={className} href={pageUrl(`ui/tasks/${row.reworkOrderId}`)}>{label}</a>;
    }
    return <span className={`${className} is-readonly`}>{label}</span>;
  };

  const openEdit = (row: BoardRow) => {
    setDeleting(null);
    setEditing(row);
    setEditStyleNo(row.styleNo);
    setEditDocumentQuantity(String(row.documentQuantity));
    setEditActualQuantity(String(row.currentActualQuantity));
    setEditDefectiveQuantity(String(row.currentDefectiveQuantity));
    setEditImages([]);
    setMutationMessage("");
  };

  const rootControls = (row: BoardRow, mobile: boolean) => {
    if (!isRoot || (!row.rootCorrectable && !row.rootDeletable)) return null;
    return <div className={`order-board-root-actions order-board-root-actions--${mobile ? "mobile" : "desktop"}`}>
      {row.rootCorrectable ? <button type="button" onClick={() => openEdit(row)}>修改</button> : null}
      {row.rootDeletable ? <button type="button" className="is-danger" onClick={() => { setEditing(null); setDeleting(row); setMutationMessage(""); }}>删除</button> : null}
    </div>;
  };

  const actionControls = (row: BoardRow, mobile: boolean) => {
    const root = rootControls(row, mobile);
    if (!root) return null;
    return <div className={`order-board-actions order-board-actions--${mobile ? "mobile" : "desktop"}`}>
      {root}
    </div>;
  };

  const differenceControl = (row: BoardRow, type: "receiving" | "packing") => {
    const value = type === "receiving" ? row.differenceQuantity : row.packingDifferenceQuantity;
    const resolution = type === "receiving"
      ? row.receivingDifferenceResolution
      : row.packingDifferenceResolution;
    const canHandle = canResolveDifferences;
    if (value === null) return <strong>-</strong>;
    return <>
      <strong>{value === 0 ? "无差异" : signedQuantity(value)}</strong>
      {value !== 0 && resolution ? <button
        type="button"
        className="order-board-operation-button is-resolved"
        onClick={() => openDifference(row, type)}
      >已处理</button> : null}
      {value !== 0 && !resolution && canHandle && liveOperationSnapshot ? <button
        type="button"
        className="order-board-operation-button"
        onClick={() => openDifference(row, type)}
      >去处理</button> : null}
      {value !== 0 && !resolution && !canHandle ? <small>未处理</small> : null}
      {value !== 0 && !resolution && canHandle && !liveOperationSnapshot ? <small>历史只读</small> : null}
    </>;
  };

  const toggleHistory = (receivingBatchId: string) => {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(receivingBatchId)) next.delete(receivingBatchId);
      else next.add(receivingBatchId);
      return next;
    });
  };

  const openReceiptCorrection = (item: ReceivingHistoryItem) => {
    setEditing(null);
    setDeleting(null);
    setCorrectingReceipt(item);
    setReceiptSource(
      item.receivingSource === "jiashun" || item.receivingSource === "other_factory"
        ? item.receivingSource
        : "",
    );
    setReceiptDocumentQuantity(String(item.receiptDocumentQuantity));
    setReceiptActualQuantity(String(item.actualQuantity));
    setReceiptDefectiveQuantity(String(item.defectiveQuantity));
    setMutationMessage("");
  };

  const submitReceiptCorrection = async () => {
    if (!correctingReceipt || mutationBusy) return;
    if (Number(receiptDefectiveQuantity) > Number(receiptActualQuantity)) {
      setMutationMessage("次品数量不能超过实际收货数量");
      return;
    }
    setMutationBusy(true);
    setMutationMessage("");
    try {
      const response = await fetch(apiUrl(`receiving/receipts/${correctingReceipt.receiptId}/corrections`), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: correctingReceipt.batchVersion,
          source: receiptSource,
          documentQuantity: Number(receiptDocumentQuantity),
          actualQuantity: Number(receiptActualQuantity),
          defectiveQuantity: Number(receiptDefectiveQuantity),
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "收货记录修正失败"));
      setCorrectingReceipt(null);
      setRefreshToken((value) => value + 1);
      setMutationMessage("本次收货已修正");
    } catch (error) {
      setMutationMessage(error instanceof Error ? error.message : "收货记录修正失败");
    } finally {
      setMutationBusy(false);
    }
  };

  const submitCorrection = async () => {
    if (!editing || mutationBusy) return;
    if (Number(editDefectiveQuantity) > Number(editActualQuantity)) {
      setMutationMessage("次品数量不能超过实际收货数量");
      return;
    }
    if (editImages.some((file) => !isReceivingImageCandidate(file))) {
      setMutationMessage("请选择手机相册中的图片文件");
      return;
    }
    setMutationBusy(true);
    setMutationMessage("");
    try {
      const attachmentIds = editImages.length > 0
        ? await Promise.all(editImages.map(uploadReplacementImage))
        : undefined;
      const response = await fetch(apiUrl(`receiving/batches/${editing.receivingBatchId}`), {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedVersion: editing.version,
          styleNo: editStyleNo,
          documentQuantity: Number(editDocumentQuantity),
          actualQuantity: Number(editActualQuantity),
          defectiveQuantity: Number(editDefectiveQuantity),
          ...(attachmentIds ? { attachmentIds } : {}),
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "收货订单修改失败"));
      setEditing(null);
      setRefreshToken((value) => value + 1);
      setMutationMessage("收货订单已修改");
    } catch (error) {
      setMutationMessage(error instanceof Error ? error.message : "收货订单修改失败");
    } finally {
      setMutationBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting || mutationBusy) return;
    setMutationBusy(true);
    setMutationMessage("");
    try {
      const response = await fetch(apiUrl(`receiving/batches/${deleting.receivingBatchId}`), {
        method: "DELETE",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: deleting.version }),
      });
      if (!response.ok) throw new Error(await responseError(response, "收货订单删除失败"));
      setDeleting(null);
      setRefreshToken((value) => value + 1);
      setMutationMessage("收货订单已删除");
    } catch (error) {
      setMutationMessage(error instanceof Error ? error.message : "收货订单删除失败");
    } finally {
      setMutationBusy(false);
    }
  };

  return <div className="order-board-page">
    <div className="order-board-heading">
      <div className="order-board-heading__title">
        {new URLSearchParams(window.location.search).get("returnTo")==="/ui/receiving"&&<a href={pageUrl("/ui/receiving")}>返回仓库收货</a>}
        <h1><NavigationIcon route="/ui/orders" size="title" />订单回货</h1>
        <p>快速查看收货数量差异；少收订单默认置顶。</p>
      </div>
      <div className="order-board-filters">
        {canExport ? <button
          type="button"
          className="order-board-export-button"
          title="按当前筛选导出Excel"
          aria-label="按当前筛选导出Excel"
          disabled={exportBusy}
          onClick={() => void downloadExport()}
        >{exportBusy ? "…" : "导出"}</button> : null}
        <label>开始日期<input type="date" value={startDate} max={endDate} onChange={(event) => { resetPagination(); setStartDate(event.target.value); }} /></label>
        <label>结束日期<input type="date" value={endDate} min={startDate} onChange={(event) => { resetPagination(); setEndDate(event.target.value); }} /></label>
        <label>款号<input type="search" placeholder="快速搜索款号" value={query} onChange={(event) => { resetPagination(); setQuery(event.target.value.toUpperCase()); }} /></label>
        <label>状态<select value={status} onChange={(event) => { resetPagination(); setStatus(event.target.value as BoardStatus); }}>
          <option value="all">全部状态</option>
          <option value="receiving_difference">回货有差异</option>
          <option value="packing_difference">装箱有差异</option>
          <option value="missing_packing">装箱未记录</option>
          <option value="pending">待处理</option>
          <option value="handled">已有处理</option>
          <option value="stale">待复核旧处理</option>
          <option value="normal">正常</option>
          <option value="short">少收</option>
          <option value="extra">多收</option>
          <option value="multiple">多次收货</option>
        </select></label>
      </div>
      <div className="order-board-heading__action">
        {canReceive ? <a className="order-board-receiving-link" href={pageUrl("ui/receiving")}>＋ 仓库收货</a> : null}
      </div>
    </div>

    <div className="order-board-insights" aria-label="当前筛选异常摘要">
      <button aria-pressed={status === "pending"} disabled={pageLoading} onClick={() => { resetPagination(); setStatus("pending"); }}>待处理差异 {data?.insights?.pendingCount ?? "—"}</button>
      <button aria-pressed={status === "missing_packing"} disabled={pageLoading} onClick={() => { resetPagination(); setStatus("missing_packing"); }}>装箱未记录 {data?.insights?.missingPackingCount ?? "—"}</button>
      <button aria-pressed={status === "stale"} disabled={pageLoading} onClick={() => { resetPagination(); setStatus("stale"); }}>处理后数据变化 {data?.insights?.staleCount ?? "—"}</button>
      {status !== "all" ? <button onClick={() => { resetPagination(); setStatus("all"); }}>查看全部</button> : null}
    </div>
    <div className="order-board-kpis">
      <KpiInstrument
        label={searchMode ? "搜索结果订单数" : "期间收货订单数"}
        value={quantity(kpis.orderCount)}
        detail={kpiRangeLabel}
        tone="info"
      />
      <KpiInstrument
        label={searchMode ? "搜索结果累计实收" : "期间实收数量"}
        value={`${quantity(kpis.receivedQuantity)}件`}
        detail={searchMode ? kpiRangeLabel : `${kpiRangeLabel} · 本期实收`}
        tone="info"
      />
      <KpiInstrument
        label="异常订单数量"
        value={quantity(kpis.abnormalOrderCount)}
        detail={searchMode ? "全时间累计实收与送货单数量不一致" : "截至结束日期累计实收与送货单数量不一致"}
        tone={kpis.abnormalOrderCount ? "warning" : "success"}
      />
      <KpiInstrument label="差异率" value={`${formatBusinessDecimal(kpis.differenceRate)}%`} detail={`绝对差异 ${quantity(kpis.differenceQuantity)} 件`} tone={kpis.differenceRate ? "warning" : "success"} />
    </div>

    <div className="order-board-legend" aria-label="差异颜色说明">
      <span><i className="is-short" />少收</span>
      <span><i className="is-extra" />多收</span>
      <span><i className="is-even" />无差异</span>
    </div>

    <div className="order-board-list">
      {data?.rows.map((row) => {
        const tone = row.differenceQuantity < 0 ? "short" : row.differenceQuantity > 0 ? "extra" : "even";
        const historyExpanded = expandedRows.has(row.receivingBatchId);
        return <div className="order-board-item" key={row.receivingBatchId}>
        <Surface className={`order-board-row is-${tone}`}>
          <div className="order-board-row__main">
            <div className="order-board-row__style">
              <div className="order-board-row__style-heading"><span>款号</span>{reworkControl(row)}</div>
              <div className="order-board-row__style-line">
                <strong>{row.styleNo}</strong>
                <StatusBadge tone={tone === "short" ? "danger" : tone === "extra" ? "info" : "success"}>
                  {tone === "short" ? "少收" : tone === "extra" ? "多收" : "正常"}
                </StatusBadge>
              </div>
              {row.receiptCount > 1 ? <button
                type="button"
                className="order-board-history-toggle"
                aria-expanded={historyExpanded}
                onClick={() => toggleHistory(row.receivingBatchId)}
              >第{row.receiptCount}次收货 <span>{historyExpanded ? "收起" : "查看记录"}</span></button> : null}
            </div>
            <div className="order-board-row__confirmation-item order-board-row__cutting-confirmation">
              <span>裁床登记人</span>
              <strong>{row.cuttingRecordedBy && row.cuttingRecordedAt ? `${row.cuttingRecordedBy} · ${dateTime(row.cuttingRecordedAt)}` : "—"}</strong>
            </div>
            <div className="order-board-row__confirmation-item order-board-row__receiving-confirmation">
              <span>收货人</span>
              <strong>{row.lastReceiverName} · {dateTime(row.lastReceivedAt)}</strong>
            </div>
            <div className="order-board-row__confirmation-item order-board-row__packing-confirmation">
              <span>装箱确认人</span>
              <strong>{row.packingRecordedBy && row.packingRecordedAt ? `${row.packingRecordedBy} · ${dateTime(row.packingRecordedAt)}` : "-"}</strong>
            </div>
            {actionControls(row, false)}
            {actionControls(row, true)}
          </div>
          <div className="order-board-row__facts">
            <div className="order-board-row__cutting">
              <span>实裁数</span>
              <strong>{row.actualCutCount === null ? "—" : `${quantity(row.actualCutCount)}件`}</strong>
            </div>
            <div className="order-board-row__document">
              <span>送货单数量</span>
              <div className="order-board-row__document-value">
                <strong>{quantity(row.documentQuantity)}件</strong>
                {row.attachments.length ? <button
                  type="button"
                  className="order-board-attachment-button"
                  aria-label={`查看${row.styleNo}的送货单附件，共${quantity(row.attachments.length)}张`}
                  onClick={() => setAttachmentViewer({ attachments: row.attachments, index: 0 })}
                >查看{row.attachments.length > 1 ? `(${row.attachments.length})` : ""}</button> : null}
              </div>
            </div>
            <div className="order-board-row__actual"><span>实收</span><strong>{quantity(row.cumulativeActualQuantity)}件</strong></div>
            <div className="order-board-row__defective"><span>次品</span><strong>{quantity(row.defectiveQuantity)}件</strong></div>
            <div className="order-board-operation order-board-row__difference">
              <span>收货差异</span>
              <div>{differenceControl(row, "receiving")}</div>
            </div>
            <div className="order-board-operation order-board-row__packing">
              <span>装箱数量</span>
              <div>
                <strong>{row.packingQuantity === null ? "-" : `${quantity(row.packingQuantity)}件`}</strong>
                {canManagePacking && liveOperationSnapshot && (row.packingQuantity === null || isRoot) ? <button
                  type="button"
                  className="order-board-packing-button"
                  onClick={() => openPacking(row)}
                >{row.packingQuantity === null ? "录入" : "修改"}</button> : null}
              </div>
            </div>
            <div className="order-board-operation order-board-row__packing-difference">
              <span>装箱差异</span>
              <div>{differenceControl(row, "packing")}</div>
            </div>
          </div>
        </Surface>
        {row.staleResolution ? <details className="order-board-stale-resolution"><summary>处理后数据已变化 · 待复核</summary>
          <p>旧处理对应当时快照，请按当前数量重新核对。原处理记录保留。</p>
          {row.resolutionHistory?.map(record => <div key={record.resolutionId}><strong>{record.differenceType === "receiving" ? "收货" : "装箱"}历史差异 {signedQuantity(record.differenceQuantity)}</strong><span>{record.result} · {record.handledBy} · {historyDateTime(record.handledAt)}</span>
            {record.attachments?.length ? <button onClick={() => setAttachmentViewer({ attachments: record.attachments!, index: 0, title: "历史处理凭证" })}>查看处理凭证</button> : null}
          </div>)}
        </details> : null}
        {historyExpanded ? <section className="order-board-history" aria-label={`${row.styleNo}多次收货记录`}>
          {row.receivingHistory.map((item) => {
            const historyTone = item.differenceQuantity < 0 ? "short" : item.differenceQuantity > 0 ? "extra" : "even";
            const historyStatus = item.differenceQuantity < 0
              ? `少收${quantity(Math.abs(item.differenceQuantity))}件`
              : item.differenceQuantity > 0
                ? `多收${quantity(item.differenceQuantity)}件`
                : "正常";
            return <article className={`order-board-history__entry is-${historyTone}`} key={item.receiptId}>
              <strong>第{item.sequence}次收货</strong>
              <span className="order-board-history__source">{item.receivingSource === "other_factory"
                ? "其他工厂"
                : item.receivingSource === "jiashun"
                  ? "嘉顺"
                  : "来源待确认"}</span>
              <span>本次送货单 <strong>{quantity(item.receiptDocumentQuantity)}件</strong></span>
              <span>本次实收 <strong>{quantity(item.actualQuantity)}件</strong></span>
              <span>累计实收 {quantity(item.cumulativeActualQuantity)}件</span>
              <span className="order-board-history__status">{historyStatus}</span>
              <span>收货人 {item.receiverName}</span>
              <time dateTime={item.receivedAt}>{historyDateTime(item.receivedAt)}</time>
              {isRoot ? <button type="button" onClick={() => openReceiptCorrection(item)}>修正本次</button> : null}
            </article>;
          })}
        </section> : null}
        </div>;
      })}
    </div>
    {message ? <p className="order-board-message" role="status">{message}</p> : null}
    {data ? <ListPagination
      page={data.page}
      totalPages={data.totalPages}
      busy={pageLoading}
      ariaLabel="订单回货分页"
      onPageChange={setPage}
    /> : null}
    {mutationMessage && !editing && !deleting && !correctingReceipt && !packingEditing && !differenceEditing
      ? <p className="order-board-mutation-message" role="status">{mutationMessage}</p>
      : null}

    {attachmentViewer && selectedAttachment ? <ReceivingDialog title={attachmentViewer.title ?? "送货单附件"} onClose={() => setAttachmentViewer(null)}>
      <section
        className="order-board-attachment-modal__content"
        role="region"
        aria-label={`查看${attachmentViewer.title ?? "送货单附件"}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="order-board-attachment-modal__heading">
          <strong>{attachmentViewer.title ?? "送货单附件"} {attachmentViewer.index + 1}/{attachmentViewer.attachments.length}</strong>
          <button type="button" onClick={() => setAttachmentViewer(null)}>关闭</button>
        </div>
        <ImageViewer src={attachmentUrl(selectedAttachment.attachmentId, "preview")} alt={selectedAttachment.filename} />
        <div className="order-board-attachment-modal__actions">
          {attachmentViewer.attachments.length > 1 ? <>
            <button
              type="button"
              disabled={attachmentViewer.index === 0}
              onClick={() => setAttachmentViewer((current) => current && ({ ...current, index: current.index - 1 }))}
            >上一张</button>
            <button
              type="button"
              disabled={attachmentViewer.index === attachmentViewer.attachments.length - 1}
              onClick={() => setAttachmentViewer((current) => current && ({ ...current, index: current.index + 1 }))}
            >下一张</button>
          </> : null}
          <a href={attachmentUrl(selectedAttachment.attachmentId, "download")} rel="noreferrer" target="_blank">下载原图</a>
        </div>
      </section>
    </ReceivingDialog> : null}

    {packingEditing ? <ReceivingDialog title="录入装箱数量" busy={mutationBusy} onClose={() => setPackingEditing(null)}>
      <form className="order-board-dialog" aria-label="录入装箱数量" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submitPacking(); }}>
        <h2>{packingEditing.packingQuantity === null ? "录入" : "修改"}装箱数量</h2>
        <p>款号：<strong>{packingEditing.styleNo}</strong>。填写当前累计已装箱数量；保存后保留上一版本。</p>
        <label>当前累计已装箱数量<input type="number" min="0" max="10000000" step="1" inputMode="numeric" value={packingQuantity} disabled={mutationBusy} onChange={(event) => setPackingQuantity(event.target.value)} /></label>
        {mutationMessage ? <p className="order-board-dialog__error" role="alert">{mutationMessage}</p> : null}
        <div className="order-board-dialog__actions">
          <button type="button" disabled={mutationBusy} onClick={() => setPackingEditing(null)}>取消</button>
          <button type="submit" className="is-primary" disabled={mutationBusy || packingQuantity === ""}>{mutationBusy ? "保存中…" : "保存"}</button>
        </div>
      </form>
    </ReceivingDialog> : null}

    {differenceEditing ? <ReceivingDialog title="差异处理" busy={mutationBusy} onClose={() => closeDifference()}>
      <form className="order-board-dialog order-board-difference-dialog" aria-label={`${differenceEditing.type === "receiving" ? "收货" : "装箱"}差异处理`} onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submitDifference(); }}>
        <h2>{differenceEditing.type === "receiving" ? "收货差异" : "装箱差异"}{differenceEditing.resolution ? "处理结果" : "去处理"}</h2>
        <dl className="order-board-difference-snapshot">
          <div><dt>款号</dt><dd>{differenceEditing.row.styleNo}</dd></div>
          <div><dt>实收数量</dt><dd>{quantity(differenceEditing.row.cumulativeActualQuantity)}件</dd></div>
          {differenceEditing.type === "receiving"
            ? <div><dt>送货单数量</dt><dd>{quantity(differenceEditing.row.documentQuantity)}件</dd></div>
            : <div><dt>装箱数量</dt><dd>{differenceEditing.row.packingQuantity === null ? "-" : `${quantity(differenceEditing.row.packingQuantity)}件`}</dd></div>}
          <div><dt>当前差异</dt><dd>{signedQuantity(differenceEditing.type === "receiving" ? differenceEditing.row.differenceQuantity : differenceEditing.row.packingDifferenceQuantity ?? 0)}</dd></div>
        </dl>
        {differenceEditing.resolution ? <div className="order-board-resolution-detail">
          <strong>处理结果</strong>
          <p>{differenceEditing.resolution.result}</p>
          <small>处理人：{differenceEditing.resolution.handledBy} · {historyDateTime(differenceEditing.resolution.handledAt)}</small>
        </div> : <label>处理结果<textarea maxLength={500} rows={4} value={differenceResult} disabled={mutationBusy} onChange={(event) => setDifferenceResult(event.target.value)} placeholder="填写核对结果和后续处理情况" /></label>}
        {differenceEditing.resolution ? (differenceEditing.resolution.attachments?.length ? <div className="order-board-difference-evidence">
          <strong>处理凭证</strong>
          <div className="order-board-difference-evidence__images">
            {differenceEditing.resolution.attachments.map((attachment, index, attachments) => <button
              key={attachment.attachmentId} type="button" className="order-board-difference-evidence__preview"
              aria-label={`查看处理凭证${index + 1}`}
              onClick={() => setAttachmentViewer({ attachments, index, title: "处理凭证" })}
            ><img src={attachmentUrl(attachment.attachmentId, "preview")} alt={`处理凭证${index + 1}`} /></button>)}
          </div>
        </div> : null) : <div className="order-board-difference-evidence">
          <label>处理凭证（选填，最多3张）<input type="file" accept="image/*" multiple
            disabled={mutationBusy || differenceImages.length >= 3}
            onChange={(event) => { selectDifferenceImages(event.target.files); event.target.value = ""; }} /></label>
          <div className="order-board-difference-evidence__images">
            {differenceImages.map((image) => <div key={image.previewUrl}>
              <img src={image.previewUrl} alt={image.file.name} />
              <button type="button" disabled={mutationBusy} onClick={() => {
                URL.revokeObjectURL(image.previewUrl);
                differencePreviewUrls.current.delete(image.previewUrl);
                differenceUploaded.current.delete(image.file);
                setDifferenceImages((current) => current.filter((item) => item !== image));
              }}>移除</button>
            </div>)}
          </div>
        </div>}
        {mutationMessage ? <p className="order-board-dialog__error" role="alert">{mutationMessage}</p> : null}
        <div className="order-board-dialog__actions">
          <button type="button" disabled={mutationBusy} onClick={closeDifference}>{differenceEditing.resolution ? "关闭" : "取消"}</button>
          {!differenceEditing.resolution ? <button type="submit" className="is-primary" disabled={mutationBusy || !differenceResult.trim()}>{mutationBusy ? "提交中…" : "提交处理"}</button> : null}
        </div>
      </form>
    </ReceivingDialog> : null}

    {correctingReceipt ? <ReceivingDialog title="修正本次收货" busy={mutationBusy} onClose={() => setCorrectingReceipt(null)}>
      <form className="order-board-dialog" aria-label="修正本次收货" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submitReceiptCorrection(); }}>
        <h2>修正第{correctingReceipt.sequence}次收货</h2>
        <p>原始收货记录不会被覆盖，本次修正会单独保存操作人和时间。</p>
        <label>收货来源<select value={receiptSource} disabled={mutationBusy} onChange={(event) => setReceiptSource(event.target.value as "" | "jiashun" | "other_factory")}>
          <option value="" disabled>请选择收货来源</option>
          <option value="jiashun">嘉顺收货</option>
          <option value="other_factory">其他工厂收货</option>
        </select></label>
        <div className="order-board-dialog__quantity-grid">
          <label>本次送货单数量<input type="number" min="1" max="10000000" step="1" inputMode="numeric" value={receiptDocumentQuantity} disabled={mutationBusy} onChange={(event) => setReceiptDocumentQuantity(event.target.value)} /></label>
          <label>本次实际收货数量<input type="number" min="0" max="10000000" step="1" inputMode="numeric" value={receiptActualQuantity} disabled={mutationBusy} onChange={(event) => setReceiptActualQuantity(event.target.value)} /></label>
          <label>本次次品数量<input type="number" min="0" max="10000000" step="1" inputMode="numeric" value={receiptDefectiveQuantity} disabled={mutationBusy} onChange={(event) => setReceiptDefectiveQuantity(event.target.value)} /></label>
        </div>
        {mutationMessage ? <p className="order-board-dialog__error" role="alert">{mutationMessage}</p> : null}
        <div className="order-board-dialog__actions">
          <button type="button" disabled={mutationBusy} onClick={() => setCorrectingReceipt(null)}>取消</button>
          <button type="submit" className="is-primary" disabled={mutationBusy || !receiptSource || !receiptDocumentQuantity || receiptActualQuantity === "" || receiptDefectiveQuantity === ""}>{mutationBusy ? "保存中…" : "保存修正"}</button>
        </div>
      </form>
    </ReceivingDialog> : null}

    {editing ? <ReceivingDialog title="修改收货订单" busy={mutationBusy} onClose={() => setEditing(null)}>
      <form className="order-board-dialog" aria-label="修改收货订单" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submitCorrection(); }}>
        <h2>修改收货订单</h2>
        <p>{editing.rootDeletable
          ? "款号改成已有款号时会自动合并；原始收货记录与被替换图片继续保留审计。"
          : "可纠正款号和数量；原始收货记录保留，已用于返工的送货单图片不变。"}</p>
        <label>款号<input value={editStyleNo} maxLength={100} disabled={mutationBusy} onChange={(event) => setEditStyleNo(event.target.value.toUpperCase())} /></label>
        <div className="order-board-dialog__quantity-grid">
          <label>送货单数量<input type="number" min="1" max="10000000" step="1" inputMode="numeric" value={editDocumentQuantity} disabled={mutationBusy} onChange={(event) => setEditDocumentQuantity(event.target.value)} /></label>
          <label>实际收货数量<input type="number" min="0" max="10000000" step="1" inputMode="numeric" value={editActualQuantity} disabled={mutationBusy} onChange={(event) => setEditActualQuantity(event.target.value)} /></label>
          <label>次品数量<input type="number" min="0" max="10000000" step="1" inputMode="numeric" value={editDefectiveQuantity} disabled={mutationBusy} onChange={(event) => setEditDefectiveQuantity(event.target.value)} /></label>
        </div>
        {editing.rootDeletable ? <label>替换送货单图片（可选，1–3张）
          <input
            type="file"
            accept="image/*"
            multiple
            disabled={mutationBusy}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length > 3) {
                setMutationMessage("替换送货单图片最多3张");
                event.target.value = "";
                return;
              }
              setEditImages(files);
              setMutationMessage("");
            }}
          />
        </label> : null}
        {editing.rootDeletable
          ? editImages.length > 0
            ? <small>已选择{quantity(editImages.length)}张；保存后整体替换当前图片。</small>
            : <small>不选择新图则保留当前图片。</small>
          : <small>返工已发起，送货单图片已锁定。</small>}
        {mutationMessage ? <p className="order-board-dialog__error" role="alert">{mutationMessage}</p> : null}
        <div className="order-board-dialog__actions">
          <button type="button" disabled={mutationBusy} onClick={() => setEditing(null)}>取消</button>
          <button type="submit" className="is-primary" disabled={mutationBusy || !editStyleNo.trim() || !editDocumentQuantity || editActualQuantity === "" || editDefectiveQuantity === ""}>{mutationBusy ? "保存中…" : "保存修改"}</button>
        </div>
      </form>
    </ReceivingDialog> : null}

    {deleting ? <ReceivingDialog title="删除收货订单" busy={mutationBusy} onClose={() => setDeleting(null)}>
      <div className="order-board-dialog order-board-delete-dialog" aria-label="删除收货订单" onMouseDown={(event) => event.stopPropagation()}>
        <h2>确认删除收货订单？</h2>
        <p>款号：<strong>{deleting.styleNo}</strong></p>
        <p>删除后从订单回货隐藏，原始收货记录与图片仍保留审计。此操作仅限尚未发起返工的订单。</p>
        {mutationMessage ? <p className="order-board-dialog__error" role="alert">{mutationMessage}</p> : null}
        <div className="order-board-dialog__actions">
          <button type="button" disabled={mutationBusy} onClick={() => setDeleting(null)}>取消</button>
          <button type="button" className="is-danger" disabled={mutationBusy} onClick={() => void confirmDelete()}>{mutationBusy ? "删除中…" : "确认删除"}</button>
        </div>
      </div>
    </ReceivingDialog> : null}
  </div>;
}
