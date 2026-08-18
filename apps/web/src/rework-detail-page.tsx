import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import type { InspectionReportDraft } from "@dx-rework/contracts";
import { useCallback, useEffect, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import type { AuthorizedUser } from "./auth.js";
import { Header, Shell } from "./components.js";
import { ExternalResponsibilityPanel } from "./external-responsibility-panel.js";
import { InspectionReportReadonly } from "./inspection-report-readonly.js";
import { OrderImageSupplementUploader } from "./order-image-supplement-uploader.js";
import { ProcessConfigurationForm } from "./process-configuration-form.js";
import { ReworkInitiationForm } from "./rework-form.js";
import { ResponsibilityDeterminationPanel } from "./responsibility-determination-panel.js";
import { promptInApp } from "./system-dialog.js";
import { TailInspectionPanel } from "./tail-inspection-panel.js";
import { WorkReportingForm } from "./work-reporting-form.js";
import "./rework-detail.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
type ReworkStatus =
  | "draft"
  | "pending_process_configuration"
  | "pending_ie_review"
  | "pending_task_assignment"
  | "in_progress"
  | "pending_order_review"
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
  | "tail_inspection"
  | "whole_order_review"
  | "quantity_adjustment"
  | "responsibility"
  | "owner_signature"
  | "settlement_ledger"
  | "archive"
  | "settlement_followup";

type ReworkBusinessDetail = Readonly<{
  reworkOrderId: string;
  reworkNo: string | null;
  status: ReworkStatus;
  version: number;
  styleNo: string | null;
  customerSupplyCode: string | null;
  factoryStyleNo: string | null;
  orderNo: string | null;
  orderQuantity: number | null;
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
    entityType: "rework_order" | "external_responsibility_case";
  }>[];
  workflowHistory: readonly Readonly<{
    action: string;
    handledBy: string;
    handledAt: string;
    remark: string | null;
  }>[];
}>;

type ReworkAttachment = ReworkBusinessDetail["attachments"][number];

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; value: ReworkBusinessDetail }
  | { kind: "error"; message: string };

type AuthMe = Readonly<{
  status: "authorized" | "no_role";
  user: AuthorizedUser;
}>;

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
type WorkflowStage = Readonly<{
  key: string;
  title: string;
  nodes: readonly WorkflowNode[];
}>;

const statusMeta: Record<ReworkStatus, { label: string; next: string }> = {
  draft: { label: "草稿", next: "等待发起人补充并提交" },
  pending_process_configuration: { label: "待工序与候选单价", next: "下一步由尾部主管配置工序、候选单价并分配尾查" },
  pending_ie_review: { label: "待 IE 核价", next: "尾查已可并行清点；IE 通过工序与单价后，进入人员分配" },
  pending_task_assignment: { label: "待分配人员", next: "工序与单价已核准，下一步由尾部主管分配返工人员" },
  in_progress: { label: "返工执行中", next: "工人登记个人完成数量，全部完成后由尾部主管核量" },
  pending_order_review: { label: "待尾部主管整单确认", next: "核对工人上数不超过尾查汇总，并确认临时工实发系数" },
  pending_quantity_adjustment_ie_review: { label: "数量调整待 IE", next: "异常数量增加申请等待 IE 复核" },
  pending_responsibility_determination: { label: "待责任判定", next: "返工已完成整单确认，正在选择主责任方和外部扣款倍率" },
  pending_owner_signature: { label: "待老板签字", next: "生产管理资料已齐全，等待老板确认同意或驳回" },
  pending_responsibility_action: { label: "责任处理中", next: "责任已判定，正在完成本厂审批或外部责任结算" },
  completed: { label: "已完成", next: "返工生产链已归档；工资与扣款按各自独立周期继续核对" },
  cancelled: { label: "已取消", next: "返工单已取消，历史资料和操作记录继续保留" },
};

const statusRank: Record<Exclude<ReworkStatus, "cancelled">, number> = {
  draft: 0,
  pending_process_configuration: 1,
  pending_ie_review: 2,
  pending_task_assignment: 3,
  in_progress: 4,
  pending_order_review: 5,
  pending_quantity_adjustment_ie_review: 5,
  pending_responsibility_determination: 6,
  pending_owner_signature: 7,
  pending_responsibility_action: 8,
  completed: 10,
};

const currentNodeByStatus: Partial<Record<ReworkStatus, WorkflowNodeKey>> = {
  draft: "initiation",
  pending_process_configuration: "process_configuration",
  pending_ie_review: "ie_review",
  pending_task_assignment: "task_assignment",
  in_progress: "work_reporting",
  pending_order_review: "whole_order_review",
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
  tail_inspection: 4,
  whole_order_review: 5,
  quantity_adjustment: 5,
  responsibility: 6,
  owner_signature: 7,
  settlement_ledger: 8,
  archive: 9,
  settlement_followup: 10,
};

const nodeKeys = new Set<WorkflowNodeKey>([
  "initiation", "process_configuration", "ie_review", "task_assignment", "work_reporting", "tail_inspection",
  "whole_order_review", "quantity_adjustment", "responsibility", "owner_signature", "settlement_ledger", "archive", "settlement_followup",
]);

const orderIdFromLocation = (): string | null => {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const currentPath = window.location.pathname.startsWith(basePath)
    ? window.location.pathname.slice(basePath.length) || "/"
    : window.location.pathname;
  const match = currentPath.match(
    /^\/ui\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );
  return match?.[1] ?? null;
};

const workflowNodeFromSearch = (): WorkflowNodeKey | null => {
  const value = new URLSearchParams(window.location.search).get("node");
  if (value === "archive") return "settlement_followup";
  return value && nodeKeys.has(value as WorkflowNodeKey) ? value as WorkflowNodeKey : null;
};

const formatTime = (value: string | null): string => {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hour12: false, timeZone: "Asia/Shanghai",
  }).format(new Date(value));
};

const attachmentUrl = (
  attachmentId: string,
  mode: "preview" | "download",
): string => apiUrl(`tools/attachments/${attachmentId}/download?mode=${mode}`);

const hasRole = (user: AuthorizedUser | null, role: string): boolean =>
  user?.businessRoles?.includes(role) === true;
const hasCapability = (user: AuthorizedUser | null, capability: string): boolean =>
  user?.capabilities.includes(capability) === true;
const elevated = (user: AuthorizedUser | null): boolean => user?.isRoot === true || hasRole(user, "owner_group");

const canUseProcessWorkspace = (user: AuthorizedUser | null): boolean => elevated(user)
  || (hasRole(user, "tail_supervisor") && hasCapability(user, "process:configure"))
  || (hasRole(user, "ie_reviewer") && hasCapability(user, "process:review"));
const canUseWorkWorkspace = (user: AuthorizedUser | null): boolean => elevated(user)
  || (hasRole(user, "tail_supervisor") && (
    hasCapability(user, "work:assign") || hasCapability(user, "submission:audit") || hasCapability(user, "quantity:adjust")
  ))
  || (hasRole(user, "worker") && hasCapability(user, "work:report"))
  || hasCapability(user, "work:report_for_worker")
  || (hasRole(user, "order_merchandiser") && hasCapability(user, "quantity:confirm"))
  || (hasRole(user, "ie_reviewer") && hasCapability(user, "process:review"));
const canUseTailInspection = (user: AuthorizedUser | null): boolean => elevated(user)
  || (hasRole(user, "tail_supervisor") && (
    hasCapability(user, "process:configure") || hasCapability(user, "submission:audit")
  ))
  || (hasRole(user, "tail_inspector") && hasCapability(user, "tail_inspection:report"));
const workflowState = (detail: ReworkBusinessDetail, key: WorkflowNodeKey): WorkflowNodeState => {
  if (detail.status === "cancelled") return "future";
  // N06 begins immediately after N02 assigns a tail inspector. It runs in
  // parallel with IE review, worker assignment and worker reporting.
  if (key === "tail_inspection") {
    if (["pending_ie_review", "pending_task_assignment", "in_progress"].includes(detail.status)) return "current";
    return statusRank[detail.status] > nodeRank[key] ? "completed" : "future";
  }
  // The ledger is atomic. Once the order has entered the responsibility-action
  // state, there is no human settlement node left to perform here.
  if (key === "settlement_ledger" && detail.status === "pending_responsibility_action") return "completed";
  // The final N10 card combines the completed order with later wage/supplier
  // settlement presentation, without falsely reopening the order itself.
  if (detail.status === "completed") {
    if (key !== "settlement_followup") return "completed";
    return ["in_progress", "revision_in_progress"].includes(detail.settlementStatus)
      || detail.wageSettlementStatus === "in_progress"
      ? "followup"
      : "completed";
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
        node("initiation", "01", "发起返工", "质检", detail.createdBy.displayName, "登记数字化验货单和纸质报告附件后提交返工单。"),
        node("process_configuration", "02", "工序与候选单价", "尾部主管", detail.processConfigurationCreatedBy?.displayName ?? "待提交后分配", "配置返工工序、候选单价并分配尾查；不再预估返工数量。"),
        node("ie_review", "03", "IE 核价", "IE", "待尾部提交", "IE 只核准工序单价；通过后才能分配返工人员。"),
      ],
    },
    {
      key: "execution",
      title: "分工与返工执行",
      nodes: [
        node("task_assignment", "04", "分配返工人员", "尾部主管", "待 IE 核价通过", "按 IE 核准的工序为正式工或临时工分配任务。"),
        node("work_reporting", "05", "工人完工上数", "返工人员", "待人员分配", "工人一次提交本人最终完工件数；临时工由尾部主管代录。"),
        node("tail_inspection", "06", "尾查报数", "尾查", "待尾部主管分配", "N02 分配后即可开始；多人清点结果按工序汇总。"),
      ],
    },
    {
      key: "responsibility",
      title: "责任与结算",
      nodes: [
        node("whole_order_review", "07", "尾部主管整单确认", "尾部主管", "待工人上数与尾查报数完成", "逐工序核对工人上数不得超过尾查汇总；临时工实发系数在此确认。"),
        node("responsibility", "08", "责任判定", "生产管理", "待 N07 提交", "每道工序只选一个主责任方；外部扣款倍率默认且最低 1.2，可向上调整。"),
        node("owner_signature", "09", "老板确认签字", "老板", "待 N08 提交", "老板直接确认或驳回已锁定的责任方与外部扣款倍率。"),
        node("settlement_followup", "10", "返工业务完成", "系统", "N09 同意后完成", "供应商计划扣款不在本阶段生成，待业务确认规则。"),
      ],
    },
  ];
};

const stageState = (stage: WorkflowStage): WorkflowNodeState => stage.nodes.every((node) => node.state === "completed")
  ? "completed"
  : stage.nodes.some((node) => node.state === "current")
    ? "current"
    : stage.nodes.some((node) => node.state === "followup") ? "followup" : "future";

const wageStatusLabel = (status: ReworkBusinessDetail["unsettledWagePeriods"][number]["status"]): string =>
  status === "pending_tail_review"
    ? "待尾部主管初核"
    : status === "pending_admin_review"
      ? "待行政复核"
      : "待工资月结会计锁定";

const followUpStatusLabel = (detail: ReworkBusinessDetail): string => {
  const labels: string[] = [];
  if (detail.settlementStatus === "revision_in_progress") labels.push("责任调整中");
  else if (detail.settlementStatus === "in_progress") labels.push("供应商扣款跟进");
  if (detail.wageSettlementStatus === "in_progress") {
    const wageStatuses = [...new Set(detail.unsettledWagePeriods.map((period) => wageStatusLabel(period.status)))];
    labels.push(wageStatuses.length === 1 ? wageStatuses[0]! : "工资待结算");
  }
  return labels.join(" / ") || "已结清";
};

const nodeStatusLabel = (node: WorkflowNode, detail: ReworkBusinessDetail): string =>
  node.key === "settlement_followup" && node.state !== "future"
    ? `${detail.status === "completed" ? "订单已完成 · " : ""}${followUpStatusLabel(detail)}`
    : node.state === "completed"
      ? "已完成"
      : node.state === "current" ? "处理中" : "未开始";

const nodeHref = (orderId: string, key: WorkflowNodeKey): string => `${pageUrl(`ui/tasks/${orderId}`)}?node=${key}`;

const historyNode = (action: string): WorkflowNodeKey | null => {
  if (action === "rework.attachments.supplement") return "initiation";
  if (action.startsWith("rework.draft") || action === "rework.submit" || action === "rework.withdraw" || action === "rework.cancel") return "initiation";
  // IE approval is recorded by the configuration service, so distinguish the
  // terminal review action before the broader process-configuration match.
  if (action.includes("process_configuration.review") || action.includes("ie_review")) return "ie_review";
  if (action.includes("process_configuration")) return "process_configuration";
  if (action.includes("tail_inspection")) return "tail_inspection";
  if (action.includes("work_task")) return "task_assignment";
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
  if (action === "rework.submit") return "提交返工单";
  if (action.includes("process_configuration.review") || action.includes("ie_review")) return "IE 审核";
  if (action.includes("process_configuration")) return "工序配置处理";
  if (action.includes("tail_inspection")) return "尾查报数";
  if (action.includes("work_task")) return "返工人员分配";
  if (action.includes("work_report")) return "完成数量登记";
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

export function ReworkDetailPage({
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
  const [collapsedStages, setCollapsedStages] = useState<Set<WorkflowStage["key"]>>(() =>
    window.matchMedia("(max-width: 640px)").matches
      ? new Set(["planning", "execution", "responsibility"])
      : new Set(),
  );

  const load = useCallback(async (signal?: AbortSignal): Promise<ReworkBusinessDetail | null> => {
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
    setState({ kind: "ready", value: latest });
    return latest;
  }, [reworkOrderId]);

  const syncAfterNodeAction = useCallback(async (): Promise<void> => {
    try {
      const latest = await load();
      if (!latest) return;
      const nextNode = currentNodeByStatus[latest.status];
      if (!nextNode) return;
      const url = new URL(window.location.href);
      url.searchParams.set("node", nextNode);
      window.history.replaceState({}, "", url);
    } catch {
      // The business mutation already succeeded. Keep its success feedback and
      // let the user retry a manual page refresh instead of reporting a false failure.
    }
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(apiUrl("auth/me"), {
      credentials: "include", signal: controller.signal, headers: { accept: "application/json" },
    }).then(async (response) => response.ok ? await response.json() as AuthMe : null)
      .then((body) => { if (body?.status === "authorized") setCurrentUser(body.user); })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selectedImage) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedImage(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedImage]);

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

  const backAction = returnToTodos
    ? { action: "返回我的待办", actionHref: "/ui/my-tasks" }
    : {};

  if (state.kind === "loading") {
    return <Shell active="全部订单"><Header title="返工单详情" badge="实时读取" {...backAction} /><Surface>正在加载返工单…</Surface></Shell>;
  }
  if (state.kind === "error") {
    return <Shell active="全部订单"><Header title="返工单详情" badge="无法读取" {...backAction} /><Surface>{state.message}</Surface></Shell>;
  }

  const detail = state.value;
  const orderAttachments = detail.attachments.filter((attachment) => attachment.entityType === "rework_order");
  const imageAttachments = detail.attachments.filter((attachment) => attachment.mimeType.startsWith("image/"));
  const otherAttachments = detail.attachments.filter((attachment) => !attachment.mimeType.startsWith("image/"));
  const meta = statusMeta[detail.status];
  const stages = buildWorkflow(detail, currentUser, returnToTodos ? focusedNode : undefined);
  const activeNode = stages.flatMap((stage) => stage.nodes)
    .find((node) => node.state === "current" || node.state === "followup")?.key;
  const selectedFromUrl = workflowNodeFromSearch();
  const defaultSelectedNode = detail.status === "pending_process_configuration"
    ? "initiation"
    : activeNode ?? "settlement_followup";
  const selectedNode = selectedFromUrl ?? (focusedNode === activeNode ? focusedNode : defaultSelectedNode);
  const selected = stages.flatMap((stage) => stage.nodes).find((node) => node.key === selectedNode);
  const canSeeResponsibility = elevated(currentUser)
    || hasCapability(currentUser, "responsibility:determine")
    || hasCapability(currentUser, "responsibility:takeover")
    || hasCapability(currentUser, "responsibility:confirm_high_multiplier")
    || hasCapability(currentUser, "responsibility:owner_sign");
  const canSeeExternal = elevated(currentUser) || hasCapability(currentUser, "external_responsibility:view");
  const canSeeWages = elevated(currentUser) || hasCapability(currentUser, "wage:view");
  const canSeeWholeOrderReview = elevated(currentUser) || [
    "submission:audit",
    "quantity:adjust",
    "quantity:confirm",
    "process:review",
  ].some((capability) => hasCapability(currentUser, capability));
  const canSupplementOrderImages = detail.status !== "completed"
    && detail.status !== "cancelled"
    && (elevated(currentUser) || (
      hasRole(currentUser, "quality_control")
      && hasCapability(currentUser, "rework:initiate")
    ));
  const canHandleInitiation = elevated(currentUser) || (
    hasRole(currentUser, "quality_control")
    && hasCapability(currentUser, "rework:initiate")
  );

  const renderNodePreview = () => {
    if (!selected) return null;
    const nodeHistory = detail.workflowHistory.filter((event) => historyNode(event.action) === selected.key);
    return <Surface className="rework-detail-node-preview">
      <StatusBadge tone={selected.state === "completed" ? "success" : "info"}>{selected.state === "completed" ? "已完成 · 可只读" : selected.state === "followup" ? `${nodeStatusLabel(selected, detail)} · 只读` : "未开始 · 可预览"}</StatusBadge>
      <h2>{selected.number} · {selected.label}</h2>
      <p>{selected.preview}</p>
      <p>负责角色：{selected.ownerRole}{" · "}实际负责人：{selected.ownerName}</p>
      {selected.state === "completed" && (
        <div className="rework-detail-node-history">
          <h3>处理历史</h3>
          {nodeHistory.length ? nodeHistory.map((event, index) => (
            <div key={`${event.action}-${event.handledAt}-${index}`}>
              <b>{historyActionLabel(event.action)}</b>
              <span>处理人：{event.handledBy} · 处理时间：{formatTime(event.handledAt)}</span>
              <span>处理意见：{event.remark ?? "未填写备注"}</span>
            </div>
          )) : <p>该节点的早期历史记录未完整入库；可在系统管理的审计日志中查询原始记录。</p>}
          {detail.attachments.length > 0 && <p>关联附件：{detail.attachments.map((attachment) => <span key={attachment.attachmentId}>
            {attachment.entityType === "external_responsibility_case" ? "外部责任 · " : ""}{attachment.filename}{" "}
            <a href={attachmentUrl(attachment.attachmentId, "preview")} rel="noreferrer" target="_blank">预览</a>{" · "}
            <a href={attachmentUrl(attachment.attachmentId, "download")} rel="noreferrer" target="_blank">下载</a>{"；"}
          </span>)}</p>}
        </div>
      )}
    </Surface>;
  };

  const renderSelectedTask = () => {
    if (!selected) return null;
    if (selected.key === "initiation" && detail.status === "draft") {
      return canHandleInitiation
        ? <ReworkInitiationForm
          reworkOrderId={detail.reworkOrderId}
          embedded
          onOrderChanged={() => { void load(); }}
        />
        : <NodePermissionNotice node={selected} />;
    }
    if (selected.key === "initiation" && detail.status === "pending_process_configuration") {
      return <InitiationFollowUpActions
        detail={detail}
        canHandleInitiation={canHandleInitiation}
        onChanged={() => { void load(); }}
      />;
    }
    if (selected.state !== "future" && (selected.key === "process_configuration" || selected.key === "ie_review")) {
      if (canUseProcessWorkspace(currentUser)) return <ProcessConfigurationForm
        reworkOrderId={detail.reworkOrderId}
        onOrderChanged={syncAfterNodeAction}
      />;
      if (selected.state === "current" || selected.state === "followup") return <NodePermissionNotice node={selected} />;
    }
    if (selected.state !== "future" && (selected.key === "task_assignment" || selected.key === "work_reporting")) {
      if (canUseWorkWorkspace(currentUser)) return <WorkReportingForm
        reworkOrderId={detail.reworkOrderId}
        taskMode={selected.key}
        onOrderChanged={syncAfterNodeAction}
      />;
      if (selected.state === "current") return <NodePermissionNotice node={selected} />;
    }
    if (selected.state !== "future" && selected.key === "tail_inspection") {
      if (canUseTailInspection(currentUser)) return <TailInspectionPanel
        reworkOrderId={detail.reworkOrderId}
        isRoot={currentUser?.isRoot === true}
        onOrderChanged={syncAfterNodeAction}
      />;
      if (selected.state === "current") return <NodePermissionNotice node={selected} />;
    }
    if (selected.state !== "future" && (selected.key === "whole_order_review" || selected.key === "quantity_adjustment")) {
      if (canSeeWholeOrderReview) return <WorkReportingForm
        reworkOrderId={detail.reworkOrderId}
        taskMode="whole_order_review"
        onOrderChanged={syncAfterNodeAction}
      />;
      if (selected.state === "current") return <NodePermissionNotice node={selected} />;
    }
    if (selected.state !== "future" && (selected.key === "responsibility" || selected.key === "owner_signature")) {
      if (canSeeResponsibility) return <ResponsibilityDeterminationPanel reworkOrderId={detail.reworkOrderId} onOrderChanged={syncAfterNodeAction} />;
      if (selected.state === "current") return <NodePermissionNotice node={selected} />;
    }
    if (selected.state !== "future" && selected.key === "settlement_ledger") {
      if (canSeeExternal || elevated(currentUser)) return <ExternalResponsibilityPanel reworkOrderId={detail.reworkOrderId} readOnly />;
      return <SettlementLedgerNotice detail={detail} />;
    }
    if (selected.state !== "future" && selected.key === "settlement_followup") {
      const hasWageFollowUp = canSeeWages && detail.unsettledWagePeriods.length > 0;
      return <>
        <OrderCompletionAndSettlementSummary detail={detail} />
        {canSeeExternal || hasWageFollowUp ? <>
          {canSeeExternal ? <ExternalResponsibilityPanel reworkOrderId={detail.reworkOrderId} {...(focusedExternalCaseId ? { focusCaseId: focusedExternalCaseId } : {})} /> : null}
          {hasWageFollowUp ? <WageSettlementFollowUp periods={detail.unsettledWagePeriods} /> : null}
        </> : null}
      </>;
    }
    return renderNodePreview();
  };

  return (
    <Shell active="全部订单">
      <Header title={detail.styleNo ?? "款号未填写"} subtitle={detail.reworkNo ?? "未提交返工草稿"} badge={meta.label} {...backAction} />
      <div className="rework-detail-layout">
        <Surface className="rework-detail-summary">
          <div className="section-title">
            <div><h2>返工单信息</h2><p>订单是唯一的流程与执行载体；处理动作始终在对应节点下方完成。</p></div>
          </div>
          <div className="rework-detail-summary-sections">
            <section className="rework-detail-summary-section">
              <h3>订单与执行</h3>
              <dl className="rework-detail-facts rework-detail-facts--core">
                <div><dt>订单号</dt><dd>{detail.orderNo ?? "未填写"}</dd></div>
                <div><dt>加工厂</dt><dd>{detail.processingFactory?.displayName ?? "—"}</dd></div>
                <div><dt>订单跟单</dt><dd>{detail.merchandiser?.displayName ?? "—"}</dd></div>
                <div><dt>订单数量</dt><dd>{detail.orderQuantity === null ? "—" : `${detail.orderQuantity} 件`}</dd></div>
                <div><dt>返工数量</dt><dd>{detail.reworkQuantity === null ? "—" : `${detail.reworkQuantity} 件`}</dd></div>
              </dl>
            </section>
            <section className="rework-detail-summary-section">
              <h3>返工问题</h3>
              <dl className="rework-detail-facts rework-detail-facts--issue">
                <div><dt>返工原因</dt><dd>{detail.reworkReason ?? "—"}</dd></div>
                <div><dt>返工工序</dt><dd>{detail.reworkProcess ?? "—"}</dd></div>
                <div><dt>问题部位</dt><dd>{detail.problemPart ?? "—"}</dd></div>
                <div className="rework-detail-wide rework-detail-description"><dt>问题描述</dt><dd>{detail.problemDescription ?? "—"}</dd></div>
              </dl>
            </section>
            <details className="rework-detail-secondary-facts">
              <summary><b>更多订单资料</b><small>客供代号、附件与操作记录</small></summary>
              <dl className="rework-detail-facts rework-detail-facts--secondary">
                <div><dt>客供代号</dt><dd>{detail.customerSupplyCode ?? "—"}</dd></div>
                <div><dt>工厂货号</dt><dd>{detail.factoryStyleNo ?? "—"}</dd></div>
                <div><dt>发起人</dt><dd>{detail.createdBy.displayName}</dd></div>
                <div><dt>发起时间</dt><dd>{formatTime(detail.createdAt)}</dd></div>
                <div><dt>最近更新</dt><dd>{formatTime(detail.updatedAt)}</dd></div>
                {detail.cancelReason ? <div className="rework-detail-wide"><dt>取消原因</dt><dd>{detail.cancelReason}</dd></div> : null}
                {otherAttachments.length > 0 && <div className="rework-detail-wide"><dt>其他附件（含外部责任凭证）</dt><dd>{otherAttachments.map((attachment) => <span key={attachment.attachmentId}>
                  {attachment.entityType === "external_responsibility_case" ? "外部责任 · " : ""}{attachment.filename}（{attachment.mimeType}）{" "}
                  <a href={attachmentUrl(attachment.attachmentId, "preview")} rel="noreferrer" target="_blank">预览</a>{" · "}
                  <a href={attachmentUrl(attachment.attachmentId, "download")} rel="noreferrer" target="_blank">下载</a>{"；"}
                </span>)}</dd></div>}
              </dl>
            </details>
          </div>
          {detail.inspectionReport ? <InspectionReportReadonly report={detail.inspectionReport} /> : null}
          <section className="rework-detail-images" aria-label="订单图片">
            <div className="section-title">
              <div><h2>订单图片</h2></div>
              <StatusBadge tone="info">{imageAttachments.length} 张图片</StatusBadge>
            </div>
            {canSupplementOrderImages && (
              <OrderImageSupplementUploader
                reworkOrderId={detail.reworkOrderId}
                expectedVersion={detail.version}
                currentAttachmentCount={orderAttachments.length}
                onUploaded={async () => { await load(); }}
              />
            )}
            {imageAttachments.length > 0 ? (
              <div className="rework-detail-image-grid">
                {imageAttachments.map((attachment) => (
                  <button
                    className="rework-detail-image-card"
                    type="button"
                    key={attachment.attachmentId}
                    onClick={() => setSelectedImage(attachment)}
                    aria-label={`放大查看 ${attachment.filename}`}
                  >
                    <img src={attachmentUrl(attachment.attachmentId, "preview")} alt={attachment.filename} loading="lazy" />
                    <span>{attachment.entityType === "external_responsibility_case" ? "外部责任 · " : ""}{attachment.filename}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        </Surface>

        <section className="rework-workflow" key={detail.status} aria-label="订单流程">
          <div className="rework-workflow__heading"><div><h2>订单流程</h2><p>阶段可收起；点击任务节点查看规则、历史或当前处理页。</p></div></div>
          <div className="rework-workflow__stages">
            {stages.map((stage) => {
              const state = stageState(stage);
              const isOpen = !collapsedStages.has(stage.key);
              return <details
                className={`rework-workflow__stage is-${state}`}
                key={stage.key}
                open={isOpen}
                onToggle={(event) => {
                  const nextOpen = event.currentTarget.open;
                  setCollapsedStages((current) => {
                    const next = new Set(current);
                    if (nextOpen) next.delete(stage.key);
                    else next.add(stage.key);
                    return next;
                  });
                }}
              >
                <summary>
                  <span><b>{stage.title}</b><small>{state === "completed" ? "阶段已完成" : state === "current" ? "当前阶段" : state === "followup" ? "订单已完成 · 后续结算中" : "待前序完成"}</small></span>
                  <span className="rework-workflow__stage-toggle"><strong>{stage.nodes.filter((node) => node.state === "completed" || node.state === "followup").length}/{stage.nodes.length}</strong><i aria-hidden="true">{isOpen ? "−" : "+"}</i></span>
                </summary>
                <div className="rework-workflow__nodes">
                  {stage.nodes.map((node) => <a className={`rework-workflow__node is-${node.state}`} href={nodeHref(detail.reworkOrderId, node.key)} key={node.key}>
                    <b>{node.number}</b><span><strong>{node.label}</strong><small>{node.ownerRole} · {node.ownerName}</small></span><em>{nodeStatusLabel(node, detail)}</em>
                  </a>)}
                </div>
              </details>;
            })}
            {detail.status === "pending_responsibility_determination" ? <div className="rework-workflow__pending-path">N08 选择每道工序的主责任方后提交老板签字；供应商计划扣款暂不生成。</div> : null}
          </div>
        </section>

        <section className="rework-detail-task" aria-label="节点任务">
          <div className="rework-detail-task__heading"><div><p>当前查看节点</p><h2>{selected?.number} · {selected?.label}</h2></div><StatusBadge tone={selected?.state === "completed" ? "success" : "info"}>{selected ? nodeStatusLabel(selected, detail) : "预览"}</StatusBadge></div>
          {renderSelectedTask()}
        </section>
      </div>
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
              <strong>{selectedImage.entityType === "external_responsibility_case" ? "外部责任 · " : ""}{selectedImage.filename}</strong>
              <button type="button" onClick={() => setSelectedImage(null)}>关闭</button>
            </div>
            <img src={attachmentUrl(selectedImage.attachmentId, "preview")} alt={selectedImage.filename} />
            <a href={attachmentUrl(selectedImage.attachmentId, "download")} rel="noreferrer" target="_blank">下载原图</a>
          </section>
        </div>
      )}
    </Shell>
  );
}

function InitiationFollowUpActions({
  detail,
  canHandleInitiation,
  onChanged,
}: {
  detail: ReworkBusinessDetail;
  canHandleInitiation: boolean;
  onChanged: () => void;
}) {
  const [message, setMessage] = useState("");
  const [busyAction, setBusyAction] = useState<"withdraw" | "cancel" | null>(null);
  const canWithdraw = detail.status === "pending_process_configuration";
  const canCancel = detail.status === "pending_process_configuration";

  const transition = async (action: "withdraw" | "cancel") => {
    const promptText = action === "withdraw" ? "请输入撤回原因" : "请输入取消原因";
    const reason = await promptInApp(promptText);
    if (!reason?.trim()) return;
    setBusyAction(action);
    try {
      const response = await fetch(apiUrl(`rework-orders/${detail.reworkOrderId}/${action}`), {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ expectedVersion: detail.version, reason: reason.trim() }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? "状态变更失败");
      }
      setMessage(action === "withdraw" ? "已撤回为草稿，可在本节点继续修改后再次提交。" : "返工单已取消，历史记录继续保留。");
      onChanged();
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "状态变更失败");
    } finally {
      setBusyAction(null);
    }
  };

  return <Surface className="rework-detail-node-preview rework-detail-initiation-actions">
    <StatusBadge tone={detail.status === "cancelled" ? "danger" : "info"}>{statusMeta[detail.status].label}</StatusBadge>
    <h2>01 · 发起返工</h2>
    <p>{detail.status === "cancelled"
      ? "该返工单已取消，历史资料和操作记录继续保留。"
      : "提交后的撤回、取消及撤回后的再次提交，统一在订单详情的本节点处理。"}</p>
    {canHandleInitiation && (canWithdraw || canCancel) ? (
      <div className="rework-detail-initiation-actions__buttons">
        {canWithdraw ? <Button disabled={busyAction !== null} onClick={() => void transition("withdraw")}>{busyAction === "withdraw" ? "撤回中…" : "撤回修改"}</Button> : null}
        {canCancel ? <Button disabled={busyAction !== null} onClick={() => void transition("cancel")}>{busyAction === "cancel" ? "取消中…" : "取消返工单"}</Button> : null}
      </div>
    ) : null}
    {message ? <p role="status">{message}</p> : null}
  </Surface>;
}

function NodePermissionNotice({ node }: { node: WorkflowNode }) {
  return <Surface className="rework-detail-node-preview"><StatusBadge tone="info">仅可查看</StatusBadge><h2>{node.number} · {node.label}</h2><p>{node.preview}</p><p>当前账号没有该节点的处理权限；如需处理，请从本人待办进入或联系节点负责人。</p></Surface>;
}

function SettlementLedgerNotice({ detail }: { detail: ReworkBusinessDetail }) {
  const text = detail.settlementStatus === "not_required"
    ? "本单没有外部责任方；老板签字后系统已完成责任结算台账，无需供应商扣款。"
    : detail.settlementStatus === "closed"
      ? "所有供应商扣款台账已终结。"
      : detail.settlementStatus === "revision_in_progress"
        ? "存在责任调整，待重新确认后自动生成新的责任结算台账。"
        : "责任结算台账已自动生成；供应商实际扣款在 N10 的后续结算区跟进，不阻塞订单完成。";
  return <Surface className="rework-detail-node-preview"><StatusBadge tone="info">系统自动生成 · 只读</StatusBadge><h2>09 · 责任结算台账</h2><p>{text}</p></Surface>;
}

function OrderCompletionAndSettlementSummary({ detail }: { detail: ReworkBusinessDetail }) {
  const orderCompleted = detail.status === "completed";
  return <Surface className="rework-detail-node-preview">
    <StatusBadge tone={orderCompleted ? "success" : "info"}>{orderCompleted ? "订单已完成" : "责任结算中"}</StatusBadge>
    <h2>10 · 订单完成与后续结算</h2>
    <p>{orderCompleted
      ? "返工生产和责任判定已经结束；工资月结与供应商实际扣款继续独立跟进，不会重新打开订单。"
      : "责任结算台账已生成，正在完成后续责任结算。"}</p>
    <p>后续结算状态：{followUpStatusLabel(detail)}</p>
  </Surface>;
}

function WageSettlementFollowUp({ periods }: {
  periods: ReworkBusinessDetail["unsettledWagePeriods"];
}) {
  return <Surface className="rework-detail-node-preview">
    <StatusBadge tone="info">已计入工资批次</StatusBadge>
    <h2>工资结算进度</h2>
    <p>订单已经完成；工资在 N10 内按月份独立核对，不会重新打开订单主流程。</p>
    <div className="rework-detail-wage-links">
      {periods.map((period) => <a key={period.periodId} href={pageUrl(`ui/wages/${period.periodId}`)}>
        {period.periodMonth.slice(0, 7)} · {wageStatusLabel(period.status)} · 进入处理
      </a>)}
    </div>
  </Surface>;
}
