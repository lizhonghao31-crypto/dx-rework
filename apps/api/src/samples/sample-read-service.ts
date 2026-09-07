import { SampleAnalysisService } from './sample-analysis-service.js';
import type { Pool, PoolClient } from "pg";
import {
  SAMPLE_PAGE_SIZE, projectSampleView, SampleReadQuerySchema, SampleListResponseSchema,
  SampleDetailResponseSchema, SampleHistoryQuerySchema, SampleHistoryResponseSchema,
  SampleOptionsSchema, SampleAmountsSchema, type SampleReadQuery,
} from "@dx-rework/contracts";
import { ApplicationError } from "../platform/errors.js";
import { isRootActor } from "../access/business-authority.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { canUseSampleCapability, requireSampleCapability } from "./sample-authority.js";

const pending = ["borrow_pending", "return_pending", "disposal_pending", "loss_payment_pending"];
const terminal = ["sold", "gifted", "scrapped", "lost"];
const fields = `s.sample_id AS "sampleId", s.sample_code AS "sampleCode", s.status, s.version,
 s.brand, s.style_name AS "styleName", s.style_no AS "styleNo", s.category, s.color, s.size, s.department,
 to_char(s.purchase_date,'YYYY-MM-DD') AS "purchaseDate", s.purchaser_user_id AS "purchaserUserId",
 s.purchaser_name AS "purchaserName", s.holder_user_id AS "holderUserId", s.holder_name AS "holderName",
 s.purpose, s.borrowed_at::text AS "borrowedAt", s.storage_location AS "storageLocation", s.remark,
 s.created_at::text AS "createdAt", s.updated_at::text AS "updatedAt"`;
const financialFields = `, jsonb_build_object('purchasePrice',f.purchase_price::text,'receiptAttachmentIds',
 ARRAY(SELECT b.attachment_id FROM sample_attachment_bindings b
 WHERE b.sample_id=s.sample_id AND b.purpose='purchase_receipt' AND b.active ORDER BY b.attachment_id)) AS finance`;

export function sampleReadFilter(actor: TrustedActorContext, q: SampleReadQuery) {
  const values: unknown[] = [];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const conditions = ["s.status<>'archived'"];
  if (q.view === "borrowed") conditions.push("s.status='borrowed'");
  if (q.view === "in_stock") conditions.push("s.status='in_stock'");
  if (q.view === "managed") conditions.push(`NOT(s.status=ANY(${bind(terminal)}::text[]))`);
  if (q.view === "disposed") conditions.push(`s.status=ANY(${bind(terminal)}::text[])`);
  if (q.view === "pending") {
    conditions.push(`s.status=ANY(${bind(pending)}::text[])`);
    if (!isRootActor(actor)) {
      const types: string[] = [];
      if (canUseSampleCapability(actor, "sample:borrow_confirm")) types.push("borrow");
      if (canUseSampleCapability(actor, "sample:return_confirm")) types.push("return");
      if (canUseSampleCapability(actor, "sample:dispose_approve")) types.push("sale", "gift", "scrap", "loss");
      const own = bind(actor.actorId), eligible = bind(types);
      conditions.push(`EXISTS(SELECT 1 FROM sample_workflow_requests r WHERE r.sample_id=s.sample_id
        AND r.status IN ('pending','payment_pending') AND (r.requested_by=${own}::uuid OR r.requested_for=${own}::uuid
        OR (r.status='pending' AND r.request_type=ANY(${eligible}::text[]))
        ${canUseSampleCapability(actor, "sample:loss_close") ? "OR (r.status='payment_pending' AND r.request_type='loss')" : ""}))`);
    }
  }
  if (q.search) {
    const pattern = bind(`${q.search.replace(/[\\%_]/g, "\\$&")}%`);
    conditions.push(`(upper(s.sample_code) LIKE upper(${pattern}) OR upper(s.style_no) LIKE upper(${pattern}))`);
  }
  if (q.purchaseYear) conditions.push(`s.purchase_date>=make_date(${bind(q.purchaseYear)}::int,1,1) AND s.purchase_date<make_date(${bind(q.purchaseYear + 1)}::int,1,1)`);
  if (q.holderUserId) conditions.push(`s.holder_user_id=${bind(q.holderUserId)}::uuid`);
  if (q.brand) conditions.push(`s.brand=${bind(q.brand)}`);
  if (q.department) conditions.push(`s.department=${bind(q.department)}`);
  if (q.status) conditions.push(`s.status=${bind(q.status)}`);
  if (q.disposalType || q.disposedFrom || q.disposedTo || q.personUserId) {
    const disposalConditions = ["d.sample_id=s.sample_id", "d.approved_at IS NOT NULL"];
    if (q.disposalType) disposalConditions.push(`d.disposal_type=${bind(q.disposalType)}`);
    if (q.disposedFrom) disposalConditions.push(`COALESCE(d.paid_at,d.approved_at)>=(${bind(q.disposedFrom)}::date::timestamp AT TIME ZONE 'Asia/Shanghai')`);
    if (q.disposedTo) disposalConditions.push(`COALESCE(d.paid_at,d.approved_at)<((${bind(q.disposedTo)}::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')`);
    if (q.personUserId) {
      const person = bind(q.personUserId);
      disposalConditions.push(`(d.responsible_user_id=${person}::uuid OR d.approved_by=${person}::uuid OR s.purchaser_user_id=${person}::uuid
        OR EXISTS(SELECT 1 FROM sample_workflow_requests initiator WHERE initiator.request_id=d.request_id AND initiator.requested_by=${person}::uuid))`);
    }
    conditions.push(`EXISTS(SELECT 1 FROM sample_disposals d WHERE ${disposalConditions.join(" AND ")})`);
  }
  return { where: conditions.join(" AND "), values };
}

export class SampleReadService {
  constructor(private readonly database: Pool) {}

  async analysis(actor: TrustedActorContext, input: unknown) { return new SampleAnalysisService(this.database).read(actor,input); }

  private async snapshot<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async list(actor: TrustedActorContext, input: unknown) {
    requireSampleCapability(actor, "sample:view_basic");
    const q = SampleReadQuerySchema.parse(input), finance = canUseSampleCapability(actor, "sample:view_finance");
    const filter = sampleReadFilter(actor, q);
    return this.snapshot(async client => {
      const total = await client.query(`SELECT count(*)::int AS total FROM sample_items s WHERE ${filter.where}`, filter.values);
      const rows = await client.query(`SELECT ${fields}${finance ? financialFields : ""} FROM sample_items s
        ${finance ? "JOIN sample_financial_facts f ON f.sample_id=s.sample_id" : ""}
        WHERE ${filter.where} ORDER BY s.created_at DESC,s.sample_id
        LIMIT ${SAMPLE_PAGE_SIZE} OFFSET $${filter.values.length + 1}`, [...filter.values, (q.page - 1) * SAMPLE_PAGE_SIZE]);
      const counts = await client.query(`SELECT count(*) FILTER(WHERE status='borrowed')::int AS borrowed,
        count(*) FILTER(WHERE status='in_stock')::int AS "inStock",
        count(*) FILTER(WHERE status=ANY($1::text[]))::int AS pending FROM sample_items`, [pending]);
      return SampleListResponseSchema.parse({ items: rows.rows.map(row => projectSampleView(row, finance)),
        page: q.page, totalCount: total.rows[0].total, counts: counts.rows[0] });
    });
  }

  async detail(actor: TrustedActorContext, sampleId: string) {
    requireSampleCapability(actor, "sample:view_basic");
    const finance = canUseSampleCapability(actor, "sample:view_finance");
    const result = await this.database.query(`SELECT ${fields}${finance ? financialFields : ""} FROM sample_items s
      ${finance ? "JOIN sample_financial_facts f ON f.sample_id=s.sample_id" : ""}
      WHERE s.sample_id=$1 AND (s.status<>'archived' OR $2)`, [sampleId, isRootActor(actor)]);
    if (!result.rows[0]) throw new ApplicationError("NOT_FOUND", "样衣不存在或已归档", 404);
    return SampleDetailResponseSchema.parse({ item: projectSampleView(result.rows[0], finance),
      canViewAudit: canUseSampleCapability(actor, "sample:view_audit") });
  }

  async history(actor: TrustedActorContext, sampleId: string, input: unknown) {
    const q = SampleHistoryQuerySchema.parse(input);
    await this.detail(actor, sampleId);
    if (q.kind === "audit") requireSampleCapability(actor, "sample:view_audit");
    const finance = canUseSampleCapability(actor, "sample:view_finance");
    // Never return raw legacy payloads or arbitrary before/after JSON to basic readers.
    const sources = {
      custody: { from: "sample_custody_records h", where: "h.sample_id=$1", time: "h.borrowed_at", id: "h.custody_id",
        fields: "h.holder_name AS \"actorName\", CASE WHEN h.initial_custody THEN 'initial_custody' ELSE 'borrow' END AS kind, h.purpose, h.returned_at::text AS \"returnedAt\", h.disposed_at::text AS \"disposedAt\"" },
      disposal: { from: "sample_disposals h JOIN sample_workflow_requests r ON r.request_id=h.request_id", where: "h.sample_id=$1", time: "r.created_at", id: "h.disposal_id",
        fields: `r.requested_by_name AS "actorName", h.disposal_type AS kind, r.status, h.recipient${finance ? ", h.final_amount::text AS amount" : ""}` },
      audit: { from: "operation_events h LEFT JOIN sample_event_actor_snapshots snapshot ON snapshot.event_id=h.event_id", where: "h.entity_type='sample' AND h.entity_id=$1", time: "h.created_at", id: "h.event_id",
        fields: "COALESCE(snapshot.actor_name,'历史操作人（未留存当时姓名）') AS \"actorName\", h.action AS kind" },
    };
    const source = sources[q.kind];
    return this.snapshot(async client => {
      const total = await client.query(`SELECT count(*)::int AS total FROM ${source.from} WHERE ${source.where}`, [sampleId]);
      const rows = await client.query(`SELECT ${source.id} AS id, ${source.time}::text AS "occurredAt", ${source.fields}
        FROM ${source.from} WHERE ${source.where} ORDER BY ${source.time} DESC,${source.id}
        LIMIT ${SAMPLE_PAGE_SIZE} OFFSET $2`, [sampleId, (q.page - 1) * SAMPLE_PAGE_SIZE]);
      return SampleHistoryResponseSchema.parse({ items: rows.rows, page: q.page, totalCount: total.rows[0].total });
    });
  }

  async options(actor: TrustedActorContext) {
    requireSampleCapability(actor, "sample:view_basic");
    return this.snapshot(async client => {
      const values = await client.query(`SELECT
        ARRAY(SELECT DISTINCT brand FROM sample_items WHERE status<>'archived' ORDER BY brand) AS brands,
        ARRAY(SELECT DISTINCT department FROM sample_items WHERE status<>'archived' ORDER BY department) AS departments,
        ARRAY(SELECT DISTINCT extract(year FROM purchase_date)::int FROM sample_items WHERE status<>'archived' ORDER BY 1 DESC) AS "purchaseYears"`);
      const people = await client.query(`SELECT DISTINCT u.id AS "userId",u.display_name AS name FROM app_users u
        WHERE EXISTS(SELECT 1 FROM sample_items s WHERE s.status<>'archived' AND (s.holder_user_id=u.id OR s.purchaser_user_id=u.id))
        OR EXISTS(SELECT 1 FROM sample_disposals d JOIN sample_items s ON s.sample_id=d.sample_id
        JOIN sample_workflow_requests r ON r.request_id=d.request_id
        WHERE s.status<>'archived' AND (d.responsible_user_id=u.id OR d.approved_by=u.id OR r.requested_by=u.id)) ORDER BY name,"userId"`);
      return SampleOptionsSchema.parse({ ...values.rows[0], people: people.rows });
    });
  }

  async amounts(actor: TrustedActorContext) {
    requireSampleCapability(actor, "sample:view_finance");
    const result = await this.database.query(`SELECT
      COALESCE(sum(f.purchase_price),0)::numeric(24,2)::text AS "purchaseTotal",
      COALESCE(sum(f.purchase_price) FILTER(WHERE NOT(s.status=ANY($1::text[]))),0)::numeric(24,2)::text AS "managedOriginalValue",
      COALESCE(sum(f.purchase_price) FILTER(WHERE s.status=ANY($1::text[])),0)::numeric(24,2)::text AS "disposedOriginalValue",
      (SELECT COALESCE(sum(d.final_amount),0)::numeric(24,2)::text FROM sample_disposals d JOIN sample_items i ON i.sample_id=d.sample_id
       WHERE i.status='sold' AND d.disposal_type='sale' AND d.approved_at IS NOT NULL) AS "saleReceipts",
      (SELECT COALESCE(sum(d.final_amount),0)::numeric(24,2)::text FROM sample_disposals d JOIN sample_items i ON i.sample_id=d.sample_id
       WHERE i.status='lost' AND d.disposal_type='loss' AND d.paid_at IS NOT NULL) AS "lossCompensation"
      FROM sample_items s JOIN sample_financial_facts f ON f.sample_id=s.sample_id WHERE s.status<>'archived'`, [terminal]);
    return SampleAmountsSchema.parse(result.rows[0]);
  }
}

