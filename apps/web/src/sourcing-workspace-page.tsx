import {
  AttachmentResponseSchema,
  DeleteSourcingCaseResponseSchema,
  MAX_SOURCING_ATTACHMENTS,
  MAX_SOURCING_PROCESSES,
  SOURCING_IMAGE_SUPPLEMENT_ROLES,
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
import { SourcingImageSupplementUploader } from "./sourcing-image-supplement-uploader.js";
import { confirmInApp } from "./system-dialog.js";
import "./rework-detail.css";
import "./rework-detail-compact.css";
import "./sourcing-workspace.css";

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
type LocalSourcingDraft = Readonly<{
  erpOrderNo: string;
  styleNo: string;
  deliveryDate: string;
  processes: readonly string[];
  orderQuantity: string;
  images: readonly UploadedImage[];
  savedAt: string;
}>;
type QuoteDraft = Readonly<{ unitPrice: string; quoteReason: string }>;
type DecisionDraft = Readonly<{ supplierId: string; unitPrice: string; decisionReason: string }>;
type FinanceReviewDraft = Readonly<{ differenceFields: readonly string[]; differenceReason: string }>;

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
    const parsed = JSON.parse(window.localStorage.getItem(localSourcingDraftKey(userId)) ?? "null") as Partial<LocalSourcingDraft> | null;
    if (!parsed || typeof parsed.erpOrderNo !== "string" || typeof parsed.styleNo !== "string"
      || typeof parsed.deliveryDate !== "string" || typeof parsed.orderQuantity !== "string"
      || !Array.isArray(parsed.processes) || parsed.processes.length < 1
      || !parsed.processes.every((process) => typeof process === "string")
      || !Array.isArray(parsed.images)) return null;
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
      erpOrderNo: parsed.erpOrderNo,
      styleNo: parsed.styleNo,
      deliveryDate: parsed.deliveryDate,
      processes: parsed.processes.slice(0, MAX_SOURCING_PROCESSES),
      orderQuantity: parsed.orderQuantity,
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

const isMobileClient = (): boolean => {
  if (typeof navigator === "undefined") return false;
  const client = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (client.userAgentData?.mobile === true) return true;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(client.userAgent)) return true;
  return client.platform === "MacIntel" && client.maxTouchPoints > 1;
};

const detailHref = (item: SourcingCaseSummary): string =>
  pageUrl(`ui/sourcing/orders/${item.sourcingCaseId}`);

function SourcingOrderCard({
  item,
  canDelete,
  deleting,
  onDelete,
}: {
  item: SourcingCaseSummary;
  canDelete: boolean;
  deleting: boolean;
  onDelete: (item: SourcingCaseSummary) => void;
}) {
  return <Surface className="sourcing-order-card">
    <a className="sourcing-order-card__main" href={detailHref(item)}>
      <div className="sourcing-order-card__heading">
        <div>
          <strong>{item.styleNo}</strong>
          <small>{item.erpOrderNo}</small>
        </div>
        <StatusBadge tone={item.status === "closed" ? "success" : "info"}>
          {STATUS_LABELS[item.status]}
        </StatusBadge>
      </div>
      <dl>
        <div><dt>订单数量</dt><dd>{formatBusinessDecimal(item.orderQuantity)}</dd></div>
        <div><dt>IE 单价</dt><dd>{item.ieQuote ? formatBusinessCurrency(item.ieQuote.unitPrice) : "—"}</dd></div>
        <div><dt>生产单价</dt><dd>{item.decision ? formatBusinessCurrency(item.decision.unitPrice) : "—"}</dd></div>
        <div><dt>加工厂</dt><dd>{item.decision?.supplierName ?? "待选厂"}</dd></div>
        <div><dt>交货日期</dt><dd>{item.deliveryDate ?? "—"}</dd></div>
      </dl>
      <small className="sourcing-order-card__activity">更新于 {formatDateTime(item.updatedAt)}</small>
    </a>
    {canDelete ? <button
      type="button"
      className="sourcing-order-delete"
      aria-label={`删除报价选厂订单 ${item.erpOrderNo}`}
      title="删除报价选厂订单"
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

  if (isMobileClient()) {
    return <Shell active={ACTIVE_NAVIGATION[view]}>
      <div className="sourcing-workspace">
        <Header title="报价&选厂" subtitle="该模块当前仅开放电脑端。" badge="PC 端" />
        <Surface><h2>请在电脑端打开</h2><p>报价选厂移动端尚未建设，手机端暂不展示或办理订单流程。</p></Surface>
      </div>
    </Shell>;
  }

  return (
    <Shell active={ACTIVE_NAVIGATION[view]}>
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
  const [erpOrderNo, setErpOrderNo] = useState("");
  const [styleNo, setStyleNo] = useState("");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [processes, setProcesses] = useState<string[]>([""]);
  const [orderQuantity, setOrderQuantity] = useState("");
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("填写订单资料并上传现场或款式照片。");
  const createKey = useRef<string | null>(null);
  const previewUrls = useRef<string[]>([]);
  const restoredDraftUserId = useRef("");
  const canCreate = canAct(user, "order_merchandiser", "sourcing:inquiry:create");

  useEffect(() => {
    if (!user?.id || restoredDraftUserId.current === user.id) return;
    restoredDraftUserId.current = user.id;
    const localDraft = readLocalSourcingDraft(user.id);
    if (!localDraft) return;
    setErpOrderNo(localDraft.erpOrderNo);
    setStyleNo(localDraft.styleNo);
    setDeliveryDate(localDraft.deliveryDate);
    setProcesses([...localDraft.processes]);
    setOrderQuantity(localDraft.orderQuantity);
    setImages([...localDraft.images]);
    setMessage("已恢复当前账号在本机保存的订单草稿。");
  }, [user?.id]);

  useEffect(() => () => {
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.current = [];
  }, []);

  const updateProcess = (index: number, value: string): void => {
    setProcesses((current) => current.map((process, currentIndex) => (
      currentIndex === index ? value : process
    )));
    createKey.current = null;
  };

  const addProcess = (): void => {
    if (processes.length >= MAX_SOURCING_PROCESSES) {
      setMessage(`每张订单最多登记 ${MAX_SOURCING_PROCESSES} 项工艺`);
      return;
    }
    setProcesses((current) => [...current, ""]);
    createKey.current = null;
  };

  const removeProcess = (index: number): void => {
    setProcesses((current) => current.length === 1
      ? [""]
      : current.filter((_process, currentIndex) => currentIndex !== index));
    createKey.current = null;
  };

  const uploadImages = async (files: FileList | null): Promise<void> => {
    if (!files?.length || uploading || busy) return;
    const selected = Array.from(files);
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
      setMessage(`已上传 ${uploaded.length} 张图片；请核对订单资料后提交`);
      createKey.current = null;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "订单图片上传失败");
    } finally {
      setUploading(false);
    }
  };

  const removeImage = (attachmentId: string): void => {
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
      erpOrderNo,
      styleNo,
      deliveryDate,
      processes,
      orderQuantity,
      images,
      savedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(localSourcingDraftKey(user.id), JSON.stringify(draft));
    setMessage("草稿已保存在本机；下次打开创建订单会自动恢复。");
  };

  const createOrder = async (): Promise<void> => {
    const quantity = Number(orderQuantity);
    const normalizedProcesses = processes.map((process) => process.trim());
    if (!canCreate) { setMessage("当前账号没有创建订单权限"); return; }
    if (!erpOrderNo.trim() || !styleNo.trim()) { setMessage("请填写 ERP 订单号和款号"); return; }
    if (!deliveryDate || normalizedProcesses.some((process) => !process)) {
      setMessage("请填写交货日期和所有工艺");
      return;
    }
    if (new Set(normalizedProcesses).size !== normalizedProcesses.length) {
      setMessage("工艺不能重复，请合并或修改重复项");
      return;
    }
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
          deliveryDate,
          processes: normalizedProcesses,
          orderQuantity: quantity,
          attachmentIds: images.map((image) => image.attachmentId),
        }),
      });
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
          <label><span>交货日期</span><input type="date" value={deliveryDate} onChange={(event) => { setDeliveryDate(event.target.value); createKey.current = null; }} /></label>
          <label className="sourcing-process-mobile"><span>工艺</span><input value={processes[0]} maxLength={100} onChange={(event) => updateProcess(0, event.target.value)} placeholder="请输入订单工艺要求" /></label>
          <section className="sourcing-process-editor sourcing-form-wide" aria-label="订单工艺清单">
            <div className="sourcing-process-editor__heading">
              <div><strong>工艺清单</strong><small>每项工艺单独一行，按实际生产顺序登记</small></div>
              <button type="button" disabled={processes.length >= MAX_SOURCING_PROCESSES} onClick={addProcess}>＋ 新增工艺</button>
            </div>
            <div className="sourcing-process-editor__list">
              {processes.map((process, index) => <div className="sourcing-process-row" key={index}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                <label><span className="visually-hidden">第 {index + 1} 项工艺</span><input value={process} maxLength={100} onChange={(event) => updateProcess(index, event.target.value)} placeholder="例如：车缝、整烫、水洗" /></label>
                <button type="button" aria-label={`删除第 ${index + 1} 项工艺`} disabled={processes.length === 1} onClick={() => removeProcess(index)}>删除</button>
              </div>)}
            </div>
          </section>
        </div>
        <section className="sourcing-photo-field" aria-label="订单照片">
          <div className="section-title">
            <div><h2>订单照片</h2><p>复用返工系统图片规范，支持 JPG、PNG、WebP。</p></div>
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
          <p role="status">{message}</p>
          <div className="sourcing-create-actions">
            <button className="dx-button dx-button--secondary" type="button" disabled={busy || uploading} onClick={saveLocalDraft}>保存草稿</button>
            <button className="dx-button dx-button--primary" type="button" disabled={busy || uploading || !canCreate} onClick={() => void createOrder()}>
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
  const [items, setItems] = useState<readonly SourcingCaseSummary[]>([]);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("正在加载订单…");
  const [deletingCaseId, setDeletingCaseId] = useState("");
  const [deleteError, setDeleteError] = useState("");

  const load = async (query = search): Promise<void> => {
    try {
      const body = await request(
        `sourcing/cases?status=${mode === "history" ? "closed" : "pending"}&q=${encodeURIComponent(query.trim())}`,
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

  const remove = async (item: SourcingCaseSummary): Promise<void> => {
    if (!(await confirmInApp(
      `确认删除报价选厂订单 ${item.erpOrderNo} 吗？删除后将从业务入口隐藏并关闭相关待办，历史证据仍会保留。`,
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
        title={mode === "pending" ? "待审批订单" : "历史订单"}
        subtitle={mode === "pending" ? "所有未完成订单集中在这里，点击订单查看完整流程和当前办理区。" : "所有已完成订单集中归档，保留报价、调价、选厂和审批证据。"}
        badge={`${visible.length} 单`}
      />
      <Surface className="sourcing-list-card">
        <form className="sourcing-search" onSubmit={(event) => { event.preventDefault(); void load(search); }}>
          <input value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 ERP、款号、跟单、供应商、工艺或合同编号" />
          <button className="dx-button dx-button--secondary" type="submit">搜索</button>
        </form>
        {deleteError ? <p className="sourcing-delete-error" role="alert">{deleteError}</p> : null}
        {message ? <p className="sourcing-list-message" role="status">{message}</p> : null}
        {!message && visible.length === 0 ? <p className="sourcing-list-message">暂无符合条件的订单</p> : null}
        <div className="sourcing-order-list">
          {visible.map((item) => <SourcingOrderCard
            item={item}
            key={item.sourcingCaseId}
            canDelete={user?.isRoot === true}
            deleting={deletingCaseId === item.sourcingCaseId}
            onDelete={(order) => { void remove(order); }}
          />)}
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
  { key: "finance", number: "05", label: "财务核对", role: "财务" },
] as const;

const statusStep = (status: SourcingCaseStatus): number => ({
  pending_ie_quote: 1,
  pending_management_decision: 2,
  pending_owner_approval: 3,
  pending_contract: 4,
  pending_factory_change_verification: 4,
  pending_finance_reconciliation: 4,
  pending_exception_verification: 4,
  closed: 5,
})[status];

const timelineLabel = (entry: SourcingTimelineEntry): string => ({
  created: "创建订单",
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

const sourcingWorkflowNodeHref = (sourcingCaseId: string, key: SourcingWorkflowNodeKey): string =>
  `${pageUrl(`ui/sourcing/orders/${sourcingCaseId}`)}?node=${key}#node-workspace`;

const timelineNode = (entry: SourcingTimelineEntry): SourcingWorkflowNodeKey => ({
  created: "created",
  ie_quote: "ie_quote",
  management_decision: "management",
  owner_decision: "owner",
  contract: "finance",
  factory_change_request: "finance",
  factory_change_verification: "finance",
  finance_reconciliation: "finance",
  exception_verification: "finance",
} as const)[entry.kind];

const WORKFLOW_PREVIEWS: Readonly<Record<SourcingWorkflowNodeKey, string>> = {
  created: "查看跟单创建订单时提交的订单资料与图片。",
  ie_quote: "查看 IE 核定的加工单价、数量、总额和说明。",
  management: "查看生产管理的调价、选厂及决定依据。",
  owner: "查看老板最终审批结论与审批说明。",
  finance: "查看换厂、财务四项核对、差异处理和闭环记录。",
};

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
  const [financeReview, setFinanceReview] = useState<FinanceReviewDraft>({ differenceFields: [], differenceReason: "" });
  const [exceptionReason, setExceptionReason] = useState("");
  const [selectedImage, setSelectedImage] = useState<SourcingAttachment | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("正在加载订单…");
  const [activeBusinessInput, setActiveBusinessInput] = useState<string | null>(null);
  const actionKey = useRef<string | null>(null);
  const canSupplementImages = user?.isRoot === true
    || user?.businessRoles?.some((role) => SOURCING_IMAGE_SUPPLEMENT_ROLES.includes(
      role as (typeof SOURCING_IMAGE_SUPPLEMENT_ROLES)[number],
    )) === true;

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
      setFinance((current) => ({
        supplierId: current.supplierId || detail.decision?.supplierId || "",
        unitPrice: current.unitPrice || detail.decision?.unitPrice || "",
        quantity: current.quantity || String(detail.decision?.quantity ?? detail.orderQuantity),
        totalAmount: current.totalAmount || detail.decision?.totalAmount || "",
        differenceReason: current.differenceReason,
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
  const canFinance = canAct(user, "factory_payables", "sourcing:finance:reconcile");
  const canVerifyException = canAct(user, "production_management", "sourcing:exception:verify");

  useEffect(() => {
    if (!canManage && !canChangeFactory && !canFinance) return;
    void request("sourcing/factories", SourcingFactoryListResponseSchema)
      .then((body) => setFactories(body.items))
      .catch((error) => setMessage(error instanceof Error ? error.message : "加工厂加载失败"));
  }, [canManage, canChangeFactory, canFinance]);

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
  const activeNode = WORKFLOW[Math.min(step, WORKFLOW.length - 1)]?.key ?? "finance";
  const selectedNode = sourcingWorkflowNodeFromSearch() ?? activeNode;
  const selectedIndex = WORKFLOW.findIndex((node) => node.key === selectedNode);
  const selectedState: SourcingWorkflowNodeState = item.status === "closed" || selectedIndex < step
    ? "completed"
    : selectedIndex === step ? "current" : "future";
  const selectedTimeline = timeline.filter((entry) => timelineNode(entry) === selectedNode);
  const selectedWorkflow = WORKFLOW[selectedIndex] ?? WORKFLOW[WORKFLOW.length - 1]!;
  const priceAdjusted = item.ieQuote && item.decision
    ? item.ieQuote.unitPrice !== item.decision.unitPrice
    : false;
  const ownerUnitPriceDelta = item.ieQuote && item.decision
    ? subtractFixedPoint(item.decision.unitPrice, item.ieQuote.unitPrice, 4)
    : null;
  const ownerTotalDelta = item.ieQuote && item.decision
    ? subtractFixedPoint(item.decision.totalAmount, item.ieQuote.totalAmount, 2)
    : null;
  const latestFinance = [...timeline].reverse()
    .find((entry) => entry.kind === "finance_reconciliation");

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
      <div className="rework-detail-layout rework-detail-target-layout">
        <dl className="rework-detail-core-facts" aria-label="报价选厂订单核心信息">
          <div className="rework-detail-core-fact"><dt>订单数量</dt><dd>{item.orderQuantity.toLocaleString("zh-CN")} 件</dd></div>
          <div className="rework-detail-core-fact"><dt>交货日期</dt><dd>{item.deliveryDate ?? "—"}</dd></div>
          <div className="rework-detail-core-fact sourcing-core-processes"><dt>工艺</dt><dd>{item.processes.length ? <ol>{item.processes.map((process) => <li key={process}>{process}</li>)}</ol> : "—"}</dd></div>
          <div className="rework-detail-core-fact"><dt>IE 单价</dt><dd>{item.ieQuote ? formatBusinessCurrency(item.ieQuote.unitPrice) : "—"}</dd></div>
          <div className="rework-detail-core-fact"><dt>生产单价</dt><dd>{item.decision ? formatBusinessCurrency(item.decision.unitPrice) : "—"}</dd></div>
          <div className="rework-detail-core-fact"><dt>加工厂</dt><dd>{item.decision?.supplierName ?? "待选厂"}</dd></div>
          <div className="rework-detail-core-fact"><dt>总额</dt><dd>{item.decision ? formatBusinessCurrency(item.decision.totalAmount) : item.ieQuote ? formatBusinessCurrency(item.ieQuote.totalAmount) : "—"}</dd></div>
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
            {canSupplementImages ? <SourcingImageSupplementUploader
              sourcingCaseId={sourcingCaseId}
              currentAttachmentCount={attachments.length}
              onUploaded={load}
            /> : null}
          </section>

          <section className="rework-workflow" aria-label="订单流程">
            <div className="rework-workflow__heading rework-detail-panel-title">
              <div><h2>订单流程</h2><p>所有节点始终可见，当前环节不会遮住前序事实。</p></div>
              <span className="rework-workflow__step-count">当前步骤 {Math.min(step + 1, WORKFLOW.length)} / {WORKFLOW.length}</span>
            </div>
            <div className="rework-workflow__desktop-grid">
              {WORKFLOW.map((node, index) => {
                const state: SourcingWorkflowNodeState = item.status === "closed" || index < step ? "completed" : index === step ? "current" : "future";
                return <a className={`rework-workflow__node is-${state}`} href={sourcingWorkflowNodeHref(item.sourcingCaseId, node.key)} key={node.key}>
                  <b>{node.number}</b>
                  <span><strong>{node.label}</strong><small>{node.role}</small></span>
                  <em>{state === "completed" ? "已完成" : state === "current" ? "处理中" : "未开始"}</em>
                </a>;
              })}
            </div>
          </section>
        </div>

        <section id="node-workspace" className="rework-detail-task rework-detail-workspace sourcing-action-panel" aria-label="节点办理区">
          <div className="rework-detail-task__heading"><h2>办理区</h2><StatusBadge tone={selectedState === "completed" ? "success" : "info"}>{selectedState === "completed" ? "已完成 · 可只读" : selectedState === "current" ? STATUS_LABELS[item.status] : "未开始 · 可预览"}</StatusBadge></div>
          {selectedState !== "current" ? <Surface className="rework-detail-node-preview">
            <h2>{selectedWorkflow.number} · {selectedWorkflow.label}</h2>
            <p>{WORKFLOW_PREVIEWS[selectedWorkflow.key]}</p>
            <p>负责角色：{selectedWorkflow.role}</p>
            {selectedState === "completed" ? <details className="rework-detail-node-history">
              <summary>处理历史{selectedTimeline.length ? ` · ${selectedTimeline.length} 条` : ""}</summary>
              {selectedTimeline.length ? <div className="sourcing-timeline">
                {selectedTimeline.map((entry) => <article key={entry.entryId}>
                  <div><strong>{timelineLabel(entry)}</strong><small>{formatDateTime(entry.handledAt)} · {entry.handledBy}</small></div>
                  <p>{entry.reason}</p>
                  <dl>
                    {entry.unitPrice ? <div><dt>单价</dt><dd>{formatBusinessCurrency(entry.unitPrice)}</dd></div> : null}
                    {entry.totalAmount ? <div><dt>总额</dt><dd>{formatBusinessCurrency(entry.totalAmount)}</dd></div> : null}
                    {entry.quantity ? <div><dt>数量</dt><dd>{entry.quantity.toLocaleString("zh-CN")} 件</dd></div> : null}
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
            <p>输入加工单价，系统按订单数量精确计算总额。</p>
            {canQuote ? <div className="sourcing-form-grid">
              <label><span>加工单价</span><input value={activeBusinessInput === "quote-unit-price" ? quote.unitPrice : businessInputValue(quote.unitPrice)} inputMode="decimal" onChange={(event) => { setQuote({ ...quote, unitPrice: businessInputChange(event.target.value) }); actionKey.current = null; }} onFocus={() => setActiveBusinessInput("quote-unit-price")} onBlur={() => setActiveBusinessInput(null)} /></label>
              <label><span>系统总额</span><input value={businessInputValue(totalPreview(quote.unitPrice, item.orderQuantity))} readOnly /></label>
              <label className="sourcing-form-wide"><span>价格说明</span><input value={quote.quoteReason} maxLength={500} onChange={(event) => { setQuote({ ...quote, quoteReason: event.target.value }); actionKey.current = null; }} /></label>
              <button className="dx-button dx-button--primary" type="button" disabled={busy} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/ie-quotes`, { unitPrice: quote.unitPrice, ...(quote.quoteReason.trim() ? { quoteReason: quote.quoteReason.trim() } : {}) }, "IE 价格已提交")}>提交 IE 价格</button>
            </div> : <p>当前账号仅可查看，本节点由 IE 办理。</p>}
          </Surface> : null}

          {item.status === "pending_management_decision" && selectedNode === "management" ? <Surface className="rework-detail-node-preview">
            <h2>03 · 生产管理调价与选厂</h2>
            <p>IE 原价：{item.ieQuote ? formatBusinessCurrency(item.ieQuote.unitPrice) : "—"}。如调整价格，必须填写原因。</p>
            {canManage ? <div className="sourcing-form-grid">
              <label><span>加工厂</span><select value={decision.supplierId} onChange={(event) => { setDecision({ ...decision, supplierId: event.target.value }); actionKey.current = null; }}><option value="">请选择加工厂</option>{factories.map((factory) => <option key={factory.supplierId} value={factory.supplierId}>{factory.supplierName}</option>)}</select></label>
              <label><span>生产单价</span><input value={activeBusinessInput === "decision-unit-price" ? decision.unitPrice : businessInputValue(decision.unitPrice)} inputMode="decimal" onChange={(event) => { setDecision({ ...decision, unitPrice: businessInputChange(event.target.value) }); actionKey.current = null; }} onFocus={() => setActiveBusinessInput("decision-unit-price")} onBlur={() => setActiveBusinessInput(null)} /></label>
              <label><span>系统总额</span><input value={businessInputValue(totalPreview(decision.unitPrice, item.orderQuantity))} readOnly /></label>
              <label className="sourcing-form-wide"><span>选厂/调价说明</span><input value={decision.decisionReason} maxLength={500} onChange={(event) => { setDecision({ ...decision, decisionReason: event.target.value }); actionKey.current = null; }} /></label>
              <button className="dx-button dx-button--primary" type="button" disabled={busy} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/management-decisions`, { supplierId: decision.supplierId, unitPrice: decision.unitPrice, ...(decision.decisionReason.trim() ? { decisionReason: decision.decisionReason.trim() } : {}) }, "选厂决定已提交老板审批")}>提交调价与选厂</button>
            </div> : <p>当前账号仅可查看，本节点由生产管理办理。</p>}
          </Surface> : null}

          {item.status === "pending_owner_approval" && selectedNode === "owner" ? <Surface className="rework-detail-node-preview sourcing-owner-decision">
            <div className="sourcing-owner-mobile-summary">
              <h2>04 · 最终审批</h2>
              <p>{item.decision?.supplierName ?? "—"} · {item.decision ? formatBusinessCurrency(item.decision.unitPrice) : "—"}/件 · {formatBusinessDecimal(item.orderQuantity)} 件</p>
            </div>
            <div className="sourcing-owner-decision__desktop">
              <h2>04 · 最终审批</h2>
              <p className="sourcing-owner-decision__lead">生产管理建议由 <strong>{item.decision?.supplierName ?? "—"}</strong> 以 <strong>{item.decision ? formatBusinessCurrency(item.decision.unitPrice) : "—"}/件</strong> 承接 <strong>{formatBusinessDecimal(item.orderQuantity)} 件</strong>，订单总额 <strong>{item.decision ? formatBusinessCurrency(item.decision.totalAmount) : "—"}</strong>。</p>
              <p>相对 IE 报价 {item.ieQuote ? `${formatBusinessCurrency(item.ieQuote.unitPrice)}/件` : "—"}，单价变化 <strong>{ownerUnitPriceDelta ?? "—"}/件</strong>，总额变化 <strong>{ownerTotalDelta ?? "—"}</strong>。{item.decision?.decisionReason ? `生产管理说明：${item.decision.decisionReason}` : "生产管理未补充说明。"}</p>
              <details className="sourcing-owner-decision__details">
                <summary>查看完整订单资料</summary>
                <p>ERP：{item.erpOrderNo}；款号：{item.styleNo}；交货日期：{item.deliveryDate ?? "—"}；工艺：{item.processes.length ? item.processes.join("、") : "—"}。</p>
              </details>
            </div>
            {canOwner ? <div className="sourcing-owner-actions">
              <label><span>审批说明 / 驳回原因</span><input value={ownerReason} maxLength={500} onChange={(event) => { setOwnerReason(event.target.value); actionKey.current = null; }} /></label>
              <div><button className="dx-button dx-button--primary" type="button" disabled={busy} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/owner-decisions`, { decision: "approved", ...(ownerReason.trim() ? { decisionReason: ownerReason.trim() } : {}) }, "老板已批准")}>批准方案</button><button className="dx-button dx-button--secondary" type="button" disabled={busy || !ownerReason.trim()} onClick={() => void submit(`sourcing/cases/${item.sourcingCaseId}/owner-decisions`, { decision: "rejected", decisionReason: ownerReason.trim() }, "已驳回生产管理重新调整")}>驳回并退回生产管理</button></div>
            </div> : <p>当前账号仅可查看，本节点由老板办理。</p>}
          </Surface> : null}

          {item.status === "pending_finance_reconciliation" && selectedNode === "finance" ? <Surface className="rework-detail-node-preview">
            <h2>05 · 财务核对</h2>
            <p>财务仅核对老板批准的合同事实，不可修改加工厂、单价、数量或总额。</p>
            {item.decision ? <dl className="sourcing-finance-reference" aria-label="老板批准的选厂决定">
              <div><dt>批准加工厂</dt><dd>{item.decision.supplierName}</dd></div>
              <div><dt>批准单价</dt><dd>{formatBusinessCurrency(item.decision.unitPrice)}</dd></div>
              <div><dt>批准数量</dt><dd>{formatBusinessDecimal(item.decision.quantity)} 件</dd></div>
              <div><dt>批准总额</dt><dd>{formatBusinessCurrency(item.decision.totalAmount)}</dd></div>
            </dl> : null}
            {canFinance ? <div className="sourcing-finance-confirmation">
              <p>请对照合同确认上述四项事实。若发现不一致，只记录差异项和说明，由生产管理核实；财务不能在此页改写业务数据。</p>
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
