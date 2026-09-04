import { createHash, randomUUID } from "node:crypto";

import {
  calculateSourcingOrderQuantity,
  calculateSourcingTotalExact,
  MAX_SOURCING_ATTACHMENTS,
  SOURCING_IMAGE_SUPPLEMENT_ROLES,
} from "@dx-rework/contracts";
import type {
  CreateSourcingCase,
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
  SourcingAttachmentListResponse,
  SourcingTimelineResponse,
  SupplementSourcingImages,
} from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import type { TodoProjectionService } from "../todos/projection-service.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";

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
const DEFAULT_CREATION_REASON = "基于平台订单创建外发定价选厂询价";
const DEFAULT_QUOTE_REASON = "IE核定加工价格";
const DEFAULT_MANAGEMENT_REASON = "生产管理确认加工厂与价格";
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

type SourcingCaseRow = Readonly<{
  sourcing_case_id: string;
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
  created_at: Date | string;
  updated_at: Date | string;
  sourcing_ie_quote_id: string | null;
  quote_version: number | string | null;
  unit_price: string | null;
  quote_quantity: number | string | null;
  total_amount: string | null;
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
  management_decision_reason: string | null;
  management_decided_by: string | null;
  management_decided_at: Date | string | null;
  sourcing_owner_decision_id: string | null;
  owner_sourcing_decision_id: string | null;
  owner_decision: "approved" | "rejected" | null;
  owner_decision_reason: string | null;
  owner_decided_by: string | null;
  owner_decided_at: Date | string | null;
  total_count?: string;
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
  createdBy: string,
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
  erpOrderId: row.erp_order_id,
  erpOrderNo: row.erp_order_no,
  styleNo: row.style_no,
  laneKey: LANE_KEY,
  orderQuantity: Number(row.order_quantity),
  lineItems,
  ...(canViewSourcingDaxingPrice(actor, row.created_by) && row.daxing_unit_price !== null
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
        totalAmount: row.total_amount,
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
        totalAmount: row.decision_total_amount,
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
    >,
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
  ): Promise<SourcingCaseSummary> {
    const result = await client.query<SourcingCaseRow>(
      `SELECT
         case_view.sourcing_case_id,case_view.erp_order_id,case_view.erp_order_no,
         case_view.style_no,case_view.lane_key,case_view.order_quantity,
         source_case.daxing_unit_price::text AS daxing_unit_price,
         to_char(source_case.estimated_cut_piece_send_date,'YYYY-MM-DD')
           AS estimated_cut_piece_send_date,
         lines_row.line_items,
         to_char(case_view.delivery_date,'YYYY-MM-DD') AS delivery_date,
         case_view.process_description,case_view.process_items,
         crafts_row.crafts,
         case_view.status,case_view.version,case_view.created_by,
         case_view.created_at,case_view.updated_at,
         quote_row.sourcing_ie_quote_id,quote_row.quote_version,
         quote_row.unit_price,quote_row.quantity AS quote_quantity,
         quote_row.total_amount,quote_row.quote_reason,
         quote_row.quoted_by,quote_row.quoted_at,
         decision_row.sourcing_decision_id,decision_row.decision_version,
         decision_row.source_type,decision_row.source_ie_quote_id,
         decision_row.supersedes_decision_id,decision_row.supplier_id,
         decision_row.supplier_code_snapshot,decision_row.supplier_name_snapshot,
         decision_row.unit_price AS decision_unit_price,
         decision_row.quantity AS decision_quantity,
         decision_row.total_amount AS decision_total_amount,
         decision_row.decision_reason AS management_decision_reason,
         decision_row.decided_by AS management_decided_by,
         decision_row.decided_at AS management_decided_at,
         owner_row.sourcing_owner_decision_id,
         owner_row.sourcing_decision_id AS owner_sourcing_decision_id,
         owner_row.decision AS owner_decision,
         owner_row.decision_reason AS owner_decision_reason,
         owner_row.decided_by AS owner_decided_by,
         owner_row.decided_at AS owner_decided_at
       FROM current_sourcing_cases case_view
       JOIN sourcing_cases source_case
         ON source_case.sourcing_case_id=case_view.sourcing_case_id
       JOIN app_users creator_user ON creator_user.id=case_view.created_by
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
           jsonb_build_object(
             'position',line.position,
             'styleNo',line.style_no,
             'alternateStyleNo',line.alternate_style_no,
             'color',line.color,
             'quantity',line.quantity,
             'externalUnitPrice',line.external_unit_price::text,
             'legacy',line.legacy_source
           )
           ORDER BY line.position
         ) AS line_items
         FROM sourcing_case_lines line
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
         ORDER BY quote.quote_version DESC
         LIMIT 1
       ) quote_row ON true
       LEFT JOIN LATERAL (
         SELECT decision_fact.*
         FROM sourcing_decisions decision_fact
         WHERE decision_fact.sourcing_case_id=case_view.sourcing_case_id
         ORDER BY decision_fact.decision_version DESC
         LIMIT 1
       ) decision_row ON true
       LEFT JOIN sourcing_owner_decisions owner_row
         ON owner_row.sourcing_decision_id=decision_row.sourcing_decision_id
       WHERE case_view.sourcing_case_id=$1`,
      [sourcingCaseId],
    );
    const row = result.rows[0];
    if (!row) return fail("报价选厂询价不存在", 404, "NOT_FOUND");
    return mapCase(row, actor);
  }

  async listCases(
    actor: TrustedActorContext,
    query = "",
    statusFilter: "all" | "pending" | "closed" = "all",
    page = 1,
  ): Promise<SourcingCaseListResponse> {
    this.assertReader(actor);
    const normalizedQuery = query.trim();
    if (normalizedQuery.length > 100) fail("搜索内容不能超过100个字符");
    if (!["all", "pending", "closed"].includes(statusFilter)) fail("订单状态筛选无效");
    if (!Number.isInteger(page) || page < 1 || page > 100_000) fail("分页页码无效");
    const offset = (page - 1) * SOURCING_LIST_PAGE_SIZE;
    const result = await this.database.query<SourcingCaseRow>(
      `SELECT
         count(*) OVER()::text AS total_count,
         case_view.sourcing_case_id,case_view.erp_order_id,case_view.erp_order_no,
         case_view.style_no,case_view.lane_key,case_view.order_quantity,
         source_case.daxing_unit_price::text AS daxing_unit_price,
         to_char(source_case.estimated_cut_piece_send_date,'YYYY-MM-DD')
           AS estimated_cut_piece_send_date,
         lines_row.line_items,
         to_char(case_view.delivery_date,'YYYY-MM-DD') AS delivery_date,
         case_view.process_description,case_view.process_items,
         crafts_row.crafts,
         case_view.status,case_view.version,case_view.created_by,
         case_view.created_at,case_view.updated_at,
         quote_row.sourcing_ie_quote_id,quote_row.quote_version,
         quote_row.unit_price,quote_row.quantity AS quote_quantity,
         quote_row.total_amount,quote_row.quote_reason,
         quote_row.quoted_by,quote_row.quoted_at,
         decision_row.sourcing_decision_id,decision_row.decision_version,
         decision_row.source_type,decision_row.source_ie_quote_id,
         decision_row.supersedes_decision_id,decision_row.supplier_id,
         decision_row.supplier_code_snapshot,decision_row.supplier_name_snapshot,
         decision_row.unit_price AS decision_unit_price,
         decision_row.quantity AS decision_quantity,
         decision_row.total_amount AS decision_total_amount,
         decision_row.decision_reason AS management_decision_reason,
         decision_row.decided_by AS management_decided_by,
         decision_row.decided_at AS management_decided_at,
         owner_row.sourcing_owner_decision_id,
         owner_row.sourcing_decision_id AS owner_sourcing_decision_id,
         owner_row.decision AS owner_decision,
         owner_row.decision_reason AS owner_decision_reason,
         owner_row.decided_by AS owner_decided_by,
         owner_row.decided_at AS owner_decided_at
       FROM current_sourcing_cases case_view
       JOIN sourcing_cases source_case
         ON source_case.sourcing_case_id=case_view.sourcing_case_id
       JOIN app_users creator_user ON creator_user.id=case_view.created_by
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
           jsonb_build_object(
             'position',line.position,
             'styleNo',line.style_no,
             'alternateStyleNo',line.alternate_style_no,
             'color',line.color,
             'quantity',line.quantity,
             'externalUnitPrice',line.external_unit_price::text,
             'legacy',line.legacy_source
           )
           ORDER BY line.position
         ) AS line_items
         FROM sourcing_case_lines line
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
         ORDER BY quote.quote_version DESC
         LIMIT 1
       ) quote_row ON true
       LEFT JOIN LATERAL (
         SELECT decision_fact.*
         FROM sourcing_decisions decision_fact
         WHERE decision_fact.sourcing_case_id=case_view.sourcing_case_id
         ORDER BY decision_fact.decision_version DESC
         LIMIT 1
       ) decision_row ON true
       LEFT JOIN sourcing_owner_decisions owner_row
         ON owner_row.sourcing_decision_id=decision_row.sourcing_decision_id
       WHERE ($1='' OR case_view.erp_order_no ILIKE '%'||$1||'%'
          OR case_view.style_no ILIKE '%'||$1||'%'
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
          OR decision_row.supplier_name_snapshot ILIKE '%'||$1||'%'
          OR decision_row.supplier_code_snapshot ILIKE '%'||$1||'%'
          OR case_view.process_description ILIKE '%'||$1||'%'
          OR EXISTS (
            SELECT 1
            FROM sourcing_contract_executions contract_row
            WHERE contract_row.sourcing_case_id=case_view.sourcing_case_id
              AND contract_row.contract_reference ILIKE '%'||$1||'%'
          ))
         AND ($2='all' OR ($2='closed' AND case_view.status='closed')
           OR ($2='pending' AND case_view.status<>'closed'))
       ORDER BY case_view.created_at DESC,case_view.sourcing_case_id DESC
       LIMIT 15 OFFSET $3`,
      [
        normalizedQuery,
        statusFilter,
        offset,
      ],
    );
    const pageRows = result.rows;
    const totalCount = Number(pageRows[0]?.total_count ?? "0");
    return {
      items: pageRows.map((row) => mapCase(row, actor)),
      page,
      pageSize: SOURCING_LIST_PAGE_SIZE,
      totalCount,
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
    return {
      items: result.rows.map((row) => ({
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
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, { sourcingCaseId, ...normalized }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        const source = await client.query<{ sourcing_case_id: string }>(
          `SELECT sourcing_case_id
           FROM sourcing_cases
           WHERE sourcing_case_id=$1 AND deleted_at IS NULL
           FOR UPDATE`,
          [sourcingCaseId],
        );
        if (!source.rows[0]) fail("报价选厂询价不存在", 404, "NOT_FOUND");

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

  async listTimeline(
    actor: TrustedActorContext,
    sourcingCaseId: string,
  ): Promise<SourcingTimelineResponse> {
    this.assertReader(actor);
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    await this.readCase(this.database, sourcingCaseId, actor);
    const result = await this.database.query<{
      entry_id: string;
      kind: "created" | "ie_quote" | "management_decision" | "owner_decision"
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
              timeline.quantity,timeline.difference_fields,timeline.result,timeline.resolution
       FROM timeline
       LEFT JOIN app_users app_user ON app_user.id=timeline.actor_id
       ORDER BY timeline.handled_at,timeline.kind,timeline.entry_version`,
      [sourcingCaseId],
    );
    if (result.rows.length === 0) fail("报价选厂询价不存在", 404, "NOT_FOUND");
    return {
      items: result.rows.map((row) => ({
        entryId: row.entry_id,
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
    return binding.entityType === "sourcing_case"
      && binding.mimeType.startsWith("image/")
      && (
        actor.actorRoles.includes(ROOT_ROLE)
        || (actor.authorizationCapabilities ?? []).includes(READ_CAPABILITY)
      );
  }

  async listFactories(
    actor: TrustedActorContext,
  ): Promise<SourcingFactoryListResponse> {
    this.assertReader(actor);
    const result = await this.database.query<{
      supplier_id: string;
      supplier_code: string;
      supplier_name: string;
    }>(
      `SELECT supplier_id,supplier_code,supplier_name
       FROM current_supplier_catalog
       WHERE supplier_type='factory' AND active=true
       ORDER BY supplier_name,supplier_code`,
    );
    return {
      items: result.rows.map((row) => ({
        supplierId: row.supplier_id,
        supplierCode: row.supplier_code,
        supplierName: row.supplier_name,
      })),
    };
  }

  async getCurrentFactoryChange(
    actor: TrustedActorContext,
    sourcingCaseId: string,
  ): Promise<SourcingFactoryChangeStateResponse> {
    this.assertReader(actor);
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
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
    }>(
      `SELECT change.factory_change_request_id,change.from_decision_id,
              change.initiator_role,change.proposed_supplier_id,
              change.proposed_supplier_name_snapshot,change.proposed_unit_price,
              change.proposed_quantity,change.proposed_total_amount,
              change.change_reason,change.requires_owner_approval,
              change.requested_by,change.requested_at,
              management_review.decision AS management_decision,
              owner_review.decision AS owner_decision,
              EXISTS(
                SELECT 1 FROM sourcing_decisions effective
                WHERE effective.source_change_request_id=change.factory_change_request_id
              ) AS effective
       FROM sourcing_factory_change_requests change
       LEFT JOIN sourcing_factory_change_decisions management_review
         ON management_review.factory_change_request_id=change.factory_change_request_id
        AND management_review.decision_role='production_management'
       LEFT JOIN sourcing_factory_change_decisions owner_review
         ON owner_review.factory_change_request_id=change.factory_change_request_id
        AND owner_review.decision_role='owner_group'
       WHERE change.sourcing_case_id=$1
       ORDER BY change.requested_at DESC,change.factory_change_request_id DESC
       LIMIT 1`,
      [sourcingCaseId],
    );
    const row = result.rows[0];
    if (!row) return { item: null };
    const status = row.effective
      ? "effective" as const
      : row.management_decision === "rejected" || row.owner_decision === "rejected"
        ? "rejected" as const
        : row.initiator_role === "order_merchandiser" && row.management_decision === null
          ? "pending_management" as const
          : "pending_owner" as const;
    return {
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
      },
    };
  }

  async createCase(
    actor: TrustedActorContext,
    input: CreateSourcingCase,
    idempotencyKey: string,
  ): Promise<Result<SourcingCaseSummary>> {
    this.assertActor(actor, CASE_CREATE_CAPABILITY, CASE_CREATE_ROLE);
    const erpOrderNo = normalizeText(input.erpOrderNo, "平台订单号", 100);
    const craftIds = [...input.craftIds];
    if (
      craftIds.length < 1 || craftIds.length > 20
      || new Set(craftIds).size !== craftIds.length
      || craftIds.some((craftId) => !UUID_PATTERN.test(craftId))
    ) fail("工艺标识无效或重复");
    const lineItems = input.lineItems.map((line, index) => ({
      position: index + 1,
      styleNo: normalizeText(line.styleNo, "款号", 100),
      alternateStyleNo: line.alternateStyleNo
        ? normalizeText(line.alternateStyleNo, "代用款号", 100)
        : null,
      color: normalizeText(line.color, "颜色", 100),
      quantity: normalizeQuantity(line.quantity),
      externalUnitPrice: normalizeSourcingUnitPrice(line.externalUnitPrice),
    }));
    let orderQuantity: number;
    try {
      orderQuantity = calculateSourcingOrderQuantity(lineItems);
    } catch {
      return fail("订单总数量必须是1至10000000之间的整数");
    }
    const normalized = {
      erpOrderNo,
      erpOrderId: erpOrderNo,
      estimatedCutPieceSendDate: input.estimatedCutPieceSendDate,
      deliveryDate: input.deliveryDate,
      craftIds,
      lineItems,
      orderQuantity,
      daxingUnitPrice: normalizeSourcingUnitPrice(input.daxingUnitPrice),
      attachmentIds: [...(input.attachmentIds ?? [])],
    };
    const scope = "sourcing.case.create";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, normalized),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
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
              [normalized.craftIds],
            )).rows.map((craft) => ({
              position: craft.position,
              craftId: craft.craft_id,
              craftCode: craft.craft_code,
              craftVersion: craft.craft_version,
              craftName: craft.craft_name,
            }));
        if (selectedCrafts.length !== normalized.craftIds.length) {
          fail("所选工艺已停用或不存在，请重新选择", 409, "CONFLICT");
        }
        const persistedProcessItems = selectedCrafts.map((craft) => craft.craftName);
        const persistedProcessDescription = persistedProcessItems.join("、");
        const sourcingCaseId = randomUUID();
        const auditedCreationFacts = {
          erpOrderNo: normalized.erpOrderNo,
          erpOrderId: normalized.erpOrderId,
          estimatedCutPieceSendDate: normalized.estimatedCutPieceSendDate,
          deliveryDate: normalized.deliveryDate,
          craftIds: normalized.craftIds,
          lineItems: normalized.lineItems,
          orderQuantity: normalized.orderQuantity,
          attachmentIds: normalized.attachmentIds,
          daxingUnitPriceRecorded: true,
        };
        const eventId = await this.events.append(client, actor, {
          action: "sourcing.case.create",
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          after: {
            ...auditedCreationFacts,
            processes: persistedProcessItems,
            processItems: persistedProcessItems,
            processDescription: persistedProcessDescription,
            crafts: selectedCrafts,
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
             estimated_cut_piece_send_date
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            sourcingCaseId,
            normalized.erpOrderId,
            normalized.erpOrderNo,
            normalized.lineItems[0]!.styleNo,
            LANE_KEY,
            normalized.orderQuantity,
            normalized.deliveryDate,
            persistedProcessDescription,
            persistedProcessItems,
            actor.actorId,
            eventId,
            actor.requestId,
            DEFAULT_CREATION_REASON,
            normalized.daxingUnitPrice,
            normalized.estimatedCutPieceSendDate,
          ],
        );
        for (const line of normalized.lineItems) {
          await client.query(
            `INSERT INTO sourcing_case_lines(
               sourcing_case_id,position,style_no,alternate_style_no,color,quantity,
               external_unit_price,legacy_source,created_by,operation_event_id,request_id
             ) VALUES($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10)`,
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
            ],
          );
        }
        for (const craft of selectedCrafts) {
          await client.query(
            `INSERT INTO sourcing_case_crafts(
               sourcing_case_id,position,craft_id,craft_version,
               craft_code_snapshot,craft_name_snapshot,created_by,
               operation_event_id,request_id
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              sourcingCaseId,
              craft.position,
              craft.craftId,
              craft.craftVersion,
              craft.craftCode,
              craft.craftName,
              actor.actorId,
              eventId,
              actor.requestId,
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

  async quoteIePrice(
    actor: TrustedActorContext,
    sourcingCaseId: string,
    input: CreateSourcingIeQuote,
    idempotencyKey: string,
  ): Promise<Result<SourcingCaseSummary>> {
    this.assertActor(actor, IE_QUOTE_CAPABILITY, IE_QUOTE_ROLE);
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    const normalized = {
      unitPrice: normalizeSourcingUnitPrice(input.unitPrice),
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
           FROM sourcing_cases source_case
           JOIN LATERAL (
             SELECT transition_row.to_status,transition_row.sequence
             FROM sourcing_case_transitions transition_row
             WHERE transition_row.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY transition_row.sequence DESC
             LIMIT 1
           ) current_transition ON true
           WHERE source_case.sourcing_case_id=$1
             AND source_case.deleted_at IS NULL
           FOR UPDATE OF source_case`,
          [sourcingCaseId],
        );
        const source = current.rows[0];
        if (!source) return fail("报价选厂询价不存在", 404, "NOT_FOUND");
        if (source.status !== "pending_ie_quote") {
          fail("该询价已完成 IE 报价，请刷新后查看", 409, "INVALID_STATE_TRANSITION");
        }
        const quantity = Number(source.order_quantity);
        const quoteVersion = Number(source.quote_version) + 1;
        const transitionSequence = Number(source.sequence) + 1;
        const totalAmount = calculateSourcingTotal(normalized.unitPrice, quantity);
        const quoteId = randomUUID();
        const eventId = await this.events.append(client, actor, {
          action: "sourcing.ie_price.quote",
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          before: { status: "pending_ie_quote" },
          after: {
            status: "pending_management_decision",
            quoteVersion,
            unitPrice: normalized.unitPrice,
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
            normalized.unitPrice,
            quantity,
            totalAmount,
            normalized.quoteReason,
            actor.actorId,
            eventId,
            actor.requestId,
          ],
        );
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
          `sourcing:${sourcingCaseId}:ie_quote:${quoteVersion}:`,
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
          dedupeKey: `sourcing:${sourcingCaseId}:management:${quoteVersion}`,
        });
        return { statusCode: 201, response: await this.readCase(client, sourcingCaseId, actor) };
      });
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (databaseCode(error) === "23514" || databaseCode(error) === "23505") {
        fail("该询价状态已经变化，请刷新后重试", 409, "INVALID_STATE_TRANSITION");
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
    const unitPrice = normalizeSourcingUnitPrice(input.unitPrice);
    const suppliedReason = input.decisionReason?.trim() ?? "";
    const scope = "sourcing.management-decision.record";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, {
          sourcingCaseId,
          supplierId: input.supplierId,
          unitPrice,
          decisionReason: suppliedReason,
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
           FROM sourcing_cases source_case
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
           FOR UPDATE OF source_case`,
          [sourcingCaseId],
        );
        const source = current.rows[0];
        if (!source) return fail("报价选厂询价不存在", 404, "NOT_FOUND");
        if (source.status !== "pending_management_decision") {
          fail("该询价当前不在生产管理调价选厂阶段", 409, "INVALID_STATE_TRANSITION");
        }
        const sourceIeQuoteId = source.sourcing_ie_quote_id;
        const quoteUnitPrice = source.quote_unit_price;
        if (!sourceIeQuoteId || !quoteUnitPrice) {
          return fail("生产管理决定必须引用当前 IE 报价", 409, "INVALID_STATE_TRANSITION");
        }
        if (source.sourcing_decision_id && source.owner_decision !== "rejected") {
          fail("只有老板驳回后才能提交新版本", 409, "INVALID_STATE_TRANSITION");
        }
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
        const adjusted = unitPrice !== normalizeSourcingUnitPrice(quoteUnitPrice);
        if (adjusted && !suppliedReason) {
          fail("调整 IE 价格时必须填写原因");
        }
        const decisionReason = suppliedReason || DEFAULT_MANAGEMENT_REASON;
        if (decisionReason.length > 500) fail("选厂说明不能超过500个字符");
        const quantity = Number(source.order_quantity);
        const totalAmount = calculateSourcingTotal(unitPrice, quantity);
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
            unitPrice,
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
             operation_event_id,request_id
           ) VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
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
            unitPrice,
            quantity,
            totalAmount,
            decisionReason,
            actor.actorId,
            eventId,
            actor.requestId,
          ],
        );
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
          `sourcing:${sourcingCaseId}:management:${decisionVersion}:`,
          "生产管理已完成调价选厂",
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
          sourcing_decision_id: string | null;
          decision_version: number | string | null;
          source_type: string | null;
        }>(
          `SELECT current_transition.to_status AS status,current_transition.sequence,
                  decision_row.sourcing_decision_id,decision_row.decision_version,
                  decision_row.source_type
           FROM sourcing_cases source_case
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
           FOR UPDATE OF source_case`,
          [sourcingCaseId],
        );
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
          },
          reason: decisionReason,
        });
        await client.query(
          `INSERT INTO sourcing_owner_decisions(
             sourcing_owner_decision_id,sourcing_case_id,sourcing_decision_id,
             decision,decision_reason,decided_by,operation_event_id,request_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            randomUUID(),
            sourcingCaseId,
            source.sourcing_decision_id,
            input.decision,
            decisionReason,
            actor.actorId,
            eventId,
            actor.requestId,
          ],
        );
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
            dedupeKey: `sourcing:${sourcingCaseId}:management:${decisionVersion + 1}`,
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
           FROM sourcing_cases source_case
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
           FOR UPDATE OF source_case`,
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
        fail("合同登记状态已经变化，请刷新后重试", 409, "INVALID_STATE_TRANSITION");
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
    await client.query(
      `INSERT INTO sourcing_decisions(
         sourcing_decision_id,sourcing_case_id,decision_version,source_type,
         source_ie_quote_id,supersedes_decision_id,source_change_request_id,
         supplier_id,supplier_code_snapshot,supplier_name_snapshot,
         unit_price,quantity,total_amount,decision_reason,decided_by,
         operation_event_id,request_id
       ) VALUES($1,$2,$3,'factory_change',NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        randomUUID(), source.sourcing_case_id ?? fail("换厂订单标识缺失"),
        nextDecisionVersion, source.sourcing_decision_id, source.factory_change_request_id,
        source.proposed_supplier_id, source.proposed_supplier_code_snapshot,
        source.proposed_supplier_name_snapshot, source.proposed_unit_price,
        Number(source.proposed_quantity), source.proposed_total_amount,
        reason, actor.actorId, eventId, actor.requestId,
      ],
    );
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
          "转厂方案已形成新选厂版本，原生产管理待办失效",
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
    }
  }

  async requestFactoryChange(
    actor: TrustedActorContext,
    sourcingCaseId: string,
    input: RequestSourcingFactoryChange,
    idempotencyKey: string,
  ): Promise<Result<SourcingCaseSummary>> {
    const initiatorRole = this.factoryChangeInitiator(actor);
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    if (!UUID_PATTERN.test(input.supplierId)) fail("加工厂标识无效");
    const unitPrice = normalizeSourcingUnitPrice(input.unitPrice);
    const changeReason = normalizeText(input.changeReason, "换厂原因", 500);
    const scope = `sourcing.factory-change.request.${initiatorRole}`;
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, {
          sourcingCaseId, supplierId: input.supplierId, unitPrice, changeReason,
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
        }>(
          `SELECT source_case.sourcing_case_id,source_case.order_quantity,
                  transition_row.to_status AS status,transition_row.sequence,
                  decision_row.sourcing_decision_id,decision_row.supplier_id,
                  decision_row.unit_price AS decision_unit_price,
                  decision_row.decision_version,
                  COALESCE(reconciliation_row.reconciliation_version,0) AS reconciliation_version,
                  open_change.factory_change_request_id AS open_change_id
           FROM sourcing_cases source_case
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
           FOR UPDATE OF source_case`,
          [sourcingCaseId],
        );
        const source = current.rows[0];
        if (!source) return fail("报价选厂询价不存在", 404, "NOT_FOUND");
        if (!source.sourcing_decision_id || !source.decision_unit_price) {
          fail("生产管理首次提交选厂信息后才可发起订单转厂", 409, "INVALID_STATE_TRANSITION");
        }
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
        const quantity = Number(source.order_quantity);
        const totalAmount = calculateSourcingTotal(unitPrice, quantity);
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
      await client.query("COMMIT");
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
           FROM sourcing_cases source_case
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
           FOR UPDATE OF source_case`,
          [sourcingCaseId,factoryChangeRequestId],
        );
        const source = current.rows[0];
        if (!source) return fail("转厂申请不存在", 404, "NOT_FOUND");
        if (source.effective || source.management_decision === "rejected" || source.owner_decision) {
          fail("该转厂申请已经处理", 409, "INVALID_STATE_TRANSITION");
        }
        if (source.from_decision_id !== source.sourcing_decision_id) {
          fail("转厂基准版本已经变化，请重新发起", 409, "INVALID_STATE_TRANSITION");
        }
        if (
          reviewerRole === "production_management"
          && (source.initiator_role !== "order_merchandiser" || source.management_decision)
        ) fail("该转厂申请不需要生产管理审批", 409, "INVALID_STATE_TRANSITION");
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
      await client.query("COMMIT");
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
          sourcingCaseId,result: input.result,differenceFields,suppliedReason,
        }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
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
          reconciliation_version: number | string;
        }>(
          `SELECT transition_row.to_status AS status,transition_row.sequence,
                  decision_row.sourcing_decision_id,decision_row.decision_version,
                  decision_row.supplier_id,decision_row.unit_price AS expected_unit_price,
                  decision_row.quantity AS expected_quantity,
                  decision_row.total_amount AS expected_total_amount,
                  contract_row.sourcing_contract_id,
                  COALESCE(reconciliation_row.reconciliation_version,0) AS reconciliation_version
           FROM sourcing_cases source_case
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
           ) contract_row ON true
           LEFT JOIN LATERAL (
             SELECT reconciliation.reconciliation_version
             FROM sourcing_finance_reconciliations reconciliation
             WHERE reconciliation.sourcing_case_id=source_case.sourcing_case_id
             ORDER BY reconciliation.reconciliation_version DESC LIMIT 1
           ) reconciliation_row ON true
           WHERE source_case.sourcing_case_id=$1
             AND source_case.deleted_at IS NULL
           FOR UPDATE OF source_case`,
          [sourcingCaseId],
        );
        const source = current.rows[0];
        if (!source) return fail("报价选厂询价或当前选厂决定不存在", 404, "NOT_FOUND");
        if (source.status !== "pending_finance_reconciliation") {
          fail("该订单当前不在财务核对阶段", 409, "INVALID_STATE_TRANSITION");
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
          fail("订单转厂审批中，财务暂不能核对", 409, "INVALID_STATE_TRANSITION");
        }
        const expectedFactoryResult = await client.query<{
          supplier_id: string;
          supplier_code: string;
          supplier_name: string;
        }>(
          `SELECT supplier_id,supplier_code,supplier_name
           FROM current_supplier_catalog
           WHERE supplier_id=$1 AND supplier_type='factory'`,
          [source.supplier_id],
        );
        const expectedFactory = expectedFactoryResult.rows[0] ?? fail("当前批准加工厂不存在", 409, "INVALID_STATE_TRANSITION");
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
             sourcing_decision_id,sourcing_contract_id,actual_supplier_id,
             actual_supplier_code_snapshot,actual_supplier_name_snapshot,
             actual_unit_price,actual_quantity,actual_total_amount,result,
             difference_fields,difference_reason,reconciled_by,operation_event_id,request_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            reconciliationId,sourcingCaseId,reconciliationVersion,source.sourcing_decision_id,
            source.sourcing_contract_id,expectedFactory.supplier_id,expectedFactory.supplier_code,
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
        fail("财务核对状态已经变化，请刷新后重试", 409, "INVALID_STATE_TRANSITION");
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
        }>(
          `SELECT transition_row.to_status AS status,transition_row.sequence,
                  decision_row.decision_version,reconciliation_row.reconciliation_version
           FROM sourcing_cases source_case
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
             ORDER BY reconciliation.reconciliation_version DESC LIMIT 1
           ) reconciliation_row ON true
           WHERE source_case.sourcing_case_id=$1
             AND source_case.deleted_at IS NULL
           FOR UPDATE OF source_case`,
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
          const nextReconciliationVersion = Number(source.reconciliation_version)+1;
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
        fail("差异核实状态已经变化，请刷新后重试", 409, "INVALID_STATE_TRANSITION");
      }
      throw error;
    } finally {
      client.release();
    }
  }

}
