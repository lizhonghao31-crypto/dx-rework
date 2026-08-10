import { StatusBadge, Surface } from "@dx-rework/ui";
import { useCallback, useEffect, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import type { AuthorizedUser } from "./auth.js";
import { Header, Shell } from "./components.js";
import { ExternalResponsibilityPanel } from "./external-responsibility-panel.js";
import { OwnFactoryApprovalPanel } from "./own-factory-approval-panel.js";
import { ProcessConfigurationForm } from "./process-configuration-form.js";
import { ResponsibilityDeterminationPanel } from "./responsibility-determination-panel.js";
import { WorkReportingForm } from "./work-reporting-form.js";
import "./rework-detail.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
const detailRefreshMilliseconds = 2_000;

type ReworkStatus =
  | "draft"
  | "pending_process_configuration"
  | "pending_ie_review"
  | "pending_task_assignment"
  | "in_progress"
  | "pending_order_review"
  | "pending_quantity_adjustment_ie_review"
  | "pending_responsibility_determination"
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
  | "quantity_adjustment"
  | "responsibility"
  | "responsibility_settlement"
  | "archive";

type ReworkBusinessDetail = Readonly<{
  reworkOrderId: string;
  reworkNo: string | null;
  status: ReworkStatus;
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
  createdBy: Readonly<{ userId: string; displayName: string }>;
  processConfigurationCreatedBy: Readonly<{ userId: string; displayName: string }> | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
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

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; value: ReworkBusinessDetail }
  | { kind: "error"; message: string };

type AuthMe = Readonly<{
  status: "authorized" | "no_role";
  user: AuthorizedUser;
}>;

type WorkflowNodeState = "completed" | "current" | "future";
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
  pending_process_configuration: { label: "待配置工序", next: "下一步由尾部主管配置工序、计划数量和单价" },
  pending_ie_review: { label: "待 IE 审核", next: "下一步由 IE 审核工序、数量、单位和单价" },
  pending_task_assignment: { label: "待分配任务", next: "工序已生效，下一步由尾部主管分配返工人员" },
  in_progress: { label: "返工执行中", next: "工人按实际完成进度登记完成数量，全部完成后进入整单审核" },
  pending_order_review: { label: "待整单审核", next: "下一步由尾部主管确认整张返工单已完成" },
  pending_quantity_adjustment_ie_review: { label: "数量调整待 IE", next: "异常数量增加申请等待 IE 复核" },
  pending_responsibility_determination: { label: "待责任判定", next: "返工已完成审核，正在判定责任、倍率和承担比例" },
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
  pending_responsibility_action: 7,
  completed: 8,
};

const currentNodeByStatus: Partial<Record<ReworkStatus, WorkflowNodeKey>> = {
  draft: "initiation",
  pending_process_configuration: "process_configuration",
  pending_ie_review: "ie_review",
  pending_task_assignment: "task_assignment",
  in_progress: "work_reporting",
  pending_order_review: "whole_order_review",
  pending_quantity_adjustment_ie_review: "quantity_adjustment",
  pending_responsibility_determination: "responsibility",
  pending_responsibility_action: "responsibility_settlement",
  completed: "archive",
};

const nodeRank: Record<WorkflowNodeKey, number> = {
  initiation: 0,
  process_configuration: 1,
  ie_review: 2,
  task_assignment: 3,
  work_reporting: 4,
  whole_order_review: 5,
  quantity_adjustment: 5,
  responsibility: 6,
  responsibility_settlement: 7,
  archive: 8,
};

const nodeKeys = new Set<WorkflowNodeKey>([
  "initiation", "process_configuration", "ie_review", "task_assignment", "work_reporting",
  "whole_order_review", "quantity_adjustment", "responsibility", "responsibility_settlement", "archive",
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
const canUseOrderIndex = (user: AuthorizedUser | null): boolean => elevated(user)
  || hasCapability(user, "dashboard:management:read")
  || hasCapability(user, "dashboard:site:read")
  || hasCapability(user, "report:view");

const workflowState = (status: ReworkStatus, key: WorkflowNodeKey): WorkflowNodeState => {
  if (status === "cancelled") return "future";
  // `completed` is the terminal business fact: all numbered nodes, including
  // 09 订单归档, must render as completed rather than leaving a false current node.
  if (status === "completed") return "completed";
  if (currentNodeByStatus[status] === key) return "current";
  return statusRank[status] > nodeRank[key] ? "completed" : "future";
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
    const state = workflowState(detail.status, key);
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

  const executionNodes: WorkflowNode[] = [
    node("task_assignment", "04", "分配返工人员", "尾部主管", "待工序生效后分配", "确认工序后分配人员或调整成员。"),
    node("work_reporting", "05", "完成数量登记", "返工人员", "待任务分配", "按实际完成进度登记数量与完成时间。"),
    node("whole_order_review", "06", "整单完成确认", "尾部主管", "待全部工序完成", "核对全部工序后确认整张返工单完成。"),
  ];
  if (detail.status === "pending_quantity_adjustment_ie_review") {
    executionNodes.push(node("quantity_adjustment", "06A", "异常数量 IE 复核", "IE 审核", "当前由 IE 处理", "异常数量调整仅在该订单实际触发时显示。"));
  }

  return [
    {
      key: "planning",
      title: "发起与方案",
      nodes: [
        node("initiation", "01", "发起返工", "质检", detail.createdBy.displayName, "登记订单、问题、数量及证据后提交返工单。"),
        node("process_configuration", "02", "配置工序与单价", "尾部主管", detail.processConfigurationCreatedBy?.displayName ?? "待提交后分配", "配置返工工序、计划数量、计价单位与单价。"),
        node("ie_review", "03", "IE 审核方案", "IE 审核", "待工序配置后分配", "审核工序、数量、单位与单价；不允许自审。"),
      ],
    },
    { key: "execution", title: "返工执行", nodes: executionNodes },
    {
      key: "responsibility",
      title: "责任与归档",
      nodes: [
        node("responsibility", "07", "责任判定", "生产管理 / 老板", "待整单审核后分配", "判定责任方、倍率及承担比例。"),
        node("responsibility_settlement", "08", "责任结算", "责任方 / 财务", "待责任判定后生成", "按该订单实际责任路径进行本厂审批或外部扣款处理。"),
        node("archive", "09", "订单归档", "系统", "待责任结算完成", "保留完整业务事实、附件和操作记录。"),
      ],
    },
  ];
};

const stageState = (stage: WorkflowStage): WorkflowNodeState => stage.nodes.every((node) => node.state === "completed")
  ? "completed"
  : stage.nodes.some((node) => node.state === "current") ? "current" : "future";

const nodeHref = (orderId: string, key: WorkflowNodeKey): string => `${pageUrl(`ui/tasks/${orderId}`)}?node=${key}`;

const historyNode = (action: string): WorkflowNodeKey | null => {
  if (action.startsWith("rework.draft") || action === "rework.submit" || action === "rework.withdraw" || action === "rework.cancel") return "initiation";
  // IE approval is recorded by the configuration service, so distinguish the
  // terminal review action before the broader process-configuration match.
  if (action.includes("process_configuration.review") || action.includes("ie_review")) return "ie_review";
  if (action.includes("process_configuration")) return "process_configuration";
  if (action.includes("work_task")) return "task_assignment";
  if (action.includes("work_report")) return "work_reporting";
  if (action.includes("whole_order")) return "whole_order_review";
  if (action.includes("quantity.")) return "quantity_adjustment";
  if (action.includes("external") || action.includes("own_factory")) return "responsibility_settlement";
  if (action.includes("responsibility")) return "responsibility";
  if (action.includes(".complete") || action.includes(".archive")) return "archive";
  return null;
};

const historyActionLabel = (action: string): string => {
  if (action === "rework.submit") return "提交返工单";
  if (action.includes("process_configuration.review") || action.includes("ie_review")) return "IE 审核";
  if (action.includes("process_configuration")) return "工序配置处理";
  if (action.includes("work_task")) return "返工人员分配";
  if (action.includes("work_report")) return "完成数量登记";
  if (action.includes("whole_order")) return "整单审核";
  if (action.includes("quantity.")) return "数量调整";
  if (action.includes("external")) return "外部责任结算";
  if (action.includes("own_factory")) return "本厂承担审批";
  if (action.includes("responsibility")) return "责任判定";
  if (action.includes(".complete") || action.includes(".archive")) return "订单归档";
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

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (!reworkOrderId) {
      setState({ kind: "error", message: "返工单链接无效" });
      return;
    }
    const response = await fetch(apiUrl(`rework-orders/${reworkOrderId}/business-detail`), {
      credentials: "include", headers: { accept: "application/json" }, ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? `返工单加载失败（${response.status}）`);
    }
    setState({ kind: "ready", value: await response.json() as ReworkBusinessDetail });
  }, [reworkOrderId]);

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
    const refresh = () => { void load().catch(() => undefined); };
    const intervalId = window.setInterval(refresh, detailRefreshMilliseconds);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort(); window.clearInterval(intervalId); window.removeEventListener("focus", refresh);
    };
  }, [load, reworkOrderId]);

  const canReturnToOrders = canUseOrderIndex(currentUser);
  const backAction = returnToTodos
    ? { action: "返回我的待办", actionHref: "/ui/my-tasks" }
    : canReturnToOrders ? { action: "返回全部订单", actionHref: "/ui/tasks" } : {};

  if (state.kind === "loading") {
    return <Shell active="全部订单"><Header title="返工单详情" badge="实时读取" {...backAction} /><Surface>正在加载返工单…</Surface></Shell>;
  }
  if (state.kind === "error") {
    return <Shell active="全部订单"><Header title="返工单详情" badge="无法读取" {...backAction} /><Surface>{state.message}</Surface></Shell>;
  }

  const detail = state.value;
  const meta = statusMeta[detail.status];
  const stages = buildWorkflow(detail, currentUser, returnToTodos ? focusedNode : undefined);
  const currentNode = stages.flatMap((stage) => stage.nodes).find((node) => node.state === "current")?.key;
  const selectedFromUrl = workflowNodeFromSearch();
  const selectedNode = selectedFromUrl ?? (focusedNode === currentNode ? focusedNode : currentNode ?? "archive");
  const selected = stages.flatMap((stage) => stage.nodes).find((node) => node.key === selectedNode);
  const canSeeResponsibility = elevated(currentUser)
    || hasCapability(currentUser, "responsibility:determine")
    || hasCapability(currentUser, "responsibility:takeover")
    || hasCapability(currentUser, "responsibility:confirm_high_multiplier");
  const canSeeOwnFactory = elevated(currentUser) || hasCapability(currentUser, "own_factory:view");
  const canSeeExternal = elevated(currentUser) || hasCapability(currentUser, "external_responsibility:view");

  const renderSelectedTask = () => {
    if (!selected) return null;
    if (selected.state !== "current") {
      const nodeHistory = detail.workflowHistory.filter((event) => historyNode(event.action) === selected.key);
      return <Surface className="rework-detail-node-preview">
        <StatusBadge tone={selected.state === "completed" ? "success" : "info"}>{selected.state === "completed" ? "已完成 · 可只读" : "未开始 · 可预览"}</StatusBadge>
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
    }
    if (selected.key === "process_configuration" || selected.key === "ie_review") {
      return canUseProcessWorkspace(currentUser)
        ? <ProcessConfigurationForm reworkOrderId={detail.reworkOrderId} />
        : <NodePermissionNotice node={selected} />;
    }
    if (selected.key === "task_assignment" || selected.key === "work_reporting") {
      return canUseWorkWorkspace(currentUser)
        ? <WorkReportingForm reworkOrderId={detail.reworkOrderId} />
        : <NodePermissionNotice node={selected} />;
    }
    if (selected.key === "whole_order_review" || selected.key === "quantity_adjustment") {
      return canUseWorkWorkspace(currentUser)
        ? <WorkReportingForm reworkOrderId={detail.reworkOrderId} taskMode="whole_order_review" />
        : <NodePermissionNotice node={selected} />;
    }
    if (selected.key === "responsibility") {
      return canSeeResponsibility
        ? <ResponsibilityDeterminationPanel reworkOrderId={detail.reworkOrderId} />
        : <NodePermissionNotice node={selected} />;
    }
    if (selected.key === "responsibility_settlement") {
      const panels = [
        canSeeOwnFactory ? <OwnFactoryApprovalPanel key="own-factory" reworkOrderId={detail.reworkOrderId} /> : null,
        canSeeExternal ? <ExternalResponsibilityPanel key="external" reworkOrderId={detail.reworkOrderId} {...(focusedExternalCaseId ? { focusCaseId: focusedExternalCaseId } : {})} /> : null,
      ].filter(Boolean);
      return panels.length ? <div className="rework-detail-responsibility">{panels}</div> : <NodePermissionNotice node={selected} />;
    }
    return <NodePermissionNotice node={selected} />;
  };

  return (
    <Shell active="全部订单">
      <Header title={detail.reworkNo ?? "未提交返工草稿"} subtitle={`${detail.styleNo ?? "款号未填写"} · ${meta.label}`} badge="返工单详情" {...backAction} />
      <div className="rework-detail-layout">
        <Surface className="rework-detail-summary">
          <div className="section-title">
            <div><h2>返工单信息</h2><p>订单是唯一的流程与执行载体；处理动作始终在对应节点下方完成。</p></div>
            <StatusBadge tone={detail.status === "cancelled" ? "danger" : detail.status === "completed" ? "success" : "info"}>{meta.label}</StatusBadge>
          </div>
          <dl className="rework-detail-facts">
            <div><dt>款号</dt><dd>{detail.styleNo ?? "—"}</dd></div><div><dt>客供代号</dt><dd>{detail.customerSupplyCode ?? "—"}</dd></div>
            <div><dt>工厂货号</dt><dd>{detail.factoryStyleNo ?? "—"}</dd></div><div><dt>订单号</dt><dd>{detail.orderNo ?? "未填写"}</dd></div>
            <div><dt>订单数量</dt><dd>{detail.orderQuantity === null ? "—" : `${detail.orderQuantity} 件`}</dd></div><div><dt>返工数量</dt><dd>{detail.reworkQuantity === null ? "—" : `${detail.reworkQuantity} 件`}</dd></div>
            <div><dt>订单跟单</dt><dd>{detail.merchandiser?.displayName ?? "—"}</dd></div><div><dt>加工厂</dt><dd>{detail.processingFactory?.displayName ?? "—"}</dd></div>
            <div><dt>返工原因</dt><dd>{detail.reworkReason ?? "—"}</dd></div><div><dt>返工工序</dt><dd>{detail.reworkProcess ?? "—"}</dd></div>
            <div><dt>问题部位</dt><dd>{detail.problemPart ?? "—"}</dd></div>
            <div className="rework-detail-wide"><dt>问题描述</dt><dd>{detail.problemDescription ?? "—"}</dd></div>
            <div className="rework-detail-wide"><dt>订单关联附件（含外部责任凭证）</dt><dd>{detail.attachments.length
              ? detail.attachments.map((attachment) => <span key={attachment.attachmentId}>
                {attachment.entityType === "external_responsibility_case" ? "外部责任 · " : ""}{attachment.filename}（{attachment.mimeType}）{" "}
                <a href={attachmentUrl(attachment.attachmentId, "preview")} rel="noreferrer" target="_blank">预览</a>{" · "}
                <a href={attachmentUrl(attachment.attachmentId, "download")} rel="noreferrer" target="_blank">下载</a>{"；"}
              </span>)
              : "无"}</dd></div>
            <div><dt>发起人</dt><dd>{detail.createdBy.displayName}</dd></div><div><dt>发起时间</dt><dd>{formatTime(detail.createdAt)}</dd></div>
            <div><dt>首次提交</dt><dd>{formatTime(detail.submittedAt)}</dd></div><div><dt>最近更新</dt><dd>{formatTime(detail.updatedAt)}</dd></div>
            {detail.cancelReason ? <div className="rework-detail-wide"><dt>取消原因</dt><dd>{detail.cancelReason}</dd></div> : null}
          </dl>
        </Surface>

        <section className="rework-workflow" key={detail.status} aria-label="订单流程">
          <div className="rework-workflow__heading"><div><h2>订单流程</h2><p>阶段可收起；点击任务节点查看规则、历史或当前处理页。</p></div><StatusBadge tone="info">{meta.label}</StatusBadge></div>
          <div className="rework-workflow__stages">
            {stages.map((stage) => {
              const state = stageState(stage);
              const isCurrent = state === "current";
              return <details className={`rework-workflow__stage is-${state}`} key={stage.key} open={isCurrent}>
                <summary>
                  <span><b>{stage.title}</b><small>{state === "completed" ? "阶段已完成" : isCurrent ? "当前阶段" : "待前序完成"}</small></span>
                  <strong>{stage.nodes.filter((node) => node.state === "completed").length}/{stage.nodes.length}</strong>
                </summary>
                <div className="rework-workflow__nodes">
                  {stage.nodes.map((node) => <a className={`rework-workflow__node is-${node.state}${selectedNode === node.key ? " is-selected" : ""}`} href={nodeHref(detail.reworkOrderId, node.key)} key={node.key}>
                    <b>{node.number}</b><span><strong>{node.label}</strong><small>{node.ownerRole} · {node.ownerName}</small></span><em>{node.state === "completed" ? "已完成" : node.state === "current" ? "处理中" : "未开始"}</em>
                  </a>)}
                </div>
              </details>;
            })}
            {detail.status === "pending_responsibility_determination" ? <div className="rework-workflow__pending-path">待判定后生成后续责任结算路径</div> : null}
          </div>
        </section>

        <section className="rework-detail-task" aria-label="节点任务">
          <div className="rework-detail-task__heading"><div><p>当前查看节点</p><h2>{selected?.number} · {selected?.label}</h2></div><StatusBadge tone={selected?.state === "completed" ? "success" : selected?.state === "current" ? "warning" : "info"}>{selected?.state === "completed" ? "已完成" : selected?.state === "current" ? "待处理" : "预览"}</StatusBadge></div>
          {renderSelectedTask()}
        </section>
      </div>
    </Shell>
  );
}

function NodePermissionNotice({ node }: { node: WorkflowNode }) {
  return <Surface className="rework-detail-node-preview"><StatusBadge tone="info">仅可查看</StatusBadge><h2>{node.number} · {node.label}</h2><p>{node.preview}</p><p>当前账号没有该节点的处理权限；如需处理，请从本人待办进入或联系节点负责人。</p></Surface>;
}
