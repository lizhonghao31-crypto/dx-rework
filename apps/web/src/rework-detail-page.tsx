import { StatusBadge, Surface } from "@dx-rework/ui";
import { useCallback, useEffect, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import type { AuthorizedUser } from "./auth.js";
import { Header, Shell } from "./components.js";
import { ExternalResponsibilityPanel } from "./external-responsibility-panel.js";
import { OwnFactoryApprovalPanel } from "./own-factory-approval-panel.js";
import { ResponsibilityDeterminationPanel } from "./responsibility-determination-panel.js";
import "./rework-detail.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
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

type ReworkBusinessDetail = Readonly<{
  reworkOrderId: string;
  reworkNo: string | null;
  status: ReworkStatus;
  styleNo: string | null;
  orderNo: string | null;
  merchandiser: Readonly<{ userId: string; displayName: string }> | null;
  processingFactory: Readonly<{
    type: "own_factory" | "supplier";
    supplierId: string | null;
    displayName: string;
  }> | null;
  problemPart: string | null;
  problemDescription: string | null;
  reworkQuantity: number | null;
  createdBy: Readonly<{ userId: string; displayName: string }>;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}>;

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; value: ReworkBusinessDetail }
  | { kind: "error"; message: string };

type AuthMe = Readonly<{
  status: "authorized" | "no_role";
  user: AuthorizedUser;
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
  pending_responsibility_action: { label: "责任处理中", next: "责任已判定，正在完成本厂审批或外部责任签收" },
  completed: { label: "已完成", next: "返工生产流程已完成；工资核对和未完外部扣款按各自生命周期继续" },
  cancelled: { label: "已取消", next: "返工单已取消，历史资料和操作记录继续保留" },
};

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

const formatTime = (value: string | null): string => {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
};

const hasRole = (user: AuthorizedUser | null, role: string): boolean =>
  user?.businessRoles?.includes(role) === true;
const hasCapability = (user: AuthorizedUser | null, capability: string): boolean =>
  user?.capabilities.includes(capability) === true;
const elevated = (user: AuthorizedUser | null): boolean =>
  user?.isRoot === true || hasRole(user, "owner_group");

const canUseProcessWorkspace = (user: AuthorizedUser | null): boolean =>
  elevated(user)
  || (hasRole(user, "tail_supervisor") && hasCapability(user, "process:configure"))
  || (hasRole(user, "ie_reviewer") && hasCapability(user, "process:review"));

const canUseWorkWorkspace = (user: AuthorizedUser | null): boolean =>
  elevated(user)
  || (hasRole(user, "tail_supervisor") && (
    hasCapability(user, "work:assign")
    || hasCapability(user, "submission:audit")
    || hasCapability(user, "quantity:adjust")
  ))
  || (hasRole(user, "worker") && hasCapability(user, "work:report"))
  || hasCapability(user, "work:report_for_worker")
  || (hasRole(user, "order_merchandiser") && hasCapability(user, "quantity:confirm"))
  || (hasRole(user, "ie_reviewer") && hasCapability(user, "process:review"));

const canUseTaskList = (user: AuthorizedUser | null): boolean =>
  elevated(user)
  || hasCapability(user, "dashboard:management:read")
  || hasCapability(user, "dashboard:site:read")
  || hasCapability(user, "report:view");

const detailActiveNav = (user: AuthorizedUser | null): string => {
  if (canUseTaskList(user)) return "返工任务";
  if (
    elevated(user)
    || hasCapability(user, "responsibility:determine")
    || hasCapability(user, "responsibility:takeover")
    || hasCapability(user, "responsibility:confirm_high_multiplier")
  ) return "责任处理";
  if (hasCapability(user, "own_factory:view")) return "本厂审批";
  if (hasCapability(user, "external_responsibility:view")) return "外部扣款";
  if (hasCapability(user, "wage:view")) return "工资核对";
  if (canUseWorkWorkspace(user)) return "返工执行";
  if (canUseProcessWorkspace(user)) return "工序配置";
  return "返工任务";
};

export function ReworkDetailPage() {
  const reworkOrderId = orderIdFromLocation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [currentUser, setCurrentUser] = useState<AuthorizedUser | null>(null);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (!reworkOrderId) {
      setState({ kind: "error", message: "返工单链接无效" });
      return;
    }
    const response = await fetch(apiUrl(`rework-orders/${reworkOrderId}/business-detail`), {
      credentials: "include",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message ?? `返工单加载失败（${response.status}）`);
    }
    const value = await response.json() as ReworkBusinessDetail;
    setState({ kind: "ready", value });
  }, [reworkOrderId]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(apiUrl("auth/me"), {
      credentials: "include",
      signal: controller.signal,
      headers: { accept: "application/json" },
    }).then(async (response) => response.ok ? await response.json() as AuthMe : null)
      .then((body) => {
        if (body?.status === "authorized") setCurrentUser(body.user);
      })
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
    const refresh = () => {
      void load().catch(() => undefined);
    };
    const intervalId = window.setInterval(refresh, detailRefreshMilliseconds);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refresh);
    };
  }, [load, reworkOrderId]);

  const activeNav = detailActiveNav(currentUser);
  const showBackToTasks = canUseTaskList(currentUser);

  if (state.kind === "loading") {
    return <Shell active={activeNav}><Header title="返工单详情" badge="实时读取" {...(showBackToTasks ? { action: "返回任务列表", actionHref: "/ui/tasks" } : {})} /><Surface>正在加载返工单…</Surface></Shell>;
  }
  if (state.kind === "error") {
    return <Shell active={activeNav}><Header title="返工单详情" badge="无法读取" {...(showBackToTasks ? { action: "返回任务列表", actionHref: "/ui/tasks" } : {})} /><Surface>{state.message}</Surface></Shell>;
  }

  const detail = state.value;
  const meta = statusMeta[detail.status];
  const showResponsibility = [
    "pending_responsibility_determination",
    "pending_responsibility_action",
    "completed",
  ].includes(detail.status);
  const canSeeResponsibility = elevated(currentUser)
    || hasCapability(currentUser, "responsibility:determine")
    || hasCapability(currentUser, "responsibility:takeover")
    || hasCapability(currentUser, "responsibility:confirm_high_multiplier");
  const canSeeOwnFactory = elevated(currentUser) || hasCapability(currentUser, "own_factory:view");
  const canSeeExternal = elevated(currentUser) || hasCapability(currentUser, "external_responsibility:view");
  const responsibilityKey = `${detail.status}:${detail.updatedAt}`;

  return (
    <Shell active={activeNav}>
      <Header
        title={detail.reworkNo ?? "未提交返工草稿"}
        subtitle={`${detail.styleNo ?? "款号未填写"} · ${meta.label}`}
        badge="返工单详情"
        {...(showBackToTasks ? { action: "返回任务列表", actionHref: "/ui/tasks" } : {})}
      />

      <div className="rework-detail-layout">
        <div className="rework-detail-main">
          <Surface className="rework-detail-summary">
            <div className="section-title">
              <div>
                <h2>返工单信息</h2>
                <p>统一查询只保留单据事实和全链路信息，不再承担日常节点操作入口。</p>
              </div>
              <StatusBadge tone={detail.status === "cancelled" ? "danger" : detail.status === "completed" ? "success" : "info"}>
                {meta.label}
              </StatusBadge>
            </div>
            <dl className="rework-detail-facts">
              <div><dt>款号</dt><dd>{detail.styleNo ?? "—"}</dd></div>
              <div><dt>订单号</dt><dd>{detail.orderNo ?? "未填写"}</dd></div>
              <div><dt>订单跟单</dt><dd>{detail.merchandiser?.displayName ?? "—"}</dd></div>
              <div><dt>加工厂</dt><dd>{detail.processingFactory?.displayName ?? "—"}</dd></div>
              <div><dt>问题部位</dt><dd>{detail.problemPart ?? "—"}</dd></div>
              <div><dt>返工数量</dt><dd>{detail.reworkQuantity === null ? "—" : `${detail.reworkQuantity} 件`}</dd></div>
              <div className="rework-detail-wide"><dt>问题描述</dt><dd>{detail.problemDescription ?? "—"}</dd></div>
              <div><dt>发起人</dt><dd>{detail.createdBy.displayName}</dd></div>
              <div><dt>发起时间</dt><dd>{formatTime(detail.createdAt)}</dd></div>
              <div><dt>首次提交</dt><dd>{formatTime(detail.submittedAt)}</dd></div>
              <div><dt>最近更新</dt><dd>{formatTime(detail.updatedAt)}</dd></div>
              {detail.cancelReason ? <div className="rework-detail-wide"><dt>取消原因</dt><dd>{detail.cancelReason}</dd></div> : null}
            </dl>
          </Surface>

          <Surface className="rework-detail-current-node">
            <h2>当前进度</h2>
            <p>{meta.next}</p>
            <p>需要处理业务时，请从对应节点工作台进入；订单会随真实状态自动流转到相应队列。</p>
          </Surface>
        </div>

        {showResponsibility && (canSeeResponsibility || canSeeOwnFactory || canSeeExternal) ? (
          <div className="rework-detail-responsibility" key={responsibilityKey}>
            {canSeeResponsibility ? <ResponsibilityDeterminationPanel reworkOrderId={detail.reworkOrderId} /> : null}
            {canSeeOwnFactory ? <OwnFactoryApprovalPanel reworkOrderId={detail.reworkOrderId} /> : null}
            {canSeeExternal ? <ExternalResponsibilityPanel reworkOrderId={detail.reworkOrderId} /> : null}
          </div>
        ) : null}
      </div>
    </Shell>
  );
}
