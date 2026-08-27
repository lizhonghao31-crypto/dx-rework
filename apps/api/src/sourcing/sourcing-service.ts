import { createHash, randomUUID } from "node:crypto";

import { calculateSourcingTotalExact } from "@dx-rework/contracts";
import type {
  CreateSourcingCase,
  CreateSourcingIeQuote,
  DecideSourcingOwner,
  RecordSourcingManagementDecision,
  SourcingCaseListResponse,
  SourcingFactoryListResponse,
  SourcingCaseStatus,
  SourcingCaseSummary,
  SourcingAttachmentListResponse,
  SourcingTimelineResponse,
} from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";

const CASE_CREATE_CAPABILITY = "sourcing:inquiry:create";
const IE_QUOTE_CAPABILITY = "sourcing:price:quote";
const MANAGEMENT_DECISION_CAPABILITY = "sourcing:decision:record";
const OWNER_DECISION_CAPABILITY = "sourcing:owner:approve";
const READ_CAPABILITY = "sourcing:view";
const ROOT_ROLE = "root_superuser";
const CASE_CREATE_ROLE = "order_merchandiser";
const IE_QUOTE_ROLE = "ie_reviewer";
const MANAGEMENT_DECISION_ROLE = "production_management";
const OWNER_DECISION_ROLE = "owner_group";
const LANE_KEY = "garment_processing" as const;
const DEFAULT_CREATION_REASON = "基于正式 ERP 订单创建报价选厂询价";
const DEFAULT_QUOTE_REASON = "IE核定加工价格";
const DEFAULT_MANAGEMENT_REASON = "生产管理确认加工厂与价格";
const DEFAULT_OWNER_APPROVAL_REASON = "老板批准选厂决定";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNIT_PRICE_PATTERN = /^\d{1,10}(?:\.\d{1,4})?$/;

type Result<T> = Readonly<{ value: T; reused: boolean }>;
type SqlError = Readonly<{ code?: string; constraint?: string }>;

type SourcingCaseRow = Readonly<{
  sourcing_case_id: string;
  erp_order_id: string;
  erp_order_no: string;
  style_no: string;
  lane_key: string;
  order_quantity: number | string;
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

const mapCase = (row: SourcingCaseRow): SourcingCaseSummary => ({
  sourcingCaseId: row.sourcing_case_id,
  erpOrderId: row.erp_order_id,
  erpOrderNo: row.erp_order_no,
  styleNo: row.style_no,
  laneKey: LANE_KEY,
  orderQuantity: Number(row.order_quantity),
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
});

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null ? (error as SqlError).code : undefined;

export class SourcingService {
  constructor(
    private readonly database: Pool,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
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
  ): Promise<SourcingCaseSummary> {
    const result = await client.query<SourcingCaseRow>(
      `SELECT
         case_view.sourcing_case_id,case_view.erp_order_id,case_view.erp_order_no,
         case_view.style_no,case_view.lane_key,case_view.order_quantity,
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
    return mapCase(row);
  }

  async listCases(
    actor: TrustedActorContext,
    query = "",
  ): Promise<SourcingCaseListResponse> {
    this.assertReader(actor);
    const normalizedQuery = query.trim();
    if (normalizedQuery.length > 100) fail("搜索内容不能超过100个字符");
    const result = await this.database.query<SourcingCaseRow>(
      `SELECT
         case_view.sourcing_case_id,case_view.erp_order_id,case_view.erp_order_no,
         case_view.style_no,case_view.lane_key,case_view.order_quantity,
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
       WHERE $1='' OR case_view.erp_order_no ILIKE '%'||$1||'%'
          OR case_view.style_no ILIKE '%'||$1||'%'
       ORDER BY case_view.created_at DESC
       LIMIT 200`,
      [normalizedQuery],
    );
    return { items: result.rows.map(mapCase) };
  }

  async getCase(
    actor: TrustedActorContext,
    sourcingCaseId: string,
  ): Promise<SourcingCaseSummary> {
    this.assertReader(actor);
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    return this.readCase(this.database, sourcingCaseId);
  }

  async listAttachments(
    actor: TrustedActorContext,
    sourcingCaseId: string,
  ): Promise<SourcingAttachmentListResponse> {
    this.assertReader(actor);
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
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

  async listTimeline(
    actor: TrustedActorContext,
    sourcingCaseId: string,
  ): Promise<SourcingTimelineResponse> {
    this.assertReader(actor);
    if (!UUID_PATTERN.test(sourcingCaseId)) fail("报价选厂询价标识无效");
    const result = await this.database.query<{
      entry_id: string;
      kind: "created" | "ie_quote" | "management_decision" | "owner_decision";
      entry_version: number | string;
      handled_by: string;
      handled_at: Date | string;
      reason: string;
      unit_price: string | null;
      total_amount: string | null;
      supplier_name: string | null;
      decision: "approved" | "rejected" | null;
    }>(
      `WITH timeline AS (
         SELECT source_case.sourcing_case_id AS entry_id,'created'::text AS kind,
                1 AS entry_version,source_case.created_by AS actor_id,
                source_case.created_at AS handled_at,source_case.creation_reason AS reason,
                NULL::numeric AS unit_price,NULL::numeric AS total_amount,
                NULL::text AS supplier_name,NULL::text AS decision
         FROM sourcing_cases source_case
         WHERE source_case.sourcing_case_id=$1
         UNION ALL
         SELECT quote.sourcing_ie_quote_id,'ie_quote',quote.quote_version,quote.quoted_by,
                quote.quoted_at,quote.quote_reason,quote.unit_price,quote.total_amount,
                NULL::text,NULL::text
         FROM sourcing_ie_quotes quote WHERE quote.sourcing_case_id=$1
         UNION ALL
         SELECT choice.sourcing_decision_id,'management_decision',choice.decision_version,
                choice.decided_by,choice.decided_at,choice.decision_reason,
                choice.unit_price,choice.total_amount,choice.supplier_name_snapshot,NULL::text
         FROM sourcing_decisions choice WHERE choice.sourcing_case_id=$1
         UNION ALL
         SELECT owner.sourcing_owner_decision_id,'owner_decision',
                row_number() OVER (ORDER BY owner.decided_at,owner.sourcing_owner_decision_id),
                owner.decided_by,owner.decided_at,owner.decision_reason,
                NULL::numeric,NULL::numeric,NULL::text,owner.decision
         FROM sourcing_owner_decisions owner WHERE owner.sourcing_case_id=$1
       )
       SELECT timeline.entry_id,timeline.kind,timeline.entry_version,
              COALESCE(app_user.display_name,'系统用户') AS handled_by,
              timeline.handled_at,timeline.reason,
              timeline.unit_price::text,timeline.total_amount::text,
              timeline.supplier_name,timeline.decision
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

  async createCase(
    actor: TrustedActorContext,
    input: CreateSourcingCase,
    idempotencyKey: string,
  ): Promise<Result<SourcingCaseSummary>> {
    this.assertActor(actor, CASE_CREATE_CAPABILITY, CASE_CREATE_ROLE);
    const erpOrderNo = normalizeText(input.erpOrderNo, "ERP订单号", 100);
    const normalized = {
      erpOrderNo,
      erpOrderId: erpOrderNo,
      styleNo: normalizeText(input.styleNo, "款号", 100),
      orderQuantity: normalizeQuantity(input.orderQuantity),
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
        const sourcingCaseId = randomUUID();
        const eventId = await this.events.append(client, actor, {
          action: "sourcing.case.create",
          entityType: "sourcing_case",
          entityId: sourcingCaseId,
          after: {
            ...normalized,
            laneKey: LANE_KEY,
            status: "pending_ie_quote",
            attachmentCount: normalized.attachmentIds.length,
          },
          reason: DEFAULT_CREATION_REASON,
        });
        await client.query(
          `INSERT INTO sourcing_cases(
             sourcing_case_id,erp_order_id,erp_order_no,style_no,lane_key,
             order_quantity,created_by,operation_event_id,request_id,creation_reason
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            sourcingCaseId,
            normalized.erpOrderId,
            normalized.erpOrderNo,
            normalized.styleNo,
            LANE_KEY,
            normalized.orderQuantity,
            actor.actorId,
            eventId,
            actor.requestId,
            DEFAULT_CREATION_REASON,
          ],
        );
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
        return { statusCode: 201, response: await this.readCase(client, sourcingCaseId) };
      });
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (databaseCode(error) === "23505") {
        fail("该 ERP 订单已经创建过加工厂报价选厂询价", 409, "CONFLICT");
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
        return { statusCode: 201, response: await this.readCase(client, sourcingCaseId) };
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
        return { statusCode: 201, response: await this.readCase(client, sourcingCaseId) };
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
    if (input.decision === "rejected" && !suppliedReason) fail("驳回原因不能为空");
    const decisionReason = suppliedReason || DEFAULT_OWNER_APPROVAL_REASON;
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
           FOR UPDATE OF source_case`,
          [sourcingCaseId],
        );
        const source = current.rows[0];
        if (!source) return fail("报价选厂询价不存在", 404, "NOT_FOUND");
        if (
          source.status !== "pending_owner_approval"
          || !source.sourcing_decision_id
          || source.source_type === "factory_change"
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
            status: approved ? "pending_contract" : "pending_management_decision",
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
            approved ? "pending_contract" : "pending_management_decision",
            approved ? "owner_approved" : "owner_rejected",
            decisionReason,
            actor.actorId,
            eventId,
            actor.requestId,
          ],
        );
        return { statusCode: 201, response: await this.readCase(client, sourcingCaseId) };
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

}
