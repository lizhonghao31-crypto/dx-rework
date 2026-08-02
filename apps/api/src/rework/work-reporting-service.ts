import { createHash, randomUUID } from "node:crypto";

import type {
  CreateWorkReport,
  CreateWorkTask,
  ReworkWorkTasksResponse,
  WorkReportResponse,
  WorkTaskResponse,
} from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";

type WorkTaskRow = Readonly<{
  work_task_id: string; rework_order_id: string; configuration_item_id: string;
  task_version: number; assignment_mode: "individual" | "collective"; status: "active" | "superseded";
  process_name: string; pricing_unit: "piece" | "hour"; planned_quantity: string; unit_price: string;
}>;
type PersonRow = Readonly<{ person_id: string; person_type: "internal" | "temporary"; display_name: string; app_user_id: string | null }>;
type OrderRow = Readonly<{
  rework_order_id: string; rework_no: string | null; status: string; version: number;
  style_no: string | null; order_no: string | null; merchandiser_user_id: string | null;
  processing_factory_type: "own_factory" | "supplier" | null; processing_factory_supplier_id: string | null;
  processing_factory_supplier_version: number | null; problem_part: string | null;
  problem_description: string | null; rework_quantity: number | null;
}>;
type Result<T> = Readonly<{ value: T; reused: boolean }>;

const hash = (scope: string, payload: unknown): string =>
  createHash("sha256").update(JSON.stringify({ scope, payload })).digest("hex");
const numberValue = (value: string | number): number => Number(value);
type Decimal = Readonly<{ units: bigint; scale: number }>;
const MONEY_SCALE = 6;

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

const compareDecimal = (left: Decimal | string | number, right: Decimal | string | number): number => {
  const leftDecimal = typeof left === "object" ? left : decimal(left);
  const rightDecimal = typeof right === "object" ? right : decimal(right);
  const scale = Math.max(leftDecimal.scale, rightDecimal.scale);
  const difference = atScale(leftDecimal, scale) - atScale(rightDecimal, scale);
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
};

const addDecimal = (left: string | number, right: string | number): Decimal => {
  const leftDecimal = decimal(left);
  const rightDecimal = decimal(right);
  const scale = Math.max(leftDecimal.scale, rightDecimal.scale);
  return { units: atScale(leftDecimal, scale) + atScale(rightDecimal, scale), scale };
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
  ) {}

  async list(actor: TrustedActorContext, reworkOrderId: string): Promise<ReworkWorkTasksResponse> {
    const order = await this.order(this.database, reworkOrderId, false);
    const tasks = await this.tasks(this.database, reworkOrderId, actor);
    return { reworkOrderId, reworkStatus: order.status as ReworkWorkTasksResponse["reworkStatus"], orderVersion: order.version, tasks };
  }

  async listAssignablePeople(actor: TrustedActorContext): Promise<Array<{ personId: string; displayName: string; personType: "internal" | "temporary" }>> {
    this.ensure(actor, "work:assign");
    const result = await this.database.query<Pick<PersonRow, "person_id" | "display_name" | "person_type">>(
      `SELECT person_id,display_name,person_type
       FROM business_people person
       WHERE person.active=true AND (
         person.person_type='temporary' OR EXISTS (
           SELECT 1 FROM user_role_assignments assignment
           JOIN business_roles role ON role.role_code=assignment.role_code AND role.enabled=true
           WHERE assignment.user_id=person.app_user_id
             AND assignment.role_code='worker' AND assignment.revoked_at IS NULL
         )
       )
       ORDER BY person.display_name,person.person_id`,
    );
    return result.rows.map((person) => ({ personId: person.person_id, displayName: person.display_name, personType: person.person_type }));
  }

  async createTask(actor: TrustedActorContext, reworkOrderId: string, input: CreateWorkTask, key: string): Promise<Result<WorkTaskResponse>> {
    this.ensure(actor, "work:assign");
    return this.mutate(actor, "rework.work_task.assign", key, { reworkOrderId, ...input }, 201, async (client) => {
      const order = await this.order(client, reworkOrderId, true);
      if (order.status !== "pending_task_assignment" && order.status !== "in_progress") error("当前返工单不在分配任务节点", 409, "INVALID_STATE_TRANSITION");
      if (order.version !== input.expectedOrderVersion) error("返工单已被其他操作更新，请刷新后重试");
      const configuration = await client.query<{ configuration_item_id: string; process_name: string; pricing_unit: "piece" | "hour"; planned_quantity: string; unit_price: string }>(
        `SELECT item.configuration_item_id,item.process_name,item.pricing_unit,item.planned_quantity,item.unit_price
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
      const transitionToInProgress = order.status === "pending_task_assignment";
      const eventId = await this.events.append(client, actor, {
        action: "rework.work_task.assign", entityType: "rework_order", entityId: reworkOrderId,
        before: { orderVersion: order.version, activeTaskId: active.rows[0]?.work_task_id ?? null },
        after: { ...this.orderAuditState(order, transitionToInProgress ? "in_progress" : order.status, transitionToInProgress ? order.version + 1 : order.version), workTaskId: taskId, configurationItemId: item.configuration_item_id, mode: input.mode, memberIds: people.rows.map((person) => person.person_id) },
      });
      await this.context(client, eventId, actor.requestId);
      if (active.rows[0]) await client.query("UPDATE rework_work_tasks SET status='superseded',superseded_at=CURRENT_TIMESTAMP WHERE work_task_id=$1", [active.rows[0].work_task_id]);
      await client.query("INSERT INTO rework_work_tasks(work_task_id,rework_order_id,configuration_item_id,task_version,assignment_mode,created_by) VALUES($1,$2,$3,$4,$5,$6)", [taskId, reworkOrderId, item.configuration_item_id, version, input.mode, actor.actorId]);
      for (const person of people.rows) await client.query(
        "INSERT INTO rework_work_task_members(work_task_id,person_id,display_name_snapshot,person_type_snapshot) VALUES($1,$2,$3,$4)",
        [taskId, person.person_id, person.display_name, person.person_type],
      );
      if (transitionToInProgress) await client.query(
        "UPDATE rework_orders SET status='in_progress',updated_by=$2,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE rework_order_id=$1",
        [reworkOrderId, actor.actorId],
      );
      return this.taskDto(client, taskId, actor);
    });
  }

  async submitReport(actor: TrustedActorContext, workTaskId: string, input: CreateWorkReport, key: string): Promise<Result<WorkReportResponse>> {
    return this.mutate(actor, "rework.work_report.submit", key, { workTaskId, ...input }, 201, async (client) => {
      const task = await this.task(client, workTaskId, true);
      const order = await this.order(client, task.rework_order_id, true);
      if (order.status !== "pending_task_assignment" && order.status !== "in_progress") error("当前返工单不允许上数", 409, "INVALID_STATE_TRANSITION");
      if (order.version !== input.expectedOrderVersion) error("返工单已被其他操作更新，请刷新后重试");
      if (task.status !== "active") error("该任务版本已被替换，请使用最新任务");
      const members = await this.members(client, task.work_task_id);
      const ownPerson = members.find((person) => person.app_user_id === actor.actorId);
      const hasTemporary = members.some((person) => person.person_type === "temporary");
      const workerCapability = actor.authorizationCapability === "work:report" || actor.authorizationCapability === "work:report_for_worker";
      const ownWorker = actor.actorRoles.includes("worker") && workerCapability && ownPerson;
      const proxy = actor.actorRoles.includes("tail_supervisor") && actor.authorizationCapability === "work:report_for_worker" && hasTemporary;
      if (!ownWorker && !proxy) error("当前用户无权为该任务上数", 403, "FORBIDDEN");
      if (task.pricing_unit === "piece" && !Number.isInteger(input.actualQuantity)) error("按件计价的上数必须为整数", 400, "VALIDATION_ERROR");
      if (task.pricing_unit === "hour" && !hasAtMostDecimalPlaces(input.actualQuantity, 2)) error("按小时计价的上数最多保留两位小数", 400, "VALIDATION_ERROR");
      const completedAt = new Date(input.completedAt);
      const now = Date.now();
      if (completedAt.getTime() > now || completedAt.getTime() < now - 7 * 24 * 60 * 60 * 1000) error("完工时间只能补录最近七天且不能晚于现在", 400, "VALIDATION_ERROR");
      const used = await client.query<{ quantity: string }>(
        "SELECT COALESCE(sum(actual_quantity),0) AS quantity FROM rework_work_reports WHERE rework_order_id=$1 AND configuration_item_id=$2 AND status='submitted'",
        [task.rework_order_id, task.configuration_item_id],
      );
      const nextQuantity = addDecimal(used.rows[0]?.quantity ?? "0", input.actualQuantity);
      if (compareDecimal(nextQuantity, task.planned_quantity) > 0) error("上数后将超过工序计划数量", 409, "CONFLICT");
      const groupAmount = calculateWorkAmount(input.actualQuantity, task.unit_price);
      const completion = await client.query<{ complete: boolean }>(
        `SELECT NOT EXISTS (
           SELECT 1
           FROM rework_process_configurations configuration
           JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
           LEFT JOIN (
             SELECT configuration_item_id,sum(actual_quantity) AS quantity
             FROM rework_work_reports
             WHERE rework_order_id=$1 AND status='submitted'
             GROUP BY configuration_item_id
           ) report ON report.configuration_item_id=item.configuration_item_id
           WHERE configuration.rework_order_id=$1 AND configuration.status='approved'
             AND CASE WHEN item.configuration_item_id=$2
               THEN COALESCE(report.quantity,0)+$3::numeric < item.planned_quantity
               ELSE COALESCE(report.quantity,0) < item.planned_quantity END
         ) AS complete`,
        [task.rework_order_id, task.configuration_item_id, input.actualQuantity],
      );
      const completedOrder = completion.rows[0]?.complete === true;
      const reportId = randomUUID();
      const shares = splitAmount(groupAmount, members.length);
      const event = {
        action: "rework.work_report.submit", entityType: "rework_order", entityId: task.rework_order_id,
        before: { submittedQuantity: numberValue(used.rows[0]?.quantity ?? "0"), plannedQuantity: numberValue(task.planned_quantity) },
        after: { ...this.orderAuditState(order, completedOrder ? "pending_order_review" : order.status, completedOrder ? order.version + 1 : order.version), workReportId: reportId, workTaskId, actualQuantity: input.actualQuantity, groupAmount, memberIds: members.map((member) => member.person_id) },
        ...(input.remark ? { reason: input.remark } : {}),
      };
      const eventId = await this.events.append(client, actor, event);
      await this.context(client, eventId, actor.requestId);
      await client.query(
        "INSERT INTO rework_work_reports(work_report_id,work_task_id,rework_order_id,configuration_item_id,actual_quantity,completed_at,remark,group_amount,submitted_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [reportId, workTaskId, task.rework_order_id, task.configuration_item_id, input.actualQuantity, completedAt, input.remark ?? null, groupAmount, actor.actorId],
      );
      for (const [index, member] of members.entries()) await client.query("INSERT INTO rework_work_report_member_shares(work_report_id,person_id,amount) VALUES($1,$2,$3)", [reportId, member.person_id, shares[index]]);
      if (completedOrder) await client.query(
        "UPDATE rework_orders SET status='pending_order_review',updated_by=$2,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE rework_order_id=$1",
        [task.rework_order_id, actor.actorId],
      );
      const workerView = actor.actorRoles.includes("worker") && !actor.actorRoles.includes("tail_supervisor");
      const visibleShares = members.map((member, index) => ({ personId: member.person_id, amount: shares[index]! })).filter((share) => !workerView || share.personId === ownPerson?.person_id);
      return { workReportId: reportId, workTaskId, reworkOrderId: task.rework_order_id, actualQuantity: input.actualQuantity, completedAt: completedAt.toISOString(), status: "submitted", groupAmount: workerView ? null : groupAmount, memberShares: visibleShares };
    });
  }

  private ensure(actor: TrustedActorContext, capability: string): void { if (!actor.actorRoles.includes("tail_supervisor") || actor.authorizationCapability !== capability) error("当前角色无权分配任务", 403, "FORBIDDEN"); }
  private async context(client: PoolClient, eventId: string, requestId: string): Promise<void> { await client.query("SELECT set_config('dx_rework.work_event_id',$1,true),set_config('dx_rework.work_request_id',$2,true),set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true)", [eventId, requestId]); }
  private orderAuditState(order: OrderRow, status: string, version: number): Record<string, unknown> { return { reworkOrderId: order.rework_order_id, reworkNo: order.rework_no, status, styleNo: order.style_no, orderNo: order.order_no, merchandiserUserId: order.merchandiser_user_id, processingFactory: order.processing_factory_type === null ? null : order.processing_factory_type === "own_factory" ? { type: "own_factory" } : { type: "supplier", supplierId: order.processing_factory_supplier_id, supplierVersion: order.processing_factory_supplier_version }, problemPart: order.problem_part, problemDescription: order.problem_description, reworkQuantity: order.rework_quantity, version }; }
  private async order(client: Pick<Pool, "query"> | PoolClient, id: string, locked: boolean): Promise<OrderRow> { const result = await client.query<OrderRow>(`SELECT rework_order_id,rework_no,status,version,style_no,order_no,merchandiser_user_id,processing_factory_type,processing_factory_supplier_id,processing_factory_supplier_version,problem_part,problem_description,rework_quantity FROM rework_orders WHERE rework_order_id=$1${locked ? " FOR UPDATE" : ""}`, [id]); return result.rows[0] ?? error("返工单不存在", 404, "NOT_FOUND"); }
  private async task(client: PoolClient, id: string, locked: boolean): Promise<WorkTaskRow> { const result = await client.query<WorkTaskRow>(`SELECT task.work_task_id,task.rework_order_id,task.configuration_item_id,task.task_version,task.assignment_mode,task.status,item.process_name,item.pricing_unit,item.planned_quantity,item.unit_price FROM rework_work_tasks task JOIN rework_process_configuration_items item ON item.configuration_item_id=task.configuration_item_id WHERE task.work_task_id=$1${locked ? " FOR UPDATE OF task" : ""}`, [id]); return result.rows[0] ?? error("返工任务不存在", 404, "NOT_FOUND"); }
  private async members(client: Pick<Pool, "query"> | PoolClient, taskId: string): Promise<PersonRow[]> { const result = await client.query<PersonRow>("SELECT member.person_id,member.person_type_snapshot AS person_type,member.display_name_snapshot AS display_name,person.app_user_id FROM rework_work_task_members member JOIN business_people person ON person.person_id=member.person_id WHERE member.work_task_id=$1 ORDER BY member.person_id", [taskId]); return result.rows; }
  private async taskDto(client: Pick<Pool, "query"> | PoolClient, id: string, actor: TrustedActorContext): Promise<WorkTaskResponse> { const task = await this.task(client as PoolClient, id, false); const members = await this.members(client, id); const used = await client.query<{ quantity: string }>("SELECT COALESCE(sum(actual_quantity),0) AS quantity FROM rework_work_reports WHERE rework_order_id=$1 AND configuration_item_id=$2 AND status='submitted'", [task.rework_order_id, task.configuration_item_id]); const submittedQuantity = numberValue(used.rows[0]?.quantity ?? "0"); const workerView = actor.actorRoles.includes("worker") && !actor.actorRoles.includes("tail_supervisor"); const visibleMembers = workerView ? members.filter((person) => person.app_user_id === actor.actorId) : members; if (workerView && visibleMembers.length !== 1) error("当前用户无权读取该任务", 403, "FORBIDDEN"); return { workTaskId: task.work_task_id,reworkOrderId: task.rework_order_id,configurationItemId: task.configuration_item_id,processName: task.process_name,pricingUnit: task.pricing_unit,plannedQuantity:numberValue(task.planned_quantity),unitPrice:numberValue(task.unit_price),mode:task.assignment_mode,version:task.task_version,status:task.status,members:visibleMembers.map(({ person_id, display_name, person_type })=>({personId:person_id,displayName:display_name,personType:person_type})),submittedQuantity,remainingQuantity:Math.max(0,numberValue(task.planned_quantity)-submittedQuantity) }; }
  private async tasks(client: Pick<Pool, "query"> | PoolClient, orderId: string, actor: TrustedActorContext): Promise<WorkTaskResponse[]> { const workerView = actor.actorRoles.includes("worker") && !actor.actorRoles.includes("tail_supervisor"); const result = await client.query<{ work_task_id: string }>(workerView ? "SELECT task.work_task_id FROM rework_work_tasks task JOIN rework_work_task_members member ON member.work_task_id=task.work_task_id JOIN business_people person ON person.person_id=member.person_id WHERE task.rework_order_id=$1 AND task.status='active' AND person.app_user_id=$2 ORDER BY task.created_at,task.work_task_id" : "SELECT work_task_id FROM rework_work_tasks WHERE rework_order_id=$1 AND status='active' ORDER BY created_at,work_task_id", workerView ? [orderId, actor.actorId] : [orderId]); return Promise.all(result.rows.map((row) => this.taskDto(client, row.work_task_id, actor))); }
  private async mutate<T>(actor: TrustedActorContext, action: string, key: string, payload: unknown, statusCode: number, work: (client: PoolClient) => Promise<T>): Promise<Result<T>> { const client = await this.database.connect(); try { await client.query("BEGIN"); const outcome = await this.idempotency.execute(client, { scope: action, actorKey: actor.actorId, key, requestHash: hash(action, payload), expiresAt: new Date(Date.now()+24*60*60*1000) }, async () => ({ statusCode, response: await work(client) })); await client.query("COMMIT"); return { value: outcome.response, reused: outcome.reused }; } catch (cause) { await client.query("ROLLBACK"); throw cause; } finally { client.release(); } }
}
