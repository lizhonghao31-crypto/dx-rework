import { createHash, randomUUID } from "node:crypto";

import {
  WorkReportsBatchResponseSchema,
  type AddActiveWorkTaskMembers,
  type CreateWorkReport,
  type CreateWorkReportsBatch,
  type CreateWorkTask,
  type ConfirmWorkAssignments,
  type FrontlineTaskKind,
  type FrontlineTasksResponse,
  type ReworkWorkTasksResponse,
  type RemoveActiveWorkTask,
  type WorkReportResponse,
  type WorkReportsBatchResponse,
  type WorkTaskResponse,
} from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import { ensureWithinSourceReceivingActualQuantity } from "./receiving-quantity-ceiling.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";

type WorkTaskRow = Readonly<{
  work_task_id: string; rework_order_id: string; configuration_item_id: string;
  task_version: number; assignment_mode: "individual" | "collective"; status: "active" | "superseded";
  special_process_type?: "inspection" | "other_craft" | null;
  process_name: string; execution_kind: "worker" | "tail_inspection"; pricing_unit: "piece" | "hour"; planned_quantity: string; unit_price: string | null;
}>;
type PersonRow = Readonly<{ person_id: string; person_type: "internal" | "temporary"; display_name: string; app_user_id: string | null }>;
type OrderRow = Readonly<{
  rework_order_id: string; rework_no: string | null; status: string; version: number;
  special_process_type?: "none" | "inspection" | "other_craft" | null; other_craft_description?: string | null;
  style_no: string | null; order_no: string | null; merchandiser_user_id: string | null;
  processing_factory_type: "own_factory" | "supplier" | null; processing_factory_supplier_id: string | null;
  processing_factory_supplier_version: number | null; problem_part: string | null;
  problem_description: string | null; rework_quantity: number | null;
}>;
type FrontlineTaskRow = Readonly<{
  rework_order_id: string;
  rework_no: string | null;
  style_no: string | null;
  order_no: string | null;
  images: Array<{ attachmentId: string; filename: string }>;
  process_names: string[];
}>;
type Result<T> = Readonly<{ value: T; reused: boolean }>;

const hash = (scope: string, payload: unknown): string =>
  createHash("sha256").update(JSON.stringify({ scope, payload })).digest("hex");
const numberValue = (value: string | number): number => Number(value);
type Decimal = Readonly<{ units: bigint; scale: number }>;
const MONEY_SCALE = 3;

const decimal = (value: string | number): Decimal => {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) throw new TypeError("Expected a finite decimal value");
  const sign = match[1] === "-" ? "-" : "";
  const whole = match[2]!;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  const digits = whole + fraction;
  const point = whole.length + exponent;
  const expanded = point <= 0
    ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length
      ? `${digits}${"0".repeat(point - digits.length)}`
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [integer, decimalPart = ""] = expanded.split(".");
  return { units: BigInt(`${sign}${integer}${decimalPart}`), scale: decimalPart.length };
};

const atScale = (value: Decimal, scale: number): bigint => value.scale <= scale
  ? value.units * 10n ** BigInt(scale - value.scale)
  : value.units / 10n ** BigInt(value.scale - scale);

const decimalNumber = (units: bigint, scale: number): number => {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return Number(negative ? `-${text}` : text);
};

export const hasAtMostDecimalPlaces = (value: number, maximum: number): boolean =>
  decimal(value).scale <= maximum;

export const calculateWorkAmount = (quantity: number, unitPrice: string | number): number => {
  const quantityDecimal = decimal(quantity);
  const priceDecimal = decimal(unitPrice);
  const scale = quantityDecimal.scale + priceDecimal.scale;
  return decimalNumber(
    atScale({ units: quantityDecimal.units * priceDecimal.units, scale }, MONEY_SCALE),
    MONEY_SCALE,
  );
};

export const splitAmount = (total: number, members: number): number[] => {
  const units = atScale(decimal(total), MONEY_SCALE);
  const memberCount = BigInt(members);
  const base = units / memberCount;
  const residual = units % memberCount;
  return Array.from({ length: members }, (_, index) => decimalNumber(base + (BigInt(index) < residual ? 1n : 0n), MONEY_SCALE));
};
const error = (message: string, status = 409, code = "CONFLICT"): never => { throw new ApplicationError(code, message, status); };

export class WorkReportingService {
  constructor(
    private readonly database: Pool,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
    private readonly todos?: TodoProjectionService,
  ) {}

  async list(actor: TrustedActorContext, reworkOrderId: string): Promise<ReworkWorkTasksResponse> {
    const order = await this.order(this.database, reworkOrderId, false);
    const tasks = await this.tasks(this.database, reworkOrderId, actor);
    return { reworkOrderId, reworkStatus: order.status as ReworkWorkTasksResponse["reworkStatus"], orderVersion: order.version, specialProcessType: order.special_process_type ?? null, otherCraftDescription: order.other_craft_description ?? null, tasks };
  }

  async listFrontlineTasks(actor: TrustedActorContext, kind: FrontlineTaskKind): Promise<FrontlineTasksResponse> {
    const allowed = kind === "worker" ? this.isWorker(actor) : this.isTailInspector(actor);
    if (!allowed && !isRootActor(actor)) {
      error(kind === "worker" ? "当前账号没有本人返工任务权限" : "当前账号没有本人整查任务权限", 403, "FORBIDDEN");
    }
    const result = await this.database.query<FrontlineTaskRow>(
      `SELECT order_record.rework_order_id,order_record.rework_no,order_record.style_no,order_record.order_no,
              COALESCE((
                SELECT jsonb_agg(
                  jsonb_build_object(
                    'attachmentId',attachment.attachment_id,
                    'filename',attachment.original_filename
                  ) ORDER BY attachment.created_at,attachment.attachment_id
                )
                FROM attachments attachment
                WHERE attachment.entity_type='rework_order'
                  AND attachment.entity_id::text=order_record.rework_order_id::text
                  AND attachment.status='ready'
                  AND attachment.mime_type LIKE 'image/%'
              ),'[]'::jsonb) AS images,
              array_agg(DISTINCT item.process_name ORDER BY item.process_name) AS process_names
       FROM rework_orders order_record
       JOIN rework_work_tasks task ON task.rework_order_id=order_record.rework_order_id AND task.status='active'
       JOIN rework_process_configuration_items item ON item.configuration_item_id=task.configuration_item_id
       JOIN rework_work_task_members member ON member.work_task_id=task.work_task_id
       JOIN business_people person ON person.person_id=member.person_id
       WHERE order_record.status='in_progress'
         AND item.execution_kind=$2
         AND person.app_user_id=$1::uuid
         AND NOT EXISTS(
           SELECT 1 FROM rework_work_reports report
           WHERE report.work_task_id=task.work_task_id AND report.status='submitted'
             AND NOT EXISTS(
               SELECT 1 FROM rework_work_report_rejections rejection
               WHERE rejection.work_report_id=report.work_report_id
             )
         )
       GROUP BY order_record.rework_order_id,order_record.rework_no,order_record.style_no,order_record.order_no,order_record.updated_at
       ORDER BY order_record.updated_at DESC,order_record.rework_order_id DESC
       LIMIT 100`,
      [actor.actorId, kind],
    );
    return {
      kind,
      items: result.rows.map((row) => ({
        reworkOrderId: row.rework_order_id,
        reworkNo: row.rework_no,
        styleNo: row.style_no,
        orderNo: row.order_no,
        images: row.images,
        processNames: row.process_names,
        status: "in_progress" as const,
      })),
    };
  }

  async listAssignablePeople(
    actor: TrustedActorContext,
    purpose: "assignment" | "active_adjustment" = "assignment",
  ): Promise<Array<{
    personId: string;
    displayName: string;
    personType: "internal" | "temporary";
    eligibleExecutionKinds: Array<"worker" | "tail_inspection">;
  }>> {
    if (purpose === "active_adjustment") this.ensureWorkforceAdjustment(actor);
    else this.ensure(actor, "work:assign");
    const result = await this.database.query<{
      person_id: string;
      display_name: string;
      person_type: "internal" | "temporary";
      worker_eligible: boolean;
      tail_eligible: boolean;
    }>(
      `SELECT person.person_id,person.display_name,person.person_type,
              (person.person_type='temporary' OR EXISTS (
                SELECT 1 FROM user_role_assignments assignment
                JOIN business_roles role ON role.role_code=assignment.role_code AND role.enabled=true
                JOIN app_users app_user ON app_user.id=assignment.user_id AND app_user.enabled=true
                JOIN identity_mappings identity ON identity.user_id=app_user.id
                  AND identity.provider='dingtalk' AND identity.active=true AND identity.employed=true
                JOIN access_security_policy policy ON policy.policy_key='primary' AND policy.dingtalk_corp_id=identity.corp_id
                WHERE assignment.user_id=person.app_user_id
                  AND assignment.role_code='worker' AND assignment.revoked_at IS NULL
              )) AS worker_eligible,
              (person.person_type='temporary' OR (
                person.person_type='internal' AND EXISTS (
                  SELECT 1 FROM user_role_assignments assignment
                  JOIN business_roles role ON role.role_code=assignment.role_code AND role.enabled=true
                  JOIN role_capabilities capability ON capability.role_code=assignment.role_code
                    AND capability.capability='tail_inspection:report'
                  JOIN app_users app_user ON app_user.id=assignment.user_id AND app_user.enabled=true
                  JOIN identity_mappings identity ON identity.user_id=app_user.id
                    AND identity.provider='dingtalk' AND identity.active=true AND identity.employed=true
                  JOIN access_security_policy policy ON policy.policy_key='primary' AND policy.dingtalk_corp_id=identity.corp_id
                  WHERE assignment.user_id=person.app_user_id
                    AND assignment.role_code IN ('worker','tail_inspector') AND assignment.revoked_at IS NULL
                )
              )) AS tail_eligible
       FROM business_people person
       WHERE person.active=true
       ORDER BY person.display_name,person.person_id`,
    );
    return result.rows.flatMap((person) => {
      const eligibleExecutionKinds: Array<"worker" | "tail_inspection"> = [];
      if (person.worker_eligible) eligibleExecutionKinds.push("worker");
      if (person.tail_eligible) eligibleExecutionKinds.push("tail_inspection");
      return eligibleExecutionKinds.length > 0 ? [{
        personId: person.person_id,
        displayName: person.display_name,
        personType: person.person_type,
        eligibleExecutionKinds,
      }] : [];
    });
  }

  async createTask(actor: TrustedActorContext, reworkOrderId: string, input: CreateWorkTask, key: string): Promise<Result<WorkTaskResponse>> {
    this.ensure(actor, "work:assign");
    return this.mutate(actor, "rework.work_task.assign", key, { reworkOrderId, ...input }, 201, async (client) => {
      const order = await this.order(client, reworkOrderId, true);
      if (order.status !== "pending_task_assignment") error("当前返工单不在分配任务节点", 409, "INVALID_STATE_TRANSITION");
      if (order.version !== input.expectedOrderVersion) error("返工单已被其他操作更新，请刷新后重试");
      const configuration = await client.query<{ configuration_item_id: string; process_name: string; pricing_unit: "piece" | "hour"; planned_quantity: string; unit_price: string | null }>(
        `SELECT item.configuration_item_id,item.process_name,item.pricing_unit,
                COALESCE((SELECT adjustment.requested_planned_quantity
                  FROM rework_process_quantity_adjustments adjustment
                  WHERE adjustment.configuration_item_id=item.configuration_item_id AND adjustment.status='effective'
                  ORDER BY adjustment.adjustment_version DESC LIMIT 1),item.planned_quantity) AS planned_quantity,item.unit_price
         FROM rework_process_configurations configuration JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
         WHERE configuration.rework_order_id=$1 AND configuration.status='approved' AND item.configuration_item_id=$2 FOR UPDATE`,
        [reworkOrderId, input.configurationItemId],
      );
      const item = configuration.rows[0];
      if (!item) throw new ApplicationError("NOT_FOUND", "工序不存在或尚未生效", 404);
      const people = await client.query<PersonRow>(
        `SELECT person.person_id,person.person_type,person.display_name,person.app_user_id
         FROM business_people person
         WHERE person.active=true AND person.person_id=ANY($1::uuid[]) AND (
           person.person_type='temporary' OR EXISTS (
             SELECT 1 FROM user_role_assignments assignment
             JOIN business_roles role ON role.role_code=assignment.role_code AND role.enabled=true
             WHERE assignment.user_id=person.app_user_id
               AND assignment.role_code='worker' AND assignment.revoked_at IS NULL
           )
         ) ORDER BY person.person_id FOR SHARE`,
        [input.members.map((member) => member.personId)],
      );
      if (people.rowCount !== input.members.length) error("存在无效、停用或未获工人上数资格的内部人员", 400, "VALIDATION_ERROR");
      if (input.mode === "individual") {
        const duplicate = await client.query<{ person_id: string }>(
          `SELECT member.person_id
           FROM rework_work_tasks task
           JOIN rework_work_task_members member ON member.work_task_id=task.work_task_id
           WHERE task.rework_order_id=$1 AND task.configuration_item_id=$2
             AND task.assignment_mode='individual' AND task.status='active'
             AND member.person_id=$3
           FOR UPDATE`,
          [reworkOrderId, input.configurationItemId, input.members[0]!.personId],
        );
        if (duplicate.rows[0]) error("该人员已经分配到这道工序", 409, "CONFLICT");
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["dx_rework:work-task:" + input.configurationItemId]);
      const latest = await client.query<{ task_version: number }>(
        "SELECT task_version FROM rework_work_tasks WHERE rework_order_id=$1 AND configuration_item_id=$2 ORDER BY task_version DESC LIMIT 1 FOR UPDATE",
        [reworkOrderId, input.configurationItemId],
      );
      const active = input.mode === "collective" ? await client.query<{ work_task_id: string }>(
        "SELECT work_task_id FROM rework_work_tasks WHERE rework_order_id=$1 AND configuration_item_id=$2 AND assignment_mode='collective' AND status='active' FOR UPDATE",
        [reworkOrderId, input.configurationItemId],
      ) : { rows: [] as Array<{ work_task_id: string }> };
      const version = (latest.rows[0]?.task_version ?? 0) + 1;
      const taskId = randomUUID();
      const eventId = await this.events.append(client, actor, {
        action: "rework.work_task.assign", entityType: "rework_order", entityId: reworkOrderId,
        before: { orderVersion: order.version, activeTaskId: active.rows[0]?.work_task_id ?? null },
        after: { ...this.orderAuditState(order, order.status, order.version), workTaskId: taskId, configurationItemId: item.configuration_item_id, mode: input.mode, memberIds: people.rows.map((person) => person.person_id) },
      });
      await this.context(client, eventId, actor.requestId);
      if (active.rows[0]) await client.query("UPDATE rework_work_tasks SET status='superseded',superseded_at=CURRENT_TIMESTAMP WHERE work_task_id=$1", [active.rows[0].work_task_id]);
      await client.query("INSERT INTO rework_work_tasks(work_task_id,rework_order_id,configuration_item_id,task_version,assignment_mode,created_by) VALUES($1,$2,$3,$4,$5,$6)", [taskId, reworkOrderId, item.configuration_item_id, version, input.mode, actor.actorId]);
      for (const person of people.rows) await client.query(
        "INSERT INTO rework_work_task_members(work_task_id,person_id,display_name_snapshot,person_type_snapshot) VALUES($1,$2,$3,$4)",
        [taskId, person.person_id, person.display_name, person.person_type],
      );
      return this.taskDto(client, taskId, actor);
    });
  }

  async addActiveTaskMembers(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: AddActiveWorkTaskMembers,
    key: string,
  ): Promise<Result<ReworkWorkTasksResponse>> {
    this.ensureWorkforceAdjustment(actor);
    return this.mutate(actor, "rework.work_task.active_add", key, { reworkOrderId, ...input }, 201, async (client) => {
      const order = await this.order(client, reworkOrderId, true);
      if (order.status !== "in_progress") error("只能在返工执行中新增员工", 409, "INVALID_STATE_TRANSITION");
      if (order.version !== input.expectedOrderVersion) error("返工单已被其他操作更新，请刷新后重试");

      const configuration = await client.query<{
        configuration_item_id: string;
        execution_kind: "worker" | "tail_inspection";
      }>(
        `SELECT item.configuration_item_id,item.execution_kind
         FROM rework_process_configurations configuration
         JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
         WHERE configuration.rework_order_id=$1 AND configuration.status='approved'
           AND item.configuration_item_id=$2
         FOR UPDATE OF item`,
        [reworkOrderId, input.configurationItemId],
      );
      const item = configuration.rows[0];
      if (!item) throw new ApplicationError("NOT_FOUND", "工序不存在或尚未生效", 404);

      const people = await client.query<PersonRow>(
        `SELECT person.person_id,person.person_type,person.display_name,person.app_user_id
         FROM business_people person
         WHERE person.active=true
           AND person.person_id=ANY($1::uuid[])
           AND (
             ($2='worker' AND (
               person.person_type='temporary' OR EXISTS (
                 SELECT 1 FROM user_role_assignments assignment
                 JOIN business_roles role ON role.role_code=assignment.role_code AND role.enabled=true
                 JOIN app_users app_user ON app_user.id=assignment.user_id AND app_user.enabled=true
                 JOIN identity_mappings identity ON identity.user_id=app_user.id
                   AND identity.provider='dingtalk' AND identity.active=true AND identity.employed=true
                 JOIN access_security_policy policy ON policy.policy_key='primary'
                   AND policy.dingtalk_corp_id=identity.corp_id
                 WHERE assignment.user_id=person.app_user_id
                   AND assignment.role_code='worker' AND assignment.revoked_at IS NULL
               )
             ))
             OR
             ($2='tail_inspection' AND (
               person.person_type='temporary' OR (
                 person.person_type='internal' AND EXISTS (
                   SELECT 1 FROM user_role_assignments assignment
                   JOIN business_roles role ON role.role_code=assignment.role_code AND role.enabled=true
                   JOIN role_capabilities capability ON capability.role_code=assignment.role_code
                     AND capability.capability='tail_inspection:report'
                   JOIN app_users app_user ON app_user.id=assignment.user_id AND app_user.enabled=true
                   JOIN identity_mappings identity ON identity.user_id=app_user.id
                     AND identity.provider='dingtalk' AND identity.active=true AND identity.employed=true
                   JOIN access_security_policy policy ON policy.policy_key='primary'
                     AND policy.dingtalk_corp_id=identity.corp_id
                   WHERE assignment.user_id=person.app_user_id
                     AND assignment.role_code IN ('worker','tail_inspector')
                     AND assignment.revoked_at IS NULL
                 )
               )
             ))
           )
         ORDER BY person.person_id
         FOR SHARE`,
        [input.memberIds, item.execution_kind],
      );
      if (people.rowCount !== input.memberIds.length) {
        error("存在无效、停用或不符合该任务类型资格的员工", 400, "VALIDATION_ERROR");
      }

      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["dx_rework:work-task:" + input.configurationItemId]);
      const duplicate = await client.query<{ person_id: string }>(
        `SELECT member.person_id
         FROM rework_work_tasks task
         JOIN rework_work_task_members member ON member.work_task_id=task.work_task_id
         WHERE task.rework_order_id=$1 AND task.configuration_item_id=$2
           AND task.status='active' AND member.person_id=ANY($3::uuid[])`,
        [reworkOrderId, input.configurationItemId, input.memberIds],
      );
      if (duplicate.rows[0]) error("所选员工中有人已在这道工序，请刷新后重试", 409, "CONFLICT");

      const latest = await client.query<{ task_version: number }>(
        "SELECT task_version FROM rework_work_tasks WHERE rework_order_id=$1 AND configuration_item_id=$2 ORDER BY task_version DESC LIMIT 1 FOR UPDATE",
        [reworkOrderId, input.configurationItemId],
      );
      const firstVersion = (latest.rows[0]?.task_version ?? 0) + 1;
      const additions = people.rows.map((person, index) => ({
        person,
        workTaskId: randomUUID(),
        version: firstVersion + index,
      }));
      const eventId = await this.events.append(client, actor, {
        action: "rework.work_task.active_add",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before: { ...this.orderAuditState(order, order.status, order.version), configurationItemId: item.configuration_item_id },
        after: {
          ...this.orderAuditState(order, order.status, order.version + 1),
          configurationItemId: item.configuration_item_id,
          addedWorkTaskIds: additions.map((addition) => addition.workTaskId),
          addedMemberIds: additions.map((addition) => addition.person.person_id),
        },
      });
      await this.context(client, eventId, actor.requestId);
      for (const addition of additions) {
        await client.query(
          "INSERT INTO rework_work_tasks(work_task_id,rework_order_id,configuration_item_id,task_version,assignment_mode,created_by) VALUES($1,$2,$3,$4,'individual',$5)",
          [addition.workTaskId, reworkOrderId, item.configuration_item_id, addition.version, actor.actorId],
        );
        await client.query(
          "INSERT INTO rework_work_task_members(work_task_id,person_id,display_name_snapshot,person_type_snapshot) VALUES($1,$2,$3,$4)",
          [addition.workTaskId, addition.person.person_id, addition.person.display_name, addition.person.person_type],
        );
      }
      await client.query(
        "UPDATE rework_orders SET updated_by=$2,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE rework_order_id=$1 AND version=$3",
        [reworkOrderId, actor.actorId, order.version],
      );
      return {
        reworkOrderId,
        reworkStatus: "in_progress",
        orderVersion: order.version + 1,
        tasks: await this.tasks(client, reworkOrderId, actor),
      };
    });
  }

  async removeActiveTask(
    actor: TrustedActorContext,
    reworkOrderId: string,
    workTaskId: string,
    input: RemoveActiveWorkTask,
    key: string,
  ): Promise<Result<ReworkWorkTasksResponse>> {
    this.ensureWorkforceAdjustment(actor);
    return this.mutate(actor, "rework.work_task.active_remove", key, { reworkOrderId, workTaskId, ...input }, 200, async (client) => {
      const task = await this.task(client, workTaskId, true);
      if (task.rework_order_id !== reworkOrderId) throw new ApplicationError("NOT_FOUND", "返工任务不存在", 404);
      const order = await this.order(client, reworkOrderId, true);
      if (order.status !== "in_progress") error("只能在返工执行中移除员工", 409, "INVALID_STATE_TRANSITION");
      if (order.version !== input.expectedOrderVersion) error("返工单已被其他操作更新，请刷新后重试");
      if (task.status !== "active") error("该人员任务已经被调整，请刷新后重试");
      if (task.assignment_mode !== "individual") error("执行中只能移除个人任务员工", 409, "CONFLICT");
      const reports = await client.query("SELECT 1 FROM rework_work_reports WHERE work_task_id=$1 LIMIT 1", [workTaskId]);
      if (reports.rows[0]) error("该员工已有上报记录，不能移除", 409, "CONFLICT");
      const members = await this.members(client, workTaskId);
      const eventId = await this.events.append(client, actor, {
        action: "rework.work_task.active_remove",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before: {
          ...this.orderAuditState(order, order.status, order.version),
          workTaskId,
          configurationItemId: task.configuration_item_id,
          memberIds: members.map((member) => member.person_id),
          taskStatus: "active",
        },
        after: {
          ...this.orderAuditState(order, order.status, order.version + 1),
          workTaskId,
          configurationItemId: task.configuration_item_id,
          memberIds: members.map((member) => member.person_id),
          taskStatus: "superseded",
        },
      });
      await this.context(client, eventId, actor.requestId);
      await client.query(
        "UPDATE rework_work_tasks SET status='superseded',superseded_at=CURRENT_TIMESTAMP WHERE work_task_id=$1",
        [workTaskId],
      );
      await client.query(
        "UPDATE rework_orders SET updated_by=$2,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE rework_order_id=$1 AND version=$3",
        [reworkOrderId, actor.actorId, order.version],
      );
      return {
        reworkOrderId,
        reworkStatus: "in_progress",
        orderVersion: order.version + 1,
        tasks: await this.tasks(client, reworkOrderId, actor),
      };
    });
  }

  async confirmAssignments(actor: TrustedActorContext, reworkOrderId: string, input: ConfirmWorkAssignments, key: string): Promise<Result<ReworkWorkTasksResponse>> {
    this.ensure(actor, "work:assign");
    return this.mutate(actor, "rework.work_task.assignment_confirm", key, { reworkOrderId, ...input }, 200, async (client) => {
      const order = await this.order(client, reworkOrderId, true);
      if (order.status !== "pending_task_assignment") error("当前返工单不在人员分配节点", 409, "INVALID_STATE_TRANSITION");
      if (order.version !== input.expectedOrderVersion) error("返工单已被其他操作更新，请刷新后重试");
      const missing = await client.query<{ process_name: string }>(
        `SELECT item.process_name
         FROM rework_process_configurations configuration
         JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
         WHERE configuration.rework_order_id=$1 AND configuration.status='approved'
           AND NOT EXISTS (
             SELECT 1 FROM rework_work_tasks task
             WHERE task.rework_order_id=$1 AND task.configuration_item_id=item.configuration_item_id AND task.status='active'
           )`,
        [reworkOrderId],
      );
      if (missing.rows.length > 0) error(`请先为以下工序分配返工人员：${missing.rows.map((row) => row.process_name).join("、")}`, 400, "VALIDATION_ERROR");
      const eventId = await this.events.append(client, actor, {
        action: "rework.work_task.assignment_confirm", entityType: "rework_order", entityId: reworkOrderId,
        before: this.orderAuditState(order, order.status, order.version),
        after: this.orderAuditState(order, "in_progress", order.version + 1),
      });
      await this.context(client, eventId, actor.requestId);
      await client.query(
        "UPDATE rework_orders SET status='in_progress',updated_by=$2,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE rework_order_id=$1 AND version=$3",
        [reworkOrderId, actor.actorId, order.version],
      );
      const tasks = await this.tasks(client, reworkOrderId, actor);
      return {
        reworkOrderId,
        reworkStatus: "in_progress",
        orderVersion: order.version + 1,
        tasks,
      };
    });
  }


  async completeExecution(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: ConfirmWorkAssignments,
    key: string,
  ): Promise<Result<ReworkWorkTasksResponse>> {
    this.ensure(actor, "work:assign");
    return this.mutate(actor, "rework.execution.complete", key, { reworkOrderId, ...input }, 200, async (client) => {
      const order = await this.order(client, reworkOrderId, true);
      if (order.status !== "in_progress") error("当前返工单不在返工执行节点", 409, "INVALID_STATE_TRANSITION");
      if (order.version !== input.expectedOrderVersion) error("返工单已被其他操作更新，请刷新后重试");
      if (!await this.readyForWholeOrderReview(client, reworkOrderId, [], true)) {
        error("仍有返工人员或整查任务未完成，不能进入最终数量确认", 409, "INVALID_STATE_TRANSITION");
      }
      const eventId = await this.events.append(client, actor, {
        action: "rework.execution.complete",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before: this.orderAuditState(order, order.status, order.version),
        after: {
          ...this.orderAuditState(order, "pending_order_review", order.version + 1),
          completionRecoveredFromEffectiveReports: true,
        },
        reason: "全部有效返工与整查任务已完成，恢复进入最终数量确认",
      });
      await this.context(client, eventId, actor.requestId);
      await client.query(
        "UPDATE rework_orders SET status='pending_order_review',updated_by=$2,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE rework_order_id=$1 AND version=$3",
        [reworkOrderId, actor.actorId, order.version],
      );
      await this.todos?.actionableForUniqueDirectRole(client, actor, {
        category: "whole_order_review",
        sourceEventId: eventId,
        sourceAction: "rework.execution.complete",
        entityType: "rework_order",
        entityId: reworkOrderId,
        requiredRole: "tail_supervisor",
        requiredCapability: "submission:audit",
        route: { routeName: "rework_detail", entityId: reworkOrderId, tab: "whole_order_review" },
        policyKey: "general",
        dedupeKey: `whole-order-review:${reworkOrderId}:${order.version + 1}`,
      });
      return {
        reworkOrderId,
        reworkStatus: "pending_order_review",
        orderVersion: order.version + 1,
        tasks: await this.tasks(client, reworkOrderId, actor),
      };
    });
  }

  async submitReport(actor: TrustedActorContext, workTaskId: string, input: CreateWorkReport, key: string): Promise<Result<WorkReportResponse>> {
    return this.mutate(actor, "rework.work_report.submit", key, { workTaskId, ...input }, 201, async (client) => {
      const task = await this.task(client, workTaskId, true);
      const order = await this.order(client, task.rework_order_id, true);
      if (order.status !== "in_progress") error("当前返工单不在完成数量登记节点", 409, "INVALID_STATE_TRANSITION");
      if (order.version !== input.expectedOrderVersion) error("返工单已被其他操作更新，请刷新后重试");
      if (task.status !== "active") error("该任务版本已被替换，请使用最新任务");
      const members = await this.members(client, task.work_task_id);
      const ownPerson = members.find((person) => person.app_user_id === actor.actorId);
      const reportingCapability = this.reportCapability(actor, task, members);
      if (reportingCapability === undefined) error("当前用户无权为该任务上数", 403, "FORBIDDEN");
      const reportingActor: TrustedActorContext = { ...actor, authorizationCapability: reportingCapability! };
      if (!Number.isInteger(input.actualQuantity)) error("返工执行报数只能填写整数件数", 400, "VALIDATION_ERROR");
      await ensureWithinSourceReceivingActualQuantity(client, task.rework_order_id, [{
        label: `${task.process_name}工序报数`, quantity: input.actualQuantity,
      }]);
      const existing = await client.query<{ work_report_id: string; quantity: string }>(
        `SELECT report.work_report_id,report.actual_quantity AS quantity
         FROM rework_work_reports report
         WHERE report.work_task_id=$1 AND report.status='submitted'
           AND NOT EXISTS (SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
         FOR UPDATE`,
        [workTaskId],
      );
      if (existing.rows[0]) error("该人员已完成上数；如需返工请由尾部主管退回", 409, "CONFLICT");
      const groupAmount = 0;
      const completedOrder = await this.readyForWholeOrderReview(client, task.rework_order_id, [task.work_task_id]);
      if (input.resubmitsWorkReportId) {
        const rejected = await client.query<{ work_report_id: string }>(
          `SELECT report.work_report_id FROM rework_work_reports report
           JOIN rework_work_report_rejections rejection ON rejection.work_report_id=report.work_report_id
           WHERE report.work_report_id=$1 AND report.work_task_id=$2 AND report.rework_order_id=$3
             AND report.configuration_item_id=$4 FOR SHARE`,
          [input.resubmitsWorkReportId, workTaskId, task.rework_order_id, task.configuration_item_id],
        );
        if (!rejected.rows[0]) error("只能重新提交当前任务中已驳回的历史上数", 409, "CONFLICT");
      }
      const reportId = randomUUID();
      const shares = members.map(() => 0);
      const event = {
        action: "rework.work_report.submit", entityType: "rework_order", entityId: task.rework_order_id,
        before: { submittedQuantity: 0, plannedQuantity: numberValue(task.planned_quantity) },
        after: { ...this.orderAuditState(order, completedOrder ? "pending_order_review" : order.status, completedOrder ? order.version + 1 : order.version), workReportId: reportId, workTaskId, actualQuantity: input.actualQuantity, groupAmount, memberIds: members.map((member) => member.person_id), resubmitsWorkReportId: input.resubmitsWorkReportId ?? null },
        ...(input.remark ? { reason: input.remark } : {}),
      };
      const eventId = await this.events.append(client, reportingActor, event);
      await this.context(client, eventId, actor.requestId);
      const reportInsert = await client.query<{ completed_at: Date }>(
        "INSERT INTO rework_work_reports(work_report_id,work_task_id,rework_order_id,configuration_item_id,actual_quantity,completed_at,remark,group_amount,submitted_by,resubmits_work_report_id) VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP,$6,$7,$8,$9) RETURNING completed_at",
        [reportId, workTaskId, task.rework_order_id, task.configuration_item_id, input.actualQuantity, input.remark ?? null, groupAmount, actor.actorId, input.resubmitsWorkReportId ?? null],
      );
      const completedAt = reportInsert.rows[0]?.completed_at ?? error("完工时间记录失败", 500, "INTERNAL_ERROR");
      if (input.resubmitsWorkReportId) {
        await this.todos?.completeOpenByDedupeKey(
          client,
          reportingActor,
          `work-report-return:${input.resubmitsWorkReportId}`,
          "Returned work report was corrected and resubmitted",
        );
      }
      for (const [index, member] of members.entries()) await client.query("INSERT INTO rework_work_report_member_shares(work_report_id,person_id,amount) VALUES($1,$2,$3)", [reportId, member.person_id, shares[index]]);
      if (completedOrder) await client.query(
        "UPDATE rework_orders SET status='pending_order_review',updated_by=$2,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE rework_order_id=$1",
        [task.rework_order_id, actor.actorId],
      );
      if (completedOrder) {
        await this.todos?.actionableForUniqueDirectRole(client, reportingActor, {
          category: "whole_order_review",
          sourceEventId: eventId,
          sourceAction: "rework.work_report.submit",
          entityType: "rework_order",
          entityId: task.rework_order_id,
          requiredRole: "tail_supervisor",
          requiredCapability: "submission:audit",
          route: { routeName: "rework_detail", entityId: task.rework_order_id, tab: "whole_order_review" },
          policyKey: "general",
          dedupeKey: `whole-order-review:${task.rework_order_id}:${order.version + 1}`,
        });
      }
      const workerView = reportingCapability !== "work:report_for_worker" && !this.isSupervisor(actor) && !isRootActor(actor);
      const visibleShares = members.map((member, index) => ({ personId: member.person_id, amount: shares[index]! })).filter((share) => !workerView || share.personId === ownPerson?.person_id);
      return { workReportId: reportId, workTaskId, reworkOrderId: task.rework_order_id, actualQuantity: input.actualQuantity, completedAt: completedAt.toISOString(), status: "submitted", groupAmount: workerView ? null : groupAmount, memberShares: visibleShares };
    });
  }

  async submitReportsBatch(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: CreateWorkReportsBatch,
    key: string,
  ): Promise<Result<WorkReportsBatchResponse>> {
    return this.mutate(
      actor,
      "rework.work_report.batch_submit",
      key,
      { reworkOrderId, ...input },
      201,
      async (client) => {
        if (input.reports.length === 0) {
          error("批量报数至少需要一项任务", 400, "VALIDATION_ERROR");
        }
        if (new Set(input.reports.map((report) => report.workTaskId)).size !== input.reports.length) {
          error("同一返工任务不能在一批中重复上数", 400, "VALIDATION_ERROR");
        }

        const taskIds = input.reports.map((report) => report.workTaskId);
        const lockedTasksResult = await client.query<WorkTaskRow>(
          `SELECT task.work_task_id,task.rework_order_id,task.configuration_item_id,
                  task.task_version,task.assignment_mode,task.status,item.process_name,
                  item.execution_kind,item.pricing_unit,
                  COALESCE((
                    SELECT adjustment.requested_planned_quantity
                    FROM rework_process_quantity_adjustments adjustment
                    WHERE adjustment.configuration_item_id=item.configuration_item_id
                      AND adjustment.status='effective'
                    ORDER BY adjustment.adjustment_version DESC LIMIT 1
                  ),item.planned_quantity) AS planned_quantity,item.unit_price
           FROM rework_work_tasks task
           JOIN rework_process_configuration_items item
             ON item.configuration_item_id=task.configuration_item_id
           WHERE task.work_task_id=ANY($1::uuid[])
           ORDER BY task.work_task_id
           FOR UPDATE OF task`,
          [[...taskIds].sort()],
        );
        const tasksById = new Map(lockedTasksResult.rows.map((task) => [task.work_task_id, task]));
        const lockedTasks = input.reports.map((reportInput) => {
          const task = tasksById.get(reportInput.workTaskId)
            ?? error("返工任务不存在", 404, "NOT_FOUND");
          if (task.rework_order_id !== reworkOrderId) error("批量报数包含不属于当前返工单的任务", 400, "VALIDATION_ERROR");
          if (task.status !== "active") error("该任务版本已被替换，请使用最新任务");
          return { input: reportInput, task };
        });

        const order = await this.order(client, reworkOrderId, true);
        if (order.status !== "in_progress") error("当前返工单不在完成数量登记节点", 409, "INVALID_STATE_TRANSITION");
        if (order.version !== input.expectedOrderVersion) error("返工单已被其他操作更新，请刷新后重试");
        await ensureWithinSourceReceivingActualQuantity(client, reworkOrderId, lockedTasks.map(({ input: report, task }) => ({
          label: `${task.process_name}工序报数`, quantity: report.actualQuantity,
        })));

        const membersResult = await client.query<PersonRow & { work_task_id: string }>(
          `SELECT member.work_task_id,member.person_id,
                  member.person_type_snapshot AS person_type,
                  member.display_name_snapshot AS display_name,person.app_user_id
           FROM rework_work_task_members member
           JOIN business_people person ON person.person_id=member.person_id
           WHERE member.work_task_id=ANY($1::uuid[])
           ORDER BY member.work_task_id,member.person_id`,
          [taskIds],
        );
        const membersByTask = new Map<string, PersonRow[]>();
        for (const member of membersResult.rows) {
          const members = membersByTask.get(member.work_task_id) ?? [];
          members.push(member);
          membersByTask.set(member.work_task_id, members);
        }

        const existingResult = await client.query<{ work_report_id: string; work_task_id: string }>(
          `SELECT report.work_report_id,report.work_task_id
           FROM rework_work_reports report
           WHERE report.work_task_id=ANY($1::uuid[]) AND report.status='submitted'
             AND NOT EXISTS (
               SELECT 1 FROM rework_work_report_rejections rejection
               WHERE rejection.work_report_id=report.work_report_id
             )
           ORDER BY report.work_report_id
           FOR UPDATE OF report`,
          [taskIds],
        );
        const submittedTaskIds = new Set(existingResult.rows.map((report) => report.work_task_id));

        const resubmissionIds = input.reports.flatMap((report) => (
          report.resubmitsWorkReportId ? [report.resubmitsWorkReportId] : []
        ));
        const rejectedResult = resubmissionIds.length === 0
          ? { rows: [] as Array<{
            work_report_id: string;
            work_task_id: string;
            rework_order_id: string;
            configuration_item_id: string;
          }> }
          : await client.query<{
            work_report_id: string;
            work_task_id: string;
            rework_order_id: string;
            configuration_item_id: string;
          }>(
            `SELECT report.work_report_id,report.work_task_id,
                    report.rework_order_id,report.configuration_item_id
             FROM rework_work_reports report
             JOIN rework_work_report_rejections rejection
               ON rejection.work_report_id=report.work_report_id
             WHERE report.work_report_id=ANY($1::uuid[])
             ORDER BY report.work_report_id
             FOR SHARE OF report`,
            [resubmissionIds],
          );
        const rejectedById = new Map(rejectedResult.rows.map((report) => [report.work_report_id, report]));

        const prepared: Array<{
          input: CreateWorkReportsBatch["reports"][number];
          task: WorkTaskRow;
          members: PersonRow[];
          ownPerson: PersonRow | undefined;
          reportingActor: TrustedActorContext;
          reportId: string;
          shares: number[];
        }> = [];
        for (const { input: reportInput, task } of lockedTasks) {
          const members = membersByTask.get(task.work_task_id) ?? [];
          const ownPerson = members.find((person) => person.app_user_id === actor.actorId);
          const reportingCapability = this.reportCapability(actor, task, members);
          if (reportingCapability === undefined) error("当前用户无权为该任务上数", 403, "FORBIDDEN");
          if (!Number.isInteger(reportInput.actualQuantity)) {
            error("返工执行报数只能填写整数件数", 400, "VALIDATION_ERROR");
          }
          if (submittedTaskIds.has(task.work_task_id)) {
            error("该人员已完成上数；如需返工请由尾部主管退回", 409, "CONFLICT");
          }
          if (reportInput.resubmitsWorkReportId) {
            const rejected = rejectedById.get(reportInput.resubmitsWorkReportId);
            if (
              !rejected
              || rejected.work_task_id !== task.work_task_id
              || rejected.rework_order_id !== reworkOrderId
              || rejected.configuration_item_id !== task.configuration_item_id
            ) error("只能重新提交当前任务中已驳回的历史上数", 409, "CONFLICT");
          }
          prepared.push({
            input: reportInput,
            task,
            members,
            ownPerson,
            reportingActor: { ...actor, authorizationCapability: reportingCapability! },
            reportId: randomUUID(),
            shares: members.map(() => 0),
          });
        }

        const completedOrder = await this.readyForWholeOrderReview(
          client,
          reworkOrderId,
          prepared.map(({ task }) => task.work_task_id),
        );
        const eventIds = await this.events.appendMany(client, prepared.map((item, index) => {
          const completesOrder = completedOrder && index === prepared.length - 1;
          const groupAmount = 0;
          return {
            actor: item.reportingActor,
            input: {
              action: "rework.work_report.submit",
              entityType: "rework_order",
              entityId: reworkOrderId,
              before: {
                submittedQuantity: 0,
                plannedQuantity: numberValue(item.task.planned_quantity),
              },
              after: {
                ...this.orderAuditState(
                  order,
                  completesOrder ? "pending_order_review" : order.status,
                  completesOrder ? order.version + 1 : order.version,
                ),
                workReportId: item.reportId,
                workTaskId: item.task.work_task_id,
                actualQuantity: item.input.actualQuantity,
                groupAmount,
                memberIds: item.members.map((member) => member.person_id),
                resubmitsWorkReportId: item.input.resubmitsWorkReportId ?? null,
              },
              ...(item.input.remark ? { reason: item.input.remark } : {}),
            },
          };
        }));
        const audited = prepared.map((item, index) => ({
          ...item,
          eventId: eventIds[index] ?? error("批量报数审计事件缺失", 500, "INTERNAL_ERROR"),
        }));
        const byCapability = new Map<string, typeof audited>();
        for (const item of audited) {
          const group = byCapability.get(item.reportingActor.authorizationCapability) ?? [];
          group.push(item);
          byCapability.set(item.reportingActor.authorizationCapability, group);
        }

        const completedAtByReport = new Map<string, Date>();
        for (const group of byCapability.values()) {
          await this.context(client, group[0]!.eventId, actor.requestId);
          const inserted = await client.query<{ work_report_id: string; completed_at: Date }>(
            `INSERT INTO rework_work_reports(
               work_report_id,work_task_id,rework_order_id,configuration_item_id,
               actual_quantity,completed_at,remark,group_amount,submitted_by,resubmits_work_report_id
             )
             SELECT report.work_report_id::uuid,report.work_task_id::uuid,report.rework_order_id::uuid,
                    report.configuration_item_id::uuid,report.actual_quantity,CURRENT_TIMESTAMP,
                    report.remark,report.group_amount,report.submitted_by::uuid,
                    report.resubmits_work_report_id::uuid
             FROM jsonb_to_recordset($1::jsonb) AS report(
               work_report_id text,work_task_id text,rework_order_id text,configuration_item_id text,
               actual_quantity numeric,remark text,group_amount numeric,submitted_by text,
               resubmits_work_report_id text
             )
             ORDER BY report.work_report_id
             RETURNING work_report_id,completed_at`,
            [JSON.stringify(group.map((item) => ({
              work_report_id: item.reportId,
              work_task_id: item.task.work_task_id,
              rework_order_id: reworkOrderId,
              configuration_item_id: item.task.configuration_item_id,
              actual_quantity: item.input.actualQuantity,
              remark: item.input.remark ?? null,
              group_amount: 0,
              submitted_by: actor.actorId,
              resubmits_work_report_id: item.input.resubmitsWorkReportId ?? null,
            })))],
          );
          if (inserted.rows.length !== group.length) {
            error("批量报数记录不完整", 500, "INTERNAL_ERROR");
          }
          for (const report of inserted.rows) {
            completedAtByReport.set(report.work_report_id, report.completed_at);
          }
          await client.query(
            `INSERT INTO rework_work_report_member_shares(work_report_id,person_id,amount)
             SELECT share.work_report_id::uuid,share.person_id::uuid,share.amount
             FROM jsonb_to_recordset($1::jsonb) AS share(
               work_report_id text,person_id text,amount numeric
             )
             ORDER BY share.work_report_id,share.person_id`,
            [JSON.stringify(group.flatMap((item) => item.members.map((member, memberIndex) => ({
              work_report_id: item.reportId,
              person_id: member.person_id,
              amount: item.shares[memberIndex],
            }))))],
          );
        }

        for (const item of audited) {
          if (item.input.resubmitsWorkReportId) {
            await this.todos?.completeOpenByDedupeKey(
              client,
              item.reportingActor,
              `work-report-return:${item.input.resubmitsWorkReportId}`,
              "Returned work report was corrected and resubmitted",
            );
          }
        }

        const reports: WorkReportResponse[] = audited.map((item) => {
          const completedAt = completedAtByReport.get(item.reportId)
            ?? error("完工时间记录失败", 500, "INTERNAL_ERROR");
          const groupAmount = 0;
          const workerView = item.reportingActor.authorizationCapability !== "work:report_for_worker"
            && !this.isSupervisor(actor)
            && !isRootActor(actor);
          const visibleShares = item.members
            .map((member, memberIndex) => ({
              personId: member.person_id,
              amount: item.shares[memberIndex]!,
            }))
            .filter((share) => !workerView || share.personId === item.ownPerson?.person_id);
          return {
            workReportId: item.reportId,
            workTaskId: item.task.work_task_id,
            reworkOrderId,
            actualQuantity: item.input.actualQuantity,
            completedAt: completedAt.toISOString(),
            status: "submitted",
            groupAmount: workerView ? null : groupAmount,
            memberShares: visibleShares,
          };
        });

        const completion = audited[audited.length - 1]
          ?? error("批量报数完工事件缺失", 500, "INTERNAL_ERROR");

        if (completedOrder) {
          await this.context(client, completion.eventId, actor.requestId);
          await client.query(
            "UPDATE rework_orders SET status='pending_order_review',updated_by=$2,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE rework_order_id=$1 AND version=$3",
            [reworkOrderId, actor.actorId, order.version],
          );
          await this.todos?.actionableForUniqueDirectRole(
            client,
            completion.reportingActor,
            {
              category: "whole_order_review",
              sourceEventId: completion.eventId,
              sourceAction: "rework.work_report.submit",
              entityType: "rework_order",
              entityId: reworkOrderId,
              requiredRole: "tail_supervisor",
              requiredCapability: "submission:audit",
              route: { routeName: "rework_detail", entityId: reworkOrderId, tab: "whole_order_review" },
              policyKey: "general",
              dedupeKey: `whole-order-review:${reworkOrderId}:${order.version + 1}`,
            },
          );
        }

        return WorkReportsBatchResponseSchema.parse({
          reworkOrderId,
          reworkStatus: completedOrder ? "pending_order_review" : "in_progress",
          orderVersion: completedOrder ? order.version + 1 : order.version,
          reports,
        });
      },
    );
  }

  private capabilities(actor: TrustedActorContext): readonly string[] {
    return actor.authorizationCapabilities ?? [actor.authorizationCapability];
  }

  private isSupervisor(actor: TrustedActorContext): boolean {
    return actor.actorRoles.includes("tail_supervisor") && this.capabilities(actor).includes("work:assign");
  }

  private isWorkforceAdjuster(actor: TrustedActorContext): boolean {
    return (
      isRootActor(actor)
      || actor.actorRoles.includes("tail_supervisor")
      || actor.actorRoles.includes("owner_group")
    ) && this.capabilities(actor).includes("work:assignment_adjust");
  }

  private isWorker(actor: TrustedActorContext): boolean {
    return actor.actorRoles.includes("worker") && this.capabilities(actor).includes("work:report");
  }

  private isTailInspector(actor: TrustedActorContext): boolean {
    return actor.actorRoles.some((role) => role === "worker" || role === "tail_inspector")
      && this.capabilities(actor).includes("tail_inspection:report");
  }

  private canProxyReport(actor: TrustedActorContext, members?: readonly PersonRow[]): boolean {
    if (isRootActor(actor)) return true;
    return this.capabilities(actor).includes("work:report_for_worker")
      && (members === undefined || members.some((person) => person.person_type === "temporary"));
  }

  private isOwnWorker(actor: TrustedActorContext, members: readonly PersonRow[]): boolean {
    return this.isWorker(actor) && members.some((person) => person.app_user_id === actor.actorId);
  }

  private isOwnTailInspector(actor: TrustedActorContext, members: readonly PersonRow[]): boolean {
    return this.isTailInspector(actor) && members.some((person) => person.app_user_id === actor.actorId);
  }

  private reportCapability(
    actor: TrustedActorContext,
    task: WorkTaskRow,
    members: readonly PersonRow[],
  ): "work:report" | "work:report_for_worker" | "tail_inspection:report" | undefined {
    if (task.execution_kind === "tail_inspection") {
      if (isRootActor(actor) || this.isOwnTailInspector(actor, members)) return "tail_inspection:report";
      if (this.canProxyReport(actor, members)) return "work:report_for_worker";
      return undefined;
    }
    if (this.isOwnWorker(actor, members)) return "work:report";
    if (this.canProxyReport(actor, members)) return "work:report_for_worker";
    return undefined;
  }

  private canSubmitReport(actor: TrustedActorContext, task: WorkTaskRow, members: readonly PersonRow[]): boolean {
    return this.reportCapability(actor, task, members) !== undefined;
  }

  private ensure(actor: TrustedActorContext, capability: string): void {
    if (!actor.actorRoles.includes("tail_supervisor") || actor.authorizationCapability !== capability) {
      error("当前角色无权分配任务", 403, "FORBIDDEN");
    }
  }

  private ensureWorkforceAdjustment(actor: TrustedActorContext): void {
    if (!this.isWorkforceAdjuster(actor) || actor.authorizationCapability !== "work:assignment_adjust") {
      error("当前角色无权调整执行中员工", 403, "FORBIDDEN");
    }
  }

  private async context(client: PoolClient, eventId: string, requestId: string): Promise<void> {
    await client.query(
      "SELECT set_config('dx_rework.work_event_id',$1,true),set_config('dx_rework.work_request_id',$2,true),set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true)",
      [eventId, requestId],
    );
  }

  private orderAuditState(order: OrderRow, status: string, version: number): Record<string, unknown> {
    return {
      reworkOrderId: order.rework_order_id, reworkNo: order.rework_no, status, styleNo: order.style_no, orderNo: order.order_no,
      merchandiserUserId: order.merchandiser_user_id,
      processingFactory: order.processing_factory_type === null ? null : order.processing_factory_type === "own_factory"
        ? { type: "own_factory" }
        : { type: "supplier", supplierId: order.processing_factory_supplier_id, supplierVersion: order.processing_factory_supplier_version },
      problemPart: order.problem_part, problemDescription: order.problem_description, reworkQuantity: order.rework_quantity, version,
    };
  }

  private async order(client: Pick<Pool, "query"> | PoolClient, id: string, locked: boolean): Promise<OrderRow> {
    const result = await client.query<OrderRow>(`SELECT rework_order_id,rework_no,status,version,style_no,order_no,merchandiser_user_id,processing_factory_type,processing_factory_supplier_id,processing_factory_supplier_version,problem_part,problem_description,rework_quantity,special_process_type,other_craft_description FROM rework_orders WHERE rework_order_id=$1 AND status<>'deleted'${locked ? " FOR UPDATE" : ""}`, [id]);
    return result.rows[0] ?? error("返工单不存在", 404, "NOT_FOUND");
  }

  private async task(client: PoolClient, id: string, locked: boolean): Promise<WorkTaskRow> {
    const result = await client.query<WorkTaskRow>(`SELECT task.work_task_id,task.rework_order_id,task.configuration_item_id,task.task_version,task.assignment_mode,task.status,item.process_name,item.execution_kind,item.special_process_type,item.pricing_unit,COALESCE((SELECT adjustment.requested_planned_quantity FROM rework_process_quantity_adjustments adjustment WHERE adjustment.configuration_item_id=item.configuration_item_id AND adjustment.status='effective' ORDER BY adjustment.adjustment_version DESC LIMIT 1),item.planned_quantity) AS planned_quantity,item.unit_price FROM rework_work_tasks task JOIN rework_process_configuration_items item ON item.configuration_item_id=task.configuration_item_id WHERE task.work_task_id=$1${locked ? " FOR UPDATE OF task" : ""}`, [id]);
    return result.rows[0] ?? error("返工任务不存在", 404, "NOT_FOUND");
  }

  private async readyForWholeOrderReview(client: PoolClient, reworkOrderId: string, submittedWorkTaskIds: readonly string[], allowReportedTaskRecovery = false): Promise<boolean> {
    const result = await client.query<{ ready: boolean }>(
      `SELECT EXISTS(
       SELECT 1 FROM rework_work_tasks task
         WHERE task.rework_order_id=$1 AND task.status='active'
       )
       AND NOT EXISTS(
         SELECT 1
         FROM rework_process_configurations configuration
         JOIN rework_process_configuration_items item
           ON item.configuration_id=configuration.configuration_id
         JOIN rework_orders target ON target.rework_order_id=configuration.rework_order_id
         WHERE configuration.rework_order_id=$1 AND configuration.status='approved'
           AND (item.execution_kind='worker' OR target.tail_inspection_required)
           AND NOT EXISTS(
             SELECT 1 FROM rework_work_tasks active_task
             WHERE active_task.rework_order_id=$1
               AND active_task.configuration_item_id=item.configuration_item_id
               AND active_task.status='active'
           )
       )
       AND NOT EXISTS(
         SELECT 1 FROM rework_work_tasks task
         WHERE task.rework_order_id=$1 AND task.status='active'
           AND NOT (task.work_task_id=ANY($2::uuid[]))
           AND NOT EXISTS(
             SELECT 1 FROM rework_work_reports report
             WHERE report.work_task_id=task.work_task_id AND report.status='submitted'
               AND NOT EXISTS(
                 SELECT 1 FROM rework_work_report_rejections rejection
                 WHERE rejection.work_report_id=report.work_report_id
               )
           )
       )
       AND (
         (
           NOT $3::boolean
           AND (
             COALESCE((
               SELECT configuration.unified_execution_required
               FROM rework_process_configurations configuration
               WHERE configuration.rework_order_id=$1 AND configuration.status='approved'
               LIMIT 1
             ),false)
             OR (
               EXISTS(
                 SELECT 1 FROM rework_tail_inspection_assignments assignment
                 WHERE assignment.rework_order_id=$1 AND assignment.revoked_at IS NULL
               )
               AND NOT EXISTS(
                 SELECT 1 FROM rework_tail_inspection_assignments assignment
                 WHERE assignment.rework_order_id=$1 AND assignment.revoked_at IS NULL
                   AND NOT EXISTS(
                     SELECT 1 FROM rework_tail_inspection_reports report
                     WHERE report.tail_inspection_assignment_id=assignment.tail_inspection_assignment_id
                       AND report.status='submitted'
                   )
               )
             )
           )
         )
         OR (
           $3::boolean
           AND (
             NOT (SELECT target.tail_inspection_required FROM rework_orders target WHERE target.rework_order_id=$1)
             OR EXISTS(
               SELECT 1
               FROM rework_work_tasks tail_task
               JOIN rework_process_configuration_items tail_item
                 ON tail_item.configuration_item_id=tail_task.configuration_item_id
               WHERE tail_task.rework_order_id=$1
                 AND tail_task.status='active'
                 AND tail_item.execution_kind='tail_inspection'
                 AND EXISTS(
                   SELECT 1 FROM rework_work_reports report
                   WHERE report.work_task_id=tail_task.work_task_id
                     AND report.status='submitted'
                     AND NOT EXISTS(
                       SELECT 1 FROM rework_work_report_rejections rejection
                       WHERE rejection.work_report_id=report.work_report_id
                     )
                 )
             )
           )
         )
       ) AS ready`,
      [reworkOrderId, submittedWorkTaskIds, allowReportedTaskRecovery],
    );
    return result.rows[0]?.ready === true;
  }

  private async members(client: Pick<Pool, "query"> | PoolClient, taskId: string): Promise<PersonRow[]> {
    const result = await client.query<PersonRow>("SELECT member.person_id,member.person_type_snapshot AS person_type,member.display_name_snapshot AS display_name,person.app_user_id FROM rework_work_task_members member JOIN business_people person ON person.person_id=member.person_id WHERE member.work_task_id=$1 ORDER BY member.person_id", [taskId]);
    return result.rows;
  }

  private async taskDto(client: Pick<Pool, "query"> | PoolClient, id: string, actor: TrustedActorContext): Promise<WorkTaskResponse> {
    const task = await this.task(client as PoolClient, id, false);
    const members = await this.members(client, id);
    const ownWorker = task.execution_kind === "worker" && this.isOwnWorker(actor, members);
    const ownTailInspector = task.execution_kind === "tail_inspection" && this.isOwnTailInspector(actor, members);
    const proxyTask = this.canProxyReport(actor, members);
    const manager = this.isSupervisor(actor) || this.isWorkforceAdjuster(actor) || isRootActor(actor);
    if (!manager && !ownWorker && !ownTailInspector && !proxyTask) error("当前用户无权读取该任务", 403, "FORBIDDEN");
    const used = await client.query<{ quantity: string }>("SELECT COALESCE(sum(report.actual_quantity),0) AS quantity FROM rework_work_reports report WHERE report.work_task_id=$1 AND report.status='submitted' AND NOT EXISTS (SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)", [task.work_task_id]);
    const submittedQuantity = numberValue(used.rows[0]?.quantity ?? "0");
    const personalView = (ownWorker || ownTailInspector) && !manager && !proxyTask;
    const visibleMembers = personalView ? members.filter((person) => person.app_user_id === actor.actorId) : members;
    return {
      workTaskId: task.work_task_id, reworkOrderId: task.rework_order_id, configurationItemId: task.configuration_item_id,
      processName: task.execution_kind === "tail_inspection" && task.special_process_type !== "other_craft" ? "整查" : task.process_name, executionKind: task.execution_kind, pricingUnit: task.pricing_unit, plannedQuantity: numberValue(task.planned_quantity),
      unitPrice: task.unit_price === null ? null : numberValue(task.unit_price), mode: task.assignment_mode, version: task.task_version, status: task.status,
      canSubmitReport: this.canSubmitReport(actor, task, members) && submittedQuantity === 0,
      members: visibleMembers.map(({ person_id, display_name, person_type }) => ({ personId: person_id, displayName: display_name, personType: person_type })),
      submittedQuantity, remainingQuantity: submittedQuantity > 0 ? 0 : numberValue(task.planned_quantity),
    };
  }

  private async tasks(client: Pick<Pool, "query"> | PoolClient, orderId: string, actor: TrustedActorContext): Promise<WorkTaskResponse[]> {
    const manager = this.isSupervisor(actor) || this.isWorkforceAdjuster(actor) || isRootActor(actor);
    const filters: string[] = [];
    const values: string[] = [orderId];
    if (this.isWorker(actor)) {
      values.push(actor.actorId);
      filters.push(`item.execution_kind='worker' AND EXISTS (SELECT 1 FROM rework_work_task_members member JOIN business_people person ON person.person_id=member.person_id WHERE member.work_task_id=task.work_task_id AND person.app_user_id=$${values.length})`);
    }
    if (this.isTailInspector(actor)) {
      values.push(actor.actorId);
      filters.push(`item.execution_kind='tail_inspection' AND EXISTS (SELECT 1 FROM rework_work_task_members member JOIN business_people person ON person.person_id=member.person_id WHERE member.work_task_id=task.work_task_id AND person.app_user_id=$${values.length})`);
    }
    if (this.canProxyReport(actor)) {
      filters.push("EXISTS (SELECT 1 FROM rework_work_task_members member WHERE member.work_task_id=task.work_task_id AND member.person_type_snapshot='temporary')");
    }
    if (!manager && filters.length === 0) error("当前用户无权读取返工执行任务", 403, "FORBIDDEN");
    const access = manager ? "" : ` AND (${filters.map((value) => `(${value})`).join(" OR ")})`;
    const result = await client.query<{ work_task_id: string }>(
      `SELECT task.work_task_id
       FROM rework_work_tasks task
       JOIN rework_process_configuration_items item ON item.configuration_item_id=task.configuration_item_id
       WHERE task.rework_order_id=$1 AND task.status='active'${access}
       ORDER BY task.created_at,task.work_task_id`,
      values,
    );
    return Promise.all(result.rows.map((row) => this.taskDto(client, row.work_task_id, actor)));
  }

  private async mutate<T>(actor: TrustedActorContext, action: string, key: string, payload: unknown, statusCode: number, work: (client: PoolClient) => Promise<T>): Promise<Result<T>> { const client = await this.database.connect(); try { await client.query("BEGIN"); const outcome = await this.idempotency.execute(client, { scope: action, actorKey: actor.actorId, key, requestHash: hash(action, payload), expiresAt: new Date(Date.now()+24*60*60*1000) }, async () => ({ statusCode, response: await work(client) })); await client.query("COMMIT"); return { value: outcome.response, reused: outcome.reused }; } catch (cause) { await client.query("ROLLBACK"); throw cause; } finally { client.release(); } }
}
