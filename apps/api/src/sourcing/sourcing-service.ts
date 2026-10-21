import {workflowStateRejection} from "../platform/business-rejection-guidance.js";
import {effectiveSourcingMerchandiser,lockDigitalSourcingHandover} from "./current-merchandiser.js";
import {SourcingContractReturnService} from "./sourcing-contract-return-service.js";
import { factoryPoLines, factoryProposals, syncFactoryPoNumbers, validateFactoryInputs, approveFactoryPoDates, prepareTransferPoDates, approveTransferPoDates } from "../production-platform/po-factory-date-adapter.js";
import {factorySettlements,reconcileFactory} from "./factory-settlement-service.js";
import {factoryTransferLines,transferProductionFactory} from "./factory-transfer-service.js";
import { syncBulkSourcing } from "../production-platform/bulk-preparation-service.js";
import { memberCanWriteModule } from "../access/member-module-policy.js";
import { validateBudgetSourcing, bindBudgetSourcing } from "../production-platform/budget-sourcing-adapter.js";
import { resolveDigitalChild } from "../production-platform/child-link-repository.js";
import {readQuoteAnalysis} from "./sourcing-analysis.js";
import { createHash, randomUUID } from "node:crypto";

import {
  calculateSourcingLinesTotalExact,
  duplicateSourcingLineMessage,
  sourcingStyleNumbers,
  normalizeSourcingStyleNumber,
  type SourcingStyleIdentity,
  cumulativeSourcingTiming, CorrectSourcingCaseSchema, ReturnSourcingCaseSchema, sourcingDatesValid, SOURCING_DATE_ORDER_ERROR,
  calculateSourcingOrderQuantity,
  calculateSourcingTotalExact,
  SourcingNewUnitPriceSchema,
  MAX_SOURCING_ATTACHMENTS,
  ReviseSourcingStylesSchema,
  SOURCING_IMAGE_SUPPLEMENT_ROLES,
  RequestSourcingFactoryChangeSchema, canChangeSourcingTransferDeliveryDate,
} from "@dx-rework/contracts";
import type {
  CorrectSourcingCase, ReturnSourcingCase,
  CreateSourcingCase,
  CorrectSourcingBudgetPrice,
  ReviseSourcingStyles,
  CreateSourcingIeQuote,
  DeleteSourcingCaseResponse,
  DecideSourcingException,
  DecideSourcingFactoryChange,
  DecideSourcingOwner,
  RecordSourcingContract,
  RecordSourcingFinanceReconciliation,
  RecordSourcingManagementDecision,
  RequestSourcingFactoryChange,
  SourcingCaseListResponse,
  SourcingFactoryListResponse,
  SourcingFactoryChangeStateResponse,
  SourcingCaseStatus,
  SourcingCaseSummary,
  SourcingHistoryNode,
  SourcingNodeHistory,
  SourcingAttachmentListResponse,
  SourcingTimelineResponse,
  SupplementSourcingImages,
} from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { ensureCuttingOrdersForApproval } from "../cutting/cutting-source-service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TodoProjectionService } from "../todos/projection-service.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { SourcingContractService } from "./sourcing-contract-service.js";
import { contractReturnState, type ContractReturnFilter } from "./contract-return-state.js";

const CASE_CREATE_CAPABILITY = "sourcing:inquiry:create";
const IE_QUOTE_CAPABILITY = "sourcing:price:quote";
const MANAGEMENT_DECISION_CAPABILITY = "sourcing:decision:record";
const OWNER_DECISION_CAPABILITY = "sourcing:owner:approve";
const CONTRACT_CAPABILITY = "sourcing:contract:record";
const FACTORY_CHANGE_REQUEST_CAPABILITY = "sourcing:factory_change:request";
const FACTORY_CHANGE_VERIFY_CAPABILITY = "sourcing:factory_change:verify";
const FINANCE_RECONCILE_CAPABILITY = "sourcing:finance:reconcile";
const EXCEPTION_VERIFY_CAPABILITY = "sourcing:exception:verify";
const CASE_DELETE_CAPABILITY = "sourcing:delete";
const READ_CAPABILITY = "sourcing:view";
const ROOT_ROLE = "root_superuser";
const IMAGE_SUPPLEMENT_CAPABILITY = "tools:user";
const CASE_CREATE_ROLE = "order_merchandiser";
const IE_QUOTE_ROLE = "ie_reviewer";
const MANAGEMENT_DECISION_ROLE = "production_management";
const OWNER_DECISION_ROLE = "owner_group";
const CONTRACT_ROLE = "order_merchandiser";
const FACTORY_CHANGE_REQUEST_ROLE = "order_merchandiser";
const FACTORY_CHANGE_VERIFY_ROLE = "production_management";
const FACTORY_CHANGE_OWNER_ROLE = "owner_group";
const FINANCE_RECONCILE_ROLE = "factory_payables";
const EXCEPTION_VERIFY_ROLE = "production_management";
const DAXING_PRICE_ROLES = new Set([
  CASE_CREATE_ROLE,
  IE_QUOTE_ROLE,
  MANAGEMENT_DECISION_ROLE,
  OWNER_DECISION_ROLE,
  FINANCE_RECONCILE_ROLE,
]);
const LANE_KEY = "garment_processing" as const;
const DEFAULT_CREATION_REASON = "创建外发定价选厂询价";
const DEFAULT_QUOTE_REASON = "IE核定加工价格";
const DEFAULT_MANAGEMENT_REASON = "供应链总监确认加工厂与价格";
const DEFAULT_OWNER_APPROVAL_REASON = "老板批准选厂决定";
const DEFAULT_OWNER_REJECTION_REASON = "老板驳回选厂决定";
const DEFAULT_CONTRACT_REASON = "跟单登记已签合同";
const DEFAULT_DELETION_REASON = "Root confirmed logical deletion";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNIT_PRICE_PATTERN = /^\d{1,10}(?:\.\d{1,4})?$/;
const TOTAL_AMOUNT_PATTERN = /^\d{1,16}(?:\.\d{1,2})?$/;
const SOURCING_LIST_PAGE_SIZE = 15;

type Result<T> = Readonly<{ value: T; reused: boolean }>;
type SqlError = Readonly<{ code?: string; constraint?: string }>;

type SourcingPricedLineRow = Readonly<{
  position: number;
  quantity: number;
  unitPrice: string;
  totalAmount: string;
}>;

type SourcingCaseRow = Readonly<{
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
  sourcing_decision_id: string | null;
  decision_version: number | string | null;
  source_type: "initial" | "management_revision" | "factory_change" | null;
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
  total_count?: string;
  total_order_quantity?: string;
}>;

const fail = (message: string, status = 400, code = "VALIDATION_ERROR"): never => {
  throw new ApplicationError(code, message, status);
};

const normalizeText = (value: string, label: string, max: number): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    fail(`${label}不能为空且不能超过${max}个字符`);
  }
  return normalized;
};

const normalizeQuantity = (value: number): number => {
  if (!Number.isInteger(value) || value < 1 || value > 10_000_000) {
    fail("订单数量必须是1至10000000之间的整数");
  }
  return value;
};

const scaledUnitPrice = (value: string): bigint => {
  const normalized = value.trim();
  if (!UNIT_PRICE_PATTERN.test(normalized)) {
    fail("加工单价必须是大于0且最多4位小数的数字");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const scaled = BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, "0"));
  if (scaled <= 0n) fail("加工单价必须大于0");
  return scaled;
};

export const normalizeSourcingUnitPrice = (value: string): string => {
  const scaled = scaledUnitPrice(value);
  const whole = scaled / 10_000n;
  const fraction = (scaled % 10_000n).toString().padStart(4, "0");
  return `${whole}.${fraction}`;
};

export const normalizeSourcingTotalAmount = (value: string): string => {
  const normalized = value.trim();
  if (!TOTAL_AMOUNT_PATTERN.test(normalized)) fail("实际总额必须是大于0且最多2位小数的数字");
  const [whole, fraction = ""] = normalized.split(".");
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents <= 0n || cents > 999_999_999_999_999_999n) {
    fail("实际总额超出系统允许范围");
  }
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
};

export const calculateSourcingTotal = (unitPrice: string, quantity: number): string => {
  const normalizedQuantity = normalizeQuantity(quantity);
  scaledUnitPrice(unitPrice);
  try {
    return calculateSourcingTotalExact(unitPrice, normalizedQuantity);
  } catch {
    return fail("报价总额超出系统允许范围");
  }
};

const requestHash = (scope: string, payload: unknown): string =>
  createHash("sha256").update(JSON.stringify({ scope, payload })).digest("hex");

const toIso = (value: Date | string): string =>
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

const mapCase = (
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
  sourcingCaseId: row.sourcing_case_id,
  identityRevision: Number(row.identity_revision ?? 0),
  gender: row.gender ?? null,
  styleName: row.style_name_snapshot ?? null,
  erpOrderId: row.erp_order_id,
  erpOrderNo: row.erp_order_no,
  styleNo: row.style_no,
  laneKey: LANE_KEY,
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
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
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
        quotedAt: toIso(row.quoted_at),
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
        decidedAt: toIso(row.management_decided_at),
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
        decidedAt: toIso(row.owner_decided_at),
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
        approvedAt: toIso(row.approval_at),
      }
    : null,
  };
};

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null ? (error as SqlError).code : undefined;

export class SourcingService {
  constructor(
    private readonly database: Pool,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
    private readonly todoProjection?: Pick<
      TodoProjectionService,
      "actionableForAllAssignedRole" | "cancelOpenByDedupePrefix"
        | "completeOpenByDedupePrefix" | "information"
    > & Partial<Pick<TodoProjectionService,"actionableForNamedRecipient">>,
    private readonly contractService?: SourcingContractService,
  ) {}

  private assertActor(
    actor: TrustedActorContext,
    capability: string,
    role: string,
  ): void {
    if (
      actor.authorizationCapability !== capability
      || (
        !actor.actorRoles.includes(ROOT_ROLE)
        && !actor.actorRoles.includes(role)
      )
    ) {
      fail("当前岗位无权执行该报价选厂操作", 403, "FORBIDDEN");
    }
  }

  private assertImageSupplementActor(actor: TrustedActorContext): void {
    if (
      actor.authorizationCapability !== IMAGE_SUPPLEMENT_CAPABILITY
      || (
        !actor.actorRoles.includes(ROOT_ROLE)
        && !actor.actorRoles.some((role) => SOURCING_IMAGE_SUPPLEMENT_ROLES.includes(
          role as (typeof SOURCING_IMAGE_SUPPLEMENT_ROLES)[number],
        ))
      )
    ) {
      fail("当前角色无权补充报价选厂订单图片", 403, "FORBIDDEN");
    }
  }

  private assertReader(actor: TrustedActorContext): void {
    if (
      actor.authorizationCapability !== READ_CAPABILITY
      || (
        !actor.actorRoles.includes(ROOT_ROLE)
        && !(actor.authorizationCapabilities ?? []).includes(READ_CAPABILITY)
      )
    ) {
      fail("无权查看报价选厂数据", 403, "FORBIDDEN");
    }
  }

  private async readCase(
    client: Pick<PoolClient, "query">,
    sourcingCaseId: string,
    actor: TrustedActorContext,
    history?: { at: string; node: SourcingHistoryNode; entryId: string },
  ): Promise<SourcingCaseSummary> {
    const result = await client.query<SourcingCaseRow>(
      `SELECT
         case_view.sourcing_case_id,case_view.erp_order_id,case_view.erp_order_no,
         COALESCE(to_jsonb(source_case)->>'workflow_generation','legacy') AS workflow_generation,
         case_view.style_no,case_view.lane_key,source_case.order_quantity,
         (SELECT COALESCE(max(revision),0) FROM sourcing_style_revisions WHERE sourcing_case_id=case_view.sourcing_case_id) AS identity_revision,
         source_case.gender,source_case.style_name_snapshot,
         COALESCE((
            SELECT correction.new_unit_price FROM sourcing_budget_price_corrections correction
            WHERE correction.sourcing_case_id=source_case.sourcing_case_id
              ${history ? "AND correction.corrected_at <= $2::timestamptz" : ""}
            ORDER BY correction.correction_version DESC LIMIT 1
          ),source_case.daxing_unit_price)::text AS daxing_unit_price,
         to_char(source_case.estimated_cut_piece_send_date,'YYYY-MM-DD')
           AS estimated_cut_piece_send_date,
         lines_row.line_items,
         to_char(sourcing_effective_delivery_date(case_view.sourcing_case_id,source_case.delivery_date${history ? ', $2::timestamptz' : ''}),'YYYY-MM-DD') AS delivery_date,
         case_view.process_description,case_view.process_items,
         COALESCE(decision_row.crafts,crafts_row.crafts) AS crafts,
         case_view.status,case_view.version,case_view.created_by,
         concat_ws('/',creator_user.display_name,additional_user.display_name) AS merchandiser_name,
         case_view.created_at,case_view.updated_at,
         COALESCE(monitor_case.contract_return_monitor_enabled,false) AS contract_return_monitor_enabled,
          COALESCE(monitor_case.contract_return_catchup,false) AS contract_return_catchup,monitor_case.contract_generated_at,
         monitor_case.contract_return_due_at,monitor_case.contract_returned_at,
         sourcing_contract_return_elapsed_seconds(
           monitor_case.contract_return_due_at,COALESCE(monitor_case.contract_returned_at,CURRENT_TIMESTAMP)
         ) AS contract_return_overdue_seconds,
         CURRENT_TIMESTAMP AS contract_return_as_of,
         quote_row.sourcing_ie_quote_id,quote_row.quote_version,
         quote_row.unit_price,quote_row.quantity AS quote_quantity,
         quote_row.total_amount,quote_row.quote_reason,
         quote_lines_row.line_prices AS quote_line_prices,
         quote_row.quoted_by,quote_row.quoted_at,
         decision_row.sourcing_decision_id,decision_row.decision_version,
         decision_row.source_type,decision_row.source_ie_quote_id,
         decision_row.supersedes_decision_id,decision_row.supplier_id,
         decision_row.supplier_code_snapshot,decision_row.supplier_name_snapshot,
         decision_row.unit_price AS decision_unit_price,
         decision_row.quantity AS decision_quantity,
         decision_row.total_amount AS decision_total_amount,
         decision_lines_row.line_prices AS decision_line_prices,
         decision_row.cutting_process,decision_row.cutting_process_other,
         decision_row.decision_reason AS management_decision_reason,
         decision_row.decided_by AS management_decided_by,
         decision_row.decided_at AS management_decided_at,
         owner_row.sourcing_owner_decision_id,
         owner_row.sourcing_decision_id AS owner_sourcing_decision_id,
         owner_row.decision AS owner_decision,
         owner_row.decision_reason AS owner_decision_reason,
         owner_row.decided_by AS owner_decided_by,
         owner_row.decided_at AS owner_decided_at,
         snapshot.sourcing_approval_snapshot_id,
         snapshot.sourcing_decision_id AS approval_decision_id,
         snapshot.decision_version AS approval_decision_version,
         snapshot.supplier_id AS approval_supplier_id,
         snapshot.supplier_code_snapshot AS approval_supplier_code,
         snapshot.supplier_name_snapshot AS approval_supplier_name,
         snapshot.quantity AS approval_quantity,
         snapshot.total_amount AS approval_total_amount,
         snapshot.daxing_unit_price::text AS approval_daxing_unit_price,
         to_char(snapshot.estimated_cut_piece_send_date,'YYYY-MM-DD') AS approval_estimated_cut_piece_send_date,
         to_char(snapshot.delivery_date,'YYYY-MM-DD') AS approval_delivery_date,
         snapshot.gender AS approval_gender,snapshot.style_name_snapshot AS approval_style_name,
         snapshot.processes AS approval_processes,
         snapshot_lines.line_prices AS approval_line_prices,
         snapshot.approved_by AS approval_by,snapshot.approved_at AS approval_at
       FROM current_sourcing_cases case_view
       JOIN LATERAL sourcing_case_facts_at(case_view.sourcing_case_id${history ? ', $2::timestamptz' : ''}) source_case ON true
       JOIN app_users creator_user ON creator_user.id=case_view.created_by
       JOIN sourcing_cases additional_case ON additional_case.sourcing_case_id=case_view.sourcing_case_id
       LEFT JOIN app_users additional_user ON additional_user.id=nullif(to_jsonb(additional_case)->>'additional_merchandiser_user_id','')::uuid
       LEFT JOIN sourcing_contract_return_monitors monitor_case ON monitor_case.sourcing_case_id=case_view.sourcing_case_id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
           jsonb_build_object(
             'position',line.position,
             'styleNo',${history ? 'line.historical_style_no' : 'line.style_no'},'formalStyleNo',line.formal_style_no,'imageAttachmentId',line.image_attachment_id,
             'alternateStyleNo',${history ? 'line.historical_alternate' : 'line.alternate_style_no'},
             'color',line.color,
             'quantity',line.quantity,
             'externalUnitPrice',line.external_unit_price::text,
             'legacy',line.legacy_source
           )
           ORDER BY line.position
         ) AS line_items
         FROM ${history ? `(SELECT original.*,
           COALESCE(identity.style_no,identity.alternate_style_no) AS historical_style_no,
           identity.style_no AS formal_style_no, identity.alternate_style_no AS historical_alternate
           FROM sourcing_case_lines_at(case_view.sourcing_case_id, $2::timestamptz) original
           LEFT JOIN LATERAL (SELECT revision,lines FROM sourcing_style_revisions
             WHERE sourcing_case_id=original.sourcing_case_id AND created_at <= $2::timestamptz
             ORDER BY revision DESC LIMIT 1) revision ON true
           LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(revision.lines)
             WHERE (value->>'position')::integer=original.position) revised ON true
           CROSS JOIN LATERAL (SELECT
             CASE WHEN revision.revision IS NULL THEN original.style_no ELSE revised.value->>'styleNo' END AS style_no,
             CASE WHEN revision.revision IS NULL THEN original.alternate_style_no ELSE revised.value->>'alternateStyleNo' END AS alternate_style_no
           ) identity) line` : "current_sourcing_case_lines line"}
         WHERE line.sourcing_case_id=case_view.sourcing_case_id
       ) lines_row ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
           jsonb_build_object(
             'position',binding.position,
             'craftId',binding.craft_id,
             'craftCode',binding.craft_code_snapshot,
             'craftVersion',binding.craft_version,
             'craftName',binding.craft_name_snapshot
           )
           ORDER BY binding.position
         ) AS crafts
         FROM sourcing_case_crafts binding
         WHERE binding.sourcing_case_id=case_view.sourcing_case_id
       ) crafts_row ON true
       LEFT JOIN LATERAL (
         SELECT quote.*
         FROM sourcing_ie_quotes quote
         WHERE quote.sourcing_case_id=case_view.sourcing_case_id
           ${history ? "AND quote.quoted_at <= $2::timestamptz AND $3::text <> 'created' AND ($3::text <> 'ie_quote' OR quote.sourcing_ie_quote_id=$4::uuid)" : "AND quote.quoted_at > COALESCE((SELECT max(transitioned_at) FROM sourcing_case_transitions WHERE sourcing_case_id=case_view.sourcing_case_id AND business_action='returned_to_merchandiser'), '-infinity'::timestamptz)"}
         ORDER BY quote.quote_version DESC
         LIMIT 1
       ) quote_row ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'position',line.position,'quantity',line.quantity,
           'unitPrice',line.unit_price::text,'totalAmount',line.total_amount::text
         ) ORDER BY line.position) AS line_prices
         FROM sourcing_ie_quote_lines line
         WHERE line.sourcing_ie_quote_id=quote_row.sourcing_ie_quote_id
       ) quote_lines_row ON true
       LEFT JOIN LATERAL (
         SELECT decision_fact.*
         FROM sourcing_decisions decision_fact
         WHERE decision_fact.sourcing_case_id=case_view.sourcing_case_id
           ${history ? "AND decision_fact.decided_at <= $2::timestamptz AND $3::text NOT IN ('created','ie_quote') AND ($3::text <> 'management' OR decision_fact.sourcing_decision_id=$4::uuid) AND ($3::text <> 'owner' OR decision_fact.sourcing_decision_id=(SELECT sourcing_decision_id FROM sourcing_owner_decisions WHERE sourcing_owner_decision_id=$4::uuid)) AND ($3::text <> 'finance' OR decision_fact.sourcing_decision_id=(SELECT sourcing_decision_id FROM sourcing_finance_reconciliations WHERE sourcing_reconciliation_id=$4::uuid))" : "AND decision_fact.decided_at > COALESCE((SELECT max(transitioned_at) FROM sourcing_case_transitions WHERE sourcing_case_id=case_view.sourcing_case_id AND business_action='returned_to_merchandiser'), '-infinity'::timestamptz)"}
         ORDER BY decision_fact.decision_version DESC
         LIMIT 1
       ) decision_row ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'position',line.position,'quantity',line.quantity,
           'unitPrice',line.unit_price::text,'totalAmount',line.total_amount::text
         ) ORDER BY line.position) AS line_prices
         FROM sourcing_decision_lines line
         WHERE line.sourcing_decision_id=decision_row.sourcing_decision_id
       ) decision_lines_row ON true
       LEFT JOIN sourcing_owner_decisions owner_row
         ON owner_row.sourcing_decision_id=decision_row.sourcing_decision_id
         ${history ? "AND owner_row.decided_at <= $2::timestamptz AND $3::text IN ('owner','finance') AND ($3::text <> 'owner' OR owner_row.sourcing_owner_decision_id=$4::uuid)" : ""}
       LEFT JOIN LATERAL (
         SELECT approval.*
         FROM sourcing_approval_snapshots approval
         WHERE approval.sourcing_case_id=case_view.sourcing_case_id
           ${history ? "AND approval.approved_at <= $2::timestamptz AND $3::text IN ('owner','finance') AND ($3::text<>'finance' OR approval.sourcing_decision_id=decision_row.sourcing_decision_id)" : ""}
         ORDER BY approval.decision_version DESC LIMIT 1
       ) snapshot ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'position',line.position,'styleNo',line.style_no,
           'alternateStyleNo',line.alternate_style_no,'color',line.color,
           'quantity',line.quantity,'unitPrice',line.unit_price::text,
           'totalAmount',line.total_amount::text
         ) ORDER BY line.position) AS line_prices
         FROM sourcing_approval_snapshot_lines line
         WHERE line.sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id
       ) snapshot_lines ON true
       WHERE case_view.sourcing_case_id=$1`,
      history ? [sourcingCaseId, history.at, history.node, history.entryId] : [sourcingCaseId],
    );
    let row = result.rows[0];
    if (!row) return fail("报价选厂询价不存在", 404, "NOT_FOUND");
    if (row.workflow_generation === "digital_production_v1") await resolveDigitalChild(client, "sourcing", sourcingCaseId, row.workflow_generation);
    row={...row,effective_created_by:await effectiveSourcingMerchandiser(client,sourcingCaseId,row.created_by,row.workflow_generation)};
    if(!history&&row.workflow_generation==="digital_production_v1")row={...row,merchandiser_name:(await client.query(`SELECT concat_ws('/',current_person.display_name,additional.display_name) AS name FROM sourcing_cases source
      LEFT JOIN app_users current_person ON current_person.id=$2
      LEFT JOIN app_users additional ON additional.id=nullif(to_jsonb(source)->>'additional_merchandiser_user_id','')::uuid
      WHERE source.sourcing_case_id=$1`,[sourcingCaseId,row.effective_created_by])).rows[0]?.name??null};
    const item = mapCase(history ? { ...row,contract_return_monitor_enabled:false } : row, actor);
    if (row.workflow_generation === "digital_production_v1") {
      const lines = (await factoryPoLines(client,sourcingCaseId,history?.at ?? null))!;
      const proposals = await factoryProposals(client,sourcingCaseId,history?.at ?? null);
      item.lineItems = item.lineItems.map(line => { const po=lines.find(po=>po.position===line.position); return po ? {...line,lineId:po.line_id,...(history?{}:{customerWarehouseArrivalDate:po.customer}),factoryDeliveryDate:po.factory,proposedFactoryDeliveryDate:proposals[line.position-1]?.factoryDeliveryDate ?? null}:line; });
      if(item.approvalSnapshot) {
        const frozen = (await factoryPoLines(client,sourcingCaseId,null,item.approvalSnapshot.sourcingApprovalSnapshotId))!;
        item.approvalSnapshot.linePrices=item.approvalSnapshot.linePrices.map(line=>{const po=frozen.find(po=>po.position===line.position);return po?{...line,lineId:po.line_id,factoryDeliveryDate:po.factory}:line;});
      }
    }
    if (history) {
      item.styleNo = item.lineItems[0]?.styleNo ?? item.styleNo;
      // Current lifecycle/version are not a historical state; never present them as such.
      item.updatedAt = toIso(history.at);
      const transition = await client.query<{ status: SourcingCaseStatus; version: number }>(
        `SELECT to_status AS status,sequence AS version FROM sourcing_case_transitions
         WHERE sourcing_case_id=$1 AND transitioned_at <= $2::timestamptz ORDER BY sequence DESC LIMIT 1`,
        [sourcingCaseId, history.at]);
      if (transition.rows[0]) { item.status = transition.rows[0].status; item.version = Number(transition.rows[0].version); }
      delete item.identityRevision;
    }
    const latestReturn = history ? null : (await client.query<{reason:string}>(
      "SELECT transition_reason AS reason FROM sourcing_case_transitions WHERE sourcing_case_id=$1 AND business_action='returned_to_merchandiser' ORDER BY sequence DESC LIMIT 1",[sourcingCaseId])).rows[0];
    const visits = await client.query<{to:string;changesNode:boolean;enteredAt:string;leftAt:string|null;asOf:string}>(
      `SELECT to_status AS to,true AS "changesNode",transitioned_at::text AS "enteredAt",
        lead(transitioned_at) OVER(ORDER BY sequence)::text AS "leftAt",CURRENT_TIMESTAMP::text AS "asOf"
       FROM sourcing_case_transitions WHERE sourcing_case_id=$1 AND from_status IS DISTINCT FROM to_status
         AND ($2::timestamptz IS NULL OR transitioned_at<=$2::timestamptz)
       ORDER BY sequence`,[sourcingCaseId,history?.at ?? null]);
    const timing=cumulativeSourcingTiming(visits.rows,item.createdAt,history?.at ?? visits.rows[0]?.asOf ?? item.createdAt);
    return {...item, correctionReason: latestReturn?.reason ?? null,timing};
  }

  async analysis(actor: TrustedActorContext, input: unknown) {
    this.assertReader(actor);
    return readQuoteAnalysis(this.database,input);
  }

  async listCases(
    actor: TrustedActorContext,
    query = "",
    statusFilter: "all" | "pending" | "closed" = "all",
    page = 1,
    filters: Readonly<{
      stage?: "all"|"ie"|"management"|"owner"|"finance"|"factory_change"|"exception";
      gender?: "all"|"男装"|"女装"|"missing";
      styleName?: string;
      contractReturn?: ContractReturnFilter;
    }> = {},
  ): Promise<SourcingCaseListResponse> {
    this.assertReader(actor);
    const normalizedQuery = query.trim();
    const stage = filters.stage ?? "all";
    const gender = filters.gender ?? "all";
    const normalizedStyleName = filters.styleName?.trim() ?? "";
    const contractReturn = filters.contractReturn ?? null;
    if (normalizedQuery.length > 100) fail("搜索内容不能超过100个字符");
    if (!["all", "pending", "closed"].includes(statusFilter)) fail("订单状态筛选无效");
    if (!["all","ie","management","owner","finance","factory_change","exception"].includes(stage)) fail("流程状态筛选无效");
    if (!["all","男装","女装","missing"].includes(gender)) fail("性别筛选无效");
    if (normalizedStyleName.length > 100) fail("款式类别不能超过100个字符");
    if (contractReturn !== null && !["all","pending","returned_on_time","overdue_pending","returned_late","all_overdue"].includes(contractReturn)) fail("合同回签状态筛选无效");
    if (!Number.isInteger(page) || page < 1 || page > 100_000) fail("分页页码无效");
    const offset = (page - 1) * SOURCING_LIST_PAGE_SIZE;
    const principalAvailable=Boolean((await this.database.query("SELECT to_regclass('digital_production_child_links') AS relation")).rows[0]?.relation);
    const principalJoins=principalAvailable?`LEFT JOIN digital_production_child_links principal_link ON principal_link.module='sourcing' AND principal_link.child_id=case_view.sourcing_case_id
      LEFT JOIN digital_production_orders principal_order ON principal_order.production_order_id=principal_link.production_order_id
      LEFT JOIN app_users principal_user ON principal_user.id=principal_order.primary_merchandiser_id`:"";
    const result = await this.database.query<SourcingCaseRow>(
      `WITH filtered_cases AS MATERIALIZED (
       SELECT
         COALESCE(to_jsonb(additional_case)->>'workflow_generation','legacy') AS workflow_generation,
         case_view.sourcing_case_id,case_view.erp_order_id,case_view.erp_order_no,
         case_view.style_no,case_view.lane_key,case_view.order_quantity,
         (SELECT COALESCE(max(revision),0) FROM sourcing_style_revisions WHERE sourcing_case_id=case_view.sourcing_case_id) AS identity_revision,
         source_case.gender,source_case.style_name_snapshot,
         ${principalAvailable?"CASE WHEN to_jsonb(additional_case)->>'workflow_generation'='digital_production_v1' THEN principal_order.primary_merchandiser_id ELSE case_view.created_by END AS effective_created_by,":""}
         ${principalAvailable?"CASE WHEN to_jsonb(additional_case)->>'workflow_generation'='digital_production_v1' THEN concat_ws('/',principal_user.display_name,additional_user.display_name) ELSE concat_ws('/',creator_user.display_name,additional_user.display_name) END":"concat_ws('/',creator_user.display_name,additional_user.display_name)"} AS merchandiser_name,
         first_image.attachment_id AS first_image_attachment_id,
         COALESCE((
            SELECT correction.new_unit_price FROM sourcing_budget_price_corrections correction
            WHERE correction.sourcing_case_id=source_case.sourcing_case_id
            ORDER BY correction.correction_version DESC LIMIT 1
          ),source_case.daxing_unit_price)::text AS daxing_unit_price,
         to_char(source_case.estimated_cut_piece_send_date,'YYYY-MM-DD')
           AS estimated_cut_piece_send_date,
         lines_row.line_items,
         to_char(sourcing_effective_delivery_date(case_view.sourcing_case_id,case_view.delivery_date),'YYYY-MM-DD') AS delivery_date,
         case_view.process_description,case_view.process_items,
         COALESCE(decision_row.crafts,crafts_row.crafts) AS crafts,
         case_view.status,case_view.version,case_view.created_by,
         case_view.created_at,case_view.updated_at,
         COALESCE(monitor_case.contract_return_monitor_enabled,false) AS contract_return_monitor_enabled,
          COALESCE(monitor_case.contract_return_catchup,false) AS contract_return_catchup,monitor_case.contract_generated_at,
         monitor_case.contract_return_due_at,monitor_case.contract_returned_at,
         sourcing_contract_return_elapsed_seconds(
           monitor_case.contract_return_due_at,COALESCE(monitor_case.contract_returned_at,CURRENT_TIMESTAMP)
         ) AS contract_return_overdue_seconds,
         CURRENT_TIMESTAMP AS contract_return_as_of,
         quote_row.sourcing_ie_quote_id,quote_row.quote_version,
         quote_row.unit_price,quote_row.quantity AS quote_quantity,
         quote_row.total_amount,quote_row.quote_reason,
         quote_lines_row.line_prices AS quote_line_prices,
         quote_row.quoted_by,quote_row.quoted_at,
         decision_row.sourcing_decision_id,decision_row.decision_version,
         decision_row.source_type,decision_row.source_ie_quote_id,
         decision_row.supersedes_decision_id,decision_row.supplier_id,
         decision_row.supplier_code_snapshot,decision_row.supplier_name_snapshot,
         decision_row.unit_price AS decision_unit_price,
         decision_row.quantity AS decision_quantity,
         decision_row.total_amount AS decision_total_amount,
         decision_lines_row.line_prices AS decision_line_prices,
         decision_row.cutting_process,decision_row.cutting_process_other,
         decision_row.decision_reason AS management_decision_reason,
         decision_row.decided_by AS management_decided_by,
         decision_row.decided_at AS management_decided_at,
         owner_row.sourcing_owner_decision_id,
         owner_row.sourcing_decision_id AS owner_sourcing_decision_id,
         owner_row.decision AS owner_decision,
         owner_row.decision_reason AS owner_decision_reason,
         owner_row.decided_by AS owner_decided_by,
         owner_row.decided_at AS owner_decided_at,
         snapshot.sourcing_approval_snapshot_id,
         snapshot.sourcing_decision_id AS approval_decision_id,
         snapshot.decision_version AS approval_decision_version,
         snapshot.supplier_id AS approval_supplier_id,
         snapshot.supplier_code_snapshot AS approval_supplier_code,
         snapshot.supplier_name_snapshot AS approval_supplier_name,
         snapshot.quantity AS approval_quantity,
         snapshot.total_amount AS approval_total_amount,
         snapshot.daxing_unit_price::text AS approval_daxing_unit_price,
         to_char(snapshot.estimated_cut_piece_send_date,'YYYY-MM-DD') AS approval_estimated_cut_piece_send_date,
         to_char(snapshot.delivery_date,'YYYY-MM-DD') AS approval_delivery_date,
         snapshot.gender AS approval_gender,snapshot.style_name_snapshot AS approval_style_name,
         snapshot.processes AS approval_processes,
         snapshot_lines.line_prices AS approval_line_prices,
         snapshot.approved_by AS approval_by,snapshot.approved_at AS approval_at
       FROM current_sourcing_cases case_view
       JOIN LATERAL sourcing_case_facts_at(case_view.sourcing_case_id) source_case ON true
       LEFT JOIN sourcing_contract_return_monitors monitor_case ON monitor_case.sourcing_case_id=case_view.sourcing_case_id
       JOIN app_users creator_user ON creator_user.id=case_view.created_by
       JOIN sourcing_cases additional_case ON additional_case.sourcing_case_id=case_view.sourcing_case_id
       LEFT JOIN app_users additional_user ON additional_user.id=nullif(to_jsonb(additional_case)->>'additional_merchandiser_user_id','')::uuid
       ${principalJoins}
       LEFT JOIN LATERAL (
         SELECT after_state->'attachmentIds' AS ids FROM operation_events
         WHERE entity_type='sourcing_case' AND entity_id=case_view.sourcing_case_id::text
           AND action IN ('sourcing.case.correct','sourcing.attachments.supplement','sourcing.case.create')
           AND jsonb_typeof(after_state->'attachmentIds')='array'
         ORDER BY created_at DESC, CASE WHEN action='sourcing.case.correct' THEN 0 ELSE 1 END, event_id DESC LIMIT 1
       ) current_images ON true
       LEFT JOIN LATERAL (
         SELECT image.attachment_id FROM attachments image
         WHERE image.entity_type='sourcing_case' AND image.entity_id=case_view.sourcing_case_id::text
           AND image.status='ready' AND image.mime_type IN ('image/jpeg','image/png','image/webp')
           AND (current_images.ids IS NULL OR current_images.ids ? image.attachment_id::text)
         ORDER BY image.created_at,image.attachment_id LIMIT 1
       ) first_image ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
           jsonb_build_object(
             'position',line.position,
             'styleNo',line.style_no,'formalStyleNo',line.formal_style_no,'imageAttachmentId',line.image_attachment_id,
             'alternateStyleNo',line.alternate_style_no,
             'color',line.color,
             'quantity',line.quantity,
             'externalUnitPrice',line.external_unit_price::text,
             'legacy',line.legacy_source
           )
           ORDER BY line.position
         ) AS line_items
         FROM current_sourcing_case_lines line
         WHERE line.sourcing_case_id=case_view.sourcing_case_id
       ) lines_row ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
           jsonb_build_object(
             'position',binding.position,
             'craftId',binding.craft_id,
             'craftCode',binding.craft_code_snapshot,
             'craftVersion',binding.craft_version,
             'craftName',binding.craft_name_snapshot
           )
           ORDER BY binding.position
         ) AS crafts
         FROM sourcing_case_crafts binding
         WHERE binding.sourcing_case_id=case_view.sourcing_case_id
       ) crafts_row ON true
       LEFT JOIN LATERAL (
         SELECT quote.*
         FROM sourcing_ie_quotes quote
         WHERE quote.sourcing_case_id=case_view.sourcing_case_id
         AND quote.quoted_at > COALESCE((SELECT max(transitioned_at) FROM sourcing_case_transitions WHERE sourcing_case_id=case_view.sourcing_case_id AND business_action='returned_to_merchandiser'), '-infinity'::timestamptz)
         ORDER BY quote.quote_version DESC
         LIMIT 1
       ) quote_row ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'position',line.position,'quantity',line.quantity,
           'unitPrice',line.unit_price::text,'totalAmount',line.total_amount::text
         ) ORDER BY line.position) AS line_prices
         FROM sourcing_ie_quote_lines line
         WHERE line.sourcing_ie_quote_id=quote_row.sourcing_ie_quote_id
       ) quote_lines_row ON true
       LEFT JOIN LATERAL (
         SELECT decision_fact.*
         FROM sourcing_decisions decision_fact
         WHERE decision_fact.sourcing_case_id=case_view.sourcing_case_id
         AND decision_fact.decided_at > COALESCE((SELECT max(transitioned_at) FROM sourcing_case_transitions WHERE sourcing_case_id=case_view.sourcing_case_id AND business_action='returned_to_merchandiser'), '-infinity'::timestamptz)
         ORDER BY decision_fact.decision_version DESC
         LIMIT 1
       ) decision_row ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'position',line.position,'quantity',line.quantity,
           'unitPrice',line.unit_price::text,'totalAmount',line.total_amount::text
         ) ORDER BY line.position) AS line_prices
         FROM sourcing_decision_lines line
         WHERE line.sourcing_decision_id=decision_row.sourcing_decision_id
       ) decision_lines_row ON true
       LEFT JOIN sourcing_owner_decisions owner_row
         ON owner_row.sourcing_decision_id=decision_row.sourcing_decision_id
       LEFT JOIN LATERAL (
         SELECT approval.*
         FROM sourcing_approval_snapshots approval
         WHERE approval.sourcing_case_id=case_view.sourcing_case_id
         ORDER BY approval.decision_version DESC LIMIT 1
       ) snapshot ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'position',line.position,'styleNo',line.style_no,
           'alternateStyleNo',line.alternate_style_no,'color',line.color,
           'quantity',line.quantity,'unitPrice',line.unit_price::text,
           'totalAmount',line.total_amount::text
         ) ORDER BY line.position) AS line_prices
         FROM sourcing_approval_snapshot_lines line
         WHERE line.sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id
       ) snapshot_lines ON true
       WHERE ($1='' OR case_view.erp_order_no ILIKE '%'||$1||'%'
          OR case_view.style_no ILIKE '%'||$1||'%'
          OR EXISTS(SELECT 1 FROM sourcing_style_aliases alias WHERE alias.sourcing_case_id=case_view.sourcing_case_id AND alias.style_no ILIKE '%'||$1||'%')
          OR EXISTS (
            SELECT 1
            FROM sourcing_case_lines search_line
            WHERE search_line.sourcing_case_id=case_view.sourcing_case_id
              AND (
                search_line.style_no ILIKE '%'||$1||'%'
                OR search_line.alternate_style_no ILIKE '%'||$1||'%'
                OR search_line.color ILIKE '%'||$1||'%'
              )
          )
          OR creator_user.display_name ILIKE '%'||$1||'%'
          ${principalAvailable?"OR principal_user.display_name ILIKE '%'||$1||'%'":""}
          OR additional_user.display_name ILIKE '%'||$1||'%'
          OR decision_row.supplier_name_snapshot ILIKE '%'||$1||'%'
          OR decision_row.supplier_code_snapshot ILIKE '%'||$1||'%'
          OR case_view.process_description ILIKE '%'||$1||'%'
          OR source_case.gender ILIKE '%'||$1||'%'
          OR source_case.style_name_snapshot ILIKE '%'||$1||'%'
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(decision_row.crafts) craft
            WHERE craft->>'craftName' ILIKE '%'||$1||'%'
          )
          OR EXISTS (
            SELECT 1
            FROM sourcing_contract_executions contract_row
            WHERE contract_row.sourcing_case_id=case_view.sourcing_case_id
              AND contract_row.contract_reference ILIKE '%'||$1||'%'
          ))
         AND ($2::text='all' OR ($2::text='closed' AND case_view.status='closed')
           OR ($2::text='pending' AND case_view.status<>'closed'))
         AND (
           $3::text='all'
           OR ($3::text='ie' AND case_view.status='pending_ie_quote')
           OR ($3::text='management' AND case_view.status='pending_management_decision')
           OR ($3::text='owner' AND case_view.status='pending_owner_approval')
           OR ($3::text='finance' AND case_view.status IN ('pending_contract','pending_finance_reconciliation'))
           OR ($3::text='factory_change' AND case_view.status='pending_factory_change_verification')
           OR ($3::text='exception' AND case_view.status='pending_exception_verification')
         )
         AND (
           $4::text='all'
           OR ($4::text='missing' AND source_case.gender IS NULL)
           OR ($4::text IN ('男装','女装') AND source_case.gender=$4::text)
         )
         AND (
           $5::text=''
           OR ($5::text='历史未维护' AND (source_case.style_name_snapshot IS NULL OR btrim(source_case.style_name_snapshot)=''))
           OR ($5::text<>'历史未维护' AND source_case.style_name_snapshot ILIKE '%'||$5::text||'%')
         )
         AND (
           $6::text IS NULL
           OR (
             monitor_case.contract_return_monitor_enabled
             AND (
               $6::text='all'
               OR ($6::text='pending' AND monitor_case.contract_returned_at IS NULL
                 AND (monitor_case.contract_return_due_at IS NULL
                   OR CURRENT_TIMESTAMP<=monitor_case.contract_return_due_at))
               OR ($6::text='returned_on_time' AND monitor_case.contract_returned_at IS NOT NULL
                 AND (monitor_case.contract_return_due_at IS NULL
                   OR monitor_case.contract_returned_at<=monitor_case.contract_return_due_at))
               OR ($6::text='overdue_pending'
                 AND monitor_case.contract_returned_at IS NULL
                 AND CURRENT_TIMESTAMP>monitor_case.contract_return_due_at)
               OR ($6::text='returned_late'
                 AND monitor_case.contract_returned_at>monitor_case.contract_return_due_at)
               OR ($6::text='all_overdue' AND (
                 monitor_case.contract_returned_at>monitor_case.contract_return_due_at
                 OR (monitor_case.contract_returned_at IS NULL AND CURRENT_TIMESTAMP>monitor_case.contract_return_due_at)
               ))
             )
           )
         )
       )
       SELECT page_row.*,totals.total_count,totals.total_order_quantity
       FROM (
         SELECT count(*)::text AS total_count,
           COALESCE(sum(order_quantity),0)::text AS total_order_quantity
         FROM filtered_cases
       ) totals
       LEFT JOIN LATERAL (
         SELECT * FROM filtered_cases
         ORDER BY created_at DESC,sourcing_case_id DESC
         LIMIT 15 OFFSET $7
       ) page_row ON true
       ORDER BY page_row.created_at DESC,page_row.sourcing_case_id DESC`,
      [
        normalizedQuery,
        statusFilter,
        stage,
        gender,
        normalizedStyleName,
        contractReturn,
        offset,
      ],
    );
    const pageRows = result.rows.filter(row => row.sourcing_case_id != null);
    const totalCount = Number(result.rows[0]?.total_count ?? "0");
    const items=pageRows.map(row=>mapCase(row,actor));
    for(const [index,row] of pageRows.entries())if(row.workflow_generation==='digital_production_v1') {
      const dates=(await factoryPoLines(this.database,row.sourcing_case_id))!;
      items[index]!.lineItems=items[index]!.lineItems.map(line=>{
        const po=dates.find(date=>date.position===line.position);
        return po?{...line,lineId:po.line_id,customerWarehouseArrivalDate:po.customer,factoryDeliveryDate:po.factory}:line;
      });
    }
    return {
      items,
      page,
      pageSize: SOURCING_LIST_PAGE_SIZE,
      totalCount,
      totalOrderQuantity: Number(result.rows[0]?.total_order_quantity ?? "0"),
      totalPages: Math.max(1, Math.ceil(totalCount / SOURCING_LIST_PAGE_SIZE)),
    };
  }

  async getCase(
    actor: TrustedActorContext,
    sourcingCaseId: string,
  ): Promise<SourcingCaseSummary> {
    this.assertReader(actor);
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    return this.readCase(this.database, sourcingCaseId, actor);
  }

  async deleteByRoot(
    actor: TrustedActorContext,
    sourcingCaseId: string,
    idempotencyKey: string,
  ): Promise<Result<DeleteSourcingCaseResponse>> {
    if (
      actor.authorizationCapability !== CASE_DELETE_CAPABILITY
      || !actor.actorRoles.includes(ROOT_ROLE)
    ) {
      fail("只有超级用户可以删除报价选厂订单", 403, "FORBIDDEN");
    }
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    const scope = "sourcing.case.delete";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, { sourcingCaseId }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        const current = await client.query<{ deleted_at: Date | string | null }>(
          `SELECT deleted_at
           FROM sourcing_cases
           WHERE sourcing_case_id=$1
           FOR UPDATE`,
          [sourcingCaseId],
        );
        const row = current.rows[0];
        if (!row) return fail("报价选厂询价不存在", 404, "NOT_FOUND");
        if (row.deleted_at !== null) {
          return {
            statusCode: 200,
            response: { sourcingCaseId, deleted: true as const },
          };
        }
        const before = await this.readCase(client, sourcingCaseId, actor);
        const eventId = await this.events.append(client, actor, {
          action: "sourcing.case.delete",
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          before,
          after: { ...before, deleted: true, deletedBy: actor.actorId },
          reason: DEFAULT_DELETION_REASON,
        });
        await this.todoProjection?.cancelOpenByDedupePrefix(
          client,
          actor,
          `sourcing:${sourcingCaseId}:`,
          "The sourcing case was deleted by root",
        );
        await client.query(
          `UPDATE sourcing_cases
           SET deleted_at=CURRENT_TIMESTAMP,deleted_by=$2,
               deletion_operation_event_id=$3,deletion_request_id=$4,
               deletion_reason=$5
           WHERE sourcing_case_id=$1`,
          [sourcingCaseId, actor.actorId, eventId, actor.requestId, DEFAULT_DELETION_REASON],
        );
        return {
          statusCode: 200,
          response: { sourcingCaseId, deleted: true as const },
        };
      });
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listAttachments(
    actor: TrustedActorContext,
    sourcingCaseId: string,
    historical = false,
  ): Promise<SourcingAttachmentListResponse> {
    this.assertReader(actor);
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    await this.readCase(this.database, sourcingCaseId, actor);
    const result = await this.database.query<{
      attachment_id: string;
      original_filename: string;
      mime_type: "image/jpeg" | "image/png" | "image/webp";
    }>(
      `SELECT attachment_id,original_filename,mime_type
       FROM attachments
       WHERE entity_type='sourcing_case' AND entity_id=$1 AND status='ready'
         AND mime_type IN ('image/jpeg','image/png','image/webp')
       ORDER BY created_at,attachment_id`,
      [sourcingCaseId],
    );
    const revision = historical ? null : (await this.database.query<{ids:string[]}>(
      `SELECT after_state->'attachmentIds' AS ids FROM operation_events
       WHERE entity_type='sourcing_case' AND entity_id=$1 AND action IN ('sourcing.case.correct','sourcing.attachments.supplement','sourcing.case.create')
       AND jsonb_typeof(after_state->'attachmentIds')='array'
       ORDER BY created_at DESC, CASE WHEN action='sourcing.case.correct' THEN 0 ELSE 1 END, event_id DESC LIMIT 1`,[sourcingCaseId])).rows[0];
    return {
      items: result.rows.filter(row=>!revision || revision.ids.includes(row.attachment_id)).map((row) => ({
        attachmentId: row.attachment_id,
        filename: row.original_filename,
        mimeType: row.mime_type,
      })),
    };
  }

  async supplementImages(
    actor: TrustedActorContext,
    sourcingCaseId: string,
    input: SupplementSourcingImages,
    idempotencyKey: string,
  ): Promise<Result<SourcingAttachmentListResponse>> {
    this.assertImageSupplementActor(actor);
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    const normalized = { attachmentIds: [...input.attachmentIds] };
    const scope = "sourcing.attachments.supplement";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await lockDigitalSourcingHandover(client,sourcingCaseId,actor);
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, { sourcingCaseId, ...normalized }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        const source = await client.query<{ sourcing_case_id: string; created_by: string; additional_merchandiser_user_id: string | null }>(
          `SELECT sourcing_case_id,created_by,
             nullif(to_jsonb(sourcing_cases)->>'additional_merchandiser_user_id','')::uuid AS additional_merchandiser_user_id
           FROM sourcing_cases
           WHERE sourcing_case_id=$1 AND deleted_at IS NULL
           FOR UPDATE`,
          [sourcingCaseId],
        );
        if (!source.rows[0]) fail("报价选厂询价不存在", 404, "NOT_FOUND");
        if (!actor.actorRoles.includes(ROOT_ROLE) && !actor.actorRoles.some(role=>role!==CASE_CREATE_ROLE && SOURCING_IMAGE_SUPPLEMENT_ROLES.includes(role as (typeof SOURCING_IMAGE_SUPPLEMENT_ROLES)[number]))
          && source.rows[0]!.additional_merchandiser_user_id === actor.actorId
          && await effectiveSourcingMerchandiser(client,sourcingCaseId,source.rows[0]!.created_by) !== actor.actorId) fail("添加跟单仅可回传合同",403,"FORBIDDEN");

        const existing = await client.query<{ attachment_id: string }>(
          `SELECT attachment_id
           FROM attachments
           WHERE entity_type='sourcing_case' AND entity_id=$1 AND status='ready'
           ORDER BY created_at,attachment_id
           FOR UPDATE`,
          [sourcingCaseId],
        );
        const existingAttachmentIds = existing.rows.map((row) => row.attachment_id);
        if (existingAttachmentIds.length + normalized.attachmentIds.length > MAX_SOURCING_ATTACHMENTS) {
          fail(`每张订单最多保留 ${MAX_SOURCING_ATTACHMENTS} 张图片`);
        }

        const images = await client.query<{ attachment_id: string }>(
          `SELECT attachment_id
           FROM attachments
           WHERE attachment_id=ANY($1::uuid[]) AND uploaded_by=$2
             AND status='ready' AND entity_type IS NULL AND entity_id IS NULL
             AND mime_type IN ('image/jpeg','image/png','image/webp')
           FOR UPDATE`,
          [normalized.attachmentIds, actor.actorId],
        );
        if (images.rows.length !== normalized.attachmentIds.length) {
          fail("补充图片必须已上传完成、属于当前账号且尚未绑定");
        }

        const nextAttachmentIds = [...existingAttachmentIds, ...normalized.attachmentIds];
        const eventId = await this.events.append(client, actor, {
          action: "sourcing.attachments.supplement",
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          before: { attachmentIds: existingAttachmentIds },
          after: { attachmentIds: nextAttachmentIds },
          reason: "补充报价选厂订单图片",
        });
        await client.query(
          `SELECT set_config('dx_rework.sourcing_event_id',$1,true),
                  set_config('dx_rework.sourcing_request_id',$2,true)`,
          [eventId, actor.requestId],
        );
        await client.query(
          `UPDATE attachments
           SET entity_type='sourcing_case',entity_id=$2,updated_at=CURRENT_TIMESTAMP
           WHERE attachment_id=ANY($1::uuid[])`,
          [normalized.attachmentIds, sourcingCaseId],
        );
        const attachments = await client.query<{
          attachment_id: string;
          original_filename: string;
          mime_type: "image/jpeg" | "image/png" | "image/webp";
        }>(
          `SELECT attachment_id,original_filename,mime_type
           FROM attachments
           WHERE entity_type='sourcing_case' AND entity_id=$1 AND status='ready'
             AND mime_type IN ('image/jpeg','image/png','image/webp')
           ORDER BY created_at,attachment_id`,
          [sourcingCaseId],
        );
        return {
          statusCode: 200,
          response: {
            items: attachments.rows.map((row) => ({
              attachmentId: row.attachment_id,
              filename: row.original_filename,
              mimeType: row.mime_type,
            })),
          },
        };
      });
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async nodeHistory(actor: TrustedActorContext, sourcingCaseId: string, node: SourcingHistoryNode, entryId?: string): Promise<SourcingNodeHistory> {
    this.assertReader(actor);
    const timeline = await this.listTimeline(actor, sourcingCaseId);
    const sources = {
      created: ["created", "sourcing_cases", "sourcing_case_id", "created_at"],
      ie_quote: ["ie_quote", "sourcing_ie_quotes", "sourcing_ie_quote_id", "quoted_at"],
      management: ["management_decision", "sourcing_decisions", "sourcing_decision_id", "decided_at"],
      owner: ["owner_decision", "sourcing_owner_decisions", "sourcing_owner_decision_id", "decided_at"],
      finance: ["finance_reconciliation", "sourcing_finance_reconciliations", "sourcing_reconciliation_id", "reconciled_at"],
    } as const;
    const [kind, table, id, time] = sources[node];
    const versions = timeline.items.filter(entry => entry.kind === kind);
    const entry = entryId ? versions.find(entry => entry.entryId === entryId) : versions.at(-1);
    if (!entry) return fail("该节点没有已提交的历史记录", 404, "NOT_FOUND");
    const cutoff = await this.database.query<{ at: string }>(
      node === "created" && entry.entryId !== sourcingCaseId
        ? "SELECT corrected_at::text AS at FROM sourcing_case_corrections WHERE correction_id=$1 AND sourcing_case_id=$2"
        : `SELECT ${time}::text AS at FROM ${table} WHERE ${id}=$1 AND sourcing_case_id=$2`, [entry.entryId, sourcingCaseId]);
    const at = cutoff.rows[0]?.at;
    if (!at) return fail("历史记录不存在", 404, "NOT_FOUND");
    const item = await this.readCase(this.database, sourcingCaseId, actor, { at, node, entryId: entry.entryId });
    const evidence = await this.database.query<{ ids: string[] | null }>(
      `SELECT after_state->'attachmentIds' AS ids FROM operation_events
       WHERE entity_type='sourcing_case' AND entity_id=$1 AND created_at <= $2::timestamptz
         AND action IN ('sourcing.case.create','sourcing.attachments.supplement','sourcing.case.correct')
         AND jsonb_typeof(after_state->'attachmentIds')='array'
       ORDER BY created_at DESC,event_id DESC LIMIT 1`, [sourcingCaseId, at]);
    const ids = evidence.rows[0]?.ids;
    const attachments = await this.listAttachments(actor, sourcingCaseId, true);
    const contract = node === "finance" ? await this.database.query<{ reference: string }>(
      `SELECT sourcing_contract_display_number(document.sourcing_contract_document_id,document.contract_number) AS reference FROM sourcing_finance_reconciliations reconciliation
       JOIN sourcing_contract_documents document ON document.sourcing_contract_document_id=reconciliation.sourcing_contract_document_id
       WHERE reconciliation.sourcing_reconciliation_id=$1 AND reconciliation.sourcing_case_id=$2`,
      [entry.entryId, sourcingCaseId]) : null;
    const notices: string[] = [];
    if (!ids) notices.push("该历史版本未保存图片清单，不能还原当时的图片。");
    // Related order-level audits remain readable, explicitly separate from the selected snapshot.
    const relatedEntries = timeline.items.filter(record => node === "management"
      ? record.kind === "factory_change_request" || record.kind === "factory_change_verification"
      : node === "finance" ? record.kind === "exception_verification" || record.kind === "contract"
        : node === "created" && record.kind === "style_revision");
    return { item, node, entry, versions, relatedEntries,
      attachments: ids ? attachments.items.filter(image => ids.includes(image.attachmentId)) : [], notices,
      contractReference: contract?.rows[0]?.reference ?? null };
  }

  async contractDirectory(actor:TrustedActorContext,sourcingCaseId:string){
    this.assertReader(actor);
    if(!actor.actorRoles.includes(ROOT_ROLE)&&!(actor.authorizationCapabilities??[]).includes("supplier_contract_data:read")){
      throw new ApplicationError("FORBIDDEN","当前身份无权读取合同资料",403);
    }
    const timeline=await this.listTimeline(actor,sourcingCaseId);
    const returned=await new SourcingContractReturnService(this.database).get(actor,sourcingCaseId);
    const contracts=timeline.items.filter(item=>item.kind==="contract"),ids=contracts.flatMap(item=>item.pdfAttachmentId?[item.pdfAttachmentId]:[]);
    const files=new Map<string,{original_filename:string;status:string}>(ids.length?(await this.database.query("SELECT attachment_id,original_filename,status FROM attachments WHERE attachment_id=ANY($1::uuid[])",[ids])).rows.map(file=>[file.attachment_id,file]):[]);
    return {contracts:contracts.map(item=>({...item,pdfFilename:item.pdfAttachmentId?files.get(item.pdfAttachmentId)?.original_filename??null:null,pdfStatus:item.pdfAttachmentId?files.get(item.pdfAttachmentId)?.status??null:null})),versions:returned.versions};
  }
  async listTimeline(
    actor: TrustedActorContext,
    sourcingCaseId: string,
  ): Promise<SourcingTimelineResponse> {
    this.assertReader(actor);
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    await this.readCase(this.database, sourcingCaseId, actor);
    const result = await this.database.query<{
      entry_id: string;
      pdf_attachment_id: string | null;
      kind: "created" | "style_revision" | "ie_quote" | "management_decision" | "owner_decision"
        | "contract" | "factory_change_request" | "factory_change_verification"
        | "finance_reconciliation" | "exception_verification";
      entry_version: number | string;
      handled_by: string;
      handled_at: Date | string;
      reason: string;
      unit_price: string | null;
      total_amount: string | null;
      supplier_name: string | null;
      decision: "approved" | "rejected" | null;
      contract_reference: string | null;
      signed_on: Date | string | null;
      quantity: number | string | null;
      difference_fields: Array<"supplier" | "unit_price" | "quantity" | "total_amount">;
      result: "match" | "difference" | null;
      resolution: "close" | "reconcile_again" | null;
      factory_decision_id: string | null;
    }>(
      `WITH timeline AS (
         SELECT source_case.sourcing_case_id AS entry_id,'created'::text AS kind,
                1 AS entry_version,source_case.created_by AS actor_id,
                source_case.created_at AS handled_at,source_case.creation_reason AS reason,
                NULL::numeric AS unit_price,NULL::numeric AS total_amount,
                NULL::text AS supplier_name,NULL::text AS decision,
                NULL::text AS contract_reference,NULL::date AS signed_on,
                NULL::integer AS quantity,'{}'::text[] AS difference_fields,
                NULL::text AS result,NULL::text AS resolution
         FROM sourcing_cases source_case
         WHERE source_case.sourcing_case_id=$1
         UNION ALL
         SELECT correction.correction_id,'created',correction.correction_version+1,correction.corrected_by,
                correction.corrected_at,correction.reason,NULL::numeric,NULL::numeric,NULL::text,NULL::text,
                NULL::text,NULL::date,correction.order_quantity,'{}'::text[],NULL::text,NULL::text
         FROM sourcing_case_corrections correction WHERE correction.sourcing_case_id=$1
         UNION ALL
         SELECT revision.operation_event_id,'style_revision',revision.revision,revision.changed_by,
                revision.created_at,'补充或修改款号',NULL::numeric,NULL::numeric,
                NULL::text,NULL::text,NULL::text,NULL::date,NULL::integer,'{}'::text[],NULL::text,NULL::text
         FROM sourcing_style_revisions revision WHERE revision.sourcing_case_id=$1
         UNION ALL
         SELECT quote.sourcing_ie_quote_id,'ie_quote',quote.quote_version,quote.quoted_by,
                quote.quoted_at,quote.quote_reason,quote.unit_price,quote.total_amount,
                NULL::text,NULL::text,NULL::text,NULL::date,
                quote.quantity,'{}'::text[],NULL::text,NULL::text
         FROM sourcing_ie_quotes quote WHERE quote.sourcing_case_id=$1
         UNION ALL
         SELECT choice.sourcing_decision_id,'management_decision',choice.decision_version,
                choice.decided_by,choice.decided_at,choice.decision_reason,
                choice.unit_price,choice.total_amount,choice.supplier_name_snapshot,
                NULL::text,NULL::text,NULL::date,
                choice.quantity,'{}'::text[],NULL::text,NULL::text
         FROM sourcing_decisions choice WHERE choice.sourcing_case_id=$1
         UNION ALL
         SELECT owner.sourcing_owner_decision_id,'owner_decision',
                row_number() OVER (ORDER BY owner.decided_at,owner.sourcing_owner_decision_id),
                owner.decided_by,owner.decided_at,owner.decision_reason,
                NULL::numeric,NULL::numeric,NULL::text,owner.decision,NULL::text,NULL::date,
                NULL::integer,'{}'::text[],NULL::text,NULL::text
         FROM sourcing_owner_decisions owner WHERE owner.sourcing_case_id=$1
         UNION ALL
         SELECT contract.sourcing_contract_id,'contract',
                row_number() OVER (ORDER BY contract.recorded_at,contract.sourcing_contract_id),
                contract.recorded_by,contract.recorded_at,contract.execution_reason,
                NULL::numeric,NULL::numeric,NULL::text,NULL::text,
                contract.contract_reference,contract.signed_on,
                NULL::integer,'{}'::text[],NULL::text,NULL::text
         FROM sourcing_contract_executions contract WHERE contract.sourcing_case_id=$1
         UNION ALL
         SELECT contract.sourcing_contract_document_id,'contract',contract.contract_version,
                contract.prepared_by,contract.prepared_at,
                CASE contract.status WHEN 'ready' THEN '系统合同PDF已生成'
                  WHEN 'pending_supplement' THEN '合同待补充资料'
                  ELSE '合同PDF待生成' END,
                NULL::numeric,NULL::numeric,NULL::text,NULL::text,
                sourcing_contract_display_number(contract.sourcing_contract_document_id,contract.contract_number),
                (contract.prepared_at AT TIME ZONE 'Asia/Shanghai')::date,
                NULL::integer,'{}'::text[],NULL::text,NULL::text
         FROM sourcing_contract_documents contract WHERE contract.sourcing_case_id=$1
         UNION ALL
         SELECT change.factory_change_request_id,'factory_change_request',
                row_number() OVER (ORDER BY change.requested_at,change.factory_change_request_id),
                change.requested_by,change.requested_at,change.change_reason,
                change.proposed_unit_price,change.proposed_total_amount,
                change.proposed_supplier_name_snapshot,NULL::text,NULL::text,NULL::date,
                change.proposed_quantity,'{}'::text[],NULL::text,NULL::text
         FROM sourcing_factory_change_requests change WHERE change.sourcing_case_id=$1
         UNION ALL
         SELECT verification.factory_change_decision_id,'factory_change_verification',
                row_number() OVER (ORDER BY verification.verified_at,verification.factory_change_decision_id),
                verification.verified_by,verification.verified_at,verification.verification_reason,
                NULL::numeric,NULL::numeric,NULL::text,verification.decision,NULL::text,NULL::date,
                NULL::integer,'{}'::text[],NULL::text,NULL::text
         FROM sourcing_factory_change_decisions verification
         JOIN sourcing_factory_change_requests change
           ON change.factory_change_request_id=verification.factory_change_request_id
         WHERE change.sourcing_case_id=$1
         UNION ALL
         SELECT reconciliation.sourcing_reconciliation_id,'finance_reconciliation',
                reconciliation.reconciliation_version,reconciliation.reconciled_by,
                reconciliation.reconciled_at,
                COALESCE(reconciliation.difference_reason,'四项核对一致'),
                reconciliation.actual_unit_price,reconciliation.actual_total_amount,
                reconciliation.actual_supplier_name_snapshot,NULL::text,NULL::text,NULL::date,
                reconciliation.actual_quantity,reconciliation.difference_fields,
                reconciliation.result,NULL::text
         FROM sourcing_finance_reconciliations reconciliation
         WHERE reconciliation.sourcing_case_id=$1
         UNION ALL
         SELECT event.event_id,'exception_verification',
                row_number() OVER (ORDER BY event.created_at,event.event_id),
                event.actor_id,event.created_at,COALESCE(event.reason,'差异已处理'),
                NULL::numeric,NULL::numeric,NULL::text,NULL::text,NULL::text,NULL::date,
                NULL::integer,'{}'::text[],NULL::text,
                CASE event.action
                  WHEN 'sourcing.exception.close' THEN 'close'
                  ELSE 'reconcile_again'
                END
         FROM operation_events event
         WHERE event.entity_type='sourcing_case' AND event.entity_id=$1::text
           AND event.action IN ('sourcing.exception.close','sourcing.exception.reopen_reconciliation')
       )
       SELECT timeline.entry_id,timeline.kind,timeline.entry_version,
              COALESCE(app_user.display_name,'系统用户') AS handled_by,
              timeline.handled_at,timeline.reason,
              timeline.unit_price::text,timeline.total_amount::text,
              timeline.supplier_name,timeline.decision,
              timeline.contract_reference,timeline.signed_on::text AS signed_on,
              timeline.quantity,timeline.difference_fields,timeline.result,timeline.resolution,
              (SELECT factory_decision_id FROM sourcing_finance_reconciliations WHERE sourcing_reconciliation_id=timeline.entry_id AND timeline.kind='finance_reconciliation') AS factory_decision_id,
              (SELECT pdf_attachment_id FROM sourcing_contract_documents WHERE sourcing_contract_document_id=timeline.entry_id AND timeline.kind='contract') AS pdf_attachment_id
       FROM timeline
       LEFT JOIN app_users app_user ON app_user.id=timeline.actor_id
       ORDER BY timeline.handled_at,timeline.kind,timeline.entry_version`,
      [sourcingCaseId],
    );
    if (result.rows.length === 0) fail("报价选厂询价不存在", 404, "NOT_FOUND");
    return {
      items: result.rows.map((row) => ({
        entryId: row.entry_id,
        ...(row.factory_decision_id?{factoryDecisionId:row.factory_decision_id}:{}),
        pdfAttachmentId: row.pdf_attachment_id ?? null,
        kind: row.kind,
        version: Number(row.entry_version),
        handledBy: row.handled_by,
        handledAt: toIso(row.handled_at),
        reason: row.reason,
        unitPrice: row.unit_price,
        totalAmount: row.total_amount,
        supplierName: row.supplier_name,
        decision: row.decision,
        contractReference: row.contract_reference,
        signedOn: row.signed_on
          ? (row.signed_on instanceof Date
              ? row.signed_on.toISOString().slice(0, 10)
              : String(row.signed_on).slice(0, 10))
          : null,
        quantity: row.quantity === null ? null : Number(row.quantity),
        differenceFields: row.difference_fields,
        result: row.result,
        resolution: row.resolution,
      })),
    };
  }

  canDownloadBoundAttachment(
    actor: TrustedActorContext,
    binding: Readonly<{ entityType: string; entityId: string; mimeType: string }>,
  ): boolean {
    if (binding.entityType === "sourcing_case" && binding.mimeType.startsWith("image/")) {
      return actor.actorRoles.includes(ROOT_ROLE)
        || (actor.authorizationCapabilities ?? []).includes(READ_CAPABILITY);
    }
    if (binding.entityType === "sourcing_contract_document"
      && ["application/pdf","image/jpeg","image/png","image/webp"].includes(binding.mimeType)) {
      return actor.actorRoles.includes(ROOT_ROLE)
        || (
          (actor.authorizationCapabilities ?? []).includes(READ_CAPABILITY)
          && (actor.authorizationCapabilities ?? []).includes("supplier_contract_data:read")
        );
    }
    if (binding.entityType === "sourcing_contract_return"
      && ["application/pdf","image/jpeg","image/png"].includes(binding.mimeType)) {
      return actor.actorRoles.includes(ROOT_ROLE)
        || ((actor.authorizationCapabilities ?? []).includes(READ_CAPABILITY)
          && (actor.authorizationCapabilities ?? []).includes("supplier_contract_data:read"));
    }
    return false;
  }

  async listFactories(
    actor: TrustedActorContext,
  ): Promise<SourcingFactoryListResponse> {
    this.assertReader(actor);
    const result = await this.database.query<{
      supplier_id: string;
      supplier_code: string;
      supplier_name: string;
      supported_crafts: string[];
      daily_capacity: number | null;
      notes: string;
      contract_data_missing: Array<"address" | "contractEntityName" | "partyBRepresentative" | "payeeName" | "bankAccount" | "bankName">;
    }>(
      `SELECT supplier_id,supplier_code,supplier_name,supported_crafts,daily_capacity,notes,
              array_remove(ARRAY[
                CASE WHEN address IS NULL THEN 'address' END,
                CASE WHEN contract_entity_name IS NULL THEN 'contractEntityName' END,
                CASE WHEN party_b_representative IS NULL THEN 'partyBRepresentative' END,
                CASE WHEN payee_name IS NULL THEN 'payeeName' END,
                CASE WHEN bank_account IS NULL THEN 'bankAccount' END,
                CASE WHEN bank_name IS NULL THEN 'bankName' END
              ],NULL)::text[] AS contract_data_missing
       FROM current_supplier_catalog
       WHERE supplier_type='factory' AND active=true
       ORDER BY supplier_name,supplier_code`,
    );
    return {
      items: result.rows.map((row) => ({
        supplierId: row.supplier_id,
        supplierCode: row.supplier_code,
        supplierName: row.supplier_name,
        supportedCrafts: row.supported_crafts,
        dailyCapacity: row.daily_capacity === null ? null : Number(row.daily_capacity),
        notes: row.notes,
        contractDataMissing: row.contract_data_missing,
      })),
    };
  }

  async getCurrentFactoryChange(
    actor: TrustedActorContext,
    sourcingCaseId: string,
  ): Promise<SourcingFactoryChangeStateResponse> {
    this.assertReader(actor);
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    const source=await this.readCase(this.database,sourcingCaseId,actor);
    const remainingLines=source.decision?(await this.database.query<{position:number;planned_quantity:number;completed_quantity:number;quantity:number}>("SELECT * FROM sourcing_factory_remaining_lines($1,$2) ORDER BY position",[sourcingCaseId,source.decision.sourcingDecisionId])).rows.map(line=>({position:line.position,plannedQuantity:line.planned_quantity,completedQuantity:line.completed_quantity,quantity:line.quantity})):undefined;
    const result = await this.database.query<{
      factory_change_request_id: string;
      from_decision_id: string;
      initiator_role: "order_merchandiser" | "production_management" | "owner_group";
      proposed_supplier_id: string;
      proposed_supplier_name_snapshot: string;
      proposed_unit_price: string;
      proposed_quantity: number | string;
      proposed_total_amount: string;
      change_reason: string;
      requires_owner_approval: boolean;
      requested_by: string;
      requested_at: Date | string;
      management_decision: "approved" | "rejected" | null;
      owner_decision: "approved" | "rejected" | null;
      effective: boolean;
      proposed_delivery_date: string | null;
      changes_delivery_date: boolean;
    }>(
      `SELECT change.factory_change_request_id,change.from_decision_id,
              change.initiator_role,change.proposed_supplier_id,
              change.proposed_supplier_name_snapshot,change.proposed_unit_price,
              change.proposed_quantity,change.proposed_total_amount,
              change.change_reason,change.requires_owner_approval,
              change.requested_by,change.requested_at,
              proposal.after_state->>'deliveryDate' AS proposed_delivery_date,
              (proposal.after_state->>'deliveryDate') IS DISTINCT FROM (proposal.after_state->>'baseDeliveryDate') AS changes_delivery_date,
              management_review.decision AS management_decision,
              owner_review.decision AS owner_decision,
              EXISTS(
                SELECT 1 FROM sourcing_decisions effective
                WHERE effective.source_change_request_id=change.factory_change_request_id
              ) AS effective
       FROM sourcing_factory_change_requests change
       JOIN operation_events proposal ON proposal.event_id=change.operation_event_id
       LEFT JOIN sourcing_factory_change_decisions management_review
         ON management_review.factory_change_request_id=change.factory_change_request_id
        AND management_review.decision_role='production_management'
       LEFT JOIN sourcing_factory_change_decisions owner_review
         ON owner_review.factory_change_request_id=change.factory_change_request_id
        AND owner_review.decision_role='owner_group'
       WHERE change.sourcing_case_id=$1
       AND change.requested_at > COALESCE((SELECT max(transitioned_at) FROM sourcing_case_transitions WHERE sourcing_case_id=$1 AND business_action='returned_to_merchandiser'),'-infinity'::timestamptz)
       ORDER BY change.requested_at DESC,change.factory_change_request_id DESC
       LIMIT 1`,
      [sourcingCaseId],
    );
    const row = result.rows[0];
    if (!row) return { item: null,...(remainingLines?{remainingLines}:{}) };
    const status = row.effective
      ? "effective" as const
      : row.management_decision === "rejected" || row.owner_decision === "rejected"
        ? "rejected" as const
        : row.initiator_role === "order_merchandiser" && row.management_decision === null
          ? "pending_management" as const
          : "pending_owner" as const;
    return {
      ...(remainingLines?{remainingLines}:{}),
      item: {
        factoryChangeRequestId: row.factory_change_request_id,
        fromDecisionId: row.from_decision_id,
        initiatorRole: row.initiator_role,
        proposedSupplierId: row.proposed_supplier_id,
        proposedSupplierName: row.proposed_supplier_name_snapshot,
        proposedUnitPrice: row.proposed_unit_price,
        proposedQuantity: Number(row.proposed_quantity),
        proposedTotalAmount: row.proposed_total_amount,
        changeReason: row.change_reason,
        requiresOwnerApproval: row.requires_owner_approval,
        status,
        requestedBy: row.requested_by,
        requestedAt: toIso(row.requested_at),
        proposedDeliveryDate: row.proposed_delivery_date,
        changesDeliveryDate: row.changes_delivery_date,
      },
    };
  }

  async listMerchandisers(actor: TrustedActorContext): Promise<{ userId: string; displayName: string }[]> {
    this.assertActor(actor, CASE_CREATE_CAPABILITY, CASE_CREATE_ROLE);
    const result = await this.database.query<{ userId: string; displayName: string }>(
      `SELECT person.id AS "userId",person.display_name AS "displayName"
       FROM app_users person
       JOIN user_role_assignments assignment ON assignment.user_id=person.id
         AND assignment.role_code='order_merchandiser' AND assignment.revoked_at IS NULL
       WHERE person.id<>$1
         AND todo_user_has_direct_role(person.id,'order_merchandiser','sourcing:contract:record')
         AND todo_user_has_direct_role(person.id,'order_merchandiser','sourcing:view')
         AND todo_user_has_direct_role(person.id,'order_merchandiser','supplier_contract_data:read')
       GROUP BY person.id,person.display_name ORDER BY person.display_name,person.id`,
      [actor.actorId],
    );
    return result.rows;
  }

  async listStyles(actor: TrustedActorContext, query = ""): Promise<{ styleId: string; styleName: string }[]> {
    this.assertActor(actor, CASE_CREATE_CAPABILITY, CASE_CREATE_ROLE);
    const result = await this.database.query<{ styleId: string; styleName: string }>(
      `SELECT style_id AS "styleId",style_name AS "styleName" FROM sourcing_style_catalog
       WHERE strpos(normalized_name,lower(btrim($1)))>0 ORDER BY style_name LIMIT 50`,
      [query.slice(0,100)],
    );
    return result.rows;
  }

  private async checkStyleNumbers(client: PoolClient, lines: readonly SourcingStyleIdentity[], confirmed: readonly string[] = [], caseId: string | null = null, previous: readonly SourcingStyleIdentity[] = []): Promise<string[]> {
    const duplicate = duplicateSourcingLineMessage(lines);
    if (duplicate) fail(duplicate);
    const prior = new Set(sourcingStyleNumbers(previous));
    const names = sourcingStyleNumbers(lines).filter(name => !prior.has(name));
    // Lock in a stable order so concurrent submissions cannot both miss a new identity.
    for (const name of names) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`sourcing-style:${name}`]);
    if (!names.length) return [];
    const matches = await client.query<{style_no:string}>(
      `SELECT DISTINCT normalize_sourcing_style_key(alias.style_no) AS style_no
       FROM sourcing_style_aliases alias JOIN sourcing_cases source USING(sourcing_case_id)
       WHERE source.deleted_at IS NULL AND ($2::uuid IS NULL OR source.sourcing_case_id<>$2)
         AND normalize_sourcing_style_key(alias.style_no)=ANY($1::text[]) ORDER BY style_no`, [names,caseId],
    );
    const acknowledged = new Set(confirmed.map(normalizeSourcingStyleNumber));
    const unconfirmed = matches.rows.filter(row => !acknowledged.has(row.style_no));
    if (unconfirmed.length) fail(`款号 ${unconfirmed.map(row => row.style_no).join("、")} 已被其它外发订单使用，请核对是否录错。`,409,"STYLE_NUMBER_EXISTS");
    return matches.rows.map(row => row.style_no);
  }

  async reviseDigitalNumbersWithClient(client:PoolClient,actor:TrustedActorContext,orderId:string){
    const order=(await client.query('SELECT * FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE',[orderId])).rows[0];
    const leader=actor.actorRoles.some(role=>['root_superuser','owner_group','production_management'].includes(role));
    if(!order||!leader&&!(actor.actorRoles.includes('sample_designer')&&order.created_by===actor.actorId)&&!(actor.actorRoles.includes('order_merchandiser')&&order.primary_merchandiser_id===actor.actorId))fail('无权补齐本单编号',403,'FORBIDDEN');
    const links=(await client.query("SELECT s.sourcing_case_id,s.workflow_generation FROM digital_production_child_links l JOIN sourcing_cases s ON s.sourcing_case_id=l.child_id WHERE l.module='sourcing' AND l.production_order_id=$1 ORDER BY l.child_id",[orderId])).rows;
    for(const link of links){
      await resolveDigitalChild(client,'sourcing',link.sourcing_case_id,link.workflow_generation);
      await client.query('SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=$1 FOR UPDATE',[link.sourcing_case_id]);
      const before=await this.readCase(client,link.sourcing_case_id,actor);
      const mapped=(await client.query(`SELECT l.child_line_key::int AS position,p.formal_style_no AS "styleNo",coalesce(p.temporary_style_no,o.temporary_style_no,o.design_style_no) AS "alternateStyleNo" FROM digital_production_child_lines l JOIN digital_production_po_lines p USING(line_id) JOIN digital_production_orders o ON o.production_order_id=p.production_order_id WHERE l.module='sourcing' AND l.child_id=$1 ORDER BY l.child_line_key::int`,[link.sourcing_case_id])).rows as Array<{position:number;styleNo:string|null;alternateStyleNo:string|null}>;
      if(mapped.length!==before.lineItems.length)fail('原外发款色关联不完整');
      const previous=before.lineItems.map(line=>({position:line.position,styleNo:line.formalStyleNo===undefined?line.styleNo:line.formalStyleNo,alternateStyleNo:line.alternateStyleNo}));
      if(JSON.stringify(previous)===JSON.stringify(mapped))continue;
      await this.checkStyleNumbers(client,mapped.map(line=>({...line,color:before.lineItems.find(row=>row.position===line.position)?.color})),undefined,link.sourcing_case_id,previous);
      const auditActor={...actor,authorizationCapability:'digital_production:numbers:correct'};
      const eventId=await this.events.append(client,auditActor,{action:'sourcing.styles.revise',entityType:'sourcing_case',entityId:link.sourcing_case_id,before:{lines:previous},after:{lines:mapped},reason:'数字母单补号同步，原数量价格审批及实裁计时保持不变'});
      await client.query('INSERT INTO sourcing_style_revisions(sourcing_case_id,revision,lines,changed_by,operation_event_id,request_id) VALUES($1,$2,$3,$4,$5,$6)',[link.sourcing_case_id,(before.identityRevision??0)+1,JSON.stringify(mapped),actor.actorId,eventId,actor.requestId]);
      if(before.approvalSnapshot){if(!this.contractService)fail('合同服务未就绪，补号不能只改单据一侧');await this.contractService!.prepareForApproval(client,before.approvalSnapshot.sourcingApprovalSnapshotId,actor);}
    }
  }
  async generateDigitalNumberContracts(actor:TrustedActorContext,orderId:string){
    for(const row of (await this.database.query("SELECT child_id FROM digital_production_child_links WHERE module='sourcing' AND production_order_id=$1",[orderId])).rows)await this.contractService?.generateIfReady({...actor,authorizationCapability:READ_CAPABILITY},row.child_id).catch(()=>undefined);
  }
  async reviseStyles(actor: TrustedActorContext, sourcingCaseId: string, input: ReviseSourcingStyles, key: string): Promise<Result<SourcingCaseSummary>> {
    const parsed = ReviseSourcingStylesSchema.safeParse(input);
    if (!parsed.success || !UUID_PATTERN.test(sourcingCaseId)) fail("款号修改信息无效");
    const root = actor.actorRoles.includes(ROOT_ROLE);
    const caps = actor.authorizationCapabilities ?? [actor.authorizationCapability];
    const manager = actor.actorRoles.includes(MANAGEMENT_DECISION_ROLE) && caps.includes(MANAGEMENT_DECISION_CAPABILITY);
    const merchandiser = actor.actorRoles.includes(CASE_CREATE_ROLE) && caps.includes(CASE_CREATE_CAPABILITY);
    if (!root && (!caps.includes(READ_CAPABILITY) || (!manager && !merchandiser))) fail("当前岗位无权修改款号",403,"FORBIDDEN");
    const lines = [...parsed.data!.lines].sort((a,b) => a.position-b.position);
    const client = await this.database.connect();
    const scope = "sourcing.styles.revise";
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      await lockDigitalSourcingHandover(client,sourcingCaseId,actor,manager ? MANAGEMENT_DECISION_CAPABILITY : CASE_CREATE_CAPABILITY);
      const source = (await client.query<{created_by:string}>("SELECT created_by FROM sourcing_cases WHERE sourcing_case_id=$1 AND deleted_at IS NULL FOR UPDATE",[sourcingCaseId])).rows[0];
      if (!source) fail("外发订单不存在",404,"NOT_FOUND");
      if (!root && ((!manager && await effectiveSourcingMerchandiser(client,sourcingCaseId,source!.created_by) !== actor.actorId) || !await memberCanWriteModule(client,actor.actorId,"sourcing"))) fail("无权修改本订单款号",403,"FORBIDDEN");
      const result = await this.idempotency.execute(client,{scope,actorKey:actor.actorId,key,
        requestHash:requestHash(scope,{sourcingCaseId,input:{...parsed.data,confirmedDuplicateStyles:undefined}}),expiresAt:new Date(Date.now()+86400000)},async () => {
        const before = await this.readCase(client,sourcingCaseId,actor);
        const generatedContract = (await client.query<{status:string;pdf_attachment_id:string|null;identity_version:number}>(
          `SELECT status,pdf_attachment_id,identity_version FROM sourcing_contract_documents
           WHERE sourcing_case_id=$1 ORDER BY contract_version DESC LIMIT 1`, [sourcingCaseId],
        )).rows[0];
        if (!before.approvalSnapshot || !["pending_finance_reconciliation","closed"].includes(before.status)
          || generatedContract?.status !== "ready" || !generatedContract.pdf_attachment_id
          || Number(generatedContract.identity_version) !== (before.identityRevision ?? 0)) {
          fail("老板批准且当前合同 PDF 生成成功后才能修改款号",409,"INVALID_STATE_TRANSITION");
        }
        if ((before.identityRevision ?? 0) !== parsed.data!.expectedRevision) fail("款号已被他人修改，请刷新后重试",409,"CONFLICT");
        if (lines.length !== before.lineItems.length || lines.some((line,index) => line.position !== before.lineItems[index]!.position)) fail("只能修改已有款色行的款号");
        const previous = before.lineItems.map(line => ({position:line.position,styleNo:line.formalStyleNo === undefined ? line.styleNo : line.formalStyleNo,alternateStyleNo:line.alternateStyleNo}));
        if (JSON.stringify(previous) === JSON.stringify(lines)) return {statusCode:200,response:before};
        const confirmedDuplicates = await this.checkStyleNumbers(client,
          lines.map(line => ({...line,color:before.lineItems.find(row => row.position===line.position)?.color})),
          parsed.data!.confirmedDuplicateStyles,sourcingCaseId,previous);
        const eventId = await this.events.append(client,{...actor,authorizationCapability:manager ? MANAGEMENT_DECISION_CAPABILITY : CASE_CREATE_CAPABILITY},{
          action:scope,entityType:"sourcing_case",entityId:sourcingCaseId,before:{lines:previous},after:{lines,confirmedDuplicateStyles:confirmedDuplicates},reason:"补充或修正款号，数量价格及审批保持不变",
        });
        await client.query(`INSERT INTO sourcing_style_revisions(sourcing_case_id,revision,lines,changed_by,operation_event_id,request_id)
          VALUES($1,$2,$3::jsonb,$4,$5,$6)`,[sourcingCaseId,(before.identityRevision ?? 0)+1,JSON.stringify(lines),actor.actorId,eventId,actor.requestId]);
        if((await client.query("SELECT to_regclass('digital_production_child_lines') AS relation")).rows[0]?.relation){
          const link=(await client.query("SELECT l.production_order_id FROM digital_production_child_links l JOIN sourcing_cases s ON s.sourcing_case_id=l.child_id WHERE l.module='sourcing' AND l.child_id=$1 AND s.workflow_generation='digital_production_v1'",[sourcingCaseId])).rows[0];
          if(link){
            for(const line of lines)await client.query("UPDATE digital_production_po_lines p SET po_number=$3,formal_style_no=$3,temporary_style_no=$4 FROM digital_production_child_lines l WHERE l.module='sourcing' AND l.child_id=$1 AND l.child_line_key=$2 AND p.line_id=l.line_id",[sourcingCaseId,String(line.position),line.styleNo,line.alternateStyleNo]);
            await client.query('UPDATE digital_production_orders SET version=version+1 WHERE production_order_id=$1',[link.production_order_id]);
          }
        }
        if (before.approvalSnapshot) await this.contractService?.prepareForApproval(client,before.approvalSnapshot.sourcingApprovalSnapshotId,actor);
        return {statusCode:200,response:await this.readCase(client,sourcingCaseId,actor)};
      });
      await client.query("COMMIT");
      await this.contractService?.generateIfReady({...actor,authorizationCapability:READ_CAPABILITY},sourcingCaseId).catch(() => undefined);
      return {value:result.response,reused:result.reused};
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async returnToMerchandiser(actor: TrustedActorContext, sourcingCaseId: string, input: ReturnSourcingCase, key: string): Promise<Result<SourcingCaseSummary>> {
    this.assertActor(actor, OWNER_DECISION_CAPABILITY, OWNER_DECISION_ROLE);
    const parsed = ReturnSourcingCaseSchema.safeParse(input);
    if (!parsed.success || !UUID_PATTERN.test(sourcingCaseId)) fail("请填写退回原因并刷新订单版本");
    return this.writeCorrection(actor, sourcingCaseId, parsed.data!, key, false);
  }

  async correctCase(actor: TrustedActorContext, sourcingCaseId: string, input: CorrectSourcingCase, key: string): Promise<Result<SourcingCaseSummary>> {
    this.assertActor(actor, CASE_CREATE_CAPABILITY, CASE_CREATE_ROLE);
    const parsed = CorrectSourcingCaseSchema.safeParse(input);
    if (!parsed.success || !UUID_PATTERN.test(sourcingCaseId)) fail(parsed.error?.issues[0]?.message ?? "修改资料无效");
    return this.writeCorrection(actor, sourcingCaseId, parsed.data!, key, true);
  }

  private async writeCorrection(actor: TrustedActorContext, sourcingCaseId: string, input: ReturnSourcingCase | CorrectSourcingCase, key: string, correcting: boolean): Promise<Result<SourcingCaseSummary>> {
    const scope = correcting ? "sourcing.case.correct" : "sourcing.case.return";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      await lockDigitalSourcingHandover(client,sourcingCaseId,actor);
      const root = actor.actorRoles.includes(ROOT_ROLE);
      const source = (await client.query<{created_by: string; additional_merchandiser_user_id: string | null}>(
        "SELECT created_by,nullif(to_jsonb(sourcing_cases)->>'additional_merchandiser_user_id','')::uuid AS additional_merchandiser_user_id FROM sourcing_cases WHERE sourcing_case_id=$1 AND deleted_at IS NULL FOR UPDATE", [sourcingCaseId],
      )).rows[0] ?? fail("外发订单不存在",404,"NOT_FOUND");
      if (!root && (!await memberCanWriteModule(client,actor.actorId,"sourcing") || correcting && await effectiveSourcingMerchandiser(client,sourcingCaseId,source.created_by) !== actor.actorId)) fail("无权修改本订单",403,"FORBIDDEN");
      const result = await this.idempotency.execute(client, {scope,actorKey:actor.actorId,key,
        requestHash:requestHash(scope,{sourcingCaseId,input:{...input,confirmedDuplicateStyles:undefined}}),expiresAt:new Date(Date.now()+86400000)}, async () => {
        const before = await this.readCase(client,sourcingCaseId,actor);
        if (before.approvalSnapshot) fail("老板已批准，不能直接退回修改生效订单",409,"INVALID_STATE_TRANSITION");
        if (before.version !== input.expectedVersion) fail("订单已被他人处理，本次未覆盖；请在本单报价选厂页重新读取最新方案与版本，再核对当前待办后提交",409,"CONFLICT");
        if (correcting ? before.status !== "pending_merchandiser_correction"
          : !["pending_ie_quote","pending_management_decision","pending_owner_approval"].includes(before.status)) fail(workflowStateRejection("外发订单",before.status,correcting?["pending_merchandiser_correction"]:["pending_ie_quote","pending_management_decision","pending_owner_approval"],"本单报价选厂办理页"),409,"INVALID_STATE_TRANSITION");
        const nextStatus = correcting ? "pending_ie_quote" : "pending_merchandiser_correction";
        let after: Record<string,unknown> = {status:nextStatus};
        const facts = correcting ? input as CorrectSourcingCase : null;
        let correctionVersion = 0;
        let correctionStyleId: string | null = null;
        if (facts) {
          const poLines=await factoryPoLines(client,sourcingCaseId);
          if(poLines)validateFactoryInputs(poLines,facts,true);
          await client.query("INSERT INTO sourcing_style_catalog(style_id,style_name,created_by) VALUES($1,$2,$3) ON CONFLICT(normalized_name) DO NOTHING",[randomUUID(),facts.styleName,actor.actorId]);
          correctionStyleId=(await client.query<{style_id:string}>("SELECT style_id FROM sourcing_style_catalog WHERE normalized_name=lower(btrim($1))",[facts.styleName])).rows[0]!.style_id;
          const confirmedDuplicateStyles = await this.checkStyleNumbers(client,facts.lineItems,facts.confirmedDuplicateStyles,sourcingCaseId,before.lineItems);
          const quantity = calculateSourcingOrderQuantity(facts.lineItems);
          const images = await client.query<{attachment_id:string;entity_type:string|null;entity_id:string|null;uploaded_by:string}>(
            `SELECT attachment_id,entity_type,entity_id,uploaded_by FROM attachments WHERE attachment_id=ANY($1::uuid[])
             AND status='ready' AND mime_type IN ('image/jpeg','image/png','image/webp') FOR UPDATE`,[facts.attachmentIds]);
          if (images.rows.length !== facts.attachmentIds.length || images.rows.some(image => image.entity_type === null
            ? image.entity_id !== null || image.uploaded_by !== actor.actorId
            : image.entity_type !== "sourcing_case" || image.entity_id !== sourcingCaseId)) fail("图片必须属于本订单或由当前账号上传完成");
          const newIds = images.rows.filter(image => image.entity_type === null).map(image => image.attachment_id);
          const newLineIds = facts.lineItems.flatMap(line => line.imageAttachmentId && newIds.includes(line.imageAttachmentId) ? [line.imageAttachmentId] : []);
          if (newLineIds.length) {
            const contracts = this.contractService ?? fail("款图校验服务暂不可用",503,"STORAGE_UNAVAILABLE");
            await contracts.validateLineImages(client,actor,newLineIds);
          }
          if (newIds.length) {
            const existing = (await client.query<{attachment_id:string}>("SELECT attachment_id FROM attachments WHERE entity_type='sourcing_case' AND entity_id=$1",[sourcingCaseId])).rows.map(row=>row.attachment_id);
            const imageEvent = await this.events.append(client,{...actor,authorizationCapability:IMAGE_SUPPLEMENT_CAPABILITY},{action:"sourcing.attachments.supplement",entityType:"sourcing_case",entityId:sourcingCaseId,
              before:{attachmentIds:existing},after:{attachmentIds:[...existing,...newIds]},reason:"纠错补充订单图片"});
            await client.query("SELECT set_config('dx_rework.sourcing_event_id',$1,true),set_config('dx_rework.sourcing_request_id',$2,true)",[imageEvent,actor.requestId]);
            await client.query("UPDATE attachments SET entity_type='sourcing_case',entity_id=$2,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=ANY($1::uuid[])",[newIds,sourcingCaseId]);
          }
          correctionVersion = Number((await client.query<{version:number}>("SELECT count(*)+1 AS version FROM sourcing_case_corrections WHERE sourcing_case_id=$1",[sourcingCaseId])).rows[0]!.version);
          after = {...after,gender:facts.gender,styleName:facts.styleName,estimatedCutPieceSendDate:facts.estimatedCutPieceSendDate,
            deliveryDate:facts.deliveryDate,lineItems:facts.lineItems,orderQuantity:quantity,attachmentIds:facts.attachmentIds,correctionVersion,confirmedDuplicateStyles};
        }
        // Budget values never enter ordinary operation-event history.
        const eventId = await this.events.append(client,actor,{action:scope,entityType:"sourcing_case",entityId:sourcingCaseId,
          before:{status:before.status,gender:before.gender,styleName:before.styleName,estimatedCutPieceSendDate:before.estimatedCutPieceSendDate,
            deliveryDate:before.deliveryDate,lineItems:before.lineItems.map(({position,formalStyleNo,alternateStyleNo,color,quantity,imageAttachmentId})=>({position,styleNo:formalStyleNo,alternateStyleNo,color,quantity,imageAttachmentId}))},
          after,reason:input.reason});
        if (facts) {
          await client.query(`INSERT INTO sourcing_case_corrections(correction_id,sourcing_case_id,correction_version,gender,style_name_snapshot,
            estimated_cut_piece_send_date,delivery_date,order_quantity,lines,attachment_ids,reason,corrected_by,operation_event_id,request_id,style_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15)`,
          [randomUUID(),sourcingCaseId,correctionVersion,facts.gender,facts.styleName,facts.estimatedCutPieceSendDate,facts.deliveryDate,
            after.orderQuantity,JSON.stringify(facts.lineItems),facts.attachmentIds,input.reason,actor.actorId,eventId,actor.requestId,correctionStyleId]);
        }
        if(facts)await syncFactoryPoNumbers(client,sourcingCaseId,facts);
        await client.query(`INSERT INTO sourcing_case_transitions(sourcing_transition_id,sourcing_case_id,sequence,from_status,to_status,
          business_action,transition_reason,actor_id,operation_event_id,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [randomUUID(),sourcingCaseId,before.version+1,before.status,nextStatus,correcting?"correction_submitted":"returned_to_merchandiser",input.reason,actor.actorId,eventId,actor.requestId]);
        await this.todoProjection?.completeOpenByDedupePrefix(client,actor,`sourcing:${sourcingCaseId}:`,correcting?"跟单已修改，重新交 IE 报价":"老板退回跟单修改");
        const projection = {category:correcting?"sourcing_ie_quote":"sourcing_merchandiser_correction",sourceEventId:eventId,sourceAction:scope,
          entityType:"sourcing_case",entityId:sourcingCaseId,requiredRole:correcting?IE_QUOTE_ROLE:CASE_CREATE_ROLE,
          requiredCapability:correcting?IE_QUOTE_CAPABILITY:CASE_CREATE_CAPABILITY,
          route:{routeName:"sourcing_detail" as const,entityId:sourcingCaseId},policyKey:"general" as const,
          dedupeKey:`sourcing:${sourcingCaseId}:${correcting?"ie_quote":"correction"}:${before.version+1}`};
        if (correcting) await this.todoProjection?.actionableForAllAssignedRole(client,actor,projection);
        else {
          await this.todoProjection?.actionableForNamedRecipient?.(client,actor,{...projection,recipientUserId:await effectiveSourcingMerchandiser(client,sourcingCaseId,source.created_by)??fail("当前主跟单缺失",409,"CONFLICT")});
          if (source.additional_merchandiser_user_id) await this.todoProjection?.information(client,actor,{
            category:"sourcing_merchandiser_correction",sourceEventId:eventId,sourceAction:scope,
            entityType:"sourcing_case",entityId:sourcingCaseId,recipientUserId:source.additional_merchandiser_user_id,
            route:{routeName:"sourcing_detail",entityId:sourcingCaseId},
            dedupeKey:`sourcing:${sourcingCaseId}:correction-info:${before.version+1}:${source.additional_merchandiser_user_id}`,
          });
        }
        return {statusCode:200,response:await this.readCase(client,sourcingCaseId,actor)};
      });
      await client.query("COMMIT");return {value:result.response,reused:result.reused};
    } catch(error) {await client.query("ROLLBACK").catch(()=>undefined);throw error;}
    finally {client.release();}
  }

  async createCase(
    actor: TrustedActorContext,
    input: CreateSourcingCase,
    idempotencyKey: string,
  ): Promise<Result<SourcingCaseSummary>> {
    this.assertActor(actor, CASE_CREATE_CAPABILITY, CASE_CREATE_ROLE);
    if (input.gender !== "男装" && input.gender !== "女装") fail("请选择男装或女装");
    if (!sourcingDatesValid(input.estimatedCutPieceSendDate,input.deliveryDate)) fail(SOURCING_DATE_ORDER_ERROR);
    const styleName = normalizeText(input.styleName, "款式", 100);
    const lineItems = input.lineItems.map((line, index) => ({
      position: index + 1,
      styleNo: line.styleNo ? normalizeText(line.styleNo, "款号", 100) : null,
      alternateStyleNo: line.alternateStyleNo
        ? normalizeText(line.alternateStyleNo, "代用款号", 100)
        : null,
      color: normalizeText(line.color, "颜色", 100),
      quantity: normalizeQuantity(line.quantity),
      externalUnitPrice: null,
      imageAttachmentId: line.imageAttachmentId ?? null,
      ...(line.lineId ? {lineId:line.lineId}:{}),
      ...(line.factoryDeliveryDate ? {factoryDeliveryDate:line.factoryDeliveryDate}:{}),
    }));
    if (lineItems.some(line => !line.styleNo && !line.alternateStyleNo)) fail("正式款号与代用款号至少填写一个");
    let orderQuantity: number;
    try {
      orderQuantity = calculateSourcingOrderQuantity(lineItems);
    } catch {
      return fail("订单总数量必须是1至10000000之间的整数");
    }
    const normalized = {
      gender: input.gender,
      ...(input.digitalBudget ? { digitalBudget: input.digitalBudget } : {}),
      ...(input.confirmedDuplicateStyles?.length ? {confirmedDuplicateStyles:input.confirmedDuplicateStyles.map(normalizeSourcingStyleNumber)} : {}),
      styleName,
      ...(input.additionalMerchandiserUserId ? {additionalMerchandiserUserId:input.additionalMerchandiserUserId} : {}),
      estimatedCutPieceSendDate: input.estimatedCutPieceSendDate,
      deliveryDate: input.deliveryDate,
      lineItems,
      orderQuantity,
      daxingUnitPrice: normalizeSourcingUnitPrice(input.daxingUnitPrice),
      attachmentIds: [...(input.attachmentIds ?? [])],
    };
    if (lineItems.some(line => line.imageAttachmentId && (!UUID_PATTERN.test(line.imageAttachmentId) || !normalized.attachmentIds.includes(line.imageAttachmentId)))) fail("款图必须包含在订单图片中");
    const scope = "sourcing.case.create";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, {...normalized,confirmedDuplicateStyles:undefined}),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        const digitalLines = await validateBudgetSourcing(client, actor, input);
        if (normalized.additionalMerchandiserUserId) {
          const eligible = await client.query(
            `SELECT 1 FROM app_users person JOIN user_role_assignments assignment
               ON assignment.user_id=person.id AND assignment.role_code='order_merchandiser'
                 AND assignment.revoked_at IS NULL
             WHERE person.id=$1 AND person.id<>$2
               AND todo_user_has_direct_role(person.id,'order_merchandiser','sourcing:contract:record')
               AND todo_user_has_direct_role(person.id,'order_merchandiser','sourcing:view')
               AND todo_user_has_direct_role(person.id,'order_merchandiser','supplier_contract_data:read') LIMIT 1`,
            [normalized.additionalMerchandiserUserId,actor.actorId],
          );
          if (!eligible.rowCount) fail("添加跟单必须是当前有效的其它跟单账号");
        }
        const lineImageIds = normalized.lineItems.flatMap(line => line.imageAttachmentId ? [line.imageAttachmentId] : []);
        if (lineImageIds.length) {
          const contractService = this.contractService ?? fail("款图校验服务暂不可用，请稍后再试",503,"STORAGE_UNAVAILABLE");
          await contractService.validateLineImages(client,actor,lineImageIds);
        }
        const confirmedDuplicates = await this.checkStyleNumbers(client,normalized.lineItems,normalized.confirmedDuplicateStyles);
        await client.query(
          `INSERT INTO sourcing_style_catalog(style_id,style_name,created_by)
           VALUES($1,$2,$3) ON CONFLICT(normalized_name) DO NOTHING`,
          [randomUUID(), normalized.styleName, actor.actorId],
        );
        const style = (await client.query<{ style_id: string; style_name: string }>(
          `SELECT style_id,style_name FROM sourcing_style_catalog WHERE normalized_name=lower(btrim($1))`,
          [normalized.styleName],
        )).rows[0]!;
        const sourcingCaseId = randomUUID();
        const auditedCreationFacts = {
          ...(input.digitalBudget ? { digitalBudget: input.digitalBudget } : {}),
          erpOrderNo: sourcingCaseId,
          erpOrderId: sourcingCaseId,
          gender: normalized.gender,
          styleId: style.style_id,
          styleName: style.style_name,
          estimatedCutPieceSendDate: normalized.estimatedCutPieceSendDate,
          deliveryDate: normalized.deliveryDate,
          lineItems: normalized.lineItems,
          orderQuantity: normalized.orderQuantity,
          attachmentIds: normalized.attachmentIds,
          daxingUnitPriceRecorded: true,
          ...(normalized.additionalMerchandiserUserId ? {additionalMerchandiserUserId:normalized.additionalMerchandiserUserId} : {}),
          pricingOrigin: "ie",
          confirmedDuplicateStyles: confirmedDuplicates,
        };
        const eventId = await this.events.append(client, actor, {
          action: "sourcing.case.create",
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          after: {
            ...auditedCreationFacts,
            processes: [],
            processItems: null,
            processDescription: null,
            crafts: [],
            laneKey: LANE_KEY,
            status: "pending_ie_quote",
            attachmentCount: normalized.attachmentIds.length,
            attachmentIds: normalized.attachmentIds,
          },
          reason: DEFAULT_CREATION_REASON,
        });
        await client.query(
          `INSERT INTO sourcing_cases(
             sourcing_case_id,erp_order_id,erp_order_no,style_no,lane_key,
             order_quantity,delivery_date,process_description,process_items,
             created_by,operation_event_id,request_id,creation_reason,daxing_unit_price,
             estimated_cut_piece_send_date,gender,style_id,style_name_snapshot${normalized.additionalMerchandiserUserId ? ',additional_merchandiser_user_id' : ''}${input.digitalBudget ? ',workflow_generation' : ''}
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18${normalized.additionalMerchandiserUserId ? ',$19' : ''}${input.digitalBudget ? (normalized.additionalMerchandiserUserId ? ',$20' : ',$19') : ''})`,
          [
            sourcingCaseId,
            sourcingCaseId,
            sourcingCaseId,
            normalized.lineItems[0]!.styleNo ?? normalized.lineItems[0]!.alternateStyleNo,
            LANE_KEY,
            normalized.orderQuantity,
            normalized.deliveryDate,
            null,
            null,
            actor.actorId,
            eventId,
            actor.requestId,
            DEFAULT_CREATION_REASON,
            normalized.daxingUnitPrice,
            normalized.estimatedCutPieceSendDate,
            normalized.gender,style.style_id,style.style_name,
            ...(normalized.additionalMerchandiserUserId ? [normalized.additionalMerchandiserUserId] : []),
            ...(input.digitalBudget ? ["digital_production_v1"] : []),
          ],
        );
        for (const line of normalized.lineItems) {
          await client.query(
            `INSERT INTO sourcing_case_lines(
               sourcing_case_id,position,style_no,alternate_style_no,color,quantity,
               external_unit_price,legacy_source,created_by,operation_event_id,request_id,image_attachment_id
             ) VALUES($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10,$11)`,
            [
              sourcingCaseId,
              line.position,
              line.styleNo,
              line.alternateStyleNo,
              line.color,
              line.quantity,
              line.externalUnitPrice,
              actor.actorId,
              eventId,
              actor.requestId,
              line.imageAttachmentId,
            ],
          );
        }
        if (normalized.attachmentIds.length > 0) {
          const images = await client.query<{ attachment_id: string }>(
            `SELECT attachment_id
             FROM attachments
             WHERE attachment_id=ANY($1::uuid[]) AND uploaded_by=$2
               AND status='ready' AND entity_type IS NULL AND entity_id IS NULL
               AND mime_type IN ('image/jpeg','image/png','image/webp')
             FOR UPDATE`,
            [normalized.attachmentIds, actor.actorId],
          );
          if (images.rows.length !== normalized.attachmentIds.length) {
            fail("订单图片必须已上传完成、属于当前账号且尚未绑定");
          }
          await client.query(
            `SELECT set_config('dx_rework.sourcing_event_id',$1,true),
                    set_config('dx_rework.sourcing_request_id',$2,true)`,
            [eventId, actor.requestId],
          );
          await client.query(
            `UPDATE attachments
             SET entity_type='sourcing_case',entity_id=$2,updated_at=CURRENT_TIMESTAMP
             WHERE attachment_id=ANY($1::uuid[])`,
            [normalized.attachmentIds, sourcingCaseId],
          );
        }
        await client.query(
          `INSERT INTO sourcing_case_transitions(
             sourcing_transition_id,sourcing_case_id,sequence,from_status,to_status,
             business_action,transition_reason,actor_id,operation_event_id,request_id
           ) VALUES($1,$2,1,NULL,'pending_ie_quote','created',$3,$4,$5,$6)`,
          [
            randomUUID(),
            sourcingCaseId,
            DEFAULT_CREATION_REASON,
            actor.actorId,
            eventId,
            actor.requestId,
          ],
        );
        await bindBudgetSourcing(client, this.database, actor, input, sourcingCaseId, digitalLines);
        if(digitalLines) await syncFactoryPoNumbers(client,sourcingCaseId,input);
        await this.todoProjection?.actionableForAllAssignedRole(client, actor, {
          category: "sourcing_ie_quote",
          sourceEventId: eventId,
          sourceAction: "sourcing.case.create",
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          requiredRole: IE_QUOTE_ROLE,
          requiredCapability: IE_QUOTE_CAPABILITY,
          route: { routeName: "sourcing_detail", entityId: sourcingCaseId },
          policyKey: "general",
          dedupeKey: `sourcing:${sourcingCaseId}:ie_quote:1`,
        });
        return { statusCode: 201, response: await this.readCase(client, sourcingCaseId, actor) };
      });
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (databaseCode(error) === "23505") {
        fail("该平台订单已经创建过外发定价选厂询价", 409, "CONFLICT");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async correctBudgetPrice(
    actor: TrustedActorContext,
    sourcingCaseId: string,
    input: CorrectSourcingBudgetPrice,
    idempotencyKey: string,
  ): Promise<Result<SourcingCaseSummary>> {
    if (
      actor.authorizationCapability !== CASE_CREATE_CAPABILITY
      || !actor.actorRoles.includes(ROOT_ROLE)
    ) {
      fail("只有超级用户可以更正预算价", 403, "FORBIDDEN");
    }
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    const parsedPrice = SourcingNewUnitPriceSchema.safeParse(input.daxingUnitPrice);
    const parsedPriceValue = parsedPrice.success
      ? parsedPrice.data
      : fail(parsedPrice.error.issues[0]?.message ?? "预算价无效");
    const nextPrice = normalizeSourcingUnitPrice(parsedPriceValue);
    const reason = normalizeText(input.reason, "更正原因", 500);
    const scope = "sourcing.budget_price.correct";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, { sourcingCaseId, daxingUnitPrice: nextPrice, reason }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        const current = await client.query<{
          status: string;
          current_price: string | null;
          correction_version: number | string;
          approved: boolean;
        }>(
          `SELECT current_transition.to_status AS status,
                  COALESCE((SELECT correction.new_unit_price FROM sourcing_budget_price_corrections correction
                    WHERE correction.sourcing_case_id=source_case.sourcing_case_id
                    ORDER BY correction.correction_version DESC LIMIT 1),source_case.daxing_unit_price)::text AS current_price,
                  COALESCE((SELECT max(correction.correction_version) FROM sourcing_budget_price_corrections correction
                    WHERE correction.sourcing_case_id=source_case.sourcing_case_id),0) AS correction_version,
                  EXISTS(SELECT 1 FROM sourcing_approval_snapshots approval
                    WHERE approval.sourcing_case_id=source_case.sourcing_case_id) AS approved
           FROM sourcing_cases source_lock
           CROSS JOIN LATERAL sourcing_case_facts_at(source_lock.sourcing_case_id) source_case
           JOIN LATERAL (
             SELECT transition_row.to_status FROM sourcing_case_transitions transition_row
             WHERE transition_row.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY transition_row.sequence DESC LIMIT 1
           ) current_transition ON true
           WHERE source_case.sourcing_case_id=$1 AND source_case.deleted_at IS NULL
           FOR UPDATE OF source_lock`,
          [sourcingCaseId],
        );
        const source = current.rows[0] ?? fail("报价选厂询价不存在", 404, "NOT_FOUND");
        if (source.approved || !["pending_ie_quote","pending_management_decision","pending_owner_approval"].includes(source.status)) {
          fail("老板已批准，订单数字已锁定", 409, "INVALID_STATE_TRANSITION");
        }
        const currentPrice = source.current_price
          ?? fail("该订单没有可更正的预算价", 409, "INVALID_STATE_TRANSITION");
        if (normalizeSourcingUnitPrice(currentPrice) === nextPrice) fail("新预算价与当前预算价相同");
        const correctionVersion = Number(source.correction_version) + 1;
        const eventId = await this.events.append(client, actor, {
          action: "sourcing.budget_price.correct",
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          before: { budgetPriceRecorded: true },
          after: { budgetPriceCorrected: true, correctionVersion },
          reason,
        });
        await client.query(
          `INSERT INTO sourcing_budget_price_corrections(
             correction_id,sourcing_case_id,correction_version,old_unit_price,new_unit_price,
             reason,corrected_by,operation_event_id,request_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [randomUUID(),sourcingCaseId,correctionVersion,currentPrice,nextPrice,reason,actor.actorId,eventId,actor.requestId],
        );
        return { statusCode: 200, response: await this.readCase(client, sourcingCaseId, actor) };
      });
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertCurrentTransferBasis(client:PoolClient,caseId:string,decisionId:string):Promise<void> {
    const stale=await client.query(`SELECT 1 FROM sourcing_decisions d JOIN sourcing_case_transitions t ON t.sourcing_case_id=d.sourcing_case_id
      WHERE d.sourcing_decision_id=$2 AND t.sourcing_case_id=$1 AND t.business_action='returned_to_merchandiser' AND t.transitioned_at>=d.decided_at LIMIT 1`,[caseId,decisionId]);
    if(stale.rowCount) fail("订单已退回修改，请完成重新选厂后再发起转厂",409,"INVALID_STATE_TRANSITION");
  }

  private async assertValidOrderDates(client: PoolClient, sourcingCaseId: string):Promise<void> {
    const dates=(await client.query<{send:string|null;delivery:string|null}>(
      "SELECT estimated_cut_piece_send_date::text AS send,delivery_date::text AS delivery FROM sourcing_case_facts_at($1)",[sourcingCaseId])).rows[0];
    if (dates && !sourcingDatesValid(dates.send,dates.delivery)) fail(SOURCING_DATE_ORDER_ERROR);
  }

  async quoteIePrice(
    actor: TrustedActorContext,
    sourcingCaseId: string,
    input: CreateSourcingIeQuote,
    idempotencyKey: string,
  ): Promise<Result<SourcingCaseSummary>> {
    this.assertActor(actor, IE_QUOTE_CAPABILITY, IE_QUOTE_ROLE);
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    const normalized = {
      linePrices: (input.linePrices ?? [{ position: 1, unitPrice: input.unitPrice! }]).map((line) => ({
        position: line.position,
        unitPrice: normalizeSourcingUnitPrice(line.unitPrice),
      })).sort((left, right) => left.position - right.position),
      quoteReason: input.quoteReason?.trim() || DEFAULT_QUOTE_REASON,
    };
    if (normalized.quoteReason.length > 500) fail("价格说明不能超过500个字符");
    const scope = "sourcing.ie-price.quote";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, { sourcingCaseId, ...normalized }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        const current = await client.query<{
          order_quantity: number | string;
          status: string;
          sequence: number | string;
          quote_version: number | string;
        }>(
          `SELECT source_case.order_quantity,current_transition.to_status AS status,
                  current_transition.sequence,
                  COALESCE((
                    SELECT max(quote.quote_version)
                    FROM sourcing_ie_quotes quote
                    WHERE quote.sourcing_case_id=source_case.sourcing_case_id
                  ),0) AS quote_version
           FROM sourcing_cases source_lock
           CROSS JOIN LATERAL sourcing_case_facts_at(source_lock.sourcing_case_id) source_case
           JOIN LATERAL (
             SELECT transition_row.to_status,transition_row.sequence
             FROM sourcing_case_transitions transition_row
             WHERE transition_row.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY transition_row.sequence DESC
             LIMIT 1
           ) current_transition ON true
           WHERE source_case.sourcing_case_id=$1
             AND source_case.deleted_at IS NULL
           FOR UPDATE OF source_lock`,
          [sourcingCaseId],
        );
        await this.assertValidOrderDates(client,sourcingCaseId);
        const source = current.rows[0];
        if (!source) return fail("报价选厂询价不存在", 404, "NOT_FOUND");
        if (source.status !== "pending_ie_quote") {
          fail("该询价已完成 IE 报价，请刷新后查看", 409, "INVALID_STATE_TRANSITION");
        }
        const caseLines = await client.query<{ position: number; quantity: number | string }>(
          `SELECT position,quantity FROM current_sourcing_case_lines
           WHERE sourcing_case_id=$1 ORDER BY position`,
          [sourcingCaseId],
        );
        if (caseLines.rows.length !== normalized.linePrices.length
          || caseLines.rows.some((line, index) => line.position !== normalized.linePrices[index]?.position)) {
          fail("IE 必须逐款填写全部价格，不能缺行或增加行");
        }
        const pricedLines = caseLines.rows.map((line, index) => ({
          position: line.position,
          quantity: Number(line.quantity),
          unitPrice: normalized.linePrices[index]!.unitPrice,
          totalAmount: calculateSourcingTotal(normalized.linePrices[index]!.unitPrice, Number(line.quantity)),
        }));
        const quantity = Number(source.order_quantity);
        const quoteVersion = Number(source.quote_version) + 1;
        const transitionSequence = Number(source.sequence) + 1;
        const totalAmount = calculateSourcingLinesTotalExact(pricedLines);
        const compatibilityUnitPrice = pricedLines[0]!.unitPrice;
        const quoteId = randomUUID();
        const eventId = await this.events.append(client, actor, {
          action: "sourcing.ie_price.quote",
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          before: { status: "pending_ie_quote" },
          after: {
            status: "pending_management_decision",
            quoteVersion,
            linePrices: pricedLines,
            quantity,
            totalAmount,
          },
          reason: normalized.quoteReason,
        });
        await client.query(
          `INSERT INTO sourcing_ie_quotes(
             sourcing_ie_quote_id,sourcing_case_id,quote_version,unit_price,
             quantity,total_amount,quote_reason,quoted_by,operation_event_id,
             request_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            quoteId,
            sourcingCaseId,
            quoteVersion,
            compatibilityUnitPrice,
            quantity,
            totalAmount,
            normalized.quoteReason,
            actor.actorId,
            eventId,
            actor.requestId,
          ],
        );
        for (const line of pricedLines) {
          await client.query(
            `INSERT INTO sourcing_ie_quote_lines(
               sourcing_ie_quote_id,sourcing_case_id,position,quantity,unit_price,total_amount
             ) VALUES($1,$2,$3,$4,$5,$6)`,
            [quoteId,sourcingCaseId,line.position,line.quantity,line.unitPrice,line.totalAmount],
          );
        }
        await client.query(
          `INSERT INTO sourcing_case_transitions(
             sourcing_transition_id,sourcing_case_id,sequence,from_status,to_status,
             business_action,transition_reason,actor_id,operation_event_id,request_id
           ) VALUES($1,$2,$3,'pending_ie_quote','pending_management_decision',
             'ie_price_quoted',$4,$5,$6,$7)`,
          [
            randomUUID(),
            sourcingCaseId,
            transitionSequence,
            normalized.quoteReason,
            actor.actorId,
            eventId,
            actor.requestId,
          ],
        );
        await this.todoProjection?.completeOpenByDedupePrefix(
          client,
          actor,
          `sourcing:${sourcingCaseId}:ie_quote:`,
          "IE 报价已完成",
        );
        await this.todoProjection?.actionableForAllAssignedRole(client, actor, {
          category: "sourcing_management_decision",
          sourceEventId: eventId,
          sourceAction: "sourcing.ie_price.quote",
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          requiredRole: MANAGEMENT_DECISION_ROLE,
          requiredCapability: MANAGEMENT_DECISION_CAPABILITY,
          route: { routeName: "sourcing_detail", entityId: sourcingCaseId },
          policyKey: "general",
          // Quote and decision versions are independent; identify the actual node entry.
          dedupeKey: `sourcing:${sourcingCaseId}:management:transition:${transitionSequence}`,
        });
        return { statusCode: 201, response: await this.readCase(client, sourcingCaseId, actor) };
      });
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (databaseCode(error) === "23514" || databaseCode(error) === "23505") {
        fail("本次报价未通过系统业务校验，具体是资料冲突还是状态变化尚未确认；请IE重新读取本单报价节点，仍失败时提供订单链接给管理员核查", 409, "INVALID_STATE_TRANSITION");
      }
      throw error;
    } finally {
      client.release();
    }
  }
  async recordManagementDecision(
    actor: TrustedActorContext,
    sourcingCaseId: string,
    input: RecordSourcingManagementDecision,
    idempotencyKey: string,
  ): Promise<Result<SourcingCaseSummary>> {
    this.assertActor(
      actor,
      MANAGEMENT_DECISION_CAPABILITY,
      MANAGEMENT_DECISION_ROLE,
    );
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    const craftIds = [...(input.craftIds ?? [])];
    if (craftIds.length < 1 || craftIds.length > 20 || new Set(craftIds).size !== craftIds.length
      || craftIds.some((id) => !UUID_PATTERN.test(id))) fail("请选择工艺及承包范围，最多20项且不能重复");
    const requestedLinePrices = (input.linePrices ?? [{ position: 1, unitPrice: input.unitPrice! }]).map((line) => ({
      position: line.position,
      unitPrice: normalizeSourcingUnitPrice(line.unitPrice),
    })).sort((left, right) => left.position - right.position);
    const suppliedReason = input.decisionReason?.trim() ?? "";
    const cuttingProcess = input.cuttingProcess ?? null;
    const cuttingProcessOther = input.cuttingProcessOther?.trim() || null;
    if (cuttingProcess !== null && !["in_house", "outsourced", "other"].includes(cuttingProcess)) fail("裁床工序无效");
    if (cuttingProcess === "other" ? !cuttingProcessOther || cuttingProcessOther.length > 100 : cuttingProcessOther !== null) {
      fail("选择其它时请填写100字以内的裁床工序；其他选项不能填写说明");
    }
    const scope = "sourcing.management-decision.record";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, {
          sourcingCaseId,
          supplierId: input.supplierId,
          craftIds,
          linePrices: requestedLinePrices,
          decisionReason: suppliedReason,
          cuttingProcess,cuttingProcessOther,
        }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        const current = await client.query<{
          order_quantity: number | string;
          status: string;
          sequence: number | string;
          sourcing_ie_quote_id: string | null;
          quote_unit_price: string | null;
          sourcing_decision_id: string | null;
          decision_version: number | string | null;
          owner_decision: string | null;
        }>(
          `SELECT source_case.order_quantity,current_transition.to_status AS status,
                  current_transition.sequence,quote_row.sourcing_ie_quote_id,
                  quote_row.unit_price AS quote_unit_price,
                  decision_row.sourcing_decision_id,decision_row.decision_version,
                  owner_row.decision AS owner_decision
           FROM sourcing_cases source_lock
           CROSS JOIN LATERAL sourcing_case_facts_at(source_lock.sourcing_case_id) source_case
           JOIN LATERAL (
             SELECT transition_row.to_status,transition_row.sequence
             FROM sourcing_case_transitions transition_row
             WHERE transition_row.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY transition_row.sequence DESC
             LIMIT 1
           ) current_transition ON true
           LEFT JOIN LATERAL (
             SELECT quote.*
             FROM sourcing_ie_quotes quote
             WHERE quote.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY quote.quote_version DESC
             LIMIT 1
           ) quote_row ON true
           LEFT JOIN LATERAL (
             SELECT decision_fact.*
             FROM sourcing_decisions decision_fact
             WHERE decision_fact.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY decision_fact.decision_version DESC
             LIMIT 1
           ) decision_row ON true
           LEFT JOIN sourcing_owner_decisions owner_row
             ON owner_row.sourcing_decision_id=decision_row.sourcing_decision_id
           WHERE source_case.sourcing_case_id=$1
             AND source_case.deleted_at IS NULL
           FOR UPDATE OF source_lock`,
          [sourcingCaseId],
        );
        const generation=(await client.query("SELECT to_jsonb(sourcing_cases)->>'workflow_generation' AS generation FROM sourcing_cases WHERE sourcing_case_id=$1",[sourcingCaseId])).rows[0]?.generation;
        if(generation==='digital_production_v1'&&!['in_house','outsourced'].includes(cuttingProcess??''))fail('新数字母单请明确选择本厂裁或外厂裁');
        await this.assertValidOrderDates(client,sourcingCaseId);
        const source = current.rows[0];
        if (!source) return fail("报价选厂询价不存在", 404, "NOT_FOUND");
        if (source.status !== "pending_management_decision") {
          fail("该询价当前不在供应链总监调价选厂阶段", 409, "INVALID_STATE_TRANSITION");
        }
        const sourceIeQuoteId = source.sourcing_ie_quote_id;
        const quoteUnitPrice = source.quote_unit_price;
        if (!sourceIeQuoteId || !quoteUnitPrice) {
          return fail("供应链总监决定必须引用当前 IE 报价", 409, "INVALID_STATE_TRANSITION");
        }
        if (source.sourcing_decision_id && source.owner_decision !== "rejected" && !(await client.query(
          `SELECT 1 FROM sourcing_case_corrections correction JOIN sourcing_ie_quotes quote ON quote.sourcing_ie_quote_id=$2
           JOIN sourcing_decisions decision ON decision.sourcing_decision_id=$3
           WHERE correction.sourcing_case_id=$1 AND correction.corrected_at>=decision.decided_at AND correction.corrected_at<=quote.quoted_at`,
          [sourcingCaseId,sourceIeQuoteId,source.sourcing_decision_id])).rowCount) {
          fail("只有老板驳回后才能提交新版本", 409, "INVALID_STATE_TRANSITION");
        }
        const quoteLines = await client.query<{
          position: number;
          quantity: number | string;
          unit_price: string;
        }>(
          `SELECT position,quantity,unit_price::text AS unit_price
           FROM sourcing_ie_quote_lines
           WHERE sourcing_ie_quote_id=$1 ORDER BY position`,
          [sourceIeQuoteId],
        );
        if (quoteLines.rows.length !== requestedLinePrices.length
          || quoteLines.rows.some((line, index) => line.position !== requestedLinePrices[index]?.position)) {
          fail("供应链总监必须逐款确认全部价格，不能缺行或增加行");
        }
        const pricedLines = quoteLines.rows.map((line, index) => ({
          position: line.position,
          quantity: Number(line.quantity),
          unitPrice: requestedLinePrices[index]!.unitPrice,
          totalAmount: calculateSourcingTotal(requestedLinePrices[index]!.unitPrice, Number(line.quantity)),
        }));
        if (!UUID_PATTERN.test(input.supplierId)) fail("加工厂标识无效");
        const factory = await client.query<{
          supplier_id: string;
          supplier_code: string;
          supplier_name: string;
        }>(
          `SELECT supplier_id,supplier_code,supplier_name
           FROM current_supplier_catalog
           WHERE supplier_id=$1 AND supplier_type='factory' AND active=true`,
          [input.supplierId],
        );
        const selected = factory.rows[0]
          ?? fail("请选择当前有效的加工厂", 400, "VALIDATION_ERROR");
        const increased = quoteLines.rows.some((line, index) => (
          scaledUnitPrice(pricedLines[index]!.unitPrice) > scaledUnitPrice(line.unit_price)
        ));
        if (increased && !suppliedReason) {
          fail("价格高于 IE，请填写原因");
        }
        const selectedCrafts = (await client.query<{
              position: number;
              craft_id: string;
              craft_code: string;
              craft_version: number;
              craft_name: string;
            }>(
              `SELECT requested.position::integer AS position,
                      item.craft_id,item.craft_code,
                      version.version AS craft_version,version.craft_name
               FROM unnest($1::uuid[]) WITH ORDINALITY requested(craft_id,position)
               JOIN craft_catalog_items item ON item.craft_id=requested.craft_id
               JOIN LATERAL (
                 SELECT history.version,history.craft_name,history.active
                 FROM craft_catalog_versions history
                 WHERE history.craft_id=item.craft_id
                 ORDER BY history.version DESC
                 LIMIT 1
               ) version ON version.active
               ORDER BY requested.position`,
              [craftIds],
            )).rows.map((craft) => ({
              position: craft.position,
              craftId: craft.craft_id,
              craftCode: craft.craft_code,
              craftVersion: craft.craft_version,
              craftName: craft.craft_name,
            }));
        if (selectedCrafts.length !== craftIds.length) {
          fail("所选工艺已停用或不存在，请重新选择", 409, "CONFLICT");
        }
        const decisionReason = suppliedReason || DEFAULT_MANAGEMENT_REASON;
        if (decisionReason.length > 500) fail("选厂说明不能超过500个字符");
        const quantity = Number(source.order_quantity);
        const totalAmount = calculateSourcingLinesTotalExact(pricedLines);
        const compatibilityUnitPrice = pricedLines[0]!.unitPrice;
        const decisionId = randomUUID();
        const decisionVersion = Number(source.decision_version ?? 0) + 1;
        const sourceType = source.sourcing_decision_id ? "management_revision" : "initial";
        const transitionSequence = Number(source.sequence) + 1;
        const eventId = await this.events.append(client, actor, {
          action: "sourcing.management_decision.record",
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          before: {
            status: "pending_management_decision",
            previousDecisionId: source.sourcing_decision_id,
          },
          after: {
            status: "pending_owner_approval",
            decisionId,
            decisionVersion,
            sourceType,
            sourceIeQuoteId,
            supplierId: selected.supplier_id,
            supplierCode: selected.supplier_code,
            supplierName: selected.supplier_name,
            crafts: selectedCrafts,
            cuttingProcess,cuttingProcessOther,
            linePrices: pricedLines,
            quantity,
            totalAmount,
          },
          reason: decisionReason,
        });
        await client.query(
          `INSERT INTO sourcing_decisions(
             sourcing_decision_id,sourcing_case_id,decision_version,source_type,
             source_ie_quote_id,supersedes_decision_id,source_change_request_id,
             supplier_id,supplier_code_snapshot,supplier_name_snapshot,
             unit_price,quantity,total_amount,decision_reason,decided_by,
             operation_event_id,request_id,crafts,cutting_process,cutting_process_other
           ) VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19)`,
          [
            decisionId,
            sourcingCaseId,
            decisionVersion,
            sourceType,
            sourceIeQuoteId,
            source.sourcing_decision_id,
            selected.supplier_id,
            selected.supplier_code,
            selected.supplier_name,
            compatibilityUnitPrice,
            quantity,
            totalAmount,
            decisionReason,
            actor.actorId,
            eventId,
            actor.requestId,
            JSON.stringify(selectedCrafts),
            cuttingProcess,cuttingProcessOther,
          ],
        );
        for (const line of pricedLines) {
          await client.query(
            `INSERT INTO sourcing_decision_lines(
               sourcing_decision_id,sourcing_case_id,position,quantity,unit_price,total_amount
             ) VALUES($1,$2,$3,$4,$5,$6)`,
            [decisionId,sourcingCaseId,line.position,line.quantity,line.unitPrice,line.totalAmount],
          );
        }
        await client.query(
          `INSERT INTO sourcing_case_transitions(
             sourcing_transition_id,sourcing_case_id,sequence,from_status,to_status,
             business_action,transition_reason,actor_id,operation_event_id,request_id
           ) VALUES($1,$2,$3,'pending_management_decision','pending_owner_approval',
             'management_decision_recorded',$4,$5,$6,$7)`,
          [
            randomUUID(),
            sourcingCaseId,
            transitionSequence,
            decisionReason,
            actor.actorId,
            eventId,
            actor.requestId,
          ],
        );
        await this.todoProjection?.completeOpenByDedupePrefix(
          client,
          actor,
          `sourcing:${sourcingCaseId}:management:`,
          "供应链总监已完成调价选厂",
        );
        await this.todoProjection?.actionableForAllAssignedRole(client, actor, {
          category: "sourcing_owner_approval",
          sourceEventId: eventId,
          sourceAction: "sourcing.management_decision.record",
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          requiredRole: OWNER_DECISION_ROLE,
          requiredCapability: OWNER_DECISION_CAPABILITY,
          route: { routeName: "sourcing_detail", entityId: sourcingCaseId },
          policyKey: "general",
          dedupeKey: `sourcing:${sourcingCaseId}:owner:${decisionVersion}`,
        });
        return { statusCode: 201, response: await this.readCase(client, sourcingCaseId, actor) };
      });
      await syncBulkSourcing(client,this.database,actor,sourcingCaseId);
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async decideOwner(
    actor: TrustedActorContext,
    sourcingCaseId: string,
    input: DecideSourcingOwner,
    idempotencyKey: string,
  ): Promise<Result<SourcingCaseSummary>> {
    this.assertActor(actor, OWNER_DECISION_CAPABILITY, OWNER_DECISION_ROLE);
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    const suppliedReason = input.decisionReason?.trim() ?? "";
    const decisionReason = suppliedReason || (
      input.decision === "approved"
        ? DEFAULT_OWNER_APPROVAL_REASON
        : DEFAULT_OWNER_REJECTION_REASON
    );
    if (decisionReason.length > 500) fail("审批说明不能超过500个字符");
    const scope = `sourcing.owner.${input.decision}`;
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, {
          sourcingCaseId,
          decision: input.decision,
          decisionReason,
        }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        const current = await client.query<{
          status: string;
          sequence: number | string;
          created_by: string;
          additional_merchandiser_user_id: string | null;
          sourcing_decision_id: string | null;
          decision_version: number | string | null;
          source_type: string | null;
          supplier_id: string | null;
          supplier_code_snapshot: string | null;
          supplier_name_snapshot: string | null;
          quantity: number | string | null;
          daxing_unit_price: string | null;
          estimated_cut_piece_send_date: string | null;
          delivery_date: string | null;
          process_items: string[] | null;
          gender: "男装" | "女装" | null;
          style_name_snapshot: string | null;
        }>(
          `SELECT current_transition.to_status AS status,current_transition.sequence,
                  source_case.created_by,
                  nullif(to_jsonb(source_lock)->>'additional_merchandiser_user_id','')::uuid AS additional_merchandiser_user_id,
                  decision_row.sourcing_decision_id,decision_row.decision_version,
                  decision_row.source_type,decision_row.supplier_id,
                  decision_row.supplier_code_snapshot,decision_row.supplier_name_snapshot,
                  decision_row.quantity,COALESCE((
                    SELECT correction.new_unit_price FROM sourcing_budget_price_corrections correction
                    WHERE correction.sourcing_case_id=source_case.sourcing_case_id
                    ORDER BY correction.correction_version DESC LIMIT 1
                  ),source_case.daxing_unit_price)::text AS daxing_unit_price,
                  source_case.estimated_cut_piece_send_date::text AS estimated_cut_piece_send_date,
                  COALESCE((SELECT (proposal.after_state->>'deliveryDate')::date
                    FROM sourcing_factory_change_requests request_row
                    JOIN operation_events proposal ON proposal.event_id=request_row.operation_event_id
                    WHERE request_row.factory_change_request_id=decision_row.source_change_request_id),
                    sourcing_effective_delivery_date(source_case.sourcing_case_id,source_case.delivery_date))::text AS delivery_date,
                  source_case.gender,source_case.style_name_snapshot,
                  CASE WHEN decision_row.crafts IS NULL THEN source_case.process_items
                    ELSE ARRAY(SELECT craft->>'craftName' FROM jsonb_array_elements(decision_row.crafts) craft) END AS process_items
           FROM sourcing_cases source_lock
           CROSS JOIN LATERAL sourcing_case_facts_at(source_lock.sourcing_case_id) source_case
           JOIN LATERAL (
             SELECT transition_row.to_status,transition_row.sequence
             FROM sourcing_case_transitions transition_row
             WHERE transition_row.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY transition_row.sequence DESC
             LIMIT 1
           ) current_transition ON true
           LEFT JOIN LATERAL (
             SELECT decision_fact.*
             FROM sourcing_decisions decision_fact
             WHERE decision_fact.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY decision_fact.decision_version DESC
             LIMIT 1
           ) decision_row ON true
           WHERE source_case.sourcing_case_id=$1
             AND source_case.deleted_at IS NULL
           FOR UPDATE OF source_lock`,
          [sourcingCaseId],
        );
        if(input.decision === "approved") await this.assertValidOrderDates(client,sourcingCaseId);
        const source = current.rows[0];
        if (!source) return fail("报价选厂询价不存在", 404, "NOT_FOUND");
        if (
          source.status !== "pending_owner_approval"
          || !source.sourcing_decision_id
        ) {
          fail("该询价当前不在老板终审阶段", 409, "INVALID_STATE_TRANSITION");
        }
        const approved = input.decision === "approved";
        const eventId = await this.events.append(client, actor, {
          action: approved ? "sourcing.owner.approve" : "sourcing.owner.reject",
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          before: {
            status: "pending_owner_approval",
            decisionId: source.sourcing_decision_id,
            decisionVersion: Number(source.decision_version),
          },
          after: {
            status: approved ? "pending_finance_reconciliation" : "pending_management_decision",
            decision: input.decision,
            deliveryDate: source.delivery_date,
          },
          reason: decisionReason,
        });
        const ownerDecisionId = randomUUID();
        await client.query(
          `INSERT INTO sourcing_owner_decisions(
             sourcing_owner_decision_id,sourcing_case_id,sourcing_decision_id,
             decision,decision_reason,decided_by,operation_event_id,request_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            ownerDecisionId,
            sourcingCaseId,
            source.sourcing_decision_id,
            input.decision,
            decisionReason,
            actor.actorId,
            eventId,
            actor.requestId,
          ],
        );
        if (approved) {
          if (!source.supplier_id || !source.supplier_code_snapshot
            || !source.supplier_name_snapshot || source.quantity === null) {
            fail("批准快照缺少当前选厂事实；请生产管理在本单报价选厂页核对原选厂方案，由Root核查关联，不要重复批准或自动另选工厂", 409, "INVALID_STATE_TRANSITION");
          }
          const snapshotId = randomUUID();
          const snapshotTotal = await client.query<{ total_amount: string }>(
            `SELECT sum(total_amount)::text AS total_amount
             FROM sourcing_decision_lines WHERE sourcing_decision_id=$1`,
            [source.sourcing_decision_id],
          );
          const totalAmount = snapshotTotal.rows[0]?.total_amount;
          if (!totalAmount) fail("批准快照缺少逐款价格；请生产管理和老板在本单原方案核对价格依据，由Root核查快照，不得补零价或重算历史批准价", 409, "INVALID_STATE_TRANSITION");
          await client.query(
            `INSERT INTO sourcing_approval_snapshots(
               sourcing_approval_snapshot_id,sourcing_case_id,sourcing_decision_id,
               decision_version,supplier_id,supplier_code_snapshot,supplier_name_snapshot,
               supplier_address,contract_entity_name,party_b_representative,
               payee_name,bank_account,bank_name,
               quantity,total_amount,daxing_unit_price,estimated_cut_piece_send_date,
               delivery_date,processes,approved_by,operation_event_id,request_id,gender,style_name_snapshot
             )
             SELECT $1,$2,$3,$4,$5,$6,$7,
                    supplier.address,supplier.contract_entity_name,supplier.party_b_representative,
                    supplier.payee_name,supplier.bank_account,supplier.bank_name,
                    $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
             FROM current_supplier_catalog supplier
             WHERE supplier.supplier_id=$5`,
            [snapshotId,sourcingCaseId,source.sourcing_decision_id,Number(source.decision_version),
              source.supplier_id,source.supplier_code_snapshot,source.supplier_name_snapshot,
              Number(source.quantity),totalAmount,source.daxing_unit_price,
              source.estimated_cut_piece_send_date,source.delivery_date,source.process_items ?? [],
              actor.actorId,eventId,actor.requestId,source.gender,source.style_name_snapshot],
          );
          await client.query(
            `INSERT INTO sourcing_approval_snapshot_lines(
               sourcing_approval_snapshot_id,position,style_no,alternate_style_no,color,
               quantity,unit_price,total_amount
             )
             SELECT $1,line.position,source_line.style_no,source_line.alternate_style_no,
                    source_line.color,line.quantity,line.unit_price,line.total_amount
             FROM sourcing_decision_lines line
             JOIN current_sourcing_case_lines source_line
               ON source_line.sourcing_case_id=$2 AND source_line.position=line.position
             WHERE line.sourcing_decision_id=$3 ORDER BY line.position`,
            [snapshotId,sourcingCaseId,source.sourcing_decision_id],
          );
          if(source.source_type === "factory_change") {
            const request=(await client.query<{id:string}>("SELECT source_change_request_id AS id FROM sourcing_decisions WHERE sourcing_decision_id=$1",[source.sourcing_decision_id])).rows[0]!;
            await approveTransferPoDates(client,actor,sourcingCaseId,request.id,eventId,decisionReason);
          } else await approveFactoryPoDates(client,actor,sourcingCaseId,eventId,decisionReason,false);
          await ensureCuttingOrdersForApproval(client, sourcingCaseId, snapshotId);
          await this.contractService?.prepareForApproval(client, snapshotId, actor);
        }
        await client.query(
          `INSERT INTO sourcing_case_transitions(
             sourcing_transition_id,sourcing_case_id,sequence,from_status,to_status,
             business_action,transition_reason,actor_id,operation_event_id,request_id
           ) VALUES($1,$2,$3,'pending_owner_approval',$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(),
            sourcingCaseId,
            Number(source.sequence) + 1,
            approved ? "pending_finance_reconciliation" : "pending_management_decision",
            approved ? "owner_approved" : "owner_rejected",
            decisionReason,
            actor.actorId,
            eventId,
            actor.requestId,
          ],
        );
        await syncBulkSourcing(client,this.database,actor,sourcingCaseId);
        const decisionVersion = Number(source.decision_version);
        const openFactoryChange = approved
          ? await client.query(
            `SELECT 1
             FROM sourcing_factory_change_requests request_row
             WHERE request_row.sourcing_case_id=$1
               AND NOT EXISTS (
                 SELECT 1 FROM sourcing_decisions effective
                 WHERE effective.source_change_request_id=request_row.factory_change_request_id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM sourcing_factory_change_decisions rejected
                 WHERE rejected.factory_change_request_id=request_row.factory_change_request_id
                   AND rejected.decision='rejected'
               )
             LIMIT 1`,
            [sourcingCaseId],
          )
          : null;
        await this.todoProjection?.completeOpenByDedupePrefix(
          client,
          actor,
          `sourcing:${sourcingCaseId}:owner:${decisionVersion}:`,
          approved ? "老板已批准" : "老板已驳回",
        );
        if (approved) {
          const returnFact = await client.query<{ contract_returned_at: Date | null }>(
            "SELECT contract_returned_at FROM sourcing_contract_return_monitors WHERE sourcing_case_id=$1",
            [sourcingCaseId],
          );
          if (returnFact.rows[0]?.contract_returned_at === null) {
            await this.todoProjection?.completeOpenByDedupePrefix(
              client, actor, `sourcing:${sourcingCaseId}:return:`, "选厂批准版本已更新",
            );
            await this.todoProjection?.actionableForNamedRecipient?.(client, actor, {
              category: "sourcing_contract_return",
              sourceEventId: eventId,
              sourceAction: "sourcing.owner.approve",
              entityType: "sourcing_case",
              entityId: sourcingCaseId,
              recipientUserId: await effectiveSourcingMerchandiser(client,sourcingCaseId,source.created_by)??fail("当前主跟单缺失",409,"CONFLICT"),
              requiredRole: CONTRACT_ROLE,
              requiredCapability: CONTRACT_CAPABILITY,
              route: { routeName: "sourcing_detail", entityId: sourcingCaseId, tab: "contract_return" },
              policyKey: "sourcing_contract_return",
              dedupeKey: `sourcing:${sourcingCaseId}:return:${decisionVersion}`,
            });
            if (source.additional_merchandiser_user_id) await this.todoProjection?.actionableForNamedRecipient?.(client,actor,{
              category:"sourcing_contract_return",sourceEventId:eventId,sourceAction:"sourcing.owner.approve",
              entityType:"sourcing_case",entityId:sourcingCaseId,recipientUserId:source.additional_merchandiser_user_id,
              requiredRole:CONTRACT_ROLE,requiredCapability:CONTRACT_CAPABILITY,
              route:{routeName:"sourcing_detail",entityId:sourcingCaseId,tab:"contract_return"},
              policyKey:"sourcing_contract_return",
              dedupeKey:`sourcing:${sourcingCaseId}:return:${decisionVersion}:${source.additional_merchandiser_user_id}`,
            });
          }
        }
        if (!approved) {
          await this.todoProjection?.actionableForAllAssignedRole(client, actor, {
            category: "sourcing_management_decision",
            sourceEventId: eventId,
            sourceAction: "sourcing.owner.reject",
            entityType: "sourcing_case",
            entityId: sourcingCaseId,
            requiredRole: MANAGEMENT_DECISION_ROLE,
            requiredCapability: MANAGEMENT_DECISION_CAPABILITY,
            route: { routeName: "sourcing_detail", entityId: sourcingCaseId },
            policyKey: "general",
            dedupeKey: `sourcing:${sourcingCaseId}:management:transition:${Number(source.sequence) + 1}`,
          });
        } else if (!openFactoryChange?.rowCount) {
          await this.todoProjection?.actionableForAllAssignedRole(client, actor, {
            category: "sourcing_finance_reconcile",
            sourceEventId: eventId,
            sourceAction: "sourcing.owner.approve",
            entityType: "sourcing_case",
            entityId: sourcingCaseId,
            requiredRole: FINANCE_RECONCILE_ROLE,
            requiredCapability: FINANCE_RECONCILE_CAPABILITY,
            route: { routeName: "sourcing_detail", entityId: sourcingCaseId },
            policyKey: "general",
            dedupeKey: `sourcing:${sourcingCaseId}:finance:${decisionVersion}:1`,
          });
        }
        return { statusCode: 201, response: await this.readCase(client, sourcingCaseId, actor) };
      });
      await client.query("COMMIT");
      if (input.decision === "approved") {
        await this.contractService?.generateIfReady(actor, sourcingCaseId).catch(() => undefined);
      }
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }


  async recordContract(
    actor: TrustedActorContext,
    sourcingCaseId: string,
    input: RecordSourcingContract,
    idempotencyKey: string,
  ): Promise<Result<SourcingCaseSummary>> {
    this.assertActor(actor, CONTRACT_CAPABILITY, CONTRACT_ROLE);
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    const contractReference = normalizeText(input.contractReference, "合同编号", 200);
    const signedOn = input.signedOn.trim();
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(signedOn)
      || Number.isNaN(new Date(`${signedOn}T00:00:00.000Z`).getTime())
      || new Date(`${signedOn}T00:00:00.000Z`).toISOString().slice(0, 10) !== signedOn
    ) fail("合同日期格式无效");
    const executionReason = input.executionReason?.trim() || DEFAULT_CONTRACT_REASON;
    if (executionReason.length > 500) fail("合同说明不能超过500个字符");
    const scope = "sourcing.contract.record";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, {
          sourcingCaseId, contractReference, signedOn, executionReason,
        }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        const current = await client.query<{
          status: string;
          sequence: number | string;
          sourcing_decision_id: string | null;
          decision_version: number | string | null;
          reconciliation_version: number | string;
        }>(
          `SELECT transition_row.to_status AS status,transition_row.sequence,
                  decision_row.sourcing_decision_id,decision_row.decision_version,
                  COALESCE(reconciliation_row.reconciliation_version,0) AS reconciliation_version
           FROM sourcing_cases source_lock
           CROSS JOIN LATERAL sourcing_case_facts_at(source_lock.sourcing_case_id) source_case
           JOIN LATERAL (
             SELECT transition.to_status,transition.sequence
             FROM sourcing_case_transitions transition
             WHERE transition.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY transition.sequence DESC LIMIT 1
           ) transition_row ON true
           LEFT JOIN LATERAL (
             SELECT decision.*
             FROM sourcing_decisions decision
             WHERE decision.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY decision.decision_version DESC LIMIT 1
           ) decision_row ON true
           LEFT JOIN LATERAL (
             SELECT reconciliation.reconciliation_version
             FROM sourcing_finance_reconciliations reconciliation
             WHERE reconciliation.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY reconciliation.reconciliation_version DESC LIMIT 1
           ) reconciliation_row ON true
           WHERE source_case.sourcing_case_id=$1
             AND source_case.deleted_at IS NULL
           FOR UPDATE OF source_lock`,
          [sourcingCaseId],
        );
        const source = current.rows[0];
        if (!source) return fail("报价选厂询价不存在", 404, "NOT_FOUND");
        if (source.status !== "pending_contract" || !source.sourcing_decision_id) {
          fail("该订单当前不在合同登记阶段", 409, "INVALID_STATE_TRANSITION");
        }
        const contractId = randomUUID();
        const eventId = await this.events.append(client, actor, {
          action: "sourcing.contract.record",
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          before: { status: "pending_contract", decisionId: source.sourcing_decision_id },
          after: {
            status: "pending_finance_reconciliation",
            contractId,
            contractReference,
            signedOn,
          },
          reason: executionReason,
        });
        await client.query(
          `INSERT INTO sourcing_contract_executions(
             sourcing_contract_id,sourcing_case_id,sourcing_decision_id,
             contract_reference,signed_on,execution_reason,recorded_by,
             operation_event_id,request_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            contractId,sourcingCaseId,source.sourcing_decision_id,
            contractReference,signedOn,executionReason,actor.actorId,eventId,actor.requestId,
          ],
        );
        await client.query(
          `INSERT INTO sourcing_case_transitions(
             sourcing_transition_id,sourcing_case_id,sequence,from_status,to_status,
             business_action,transition_reason,actor_id,operation_event_id,request_id
           ) VALUES($1,$2,$3,'pending_contract','pending_finance_reconciliation',
             'contract_recorded',$4,$5,$6,$7)`,
          [
            randomUUID(),sourcingCaseId,Number(source.sequence)+1,executionReason,
            actor.actorId,eventId,actor.requestId,
          ],
        );
        await this.todoProjection?.completeOpenByDedupePrefix(
          client,
          actor,
          `sourcing:${sourcingCaseId}:contract:${Number(source.decision_version)}:`,
          "合同已登记",
        );
        const nextReconciliationVersion = Number(source.reconciliation_version)+1;
        await this.todoProjection?.actionableForAllAssignedRole(client, actor, {
          category: "sourcing_finance_reconcile",
          sourceEventId: eventId,
          sourceAction: "sourcing.contract.record",
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          requiredRole: FINANCE_RECONCILE_ROLE,
          requiredCapability: FINANCE_RECONCILE_CAPABILITY,
          route: { routeName: "sourcing_detail", entityId: sourcingCaseId },
          policyKey: "general",
          dedupeKey: `sourcing:${sourcingCaseId}:finance:${Number(source.decision_version)}:${nextReconciliationVersion}`,
        });
        return { statusCode: 201, response: await this.readCase(client, sourcingCaseId, actor) };
      });
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (databaseCode(error) === "23514" || databaseCode(error) === "23505") {
        fail("本次合同登记未通过系统校验；请订单跟单在本单合同办理页重新读取当前批准版本与合同记录，仍无法判断原因时交管理员核查", 409, "INVALID_STATE_TRANSITION");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private factoryChangeInitiator(
    actor: TrustedActorContext,
  ): "order_merchandiser" | "production_management" | "owner_group" {
    if (
      actor.authorizationCapability === FACTORY_CHANGE_REQUEST_CAPABILITY
      && (actor.actorRoles.includes(ROOT_ROLE) || actor.actorRoles.includes(FACTORY_CHANGE_REQUEST_ROLE))
    ) return "order_merchandiser";
    if (
      actor.authorizationCapability === MANAGEMENT_DECISION_CAPABILITY
      && (actor.actorRoles.includes(ROOT_ROLE) || actor.actorRoles.includes(MANAGEMENT_DECISION_ROLE))
    ) return "production_management";
    if (
      actor.authorizationCapability === OWNER_DECISION_CAPABILITY
      && (actor.actorRoles.includes(ROOT_ROLE) || actor.actorRoles.includes(FACTORY_CHANGE_OWNER_ROLE))
    ) return "owner_group";
    return fail("当前岗位无权发起订单转厂", 403, "FORBIDDEN");
  }

  private factoryChangeReviewer(
    actor: TrustedActorContext,
  ): "production_management" | "owner_group" {
    if (
      actor.authorizationCapability === FACTORY_CHANGE_VERIFY_CAPABILITY
      && (actor.actorRoles.includes(ROOT_ROLE) || actor.actorRoles.includes(FACTORY_CHANGE_VERIFY_ROLE))
    ) return "production_management";
    if (
      actor.authorizationCapability === OWNER_DECISION_CAPABILITY
      && (actor.actorRoles.includes(ROOT_ROLE) || actor.actorRoles.includes(FACTORY_CHANGE_OWNER_ROLE))
    ) return "owner_group";
    return fail("当前岗位无权审批订单转厂", 403, "FORBIDDEN");
  }

  private factoryChangeTargetStatus(
    status: string,
    actor: TrustedActorContext,
  ): "pending_owner_approval" | "pending_finance_reconciliation" {
    const ownerAction = actor.authorizationCapability === OWNER_DECISION_CAPABILITY;
    return !ownerAction && (
      status === "pending_management_decision"
      || status === "pending_owner_approval"
    )
      ? "pending_owner_approval"
      : "pending_finance_reconciliation";
  }

  private async applyFactoryChange(
    client: PoolClient,
    actor: TrustedActorContext,
    source: Readonly<{
      sourcing_case_id: string;
      status: string;
      sequence: number | string;
      sourcing_decision_id: string;
      decision_version: number | string;
      factory_change_request_id: string;
      proposed_supplier_id: string;
      proposed_supplier_code_snapshot: string;
      proposed_supplier_name_snapshot: string;
      proposed_unit_price: string;
      proposed_quantity: number | string;
      proposed_total_amount: string;
      reconciliation_version: number | string;
    }>,
    eventId: string,
    reason: string,
  ): Promise<void> {
    const nextDecisionVersion = Number(source.decision_version) + 1;
    const nextStatus = this.factoryChangeTargetStatus(source.status, actor);
    const decisionId = randomUUID();
    await client.query(
      `INSERT INTO sourcing_decisions(
         sourcing_decision_id,sourcing_case_id,decision_version,source_type,
         source_ie_quote_id,supersedes_decision_id,source_change_request_id,
         supplier_id,supplier_code_snapshot,supplier_name_snapshot,
         unit_price,quantity,total_amount,decision_reason,decided_by,
         operation_event_id,request_id,crafts,cutting_process,cutting_process_other
      ) VALUES($1,$2,$3,'factory_change',NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
        (SELECT crafts FROM sourcing_decisions WHERE sourcing_decision_id=$4),
        (SELECT cutting_process FROM sourcing_decisions WHERE sourcing_decision_id=$4),
        (SELECT cutting_process_other FROM sourcing_decisions WHERE sourcing_decision_id=$4))`,
      [
        decisionId, source.sourcing_case_id ?? fail("换厂订单标识缺失"),
        nextDecisionVersion, source.sourcing_decision_id, source.factory_change_request_id,
        source.proposed_supplier_id, source.proposed_supplier_code_snapshot,
        source.proposed_supplier_name_snapshot, source.proposed_unit_price,
        Number(source.proposed_quantity), source.proposed_total_amount,
        reason, actor.actorId, eventId, actor.requestId,
      ],
    );
    await client.query(
      `INSERT INTO sourcing_decision_lines(sourcing_decision_id,sourcing_case_id,position,quantity,unit_price,total_amount)
       SELECT $1,$3,line.position,line.quantity,$2,round($2::numeric*line.quantity,2)
       FROM sourcing_factory_remaining_lines($3,$4) line WHERE line.quantity>0 ORDER BY line.position`,
      [decisionId,source.proposed_unit_price,source.sourcing_case_id,source.sourcing_decision_id],
    );
    if (nextStatus === "pending_finance_reconciliation") {
      const snapshotId = randomUUID();
      await client.query(
        `INSERT INTO sourcing_approval_snapshots(
           sourcing_approval_snapshot_id,sourcing_case_id,sourcing_decision_id,
           decision_version,supplier_id,supplier_code_snapshot,supplier_name_snapshot,
           supplier_address,contract_entity_name,party_b_representative,
           payee_name,bank_account,bank_name,quantity,total_amount,daxing_unit_price,
           estimated_cut_piece_send_date,delivery_date,processes,
           approved_by,operation_event_id,request_id,gender,style_name_snapshot
         )
         SELECT $1,$2,$3,$4,$5,$6,$7,
                supplier.address,supplier.contract_entity_name,supplier.party_b_representative,
                supplier.payee_name,supplier.bank_account,supplier.bank_name,
                $8,(SELECT sum(line.total_amount) FROM sourcing_decision_lines line
                    WHERE line.sourcing_decision_id=$3),
                source_case.daxing_unit_price,source_case.estimated_cut_piece_send_date,
                COALESCE((SELECT (proposal.after_state->>'deliveryDate')::date
                  FROM sourcing_factory_change_requests request_row
                  JOIN operation_events proposal ON proposal.event_id=request_row.operation_event_id
                  WHERE request_row.factory_change_request_id=$12),
                  sourcing_effective_delivery_date(source_case.sourcing_case_id,source_case.delivery_date)),
                CASE WHEN decision.crafts IS NULL THEN COALESCE(source_case.process_items,'{}'::text[])
                  ELSE ARRAY(SELECT craft->>'craftName' FROM jsonb_array_elements(decision.crafts) craft) END,
                $9,$10,$11,source_case.gender,source_case.style_name_snapshot
         FROM sourcing_cases source_lock
           CROSS JOIN LATERAL sourcing_case_facts_at(source_lock.sourcing_case_id) source_case
         JOIN current_supplier_catalog supplier ON supplier.supplier_id=$5
         JOIN sourcing_decisions decision ON decision.sourcing_decision_id=$3
         WHERE source_case.sourcing_case_id=$2`,
        [snapshotId,source.sourcing_case_id,decisionId,nextDecisionVersion,
          source.proposed_supplier_id,source.proposed_supplier_code_snapshot,
          source.proposed_supplier_name_snapshot,Number(source.proposed_quantity),
          actor.actorId,eventId,actor.requestId,source.factory_change_request_id],
      );
      await client.query(
        `INSERT INTO sourcing_approval_snapshot_lines(
           sourcing_approval_snapshot_id,position,style_no,alternate_style_no,color,
           quantity,unit_price,total_amount
         )
         SELECT $1,line.position,source_line.style_no,source_line.alternate_style_no,
                source_line.color,line.quantity,line.unit_price,line.total_amount
         FROM sourcing_decision_lines line
         JOIN current_sourcing_case_lines source_line
           ON source_line.sourcing_case_id=$2 AND source_line.position=line.position
         WHERE line.sourcing_decision_id=$3 ORDER BY line.position`,
        [snapshotId,source.sourcing_case_id,decisionId],
      );
      if(!(await client.query('SELECT 1 FROM sourcing_production_orders WHERE sourcing_case_id=$1',[source.sourcing_case_id])).rowCount)await ensureCuttingOrdersForApproval(client,source.sourcing_case_id,snapshotId);
      await approveTransferPoDates(client,actor,source.sourcing_case_id,source.factory_change_request_id,eventId,reason);
      await this.contractService?.prepareForApproval(client, snapshotId, actor);
      await transferProductionFactory(client,source.sourcing_case_id,source.sourcing_decision_id,decisionId,eventId);
    }
    if (nextStatus !== source.status) {
      await client.query(
        `INSERT INTO sourcing_case_transitions(
           sourcing_transition_id,sourcing_case_id,sequence,from_status,to_status,
           business_action,transition_reason,actor_id,operation_event_id,request_id
         ) VALUES($1,$2,$3,$4,$5,'factory_change_effective',$6,$7,$8,$9)`,
        [
          randomUUID(), source.sourcing_case_id, Number(source.sequence) + 1,
          source.status, nextStatus, reason, actor.actorId, eventId, actor.requestId,
        ],
      );
    }
    if (nextStatus === "pending_owner_approval") {
      if (source.status === "pending_management_decision") {
        await this.todoProjection?.completeOpenByDedupePrefix(
          client, actor, `sourcing:${source.sourcing_case_id}:management:`,
          "转厂方案已形成新选厂版本，原供应链总监待办失效",
        );
      }
      await this.todoProjection?.completeOpenByDedupePrefix(
        client, actor, `sourcing:${source.sourcing_case_id}:owner:`,
        "转厂方案已形成新选厂版本，原老板待办失效",
      );
      await this.todoProjection?.actionableForAllAssignedRole(client, actor, {
        category: "sourcing_owner_approval",
        sourceEventId: eventId,
        sourceAction: "sourcing.factory_change.effective",
        entityType: "sourcing_case",
        entityId: source.sourcing_case_id,
        requiredRole: OWNER_DECISION_ROLE,
        requiredCapability: OWNER_DECISION_CAPABILITY,
        route: { routeName: "sourcing_detail", entityId: source.sourcing_case_id },
        policyKey: "general",
        dedupeKey: `sourcing:${source.sourcing_case_id}:owner:${nextDecisionVersion}`,
      });
    }
    if (
      source.status === "pending_owner_approval"
      && nextStatus === "pending_finance_reconciliation"
    ) {
      await this.todoProjection?.completeOpenByDedupePrefix(
        client, actor, `sourcing:${source.sourcing_case_id}:owner:`,
        "老板直接转厂已生效，原老板审批待办失效",
      );
    }
    if (source.status === "pending_exception_verification") {
      await this.todoProjection?.completeOpenByDedupePrefix(
        client, actor, `sourcing:${source.sourcing_case_id}:exception:`,
        "转厂方案已生效，原异常核实待办失效",
      );
    }
    await this.todoProjection?.completeOpenByDedupePrefix(
      client, actor, `sourcing:${source.sourcing_case_id}:finance:`,
      "选厂版本已更新，原财务核对待办失效",
    );
    if (nextStatus === "pending_finance_reconciliation") {
      await this.todoProjection?.actionableForAllAssignedRole(client, actor, {
        category: "sourcing_finance_reconcile",
        sourceEventId: eventId,
        sourceAction: "sourcing.factory_change.effective",
        entityType: "sourcing_case",
        entityId: source.sourcing_case_id,
        requiredRole: FINANCE_RECONCILE_ROLE,
        requiredCapability: FINANCE_RECONCILE_CAPABILITY,
        route: { routeName: "sourcing_detail", entityId: source.sourcing_case_id },
        policyKey: "general",
        dedupeKey: `sourcing:${source.sourcing_case_id}:finance:${nextDecisionVersion}:${Number(source.reconciliation_version)+1}`,
      });
      if (actor.authorizationCapability === OWNER_DECISION_CAPABILITY) {
        const returnFact = await client.query<{ created_by: string; additional_merchandiser_user_id: string | null; contract_returned_at: Date | null }>(
          `SELECT source_case.created_by,
             nullif(to_jsonb(source_case)->>'additional_merchandiser_user_id','')::uuid AS additional_merchandiser_user_id,
             monitor.contract_returned_at
           FROM sourcing_cases source_case
           JOIN sourcing_contract_return_monitors monitor
             ON monitor.sourcing_case_id=source_case.sourcing_case_id
           WHERE source_case.sourcing_case_id=$1 AND monitor.contract_return_monitor_enabled`,
          [source.sourcing_case_id],
        );
        const pending = returnFact.rows[0];
        if (pending?.contract_returned_at === null) {
          await this.todoProjection?.completeOpenByDedupePrefix(
            client, actor, `sourcing:${source.sourcing_case_id}:return:`, "选厂批准版本已更新",
          );
          await this.todoProjection?.actionableForNamedRecipient?.(client, actor, {
            category: "sourcing_contract_return",
            sourceEventId: eventId,
            sourceAction: "sourcing.factory_change.effective",
            entityType: "sourcing_case",
            entityId: source.sourcing_case_id,
            recipientUserId: await effectiveSourcingMerchandiser(client,source.sourcing_case_id,pending.created_by)??fail("当前主跟单缺失",409,"CONFLICT"),
            requiredRole: CONTRACT_ROLE,
            requiredCapability: CONTRACT_CAPABILITY,
            route: { routeName: "sourcing_detail", entityId: source.sourcing_case_id, tab: "contract_return" },
            policyKey: "sourcing_contract_return",
            dedupeKey: `sourcing:${source.sourcing_case_id}:return:${nextDecisionVersion}`,
          });
          if (pending.additional_merchandiser_user_id) await this.todoProjection?.actionableForNamedRecipient?.(client,actor,{
            category:"sourcing_contract_return",sourceEventId:eventId,sourceAction:"sourcing.factory_change.effective",
            entityType:"sourcing_case",entityId:source.sourcing_case_id,recipientUserId:pending.additional_merchandiser_user_id,
            requiredRole:CONTRACT_ROLE,requiredCapability:CONTRACT_CAPABILITY,
            route:{routeName:"sourcing_detail",entityId:source.sourcing_case_id,tab:"contract_return"},
            policyKey:"sourcing_contract_return",
            dedupeKey:`sourcing:${source.sourcing_case_id}:return:${nextDecisionVersion}:${pending.additional_merchandiser_user_id}`,
          });
        }
      }
    }
  }

  async requestFactoryChange(
    actor: TrustedActorContext,
    sourcingCaseId: string,
    input: RequestSourcingFactoryChange,
    idempotencyKey: string,
  ): Promise<Result<SourcingCaseSummary>> {
    const initiatorRole = this.factoryChangeInitiator(actor);
    const parsed = RequestSourcingFactoryChangeSchema.safeParse(input);
    if (!parsed.success) fail(parsed.error.issues[0]?.message ?? "转厂资料无效");
    if (input.deliveryDate !== undefined && !canChangeSourcingTransferDeliveryDate({
      isRoot: actor.actorRoles.includes(ROOT_ROLE), businessRoles: actor.actorRoles,
      capabilities: actor.authorizationCapabilities ?? [actor.authorizationCapability],
    })) fail("仅Root或生产管理可在转厂时修改交货日期",403,"FORBIDDEN");
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    if (!UUID_PATTERN.test(input.supplierId)) fail("加工厂标识无效");
    const unitPrice = normalizeSourcingUnitPrice(input.unitPrice);
    const changeReason = normalizeText(input.changeReason, "换厂原因", 500);
    const scope = `sourcing.factory-change.request.${initiatorRole}`;
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, {
          sourcingCaseId, supplierId: input.supplierId, unitPrice, changeReason, ...(input.deliveryDate !== undefined ? {deliveryDate:input.deliveryDate} : {}),
        }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        const current = await client.query<{
          sourcing_case_id: string;
          order_quantity: number | string;
          status: string;
          sequence: number | string;
          sourcing_decision_id: string | null;
          supplier_id: string | null;
          decision_unit_price: string | null;
          decision_version: number | string | null;
          reconciliation_version: number | string;
          open_change_id: string | null;
          created_by: string;
          additional_merchandiser_user_id: string | null;
          current_delivery_date: string | null;
          estimated_send_date: string | null;
        }>(
          `SELECT source_case.sourcing_case_id,source_case.order_quantity,source_lock.created_by,
                  nullif(to_jsonb(source_lock)->>'additional_merchandiser_user_id','')::uuid AS additional_merchandiser_user_id,
                  transition_row.to_status AS status,transition_row.sequence,
                  decision_row.sourcing_decision_id,decision_row.supplier_id,
                  decision_row.unit_price AS decision_unit_price,
                  decision_row.decision_version,
                  COALESCE(reconciliation_row.reconciliation_version,0) AS reconciliation_version,
                  open_change.factory_change_request_id AS open_change_id,
                  to_char(sourcing_effective_delivery_date(source_case.sourcing_case_id,source_case.delivery_date),'YYYY-MM-DD') AS current_delivery_date,
                  to_char(source_case.estimated_cut_piece_send_date,'YYYY-MM-DD') AS estimated_send_date
           FROM sourcing_cases source_lock
           CROSS JOIN LATERAL sourcing_case_facts_at(source_lock.sourcing_case_id) source_case
           JOIN LATERAL (
             SELECT transition.to_status,transition.sequence
             FROM sourcing_case_transitions transition
             WHERE transition.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY transition.sequence DESC LIMIT 1
           ) transition_row ON true
           LEFT JOIN LATERAL (
             SELECT decision.*
             FROM sourcing_decisions decision
             WHERE decision.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY decision.decision_version DESC LIMIT 1
           ) decision_row ON true
           LEFT JOIN LATERAL (
             SELECT reconciliation.reconciliation_version
             FROM sourcing_finance_reconciliations reconciliation
             WHERE reconciliation.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY reconciliation.reconciliation_version DESC LIMIT 1
           ) reconciliation_row ON true
           LEFT JOIN LATERAL (
             SELECT change.factory_change_request_id
             FROM sourcing_factory_change_requests change
             WHERE change.sourcing_case_id=source_case.sourcing_case_id
               AND change.requested_at > COALESCE((SELECT max(transitioned_at) FROM sourcing_case_transitions WHERE sourcing_case_id=source_case.sourcing_case_id AND business_action='returned_to_merchandiser'),'-infinity'::timestamptz)
               AND NOT EXISTS (
                 SELECT 1 FROM sourcing_decisions effective
                 WHERE effective.source_change_request_id=change.factory_change_request_id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM sourcing_factory_change_decisions rejected
                 WHERE rejected.factory_change_request_id=change.factory_change_request_id
                   AND rejected.decision='rejected'
               )
             ORDER BY change.requested_at DESC LIMIT 1
           ) open_change ON true
           WHERE source_case.sourcing_case_id=$1 AND source_case.deleted_at IS NULL
           FOR UPDATE OF source_lock`,
          [sourcingCaseId],
        );
        const source = current.rows[0];
        if (!source) return fail("报价选厂询价不存在", 404, "NOT_FOUND");
        const transferDeliveryDate = input.deliveryDate ?? source.current_delivery_date;
        if (!sourcingDatesValid(source.estimated_send_date,transferDeliveryDate)) fail(SOURCING_DATE_ORDER_ERROR);
        if (initiatorRole === "order_merchandiser" && !actor.actorRoles.includes(ROOT_ROLE)
          && source.additional_merchandiser_user_id === actor.actorId && await effectiveSourcingMerchandiser(client,sourcingCaseId,source.created_by) !== actor.actorId)
          fail("添加跟单仅可回传合同",403,"FORBIDDEN");
        if (!source.sourcing_decision_id || !source.decision_unit_price) {
          fail("供应链总监首次提交选厂信息后才可发起订单转厂", 409, "INVALID_STATE_TRANSITION");
        }
        await this.assertCurrentTransferBasis(client,sourcingCaseId,source.sourcing_decision_id!);
        if (source.open_change_id) fail("该订单已有待处理的转厂申请", 409, "CONFLICT");
        if (source.supplier_id === input.supplierId) fail("新加工厂不能与当前加工厂相同");
        const factory = await client.query<{
          supplier_id: string; supplier_code: string; supplier_name: string;
        }>(
          `SELECT supplier_id,supplier_code,supplier_name
           FROM current_supplier_catalog
           WHERE supplier_id=$1 AND supplier_type='factory' AND active=true`,
          [input.supplierId],
        );
        const selected = factory.rows[0] ?? fail("请选择当前有效的加工厂");
        const remainingLines=await factoryTransferLines(client,sourcingCaseId,source.sourcing_decision_id!);
        const baseContractDocumentId = (await client.query<{id:string}>(
          "SELECT sourcing_contract_document_id AS id FROM sourcing_contract_documents WHERE sourcing_case_id=$1 ORDER BY contract_version DESC LIMIT 1",[sourcingCaseId])).rows[0]?.id ?? null;
        const transferPoDates = input.deliveryDate !== undefined ? await prepareTransferPoDates(client,sourcingCaseId,input.deliveryDate,remainingLines.filter(row=>row.quantity>0).map(row=>row.position)) : undefined;
        const quantity=remainingLines.reduce((sum,line)=>sum+line.quantity,0);
        const totalAmount = calculateSourcingLinesTotalExact(remainingLines.filter(line=>line.quantity>0).map((line) => ({
          position: line.position,
          quantity: Number(line.quantity),
          unitPrice,
        })));
        const requiresOwnerApproval = scaledUnitPrice(unitPrice) > scaledUnitPrice(source.decision_unit_price!);
        const immediate = initiatorRole === "owner_group"
          || (initiatorRole === "production_management" && !requiresOwnerApproval);
        const effectiveStatus = this.factoryChangeTargetStatus(source.status, actor);
        const factoryChangeRequestId = randomUUID();
        const action = immediate ? "sourcing.factory_change.effective" : "sourcing.factory_change.request";
        const eventId = await this.events.append(client, actor, {
          action,
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          before: {
            status: source.status,
            decisionId: source.sourcing_decision_id,
            supplierId: source.supplier_id,
            unitPrice: source.decision_unit_price,
            deliveryDate: source.current_delivery_date,
          },
          after: {
            status: immediate ? effectiveStatus : source.status,
            factoryChangeRequestId,
            initiatorRole,
            supplierId: selected.supplier_id,
            supplierCode: selected.supplier_code,
            supplierName: selected.supplier_name,
            unitPrice, quantity, totalAmount, requiresOwnerApproval,
            effective: immediate,
            ...(input.deliveryDate !== undefined || baseContractDocumentId !== null ? {baseContractDocumentId} : {}),
            baseDeliveryDate:source.current_delivery_date,
            deliveryDate:transferDeliveryDate,
            ...(transferPoDates ? {transferPoDates} : {}),
          },
          reason: changeReason,
        });
        await client.query(
          `INSERT INTO sourcing_factory_change_requests(
             factory_change_request_id,sourcing_case_id,from_decision_id,
             proposed_supplier_id,proposed_supplier_code_snapshot,
             proposed_supplier_name_snapshot,proposed_unit_price,proposed_quantity,
             proposed_total_amount,change_reason,requested_by,operation_event_id,request_id,
             initiator_role,requires_owner_approval
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            factoryChangeRequestId,sourcingCaseId,source.sourcing_decision_id,
            selected.supplier_id,selected.supplier_code,selected.supplier_name,
            unitPrice,quantity,totalAmount,changeReason,actor.actorId,eventId,actor.requestId,
            initiatorRole,requiresOwnerApproval,
          ],
        );
        const reviewRole = initiatorRole === "production_management"
          ? "production_management"
          : initiatorRole === "owner_group" ? "owner_group" : null;
        if (reviewRole) {
          await client.query(
            `INSERT INTO sourcing_factory_change_decisions(
               factory_change_decision_id,factory_change_request_id,decision,
               verification_reason,verified_by,operation_event_id,request_id,decision_role
             ) VALUES($1,$2,'approved',$3,$4,$5,$6,$7)`,
            [
              randomUUID(),factoryChangeRequestId,changeReason,actor.actorId,
              eventId,actor.requestId,reviewRole,
            ],
          );
        }
        const effectSource = {
          ...source,
          sourcing_decision_id: source.sourcing_decision_id!,
          decision_version: source.decision_version!,
          factory_change_request_id: factoryChangeRequestId,
          proposed_supplier_id: selected.supplier_id,
          proposed_supplier_code_snapshot: selected.supplier_code,
          proposed_supplier_name_snapshot: selected.supplier_name,
          proposed_unit_price: unitPrice,
          proposed_quantity: quantity,
          proposed_total_amount: totalAmount,
        };
        if (immediate) {
          await this.applyFactoryChange(client, actor, effectSource, eventId, changeReason);
        } else {
          if (source.status === "pending_finance_reconciliation") {
            await this.todoProjection?.completeOpenByDedupePrefix(
              client, actor,
              `sourcing:${sourcingCaseId}:finance:${Number(source.decision_version)}:${Number(source.reconciliation_version)+1}:`,
              "订单转厂审批中，原财务核对待办暂停",
            );
          }
          const approvalRole = initiatorRole === "order_merchandiser"
            ? FACTORY_CHANGE_VERIFY_ROLE
            : FACTORY_CHANGE_OWNER_ROLE;
          const approvalCapability = initiatorRole === "order_merchandiser"
            ? FACTORY_CHANGE_VERIFY_CAPABILITY
            : OWNER_DECISION_CAPABILITY;
          await this.todoProjection?.actionableForAllAssignedRole(client, actor, {
            category: initiatorRole === "order_merchandiser"
              ? "sourcing_factory_change_verify"
              : "sourcing_factory_change_owner_approve",
            sourceEventId: eventId,
            sourceAction: action,
            entityType: "sourcing_case",
            entityId: sourcingCaseId,
            requiredRole: approvalRole,
            requiredCapability: approvalCapability,
            route: { routeName: "sourcing_detail", entityId: sourcingCaseId },
            policyKey: "general",
            dedupeKey: `sourcing:${sourcingCaseId}:factory_change:${factoryChangeRequestId}`,
          });
        }
        return { statusCode: 201, response: await this.readCase(client, sourcingCaseId, actor) };
      });
      await syncBulkSourcing(client,this.database,actor,sourcingCaseId);
      await client.query("COMMIT");
      await this.contractService?.generateIfReady(actor, sourcingCaseId).catch(() => undefined);
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (databaseCode(error) === "23514" || databaseCode(error) === "23505") {
        fail("转厂状态已经变化，请刷新后重试", 409, "INVALID_STATE_TRANSITION");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async decideFactoryChange(
    actor: TrustedActorContext,
    sourcingCaseId: string,
    factoryChangeRequestId: string,
    input: DecideSourcingFactoryChange,
    idempotencyKey: string,
  ): Promise<Result<SourcingCaseSummary>> {
    const reviewerRole = this.factoryChangeReviewer(actor);
    if (!UUID_PATTERN.test(sourcingCaseId) || !UUID_PATTERN.test(factoryChangeRequestId)) {
      fail("转厂申请标识无效");
    }
    const verificationReason = normalizeText(input.verificationReason, "核实说明", 500);
    const scope = `sourcing.factory-change.${reviewerRole}.${input.decision}`;
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, {
          sourcingCaseId,factoryChangeRequestId,decision: input.decision,verificationReason,
        }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        const current = await client.query<{
          sourcing_case_id: string;
          status: string;
          sequence: number | string;
          sourcing_decision_id: string;
          decision_version: number | string;
          factory_change_request_id: string;
          from_decision_id: string;
          initiator_role: "order_merchandiser" | "production_management" | "owner_group";
          requires_owner_approval: boolean;
          proposed_supplier_id: string;
          proposed_supplier_code_snapshot: string;
          proposed_supplier_name_snapshot: string;
          proposed_unit_price: string;
          proposed_quantity: number | string;
          proposed_total_amount: string;
          reconciliation_version: number | string;
          management_decision: string | null;
          owner_decision: string | null;
          effective: boolean;
        }>(
          `SELECT source_case.sourcing_case_id,transition_row.to_status AS status,
                  transition_row.sequence,decision_row.sourcing_decision_id,
                  decision_row.decision_version,change.factory_change_request_id,
                  change.from_decision_id,change.initiator_role,
                  change.requires_owner_approval,change.proposed_supplier_id,
                  change.proposed_supplier_code_snapshot,
                  change.proposed_supplier_name_snapshot,change.proposed_unit_price,
                  change.proposed_quantity,change.proposed_total_amount,
                  COALESCE(reconciliation_row.reconciliation_version,0) AS reconciliation_version,
                  management_review.decision AS management_decision,
                  owner_review.decision AS owner_decision,
                  EXISTS(
                    SELECT 1 FROM sourcing_decisions effective
                    WHERE effective.source_change_request_id=change.factory_change_request_id
                  ) AS effective
           FROM sourcing_cases source_lock
           CROSS JOIN LATERAL sourcing_case_facts_at(source_lock.sourcing_case_id) source_case
           JOIN LATERAL (
             SELECT transition.to_status,transition.sequence
             FROM sourcing_case_transitions transition
             WHERE transition.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY transition.sequence DESC LIMIT 1
           ) transition_row ON true
           JOIN LATERAL (
             SELECT decision.*
             FROM sourcing_decisions decision
             WHERE decision.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY decision.decision_version DESC LIMIT 1
           ) decision_row ON true
           JOIN sourcing_factory_change_requests change
             ON change.factory_change_request_id=$2
            AND change.sourcing_case_id=source_case.sourcing_case_id
           LEFT JOIN sourcing_factory_change_decisions management_review
             ON management_review.factory_change_request_id=change.factory_change_request_id
            AND management_review.decision_role='production_management'
           LEFT JOIN sourcing_factory_change_decisions owner_review
             ON owner_review.factory_change_request_id=change.factory_change_request_id
            AND owner_review.decision_role='owner_group'
           LEFT JOIN LATERAL (
             SELECT reconciliation.reconciliation_version
             FROM sourcing_finance_reconciliations reconciliation
             WHERE reconciliation.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY reconciliation.reconciliation_version DESC LIMIT 1
           ) reconciliation_row ON true
           WHERE source_case.sourcing_case_id=$1 AND source_case.deleted_at IS NULL
           FOR UPDATE OF source_lock`,
          [sourcingCaseId,factoryChangeRequestId],
        );
        const source = current.rows[0];
        if (!source) return fail("转厂申请不存在", 404, "NOT_FOUND");
        if (source.effective || source.management_decision === "rejected" || source.owner_decision) {
          fail("该转厂申请已经处理", 409, "INVALID_STATE_TRANSITION");
        }
        await this.assertCurrentTransferBasis(client,sourcingCaseId,source.from_decision_id);
        if (source.from_decision_id !== source.sourcing_decision_id) {
          fail("转厂基准版本已经变化，请重新发起", 409, "INVALID_STATE_TRANSITION");
        }
        if (
          reviewerRole === "production_management"
          && (source.initiator_role !== "order_merchandiser" || source.management_decision)
        ) fail("该转厂申请不需要供应链总监审批", 409, "INVALID_STATE_TRANSITION");
        if (
          reviewerRole === "owner_group"
          && (
            !source.requires_owner_approval
            || (source.initiator_role === "order_merchandiser"
              && source.management_decision !== "approved")
          )
        ) fail("该转厂申请当前不需要老板审批", 409, "INVALID_STATE_TRANSITION");
        const willEffect = input.decision === "approved"
          && (reviewerRole === "owner_group" || !source.requires_owner_approval);
        const actualLines=willEffect?await factoryTransferLines(client,sourcingCaseId,source.from_decision_id):null;
        if(actualLines){source.proposed_quantity=actualLines.reduce((sum,line)=>sum+line.quantity,0);
          source.proposed_total_amount=calculateSourcingLinesTotalExact(actualLines.filter(line=>line.quantity>0).map(line=>({position:line.position,quantity:line.quantity,unitPrice:source.proposed_unit_price})));}
        const effectiveStatus = this.factoryChangeTargetStatus(source.status, actor);
        const action = willEffect
          ? "sourcing.factory_change.effective"
          : input.decision === "approved"
            ? "sourcing.factory_change.management_approved"
            : reviewerRole === "owner_group"
              ? "sourcing.factory_change.owner_rejected"
              : "sourcing.factory_change.rejected";
        const eventId = await this.events.append(client, actor, {
          action,
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          before: {
            status: source.status,
            decisionId: source.sourcing_decision_id,
            factoryChangeRequestId,
          },
          after: {
            status: willEffect ? effectiveStatus : source.status,
            decision: input.decision,
            reviewerRole,
            effective: willEffect,
            requiresOwnerApproval: source.requires_owner_approval,
            supplierId: source.proposed_supplier_id,
            unitPrice: source.proposed_unit_price,
            quantity: Number(source.proposed_quantity),
            totalAmount: source.proposed_total_amount,
          },
          reason: verificationReason,
        });
        await client.query(
          `INSERT INTO sourcing_factory_change_decisions(
             factory_change_decision_id,factory_change_request_id,decision,
             verification_reason,verified_by,operation_event_id,request_id,decision_role
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            randomUUID(),factoryChangeRequestId,input.decision,verificationReason,
            actor.actorId,eventId,actor.requestId,reviewerRole,
          ],
        );
        await this.todoProjection?.completeOpenByDedupePrefix(
          client, actor, `sourcing:${sourcingCaseId}:factory_change:${factoryChangeRequestId}:`,
          input.decision === "approved" ? "转厂审批已通过" : "转厂申请已驳回",
        );
        if (willEffect) {
          const basis = (await client.query<{after_state:Record<string,unknown>;id:string|null}>(
            `SELECT event.after_state,(SELECT sourcing_contract_document_id::text FROM sourcing_contract_documents
              WHERE sourcing_case_id=$2 ORDER BY contract_version DESC LIMIT 1) AS id
             FROM sourcing_factory_change_requests request_row JOIN operation_events event ON event.event_id=request_row.operation_event_id
             WHERE request_row.factory_change_request_id=$1`,[factoryChangeRequestId,sourcingCaseId])).rows[0]!;
          if ('baseContractDocumentId' in basis.after_state && basis.after_state.baseContractDocumentId !== basis.id)
            fail("合同版本已经变化，请驳回后重新发起转厂",409,"CONFLICT");
          await this.applyFactoryChange(client, actor, source, eventId, verificationReason);
        } else if (input.decision === "approved") {
          await this.todoProjection?.actionableForAllAssignedRole(client, actor, {
            category: "sourcing_factory_change_owner_approve",
            sourceEventId: eventId,
            sourceAction: action,
            entityType: "sourcing_case",
            entityId: sourcingCaseId,
            requiredRole: FACTORY_CHANGE_OWNER_ROLE,
            requiredCapability: OWNER_DECISION_CAPABILITY,
            route: { routeName: "sourcing_detail", entityId: sourcingCaseId },
            policyKey: "general",
            dedupeKey: `sourcing:${sourcingCaseId}:factory_change:${factoryChangeRequestId}`,
          });
        } else if (
          source.status === "pending_finance_reconciliation"
          || source.status === "pending_factory_change_verification"
        ) {
          if (source.status === "pending_factory_change_verification") {
            await client.query(
              `INSERT INTO sourcing_case_transitions(
                 sourcing_transition_id,sourcing_case_id,sequence,from_status,to_status,
                 business_action,transition_reason,actor_id,operation_event_id,request_id
               ) VALUES($1,$2,$3,'pending_factory_change_verification',
                 'pending_finance_reconciliation','factory_change_rejected',$4,$5,$6,$7)`,
              [
                randomUUID(),sourcingCaseId,Number(source.sequence)+1,
                verificationReason,actor.actorId,eventId,actor.requestId,
              ],
            );
          }
          await this.todoProjection?.actionableForAllAssignedRole(client, actor, {
            category: "sourcing_finance_reconcile",
            sourceEventId: eventId,
            sourceAction: action,
            entityType: "sourcing_case",
            entityId: sourcingCaseId,
            requiredRole: FINANCE_RECONCILE_ROLE,
            requiredCapability: FINANCE_RECONCILE_CAPABILITY,
            route: { routeName: "sourcing_detail", entityId: sourcingCaseId },
            policyKey: "general",
            dedupeKey: `sourcing:${sourcingCaseId}:finance:${Number(source.decision_version)}:${Number(source.reconciliation_version)+1}:resume:${factoryChangeRequestId}`,
          });
        }
        return { statusCode: 201, response: await this.readCase(client, sourcingCaseId, actor) };
      });
      await syncBulkSourcing(client,this.database,actor,sourcingCaseId);
      await client.query("COMMIT");
      await this.contractService?.generateIfReady(actor, sourcingCaseId).catch(() => undefined);
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (databaseCode(error) === "23514" || databaseCode(error) === "23505") {
        fail("转厂审批状态已经变化，请刷新后重试", 409, "INVALID_STATE_TRANSITION");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async readFactorySettlements(actor:TrustedActorContext,sourcingCaseId:string){
    this.assertActor(actor,FINANCE_RECONCILE_CAPABILITY,FINANCE_RECONCILE_ROLE);
    if(!UUID_PATTERN.test(sourcingCaseId))fail("财务核对标识无效");
    return {items:(await factorySettlements(this.database,sourcingCaseId)).map(s=>({decisionId:s.decision_id,supplierName:s.supplier_name,quantity:s.quantity,totalAmount:s.total_amount,contractNumber:s.contract_number,pdfAttachmentId:s.pdf_attachment_id,result:s.result}))};
  }

  async recordFinanceReconciliation(
    actor: TrustedActorContext,
    sourcingCaseId: string,
    input: RecordSourcingFinanceReconciliation,
    idempotencyKey: string,
  ): Promise<Result<SourcingCaseSummary>> {
    this.assertActor(actor, FINANCE_RECONCILE_CAPABILITY, FINANCE_RECONCILE_ROLE);
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("财务核对标识无效");
    const differenceFields = input.differenceFields ?? [];
    const suppliedReason = input.differenceReason?.trim() ?? "";
    const difference = input.result === "difference";
    if (difference && (!differenceFields.length || !suppliedReason)) {
      fail("发现差异时必须选择差异项并填写说明");
    }
    if (!difference && (differenceFields.length || suppliedReason)) {
      fail("一致确认不能提交差异信息");
    }
    const scope = "sourcing.finance.reconcile";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, {
          sourcingCaseId,factoryDecisionId:input.factoryDecisionId??null,result: input.result,differenceFields,suppliedReason,
        }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        await client.query("SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=$1 FOR UPDATE",[sourcingCaseId]);
        if(input.factoryDecisionId){
          await reconcileFactory(client,actor,sourcingCaseId,input as typeof input&{factoryDecisionId:string},this.events);
          return {statusCode:201,response:await this.readCase(client,sourcingCaseId,actor)};
        }
        const current = await client.query<{
          status: string;
          sequence: number | string;
          sourcing_decision_id: string;
          decision_version: number | string;
          supplier_id: string;
          expected_unit_price: string;
          expected_quantity: number | string;
          expected_total_amount: string;
          sourcing_contract_id: string | null;
          sourcing_contract_document_id: string | null;
          contract_version: number | string | null;
          contract_fingerprint: string | null;
          pdf_attachment_id: string | null;
          reconciliation_version: number | string;
        }>(
          `SELECT transition_row.to_status AS status,transition_row.sequence,
                  decision_row.sourcing_decision_id,decision_row.decision_version,
                  decision_row.supplier_id,decision_row.unit_price AS expected_unit_price,
                  decision_row.quantity AS expected_quantity,
                  decision_row.total_amount AS expected_total_amount,
                  legacy_contract.sourcing_contract_id,
                  contract_row.sourcing_contract_document_id,
                  contract_row.contract_version,
                  contract_row.snapshot_fingerprint AS contract_fingerprint,
                  contract_row.pdf_attachment_id,
                  COALESCE(reconciliation_row.reconciliation_version,0) AS reconciliation_version
           FROM sourcing_cases source_lock
           CROSS JOIN LATERAL sourcing_case_facts_at(source_lock.sourcing_case_id) source_case
           JOIN LATERAL (
             SELECT transition.to_status,transition.sequence
             FROM sourcing_case_transitions transition
             WHERE transition.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY transition.sequence DESC LIMIT 1
           ) transition_row ON true
           JOIN LATERAL (
             SELECT decision.* FROM sourcing_decisions decision
             WHERE decision.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY decision.decision_version DESC LIMIT 1
           ) decision_row ON true
           LEFT JOIN LATERAL (
             SELECT contract.sourcing_contract_id
             FROM sourcing_contract_executions contract
             WHERE contract.sourcing_case_id=source_case.sourcing_case_id
               AND contract.sourcing_decision_id=decision_row.sourcing_decision_id
             ORDER BY contract.recorded_at DESC,contract.sourcing_contract_id DESC LIMIT 1
           ) legacy_contract ON true
           LEFT JOIN LATERAL (
             SELECT contract.sourcing_contract_document_id,contract.contract_version,
                    contract.snapshot_fingerprint,contract.pdf_attachment_id
             FROM sourcing_contract_documents contract
             WHERE contract.sourcing_case_id=source_case.sourcing_case_id
               AND contract.sourcing_decision_id=decision_row.sourcing_decision_id
               AND contract.contract_version=(SELECT max(latest.contract_version) FROM sourcing_contract_documents latest WHERE latest.sourcing_case_id=contract.sourcing_case_id)
               AND contract.status='ready'
             ORDER BY contract.contract_version DESC LIMIT 1
           ) contract_row ON true
           LEFT JOIN LATERAL (
             SELECT reconciliation.reconciliation_version
             FROM sourcing_finance_reconciliations reconciliation
             WHERE reconciliation.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY reconciliation.reconciliation_version DESC LIMIT 1
           ) reconciliation_row ON true
           WHERE source_case.sourcing_case_id=$1
             AND source_case.deleted_at IS NULL
           FOR UPDATE OF source_lock`,
          [sourcingCaseId],
        );
        const source = current.rows[0];
        if (!source) return fail("报价选厂询价或当前选厂决定不存在", 404, "NOT_FOUND");
        if (source.status !== "pending_finance_reconciliation") {
          fail("该订单当前不在财务核对阶段", 409, "INVALID_STATE_TRANSITION");
        }
        if (!source.sourcing_contract_document_id || source.contract_version === null
          || !source.contract_fingerprint || !source.pdf_attachment_id) {
          fail("当前批准版本尚无可核对的系统合同PDF", 409, "INVALID_STATE_TRANSITION");
        }
        const openFactoryChange = await client.query(
          `SELECT 1
           FROM sourcing_factory_change_requests request_row
           WHERE request_row.sourcing_case_id=$1
             AND NOT EXISTS (
               SELECT 1 FROM sourcing_decisions effective
               WHERE effective.source_change_request_id=request_row.factory_change_request_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM sourcing_factory_change_decisions rejected
               WHERE rejected.factory_change_request_id=request_row.factory_change_request_id
                 AND rejected.decision='rejected'
             )
           LIMIT 1`,
          [sourcingCaseId],
        );
        if (openFactoryChange.rowCount) {
          fail("订单转厂审批中，财务暂不能核对；请原转厂审批岗位在本单转厂申请完成决定，财务再读取有效工厂与合同后对账", 409, "INVALID_STATE_TRANSITION");
        }
        const expectedFactoryResult = await client.query<{
          supplier_id: string;
          supplier_code: string;
          supplier_name: string;
        }>(
          `SELECT supplier_id,supplier_code_snapshot AS supplier_code,
                  supplier_name_snapshot AS supplier_name
           FROM sourcing_approval_snapshots
           WHERE sourcing_decision_id=$1`,
          [source.sourcing_decision_id],
        );
        const expectedFactory = expectedFactoryResult.rows[0] ?? fail("当前批准加工厂依据缺失；请财务暂停本次对账，由订单跟单在本单原批准方案核对，交Root核查关联记录", 409, "INVALID_STATE_TRANSITION");
        const differenceReason = difference ? suppliedReason : undefined;
        const reconciliationVersion = Number(source.reconciliation_version)+1;
        const reconciliationId = randomUUID();
        const action = difference ? "sourcing.finance.difference" : "sourcing.finance.matched";
        const eventId = await this.events.append(client, actor, {
          action,
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          before: { status: "pending_finance_reconciliation", decisionId: source.sourcing_decision_id },
          after: {
            status: difference ? "pending_exception_verification" : "closed",
            reconciliationId,reconciliationVersion,result: difference ? "difference" : "match",
            differenceFields,
          },
          ...(differenceReason ? { reason: differenceReason } : {}),
        });
        await client.query(
          `INSERT INTO sourcing_finance_reconciliations(
             sourcing_reconciliation_id,sourcing_case_id,reconciliation_version,
             sourcing_decision_id,sourcing_contract_id,
             sourcing_contract_document_id,contract_version,contract_fingerprint,
             actual_supplier_id,
             actual_supplier_code_snapshot,actual_supplier_name_snapshot,
             actual_unit_price,actual_quantity,actual_total_amount,result,
             difference_fields,difference_reason,reconciled_by,operation_event_id,request_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          [
            reconciliationId,sourcingCaseId,reconciliationVersion,source.sourcing_decision_id,
            source.sourcing_contract_id,source.sourcing_contract_document_id,
            Number(source.contract_version),source.contract_fingerprint,
            expectedFactory.supplier_id,expectedFactory.supplier_code,
            expectedFactory.supplier_name,source.expected_unit_price,Number(source.expected_quantity),source.expected_total_amount,
            difference ? "difference" : "match",differenceFields,differenceReason ?? null,
            actor.actorId,eventId,actor.requestId,
          ],
        );
        await client.query(
          `INSERT INTO sourcing_case_transitions(
             sourcing_transition_id,sourcing_case_id,sequence,from_status,to_status,
             business_action,transition_reason,actor_id,operation_event_id,request_id
           ) VALUES($1,$2,$3,'pending_finance_reconciliation',$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(),sourcingCaseId,Number(source.sequence)+1,
            difference ? "pending_exception_verification" : "closed",
            difference ? "finance_difference" : "finance_matched",
            differenceReason ?? null,actor.actorId,eventId,actor.requestId,
          ],
        );
        await this.todoProjection?.completeOpenByDedupePrefix(
          client,actor,
          `sourcing:${sourcingCaseId}:finance:${Number(source.decision_version)}:${reconciliationVersion}:`,
          difference ? "财务已提交差异" : "财务核对一致",
        );
        if (difference) {
          await this.todoProjection?.actionableForAllAssignedRole(client, actor, {
            category: "sourcing_exception_verify",
            sourceEventId: eventId,
            sourceAction: action,
            entityType: "sourcing_case",
            entityId: sourcingCaseId,
            requiredRole: EXCEPTION_VERIFY_ROLE,
            requiredCapability: EXCEPTION_VERIFY_CAPABILITY,
            route: { routeName: "sourcing_detail", entityId: sourcingCaseId },
            policyKey: "general",
            dedupeKey: `sourcing:${sourcingCaseId}:exception:${reconciliationVersion}`,
          });
          const approvingOwners = await client.query<{ user_id: string }>(
            `SELECT DISTINCT decided_by AS user_id FROM sourcing_owner_decisions
             WHERE sourcing_case_id=$1 AND decision='approved' ORDER BY decided_by`,
            [sourcingCaseId],
          );
          for (const owner of approvingOwners.rows) {
            await this.todoProjection?.information(client, actor, {
              category: "sourcing_finance_difference_notice",
              sourceEventId: eventId,
              sourceAction: action,
              entityType: "sourcing_case",
              entityId: sourcingCaseId,
              recipientUserId: owner.user_id,
              route: { routeName: "sourcing_detail", entityId: sourcingCaseId },
              dedupeKey: `sourcing:${sourcingCaseId}:finance_difference:${reconciliationVersion}:${owner.user_id}`,
            });
          }
        }
        return { statusCode: 201, response: await this.readCase(client, sourcingCaseId, actor) };
      });
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (databaseCode(error) === "23514" || databaseCode(error) === "23505") {
        fail("本次财务核对未通过系统校验；请财务在本单对账页重新读取当前合同、工厂与已核对记录，避免重复对账；仍失败时提供订单链接给管理员", 409, "INVALID_STATE_TRANSITION");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async decideException(
    actor: TrustedActorContext,
    sourcingCaseId: string,
    input: DecideSourcingException,
    idempotencyKey: string,
  ): Promise<Result<SourcingCaseSummary>> {
    this.assertActor(actor, EXCEPTION_VERIFY_CAPABILITY, EXCEPTION_VERIFY_ROLE);
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    const resolutionReason = normalizeText(input.resolutionReason, "差异处理说明", 500);
    const scope = `sourcing.exception.${input.resolution}`;
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, { sourcingCaseId,resolution: input.resolution,resolutionReason }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        const current = await client.query<{
          status: string;
          sequence: number | string;
          decision_version: number | string;
          reconciliation_version: number | string;
          next_reconciliation_version: number | string;
        }>(
          `SELECT transition_row.to_status AS status,transition_row.sequence,
                  decision_row.decision_version,reconciliation_row.reconciliation_version,
                  (SELECT COALESCE(max(reconciliation_version),0)+1 FROM sourcing_finance_reconciliations WHERE sourcing_case_id=source_case.sourcing_case_id) AS next_reconciliation_version
           FROM sourcing_cases source_lock
           CROSS JOIN LATERAL sourcing_case_facts_at(source_lock.sourcing_case_id) source_case
           JOIN LATERAL (
             SELECT transition.to_status,transition.sequence
             FROM sourcing_case_transitions transition
             WHERE transition.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY transition.sequence DESC LIMIT 1
           ) transition_row ON true
           JOIN LATERAL (
             SELECT decision.decision_version FROM sourcing_decisions decision
             WHERE decision.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY decision.decision_version DESC LIMIT 1
           ) decision_row ON true
           JOIN LATERAL (
             SELECT reconciliation.reconciliation_version
             FROM sourcing_finance_reconciliations reconciliation
             WHERE reconciliation.sourcing_case_id=source_case.sourcing_case_id
               AND reconciliation.result='difference'
               AND reconciliation.factory_decision_id IS NULL
             ORDER BY reconciliation.reconciliation_version DESC LIMIT 1
           ) reconciliation_row ON true
           WHERE source_case.sourcing_case_id=$1
             AND source_case.deleted_at IS NULL
           FOR UPDATE OF source_lock`,
          [sourcingCaseId],
        );
        const source = current.rows[0];
        if (!source) return fail("报价选厂差异记录不存在", 404, "NOT_FOUND");
        if (source.status !== "pending_exception_verification") {
          fail("该订单当前不在差异核实阶段", 409, "INVALID_STATE_TRANSITION");
        }
        const close = input.resolution === "close";
        const action = close ? "sourcing.exception.close" : "sourcing.exception.reopen_reconciliation";
        const eventId = await this.events.append(client, actor, {
          action,
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          before: { status: "pending_exception_verification", reconciliationVersion: Number(source.reconciliation_version) },
          after: { status: close ? "closed" : "pending_finance_reconciliation", resolution: input.resolution },
          reason: resolutionReason,
        });
        await client.query(
          `INSERT INTO sourcing_case_transitions(
             sourcing_transition_id,sourcing_case_id,sequence,from_status,to_status,
             business_action,transition_reason,actor_id,operation_event_id,request_id
           ) VALUES($1,$2,$3,'pending_exception_verification',$4,$5,$6,$7,$8,$9)`,
          [
            randomUUID(),sourcingCaseId,Number(source.sequence)+1,
            close ? "closed" : "pending_finance_reconciliation",
            close ? "exception_closed" : "exception_reopened_for_reconciliation",
            resolutionReason,actor.actorId,eventId,actor.requestId,
          ],
        );
        await this.todoProjection?.completeOpenByDedupePrefix(
          client,actor,
          `sourcing:${sourcingCaseId}:exception:${Number(source.reconciliation_version)}:`,
          close ? "差异已确认闭环" : "已退回财务重核",
        );
        if (!close) {
          const nextReconciliationVersion = Number(source.next_reconciliation_version);
          await this.todoProjection?.actionableForAllAssignedRole(client, actor, {
            category: "sourcing_finance_reconcile",
            sourceEventId: eventId,
            sourceAction: action,
            entityType: "sourcing_case",
            entityId: sourcingCaseId,
            requiredRole: FINANCE_RECONCILE_ROLE,
            requiredCapability: FINANCE_RECONCILE_CAPABILITY,
            route: { routeName: "sourcing_detail", entityId: sourcingCaseId },
            policyKey: "general",
            dedupeKey: `sourcing:${sourcingCaseId}:finance:${Number(source.decision_version)}:${nextReconciliationVersion}`,
          });
        }
        return { statusCode: 201, response: await this.readCase(client, sourcingCaseId, actor) };
      });
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (databaseCode(error) === "23514" || databaseCode(error) === "23505") {
        fail("本次差异处理未通过系统校验；请原差异处理岗位在本单对账差异页重新读取处理结果，不能用旧版本重复关闭", 409, "INVALID_STATE_TRANSITION");
      }
      throw error;
    } finally {
      client.release();
    }
  }

}
