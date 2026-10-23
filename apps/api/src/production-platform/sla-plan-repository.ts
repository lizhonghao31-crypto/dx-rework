import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { validateDigitalSlaSnapshot } from "@dx-rework/contracts/digital-sla";
import { calculateSlaPlan, evaluateSlaPlan, type SlaNodeFact, type SlaPlan } from "@dx-rework/domain/digital-sla-plan";
import { validateBusinessTime, type BusinessTime } from "@dx-rework/domain/business-clock";
import { SlaIdempotencyConflict, SlaVersionConflict } from "./sla-configuration-repository.js";

export type StoredSlaPlan = { planId: string; orderId: string; revision: number; snapshotId: string; plan: SlaPlan; time: BusinessTime; recordedAt: string; reason: string };
type PlanRow = { plan_id: string; production_order_id: string; revision: number; snapshot_id: string; plan_json: SlaPlan; business_time: BusinessTime; recorded_at: Date; reason: string };
const mapPlan = (row: PlanRow): StoredSlaPlan => ({ planId: row.plan_id, orderId: row.production_order_id, revision: row.revision,
  snapshotId: row.snapshot_id, plan: row.plan_json, time: row.business_time, recordedAt: row.recorded_at.toISOString(), reason: row.reason });
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
  async appendPlan(input: { orderId: string; expectedRevision: number; snapshotId: string; plan: SlaPlan; time: BusinessTime; actorId: string; reason: string; requestKey: string }): Promise<StoredSlaPlan> {
    calculateSlaPlan(input.plan); validateBusinessTime(input.time);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("Invalid plan revision");
    const reason = reasonText(input.reason);
    await this.lock(input.orderId);
    const snapshot = (await this.client.query("SELECT * FROM digital_sla_order_snapshots WHERE snapshot_id=$1 AND production_order_id=$2", [input.snapshotId, input.orderId])).rows[0];
    if (!snapshot) throw new Error("SLA snapshot belongs to another order or is missing");
    const values = validateDigitalSlaSnapshot({ ruleVersion: snapshot.rule_version, parameters: snapshot.parameters_json }).parameters;
    for (const node of input.plan.nodes) {
      const value = values[node.parameterKey]?.value;
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
    const history = await this.plans(input.orderId), previous = history.at(-1);
    if ((previous?.revision ?? 0) !== input.expectedRevision) throw new SlaVersionConflict("SLA plan changed; preview again");
    if (previous && (previous.time.scenarioId !== input.time.scenarioId || Date.parse(input.time.now) < Date.parse(previous.time.now) || input.time.revision < previous.time.revision)) throw new Error("SLA clock scope or time cannot regress");
    const saved = await this.client.query(`INSERT INTO digital_sla_plans(plan_id,production_order_id,revision,snapshot_id,plan_json,business_time,created_by,reason,request_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [randomUUID(), input.orderId, input.expectedRevision + 1, input.snapshotId, JSON.stringify(input.plan), JSON.stringify(input.time), input.actorId, reason, input.requestKey]);
    return mapPlan(saved.rows[0]);
  }
  async appendFact(input: { orderId: string; nodeId: string; planId: string; expectedRevision: number; fact: Omit<SlaNodeFact, "completedDeadline">;
    time: BusinessTime; actorId: string; reason: string; requestKey: string; correction?: boolean }): Promise<void> {
    validateBusinessTime(input.time); const reason = reasonText(input.reason);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("Invalid fact revision");
    await this.lock(input.orderId);
    const history = await this.plans(input.orderId), plan = history.find(row => row.planId === input.planId);
    if (!plan?.plan.nodes.some(n => n.id === input.nodeId)) throw new Error("SLA fact has no matching order plan node");
    if (plan.time.scenarioId !== input.time.scenarioId) throw new Error("SLA fact clock scope mismatch");
    if ("completedDeadline" in input.fact) throw new Error("Completion assessment is captured by the server");
    const assessment = evaluateSlaPlan(plan.plan, { [input.nodeId]: input.fact }, input.time).find(n => n.id === input.nodeId)!;
    const retry = (await this.client.query("SELECT * FROM digital_sla_node_facts WHERE request_key=$1", [input.requestKey])).rows[0];
    if (retry) {
      const requestedFact = { ...retry.fact_json }; delete requestedFact.completedDeadline;
      if (retry.production_order_id !== input.orderId || retry.node_id !== input.nodeId || retry.plan_id !== input.planId || retry.revision !== input.expectedRevision + 1
        || retry.created_by !== input.actorId || retry.reason !== reason || !isDeepStrictEqual(requestedFact, input.fact) || !isDeepStrictEqual(retry.business_time, input.time)) throw new SlaIdempotencyConflict("SLA fact request reused");
      return;
    }
    if (history.at(-1)?.planId !== input.planId) throw new SlaVersionConflict("SLA plan changed before fact recording");
    const previous = (await this.client.query("SELECT * FROM digital_sla_node_facts WHERE production_order_id=$1 AND node_id=$2 ORDER BY revision DESC LIMIT 1", [input.orderId, input.nodeId])).rows[0];
    if ((previous?.revision ?? 0) !== input.expectedRevision) throw new SlaVersionConflict("SLA fact changed; reload before recording");
    if (previous) {
      if (Date.parse(input.time.now) < Date.parse(previous.business_time.now) || input.time.revision < previous.business_time.revision) throw new Error("SLA fact observation cannot regress");
      if (!input.correction && ((previous.fact_json.startedAt && previous.fact_json.startedAt !== input.fact.startedAt)
        || (previous.fact_json.completedAt && previous.fact_json.completedAt !== input.fact.completedAt))) throw new Error("Reassignment or return cannot reset actual SLA events");
    }
    const fact: SlaNodeFact = { ...input.fact };
    if (fact.completedAt) fact.completedDeadline = previous?.fact_json.completedAt === fact.completedAt && !input.correction
      ? previous.fact_json.completedDeadline ?? assessment.deadline : assessment.deadline;
    await this.client.query(`INSERT INTO digital_sla_node_facts(fact_id,production_order_id,node_id,revision,plan_id,fact_json,business_time,created_by,reason,request_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [randomUUID(), input.orderId, input.nodeId, input.expectedRevision + 1, input.planId, JSON.stringify(fact), JSON.stringify(input.time), input.actorId, reason, input.requestKey]);
  }
}
