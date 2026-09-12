import type { ManagementReworkRow } from "@dx-rework/contracts/reporting";

import { type FactRow, money, number, iso } from "./management-reporting-shared.js";

export function factDto(row: FactRow, canReadWages = true): ManagementReworkRow {
  return {
    reworkOrderId: row.rework_order_id,
    reworkNo: row.rework_no,
    styleNo: row.style_no,
    orderNo: row.order_no,
    status: row.status,
    node: row.node,
    nodeLabel: row.node_label,
    nodeEnteredAt: iso(row.node_entered_at),
    agingSeconds: number(row.aging_seconds),
    currentHandlerUserId: row.current_handler_user_id,
    plannedQuantity: row.planned_quantity,
    reportedQuantity: row.reported_quantity,
    ...(canReadWages ? { wageAmount: money(row.wage_amount) } : {}),
    responsibilityAmount: money(row.responsibility_amount),
    ownFactoryAmount: money(row.own_factory_amount),
    externalProposedAmount: money(row.external_proposed_amount),
    externalDeductedAmount: money(row.external_deducted_amount),
    externalRemainingAmount: money(row.external_remaining_amount),
    deductionStatus: row.deduction_status,
    overdue: row.overdue,
    exceptionCount: row.exception_count,
    attachmentCount: row.attachment_count,
    deepLink: `/ui/tasks/${row.rework_order_id}`,
    updatedAt: iso(row.updated_at),
  };
}
