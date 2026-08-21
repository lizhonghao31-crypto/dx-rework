import { createHash, randomUUID } from "node:crypto";

import type {
  ActivateProcessWorkerPlan,
  ProcessWorkerPlanActivationResponse,
  ProcessWorkerPlanResponse,
  SaveProcessWorkerPlan,
} from "@dx-rework/contracts/process-worker-plan";
import type { Pool, PoolClient } from "pg";

import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";

type Result<T> = Readonly<{ value: T; reused: boolean }>;
type OrderRow = Readonly<{
  rework_order_id: string;
  rework_no: string | null;
  status: string;
  version: number;
  style_no: string | null;
  order_no: string | null;
  merchandiser_user_id: string | null;
  processing_factory_type: "own_factory" | "supplier" | null;
  processing_factory_supplier_id: string | null;
  processing_factory_supplier_version: number | null;
  problem_part: string | null;
  problem_description: string | null;
  rework_quantity: number | null;
}>;
type ConfigurationRow = Readonly<{
  configuration_id: string;
  configuration_version: number;
  status: "draft" | "pending_ie_review" | "approved" | "rejected" | "superseded";
  worker_preassignment_required: boolean;
}>;
type ItemRow = Readonly<{ configuration_item_id: string; process_name: string }>;
type PersonRow = Readonly<{
  person_id: string;
  person_type: "internal" | "temporary";
  display_name: string;
  app_user_id: string | null;
}>;
type PlanRow = Readonly<{
  plan_id: string;
  planned_by: string;
}>;
type PlanMemberRow = Readonly<{
  configuration_item_id: string;
  person_id: string;
  display_name_snapshot: string;
  person_type_snapshot: "internal" | "temporary";
}>;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
};
const hash = (scope: string, payload: unknown): string =>
  createHash("sha256").update(JSON.stringify(canonicalize({ scope, payload }))).digest("hex");
const fail = (message: string, status = 409, code = "CONFLICT"): never => {
  throw new ApplicationError(code, message, status);
};

export class ProcessWorkerPlanService {
  constructor(
    private readonly database: Pool,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
  ) {}

  async get(_actor: TrustedActorContext, reworkOrderId: string): Promise<ProcessWorkerPlanResponse> {
    const order = await this.order(this.database, reworkOrderId, false);
    const configuration = await this.latestConfiguration(this.database, reworkOrderId, false);
    return this.dto(this.database, order, configuration);
  }

  async save(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: SaveProcessWorkerPlan,
    key: string,
  ): Promise<Result<ProcessWorkerPlanResponse>> {
    this.ensureAssign(actor);
    return this.mutate(actor, "rework.process_worker_plan.save", key, { reworkOrderId, ...input }, 201, async (client) => {
      const order = await this.order(client, reworkOrderId, true);
      if (order.status !== "pending_process_configuration") {
        fail("当前返工单不在分配工序与工人节点", 409, "INVALID_STATE_TRANSITION");
      }
      if (order.version !== input.expectedOrderVersion) fail("返工单已被其他操作更新，请刷新后重试");
      const configuration = await this.configuration(client, reworkOrderId, input.configurationId, true);
      if (
        configuration.status !== "draft"
        || configuration.configuration_version !== input.expectedConfigurationVersion
      ) fail("工序配置已更新，请先保存最新工序后再分配人员");
      if (!configuration.worker_preassignment_required) {
        fail("该历史工序配置沿用旧人员分配流程", 409, "INVALID_STATE_TRANSITION");
      }

      const items = await this.items(client, configuration.configuration_id);
      const itemIds = new Set(items.map((item) => item.configuration_item_id));
      if (
        input.assignments.length !== items.length
        || input.assignments.some((assignment) => !itemIds.has(assignment.configurationItemId))
      ) fail("每道返工工序都必须分配至少一名工人", 400, "VALIDATION_ERROR");

      const requestedPersonIds = [...new Set(input.assignments.flatMap((assignment) => assignment.memberIds))];
      const people = await this.people(client, requestedPersonIds);
      if (people.length !== requestedPersonIds.length) {
        fail("存在无效、停用或未获工人上数资格的人员", 400, "VALIDATION_ERROR");
      }
      const peopleById = new Map(people.map((person) => [person.person_id, person]));

      const existing = await this.plan(client, configuration.configuration_id, true);
      if (existing) {
        const existingMembers = await this.planMembers(client, existing.plan_id);
        const existingKeys = existingMembers.map((member) => `${member.configuration_item_id}:${member.person_id}`).sort();
        const requestedKeys = input.assignments.flatMap((assignment) =>
          assignment.memberIds.map((personId) => `${assignment.configurationItemId}:${personId}`)).sort();
        if (JSON.stringify(existingKeys) !== JSON.stringify(requestedKeys)) {
          fail("当前工序版本已经保存过人员方案；请先重新保存工序生成新版本后再修改人员");
        }
        return this.dto(client, order, configuration);
      }

      const planId = randomUUID();
      const afterAssignments = input.assignments.map((assignment) => ({
        configurationItemId: assignment.configurationItemId,
        memberIds: [...assignment.memberIds].sort(),
      }));
      const eventId = await this.events.append(client, actor, {
        action: "rework.process_worker_plan.save",
        entityType: "rework_order",
        entityId: reworkOrderId,
        after: {
          reworkOrderId,
          orderVersion: order.version,
          configurationId: configuration.configuration_id,
          configurationVersion: configuration.configuration_version,
          assignments: afterAssignments,
        },
      });
      await client.query(
        "SELECT set_config('dx_rework.process_worker_plan_event_id',$1,true),set_config('dx_rework.process_worker_plan_request_id',$2,true)",
        [eventId, actor.requestId],
      );
      await client.query(
        `INSERT INTO rework_process_worker_plans(
          plan_id,rework_order_id,configuration_id,configuration_version,planned_by,operation_event_id,request_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [planId, reworkOrderId, configuration.configuration_id, configuration.configuration_version, actor.actorId, eventId, actor.requestId],
      );
      for (const assignment of input.assignments) {
        for (const personId of assignment.memberIds) {
          const person = peopleById.get(personId)!;
          await client.query(
            `INSERT INTO rework_process_worker_plan_members(
              plan_member_id,plan_id,configuration_item_id,person_id,display_name_snapshot,person_type_snapshot
            ) VALUES($1,$2,$3,$4,$5,$6)`,
            [randomUUID(), planId, assignment.configurationItemId, person.person_id, person.display_name, person.person_type],
          );
        }
      }
      return this.dto(client, order, configuration);
    });
  }

  async assertReadyForSubmit(
    reworkOrderId: string,
    expectedConfigurationVersion: number,
  ): Promise<boolean> {
    const configuration = await this.latestConfiguration(this.database, reworkOrderId, false);
    if (!configuration || configuration.configuration_version !== expectedConfigurationVersion) {
      fail("工序配置已更新，请刷新后重新提交");
    }
    const requiredConfiguration = configuration!;
    if (!requiredConfiguration.worker_preassignment_required) return false;
    const order = await this.order(this.database, reworkOrderId, false);
    const response = await this.dto(this.database, order, requiredConfiguration);
    if (!response.complete) fail("请先为每道返工工序分配至少一名工人", 400, "VALIDATION_ERROR");
    return true;
  }

  async activateAfterIeApproval(
    reworkOrderId: string,
    expectedConfigurationVersion: number,
    requestId: string,
  ): Promise<ProcessWorkerPlanActivationResponse | null> {
    const configuration = await this.latestConfiguration(this.database, reworkOrderId, false);
    if (!configuration || configuration.configuration_version !== expectedConfigurationVersion) return null;
    if (!configuration.worker_preassignment_required) return null;
    const plan = await this.plan(this.database, configuration.configuration_id, false);
    if (!plan) fail("IE 已通过，但预分配人员方案不存在，请联系尾部主管", 409, "CONFLICT");
    const requiredPlan = plan!;
    const actor = await this.plannerActor(requiredPlan.planned_by, requestId);
    const order = await this.order(this.database, reworkOrderId, false);
    return (await this.activate(actor, reworkOrderId, {
      expectedOrderVersion: order.version,
      expectedConfigurationVersion,
    }, `auto-ie:${reworkOrderId}:${expectedConfigurationVersion}`)).value;
  }

  async activate(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: ActivateProcessWorkerPlan,
    key: string,
  ): Promise<Result<ProcessWorkerPlanActivationResponse>> {
    this.ensureAssign(actor);
    return this.mutate(actor, "rework.process_worker_plan.activate", key, { reworkOrderId, ...input }, 200, async (client) => {
      const order = await this.order(client, reworkOrderId, true);
      if (order.status === "in_progress") {
        return { reworkOrderId, reworkStatus: "in_progress", orderVersion: order.version, tasksCreated: 0 };
      }
      if (order.status !== "pending_task_assignment") {
        fail("当前返工单不在待启动返工状态", 409, "INVALID_STATE_TRANSITION");
      }
      if (order.version !== input.expectedOrderVersion) fail("返工单已被其他操作更新，请刷新后重试");
      const configuration = await this.latestConfiguration(client, reworkOrderId, true);
      if (
        !configuration
        || configuration.status !== "approved"
        || configuration.configuration_version !== input.expectedConfigurationVersion
        || !configuration.worker_preassignment_required
      ) fail("IE 核准的工序版本与预分配方案不一致");
      const requiredConfiguration = configuration!;
      const plan = await this.plan(client, requiredConfiguration.configuration_id, true);
      if (!plan) fail("预分配人员方案不存在");
      const requiredPlan = plan!;
      const items = await this.items(client, requiredConfiguration.configuration_id);
      const members = await this.planMembers(client, requiredPlan.plan_id);
      if (items.length === 0 || items.some((item) => !members.some((member) => member.configuration_item_id === item.configuration_item_id))) {
        fail("预分配人员方案不完整", 400, "VALIDATION_ERROR");
      }
      const activeTasks = await client.query(
        "SELECT 1 FROM rework_work_tasks WHERE rework_order_id=$1 AND status='active' LIMIT 1 FOR UPDATE",
        [reworkOrderId],
      );
      if (activeTasks.rows[0]) fail("当前订单已存在活动返工任务，请使用旧单兼容分配流程");

      const assignmentEventId = await this.events.append(client, actor, {
        action: "rework.work_task.assign",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before: this.orderAudit(order, order.status, order.version),
        after: {
          ...this.orderAudit(order, order.status, order.version),
          source: "process_worker_preassignment",
          configurationVersion: requiredConfiguration.configuration_version,
          assignments: members.map((member) => ({
            configurationItemId: member.configuration_item_id,
            personId: member.person_id,
          })),
        },
      });
      await this.workContext(client, assignmentEventId, actor.requestId);
      let tasksCreated = 0;
      for (const item of items) {
        const itemMembers = members.filter((member) => member.configuration_item_id === item.configuration_item_id);
        let taskVersion = Number((await client.query<{ version: string }>(
          "SELECT COALESCE(max(task_version),0)::text AS version FROM rework_work_tasks WHERE rework_order_id=$1 AND configuration_item_id=$2",
          [reworkOrderId, item.configuration_item_id],
        )).rows[0]?.version ?? "0");
        for (const member of itemMembers) {
          taskVersion += 1;
          const taskId = randomUUID();
          await client.query(
            `INSERT INTO rework_work_tasks(
              work_task_id,rework_order_id,configuration_item_id,task_version,assignment_mode,created_by
            ) VALUES($1,$2,$3,$4,'individual',$5)`,
            [taskId, reworkOrderId, item.configuration_item_id, taskVersion, actor.actorId],
          );
          await client.query(
            `INSERT INTO rework_work_task_members(
              work_task_id,person_id,display_name_snapshot,person_type_snapshot
            ) VALUES($1,$2,$3,$4)`,
            [taskId, member.person_id, member.display_name_snapshot, member.person_type_snapshot],
          );
          tasksCreated += 1;
        }
      }

      const nextVersion = order.version + 1;
      const confirmEventId = await this.events.append(client, actor, {
        action: "rework.work_task.assignment_confirm",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before: this.orderAudit(order, order.status, order.version),
        after: this.orderAudit(order, "in_progress", nextVersion),
        reason: "IE审核通过后自动激活预分配返工人员",
      });
      await this.reworkContext(client, confirmEventId, actor.requestId);
      await client.query(
        "UPDATE rework_orders SET status='in_progress',updated_by=$2,updated_at=CURRENT_TIMESTAMP,version=$3 WHERE rework_order_id=$1 AND version=$4",
        [reworkOrderId, actor.actorId, nextVersion, order.version],
      );
      return { reworkOrderId, reworkStatus: "in_progress", orderVersion: nextVersion, tasksCreated };
    });
  }

  private ensureAssign(actor: TrustedActorContext): void {
    if (isRootActor(actor)) return;
    if (!actor.actorRoles.includes("tail_supervisor") || !this.capabilities(actor).includes("work:assign")) {
      fail("当前角色无权分配返工人员", 403, "FORBIDDEN");
    }
  }

  private capabilities(actor: TrustedActorContext): readonly string[] {
    return actor.authorizationCapabilities ?? [actor.authorizationCapability];
  }

  private async plannerActor(actorId: string, requestId: string): Promise<TrustedActorContext> {
    const result = await this.database.query<{ roles: string[] }>(
      "SELECT access_authorized_actor_roles($1::uuid,'work:assign') AS roles",
      [actorId],
    );
    const roles = result.rows[0]?.roles;
    if (!roles?.length) fail("原分配人员已无返工分配权限，请由尾部主管重新处理", 403, "FORBIDDEN");
    const authorizedRoles = roles!;
    return {
      actorId,
      actorRoles: authorizedRoles,
      authorizationCapability: "work:assign",
      authorizationCapabilities: ["work:assign"],
      requestId,
    };
  }

  private async people(client: PoolClient, personIds: readonly string[]): Promise<PersonRow[]> {
    if (personIds.length === 0) return [];
    const result = await client.query<PersonRow>(
      `SELECT person.person_id,person.person_type,person.display_name,person.app_user_id
       FROM business_people person
       WHERE person.active=true AND person.person_id=ANY($1::uuid[]) AND (
         person.person_type='temporary' OR EXISTS (
           SELECT 1 FROM user_role_assignments assignment
           JOIN business_roles role ON role.role_code=assignment.role_code AND role.enabled=true
           JOIN app_users app_user ON app_user.id=assignment.user_id AND app_user.enabled=true
           JOIN identity_mappings identity ON identity.user_id=app_user.id
             AND identity.provider='dingtalk' AND identity.active=true AND identity.employed=true
           JOIN access_security_policy policy ON policy.policy_key='primary' AND policy.dingtalk_corp_id=identity.corp_id
           WHERE assignment.user_id=person.app_user_id
             AND assignment.role_code='worker' AND assignment.revoked_at IS NULL
         )
       )
       ORDER BY person.person_id FOR SHARE`,
      [personIds],
    );
    return result.rows;
  }

  private async order(client: Pick<Pool, "query"> | PoolClient, id: string, locked: boolean): Promise<OrderRow> {
    const result = await client.query<OrderRow>(
      `SELECT rework_order_id,rework_no,status,version,style_no,order_no,merchandiser_user_id,
              processing_factory_type,processing_factory_supplier_id,processing_factory_supplier_version,
              problem_part,problem_description,rework_quantity
       FROM rework_orders WHERE rework_order_id=$1 AND status<>'deleted'${locked ? " FOR UPDATE" : ""}`,
      [id],
    );
    return result.rows[0] ?? fail("返工单不存在", 404, "NOT_FOUND");
  }

  private async configuration(
    client: Pick<Pool, "query"> | PoolClient,
    orderId: string,
    configurationId: string,
    locked: boolean,
  ): Promise<ConfigurationRow> {
    const result = await client.query<ConfigurationRow>(
      `SELECT configuration_id,configuration_version,status,worker_preassignment_required
       FROM rework_process_configurations
       WHERE rework_order_id=$1 AND configuration_id=$2${locked ? " FOR UPDATE" : ""}`,
      [orderId, configurationId],
    );
    return result.rows[0] ?? fail("工序配置不存在", 404, "NOT_FOUND");
  }

  private async latestConfiguration(
    client: Pick<Pool, "query"> | PoolClient,
    orderId: string,
    locked: boolean,
  ): Promise<ConfigurationRow | null> {
    const result = await client.query<ConfigurationRow>(
      `SELECT configuration_id,configuration_version,status,worker_preassignment_required
       FROM rework_process_configurations
       WHERE rework_order_id=$1 AND status<>'superseded'
       ORDER BY configuration_version DESC LIMIT 1${locked ? " FOR UPDATE" : ""}`,
      [orderId],
    );
    return result.rows[0] ?? null;
  }

  private async items(client: Pick<Pool, "query"> | PoolClient, configurationId: string): Promise<ItemRow[]> {
    return (await client.query<ItemRow>(
      `SELECT configuration_item_id,process_name
       FROM rework_process_configuration_items
       WHERE configuration_id=$1 ORDER BY position,configuration_item_id`,
      [configurationId],
    )).rows;
  }

  private async plan(client: Pick<Pool, "query"> | PoolClient, configurationId: string, locked: boolean): Promise<PlanRow | null> {
    const result = await client.query<PlanRow>(
      `SELECT plan_id,planned_by FROM rework_process_worker_plans
       WHERE configuration_id=$1${locked ? " FOR UPDATE" : ""}`,
      [configurationId],
    );
    return result.rows[0] ?? null;
  }

  private async planMembers(client: Pick<Pool, "query"> | PoolClient, planId: string): Promise<PlanMemberRow[]> {
    return (await client.query<PlanMemberRow>(
      `SELECT configuration_item_id,person_id,display_name_snapshot,person_type_snapshot
       FROM rework_process_worker_plan_members
       WHERE plan_id=$1 ORDER BY configuration_item_id,display_name_snapshot,person_id`,
      [planId],
    )).rows;
  }

  private async dto(
    client: Pick<Pool, "query"> | PoolClient,
    order: OrderRow,
    configuration: ConfigurationRow | null,
  ): Promise<ProcessWorkerPlanResponse> {
    const items = configuration ? await this.items(client, configuration.configuration_id) : [];
    const plan = configuration ? await this.plan(client, configuration.configuration_id, false) : null;
    const members = plan ? await this.planMembers(client, plan.plan_id) : [];
    const assignments = items.map((item) => ({
      configurationItemId: item.configuration_item_id,
      processName: item.process_name,
      members: members.filter((member) => member.configuration_item_id === item.configuration_item_id).map((member) => ({
        personId: member.person_id,
        displayName: member.display_name_snapshot,
        personType: member.person_type_snapshot,
      })),
    }));
    return {
      reworkOrderId: order.rework_order_id,
      reworkStatus: order.status as ProcessWorkerPlanResponse["reworkStatus"],
      orderVersion: order.version,
      required: configuration?.worker_preassignment_required ?? order.status === "pending_process_configuration",
      configurationId: configuration?.configuration_id ?? null,
      configurationVersion: configuration?.configuration_version ?? null,
      configurationStatus: configuration?.status ?? null,
      assignments,
      complete: assignments.length > 0 && assignments.every((assignment) => assignment.members.length > 0),
    };
  }

  private orderAudit(order: OrderRow, status: string, version: number): Record<string, unknown> {
    return {
      reworkOrderId: order.rework_order_id, reworkNo: order.rework_no, status, styleNo: order.style_no, orderNo: order.order_no,
      merchandiserUserId: order.merchandiser_user_id,
      processingFactory: order.processing_factory_type === null ? null : order.processing_factory_type === "own_factory"
        ? { type: "own_factory" }
        : { type: "supplier", supplierId: order.processing_factory_supplier_id, supplierVersion: order.processing_factory_supplier_version },
      problemPart: order.problem_part, problemDescription: order.problem_description, reworkQuantity: order.rework_quantity, version,
    };
  }

  private async workContext(client: PoolClient, eventId: string, requestId: string): Promise<void> {
    await client.query(
      "SELECT set_config('dx_rework.work_event_id',$1,true),set_config('dx_rework.work_request_id',$2,true)",
      [eventId, requestId],
    );
  }

  private async reworkContext(client: PoolClient, eventId: string, requestId: string): Promise<void> {
    await client.query(
      "SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true)",
      [eventId, requestId],
    );
  }

  private async mutate<T>(
    actor: TrustedActorContext,
    scope: string,
    key: string,
    payload: unknown,
    statusCode: number,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<Result<T>> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute<T>(client, {
        scope,
        actorKey: actor.actorId,
        key,
        requestHash: hash(scope, payload),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => ({ statusCode, response: await work(client) }));
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
