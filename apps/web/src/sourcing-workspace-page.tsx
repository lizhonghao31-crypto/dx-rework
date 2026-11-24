import { SourcingContractReturnFiles } from "./sourcing-contract-return-files.js";
import { SourcingPriceReapplicationPanel } from "./sourcing-price-reapplication.js";
import { SearchableSelect } from "./search-select.js";
import { CONTRACT_RETURN_MAX_BYTES, CONTRACT_RETURN_MAX_FILES, confirmedContractReturnVersionFiles, confirmContractReturnSubmission, contractReturnSelectionError, finishContractReturnUpload, formatContractReturnSize, isContractReturnVersionConflict, type ContractReturnUpload } from "./sourcing-contract-return-upload.js";
import { sourcingCurrentDisplay } from "./sourcing-current-display.js";
import { SourcingReturnDialog } from "./sourcing-return-dialog.js";
import { isMerchandiserOnly } from "./sourcing-role-visibility.js";
import { sourcingContractReturnBadgeLabel, sourcingContractReturnLabel } from "./sourcing-contract-return-presentation.js";
import { ContractInformationRefresh } from "./contract-information-refresh.js";
import { sourcingDatesValid, SOURCING_DATE_ORDER_ERROR, canChangeSourcingTransferDeliveryDate } from "@dx-rework/contracts";
import { moduleCanWrite } from "./member-module-policy.js";
import { todoReturnPath } from "./todo-query-state.js";
import {WorkAnalysisPanel} from "./work-analysis-panel.js";
import { isNewSourcingPrice, newSourcingPriceDisplay, historicalSourcingPrice, sourcingPriceSummary, sourcingLinePricing, sourcingDeleteConfirmation, sourcingDecisionNeedsReason } from "./sourcing-price-presentation.js";
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
  SourcingMerchandiserOptionsSchema,
  SourcingContractStateResponseSchema,
  SourcingContractReturnResponseSchema,
  SourcingDispatchStateSchema,
  SourcingProductionOrderSchema,
  type SourcingDispatchState,
  SourcingFactoryListResponseSchema,
  SourcingFactoryChangeStateResponseSchema,
  SourcingPriceReapplicationStateSchema,
  SourcingTimelineResponseSchema,
  UploadIntentResponseSchema,
  duplicateSourcingLineMessage,
  findDuplicateSourcingLine,
  sourcingStyleNumbers,
  type SourcingStyleIdentity,
  calculateSourcingTotalExact,
  type CraftCatalogItem,
  type SourcingAttachment,
  type SourcingCaseStatus,
  type SourcingCaseSummary,
  type SourcingContractDocument,
  type SourcingContractReturnResponse,
  type SourcingContractMissingField,
  type SourcingFactory,
  type SourcingFactoryChangeState,
  type SourcingTimelineEntry,
} from "@dx-rework/contracts";
import { formatBusinessCurrency, formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { DecisionSummary, ActionBar, ImageStrip, KeyFacts, ResponsiveFactsTable, WorkflowRail, StatusBadge, Surface } from "@dx-rework/ui";
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
  type SourcingContractReturnFilter,
  type SourcingListQuery,
  type SourcingStageFilter,
} from "./sourcing-list-query.js";
import { useDebouncedValue } from "./use-debounced-value.js";
import { SourcingImageSupplementUploader } from "./sourcing-image-supplement-uploader.js";
import { SourcingNodeHistoryPage } from "./sourcing-node-history-page.js";
import { SourcingFinanceDifferenceDialog } from "./sourcing-finance-difference-dialog.js";
import { SourcingBudgetPriceCorrectionDialog } from "./sourcing-budget-price-correction-dialog.js";
import { alertInApp, confirmInApp } from "./system-dialog.js";
import { SubmissionFeedback, useSubmissionFeedback } from "./submission-feedback.js";
import { SubmissionCancelled, SubmissionRequestError } from "./submission-validation.js";
import { sourcingCreateDuplicateIssue, validateSourcingCreate, validateSourcingDecision, validateSourcingPrices } from "./sourcing-submit-validation.js";
import "./rework-detail.css";
import "./rework-detail-compact.css";
import "./sourcing-workspace.css";
import "./order-overview-responsive.css";
import "./sourcing-governed.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

const STATUS_LABELS: Readonly<Record<SourcingCaseStatus, string>> = {
  pending_merchandiser_correction: "待跟单修改",
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
  additionalMerchandiserUserId: string;
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
type FactoryChangeDraft = Readonly<{ supplierId: string; unitPrice: string; changeReason: string; craftNames?: readonly string[] | undefined; deliveryDate?: string | undefined }>;
type ContractSupplementDraft = Readonly<Partial<Record<SourcingContractMissingField, string>>>;

class SourcingRequestError extends SubmissionRequestError {
  constructor(message: string, code?: string, status = 400, readonly requestId?: string) {
    super(message, code, status);
  }
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
    const body = await response.json().catch(() => null) as { error?: { message?: string; code?: string; requestId?: string } } | null;
    const requestId = body?.error?.requestId;
    throw new SourcingRequestError(body?.error?.message ?? "操作失败，请稍后重试", body?.error?.code, response.status,
      typeof requestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? requestId : undefined);
  }
  return schema.parse(await response.json());
};

const requestSubmission = async <T,>(path: string, schema: ApiSchema<T>, init: RequestInit): Promise<T> => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try { return await request(path, schema, { ...init, signal: controller.signal }); }
  finally { window.clearTimeout(timeout); }
};

const requestWithStyleCheck = async <T,>(path: string, schema: ApiSchema<T>, init: RequestInit, lines: readonly SourcingStyleIdentity[], submission = false): Promise<T> => {
  const send = submission ? requestSubmission : request;
  const duplicate = duplicateSourcingLineMessage(lines);
  if (duplicate) throw new Error(duplicate);
  try {
    return await send(path,schema,init);
  } catch (error) {
    if (!(error instanceof SourcingRequestError) || error.code !== "STYLE_NUMBER_EXISTS") throw error;
    const confirmed = await confirmInApp(`${error.message}\n仅确认属于追加或分批外发时继续提交。`,{
      title:"发现重复款号",confirmLabel:"已核对，继续提交",cancelLabel:"返回修改",
    });
    if (!confirmed) throw new SubmissionCancelled("已取消提交，请核对款号");
    return send(path,schema,{...init,body:JSON.stringify({
      ...JSON.parse(String(init.body)),confirmedDuplicateStyles:sourcingStyleNumbers(lines),
    })});
  }
};

const canAct = (user: AuthorizedUser | null, role: string, capability: string): boolean =>
  user?.isRoot === true
  || (moduleCanWrite(user, "sourcing") && user?.businessRoles?.includes(role) === true && (user.effectiveWriteCapabilities ?? user.capabilities).includes(capability));

const isJiashunContractClerk=(user:AuthorizedUser|null):boolean=>user?.isRoot!==true
  && user?.businessRoles?.length===1 && user?.businessRoles?.[0]==="jiashun_contract_clerk"
  && user?.capabilities.includes("sourcing:jiashun:read")===true;

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
      additionalMerchandiserUserId: typeof parsed.additionalMerchandiserUserId === "string" ? parsed.additionalMerchandiserUserId : "",
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
  returnTo?: string,
): string => {
  const target = pageUrl(`ui/sourcing/orders/${item.sourcingCaseId}`);
  if (!returnTo) return target;
  return withSourcingReturn(
    target,
    returnTo.startsWith("/ui/sourcing/history") ? "history" : "pending",
    readSourcingListQuery(returnTo.slice(returnTo.indexOf("?") + 1)),
  );
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
  const contractBadge = item.contractReturnMonitoring ? sourcingContractReturnBadgeLabel(item) : null;
  return <Surface className="sourcing-order-card sourcing-order-card--overview">
    <a className="sourcing-order-card__main" href={detailHref(item, returnTo)}>
      <div className="sourcing-order-card__identity">
        <span className="sourcing-order-card__photo">
          {item.firstImageAttachmentId ? <img src={attachmentUrl(item.firstImageAttachmentId, "preview")} alt="订单首张图片" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} /> : <span>暂无图片</span>}
        </span>
        <div className="sourcing-order-card__identity-text">
          <div className="sourcing-order-card__heading">
            <div>
              <span className="sourcing-order-card__title-line">
                <strong title={item.lineItems[0]?.styleNo ?? item.styleNo}>{item.lineItems[0]?.styleNo ?? item.styleNo}</strong>
                {item.lineItems.length > 1 ? <span className="sourcing-order-card__line-count">共 {item.lineItems.length} 款色</span> : null}
              </span>
              <small>{item.gender ?? "历史未维护"} · {item.styleName ?? "历史未维护"}</small>
            </div>
          </div>
          <ul className="sourcing-order-card__lines" aria-label="款色明细">
            {item.lineItems.slice(0, 1).map((line) => <li key={line.position}>
              {line.styleNo}{line.alternateStyleNo && line.alternateStyleNo !== line.styleNo ? ` / ${line.alternateStyleNo}` : ""} · {line.color ?? "历史未维护颜色"} · {formatBusinessDecimal(line.quantity)} 件
            </li>)}
            {item.lineItems.length > 1 ? <li>另有 {item.lineItems.length - 1} 个颜色</li> : null}
          </ul>
          <p className="sourcing-order-card__merchant">跟单：{item.merchandiserName ?? "历史未维护"}{contractBadge ? <> · 合同：<span
            className={`sourcing-return-badge sourcing-return-badge--${item.contractReturnStatus}`}
            title={sourcingContractReturnLabel({contractReturnStatus:item.contractReturnStatus ?? null,contractReturnOverdueHours:item.contractReturnOverdueHours ?? null})}
          >{contractBadge}</span></> : null}</p>
        </div>
      </div>
      <span className="sourcing-order-card__workflow-status"><StatusBadge tone={item.status === "closed" ? "success" : "info"}>
        {STATUS_LABELS[item.status]}
      </StatusBadge></span>
      <dl className="sourcing-list-facts">
        <div className="sourcing-list-facts__quantity">
          <div><dt>订单数量</dt><dd>{formatBusinessDecimal(item.orderQuantity)} 件</dd></div>
          {item.decision ? <><div><dt>生产单价</dt><dd>{sourcingPriceSummary(item.decision)}</dd></div><div><dt>加工厂</dt><dd>{item.decision.supplierName}</dd></div></>
            : item.ieQuote ? <div><dt>IE 单价</dt><dd>{sourcingPriceSummary(item.ieQuote)}</dd></div>
              : "daxingUnitPrice" in item ? <div><dt>预算价</dt><dd>{formatBusinessCurrency(item.daxingUnitPrice ?? "")}</dd></div> : null}
        </div>
        <div className="sourcing-list-facts__dates">
          <div><dt>预计裁片发出</dt><dd>{item.estimatedCutPieceSendDate ?? "历史未维护"}</dd></div>
          <div><dt>交货日期</dt><dd>{item.deliveryDate ?? "—"}</dd></div>
        </div>
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
      <div data-dx-ui="governed" className="sourcing-governed">
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
        ? (new URLSearchParams(window.location.search).get("view") === "node-history" && sourcingWorkflowNodeFromSearch()
          && !(sourcingWorkflowNodeFromSearch()==="finance" && isMerchandiserOnly(user?.businessRoles,user?.isRoot))
          ? <SourcingNodeHistoryPage sourcingCaseId={sourcingCaseId} node={sourcingWorkflowNodeFromSearch()!} returnTo={todoReturnPath(window.location.search) ?? sourcingReturnPath(window.location.search)} />
          : <OrderDetailPage sourcingCaseId={sourcingCaseId} user={user} />)
        : null}
      </div>
    </Shell>
  );
}

function CreateOrderPage({ user, correction }: { user: AuthorizedUser | null; correction?: {item:SourcingCaseSummary; attachments:readonly SourcingAttachment[]} }) {
  const [gender, setGender] = useState<"" | "男装" | "女装">(correction?.item.gender ?? "");
  const [styleName, setStyleName] = useState(correction?.item.styleName ?? "");
  const [additionalMerchandiserUserId, setAdditionalMerchandiserUserId] = useState("");
  const [merchandisers, setMerchandisers] = useState<readonly {userId:string;displayName:string}[]>([]);
  const [styleCatalog, setStyleCatalog] = useState<readonly { styleId: string; styleName: string }[]>([]);
  const [estimatedCutPieceSendDate, setEstimatedCutPieceSendDate] = useState(correction?.item.estimatedCutPieceSendDate ?? "");
  const [deliveryDate, setDeliveryDate] = useState(correction?.item.deliveryDate ?? "");
  const [lineItems, setLineItems] = useState<SourcingLineDraft[]>(correction ? correction.item.lineItems.map(line => ({
    styleNo:line.formalStyleNo ?? "", alternateStyleNo:line.alternateStyleNo ?? "",
    color:line.color ?? "", quantity:String(line.quantity), ...(line.imageAttachmentId ? {imageAttachmentId:line.imageAttachmentId} : {}),
  })) : [{
    styleNo: "",
    alternateStyleNo: "",
    color: "",
    quantity: "",
  }]);
  const [daxingUnitPrice, setDaxingUnitPrice] = useState(correction?.item.daxingUnitPrice ?? "");
  const [images, setImages] = useState<UploadedImage[]>(correction?.attachments.map(image => ({...image, previewUrl:attachmentUrl(image.attachmentId,"preview")})) ?? []);
  const [uploading, setUploading] = useState(false);
  const [uploadFailed, setUploadFailed] = useState(false);
  const [activeCreateInput, setActiveCreateInput] = useState<string | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const feedback = useSubmissionFeedback(setBusy);
  const [message, setMessage] = useState("");
  const createKey = useRef<string | null>(null);
  const previewUrls = useRef<string[]>([]);
  const restoredDraftUserId = useRef("");
  const canCreate = canAct(user, "order_merchandiser", "sourcing:inquiry:create");
  const duplicateLine = sourcingCreateDuplicateIssue(lineItems);

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
    if (correction || !canCreate) return;
    let mounted = true;
    void request("sourcing/merchandisers",SourcingMerchandiserOptionsSchema)
      .then(items => { if (mounted) setMerchandisers(items); })
      .catch(() => { if (mounted) setMessage("跟单列表加载失败，请刷新后重试。"); });
    return () => { mounted = false; };
  }, [canCreate,correction]);

  useEffect(() => {
    if (correction || !user?.id || restoredDraftUserId.current === user.id) return;
    restoredDraftUserId.current = user.id;
    const localDraft = readLocalSourcingDraft(user.id);
    if (!localDraft) return;
    setGender(localDraft.gender);
    setStyleName(localDraft.styleName);
    setAdditionalMerchandiserUserId(localDraft.additionalMerchandiserUserId);
    setEstimatedCutPieceSendDate(localDraft.estimatedCutPieceSendDate);
    setDeliveryDate(localDraft.deliveryDate);
    setLineItems([...localDraft.lineItems]);
    setDaxingUnitPrice(localDraft.daxingUnitPrice);
    setImages([...localDraft.images]);
    setMessage("已恢复当前账号在本机保存的订单草稿。");
  }, [user?.id, correction]);

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
      const failureMessage = error instanceof Error ? error.message : "订单图片上传失败";
      setMessage(failureMessage);
      setUploading(false);
      await feedback.reject([{ fieldId: "sourcing-create-photos", message: failureMessage }]);
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
      additionalMerchandiserUserId,
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
    if (busy || feedback.uncertain) return;
    if (!canCreate) { await alertInApp("当前账号没有创建订单权限", { title: "无权执行此操作" }); return; }
    const normalizedDaxingPrice = businessInputChange(daxingUnitPrice).trim();
    const issues = validateSourcingCreate({ gender, styleName, estimatedCutPieceSendDate, deliveryDate,
      lineItems, daxingUnitPrice: normalizedDaxingPrice, imageCount: images.length, uploading, uploadFailed });
    const effectiveIssues = correction ? issues.filter(issue=>issue.fieldId!=="sourcing-create-budget") : issues;
    if (correction && !correctionReason.trim()) effectiveIssues.push({fieldId:"sourcing-correction-reason",message:"请填写修改说明"});
    if (effectiveIssues.length) { await feedback.reject(effectiveIssues); return; }
    const normalizedLines = lineItems.map((line) => ({
      ...(line.styleNo.trim() ? { styleNo: line.styleNo.trim() } : {}),
      ...(line.alternateStyleNo.trim() ? { alternateStyleNo: line.alternateStyleNo.trim() } : {}),
      color: line.color.trim(), quantity: Number(line.quantity),
      ...(line.imageAttachmentId ? { imageAttachmentId: line.imageAttachmentId } : {}),
    }));
    const requestKey = createKey.current ?? createClientRequestId();
    createKey.current = requestKey;
    const body = JSON.stringify({ gender, styleName: styleName.trim(), estimatedCutPieceSendDate, deliveryDate,
      lineItems: normalizedLines, ...(correction ? {expectedVersion:correction.item.version,reason:correctionReason.trim()} : {daxingUnitPrice: normalizedDaxingPrice,
        ...(additionalMerchandiserUserId ? {additionalMerchandiserUserId} : {})}),
      attachmentIds: images.map(image => image.attachmentId) });
    await feedback.run(async () => {
      // Same snapshot and key on recovery: the existing API checks its idempotency record first.
      const created = await requestWithStyleCheck(correction ? `sourcing/cases/${correction.item.sourcingCaseId}/corrections` : "sourcing/cases", SourcingCaseSummarySchema, {
        method: "POST", headers: { "idempotency-key": requestKey }, body,
      }, normalizedLines, true);
      feedback.confirmed();
      // A local storage failure after a confirmed write must never invite another submission.
      try { if (!correction && user?.id) clearLocalSourcingDraft(user.id); } catch { /* Navigation still proceeds. */ }
      window.location.assign(detailHref(created));
    });
  };

  return (
    <div className="sourcing-workspace sourcing-workspace--create">
      <Header
        iconRoute="/ui/sourcing/create"
        title={correction ? "修改订单资料" : "创建订单"}
        badge="外发定价&选厂"
      />
      {correction ? <p role="status">退回原因：{correction.item.correctionReason}<a href={detailHref(correction.item)}>返回订单</a></p> : null}
      <SubmissionFeedback feedback={feedback} busy={busy} />
      <Surface className="sourcing-create-card">
        <fieldset className="sourcing-submission-fields" disabled={busy || feedback.uncertain}>
        <div className="section-title">
          <div><h2>订单资料</h2></div>
          <StatusBadge tone="info">跟单提交</StatusBadge>
        </div>
        <div className="sourcing-form-grid">
          <div className={`sourcing-order-classification${correction ? "" : " sourcing-order-classification--additional"}`}>
            <label><span>性别（必填）</span><select {...feedback.field("sourcing-create-gender")} required value={gender} onChange={(event) => { setGender(event.target.value as typeof gender); createKey.current = null; }}><option value="">请选择</option><option value="男装">男装</option><option value="女装">女装</option></select></label>
            <label><span>款式（必填）</span><input {...feedback.field("sourcing-create-style")} required list="sourcing-style-options" value={styleName} maxLength={100} onChange={(event) => { setStyleName(event.target.value); createKey.current = null; }} placeholder="搜索或输入，如梭织短裤" /></label>
            {!correction ? <label><span>添加跟单（选填）</span><SearchableSelect value={additionalMerchandiserUserId} onChange={event=>{setAdditionalMerchandiserUserId(event.target.value);createKey.current=null;}}><option value="">不添加</option>{additionalMerchandiserUserId && !merchandisers.some(person=>person.userId===additionalMerchandiserUserId) ? <option value={additionalMerchandiserUserId}>所选跟单已失效，请重选</option> : null}{merchandisers.map(person=><option key={person.userId} value={person.userId}>{person.displayName}</option>)}</SearchableSelect></label> : null}
            <datalist id="sourcing-style-options">{styleCatalog.map((style) => <option key={style.styleId} value={style.styleName} />)}</datalist>
          </div>
          <label><span>预计裁片发出日期（工厂发出，必填）</span><input type="date" required aria-required="true" value={estimatedCutPieceSendDate} {...feedback.field("sourcing-create-send-date")} onChange={(event) => { setEstimatedCutPieceSendDate(event.target.value); createKey.current = null; }} /></label>
          <label><span>要求交货日期（到工厂，必填）</span><input type="date" required aria-required="true" value={deliveryDate} {...feedback.field("sourcing-create-delivery-date")} onChange={(event) => { setDeliveryDate(event.target.value); createKey.current = null; }} /></label>
          <label><span>预算价（内部，必填）</span><input readOnly={!!correction} {...feedback.field("sourcing-create-budget")} value={activeCreateInput === "daxing" ? daxingUnitPrice : newSourcingPriceDisplay(daxingUnitPrice)} onFocus={() => setActiveCreateInput("daxing")} onBlur={() => setActiveCreateInput(null)} inputMode="decimal" onChange={(event) => { setDaxingUnitPrice(businessInputChange(event.target.value)); createKey.current = null; }} placeholder="请输入预算价" aria-invalid={!isNewSourcingPrice(daxingUnitPrice)} /></label>
          <section className="sourcing-line-editor sourcing-form-wide" aria-label="订单款色明细">
            <div className="sourcing-line-editor__heading">
              <div>
                <strong>款色明细</strong>
              </div>
              <div className="sourcing-line-editor__actions">
                <StatusBadge tone="info">合计 {formatBusinessDecimal(lineItems.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0))} 件</StatusBadge>
                <button className="dx-button dx-button--secondary" type="button" disabled={busy || uploading || lineItems.length >= MAX_SOURCING_LINE_ITEMS} onClick={addLineItem}>＋ 新增款色</button>
              </div>
            </div>
            <div className="sourcing-line-editor__list">
              {lineItems.map((line, index) => <article className="sourcing-line-row" key={index}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                <label><span>正式款号</span><input {...feedback.field(`sourcing-create-style-${index}`)}
                  {...(duplicateLine?.fieldId === `sourcing-create-style-${index}` ? { "aria-invalid": true, "aria-describedby": "sourcing-create-duplicate-style" } : {})}
                  value={line.styleNo} maxLength={100} onChange={(event) => updateLineItem(index, "styleNo", event.target.value)} placeholder="可后补" /></label>
                <label><span>代用款号</span><input value={line.alternateStyleNo} maxLength={100} onChange={(event) => updateLineItem(index, "alternateStyleNo", event.target.value)} placeholder="无正式款号时必填" /></label>
                <label><span>颜色</span><input {...feedback.field(`sourcing-create-color-${index}`)} value={line.color} maxLength={100} onChange={(event) => updateLineItem(index, "color", event.target.value)} placeholder="必填" /></label>
                <label><span>数量</span><input {...feedback.field(`sourcing-create-quantity-${index}`)} value={activeCreateInput === `quantity-${index}` ? line.quantity : businessInputValue(line.quantity)} onFocus={() => setActiveCreateInput(`quantity-${index}`)} onBlur={() => setActiveCreateInput(null)} inputMode="numeric" onChange={(event) => updateLineItem(index, "quantity", businessInputChange(event.target.value))} placeholder="整数" /></label>
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
        <section className="sourcing-photo-field" aria-label="订单照片" tabIndex={-1} {...feedback.field("sourcing-create-photos")}>
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
        {correction ? <label className="sourcing-form-wide"><span>修改说明（必填）</span><textarea {...feedback.field("sourcing-correction-reason")} value={correctionReason} maxLength={500} onChange={event=>{setCorrectionReason(event.target.value);createKey.current=null;}} /></label> : null}
        <div className="sourcing-submit-row">
          {duplicateLine || message ? <p id={duplicateLine ? "sourcing-create-duplicate-style" : undefined} role="status">{duplicateLine?.message ?? message}</p> : null}
          {uploadFailed && !uploading ? <p role="alert">本次图片上传未完成，请重新选择图片上传成功后再提交。</p> : null}
          <ActionBar className="sourcing-create-actions">
            {!correction ? <button className="dx-button dx-button--secondary" type="button" disabled={busy || uploading} onClick={saveLocalDraft}>保存草稿</button> : null}
            <button className="dx-button dx-button--primary" type="button" disabled={busy || feedback.uncertain || !canCreate || !!duplicateLine} onClick={() => void createOrder()}>
              {busy ? "正在提交…" : "提交并进入审批"}
            </button>
          </ActionBar>
        </div>
        </fieldset>
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
  const [contractReturn,setContractReturn] = useState<SourcingContractReturnFilter | null>(initial.contractReturn ?? null);
  const [message, setMessage] = useState("正在加载订单…");
  const [deletingCaseId, setDeletingCaseId] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [page, setPage] = useState(initial.page);
  const [totalPages, setTotalPages] = useState(1);
  const loadVersion = useRef(0);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [messagePath, setMessagePath] = useState<string | null>(null);
  const [summary, setSummary] = useState({ totalCount: 0, totalOrderQuantity: 0 });
  const [reloadRevision, setReloadRevision] = useState(0);
  const debouncedSearch = useDebouncedValue(search.trim(), 180);
  const debouncedStyleName = useDebouncedValue(styleName.trim(), 180);
  const listState: SourcingListQuery = {
    q: debouncedSearch,
    stage: mode === "history" ? "all" : stage,
    gender,
    styleName: debouncedStyleName,
    contractReturn,
    page,
  };
  const listPath = sourcingListPath(mode, listState);

  const load = async (state: SourcingListQuery): Promise<void> => {
    const version = ++loadVersion.current;
    setMessagePath(sourcingListPath(mode, state));
    setMessage("正在加载订单…");
    try {
      const params = new URLSearchParams({
        status: mode === "history" ? "closed" : "pending",
        q: state.q,
        stage: state.stage,
        gender: state.gender,
        styleName: state.styleName,
        page: String(state.page),
      });
      if (state.contractReturn != null) params.set("contractReturn",state.contractReturn);
      const body = await request(
        `sourcing/cases?${params.toString()}`,
        SourcingCaseListResponseSchema,
      );
      if (version !== loadVersion.current) return;
      if (body.page > body.totalPages) {
        setPage(Math.max(1, body.totalPages));
        return;
      }
      setItems(body.items);
      setSummary({ totalCount: body.totalCount, totalOrderQuantity: body.totalOrderQuantity });
      setLoadedPath(sourcingListPath(mode, state));
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
    return () => { loadVersion.current += 1; };
  }, [debouncedSearch, debouncedStyleName, stage, gender, contractReturn, page, mode, reloadRevision]);

  const changeStage = (value: SourcingStageFilter): void => {
    setStage(value);
    setPage(1);
  };
  const changeGender = (value: SourcingGenderFilter): void => {
    setGender(value);
    setPage(1);
  };

  const inputsSettled = search.trim() === debouncedSearch && styleName.trim() === debouncedStyleName;
  const currentResult = loadedPath === listPath && inputsSettled;
  const listMessage = !inputsSettled || messagePath !== listPath
    ? "正在加载订单…" : message || (!currentResult ? "正在加载订单…" : "");
  const visible = useMemo(
    () => listMessage ? [] : items.filter((item) => mode === "history" ? item.status === "closed" : item.status !== "closed"),
    [items, mode, listMessage],
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
      setLoadedPath(null);
      setReloadRevision(current => current + 1);
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
          <label>
            <span>合同回签</span>
            <select aria-label="合同回签" value={contractReturn ?? ""} onChange={event=>{
              setContractReturn(event.target.value ? event.target.value as SourcingContractReturnFilter : null);
              setPage(1);
            }}>
              <option value="">不筛选</option>
              <option value="all">全部监控订单</option>
              <option value="pending">待回签</option>
              <option value="returned_on_time">按时回签</option>
              <option value="overdue_pending">逾期未回签</option>
              <option value="returned_late">逾期已回签</option>
              <option value="all_overdue">全部逾期</option>
            </select>
          </label>
        </div>
        {!listMessage ? <p className="sourcing-list-summary" role="status" aria-label="筛选结果汇总">
          共 {summary.totalCount.toLocaleString("zh-CN")} 张订单 <span aria-hidden="true">｜</span> 订单数量合计 <strong>{summary.totalOrderQuantity.toLocaleString("zh-CN")}</strong> 件
        </p> : null}
        {deleteError ? <p className="sourcing-delete-error" role="alert">{deleteError}</p> : null}
        {listMessage ? <p className="sourcing-list-message" role="status">{listMessage}</p> : null}
        {!listMessage && visible.length === 0 ? <p className="sourcing-list-message">暂无符合条件的订单</p> : null}
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
        {!listMessage ? <ListPagination
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
  pending_merchandiser_correction: 0,
  pending_ie_quote: 1,
  pending_management_decision: 2,
  pending_owner_approval: 3,
  pending_contract: 4,
  pending_factory_change_verification: 2,
  pending_finance_reconciliation: 4,
  pending_exception_verification: 4,
  closed: 5,
})[status];

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
  historical = false,
): string => {
  const params = new URLSearchParams({ node: key });
  if (historical) params.set("view", "node-history");
  if (returnTo) params.set("returnTo", returnTo);
  return `${pageUrl(`ui/sourcing/orders/${sourcingCaseId}`)}?${params}`;
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
  const budgetCorrectionKey = useRef<string | null>(null);
  const [attachments, setAttachments] = useState<readonly SourcingAttachment[]>([]);
  const [timeline, setTimeline] = useState<readonly SourcingTimelineEntry[]>([]);
  const [factories, setFactories] = useState<readonly SourcingFactory[]>([]);
  const [quote, setQuote] = useState<QuoteDraft>({ linePrices: [], quoteReason: "" });
  const [processes, setProcesses] = useState<string[]>([""]);
  const [craftCatalog, setCraftCatalog] = useState<readonly CraftCatalogItem[]>([]);
  const [activeCraftQuery, setActiveCraftQuery] = useState("");
  const [decision, setDecision] = useState<DecisionDraft>({ supplierId: "", linePrices: [], decisionReason: "", cuttingProcess: "", cuttingProcessOther: "" });
  const [financeDifferenceOpen, setFinanceDifferenceOpen] = useState(false);
  const [budgetCorrectionOpen, setBudgetCorrectionOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnError, setReturnError] = useState("");
  const returnKey = useRef<string | null>(null);
  const returnReason = useRef("");
  const [budgetCorrectionError, setBudgetCorrectionError] = useState("");
  const [financeReview, setFinanceReview] = useState<FinanceReviewDraft>({ differenceFields: [], differenceReason: "" });
  const [factoryChange, setFactoryChange] = useState<SourcingFactoryChangeState | null>(null);
  const [contract, setContract] = useState<SourcingContractDocument | null>(null);
  const [contractReturn,setContractReturn] = useState<SourcingContractReturnResponse | null>(null);
  const contractReturnSectionRef=useRef<HTMLDivElement>(null);
  const [contractUploading,setContractUploading] = useState(false);
  const [contractUploadStage,setContractUploadStage] = useState<"uploading"|"saving"|"checking"|null>(null);
  const contractUploadGuard=useRef(false);
  const contractFileInput=useRef<HTMLInputElement | null>(null);
  const [contractReturnError,setContractReturnError] = useState("");
  const [contractReturnNeedsRefresh,setContractReturnNeedsRefresh] = useState(false);
  const contractReturnErrorRef=useRef<HTMLParagraphElement>(null);
  const [contractReturnNotice,setContractReturnNotice] = useState<{tone:"success"|"warning";message:string}|null>(null);
  const contractPendingUpload = useRef<ContractReturnUpload | null>(null);
  const [contractPendingSubmission,setContractPendingSubmission] = useState<{attachmentIds:string[];key:string;expectedContractDocumentId?:string|null}|null>(null);
  useEffect(()=>{
    contractPendingUpload.current=null;
    setContractPendingSubmission(null);
    setContractReturnError("");
    setContractReturnNeedsRefresh(false);
    setContractReturnNotice(null);
    setContractUploadStage(null);
  },[sourcingCaseId]);
  useEffect(()=>{
    if (!contractReturnError) return;
    contractReturnErrorRef.current?.focus();
    contractReturnErrorRef.current?.scrollIntoView({block:"nearest",behavior:"auto"});
  },[contractReturnError]);
  const [dispatchState, setDispatchState] = useState<SourcingDispatchState>({ item: null, canDispatch: false });
  const [contractSupplement, setContractSupplement] = useState<ContractSupplementDraft>({});
  const [factoryChangeDraft, setFactoryChangeDraft] = useState<FactoryChangeDraft>({ supplierId: "", unitPrice: "", changeReason: "" });
  const [factoryChangeReviewReason, setFactoryChangeReviewReason] = useState("");
  const [transferFormOpen, setTransferFormOpen] = useState(false);
  const [factoryChangeFeedback, setFactoryChangeFeedback] = useState<Readonly<{
    sourcingCaseId: string; kind: "error" | "success"; message: string; requestId?: string;
  }> | null>(null);
  const factoryChangeFeedbackRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { setFactoryChangeFeedback(null); }, [sourcingCaseId]);
  useEffect(() => {
    if (factoryChangeFeedback?.kind !== "error" || factoryChangeFeedback.sourcingCaseId !== sourcingCaseId) return;
    factoryChangeFeedbackRef.current?.focus({ preventScroll: true });
    factoryChangeFeedbackRef.current?.scrollIntoView({ block: "nearest" });
  }, [factoryChangeFeedback, sourcingCaseId]);
  const [exceptionReason, setExceptionReason] = useState("");
  const [selectedImage, setSelectedImage] = useState<SourcingAttachment | null>(null);
  const [mobileWorkflowExpanded, setMobileWorkflowExpanded] = useState(false);
  const workflowRailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mobileWorkflowExpanded) workflowRailRef.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [mobileWorkflowExpanded]);
  const [busy, setBusy] = useState(false);
  const feedback = useSubmissionFeedback(setBusy);
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

  const moduleWritable = moduleCanWrite(user, "sourcing") && !isJiashunContractClerk(user);
  const canSupplementImages = user?.isRoot === true
    || moduleWritable && (item?.createdBy === user?.id || user?.businessRoles?.some(role => role!=="order_merchandiser" && SOURCING_IMAGE_SUPPLEMENT_ROLES.includes(role as (typeof SOURCING_IMAGE_SUPPLEMENT_ROLES)[number]))) && user?.businessRoles?.some((role) => SOURCING_IMAGE_SUPPLEMENT_ROLES.includes(
      role as (typeof SOURCING_IMAGE_SUPPLEMENT_ROLES)[number],
    )) === true;

  const load = async (): Promise<void> => {
    try {
      const [detail, evidence, history, currentFactoryChange, currentContract, currentDispatch, currentContractReturn] = await Promise.all([
        request(`sourcing/cases/${sourcingCaseId}`, SourcingCaseSummarySchema),
        request(`sourcing/cases/${sourcingCaseId}/attachments`, SourcingAttachmentListResponseSchema),
        request(`sourcing/cases/${sourcingCaseId}/timeline`, SourcingTimelineResponseSchema),
        request(`sourcing/cases/${sourcingCaseId}/factory-changes/current`, SourcingFactoryChangeStateResponseSchema),
        request(`sourcing/cases/${sourcingCaseId}/contract`, SourcingContractStateResponseSchema),
        request(`sourcing/cases/${sourcingCaseId}/dispatch`, SourcingDispatchStateSchema),
        request(`sourcing/cases/${sourcingCaseId}/contract-return`, SourcingContractReturnResponseSchema),
      ]);
      setItem(detail);
      setProcesses((current) => current.some((value) => value.trim()) ? current : detail.processes.length ? [...detail.processes] : [""]);
      setAttachments(evidence.items);
      setTimeline(history.items);
      setFactoryChange(currentFactoryChange.item);
      setContract(currentContract.item);
      setContractReturn(currentContractReturn);
      setDispatchState(currentDispatch);
      setFactoryChangeDraft((current) => ({
        supplierId: current.supplierId,
        unitPrice: current.unitPrice || detail.decision?.unitPrice || "",
        changeReason: current.changeReason,
        ...(current.deliveryDate !== undefined ? {deliveryDate:current.deliveryDate} : {}),
        ...(current.craftNames ? { craftNames: current.craftNames } : {}),
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
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("section") !== "contract-return"
      || item?.sourcingCaseId !== sourcingCaseId || !contractReturn?.contractReturnMonitoring) return;
    const frame=window.requestAnimationFrame(() => {
      contractReturnSectionRef.current?.scrollIntoView({block:"start"});
      contractReturnSectionRef.current?.focus({preventScroll:true});
    });
    return () => window.cancelAnimationFrame(frame);
  },[sourcingCaseId,item?.sourcingCaseId,contractReturn?.contractReturnMonitoring]);
  const canQuote = canAct(user, "ie_reviewer", "sourcing:price:quote");
  const canManage = canAct(user, "production_management", "sourcing:decision:record");
  const canCorrectBudget = !!item
    && user?.isRoot === true
    && "daxingUnitPrice" in item
    && !!item.daxingUnitPrice
    && !item.approvalSnapshot
    && ["pending_ie_quote", "pending_management_decision", "pending_owner_approval"].includes(item.status);
  useEffect(() => {
    if (!canManage && !canAct(user,"order_merchandiser","sourcing:factory_change:request")
      && !canAct(user,"owner_group","sourcing:owner:approve")) return;
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
  }, [activeCraftQuery, canManage, user]);

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
  const contractReturnFileCount=contractReturn?.uploadedFileCount ?? contractReturn?.attachments.length ?? 0;
  const contractReturnUsedBytes=contractReturn?.uploadedTotalBytes ?? contractReturn?.attachments.reduce((total,file)=>total+file.sizeBytes,0) ?? 0;
  const saveContractReturn = async (submission: {attachmentIds:string[];key:string;expectedContractDocumentId?:string|null}):Promise<void> => {
    setContractUploadStage("saving");
    const savedFiles=(value:SourcingContractReturnResponse)=>confirmedContractReturnVersionFiles(value,submission.attachmentIds,submission.expectedContractDocumentId??null);
    const result=await confirmContractReturnSubmission(submission.attachmentIds,()=>requestSubmission(`sourcing/cases/${sourcingCaseId}/contract-return`,SourcingContractReturnResponseSchema,{
      method:"POST",headers:{"idempotency-key":submission.key},body:JSON.stringify({attachmentIds:submission.attachmentIds,expectedContractDocumentId:submission.expectedContractDocumentId}),
    }),async()=>{
      setContractUploadStage("checking");
      const current=await requestSubmission(`sourcing/cases/${sourcingCaseId}/contract-return`,SourcingContractReturnResponseSchema,{method:"GET"});
      setContractReturn(current);
      return current;
    },value=>savedFiles(value)!==null);
    const savedNames=savedFiles(result)!.map(name=>`《${name}》`).join("、");
    const savedCount=result.uploadedFileCount ?? result.attachments.length;
    const versionChanged=result.currentContractDocumentId!==(submission.expectedContractDocumentId??null);
    const receipt=versionChanged?`${savedNames}已保存到原合同版本。当前合同已换版，请刷新后核对。`
      :`${savedNames}上传成功，当前已保存 ${savedCount}/${CONTRACT_RETURN_MAX_FILES} 份。`;
    setContractReturn(result);
    contractPendingUpload.current=null;
    setContractPendingSubmission(null);
    setContractReturnError("");
    setContractReturnNotice({tone:versionChanged?"warning":"success",message:receipt});
    try {
      setItem(await requestSubmission(`sourcing/cases/${sourcingCaseId}`,SourcingCaseSummarySchema,{method:"GET"}));
    } catch {
      // The business write has already committed. A summary refresh failure is not an upload failure.
      setContractReturnNotice({tone:"warning",message:`${receipt} 订单信息刷新失败，请刷新页面核对。`});
    }
  };
  const releaseSupersededContractReturn=(error:unknown):boolean=>{
    if (!isContractReturnVersionConflict(error)) return false;
    setContractPendingSubmission(null);
    setContractReturnNeedsRefresh(true);
    setContractReturnError("本次回签未保存：合同已换版，请刷新合同版本后重新选择对应文件。");
    return true;
  };
  const refreshContractReturnVersion=async():Promise<void>=>{
    if (!contractReturnNeedsRefresh || contractUploadGuard.current) return;
    contractUploadGuard.current=true;setContractUploading(true);
    try {
      const [document,current]=await Promise.all([
        requestSubmission(`sourcing/cases/${sourcingCaseId}/contract`,SourcingContractStateResponseSchema,{method:"GET"}),
        requestSubmission(`sourcing/cases/${sourcingCaseId}/contract-return`,SourcingContractReturnResponseSchema,{method:"GET"}),
      ]);
      if (!document.item || document.item.sourcingContractDocumentId!==current.currentContractDocumentId) {
        setContractReturnError("合同版本尚未同步，请再次刷新合同版本。");return;
      }
      setContract(document.item);
      setContractReturn(current);
      setContractReturnNeedsRefresh(false);
      setContractReturnError("");
    } catch {
      setContractReturnError("合同版本刷新失败，请重试刷新。");
    } finally {contractUploadGuard.current=false;setContractUploading(false);}
  };
  const continueContractReturnUpload = async ():Promise<void> => {
    const pending=contractPendingUpload.current;
    if (!pending || contractUploadGuard.current) return;
    contractUploadGuard.current=true;setContractUploading(true);setContractUploadStage("uploading");setContractReturnError("");setContractReturnNotice(null);
    try {
      const submission=await finishContractReturnUpload(pending,async file=>{
        const intent=await request("tools/attachments/upload-intents",UploadIntentResponseSchema,{
          method:"POST",body:JSON.stringify({
            filename:file.name,mimeType:file.type,sizeBytes:file.size,sha256:await sha256Hex(file),
            ...(isJiashunContractClerk(user)?{
              sourcingCaseId,expectedContractDocumentId:pending.expectedContractDocumentId,
            }:{}),
          }),
        });
        const upload=new FormData();
        for (const [name,value] of Object.entries(intent.uploadFields)) upload.append(name,value);
        upload.append("file",file);
        const response=await fetch(intent.uploadUrl,{method:"POST",body:upload});
        if (!response.ok) throw new Error(`${file.name} 上传失败`);
        const ready=await request(`tools/attachments/${intent.attachmentId}/finalize`,AttachmentResponseSchema,{method:"POST"});
        if (ready.status!=="ready") throw new Error(`${file.name} 尚未完成校验`);
        return ready.attachmentId;
      });
      contractPendingUpload.current=null;
      setContractPendingSubmission(submission);
      await saveContractReturn(submission);
    } catch(error) {
      const message=error instanceof Error?error.message:"回签合同上传失败";
      if(error instanceof SourcingRequestError && error.status===403){
        contractPendingUpload.current=null;
        setContractPendingSubmission(null);
        setContractReturn(current=>current?{...current,canUpload:false}:current);
        setContractReturnError("账号权限或订单工厂已变化，当前页面无法确认回签保存结果。请由管理员核对订单记录后再处理。");
        return;
      }
      if(contractPendingUpload.current) {
        setContractReturnError(`${message}。已完成 ${pending.attachmentIds.length}/${pending.files.length} 个文件，尚未保存回签记录，请重试上传。`);
      } else if(!releaseSupersededContractReturn(error)) {
        if(error instanceof SourcingRequestError && (error.status===400&&error.code==="VALIDATION_ERROR" || error.status===409&&error.code==="INVALID_STATE_TRANSITION")) {
          setContractPendingSubmission(null);
          setContractReturnError(`本次回签未保存：${message}`);
        } else {
          setContractReturnError(`文件已传输，但回签保存结果尚未确认：${message}。请使用“重试保存”核对同一次请求，勿重新上传文件。`);
        }
      }
    } finally {contractUploadGuard.current=false;setContractUploading(false);setContractUploadStage(null);}
  };
  const uploadContractReturn = async (files:FileList|null):Promise<void> => {
    if (!files?.length || contractUploadGuard.current || contractPendingSubmission || contractReturnNeedsRefresh || !contractReturn?.canUpload
      || contractReturn.currentContractDocumentId!==contract?.sourcingContractDocumentId) return;
    const chosen=Array.from(files);
    setContractReturnNotice(null);
    const error=contractReturnSelectionError(chosen,contractReturnFileCount,contractReturnUsedBytes);
    if (error) {setContractReturnError(error);return;}
    contractPendingUpload.current={files:chosen,attachmentIds:[],key:createClientRequestId(),expectedContractDocumentId:contractReturn.currentContractDocumentId};
    await continueContractReturnUpload();
  };
  const retryContractReturn=async():Promise<void>=>{
    if (!contractPendingSubmission || contractUploadGuard.current) return;
    contractUploadGuard.current=true;setContractUploading(true);setContractUploadStage("saving");setContractReturnError("");setContractReturnNotice(null);
    try {await saveContractReturn(contractPendingSubmission);}
    catch(error){if(error instanceof SourcingRequestError&&error.status===403){setContractPendingSubmission(null);setContractReturn(current=>current?{...current,canUpload:false}:current);setContractReturnError("回传权限已撤销或订单已转厂，当前页面无法确认保存结果。请由管理员核对订单记录。");}else if(!releaseSupersededContractReturn(error))setContractReturnError(`回签保存结果尚未确认：${error instanceof Error?error.message:"请求失败"}。可使用原请求再次核对。`);}
    finally {contractUploadGuard.current=false;setContractUploading(false);setContractUploadStage(null);}
  };
  const styleLines = styleEdits.map(line => ({...line,color:item?.lineItems.find(row => row.position===line.position)?.color}));
  const duplicateStyleEdit = findDuplicateSourcingLine(styleLines);
  const submitReturn = async (reason:string):Promise<void> => {
    if (!item || busy) return;
    setBusy(true);setReturnError("");
    if(returnReason.current!==reason){returnKey.current=null;returnReason.current=reason;}
    const key=returnKey.current ?? createClientRequestId();returnKey.current=key;
    try {
      await requestSubmission(`sourcing/cases/${item.sourcingCaseId}/return-to-merchandiser`,SourcingCaseSummarySchema,{
        method:"POST",headers:{"idempotency-key":key},body:JSON.stringify({expectedVersion:item.version,reason})});
      window.location.assign(detailHref(item));
    } catch(error) {setReturnError(error instanceof Error?error.message:"退回失败");}
    finally {setBusy(false);}
  };
  const submitBudgetCorrection = async (daxingUnitPrice: string, reason: string): Promise<void> => {
    if (!item || !canCorrectBudget || busy) return;
    setBusy(true);
    setBudgetCorrectionError("");
    const key = budgetCorrectionKey.current ?? createClientRequestId();
    budgetCorrectionKey.current = key;
    try {
      const corrected = await request(`sourcing/cases/${sourcingCaseId}/budget-price-corrections`, SourcingCaseSummarySchema, {
        method: "POST",
        headers: { "idempotency-key": key },
        body: JSON.stringify({ daxingUnitPrice, reason }),
      });
      setItem(corrected);
      budgetCorrectionKey.current = null;
      setBudgetCorrectionOpen(false);
      setMessage("预算价已更正");
    } catch (error) {
      setBudgetCorrectionError(error instanceof Error ? error.message : "预算价更正失败");
    } finally {
      setBusy(false);
    }
  };

  const saveStyles = async (): Promise<void> => {
    if (!item || busy || !canEditStyles || duplicateStyleEdit) return;
    if (styleEdits.some(line => !line.styleNo.trim() && !line.alternateStyleNo.trim())) {setMessage("每行须填写正式款号或代用款号");return;}
    setBusy(true);
    const key=styleEditKey.current ?? createClientRequestId();styleEditKey.current=key;
    try {
      await requestWithStyleCheck(`sourcing/cases/${sourcingCaseId}/styles`,SourcingCaseSummarySchema,{method:"POST",headers:{"idempotency-key":key},
        body:JSON.stringify({expectedRevision:styleEditRevision,lines:styleEdits.map(line=>({position:line.position,styleNo:line.styleNo.trim()||null,alternateStyleNo:line.alternateStyleNo.trim()||null}))})},styleLines);
      setEditingStyles(false);styleEditKey.current=null;
      await load();setMessage("款号已保存；已生成的合同将保留旧版，并更新当前下载版本。");
    } catch(error) {setMessage(error instanceof Error ? error.message : "款号保存失败");}
    finally {setBusy(false);}
  };
  const canOwner = canAct(user, "owner_group", "sourcing:owner:approve");
  const canMerchandiserTransfer = item?.createdBy === user?.id && canAct(user, "order_merchandiser", "sourcing:factory_change:request");
  const canManagementTransfer = canManage;
  const canOwnerTransfer = canOwner;
  const canReviewManagementTransfer = canAct(user, "production_management", "sourcing:factory_change:verify");
  const canFinance = canAct(user, "factory_payables", "sourcing:finance:reconcile");
  const canChangeTransferDate = canChangeSourcingTransferDeliveryDate(user ?? {});
  const transferDateError = factoryChangeDraft.deliveryDate === undefined ? "" : !factoryChangeDraft.deliveryDate
    ? "请选择交货日期" : !sourcingDatesValid(item?.estimatedCutPieceSendDate ?? null,factoryChangeDraft.deliveryDate) ? SOURCING_DATE_ORDER_ERROR : "";
  const hideFinanceForMerchandiser = isMerchandiserOnly(user?.businessRoles,user?.isRoot);
  const canReadContractData = user?.isRoot === true
    || user?.capabilities.includes("supplier_contract_data:read") === true
    || isJiashunContractClerk(user);
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
    if (path.endsWith("/ie-quotes")) {
      if (busy || feedback.uncertain || priceComposing("quote")) return;
      const issues = validateSourcingPrices("quote", quote.linePrices);
      if (issues.length) { await feedback.reject(issues); return; }
      const requestKey = actionKey.current ?? createClientRequestId();
      actionKey.current = requestKey;
      const snapshot = JSON.stringify(body);
      await feedback.run(async () => {
        await requestSubmission(path, SourcingCaseSummarySchema, {
          method: "POST", headers: { "idempotency-key": requestKey }, body: snapshot,
        });
        feedback.confirmed();
        actionKey.current = null;
        await load();
        setMessage(success);
        await alertInApp(success, { title: "提交成功" });
      });
      return;
    }
    if (resetFactoryChange) { setFactoryChangeFeedback(null); setMessage(""); }
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
      if (resetFactoryChange) {
        setFactoryChangeFeedback({ sourcingCaseId, kind: "success", message: success });
        setFactoryChangeDraft({
          supplierId: "",
          unitPrice: updated.decision?.unitPrice || "",
          changeReason: "",
        });
        setFactoryChangeReviewReason("");
        setActiveCraftQuery("");
      } else setMessage(success);
      await load();
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : "提交失败";
      if (resetFactoryChange) {
        setFactoryChangeFeedback({ sourcingCaseId, kind: "error", message: failureMessage,
          ...(error instanceof SourcingRequestError && error.requestId ? { requestId: error.requestId } : {}),
        });
      } else setMessage(failureMessage);
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
        `供应商：${snapshot.supplierName}\n总数量：${formatBusinessDecimal(snapshot.quantity)} 件\n交期：${item.deliveryDate ?? "历史未维护"}\n合同编号：${contract.contractNumber}`,
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
    if (busy || feedback.uncertain || priceComposing("decision")) return;
    const issues = validateSourcingDecision(decision, item.ieQuote?.linePrices ?? [], processes);
    if (issues.length) { await feedback.reject(issues); return; }
    const names = processes.map(value => value.trim());
    const requestKey = actionKey.current ?? createClientRequestId();
    actionKey.current = requestKey;
    // Snapshot before awaiting craft resolution; recovery cannot pick up edited values.
    const decisionSnapshot = JSON.stringify({ supplierId: decision.supplierId, linePrices: decision.linePrices,
      ...(decision.cuttingProcess ? { cuttingProcess: decision.cuttingProcess } : {}),
      ...(decision.cuttingProcess === "other" ? { cuttingProcessOther: decision.cuttingProcessOther.trim() } : {}),
      ...(decision.decisionReason.trim() ? { decisionReason: decision.decisionReason.trim() } : {}) });
    let body: string | null = null;
    await feedback.run(async () => {
      if (!body) {
        const crafts = await requestSubmission("master-data/crafts/ensure", CraftCatalogListResponseSchema, {
          method: "POST", body: JSON.stringify({ craftNames: names }),
        });
        body = JSON.stringify({ ...JSON.parse(decisionSnapshot), craftIds: crafts.map(craft => craft.craftId) });
      }
      await requestSubmission(`sourcing/cases/${item.sourcingCaseId}/management-decisions`, SourcingCaseSummarySchema, {
        method: "POST", headers: { "idempotency-key": requestKey }, body,
      });
      feedback.confirmed();
      actionKey.current = null;
      await load();
      const success = "逐款调价、选厂与工艺及承包范围已提交老板审批";
      setMessage(success);
      await alertInApp(success, { title: "提交成功" });
    });
  };

  const mainStep = statusStep(item.status);
  const step = factoryChange?.status === "pending_owner" ? Math.max(mainStep, 3) : mainStep;
  const visibleWorkflow = hideFinanceForMerchandiser ? WORKFLOW.filter(node=>node.key!=="finance") : WORKFLOW;
  const activeNode = hideFinanceForMerchandiser && step>=4 ? "owner" : WORKFLOW[Math.min(step,WORKFLOW.length-1)]?.key ?? "finance";
  const requestedNodeValue = sourcingWorkflowNodeFromSearch();
  const requestedNode = hideFinanceForMerchandiser && requestedNodeValue==="finance" ? null : requestedNodeValue;
  const requestedIndex = requestedNode ? WORKFLOW.findIndex((node) => node.key === requestedNode) : -1;
  const requestedNodeIsAccessible = requestedNode !== null
    && (item.status === "closed" || requestedIndex <= step);
  const selectedNode = requestedNodeIsAccessible ? requestedNode : activeNode;
  const selectedIndex = WORKFLOW.findIndex((node) => node.key === selectedNode);
  const selectedState: SourcingWorkflowNodeState = item.status === "closed" || selectedIndex < step
    ? "completed"
    : selectedIndex === step ? "current" : "future";
  const display = sourcingCurrentDisplay(item);
  const ownerTotalDelta = item.ieQuote && display.totalAmount
    ? subtractFixedPoint(display.totalAmount, item.ieQuote.totalAmount, 2)
    : null;
  const ownerCraftSummary = <span className="sourcing-owner-craft-summary">承包内容包括 <strong>{display.processes.length ? display.processes.join("、") : "未填写"}</strong>；裁床工序为 <strong>{item.decision?.cuttingProcess === "in_house" ? "本厂裁" : item.decision?.cuttingProcess === "outsourced" ? "外厂裁" : item.decision?.cuttingProcess === "other" ? `其它：${item.decision.cuttingProcessOther ?? "未填写"}` : "未填写"}</strong>。</span>;
  const latestFinance = [...timeline].reverse()
    .find((entry) => entry.kind === "finance_reconciliation");
  const transferNodeRole = canOwnerTransfer ? "owner_group"
    : canManagementTransfer ? "production_management"
      : canMerchandiserTransfer ? "order_merchandiser" : null;
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
  const transferCraftNames = factoryChangeDraft.craftNames?.map(name => name.trim());
  const transferCraftError = !transferCraftNames ? ""
    : !transferCraftNames.length || transferCraftNames.some(name => !name) ? "请填写每一项工艺，或删除空白行"
      : new Set(transferCraftNames.map(name => name.toLowerCase())).size !== transferCraftNames.length ? "工艺不能重复，请修改或删除重复行"
        : transferCraftNames.some(name => name.length > 100) ? "每项工艺最多100字" : "";
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

  const requestedTransferReview = factoryChange?.status === "pending_owner" && requestedNode === "owner"
    || factoryChange?.status === "pending_management" && requestedNode === "management";
  if (requestedNode && selectedState === "completed" && !requestedTransferReview) return <SourcingNodeHistoryPage
    sourcingCaseId={sourcingCaseId} node={selectedNode} returnTo={detailReturnPath} />;

  if (item.status === "pending_merchandiser_correction" && new URLSearchParams(window.location.search).get("edit") === "correction"
    && canAct(user,"order_merchandiser","sourcing:inquiry:create") && (user?.isRoot || user?.id===item.createdBy)) {
    return <CreateOrderPage key={`${item.sourcingCaseId}:${item.version}`} user={user} correction={{item,attachments}} />;
  }
  const datesValid = sourcingDatesValid(item.estimatedCutPieceSendDate,item.deliveryDate);
  const canReturn = canAct(user,"owner_group","sourcing:owner:approve") && !item.approvalSnapshot
    && ["pending_ie_quote","pending_management_decision","pending_owner_approval"].includes(item.status);
  return (
    <div className="sourcing-workspace sourcing-order-detail">
      {returnOpen ? <SourcingReturnDialog busy={busy} error={returnError} onClose={()=>{setReturnOpen(false);returnKey.current=null;}} onSubmit={reason=>void submitReturn(reason)} /> : null}
      {budgetCorrectionOpen && item?.daxingUnitPrice ? <SourcingBudgetPriceCorrectionDialog
        currentPrice={item.daxingUnitPrice}
        busy={busy}
        error={budgetCorrectionError}
        onClose={() => {
          if (busy) return;
          budgetCorrectionKey.current = null;
          setBudgetCorrectionError("");
          setBudgetCorrectionOpen(false);
        }}
        onSubmit={(daxingUnitPrice, reason) => void submitBudgetCorrection(daxingUnitPrice, reason)}
      /> : null}
      <Header
        iconRoute="/ui/sourcing/pending"
        title={display.styleNo}
        subtitle={`${display.gender ?? "历史未维护"} · ${display.styleName ?? "历史未维护"}`}
        badge={STATUS_LABELS[item.status]}
        badgePlacement="subtitle"
        action={todoBackPath ? "返回我的待办" : "返回订单列表"}
        actionHref={detailReturnPath ?? (item.status === "closed" ? "/ui/sourcing/history" : "/ui/sourcing/pending")}
      />
      {canReturn ? <button type="button" className="dx-button dx-button--secondary" disabled={busy} onClick={()=>{setReturnOpen(true);setReturnError("");}}>退回跟单修改</button> : null}
      {!datesValid ? <p role="alert">{SOURCING_DATE_ORDER_ERROR}，请退回跟单纠正后再提交。</p> : null}
      {item.status === "pending_merchandiser_correction" ? <section><p>退回原因：{item.correctionReason}</p>
        {canAct(user,"order_merchandiser","sourcing:inquiry:create") && (user?.isRoot || user?.id===item.createdBy)
          ? <a className="dx-button dx-button--primary" href={`${detailHref(item)}?edit=correction`}>修改订单资料</a> : <p>等待原跟单修改资料</p>}
        <a href={sourcingWorkflowNodeHref(item.sourcingCaseId,"created",detailReturnPath,true)}>查看历次提交资料</a>
      </section> : null}
      {!item.decision && item.processes.length > 0 ? <p className="sourcing-order-meta">工艺及承包范围：{item.processes.join("、")}</p> : null}
      <div className="sourcing-detail-layout">
        <KeyFacts className="sourcing-key-facts" aria-label="外发定价选厂订单核心信息">
          <div><dt>跟单</dt><dd>{item.merchandiserName ?? "历史未维护"}</dd></div>
          <div className="sourcing-key-facts__factory"><dt>加工厂</dt><dd>{display.supplierName ?? "待选厂"}</dd></div>
          <div><dt>总数量</dt><dd>{formatBusinessDecimal(display.quantity)} 件</dd></div>
          <div><dt>生产总额</dt><dd>{display.totalAmount ? formatBusinessCurrency(display.totalAmount) : "—"}</dd></div>
          <div><dt>IE 总额</dt><dd>{item.ieQuote ? formatBusinessCurrency(item.ieQuote.totalAmount) : "—"}</dd></div>
          <div><dt>较 IE 总额变化</dt><dd className={ownerTotalDelta?.startsWith("-") ? "sourcing-price-lower" : undefined}>{ownerTotalDelta ?? "—"}</dd></div>
          <div className="sourcing-key-facts__date"><dt>预计裁片发出</dt><dd>{display.estimatedCutPieceSendDate ?? "历史未维护"}</dd></div>
          <div className="sourcing-key-facts__date"><dt>要求交货日期</dt><dd>{display.deliveryDate ?? "—"}</dd></div>
        </KeyFacts>
        <div className="sourcing-supporting-overview">
          <section className="sourcing-photo-section" aria-label="订单图片">
            <div className="section-title rework-detail-panel-title">
              <h2>订单图片</h2>
            {canSupplementImages ? <SourcingImageSupplementUploader
              sourcingCaseId={sourcingCaseId}
              currentAttachmentCount={attachments.length}
              onUploaded={load}
            /> : null}
              <StatusBadge tone="info">{formatBusinessDecimal(item.contractDisplay?.linesMatchOrder && canReadContractData ? item.contractDisplay.lines.filter(line => line.imageAttachmentId).length : attachments.length)} 张</StatusBadge>
            </div>
            {item.contractDisplay?.linesMatchOrder && canReadContractData ? <ImageStrip aria-label="当前合同款图，可横向滚动">
              {item.contractDisplay.lines.filter(line => line.imageAttachmentId).map(line => <a className="sourcing-photo" key={line.position} href={attachmentUrl(line.imageAttachmentId!,"preview")} target="_blank" rel="noreferrer">
                <img src={attachmentUrl(line.imageAttachmentId!,"preview")} alt={`${line.styleNo || "未维护款号"}款图`} loading="lazy" />
                <span className="sourcing-photo__filename">{line.styleNo || "未维护款号"}</span>
              </a>)}
            </ImageStrip> : attachments.length > 0 ? <ImageStrip aria-label="订单照片，可横向滚动">
              {attachments.map((attachment) => <button className="sourcing-photo" type="button" key={attachment.attachmentId} onClick={() => setSelectedImage(attachment)}>
                <img src={attachmentUrl(attachment.attachmentId, "preview")} alt={attachment.filename} loading="lazy" />
                <span className="sourcing-photo__filename">{attachment.filename}</span>
              </button>)}
            </ImageStrip> : <p className="sourcing-list-message">本单没有图片</p>}

          </section>

          <section className="sourcing-workflow-section" aria-label="订单流程">
            <div className="rework-workflow__heading rework-detail-panel-title rework-detail-desktop-panel-heading">
              <h2>订单流程</h2><span className="rework-workflow__step-count">{hideFinanceForMerchandiser ? "审批环节" : "当前步骤"} {Math.min(step + 1, visibleWorkflow.length)} / {visibleWorkflow.length}</span>
            </div>
            <button className="rework-detail-mobile-panel-toggle rework-detail-mobile-workflow-toggle" type="button"
              aria-controls="sourcing-workflow-content" aria-expanded={mobileWorkflowExpanded}
              onClick={() => setMobileWorkflowExpanded(value => !value)}>
              <span><strong>订单流程</strong><small>{hideFinanceForMerchandiser && step>=4 ? STATUS_LABELS[item.status] : WORKFLOW[Math.min(step, WORKFLOW.length - 1)]?.label}</small></span>
              <span><small>{Math.min(step + 1, visibleWorkflow.length)}/{visibleWorkflow.length}</small><b aria-hidden="true">{mobileWorkflowExpanded ? "−" : "+"}</b></span>
            </button>
            <div id="sourcing-workflow-content" className={`rework-detail-mobile-collapsible${mobileWorkflowExpanded ? " is-expanded" : ""}`}>
              <WorkflowRail className="sourcing-workflow-rail" ref={workflowRailRef}>
              {visibleWorkflow.map((node, index) => {
                const state: SourcingWorkflowNodeState = item.status === "closed" || index < step ? "completed" : index === step ? "current" : "future";
                const content = <>
                  <b aria-hidden="true">{state === "completed" ? "✓" : index + 1}</b>
                  <span><strong>{node.label}</strong><small>{node.role}</small></span>
                  <em>{state === "completed" ? "已完成" : state === "current" ? "处理中" : "未开始"}</em>
                </>;
                return state === "future"
                  ? <div className="sourcing-workflow-step is-future" aria-disabled="true" key={node.key}>{content}</div>
                  : <a className={`sourcing-workflow-step is-${state}`} href={sourcingWorkflowNodeHref(item.sourcingCaseId, node.key, detailReturnPath, state === "completed")} aria-current={state === "current" ? "step" : undefined} key={node.key}>{content}</a>;
              })}
              </WorkflowRail>
            </div>
          </section>
        </div>

        {item.decision ? <DecisionSummary title={selectedNode === "owner" ? "审批摘要" : "选厂摘要"}>
          <p className="sourcing-owner-decision__lead">{item.contractDisplay ? "当前合同由" : "生产管理建议由"} <strong>{display.supplierName}</strong> 承接 <strong>{formatBusinessDecimal(display.quantity)} 件</strong>，生产总额 <strong>{formatBusinessCurrency(display.totalAmount!)}</strong>，相对 IE 总额变化 <strong>{ownerTotalDelta ?? "—"}</strong>。</p>
          <p>{ownerCraftSummary}</p>
          {item.decision.decisionReason ? <p>生产管理说明：{item.decision.decisionReason}</p> : null}
          {selectedNode === "owner" && selectedState === "current" ? <p>请核对价格、加工厂及交期，确认后审批。</p> : null}
        </DecisionSummary> : null}
        <ResponsiveFactsTable caption="款式明细" mobileLayout="compact" rows={display.lines} rowKey={line => line.position}
          totals={{ style: "合计", quantity: `${formatBusinessDecimal(display.quantity)} 件`, amount: display.totalAmount ? formatBusinessCurrency(display.totalAmount) : "—" }}
          columns={[
            {
              key: "style", label: "款号", mobileHeading: true,
              mobileRender: line => {
                const alternate = line.alternateStyleNo && line.alternateStyleNo !== line.styleNo ? line.alternateStyleNo : null;
                const historical = line.externalUnitPrice
                  && !sourcingLinePricing(item.ieQuote, line.position, item.lineItems.length)
                  && !sourcingLinePricing(item.decision, line.position, item.lineItems.length)
                  ? line.externalUnitPrice : null;
                return <>{line.styleNo || "—"}{alternate || historical ? <details className="sourcing-style-secondary">
                  <summary>补充信息</summary>
                  {alternate ? <small>代用：{alternate}</small> : null}
                  {historical ? <small>原登记加工价：{historicalSourcingPrice(historical)}</small> : null}
                </details> : null}</>;
              },
              render: line => <>{line.styleNo || "—"}{line.alternateStyleNo && line.alternateStyleNo !== line.styleNo ? <small>代用：{line.alternateStyleNo}</small> : null}{line.externalUnitPrice && !sourcingLinePricing(item.ieQuote, line.position, item.lineItems.length) && !sourcingLinePricing(item.decision, line.position, item.lineItems.length) ? <small>原登记加工价：{historicalSourcingPrice(line.externalUnitPrice)}</small> : null}</>,
            },
            { key: "color", label: "颜色", mobileHeading: true, render: line => line.color ?? "历史未维护" },
            { key: "quantity", label: "数量", render: line => `${formatBusinessDecimal(line.quantity)} 件` },
            ...("daxingUnitPrice" in item ? [{ key: "budget", label: "预算价", render: (line: SourcingCaseSummary["lineItems"][number]) => item.daxingUnitPrice ? <span className="sourcing-budget-price-value">
              {formatBusinessCurrency(item.daxingUnitPrice)}
              {canCorrectBudget && line.position === item.lineItems[0]?.position ? <button type="button" className="sourcing-budget-price-correct"
                onClick={() => { budgetCorrectionKey.current = null; setBudgetCorrectionError(""); setBudgetCorrectionOpen(true); }}>更正</button> : null}
            </span> : "历史未维护" }] : []),
            { key: "ie", label: "IE 单价", render: line => { const price = sourcingLinePricing(item.ieQuote, line.position, item.lineItems.length); return price ? historicalSourcingPrice(price.unitPrice) : "—"; } },
            { key: "production", label: "生产单价", render: line => { const price = display.prices.find(price => price.position === line.position); return price ? historicalSourcingPrice(price.unitPrice) : "—"; } },
            { key: "amount", label: "本款金额", render: line => { const price = display.prices.find(price => price.position === line.position); return price?.totalAmount ? formatBusinessCurrency(price.totalAmount) : "—"; } },
          ]} />
        {item.contractDisplay && !item.contractDisplay.linesMatchOrder ? <p role="status">合同款色对应关系不明确，款式明细保留订单记录，请由 Root 核对合同。</p> : null}
        {item.decision?.sourceType === "factory_change" && item.lineItems.length > 1 && item.lineItems.some(line => !item.decision?.linePrices.some(price => price.position === line.position)) ? <p className="sourcing-price-note">转厂后按统一生产单价执行，部分款式缺少逐款金额记录，生产总额见合计。</p> : null}

        <section id="node-workspace" className="sourcing-node-workspace" aria-label="节点办理区">
          <SubmissionFeedback feedback={feedback} busy={busy} />
          {item.status === "pending_ie_quote" && selectedNode === "ie_quote" ? <Surface className="rework-detail-node-preview">
            <h2>IE 给价</h2>
            <p>逐款核定加工单价；每行金额独立四舍五入到分后汇总。</p>
            {canQuote ? <fieldset className="sourcing-submission-fields sourcing-form-grid" disabled={busy || feedback.uncertain}>
              <div className="sourcing-line-price-table sourcing-form-wide" role="table" aria-label="IE逐款价格">
                {item.lineItems.map((line) => {
                  const price = quote.linePrices.find((entry) => entry.position === line.position)?.unitPrice ?? "";
                  const control = priceInput("quote", line.position, price);
                  const errorId = `sourcing-quote-price-error-${line.position}`;
                  return <label className="sourcing-line-price-row" key={line.position}>
                    <span><b>{String(line.position).padStart(2, "0")}</b> {line.styleNo} · {line.color ?? "历史未维护颜色"} · {formatBusinessDecimal(line.quantity)} 件</span>
                    <span className="sourcing-price-control"><input aria-label={`${line.styleNo} IE单价`} {...control.props} {...feedback.field(`sourcing-quote-price-${line.position}`)} aria-describedby={control.error ? errorId : feedback.field(errorId.replace("-error-", "-"))["aria-describedby"]} />{control.error ? <small id={errorId} role="status">{control.error}</small> : null}</span>
                    <strong>{formatBusinessCurrency(isNewSourcingPrice(price) ? totalPreview(price, line.quantity) : "—")}</strong>
                  </label>;
                })}
              </div>
              <label><span>逐款汇总</span><input value={businessInputValue(linesTotalPreview(quote.linePrices, item.lineItems))} readOnly /></label>
              <label className="sourcing-form-wide"><span>价格说明</span><input value={quote.quoteReason} maxLength={500} onChange={(event) => { setQuote({ ...quote, quoteReason: event.target.value }); actionKey.current = null; }} /></label>
              <button className="dx-button dx-button--primary" type="button" disabled={busy || feedback.uncertain || priceComposing("quote")} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/ie-quotes`, { linePrices: quote.linePrices, ...(quote.quoteReason.trim() ? { quoteReason: quote.quoteReason.trim() } : {}) }, "IE 逐款价格已提交")}>提交 IE 逐款价格</button>
            </fieldset> : <p>当前账号仅可查看，本节点由 IE 办理。</p>}
          </Surface> : null}

          {item.status === "pending_management_decision" && selectedNode === "management" ? <Surface className="rework-detail-node-preview">
            <h2>生产管理调价与选厂</h2>
            <p>逐款确认 IE 价格并选择一个启用加工厂。</p>
            {canManage ? <fieldset className="sourcing-submission-fields sourcing-form-grid" disabled={busy || feedback.uncertain}>
              <label><span>加工厂</span><SearchableSelect {...feedback.field("sourcing-decision-factory")} value={decision.supplierId} onChange={(event) => { setDecision({ ...decision, supplierId: event.target.value }); actionKey.current = null; }}><option value="">请选择加工厂</option>{factories.map((factory) => <option key={factory.supplierId} value={factory.supplierId}>{factory.supplierName}</option>)}</SearchableSelect></label>
              {selectedFactory ? <div className="sourcing-factory-facts sourcing-form-wide"><strong>{selectedFactory.supplierName} · {selectedFactory.supplierCode}</strong><span>工艺：{selectedFactory.supportedCrafts.join("、") || "未维护"}</span><span>日产能：{selectedFactory.dailyCapacity ? `${formatBusinessDecimal(selectedFactory.dailyCapacity)} 件` : "未维护"}</span><span>{selectedFactory.notes || "暂无协同备注"}</span><em>{selectedFactory.contractDataMissing.length ? `合同缺项：${selectedFactory.contractDataMissing.map((field) => contractMissingLabels[field] ?? field).join("、")}` : "合同资料完整"}</em></div> : null}
              <div className="sourcing-line-price-table sourcing-form-wide" role="table" aria-label="生产管理逐款价格">
                {item.lineItems.map((line) => {
                  const price = decision.linePrices.find((entry) => entry.position === line.position)?.unitPrice ?? "";
                  const control = priceInput("decision", line.position, price);
                  const errorId = `sourcing-decision-price-error-${line.position}`;
                  const iePrice = item.ieQuote?.linePrices.find((entry) => entry.position === line.position)?.unitPrice;
                  return <label className="sourcing-line-price-row" key={line.position}><span><b>{String(line.position).padStart(2, "0")}</b> {line.styleNo} · {line.color ?? "历史未维护颜色"}<small>IE {iePrice ? formatBusinessCurrency(iePrice) : "—"}</small></span><span className="sourcing-price-control"><input aria-label={`${line.styleNo} 生产单价`} {...control.props} {...feedback.field(`sourcing-decision-price-${line.position}`)} aria-describedby={control.error ? errorId : feedback.field(errorId.replace("-error-", "-"))["aria-describedby"]} />{control.error ? <small id={errorId} role="status">{control.error}</small> : null}</span><strong>{formatBusinessCurrency(isNewSourcingPrice(price) ? totalPreview(price, line.quantity) : "—")}</strong></label>;
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
                <label><span className="visually-hidden">第 {index + 1} 项工艺</span><input {...feedback.field(`sourcing-decision-process-${index}`)} list="sourcing-craft-options" value={process} maxLength={100} onChange={(event) => updateProcess(index, event.target.value)} placeholder="例如：车缝+线+包装，回厂装箱+一程运费" /></label>
                <button type="button" aria-label={`删除第 ${index + 1} 项工艺`} disabled={processes.length === 1} onClick={() => removeProcess(index)}>删除</button>
              </div>)}
            </div>
            <datalist id="sourcing-craft-options">
              {craftCatalog.map((craft) => <option key={craft.craftId} value={craft.craftName}>{craft.craftCode}</option>)}
            </datalist>
          </section>
              <label><span>裁床工序</span><select value={decision.cuttingProcess} onChange={(event) => { setDecision({ ...decision, cuttingProcess: event.target.value as DecisionDraft["cuttingProcess"], cuttingProcessOther: "" }); actionKey.current = null; }}><option value="">请选择</option><option value="in_house">本厂裁</option><option value="outsourced">外厂裁</option><option value="other">其它</option></select></label>
              {decision.cuttingProcess === "other" ? <label><span>其它裁床工序（必填）</span><input {...feedback.field("sourcing-decision-cutting-other")} value={decision.cuttingProcessOther} maxLength={100} onChange={(event) => { setDecision({ ...decision, cuttingProcessOther: event.target.value }); actionKey.current = null; }} /></label> : null}
              <label className="sourcing-form-wide"><span>选厂/调价说明{needsDecisionReason ? "（必填）" : ""}</span><input {...feedback.field("sourcing-decision-reason")} value={decision.decisionReason} maxLength={500} required={needsDecisionReason} aria-invalid={missingDecisionReason} aria-describedby={missingDecisionReason ? "sourcing-decision-reason-hint" : undefined} onChange={(event) => { setDecision({ ...decision, decisionReason: event.target.value }); actionKey.current = null; }} />{missingDecisionReason ? <small id="sourcing-decision-reason-hint" role="status">价格高于 IE，请填写原因</small> : null}</label>
              <button className="dx-button dx-button--primary" type="button" disabled={busy || feedback.uncertain || priceComposing("decision")} onClick={() => void submitManagement()}>提交调价与选厂</button>
            </fieldset> : <p>当前账号仅可查看，本节点由生产管理办理。</p>}
          </Surface> : null}

          {item.status === "pending_owner_approval" && selectedNode === "owner" && !canOwner ? <p>当前账号仅可查看，本节点由老板办理。</p> : null}

          {item.approvalSnapshot ? <Surface className="rework-detail-node-preview sourcing-contract-bar">
            <div className="sourcing-contract-bar__heading">
              <div><h2>系统合同</h2><p>{item.contractDisplay ? "当前合同按本单修改内容生成，原批准记录保留。" : "合同仅使用老板批准快照；主档后续修改不会追改本版本。"}</p></div>
              {contract ? <StatusBadge tone={contract.status === "ready" ? "success" : contract.status === "generation_failed" ? "danger" : "info"}>{contract.status === "ready" ? "PDF 已生成" : contract.status === "pending_supplement" ? "待补资料" : contract.status === "generation_failed" ? "生成失败" : "生成中"}</StatusBadge> : null}
            </div>
            {contract ? <>
              <dl className="sourcing-finance-reference" aria-label="系统合同版本">
                <div><dt>合同编号</dt><dd>{contract.contractNumber}</dd></div>
                <div><dt>合同版本</dt><dd>V{contract.contractVersion} · 模板 V{contract.templateVersion}</dd></div>
              </dl>
              {contract.status === "ready" && contract.pdfAttachmentId && canReadContractData ? <div className="sourcing-contract-bar__actions"><a className="dx-button dx-button--primary" href={attachmentUrl(contract.pdfAttachmentId, "preview")} target="_blank" rel="noreferrer">预览合同 PDF</a><a className="dx-button dx-button--secondary" href={attachmentUrl(contract.pdfAttachmentId, "download")} target="_blank" rel="noreferrer">下载合同</a>{contract.canRefreshInformation ? <ContractInformationRefresh key={contract.sourcingContractDocumentId} caseId={item.sourcingCaseId} disabled={busy} canEditContent={contract.canEditContent === true} onUpdated={load} /> : null}{canEditStyles ? <button className="dx-button dx-button--secondary" type="button" disabled={busy} onClick={() => {
          setStyleEdits(item.lineItems.map(line => ({position:line.position,styleNo:line.formalStyleNo ?? "",alternateStyleNo:line.alternateStyleNo ?? ""})));
          setStyleEditRevision(item.identityRevision ?? 0);styleEditKey.current=null;setEditingStyles(true);
        }}>修改款号</button> : null}</div> : null}
              {contractReturn?.contractReturnMonitoring ? <>
                {contractReturn.contractReturnedAt || contractReturn.contractReturnCycleId ? <p>{contractReturn.currentContractReturned && contractReturn.currentContractDocumentId === contract.sourcingContractDocumentId ? `本版本 V${contract.contractVersion} 已回签` : `本版本 V${contract.contractVersion} 无回签记录`}</p> : null}
                <p className="sourcing-contract-return-capacity" aria-label="当前合同版本实际保存的回签文件数量与空间">
                  已保存 {contractReturnFileCount}/{CONTRACT_RETURN_MAX_FILES} 份 · 已用 {formatContractReturnSize(contractReturnUsedBytes)} · 剩余 {formatContractReturnSize(Math.max(0,CONTRACT_RETURN_MAX_BYTES-contractReturnUsedBytes))}
                </p>
                <div ref={contractReturnSectionRef} tabIndex={-1} className="sourcing-contract-bar__actions sourcing-contract-return-actions">
                  {new URLSearchParams(window.location.search).get("contractDocumentId") && new URLSearchParams(window.location.search).get("contractDocumentId") !== contractReturn.currentContractDocumentId ? <p role="status">该待办对应的合同已换版。下方显示当前合同，请核对版本后下载及回传。</p> : null}
                  {contractReturnNeedsRefresh ? <button className="dx-button dx-button--secondary" type="button" disabled={contractUploading || busy}
                    onClick={()=>void refreshContractReturnVersion()}>刷新合同版本</button> : null}
                  {!contractReturnNeedsRefresh && contractReturn.canUpload && contractReturn.currentContractDocumentId===contract.sourcingContractDocumentId ? <>
                    <input ref={contractFileInput} type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" multiple hidden disabled={contractUploading || !!contractPendingSubmission}
                      onChange={event=>{void uploadContractReturn(event.target.files);event.target.value="";}} />
                    <button className="dx-button dx-button--secondary" type="button" disabled={contractUploading || busy || !!contractPendingSubmission}
                      onClick={()=>contractFileInput.current?.click()}>
                      {contractUploadStage==="uploading"?"正在上传文件…":contractUploadStage==="saving"?"正在保存回签…":contractUploadStage==="checking"?"正在核对保存结果…":contractReturn.uploadedFileCount?"补传回签合同":"上传回签合同"}
                    </button>
                  </> : null}
                  {(contractReturn.uploadedFileCount ?? contractReturn.attachments.length)>=3 ? <span>当前合同版本已达文件上限，已保存附件及历史记录保留</span> : null}
                  <SourcingContractReturnFiles key={sourcingCaseId} value={contractReturn} attachmentUrl={attachmentUrl} />
                  {contractPendingUpload.current && contractReturnError ? <button className="dx-button dx-button--secondary" type="button"
                    disabled={contractUploading} onClick={()=>void continueContractReturnUpload()}>重试上传</button> : null}
                  {contractPendingSubmission && contractReturnError ? <button className="dx-button dx-button--secondary" type="button"
                    disabled={contractUploading} onClick={()=>void retryContractReturn()}>重试保存</button> : null}
                </div>
                {contractReturnError ? <p ref={contractReturnErrorRef} tabIndex={-1} role="alert" className="sourcing-contract-return-error">{contractReturnError}</p> : null}
                {contractReturnNotice ? <p role="status" className={`sourcing-contract-return-feedback sourcing-contract-return-feedback--${contractReturnNotice.tone}`}>{contractReturnNotice.message}</p> : null}
                <details className="sourcing-contract-return-facts" open={!window.matchMedia("(max-width: 768px)").matches}>
                  <summary className={`sourcing-contract-return-status--${contractReturn.contractReturnStatus}`}>{contractReturn.contractReturnCycleId ? "本次合同回签时效" : "首次回签时效"} · {sourcingContractReturnLabel(contractReturn)}</summary>
                  <dl className="sourcing-finance-reference">
                    <div><dt>合同生成时间</dt><dd>{contractReturn.contractGeneratedAt?formatDateTime(contractReturn.contractGeneratedAt):"—"}</dd></div>
                    <div><dt>回传截止时间</dt><dd>{contractReturn.contractReturnDueAt?formatDateTime(contractReturn.contractReturnDueAt):"待合同生成"}</dd></div>
                    <div><dt>实际回传时间</dt><dd>{contractReturn.contractReturnedAt?formatDateTime(contractReturn.contractReturnedAt):"—"}</dd></div>
                    <div><dt>上传人</dt><dd>{contractReturn.uploadedByName??"—"}</dd></div>
                    <div><dt>{contractReturn.contractReturnCycleId ? "本次回签状态" : "首次回签状态"}</dt><dd className={`sourcing-contract-return-status sourcing-contract-return-status--${contractReturn.contractReturnStatus}`}>{sourcingContractReturnLabel(contractReturn)}</dd></div>
                  </dl>
                </details>
              </> : null}
              {editingStyles && canEditStyles ? <form className="sourcing-style-editor" onSubmit={event=>{event.preventDefault();void saveStyles();}}>
                {duplicateStyleEdit ? <p id="sourcing-revise-duplicate-style" role="alert">{duplicateStyleEdit.message}</p> : null}
        {styleEdits.map((line,index)=><div className="sourcing-style-editor__row" key={line.position}>
          <strong>{item.lineItems[index]?.color ?? "款色"} · {formatBusinessDecimal(item.lineItems[index]?.quantity ?? 0)} 件</strong>
          <label><span>正式款号</span><input maxLength={100} value={line.styleNo}
            aria-invalid={duplicateStyleEdit?.index === index || undefined} aria-describedby={duplicateStyleEdit?.index === index ? "sourcing-revise-duplicate-style" : undefined}
            onChange={event=>{setStyleEdits(current=>current.map(row=>row.position===line.position?{...row,styleNo:event.target.value}:row));styleEditKey.current=null;}} /></label>
          <label><span>代用款号</span><input maxLength={100} value={line.alternateStyleNo} onChange={event=>{setStyleEdits(current=>current.map(row=>row.position===line.position?{...row,alternateStyleNo:event.target.value}:row));styleEditKey.current=null;}} /></label>
        </div>)}
        <div className="sourcing-style-editor__actions"><button className="dx-button" disabled={busy || !!duplicateStyleEdit} type="submit">保存款号</button><button className="dx-button dx-button--secondary" disabled={busy} type="button" onClick={()=>setEditingStyles(false)}>取消</button></div>
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

          {!hideFinanceForMerchandiser && item.status === "pending_finance_reconciliation" && selectedNode === "finance" ? <Surface className="rework-detail-node-preview sourcing-finance-panel">
            <h2>05 · 财务核对</h2>
            <p>财务在付款、对账时核对系统信息；核对不影响跟单派单和生产。加工厂、单价、数量及总额只读。</p>
            {item.decision ? <dl className="sourcing-finance-reference" aria-label="老板批准的选厂决定">
              <div><dt>批准加工厂</dt><dd>{item.decision.supplierName}</dd></div>
              <div><dt>批准单价</dt><dd>{sourcingPriceSummary(item.decision)}</dd></div>
              <div><dt>批准数量</dt><dd>{formatBusinessDecimal(item.decision.quantity)} 件</dd></div>
              <div><dt>批准总额</dt><dd>{formatBusinessCurrency(item.decision.totalAmount)}</dd></div>
              <div><dt>对应合同</dt><dd>{contract?.status === "ready" ? `${contract.contractNumber} · V${contract.contractVersion}` : "合同 PDF 尚未就绪"}</dd></div>
            </dl> : null}
            {item.decision && item.decision.sourceType !== "factory_change" && item.decision.linePrices.length > 1 ? <ResponsiveFactsTable
              caption="财务逐款核对明细" mobileLayout="compact"
              rows={item.decision.linePrices} rowKey={price => price.position}
              columns={[
                { key: "style", label: "款号", mobileHeading: true, render: price => item.lineItems.find(line => line.position === price.position)?.styleNo ?? "历史款号缺失" },
                { key: "color", label: "颜色", mobileHeading: true, render: price => item.lineItems.find(line => line.position === price.position)?.color ?? "历史颜色缺失" },
                { key: "quantity", label: "批准数量", render: price => `${formatBusinessDecimal(price.quantity)} 件` },
                { key: "price", label: "批准价", render: price => historicalSourcingPrice(price.unitPrice) },
                { key: "amount", label: "批准行金额", render: price => formatBusinessCurrency(price.totalAmount) },
              ]} /> : null}
            {hasPendingFactoryChange ? <p className="sourcing-finance-waiting">订单转厂正在审批，财务核对已暂停；转厂生效或驳回后会自动恢复。</p> : contract?.status !== "ready" ? <p className="sourcing-finance-waiting">系统合同 PDF 未就绪，暂不能提交财务核对。</p> : canFinance ? <div className="sourcing-finance-confirmation">
              <p>请对照已批准的选厂决定确认上述四项事实。若发现不一致，只记录差异项和说明，由生产管理核实；财务不能在此页改写业务数据。</p>
              <div className="sourcing-finance-actions">
                <button className="dx-button dx-button--primary" type="button" disabled={busy} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/finance-reconciliations`, { result: "match" }, "与合同一致，订单已归档")}>确认与合同一致</button>
                <button className="dx-button dx-button--primary" type="button" disabled={busy} onClick={() => { setMessage(""); setFinanceDifferenceOpen(true); }}>发现不一致</button>
              </div>
              {financeDifferenceOpen ? <SourcingFinanceDifferenceDialog busy={busy} onClose={() => setFinanceDifferenceOpen(false)}>
                <form onSubmit={event => {
                  event.preventDefault();
                  if (busy || !financeReview.differenceFields.length || !financeReview.differenceReason.trim()) return;
                  void submit(`sourcing/cases/${item.sourcingCaseId}/finance-reconciliations`, { result: "difference", differenceFields: financeReview.differenceFields, differenceReason: financeReview.differenceReason.trim() }, "财务差异已提交生产管理核实");
                }}>
                  <div className="system-dialog__copy"><h2>发现不一致</h2><p>请选择差异项目并填写说明。</p></div>
                  <fieldset disabled={busy}><legend>差异项目</legend>{([
                    ["supplier", "加工厂"], ["unit_price", "单价"], ["quantity", "数量"], ["total_amount", "总额"],
                  ] as const).map(([value, label]) => <label key={value}><input type="checkbox" checked={financeReview.differenceFields.includes(value)} onChange={(event) => {
                    setFinanceReview((current) => ({ ...current, differenceFields: event.target.checked ? [...current.differenceFields, value] : current.differenceFields.filter((field) => field !== value) })); actionKey.current = null;
                  }} />{label}</label>)}</fieldset>
                  <label className="system-dialog__field"><span>差异说明</span><input disabled={busy} required value={financeReview.differenceReason} maxLength={500} onChange={(event) => { setFinanceReview({ ...financeReview, differenceReason: event.target.value }); actionKey.current = null; }} /></label>
                  {message ? <p role="status">{message}</p> : null}
                  <div className="system-dialog__actions">
                    <button className="dx-button dx-button--secondary" type="button" disabled={busy} onClick={() => setFinanceDifferenceOpen(false)}>取消</button>
                    <button className="dx-button dx-button--primary" type="submit" disabled={busy || !financeReview.differenceFields.length || !financeReview.differenceReason.trim()}>{busy ? "正在提交…" : "提交差异核实"}</button>
                  </div>
                </form>
              </SourcingFinanceDifferenceDialog> : null}
            </div> : <p>当前账号仅可查看，本节点由财务核对。</p>}
          </Surface> : null}

                    {!hideFinanceForMerchandiser && item.status === "pending_exception_verification" && selectedNode === "finance" ? <Surface className="rework-detail-node-preview">
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
          {message ? <p className="sourcing-action-message" role="status">{message}</p> : null}
        </section>
          {(canManage||canAct(user,"owner_group","sourcing:owner:approve"))&&item.approvalSnapshot?<SourcingPriceReapplicationPanel item={item} contract={contract}
            canStart={canManage} canReview={canAct(user,"owner_group","sourcing:owner:approve")} isRoot={user?.isRoot===true} userId={user?.id??""} busy={busy}
            read={()=>request(`sourcing/cases/${item.sourcingCaseId}/price-reapplications/current`,SourcingPriceReapplicationStateSchema)}
            save={async(path,body,key)=>{setBusy(true);try{await requestSubmission(path,SourcingCaseSummarySchema,{method:"POST",headers:{"idempotency-key":key},body:JSON.stringify(body)});await load();}finally{setBusy(false);}}}/>:null}
          {transferNodeRole ? <section className="sourcing-factory-change" aria-label="订单转厂">
            {!item.decision ? <button className="dx-button dx-button--primary" type="button" disabled title="生产管理首次提交加工厂和单价后开放">订单转厂</button> : factoryChange?.status === "pending_management" ? <>
              <h2>订单转厂</h2>
              <p><strong>{factoryChange.proposedSupplierName}</strong> · {formatBusinessCurrency(factoryChange.proposedUnitPrice)}/件 · {formatBusinessCurrency(factoryChange.proposedTotalAmount)}。跟单申请，等待生产管理审批。</p>
              {factoryChange.proposedProcesses?.length ? <p>申请工艺：{factoryChange.proposedProcesses.join("、")}</p> : null}
              {factoryChange.changesDeliveryDate ? <p>申请交货日期：{factoryChange.proposedDeliveryDate}，随转厂批准生效。</p> : null}
              {canReviewManagementTransfer ? <div className="sourcing-factory-change__review">
                <label><span>审批说明</span><input maxLength={500} value={factoryChangeReviewReason} onChange={(event) => { setFactoryChangeReviewReason(event.target.value); actionKey.current = null; }} /></label>
                <div><button className="dx-button dx-button--primary" type="button" disabled={busy || !factoryChangeReviewReason.trim()} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/factory-changes/${factoryChange.factoryChangeRequestId}/decision`, { decision: "approved", verificationReason: factoryChangeReviewReason.trim() }, factoryChange.requiresOwnerApproval ? "生产管理已通过，转老板审批" : "转厂已生效", true)}>批准转厂</button><button className="dx-button dx-button--secondary" type="button" disabled={busy || !factoryChangeReviewReason.trim()} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/factory-changes/${factoryChange.factoryChangeRequestId}/decision`, { decision: "rejected", verificationReason: factoryChangeReviewReason.trim() }, "转厂申请已驳回", true)}>驳回</button></div>
              </div> : null}
            </> : factoryChange?.status === "pending_owner" ? <>
              <h2>订单转厂</h2>
              <p><strong>{factoryChange.proposedSupplierName}</strong> · {formatBusinessCurrency(factoryChange.proposedUnitPrice)}/件，超过当前单价，等待老板批准。</p>
              {factoryChange.proposedProcesses?.length ? <p>申请工艺：{factoryChange.proposedProcesses.join("、")}</p> : null}
              {factoryChange.changesDeliveryDate ? <p>申请交货日期：{factoryChange.proposedDeliveryDate}，随转厂批准生效。</p> : null}
              {canOwner ? <div className="sourcing-factory-change__review">
                <label><span>审批说明</span><input maxLength={500} value={factoryChangeReviewReason} onChange={(event) => { setFactoryChangeReviewReason(event.target.value); actionKey.current = null; }} /></label>
                <div><button className="dx-button dx-button--primary" type="button" disabled={busy || !factoryChangeReviewReason.trim()} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/factory-changes/${factoryChange.factoryChangeRequestId}/owner-decision`, { decision: "approved", verificationReason: factoryChangeReviewReason.trim() }, "老板已批准，转厂生效", true)}>批准转厂</button><button className="dx-button dx-button--secondary" type="button" disabled={busy || !factoryChangeReviewReason.trim()} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/factory-changes/${factoryChange.factoryChangeRequestId}/owner-decision`, { decision: "rejected", verificationReason: factoryChangeReviewReason.trim() }, "老板已驳回转厂", true)}>驳回</button></div>
              </div> : null}
            </> : canInitiateTransfer ? <>
              <button className="dx-button dx-button--primary" type="button" aria-expanded={transferFormOpen} aria-controls="sourcing-transfer-form" onClick={() => { setFactoryChangeFeedback(null); setTransferFormOpen(value => !value); }}>订单转厂</button>
              {transferFormOpen ? <div id="sourcing-transfer-form" className="sourcing-transfer-form">
              <p>当前：{item.decision.supplierName} · {formatBusinessCurrency(item.decision.unitPrice)}/件。新单价不高于当前价时按角色规则直接生效；超过时交老板批准。</p>
              <div className="sourcing-form-grid">
                <label><span>新加工厂</span><SearchableSelect value={factoryChangeDraft.supplierId} onChange={(event) => { setFactoryChangeDraft({ ...factoryChangeDraft, supplierId: event.target.value }); actionKey.current = null; }}><option value="">请选择不同的加工厂</option>{factories.filter((factory) => factory.supplierId !== item.decision?.supplierId).map((factory) => <option value={factory.supplierId} key={factory.supplierId}>{factory.supplierName}</option>)}</SearchableSelect></label>
                <label><span>新加工单价</span><input inputMode="decimal" value={activeBusinessInput === "factory-change-unit-price" && factoryChangeUnitPriceEdited ? factoryChangeDraft.unitPrice : businessInputValue(factoryChangeDraft.unitPrice)} onFocus={() => setActiveBusinessInput("factory-change-unit-price")} onBlur={() => setActiveBusinessInput(null)} onChange={(event) => { setFactoryChangeUnitPriceEdited(true); setFactoryChangeDraft({ ...factoryChangeDraft, unitPrice: businessInputChange(event.target.value) }); actionKey.current = null; }} /></label>
                <label><span>新总额</span><input readOnly value={businessInputValue(totalPreview(factoryChangeDraft.unitPrice, item.orderQuantity))} /></label>
                <p className="sourcing-factory-change__delta">相对当前单价：<strong>{transferPriceDelta ?? "—"}</strong></p>
                <label className="sourcing-form-wide sourcing-transfer-craft-toggle"><input type="checkbox" checked={factoryChangeDraft.craftNames !== undefined} onChange={event => {
                  setFactoryChangeDraft(current => ({ ...current, craftNames: event.target.checked ? (item.processes.length ? [...item.processes] : [""]) : undefined })); actionKey.current = null;
                }} /><span>修改工艺</span></label>
                {factoryChangeDraft.craftNames ? <section className="sourcing-process-editor sourcing-form-wide" aria-label="转厂工艺及承包范围">
                  <div className="sourcing-process-editor__heading"><strong>新工艺及承包范围（必填）</strong><button type="button" disabled={factoryChangeDraft.craftNames.length >= MAX_SOURCING_PROCESSES} onClick={() => {setFactoryChangeDraft(current => ({...current,craftNames:[...(current.craftNames ?? []),""]})); actionKey.current=null;}}>＋ 新增工艺</button></div>
                  <div className="sourcing-process-editor__list">{factoryChangeDraft.craftNames.map((name,index) => <div className="sourcing-process-row" key={index}>
                    <b>{String(index+1).padStart(2,"0")}</b><label><span className="visually-hidden">第 {index+1} 项转厂工艺</span><input list="sourcing-transfer-craft-options" value={name} maxLength={100} aria-invalid={Boolean(transferCraftError)} aria-describedby={transferCraftError ? "sourcing-transfer-craft-error" : undefined} onFocus={() => setActiveCraftQuery(name)} onChange={event => {setFactoryChangeDraft(current => ({...current,craftNames:current.craftNames?.map((value,i)=>i===index?event.target.value:value)}));setActiveCraftQuery(event.target.value);actionKey.current=null;}} placeholder="选择已有工艺或输入新工艺" /></label>
                    <button type="button" aria-label={`删除第 ${index+1} 项转厂工艺`} onClick={() => {setFactoryChangeDraft(current => ({...current,craftNames:current.craftNames?.filter((_,i)=>i!==index)}));actionKey.current=null;}}>删除</button>
                  </div>)}</div>
                  {!factoryChangeDraft.craftNames.length ? <button type="button" onClick={() => {setFactoryChangeDraft(current => ({...current,craftNames:[""]}));actionKey.current=null;}}>选择工艺</button> : null}
                  <datalist id="sourcing-transfer-craft-options">{craftCatalog.map(craft => <option key={craft.craftId} value={craft.craftName}>{craft.craftCode}</option>)}</datalist>
                  {transferCraftError ? <p id="sourcing-transfer-craft-error" role="status">{transferCraftError}</p> : null}
                </section> : null}
                {canChangeTransferDate ? <>
                  <label className="sourcing-transfer-date-toggle"><input type="checkbox" checked={factoryChangeDraft.deliveryDate !== undefined} onChange={event=>{setFactoryChangeDraft(current=>({...current,deliveryDate:event.target.checked ? item.deliveryDate ?? "" : undefined}));actionKey.current=null;}} /><span>修改交货日期</span></label>
                  {factoryChangeDraft.deliveryDate !== undefined ? <label><span>转厂后交货日期</span><input type="date" aria-label="转厂后交货日期" aria-describedby={transferDateError ? "sourcing-transfer-date-error" : undefined} required min={item.estimatedCutPieceSendDate ?? undefined} value={factoryChangeDraft.deliveryDate} aria-invalid={Boolean(transferDateError)} onChange={event=>{setFactoryChangeDraft(current=>({...current,deliveryDate:event.target.value}));actionKey.current=null;}} />{transferDateError ? <small id="sourcing-transfer-date-error" role="alert">{transferDateError}</small> : null}</label> : null}
                </> : null}
                <label className="sourcing-form-wide"><span>转厂原因</span><input maxLength={500} value={factoryChangeDraft.changeReason} onChange={(event) => { setFactoryChangeDraft({ ...factoryChangeDraft, changeReason: event.target.value }); actionKey.current = null; }} /></label>
                <button className="dx-button dx-button--primary" type="button" disabled={busy || !factoryChangeDraft.supplierId || !factoryChangeDraft.unitPrice || !factoryChangeDraft.changeReason.trim() || Boolean(transferCraftError) || Boolean(transferDateError)} onClick={() => void submit(transferRequestPath, { supplierId: factoryChangeDraft.supplierId, unitPrice: factoryChangeDraft.unitPrice, changeReason: factoryChangeDraft.changeReason.trim(), ...(factoryChangeDraft.craftNames ? { craftNames: factoryChangeDraft.craftNames.map(name => name.trim()) } : {}), ...(canChangeTransferDate && factoryChangeDraft.deliveryDate !== undefined ? {deliveryDate:factoryChangeDraft.deliveryDate} : {}) }, transferNodeRole === "owner_group" ? "老板发起的转厂已直接生效" : transferNodeRole === "production_management" && (transferPriceDelta?.startsWith("+") !== true) ? "转厂已生效" : "转厂申请已提交", true)}>提交转厂</button>
              </div>
            </div> : null}
            </> : <p>当前账号可查看转厂记录，但不能在本节点发起。</p>}
            {factoryChangeFeedback?.sourcingCaseId === sourcingCaseId ? <p ref={factoryChangeFeedbackRef}
              className="sourcing-action-message" role={factoryChangeFeedback.kind === "error" ? "alert" : "status"}
              tabIndex={-1} style={{ overflowWrap: "anywhere" }}>
              {factoryChangeFeedback.message}{factoryChangeFeedback.requestId ? <>（请求编号：{factoryChangeFeedback.requestId}）</> : null}
            </p> : null}
          </section> : null}
        {item.status === "pending_owner_approval" && selectedNode === "owner" && canOwner ? <ActionBar className="sourcing-owner-actions" aria-label="老板审批操作">
          <button className="dx-button dx-button--secondary sourcing-owner-reject" type="button" disabled={busy} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/owner-decisions`, { decision: "rejected" }, "已驳回生产管理重新调整")}>驳回并退回生产管理</button>
          <button className="dx-button dx-button--primary" type="button" disabled={busy} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/owner-decisions`, { decision: "approved" }, "老板已批准")}>批准方案</button>
        </ActionBar> : null}
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
