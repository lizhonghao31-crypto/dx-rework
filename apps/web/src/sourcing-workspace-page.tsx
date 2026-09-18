import { moduleCanWrite } from "./member-module-policy.js";
import { todoReturnPath } from "./todo-query-state.js";
import {WorkAnalysisPanel} from "./work-analysis-panel.js";
import { isNewSourcingPrice, newSourcingPriceDisplay, historicalSourcingPrice, sourcingPriceSummary, sourcingDeleteConfirmation, sourcingDecisionNeedsReason } from "./sourcing-price-presentation.js";
import { createSourcingPriceInput } from "./sourcing-price-input.js";
import { applySourcingPriceCascade } from "./sourcing-price-cascade.js";
import { NavigationIcon } from "./navigation-icons.js";
import {
  AttachmentResponseSchema,
  CraftCatalogListResponseSchema,
  DeleteSourcingCaseResponseSchema,
  MAX_SOURCING_ATTACHMENTS,
  MAX_SOURCING_LINE_ITEMS,
  MAX_SOURCING_PROCESSES,
  SOURCING_IMAGE_SUPPLEMENT_ROLES,
  SourcingAttachmentListResponseSchema,
  SourcingCaseListResponseSchema,
  SourcingCaseSummarySchema,
  SourcingStyleCatalogSchema,
  SourcingContractStateResponseSchema,
  SourcingDispatchStateSchema,
  SourcingProductionOrderSchema,
  type SourcingDispatchState,
  SourcingFactoryListResponseSchema,
  SourcingFactoryChangeStateResponseSchema,
  SourcingTimelineResponseSchema,
  UploadIntentResponseSchema,
  calculateSourcingOrderQuantity,
  duplicateSourcingLineMessage,
  sourcingStyleNumbers,
  type SourcingStyleIdentity,
  calculateSourcingTotalExact,
  type CraftCatalogItem,
  type SourcingAttachment,
  type SourcingCaseStatus,
  type SourcingCaseSummary,
  type SourcingContractDocument,
  type SourcingContractMissingField,
  type SourcingFactory,
  type SourcingFactoryChangeState,
  type SourcingTimelineEntry,
} from "@dx-rework/contracts";
import { formatBusinessCurrency, formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
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
import { verifySession, type AuthorizedUser } from "./auth.js";
import { createClientRequestId } from "./client-request-id.js";
import { Header, Shell } from "./components.js";
import { ImageViewer } from "./image-viewer.js";
import { ListPagination } from "./list-pagination.js";
import {
  readSourcingListQuery,
  sourcingListPath,
  sourcingReturnPath,
  withSourcingReturn,
  type SourcingGenderFilter,
  type SourcingListQuery,
  type SourcingStageFilter,
} from "./sourcing-list-query.js";
import { useDebouncedValue } from "./use-debounced-value.js";
import { SourcingImageSupplementUploader } from "./sourcing-image-supplement-uploader.js";
import { confirmInApp } from "./system-dialog.js";
import "./rework-detail.css";
import "./rework-detail-compact.css";
import "./sourcing-workspace.css";
import "./order-overview-responsive.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

const STATUS_LABELS: Readonly<Record<SourcingCaseStatus, string>> = {
  pending_ie_quote: "待 IE 报价",
  pending_management_decision: "待生产管理调价选厂",
  pending_owner_approval: "待老板终审",
  pending_contract: "待财务核对",
  pending_finance_reconciliation: "待财务核对",
  pending_factory_change_verification: "待核实换厂",
  pending_exception_verification: "待核实差异",
  closed: "已完成",
};

const ACTIVE_NAVIGATION = {
  create: "创建订单",
  pending: "待审批订单",
  history: "历史订单",
  detail: "待审批订单",
} as const;

type WorkspaceView = keyof typeof ACTIVE_NAVIGATION;
type ApiSchema<T> = Readonly<{ parse(value: unknown): T }>;
type UploadedImage = Readonly<{
  attachmentId: string;
  filename: string;
  mimeType: string;
  previewUrl: string;
}>;
type SourcingLineDraft = Readonly<{
  styleNo: string;
  alternateStyleNo: string;
  color: string;
  quantity: string;
  imageAttachmentId?: string;
}>;
type LocalSourcingDraft = Readonly<{
  gender: "" | "男装" | "女装";
  styleName: string;
  estimatedCutPieceSendDate: string;
  deliveryDate: string;
  lineItems: readonly SourcingLineDraft[];
  daxingUnitPrice: string;
  images: readonly UploadedImage[];
  savedAt: string;
}>;
type LinePriceDraft = Readonly<{ position: number; unitPrice: string }>;
type QuoteDraft = Readonly<{ linePrices: readonly LinePriceDraft[]; quoteReason: string }>;
type DecisionDraft = Readonly<{ supplierId: string; linePrices: readonly LinePriceDraft[]; decisionReason: string; cuttingProcess: "" | "in_house" | "outsourced" | "other"; cuttingProcessOther: string }>;
type FinanceReviewDraft = Readonly<{ differenceFields: readonly string[]; differenceReason: string }>;
type FactoryChangeDraft = Readonly<{ supplierId: string; unitPrice: string; changeReason: string }>;
type ContractSupplementDraft = Readonly<Partial<Record<SourcingContractMissingField, string>>>;

class SourcingRequestError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

const request = async <T,>(
  path: string,
  schema: ApiSchema<T>,
  init: RequestInit = {},
): Promise<T> => {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string; code?: string } } | null;
    throw new SourcingRequestError(body?.error?.message ?? "操作失败，请稍后重试", body?.error?.code);
  }
  return schema.parse(await response.json());
};

const requestWithStyleCheck = async <T,>(path: string, schema: ApiSchema<T>, init: RequestInit, lines: readonly SourcingStyleIdentity[]): Promise<T> => {
  const duplicate = duplicateSourcingLineMessage(lines);
  if (duplicate) throw new Error(duplicate);
  try {
    return await request(path,schema,init);
  } catch (error) {
    if (!(error instanceof SourcingRequestError) || error.code !== "STYLE_NUMBER_EXISTS") throw error;
    const confirmed = await confirmInApp(`${error.message}\n仅确认属于追加或分批外发时继续提交。`,{
      title:"发现重复款号",confirmLabel:"已核对，继续提交",cancelLabel:"返回修改",
    });
    if (!confirmed) throw new Error("已取消提交，请核对款号");
    return request(path,schema,{...init,body:JSON.stringify({
      ...JSON.parse(String(init.body)),confirmedDuplicateStyles:sourcingStyleNumbers(lines),
    })});
  }
};

const canAct = (user: AuthorizedUser | null, role: string, capability: string): boolean =>
  user?.isRoot === true
  || (moduleCanWrite(user, "sourcing") && user?.businessRoles?.includes(role) === true && (user.effectiveWriteCapabilities ?? user.capabilities).includes(capability));

const formatDateTime = (value: string): string => new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Shanghai",
}).format(new Date(value));

const totalPreview = (unitPrice: string, quantity: number): string => {
  try {
    return calculateSourcingTotalExact(unitPrice, quantity);
  } catch {
    return "—";
  }
};

const linesTotalPreview = (
  linePrices: readonly LinePriceDraft[],
  lines: SourcingCaseSummary["lineItems"],
): string => {
  try {
    if (linePrices.some((price) => !isNewSourcingPrice(price.unitPrice))) return "—";
    const cents = linePrices.reduce((sum, price) => {
      const quantity = lines.find((line) => line.position === price.position)?.quantity ?? 0;
      const amount = calculateSourcingTotalExact(price.unitPrice, quantity);
      const [whole, fraction] = amount.split(".");
      return sum + BigInt(whole!) * 100n + BigInt(fraction!);
    }, 0n);
    return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  } catch {
    return "—";
  }
};

const businessInputValue = (value: string): string =>
  value ? formatBusinessDecimal(value) : "";

const businessInputChange = (value: string): string => value.replace(/,/g, "");

const subtractFixedPoint = (left: string, right: string, scale: number): string | null => {
  const toScaled = (value: string): bigint | null => {
    const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match || (match[2]?.length ?? 0) > scale) return null;
    return BigInt(match[1]!) * (10n ** BigInt(scale))
      + BigInt((match[2] ?? "").padEnd(scale, "0"));
  };
  const leftScaled = toScaled(left);
  const rightScaled = toScaled(right);
  if (leftScaled === null || rightScaled === null) return null;
  const delta = leftScaled - rightScaled;
  const sign = delta < 0n ? "-" : delta > 0n ? "+" : "";
  const absolute = delta < 0n ? -delta : delta;
  const divisor = 10n ** BigInt(scale);
  const whole = absolute / divisor;
  const fraction = (absolute % divisor).toString().padStart(scale, "0");
  return sign + formatBusinessCurrency(whole.toString() + "." + fraction);
};

const attachmentUrl = (attachmentId: string, mode: "preview" | "download"): string =>
  apiUrl(`tools/attachments/${attachmentId}/download?mode=${mode}`);

const LOCAL_SOURCING_DRAFT_KEY = "dx-rework:sourcing-create-local-draft:v1";
const localSourcingDraftKey = (userId: string): string => `${LOCAL_SOURCING_DRAFT_KEY}:${userId}`;

const readLocalSourcingDraft = (userId: string): LocalSourcingDraft | null => {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(localSourcingDraftKey(userId)) ?? "null") as
      (Partial<LocalSourcingDraft> & { styleNo?: unknown; orderQuantity?: unknown }) | null;
    if (!parsed || typeof parsed.deliveryDate !== "string"
      || !Array.isArray(parsed.images)) return null;
    const lineItems = Array.isArray(parsed.lineItems)
      ? parsed.lineItems.filter((line): line is SourcingLineDraft => (
          typeof line === "object" && line !== null
          && typeof line.styleNo === "string"
          && typeof line.alternateStyleNo === "string"
          && typeof line.color === "string"
          && typeof line.quantity === "string"
        )).slice(0, MAX_SOURCING_LINE_ITEMS)
      : typeof parsed.styleNo === "string" && typeof parsed.orderQuantity === "string"
        ? [{
            styleNo: parsed.styleNo,
            alternateStyleNo: "",
            color: "",
            quantity: parsed.orderQuantity,
          }]
        : [];
    if (!lineItems.length) return null;
    const images = parsed.images.filter((image): image is UploadedImage => (
      typeof image === "object" && image !== null
      && typeof image.attachmentId === "string"
      && typeof image.filename === "string"
      && typeof image.mimeType === "string"
    )).slice(0, MAX_SOURCING_ATTACHMENTS).map((image) => ({
      ...image,
      previewUrl: attachmentUrl(image.attachmentId, "preview"),
    }));
    return {
      gender: parsed.gender === "男装" || parsed.gender === "女装" ? parsed.gender : "",
      styleName: typeof parsed.styleName === "string" ? parsed.styleName : "",
      estimatedCutPieceSendDate: typeof parsed.estimatedCutPieceSendDate === "string"
        ? parsed.estimatedCutPieceSendDate
        : "",
      deliveryDate: parsed.deliveryDate,
      lineItems: lineItems.map((line) => ({
        ...line,
        imageAttachmentId: images.some((image) => image.attachmentId === line.imageAttachmentId)
          ? line.imageAttachmentId ?? "" : "",
      })),
      daxingUnitPrice: typeof parsed.daxingUnitPrice === "string" ? parsed.daxingUnitPrice : "",
      images,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
    };
  } catch {
    return null;
  }
};

const clearLocalSourcingDraft = (userId: string): void => {
  if (typeof window !== "undefined") window.localStorage.removeItem(localSourcingDraftKey(userId));
};

const detailHref = (
  item: SourcingCaseSummary,
  returnTo: string,
): string => withSourcingReturn(
  pageUrl(`ui/sourcing/orders/${item.sourcingCaseId}`),
  returnTo.startsWith("/ui/sourcing/history") ? "history" : "pending",
  readSourcingListQuery(returnTo.slice(returnTo.indexOf("?") + 1)),
);

const sourcingLinePriceLabel = (item: SourcingCaseSummary, position: number): string => {
  const line = item.lineItems.find((entry) => entry.position === position);
  const price = item.decision?.linePrices.find((entry) => entry.position === position)?.unitPrice
    ?? item.ieQuote?.linePrices.find((entry) => entry.position === position)?.unitPrice
    ?? line?.externalUnitPrice;
  return price ? formatBusinessCurrency(price) : line?.legacy ? "历史未维护价格" : "待 IE 给价";
};

function SourcingOrderCard({
  item,
  returnTo,
  canDelete,
  deleting,
  onDelete,
}: {
  item: SourcingCaseSummary;
  returnTo: string;
  canDelete: boolean;
  deleting: boolean;
  onDelete: (item: SourcingCaseSummary) => void;
}) {
  return <Surface className="sourcing-order-card">
    <a className="sourcing-order-card__main" href={detailHref(item, returnTo)}>
      <div className="sourcing-order-card__heading">
        <div>
          <strong>{item.lineItems[0]?.styleNo ?? item.styleNo}{item.lineItems.length > 1 ? ` 等 ${item.lineItems.length} 行` : ""}</strong>
          <small>{item.gender ?? "历史未维护"} · {item.styleName ?? "历史未维护"}</small>
        </div>
        <StatusBadge tone={item.status === "closed" ? "success" : "info"}>
          {STATUS_LABELS[item.status]}
        </StatusBadge>
      </div>
      <ul className="sourcing-order-card__lines" aria-label="款色明细">
        {item.lineItems.slice(0, 3).map((line) => <li key={line.position}>
          <span>{line.styleNo}{line.alternateStyleNo ? ` / ${line.alternateStyleNo}` : ""}</span>
          <span>{line.color ?? "历史未维护颜色"}</span>
          <span>{formatBusinessDecimal(line.quantity)} 件</span>
          <span>{sourcingLinePriceLabel(item, line.position)}</span>
        </li>)}
        {item.lineItems.length > 3 ? <li><span>另有 {item.lineItems.length - 3} 行</span></li> : null}
      </ul>
      <dl>
        <div><dt>订单数量</dt><dd>{formatBusinessDecimal(item.orderQuantity)}</dd></div>
        {"daxingUnitPrice" in item ? <div><dt>预算价</dt><dd>{formatBusinessCurrency(item.daxingUnitPrice ?? "")}</dd></div> : null}
        <div><dt>IE 单价</dt><dd>{sourcingPriceSummary(item.ieQuote)}</dd></div>
        <div><dt>生产单价</dt><dd>{sourcingPriceSummary(item.decision)}</dd></div>
        <div><dt>加工厂</dt><dd>{item.decision?.supplierName ?? "待选厂"}</dd></div>
        <div><dt>交货日期</dt><dd>{item.deliveryDate ?? "—"}</dd></div>
      </dl>
      <small className="sourcing-order-card__activity">更新于 {formatDateTime(item.updatedAt)}</small>
    </a>
    {canDelete ? <button
      type="button"
      className="sourcing-order-delete"
      aria-label={`删除外发定价选厂订单 ${item.erpOrderNo}`}
      title="删除外发定价选厂订单"
      disabled={deleting}
      onClick={() => onDelete(item)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M9 7l1-2h4l1 2m-9 0 1 13h10l1-13" /></svg>
    </button> : null}
  </Surface>;
}

export function SourcingWorkspacePage({
  view,
  sourcingCaseId,
}: {
  view: WorkspaceView;
  sourcingCaseId?: string;
}) {
  const [user, setUser] = useState<AuthorizedUser | null>(null);
  useEffect(() => {
    let mounted = true;
    void verifySession().then((session) => {
      if (mounted && session !== "denied" && session.status === "authorized") setUser(session.user);
    });
    return () => { mounted = false; };
  }, []);

  const mobileActiveView = view === "detail" ? "pending" : view;
  const canCreateOrder = canAct(user, "order_merchandiser", "sourcing:inquiry:create");

  return (
    <Shell active={ACTIVE_NAVIGATION[view]}>
      <nav className="sourcing-mobile-navigation" aria-label="外发业务页面">
        {canCreateOrder ? <a
          className={mobileActiveView === "create" ? "is-active" : ""}
          aria-current={mobileActiveView === "create" ? "page" : undefined}
          href={pageUrl("ui/sourcing/create")}
        ><NavigationIcon route="/ui/sourcing/create" />创建</a> : null}
        <a
          className={mobileActiveView === "pending" ? "is-active" : ""}
          aria-current={mobileActiveView === "pending" ? "page" : undefined}
          href={pageUrl("ui/sourcing/pending")}
        ><NavigationIcon route="/ui/sourcing/pending" />待审批</a>
        <a
          className={mobileActiveView === "history" ? "is-active" : ""}
          aria-current={mobileActiveView === "history" ? "page" : undefined}
          href={pageUrl("ui/sourcing/history")}
        ><NavigationIcon route="/ui/sourcing/history" />历史</a>
      </nav>
      {view === "create" ? <CreateOrderPage user={user} /> : null}
      {view === "pending" ? <OrderListPage mode="pending" user={user} /> : null}
      {view === "history" ? <OrderListPage mode="history" user={user} /> : null}
      {view === "detail" && sourcingCaseId
        ? <OrderDetailPage sourcingCaseId={sourcingCaseId} user={user} />
        : null}
    </Shell>
  );
}

function CreateOrderPage({ user }: { user: AuthorizedUser | null }) {
  const [gender, setGender] = useState<"" | "男装" | "女装">("");
  const [styleName, setStyleName] = useState("");
  const [styleCatalog, setStyleCatalog] = useState<readonly { styleId: string; styleName: string }[]>([]);
  const [estimatedCutPieceSendDate, setEstimatedCutPieceSendDate] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [lineItems, setLineItems] = useState<SourcingLineDraft[]>([{
    styleNo: "",
    alternateStyleNo: "",
    color: "",
    quantity: "",
  }]);
  const [daxingUnitPrice, setDaxingUnitPrice] = useState("");
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadFailed, setUploadFailed] = useState(false);
  const [activeCreateInput, setActiveCreateInput] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("填写订单资料并上传现场或款式照片。");
  const createKey = useRef<string | null>(null);
  const previewUrls = useRef<string[]>([]);
  const restoredDraftUserId = useRef("");
  const canCreate = canAct(user, "order_merchandiser", "sourcing:inquiry:create");
  const duplicateLinesMessage = duplicateSourcingLineMessage(lineItems);

  useEffect(() => {
    if (!canCreate) return;
    let mounted = true;
    const timer = window.setTimeout(() => {
      const query = styleName.trim();
      const path = query ? `sourcing/styles?q=${encodeURIComponent(query)}` : "sourcing/styles";
      void request(path, SourcingStyleCatalogSchema)
        .then((items) => { if (mounted) setStyleCatalog(items); })
        .catch(() => { if (mounted) setMessage("款式数据库加载失败，请刷新后重试。"); });
    }, 150);
    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, [styleName, canCreate]);

  useEffect(() => {
    if (!user?.id || restoredDraftUserId.current === user.id) return;
    restoredDraftUserId.current = user.id;
    const localDraft = readLocalSourcingDraft(user.id);
    if (!localDraft) return;
    setGender(localDraft.gender);
    setStyleName(localDraft.styleName);
    setEstimatedCutPieceSendDate(localDraft.estimatedCutPieceSendDate);
    setDeliveryDate(localDraft.deliveryDate);
    setLineItems([...localDraft.lineItems]);
    setDaxingUnitPrice(localDraft.daxingUnitPrice);
    setImages([...localDraft.images]);
    setMessage("已恢复当前账号在本机保存的订单草稿。");
  }, [user?.id]);

  useEffect(() => () => {
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.current = [];
  }, []);

  const updateLineItem = (
    index: number,
    field: keyof SourcingLineDraft,
    value: string,
  ): void => {
    setLineItems((current) => current.map((line, currentIndex) => (
      currentIndex === index ? { ...line, [field]: value } : line
    )));
    createKey.current = null;
  };

  const addLineItem = (): void => {
    if (lineItems.length >= MAX_SOURCING_LINE_ITEMS) {
      setMessage(`每张订单最多登记 ${MAX_SOURCING_LINE_ITEMS} 行款色`);
      return;
    }
    setLineItems((current) => [...current, {
      styleNo: "",
      alternateStyleNo: "",
      color: "",
      quantity: "",
    }]);
    createKey.current = null;
  };

  const removeLineItem = async (index: number): Promise<void> => {
    if (lineItems.length === 1) return;
    if (!(await confirmInApp(`确认删除第 ${index + 1} 行未提交款色吗？`))) return;
    setLineItems((current) => current.filter((_line, currentIndex) => currentIndex !== index));
    createKey.current = null;
  };

  const uploadImages = async (files: FileList | null, lineIndex?: number): Promise<void> => {
    if (!files?.length || uploading || busy) return;
    const selected = lineIndex === undefined ? Array.from(files) : [files[0]!];
    const unsupported = selected.find((file) => !isImageUploadCandidate(file));
    if (unsupported) {
      setMessage(`${unsupported.name} 不是支持的图片格式`);
      return;
    }
    if (images.length + selected.length > MAX_SOURCING_ATTACHMENTS) {
      setMessage(`每张订单最多上传 ${MAX_SOURCING_ATTACHMENTS} 张图片`);
      return;
    }
    setUploading(true);
    setUploadFailed(false);
    try {
      const profile = currentUploadClientProfile();
      const uploaded = await prepareAndUploadWithConcurrency(
        selected,
        currentQcUploadConcurrency(),
        async (file, index) => {
          setMessage(`正在处理第 ${index + 1}/${selected.length} 张图片…`);
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
          const timing = { ...baseTiming, uploadBytes: prepared.size };
          const sha256 = await measureAttachmentUploadStage(timing, "hash", () => sha256Hex(prepared));
          return { file: prepared, timing, sha256 };
        },
        async ({ file, timing, sha256 }, sourceFile, index): Promise<UploadedImage> => {
          setMessage(`正在上传第 ${index + 1}/${selected.length} 张图片…`);
          return uploadImageWithNormalizationRetry(sourceFile, file, async (candidate) => {
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
              () => request("tools/attachments/upload-intents", UploadIntentResponseSchema, {
                method: "POST",
                body: JSON.stringify({
                  filename: candidate.name,
                  mimeType: candidate.type,
                  sizeBytes: candidate.size,
                  sha256: candidateSha256,
                }),
              }),
            );
            const upload = new FormData();
            for (const [name, value] of Object.entries(intent.uploadFields)) upload.append(name, value);
            upload.append("file", candidate);
            const response = await measureAttachmentUploadStage(
              candidateTiming,
              "oss",
              () => fetch(intent.uploadUrl, { method: "POST", body: upload }),
            );
            if (!response.ok) throw new Error(`${sourceFile.name} 上传失败`);
            const finalized = await measureAttachmentUploadStage(
              candidateTiming,
              "finalize",
              () => request(
                `tools/attachments/${intent.attachmentId}/finalize`,
                AttachmentResponseSchema,
                { method: "POST" },
              ),
            );
            if (finalized.status !== "ready") throw new Error("订单图片尚未确认成功，请重新上传");
            const previewUrl = URL.createObjectURL(candidate);
            previewUrls.current.push(previewUrl);
            return {
              attachmentId: finalized.attachmentId,
              filename: finalized.filename,
              mimeType: finalized.mimeType,
              previewUrl,
            };
          });
        },
      );
      setImages((current) => [...current, ...uploaded]);
      setUploadFailed(false);
      if (lineIndex !== undefined && uploaded[0]) {
        const imageAttachmentId = uploaded[0].attachmentId;
        setLineItems((current) => current.map((line, index) => index === lineIndex
          ? { ...line, imageAttachmentId } : line));
      }
      setMessage(`已上传 ${formatBusinessDecimal(uploaded.length)} 张图片；请核对订单资料后提交`);
      createKey.current = null;
    } catch (error) {
      setUploadFailed(true);
      setMessage(error instanceof Error ? error.message : "订单图片上传失败");
    } finally {
      setUploading(false);
    }
  };

  const removeImage = (attachmentId: string): void => {
    setLineItems((current) => current.map((line) => line.imageAttachmentId === attachmentId
      ? { ...line, imageAttachmentId: "" } : line));
    setImages((current) => {
      const removed = current.find((image) => image.attachmentId === attachmentId);
      if (removed && previewUrls.current.includes(removed.previewUrl)) {
        URL.revokeObjectURL(removed.previewUrl);
        previewUrls.current = previewUrls.current.filter((url) => url !== removed.previewUrl);
      }
      return current.filter((image) => image.attachmentId !== attachmentId);
    });
    createKey.current = null;
  };

  const saveLocalDraft = (): void => {
    if (busy || uploading) return;
    if (!user?.id) {
      setMessage("正在确认登录账号，请稍后再保存草稿。");
      return;
    }
    const draft: LocalSourcingDraft = {
      gender,
      styleName,
      estimatedCutPieceSendDate,
      deliveryDate,
      lineItems,
      daxingUnitPrice,
      images,
      savedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(localSourcingDraftKey(user.id), JSON.stringify(draft));
    setMessage("草稿已保存在本机；下次打开创建订单会自动恢复。");
  };

  const createOrder = async (): Promise<void> => {
    if (busy || uploading || uploadFailed) { setMessage("请等待图片上传成功，失败时重新选择图片上传。"); return; }
    const normalizedLines = lineItems.map((line) => ({
      ...(line.styleNo.trim() ? { styleNo: line.styleNo.trim() } : {}),
      ...(line.alternateStyleNo.trim() ? { alternateStyleNo: line.alternateStyleNo.trim() } : {}),
      color: line.color.trim(),
      quantity: Number(line.quantity),
      ...(line.imageAttachmentId ? { imageAttachmentId: line.imageAttachmentId } : {}),
    }));
    if (!canCreate) { setMessage("当前账号没有创建订单权限"); return; }
    if (!gender || !styleName.trim()) { setMessage("请选择性别并填写款式"); return; }
    if (!estimatedCutPieceSendDate || !deliveryDate) {
      setMessage("请填写裁片发出日期和到工厂的交货日期"); return;
    }
    if (normalizedLines.some((line) => (!line.styleNo && !line.alternateStyleNo) || !line.color)) {
      setMessage("每行须填写正式款号或代用款号，并填写颜色");
      return;
    }
    if (lineItems.some((line) => !/^\d+$/.test(line.quantity))
      || normalizedLines.some((line) => line.quantity < 1 || line.quantity > 10_000_000)) {
      setMessage("每行数量必须是1至10000000之间的整数");
      return;
    }
    const normalizedDaxingPrice = businessInputChange(daxingUnitPrice).trim();
    if (!isNewSourcingPrice(normalizedDaxingPrice)) {
      setMessage("请填写预算价，最多2位有效小数且必须大于0");
      return;
    }
    try {
      calculateSourcingOrderQuantity(normalizedLines);
    } catch {
      setMessage("订单总数量必须是1至10000000之间的整数");
      return;
    }
    if (images.length === 0) { setMessage("请至少上传一张订单照片"); return; }
    setBusy(true);
    const requestKey = createKey.current ?? createClientRequestId();
    createKey.current = requestKey;
    try {
      const created = await requestWithStyleCheck("sourcing/cases", SourcingCaseSummarySchema, {
        method: "POST",
        headers: { "idempotency-key": requestKey },
        body: JSON.stringify({
          gender,
          styleName: styleName.trim(),
          estimatedCutPieceSendDate,
          deliveryDate,
          lineItems: normalizedLines,
          daxingUnitPrice: normalizedDaxingPrice,
          attachmentIds: images.map((image) => image.attachmentId),
        }),
      }, normalizedLines);
      if (user?.id) clearLocalSourcingDraft(user.id);
      window.location.assign(detailHref(created));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "订单创建失败");
      setBusy(false);
    }
  };

  return (
    <div className="sourcing-workspace sourcing-workspace--create">
      <Header
        iconRoute="/ui/sourcing/create"
        title="创建订单"
        subtitle="跟单登记订单资料、款色数量和照片，提交后由 IE 首次给加工报价。"
        badge="外发定价&选厂"
      />
      <Surface className="sourcing-create-card">
        <div className="section-title">
          <div><h2>订单资料</h2><p>请按实际订单填写；预算价仅供内部核价。</p></div>
          <StatusBadge tone="info">跟单提交</StatusBadge>
        </div>
        <div className="sourcing-form-grid">
          <div className="sourcing-order-classification">
            <label><span>性别（必填）</span><select required value={gender} onChange={(event) => { setGender(event.target.value as typeof gender); createKey.current = null; }}><option value="">请选择</option><option value="男装">男装</option><option value="女装">女装</option></select></label>
            <label><span>款式（必填）</span><input required list="sourcing-style-options" value={styleName} maxLength={100} onChange={(event) => { setStyleName(event.target.value); createKey.current = null; }} placeholder="搜索或输入，如梭织短裤" /></label>
            <datalist id="sourcing-style-options">{styleCatalog.map((style) => <option key={style.styleId} value={style.styleName} />)}</datalist>
          </div>
          <label><span>预计裁片发出日期（工厂发出，必填）</span><input type="date" required aria-required="true" value={estimatedCutPieceSendDate} onChange={(event) => { setEstimatedCutPieceSendDate(event.target.value); createKey.current = null; }} /></label>
          <label><span>要求交货日期（到工厂，必填）</span><input type="date" required aria-required="true" value={deliveryDate} onChange={(event) => { setDeliveryDate(event.target.value); createKey.current = null; }} /></label>
          <label><span>预算价（内部，必填）</span><input value={activeCreateInput === "daxing" ? daxingUnitPrice : newSourcingPriceDisplay(daxingUnitPrice)} onFocus={() => setActiveCreateInput("daxing")} onBlur={() => setActiveCreateInput(null)} inputMode="decimal" onChange={(event) => { setDaxingUnitPrice(businessInputChange(event.target.value)); createKey.current = null; }} placeholder="必填，最多2位有效小数；仅内部授权岗位可见" aria-invalid={!isNewSourcingPrice(daxingUnitPrice)} /><small>{!isNewSourcingPrice(daxingUnitPrice) ? "请填写大于0且最多2位有效小数的预算价。" : "仅内部授权岗位可见，不进入供应商合同。"}</small></label>
          <section className="sourcing-line-editor sourcing-form-wide" aria-label="订单款色明细">
            <div className="sourcing-line-editor__heading">
              <div>
                <strong>款色明细</strong>
                <small>一份订单可登记多行款色；加工报价由 IE 首次填写，总数量由各行自动汇总。</small>
              </div>
              <div className="sourcing-line-editor__actions">
                <StatusBadge tone="info">合计 {formatBusinessDecimal(lineItems.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0))} 件</StatusBadge>
                <button className="dx-button dx-button--secondary" type="button" disabled={busy || uploading || lineItems.length >= MAX_SOURCING_LINE_ITEMS} onClick={addLineItem}>＋ 新增款色</button>
              </div>
            </div>
            <div className="sourcing-line-editor__list">
              {lineItems.map((line, index) => <article className="sourcing-line-row" key={index}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                <label><span>正式款号</span><input value={line.styleNo} maxLength={100} onChange={(event) => updateLineItem(index, "styleNo", event.target.value)} placeholder="可后补" /></label>
                <label><span>代用款号</span><input value={line.alternateStyleNo} maxLength={100} onChange={(event) => updateLineItem(index, "alternateStyleNo", event.target.value)} placeholder="无正式款号时必填" /></label>
                <label><span>颜色</span><input value={line.color} maxLength={100} onChange={(event) => updateLineItem(index, "color", event.target.value)} placeholder="必填" /></label>
                <label><span>数量</span><input value={activeCreateInput === `quantity-${index}` ? line.quantity : businessInputValue(line.quantity)} onFocus={() => setActiveCreateInput(`quantity-${index}`)} onBlur={() => setActiveCreateInput(null)} inputMode="numeric" onChange={(event) => updateLineItem(index, "quantity", businessInputChange(event.target.value))} placeholder="整数" /></label>
                <div className="sourcing-line-photo">
                  {line.imageAttachmentId ? <img src={images.find((image) => image.attachmentId === line.imageAttachmentId)?.previewUrl} alt={`第 ${index + 1} 款图片`} /> : null}
                  <label className="rework-v2-upload">
                    <span>{line.imageAttachmentId ? "更换图片" : "＋ 上传图片"}</span>
                    <input type="file" accept="image/*" disabled={busy || uploading || images.length >= MAX_SOURCING_ATTACHMENTS} onChange={(event) => { void uploadImages(event.target.files, index); event.target.value = ""; }} />
                  </label>
                  {images.length > 0 ? <select aria-label={`第 ${index + 1} 款复用图片`} value={line.imageAttachmentId ?? ""} disabled={busy || uploading} onChange={(event) => updateLineItem(index, "imageAttachmentId", event.target.value)}>
                    <option value="">复用已上传图片</option>
                    {images.map((image, imageIndex) => <option key={image.attachmentId} value={image.attachmentId}>{imageIndex + 1}. {image.filename}</option>)}
                  </select> : null}
                </div>
                <button className="dx-button dx-button--secondary" type="button" aria-label={`删除第 ${index + 1} 行款色`} disabled={busy || uploading || lineItems.length === 1} onClick={() => void removeLineItem(index)}>删除</button>
              </article>)}
            </div>
          </section>

        </div>
        <section className="sourcing-photo-field" aria-label="订单照片">
          <div className="section-title">
            <div><h2>订单照片（必填）</h2><p>至少上传1张；款图也会显示在这里，无需重复上传。支持 JPG、PNG、WebP。</p></div>
            <StatusBadge tone="info">{images.length}/{MAX_SOURCING_ATTACHMENTS}</StatusBadge>
          </div>
          {images.length > 0 ? <div className="rework-v2-image-grid">
            {images.map((image) => <article key={image.attachmentId}>
              <a href={image.previewUrl} target="_blank" rel="noreferrer">
                <img src={image.previewUrl} alt={image.filename} />
              </a>
              <button type="button" disabled={busy || uploading} onClick={() => removeImage(image.attachmentId)}>移除</button>
            </article>)}
          </div> : null}
          <label className="rework-v2-upload">
            <span>{uploading ? "正在上传…" : "＋ 上传照片"}</span>
            <input type="file" accept="image/*" multiple disabled={busy || uploading || images.length >= MAX_SOURCING_ATTACHMENTS} onChange={(event) => { void uploadImages(event.target.files); event.target.value = ""; }} />
          </label>
        </section>
        <div className="sourcing-submit-row">
          <p role="status">{duplicateLinesMessage ?? message}</p>
          {uploadFailed && !uploading ? <p role="alert">本次图片上传未完成，请重新选择图片上传成功后再提交。</p> : null}
          <div className="sourcing-create-actions">
            <button className="dx-button dx-button--secondary" type="button" disabled={busy || uploading} onClick={saveLocalDraft}>保存草稿</button>
            <button className="dx-button dx-button--primary" type="button" disabled={busy || uploading || uploadFailed || !images.length || !canCreate} onClick={() => void createOrder()}>
              {busy ? "正在提交…" : "提交并进入审批"}
            </button>
          </div>
        </div>
      </Surface>
    </div>
  );
}

function OrderListPage({
  mode,
  user,
}: {
  mode: "pending" | "history";
  user: AuthorizedUser | null;
}) {
  const [initial] = useState(() => readSourcingListQuery(window.location.search));
  const [items, setItems] = useState<readonly SourcingCaseSummary[]>([]);
  const [search, setSearch] = useState(initial.q);
  const [stage, setStage] = useState<SourcingStageFilter>(mode === "history" ? "all" : initial.stage);
  const [gender, setGender] = useState<SourcingGenderFilter>(initial.gender);
  const [styleName, setStyleName] = useState(initial.styleName);
  const [message, setMessage] = useState("正在加载订单…");
  const [deletingCaseId, setDeletingCaseId] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [page, setPage] = useState(initial.page);
  const [totalPages, setTotalPages] = useState(1);
  const loadVersion = useRef(0);
  const debouncedSearch = useDebouncedValue(search.trim(), 180);
  const debouncedStyleName = useDebouncedValue(styleName.trim(), 180);
  const listState: SourcingListQuery = {
    q: debouncedSearch,
    stage: mode === "history" ? "all" : stage,
    gender,
    styleName: debouncedStyleName,
    page,
  };
  const listPath = sourcingListPath(mode, listState);

  const load = async (state: SourcingListQuery): Promise<void> => {
    const version = ++loadVersion.current;
    try {
      const params = new URLSearchParams({
        status: mode === "history" ? "closed" : "pending",
        q: state.q,
        stage: state.stage,
        gender: state.gender,
        styleName: state.styleName,
        page: String(state.page),
      });
      const body = await request(
        `sourcing/cases?${params.toString()}`,
        SourcingCaseListResponseSchema,
      );
      if (version !== loadVersion.current) return;
      setItems(body.items);
      setPage(body.page);
      setTotalPages(body.totalPages);
      setMessage("");
    } catch (error) {
      if (version !== loadVersion.current) return;
      setMessage(error instanceof Error ? error.message : "订单列表加载失败");
    }
  };

  useEffect(() => {
    window.history.replaceState(window.history.state, "", pageUrl(listPath));
  }, [listPath]);

  useEffect(() => {
    void load(listState);
  }, [debouncedSearch, debouncedStyleName, stage, gender, page, mode]);

  const changeStage = (value: SourcingStageFilter): void => {
    setStage(value);
    setPage(1);
  };
  const changeGender = (value: SourcingGenderFilter): void => {
    setGender(value);
    setPage(1);
  };

  const visible = useMemo(
    () => items.filter((item) => mode === "history" ? item.status === "closed" : item.status !== "closed"),
    [items, mode],
  );

  const remove = async (item: SourcingCaseSummary): Promise<void> => {
    if (!(await confirmInApp(
      sourcingDeleteConfirmation(item),
    ))) return;
    setDeletingCaseId(item.sourcingCaseId);
    setDeleteError("");
    try {
      await request(
        `sourcing/cases/${item.sourcingCaseId}`,
        DeleteSourcingCaseResponseSchema,
        {
          method: "DELETE",
          headers: { "idempotency-key": createClientRequestId() },
        },
      );
      setItems((current) => current.filter((entry) => entry.sourcingCaseId !== item.sourcingCaseId));
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeletingCaseId("");
    }
  };

  return (
    <div className="sourcing-workspace">
      <Header
        iconRoute={mode === "pending" ? "/ui/sourcing/pending" : "/ui/sourcing/history"}
        title={mode === "pending" ? "待审批订单" : "历史订单"}
        subtitle={mode === "pending" ? "所有未完成订单集中在这里，点击订单查看完整流程和当前办理区。" : "所有已完成订单集中归档，保留报价、调价、选厂和审批证据。"}
        badge={`${formatBusinessDecimal(visible.length)} 条当前页`}
      />
      <WorkAnalysisPanel kind="quote" />
      <Surface className="sourcing-list-card">
        <div className="sourcing-search" aria-label="外发订单筛选">
          <label className="sourcing-search__keyword">
            <span>关键词</span>
            <input
              aria-label="关键词搜索"
              value={search}
              maxLength={100}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </label>
          {mode === "pending" ? <label>
            <span>订单状态</span>
            <select
              aria-label="订单状态"
              value={stage}
              onChange={(event) => changeStage(event.target.value as SourcingStageFilter)}
            >
              <option value="all">全部状态</option>
              <option value="ie">待 IE 报价</option>
              <option value="management">待生产管理调价选厂</option>
              <option value="owner">待老板终审</option>
              <option value="finance">待财务核对</option>
              <option value="factory_change">待核实换厂</option>
              <option value="exception">待核实差异</option>
            </select>
          </label> : null}
          <label>
            <span>性别</span>
            <select
              aria-label="性别"
              value={gender}
              onChange={(event) => changeGender(event.target.value as SourcingGenderFilter)}
            >
              <option value="all">全部</option>
              <option value="男装">男装</option>
              <option value="女装">女装</option>
              <option value="missing">历史未维护</option>
            </select>
          </label>
          <label>
            <span>款式类别</span>
            <input
              aria-label="款式类别"
              value={styleName}
              maxLength={100}
              list="sourcing-style-filter-options"
              onChange={(event) => {
                setStyleName(event.target.value);
                setPage(1);
              }}
            />
            <datalist id="sourcing-style-filter-options">
              <option value="历史未维护" />
              {[...new Set(items.map((item) => item.styleName).filter((value): value is string => !!value))]
                .map((value) => <option value={value} key={value} />)}
            </datalist>
          </label>
        </div>
        {deleteError ? <p className="sourcing-delete-error" role="alert">{deleteError}</p> : null}
        {message ? <p className="sourcing-list-message" role="status">{message}</p> : null}
        {!message && visible.length === 0 ? <p className="sourcing-list-message">暂无符合条件的订单</p> : null}
        <div className="sourcing-order-list">
          {visible.map((item) => <SourcingOrderCard
            item={item}
            returnTo={listPath}
            key={item.sourcingCaseId}
            canDelete={user?.isRoot === true}
            deleting={deletingCaseId === item.sourcingCaseId}
            onDelete={(order) => { void remove(order); }}
          />)}
        </div>
        {!message ? <ListPagination
          page={page}
          totalPages={totalPages}
          ariaLabel="订单列表分页"
          onPageChange={setPage}
        /> : null}
      </Surface>
    </div>
  );
}
const WORKFLOW = [
  { key: "created", number: "01", label: "跟单创建订单", role: "订单跟单" },
  { key: "ie_quote", number: "02", label: "IE 给价", role: "IE" },
  { key: "management", number: "03", label: "调价与选厂", role: "生产管理" },
  { key: "owner", number: "04", label: "最终审批", role: "老板" },
  { key: "finance", number: "05", label: "财务核对", role: "财务" },
] as const;

const statusStep = (status: SourcingCaseStatus): number => ({
  pending_ie_quote: 1,
  pending_management_decision: 2,
  pending_owner_approval: 3,
  pending_contract: 4,
  pending_factory_change_verification: 2,
  pending_finance_reconciliation: 4,
  pending_exception_verification: 4,
  closed: 5,
})[status];

const timelineLabel = (entry: SourcingTimelineEntry): string => ({
  created: "创建订单",
  style_revision: "修改款号",
  ie_quote: `IE 报价 V${entry.version}`,
  management_decision: `生产管理决定 V${entry.version}`,
  owner_decision: entry.decision === "approved" ? "老板批准" : "老板驳回",
  contract: `合同登记 V${entry.version}`,
  factory_change_request: `换厂申请 V${entry.version}`,
  factory_change_verification: entry.decision === "approved" ? "换厂核实通过" : "换厂申请驳回",
  finance_reconciliation: entry.result === "match"
    ? `财务核对一致 V${entry.version}`
    : `财务发现差异 V${entry.version}`,
  exception_verification: entry.resolution === "close" ? "差异确认闭环" : "退回财务重核",
})[entry.kind];

type SourcingWorkflowNodeKey = typeof WORKFLOW[number]["key"];
type SourcingWorkflowNodeState = "completed" | "current" | "future";

const sourcingWorkflowNodeKeys = new Set<SourcingWorkflowNodeKey>(WORKFLOW.map((node) => node.key));

const sourcingWorkflowNodeFromSearch = (): SourcingWorkflowNodeKey | null => {
  const value = new URLSearchParams(window.location.search).get("node");
  return value && sourcingWorkflowNodeKeys.has(value as SourcingWorkflowNodeKey)
    ? value as SourcingWorkflowNodeKey
    : null;
};

const sourcingWorkflowNodeHref = (
  sourcingCaseId: string,
  key: SourcingWorkflowNodeKey,
  returnTo: string | null,
): string => {
  const params = new URLSearchParams({ node: key });
  if (returnTo) params.set("returnTo", returnTo);
  return `${pageUrl(`ui/sourcing/orders/${sourcingCaseId}`)}?${params}#node-workspace`;
};

const timelineNode = (entry: SourcingTimelineEntry): SourcingWorkflowNodeKey => ({
  created: "created",
  style_revision: "created",
  ie_quote: "ie_quote",
  management_decision: "management",
  owner_decision: "owner",
  contract: "finance",
  factory_change_request: "management",
  factory_change_verification: "management",
  finance_reconciliation: "finance",
  exception_verification: "finance",
} as const)[entry.kind];

const WORKFLOW_PREVIEWS: Readonly<Record<SourcingWorkflowNodeKey, string>> = {
  created: "查看跟单创建订单时提交的订单资料与图片。",
  ie_quote: "查看 IE 核定的加工单价、数量、总额和说明。",
  management: "查看生产管理的调价、选厂及决定依据。",
  owner: "查看老板最终审批结论与审批说明。",
  finance: "查看财务四项核对、差异处理和闭环记录。",
};

function OrderDetailPage({
  sourcingCaseId,
  user,
}: {
  sourcingCaseId: string;
  user: AuthorizedUser | null;
}) {
  const [item, setItem] = useState<SourcingCaseSummary | null>(null);
  const [editingStyles,setEditingStyles] = useState(false);
  const [styleEdits,setStyleEdits] = useState<Array<{position:number;styleNo:string;alternateStyleNo:string}>>([]);
  const [styleEditRevision,setStyleEditRevision] = useState(0);
  const styleEditKey = useRef<string | null>(null);
  const [attachments, setAttachments] = useState<readonly SourcingAttachment[]>([]);
  const [timeline, setTimeline] = useState<readonly SourcingTimelineEntry[]>([]);
  const [factories, setFactories] = useState<readonly SourcingFactory[]>([]);
  const [quote, setQuote] = useState<QuoteDraft>({ linePrices: [], quoteReason: "" });
  const [processes, setProcesses] = useState<string[]>([""]);
  const [craftCatalog, setCraftCatalog] = useState<readonly CraftCatalogItem[]>([]);
  const [activeCraftQuery, setActiveCraftQuery] = useState("");
  const [decision, setDecision] = useState<DecisionDraft>({ supplierId: "", linePrices: [], decisionReason: "", cuttingProcess: "", cuttingProcessOther: "" });
  const [financeReview, setFinanceReview] = useState<FinanceReviewDraft>({ differenceFields: [], differenceReason: "" });
  const [factoryChange, setFactoryChange] = useState<SourcingFactoryChangeState | null>(null);
  const [contract, setContract] = useState<SourcingContractDocument | null>(null);
  const [dispatchState, setDispatchState] = useState<SourcingDispatchState>({ item: null, canDispatch: false });
  const [contractSupplement, setContractSupplement] = useState<ContractSupplementDraft>({});
  const [factoryChangeDraft, setFactoryChangeDraft] = useState<FactoryChangeDraft>({ supplierId: "", unitPrice: "", changeReason: "" });
  const [factoryChangeReviewReason, setFactoryChangeReviewReason] = useState("");
  const [exceptionReason, setExceptionReason] = useState("");
  const [selectedImage, setSelectedImage] = useState<SourcingAttachment | null>(null);
  const [mobileWorkflowExpanded, setMobileWorkflowExpanded] = useState(false);
  const workflowRailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mobileWorkflowExpanded) workflowRailRef.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [mobileWorkflowExpanded]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("正在加载订单…");
  const [activeBusinessInput, setActiveBusinessInput] = useState<string | null>(null);
  const [factoryChangeUnitPriceEdited, setFactoryChangeUnitPriceEdited] = useState(false);
  const actionKey = useRef<string | null>(null);
  const priceInputs = useRef(new Map<string, ReturnType<typeof createSourcingPriceInput>>());
  const quotePriceOverrides = useRef<ReadonlySet<number>>(new Set<number>());
  const decisionPriceOverrides = useRef<ReadonlySet<number>>(new Set<number>());
  const [, refreshPriceInputs] = useState(0);
  useEffect(() => {
    quotePriceOverrides.current = new Set<number>();
    decisionPriceOverrides.current = new Set<number>();
  }, [sourcingCaseId]);
  const priceInput = (kind: "quote" | "decision", position: number, value: string) => {
    const key = `${kind}-${position}`;
    let control = priceInputs.current.get(key);
    if (!control) {
      control = createSourcingPriceInput(next => {
        const overrides = kind === "quote" ? quotePriceOverrides : decisionPriceOverrides;
        const update = (lines: readonly LinePriceDraft[]) => {
          const result = applySourcingPriceCascade(lines, position, next, overrides.current);
          overrides.current = result.independentPositions;
          return result.linePrices;
        };
        if (kind === "quote") setQuote(current => ({ ...current, linePrices: update(current.linePrices) }));
        else setDecision(current => ({ ...current, linePrices: update(current.linePrices) }));
        actionKey.current = null;
      }, () => refreshPriceInputs(current => current + 1));
      priceInputs.current.set(key, control);
    }
    control.sync(value);
    return control;
  };
  const priceComposing = (kind: "quote" | "decision") => [...priceInputs.current].some(([key, control]) => key.startsWith(`${kind}-`) && control.composing);

  const moduleWritable = moduleCanWrite(user, "sourcing");
  const canSupplementImages = user?.isRoot === true
    || moduleWritable && user?.businessRoles?.some((role) => SOURCING_IMAGE_SUPPLEMENT_ROLES.includes(
      role as (typeof SOURCING_IMAGE_SUPPLEMENT_ROLES)[number],
    )) === true;

  const load = async (): Promise<void> => {
    try {
      const [detail, evidence, history, currentFactoryChange, currentContract, currentDispatch] = await Promise.all([
        request(`sourcing/cases/${sourcingCaseId}`, SourcingCaseSummarySchema),
        request(`sourcing/cases/${sourcingCaseId}/attachments`, SourcingAttachmentListResponseSchema),
        request(`sourcing/cases/${sourcingCaseId}/timeline`, SourcingTimelineResponseSchema),
        request(`sourcing/cases/${sourcingCaseId}/factory-changes/current`, SourcingFactoryChangeStateResponseSchema),
        request(`sourcing/cases/${sourcingCaseId}/contract`, SourcingContractStateResponseSchema),
        request(`sourcing/cases/${sourcingCaseId}/dispatch`, SourcingDispatchStateSchema),
      ]);
      setItem(detail);
      setProcesses((current) => current.some((value) => value.trim()) ? current : detail.processes.length ? [...detail.processes] : [""]);
      setAttachments(evidence.items);
      setTimeline(history.items);
      setFactoryChange(currentFactoryChange.item);
      setContract(currentContract.item);
      setDispatchState(currentDispatch);
      setFactoryChangeDraft((current) => ({
        supplierId: current.supplierId,
        unitPrice: current.unitPrice || detail.decision?.unitPrice || "",
        changeReason: current.changeReason,
      }));
      setQuote((current) => ({
        quoteReason: current.quoteReason,
        linePrices: detail.lineItems.map((line) => ({
          position: line.position,
          unitPrice: current.linePrices.find((price) => price.position === line.position)?.unitPrice
            || "",
        })),
      }));
      setDecision((current) => ({
        supplierId: current.supplierId || detail.decision?.supplierId || "",
        linePrices: detail.lineItems.map((line) => ({
          position: line.position,
          unitPrice: current.linePrices.find((price) => price.position === line.position)?.unitPrice
            || detail.decision?.linePrices.find((price) => price.position === line.position)?.unitPrice
            || detail.ieQuote?.linePrices.find((price) => price.position === line.position)?.unitPrice
            || "",
        })),
        decisionReason: current.decisionReason,
        cuttingProcess: current.cuttingProcess || detail.decision?.cuttingProcess || "",
        cuttingProcessOther: current.cuttingProcessOther || detail.decision?.cuttingProcessOther || "",
      }));
      setFactoryChangeUnitPriceEdited(false);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "订单加载失败");
    }
  };

  useEffect(() => { void load(); }, [sourcingCaseId]);
  const canQuote = canAct(user, "ie_reviewer", "sourcing:price:quote");
  const canManage = canAct(user, "production_management", "sourcing:decision:record");
  useEffect(() => {
    if (!canManage) return;
    let mounted = true;
    const timer = window.setTimeout(() => {
      const query = activeCraftQuery.trim();
      const path = query ? `master-data/crafts?q=${encodeURIComponent(query)}` : "master-data/crafts";
      void request(path, CraftCatalogListResponseSchema)
        .then((items) => { if (mounted) setCraftCatalog(items); })
        .catch(() => { if (mounted) setMessage("工艺数据库加载失败，请刷新后重试。"); });
    }, 150);
    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, [activeCraftQuery, canManage]);

  const updateProcess = (index: number, value: string): void => {
    setProcesses((current) => current.map((process, currentIndex) => (
      currentIndex === index ? value : process
    )));
    setActiveCraftQuery(value);
    actionKey.current = null;
  };

  const addProcess = (): void => {
    if (processes.length >= MAX_SOURCING_PROCESSES) {
      setMessage(`每张订单最多登记 ${MAX_SOURCING_PROCESSES} 项工艺`);
      return;
    }
    setProcesses((current) => [...current, ""]);
    actionKey.current = null;
  };

  const removeProcess = (index: number): void => {
    setProcesses((current) => current.length === 1
      ? [""]
      : current.filter((_process, currentIndex) => currentIndex !== index));
    actionKey.current = null;
  };

  const canEditStyles = moduleWritable && !!item?.approvalSnapshot && ["pending_finance_reconciliation", "closed"].includes(item.status) && contract?.status === "ready" && !!contract.pdfAttachmentId
    && (user?.isRoot === true || canManage || (canAct(user,"order_merchandiser","sourcing:inquiry:create") && item?.createdBy === user?.id));
  const styleDuplicateMessage = duplicateSourcingLineMessage(styleEdits.map(line => ({...line,color:item?.lineItems.find(row => row.position===line.position)?.color})));
  const saveStyles = async (): Promise<void> => {
    if (!item || busy || !canEditStyles) return;
    if (styleEdits.some(line => !line.styleNo.trim() && !line.alternateStyleNo.trim())) {setMessage("每行须填写正式款号或代用款号");return;}
    setBusy(true);
    const key=styleEditKey.current ?? createClientRequestId();styleEditKey.current=key;
    try {
      await requestWithStyleCheck(`sourcing/cases/${sourcingCaseId}/styles`,SourcingCaseSummarySchema,{method:"POST",headers:{"idempotency-key":key},
        body:JSON.stringify({expectedRevision:styleEditRevision,lines:styleEdits.map(line=>({position:line.position,styleNo:line.styleNo.trim()||null,alternateStyleNo:line.alternateStyleNo.trim()||null}))})},styleEdits.map(line => ({...line,color:item.lineItems.find(row => row.position===line.position)?.color})));
      setEditingStyles(false);styleEditKey.current=null;
      await load();setMessage("款号已保存；已生成的合同将保留旧版，并更新当前下载版本。");
    } catch(error) {setMessage(error instanceof Error ? error.message : "款号保存失败");}
    finally {setBusy(false);}
  };
  const canOwner = canAct(user, "owner_group", "sourcing:owner:approve");
  const canMerchandiserTransfer = canAct(user, "order_merchandiser", "sourcing:factory_change:request");
  const canManagementTransfer = canManage;
  const canOwnerTransfer = canOwner;
  const canReviewManagementTransfer = canAct(user, "production_management", "sourcing:factory_change:verify");
  const canFinance = canAct(user, "factory_payables", "sourcing:finance:reconcile");
  const canReadContractData = user?.isRoot === true
    || user?.capabilities.includes("supplier_contract_data:read") === true;
  const hasPendingFactoryChange = factoryChange?.status === "pending_management"
    || factoryChange?.status === "pending_owner";
  const canVerifyException = canAct(user, "production_management", "sourcing:exception:verify");

  useEffect(() => {
    if (!canManage && !canMerchandiserTransfer && !canOwnerTransfer) return;
    void request("sourcing/factories", SourcingFactoryListResponseSchema)
      .then((body) => setFactories(body.items))
      .catch((error) => setMessage(error instanceof Error ? error.message : "加工厂加载失败"));
  }, [canManage, canMerchandiserTransfer, canOwnerTransfer]);

  const submit = async (
    path: string,
    body: unknown,
    success: string,
    resetFactoryChange = false,
  ): Promise<void> => {
    if (path.endsWith("/ie-quotes") && priceComposing("quote")) return;
    if (path.endsWith("/ie-quotes") && (!quote.linePrices.length || quote.linePrices.some((line) => !isNewSourcingPrice(line.unitPrice)))) {
      setMessage("请填写各款大于0且最多2位有效小数的IE价格"); return;
    }
    setBusy(true);
    const requestKey = actionKey.current ?? createClientRequestId();
    actionKey.current = requestKey;
    try {
      const updated = await request(path, SourcingCaseSummarySchema, {
        method: "POST",
        headers: { "idempotency-key": requestKey },
        body: JSON.stringify(body),
      });
      actionKey.current = null;
      setMessage(success);
      if (resetFactoryChange) {
        setFactoryChangeDraft({
          supplierId: "",
          unitPrice: updated.decision?.unitPrice || "",
          changeReason: "",
        });
        setFactoryChangeReviewReason("");
      }
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提交失败");
    } finally {
      setBusy(false);
    }
  };

  const dispatchOrder = async (): Promise<void> => {
    const snapshot = item?.approvalSnapshot;
    if (busy || !item || !snapshot || !contract || !(moduleWritable && dispatchState.canDispatch)) return;
    if (contract.sourcingApprovalSnapshotId !== snapshot.sourcingApprovalSnapshotId) {
      setMessage("订单已更新，请刷新后确认派单信息。");
      return;
    }
    setBusy(true);
    try {
      const confirmed = await confirmInApp(
        `供应商：${snapshot.supplierName}\n总数量：${formatBusinessDecimal(snapshot.quantity)} 件\n交期：${snapshot.deliveryDate ?? "历史未维护"}\n合同编号：${contract.contractNumber}`,
        { title: "确认正式派单", confirmLabel: "确认派单", cancelLabel: "取消" },
      );
      if (!confirmed) return;
      await request(`sourcing/cases/${item.sourcingCaseId}/dispatch`, SourcingProductionOrderSchema, {
        method: "POST", headers: { "idempotency-key": createClientRequestId() },
        body: JSON.stringify({ sourcingContractDocumentId: contract.sourcingContractDocumentId, confirmed: true }),
      });
      await load();
      setMessage("已正式派单，待首次生产上报。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "派单失败，请重试");
    } finally { setBusy(false); }
  };

  const submitContract = async (path: string, body: unknown, success: string): Promise<void> => {
    setBusy(true);
    const requestKey = actionKey.current ?? createClientRequestId();
    actionKey.current = requestKey;
    try {
      const updated = await request(path, SourcingContractStateResponseSchema, {
        method: "POST",
        headers: { "idempotency-key": requestKey },
        body: JSON.stringify(body),
      });
      actionKey.current = null;
      setContract(updated.item);
      setContractSupplement({});
      setMessage(success);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "合同操作失败");
    } finally {
      setBusy(false);
    }
  };

  if (!item) {
    return <div className="sourcing-workspace"><Header iconRoute="/ui/sourcing/pending" title="订单详情" subtitle={message} badge="外发定价&选厂" /></div>;
  }

  const needsDecisionReason = sourcingDecisionNeedsReason(decision.linePrices, item.ieQuote?.linePrices ?? []);
  const missingDecisionReason = needsDecisionReason && !decision.decisionReason.trim();
  const submitManagement = async (): Promise<void> => {
    if (priceComposing("decision")) return;
    if (!decision.linePrices.length || decision.linePrices.some((line) => !isNewSourcingPrice(line.unitPrice))) { setMessage("请填写各款大于0且最多2位有效小数的生产价格"); return; }
    if (missingDecisionReason) { setMessage("价格高于 IE，请填写原因"); return; }
    if (decision.cuttingProcess === "other" && !decision.cuttingProcessOther.trim()) { setMessage("请填写其它裁床工序"); return; }
    const names = processes.map((value) => value.trim());
    if (names.some((value) => !value) || new Set(names).size !== names.length) {
      setMessage("请完整填写工艺及承包范围，不能重复"); return;
    }
    setBusy(true);
    try {
      const crafts = await request("master-data/crafts/ensure", CraftCatalogListResponseSchema, {
        method: "POST", body: JSON.stringify({ craftNames: names }),
      });
      await submit(`sourcing/cases/${item.sourcingCaseId}/management-decisions`, {
        supplierId: decision.supplierId, linePrices: decision.linePrices,
        craftIds: crafts.map((craft) => craft.craftId),
        ...(decision.cuttingProcess ? { cuttingProcess: decision.cuttingProcess } : {}),
        ...(decision.cuttingProcess === "other" ? { cuttingProcessOther: decision.cuttingProcessOther.trim() } : {}),
        ...(decision.decisionReason.trim() ? { decisionReason: decision.decisionReason.trim() } : {}),
      }, "逐款调价、选厂与工艺及承包范围已提交老板审批");
    } catch (error) { setMessage(error instanceof Error ? error.message : "工艺确认失败"); }
    finally { setBusy(false); }
  };

  const mainStep = statusStep(item.status);
  const step = factoryChange?.status === "pending_owner" ? Math.max(mainStep, 3) : mainStep;
  const activeNode = WORKFLOW[Math.min(step, WORKFLOW.length - 1)]?.key ?? "finance";
  const requestedNode = sourcingWorkflowNodeFromSearch();
  const requestedIndex = requestedNode ? WORKFLOW.findIndex((node) => node.key === requestedNode) : -1;
  const requestedNodeIsAccessible = requestedNode !== null
    && (item.status === "closed" || requestedIndex <= step);
  const selectedNode = requestedNodeIsAccessible ? requestedNode : activeNode;
  const selectedIndex = WORKFLOW.findIndex((node) => node.key === selectedNode);
  const selectedState: SourcingWorkflowNodeState = item.status === "closed" || selectedIndex < step
    ? "completed"
    : selectedIndex === step ? "current" : "future";
  const selectedTimeline = timeline.filter((entry) => timelineNode(entry) === selectedNode);
  const selectedWorkflow = WORKFLOW[selectedIndex] ?? WORKFLOW[WORKFLOW.length - 1]!;
  const priceAdjusted = item.ieQuote && item.decision
    ? item.decision.linePrices.some((line) => (
        item.ieQuote?.linePrices.find((quoteLine) => quoteLine.position === line.position)?.unitPrice
          !== line.unitPrice
      ))
    : false;
  const ownerTotalDelta = item.ieQuote && item.decision
    ? subtractFixedPoint(item.decision.totalAmount, item.ieQuote.totalAmount, 2)
    : null;
  const ownerCraftSummary = <span className="sourcing-owner-craft-summary">承包内容包括 <strong>{item.processes.length ? item.processes.join("、") : "未填写"}</strong>；裁床工序为 <strong>{item.decision?.cuttingProcess === "in_house" ? "本厂裁" : item.decision?.cuttingProcess === "outsourced" ? "外厂裁" : item.decision?.cuttingProcess === "other" ? `其它：${item.decision.cuttingProcessOther ?? "未填写"}` : "未填写"}</strong>。</span>;
  const latestFinance = [...timeline].reverse()
    .find((entry) => entry.kind === "finance_reconciliation");
  const transferNodeRole = selectedNode === "created"
    ? "order_merchandiser"
    : selectedNode === "management" ? "production_management"
      : selectedNode === "owner" ? "owner_group" : null;
  const canInitiateTransfer = transferNodeRole === "order_merchandiser"
    ? canMerchandiserTransfer
    : transferNodeRole === "production_management"
      ? canManagementTransfer
      : transferNodeRole === "owner_group" ? canOwnerTransfer : false;
  const transferRequestPath = transferNodeRole === "production_management"
    ? `sourcing/cases/${item.sourcingCaseId}/factory-changes/management`
    : transferNodeRole === "owner_group"
      ? `sourcing/cases/${item.sourcingCaseId}/factory-changes/owner`
      : `sourcing/cases/${item.sourcingCaseId}/factory-changes`;
  const transferPriceDelta = item.decision && factoryChangeDraft.unitPrice
    ? subtractFixedPoint(factoryChangeDraft.unitPrice, item.decision.unitPrice, 4)
    : null;
  const selectedFactory = factories.find((factory) => factory.supplierId === decision.supplierId);
  const todoBackPath = todoReturnPath(window.location.search);
  const listBackPath = sourcingReturnPath(window.location.search);
  const detailReturnPath = todoBackPath ?? listBackPath;
  const contractMissingLabels: Readonly<Record<string, string>> = {
    address: "地址",
    contractEntityName: "合同主体",
    partyBRepresentative: "乙方代表",
    payeeName: "收款人",
    bankAccount: "收款账号",
    bankName: "开户行",
  };

  return (
    <div className="sourcing-workspace sourcing-order-detail">
      <Header
        iconRoute="/ui/sourcing/pending"
        title={item.styleNo}
        subtitle={`${item.gender ?? "历史未维护"} · ${item.styleName ?? "历史未维护"}`}
        badge={STATUS_LABELS[item.status]}
        badgePlacement="subtitle"
        action={todoBackPath ? "返回我的待办" : "返回订单列表"}
        actionHref={detailReturnPath ?? (item.status === "closed" ? "/ui/sourcing/history" : "/ui/sourcing/pending")}
      />
      <div className="rework-detail-layout rework-detail-target-layout">
        <dl className="rework-detail-core-facts" aria-label="外发定价选厂订单核心信息">
          <div className="rework-detail-core-fact"><dt>订单总数量</dt><dd>{formatBusinessDecimal(item.orderQuantity)} 件</dd></div>
          {"daxingUnitPrice" in item ? <div className="rework-detail-core-fact"><dt>预算价</dt><dd>{formatBusinessCurrency(item.daxingUnitPrice ?? "")}</dd></div> : null}
          <div className="rework-detail-core-fact"><dt>预计裁片发出</dt><dd>{item.estimatedCutPieceSendDate ?? "历史未维护"}</dd></div>
          <div className="rework-detail-core-fact"><dt>要求交货日期</dt><dd>{item.deliveryDate ?? "—"}</dd></div>
          <div className="rework-detail-core-fact"><dt>IE 单价</dt><dd>{sourcingPriceSummary(item.ieQuote)}</dd></div>
          <div className="rework-detail-core-fact"><dt>生产单价</dt><dd>{sourcingPriceSummary(item.decision)}</dd></div>
          <div className="rework-detail-core-fact"><dt>加工厂</dt><dd>{item.decision?.supplierName ?? "待选厂"}</dd></div>
          <div className="rework-detail-core-fact"><dt>总额</dt><dd>{item.decision ? formatBusinessCurrency(item.decision.totalAmount) : item.ieQuote ? formatBusinessCurrency(item.ieQuote.totalAmount) : "—"}</dd></div>
          <div className="rework-detail-core-fact"><dt>调价情况</dt><dd>{priceAdjusted ? "生产管理已调整" : item.decision ? "沿用 IE 价格" : "—"}</dd></div>
          <div className="rework-detail-core-fact"><dt>性别 / 款式</dt><dd>{item.gender ?? "历史未维护"} / {item.styleName ?? "历史未维护"}</dd></div>
          {selectedNode !== "owner" ? <div className="rework-detail-core-fact sourcing-core-processes"><dt>工艺及承包范围</dt><dd>{item.processes.length ? <ol>{item.processes.map((process) => <li key={process}>{process}</li>)}</ol> : "—"}</dd></div> : null}
        </dl>

        <div className="rework-detail-overview-grid order-overview--compact">
          <section className="rework-detail-images" aria-label="订单图片">
            <div className="section-title rework-detail-panel-title">
              <h2>订单图片</h2>
            {canSupplementImages ? <SourcingImageSupplementUploader
              sourcingCaseId={sourcingCaseId}
              currentAttachmentCount={attachments.length}
              onUploaded={load}
            /> : null}
              <StatusBadge tone="info">{formatBusinessDecimal(attachments.length)} 张</StatusBadge>
            </div>
            {attachments.length > 0 ? <div className="rework-detail-image-grid">
              {attachments.map((attachment, index) => <button className="rework-detail-image-card" type="button" key={attachment.attachmentId} onClick={() => setSelectedImage(attachment)}>
                <img src={attachmentUrl(attachment.attachmentId, "preview")} alt={attachment.filename} loading="lazy" />
                <span className="rework-detail-image-card__filename">{attachment.filename}</span>
                {index === 5 && attachments.length > 6 ? <strong className="rework-detail-image-card__overflow">+{attachments.length - 5}</strong> : null}
              </button>)}
            </div> : <p className="sourcing-list-message">本单没有图片</p>}

          </section>

          <section className="rework-workflow" aria-label="订单流程">
            <div className="rework-workflow__heading rework-detail-panel-title rework-detail-desktop-panel-heading">
              <h2>订单流程</h2><span className="rework-workflow__step-count">当前步骤 {Math.min(step + 1, WORKFLOW.length)} / {WORKFLOW.length}</span>
            </div>
            <button className="rework-detail-mobile-panel-toggle rework-detail-mobile-workflow-toggle" type="button"
              aria-controls="sourcing-workflow-content" aria-expanded={mobileWorkflowExpanded}
              onClick={() => setMobileWorkflowExpanded(value => !value)}>
              <span><strong>订单流程</strong><small>{WORKFLOW[Math.min(step, WORKFLOW.length - 1)]?.label}</small></span>
              <span><small>{Math.min(step + 1, WORKFLOW.length)}/{WORKFLOW.length}</small><b aria-hidden="true">{mobileWorkflowExpanded ? "−" : "+"}</b></span>
            </button>
            <div id="sourcing-workflow-content" className={`rework-detail-mobile-collapsible${mobileWorkflowExpanded ? " is-expanded" : ""}`}>
              <div className="rework-workflow__desktop-grid">
              {WORKFLOW.map((node, index) => {
                const state: SourcingWorkflowNodeState = item.status === "closed" || index < step ? "completed" : index === step ? "current" : "future";
                const content = <>
                  <b>{node.number}</b>
                  <span><strong>{node.label}</strong><small>{node.role}</small></span>
                  <em>{state === "completed" ? "已完成" : state === "current" ? "处理中" : "未开始"}</em>
                </>;
                return state === "future"
                  ? <div className="rework-workflow__node is-future" aria-disabled="true" key={node.key}>{content}</div>
                  : <a className={`rework-workflow__node is-${state}`} href={sourcingWorkflowNodeHref(item.sourcingCaseId, node.key, detailReturnPath)} aria-current={state === "current" ? "step" : undefined} key={node.key}>{content}</a>;
              })}
              </div>
              <div className="rework-workflow__mobile-rail" ref={workflowRailRef}>
              {WORKFLOW.map((node, index) => {
                const state: SourcingWorkflowNodeState = item.status === "closed" || index < step ? "completed" : index === step ? "current" : "future";
                const content = <>
                  <b>{node.number}</b>
                  <span><strong>{node.label}</strong><small>{node.role}</small></span>
                  <em>{state === "completed" ? "已完成" : state === "current" ? "处理中" : "未开始"}</em>
                </>;
                return state === "future"
                  ? <div className="rework-workflow__node is-future" aria-disabled="true" key={node.key}>{content}</div>
                  : <a className={`rework-workflow__node is-${state}`} href={sourcingWorkflowNodeHref(item.sourcingCaseId, node.key, detailReturnPath)} aria-current={state === "current" ? "step" : undefined} key={node.key}>{content}</a>;
              })}
              </div>
            </div>
          </section>
        </div>

        <section id="node-workspace" className="rework-detail-task rework-detail-workspace sourcing-action-panel" aria-label="节点办理区">
          <div className="rework-detail-task__heading"><h2>办理区</h2><StatusBadge tone={selectedState === "completed" ? "success" : "info"}>{selectedState === "completed" ? "已完成 · 可只读" : selectedState === "current" ? STATUS_LABELS[item.status] : "未开始 · 可预览"}</StatusBadge></div>
          {selectedState !== "current" ? <Surface className="rework-detail-node-preview">
            <h2>{selectedWorkflow.number} · {selectedWorkflow.label}</h2>
            <p>{WORKFLOW_PREVIEWS[selectedWorkflow.key]}</p>
            <p>负责角色：{selectedWorkflow.role}</p>
            {selectedNode === "owner" ? <p>{ownerCraftSummary}</p> : null}
            {selectedNode === "management" ? <p>裁床工序：{item.decision?.cuttingProcess === "in_house" ? "本厂裁" : item.decision?.cuttingProcess === "outsourced" ? "外厂裁" : item.decision?.cuttingProcess === "other" ? item.decision.cuttingProcessOther : "未填写"}</p> : null}
            {selectedNode === "created" ? <section className="sourcing-line-facts" aria-label="订单款色价格事实">
              <div className="section-title">
                <div><h2>款色明细</h2></div>
                <StatusBadge tone="info">{item.lineItems.length} 行 · {formatBusinessDecimal(item.orderQuantity)} 件</StatusBadge>
              </div>
              <div className="sourcing-line-facts__table">
                <div className="sourcing-line-facts__header">
                  <span>序号</span><span>款号</span><span>代用款号</span><span>颜色</span><span>数量</span><span>对外加工价格</span>
                </div>
                {item.lineItems.map((line) => <div className="sourcing-line-facts__row" key={line.position}>
                  <b>{String(line.position).padStart(2, "0")}</b>
                  <span data-label="款号">{line.styleNo}</span>
                  <span data-label="代用款号">{line.alternateStyleNo ?? "—"}</span>
                  <span data-label="颜色">{line.color ?? "历史未维护"}</span>
                  <span data-label="数量">{formatBusinessDecimal(line.quantity)} 件</span>
                  <span data-label="对外加工价格">{sourcingLinePriceLabel(item, line.position)}</span>
                </div>)}
              </div>
            </section> : null}
            {selectedState === "completed" ? <details className="rework-detail-node-history">
              <summary>处理历史{selectedTimeline.length ? ` · ${formatBusinessDecimal(selectedTimeline.length)} 条` : ""}</summary>
              {selectedTimeline.length ? <div className="sourcing-timeline">
                {selectedTimeline.map((entry) => <article key={entry.entryId}>
                  <div><strong>{timelineLabel(entry)}</strong><small>{formatDateTime(entry.handledAt)} · {entry.handledBy}</small></div>
                  <p>{entry.reason}</p>
                  <dl>
                    {entry.unitPrice ? <div><dt>单价</dt><dd>{formatBusinessCurrency(entry.unitPrice)}</dd></div> : null}
                    {entry.totalAmount ? <div><dt>总额</dt><dd>{formatBusinessCurrency(entry.totalAmount)}</dd></div> : null}
                    {entry.quantity ? <div><dt>数量</dt><dd>{formatBusinessDecimal(entry.quantity)} 件</dd></div> : null}
                    {entry.supplierName ? <div><dt>加工厂</dt><dd>{entry.supplierName}</dd></div> : null}
                    {entry.contractReference ? <div><dt>合同编号</dt><dd>{entry.contractReference}</dd></div> : null}
                    {entry.signedOn ? <div><dt>签署日期</dt><dd>{entry.signedOn}</dd></div> : null}
                    {entry.decision ? <div><dt>结论</dt><dd>{entry.decision === "approved" ? "通过" : "驳回"}</dd></div> : null}
                    {entry.result ? <div><dt>核对结果</dt><dd>{entry.result === "match" ? "四项一致" : `差异：${entry.differenceFields.map((field) => ({ supplier: "供应商", unit_price: "单价", quantity: "数量", total_amount: "总额" })[field]).join("、")}`}</dd></div> : null}
                    {entry.resolution ? <div><dt>处理结果</dt><dd>{entry.resolution === "close" ? "确认差异并闭环" : "退回财务重核"}</dd></div> : null}
                  </dl>
                </article>)}
              </div> : <p>该节点暂无历史记录。</p>}
            </details> : null}
          </Surface> : null}
          {item.status === "pending_ie_quote" && selectedNode === "ie_quote" ? <Surface className="rework-detail-node-preview">
            <h2>02 · IE 给价</h2>
            <p>逐款核定加工单价；每行金额独立四舍五入到分后汇总。</p>
            {canQuote ? <div className="sourcing-form-grid">
              <div className="sourcing-line-price-table sourcing-form-wide" role="table" aria-label="IE逐款价格">
                {item.lineItems.map((line) => {
                  const price = quote.linePrices.find((entry) => entry.position === line.position)?.unitPrice ?? "";
                  const control = priceInput("quote", line.position, price);
                  const errorId = `sourcing-quote-price-error-${line.position}`;
                  return <label className="sourcing-line-price-row" key={line.position}>
                    <span><b>{String(line.position).padStart(2, "0")}</b> {line.styleNo} · {line.color ?? "历史未维护颜色"} · {formatBusinessDecimal(line.quantity)} 件</span>
                    <span className="sourcing-price-control"><input aria-label={`${line.styleNo} IE单价`} {...control.props} aria-describedby={control.error ? errorId : undefined} />{control.error ? <small id={errorId} role="status">{control.error}</small> : null}</span>
                    <strong>{formatBusinessCurrency(isNewSourcingPrice(price) ? totalPreview(price, line.quantity) : "—")}</strong>
                  </label>;
                })}
              </div>
              <label><span>逐款汇总</span><input value={businessInputValue(linesTotalPreview(quote.linePrices, item.lineItems))} readOnly /></label>
              <label className="sourcing-form-wide"><span>价格说明</span><input value={quote.quoteReason} maxLength={500} onChange={(event) => { setQuote({ ...quote, quoteReason: event.target.value }); actionKey.current = null; }} /></label>
              <button className="dx-button dx-button--primary" type="button" disabled={busy || priceComposing("quote") || quote.linePrices.some((line) => !isNewSourcingPrice(line.unitPrice))} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/ie-quotes`, { linePrices: quote.linePrices, ...(quote.quoteReason.trim() ? { quoteReason: quote.quoteReason.trim() } : {}) }, "IE 逐款价格已提交")}>提交 IE 逐款价格</button>
            </div> : <p>当前账号仅可查看，本节点由 IE 办理。</p>}
          </Surface> : null}

          {item.status === "pending_management_decision" && selectedNode === "management" ? <Surface className="rework-detail-node-preview">
            <h2>03 · 生产管理调价与选厂</h2>
            <p>逐款确认 IE 价格并选择一个启用加工厂。</p>
            {canManage ? <div className="sourcing-form-grid">
              <label><span>加工厂</span><select value={decision.supplierId} onChange={(event) => { setDecision({ ...decision, supplierId: event.target.value }); actionKey.current = null; }}><option value="">请选择加工厂</option>{factories.map((factory) => <option key={factory.supplierId} value={factory.supplierId}>{factory.supplierName}</option>)}</select></label>
              {selectedFactory ? <div className="sourcing-factory-facts sourcing-form-wide"><strong>{selectedFactory.supplierName} · {selectedFactory.supplierCode}</strong><span>工艺：{selectedFactory.supportedCrafts.join("、") || "未维护"}</span><span>日产能：{selectedFactory.dailyCapacity ? `${formatBusinessDecimal(selectedFactory.dailyCapacity)} 件` : "未维护"}</span><span>{selectedFactory.notes || "暂无协同备注"}</span><em>{selectedFactory.contractDataMissing.length ? `合同缺项：${selectedFactory.contractDataMissing.map((field) => contractMissingLabels[field] ?? field).join("、")}` : "合同资料完整"}</em></div> : null}
              <div className="sourcing-line-price-table sourcing-form-wide" role="table" aria-label="生产管理逐款价格">
                {item.lineItems.map((line) => {
                  const price = decision.linePrices.find((entry) => entry.position === line.position)?.unitPrice ?? "";
                  const control = priceInput("decision", line.position, price);
                  const errorId = `sourcing-decision-price-error-${line.position}`;
                  const iePrice = item.ieQuote?.linePrices.find((entry) => entry.position === line.position)?.unitPrice;
                  return <label className="sourcing-line-price-row" key={line.position}><span><b>{String(line.position).padStart(2, "0")}</b> {line.styleNo} · {line.color ?? "历史未维护颜色"}<small>IE {iePrice ? formatBusinessCurrency(iePrice) : "—"}</small></span><span className="sourcing-price-control"><input aria-label={`${line.styleNo} 生产单价`} {...control.props} aria-describedby={control.error ? errorId : undefined} />{control.error ? <small id={errorId} role="status">{control.error}</small> : null}</span><strong>{formatBusinessCurrency(isNewSourcingPrice(price) ? totalPreview(price, line.quantity) : "—")}</strong></label>;
                })}
              </div>
              <label><span>逐款汇总</span><input value={businessInputValue(linesTotalPreview(decision.linePrices, item.lineItems))} readOnly /></label>
          <section className="sourcing-process-editor sourcing-form-wide" aria-label="工艺及承包范围">
            <div className="sourcing-process-editor__heading">
              <div><strong>工艺及承包范围（必填）</strong><small>按合同乙方负责的内容顺序登记，可搜索或输入新内容；确认后进入合同第二条，包含用线、包装、装箱和运费责任。</small></div>
              <button type="button" disabled={processes.length >= MAX_SOURCING_PROCESSES} onClick={addProcess}>＋ 新增工艺</button>
            </div>
            <div className="sourcing-process-editor__list">
              {processes.map((process, index) => <div className="sourcing-process-row" key={index}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                <label><span className="visually-hidden">第 {index + 1} 项工艺</span><input list="sourcing-craft-options" value={process} maxLength={100} onChange={(event) => updateProcess(index, event.target.value)} placeholder="例如：车缝+线+包装，回厂装箱+一程运费" /></label>
                <button type="button" aria-label={`删除第 ${index + 1} 项工艺`} disabled={processes.length === 1} onClick={() => removeProcess(index)}>删除</button>
              </div>)}
            </div>
            <datalist id="sourcing-craft-options">
              {craftCatalog.map((craft) => <option key={craft.craftId} value={craft.craftName}>{craft.craftCode}</option>)}
            </datalist>
          </section>
              <label><span>裁床工序</span><select value={decision.cuttingProcess} onChange={(event) => { setDecision({ ...decision, cuttingProcess: event.target.value as DecisionDraft["cuttingProcess"], cuttingProcessOther: "" }); actionKey.current = null; }}><option value="">请选择</option><option value="in_house">本厂裁</option><option value="outsourced">外厂裁</option><option value="other">其它</option></select></label>
              {decision.cuttingProcess === "other" ? <label><span>其它裁床工序（必填）</span><input value={decision.cuttingProcessOther} maxLength={100} onChange={(event) => { setDecision({ ...decision, cuttingProcessOther: event.target.value }); actionKey.current = null; }} /></label> : null}
              <label className="sourcing-form-wide"><span>选厂/调价说明{needsDecisionReason ? "（必填）" : ""}</span><input value={decision.decisionReason} maxLength={500} required={needsDecisionReason} aria-invalid={missingDecisionReason} aria-describedby={missingDecisionReason ? "sourcing-decision-reason-hint" : undefined} onChange={(event) => { setDecision({ ...decision, decisionReason: event.target.value }); actionKey.current = null; }} />{missingDecisionReason ? <small id="sourcing-decision-reason-hint" role="status">价格高于 IE，请填写原因</small> : null}</label>
              <button className="dx-button dx-button--primary" type="button" disabled={busy || priceComposing("decision") || !decision.supplierId || missingDecisionReason || decision.linePrices.some((line) => !isNewSourcingPrice(line.unitPrice))} onClick={() => void submitManagement()}>提交调价与选厂</button>
            </div> : <p>当前账号仅可查看，本节点由生产管理办理。</p>}
          </Surface> : null}

          {item.status === "pending_owner_approval" && selectedNode === "owner" ? <Surface className="rework-detail-node-preview sourcing-owner-decision">
            <div className="sourcing-owner-mobile-summary">
              <h2>04 · 最终审批</h2>
              <p>{item.decision?.supplierName ?? "—"} · {formatBusinessDecimal(item.orderQuantity)} 件 · {item.decision ? formatBusinessCurrency(item.decision.totalAmount) : "—"}</p>
            </div>
            <div className="sourcing-owner-decision__desktop">
              <h2>04 · 最终审批</h2>
              <p className="sourcing-owner-decision__lead">生产管理建议由 <strong>{item.decision?.supplierName ?? "—"}</strong> 承接 <strong>{formatBusinessDecimal(item.orderQuantity)} 件</strong>，逐款汇总 <strong>{item.decision ? formatBusinessCurrency(item.decision.totalAmount) : "—"}</strong>，相对 IE 总额变化 <strong>{ownerTotalDelta ?? "—"}</strong>。{ownerCraftSummary}</p>
              <div className="sourcing-owner-line-review" role="table" aria-label="老板逐款审批摘要">
                {item.lineItems.map((line) => {
                  const ieLine = item.ieQuote?.linePrices.find((entry) => entry.position === line.position);
                  const decisionLine = item.decision?.linePrices.find((entry) => entry.position === line.position);
                  return <div className="sourcing-owner-line-review__row" key={line.position}><b>{String(line.position).padStart(2, "0")}</b><span>{line.styleNo}<small>{line.color ?? "历史未维护颜色"} · {formatBusinessDecimal(line.quantity)} 件</small></span><span>IE <strong>{ieLine ? formatBusinessCurrency(ieLine.unitPrice) : "—"}</strong></span><span>生产 <strong>{decisionLine ? formatBusinessCurrency(decisionLine.unitPrice) : "—"}</strong></span><span>行金额 <strong>{decisionLine ? formatBusinessCurrency(decisionLine.totalAmount) : "—"}</strong></span></div>;
                })}
              </div>
              <p>{"daxingUnitPrice" in item ? `预算价：${formatBusinessCurrency(item.daxingUnitPrice ?? "")}。` : ""}{item.decision?.decisionReason ? `生产管理说明：${item.decision.decisionReason}` : "生产管理未补充说明。"}</p>
              <details className="sourcing-owner-decision__details">
                <summary>查看完整订单资料</summary>
                <p>性别：{item.gender ?? "历史未维护"}；款式：{item.styleName ?? "历史未维护"}；款色：{item.lineItems.length} 行；预计裁片发出：{item.estimatedCutPieceSendDate ?? "历史未维护"}；要求交货：{item.deliveryDate ?? "—"}。</p>
              </details>
            </div>
            {canOwner ? <div className="sourcing-owner-actions" aria-label="老板审批操作">
              <div><button className="dx-button dx-button--primary" type="button" disabled={busy} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/owner-decisions`, { decision: "approved" }, "老板已批准")}>批准方案</button><button className="dx-button dx-button--secondary sourcing-owner-reject" type="button" disabled={busy} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/owner-decisions`, { decision: "rejected" }, "已驳回生产管理重新调整")}>驳回并退回生产管理</button></div>
            </div> : <p>当前账号仅可查看，本节点由老板办理。</p>}
          </Surface> : null}

          {item.approvalSnapshot ? <Surface className="rework-detail-node-preview sourcing-contract-bar">
            <div className="sourcing-contract-bar__heading">
              <div><h2>系统合同</h2><p>合同仅使用老板批准快照；主档后续修改不会追改本版本。</p></div>
              {contract ? <StatusBadge tone={contract.status === "ready" ? "success" : contract.status === "generation_failed" ? "danger" : "info"}>{contract.status === "ready" ? "PDF 已生成" : contract.status === "pending_supplement" ? "待补资料" : contract.status === "generation_failed" ? "生成失败" : "生成中"}</StatusBadge> : null}
            </div>
            {contract ? <>
              <dl className="sourcing-finance-reference" aria-label="系统合同版本">
                <div><dt>合同编号</dt><dd>{contract.contractNumber}</dd></div>
                <div><dt>合同版本</dt><dd>V{contract.contractVersion} · 模板 V{contract.templateVersion}</dd></div>
              </dl>
              {contract.status === "ready" && contract.pdfAttachmentId && canReadContractData ? <div className="sourcing-contract-bar__actions"><a className="dx-button dx-button--primary" href={attachmentUrl(contract.pdfAttachmentId, "preview")} target="_blank" rel="noreferrer">预览合同 PDF</a><a className="dx-button dx-button--secondary" href={attachmentUrl(contract.pdfAttachmentId, "download")} target="_blank" rel="noreferrer">下载合同</a>{canEditStyles ? <button className="dx-button dx-button--secondary" type="button" disabled={busy} onClick={() => {
          setStyleEdits(item.lineItems.map(line => ({position:line.position,styleNo:(line.formalStyleNo === undefined ? line.styleNo : line.formalStyleNo) ?? "",alternateStyleNo:line.alternateStyleNo ?? ""})));
          setStyleEditRevision(item.identityRevision ?? 0);styleEditKey.current=null;setEditingStyles(true);
        }}>修改款号</button> : null}</div> : null}
              {editingStyles && canEditStyles ? <form className="sourcing-style-editor" onSubmit={event=>{event.preventDefault();void saveStyles();}}>
                {styleDuplicateMessage ? <p role="alert">{styleDuplicateMessage}</p> : null}
        {styleEdits.map((line,index)=><div className="sourcing-style-editor__row" key={line.position}>
          <strong>{item.lineItems[index]?.color ?? "款色"} · {formatBusinessDecimal(item.lineItems[index]?.quantity ?? 0)} 件</strong>
          <label><span>正式款号</span><input maxLength={100} value={line.styleNo} onChange={event=>{setStyleEdits(current=>current.map(row=>row.position===line.position?{...row,styleNo:event.target.value}:row));styleEditKey.current=null;}} /></label>
          <label><span>代用款号</span><input maxLength={100} value={line.alternateStyleNo} onChange={event=>{setStyleEdits(current=>current.map(row=>row.position===line.position?{...row,alternateStyleNo:event.target.value}:row));styleEditKey.current=null;}} /></label>
        </div>)}
        <div className="sourcing-style-editor__actions"><button className="dx-button" disabled={busy || !!styleDuplicateMessage} type="submit">保存款号</button><button className="dx-button dx-button--secondary" disabled={busy} type="button" onClick={()=>setEditingStyles(false)}>取消</button></div>
      </form> : null}
              <div className="sourcing-contract-bar__actions" aria-label="正式派单">
                {dispatchState.item ? <StatusBadge tone="success">{dispatchState.item.status === "shipped" ? "已发货" : dispatchState.item.status === "production_completed" ? "生产完成" : "已派单 · 生产中"}</StatusBadge>
                  : (moduleWritable && dispatchState.canDispatch) ? <button className="dx-button dx-button--primary" type="button" disabled={busy} onClick={() => void dispatchOrder()}>正式派单</button>
                    : <span>{contract.status === "ready" ? "待本订单跟单派单" : "合同生成后可派单"}</span>}
              </div>
              {contract.status === "pending_supplement" ? <div className="sourcing-form-grid">
                <p className="sourcing-form-wide">缺少：{contract.missingFields.map((field) => contractMissingLabels[field] ?? field).join("、")}。补充值只进入本合同快照，不回写供应商主档。</p>
                {(moduleWritable && contract.canSupplement) ? contract.missingFields.map((field) => <label key={field}><span>{contractMissingLabels[field] ?? field}</span><input value={contractSupplement[field] ?? ""} maxLength={300} onChange={(event) => { setContractSupplement({ ...contractSupplement, [field]: event.target.value }); actionKey.current = null; }} /></label>) : null}
                {(moduleWritable && contract.canSupplement) ? <button className="dx-button dx-button--primary" type="button" disabled={busy || contract.missingFields.some((field) => !(contractSupplement[field] ?? "").trim())} onClick={() => void submitContract(`sourcing/cases/${item.sourcingCaseId}/contract/supplements`, Object.fromEntries(contract.missingFields.map((field) => [field, contractSupplement[field]?.trim()])), "合同资料已补齐并生成 PDF")}>保存本合同补充资料</button> : <p>仅本订单跟单或 Root 可补充缺项。</p>}
              </div> : null}
              {canReadContractData && timeline.some(entry=>entry.kind==="contract" && entry.pdfAttachmentId && entry.entryId!==contract.sourcingContractDocumentId) ? <details><summary>历史合同</summary>{timeline.filter(entry=>entry.kind==="contract" && entry.pdfAttachmentId && entry.entryId!==contract.sourcingContractDocumentId).map(entry=><p key={entry.entryId}><a href={attachmentUrl(entry.pdfAttachmentId!,"download")} target="_blank" rel="noreferrer">V{entry.version} · {entry.contractReference}</a></p>)}</details> : null}
              {contract.status === "generation_failed" && (moduleWritable && contract.canSupplement) ? <div className="sourcing-contract-bar__actions"><span>{contract.failureReason ?? "合同生成失败"}</span><button className="dx-button dx-button--secondary" type="button" disabled={busy} onClick={() => void submitContract(`sourcing/cases/${item.sourcingCaseId}/contract/generate`, {}, "合同 PDF 已重新生成")}>重试生成</button></div> : null}
            </> : <p>批准事实正在准备合同，请刷新后查看。</p>}
          </Surface> : null}

          {item.status === "pending_finance_reconciliation" && selectedNode === "finance" ? <Surface className="rework-detail-node-preview">
            <h2>05 · 财务核对</h2>
            <p>财务在付款、对账时核对系统信息；核对不影响跟单派单和生产。加工厂、单价、数量及总额只读。</p>
            {item.decision ? <dl className="sourcing-finance-reference" aria-label="老板批准的选厂决定">
              <div><dt>批准加工厂</dt><dd>{item.decision.supplierName}</dd></div>
              <div><dt>批准单价</dt><dd>{sourcingPriceSummary(item.decision)}</dd></div>
              <div><dt>批准数量</dt><dd>{formatBusinessDecimal(item.decision.quantity)} 件</dd></div>
              <div><dt>批准总额</dt><dd>{formatBusinessCurrency(item.decision.totalAmount)}</dd></div>
              <div><dt>对应合同</dt><dd>{contract?.status === "ready" ? `${contract.contractNumber} · V${contract.contractVersion}` : "合同 PDF 尚未就绪"}</dd></div>
            </dl> : null}
            {item.decision && item.decision.sourceType !== "factory_change" && item.decision.linePrices.length > 1 ? <div className="sourcing-owner-line-review" aria-label="财务逐款核对明细">
              {item.decision.linePrices.map((price) => {
                const line = item.lineItems.find((entry) => entry.position === price.position);
                return <div className="sourcing-owner-line-review__row" key={price.position}><b>{String(price.position).padStart(2, "0")}</b><span>{line?.styleNo ?? "历史款号缺失"}<small>{line?.color ?? "历史颜色缺失"} · {formatBusinessDecimal(price.quantity)} 件</small></span><span>批准价 <strong>{historicalSourcingPrice(price.unitPrice)}</strong></span><span>批准行金额 <strong>{formatBusinessCurrency(price.totalAmount)}</strong></span></div>;
              })}
            </div> : null}
            {hasPendingFactoryChange ? <p className="sourcing-finance-waiting">订单转厂正在审批，财务核对已暂停；转厂生效或驳回后会自动恢复。</p> : contract?.status !== "ready" ? <p className="sourcing-finance-waiting">系统合同 PDF 未就绪，暂不能提交财务核对。</p> : canFinance ? <div className="sourcing-finance-confirmation">
              <p>请对照已批准的选厂决定确认上述四项事实。若发现不一致，只记录差异项和说明，由生产管理核实；财务不能在此页改写业务数据。</p>
              <button className="dx-button dx-button--primary" type="button" disabled={busy} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/finance-reconciliations`, { result: "match" }, "与合同一致，订单已归档")}>确认与合同一致</button>
              <details>
                <summary>发现不一致</summary>
                <fieldset><legend>差异项目</legend>{([
                  ["supplier", "加工厂"], ["unit_price", "单价"], ["quantity", "数量"], ["total_amount", "总额"],
                ] as const).map(([value, label]) => <label key={value}><input type="checkbox" checked={financeReview.differenceFields.includes(value)} onChange={(event) => {
                  setFinanceReview((current) => ({ ...current, differenceFields: event.target.checked ? [...current.differenceFields, value] : current.differenceFields.filter((field) => field !== value) })); actionKey.current = null;
                }} />{label}</label>)}</fieldset>
                <label><span>差异说明</span><input value={financeReview.differenceReason} maxLength={500} onChange={(event) => { setFinanceReview({ ...financeReview, differenceReason: event.target.value }); actionKey.current = null; }} /></label>
                <button className="dx-button dx-button--secondary" type="button" disabled={busy || !financeReview.differenceFields.length || !financeReview.differenceReason.trim()} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/finance-reconciliations`, { result: "difference", differenceFields: financeReview.differenceFields, differenceReason: financeReview.differenceReason.trim() }, "财务差异已提交生产管理核实")}>提交差异核实</button>
              </details>
            </div> : <p>当前账号仅可查看，本节点由财务核对。</p>}
          </Surface> : null}

                    {item.status === "pending_exception_verification" && selectedNode === "finance" ? <Surface className="rework-detail-node-preview">
            <h2>05 · 财务差异核实</h2>
            <p>财务发现：{latestFinance?.differenceFields.map((field) => ({ supplier: "供应商", unit_price: "单价", quantity: "数量", total_amount: "总额" })[field]).join("、") || "差异项待确认"}。记录和证据已保留，老板已收到信息通知。</p>
            {canVerifyException ? <div className="sourcing-owner-actions">
              <label><span>处理说明</span><input value={exceptionReason} maxLength={500} onChange={(event) => { setExceptionReason(event.target.value); actionKey.current = null; }} /></label>
              <div><button className="dx-button dx-button--primary" type="button" disabled={busy || !exceptionReason.trim()} onClick={() => void submit(
                `sourcing/cases/${item.sourcingCaseId}/exception-decisions`,
                { resolution: "close", resolutionReason: exceptionReason.trim() },
                "差异已确认并归档",
              )}>确认差异并闭环</button><button className="dx-button dx-button--secondary" type="button" disabled={busy || !exceptionReason.trim()} onClick={() => void submit(
                `sourcing/cases/${item.sourcingCaseId}/exception-decisions`,
                { resolution: "reconcile_again", resolutionReason: exceptionReason.trim() },
                "已退回财务重新核对",
              )}>退回财务重核</button></div>
            </div> : <p>当前账号仅可查看，本节点由生产管理核实。</p>}
          </Surface> : null}
          {transferNodeRole ? <Surface className="rework-detail-node-preview sourcing-factory-change">
            <div className="sourcing-factory-change__heading">
              <div><h2>订单转厂</h2><p>以当前生效的选厂版本为对照，不占用主流程节点。</p></div>
              {!item.decision ? <button className="dx-button dx-button--secondary" type="button" disabled>订单转厂</button> : null}
            </div>
            {!item.decision ? <p>生产管理首次提交加工厂和单价后开放。</p> : factoryChange?.status === "pending_management" ? <>
              <p><strong>{factoryChange.proposedSupplierName}</strong> · {formatBusinessCurrency(factoryChange.proposedUnitPrice)}/件 · {formatBusinessCurrency(factoryChange.proposedTotalAmount)}。跟单申请，等待生产管理审批。</p>
              {selectedNode === "management" && canReviewManagementTransfer ? <div className="sourcing-factory-change__review">
                <label><span>审批说明</span><input maxLength={500} value={factoryChangeReviewReason} onChange={(event) => { setFactoryChangeReviewReason(event.target.value); actionKey.current = null; }} /></label>
                <div><button className="dx-button dx-button--primary" type="button" disabled={busy || !factoryChangeReviewReason.trim()} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/factory-changes/${factoryChange.factoryChangeRequestId}/decision`, { decision: "approved", verificationReason: factoryChangeReviewReason.trim() }, factoryChange.requiresOwnerApproval ? "生产管理已通过，转老板审批" : "转厂已生效", true)}>批准转厂</button><button className="dx-button dx-button--secondary" type="button" disabled={busy || !factoryChangeReviewReason.trim()} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/factory-changes/${factoryChange.factoryChangeRequestId}/decision`, { decision: "rejected", verificationReason: factoryChangeReviewReason.trim() }, "转厂申请已驳回", true)}>驳回</button></div>
              </div> : null}
            </> : factoryChange?.status === "pending_owner" ? <>
              <p><strong>{factoryChange.proposedSupplierName}</strong> · {formatBusinessCurrency(factoryChange.proposedUnitPrice)}/件，超过当前单价，等待老板批准。</p>
              {selectedNode === "owner" && canOwner ? <div className="sourcing-factory-change__review">
                <label><span>审批说明</span><input maxLength={500} value={factoryChangeReviewReason} onChange={(event) => { setFactoryChangeReviewReason(event.target.value); actionKey.current = null; }} /></label>
                <div><button className="dx-button dx-button--primary" type="button" disabled={busy || !factoryChangeReviewReason.trim()} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/factory-changes/${factoryChange.factoryChangeRequestId}/owner-decision`, { decision: "approved", verificationReason: factoryChangeReviewReason.trim() }, "老板已批准，转厂生效", true)}>批准转厂</button><button className="dx-button dx-button--secondary" type="button" disabled={busy || !factoryChangeReviewReason.trim()} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/factory-changes/${factoryChange.factoryChangeRequestId}/owner-decision`, { decision: "rejected", verificationReason: factoryChangeReviewReason.trim() }, "老板已驳回转厂", true)}>驳回</button></div>
              </div> : null}
            </> : canInitiateTransfer ? <details>
              <summary>订单转厂</summary>
              <p>当前：{item.decision.supplierName} · {formatBusinessCurrency(item.decision.unitPrice)}/件。新单价不高于当前价时按角色规则直接生效；超过时交老板批准。</p>
              <div className="sourcing-form-grid">
                <label><span>新加工厂</span><select value={factoryChangeDraft.supplierId} onChange={(event) => { setFactoryChangeDraft({ ...factoryChangeDraft, supplierId: event.target.value }); actionKey.current = null; }}><option value="">请选择不同的加工厂</option>{factories.filter((factory) => factory.supplierId !== item.decision?.supplierId).map((factory) => <option value={factory.supplierId} key={factory.supplierId}>{factory.supplierName}</option>)}</select></label>
                <label><span>新加工单价</span><input inputMode="decimal" value={activeBusinessInput === "factory-change-unit-price" && factoryChangeUnitPriceEdited ? factoryChangeDraft.unitPrice : businessInputValue(factoryChangeDraft.unitPrice)} onFocus={() => setActiveBusinessInput("factory-change-unit-price")} onBlur={() => setActiveBusinessInput(null)} onChange={(event) => { setFactoryChangeUnitPriceEdited(true); setFactoryChangeDraft({ ...factoryChangeDraft, unitPrice: businessInputChange(event.target.value) }); actionKey.current = null; }} /></label>
                <label><span>新总额</span><input readOnly value={businessInputValue(totalPreview(factoryChangeDraft.unitPrice, item.orderQuantity))} /></label>
                <p className="sourcing-factory-change__delta">相对当前单价：<strong>{transferPriceDelta ?? "—"}</strong></p>
                <label className="sourcing-form-wide"><span>转厂原因</span><input maxLength={500} value={factoryChangeDraft.changeReason} onChange={(event) => { setFactoryChangeDraft({ ...factoryChangeDraft, changeReason: event.target.value }); actionKey.current = null; }} /></label>
                <button className="dx-button dx-button--primary" type="button" disabled={busy || !factoryChangeDraft.supplierId || !factoryChangeDraft.unitPrice || !factoryChangeDraft.changeReason.trim()} onClick={() => void submit(transferRequestPath, { supplierId: factoryChangeDraft.supplierId, unitPrice: factoryChangeDraft.unitPrice, changeReason: factoryChangeDraft.changeReason.trim() }, transferNodeRole === "owner_group" ? "老板发起的转厂已直接生效" : transferNodeRole === "production_management" && (transferPriceDelta?.startsWith("+") !== true) ? "转厂已生效" : "转厂申请已提交", true)}>提交转厂</button>
              </div>
            </details> : <p>当前账号可查看转厂记录，但不能在本节点发起。</p>}
          </Surface> : null}
          {message ? <p className="sourcing-action-message" role="status">{message}</p> : null}
        </section>
      </div>

      {selectedImage ? <div className="rework-image-modal" role="presentation" onMouseDown={() => setSelectedImage(null)}>
        <section className="rework-image-modal__content" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
          <div className="rework-image-modal__heading"><strong>{selectedImage.filename}</strong><button type="button" onClick={() => setSelectedImage(null)}>关闭</button></div>
          <ImageViewer src={attachmentUrl(selectedImage.attachmentId, "preview")} alt={selectedImage.filename} />
          <div className="rework-image-modal__actions">
            <button type="button" disabled={attachments[0]?.attachmentId === selectedImage.attachmentId} onClick={() => setSelectedImage(attachments[Math.max(0, attachments.findIndex(image => image.attachmentId === selectedImage.attachmentId) - 1)] ?? selectedImage)}>上一张</button>
            <span>{attachments.findIndex(image => image.attachmentId === selectedImage.attachmentId) + 1} / {attachments.length}</span>
            <button type="button" disabled={attachments.at(-1)?.attachmentId === selectedImage.attachmentId} onClick={() => setSelectedImage(attachments[Math.min(attachments.length - 1, attachments.findIndex(image => image.attachmentId === selectedImage.attachmentId) + 1)] ?? selectedImage)}>下一张</button>
            <a href={attachmentUrl(selectedImage.attachmentId, "download")} target="_blank" rel="noreferrer">下载原图</a>
          </div>
        </section>
      </div> : null}
    </div>
  );
}
