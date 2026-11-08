import {preparationAdoption} from './preparation-material-repository.js';
import {sourcingSlaEvidence} from './sourcing-sla-evidence.js';
import {slaApplications,appliedSlaWindow} from './sla-applied-window.js';
import {OrderClosureService} from './order-closure-service.js';
import {packingSlaEvidence} from './packing-sla-evidence.js';
import {garmentSlaEvidence} from './garment-sla-evidence.js';
import {reworkSlaEvidence,reworkEvaluationPlan} from './rework-sla-evidence.js';
import {factoryProductionFacts} from './factory-production-facts.js';
import {factoryReturnLogistics} from './factory-return-logistics.js';
import {attachFactoryLogisticsRanges} from './factory-logistics-sla-projection.js';
import {ShipSampleService} from './ship-sample-service.js';
import {shipSampleSlaEvidence} from './ship-sample-facts.js';
import {factorySlaEvidence,factoryEvaluationPlan} from './factory-sla-evidence.js';
import {bulkSlaEvidence,bulkEvaluationPlan} from "./bulk-sla-evidence.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { resolveDigitalSlaSnapshot, validateDigitalSlaSnapshot } from "@dx-rework/contracts/digital-sla";
import { evaluateSlaPlan, slaBusinessProgress, type SlaAnchor } from "@dx-rework/domain/digital-sla-plan";
import { validateBusinessTime, type BusinessClock, type BusinessTime } from "@dx-rework/domain/business-clock";
import {assertBusinessClockUnchanged,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalProductionAccessPolicy } from "./access-policy.js";
import { SlaConfigurationRepository } from "./sla-configuration-repository.js";
import { SlaPlanRepository } from "./sla-plan-repository.js";
import { buildOrderSlaRoute, type SlaRouteSelection } from "./sla-route.js";
import { developmentDocumentRow } from "./development-round-repository.js";
import { developmentSlaPlan } from "./development-sla-enrollment.js";
import { developmentEvaluationPlan, developmentNativeFacts, developmentSlaEvidence } from "./development-sla-evidence.js";
import { applyOrderCreationEvidence, orderCreationSlaEvidence } from "./sla-order-evidence.js";

/** Creation and reads reuse order authorization; there is no generic event/date edit endpoint. */
export class SlaOrderService {
  constructor(private readonly database: Pool, private readonly clock: BusinessClock = new ContextBusinessClock(database)) {}

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
    await new ShipSampleService(this.database).ensureWithClient(client,actor,orderId);
    // Actual creation/confirmation is read from the original audit event, not copied three times.
    // Development evidence is retained on its original source/round, never copied as newly performed work.
    // Historical sources without enrollment remain unrated against today's standard.
  }

  async read(actor: TrustedActorContext, orderId: string) {
    const client = await this.database.connect();
    let result:Awaited<ReturnType<SlaOrderService["readWithClient"]>>;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      result = await this.readWithClient(actor, orderId, client,{mode:"read_projection"});
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    await assertBusinessClockUnchanged(this.clock,{kind:"order",id:orderId},result.time);
    return result;
  }

  /** Reuse the caller's authorized read snapshot; never open a nested connection/transaction. */
  async readWithClient(actor: TrustedActorContext, orderId: string, client: PoolClient, options:{mode?:"read_projection"}={}) {
      await new DigitalProductionAccessPolicy(client).assert(actor, "order", orderId, "technical");
      return this.readFacts(orderId,client,options,actor);
  }
  /** Internal canonical inputs. This never supplies an actor or an authorization result. */
  async readFactsWithClient(orderId:string,client:PoolClient,options:{mode?:"read_projection"}={}){
      return this.readFacts(orderId,client,options,null);
  }
  private async readFacts(orderId:string,client:PoolClient,options:{mode?:"read_projection"},actor:TrustedActorContext|null){
      const repo = new SlaPlanRepository(client), time = validateBusinessTime(await (this.clock instanceof ContextBusinessClock?this.clock.withTransaction(client):this.clock).read({ kind: "order", id: orderId }));
      const history = await repo.available() ? await repo.plans(orderId) : [];
      const current = history.at(-1);
      if (current && current.time.scenarioId !== time.scenarioId) throw new Error("SLA clock scope mismatch");
      const sourceId = (await client.query("SELECT source_id FROM digital_production_orders WHERE production_order_id=$1", [orderId])).rows[0]?.source_id;
      const development = sourceId ? await developmentSlaEvidence(client, sourceId, time) : null;
      // Legacy SLA observations are fallback only. A corrected native fact (including an
      // explicitly unknown completion) must replace, not merge with, its obsolete copy.
      const facts = applyOrderCreationEvidence({ ...(current?await repo.facts(orderId):{}),
        ...(sourceId && (!current || !development) ? await developmentNativeFacts(client,sourceId,time) : {}), ...development?.facts },
        history[0]?await orderCreationSlaEvidence(client, orderId, history[0]):{});
      const {facts:bulk,preshrink,preshrinkCorrection}=await bulkSlaEvidence(client,orderId);
      // Only the current preparation's structured correction supersedes a legacy
      // observation. Remove its evaluation copy, never the immutable saved fact.
      // Native evidence is merged afterwards so real work retains its authority.
      if(preshrinkCorrection)delete facts.warehouse_preshrink;
      // Publication proves the sheet's end, not a replacement for its original order-confirmation start.
      if(bulk.production_sheet?.evidence.startsWith('instruction:')&&facts.production_sheet?.startedAt)bulk.production_sheet.startedAt=facts.production_sheet.startedAt;
      const production=await factoryProductionFacts(client,orderId);
      Object.assign(facts,bulk,await sourcingSlaEvidence(client,orderId),await shipSampleSlaEvidence(client,orderId),production.facts);
      const factory=await factorySlaEvidence(client,orderId);if(factory)Object.assign(facts,factory.facts);
      const garments=await garmentSlaEvidence(client,orderId);Object.assign(facts,garments.facts);
      const receiving=actor?await new OrderClosureService(this.database).read(actor,orderId,client):await new OrderClosureService(this.database).readFactsWithClient(orderId,client);
      const span=receiving.receivingSpan;facts.receiving_span={businessCompleted:receiving.collection?.status==='已收齐',evidence:`native-receipts:${receiving.revision}`,
       ...(span?.firstEffectiveReceipt?.receivedAt?{startedAt:span.firstEffectiveReceipt.receivedAt}:{}),...(span?.collectedAt?{completedAt:span.collectedAt}:{})};
      const packing=packingSlaEvidence(receiving);Object.assign(facts,packing.facts);
      const rework=await reworkSlaEvidence(client,orderId);Object.assign(facts,rework.facts);
      // No adopted plan means no synthetic target/evaluation, not no native work.
      // Keep the same authorized snapshot and original evidence adapters.
      if (!current) return { status: 'legacy_unenrolled' as const, time,
        reason: '此历史订单未建立首版计划，未补造历史时间',
        facts, development, factory, rework, garments, receiving, packing };
      const applications=await slaApplications(client,orderId);
      if(applications.length){
        const originalSnapshot=await new SlaConfigurationRepository(client).orderSnapshot(orderId,1);
        if(!originalSnapshot)throw new Error('Applied SLA order has no original snapshot');
        for(const node of current.plan.nodes){
          const fact=facts[node.id];if(!fact||fact.batchWindows?.length||node.id==='bulk_pattern'&&bulk.bulk_pattern||node.id==='production_sheet'&&await preparationAdoption(client,{kind:'order',id:orderId}))continue;
          const applied=appliedSlaWindow(node.stage===2&&development?development.originalSnapshot:originalSnapshot.snapshot,node.parameterKey,`node:${node.id}`,applications);
          const warning=applied.snapshot.parameters.warning_ratio!.value;
          if(warning.kind==='ratio')fact.standardWarningPercent=warning.percent;
          if(!applied.applicationId)continue;
          const value=applied.snapshot.parameters[node.parameterKey]?.value;
          if(value&&'minutes' in value)fact.standardMinutes=value.minutes;
        }
      }
      const bulkPlan=bulkEvaluationPlan(current.plan,preshrink,facts);
      const evaluationPlan = reworkEvaluationPlan(developmentEvaluationPlan(factory?factoryEvaluationPlan(bulkPlan,factory.craftKey):bulkPlan, facts),rework.facts);
      const evaluated=evaluateSlaPlan(evaluationPlan,facts,time,options);
      // Display-only ranges must not enter strict before/after business comparisons.
      const nodes=options.mode==='read_projection'?attachFactoryLogisticsRanges(evaluated,evaluationPlan,
        await factoryReturnLogistics(client,orderId,new Date(time.now)),production.checks):evaluated;
      const progress = slaBusinessProgress(evaluationPlan, Object.entries(facts).filter(([, f]) => f.businessCompleted || f.completedAt).map(([id]) => id));
      return { status: "planned" as const, time, original: history[0]!, current, history, nodes, facts, evaluationPlan, applications, progress, development, factory, rework, garments, receiving, packing };
  }

}
