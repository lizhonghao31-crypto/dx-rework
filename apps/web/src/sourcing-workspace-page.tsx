import { PoDateSummary } from "./po-delivery-dates.js";
import { changePoDate, inheritPoDate, removePoDateOverride } from "./po-date-input-defaults.js";
import { type PoDeliveryDate } from "@dx-rework/contracts";
import {FactorySettlementPanel} from "./factory-settlement-panel.js";
import { contractReturnFileError, finishContractReturnUpload, type ContractReturnUpload } from "./sourcing-contract-return-upload.js";
import {readBudgetSourcingDraft,saveBudgetSourcingDraft,clearBudgetSourcingDraft,recoverBudgetSourcingManual,type BudgetSourcingDraft} from "./budget-sourcing-draft.js";
import {registerInternalNavigationGuard} from "./internal-navigation.js";
import type {BudgetSheet} from "@dx-rework/contracts/digital-budget";
import type { BudgetSourcingPreparation } from "@dx-rework/contracts/digital-budget";
import { digitalRequest } from "./digital-production-api.js";
import { SourcingReturnDialog } from "./sourcing-return-dialog.js";
import { isMerchandiserOnly } from "./sourcing-role-visibility.js";
import { sourcingContractReturnBadgeLabel, sourcingContractReturnLabel } from "./sourcing-contract-return-presentation.js";
import { ContractInformationRefresh } from "./contract-information-refresh.js";
import { sourcingDatesValid, SOURCING_DATE_ORDER_ERROR } from "@dx-rework/contracts";
import { moduleCanWrite } from "./member-module-policy.js";
import { todoReturnPath } from "./todo-query-state.js";
import { cockpitReturnPath } from "./digital-journey-cockpit-model.js";
import {WorkAnalysisPanel} from "./work-analysis-panel.js";
import { factoryChangeTotalPreview, isNewSourcingPrice, newSourcingPriceDisplay, historicalSourcingPrice, sourcingPriceSummary, sourcingLinePricing, sourcingDeleteConfirmation, sourcingDecisionNeedsReason } from "./sourcing-price-presentation.js";
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
  SourcingTimelineResponseSchema,
  UploadIntentResponseSchema,
  duplicateSourcingLineMessage,
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
import { Button, DecisionSummary, ActionBar, ImageStrip, KeyFacts, ResponsiveFactsTable, WorkflowRail, StatusBadge, Surface } from "@dx-rework/ui";
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
import { validateSourcingCreate, validateSourcingDecision, validateSourcingPrices } from "./sourcing-submit-validation.js";
import "./rework-detail.css";
import "./rework-detail-compact.css";
import "./sourcing-workspace.css";
import "./order-overview-responsive.css";
import "./sourcing-governed.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

const STATUS_LABELS: Readonly<Record<SourcingCaseStatus, string>> = {
  pending_merchandiser_correction: "待跟单修改",
  pending_ie_quote: "待 IE 报价",
  pending_management_decision: "待供应链总监调价选厂",
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
  lineId?: string;
  factoryDeliveryDate?: string;
  customerWarehouseArrivalDate?: string | null;
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
type FactoryChangeDraft = Readonly<{ supplierId: string; unitPrice: string; changeReason: string }>;
type ContractSupplementDraft = Readonly<Partial<Record<SourcingContractMissingField, string>>>;

class SourcingRequestError extends SubmissionRequestError {}

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
    throw new SourcingRequestError(body?.error?.message ?? "操作失败，请稍后重试", body?.error?.code, response.status);
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

function sourcingPoDates(item:Pick<SourcingCaseSummary,"lineItems">):PoDeliveryDate[]|undefined {
  if(!item.lineItems.every(line=>Boolean(line.lineId)))return undefined;
  return item.lineItems.map(line=>({lineId:line.lineId!,position:line.position,poNumber:line.styleNo,color:line.color??"未登记颜色",
    customerWarehouseArrivalDate:line.customerWarehouseArrivalDate??null,factoryDeliveryDate:line.factoryDeliveryDate??null,sampleTargetDate:null}));
}
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
          {sourcingPoDates(item)?<div><dt>PO 双交期</dt><dd><PoDateSummary lines={sourcingPoDates(item)}/></dd></div>:<div><dt>交货日期</dt><dd>{item.deliveryDate ?? "—"}</dd></div>}
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
          ? <SourcingNodeHistoryPage sourcingCaseId={sourcingCaseId} node={sourcingWorkflowNodeFromSearch()!} returnTo={todoReturnPath(window.location.search) ?? sourcingReturnPath(window.location.search) ?? cockpitReturnPath(window.location.search)} />
          : <OrderDetailPage sourcingCaseId={sourcingCaseId} user={user} />)
        : null}
      </div>
    </Shell>
  );
}

function CreateOrderPage({ user, correction }: { user: AuthorizedUser | null; correction?: {item:SourcingCaseSummary; attachments:readonly SourcingAttachment[]} }) {
  const [budgetOrderId] = useState(() => correction ? null : new URLSearchParams(window.location.search).get("budget"));
  const [budgetPreparation, setBudgetPreparation] = useState<BudgetSourcingPreparation | null>(null);
  const [budgetNeedsReview,setBudgetNeedsReview]=useState(false),[budgetDraftStatus,setBudgetDraftStatus]=useState(""),[budgetSourceOpen,setBudgetSourceOpen]=useState(false);
  const pendingBudgetDraft=useRef<BudgetSourcingDraft|null>(null),savedBudgetFingerprint=useRef(""),initialBudgetScope=useRef("");
  const budgetGuard=useRef({dirty:false,busy:false,confirmed:false});
  const [gender, setGender] = useState<"" | "男装" | "女装">(correction?.item.gender ?? "");
  const [styleName, setStyleName] = useState(correction?.item.styleName ?? "");
  const [additionalMerchandiserUserId, setAdditionalMerchandiserUserId] = useState("");
  const [merchandisers, setMerchandisers] = useState<readonly {userId:string;displayName:string}[]>([]);
  const [styleCatalog, setStyleCatalog] = useState<readonly { styleId: string; styleName: string }[]>([]);
  const [estimatedCutPieceSendDate, setEstimatedCutPieceSendDate] = useState(correction?.item.estimatedCutPieceSendDate ?? "");
  const [deliveryDate, setDeliveryDate] = useState(correction?.item.deliveryDate ?? "");
  const [lineItems, setLineItems] = useState<SourcingLineDraft[]>(correction ? correction.item.lineItems.map(line => ({
    styleNo:line.formalStyleNo === undefined ? line.styleNo : line.formalStyleNo ?? "", alternateStyleNo:line.alternateStyleNo ?? "",
    ...(line.lineId?{lineId:line.lineId,factoryDeliveryDate:line.proposedFactoryDeliveryDate ?? line.factoryDeliveryDate ?? ""}:{}),
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
  const factoryDateOverrides = useRef(new Set<number>());
  const previewUrls = useRef<string[]>([]);
  const restoredDraftUserId = useRef("");
  const canCreate = canAct(user, "order_merchandiser", "sourcing:inquiry:create");
  const digitalPo = Boolean(budgetOrderId) || Boolean(correction?.item.lineItems.some(line=>line.lineId));
  const effectiveDeliveryDate = digitalPo ? lineItems.map(line=>line.factoryDeliveryDate ?? "").filter(Boolean).sort()[0] ?? "" : deliveryDate;
  const applyFactoryDefault = async () => {
    if(!deliveryDate)return;
    if(lineItems.some(line=>line.factoryDeliveryDate && line.factoryDeliveryDate!==deliveryDate)
      && !await confirmInApp("应用默认日期将覆盖已经单独填写的 PO 工厂交期，确认继续吗？"))return;
    factoryDateOverrides.current=new Set();
    setLineItems(current=>current.map(line=>({...line,factoryDeliveryDate:deliveryDate})));createKey.current=null;
  };
  const duplicateLinesMessage = duplicateSourcingLineMessage(lineItems);
  const restoreBudgetManual=(prepared:BudgetSourcingPreparation,draft:BudgetSourcingDraft)=>{
    const restored=recoverBudgetSourcingManual(prepared,draft);
    setAdditionalMerchandiserUserId(restored.additionalMerchandiserUserId);setEstimatedCutPieceSendDate(restored.estimatedCutPieceSendDate);setDeliveryDate(restored.deliveryDate);
    setLineItems(restored.lines.map(line=>({...line,quantity:String(line.quantity)})));setImages(restored.images.map(image=>({...image,previewUrl:attachmentUrl(image.attachmentId,"preview")})));
    setBudgetDraftStatus(`已恢复当前账号的人工补填${restored.discarded?`；${restored.discarded}项不再适用，请重新填写`:""}。`);
  };
  useEffect(() => {
    if (!budgetOrderId || !canCreate || !user?.id) return;
    let live = true;
    void (async()=>{
      const current=await digitalRequest<BudgetSheet>(`orders/${budgetOrderId}/budget`);
      if(current.status!=="published"||!current.canSubmitSourcing)throw Error(current.sourcingCaseId?"该母单已关联外发订单，请打开原订单":"请先发布当前有效预算，并由本单主跟单发起外发");
      const prepared=await digitalRequest<BudgetSourcingPreparation>(`orders/${budgetOrderId}/budget/prepare-sourcing`, "POST", { expectedVersion: current.version });
      if (!live) return;
      let previous:BudgetSourcingDraft|null=null;try{previous=readBudgetSourcingDraft(window.localStorage,{userId:user.id,productionOrderId:budgetOrderId,budgetVersion:prepared.budgetVersion});}catch{setBudgetDraftStatus("本机存储不可用，当前表单仍可填写与正式提交。");}
      const staleUrl=Number(new URLSearchParams(window.location.search).get("budgetVersion"))!==prepared.budgetVersion;
      const changed=!!previous&&(previous.budgetVersion!==prepared.budgetVersion||previous.orderVersion!==prepared.orderVersion);
      pendingBudgetDraft.current=previous;setBudgetNeedsReview(staleUrl||changed);
      setAdditionalMerchandiserUserId("");setEstimatedCutPieceSendDate("");setDeliveryDate("");setBudgetSourceOpen(false);
      setBudgetPreparation(prepared);setGender(prepared.gender);setStyleName(prepared.styleName);setDaxingUnitPrice(prepared.daxingUnitPrice);
      factoryDateOverrides.current=new Set();
      setLineItems(prepared.lineItems.map(line => ({lineId:line.lineId, factoryDeliveryDate:"", customerWarehouseArrivalDate:line.customerWarehouseArrivalDate ?? null, styleNo: line.styleNo, alternateStyleNo: line.alternateStyleNo, color: line.color, quantity: String(line.quantity) })));
      setImages(prepared.images.map(image => ({ ...image, previewUrl: attachmentUrl(image.attachmentId, "preview") })));
      if(previous&&!changed&&!staleUrl)restoreBudgetManual(prepared,previous);
      else if(staleUrl||changed)setBudgetDraftStatus(`预算或母单来源已变化，当前有效预算第${prepared.budgetVersion}版；请核对后继续。`);
      const url=new URL(window.location.href);url.searchParams.set("budgetVersion",String(prepared.budgetVersion));window.history.replaceState(window.history.state,"",url);
    })().catch(reason => { if (live) setMessage(reason.message); });
    return () => { live = false; };
  }, [budgetOrderId, canCreate,user?.id]);
  const budgetManual=budgetPreparation&&user?.id?{userId:user.id,productionOrderId:budgetPreparation.productionOrderId,budgetVersion:budgetPreparation.budgetVersion,orderVersion:budgetPreparation.orderVersion,
    additionalMerchandiserUserId,estimatedCutPieceSendDate,deliveryDate,lines:lineItems.filter(line=>line.lineId).map(line=>({lineId:line.lineId!,factoryDeliveryDate:line.factoryDeliveryDate??"",styleNo:line.styleNo,imageAttachmentId:line.imageAttachmentId??""})),
    extraImages:images.filter(image=>!budgetPreparation.images.some(source=>source.attachmentId===image.attachmentId)).map(({attachmentId,filename,mimeType})=>({attachmentId,filename,mimeType}))}:null;
  const budgetFingerprint=budgetManual?JSON.stringify(budgetManual):"";
  const scopeIdentity=budgetManual?`${budgetManual.userId}:${budgetManual.productionOrderId}:${budgetManual.budgetVersion}:${budgetManual.orderVersion}`:"";
  if(scopeIdentity&&scopeIdentity!==initialBudgetScope.current){initialBudgetScope.current=scopeIdentity;savedBudgetFingerprint.current=budgetFingerprint;}
  budgetGuard.current.dirty=!budgetNeedsReview&&!!budgetFingerprint&&budgetFingerprint!==savedBudgetFingerprint.current;
  budgetGuard.current.busy=busy||uploading||feedback.uncertain;
  const persistBudgetManual=()=>{
    if(!budgetManual||budgetNeedsReview||!canCreate||budgetGuard.current.confirmed)return;
    try{saveBudgetSourcingDraft(window.localStorage,{...budgetManual,savedAt:new Date().toISOString()});savedBudgetFingerprint.current=budgetFingerprint;budgetGuard.current.dirty=false;setBudgetDraftStatus("人工补填已保存在当前账号 / 母单 / 预算版本的本机草稿。");}
    catch{setBudgetDraftStatus("本机草稿未保存成功，当前填写仍在，请重试保存后离开。");}
  };
  useEffect(()=>{
    if(!budgetFingerprint||budgetNeedsReview||uploading||busy||budgetGuard.current.confirmed)return;
    const timer=window.setTimeout(persistBudgetManual,600);return()=>window.clearTimeout(timer);
  },[budgetFingerprint,budgetNeedsReview,uploading,busy]);
  useEffect(()=>{
    if(!budgetOrderId)return;
    const unregister=registerInternalNavigationGuard(async()=>{const state=budgetGuard.current;if(state.confirmed)return true;if(state.busy)return false;if(!state.dirty)return true;return await confirmInApp("本单人工补填尚未保存，确定离开？")&&!budgetGuard.current.busy;});
    const beforeUnload=(event:BeforeUnloadEvent)=>{const state=budgetGuard.current;if(!state.confirmed&&(state.dirty||state.busy)){event.preventDefault();event.returnValue="";}};
    window.addEventListener("beforeunload",beforeUnload);return()=>{unregister();window.removeEventListener("beforeunload",beforeUnload);};
  },[budgetOrderId]);
  const acceptBudgetReview=()=>{
    if(!budgetPreparation)return;
    if(pendingBudgetDraft.current)restoreBudgetManual(budgetPreparation,pendingBudgetDraft.current);
    else setBudgetDraftStatus("已核对当前有效预算及母单资料，请补齐加工厂日期后正式提交。");
    pendingBudgetDraft.current=null;setBudgetNeedsReview(false);createKey.current=null;
  };


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
    if (correction || budgetOrderId || !user?.id || restoredDraftUserId.current === user.id) return;
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
  }, [user?.id, correction, budgetOrderId]);

  useEffect(() => () => {
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.current = [];
  }, []);

  const updateLineItem = (
    index: number,
    field: keyof SourcingLineDraft,
    value: string,
  ): void => {
    if (digitalPo && field === "factoryDeliveryDate") {
      const overrides=new Set(factoryDateOverrides.current);
      if(index>0)overrides.add(index);
      factoryDateOverrides.current=overrides;
      setLineItems(current=>changePoDate(current,"factoryDeliveryDate",index,value,overrides,!correction));
    } else setLineItems((current) => current.map((line, currentIndex) => (
      currentIndex === index ? { ...line, [field]: value } : line
    )));
    createKey.current = null;
  };

  const addLineItem = (): void => {
    if (lineItems.length >= MAX_SOURCING_LINE_ITEMS) {
      setMessage(`每张订单最多登记 ${MAX_SOURCING_LINE_ITEMS} 行款色`);
      return;
    }
    setLineItems((current) => [...current, inheritPoDate({
      styleNo: "",
      alternateStyleNo: "",
      color: "",
      quantity: "",
    } as SourcingLineDraft, digitalPo ? current[0] : undefined, "factoryDeliveryDate")]);
    createKey.current = null;
  };

  const removeLineItem = async (index: number): Promise<void> => {
    if (lineItems.length === 1) return;
    if (!(await confirmInApp(`确认删除第 ${index + 1} 行未提交款色吗？`))) return;
    factoryDateOverrides.current=removePoDateOverride(factoryDateOverrides.current,index);
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
    if (budgetOrderId && (!budgetPreparation||budgetNeedsReview)) return;
    if (!canCreate) { await alertInApp("当前账号没有创建订单权限", { title: "无权执行此操作" }); return; }
    const normalizedDaxingPrice = businessInputChange(daxingUnitPrice).trim();
    const issues = validateSourcingCreate({ gender, styleName, estimatedCutPieceSendDate, deliveryDate:effectiveDeliveryDate, digitalPo,
      lineItems, daxingUnitPrice: normalizedDaxingPrice, imageCount: images.length, uploading, uploadFailed });
    const effectiveIssues = correction ? issues.filter(issue=>issue.fieldId!=="sourcing-create-budget") : issues;
    if (correction && !correctionReason.trim()) effectiveIssues.push({fieldId:"sourcing-correction-reason",message:"请填写修改说明"});
    if (effectiveIssues.length) { await feedback.reject(effectiveIssues); return; }
    const normalizedLines = lineItems.map((line) => ({
      ...(line.styleNo.trim() ? { styleNo: line.styleNo.trim() } : {}),
      ...(line.alternateStyleNo.trim() ? { alternateStyleNo: line.alternateStyleNo.trim() } : {}),
      ...(digitalPo?{lineId:line.lineId,factoryDeliveryDate:line.factoryDeliveryDate}:{}),
      color: line.color.trim(), quantity: Number(line.quantity),
      ...(line.imageAttachmentId ? { imageAttachmentId: line.imageAttachmentId } : {}),
    }));
    const requestKey = createKey.current ?? createClientRequestId();
    createKey.current = requestKey;
    const body = JSON.stringify({ gender, styleName: styleName.trim(), estimatedCutPieceSendDate, deliveryDate:effectiveDeliveryDate,
      lineItems: normalizedLines, ...(correction ? {expectedVersion:correction.item.version,reason:correctionReason.trim()} : {daxingUnitPrice: normalizedDaxingPrice,
        ...(additionalMerchandiserUserId ? {additionalMerchandiserUserId} : {})}),
      ...(budgetPreparation ? { digitalBudget: { productionOrderId: budgetPreparation.productionOrderId, budgetVersion: budgetPreparation.budgetVersion, orderVersion: budgetPreparation.orderVersion } } : {}),
      attachmentIds: images.map(image => image.attachmentId) });
    await feedback.run(async () => {
      // Same snapshot and key on recovery: the existing API checks its idempotency record first.
      const created = await requestWithStyleCheck(correction ? `sourcing/cases/${correction.item.sourcingCaseId}/corrections` : "sourcing/cases", SourcingCaseSummarySchema, {
        method: "POST", headers: { "idempotency-key": requestKey }, body,
      }, normalizedLines, true);
      feedback.confirmed();budgetGuard.current.confirmed=true;
      // A local storage failure after a confirmed write must never invite another submission.
      try { if (!correction && user?.id) {if(budgetPreparation)clearBudgetSourcingDraft(window.localStorage,{userId:user.id,productionOrderId:budgetPreparation.productionOrderId,budgetVersion:budgetPreparation.budgetVersion});else clearLocalSourcingDraft(user.id);} } catch { /* Navigation still proceeds. */ }
      window.location.assign(detailHref(created));
    });
  };

  return (
    <div className={`sourcing-workspace sourcing-workspace--create${digitalPo?" sourcing-workspace--create-digital-po":""}`}>
      <Header
        iconRoute="/ui/sourcing/create"
        title={correction ? "修改订单资料" : "创建订单"}
        badge="外发定价&选厂"
      />
      {budgetPreparation&&<section aria-label="本单预算来源"><p>客户：{budgetPreparation.customerCode??"未登记"} · 有效预算第{budgetPreparation.budgetVersion}版 · 母单版本{budgetPreparation.orderVersion}</p><p role="status">{budgetDraftStatus}</p>{budgetNeedsReview&&<Button onClick={acceptBudgetReview} disabled={busy||uploading}>已核对当前来源，沿用合法补填</Button>}{budgetPreparation.budgetRows&&<details onToggle={event=>setBudgetSourceOpen(event.currentTarget.open)}><summary>查看设计师预算项</summary>{budgetSourceOpen&&budgetPreparation.budgetRows.map(row=><p key={row.rowId}>{row.section} · {row.category} · {row.name} {row.specification} · 单耗：{row.consumption||"未填"} · 单价：{row.unitPrice||"未填"} 元/{row.unit||"未填单位"}</p>)}</details>}</section>}
      {correction ? <p role="status">退回原因：{correction.item.correctionReason}<a href={detailHref(correction.item)}>返回订单</a></p> : null}
      <SubmissionFeedback feedback={feedback} busy={busy} />
      <Surface className="sourcing-create-card">
        <fieldset className="sourcing-submission-fields" disabled={busy || feedback.uncertain || budgetNeedsReview}>
        <div className="section-title">
          <div><h2>订单资料</h2></div>
          <StatusBadge tone="info">跟单提交</StatusBadge>
        </div>
        <div className="sourcing-form-grid">
          {budgetPreparation?.contractDeliveryDate && <p>历史整单参考日期：{budgetPreparation.contractDeliveryDate}</p>}
          <div className={`sourcing-order-classification${correction ? "" : " sourcing-order-classification--additional"}`}>
            <label><span>性别（必填）</span><select disabled={Boolean(budgetOrderId)} {...feedback.field("sourcing-create-gender")} required value={gender} onChange={(event) => { setGender(event.target.value as typeof gender); createKey.current = null; }}><option value="">请选择</option><option value="男装">男装</option><option value="女装">女装</option></select></label>
            <label><span>款式（必填）</span><input readOnly={Boolean(budgetOrderId)} {...feedback.field("sourcing-create-style")} required list="sourcing-style-options" value={styleName} maxLength={100} onChange={(event) => { setStyleName(event.target.value); createKey.current = null; }} placeholder="搜索或输入，如梭织短裤" /></label>
            {!correction ? <label><span>添加跟单（选填）</span><select value={additionalMerchandiserUserId} onChange={event=>{setAdditionalMerchandiserUserId(event.target.value);createKey.current=null;}}><option value="">不添加</option>{additionalMerchandiserUserId && !merchandisers.some(person=>person.userId===additionalMerchandiserUserId) ? <option value={additionalMerchandiserUserId}>所选跟单已失效，请重选</option> : null}{merchandisers.map(person=><option key={person.userId} value={person.userId}>{person.displayName}</option>)}</select></label> : null}
            <datalist id="sourcing-style-options">{styleCatalog.map((style) => <option key={style.styleId} value={style.styleName} />)}</datalist>
          </div>
          <label><span>预计裁片发出日期（工厂发出，必填）</span><input type="date" required aria-required="true" value={estimatedCutPieceSendDate} {...feedback.field("sourcing-create-send-date")} onChange={(event) => { setEstimatedCutPieceSendDate(event.target.value); createKey.current = null; }} /></label>
          <label><span>{digitalPo?"默认加工厂交货日（选填）":"要求交货日期（到工厂，必填）"}</span><input type="date" required={!digitalPo} aria-required={!digitalPo} value={deliveryDate} {...feedback.field("sourcing-create-delivery-date")} onChange={(event) => { setDeliveryDate(event.target.value); createKey.current = null; }} />{digitalPo?<button type="button" className="dx-button dx-button--secondary" disabled={!deliveryDate} onClick={()=>void applyFactoryDefault()}>应用到全部 PO</button>:null}</label>
          <label><span>预算价（内部，必填）</span><input readOnly={!!correction || Boolean(budgetOrderId)} {...feedback.field("sourcing-create-budget")} value={activeCreateInput === "daxing" ? daxingUnitPrice : newSourcingPriceDisplay(daxingUnitPrice)} onFocus={() => setActiveCreateInput("daxing")} onBlur={() => setActiveCreateInput(null)} inputMode="decimal" onChange={(event) => { setDaxingUnitPrice(businessInputChange(event.target.value)); createKey.current = null; }} placeholder="请输入预算价" aria-invalid={!isNewSourcingPrice(daxingUnitPrice)} /></label>
          <section className="sourcing-line-editor sourcing-form-wide" aria-label="订单款色明细">
            <div className="sourcing-line-editor__heading">
              <div>
                <strong>款色明细</strong>
              </div>
              <div className="sourcing-line-editor__actions">
                <StatusBadge tone="info">合计 {formatBusinessDecimal(lineItems.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0))} 件</StatusBadge>
                <button className="dx-button dx-button--secondary" type="button" disabled={digitalPo || busy || uploading || lineItems.length >= MAX_SOURCING_LINE_ITEMS} onClick={addLineItem}>＋ 新增款色</button>
              </div>
            </div>
            <div className="sourcing-line-editor__list">
              {lineItems.map((line, index) => <article className="sourcing-line-row" key={index}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                <label><span>正式款号</span><input {...feedback.field(`sourcing-create-style-${index}`)} value={line.styleNo} maxLength={100} onChange={(event) => updateLineItem(index, "styleNo", event.target.value)} placeholder="可后补" /></label>
                <label><span>代用款号</span><input readOnly={digitalPo} value={line.alternateStyleNo} maxLength={100} onChange={(event) => updateLineItem(index, "alternateStyleNo", event.target.value)} placeholder="无正式款号时必填" /></label>
                <label><span>颜色</span><input readOnly={digitalPo} {...feedback.field(`sourcing-create-color-${index}`)} value={line.color} maxLength={100} onChange={(event) => updateLineItem(index, "color", event.target.value)} placeholder="必填" /></label>
                <label><span>数量</span><input readOnly={digitalPo} {...feedback.field(`sourcing-create-quantity-${index}`)} value={activeCreateInput === `quantity-${index}` ? line.quantity : businessInputValue(line.quantity)} onFocus={() => setActiveCreateInput(`quantity-${index}`)} onBlur={() => setActiveCreateInput(null)} inputMode="numeric" onChange={(event) => updateLineItem(index, "quantity", businessInputChange(event.target.value))} placeholder="整数" /></label>
                {digitalPo?<label><span>本 PO 加工厂交货日（必填）</span><input type="date" required value={line.factoryDeliveryDate ?? ""} {...feedback.field(`sourcing-create-factory-date-${index}`)} onChange={event=>updateLineItem(index,"factoryDeliveryDate",event.target.value)}/>{index===0&&!correction?<small>其余 PO 默认沿用，可单独修改。</small>:null}{line.customerWarehouseArrivalDate?<small>客户仓到货：{line.customerWarehouseArrivalDate}</small>:null}</label>:null}
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
                <button className="dx-button dx-button--secondary" type="button" aria-label={`删除第 ${index + 1} 行款色`} disabled={digitalPo || busy || uploading || lineItems.length === 1} onClick={() => void removeLineItem(index)}>删除</button>
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
          {duplicateLinesMessage || message ? <p role="status">{duplicateLinesMessage ?? message}</p> : null}
          {uploadFailed && !uploading ? <p role="alert">本次图片上传未完成，请重新选择图片上传成功后再提交。</p> : null}
          <ActionBar className="sourcing-create-actions">
            {!correction ? <button className="dx-button dx-button--secondary" type="button" disabled={busy || uploading} onClick={budgetOrderId?persistBudgetManual:saveLocalDraft}>保存草稿</button> : null}
            <button className="dx-button dx-button--primary" type="button" disabled={busy || feedback.uncertain || !canCreate || Boolean(budgetOrderId && (!budgetPreparation||budgetNeedsReview))} onClick={() => void createOrder()}>
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
  }, [debouncedSearch, debouncedStyleName, stage, gender, contractReturn, page, mode]);

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
              <option value="management">待供应链总监调价选厂</option>
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
  { key: "management", number: "03", label: "调价与选厂", role: "供应链总监" },
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
  const[factoryRemainingLines,setFactoryRemainingLines]=useState<ReturnType<typeof SourcingFactoryChangeStateResponseSchema.parse>["remainingLines"]>();
  const [factoryChange, setFactoryChange] = useState<SourcingFactoryChangeState | null>(null);
  const [contract, setContract] = useState<SourcingContractDocument | null>(null);
  const [contractReturn,setContractReturn] = useState<SourcingContractReturnResponse | null>(null);
  const contractReturnSectionRef=useRef<HTMLDivElement>(null);
  const [contractUploading,setContractUploading] = useState(false);
  const contractUploadGuard=useRef(false);
  const contractFileInput=useRef<HTMLInputElement | null>(null);
  const [contractReturnError,setContractReturnError] = useState("");
  const contractPendingUpload = useRef<ContractReturnUpload | null>(null);
  const [contractPendingSubmission,setContractPendingSubmission] = useState<{attachmentIds:string[];key:string}|null>(null);
  useEffect(()=>{
    contractPendingUpload.current=null;
    setContractPendingSubmission(null);
    setContractReturnError("");
  },[sourcingCaseId]);
  const [dispatchState, setDispatchState] = useState<SourcingDispatchState>({ item: null, canDispatch: false });
  const [contractSupplement, setContractSupplement] = useState<ContractSupplementDraft>({});
  const [factoryChangeDraft, setFactoryChangeDraft] = useState<FactoryChangeDraft>({ supplierId: "", unitPrice: "", changeReason: "" });
  const [factoryChangeReviewReason, setFactoryChangeReviewReason] = useState("");
  const [transferFormOpen, setTransferFormOpen] = useState(false);
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
      setFactoryChange(currentFactoryChange.item);setFactoryRemainingLines(currentFactoryChange.remainingLines);
      setContract(currentContract.item);
      setContractReturn(currentContractReturn);
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
  const saveContractReturn = async (submission: {attachmentIds:string[];key:string}):Promise<void> => {
    const result=await requestSubmission(`sourcing/cases/${sourcingCaseId}/contract-return`,SourcingContractReturnResponseSchema,{
      method:"POST",headers:{"idempotency-key":submission.key},body:JSON.stringify({attachmentIds:submission.attachmentIds}),
    });
    setContractReturn(result);
    contractPendingUpload.current=null;
    setContractPendingSubmission(null);
    setContractReturnError("");
    setItem(await request(`sourcing/cases/${sourcingCaseId}`,SourcingCaseSummarySchema));
  };
  const continueContractReturnUpload = async ():Promise<void> => {
    const pending=contractPendingUpload.current;
    if (!pending || contractUploadGuard.current) return;
    contractUploadGuard.current=true;setContractUploading(true);setContractReturnError("");
    try {
      const submission=await finishContractReturnUpload(pending,async file=>{
        const intent=await request("tools/attachments/upload-intents",UploadIntentResponseSchema,{
          method:"POST",body:JSON.stringify({
            filename:file.name,mimeType:file.type,sizeBytes:file.size,sha256:await sha256Hex(file),
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
      setContractReturnError(contractPendingUpload.current
        ? `${message}。已完成 ${pending.attachmentIds.length}/${pending.files.length} 个文件，尚未保存回签记录，请重试上传。`
        : message);
    } finally {contractUploadGuard.current=false;setContractUploading(false);}
  };
  const uploadContractReturn = async (files:FileList|null):Promise<void> => {
    if (!files?.length || contractUploadGuard.current || !contractReturn?.canUpload) return;
    const chosen=Array.from(files);
    const error=contractReturnFileError(chosen,contractReturn.uploadedFileCount ?? contractReturn.attachments.length,contractReturn.uploadedTotalBytes ?? contractReturn.attachments.reduce((total,file)=>total+file.sizeBytes,0));
    if (error) {setContractReturnError(error);return;}
    setContractPendingSubmission(null);
    contractPendingUpload.current={files:chosen,attachmentIds:[],key:createClientRequestId()};
    await continueContractReturnUpload();
  };
  const retryContractReturn=async():Promise<void>=>{
    if (!contractPendingSubmission || contractUploadGuard.current) return;
    contractUploadGuard.current=true;setContractUploading(true);setContractReturnError("");
    try {await saveContractReturn(contractPendingSubmission);}
    catch(error){setContractReturnError(error instanceof Error?error.message:"保存失败，请重试");}
    finally {contractUploadGuard.current=false;setContractUploading(false);}
  };
  const styleDuplicateMessage = duplicateSourcingLineMessage(styleEdits.map(line => ({...line,color:item?.lineItems.find(row => row.position===line.position)?.color})));
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
  const canMerchandiserTransfer = item?.createdBy === user?.id && canAct(user, "order_merchandiser", "sourcing:factory_change:request");
  const canManagementTransfer = canManage;
  const canOwnerTransfer = canOwner;
  const canReviewManagementTransfer = canAct(user, "production_management", "sourcing:factory_change:verify");
  const canFinance = canAct(user, "factory_payables", "sourcing:finance:reconcile");
  const hideFinanceForMerchandiser = isMerchandiserOnly(user?.businessRoles,user?.isRoot);
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
  const comparableIeTotal=item.ieQuote&&item.decision?.sourceType==='factory_change'
    ?item.ieQuote.linePrices.length?linesTotalPreview(item.ieQuote.linePrices.filter(price=>item.decision!.linePrices.some(line=>line.position===price.position)),item.lineItems.map(line=>({...line,quantity:item.decision!.linePrices.find(price=>price.position===line.position)?.quantity??0}))):totalPreview(item.ieQuote.unitPrice,item.decision.quantity)
    :item.ieQuote?.totalAmount;
  const ownerTotalDelta=item.decision&&comparableIeTotal&&comparableIeTotal!=='—'?subtractFixedPoint(item.decision.totalAmount,comparableIeTotal,2):null;
  const transferQuantity=factoryRemainingLines?.reduce((sum,line)=>sum+line.quantity,0)??item.orderQuantity;
  const transferTotal=factoryChangeTotalPreview(factoryChangeDraft.unitPrice,factoryRemainingLines?factoryRemainingLines.filter(line=>line.quantity>0).map(line=>line.quantity):[item.orderQuantity]);
  const ownerCraftSummary = <span className="sourcing-owner-craft-summary">承包内容包括 <strong>{item.processes.length ? item.processes.join("、") : "未填写"}</strong>；裁床工序为 <strong>{item.decision?.cuttingProcess === "in_house" ? "本厂裁" : item.decision?.cuttingProcess === "outsourced" ? "外厂裁" : item.decision?.cuttingProcess === "other" ? `其它：${item.decision.cuttingProcessOther ?? "未填写"}` : "未填写"}</strong>。</span>;
  const latestFinance = [...timeline].reverse()
    .find((entry) => entry.kind === "finance_reconciliation" && !entry.factoryDecisionId);
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
  const selectedFactory = factories.find((factory) => factory.supplierId === decision.supplierId);
  const todoBackPath = todoReturnPath(window.location.search);
  const listBackPath = sourcingReturnPath(window.location.search);
  const detailReturnPath = todoBackPath ?? listBackPath ?? cockpitReturnPath(window.location.search);
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
        title={item.styleNo}
        subtitle={`${item.gender ?? "历史未维护"} · ${item.styleName ?? "历史未维护"}`}
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
          <div className="sourcing-key-facts__factory"><dt>加工厂</dt><dd>{item.decision?.supplierName ?? "待选厂"}</dd></div>
          <div><dt>总数量</dt><dd>{formatBusinessDecimal(item.orderQuantity)} 件</dd></div>
          <div><dt>生产总额</dt><dd>{item.decision ? formatBusinessCurrency(item.decision.totalAmount) : "—"}</dd></div>
          <div><dt>IE 总额</dt><dd>{item.ieQuote ? formatBusinessCurrency(item.ieQuote.totalAmount) : "—"}</dd></div>
          <div><dt>较 IE 总额变化</dt><dd className={ownerTotalDelta?.startsWith("-") ? "sourcing-price-lower" : undefined}>{ownerTotalDelta ?? "—"}</dd></div>
          <div className="sourcing-key-facts__date"><dt>预计裁片发出</dt><dd>{item.estimatedCutPieceSendDate ?? "历史未维护"}</dd></div>
          {sourcingPoDates(item)?<div className="sourcing-key-facts__date"><dt>PO 双交期</dt><dd><PoDateSummary lines={sourcingPoDates(item)}/></dd></div>:<div className="sourcing-key-facts__date"><dt>要求交货日期</dt><dd>{item.deliveryDate ?? "—"}</dd></div>}
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
              <StatusBadge tone="info">{formatBusinessDecimal(attachments.length)} 张</StatusBadge>
            </div>
            {attachments.length > 0 ? <ImageStrip aria-label="订单照片，可横向滚动">
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
          <p className="sourcing-owner-decision__lead">供应链总监建议由 <strong>{item.decision.supplierName}</strong> 承接 <strong>{formatBusinessDecimal(item.decision.quantity)} 件</strong>，生产总额 <strong>{formatBusinessCurrency(item.decision.totalAmount)}</strong>，相对 IE 总额变化{item.decision.sourceType==='factory_change'?'（按转入同份额）':''} <strong>{ownerTotalDelta ?? "—"}</strong>。</p>
          <p>{ownerCraftSummary}</p>
          {item.decision.decisionReason ? <p>供应链总监说明：{item.decision.decisionReason}</p> : null}
          {selectedNode === "owner" && selectedState === "current" ? <p>请核对价格、加工厂及交期，确认后审批。</p> : null}
        </DecisionSummary> : null}
        <ResponsiveFactsTable caption="款式明细" mobileLayout="compact" rows={item.lineItems} rowKey={line => line.position}
          totals={{ style: "合计", quantity: `${formatBusinessDecimal(item.orderQuantity)} 件`, amount: item.decision ? formatBusinessCurrency(item.decision.totalAmount) : "—" }}
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
            ...(item.lineItems.some(line=>line.lineId)?[{key:"customerDate",label:"客户仓到货日",render:(line:SourcingCaseSummary["lineItems"][number])=>line.customerWarehouseArrivalDate ?? "未登记"},{key:"factoryDate",label:"加工厂交货日",render:(line:SourcingCaseSummary["lineItems"][number])=><>{line.factoryDeliveryDate ?? "尚未生效"}{line.proposedFactoryDeliveryDate && line.proposedFactoryDeliveryDate!==line.factoryDeliveryDate?<small>{item.approvalSnapshot?"原申请日期：":"审批提议："}{line.proposedFactoryDeliveryDate}</small>:null}</>}]:[]),
            { key: "ie", label: "IE 单价", render: line => { const price = sourcingLinePricing(item.ieQuote, line.position, item.lineItems.length); return price ? historicalSourcingPrice(price.unitPrice) : "—"; } },
            { key: "production", label: "生产单价", render: line => { const price = sourcingLinePricing(item.decision, line.position, item.lineItems.length); return price ? historicalSourcingPrice(price.unitPrice) : "—"; } },
            { key: "amount", label: "本款金额", render: line => { const price = sourcingLinePricing(item.decision, line.position, item.lineItems.length); return price?.totalAmount ? formatBusinessCurrency(price.totalAmount) : "—"; } },
          ]} />
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
            <h2>供应链总监调价与选厂</h2>
            <p>逐款确认 IE 价格并选择一个启用加工厂。</p>
            {canManage ? <fieldset className="sourcing-submission-fields sourcing-form-grid" disabled={busy || feedback.uncertain}>
              <label><span>加工厂</span><select {...feedback.field("sourcing-decision-factory")} value={decision.supplierId} onChange={(event) => { setDecision({ ...decision, supplierId: event.target.value }); actionKey.current = null; }}><option value="">请选择加工厂</option>{factories.map((factory) => <option key={factory.supplierId} value={factory.supplierId}>{factory.supplierName}</option>)}</select></label>
              {selectedFactory ? <div className="sourcing-factory-facts sourcing-form-wide"><strong>{selectedFactory.supplierName} · {selectedFactory.supplierCode}</strong><span>工艺：{selectedFactory.supportedCrafts.join("、") || "未维护"}</span><span>日产能：{selectedFactory.dailyCapacity ? `${formatBusinessDecimal(selectedFactory.dailyCapacity)} 件` : "未维护"}</span><span>{selectedFactory.notes || "暂无协同备注"}</span><em>{selectedFactory.contractDataMissing.length ? `合同缺项：${selectedFactory.contractDataMissing.map((field) => contractMissingLabels[field] ?? field).join("、")}` : "合同资料完整"}</em></div> : null}
              <div className="sourcing-line-price-table sourcing-form-wide" role="table" aria-label="供应链总监逐款价格">
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
            </fieldset> : <p>当前账号仅可查看，本节点由供应链总监办理。</p>}
          </Surface> : null}

          {item.status === "pending_owner_approval" && selectedNode === "owner" && !canOwner ? <p>当前账号仅可查看，本节点由老板办理。</p> : null}

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
              {contract.status === "ready" && contract.pdfAttachmentId && canReadContractData ? <div className="sourcing-contract-bar__actions"><a className="dx-button dx-button--primary" href={attachmentUrl(contract.pdfAttachmentId, "preview")} target="_blank" rel="noreferrer">预览合同 PDF</a><a className="dx-button dx-button--secondary" href={attachmentUrl(contract.pdfAttachmentId, "download")} target="_blank" rel="noreferrer">下载合同</a>{contract.canRefreshInformation ? <ContractInformationRefresh key={contract.sourcingContractDocumentId} caseId={item.sourcingCaseId} disabled={busy} canEditContent={contract.canEditContent === true} onUpdated={load} /> : null}{canEditStyles ? <button className="dx-button dx-button--secondary" type="button" disabled={busy} onClick={() => {
          setStyleEdits(item.lineItems.map(line => ({position:line.position,styleNo:(line.formalStyleNo === undefined ? line.styleNo : line.formalStyleNo) ?? "",alternateStyleNo:line.alternateStyleNo ?? ""})));
          setStyleEditRevision(item.identityRevision ?? 0);styleEditKey.current=null;setEditingStyles(true);
        }}>修改款号</button> : null}</div> : null}
              {contractReturn?.contractReturnMonitoring ? <>
                {contractReturn.contractReturnedAt ? <p>{contractReturn.currentContractReturned && contractReturn.currentContractDocumentId === contract.sourcingContractDocumentId ? `本版本 V${contract.contractVersion} 已回签` : `本版本 V${contract.contractVersion} 无回签记录`}</p> : null}
                <div ref={contractReturnSectionRef} tabIndex={-1} className="sourcing-contract-bar__actions sourcing-contract-return-actions">
                  {contractReturn.canUpload ? <>
                    <input ref={contractFileInput} type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" multiple hidden
                      onChange={event=>{void uploadContractReturn(event.target.files);event.target.value="";}} />
                    <button className="dx-button dx-button--secondary" type="button" disabled={contractUploading || busy}
                      onClick={()=>contractFileInput.current?.click()}>
                      {contractUploading?"正在上传…":contractReturn.attachments.length?"补传回签合同":"上传回签合同"}
                    </button>
                    <span>可一次传两个，也可分次追加；累计最多 2 个 PDF/JPG/PNG，合计不超过 20 MB</span>
                  </> : null}
                  {(contractReturn.uploadedFileCount ?? contractReturn.attachments.length)>=2 ? <span>已达累计文件上限，已保存附件及历史记录保留</span>
                    : (contractReturn.uploadedTotalBytes ?? contractReturn.attachments.reduce((total,file)=>total+file.sizeBytes,0))>=20*1024*1024
                      ? <span>已达累计 20 MB 上限，已保存附件及历史记录保留</span> : null}
                  {contractReturn.attachments.length ? <div className="sourcing-contract-return-links" aria-label="回签附件，可左右滑动查看更多">
                    {contractReturn.attachments.map((file,index)=>
                      <a className="dx-button dx-button--secondary" key={file.attachmentId}
                        href={attachmentUrl(file.attachmentId,"preview")} target="_blank" rel="noreferrer" title={file.filename}>
                        {index===0?(contractReturn.signedContractVersion ? `查看 V${contractReturn.signedContractVersion} 回签合同` : "查看历史回签（版本未记录）"):`查看第 ${index+1} 个文件`}
                      </a>)}
                  </div> : null}
                  {contractPendingUpload.current && contractReturnError ? <button className="dx-button dx-button--secondary" type="button"
                    disabled={contractUploading} onClick={()=>void continueContractReturnUpload()}>重试上传</button> : null}
                  {contractPendingSubmission && contractReturnError ? <button className="dx-button dx-button--secondary" type="button"
                    disabled={contractUploading} onClick={()=>void retryContractReturn()}>重试保存</button> : null}
                </div>
                {contractReturn.history.length ? <details className="sourcing-contract-return-history">
                  <summary>历史回签 · {contractReturn.history.length} 次</summary>
                  {contractReturn.history.map(version=><div key={version.revision}>
                    <span>第 {version.revision} 次 · {version.signedContractVersion ? `合同 V${version.signedContractVersion} · ${version.signedContractNumber}` : "合同版本未记录"} · {version.uploadedByName} · {formatDateTime(version.submittedAt)}</span>
                    <div className="sourcing-contract-return-links">
                      {version.attachments.map((file,index)=><a className="dx-button dx-button--secondary" key={file.attachmentId}
                        href={attachmentUrl(file.attachmentId,"preview")} target="_blank" rel="noreferrer" title={file.filename}>
                        {index===0?"查看回签合同":`查看第 ${index+1} 个文件`}
                      </a>)}
                    </div>
                  </div>)}
                </details> : null}
                {contractReturnError ? <p role="alert" className="sourcing-contract-return-error">{contractReturnError}</p> : null}
                <details className="sourcing-contract-return-facts" open={!window.matchMedia("(max-width: 768px)").matches}>
                  <summary className={`sourcing-contract-return-status--${contractReturn.contractReturnStatus}`}>首次回签时效 · {sourcingContractReturnLabel(contractReturn)}</summary>
                  <dl className="sourcing-finance-reference">
                    <div><dt>合同生成时间</dt><dd>{contractReturn.contractGeneratedAt?formatDateTime(contractReturn.contractGeneratedAt):"—"}</dd></div>
                    <div><dt>回传截止时间</dt><dd>{contractReturn.contractReturnDueAt?formatDateTime(contractReturn.contractReturnDueAt):"待合同生成"}</dd></div>
                    <div><dt>实际回传时间</dt><dd>{contractReturn.contractReturnedAt?formatDateTime(contractReturn.contractReturnedAt):"—"}</dd></div>
                    <div><dt>上传人</dt><dd>{contractReturn.uploadedByName??"—"}</dd></div>
                    <div><dt>首次回签状态</dt><dd className={`sourcing-contract-return-status sourcing-contract-return-status--${contractReturn.contractReturnStatus}`}>{sourcingContractReturnLabel(contractReturn)}</dd></div>
                  </dl>
                </details>
              </> : null}
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
                    : <span>{dispatchState.dispatchMode === "warehouse_actual_dispatch"
                      ? "数字单完成产前技术准备、实际开裁与裁后工艺后，由仓库完成整款实际发厂，自动生成生产单。"
                      : contract.status === "ready" ? "待本订单跟单派单" : "合同生成后可派单"}</span>}
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

          {canFinance&&item.decision?<FactorySettlementPanel sourcingCaseId={item.sourcingCaseId} currentDecisionId={item.decision.sourcingDecisionId}/>:null}
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
              <p>请对照已批准的选厂决定确认上述四项事实。若发现不一致，只记录差异项和说明，由供应链总监核实；财务不能在此页改写业务数据。</p>
              <div className="sourcing-finance-actions">
                <button className="dx-button dx-button--primary" type="button" disabled={busy} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/finance-reconciliations`, { result: "match" }, "与合同一致，订单已归档")}>确认与合同一致</button>
                <button className="dx-button dx-button--primary" type="button" disabled={busy} onClick={() => { setMessage(""); setFinanceDifferenceOpen(true); }}>发现不一致</button>
              </div>
              {financeDifferenceOpen ? <SourcingFinanceDifferenceDialog busy={busy} onClose={() => setFinanceDifferenceOpen(false)}>
                <form onSubmit={event => {
                  event.preventDefault();
                  if (busy || !financeReview.differenceFields.length || !financeReview.differenceReason.trim()) return;
                  void submit(`sourcing/cases/${item.sourcingCaseId}/finance-reconciliations`, { result: "difference", differenceFields: financeReview.differenceFields, differenceReason: financeReview.differenceReason.trim() }, "财务差异已提交供应链总监核实");
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
            </div> : <p>当前账号仅可查看，本节点由供应链总监核实。</p>}
          </Surface> : null}
          {message ? <p className="sourcing-action-message" role="status">{message}</p> : null}
        </section>
          {transferNodeRole ? <section className="sourcing-factory-change" aria-label="订单转厂">
            {!item.decision ? <button className="dx-button dx-button--primary" type="button" disabled title="供应链总监首次提交加工厂和单价后开放">订单转厂</button> : factoryChange?.status === "pending_management" ? <>
              <h2>订单转厂</h2>
              <p><strong>{factoryChange.proposedSupplierName}</strong> · {formatBusinessCurrency(factoryChange.proposedUnitPrice)}/件 · {formatBusinessCurrency(factoryChange.proposedTotalAmount)}。跟单申请，等待供应链总监审批。</p>
              {canReviewManagementTransfer ? <div className="sourcing-factory-change__review">
                <label><span>审批说明</span><input maxLength={500} value={factoryChangeReviewReason} onChange={(event) => { setFactoryChangeReviewReason(event.target.value); actionKey.current = null; }} /></label>
                <div><button className="dx-button dx-button--primary" type="button" disabled={busy || !factoryChangeReviewReason.trim()} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/factory-changes/${factoryChange.factoryChangeRequestId}/decision`, { decision: "approved", verificationReason: factoryChangeReviewReason.trim() }, factoryChange.requiresOwnerApproval ? "供应链总监已通过，转老板审批" : "转厂已生效", true)}>批准转厂</button><button className="dx-button dx-button--secondary" type="button" disabled={busy || !factoryChangeReviewReason.trim()} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/factory-changes/${factoryChange.factoryChangeRequestId}/decision`, { decision: "rejected", verificationReason: factoryChangeReviewReason.trim() }, "转厂申请已驳回", true)}>驳回</button></div>
              </div> : null}
            </> : factoryChange?.status === "pending_owner" ? <>
              <h2>订单转厂</h2>
              <p><strong>{factoryChange.proposedSupplierName}</strong> · {formatBusinessCurrency(factoryChange.proposedUnitPrice)}/件，超过当前单价，等待老板批准。</p>
              {canOwner ? <div className="sourcing-factory-change__review">
                <label><span>审批说明</span><input maxLength={500} value={factoryChangeReviewReason} onChange={(event) => { setFactoryChangeReviewReason(event.target.value); actionKey.current = null; }} /></label>
                <div><button className="dx-button dx-button--primary" type="button" disabled={busy || !factoryChangeReviewReason.trim()} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/factory-changes/${factoryChange.factoryChangeRequestId}/owner-decision`, { decision: "approved", verificationReason: factoryChangeReviewReason.trim() }, "老板已批准，转厂生效", true)}>批准转厂</button><button className="dx-button dx-button--secondary" type="button" disabled={busy || !factoryChangeReviewReason.trim()} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/factory-changes/${factoryChange.factoryChangeRequestId}/owner-decision`, { decision: "rejected", verificationReason: factoryChangeReviewReason.trim() }, "老板已驳回转厂", true)}>驳回</button></div>
              </div> : null}
            </> : canInitiateTransfer ? <>
              <button className="dx-button dx-button--primary" type="button" aria-expanded={transferFormOpen} aria-controls="sourcing-transfer-form" onClick={() => setTransferFormOpen(value => !value)}>订单转厂</button>
              {transferFormOpen ? <div id="sourcing-transfer-form" className="sourcing-transfer-form">
              <p>当前：{item.decision.supplierName} · {formatBusinessCurrency(item.decision.unitPrice)}/件。新单价不高于当前价时按角色规则直接生效；超过时交老板批准。</p>
              <div className="sourcing-form-grid">
                <label><span>新加工厂</span><select value={factoryChangeDraft.supplierId} onChange={(event) => { setFactoryChangeDraft({ ...factoryChangeDraft, supplierId: event.target.value }); actionKey.current = null; }}><option value="">请选择不同的加工厂</option>{factories.filter((factory) => factory.supplierId !== item.decision?.supplierId).map((factory) => <option value={factory.supplierId} key={factory.supplierId}>{factory.supplierName}</option>)}</select></label>
                <label><span>新加工单价</span><input inputMode="decimal" value={activeBusinessInput === "factory-change-unit-price" ? factoryChangeDraft.unitPrice : businessInputValue(factoryChangeDraft.unitPrice)} onFocus={() => setActiveBusinessInput("factory-change-unit-price")} onBlur={() => setActiveBusinessInput(null)} onChange={(event) => { setFactoryChangeDraft({ ...factoryChangeDraft, unitPrice: businessInputChange(event.target.value) }); actionKey.current = null; }} /></label>
                <label><span>转入数量</span><input readOnly value={transferQuantity}/></label>
                <label><span>新总额</span><input readOnly value={businessInputValue(transferTotal)} /></label>
                <p>已报完成数保留旧厂，未完工余量按生效时最新报量转入新厂。</p>
                <p className="sourcing-factory-change__delta">相对当前单价：<strong>{transferPriceDelta ?? "—"}</strong></p>
                <label className="sourcing-form-wide"><span>转厂原因</span><input maxLength={500} value={factoryChangeDraft.changeReason} onChange={(event) => { setFactoryChangeDraft({ ...factoryChangeDraft, changeReason: event.target.value }); actionKey.current = null; }} /></label>
                <button className="dx-button dx-button--primary" type="button" disabled={busy || transferQuantity===0 || !factoryChangeDraft.supplierId || !factoryChangeDraft.unitPrice || !factoryChangeDraft.changeReason.trim()} onClick={() => void submit(transferRequestPath, { supplierId: factoryChangeDraft.supplierId, unitPrice: factoryChangeDraft.unitPrice, changeReason: factoryChangeDraft.changeReason.trim() }, transferNodeRole === "owner_group" ? "老板发起的转厂已直接生效" : transferNodeRole === "production_management" && (transferPriceDelta?.startsWith("+") !== true) ? "转厂已生效" : "转厂申请已提交", true)}>提交转厂</button>
              </div>
            </div> : null}
            </> : <p>当前账号可查看转厂记录，但不能在本节点发起。</p>}
          </section> : null}
        {item.status === "pending_owner_approval" && selectedNode === "owner" && canOwner ? <ActionBar className="sourcing-owner-actions" aria-label="老板审批操作">
          <button className="dx-button dx-button--secondary sourcing-owner-reject" type="button" disabled={busy} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/owner-decisions`, { decision: "rejected" }, "已驳回供应链总监重新调整")}>驳回并退回供应链总监</button>
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
