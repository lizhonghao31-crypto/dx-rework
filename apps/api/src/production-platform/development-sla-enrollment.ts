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
import {captureTechnicalEnrollment,captureTechnicalRound} from './development-cycle-evidence.js';
import {freezeInitialTimelineInput,readInitialTimelineInput} from './fixed-timeline-initial-input.js';
import type {TimelineAdoptionMode} from './fixed-timeline-mode.js';
import {CraftStepChoicesSchema} from '@dx-rework/contracts/digital-craft';
import {orderTimeAdmission} from './order-time-admission.js';
import {orderTimeSnapshot} from './order-time-native-timing.js';

type DB = Pick<PoolClient, "query">;
export async function developmentSlaPlan(db: DB, sourceId: string) {
  if (!(await db.query("SELECT to_regclass('digital_development_sla_plans') AS relation")).rows[0]?.relation) return null;
  return (await db.query("SELECT * FROM digital_development_sla_plans WHERE source_id=$1 ORDER BY revision DESC LIMIT 1", [sourceId])).rows[0] ?? null;
}
/** Fixed route for newly enrolled sources only. Historical routes stay on their original reader. */
export function developmentSlaRoute(document: Pick<DevelopmentDocument, "craft" | "washing" | "craftSteps">,outputKind="整件样板",routeSchemaVersion:1|2=1): DigitalTaskKind[] {
  if(routeSchemaVersion!==2&&document.craftSteps?.some(step=>step.craftKind==='special'))throw Error('特殊工艺须采用独立步骤路线，不能合并为旧印绣流程');
  const route: DigitalTaskKind[] = ["development_pattern", "development_cutting"];
  if (document.craft !== "无") {
    if(routeSchemaVersion===2){
      if(document.craft==='印绣花'&&!document.craftSteps)throw Error('请在开发资料中明确绣花和印花的实际先后顺序');
      const steps=CraftStepChoicesSchema.parse(document.craftSteps??[{craftKind:document.craft==='绣花'?'embroidery':'printing',sequence:1}]);
      for(const step of steps)route.push('development_craft_dispatch',step.craftKind==='embroidery'?'development_embroidery':'development_printing','development_craft_confirmation');
    }else route.push("development_craft_dispatch", document.craft === "印花" ? "development_printing" : document.craft === "绣花" ? "development_embroidery" : "development_print_embroidery", "development_craft_confirmation");
  }
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
  document: DevelopmentDocument | null, time: BusinessTime, eventKey: string,newMode:TimelineAdoptionMode='legacy',activation:{eventId:string;createdBy:string}|null=null) {
  if (!(await db.query("SELECT to_regclass('digital_development_sla_plans') AS relation")).rows[0]?.relation) return;
  validateBusinessTime(time);
  const outputKind=(await db.query('SELECT output_kind FROM digital_development_revision_sources WHERE source_id=$1',[sourceId])).rows[0]?.output_kind??'整件样板';
  if (!(await db.query("SELECT source_id FROM digital_production_sources WHERE source_id=$1 FOR UPDATE", [sourceId])).rowCount) throw new Error("Development SLA source missing");
  const repeated = (await db.query("SELECT * FROM digital_development_sla_plans WHERE event_key=$1", [eventKey])).rows[0];
  if (repeated) {
    if (repeated.source_id !== sourceId || repeated.created_by !== actor.actorId || !isDeepStrictEqual(repeated.business_time, time)
      || !isDeepStrictEqual(repeated.route_nodes, document ? developmentSlaRoute(document,outputKind,repeated.route_schema_version===2?2:1) : [])) throw new Error("Development SLA event reused with different content");
    return;
  }
  const prior = await developmentSlaPlan(db, sourceId);
  const admission=orderTimeAdmission(db),firstEffective=Boolean(!prior&&document&&admission?.activationEventId&&admission.operation.kind==='development_publish'&&admission.operation.sourceId===sourceId);
  if (prior && (!document || prior.route_nodes.length)) throw new Error("Development SLA enrollment/publication already captured");
  if (prior && (prior.business_time.scenarioId !== time.scenarioId || prior.business_time.revision > time.revision
    || Date.parse(prior.business_time.now) > Date.parse(time.now))) throw new Error("Development SLA clock scope or time regression");
  if (activation) {
    if(prior||!document)throw Error('First publication requires an unenrolled development document');
    await captureTechnicalEnrollment(db,activation.createdBy,sourceId,activation.eventId);
  } else if (!prior) {
    if (document&&!firstEffective) throw new Error("Historical development cannot be enrolled by publishing");
    const event = (await db.query("SELECT action,entity_id,actor_id FROM audit_events WHERE id=$1", [firstEffective?admission!.activationEventId:eventKey])).rows[0];
    if (event?.action !== (firstEffective?'order_time_activated':"digital_source_created") || event.entity_id !== sourceId || event.actor_id !== actor.actorId)
      throw new Error("Development SLA enrollment requires its source creation event");
    if(firstEffective){
      const subject=(await db.query("SELECT s.created_by,s.creation_event_ref FROM digital_order_time_subjects s WHERE s.source_id=$1 AND NOT s.effective FOR UPDATE",[sourceId])).rows[0];
      if(!subject||subject.created_by!==admission!.designerId)throw Error('本单首次生效缺少原设计师档案');
      await captureTechnicalEnrollment(db,subject.created_by,sourceId,String(subject.creation_event_ref).replace(/^audit_events:/,''));
    }
  }
  const config = prior ? null : await new SlaConfigurationRepository(db).initialStandard(actor.actorId);
  const originalSnapshot = prior ? validateDigitalSlaSnapshot({ ruleVersion: prior.rule_version, parameters: prior.parameters_json }) : resolveDigitalSlaSnapshot({ version: config!.version, values: config!.values });
  const snapshot=admission&&!prior?orderTimeSnapshot(originalSnapshot,admission.plan):originalSnapshot;
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
  const inherited=prior?.timeline_schema_version===2?await readInitialTimelineInput(db,{kind:'source',id:sourceId}):null;
  if(prior?.timeline_schema_version&&!['1','2'].includes(String(prior.timeline_schema_version)))throw Error('此开发单采用版本不受当前程序支持');
  const mode=inherited?'fixed_v2':prior?'legacy':newMode;
  if(!prior&&!document&&mode==='fixed_v2')await captureTechnicalEnrollment(db,actor.actorId,sourceId,eventKey);
  const initial=inherited??await freezeInitialTimelineInput(db,firstEffective?'fixed_v2':mode,{resource:{kind:'source',id:sourceId},creationEventRef:`audit_events:${activation?.eventId??(firstEffective?admission!.activationEventId:eventKey)}`,time,
    unified:{configurationId:prior?.configuration_id??config!.configurationId,snapshotRef:`digital_development_sla_plans:${sourceId}:1`,values:snapshot},...(admission?{orderTimePlan:admission.plan}:{})});
  const values=[sourceId, revision, prior?.configuration_id ?? config!.configurationId, snapshot.ruleVersion,
    JSON.stringify(snapshot.parameters), JSON.stringify(plan), document ? developmentSlaRoute(document,outputKind,initial?2:1) : [], actor.actorId, JSON.stringify(time),
    document ? "开发发布：保存本单适用路线，文员窗口从发布开始" : "新开发单：冻结初版标准，未发布日期保持未知", eventKey];
  await db.query(`INSERT INTO digital_development_sla_plans(source_id,revision,configuration_id,rule_version,parameters_json,plan_json,route_nodes,created_by,business_time,reason,event_key${initial?',timeline_schema_version,route_schema_version,initial_adoption_input':''})
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11${initial?',2,2,$12':''})`,[...values,...(initial?[JSON.stringify(initial)]:[])]);
  if(!prior&&!document&&mode==='legacy')await captureTechnicalEnrollment(db,actor.actorId,sourceId,eventKey);
  if(document){
    const washing=snapshot.parameters.development_washing!.value,warning=snapshot.parameters.warning_ratio!.value;
    await captureTechnicalRound(db,actor.actorId,sourceId,1,time.now,'minutes' in washing?washing.minutes:1440,warning.kind==='ratio'?warning.percent/100:0.7);
  }
}
