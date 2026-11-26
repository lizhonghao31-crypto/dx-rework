import {calculateSourcingLinesTotalExact,type SourcingCaseSummary,type SourcingCaseStatus} from "@dx-rework/contracts";
import type {TrustedActorContext} from "../tools/repositories.js";
import {contractReturnState,type ContractReturnFacts} from "./contract-return-state.js";

export const SOURCING_LANE_KEY="garment_processing" as const;
const ROOT_ROLE="root_superuser",CASE_CREATE_ROLE="order_merchandiser";
const DAXING_PRICE_ROLES=new Set([CASE_CREATE_ROLE,"ie_reviewer","production_management","owner_group","factory_payables"]);

type SourcingPricedLineRow = Readonly<{
  position: number;
  quantity: number;
  unitPrice: string;
  totalAmount: string;
}>;

export type SourcingCaseRow = Readonly<{
  workflow_generation?: "legacy" | "digital_production_v1";
  identity_revision?: number;
  sourcing_case_id: string;
  gender: "男装" | "女装" | null;
  style_name_snapshot: string | null;
  erp_order_id: string;
  erp_order_no: string;
  style_no: string;
  lane_key: string;
  order_quantity: number | string;
  daxing_unit_price: string | null;
  estimated_cut_piece_send_date: string | null;
  line_items: readonly {
    position: number;
    styleNo: string;
    alternateStyleNo: string | null;
    color: string | null;
    quantity: number;
    externalUnitPrice: string | null;
    legacy: boolean;
  }[] | null;
  delivery_date: string | null;
  process_description: string | null;
  process_items: string[] | null;
  crafts: readonly {
    position: number;
    craftId: string;
    craftCode: string;
    craftVersion: number;
    craftName: string;
  }[] | null;
  status: string;
  version: number | string;
  created_by: string;
  effective_created_by?: string|null;
  merchandiser_name?: string | null;
  first_image_attachment_id?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  sourcing_ie_quote_id: string | null;
  quote_version: number | string | null;
  unit_price: string | null;
  quote_quantity: number | string | null;
  total_amount: string | null;
  quote_line_prices: readonly SourcingPricedLineRow[] | null;
  quote_reason: string | null;
  quoted_by: string | null;
  quoted_at: Date | string | null;
  original_ie_budget_order_id?:string|null;
  adopted_budget_order_id?:string|null;
  adopted_budget_version?:number|null;
  adopted_quotation_row_id?:string|null;
  sourcing_decision_id: string | null;
  decision_version: number | string | null;
  source_type: "initial" | "management_revision" | "factory_change" | "price_reapplication" | null;
  source_ie_quote_id: string | null;
  supersedes_decision_id: string | null;
  supplier_id: string | null;
  supplier_code_snapshot: string | null;
  supplier_name_snapshot: string | null;
  decision_unit_price: string | null;
  decision_quantity: number | string | null;
  decision_total_amount: string | null;
  decision_line_prices: readonly SourcingPricedLineRow[] | null;
  cutting_process: "in_house" | "outsourced" | "other" | null;
  cutting_process_other: string | null;
  management_decision_reason: string | null;
  management_decided_by: string | null;
  management_decided_at: Date | string | null;
  sourcing_owner_decision_id: string | null;
  owner_sourcing_decision_id: string | null;
  owner_decision: "approved" | "rejected" | null;
  owner_decision_reason: string | null;
  owner_decided_by: string | null;
  owner_decided_at: Date | string | null;
  sourcing_approval_snapshot_id: string | null;
  approval_decision_id: string | null;
  approval_decision_version: number | string | null;
  approval_supplier_id: string | null;
  approval_supplier_code: string | null;
  approval_supplier_name: string | null;
  approval_quantity: number | string | null;
  approval_total_amount: string | null;
  approval_daxing_unit_price: string | null;
  approval_estimated_cut_piece_send_date: string | null;
  approval_delivery_date: string | null;
  approval_gender: "男装" | "女装" | null;
  approval_style_name: string | null;
  approval_processes: string[] | null;
  approval_line_prices: readonly (SourcingPricedLineRow & {
    styleNo: string;
    alternateStyleNo: string | null;
    color: string | null;
  })[] | null;
  approval_by: string | null;
  approval_at: Date | string | null;
  contract_return_monitor_enabled: boolean;
  contract_return_catchup: boolean;
  contract_generated_at: Date | string | null;
  contract_return_due_at: Date | string | null;
  contract_returned_at: Date | string | null;
  contract_return_overdue_seconds: number | string | null;
  contract_return_as_of: Date | string;
  time_quality?: ContractReturnFacts["time_quality"];
  time_reason?: string|null;
  total_count?: string;
  total_order_quantity?: string;
}>;

export const toSourcingIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export const canViewSourcingDaxingPrice = (
  actor: Pick<TrustedActorContext, "actorId" | "actorRoles">,
  createdBy: string|null,
): boolean => actor.actorRoles.includes(ROOT_ROLE)
  || (
    actor.actorRoles.includes(CASE_CREATE_ROLE)
    && actor.actorId === createdBy
  )
  || actor.actorRoles.some((role) => role !== CASE_CREATE_ROLE && DAXING_PRICE_ROLES.has(role));

export const mapSourcingCase = (
  row: SourcingCaseRow,
  actor: TrustedActorContext,
): SourcingCaseSummary => {
  const crafts = [...(row.crafts ?? [])];
  const lineItems = row.line_items?.length
    ? row.line_items.map((line) => ({
        ...line,
        quantity: Number(line.quantity),
      }))
    : [{
        position: 1,
        styleNo: row.style_no,
        alternateStyleNo: null,
        color: null,
        quantity: Number(row.order_quantity),
        externalUnitPrice: null,
        legacy: true,
      }];
  return {
  ...(row.original_ie_budget_order_id&&canViewSourcingDaxingPrice(actor,row.effective_created_by===undefined?row.created_by:row.effective_created_by)?
   {originalIeBudgetOrderId:row.original_ie_budget_order_id}:{}),
  sourcingCaseId: row.sourcing_case_id,
  identityRevision: Number(row.identity_revision ?? 0),
  gender: row.gender ?? null,
  styleName: row.style_name_snapshot ?? null,
  erpOrderId: row.erp_order_id,
  erpOrderNo: row.erp_order_no,
  styleNo: row.style_no,
  laneKey: SOURCING_LANE_KEY,
  orderQuantity: Number(row.order_quantity),
  lineItems,
  ...contractReturnState(row, row.contract_return_as_of),
  ...(canViewSourcingDaxingPrice(actor,row.effective_created_by===undefined?row.created_by:row.effective_created_by) && row.daxing_unit_price !== null
    ? { daxingUnitPrice: row.daxing_unit_price }
    : {}),
  estimatedCutPieceSendDate: row.estimated_cut_piece_send_date,
  deliveryDate: row.delivery_date,
  processDescription: row.process_description,
  processes: crafts.length
    ? crafts.map((craft) => craft.craftName)
    : row.process_items?.length
      ? row.process_items
      : row.process_description ? [row.process_description] : [],
  crafts,
  status: row.status as SourcingCaseStatus,
  version: Number(row.version),
  createdBy: row.created_by,
  ...(row.merchandiser_name !== undefined ? { merchandiserName: row.merchandiser_name } : {}),
  ...(row.first_image_attachment_id !== undefined ? { firstImageAttachmentId: row.first_image_attachment_id } : {}),
  createdAt: toSourcingIso(row.created_at),
  updatedAt: toSourcingIso(row.updated_at),
  ieQuote: row.sourcing_ie_quote_id && row.quote_version !== null
    && row.unit_price !== null && row.quote_quantity !== null
    && row.total_amount !== null && row.quote_reason !== null
    && row.quoted_by !== null && row.quoted_at !== null
    ? {
        sourcingIeQuoteId: row.sourcing_ie_quote_id,
        quoteVersion: Number(row.quote_version),
        unitPrice: row.unit_price,
        quantity: Number(row.quote_quantity),
        totalAmount: row.quote_line_prices?.length
          ? calculateSourcingLinesTotalExact(row.quote_line_prices)
          : row.total_amount,
        linePrices: row.quote_line_prices?.length
          ? row.quote_line_prices.map((line) => ({ ...line, quantity: Number(line.quantity) }))
          : [{ position: 1, quantity: Number(row.quote_quantity), unitPrice: row.unit_price, totalAmount: row.total_amount }],
        quoteReason: row.quote_reason,
        quotedBy: row.quoted_by,
        quotedAt: toSourcingIso(row.quoted_at),
        ...(row.adopted_budget_order_id&&row.adopted_budget_version&&row.adopted_quotation_row_id?{adoptedFromBudget:{
          orderId:row.adopted_budget_order_id,budgetVersion:row.adopted_budget_version,quotationRowId:row.adopted_quotation_row_id,
        }}:{}),
      }
    : null,
  decision: row.sourcing_decision_id && row.decision_version !== null
    && row.source_type !== null && row.supplier_id !== null
    && row.supplier_code_snapshot !== null && row.supplier_name_snapshot !== null
    && row.decision_unit_price !== null && row.decision_quantity !== null
    && row.decision_total_amount !== null && row.management_decision_reason !== null
    && row.management_decided_by !== null && row.management_decided_at !== null
    ? {
        sourcingDecisionId: row.sourcing_decision_id,
        decisionVersion: Number(row.decision_version),
        sourceType: row.source_type,
        sourceIeQuoteId: row.source_ie_quote_id,
        supersedesDecisionId: row.supersedes_decision_id,
        supplierId: row.supplier_id,
        supplierCode: row.supplier_code_snapshot,
        supplierName: row.supplier_name_snapshot,
        unitPrice: row.decision_unit_price,
        quantity: Number(row.decision_quantity),
        totalAmount: row.decision_line_prices?.length
          ? calculateSourcingLinesTotalExact(row.decision_line_prices)
          : row.decision_total_amount,
        linePrices: row.decision_line_prices?.length
          ? row.decision_line_prices.map((line) => ({ ...line, quantity: Number(line.quantity) }))
          : [{ position: 1, quantity: Number(row.decision_quantity), unitPrice: row.decision_unit_price, totalAmount: row.decision_total_amount }],
        cuttingProcess: row.cutting_process ?? null,
        cuttingProcessOther: row.cutting_process_other ?? null,
        decisionReason: row.management_decision_reason,
        decidedBy: row.management_decided_by,
        decidedAt: toSourcingIso(row.management_decided_at),
      }
    : null,
  ownerDecision: row.sourcing_owner_decision_id && row.owner_sourcing_decision_id
    && row.owner_decision && row.owner_decision_reason
    && row.owner_decided_by && row.owner_decided_at
    ? {
        sourcingOwnerDecisionId: row.sourcing_owner_decision_id,
        sourcingDecisionId: row.owner_sourcing_decision_id,
        decision: row.owner_decision,
        decisionReason: row.owner_decision_reason,
        decidedBy: row.owner_decided_by,
        decidedAt: toSourcingIso(row.owner_decided_at),
      }
    : null,
  approvalSnapshot: row.sourcing_approval_snapshot_id && row.approval_decision_id
    && row.approval_decision_version !== null && row.approval_supplier_id
    && row.approval_supplier_code && row.approval_supplier_name
    && row.approval_quantity !== null && row.approval_total_amount
    && row.approval_by && row.approval_at && row.approval_line_prices?.length
    ? {
        sourcingApprovalSnapshotId: row.sourcing_approval_snapshot_id,
        sourcingDecisionId: row.approval_decision_id,
        decisionVersion: Number(row.approval_decision_version),
        supplierId: row.approval_supplier_id,
        supplierCode: row.approval_supplier_code,
        supplierName: row.approval_supplier_name,
        quantity: Number(row.approval_quantity),
        totalAmount: row.approval_total_amount,
        ...(canViewSourcingDaxingPrice(actor,row.effective_created_by===undefined?row.created_by:row.effective_created_by) && row.approval_daxing_unit_price
          ? { daxingUnitPrice: row.approval_daxing_unit_price }
          : {}),
        estimatedCutPieceSendDate: row.approval_estimated_cut_piece_send_date,
        deliveryDate: row.approval_delivery_date,
        gender: row.approval_gender ?? null,
        styleName: row.approval_style_name ?? null,
        processes: row.approval_processes ?? [],
        linePrices: row.approval_line_prices.map((line) => ({ ...line, quantity: Number(line.quantity) })),
        approvedBy: row.approval_by,
        approvedAt: toSourcingIso(row.approval_at),
      }
    : null,
  };
};

