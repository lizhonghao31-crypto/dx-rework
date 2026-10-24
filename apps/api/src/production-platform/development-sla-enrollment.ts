import type { PoolClient } from "pg";
import { resolveDigitalSlaSnapshot, validateDigitalSlaSnapshot } from "@dx-rework/contracts/digital-sla";
import type { DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import { calculateSlaPlan, type SlaPlan } from "@dx-rework/domain/digital-sla-plan";
import { validateBusinessTime, type BusinessTime } from "@dx-rework/domain/business-clock";
import type { TrustedActorContext } from "../tools/repositories.js";
import { SlaConfigurationRepository } from "./sla-configuration-repository.js";
import { buildOrderSlaRoute, type SlaRouteSelection } from "./sla-route.js";
import { isDeepStrictEqual } from "node:util";
import { developmentRoute } from "./development-route.js";
import type { DigitalTaskKind } from "./task-access-repository.js";

type DB = Pick<PoolClient, "query">;
export async function developmentSlaPlan(db: DB, sourceId: string) {
  if (!(await db.query("SELECT to_regclass('digital_development_sla_plans') AS relation")).rows[0]?.relation) return null;
  return (await db.query("SELECT * FROM digital_development_sla_plans WHERE source_id=$1 ORDER BY revision DESC LIMIT 1", [sourceId])).rows[0] ?? null;
}
/** Fixed route for newly enrolled sources only. Historical routes stay on their original reader. */
export function developmentSlaRoute(document: Pick<DevelopmentDocument, "craft" | "washing">,outputKind="整件样板"): DigitalTaskKind[] {
  const route: DigitalTaskKind[] = ["development_pattern", "development_cutting"];
  if (document.craft !== "无") route.push("development_craft_dispatch", document.craft === "印花" ? "development_printing" : document.craft === "绣花" ? "development_embroidery" : "development_print_embroidery", "development_craft_confirmation");
  if(outputKind==='工艺布片'){route.push("development_confirmation");return route;}
  route.push("development_sewing");
  if (document.washing !== "免洗") route.push("development_pre_wash_check", "development_washing_dispatch", "development_washing");
  route.push("development_tail_check", "development_confirmation");
  // Shipping stays an independent record. Native financial confirmation retains its original authority.
  return route;
}
export async function savedDevelopmentRoute(db: DB, sourceId: string, document: Pick<DevelopmentDocument, "craft" | "washing">): Promise<DigitalTaskKind[]> {
  const saved = await developmentSlaPlan(db, sourceId);
  return saved?.route_nodes.length ? saved.route_nodes : developmentRoute(document);
}
export async function captureDevelopmentSla(db: PoolClient, actor: TrustedActorContext, sourceId: string,
  document: DevelopmentDocument | null, time: BusinessTime, eventKey: string) {
  if (!(await db.query("SELECT to_regclass('digital_development_sla_plans') AS relation")).rows[0]?.relation) return;
  validateBusinessTime(time);
  const outputKind=(await db.query('SELECT output_kind FROM digital_development_revision_sources WHERE source_id=$1',[sourceId])).rows[0]?.output_kind??'整件样板';
  if (!(await db.query("SELECT source_id FROM digital_production_sources WHERE source_id=$1 FOR UPDATE", [sourceId])).rowCount) throw new Error("Development SLA source missing");
  const repeated = (await db.query("SELECT * FROM digital_development_sla_plans WHERE event_key=$1", [eventKey])).rows[0];
  if (repeated) {
    if (repeated.source_id !== sourceId || repeated.created_by !== actor.actorId || !isDeepStrictEqual(repeated.business_time, time)
      || !isDeepStrictEqual(repeated.route_nodes, document ? developmentSlaRoute(document,outputKind) : [])) throw new Error("Development SLA event reused with different content");
    return;
  }
  const prior = await developmentSlaPlan(db, sourceId);
  if (prior && (!document || prior.route_nodes.length)) throw new Error("Development SLA enrollment/publication already captured");
  if (prior && (prior.business_time.scenarioId !== time.scenarioId || prior.business_time.revision > time.revision
    || Date.parse(prior.business_time.now) > Date.parse(time.now))) throw new Error("Development SLA clock scope or time regression");
  if (!prior) {
    if (document) throw new Error("Historical development cannot be enrolled by publishing");
    const event = (await db.query("SELECT action,entity_id,actor_id FROM audit_events WHERE id=$1", [eventKey])).rows[0];
    if (event?.action !== "digital_source_created" || event.entity_id !== sourceId || event.actor_id !== actor.actorId)
      throw new Error("Development SLA enrollment requires its source creation event");
  }
  const config = prior ? null : await new SlaConfigurationRepository(db).initialStandard(actor.actorId);
  const snapshot = prior ? validateDigitalSlaSnapshot({ ruleVersion: prior.rule_version, parameters: prior.parameters_json }) : resolveDigitalSlaSnapshot({ version: config!.version, values: config!.values });
  const selection: SlaRouteSelection = {
    developmentCraft: !document ? "unknown" : document.craft === "无" ? "none" : document.craft === "印花" ? "printing" : document.craft === "绣花" ? "embroidery" : "print_embroidery",
    washing: !document ? "unknown" : document.washing === "免洗" ? "no" : "yes", bulkCraft: "unknown",
  };
  const anchors: SlaPlan["anchors"] = document ? { development_published: { precision: "instant", value: time.now, source: eventKey } } : {};
  // No fabricated PO identity is persisted: the generic mother route is projected to the source's own stages.
  const full = buildOrderSlaRoute(snapshot, selection, anchors, ["unconfirmed"]);
  const plan: SlaPlan = { ...full, nodes: full.nodes.filter(n => n.stage <= 2 && n.id !== "customer_confirmation") };
  if(outputKind==='工艺布片')for(const node of plan.nodes)if(['development_sewing','development_sewing_transfer','development_pre_wash_check','development_washing','development_washing_dispatch','development_tail_check'].includes(node.id))node.applicable='no';
  calculateSlaPlan(plan);
  const revision = (prior?.revision ?? 0) + 1;
  await db.query(`INSERT INTO digital_development_sla_plans(source_id,revision,configuration_id,rule_version,parameters_json,plan_json,route_nodes,created_by,business_time,reason,event_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [sourceId, revision, prior?.configuration_id ?? config!.configurationId, snapshot.ruleVersion,
    JSON.stringify(snapshot.parameters), JSON.stringify(plan), document ? developmentSlaRoute(document,outputKind) : [], actor.actorId, JSON.stringify(time),
    document ? "开发发布：保存本单适用路线，文员窗口从发布开始" : "新开发单：冻结初版标准，未发布日期保持未知", eventKey]);
}
