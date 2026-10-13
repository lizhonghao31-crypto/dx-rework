import {
  AttachmentResponseSchema,
  CuttingOrderDetailSchema,
  CuttingOrderListResponseSchema,
  CuttingRecordMutationResponseSchema,
  MAX_CUTTING_SHEET_ATTACHMENTS,
  UploadIntentResponseSchema,
  cuttingOutOfRange,
  parseCuttingCountText,
  type CuttingOrderDetail,
  type CuttingOrderListItem,
} from "@dx-rework/contracts";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useRef, useState } from "react";

import { createClientRequestId } from "./client-request-id.js";
import {
  currentQcUploadConcurrency,
  currentUploadClientProfile,
  isImageUploadCandidate,
  measureAttachmentUploadStage,
  prepareAndUploadWithConcurrency,
  prepareImageUploadCandidate,
  sha256Hex,
  uploadImageWithNormalizationRetry,
  type AttachmentUploadTimingContext,
} from "./attachment-upload.js";
import { Header } from "./components.js";
import {
  cuttingImageUrl,
  cuttingRequest,
  cuttingTime,
} from "./cutting-client.js";
import {
  cuttingListPath,
  cuttingReturnPath,
  readCuttingListQuery,
  type CuttingListQuery,
} from "./cutting-query.js";
import { ListPagination } from "./list-pagination.js";
import { confirmInApp, promptInApp } from "./system-dialog.js";
import { useCuttingDraftGuard } from "./use-cutting-draft-guard.js";
import { useDebouncedValue } from "./use-debounced-value.js";
import { useInternalReturnScroll } from "./use-internal-return-scroll.js";
import { createWebUrls } from "../url-contract.js";
import "./cutting-page.css";
import "./rework-v2-form.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

type UploadedCuttingSheet = Readonly<{
  attachmentId: string;
  filename: string;
  mimeType: string;
  previewUrl: string;
}>;

type ApiSchema<T> = Readonly<{ parse(value: unknown): T }>;

async function uploadRequest<T>(
  path: string,
  schema: ApiSchema<T>,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? "图片上传失败");
  return schema.parse(body);
}

const statusLabel = (status: CuttingOrderListItem["status"]): string =>
  status === "recorded" ? "已裁" : "待登记";

const processLabel = (
  process: CuttingOrderListItem["cuttingProcess"],
  other: string | null,
): string => process === "in_house"
  ? "本厂裁"
  : process === "outsourced"
    ? "外厂裁"
    : process === "other"
      ? other ?? "其它"
      : "—";

function cardHref(item: CuttingOrderListItem, returnTo: string): string {
  return `${pageUrl(`ui/cutting/orders/${item.cuttingOrderId}`)}?${new URLSearchParams({ returnTo })}`;
}

function CuttingCard({
  item,
  returnTo,
}: {
  item: CuttingOrderListItem;
  returnTo: string;
}) {
  return (
    <Surface className="cutting-card">
      <a href={cardHref(item, returnTo)}>
        <div className="cutting-card__identity">
          <strong>{item.formalStyleNo ?? item.displayStyleNo}</strong>
          <small>
            {item.supplierName} · {item.merchandiserName}
            {item.color ? ` · ${item.color}` : ""}
          </small>
        </div>
        <div className="cutting-card__counts">
          <div>
            <span>合同数量</span>
            <b>{formatBusinessDecimal(item.contractQuantity)} 件</b>
          </div>
          <div>
            <span>士啤片</span>
            <b>{item.pieceCount === null ? "—" : `${formatBusinessDecimal(item.pieceCount)} 片`}</b>
          </div>
          <div>
            <span>实裁数</span>
            <b>{item.actualCutCount === null ? "—" : `${formatBusinessDecimal(item.actualCutCount)} 件`}</b>
          </div>
        </div>
        <div className="cutting-card__status">
          <div className="cutting-card__status-line">
            <StatusBadge tone={item.status === "recorded" ? "success" : "info"}>
              {statusLabel(item.status)}
            </StatusBadge>
            {item.outOfRange === true ? <span className="cutting-alert">超出±5%</span> : null}
          </div>
          <small>
            {item.recordedByName
              ? `${item.recordedByName} · ${cuttingTime(item.recordedAt)}`
              : item.formalStyleNo
                ? "等待裁床登记"
                : "待补正式款号"}
          </small>
        </div>
      </a>
    </Surface>
  );
}

export function CuttingListPage() {
  const [initial] = useState(() => readCuttingListQuery(window.location.search));
  const [q, setQ] = useState(initial.q);
  const [status, setStatus] = useState<CuttingListQuery["status"]>(initial.status);
  const [outOfRange, setOutOfRange] = useState(initial.outOfRange);
  const [page, setPage] = useState(initial.page);
  const [data, setData] = useState<ReturnType<typeof CuttingOrderListResponseSchema.parse> | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const search = useDebouncedValue(q.trim(), 180);
  const listPath = cuttingListPath({ q: search, status, outOfRange, page });
  useInternalReturnScroll(!loading && data !== null);

  useEffect(() => {
    window.history.replaceState(window.history.state, "", pageUrl(listPath));
  }, [listPath]);

  useEffect(() => {
    const abort = new AbortController();
    const params = new URLSearchParams({
      q: search,
      status,
      outOfRange: outOfRange ? "true" : "false",
      page: String(page),
    });
    setLoading(true);
    setError("");
    void cuttingRequest(
      `orders?${params}`,
      CuttingOrderListResponseSchema,
      { signal: abort.signal },
    ).then((result) => {
      if (!abort.signal.aborted) {
        setData(result);
        if (page !== result.page) setPage(result.page);
      }
    }).catch((cause) => {
      if (!abort.signal.aborted) {
        setData(null);
        setError(cause instanceof Error ? cause.message : "读取裁床订单失败");
      }
    }).finally(() => {
      if (!abort.signal.aborted) setLoading(false);
    });
    return () => abort.abort();
  }, [search, status, outOfRange, page, refresh]);

  const changeStatus = (next: CuttingListQuery["status"]) => {
    setStatus(next);
    setPage(1);
  };
  const toggleOutOfRange = () => {
    setOutOfRange((current) => !current);
    setPage(1);
  };

  return (
    <div className="cutting-page">
      <Header
        title="裁床实裁"
        badge="订单开裁"
        badgePlacement="subtitle"
        subtitle="按款登记实际士啤片与实裁数"
      />
      <Surface className="cutting-toolbar">
        <div className="cutting-toolbar__statuses" aria-label="裁床状态筛选">
          {([
            ["all", "全部"],
            ["pending", "待登记"],
            ["recorded", "已裁"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={status === value ? "is-active" : ""}
              aria-pressed={status === value}
              onClick={() => changeStatus(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`cutting-toolbar__range cutting-toolbar__range--desktop${outOfRange ? " is-active" : ""}`}
          aria-pressed={outOfRange}
          onClick={toggleOutOfRange}
        >
          仅看超出±5%
        </button>
        <details className="cutting-range-disclosure">
          <summary>更多筛选</summary>
          <button
            type="button"
            className={`cutting-toolbar__range${outOfRange ? " is-active" : ""}`}
            aria-pressed={outOfRange}
            onClick={toggleOutOfRange}
          >
            仅看超出±5%
          </button>
        </details>
        <label className="cutting-toolbar__search">
          <span>搜索裁床订单</span>
          <input
            aria-label="搜索裁床订单"
            value={q}
            onChange={(event) => {
              setQ(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <Button
          className="cutting-toolbar__refresh"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          刷新
        </Button>
      </Surface>
      {error ? (
        <Surface>
          <p className="cutting-error" role="alert">{error}</p>
        </Surface>
      ) : null}
      <div className="cutting-list" aria-busy={loading}>
        {data?.items.map((item) => (
          <CuttingCard key={item.cuttingOrderId} item={item} returnTo={listPath} />
        ))}
      </div>
      {data && !data.items.length ? (
        <Surface><p className="cutting-empty">没有符合条件的裁床订单。</p></Surface>
      ) : null}
      {data ? (
        <div className="cutting-pagination">
          <span>共 {formatBusinessDecimal(data.totalCount)} 款</span>
          <ListPagination
            page={data.page}
            totalPages={data.totalPages}
            busy={loading}
            onPageChange={setPage}
            ariaLabel="裁床实裁分页"
          />
        </div>
      ) : loading ? <p role="status">正在读取裁床订单…</p> : null}
    </div>
  );
}

function CountInput({
  label,
  unit,
  value,
  onChange,
  error,
  disabled,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  error: string;
  disabled: boolean;
}) {
  return (
    <label className={`cutting-count-field${error ? " is-error" : ""}`}>
      <span>{label}</span>
      <div className="cutting-count-control">
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          value={value}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          onChange={(event) => onChange(event.target.value)}
        />
        <span>{unit}</span>
      </div>
      {error ? <p className="cutting-field-error">{error}</p> : null}
    </label>
  );
}

export function CuttingDetailPage({ cuttingOrderId }: { cuttingOrderId: string }) {
  const [item, setItem] = useState<CuttingOrderDetail | null>(null);
  const [pieceCount, setPieceCount] = useState("");
  const [actualCutCount, setActualCutCount] = useState("");
  const [pieceError, setPieceError] = useState("");
  const [actualError, setActualError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cuttingSheets, setCuttingSheets] = useState<readonly UploadedCuttingSheet[]>([]);
  const [uploading, setUploading] = useState(false);
  const previewUrls = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const correctionAttempt = useRef<{ body: string; key: string } | null>(null);
  const draft = useCuttingDraftGuard(
    JSON.stringify({
      pieceCount,
      actualCutCount,
      attachmentIds: cuttingSheets.map((sheet) => sheet.attachmentId),
    }),
    Boolean(item?.canRecord && !item.record
      && (pieceCount || actualCutCount || cuttingSheets.length > 0)),
  );
  const backHref = cuttingReturnPath(window.location.search);

  useEffect(() => () => {
    for (const previewUrl of previewUrls.current) URL.revokeObjectURL(previewUrl);
    previewUrls.current.clear();
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    setError("");
    void cuttingRequest(
      `orders/${cuttingOrderId}`,
      CuttingOrderDetailSchema,
      { signal: abort.signal },
    ).then((result) => {
      if (!abort.signal.aborted) {
        setItem(result);
        if (result.record) {
          setPieceCount("");
          setActualCutCount("");
        }
      }
    }).catch((cause) => {
      if (!abort.signal.aborted) {
        setItem(null);
        setError(cause instanceof Error ? cause.message : "读取裁床订单失败");
      }
    });
    return () => abort.abort();
  }, [cuttingOrderId]);

  const updateDigits = (
    next: string,
    setValue: (value: string) => void,
    setFieldError: (value: string) => void,
  ) => {
    if (next === "" || /^\d+$/.test(next)) {
      if (next !== "" && parseCuttingCountText(next) === null) {
        setFieldError("数量超出系统可安全保存范围");
        return;
      }
      setValue(next);
      setFieldError("");
      return;
    }
    setFieldError("只允许输入半角整数数字");
  };

  const parsedPiece = parseCuttingCountText(pieceCount);
  const parsedActual = parseCuttingCountText(actualCutCount);
  const draftOutOfRange = item && parsedActual !== null
    ? cuttingOutOfRange(item.contractQuantity, parsedActual)
    : false;

  const uploadCuttingSheets = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0 || busy || uploading || item?.record || !item?.canRecord) return;
    const selected = Array.from(files);
    if (cuttingSheets.length + selected.length > MAX_CUTTING_SHEET_ATTACHMENTS) {
      setError(`裁床单最多上传 ${MAX_CUTTING_SHEET_ATTACHMENTS} 张图片`);
      return;
    }
    if (selected.some((file) => !isImageUploadCandidate(file))) {
      setError("裁床单仅支持图片格式");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const profile = currentUploadClientProfile();
      const uploaded = await prepareAndUploadWithConcurrency(
        selected,
        currentQcUploadConcurrency(),
        async (file) => {
          const baseTiming: AttachmentUploadTimingContext = {
            diagnosticId: createClientRequestId(),
            ...profile,
            originalBytes: file.size,
            uploadBytes: file.size,
            mimeType: file.type,
          };
          const prepared = await measureAttachmentUploadStage(
            baseTiming,
            "prepare",
            () => prepareImageUploadCandidate(file),
          );
          const timing = { ...baseTiming, uploadBytes: prepared.size, mimeType: prepared.type };
          const sha256 = await measureAttachmentUploadStage(
            timing,
            "hash",
            () => sha256Hex(prepared),
          );
          return { file: prepared, timing, sha256 };
        },
        async ({ file, timing, sha256 }, source): Promise<UploadedCuttingSheet> =>
          uploadImageWithNormalizationRetry(source, file, async (candidate) => {
            const candidateTiming = candidate === file
              ? timing
              : { ...timing, uploadBytes: candidate.size, mimeType: candidate.type };
            const candidateSha256 = candidate === file
              ? sha256
              : await measureAttachmentUploadStage(
                  candidateTiming,
                  "hash",
                  () => sha256Hex(candidate),
                );
            const intent = await measureAttachmentUploadStage(
              candidateTiming,
              "intent",
              () => uploadRequest(
                `cutting/orders/${cuttingOrderId}/attachments/upload-intents`,
                UploadIntentResponseSchema,
                {
                  method: "POST",
                  body: JSON.stringify({
                    filename: candidate.name,
                    mimeType: candidate.type,
                    sizeBytes: candidate.size,
                    sha256: candidateSha256,
                  }),
                },
              ),
            );
            const upload = new FormData();
            for (const [name, value] of Object.entries(intent.uploadFields)) upload.append(name, value);
            upload.append("file", candidate);
            const response = await measureAttachmentUploadStage(
              candidateTiming,
              "oss",
              () => fetch(intent.uploadUrl, { method: "POST", body: upload }),
            );
            if (!response.ok) throw new Error(`${source.name} 上传失败`);
            const finalized = await measureAttachmentUploadStage(
              candidateTiming,
              "finalize",
              () => uploadRequest(
                `tools/attachments/${intent.attachmentId}/finalize`,
                AttachmentResponseSchema,
                { method: "POST" },
              ),
            );
            const previewUrl = URL.createObjectURL(candidate);
            previewUrls.current.add(previewUrl);
            return {
              attachmentId: finalized.attachmentId,
              filename: finalized.filename,
              mimeType: finalized.mimeType,
              previewUrl,
            };
          }),
      );
      setCuttingSheets((current) => [...current, ...uploaded]);
      attempt.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "裁床单上传失败，请重试");
    } finally {
      setUploading(false);
    }
  };

  const removeCuttingSheet = (attachmentId: string): void => {
    setCuttingSheets((current) => {
      const removed = current.find((sheet) => sheet.attachmentId === attachmentId);
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl);
        previewUrls.current.delete(removed.previewUrl);
      }
      return current.filter((sheet) => sheet.attachmentId !== attachmentId);
    });
    attempt.current = null;
  };

  const submitRecord = async () => {
    if (!item || !item.canRecord || busy || uploading) return;
    if (cuttingSheets.length === 0) {
      setError("请上传裁床单");
      return;
    }
    if (parsedPiece === null || parsedActual === null) {
      if (parsedPiece === null) setPieceError("请填写有效士啤片");
      if (parsedActual === null) setActualError("请填写有效实裁数");
      return;
    }
    const body = JSON.stringify({
      pieceCount: parsedPiece,
      actualCutCount: parsedActual,
      attachmentIds: cuttingSheets.map((sheet) => sheet.attachmentId),
    });
    if (attempt.current?.body !== body) {
      attempt.current = { body, key: createClientRequestId() };
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await cuttingRequest(
        `orders/${cuttingOrderId}/records`,
        CuttingRecordMutationResponseSchema,
        {
          method: "POST",
          body,
          headers: { "idempotency-key": attempt.current.key },
        },
      );
      draft.markSaved();
      setItem(result.item);
      setPieceCount("");
      setActualCutCount("");
      for (const sheet of cuttingSheets) {
        URL.revokeObjectURL(sheet.previewUrl);
        previewUrls.current.delete(sheet.previewUrl);
      }
      setCuttingSheets([]);
      setNotice(result.outcome === "already_recorded"
        ? "该款已由其他人员完成登记，页面已显示真实结果。"
        : "裁床实裁已登记。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登记失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const correctRecord = async () => {
    if (!item?.record || !item.canCorrect || busy) return;
    const piece = await promptInApp(
      "修正后的士啤片（片）",
      String(item.record.pieceCount),
      { title: "Root 修正士啤片", confirmLabel: "下一步" },
    );
    if (piece === null) return;
    const parsedCorrectionPiece = parseCuttingCountText(piece.trim());
    if (parsedCorrectionPiece === null) {
      setError("士啤片必须是非负整数");
      return;
    }
    const actual = await promptInApp(
      "修正后的实裁数（件）",
      String(item.record.actualCutCount),
      { title: "Root 修正实裁数", confirmLabel: "下一步" },
    );
    if (actual === null) return;
    const parsedCorrectionActual = parseCuttingCountText(actual.trim());
    if (parsedCorrectionActual === null) {
      setError("实裁数必须是非负整数");
      return;
    }
    const reason = await promptInApp(
      "填写本次修正原因",
      "",
      { title: "Root 修正原因", confirmLabel: "继续" },
    );
    if (!reason?.trim()) return;
    const confirmed = await confirmInApp(
      `将士啤片修正为 ${formatBusinessDecimal(parsedCorrectionPiece)} 片，实裁数修正为 ${formatBusinessDecimal(parsedCorrectionActual)} 件？`,
      { title: "确认修正", confirmLabel: "保存修正" },
    );
    if (!confirmed) return;
    const body = JSON.stringify({
      expectedVersion: item.record.version,
      pieceCount: parsedCorrectionPiece,
      actualCutCount: parsedCorrectionActual,
      reason: reason.trim(),
    });
    if (correctionAttempt.current?.body !== body) {
      correctionAttempt.current = { body, key: createClientRequestId() };
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await cuttingRequest(
        `orders/${cuttingOrderId}/corrections`,
        CuttingRecordMutationResponseSchema,
        {
          method: "POST",
          body,
          headers: { "idempotency-key": correctionAttempt.current.key },
        },
      );
      setItem(result.item);
      setNotice("修正已保存，最初登记人和登记时间保持不变。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "修正失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const title = item?.formalStyleNo ?? item?.displayStyleNo ?? "裁床实裁";
  return (
    <div className="cutting-page cutting-detail">
      <Header
        title={title}
        badge="裁床实裁"
        badgePlacement="subtitle"
        backHref={backHref}
        {...(item ? { subtitle: `${item.supplierName} · ${statusLabel(item.status)}` } : {})}
      />
      {error ? <Surface><p className="cutting-error" role="alert">{error}</p></Surface> : null}
      {notice ? <Surface><p role="status">{notice}</p></Surface> : null}
      {!item && !error ? <p role="status">正在读取裁床订单…</p> : null}
      {item ? (
        <>
          <Surface>
            <dl className="cutting-detail__facts">
              <div><dt>正式款号</dt><dd>{item.formalStyleNo ?? "待补正式款号"}</dd></div>
              <div><dt>代用款号</dt><dd>{item.alternateStyleNo ?? "—"}</dd></div>
              <div><dt>款式 / 颜色</dt><dd>{item.styleName ?? "—"}{item.color ? ` · ${item.color}` : ""}</dd></div>
              <div><dt>性别</dt><dd>{item.gender ?? "—"}</dd></div>
              <div><dt>合同编号</dt><dd>{item.contractNumber ?? "—"}</dd></div>
              <div><dt>对应款合同数量</dt><dd>{formatBusinessDecimal(item.contractQuantity)} 件</dd></div>
              <div><dt>加工厂</dt><dd>{item.supplierName}</dd></div>
              <div><dt>跟单</dt><dd>{item.merchandiserName}</dd></div>
              <div><dt>交期</dt><dd>{item.deliveryDate ?? "—"}</dd></div>
              <div><dt>裁床方式</dt><dd>{processLabel(item.cuttingProcess, item.cuttingProcessOther)}</dd></div>
              <div><dt>工艺及承包范围</dt><dd>{item.processes.length ? item.processes.join("、") : "—"}</dd></div>
            </dl>
          </Surface>
          {item.photos.length ? (
            <Surface className="cutting-detail__photos">
              <details>
                <summary>源单产品照片（{formatBusinessDecimal(item.photos.length)}）</summary>
                <div className="cutting-detail__photo-grid">
                  {item.photos.map((photo) => (
                    <a
                      key={photo.attachmentId}
                      href={cuttingImageUrl(photo.attachmentId, "preview")}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img
                        src={cuttingImageUrl(photo.attachmentId, "thumbnail")}
                        alt={photo.filename}
                      />
                    </a>
                  ))}
                </div>
              </details>
            </Surface>
          ) : null}
          <Surface className="cutting-record-panel">
            <div className="cutting-record-panel__heading">
              <div>
                <h2>{item.record ? "实裁登记" : item.canRecord ? "登记裁床数量" : "实裁记录"}</h2>
                <p>士啤片按片记录；实裁数按可用于制作成衣的件数记录。</p>
              </div>
              <div className="cutting-card__status-line">
                <StatusBadge tone={item.status === "recorded" ? "success" : "info"}>
                  {statusLabel(item.status)}
                </StatusBadge>
                {item.outOfRange === true ? <span className="cutting-alert">超出±5%</span> : null}
              </div>
            </div>
            {item.record ? (
              <>
                <dl className="cutting-record-facts">
                  <div><dt>士啤片</dt><dd>{formatBusinessDecimal(item.record.pieceCount)} 片</dd></div>
                  <div><dt>实裁数</dt><dd>{formatBusinessDecimal(item.record.actualCutCount)} 件</dd></div>
                  <div><dt>登记人</dt><dd>{item.record.recordedByName}</dd></div>
                  <div><dt>登记时间</dt><dd>{cuttingTime(item.record.recordedAt)}</dd></div>
                </dl>
                {item.record.cuttingSheetPhotos.length ? (
                  <div className="cutting-sheet-readonly">
                    <strong>裁床单</strong>
                    <div className="rework-v2-image-grid">
                      {item.record.cuttingSheetPhotos.map((photo) => (
                        <article key={photo.attachmentId}>
                          <a
                            href={cuttingImageUrl(photo.attachmentId, "preview")}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <img
                              src={cuttingImageUrl(photo.attachmentId, "thumbnail")}
                              alt={photo.filename}
                              loading="lazy"
                            />
                          </a>
                        </article>
                      ))}
                    </div>
                  </div>
                ) : null}
                <p className={`cutting-range-note${item.outOfRange ? " is-warning" : ""}`}>
                  合同允许范围：{formatBusinessDecimal(item.allowedRange.min)}–{formatBusinessDecimal(item.allowedRange.max)} 件。
                  {item.outOfRange ? " 当前实裁超出±5%，仅作提示。" : " 当前实裁在±5%范围内。"}
                </p>
                {item.canCorrect ? (
                  <div className="cutting-record-actions">
                    <Button
                      className="cutting-correction-button"
                      disabled={busy}
                      onClick={() => void correctRecord()}
                    >
                      修正
                    </Button>
                  </div>
                ) : null}
                {item.record.corrections.length ? (
                  <details className="cutting-correction-history">
                    <summary>修正记录（{formatBusinessDecimal(item.record.corrections.length)}）</summary>
                    <ol>
                      {item.record.corrections.map((correction) => (
                        <li key={correction.version}>
                          第 {formatBusinessDecimal(correction.version)} 版：
                          士啤片 {formatBusinessDecimal(correction.pieceCount)} 片，
                          实裁 {formatBusinessDecimal(correction.actualCutCount)} 件；
                          {correction.correctedByName} · {cuttingTime(correction.correctedAt)} · {correction.reason}
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
              </>
            ) : item.canRecord ? (
              <>
                {!item.formalStyleNo ? (
                  <p className="cutting-range-note is-warning">
                    正式款号尚未补齐。请沿用外发订单原有补号入口，补齐后再登记实裁。
                  </p>
                ) : null}
                <div className="cutting-record-grid">
                  <CountInput
                    label="士啤片"
                    unit="片"
                    value={pieceCount}
                    error={pieceError}
                    disabled={busy || !item.canRecord}
                    onChange={(value) => updateDigits(value, setPieceCount, setPieceError)}
                  />
                  <CountInput
                    label="实裁数"
                    unit="件"
                    value={actualCutCount}
                    error={actualError}
                    disabled={busy || !item.canRecord}
                    onChange={(value) => updateDigits(value, setActualCutCount, setActualError)}
                  />
                </div>
                <div className="cutting-sheet-upload">
                  <div className="cutting-sheet-upload__heading">
                    <div>
                      <h3>上传裁床单 <b>*</b></h3>
                      <p>必须上传1张，最多3张；支持 JPEG / PNG / WebP。</p>
                    </div>
                    <StatusBadge tone={cuttingSheets.length ? "success" : "info"}>
                      {cuttingSheets.length}/{MAX_CUTTING_SHEET_ATTACHMENTS}
                    </StatusBadge>
                  </div>
                  <label className="rework-v2-upload">
                    <span>{uploading ? "正在上传…" : "＋ 上传裁床单"}</span>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      disabled={busy || uploading || cuttingSheets.length >= MAX_CUTTING_SHEET_ATTACHMENTS}
                      onChange={(event) => {
                        void uploadCuttingSheets(event.target.files);
                        event.target.value = "";
                      }}
                    />
                  </label>
                  {cuttingSheets.length ? (
                    <div className="rework-v2-image-grid">
                      {cuttingSheets.map((sheet) => (
                        <article key={sheet.attachmentId}>
                          <a href={sheet.previewUrl} target="_blank" rel="noreferrer">
                            <img src={sheet.previewUrl} alt={sheet.filename} />
                          </a>
                          <button
                            type="button"
                            disabled={busy || uploading}
                            onClick={() => removeCuttingSheet(sheet.attachmentId)}
                          >
                            移除
                          </button>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </div>
                <p className={`cutting-range-note${draftOutOfRange ? " is-warning" : ""}`}>
                  实裁允许范围：{formatBusinessDecimal(item.allowedRange.min)}–{formatBusinessDecimal(item.allowedRange.max)} 件。
                  {draftOutOfRange ? " 当前输入超出±5%，仍可按真实数量提交。" : ""}
                </p>
                {item.canRecord ? (
                  <div className="cutting-record-actions">
                    <Button
                      variant="primary"
                      disabled={busy || uploading || parsedPiece === null || parsedActual === null || cuttingSheets.length === 0}
                      onClick={() => void submitRecord()}
                    >
                      {busy ? "提交中…" : "提交登记"}
                    </Button>
                  </div>
                ) : null}
              </>
            ) : <p className="cutting-range-note" role="status">尚未登记实裁。当前仅可查看订单及登记后记录。</p>}
          </Surface>
        </>
      ) : null}
    </div>
  );
}
