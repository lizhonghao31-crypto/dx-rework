import {reworkResultNode} from "./rework-result-node.js";
import { specialProcessLabel, specialProcessName } from "@dx-rework/contracts";
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
import "./legacy-ui.css";

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
  pending_responsibility_determination: { label: "待责任判定", next: "返工已完成整单确认，正在核对各工序责任方、承担比例和外部扣款倍率" },
  pending_owner_signature: { label: "待老板签字", next: "供应链总监资料已齐全，等待老板确认同意或驳回" },
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
      title: detail.reworkKind === "inhouse_finishing" ? "本厂做尾执行" : "返工执行",
      nodes: [
        node("work_reporting", "04", detail.reworkKind === "inhouse_finishing" ? "本厂做尾报数" : "返工执行报数", detail.tailInspectionRequired ? `返工人员 / ${specialProcessLabel(detail)}` : detail.reworkKind === "inhouse_finishing" ? "做尾人员" : "返工人员", "待 IE 核价通过并自动激活任务", detail.tailInspectionRequired ? `返工人员与${specialProcessLabel(detail)}都在同一执行节点提交本人实际件数；临时工由尾部主管代录。` : detail.reworkKind === "inhouse_finishing" ? "做尾人员在执行节点提交本人实际件数；临时工由尾部主管代录。" : "返工人员在执行节点提交本人实际件数；临时工由尾部主管代录。"),
