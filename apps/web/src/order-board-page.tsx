import { KpiInstrument, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import {
  isImageAttachment,
  isReceivingImageCandidate,
  normalizeReceivingImageForUpload,
  prepareAttachmentForUpload,
  sha256Hex,
} from "./attachment-upload.js";
import { verifySession } from "./auth.js";
import { ImageViewer } from "./image-viewer.js";
import { ListPagination } from "./list-pagination.js";
import { useDebouncedValue } from "./use-debounced-value.js";
import "./order-board-page.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

type ReworkStatus = "draft" | "active" | "completed" | null;
type BoardStatus = "all" | "normal" | "extra" | "short" | "multiple";

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
  differenceQuantity: number;
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
  const [isRoot, setIsRoot] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [page, setPage] = useState(1);
  const [expandedStyles, setExpandedStyles] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<BoardRow | null>(null);
  const [correctingReceipt, setCorrectingReceipt] = useState<ReceivingHistoryItem | null>(null);
  const [deleting, setDeleting] = useState<BoardRow | null>(null);
  const [editStyleNo, setEditStyleNo] = useState("");
  const [editDocumentQuantity, setEditDocumentQuantity] = useState("");
  const [editActualQuantity, setEditActualQuantity] = useState("");
  const [editDefectiveQuantity, setEditDefectiveQuantity] = useState("");
  const [editImages, setEditImages] = useState<readonly File[]>([]);
  const [receiptSource, setReceiptSource] = useState<"jiashun" | "other_factory">("jiashun");
  const [receiptDocumentQuantity, setReceiptDocumentQuantity] = useState("");
  const [receiptActualQuantity, setReceiptActualQuantity] = useState("");
  const [receiptDefectiveQuantity, setReceiptDefectiveQuantity] = useState("");
  const [mutationBusy, setMutationBusy] = useState(false);
  const [mutationMessage, setMutationMessage] = useState("");
  const [attachmentViewer, setAttachmentViewer] = useState<Readonly<{
    attachments: readonly ReceivingAttachment[];
    index: number;
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
        setCanInitiate(isRoot || roles.includes("owner_group") || qualityControl);
        setIsRoot(isRoot);
      })
      .catch(() => {
        if (!active) return;
        setCanReceive(false);
        setCanInitiate(false);
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

  const toggleHistory = (styleNo: string) => {
    setExpandedStyles((current) => {
      const next = new Set(current);
      if (next.has(styleNo)) next.delete(styleNo);
      else next.add(styleNo);
      return next;
    });
  };

  const openReceiptCorrection = (item: ReceivingHistoryItem) => {
    setEditing(null);
    setDeleting(null);
    setCorrectingReceipt(item);
    setReceiptSource(item.receivingSource === "other_factory" ? "other_factory" : "jiashun");
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
        <h1>订单回货</h1>
        <p>快速查看收货数量差异；少收订单默认置顶。</p>
      </div>
      <div className="order-board-filters">
        <label>开始日期<input type="date" value={startDate} max={endDate} onChange={(event) => { resetPagination(); setStartDate(event.target.value); }} /></label>
        <label>结束日期<input type="date" value={endDate} min={startDate} onChange={(event) => { resetPagination(); setEndDate(event.target.value); }} /></label>
        <label>款号<input type="search" placeholder="快速搜索款号" value={query} onChange={(event) => { resetPagination(); setQuery(event.target.value.toUpperCase()); }} /></label>
        <label>状态<select value={status} onChange={(event) => { resetPagination(); setStatus(event.target.value as BoardStatus); }}>
          <option value="all">全部状态</option>
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

    <div className="order-board-kpis">
      <KpiInstrument
        label={searchMode ? "搜索结果订单数" : "期间收货订单数"}
        value={kpis.orderCount}
        detail={kpiRangeLabel}
        tone="info"
      />
      <KpiInstrument
        label={searchMode ? "搜索结果累计实收" : "期间实收数量"}
        value={`${kpis.receivedQuantity}件`}
        detail={searchMode ? kpiRangeLabel : `${kpiRangeLabel} · 本期实收`}
        tone="info"
      />
      <KpiInstrument
        label="异常订单数量"
        value={kpis.abnormalOrderCount}
        detail={searchMode ? "全时间累计实收与送货单数量不一致" : "截至结束日期累计实收与送货单数量不一致"}
        tone={kpis.abnormalOrderCount ? "warning" : "success"}
      />
      <KpiInstrument label="差异率" value={`${kpis.differenceRate}%`} detail={`绝对差异 ${kpis.differenceQuantity} 件`} tone={kpis.differenceRate ? "warning" : "success"} />
    </div>

    <div className="order-board-legend" aria-label="差异颜色说明">
      <span><i className="is-short" />少收</span>
      <span><i className="is-extra" />多收</span>
      <span><i className="is-even" />无差异</span>
    </div>

    <div className="order-board-list">
      {data?.rows.map((row) => {
        const tone = row.differenceQuantity < 0 ? "short" : row.differenceQuantity > 0 ? "extra" : "even";
        const signed = row.differenceQuantity > 0 ? `+${row.differenceQuantity}` : String(row.differenceQuantity);
        const historyExpanded = expandedStyles.has(row.styleNo);
        return <div className="order-board-item" key={row.receivingBatchId}>
        <Surface className={`order-board-row is-${tone}`}>
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
              onClick={() => toggleHistory(row.styleNo)}
            >第{row.receiptCount}次收货 <span>{historyExpanded ? "收起" : "查看记录"}</span></button> : null}
          </div>
          <div className="order-board-row__document">
            <span>送货单数量</span>
            <div className="order-board-row__document-value">
              <strong>{row.documentQuantity}件</strong>
              {row.attachments.length ? <button
                type="button"
                className="order-board-attachment-button"
                aria-label={`查看${row.styleNo}的送货单附件，共${row.attachments.length}张`}
                onClick={() => setAttachmentViewer({ attachments: row.attachments, index: 0 })}
              >查看{row.attachments.length > 1 ? `(${row.attachments.length})` : ""}</button> : null}
            </div>
          </div>
          <div className="order-board-row__actual"><span>实收</span><strong>{row.actualQuantity}件</strong></div>
          <div className="order-board-row__defective"><span>次品</span><strong>{row.defectiveQuantity}件</strong></div>
          <div className="order-board-row__difference"><span>差异</span><strong>{signed}件</strong></div>
          <div className="order-board-row__latest"><span>最近收货</span><strong>{dateTime(row.lastReceivedAt)}</strong></div>
          <div className="order-board-row__receiver"><span>收货人</span><strong>{row.lastReceiverName}</strong></div>
          {actionControls(row, false)}
          {actionControls(row, true)}
        </Surface>
        {historyExpanded ? <section className="order-board-history" aria-label={`${row.styleNo}多次收货记录`}>
          {row.receivingHistory.map((item) => {
            const historyTone = item.differenceQuantity < 0 ? "short" : item.differenceQuantity > 0 ? "extra" : "even";
            const historyStatus = item.differenceQuantity < 0
              ? `少收${Math.abs(item.differenceQuantity)}件`
              : item.differenceQuantity > 0
                ? `多收${item.differenceQuantity}件`
                : "正常";
            return <article className={`order-board-history__entry is-${historyTone}`} key={item.receiptId}>
              <strong>第{item.sequence}次收货</strong>
              <span>{item.receivingSource === "other_factory" ? "其他工厂" : "嘉顺"} · 本次送货单 {item.receiptDocumentQuantity}件</span>
              <span>本次实收 {item.actualQuantity}件</span>
              <span>累计实收 {item.cumulativeActualQuantity}件</span>
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
    {mutationMessage && !editing && !deleting ? <p className="order-board-mutation-message" role="status">{mutationMessage}</p> : null}

    {attachmentViewer && selectedAttachment ? <div
      className="order-board-attachment-modal"
      role="presentation"
      onMouseDown={() => setAttachmentViewer(null)}
    >
      <section
        className="order-board-attachment-modal__content"
        role="dialog"
        aria-modal="true"
        aria-label="查看送货单附件"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="order-board-attachment-modal__heading">
          <strong>送货单附件 {attachmentViewer.index + 1}/{attachmentViewer.attachments.length}</strong>
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
    </div> : null}

    {correctingReceipt ? <div className="order-board-dialog-backdrop" role="presentation" onMouseDown={() => !mutationBusy && setCorrectingReceipt(null)}>
      <form className="order-board-dialog" role="dialog" aria-modal="true" aria-label="修正本次收货" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submitReceiptCorrection(); }}>
        <h2>修正第{correctingReceipt.sequence}次收货</h2>
        <p>原始收货记录不会被覆盖，本次修正会单独保存操作人和时间。</p>
        <label>收货来源<select value={receiptSource} disabled={mutationBusy} onChange={(event) => setReceiptSource(event.target.value as "jiashun" | "other_factory")}>
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
          <button type="submit" className="is-primary" disabled={mutationBusy || !receiptDocumentQuantity || receiptActualQuantity === "" || receiptDefectiveQuantity === ""}>{mutationBusy ? "保存中…" : "保存修正"}</button>
        </div>
      </form>
    </div> : null}

    {editing ? <div className="order-board-dialog-backdrop" role="presentation" onMouseDown={() => !mutationBusy && setEditing(null)}>
      <form className="order-board-dialog" role="dialog" aria-modal="true" aria-label="修改收货订单" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submitCorrection(); }}>
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
            ? <small>已选择{editImages.length}张；保存后整体替换当前图片。</small>
            : <small>不选择新图则保留当前图片。</small>
          : <small>返工已发起，送货单图片已锁定。</small>}
        {mutationMessage ? <p className="order-board-dialog__error" role="alert">{mutationMessage}</p> : null}
        <div className="order-board-dialog__actions">
          <button type="button" disabled={mutationBusy} onClick={() => setEditing(null)}>取消</button>
          <button type="submit" className="is-primary" disabled={mutationBusy || !editStyleNo.trim() || !editDocumentQuantity || editActualQuantity === "" || editDefectiveQuantity === ""}>{mutationBusy ? "保存中…" : "保存修改"}</button>
        </div>
      </form>
    </div> : null}

    {deleting ? <div className="order-board-dialog-backdrop" role="presentation" onMouseDown={() => !mutationBusy && setDeleting(null)}>
      <div className="order-board-dialog order-board-delete-dialog" role="dialog" aria-modal="true" aria-label="删除收货订单" onMouseDown={(event) => event.stopPropagation()}>
        <h2>确认删除收货订单？</h2>
        <p>款号：<strong>{deleting.styleNo}</strong></p>
        <p>删除后从订单回货隐藏，原始收货记录与图片仍保留审计。此操作仅限尚未发起返工的订单。</p>
        {mutationMessage ? <p className="order-board-dialog__error" role="alert">{mutationMessage}</p> : null}
        <div className="order-board-dialog__actions">
          <button type="button" disabled={mutationBusy} onClick={() => setDeleting(null)}>取消</button>
          <button type="button" className="is-danger" disabled={mutationBusy} onClick={() => void confirmDelete()}>{mutationBusy ? "删除中…" : "确认删除"}</button>
        </div>
      </div>
    </div> : null}
  </div>;
}
