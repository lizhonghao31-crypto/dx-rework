import { createHash, randomUUID } from "node:crypto";

import type {
  CreateSourcingCase,
  CreateSourcingIeQuote,
  SourcingCaseListResponse,
  SourcingCaseStatus,
  SourcingCaseSummary,
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
const READ_CAPABILITY = "sourcing:view";
const ROOT_ROLE = "root_superuser";
const CASE_CREATE_ROLE = "order_merchandiser";
const IE_QUOTE_ROLE = "ie_reviewer";
const LANE_KEY = "garment_processing" as const;
const DEFAULT_CREATION_REASON = "基于正式 ERP 订单创建报价选厂询价";
const DEFAULT_QUOTE_REASON = "IE核定加工价格";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNIT_PRICE_PATTERN = /^\d{1,10}(?:\.\d{1,4})?$/;
const MAX_TOTAL_CENTS = 999_999_999_999_999_999n;

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
  const cents = (scaledUnitPrice(unitPrice) * BigInt(normalizedQuantity) + 50n) / 100n;
  if (cents <= 0n || cents > MAX_TOTAL_CENTS) {
    fail("报价总额超出系统允许范围");
  }
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
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
         quote_row.quoted_by,quote_row.quoted_at
       FROM current_sourcing_cases case_view
       LEFT JOIN LATERAL (
         SELECT quote.*
         FROM sourcing_ie_quotes quote
         WHERE quote.sourcing_case_id=case_view.sourcing_case_id
         ORDER BY quote.quote_version DESC
         LIMIT 1
       ) quote_row ON true
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
         quote_row.quoted_by,quote_row.quoted_at
       FROM current_sourcing_cases case_view
       LEFT JOIN LATERAL (
         SELECT quote.*
         FROM sourcing_ie_quotes quote
         WHERE quote.sourcing_case_id=case_view.sourcing_case_id
         ORDER BY quote.quote_version DESC
         LIMIT 1
       ) quote_row ON true
       WHERE $1='' OR case_view.erp_order_no ILIKE '%'||$1||'%'
          OR case_view.style_no ILIKE '%'||$1||'%'
       ORDER BY case_view.created_at DESC
       LIMIT 200`,
      [normalizedQuery],
    );
    return { items: result.rows.map(mapCase) };
  }

  async createCase(
    actor: TrustedActorContext,
    input: CreateSourcingCase,
    idempotencyKey: string,
  ): Promise<Result<SourcingCaseSummary>> {
    this.assertActor(actor, CASE_CREATE_CAPABILITY, CASE_CREATE_ROLE);
    const normalized = {
      erpOrderNo: normalizeText(input.erpOrderNo, "ERP订单号", 100),
      erpOrderId: normalizeText(input.erpOrderId ?? input.erpOrderNo, "ERP订单稳定标识", 200),
      styleNo: normalizeText(input.styleNo, "款号", 100),
      orderQuantity: normalizeQuantity(input.orderQuantity),
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
}
