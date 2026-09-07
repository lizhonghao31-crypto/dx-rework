import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ProductionExclusionInputSchema, ProductionExclusionPreviewSchema, type ProductionExclusionInput, type ProductionExclusionPreview } from "@dx-rework/contracts";
import { ApplicationError } from "../platform/errors.js";
import { IdempotencyService, OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
import { selectProduction, toOrder, type ProductionRow } from "./sourcing-production-service.js";

const fail = (message: string, status = 409): never => { throw new ApplicationError(status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : status === 400 ? "VALIDATION_ERROR" : "INVALID_STATE_TRANSITION", message, status); };
export function requireProductionExclusionRoot(actor: TrustedActorContext): void {
  if (!actor.actorRoles.includes("root_superuser")) fail("仅Root可预览和排除测试生产记录", 403);
}
export const productionExclusionVersion = (facts: unknown): string => createHash("sha256").update(JSON.stringify(facts)).digest("hex");
export function validateProductionExclusion(preview: ProductionExclusionPreview, input: ProductionExclusionInput): void {
  if (input.confirmedProductionOrderId !== preview.order.productionOrderId) fail("确认对象与预览不一致，请重新预览", 400);
  if (preview.version !== input.expectedVersion) fail("生产记录已变化，请重新预览后确认");
  if (preview.exclusion) fail("该生产记录已排除，请查看已保存的原因");
}
export class ProductionExclusionService {
  constructor(private readonly database: Pool, private readonly idempotency = new IdempotencyService(), private readonly events = new OperationEventRepository()) {}
  private async read(client: PoolClient, id: string): Promise<ProductionExclusionPreview> {
    const selected = await client.query<ProductionRow>(`${selectProduction} WHERE production.production_order_id=$1`, [id]);
    if (!selected.rows[0]) fail("生产订单不存在，请核对精确ID", 404);
    const order = toOrder(selected.rows[0]!);
    const facts = await client.query<{ report_ids: string[]; transition_ids: string[]; receipt_ids: string[] }>(`SELECT
      ARRAY(SELECT report_id::text FROM sourcing_production_reports WHERE production_order_id=$1 ORDER BY report_id) AS report_ids,
      ARRAY(SELECT production_transition_id::text FROM sourcing_production_transitions WHERE production_order_id=$1 ORDER BY sequence) AS transition_ids,
      ARRAY(SELECT receipt_id::text FROM sourcing_production_receipt_links WHERE production_order_id=$1 ORDER BY receipt_id) AS receipt_ids`, [id]);
    const exclusion = await client.query<{ reason: string; excluded_by: string; excluded_at: Date; operation_event_id: string }>(
      "SELECT reason,excluded_by,excluded_at,operation_event_id FROM sourcing_production_exclusions WHERE production_order_id=$1", [id]);
    const row = exclusion.rows[0], links = facts.rows[0]!;
    return ProductionExclusionPreviewSchema.parse({ order, version: productionExclusionVersion({ order, ...links }),
      reportCount: links.report_ids.length, receiptIds: links.receipt_ids,
      exclusion: row ? { reason: row.reason, excludedBy: row.excluded_by, excludedAt: new Date(row.excluded_at).toISOString(), operationEventId: row.operation_event_id } : null });
  }
  async preview(actor: TrustedActorContext, id: string): Promise<ProductionExclusionPreview> {
    requireProductionExclusionRoot(actor);
    if (!z.string().uuid().safeParse(id).success) fail("请填写完整生产订单ID", 400);
    const client = await this.database.connect();
    try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await this.read(client, id); await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }
  async exclude(actor: TrustedActorContext, id: string, input: ProductionExclusionInput, key: string) {
    requireProductionExclusionRoot(actor);
    const parsed = ProductionExclusionInputSchema.safeParse(input);
    if (!parsed.success || !z.string().uuid().safeParse(id).success || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) fail("请重新预览、填写原因并确认精确对象", 400);
    const data = parsed.data, client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT production_order_id FROM sourcing_production_orders WHERE production_order_id=$1 FOR UPDATE", [id]);
      const result = await this.idempotency.execute(client, { scope: "sourcing.production.exclude", actorKey: actor.actorId, key,
        requestHash: productionExclusionVersion({ id, input: data }), expiresAt: new Date(Date.now() + 86400000) }, async () => {
        const preview = await this.read(client, id);
        validateProductionExclusion(preview, data);
        // Same lock/order as report-driven projections prevents reopening a resolved alert.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('production-closure'))");
        const eventId = await this.events.append(client, actor, { action: "sourcing.production.exclude", entityType: "sourcing_production_order", entityId: id,
          before: { order: preview.order, reportCount: preview.reportCount, receiptIds: preview.receiptIds },
          after: { productionOrderId: id, excluded: true, previewVersion: data.expectedVersion, reason: data.reason }, reason: data.reason });
        await client.query("INSERT INTO sourcing_production_exclusions(production_order_id,preview_version,reason,excluded_by,operation_event_id) VALUES($1,$2,$3,$4,$5)", [id, data.expectedVersion, data.reason, actor.actorId, eventId]);
        await client.query("UPDATE sourcing_production_alerts SET resolved_at=clock_timestamp() WHERE production_order_id=$1 AND resolved_at IS NULL", [id]);
        return { statusCode: 200, response: await this.read(client, id) };
      });
      await client.query("COMMIT"); return { value: result.response, reused: result.reused };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }
}
