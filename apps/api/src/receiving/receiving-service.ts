import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";

type CreateReceivingInput = Readonly<{
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
}>;

type ReceivingReceipt = Readonly<{
  receiptId: string;
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  differenceQuantity: number;
  receivedBy: string;
  receivedAt: string;
}>;

type BoardRow = Readonly<{
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  differenceQuantity: number;
  receiptCount: number;
  lastReceivedAt: string;
  lastReceiverName: string;
}>;

type BoardResult = Readonly<{
  date: string;
  kpis: Readonly<{
    orderCount: number;
    receivedQuantity: number;
    differenceQuantity: number;
    differenceRate: number;
  }>;
  rows: readonly BoardRow[];
}>;

type Result<T> = Readonly<{ value: T; reused: boolean }>;

const hash = (scope: string, payload: unknown): string =>
  createHash("sha256").update(JSON.stringify({ scope, payload })).digest("hex");

const fail = (message: string, status = 400, code = "VALIDATION_ERROR"): never => {
  throw new ApplicationError(code, message, status);
};

const normalizeStyleNo = (value: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 100) fail("款号不能为空且不能超过100个字符");
  return normalized;
};

const validateQuantity = (value: number, label: string, allowZero: boolean): number => {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 10_000_000) {
    fail(`${label}必须是${allowZero ? "大于等于0" : "大于0"}的整数`);
  }
  return value;
};

export class ReceivingService {
  constructor(
    private readonly database: Pool,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
  ) {}

  async create(
    actor: TrustedActorContext,
    input: CreateReceivingInput,
    idempotencyKey: string,
  ): Promise<Result<ReceivingReceipt>> {
    const normalized = {
      styleNo: normalizeStyleNo(input.styleNo),
      documentQuantity: validateQuantity(input.documentQuantity, "收货单数量", false),
      actualQuantity: validateQuantity(input.actualQuantity, "实际收货数量", true),
    };
    const scope = "receiving.receipt.create";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: hash(scope, normalized),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => ({ statusCode: 201, response: await this.createInTransaction(client, actor, normalized) }));
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async createInTransaction(
    client: PoolClient,
    actor: TrustedActorContext,
    input: CreateReceivingInput,
  ): Promise<ReceivingReceipt> {
    const receiptId = randomUUID();
    const eventId = await this.events.append(client, actor, {
      action: "receiving.receipt.create",
      entityType: "receiving_receipt",
      entityId: receiptId,
      after: {
        receiptId,
        styleNo: input.styleNo,
        documentQuantity: input.documentQuantity,
        actualQuantity: input.actualQuantity,
        differenceQuantity: input.actualQuantity - input.documentQuantity,
      },
    });
    await client.query(
      "SELECT set_config('dx_rework.receiving_event_id',$1,true),set_config('dx_rework.receiving_request_id',$2,true)",
      [eventId, actor.requestId],
    );
    const inserted = await client.query<{
      receipt_id: string;
      style_no: string;
      document_quantity: number;
      actual_quantity: number;
      difference_quantity: number;
      received_by: string;
      received_at: Date;
    }>(
      `INSERT INTO receiving_receipts(
         receipt_id,style_no,document_quantity,actual_quantity,
         received_by,operation_event_id,request_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7)
       RETURNING receipt_id,style_no,document_quantity,actual_quantity,
                 difference_quantity,received_by,received_at`,
      [
        receiptId,
        input.styleNo,
        input.documentQuantity,
        input.actualQuantity,
        actor.actorId,
        eventId,
        actor.requestId,
      ],
    );
    const row = inserted.rows[0]!;
    return {
      receiptId: row.receipt_id,
      styleNo: row.style_no,
      documentQuantity: row.document_quantity,
      actualQuantity: row.actual_quantity,
      differenceQuantity: row.difference_quantity,
      receivedBy: row.received_by,
      receivedAt: row.received_at.toISOString(),
    };
  }

  async listStyleOptions(query = ""): Promise<readonly string[]> {
    const needle = query.trim();
    const result = await this.database.query<{ style_no: string }>(
      `SELECT source.style_no
       FROM (
         SELECT style_no FROM receiving_receipts
         UNION
         SELECT style_no FROM rework_orders WHERE style_no IS NOT NULL AND status<>'deleted'
       ) source
       WHERE ($1::text='' OR source.style_no ILIKE '%' || $1 || '%')
       ORDER BY source.style_no
       LIMIT 100`,
      [needle],
    );
    return result.rows.map((row) => row.style_no);
  }

  async board(date: string, query = ""): Promise<BoardResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("日期格式必须为YYYY-MM-DD");
    const needle = query.trim();
    const rowsResult = await this.database.query<{
      style_no: string;
      document_quantity: string;
      actual_quantity: string;
      difference_quantity: string;
      receipt_count: string;
      last_received_at: Date;
      last_receiver_name: string;
    }>(
      `WITH scoped_styles AS (
         SELECT DISTINCT style_no
         FROM receiving_receipts
         WHERE (received_at AT TIME ZONE 'Asia/Shanghai')::date=$1::date
           AND ($2::text='' OR style_no ILIKE '%' || $2 || '%')
       ), totals AS (
         SELECT r.style_no,
                sum(r.document_quantity)::bigint AS document_quantity,
                sum(r.actual_quantity)::bigint AS actual_quantity,
                sum(r.difference_quantity)::bigint AS difference_quantity,
                count(*)::bigint AS receipt_count,
                max(r.received_at) AS last_received_at
         FROM receiving_receipts r
         JOIN scoped_styles scope ON scope.style_no=r.style_no
         WHERE (r.received_at AT TIME ZONE 'Asia/Shanghai')::date<=$1::date
         GROUP BY r.style_no
       )
       SELECT totals.style_no,totals.document_quantity,totals.actual_quantity,
              totals.difference_quantity,totals.receipt_count,totals.last_received_at,
              receiver.display_name AS last_receiver_name
       FROM totals
       JOIN LATERAL (
         SELECT u.display_name
         FROM receiving_receipts latest
         JOIN app_users u ON u.id=latest.received_by
         WHERE latest.style_no=totals.style_no
           AND (latest.received_at AT TIME ZONE 'Asia/Shanghai')::date<=$1::date
         ORDER BY latest.received_at DESC,latest.receipt_id DESC
         LIMIT 1
       ) receiver ON true
       ORDER BY CASE WHEN totals.difference_quantity<0 THEN 0 WHEN totals.difference_quantity>0 THEN 1 ELSE 2 END,
                abs(totals.difference_quantity) DESC,totals.last_received_at DESC,totals.style_no`,
      [date, needle],
    );
    const rows: BoardRow[] = rowsResult.rows.map((row) => ({
      styleNo: row.style_no,
      documentQuantity: Number(row.document_quantity),
      actualQuantity: Number(row.actual_quantity),
      differenceQuantity: Number(row.difference_quantity),
      receiptCount: Number(row.receipt_count),
      lastReceivedAt: row.last_received_at.toISOString(),
      lastReceiverName: row.last_receiver_name,
    }));
    const dayStats = await this.database.query<{ received_quantity: string }>(
      `SELECT COALESCE(sum(actual_quantity),0)::bigint AS received_quantity
       FROM receiving_receipts
       WHERE (received_at AT TIME ZONE 'Asia/Shanghai')::date=$1::date
         AND ($2::text='' OR style_no ILIKE '%' || $2 || '%')`,
      [date, needle],
    );
    const differenceQuantity = rows.reduce((sum, row) => sum + Math.abs(row.differenceQuantity), 0);
    const documentQuantity = rows.reduce((sum, row) => sum + row.documentQuantity, 0);
    return {
      date,
      kpis: {
        orderCount: rows.length,
        receivedQuantity: Number(dayStats.rows[0]?.received_quantity ?? 0),
        differenceQuantity,
        differenceRate: documentQuantity === 0 ? 0 : Number(((differenceQuantity / documentQuantity) * 100).toFixed(2)),
      },
      rows,
    };
  }
}

export type { BoardResult, CreateReceivingInput, ReceivingReceipt };
