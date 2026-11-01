import {assertCurrentFactoryTask} from "./retired-factory-nodes.js";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalProductionAccessPolicy, digitalForbidden, digitalNotFound, isDigitalLeader, isDigitalTechnicalManager } from "./access-policy.js";
export const DIGITAL_TASK_ROLES = {
  development_positioning:'sample_designer',development_size_review:'pattern_room_worker',development_patch:'pattern_room_worker',
  development_patch_tail_check:'pattern_room_tail_inspector',development_patch_confirmation:'sample_designer',
  sourcing_preparation: "order_merchandiser",
  development_external_pattern: "pattern_room_supervisor",
  development_washing_dispatch: "development_clerk",
  development_craft_dispatch: "sample_designer", development_craft_confirmation: "sample_designer", development_sewing_transfer: "development_clerk",
  development_material_supply: "sample_designer", development_material_recheck: "development_clerk", development_materials: "development_clerk", development_pattern: "pattern_room_worker", development_cutting: "pattern_room_worker",
  development_sewing: "pattern_room_worker", development_tail_check: "pattern_room_tail_inspector", development_pre_wash_check: "pattern_room_tail_inspector",
  development_printing: "pattern_room_worker", development_embroidery: "pattern_room_worker", development_print_embroidery: "pattern_room_worker",
  development_washing: "development_clerk", development_shipping: "sample_designer", development_confirmation: "sample_designer",
  bulk_pattern: "pattern_room_worker", warehouse_preshrink: "warehouse_receiver", bulk_cutting: "cutting_worker", bulk_cutting_external: "order_merchandiser",
  factory_material_count: "order_merchandiser", bulk_ship_sample:"order_merchandiser", budget: "sample_designer", production_sheet: "order_merchandiser",
  factory_production_qc: "quality_control", process_logistics: "embroidery_washing_merchandiser", bulk_qc: "quality_control", warehouse_dispatch: "warehouse_receiver",
} as const;
export type DigitalTaskKind = keyof typeof DIGITAL_TASK_ROLES;
// Internal transactional adapter: no public endpoint can invent a task to obtain access.
export async function createDigitalTaskAccess(client: PoolClient, actor: TrustedActorContext, input: { taskId?: string; orderId?: string; sourceId?: string; kind: DigitalTaskKind; assigneeId: string | null }) {
  const policy = new DigitalProductionAccessPolicy(client);
  assertCurrentFactoryTask(input.kind);
  const role = DIGITAL_TASK_ROLES[input.kind];
  if (!role || Boolean(input.orderId) === Boolean(input.sourceId)) digitalForbidden();
  if (input.assigneeId && !await policy.activeRole(input.assigneeId, role)) digitalForbidden();
  const taskId = input.taskId ?? randomUUID();
  await client.query(`INSERT INTO digital_production_task_access(task_id,production_order_id,source_id,task_kind,required_role,assignee_id,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [taskId, input.orderId ?? null, input.sourceId ?? null, input.kind, role, input.assigneeId, actor.actorId]);
  return taskId;
}
export async function reassignDigitalTask(client: PoolClient, actor: TrustedActorContext, taskId: string, assigneeId: string) {
  const task = (await client.query("SELECT * FROM digital_production_task_access WHERE task_id=$1 FOR UPDATE", [taskId])).rows[0] ?? digitalNotFound();
  assertCurrentFactoryTask(task.task_kind);
  if (["sourcing_preparation","bulk_cutting_external","bulk_ship_sample"].includes(task.task_kind) && !(await client.query("SELECT 1 FROM digital_production_orders WHERE production_order_id=$1 AND primary_merchandiser_id=$2", [task.production_order_id, assigneeId])).rowCount) digitalForbidden();
  const development = task.task_kind.startsWith("development_") || task.task_kind === "bulk_pattern";
  if (!isDigitalLeader(actor) && !(development && (isDigitalTechnicalManager(actor) || actor.actorRoles.includes("development_clerk")))) digitalForbidden();
  if (!await new DigitalProductionAccessPolicy(client).activeRole(assigneeId, task.required_role)) digitalForbidden();
  await client.query("UPDATE digital_production_task_access SET assignee_id=$2 WHERE task_id=$1", [taskId, assigneeId]);
  // Daily dispatch never changes wage attribution. Wage reassignment remains with its original service.
  await client.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state)
    VALUES($1,$2,$3,'digital_task_reassigned','digital_task',$4,$5,$6)`, [randomUUID(), actor.requestId, actor.actorId, taskId, JSON.stringify({ assigneeId: task.assignee_id }), JSON.stringify({ assigneeId })]);
  return { taskId, assigneeId };
}
