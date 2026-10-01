import {developmentRoute} from "./development-route.js";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { TrustedActorContext } from "../tools/repositories.js";
import { ApplicationError } from "../platform/errors.js";
import { DigitalProductionAccessPolicy, digitalForbidden, digitalNotFound, isDigitalLeader, isDigitalTechnicalManager } from "./access-policy.js";
import { createDigitalTaskAccess, reassignDigitalTask, type DigitalTaskKind } from "./task-access-repository.js";
import { digitalDeadline } from "@dx-rework/domain/digital-task-deadline";
import { ProductionOrderNodeClockRepository } from "./node-clock-repository.js";

type Resource = { kind: "order" | "source"; id: string };
type TimeQuality = "现场登记" | "补报未核实" | "已核实" | "缺失";
const fail = (message: string): never => { throw new ApplicationError("DIGITAL_TASK_CONFLICT", message, 409); };
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
export const DIGITAL_CONDITION_KEYS = ["customer_confirmed", "owner_approved", "materials_ready", "handover_received", "pattern_ready", "preshrink_ready", "qc_approved", "all_po_complete", "factory_arrived", "washing_finished", "business_recorded"] as const;
const REQUIRED_ACTIVATION: Partial<Record<DigitalTaskKind, readonly typeof DIGITAL_CONDITION_KEYS[number][]>> = {
  development_pattern: ["materials_ready", "handover_received"], development_cutting: ["handover_received"], development_sewing: ["materials_ready", "handover_received"],
  development_washing: ["handover_received"], development_tail_check: ["washing_finished"], bulk_pattern: ["owner_approved"], warehouse_preshrink: ["owner_approved"],
  bulk_cutting: ["owner_approved", "pattern_ready", "preshrink_ready"], warehouse_dispatch: ["qc_approved", "all_po_complete"], factory_material_count: ["factory_arrived"],
};
export class DigitalProductionTaskService {
  constructor(private readonly database: Pool) {}
  async syncSourcingAssignee(client: PoolClient, actor: TrustedActorContext, orderId: string, assigneeId: string) {
    if (!(await client.query("SELECT to_regclass('digital_budget_preparations') AS relation")).rows[0]?.relation) return;
    const tasks = (await client.query(`SELECT a.task_id FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
      WHERE a.production_order_id=$1 AND a.task_kind='sourcing_preparation' AND t.state NOT IN ('completed','cancelled')`, [orderId])).rows;
    for (const task of tasks) {
      await reassignDigitalTask(client, actor, task.task_id, assigneeId);
      await this.event(client, actor, task.task_id, { kind: "order", id: orderId }, "reassigned", new Date().toISOString(), "现场登记", { assigneeId });
    }
  }
  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      // One short lifecycle lock keeps policy coverage, completion and successor release atomic.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      const result = await action(client); await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  private async command<T>(client: PoolClient, actor: TrustedActorContext, command: string, key: string, payload: unknown, action: () => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) fail("缺少有效操作标识");
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const prior = (await client.query("SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3", [actor.actorId, command, key])).rows[0];
    if (prior) { if (prior.payload_hash !== hash) fail("操作标识已用于不同内容"); return prior.response as T; }
    const result = await action();
    await client.query("INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)", [actor.actorId, command, key, hash, JSON.stringify(result)]);
    return result;
  }
  private async task(client: PoolClient | Pick<Pool, "query">, id: string, lock = false) {
    return (await client.query(`SELECT t.*,a.production_order_id,a.source_id,a.task_kind,a.assignee_id,a.required_role FROM digital_production_tasks t
      JOIN digital_production_task_access a USING(task_id) WHERE t.task_id=$1 ${lock ? "FOR UPDATE OF t,a" : ""}`, [id])).rows[0] ?? digitalNotFound();
  }
  private resource(task: { production_order_id: string | null; source_id: string | null }): Resource {
    return task.production_order_id ? { kind: "order", id: task.production_order_id } : { kind: "source", id: task.source_id! };
  }
  private async active(client: PoolClient, resource: Resource) {
    const state = (await client.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind=$1 AND resource_id=$2", [resource.kind, resource.id])).rows[0]?.state ?? "active";
    if (state !== "active") fail(state === "paused" ? "订单已暂停" : "订单已取消");
  }
  private async conditionsReady(client: PoolClient, id: string, completion = false) {
    const unmet = await client.query(`SELECT 1 FROM digital_production_task_conditions WHERE task_id=$1 AND NOT satisfied AND (stage='activation' OR $2::boolean)
      UNION ALL SELECT 1 FROM digital_production_task_dependencies d JOIN digital_production_tasks p ON p.task_id=d.predecessor_id WHERE d.task_id=$1 AND p.state<>'completed' LIMIT 1`, [id, completion]);
    return !unmet.rowCount;
  }
  private async event(client: PoolClient, actor: TrustedActorContext, taskId: string | null, resource: Resource, kind: string, occurredAt: string | null, quality: TimeQuality, payload: unknown = {}, corrects: string | null = null) {
    const eventId = randomUUID();
    await client.query(`INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload,corrects_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [eventId, taskId, resource.kind, resource.id, kind, actor.actorId, occurredAt, quality, JSON.stringify(payload), corrects]);
    await client.query("INSERT INTO digital_production_event_intents(event_id,task_id,event_kind) VALUES($1,$2,$3)", [eventId, taskId, kind]);
    return eventId;
  }
  private async policy(client: PoolClient | Pick<Pool, "query">, key: string) {
    return (await client.query("SELECT * FROM digital_production_deadline_policies WHERE node_key=$1 ORDER BY version DESC LIMIT 1", [key])).rows[0] ?? digitalNotFound();
  }
  private async revision(client: PoolClient, actor: TrustedActorContext, taskId: string, policy: { node_key: string; version: number; sla_seconds: string | number | null; warning_ratio: string | number }, enteredAt: string | null, reason: string, eventId: string) {
    const deadline = digitalDeadline(enteredAt, policy.sla_seconds === null ? null : Number(policy.sla_seconds), Number(policy.warning_ratio));
    await client.query(`INSERT INTO digital_production_deadline_revisions(task_id,policy_node_key,policy_version,entered_at,warning_at,due_at,reason,event_id,changed_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [taskId, policy.node_key, policy.version, enteredAt, deadline.warningAt, deadline.dueAt, reason, eventId, actor.actorId]);
    return deadline;
  }
  private async activate(client: PoolClient, actor: TrustedActorContext, id: string, occurredAt: string | null, quality: TimeQuality) {
    const task = await this.task(client, id, true);
    if (task.state !== "pending" || !await this.conditionsReady(client, id)) return false;
    const lifecycle = (await client.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind=$1 AND resource_id=$2", [this.resource(task).kind, this.resource(task).id])).rows[0]?.state;
    if (lifecycle === "paused" || lifecycle === "cancelled") return false;
    const facts = (await client.query(`SELECT count(*)::int AS count,bool_or(moment IS NULL) AS has_unknown,max(moment) AS latest_at FROM (
      SELECT occurred_at AS moment FROM digital_production_task_conditions WHERE task_id=$1 AND stage='activation' AND satisfied
      UNION ALL SELECT p.completed_at FROM digital_production_task_dependencies d JOIN digital_production_tasks p ON p.task_id=d.predecessor_id WHERE d.task_id=$1
      ) facts`, [id])).rows[0];
    if (facts.has_unknown) occurredAt = null;
    else if (facts.count > 0) occurredAt = iso(facts.latest_at);
    if (occurredAt === null) quality = "缺失";
    else if (quality === "缺失") quality = "补报未核实";
    const policy = await this.policy(client, task.task_kind);
    const eventId = await this.event(client, actor, id, this.resource(task), "ready", occurredAt, quality);
    const deadline = await this.revision(client, actor, id, policy, occurredAt, "activation", eventId);
    let clockId: string | null = null;
    if (task.production_order_id && occurredAt && deadline.dueAt && deadline.warningAt) {
      clockId = id;
      await new ProductionOrderNodeClockRepository(client).enter({ nodeInstanceId: id, productionOrderId: task.production_order_id, nodeKey: task.task_kind, occurrence: task.occurrence,
        enteredAt: new Date(occurredAt), dueAt: deadline.dueAt, warningAt: deadline.warningAt, deadlinePolicyKey: task.task_kind, deadlinePolicyVersion: policy.version, createdBy: actor.actorId });
    }
    await client.query("UPDATE digital_production_tasks SET state='ready',entered_at=$2,entered_quality=$3,baseline_clock_id=$4 WHERE task_id=$1", [id, occurredAt, quality, clockId]);
    return true;
  }
  // Called by fixed business adapters inside their own transaction; no public task-builder route.
  async createWithClient(client: PoolClient, actor: TrustedActorContext, input: { resource: Resource; authorizingTaskId?: string; kind: DigitalTaskKind; routeId: string; routeVersion: number; occurrence: number; assigneeId: string | null; predecessors?: string[]; conditions?: typeof DIGITAL_CONDITION_KEYS[number][]; occurredAt?: string | null }) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
    await this.active(client, input.resource);
    if (input.authorizingTaskId) {
      const origin = await this.task(client, input.authorizingTaskId);
      if (this.resource(origin).kind !== input.resource.kind || this.resource(origin).id !== input.resource.id) digitalForbidden();
      await new DigitalProductionAccessPolicy(client).assert(actor, "task", input.authorizingTaskId, "execute");
    } else await new DigitalProductionAccessPolicy(client).assert(actor, input.resource.kind, input.resource.id, "technical");
    const column = input.resource.kind === "order" ? "production_order_id" : "source_id";
    const existing = (await client.query(`SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.${column}=$1 AND a.task_kind=$2 AND t.occurrence=$3`, [input.resource.id, input.kind, input.occurrence])).rows[0];
    if (existing) fail("本轮该节点任务已经存在");
    for (const predecessor of input.predecessors ?? []) {
      const prior = await this.task(client, predecessor);
      if (this.resource(prior).kind !== input.resource.kind || this.resource(prior).id !== input.resource.id || prior.route_instance_id !== input.routeId) fail("前置任务必须属于同一业务轮次");
    }
    const id = await createDigitalTaskAccess(client, actor, { kind: input.kind, assigneeId: input.assigneeId, ...(input.resource.kind === "order" ? { orderId: input.resource.id } : { sourceId: input.resource.id }) });
    await client.query("INSERT INTO digital_production_tasks(task_id,node_key,route_instance_id,route_version,occurrence) VALUES($1,$2,$3,$4,$5)", [id, input.kind, input.routeId, input.routeVersion, input.occurrence]);
    for (const prior of input.predecessors ?? []) await client.query("INSERT INTO digital_production_task_dependencies(task_id,predecessor_id) VALUES($1,$2)", [id, prior]);
    for (const condition of new Set([...(REQUIRED_ACTIVATION[input.kind] ?? []), ...(input.conditions ?? []), "business_recorded" as const])) {
      if (!DIGITAL_CONDITION_KEYS.includes(condition)) fail("未知前置条件");
      await client.query("INSERT INTO digital_production_task_conditions(task_id,condition_key,stage) VALUES($1,$2,$3)", [id, condition, condition === "business_recorded" ? "completion" : "activation"]);
    }
    await this.event(client, actor, id, input.resource, "created", new Date().toISOString(), "现场登记");
    await this.activate(client, actor, id, input.occurredAt === undefined ? new Date().toISOString() : input.occurredAt, input.occurredAt === null ? "缺失" : input.occurredAt === undefined ? "现场登记" : "补报未核实");
    return { taskId: id };
  }
  async setConditionWithClient(client: PoolClient, actor: TrustedActorContext, id: string, condition: typeof DIGITAL_CONDITION_KEYS[number], satisfied: boolean, occurredAt: string | null, note = "") {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
    const task = await this.task(client, id, true);
    if (["completed", "cancelled"].includes(task.state)) fail("已结束任务不能重写条件");
    if (occurredAt !== null && (!Number.isFinite(new Date(occurredAt).getTime()) || new Date(occurredAt).getTime() > Date.now())) fail("条件发生时间无效");
    const updated = await client.query("UPDATE digital_production_task_conditions SET satisfied=$3,occurred_at=$4 WHERE task_id=$1 AND condition_key=$2 RETURNING task_id", [id, condition, satisfied, occurredAt]);
    if (!updated.rowCount) fail("任务不包含该前置条件");
    await this.event(client, actor, id, this.resource(task), "condition", occurredAt, occurredAt === null ? "缺失" : "补报未核实", { condition, satisfied, note });
    if (!satisfied && task.state === "ready") await client.query("UPDATE digital_production_tasks SET state='blocked',blocked_reason='前置条件未满足' WHERE task_id=$1", [id]);
    return this.activate(client, actor, id, occurredAt, occurredAt === null ? "缺失" : "补报未核实");
  }
  async complete(actor: TrustedActorContext, id: string, input: { occurredAt?: string | null | undefined; note: string }, key: string) {
    return this.transaction(client => this.completeWithClient(client, actor, id, input, key));
  }
  // Fixed business adapters may create successors and complete in the same transaction.
  async completeWithClient(client: PoolClient, actor: TrustedActorContext, id: string, input: { occurredAt?: string | null | undefined; note: string }, key: string) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      await new DigitalProductionAccessPolicy(client).assert(actor, "task", id, "execute");
      return this.command(client, actor, `task-complete:${id}`, key, input, async () => {
        const task = await this.task(client, id, true);
        if (task.state === "completed") return { taskId: id, state: "completed" };
        await this.active(client, this.resource(task));
        if (task.state !== "ready" || !await this.conditionsReady(client, id, true)) fail("任务尚不具备完成条件");
        const occurredAt = input.occurredAt === undefined ? new Date().toISOString() : input.occurredAt;
        if (occurredAt && (new Date(occurredAt).getTime() > Date.now() || (task.entered_at && new Date(occurredAt) < new Date(task.entered_at)))) fail("发生时间不能晚于当前或早于任务进入");
        const quality: TimeQuality = occurredAt === null ? "缺失" : input.occurredAt === undefined ? "现场登记" : "补报未核实";
        const eventId = await this.event(client, actor, id, this.resource(task), "completed", occurredAt, quality, { note: input.note });
        await this.revision(client, actor, id, await this.policy(client, task.task_kind), iso(task.entered_at), "completion", eventId);
        await client.query("UPDATE digital_production_tasks SET state='completed',completed_at=$2,completed_quality=$3,terminal_recorded_at=CURRENT_TIMESTAMP WHERE task_id=$1", [id, occurredAt, quality]);
        if (task.baseline_clock_id && occurredAt) {
          const clock = (await client.query("SELECT entered_at,completed_at FROM production_order_node_clocks WHERE node_instance_id=$1", [id])).rows[0];
          if (clock && !clock.completed_at && new Date(occurredAt) >= new Date(clock.entered_at)) await new ProductionOrderNodeClockRepository(client).complete(id, new Date(occurredAt));
        }
        const next = await client.query("SELECT task_id FROM digital_production_task_dependencies WHERE predecessor_id=$1 ORDER BY task_id", [id]);
        for (const row of next.rows) await this.activate(client, actor, row.task_id, occurredAt, quality);
        return { taskId: id, state: "completed" };
      });
  }
  async handover(actor: TrustedActorContext, id: string, input: { occurredAt?: string | null | undefined; note: string }, key: string) {
    return this.transaction(async client => {
      await new DigitalProductionAccessPolicy(client).assert(actor, "task", id, "execute");
      return this.command(client, actor, `task-handover:${id}`, key, input, async () => {
        const task = await this.task(client, id, true);
        if (["completed", "cancelled"].includes(task.state)) fail("已结束任务不能补交接");
        const at = input.occurredAt === undefined ? new Date().toISOString() : input.occurredAt;
        await this.setConditionWithClient(client, actor, id, "handover_received", true, at, input.note);
        return { taskId: id };
      });
    });
  }
  async feedback(actor: TrustedActorContext, id: string, reason: string, blocked: boolean, key: string) {
    return this.transaction(async client => {
      await new DigitalProductionAccessPolicy(client).assert(actor, "task", id, "execute");
      return this.command(client, actor, `task-block:${id}`, key, { reason, blocked }, async () => {
        const task = await this.task(client, id, true); await this.active(client, this.resource(task));
        if (!['ready','blocked'].includes(task.state) || (!blocked && !await this.conditionsReady(client, id))) fail("当前任务不能更改阻断状态");
        await client.query("UPDATE digital_production_tasks SET state=$2,blocked_reason=$3 WHERE task_id=$1", [id, blocked ? "blocked" : "ready", blocked ? reason : null]);
        await this.event(client, actor, id, this.resource(task), blocked ? "blocked" : "unblocked", new Date().toISOString(), "现场登记", { reason });
        return { taskId: id, state: blocked ? "blocked" : "ready" };
      });
    });
  }
  async reassign(actor: TrustedActorContext, id: string, assigneeId: string, key: string) {
    return this.transaction(async client => {
      const task = await this.task(client, id, true);
      if (!isDigitalLeader(actor) && !isDigitalTechnicalManager(actor) && !actor.actorRoles.includes("development_clerk")) digitalForbidden();
      return this.command(client, actor, `task-reassign:${id}`, key, { assigneeId }, async () => {
        if (['completed','cancelled'].includes(task.state)) fail("已结束任务不可日常改派");
        const result = await reassignDigitalTask(client, actor, id, assigneeId);
        await this.event(client, actor, id, this.resource(task), "reassigned", new Date().toISOString(), "现场登记", { previousAssigneeId: task.assignee_id, assigneeId });
        return result;
      });
    });
  }
  async policies(actor: TrustedActorContext) {
    if (!isDigitalLeader(actor)) digitalForbidden();
    return (await this.database.query(`SELECT DISTINCT ON(node_key) node_key AS "nodeKey",label,version,sla_seconds/3600.0 AS "slaHours",warning_ratio AS "warningRatio",changed_at AS "changedAt",changed_by AS "changedBy",note
      FROM digital_production_deadline_policies ORDER BY node_key,version DESC`)).rows.map(row => ({ ...row, slaHours: row.slaHours === null ? null : Number(row.slaHours), warningRatio: Number(row.warningRatio) }));
  }
  async changePolicy(actor: TrustedActorContext, nodeKey: string, input: { expectedVersion: number; slaHours: number | null; warningRatio: number; note: string }, key: string) {
    if (!isDigitalLeader(actor)) digitalForbidden();
    const slaSeconds = input.slaHours === null ? null : input.slaHours * 3600;
    digitalDeadline(null, slaSeconds, input.warningRatio);
    return this.transaction(client => this.command(client, actor, `task-policy:${nodeKey}`, key, input, async () => {
      const prior = await this.policy(client, nodeKey);
      if (prior.version !== input.expectedVersion) fail("时效参数已更新，请刷新");
      const version = prior.version + 1;
      await client.query("INSERT INTO digital_production_deadline_policies(node_key,version,label,sla_seconds,warning_ratio,changed_by,note) VALUES($1,$2,$3,$4,$5,$6,$7)", [nodeKey, version, prior.label, slaSeconds, input.warningRatio, actor.actorId, input.note]);
      const nextPolicy = await this.policy(client, nodeKey);
      const tasks = await client.query("SELECT t.task_id FROM digital_production_tasks t WHERE node_key=$1 AND state IN ('ready','blocked') ORDER BY task_id FOR UPDATE", [nodeKey]);
      for (const row of tasks.rows) {
        const task = await this.task(client, row.task_id);
        const eventId = await this.event(client, actor, task.task_id, this.resource(task), "policy_changed", new Date().toISOString(), "现场登记", { previousVersion: prior.version, version });
        await this.revision(client, actor, task.task_id, nextPolicy, iso(task.entered_at), "policy", eventId);
      }
      await client.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state)
        VALUES($1,$2,$3,'digital_deadline_policy_changed','digital_deadline_policy',$4,$5,$6)`, [randomUUID(), actor.requestId, actor.actorId, nodeKey, JSON.stringify(prior), JSON.stringify({ ...input, version, affectedTasks: tasks.rowCount })]);
      return { nodeKey, version, affectedTasks: tasks.rowCount };
    }));
  }
  async correctTime(actor: TrustedActorContext, id: string, input: { eventId: string; occurredAt: string | null; reason: string }, key: string) {
    if (!isDigitalLeader(actor) && !isDigitalTechnicalManager(actor)) digitalForbidden();
    return this.transaction(async client => {
      await new DigitalProductionAccessPolicy(client).assert(actor, "task", id, "technical");
      return this.command(client, actor, `task-time:${id}`, key, input, async () => {
        const task = await this.task(client, id, true);
        const original = (await client.query("SELECT * FROM digital_production_task_events WHERE event_id=$1 AND task_id=$2 AND event_kind IN ('ready','completed')", [input.eventId, id])).rows[0] ?? digitalNotFound();
        if (task.state === "cancelled") fail("已取消任务不能订正办理时间");
        const corrected = input.occurredAt === null ? null : new Date(input.occurredAt);
        if (corrected && (!Number.isFinite(corrected.getTime()) || corrected.getTime() > Date.now())) fail("请填写过去真实时间或明确未知");
        const entry = original.event_kind === "ready" ? corrected : task.entered_at ? new Date(task.entered_at) : null;
        const completion = original.event_kind === "completed" ? corrected : task.completed_at ? new Date(task.completed_at) : null;
        if (entry && completion && completion < entry) fail("完成时间不能早于进入时间");
        const eventId = await this.event(client, actor, id, this.resource(task), "time_corrected", input.occurredAt, corrected ? "已核实" : "缺失", { reason: input.reason, originalKind: original.event_kind }, input.eventId);
        if (original.event_kind === "ready") await client.query("UPDATE digital_production_tasks SET entered_at=$2,entered_quality=$3 WHERE task_id=$1", [id, corrected, corrected ? "已核实" : "缺失"]);
        else await client.query("UPDATE digital_production_tasks SET completed_at=$2,completed_quality=$3 WHERE task_id=$1", [id, corrected, corrected ? "已核实" : "缺失"]);
        let policy = await this.policy(client, task.task_kind);
        if (task.state === "completed") {
          const snapshot = (await client.query(`SELECT p.* FROM digital_production_deadline_revisions r JOIN digital_production_deadline_policies p ON p.node_key=r.policy_node_key AND p.version=r.policy_version
            WHERE r.task_id=$1 ORDER BY r.revision_id DESC LIMIT 1`, [id])).rows[0];
          if (snapshot) policy = snapshot;
        }
        await this.revision(client, actor, id, policy, entry?.toISOString() ?? null, "correction", eventId);
        return { taskId: id, eventId };
      });
    });
  }
  async controlResource(actor: TrustedActorContext, resource: Resource, action: "pause" | "resume" | "cancel", reason: string, key: string) {
    return this.transaction(async client => {
      const column = resource.kind === "order" ? "production_order_id" : "source_id";
      const table = resource.kind === "order" ? "digital_production_orders" : "digital_production_sources";
      const record = (await client.query(`SELECT * FROM ${table} WHERE ${column}=$1 FOR UPDATE`, [resource.id])).rows[0] ?? digitalNotFound();
      if (!isDigitalLeader(actor) && !(resource.kind === "order" && actor.actorRoles.includes("order_merchandiser") && record.primary_merchandiser_id === actor.actorId)
        && !(resource.kind === "source" && actor.actorRoles.includes("sample_designer") && record.created_by === actor.actorId)) digitalForbidden();
      return this.command(client, actor, `task-resource:${resource.kind}:${resource.id}`, key, { action, reason }, async () => {
        const current = (await client.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind=$1 AND resource_id=$2", [resource.kind, resource.id])).rows[0]?.state ?? "active";
        if (current === "cancelled") fail("已取消业务不能重新启动");
        if (action === "resume" && current !== "paused") fail("当前业务未暂停");
        const state = action === "pause" ? "paused" : action === "cancel" ? "cancelled" : "active";
        await client.query(`INSERT INTO digital_production_resource_lifecycle(resource_kind,resource_id,state,changed_by,reason) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(resource_kind,resource_id) DO UPDATE SET state=EXCLUDED.state,changed_by=EXCLUDED.changed_by,reason=EXCLUDED.reason,changed_at=CURRENT_TIMESTAMP`, [resource.kind, resource.id, state, actor.actorId, reason]);
        const tasks = await client.query(`SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.${column}=$1 AND t.state NOT IN ('completed','cancelled') ORDER BY t.task_id FOR UPDATE OF t`, [resource.id]);
        for (const row of tasks.rows) {
          if (action === "cancel") await client.query("UPDATE digital_production_tasks SET state='cancelled',terminal_recorded_at=CURRENT_TIMESTAMP WHERE task_id=$1", [row.task_id]);
          await this.event(client, actor, row.task_id, resource, action, new Date().toISOString(), "现场登记", { reason });
        }
        if (action === "resume") for (const row of tasks.rows) await this.activate(client, actor, row.task_id, null, "缺失");
        if (!tasks.rowCount) await this.event(client, actor, null, resource, action, new Date().toISOString(), "现场登记", { reason });
        return { ...resource, state };
      });
    });
  }
  async read(actor: TrustedActorContext, id: string) {
    const policy = new DigitalProductionAccessPolicy(this.database);
    await policy.assert(actor, "task", id, "technical");
    const task = await this.task(this.database, id);
    const effective = (await this.database.query(`SELECT r.entered_at,r.warning_at,r.due_at,p.version,p.sla_seconds,p.label FROM digital_production_deadline_revisions r
      JOIN digital_production_deadline_policies p ON p.node_key=r.policy_node_key AND p.version=r.policy_version JOIN app_users u ON u.id=r.changed_by WHERE r.task_id=$1 ORDER BY r.revision_id DESC LIMIT 1`, [id])).rows[0];
    const currentPolicy = effective ?? await this.policy(this.database, task.task_kind);
    const resource = this.resource(task);
    const paused = (await this.database.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind=$1 AND resource_id=$2", [resource.kind, resource.id])).rows[0]?.state === "paused";
    const parent = (await this.database.query(resource.kind === "order" ? "SELECT created_by,primary_merchandiser_id FROM digital_production_orders WHERE production_order_id=$1" : "SELECT created_by FROM digital_production_sources WHERE source_id=$1", [resource.id])).rows[0];
    const canManage = isDigitalLeader(actor) || ((task.task_kind.startsWith("development_") || task.task_kind === "bulk_pattern") && (isDigitalTechnicalManager(actor) || actor.actorRoles.includes("development_clerk")));
    const canControl = isDigitalLeader(actor) || (resource.kind === "order" ? actor.actorRoles.includes("order_merchandiser") && parent.primary_merchandiser_id === actor.actorId : actor.actorRoles.includes("sample_designer") && parent.created_by === actor.actorId);
    const assignee = task.assignee_id ? (await this.database.query("SELECT display_name FROM app_users WHERE id=$1", [task.assignee_id])).rows[0]?.display_name ?? null : null;
    let route = (await this.database.query("SELECT count(*)::int AS applicable,count(*) FILTER(WHERE state='completed')::int AS completed,count(*) FILTER(WHERE state='cancelled')::int AS cancelled FROM digital_production_tasks t WHERE route_instance_id=$1 AND node_key NOT IN ('development_material_supply','development_craft_dispatch','development_sewing_transfer','development_washing_dispatch') AND NOT EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned')", [task.route_instance_id])).rows[0];
    if(task.source_id&&(await this.database.query("SELECT to_regclass('digital_development_documents') AS relation")).rows[0]?.relation){
      const document=(await this.database.query("SELECT document FROM digital_development_documents WHERE source_id=$1 AND status='published'",[task.source_id])).rows[0];
      if(document){
        const nodes:string[]=task.route_version===1?["development_materials",...developmentRoute(document.document)]:(await this.database.query("SELECT route_nodes FROM digital_development_rounds WHERE source_id=$1 AND round_number=$2",[task.source_id,task.route_version])).rows[0]?.route_nodes??[];
        const business=nodes.filter(node=>!["development_material_supply","development_craft_dispatch","development_sewing_transfer","development_washing_dispatch"].includes(node));
        const rows=(await this.database.query("SELECT DISTINCT CASE WHEN node_key='development_material_recheck' THEN 'development_materials' ELSE node_key END AS node,state FROM digital_production_tasks t WHERE route_instance_id=$1 AND NOT EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned')",[task.route_instance_id])).rows;
        route={applicable:business.length,completed:business.filter(node=>rows.some(row=>row.node===node&&row.state==='completed')).length,cancelled:business.filter(node=>rows.some(row=>row.node===node&&row.state==='cancelled')&&!rows.some(row=>row.node===node&&row.state==='completed')).length};
      }
    }
    const handover = await this.database.query("SELECT 1 FROM digital_production_task_conditions WHERE task_id=$1 AND condition_key='handover_received'", [id]);
    return { taskId: id, orderId: task.production_order_id as string | null, sourceId: task.source_id as string | null, taskKind: task.task_kind as string, label: currentPolicy.label as string,
      routeProgress: route, assigneeName: assignee, requiredRole: task.required_role, hasHandover: Boolean(handover.rowCount), canManage, canControl, canCorrect: isDigitalLeader(actor) || isDigitalTechnicalManager(actor),
      assigneeId: task.assignee_id as string | null, state: task.state as string, routeVersion: task.route_version as number, occurrence: task.occurrence as number,
      enteredAt: iso(task.entered_at), recordedAt: iso(task.created_at)!, completedAt: iso(task.completed_at), paused,
      dueAt: iso(effective?.due_at ?? null), warningAt: iso(effective?.warning_at ?? null), slaHours: currentPolicy.sla_seconds === null ? null : Number(currentPolicy.sla_seconds) / 3600,
      policyVersion: currentPolicy.version as number, timeQuality: task.entered_quality as string, completedTimeQuality: task.completed_quality as string,
      blockedReason: task.blocked_reason as string | null, canExecute: !paused && await policy.allowed(actor, "task", id, "execute") };
  }
  async supersedeSourceTasksWithClient(client:PoolClient,actor:TrustedActorContext,sourceId:string,throughRound:number,authorizingTaskId?:string){
    if(authorizingTaskId){const origin=await this.task(client,authorizingTaskId);if(origin.source_id!==sourceId)digitalForbidden();await new DigitalProductionAccessPolicy(client).assert(actor,"task",authorizingTaskId,"execute");}
    else await new DigitalProductionAccessPolicy(client).assert(actor,"source",sourceId,"technical");
    const pending=(await client.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.route_version<=$2 AND t.state IN ('pending','ready','blocked') FOR UPDATE OF t",[sourceId,throughRound])).rows;
    for(const row of pending){await client.query("UPDATE digital_production_tasks SET state='cancelled',blocked_reason='已由新修改轮次接续，保留原记录' WHERE task_id=$1",[row.task_id]);await this.event(client,actor,row.task_id,{kind:"source",id:sourceId},"cancelled",new Date().toISOString(),"现场登记",{reason:"new_development_round"});}
  }
  async list(actor: TrustedActorContext, page: number) {
    const global = isDigitalLeader(actor) || isDigitalTechnicalManager(actor);
    const result = await this.database.query(`SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
      LEFT JOIN digital_production_orders o ON o.production_order_id=a.production_order_id LEFT JOIN digital_production_sources s ON s.source_id=a.source_id
      WHERE $1::boolean OR a.assignee_id=$2 OR ($3::boolean AND (o.created_by=$2 OR s.created_by=$2)) OR ($4::boolean AND o.primary_merchandiser_id=$2)
      OR ($5::boolean AND a.task_kind LIKE 'development_%') OR EXISTS(SELECT 1 FROM digital_production_delegations d WHERE d.delegate_id=$2 AND d.revoked_at IS NULL AND d.expires_at>CURRENT_TIMESTAMP
        AND (d.task_id=t.task_id OR (d.purpose='technical' AND (d.production_order_id=a.production_order_id OR d.source_id=a.source_id))))
      ORDER BY t.created_at DESC,t.task_id DESC LIMIT 20 OFFSET $6`, [global, actor.actorId, actor.actorRoles.includes("sample_designer"), actor.actorRoles.includes("order_merchandiser"), actor.actorRoles.includes("development_clerk"), (page-1)*20]);
    const policy = new DigitalProductionAccessPolicy(this.database); const items = [];
    for (const row of result.rows) if (await policy.allowed(actor, "task", row.task_id, "technical")) items.push(await this.read(actor, row.task_id));
    return { items, page };
  }
  async history(actor: TrustedActorContext, id: string) {
    await new DigitalProductionAccessPolicy(this.database).assert(actor, "task", id, "technical");
    return { events: (await this.database.query("SELECT event_id AS \"eventId\",event_kind AS kind,occurred_at AS \"occurredAt\",recorded_at AS \"recordedAt\",time_quality AS quality,corrects_event_id AS \"correctsEventId\",payload,u.display_name AS \"actorName\" FROM digital_production_task_events e JOIN app_users u ON u.id=e.actor_id WHERE task_id=$1 ORDER BY recorded_at,event_id", [id])).rows,
      revisions: (await this.database.query("SELECT r.revision_id AS \"revisionId\",r.policy_version AS \"policyVersion\",r.entered_at AS \"enteredAt\",r.warning_at AS \"warningAt\",r.due_at AS \"dueAt\",r.reason,r.changed_at AS \"changedAt\",p.sla_seconds IS NOT NULL AS \"hasSla\",u.display_name AS \"changedByName\" FROM digital_production_deadline_revisions r JOIN digital_production_deadline_policies p ON p.node_key=r.policy_node_key AND p.version=r.policy_version JOIN app_users u ON u.id=r.changed_by WHERE r.task_id=$1 ORDER BY r.revision_id", [id])).rows };
  }
}
