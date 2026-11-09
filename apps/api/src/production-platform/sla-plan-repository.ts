import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { validateDigitalSlaSnapshot } from "@dx-rework/contracts/digital-sla";
import { calculateSlaPlan, type SlaNodeFact, type SlaPlan } from "@dx-rework/domain/digital-sla-plan";
import { validateBusinessTime, type BusinessTime } from "@dx-rework/domain/business-clock";
import { SlaIdempotencyConflict, SlaVersionConflict } from "./sla-configuration-repository.js";
import type {FrozenInitialTimelineInput} from './fixed-timeline-initial-input.js';
import {fixedTimelineIdentity} from './fixed-timeline-identity.js';

export type StoredSlaPlan = { planId: string; orderId: string; revision: number; snapshotId: string; plan: SlaPlan; time: BusinessTime; recordedAt: string; reason: string;timelineSchemaVersion?:2;routeSchemaVersion?:2;initialAdoptionInput?:FrozenInitialTimelineInput };
type PlanRow = { plan_id: string; production_order_id: string; revision: number; snapshot_id: string; plan_json: SlaPlan; business_time: BusinessTime; recorded_at: Date; reason: string;timeline_schema_version?:number;route_schema_version?:number;initial_adoption_input?:FrozenInitialTimelineInput|null };
const mapPlan = (row: PlanRow): StoredSlaPlan => {
 if(row.timeline_schema_version!==undefined&&row.timeline_schema_version!==1&&(row.timeline_schema_version!==2||row.route_schema_version!==2||!row.initial_adoption_input||fixedTimelineIdentity(row.initial_adoption_input.data)!==row.initial_adoption_input.identityHash))throw Error('此订单采用版本或冻结输入不受当前程序支持');
 return { planId: row.plan_id, orderId: row.production_order_id, revision: row.revision,
  snapshotId: row.snapshot_id, plan: row.plan_json, time: row.business_time, recordedAt: row.recorded_at.toISOString(), reason: row.reason,
  ...(row.timeline_schema_version===2?{timelineSchemaVersion:2 as const,routeSchemaVersion:2 as const,initialAdoptionInput:row.initial_adoption_input!}:{}) };
};
const reasonText = (text: string) => { if (!text.trim() || text.length > 1000) throw new Error("SLA history reason required"); return text.trim(); };
/** Internal transaction-bound API. Business adapters authorize and provide real event evidence. */
export class SlaPlanRepository {
  constructor(private readonly client: Pick<PoolClient, "query">) {}
  async available(): Promise<boolean> {
    return Boolean((await this.client.query("SELECT to_regclass('digital_sla_plans') AS relation")).rows[0]?.relation);
  }
  async plans(orderId: string): Promise<StoredSlaPlan[]> {
    const rows = await this.client.query<PlanRow>("SELECT * FROM digital_sla_plans WHERE production_order_id=$1 ORDER BY revision", [orderId]);
    return rows.rows.map(mapPlan);
  }
  async facts(orderId: string): Promise<Record<string, SlaNodeFact>> {
    const rows = await this.client.query("SELECT DISTINCT ON(node_id) node_id,fact_json FROM digital_sla_node_facts WHERE production_order_id=$1 ORDER BY node_id,revision DESC", [orderId]);
    return Object.fromEntries(rows.rows.map(row => [row.node_id, row.fact_json]));
  }
  private async lock(orderId: string) {
    if (!(await this.client.query("SELECT 1 FROM production_order_roots WHERE production_order_id=$1 FOR UPDATE", [orderId])).rowCount) throw new Error("SLA order not found");
  }
  async appendPlan(input: { orderId: string; expectedRevision: number; snapshotId: string; plan: SlaPlan; time: BusinessTime; actorId: string; reason: string; requestKey: string;initialAdoptionInput?:FrozenInitialTimelineInput }): Promise<StoredSlaPlan> {
    calculateSlaPlan(input.plan); validateBusinessTime(input.time);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("Invalid plan revision");
    const reason = reasonText(input.reason);
    await this.lock(input.orderId);
    const snapshot = (await this.client.query("SELECT * FROM digital_sla_order_snapshots WHERE snapshot_id=$1 AND production_order_id=$2", [input.snapshotId, input.orderId])).rows[0];
    if (!snapshot) throw new Error("SLA snapshot belongs to another order or is missing");
    const values = validateDigitalSlaSnapshot({ ruleVersion: snapshot.rule_version, parameters: snapshot.parameters_json }).parameters;
    const history = await this.plans(input.orderId), previous = history.at(-1);
    if(previous&&input.initialAdoptionInput&&(input.expectedRevision!==0||!isDeepStrictEqual(input.initialAdoptionInput,previous.initialAdoptionInput)))throw Error('不能在既有订单追加新的首次采用输入');
    const initial=previous?.initialAdoptionInput??input.initialAdoptionInput;
    if(initial&&(initial.version!==2||initial.data.resource.kind!=='order'||initial.data.resource.id!==input.orderId||fixedTimelineIdentity(initial.data)!==initial.identityHash))throw Error('首次冻结计划输入不属于本订单或校验失败');
    const retained=new Map<string,ReturnType<typeof validateDigitalSlaSnapshot>>();
    for(const [id,reference] of Object.entries(input.plan.retainedNodeSnapshots??{})){
      const before=previous?.plan.nodes.find(n=>n.id===id),after=input.plan.nodes.find(n=>n.id===id);
      if(!before||!after||!isDeepStrictEqual(before,after)||!(previous?.snapshotId===reference||previous?.plan.retainedNodeSnapshots?.[id]===reference))throw new Error('Retained SLA target must match its previous immutable plan');
      if(!retained.has(reference)){
        const original=(await this.client.query('SELECT * FROM digital_sla_order_snapshots WHERE snapshot_id=$1 AND production_order_id=$2',[reference,input.orderId])).rows[0];
        if(!original)throw new Error('Retained SLA snapshot belongs to another order or is missing');
        retained.set(reference,validateDigitalSlaSnapshot({ruleVersion:original.rule_version,parameters:original.parameters_json}));
      }
    }
    for (const node of input.plan.nodes) {
      const reference=input.plan.retainedNodeSnapshots?.[node.id];
      const value = (reference?retained.get(reference)!.parameters:values)[node.parameterKey]?.value;
      if (!value || node.kind !== value.kind || node.minutes !== ("minutes" in value ? value.minutes : null)
        || node.offsetDays !== ("days" in value ? value.days : null)) throw new Error("SLA plan does not match its frozen parameter snapshot");
    }
    const warning = values.warning_ratio!.value;
    const buffer = values.stage_buffer!.value;
    if (warning.kind !== "ratio" || input.plan.warningPercent !== warning.percent || buffer.kind !== "buffer" || input.plan.stageBufferMinutes !== buffer.minutes) throw new Error("SLA plan warning/buffer policy differs from snapshot");
    const prior = (await this.client.query("SELECT * FROM digital_sla_plans WHERE request_key=$1", [input.requestKey])).rows[0];
    if (prior) {
      if (prior.production_order_id !== input.orderId || prior.snapshot_id !== input.snapshotId || prior.revision !== input.expectedRevision + 1
        || prior.created_by !== input.actorId || prior.reason !== reason || !isDeepStrictEqual(prior.plan_json, input.plan) || !isDeepStrictEqual(prior.business_time, input.time)) throw new SlaIdempotencyConflict("SLA plan request reused");
      return mapPlan(prior);
    }
    if ((previous?.revision ?? 0) !== input.expectedRevision) throw new SlaVersionConflict("SLA plan changed; preview again");
    if (previous && (previous.time.scenarioId !== input.time.scenarioId || Date.parse(input.time.now) < Date.parse(previous.time.now) || input.time.revision < previous.time.revision)) throw new Error("SLA clock scope or time cannot regress");
    const saved = await this.client.query(`INSERT INTO digital_sla_plans(plan_id,production_order_id,revision,snapshot_id,plan_json,business_time,created_by,reason,request_key${initial?',timeline_schema_version,route_schema_version,initial_adoption_input':''})
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9${initial?',2,2,$10':''}) RETURNING *`, [randomUUID(), input.orderId, input.expectedRevision + 1, input.snapshotId, JSON.stringify(input.plan), JSON.stringify(input.time), input.actorId, reason, input.requestKey,...(initial?[JSON.stringify(initial)]:[])]);
    return mapPlan(saved.rows[0]);
  }
}
