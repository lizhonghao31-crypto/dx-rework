import { specialProcessLabel, specialProcessName } from "@dx-rework/contracts";
import { ReceivedQuantityLabel } from "./received-quantity-label.js";
import { FinanceNodeKeySchema } from "@dx-rework/contracts/reporting";
import { ReworkNodeHistoryPage, reworkHistoryHref } from "./rework-node-history-page.js";
import { moduleCanWrite } from "./member-module-policy.js";
import { canOperateReworkNode, WHOLE_ORDER_REVIEW_CAPABILITIES } from "./rework-node-access.js";
import { FinanceNodePanel } from "./reporting/finance-node-panel.js";
import { Button, StatusBadge, Surface, WorkflowRail } from "@dx-rework/ui";
import { REWORK_IMAGE_SUPPLEMENT_ROLES, type InspectionReportDraft } from "@dx-rework/contracts";
import { formatBusinessCurrency, formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { useCallback, useEffect, useRef, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { createClientRequestId } from "./client-request-id.js";
import { verifySession, type AuthorizedUser } from "./auth.js";
import { Header, Shell } from "./components.js";
import { OrderResponsibilityRevisionPanel } from "./order-responsibility-revision-panel.js";
import { reworkReturnPath } from "./rework-return-path.js";
import { InitiationFollowUpActions } from "./rework-initiation-actions.js";
import { publishReworkNodeRefresh, reworkInitiationAccess } from "./rework-initiation-access.js";
import { ExternalResponsibilityPanel } from "./external-responsibility-panel.js";
import { InspectionReportReadonly } from "./inspection-report-readonly.js";
import { ImageViewer } from "./image-viewer.js";
import { OrderImageSupplementUploader } from "./order-image-supplement-uploader.js";
import { ProcessConfigurationForm } from "./process-configuration-form.js";
import { ReworkInitiationForm } from "./rework-form.js";
import { ResponsibilityDeterminationPanel } from "./responsibility-determination-panel.js";
import { promptInApp } from "./system-dialog.js";
import { WorkReportingForm } from "./work-reporting-form.js";
import "./rework-detail.css";
import "./rework-detail-compact.css";
import "./rework-mobile.css";
import "./order-overview-responsive.css";
import "./rework-governed.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

type ReworkStatus =
  | "draft"
  | "pending_process_configuration"
  | "pending_ie_review"
  | "pending_task_assignment"
  | "in_progress"
  | "pending_order_review"
  | "pending_final_quantity_ie_review"
  | "pending_quantity_adjustment_ie_review"
  | "pending_responsibility_determination"
  | "pending_owner_signature"
  | "pending_responsibility_action"
  | "completed"
  | "cancelled";

export type WorkflowNodeKey =
  | "initiation"
  | "process_configuration"
  | "ie_review"
  | "task_assignment"
  | "work_reporting"
  | "whole_order_review"
  | "final_quantity_ie_review"
  | "quantity_adjustment"
  | "responsibility"
  | "owner_signature"
  | "settlement_ledger"
  | "archive"
  | "settlement_followup";

export type ReworkBusinessDetail = Readonly<{
  reworkOrderId: string;
  reworkNo: string | null;
  status: ReworkStatus;
  reworkKind?: "qc_rework" | "inhouse_finishing";
  version: number;
  styleNo: string | null;
  customerSupplyCode: string | null;
  factoryStyleNo: string | null;
  orderNo: string | null;
  orderQuantity: number | null;
  sourceReceivingActualQuantity: number | null;
  iePrecounts: Readonly<{
    canRecord: boolean;
    processes: readonly Readonly<{
      configurationItemId: string;
      processName: string;
    }>[];
    entries: readonly Readonly<{
      entryId: string;
      configurationItemId: string;
      processName: string;
      quantity: number;
      note: string | null;
      recordedBy: string;
      recordedAt: string;
    }>[];
  }>;
  defectiveQuantity: Readonly<{
    receiving: number;
    receivingLinked: boolean;
    tail: number;
    total: number;
    canAddTail: boolean;
    tailEntries: readonly Readonly<{
      entryId: string;
      quantity: number;
      recordedBy: string;
      recordedAt: string;
    }>[];
  }>;
  supplyContext: Readonly<{
    washingSupplierName: string | null;
    embroiderySupplierName: string | null;
    fabricSupplierName: string | null;
    embroideryMerchandiserName: string | null;
  }>;
  merchandiser: Readonly<{ userId: string; displayName: string }> | null;
  processingFactory: Readonly<{
    type: "own_factory" | "supplier";
    supplierId: string | null;
    displayName: string;
  }> | null;
  reworkReason: string | null;
  reworkProcess: string | null;
  problemPart: string | null;
  problemDescription: string | null;
  reworkQuantity: number | null;
  tailInspectionRequired: boolean;
  specialProcessType?: "none" | "inspection" | "other_craft" | null;
  otherCraftDescription?: string | null;
  canReadBusinessDetails?: boolean;
  singlePieceReworkTotal: number | null;
  inspectionReport: InspectionReportDraft | null;
  createdBy: Readonly<{ userId: string; displayName: string }>;
  processConfigurationCreatedBy: Readonly<{ userId: string; displayName: string }> | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  settlementStatus: "not_required" | "in_progress" | "closed" | "revision_in_progress";
  wageSettlementStatus: "not_required" | "in_progress" | "closed";
  unsettledWagePeriods: readonly Readonly<{
    periodId: string;
    periodMonth: string;
    status: "pending_tail_review" | "pending_admin_review" | "ready_to_lock";
  }>[];
  attachments: readonly Readonly<{
    attachmentId: string;
    filename: string;
    mimeType: string;
    entityType: "rework_order" | "external_responsibility_case" | "receiving_batch" | "sourcing_case";
  }>[];
  workflowHistory: readonly Readonly<{
    action: string;
    handledBy: string;
    handledAt: string;
    remark: string | null;
  }>[];
}>;

type ReworkAttachment = ReworkBusinessDetail["attachments"][number];
type LoadState = { kind: "loading" } | { kind: "ready"; value: ReworkBusinessDetail } | { kind: "error"; message: string };
type WorkflowNodeState = "completed" | "current" | "future" | "followup";
type WorkflowNode = Readonly<{
  key: WorkflowNodeKey;
  number: string;
  label: string;
  ownerRole: string;
  ownerName: string;
  state: WorkflowNodeState;
  preview: string;
}>;
type WorkflowStage = Readonly<{ key: string; title: string; nodes: readonly WorkflowNode[] }>;

const statusMeta: Record<ReworkStatus, { label: string; next: string }> = {
  draft: { label: "草稿", next: "等待发起人补充并提交" },
  pending_process_configuration: { label: "待分配工序 &工人", next: "下一步由尾部主管一次完成工序、候选单价、返工人员与整查分配" },
  pending_ie_review: { label: "待 IE 核价", next: "IE 通过后返工人员与整查任务统一生效并进入执行" },
  pending_task_assignment: { label: "待启动执行任务", next: "IE 已通过；预分配执行任务等待自动启动，可在节点02重试启动" },
  in_progress: { label: "返工执行中", next: "返工人员与整查统一登记实际完成数量，全部完成后由尾部主管核量" },
  pending_order_review: { label: "待尾部确认最终数量", next: "核对工人上数与整查数量，提交每道工序最终确认数量" },
  pending_final_quantity_ie_review: { label: "最终数量待 IE 复核", next: "IE 核对数量与质量事实；通过后生成正式工资并进入责任判定" },
  pending_quantity_adjustment_ie_review: { label: "数量调整待 IE", next: "异常数量增加申请等待 IE 复核" },
  pending_responsibility_determination: { label: "待责任判定", next: "返工已完成整单确认，正在选择主责任方和外部扣款倍率" },
  pending_owner_signature: { label: "待老板签字", next: "生产管理资料已齐全，等待老板确认同意或驳回" },
  pending_responsibility_action: { label: "责任处理中", next: "责任已判定，正在完成本厂审批或外部责任结算" },
  completed: { label: "已完成", next: "订单完成即进入扣款；工资金额仅供财务查询与对数" },
  cancelled: { label: "已取消", next: "返工单已取消，历史资料和操作记录继续保留" },
};

const statusRank: Record<Exclude<ReworkStatus, "cancelled">, number> = {
  draft: 0,
  pending_process_configuration: 1,
  pending_ie_review: 2,
  pending_task_assignment: 3,
  in_progress: 4,
  pending_order_review: 5,
  pending_final_quantity_ie_review: 6,
  pending_quantity_adjustment_ie_review: 5,
  pending_responsibility_determination: 7,
  pending_owner_signature: 8,
  pending_responsibility_action: 9,
  completed: 10,
};

const currentNodeByStatus: Partial<Record<ReworkStatus, WorkflowNodeKey>> = {
  draft: "initiation",
  pending_process_configuration: "process_configuration",
  pending_ie_review: "ie_review",
  pending_task_assignment: "process_configuration",
  in_progress: "work_reporting",
  pending_order_review: "whole_order_review",
  pending_final_quantity_ie_review: "final_quantity_ie_review",
  pending_quantity_adjustment_ie_review: "whole_order_review",
  pending_responsibility_determination: "responsibility",
  pending_owner_signature: "owner_signature",
  pending_responsibility_action: "settlement_followup",
  completed: "settlement_followup",
};

const nodeRank: Record<WorkflowNodeKey, number> = {
  initiation: 0,
  process_configuration: 1,
  ie_review: 2,
  task_assignment: 3,
  work_reporting: 4,
  whole_order_review: 5,
  final_quantity_ie_review: 6,
  quantity_adjustment: 5,
  responsibility: 7,
  owner_signature: 8,
  settlement_ledger: 8,
  archive: 9,
  settlement_followup: 9,
};

const nodeKeys = new Set<WorkflowNodeKey>([
  "initiation", "process_configuration", "ie_review", "task_assignment", "work_reporting",
  "whole_order_review", "final_quantity_ie_review", "quantity_adjustment", "responsibility", "owner_signature", "settlement_ledger", "archive", "settlement_followup",
]);

const orderIdFromLocation = (): string | null => {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const currentPath = window.location.pathname.startsWith(basePath)
    ? window.location.pathname.slice(basePath.length) || "/"
    : window.location.pathname;
  const match = currentPath.match(/^\/ui\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
  return match?.[1] ?? null;
};

const workflowNodeFromSearch = (): WorkflowNodeKey | null => {
  const value = new URLSearchParams(window.location.search).get("node");
  if (value === "archive") return "settlement_followup";
  if (value === "task_assignment") return "process_configuration";
  return value && nodeKeys.has(value as WorkflowNodeKey) ? value as WorkflowNodeKey : null;
};

const formatTime = (value: string | null): string => {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hour12: false, timeZone: "Asia/Shanghai",
  }).format(new Date(value));
};

const attachmentUrl = (attachmentId: string, mode: "preview" | "download"): string =>
  apiUrl(`tools/attachments/${attachmentId}/download?mode=${mode}`);

const hasRole = (user: AuthorizedUser | null, role: string): boolean => user?.businessRoles?.includes(role) === true;
const hasCapability = (user: AuthorizedUser | null, capability: string): boolean => user?.capabilities.includes(capability) === true;
const elevated = (user: AuthorizedUser | null): boolean => user?.isRoot === true || hasRole(user, "owner_group");
const canSupplementImagesByRole = (user: AuthorizedUser | null): boolean => elevated(user)
  || REWORK_IMAGE_SUPPLEMENT_ROLES.some((role) => hasRole(user, role));

const canUseProcessWorkspace = (user: AuthorizedUser | null): boolean => elevated(user)
  || (hasRole(user, "tail_supervisor") && hasCapability(user, "process:configure"))
  || (hasRole(user, "ie_reviewer") && hasCapability(user, "process:review"));
const canUseWorkWorkspace = (user: AuthorizedUser | null): boolean => elevated(user)
  || (hasRole(user, "tail_supervisor") && (
    hasCapability(user, "work:assign") || hasCapability(user, "submission:audit") || hasCapability(user, "quantity:adjust")
  ))
  || (hasRole(user, "worker") && hasCapability(user, "work:report"))
  || (hasRole(user, "tail_inspector") && hasCapability(user, "tail_inspection:report"))
  || hasCapability(user, "work:report_for_worker")
  || (hasRole(user, "order_merchandiser") && hasCapability(user, "quantity:confirm"))
  || (hasRole(user, "ie_reviewer") && hasCapability(user, "process:review"));
const workflowState = (detail: ReworkBusinessDetail, key: WorkflowNodeKey): WorkflowNodeState => {
  if (detail.status === "cancelled") return "future";
  if (key === "settlement_ledger" && detail.status === "pending_responsibility_action") return "completed";
  if (detail.status === "completed") {
    if (key !== "settlement_followup") return "completed";
    return detail.settlementStatus === "closed" ? "completed" : "followup";
  }
  if (currentNodeByStatus[detail.status] === key) return "current";
  return statusRank[detail.status] > nodeRank[key] ? "completed" : "future";
};

const currentOwner = (
  state: WorkflowNodeState,
  user: AuthorizedUser | null,
  fallback: string,
  confirmedAssignee: boolean,
): string => state === "current" && confirmedAssignee && user ? user.displayName : fallback;

const buildWorkflow = (
  detail: ReworkBusinessDetail,
  user: AuthorizedUser | null,
  assignedNode?: WorkflowNodeKey,
): readonly WorkflowStage[] => {
  const node = (
    key: WorkflowNodeKey,
    number: string,
    label: string,
    ownerRole: string,
    fallbackOwner: string,
    preview: string,
  ): WorkflowNode => {
    const state = workflowState(detail, key);
    return {
      key,
      number,
      label,
      ownerRole,
      ownerName: currentOwner(state, user, fallbackOwner, assignedNode === key),
      state,
      preview,
    };
  };
  return [
    {
      key: "planning",
      title: "发起、配置与核价",
      nodes: [
        node("initiation", "01", detail.reworkKind === "inhouse_finishing" ? "本厂做尾" : "发起返工", detail.reworkKind === "inhouse_finishing" ? "尾部主管" : "质检", detail.createdBy.displayName, detail.reworkKind === "inhouse_finishing" ? "沿用来源款图、加工厂与跟单资料发起做尾。" : "登记数字化验货单和纸质报告附件后提交返工单。"),
        node("process_configuration", "02", "分配工序 &工人", "尾部主管", detail.processConfigurationCreatedBy?.displayName ?? "待提交后分配", detail.tailInspectionRequired ? `一次完成返工工序、候选单价、返工人员与${specialProcessLabel(detail)}分配；不再设置独立人员分配节点。` : `一次完成返工工序、候选单价与返工人员分配；本单无需${specialProcessLabel(detail)}。`),
        node("ie_review", "03", "IE 核价", "IE", "待尾部提交", "IE 只核准工序单价；通过后预分配工人自动生效并进入返工执行。"),
      ],
    },
    {
      key: "execution",
      title: "返工执行",
      nodes: [
        node("work_reporting", "04", "返工执行报数", detail.tailInspectionRequired ? `返工人员 / ${specialProcessLabel(detail)}` : "返工人员", "待 IE 核价通过并自动激活任务", detail.tailInspectionRequired ? `返工人员与${specialProcessLabel(detail)}都在同一执行节点提交本人实际件数；临时工由尾部主管代录。` : "返工人员在执行节点提交本人实际件数；临时工由尾部主管代录。"),
      ],
    },
    {
      key: "responsibility",
      title: detail.reworkKind === "inhouse_finishing" ? "最终确认与计薪" : "责任与结算",
      nodes: [
        node("whole_order_review", "05", "尾部最终数量确认", "尾部主管", "待全部执行报数完成", detail.tailInspectionRequired ? `逐工序对照工人原报数与${specialProcessLabel(detail)}数，提交最终确认数量并保留每版审计。` : "系统按工人有效上数生成最终数量，并保留每版审计。"),
        node("final_quantity_ie_review", "06", "IE 最终数量复核", "IE", "待 N05 提交", "只复核数量与质量事实；通过后生成正式工资，退回则回到 N05。"),
        ...(detail.reworkKind === "inhouse_finishing" ? [] : [
        node("responsibility", "07", "责任判定", "生产管理", "待 N06 通过", "每道工序只选一个主责任方；外部扣款倍率默认且最低 1.2，可向上调整。"),
        node("owner_signature", "08", "老板确认签字", "老板", "待 N07 提交", "老板直接确认或驳回已锁定的责任方与外部扣款倍率。"),
        node("settlement_followup", "09", "返工业务完成", "系统", "N08 同意后完成", "订单完成即进入供应商扣款；工资金额仅供财务查询与对数。"),
        ]),
      ],
    },
  ];
};

const followUpStatusLabel = (detail: ReworkBusinessDetail): string =>
  detail.settlementStatus === "revision_in_progress"
    ? "责任调整中"
    : detail.settlementStatus === "closed"
      ? "扣款完成"
      : "未扣款";

const nodeStatusLabel = (node: WorkflowNode, detail: ReworkBusinessDetail): string =>
  node.key === "settlement_followup" && node.state !== "future"
    ? `${detail.status === "completed" ? "订单已完成 · " : ""}${followUpStatusLabel(detail)}`
    : node.state === "completed" ? "已完成" : node.state === "current" ? "处理中" : "未开始";

const nodeHref = (orderId: string, key: WorkflowNodeKey): string => `${pageUrl(`ui/tasks/${orderId}`)}?node=${key}#node-workspace`;

const historyNode = (action: string): WorkflowNodeKey | null => {
  if (action === "rework.attachments.supplement") return "initiation";
  if (action.startsWith("rework.draft") || action === "rework.submit" || action === "rework.withdraw" || action === "rework.cancel") return "initiation";
  if (action.startsWith("rework.final_quantity.")) return "final_quantity_ie_review";
  if (action === "rework.tail_completion.confirm") return "whole_order_review";
  if (action.includes("process_configuration.review") || action.includes("ie_review")) return "ie_review";
  if (action.includes("process_configuration") || action.includes("process_worker_plan") || action.includes("work_task")) return "process_configuration";
  if (action.includes("tail_inspection")) return "work_reporting";
  if (action.includes("ie_precount")) return "work_reporting";
  if (action.includes("work_report")) return "work_reporting";
  if (action.includes("whole_order")) return "whole_order_review";
  if (action.includes("quantity.")) return "quantity_adjustment";
  if (action.includes("owner_approve") || action.includes("owner_reject")) return "owner_signature";
  if (action.includes("external") || action.includes("own_factory")) return "settlement_followup";
  if (action.includes("submit_owner_signature") || action.includes("responsibility")) return "responsibility";
  if (action.includes(".complete") || action.includes(".archive")) return "settlement_followup";
  return null;
};

const historyActionLabel = (action: string): string => {
  if (action === "rework.attachments.supplement") return "补充订单图片";
  if (action === "rework.tail_inspection.waive") return "改为无需整查";
  if (action === "rework.submit") return "提交返工单";
  if (action === "rework.tail_completion.confirm") return "尾部确认最终数量";
  if (action.startsWith("rework.final_quantity.")) return "IE 复核最终数量";
  if (action.includes("process_configuration.review") || action.includes("ie_review")) return "IE 审核";
  if (action.includes("process_worker_plan")) return "返工人员预分配";
  if (action.includes("process_configuration")) return "工序配置处理";
  if (action.includes("tail_defective_quantity")) return "尾部次品追加";
  if (action.includes("tail_inspection")) return "返工执行报数";
  if (action.includes("ie_precount")) return "数量记录";
  if (action.includes("work_task")) return "返工人员分配";
  if (action.includes("work_report")) return "执行报数";
  if (action.includes("whole_order")) return "整单审核";
  if (action.includes("quantity.")) return "数量调整";
  if (action.includes("owner_approve")) return "老板确认同意";
  if (action.includes("owner_reject")) return "老板驳回";
  if (action.includes("external")) return "供应商扣款处理";
  if (action.includes("own_factory")) return "本厂责任处理";
  if (action.includes("responsibility")) return "责任判定";
  if (action.includes(".complete") || action.includes(".archive")) return "订单完成";
  return "流程处理";
};

export function ReworkDetailPage(props: { reworkOrderId?: string; focusedNode?: WorkflowNodeKey; focusedExternalCaseId?: string; returnToTodos?: boolean } = {}) {
  const query = new URLSearchParams(window.location.search);
  const node = FinanceNodeKeySchema.safeParse(query.get("node"));
  const orderId = props.reworkOrderId ?? orderIdFromLocation();
  if (orderId && query.get("view") === "node-history" && node.success) return <ReworkNodeHistoryPage orderId={orderId} node={node.data} />;
  return <CurrentReworkDetailPage {...props} />;
}

function CurrentReworkDetailPage({
  reworkOrderId: providedReworkOrderId,
  focusedNode,
  focusedExternalCaseId,
  returnToTodos = false,
}: {
  reworkOrderId?: string;
  focusedNode?: WorkflowNodeKey;
  focusedExternalCaseId?: string;
  returnToTodos?: boolean;
} = {}) {
  const reworkOrderId = providedReworkOrderId ?? orderIdFromLocation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [currentUser, setCurrentUser] = useState<AuthorizedUser | null>(null);
  const [selectedImage, setSelectedImage] = useState<ReworkAttachment | null>(null);
  const [defectDialogOpen, setDefectDialogOpen] = useState(false);
  const [tailDefectQuantity, setTailDefectQuantity] = useState("");
  const [tailDefectMessage, setTailDefectMessage] = useState("");
  const [tailDefectBusy, setTailDefectBusy] = useState(false);
  const defectDialogRef = useRef<HTMLDialogElement | null>(null);
  const [mobileWorkflowExpanded, setMobileWorkflowExpanded] = useState(false);
  const mobileWorkflowRailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mobileWorkflowExpanded) mobileWorkflowRailRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [mobileWorkflowExpanded, state]);

  const load = useCallback(async (signal?: AbortSignal, selectCurrentNode = false): Promise<ReworkBusinessDetail | null> => {
    if (!reworkOrderId) {
      setState({ kind: "error", message: "返工单链接无效" });
      return null;
    }
    const response = await fetch(apiUrl(`rework-orders/${reworkOrderId}/business-detail`), {
      credentials: "include", headers: { accept: "application/json" }, ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? `返工单加载失败（${response.status}）`);
    }
    const latest = await response.json() as ReworkBusinessDetail;
    publishReworkNodeRefresh(latest, selectCurrentNode ? currentNodeByStatus[latest.status] : undefined, (nextNode) => {
      const url = new URL(window.location.href);
      url.searchParams.set("node", nextNode);
      window.history.replaceState(window.history.state, "", url);
    }, (value) => setState({ kind: "ready", value }));
    return latest;
  }, [reworkOrderId]);

  const syncAfterNodeAction = useCallback(async (): Promise<void> => {
    try {
      await load(undefined, true);
    } catch {
      // Mutation already succeeded; preserve its success feedback and allow a manual refresh.
    }
  }, [load]);

  useEffect(() => {
    let mounted = true;
    void verifySession().then((session) => {
      if (mounted && session !== "denied" && session.status === "authorized") setCurrentUser(session.user);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!selectedImage) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectedImage(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedImage]);

  useEffect(() => {
    const dialog = defectDialogRef.current;
    if (!dialog) return;
    if (defectDialogOpen && !dialog.open) dialog.showModal();
    if (!defectDialogOpen && dialog.open) dialog.close();
  }, [defectDialogOpen]);

  useEffect(() => {
    if (!reworkOrderId) {
      setState({ kind: "error", message: "返工单链接无效" });
      return;
    }
    const controller = new AbortController();
    void load(controller.signal).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setState({ kind: "error", message: error instanceof Error ? error.message : "返工单加载失败" });
      }
    });
    return () => controller.abort();
  }, [load, reworkOrderId]);

  const backAction = { backHref: reworkReturnPath(window.location.search, window.history.state?.dxReworkReturnTo, returnToTodos) };
  if (state.kind === "loading") {
    return <Shell active="全部订单"><Header title="返工单详情" badge="实时读取" {...backAction} /><Surface>正在加载返工单…</Surface></Shell>;
  }
  if (state.kind === "error") {
    return <Shell active="全部订单"><Header title="返工单详情" badge="无法读取" {...backAction} /><Surface>{state.message}</Surface></Shell>;
  }

  const detail = state.value;
  const addTailDefectiveQuantity = async (): Promise<void> => {
    const quantity = Number(tailDefectQuantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      setTailDefectMessage("请输入大于 0 的整数");
      return;
    }
    setTailDefectBusy(true);
    setTailDefectMessage("");
    try {
      const response = await fetch(apiUrl(`rework-orders/${detail.reworkOrderId}/tail-defective-quantity`), {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": createClientRequestId(),
        },
        body: JSON.stringify({ expectedVersion: detail.version, quantity }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? "尾部次品数量保存失败");
      }
      const latest = await response.json() as ReworkBusinessDetail;
      setState({ kind: "ready", value: latest });
      setTailDefectQuantity("");
      setTailDefectMessage(`已增加 ${formatBusinessDecimal(quantity)} 件尾部次品`);
    } catch (error: unknown) {
      setTailDefectMessage(error instanceof Error ? error.message : "尾部次品数量保存失败");
    } finally {
      setTailDefectBusy(false);
    }
  };
  const orderAttachments = detail.attachments.filter((attachment) =>
    attachment.entityType === "rework_order" || attachment.entityType === "receiving_batch" || attachment.entityType === "sourcing_case");
  const imageAttachments = orderAttachments.filter((attachment) => attachment.mimeType.startsWith("image/"));
  const dynamicFacts = [
    { label: "业务类型", value: detail.reworkKind === "inhouse_finishing" ? "本厂做尾" : "QC返工" },
    { label: "客供款号", value: detail.customerSupplyCode },
    { label: "工厂款号", value: detail.factoryStyleNo },
    { label: "订单号", value: detail.orderNo },
    { label: "订单数量", value: detail.orderQuantity === null ? null : `${formatBusinessDecimal(detail.orderQuantity)} 件` },
    { label: "返工原因", value: detail.reworkReason },
    ...(detail.specialProcessType === "other_craft" ? [{ label: "其他工艺", value: specialProcessName(detail) }] : []),
    { label: "问题部位", value: detail.problemPart },
    { label: "问题描述", value: detail.problemDescription },
    { label: "返工数量", value: detail.reworkQuantity === null ? null : `${formatBusinessDecimal(detail.reworkQuantity)} 件` },
    { label: "洗水厂", value: detail.supplyContext.washingSupplierName },
    { label: "印绣花厂", value: detail.supplyContext.embroiderySupplierName },
    { label: "面辅料供应商", value: detail.supplyContext.fabricSupplierName },
    { label: "印绣花跟单", value: detail.supplyContext.embroideryMerchandiserName },
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact.value));
  const visibleImageAttachments = imageAttachments;
  const baseMeta = statusMeta[detail.status];
  const meta = { ...baseMeta, next: baseMeta.next.replaceAll("整查", specialProcessLabel(detail)) };
  const stages = buildWorkflow(detail, currentUser, returnToTodos ? focusedNode : undefined);
  const workflowNodes = stages.flatMap((stage) => stage.nodes);
  const activeNode = workflowNodes.find((node) => node.state === "current" || node.state === "followup")?.key
    ?? (detail.status === "completed" ? detail.reworkKind === "inhouse_finishing" ? "final_quantity_ie_review" : "settlement_followup" : undefined);
  const activeWorkflowNode = workflowNodes.find((node) => node.key === activeNode);
  const selectedFromUrl = workflowNodeFromSearch();
  const defaultSelectedNode = activeNode ?? "settlement_followup";
  const selectedNode = selectedFromUrl ?? (focusedNode === activeNode ? focusedNode : defaultSelectedNode);
  const selected = workflowNodes.find((node) => node.key === selectedNode);
  const activeStepIndex = Math.max(1, workflowNodes.findIndex((node) => node.key === activeNode) + 1);
  const selectedImageIndex = selectedImage
    ? imageAttachments.findIndex((attachment) => attachment.attachmentId === selectedImage.attachmentId)
    : -1;
  const showRelativeImage = (offset: number): void => {
    if (selectedImageIndex < 0 || imageAttachments.length === 0) return;
    const nextIndex = (selectedImageIndex + offset + imageAttachments.length) % imageAttachments.length;
    setSelectedImage(imageAttachments[nextIndex] ?? null);
  };

  const canSeeResponsibility = elevated(currentUser)
    || (hasRole(currentUser,"pmc") && hasCapability(currentUser,"external_responsibility:view"))
    || hasCapability(currentUser, "responsibility:determine")
    || hasCapability(currentUser, "responsibility:takeover")
    || hasCapability(currentUser, "responsibility:confirm_high_multiplier")
    || hasCapability(currentUser, "responsibility:owner_sign")
    || hasCapability(currentUser, "rework:related_orders:view");
  const canSeeExternal = elevated(currentUser) || hasCapability(currentUser, "external_responsibility:view") || hasCapability(currentUser,"rework:finance_orders:read");
  const canSeeWholeOrderReview = elevated(currentUser) || WHOLE_ORDER_REVIEW_CAPABILITIES.some((capability) => hasCapability(currentUser, capability));
  const moduleWritable = moduleCanWrite(currentUser, "rework");
  const canSupplementOrderImages = moduleWritable && detail.status !== "cancelled"
    && canSupplementImagesByRole(currentUser);
  const canHandleInitiation = moduleWritable && (elevated(currentUser)
    || (hasRole(currentUser, "quality_control") && hasCapability(currentUser, "rework:initiate")));
  const initiationAccess = reworkInitiationAccess({
    canHandleInitiation,
    currentUserId: currentUser?.id ?? null,
    createdByUserId: detail.createdBy.userId,
    isRoot: currentUser?.isRoot === true,
    status: detail.status,
  });
  const initiationOwnershipNotice = !initiationAccess.isOwnOrder && currentUser?.isRoot !== true
    ? `本单由 ${detail.createdBy.displayName} 发起；撤回和取消需由原发起人操作。` : undefined;
  const canWaiveTailInspection = moduleWritable && detail.tailInspectionRequired
    && (detail.status === "in_progress" || detail.status === "pending_order_review")
    && (elevated(currentUser) || (
      (hasRole(currentUser, "owner_group") || hasRole(currentUser, "production_management"))
      && hasCapability(currentUser, "tail_inspection:waive")
    ));

  const renderNodePreview = () => {
    if (!selected) return null;
    const nodeHistory = detail.workflowHistory.filter((event) => historyNode(event.action) === selected.key);
    return <Surface className="rework-detail-node-preview">
      <StatusBadge tone={selected.state === "completed" ? "success" : "info"}>
        {selected.state === "completed" ? "已完成 · 可只读" : selected.state === "current" || selected.state === "followup" ? `${nodeStatusLabel(selected, detail)} · 只读` : "未开始 · 可预览"}
      </StatusBadge>
      <h2>{selected.number} · {selected.label}</h2>
      <p>{selected.preview}</p>
      <p>负责角色：{selected.ownerRole}{" · "}实际负责人：{selected.ownerName}</p>
      {selected.state === "completed" && (
        <details className="rework-detail-node-history">
          <summary>处理历史{nodeHistory.length ? ` · ${formatBusinessDecimal(nodeHistory.length)} 条` : ""}</summary>
          {nodeHistory.length ? nodeHistory.map((event, index) => (
            <div key={`${event.action}-${event.handledAt}-${index}`}>
              <b>{historyActionLabel(event.action)}</b>
              <span>处理人：{event.handledBy} · 处理时间：{formatTime(event.handledAt)}</span>
              <span>处理意见：{event.remark ?? "未填写备注"}</span>
            </div>
          )) : <p>该节点的早期历史记录未完整入库；可在系统管理的审计日志中查询原始记录。</p>}
          {detail.attachments.length > 0 && <p>关联附件：{detail.attachments.map((attachment) => <span key={attachment.attachmentId}>
            {attachment.entityType === "external_responsibility_case" ? "外部责任 · " : ""}
            {attachment.entityType === "receiving_batch" ? "收货凭证 · " : ""}
            {attachment.filename}{" "}
            <a href={attachmentUrl(attachment.attachmentId, "preview")} rel="noreferrer" target="_blank">预览</a>{" · "}
            <a href={attachmentUrl(attachment.attachmentId, "download")} rel="noreferrer" target="_blank">下载</a>{"；"}
          </span>)}</p>}
        </details>
      )}
    </Surface>;
  };

  if (selected?.state === "completed" && !["settlement_ledger", "archive", "settlement_followup"].includes(selected.key)) {
    const historyKey = FinanceNodeKeySchema.safeParse(selected.key);
    if (historyKey.success) return <ReworkNodeHistoryPage orderId={detail.reworkOrderId} node={historyKey.data} />;
  }

  const scopedFinanceOrderReader = hasCapability(currentUser,"rework:finance_orders:read") && !elevated(currentUser) && !hasCapability(currentUser,"rework:finance_nodes:read");
  const financeNodeReader = !elevated(currentUser) && hasCapability(currentUser,"rework:finance_nodes:read");
  const renderSelectedTask = () => {
    if (!selected) return null;
    if (selected.state === "completed" && !["settlement_ledger", "archive", "settlement_followup"].includes(selected.key)) return <a className="dx-button dx-button--primary" href={reworkHistoryHref(detail.reworkOrderId, selected.key)}>查看完整历史页面</a>;
    if (scopedFinanceOrderReader && selected.state !== "future"
      && !["settlement_ledger","settlement_followup"].includes(selected.key)
      && !canOperateReworkNode(currentUser?.capabilities??[],selected.key)) {
      return <>{renderNodePreview()}<ExternalResponsibilityPanel reworkOrderId={detail.reworkOrderId} readOnly embedded /></>;
    }

    if (financeNodeReader && selected.state !== "future" && selected.key !== "settlement_followup"
      && !(selected.state === "current" && canOperateReworkNode(currentUser?.capabilities ?? [], selected.key))) {
      return <>{renderNodePreview()}<FinanceNodePanel orderId={detail.reworkOrderId} node={selected.key==="archive"?"settlement_followup":selected.key}
        {...(selected.state!=="completed"?{attachments:detail.attachments}:{})} /></>;
    }
    if (selected.key === "initiation" && detail.status === "draft") {
      return initiationAccess.canEditDraft
        ? <ReworkInitiationForm reworkOrderId={detail.reworkOrderId} embedded onOrderChanged={() => { void syncAfterNodeAction(); }} />
        : <NodePermissionNotice node={selected} message={initiationOwnershipNotice} />;
    }
    if (selected.key === "initiation" && detail.status === "pending_process_configuration") {
      return <InitiationFollowUpActions detail={detail} statusLabel={statusMeta[detail.status].label} canHandleInitiation={initiationAccess.canWithdraw} ownershipNotice={initiationOwnershipNotice} onChanged={syncAfterNodeAction} />;
    }
    if (selected.state !== "future" && (selected.key === "process_configuration" || selected.key === "ie_review")) {
      if (canUseProcessWorkspace(currentUser)) return <ProcessConfigurationForm reworkOrderId={detail.reworkOrderId} initialDetail={detail} embedded workspaceNode={selected.key} onOrderChanged={syncAfterNodeAction} />;
      if (selected.state === "current" || selected.state === "followup") return <NodePermissionNotice node={selected} />;
    }
    if (selected.state !== "future" && (selected.key === "task_assignment" || selected.key === "work_reporting")) {
      if (canUseWorkWorkspace(currentUser)) return <WorkReportingForm
        reworkOrderId={detail.reworkOrderId}
        taskMode={selected.key}
        embedded
        onOrderChanged={syncAfterNodeAction}
        {...(selected.key === "work_reporting"
          && (detail.iePrecounts.canRecord || currentUser?.isRoot === true || hasRole(currentUser, "ie_reviewer"))
          ? { iePrecounts: { ...detail.iePrecounts, canRecord: moduleWritable && detail.iePrecounts.canRecord } }
          : {})}
      />;
      if (selected.state === "current") return <NodePermissionNotice node={selected} />;
    }
    if (selected.state !== "future" && (selected.key === "whole_order_review" || selected.key === "final_quantity_ie_review" || selected.key === "quantity_adjustment")) {
      if (canSeeWholeOrderReview) return <WorkReportingForm
        reworkOrderId={detail.reworkOrderId}
        taskMode="whole_order_review"
        embedded
        onOrderChanged={syncAfterNodeAction}
        {...(selected.key === "final_quantity_ie_review" ? { iePrecounts: { ...detail.iePrecounts, canRecord: moduleWritable && detail.iePrecounts.canRecord } } : {})}
      />;
      if (selected.state === "current") return <NodePermissionNotice node={selected} />;
    }
    if (selected.state !== "future" && (selected.key === "responsibility" || selected.key === "owner_signature")) {
      if (canSeeResponsibility) return <ResponsibilityDeterminationPanel reworkOrderId={detail.reworkOrderId} embedded onOrderChanged={syncAfterNodeAction} />;
      if (selected.state === "current") return <NodePermissionNotice node={selected} />;
    }
    if (selected.state !== "future" && selected.key === "settlement_ledger") {
      if (canSeeExternal || elevated(currentUser)) return <ExternalResponsibilityPanel reworkOrderId={detail.reworkOrderId} readOnly embedded />;
      return <SettlementLedgerNotice detail={detail} />;
    }
    if (selected.state !== "future" && selected.key === "settlement_followup") {
      return <>
        <OrderCompletionAndSettlementSummary detail={detail} />
        {financeNodeReader&&<FinanceNodePanel orderId={detail.reworkOrderId} node="settlement_followup" onlyWages />}
        {canSeeExternal ? <ExternalResponsibilityPanel reworkOrderId={detail.reworkOrderId} readOnly={!moduleWritable} embedded {...(focusedExternalCaseId ? { focusCaseId: focusedExternalCaseId } : {})} /> : null}
      </>;
    }
    return renderNodePreview();
  };

  const renderWorkflowNode = (node: WorkflowNode) => (
    <a className={`rework-workflow-step is-${node.state}`} data-active={node.key === activeNode} aria-current={node.state === "current" ? "step" : undefined} href={node.state === "completed" && !["settlement_ledger", "archive", "settlement_followup"].includes(node.key) ? reworkHistoryHref(detail.reworkOrderId, node.key) : nodeHref(detail.reworkOrderId, node.key)} key={node.key}>
      <b aria-hidden="true">{node.state === "completed" ? "✓" : Number(node.number)}</b>
      <span><strong>{node.label}</strong><small>{node.ownerRole}</small></span>
      <em>{nodeStatusLabel(node, detail)}</em>
    </a>
  );

  return (
    <Shell active="全部订单">
      <div className="rework-governed" data-dx-ui="governed"><div className="rework-detail-header"><Header title={detail.styleNo ?? "款号未填写"} subtitle={detail.reworkNo ?? "未提交返工草稿"} badge={meta.label} badgePlacement="subtitle" {...backAction} /></div>
      <div className="rework-detail-layout rework-detail-target-layout">
      {canSeeResponsibility && ["pending_responsibility_determination","pending_owner_signature","pending_responsibility_action","completed"].includes(detail.status) && <OrderResponsibilityRevisionPanel readOnly={!moduleWritable} orderId={detail.reworkOrderId} orderVersion={detail.version} onChanged={syncAfterNodeAction} />}
        <dl className="rework-detail-core-facts" aria-label="返工单核心信息">
          <div className="rework-detail-core-fact"><dt>加工厂</dt><dd>{detail.processingFactory?.displayName ?? "—"}</dd></div>
          <div className="rework-detail-core-fact"><dt>返工工序</dt><dd title={detail.reworkProcess ?? undefined}>{detail.reworkProcess ?? "—"}</dd></div>
          <div className="rework-detail-core-fact"><dt>发起时间</dt><dd>{formatTime(detail.createdAt)}</dd></div>
          <div className="rework-detail-core-fact"><dt>发起人</dt><dd>{detail.createdBy.displayName}</dd></div>
          <div className="rework-detail-core-fact rework-detail-core-fact--merchandiser"><dt>订单跟单</dt><dd>{detail.merchandiser?.displayName ?? "—"}</dd></div>
          <div className="rework-detail-core-fact rework-detail-core-fact--received"><dt><ReceivedQuantityLabel>实收数量</ReceivedQuantityLabel></dt><dd>{detail.sourceReceivingActualQuantity === null ? "—" : `${formatBusinessDecimal(detail.sourceReceivingActualQuantity)} 件`}</dd></div>
          <div className="rework-detail-core-fact rework-detail-core-fact--defective"><dt>次品数量</dt><dd><button type="button" onClick={() => { setTailDefectMessage(""); setDefectDialogOpen(true); }}>{formatBusinessDecimal(detail.defectiveQuantity.total)} 件 · 查看</button></dd></div>
        </dl>

        <div className="rework-detail-overview-grid order-overview--compact">
          <section className="rework-detail-images" aria-label="订单图片">
            <div className="section-title rework-detail-panel-title rework-governed-image-heading">
              <h2>订单图片</h2>
              {canSupplementOrderImages && (
                <OrderImageSupplementUploader
                  reworkOrderId={detail.reworkOrderId}
                  expectedVersion={detail.version}
                  currentAttachmentCount={detail.attachments.filter((attachment) => attachment.entityType === "rework_order").length}
                  onUploaded={async () => { await load(); }}
                />
              )}
              <span className="rework-governed-image-count">{formatBusinessDecimal(imageAttachments.length)} 张</span>
            </div>
            <div id="order-images-content" className="rework-detail-mobile-collapsible is-expanded">
              {visibleImageAttachments.length > 0 ? <div className="rework-detail-image-grid">
                {visibleImageAttachments.map((attachment) => (
                  <button
                    className="rework-detail-image-card"
                    type="button"
                    key={attachment.attachmentId}
                    onClick={() => setSelectedImage(attachment)}
                    aria-label={`放大查看 ${attachment.filename}`}
                  >
                    <img src={attachmentUrl(attachment.attachmentId, "preview")} alt={attachment.filename} loading="lazy" />
                    <span className="rework-detail-image-card__filename">{attachment.filename}</span>
                  </button>
                ))}
              </div> : null}
            </div>
          </section>

          <section className="rework-workflow" key={detail.status} aria-label="订单流程">
            <div className="rework-workflow__heading rework-detail-panel-title rework-detail-desktop-panel-heading">
              <h2>订单流程</h2>
              <span className="rework-workflow__step-count">当前步骤 {activeStepIndex} / {workflowNodes.length}</span>
            </div>
            <button
              className="rework-detail-mobile-panel-toggle rework-detail-mobile-workflow-toggle"
              type="button"
              aria-controls="order-workflow-content"
              aria-expanded={mobileWorkflowExpanded}
              onClick={() => setMobileWorkflowExpanded((value) => !value)}
            >
              <span>
                <strong>订单流程</strong>
                {activeWorkflowNode ? <small>{activeWorkflowNode.number} · {activeWorkflowNode.label} · {nodeStatusLabel(activeWorkflowNode, detail)}</small> : null}
              </span>
              <span><small>{activeStepIndex}/{workflowNodes.length}</small><b aria-hidden="true">{mobileWorkflowExpanded ? "−" : "+"}</b></span>
            </button>
            <div id="order-workflow-content" className={`rework-detail-mobile-collapsible${mobileWorkflowExpanded ? " is-expanded" : ""}`}>
              <WorkflowRail className="rework-workflow__desktop-grid" aria-label="电脑端流程节点">
                {workflowNodes.map(renderWorkflowNode)}
              </WorkflowRail>
              <WorkflowRail className="rework-workflow__mobile-rail" ref={mobileWorkflowRailRef} aria-label="移动端流程节点">
                {workflowNodes.map(renderWorkflowNode)}
              </WorkflowRail>
            </div>
          </section>
        </div>

        {dynamicFacts.length > 0 ? <Surface className="rework-detail-dynamic-information">
          <div className="section-title rework-detail-panel-title">
            <div><h2>订单补充信息</h2><p>仅展示本单已填写的业务字段。</p></div>
            <StatusBadge tone="info">{formatBusinessDecimal(dynamicFacts.length)} 项</StatusBadge>
          </div>
          <dl className="rework-detail-dynamic-facts">
            {dynamicFacts.map((fact) => <div key={fact.label}>
              <dt>{fact.label}</dt><dd>{fact.value}</dd>
            </div>)}
          </dl>
        </Surface> : null}

        {detail.inspectionReport ? <InspectionReportReadonly report={detail.inspectionReport} /> : null}

        <section id="node-workspace" className="rework-detail-task rework-detail-workspace" aria-label="节点任务">
          <div className="rework-detail-task__heading"><h2>办理区<span className="rework-mobile-current-node"> · {selected?.number} {selected?.label}</span></h2>{detail.canReadBusinessDetails !== false && <span className="rework-detail-single-piece-total">单件返工总价：{detail.singlePieceReworkTotal === null ? "待核价" : formatBusinessCurrency(detail.singlePieceReworkTotal)}</span>}</div>
          {detail.status === "pending_process_configuration" && canHandleInitiation ? <InitiationFollowUpActions detail={detail} statusLabel={statusMeta[detail.status].label} canHandleInitiation={initiationAccess.canWithdraw} ownershipNotice={initiationOwnershipNotice} onChanged={syncAfterNodeAction} /> : null}
          {canWaiveTailInspection ? <TailInspectionWaiverAction detail={detail} onChanged={syncAfterNodeAction} /> : null}
          {renderSelectedTask()}
        </section>
      </div>

      <dialog ref={defectDialogRef} className="rework-defect-dialog" onCancel={() => setDefectDialogOpen(false)} onClose={() => setDefectDialogOpen(false)}>
        <div className="rework-defect-dialog__heading">
          <div><h2>次品数量明细</h2><p>总数 = 收货阶段 + 尾部阶段；尾部新增不会修改仓库原始收货记录。</p></div>
          <button type="button" onClick={() => setDefectDialogOpen(false)}>关闭</button>
        </div>
        <div className="rework-defect-dialog__totals">
          <div><span>收货阶段</span><strong>{detail.defectiveQuantity.receivingLinked ? `${formatBusinessDecimal(detail.defectiveQuantity.receiving)} 件` : "—"}</strong><small>{detail.defectiveQuantity.receivingLinked ? "来自仓库收货记录" : "未关联仓库收货记录"}</small></div>
          <div><span>尾部阶段</span><strong>{formatBusinessDecimal(detail.defectiveQuantity.tail)} 件</strong><small>{detail.defectiveQuantity.tailEntries.length} 条追加记录</small></div>
          <div><span>次品总数</span><strong>{formatBusinessDecimal(detail.defectiveQuantity.total)} 件</strong><small>两阶段合计</small></div>
        </div>
        {detail.defectiveQuantity.tailEntries.length > 0 ? <div className="rework-defect-dialog__history">
          <h3>尾部追加记录</h3>
          {detail.defectiveQuantity.tailEntries.map((entry) => <div key={entry.entryId}>
            <strong>+{formatBusinessDecimal(entry.quantity)} 件</strong><span>{entry.recordedBy}</span><time dateTime={entry.recordedAt}>{formatTime(entry.recordedAt)}</time>
          </div>)}
        </div> : <p className="rework-defect-dialog__empty">尾部阶段暂未增加次品。</p>}
        {(moduleWritable && detail.defectiveQuantity.canAddTail) ? <div className="rework-defect-dialog__add">
          <label>新增尾部次品数量<input autoFocus type="number" inputMode="numeric" min="1" step="1" value={tailDefectQuantity} onChange={(event) => setTailDefectQuantity(event.target.value)} /></label>
          <Button variant="primary" disabled={tailDefectBusy} onClick={() => void addTailDefectiveQuantity()}>{tailDefectBusy ? "保存中…" : "增加次品数量"}</Button>
        </div> : <p className="rework-defect-dialog__empty">仅尾部主管、老板和Root可增加尾部阶段次品数量。</p>}
        {tailDefectMessage ? <p className="rework-defect-dialog__message" role="status">{tailDefectMessage}</p> : null}
      </dialog>

      {selectedImage && (
        <div className="rework-image-modal" role="presentation" onMouseDown={() => setSelectedImage(null)}>
          <section
            className="rework-image-modal__content"
            role="dialog"
            aria-modal="true"
            aria-label={`订单图片：${selectedImage.filename}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="rework-image-modal__heading">
              <strong>{selectedImage.filename}</strong>
              <button type="button" onClick={() => setSelectedImage(null)}>关闭</button>
            </div>
            <ImageViewer src={attachmentUrl(selectedImage.attachmentId, "preview")} alt={selectedImage.filename} />
            <div className="rework-image-modal__actions">
              {imageAttachments.length > 1 ? <><button type="button" onClick={() => showRelativeImage(-1)}>上一张</button><span>{selectedImageIndex + 1} / {imageAttachments.length}</span><button type="button" onClick={() => showRelativeImage(1)}>下一张</button></> : null}
              <a href={attachmentUrl(selectedImage.attachmentId, "download")} rel="noreferrer" target="_blank">下载原图</a>
            </div>
          </section>
        </div>
      )}
    </div>
    </Shell>
  );
}

function TailInspectionWaiverAction({
  detail,
  onChanged,
}: {
  detail: ReworkBusinessDetail;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const waive = async (): Promise<void> => {
    const reason = (await promptInApp(
      `请输入改为无需${specialProcessLabel(detail)}的原因。若已经上过${specialProcessLabel(detail)}数，该记录会保留但作废，不计入最终数量、工资或责任。`,
      "",
      { title: `改为无需${specialProcessLabel(detail)}`, confirmLabel: `确认免${specialProcessLabel(detail)}` },
    ))?.trim();
    if (!reason) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(apiUrl(`rework-orders/${detail.reworkOrderId}/waive-tail-inspection`), {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": createClientRequestId(),
        },
        body: JSON.stringify({ expectedVersion: detail.version, reason }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `免${specialProcessLabel(detail)}失败`);
      }
      setMessage(`已改为无需${specialProcessLabel(detail)}；原${specialProcessLabel(detail)}报数已保留为历史并从结算中作废。`);
      await onChanged();
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : `免${specialProcessLabel(detail)}失败`);
    } finally {
      setBusy(false);
    }
  };

  return <Surface className="rework-detail-node-preview">
    <StatusBadge tone="info">旧订单纠正</StatusBadge>
    <h2>改为无需{specialProcessLabel(detail)}</h2>
    <p>仅老板、生产管理和超级用户可操作。已上报的{specialProcessLabel(detail)}数会保留审计记录，但不再计入最终数量、工资和责任。</p>
    <Button disabled={busy} onClick={() => { void waive(); }}>{busy ? "处理中…" : `改为无需${specialProcessLabel(detail)}`}</Button>
    {message ? <p role="status">{message}</p> : null}
  </Surface>;
}


function NodePermissionNotice({ node, message }: { node: WorkflowNode; message?: string | undefined }) {
  return <Surface className="rework-detail-node-preview"><StatusBadge tone="info">仅可查看</StatusBadge><h2>{node.number} · {node.label}</h2><p>{node.preview}</p><p>{message ?? "当前账号没有该节点的处理权限；如需处理，请从本人待办进入或联系节点负责人。"}</p></Surface>;
}

function SettlementLedgerNotice({ detail }: { detail: ReworkBusinessDetail }) {
  const text = detail.settlementStatus === "not_required"
    ? "本单没有外部责任方；老板签字后系统已完成责任结算台账，无需供应商扣款。"
    : detail.settlementStatus === "closed"
      ? "所有供应商扣款台账已终结。"
      : detail.settlementStatus === "revision_in_progress"
        ? "存在责任调整，待重新确认后自动生成新的责任结算台账。"
        : "责任结算台账已自动生成；供应商实际扣款在 N08 的后续结算区跟进，不阻塞订单完成。";
  return <Surface className="rework-detail-node-preview"><StatusBadge tone="info">系统自动生成 · 只读</StatusBadge><h2>09 · 责任结算台账</h2><p>{text}</p></Surface>;
}

function OrderCompletionAndSettlementSummary({ detail }: { detail: ReworkBusinessDetail }) {
  const orderCompleted = detail.status === "completed";
  return <Surface className="rework-detail-node-preview">
    <StatusBadge tone={orderCompleted ? "success" : "info"}>{orderCompleted ? "订单已完成" : "责任结算中"}</StatusBadge>
    <h2>09 · 订单完成与扣款</h2>
    <p>{orderCompleted
      ? "返工生产和责任判定已经结束；订单完成即进入扣款。工资金额只保留给财务查询与对数。"
      : "责任结算台账已生成，正在完成后续责任结算。"}</p>
    <p>扣款状态：{followUpStatusLabel(detail)}</p>
  </Surface>;
}

