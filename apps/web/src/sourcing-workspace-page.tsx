import {
  AttachmentResponseSchema,
  MAX_SOURCING_ATTACHMENTS,
  SourcingAttachmentListResponseSchema,
  SourcingCaseListResponseSchema,
  SourcingCaseSummarySchema,
  SourcingFactoryListResponseSchema,
  SourcingTimelineResponseSchema,
  UploadIntentResponseSchema,
  calculateSourcingTotalExact,
  type SourcingAttachment,
  type SourcingCaseStatus,
  type SourcingCaseSummary,
  type SourcingFactory,
  type SourcingTimelineEntry,
} from "@dx-rework/contracts";
import { StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import {
  currentQcUploadConcurrency,
  isImageAttachment,
  prepareAndUploadWithConcurrency,
  prepareAttachmentForUpload,
  sha256Hex,
} from "./attachment-upload.js";
import { verifySession, type AuthorizedUser } from "./auth.js";
import { createClientRequestId } from "./client-request-id.js";
import { Header, Shell } from "./components.js";
import { ImageViewer } from "./image-viewer.js";
import "./rework-detail.css";
import "./sourcing-workspace.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

const STATUS_LABELS: Readonly<Record<SourcingCaseStatus, string>> = {
  pending_ie_quote: "待 IE 报价",
  pending_management_decision: "待生产管理调价选厂",
  pending_owner_approval: "待老板终审",
  pending_contract: "待登记合同",
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
type QuoteDraft = Readonly<{ unitPrice: string; quoteReason: string }>;
type DecisionDraft = Readonly<{ supplierId: string; unitPrice: string; decisionReason: string }>;

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
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? "操作失败，请稍后重试");
  }
  return schema.parse(await response.json());
};

const canAct = (user: AuthorizedUser | null, role: string, capability: string): boolean =>
  user?.isRoot === true
  || (user?.businessRoles?.includes(role) === true && user.capabilities.includes(capability));

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

const attachmentUrl = (attachmentId: string, mode: "preview" | "download"): string =>
  apiUrl(`tools/attachments/${attachmentId}/download?mode=${mode}`);

const detailHref = (item: SourcingCaseSummary): string =>
  pageUrl(`ui/sourcing/orders/${item.sourcingCaseId}`);

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

  return (
    <Shell active={ACTIVE_NAVIGATION[view]}>
      {view === "create" ? <CreateOrderPage user={user} /> : null}
      {view === "pending" ? <OrderListPage mode="pending" /> : null}
      {view === "history" ? <OrderListPage mode="history" /> : null}
      {view === "detail" && sourcingCaseId
        ? <OrderDetailPage sourcingCaseId={sourcingCaseId} user={user} />
        : null}
    </Shell>
  );
}

function CreateOrderPage({ user }: { user: AuthorizedUser | null }) {
  const [erpOrderNo, setErpOrderNo] = useState("");
  const [styleNo, setStyleNo] = useState("");
  const [orderQuantity, setOrderQuantity] = useState("");
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("填写订单资料并上传现场或款式照片。");
  const createKey = useRef<string | null>(null);
  const canCreate = canAct(user, "order_merchandiser", "sourcing:inquiry:create");

  const uploadImages = async (files: FileList | null): Promise<void> => {
    if (!files?.length || uploading) return;
    const selected = Array.from(files);
    const unsupported = selected.find((file) => !isImageAttachment(file));
    if (unsupported) {
      setMessage(`${unsupported.name} 不是支持的图片格式`);
      return;
    }
    if (images.length + selected.length > MAX_SOURCING_ATTACHMENTS) {
      setMessage(`每张订单最多上传 ${MAX_SOURCING_ATTACHMENTS} 张图片`);
      return;
    }
    setUploading(true);
    try {
      const uploaded = await prepareAndUploadWithConcurrency(
        selected,
        currentQcUploadConcurrency(),
        async (file, index) => {
          setMessage(`正在处理第 ${index + 1}/${selected.length} 张图片…`);
          const prepared = await prepareAttachmentForUpload(file);
          return { file: prepared, sha256: await sha256Hex(prepared) };
        },
        async ({ file, sha256 }, _sourceFile, index): Promise<UploadedImage> => {
          setMessage(`正在上传第 ${index + 1}/${selected.length} 张图片…`);
          const intent = await request("tools/attachments/upload-intents", UploadIntentResponseSchema, {
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
          const response = await fetch(intent.uploadUrl, { method: "POST", body: upload });
          if (!response.ok) throw new Error(`${file.name} 上传失败`);
          const finalized = await request(
            `tools/attachments/${intent.attachmentId}/finalize`,
            AttachmentResponseSchema,
            { method: "POST" },
          );
          return {
            attachmentId: finalized.attachmentId,
            filename: finalized.filename,
            mimeType: finalized.mimeType,
            previewUrl: attachmentUrl(finalized.attachmentId, "preview"),
          };
        },
      );
      setImages((current) => [...current, ...uploaded]);
      setMessage(`已上传 ${uploaded.length} 张图片；请核对订单资料后提交`);
      createKey.current = null;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "订单图片上传失败");
    } finally {
      setUploading(false);
    }
  };

  const createOrder = async (): Promise<void> => {
    const quantity = Number(orderQuantity);
    if (!canCreate) { setMessage("当前账号没有创建订单权限"); return; }
    if (!erpOrderNo.trim() || !styleNo.trim()) { setMessage("请填写 ERP 订单号和款号"); return; }
    if (!/^\d+$/.test(orderQuantity) || quantity < 1 || quantity > 10_000_000) {
      setMessage("订单数量必须是1至10000000之间的整数");
      return;
    }
    if (images.length === 0) { setMessage("请至少上传一张订单照片"); return; }
    setBusy(true);
    createKey.current ??= createClientRequestId();
    try {
      const created = await request("sourcing/cases", SourcingCaseSummarySchema, {
        method: "POST",
        headers: { "idempotency-key": createKey.current },
        body: JSON.stringify({
          erpOrderNo: erpOrderNo.trim(),
          styleNo: styleNo.trim(),
          orderQuantity: quantity,
          attachmentIds: images.map((image) => image.attachmentId),
        }),
      });
      window.location.assign(detailHref(created));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "订单创建失败");
      setBusy(false);
    }
  };

  return (
    <div className="sourcing-workspace sourcing-workspace--create">
      <Header
        title="创建订单"
        subtitle="跟单只需登记订单核心资料和照片，提交后自动进入待审批订单。"
        badge="报价&选厂"
      />
      <Surface className="sourcing-create-card">
        <div className="section-title">
          <div><h2>订单资料</h2><p>请以正式 ERP 订单为准。</p></div>
          <StatusBadge tone="info">跟单提交</StatusBadge>
        </div>
        <div className="sourcing-form-grid">
          <label><span>ERP 订单号</span><input value={erpOrderNo} maxLength={100} onChange={(event) => { setErpOrderNo(event.target.value); createKey.current = null; }} placeholder="请输入正式 ERP 订单号" /></label>
          <label><span>款号</span><input value={styleNo} maxLength={100} onChange={(event) => { setStyleNo(event.target.value); createKey.current = null; }} placeholder="请输入款号" /></label>
          <label><span>订单数量</span><input value={orderQuantity} inputMode="numeric" onChange={(event) => { setOrderQuantity(event.target.value); createKey.current = null; }} placeholder="请输入整数" /></label>
        </div>
        <section className="sourcing-photo-field" aria-label="订单照片">
          <div className="section-title">
            <div><h2>订单照片</h2><p>复用返工系统图片规范，支持 JPG、PNG、WebP。</p></div>
            <StatusBadge tone="info">{images.length}/{MAX_SOURCING_ATTACHMENTS}</StatusBadge>
          </div>
          {images.length > 0 ? <div className="rework-detail-image-grid">
            {images.map((image) => <div className="rework-detail-image-card" key={image.attachmentId}>
              <img src={image.previewUrl} alt={image.filename} />
              <span>{image.filename}</span>
            </div>)}
          </div> : <div className="sourcing-photo-empty">尚未上传图片</div>}
          <label className="qc-file-button sourcing-upload-button">
            <span>{uploading ? "正在上传…" : "选择照片"}</span>
            <input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={uploading || images.length >= MAX_SOURCING_ATTACHMENTS} onChange={(event) => { void uploadImages(event.target.files); event.target.value = ""; }} />
          </label>
        </section>
        <div className="sourcing-submit-row">
          <p role="status">{message}</p>
          <button className="dx-button dx-button--primary" type="button" disabled={busy || uploading || !canCreate} onClick={() => void createOrder()}>
            {busy ? "正在提交…" : "提交并进入审批"}
          </button>
        </div>
      </Surface>
    </div>
  );
}

function OrderListPage({ mode }: { mode: "pending" | "history" }) {
  const [items, setItems] = useState<readonly SourcingCaseSummary[]>([]);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("正在加载订单…");

  const load = async (query = search): Promise<void> => {
    try {
      const body = await request(
        `sourcing/cases?q=${encodeURIComponent(query.trim())}`,
        SourcingCaseListResponseSchema,
      );
      setItems(body.items);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "订单列表加载失败");
    }
  };

  useEffect(() => { void load(""); }, []);
  const visible = useMemo(
    () => items.filter((item) => mode === "history" ? item.status === "closed" : item.status !== "closed"),
    [items, mode],
  );

  return (
    <div className="sourcing-workspace">
      <Header
        title={mode === "pending" ? "待审批订单" : "历史订单"}
        subtitle={mode === "pending" ? "所有未完成订单集中在这里，点击订单查看完整流程和当前办理区。" : "所有已完成订单集中归档，保留报价、调价、选厂和审批证据。"}
        badge={`${visible.length} 单`}
      />
      <Surface className="sourcing-list-card">
        <form className="sourcing-search" onSubmit={(event) => { event.preventDefault(); void load(search); }}>
          <input value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 ERP 订单号或款号" />
          <button className="dx-button dx-button--secondary" type="submit">搜索</button>
        </form>
        {message ? <p className="sourcing-list-message" role="status">{message}</p> : null}
        {!message && visible.length === 0 ? <p className="sourcing-list-message">暂无符合条件的订单</p> : null}
        <div className="sourcing-order-list">
          {visible.map((item) => <a className="sourcing-order-row" href={detailHref(item)} key={item.sourcingCaseId}>
            <div><strong>{item.styleNo}</strong><small>{item.erpOrderNo}</small></div>
            <span><b>{item.orderQuantity.toLocaleString("zh-CN")}</b><small>订单数量</small></span>
            <span><b>{item.ieQuote ? `¥${item.ieQuote.unitPrice}` : "—"}</b><small>IE 单价</small></span>
            <span><b>{item.decision ? `¥${item.decision.unitPrice}` : "—"}</b><small>生产单价</small></span>
            <span><b>{item.decision?.supplierName ?? "待选厂"}</b><small>加工厂</small></span>
            <span><StatusBadge tone={item.status === "closed" ? "success" : "info"}>{STATUS_LABELS[item.status]}</StatusBadge><small>{formatDateTime(item.updatedAt)}</small></span>
          </a>)}
        </div>
      </Surface>
    </div>
  );
}

const WORKFLOW = [
  { key: "created", number: "01", label: "跟单创建订单", role: "订单跟单" },
  { key: "ie_quote", number: "02", label: "IE 给价", role: "IE" },
  { key: "management", number: "03", label: "调价与选厂", role: "生产管理" },
  { key: "owner", number: "04", label: "最终审批", role: "老板" },
  { key: "contract", number: "05", label: "合同执行", role: "跟单" },
  { key: "finance", number: "06", label: "财务核对", role: "财务" },
] as const;

const statusStep = (status: SourcingCaseStatus): number => ({
  pending_ie_quote: 1,
  pending_management_decision: 2,
  pending_owner_approval: 3,
  pending_contract: 4,
  pending_factory_change_verification: 4,
  pending_finance_reconciliation: 5,
  pending_exception_verification: 5,
  closed: 6,
})[status];

const timelineLabel = (entry: SourcingTimelineEntry): string => ({
  created: "创建订单",
  ie_quote: `IE 报价 V${entry.version}`,
  management_decision: `生产管理决定 V${entry.version}`,
  owner_decision: entry.decision === "approved" ? "老板批准" : "老板驳回",
})[entry.kind];

function OrderDetailPage({
  sourcingCaseId,
  user,
}: {
  sourcingCaseId: string;
  user: AuthorizedUser | null;
}) {
  const [item, setItem] = useState<SourcingCaseSummary | null>(null);
  const [attachments, setAttachments] = useState<readonly SourcingAttachment[]>([]);
  const [timeline, setTimeline] = useState<readonly SourcingTimelineEntry[]>([]);
  const [factories, setFactories] = useState<readonly SourcingFactory[]>([]);
  const [quote, setQuote] = useState<QuoteDraft>({ unitPrice: "", quoteReason: "" });
  const [decision, setDecision] = useState<DecisionDraft>({ supplierId: "", unitPrice: "", decisionReason: "" });
  const [ownerReason, setOwnerReason] = useState("");
  const [selectedImage, setSelectedImage] = useState<SourcingAttachment | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("正在加载订单…");
  const actionKey = useRef<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const [detail, evidence, history] = await Promise.all([
        request(`sourcing/cases/${sourcingCaseId}`, SourcingCaseSummarySchema),
        request(`sourcing/cases/${sourcingCaseId}/attachments`, SourcingAttachmentListResponseSchema),
        request(`sourcing/cases/${sourcingCaseId}/timeline`, SourcingTimelineResponseSchema),
      ]);
      setItem(detail);
      setAttachments(evidence.items);
      setTimeline(history.items);
      setDecision((current) => ({
        supplierId: current.supplierId || detail.decision?.supplierId || "",
        unitPrice: current.unitPrice || detail.decision?.unitPrice || detail.ieQuote?.unitPrice || "",
        decisionReason: current.decisionReason,
      }));
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "订单加载失败");
    }
  };

  useEffect(() => { void load(); }, [sourcingCaseId]);
  const canQuote = canAct(user, "ie_reviewer", "sourcing:price:quote");
  const canManage = canAct(user, "production_management", "sourcing:decision:record");
  const canOwner = canAct(user, "owner_group", "sourcing:owner:approve");

  useEffect(() => {
    if (!canManage) return;
    void request("sourcing/factories", SourcingFactoryListResponseSchema)
      .then((body) => setFactories(body.items))
      .catch((error) => setMessage(error instanceof Error ? error.message : "加工厂加载失败"));
  }, [canManage]);

  const submit = async (
    path: string,
    body: unknown,
    success: string,
  ): Promise<void> => {
    setBusy(true);
    actionKey.current ??= createClientRequestId();
    try {
      await request(path, SourcingCaseSummarySchema, {
        method: "POST",
        headers: { "idempotency-key": actionKey.current },
        body: JSON.stringify(body),
      });
      actionKey.current = null;
      setMessage(success);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提交失败");
    } finally {
      setBusy(false);
    }
  };

  if (!item) {
    return <div className="sourcing-workspace"><Header title="订单详情" subtitle={message} badge="报价&选厂" /></div>;
  }

  const step = statusStep(item.status);
  const priceAdjusted = item.ieQuote && item.decision
    ? Number(item.ieQuote.unitPrice) !== Number(item.decision.unitPrice)
    : false;

  return (
    <div className="sourcing-workspace sourcing-order-detail">
      <Header
        title={item.styleNo}
        subtitle={item.erpOrderNo}
        badge={STATUS_LABELS[item.status]}
        badgePlacement="subtitle"
        action="返回订单列表"
        actionHref={item.status === "closed" ? "/ui/sourcing/history" : "/ui/sourcing/pending"}
      />
      <div className="rework-detail-layout">
        <dl className="rework-detail-core-facts" aria-label="报价选厂订单核心信息">
          <div className="rework-detail-core-fact"><dt>订单数量</dt><dd>{item.orderQuantity.toLocaleString("zh-CN")} 件</dd></div>
          <div className="rework-detail-core-fact"><dt>IE 单价</dt><dd>{item.ieQuote ? `¥${item.ieQuote.unitPrice}` : "—"}</dd></div>
          <div className="rework-detail-core-fact"><dt>生产单价</dt><dd>{item.decision ? `¥${item.decision.unitPrice}` : "—"}</dd></div>
          <div className="rework-detail-core-fact"><dt>加工厂</dt><dd>{item.decision?.supplierName ?? "待选厂"}</dd></div>
          <div className="rework-detail-core-fact"><dt>总额</dt><dd>{item.decision ? `¥${item.decision.totalAmount}` : item.ieQuote ? `¥${item.ieQuote.totalAmount}` : "—"}</dd></div>
          <div className="rework-detail-core-fact"><dt>调价情况</dt><dd>{priceAdjusted ? "生产管理已调整" : item.decision ? "沿用 IE 价格" : "—"}</dd></div>
        </dl>

        <div className="rework-detail-overview-grid">
          <section className="rework-detail-images" aria-label="订单图片">
            <div className="section-title rework-detail-panel-title">
              <div><h2>订单图片</h2><p>跟单提交时上传的订单证据。</p></div>
              <StatusBadge tone="info">{attachments.length} 张</StatusBadge>
            </div>
            {attachments.length > 0 ? <div className="rework-detail-image-grid">
              {attachments.map((attachment) => <button className="rework-detail-image-card" type="button" key={attachment.attachmentId} onClick={() => setSelectedImage(attachment)}>
                <img src={attachmentUrl(attachment.attachmentId, "preview")} alt={attachment.filename} loading="lazy" />
                <span>{attachment.filename}</span>
              </button>)}
            </div> : <p className="sourcing-list-message">本单没有图片</p>}
          </section>

          <section className="rework-workflow" aria-label="订单流程">
            <div className="rework-workflow__heading rework-detail-panel-title">
              <div><h2>订单流程</h2><p>所有节点始终可见，当前环节不会遮住前序事实。</p></div>
              <span className="rework-workflow__step-count">当前步骤 {Math.min(step + 1, 6)} / 6</span>
            </div>
            <div className="rework-workflow__desktop-grid">
              {WORKFLOW.map((node, index) => {
                const state = item.status === "closed" || index < step ? "completed" : index === step ? "current" : "future";
                return <div className={`rework-workflow__node is-${state}`} key={node.key}>
                  <b>{node.number}</b>
                  <span><strong>{node.label}</strong><small>{node.role}</small></span>
                  <em>{state === "completed" ? "已完成" : state === "current" ? "处理中" : "未开始"}</em>
                </div>;
              })}
            </div>
          </section>
        </div>

        <Surface className="sourcing-history-panel">
          <div className="section-title">
            <div><h2>流程记录</h2><p>每次报价、调价、选厂和审批都按版本保留。</p></div>
            <StatusBadge tone="info">{timeline.length} 条</StatusBadge>
          </div>
          <div className="sourcing-timeline">
            {timeline.map((entry) => <article key={entry.entryId}>
              <div><strong>{timelineLabel(entry)}</strong><small>{formatDateTime(entry.handledAt)} · {entry.handledBy}</small></div>
              <p>{entry.reason}</p>
              <dl>
                {entry.unitPrice ? <div><dt>单价</dt><dd>¥{entry.unitPrice}</dd></div> : null}
                {entry.totalAmount ? <div><dt>总额</dt><dd>¥{entry.totalAmount}</dd></div> : null}
                {entry.supplierName ? <div><dt>加工厂</dt><dd>{entry.supplierName}</dd></div> : null}
              </dl>
            </article>)}
          </div>
        </Surface>

        <section className="rework-detail-task sourcing-action-panel" aria-label="节点办理区">
          <div className="rework-detail-task__heading"><h2>办理区</h2><StatusBadge tone="info">{STATUS_LABELS[item.status]}</StatusBadge></div>
          {item.status === "pending_ie_quote" ? <Surface className="rework-detail-node-preview">
            <h2>02 · IE 给价</h2>
            <p>输入加工单价，系统按订单数量精确计算总额。</p>
            {canQuote ? <div className="sourcing-form-grid">
              <label><span>加工单价</span><input value={quote.unitPrice} inputMode="decimal" onChange={(event) => { setQuote({ ...quote, unitPrice: event.target.value }); actionKey.current = null; }} /></label>
              <label><span>系统总额</span><input value={totalPreview(quote.unitPrice, item.orderQuantity)} readOnly /></label>
              <label className="sourcing-form-wide"><span>价格说明</span><input value={quote.quoteReason} maxLength={500} onChange={(event) => { setQuote({ ...quote, quoteReason: event.target.value }); actionKey.current = null; }} /></label>
              <button className="dx-button dx-button--primary" type="button" disabled={busy} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/ie-quotes`, { unitPrice: quote.unitPrice, ...(quote.quoteReason.trim() ? { quoteReason: quote.quoteReason.trim() } : {}) }, "IE 价格已提交")}>提交 IE 价格</button>
            </div> : <p>当前账号仅可查看，本节点由 IE 办理。</p>}
          </Surface> : null}

          {item.status === "pending_management_decision" ? <Surface className="rework-detail-node-preview">
            <h2>03 · 生产管理调价与选厂</h2>
            <p>IE 原价：¥{item.ieQuote?.unitPrice ?? "—"}。如调整价格，必须填写原因。</p>
            {canManage ? <div className="sourcing-form-grid">
              <label><span>加工厂</span><select value={decision.supplierId} onChange={(event) => { setDecision({ ...decision, supplierId: event.target.value }); actionKey.current = null; }}><option value="">请选择加工厂</option>{factories.map((factory) => <option key={factory.supplierId} value={factory.supplierId}>{factory.supplierName}</option>)}</select></label>
              <label><span>生产单价</span><input value={decision.unitPrice} inputMode="decimal" onChange={(event) => { setDecision({ ...decision, unitPrice: event.target.value }); actionKey.current = null; }} /></label>
              <label><span>系统总额</span><input value={totalPreview(decision.unitPrice, item.orderQuantity)} readOnly /></label>
              <label className="sourcing-form-wide"><span>选厂/调价说明</span><input value={decision.decisionReason} maxLength={500} onChange={(event) => { setDecision({ ...decision, decisionReason: event.target.value }); actionKey.current = null; }} /></label>
              <button className="dx-button dx-button--primary" type="button" disabled={busy} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/management-decisions`, { supplierId: decision.supplierId, unitPrice: decision.unitPrice, ...(decision.decisionReason.trim() ? { decisionReason: decision.decisionReason.trim() } : {}) }, "选厂决定已提交老板审批")}>提交调价与选厂</button>
            </div> : <p>当前账号仅可查看，本节点由生产管理办理。</p>}
          </Surface> : null}

          {item.status === "pending_owner_approval" ? <Surface className="rework-detail-node-preview">
            <h2>04 · 老板最终审批</h2>
            <p>IE 原价 ¥{item.ieQuote?.unitPrice ?? "—"}；生产管理价格 ¥{item.decision?.unitPrice ?? "—"}；加工厂 {item.decision?.supplierName ?? "—"}。</p>
            {canOwner ? <div className="sourcing-owner-actions">
              <label><span>审批说明 / 驳回原因</span><input value={ownerReason} maxLength={500} onChange={(event) => { setOwnerReason(event.target.value); actionKey.current = null; }} /></label>
              <div><button className="dx-button dx-button--primary" type="button" disabled={busy} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/owner-decisions`, { decision: "approved", ...(ownerReason.trim() ? { decisionReason: ownerReason.trim() } : {}) }, "老板已批准")}>批准</button><button className="dx-button dx-button--secondary" type="button" disabled={busy || !ownerReason.trim()} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/owner-decisions`, { decision: "rejected", decisionReason: ownerReason.trim() }, "已驳回生产管理重新调整")}>驳回</button></div>
            </div> : <p>当前账号仅可查看，本节点由老板办理。</p>}
          </Surface> : null}

          {["pending_contract", "pending_factory_change_verification"].includes(item.status) ? <Surface className="rework-detail-node-preview"><h2>05 · 合同执行</h2><p>老板已批准。本节点将在 PR4 接入合同登记与换厂核实；当前全部前序事实已经可见。</p></Surface> : null}
          {["pending_finance_reconciliation", "pending_exception_verification"].includes(item.status) ? <Surface className="rework-detail-node-preview"><h2>06 · 财务核对</h2><p>合同执行事实完成后进入财务核对。本节点将在 PR5 接入差异处理与闭环。</p></Surface> : null}
          {item.status === "closed" ? <Surface className="rework-detail-node-preview"><h2>订单已完成</h2><p>报价、调价、选厂、审批、合同和财务记录已完整归档。</p></Surface> : null}
          {message ? <p className="sourcing-action-message" role="status">{message}</p> : null}
        </section>
      </div>

      {selectedImage ? <div className="rework-image-modal" role="presentation" onMouseDown={() => setSelectedImage(null)}>
        <section className="rework-image-modal__content" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
          <div className="rework-image-modal__heading"><strong>{selectedImage.filename}</strong><button type="button" onClick={() => setSelectedImage(null)}>关闭</button></div>
          <ImageViewer src={attachmentUrl(selectedImage.attachmentId, "preview")} alt={selectedImage.filename} />
          <a href={attachmentUrl(selectedImage.attachmentId, "download")} target="_blank" rel="noreferrer">下载原图</a>
        </section>
      </div> : null}
    </div>
  );
}
