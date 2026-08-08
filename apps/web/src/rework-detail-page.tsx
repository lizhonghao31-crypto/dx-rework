import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useState } from "react";

import { createWebUrls } from "../url-contract.js";
import { Header, Shell } from "./components.js";
import { ExternalResponsibilityPanel } from "./external-responsibility-panel.js";
import { OwnFactoryApprovalPanel } from "./own-factory-approval-panel.js";
import { ResponsibilityDeterminationPanel } from "./responsibility-determination-panel.js";

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

const statusMeta: Record<ReworkStatus, { label: string; next: string }> = {
  draft: { label: "草稿", next: "等待发起人补充并提交" },
  pending_process_configuration: { label: "待配置工序", next: "下一步由尾部主管配置工序、计划数量和单价" },
  pending_ie_review: { label: "待 IE 审核", next: "下一步由 IE 审核工序、数量、单位和单价" },
  pending_task_assignment: { label: "待分配任务", next: "工序已生效，下一步由尾部主管分配返工人员" },
  in_progress: { label: "返工上数中", next: "工人按任务上数，完成后进入整单审核" },
  pending_order_review: { label: "待整单审核", next: "下一步由尾部主管审核全部返工上数" },
  pending_quantity_adjustment_ie_review: { label: "数量调整待 IE", next: "数量增加申请等待 IE 复核" },
  pending_responsibility_determination: { label: "待责任判定", next: "返工已完成审核，正在判定责任、倍率和承担比例" },
  pending_responsibility_action: { label: "责任处理中", next: "责任已判定，正在完成本厂审批或外部责任签收" },
  completed: { label: "已完成", next: "返工生产流程已完成，历史数据保持只读可追溯" },
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
  }).format(new Date(value));
};

const nextAction = (detail: ReworkBusinessDetail): { label: string; href: string } | null => {
  if (detail.status === "pending_process_configuration") {
    return { label: "进入工序配置", href: `/ui/process-configuration?rework=${detail.reworkOrderId}` };
  }
  if (detail.status === "pending_ie_review") {
    return { label: "进入 IE 审核", href: `/ui/process-configuration?rework=${detail.reworkOrderId}` };
  }
  if ([
    "pending_task_assignment",
    "in_progress",
    "pending_order_review",
    "pending_quantity_adjustment_ie_review",
  ].includes(detail.status)) {
    return { label: "进入分工 / 上数 / 整单审核", href: `/ui/work-reporting?rework=${detail.reworkOrderId}` };
  }
  return null;
};

export function ReworkDetailPage() {
  const reworkOrderId = orderIdFromLocation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    if (!reworkOrderId) {
      setState({ kind: "error", message: "返工单链接无效" });
      return;
    }
    const controller = new AbortController();
    void fetch(apiUrl(`rework-orders/${reworkOrderId}/business-detail`), {
      credentials: "include",
      headers: { accept: "application/json" },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `返工单加载失败（${response.status}）`);
      }
      return await response.json() as ReworkBusinessDetail;
    }).then((value) => setState({ kind: "ready", value })).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setState({ kind: "error", message: error instanceof Error ? error.message : "返工单加载失败" });
      }
    });
    return () => controller.abort();
  }, [reworkOrderId]);

  if (state.kind === "loading") {
    return <Shell active="返工任务"><Header title="返工单详情" badge="实时读取" action="返回任务列表" actionHref="/ui/tasks" /><Surface>正在加载返工单…</Surface></Shell>;
  }
  if (state.kind === "error") {
    return <Shell active="返工任务"><Header title="返工单详情" badge="无法读取" action="返回任务列表" actionHref="/ui/tasks" /><Surface>{state.message}</Surface></Shell>;
  }

  const detail = state.value;
  const meta = statusMeta[detail.status];
  const action = nextAction(detail);
  const showResponsibility = [
    "pending_responsibility_determination",
    "pending_responsibility_action",
    "completed",
  ].includes(detail.status);

  return (
    <Shell active="返工任务">
      <Header
        title={detail.reworkNo ?? "未提交返工草稿"}
        subtitle={`${detail.styleNo ?? "款号未填写"} · ${meta.label}`}
        badge="返工单详情"
        action="返回任务列表"
        actionHref="/ui/tasks"
      />

      <div className="rework-detail-layout">
        <div className="rework-detail-main">
          <Surface className="rework-detail-summary">
            <div className="section-title">
              <div>
                <h2>返工单信息</h2>
                <p>业务人员先看单据事实，再按当前节点处理。</p>
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
            {action ? <a href={pageUrl(action.href)}><Button variant="primary">{action.label}</Button></a> : null}
          </Surface>
        </div>

        {showResponsibility ? (
          <div className="rework-detail-responsibility">
            <ResponsibilityDeterminationPanel reworkOrderId={detail.reworkOrderId} />
            <OwnFactoryApprovalPanel reworkOrderId={detail.reworkOrderId} />
            <ExternalResponsibilityPanel reworkOrderId={detail.reworkOrderId} />
          </div>
        ) : null}
      </div>
    </Shell>
  );
}
