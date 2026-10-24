import {factorySlaEvidence,factoryEvaluationPlan} from './factory-sla-evidence.js';
import {bulkSlaEvidence} from "./bulk-sla-evidence.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { resolveDigitalSlaSnapshot, validateDigitalSlaSnapshot } from "@dx-rework/contracts/digital-sla";
import { evaluateSlaPlan, slaBusinessProgress, type SlaAnchor } from "@dx-rework/domain/digital-sla-plan";
import { SystemBusinessClock, validateBusinessTime, type BusinessClock, type BusinessTime } from "@dx-rework/domain/business-clock";
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalProductionAccessPolicy } from "./access-policy.js";
import { SlaConfigurationRepository } from "./sla-configuration-repository.js";
import { SlaPlanRepository } from "./sla-plan-repository.js";
import { buildOrderSlaRoute, type SlaRouteSelection } from "./sla-route.js";
import { developmentDocumentRow } from "./development-round-repository.js";
import { developmentSlaPlan } from "./development-sla-enrollment.js";
import { developmentEvaluationPlan, developmentSlaEvidence } from "./development-sla-evidence.js";
import { applyOrderCreationEvidence, orderCreationSlaEvidence } from "./sla-order-evidence.js";

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
    const sourcePlan = order.source_id ? await developmentSlaPlan(client, order.source_id) : null;
    if (sourcePlan && (sourcePlan.business_time.scenarioId !== time.scenarioId
      || Date.parse(sourcePlan.business_time.now) > Date.parse(time.now))) throw new Error("Development/order SLA clock scope mismatch");
    const repo = new SlaConfigurationRepository(client);
    const config = sourcePlan ? null : await repo.initialStandard(actor.actorId);
    const snapshot = await repo.appendOrder({ orderId, expectedRevision: 0, configurationId: sourcePlan?.configuration_id ?? config!.configurationId,
      snapshot: sourcePlan ? validateDigitalSlaSnapshot({ ruleVersion: sourcePlan.rule_version, parameters: sourcePlan.parameters_json })
        : resolveDigitalSlaSnapshot({ version: config!.version, values: config!.values }), actorId: actor.actorId,
      reason: sourcePlan ? "沿用关联开发单已冻结的整单标准，不因转正式订单重置" : "新订单保存首版时效标准", requestKey: randomUUID() });
    const anchors: Record<string, SlaAnchor> = {
      customer_order_confirmed: { precision: "instant", value: time.now, source: `audit_events:${creationEventId}` },
      expected_fabric_arrival: { precision: "unknown", reason: "未填预计到布日期，布料线暂不能预计" },
      sourcing_accepted: { precision: "unknown", reason: "外发申请尚无接受时间，商务线暂不能预计" },
    };
    let developmentCraft: SlaRouteSelection["developmentCraft"] = "unknown", washing: SlaRouteSelection["washing"] = "unknown";
    if (order.source_id) {
      const document = await developmentDocumentRow(client, order.source_id, 1);
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
    if (sourcePlan?.route_nodes.length) {
      // Preserve the development path captured at publication, even after a correction round.
      const originalNodes = new Map(sourcePlan.plan_json.nodes.map((node: { id: string }) => [node.id, node]));
      plan.nodes = plan.nodes.map(node => node.stage === 2 && originalNodes.has(node.id)
        ? structuredClone(originalNodes.get(node.id)) as typeof node : node);
      Object.assign(plan.anchors, sourcePlan.plan_json.anchors);
    }
    await plans.appendPlan({ orderId, expectedRevision: 0, snapshotId: snapshot.snapshotId, plan, time, actorId: actor.actorId,
      reason: "新订单保存全链首版计划；未有依据的日期保持未知", requestKey: randomUUID() });
    // Actual creation/confirmation is read from the original audit event, not copied three times.
    // Development evidence is retained on its original source/round, never copied as newly performed work.
    // Historical sources without enrollment remain unrated against today's standard.
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
      const sourceId = (await client.query("SELECT source_id FROM digital_production_orders WHERE production_order_id=$1", [orderId])).rows[0]?.source_id;
      const development = sourceId ? await developmentSlaEvidence(client, sourceId, time) : null;
      // Legacy SLA observations are fallback only. A corrected native fact (including an
      // explicitly unknown completion) must replace, not merge with, its obsolete copy.
      const facts = applyOrderCreationEvidence({ ...await repo.facts(orderId), ...development?.facts },
        await orderCreationSlaEvidence(client, orderId, history[0]!));
      const bulk=await bulkSlaEvidence(client,orderId);
      // Publication proves the sheet's end, not a replacement for its original order-confirmation start.
      if(bulk.production_sheet&&facts.production_sheet?.startedAt)bulk.production_sheet.startedAt=facts.production_sheet.startedAt;
      Object.assign(facts,bulk);
      const factory=await factorySlaEvidence(client,orderId);if(factory)Object.assign(facts,factory.facts);
      const evaluationPlan = developmentEvaluationPlan(factory?factoryEvaluationPlan(current.plan,factory.craftKey):current.plan, facts), nodes = evaluateSlaPlan(evaluationPlan, facts, time);
      const progress = slaBusinessProgress(evaluationPlan, Object.entries(facts).filter(([, f]) => f.businessCompleted || f.completedAt).map(([id]) => id));
      await client.query("COMMIT");
      return { status: "planned" as const, time, original: history[0]!, current, history, nodes, progress, development, factory };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
}
