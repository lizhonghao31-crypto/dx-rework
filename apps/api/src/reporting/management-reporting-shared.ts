import { BUSINESS_TIME_ZONE } from "@dx-rework/contracts/business-display";
import type { ManagementReworkRow, ReportType, ReportPreviewResponse } from "@dx-rework/contracts/reporting";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";

export const TIMEZONE = BUSINESS_TIME_ZONE;
export const ZERO = "0.00";

export type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;
export type Range = Readonly<{ from: string; to: string; asOf: Date }>;
export type FactRow = {
  rework_order_id: string;
  rework_no: string | null;
  style_no: string | null;
  order_no: string | null;
  status: ManagementReworkRow["status"];
  rework_kind?: "qc_rework" | "inhouse_finishing";
  node: string;
  node_label: string;
  node_entered_at: Date;
  aging_seconds: string;
  current_handler_user_id: string | null;
  planned_quantity: string | null;
  reported_quantity: string;
  wage_amount: string;
  responsibility_amount: string;
  own_factory_amount: string;
  external_proposed_amount: string;
  external_deducted_amount: string;
  external_remaining_amount: string;
  deduction_status: ManagementReworkRow["deductionStatus"];
  overdue: boolean;
  exception_count: number;
  attachment_count: number;
  updated_at: Date;
  total_count?: string;
};
export type CountRow = { status: string; count: string };
export type FinancialRow = {
  wage_total: string;
  responsibility_total: string;
  own_factory_total: string;
  external_proposed: string;
  external_deducted: string;
  external_remaining: string;
};
export type ExceptionRow = {
  exception_type: "overdue_todo" | "blocked_recipient" | "todo_delivery_failed" | "deduction_follow_up_overdue";
  entity_id: string;
  rework_order_id: string | null;
  label: string;
  occurred_at: Date;
  deep_link: string;
};
export type ReportColumn = { key: string; label: string };
export type ReportRow = Record<string, string | number | boolean | null>;
export type ReportData = { columns: ReportColumn[]; rows: ReportRow[]; totals: Record<string, string>; wageSummary?: ReportPreviewResponse["wageSummary"]; pagination?:ReportPreviewResponse["pagination"] };

export const fail = (message: string, status = 403, code = "FORBIDDEN"): never => {
  throw new ApplicationError(code, message, status);
};
export const money = (value: string | null | undefined): string => {
  if (value === null || value === undefined) return ZERO;
  const match = /^(-?\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new ApplicationError("INTERNAL_ERROR", "报表金额格式异常", 500);
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return `${match[1]}.${fraction}`;
};
export const number = (value: string | number): number => typeof value === "number" ? value : Number(value);
export const iso = (value: Date): string => value.toISOString();
export const capabilities = (actor: TrustedActorContext): readonly string[] => actor.authorizationCapabilities ?? [actor.authorizationCapability];
export type ReworkListCursor = Readonly<{
  closedRank?: 0 | 1;
  updatedAt: string;
  id: string;
}>;

const closedOrderRank = (status: ManagementReworkRow["status"]): 0 | 1 =>
  status === "completed" || status === "cancelled" ? 1 : 0;

export const encodeCursor = (row: FactRow): string => Buffer.from(JSON.stringify({
  closedRank: closedOrderRank(row.status),
  updatedAt: row.updated_at.toISOString(),
  id: row.rework_order_id,
}), "utf8").toString("base64url");
export const decodeCursor = (cursor: string | undefined): ReworkListCursor | null => {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object") throw new Error("invalid");
    const parsed = value as Record<string, unknown>;
    const closedRank = parsed.closedRank;
    if (
      typeof parsed.updatedAt !== "string"
      || Number.isNaN(Date.parse(parsed.updatedAt))
      || typeof parsed.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)
      || (closedRank !== undefined && closedRank !== 0 && closedRank !== 1)
    ) throw new Error("invalid");
    return {
      updatedAt: parsed.updatedAt,
      id: parsed.id,
      ...(closedRank === 0 || closedRank === 1 ? { closedRank } : {}),
    };
  } catch {
    return fail("查询游标无效", 400, "VALIDATION_ERROR");
  }
};

export const nodeMeta: Record<ManagementReworkRow["status"], { node: string; label: string }> = {
  draft: { node: "N01", label: "发起返工 / 草稿" },
  pending_process_configuration: { node: "N02", label: "待配置工序" },
  pending_ie_review: { node: "N03", label: "待 IE 审核" },
  pending_task_assignment: { node: "N02-R", label: "待启动预分配任务" },
  in_progress: { node: "N04", label: "返工执行中" },
  pending_order_review: { node: "N05", label: "待尾部确认最终数量" },
  pending_final_quantity_ie_review: { node: "N06", label: "最终数量待 IE 复核" },
  pending_quantity_adjustment_ie_review: { node: "N06-A", label: "数量调整待 IE" },
  pending_responsibility_determination: { node: "N07", label: "责任判定与资料核验" },
  pending_owner_signature: { node: "N08", label: "待老板确认签字" },
  // Only legacy records remain on this status. New orders complete their main
  // chain at N10 and keep actual deductions in the independent N11 ledger.
  pending_responsibility_action: { node: "N-LEGACY", label: "旧责任处理" },
  completed: { node: "N09", label: "订单已完成" },
  cancelled: { node: "N-C", label: "已取消" },
};

export const reportStatusValues: Readonly<Record<ReportType, ReadonlySet<string>>> = {
  rework_overview: new Set(Object.keys(nodeMeta)),
  wages: new Set(["settled", "unsettled"]),
  responsibilities: new Set(["own_factory", "processing_factory", "embroidery_factory", "washing_factory", "fabric_supplier"]),
  own_factory: new Set(["pending", "approved", "rejected"]),
  external_deductions: new Set([
    "pending_business_signoff", "pending_payables_confirmation", "deduction_follow_up", "pending_special_approval",
    "returned", "pending_responsibility_revision", "closed", "superseded",
    "full", "partial", "not_deducted", "over_deducted",
  ]),
  exceptions: new Set(["overdue_todo", "blocked_recipient", "todo_delivery_failed", "deduction_follow_up_overdue"]),
};
