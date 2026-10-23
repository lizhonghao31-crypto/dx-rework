import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { resolveDigitalSlaSnapshot } from "@dx-rework/contracts/digital-sla";
import { evaluateSlaPlan, slaBusinessProgress, type SlaAnchor } from "@dx-rework/domain/digital-sla-plan";
import { SystemBusinessClock, validateBusinessTime, type BusinessClock, type BusinessTime } from "@dx-rework/domain/business-clock";
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalProductionAccessPolicy } from "./access-policy.js";
import { SlaConfigurationRepository } from "./sla-configuration-repository.js";
import { SlaPlanRepository } from "./sla-plan-repository.js";
import { buildOrderSlaRoute, type SlaRouteSelection } from "./sla-route.js";
import { developmentDocumentRow } from "./development-round-repository.js";

/** Creation and reads reuse order authorization; there is no generic event/date edit endpoint. */
export class SlaOrderService {
  constructor(private readonly database: Pool, private readonly clock: BusinessClock = new SystemBusinessClock()) {}

  async enrollNewOrder(client: PoolClient, actor: TrustedActorContext, orderId: string, creationEventId: string, time: BusinessTime) {
    validateBusinessTime(time);
    const plans = new SlaPlanRepository(client);
    // Old schema can keep creating orders until the additive migration is applied. Never retrofit historical P0.
    if (!await plans.available()) return;
    const order = (await client.query("SELECT * FROM digital_production_orders WHERE production_order_id=$1", [orderId])).rows[0];
    const evidence = (await client.query("SELECT action,entity_id,actor_id FROM audit_events WHERE id=$1", [creationEventId])).rows[0];
    if (!order || evidence?.action !== "digital_order_created" || evidence.entity_id !== orderId || evidence.actor_id !== actor.actorId) throw new Error("SLA enrollment requires the current order creation event");
    if ((await plans.plans(orderId)).length) return;
    const repo = new SlaConfigurationRepository(client), config = await repo.initialStandard(actor.actorId);
    const snapshot = await repo.appendOrder({ orderId, expectedRevision: 0, configurationId: config.configurationId,
      snapshot: resolveDigitalSlaSnapshot({ version: config.version, values: config.values }), actorId: actor.actorId,
      reason: "新订单保存首版时效标准", requestKey: randomUUID() });
    const anchors: Record<string, SlaAnchor> = {
      customer_order_confirmed: { precision: "instant", value: time.now, source: `audit_events:${creationEventId}` },
      expected_fabric_arrival: { precision: "unknown", reason: "未填预计到布日期，布料线暂不能预计" },
      sourcing_accepted: { precision: "unknown", reason: "外发申请尚无接受时间，商务线暂不能预计" },
    };
    let developmentCraft: SlaRouteSelection["developmentCraft"] = "unknown", washing: SlaRouteSelection["washing"] = "unknown";
    if (order.source_id) {
      const document = await developmentDocumentRow(client, order.source_id);
      if (document?.published_at) anchors.development_published = { precision: "instant", value: new Date(document.published_at).toISOString(), source: `development:${order.source_id}:round:${document.round_number ?? 1}:published` };
      const craft = document?.document?.craft;
      developmentCraft = craft === "无" ? "none" : craft === "印花" ? "printing" : craft === "绣花" ? "embroidery" : craft === "印绣花" ? "print_embroidery" : "unknown";
      const wash = document?.document?.washing;
      washing = wash === "免洗" ? "no" : wash === "内洗" || wash === "外洗" ? "yes" : "unknown";
    }
    const lines = (await client.query("SELECT line_id,customer_warehouse_arrival_date::text AS customer_date,factory_delivery_date::text AS factory_date FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position", [orderId])).rows;
    for (const line of lines) {
      if (line.customer_date) anchors[`customer_shipping_date:${line.line_id}`] = { precision: "date", value: line.customer_date, source: `po:${line.line_id}:customer_date` };
      if (line.factory_date) anchors[`factory_delivery_date:${line.line_id}`] = { precision: "date", value: line.factory_date, source: `po:${line.line_id}:factory_date` };
    }
    const plan = buildOrderSlaRoute(snapshot.snapshot, { developmentCraft, washing, bulkCraft: "unknown" }, anchors, lines.map(row => row.line_id));
    const saved = await plans.appendPlan({ orderId, expectedRevision: 0, snapshotId: snapshot.snapshotId, plan, time, actorId: actor.actorId,
      reason: "新订单保存全链首版计划；未有依据的日期保持未知", requestKey: randomUUID() });
    for (const nodeId of ["order_creation", "customer_confirmation"]) {
      await plans.appendFact({ orderId, nodeId, planId: saved.planId, expectedRevision: 0,
        fact: { completedAt: time.now, evidence: `audit_events:${creationEventId}` }, time, actorId: actor.actorId,
        reason: "本次有效创建及确认事件", requestKey: randomUUID() });
    }
    await plans.appendFact({ orderId, nodeId: "production_sheet", planId: saved.planId, expectedRevision: 0,
      fact: { startedAt: time.now, evidence: `audit_events:${creationEventId}`,
        standardMinutes: plan.nodes.find(n => n.id === "production_sheet")!.minutes! }, time, actorId: actor.actorId,
      reason: "本次确认客户订单起制单72小时", requestKey: randomUUID() });
    // Development published before this order has no captured original SLA standard here.
    // PR03 transfers a registered source plan; do not retrospectively rate legacy work against today's standard.
  }

  async read(actor: TrustedActorContext, orderId: string) {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await new DigitalProductionAccessPolicy(client).assert(actor, "order", orderId, "technical");
      const repo = new SlaPlanRepository(client), time = validateBusinessTime(await this.clock.read({ kind: "order", id: orderId }));
      const history = await repo.available() ? await repo.plans(orderId) : [];
      const current = history.at(-1);
      if (!current) { await client.query("COMMIT"); return { status: "legacy_unenrolled" as const, time, reason: "此历史订单未建立首版计划，未补造历史时间" }; }
      if (current.time.scenarioId !== time.scenarioId) throw new Error("SLA clock scope mismatch");
      const facts = await repo.facts(orderId), nodes = evaluateSlaPlan(current.plan, facts, time);
      const progress = slaBusinessProgress(current.plan, Object.entries(facts).filter(([, f]) => f.completedAt).map(([id]) => id));
      await client.query("COMMIT");
      return { status: "planned" as const, time, original: history[0]!, current, history, nodes, progress };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
}
