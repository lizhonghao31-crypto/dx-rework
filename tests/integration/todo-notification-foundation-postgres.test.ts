import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { TodoDeliveryWorker } from "../../apps/api/src/todos/delivery-worker.js";
import type { DingTalkTodoProvider } from "../../apps/api/src/todos/provider.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
import { OperationEventRepository, type TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;
const migrations = [
  "0001_platform_foundation.sql",
  "0002_dingtalk_identity_access.sql",
  "0003_identity_union_continuity.sql",
  "0004_public_tools_foundation.sql",
  "0005_access_master_data.sql",
  "0006_rework_initiation.sql",
  "0007_process_configuration_ie_review.sql",
  "0008_worker_assignment_reporting.sql",
  "0009_whole_order_review_quantity_adjustment.sql",
  "0010_responsibility_determination_amount_engine.sql",
  "0011_responsibility_authorization_handler_closure.sql",
  "0012_responsibility_direct_delegation.sql",
  "0013_responsibility_review_closure.sql",
  "0014_responsibility_source_share_coverage.sql",
  "0015_own_factory_responsibility_approval.sql",
  "0016_responsibility_amount_contract_restore.sql",
  "0017_external_responsibility_deduction.sql",
  "0018_external_responsibility_review_closure.sql",
  "0019_external_revision_seed_ordering.sql",
  "0020_external_responsibility_codex_closure.sql",
  "0021_external_processing_factory_override_closure.sql",
  "0022_wage_reconciliation_month_close.sql",
  "0023_wage_materialization_closure.sql",
  "0024_wage_adjustment_attachment_closure.sql",
  "0025_wage_completion_month_backfill_access.sql",
  "0026_todo_notification_foundation.sql",
  "0027_todo_routing_lifecycle_closure.sql",
  "0028_dingtalk_todo_external_bindings.sql",
] as const;

runWithPostgres("PR-13 todo notification foundation migration", () => {
  const schema = `todo_foundation_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });
  const adminId = randomUUID();
  let access: AccessMasterDataService;
  const adminActor = (): TrustedActorContext => ({
    actorId: adminId,
    actorRoles: ["system_admin"],
    authorizationCapability: "access:admin",
    authorizationCapabilities: ["access:admin"],
    requestId: `todo-admin-${randomUUID()}`,
  });

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const migration of migrations) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration}`, import.meta.url),
        "utf8",
      ));
    }
    await database.query(
      "INSERT INTO app_users(id,display_name,enabled) VALUES($1,'Todo test administrator',true)",
      [adminId],
    );
    await database.query(
      `INSERT INTO identity_mappings(
         id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at
       ) VALUES($1,$2,'dingtalk','todo-corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
      [randomUUID(), adminId, `todo-admin-user-${adminId}`, `todo-admin-union-${adminId}`],
    );
    await database.query(
      `INSERT INTO user_role_assignments(
         assignment_id,user_id,role_code,granted_by,grant_reason
       ) VALUES($1,$2,'system_admin',$2,'initial controlled administrator')`,
      [randomUUID(), adminId],
    );
    access = new AccessMasterDataService(database, "todo-corp");
    await access.ensureOrganizationPolicy();
  });

  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("separates immutable todo facts, delivery attempts, policies and routing exceptions", async () => {
    const [tables, policies, routingCapability, adminRoutingCapability] = await Promise.all([
      database.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema=current_schema() AND table_name=ANY($1::text[])
         ORDER BY table_name`,
        [[
          "rework_todos",
          "todo_delivery_attempts",
          "todo_recipient_routing_exceptions",
          "todo_recipient_transfers",
          "todo_policies",
          "todo_backfill_runs",
          "todo_backfill_exceptions",
        ]],
      ),
      database.query<{ policy_key: string; max_reminders: number }>(
        "SELECT policy_key,max_reminders FROM todo_policies ORDER BY policy_key",
      ),
      database.query<{ count: number }>(
        "SELECT count(*)::int count FROM role_capabilities WHERE role_code='production_management' AND capability='todo:routing_exception_manage'",
      ),
      database.query<{ count: number }>(
        "SELECT count(*)::int count FROM role_capabilities WHERE role_code='system_admin' AND capability='todo:routing_exception_manage'",
      ),
    ]);

    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "rework_todos",
      "todo_backfill_exceptions",
      "todo_backfill_runs",
      "todo_delivery_attempts",
      "todo_policies",
      "todo_recipient_routing_exceptions",
      "todo_recipient_transfers",
    ]);
    expect(policies.rows).toEqual([
      { policy_key: "deduction_follow_up", max_reminders: 0 },
      { policy_key: "finance_return_or_wage_review", max_reminders: 1 },
      { policy_key: "general", max_reminders: 2 },
    ]);
    expect(routingCapability.rows[0]).toEqual({ count: 1 });
    expect(adminRoutingCapability.rows[0]).toEqual({ count: 0 });

    const actorId = randomUUID();
    const sourceEventId = randomUUID();
    const todoEventId = randomUUID();
    const todoId = randomUUID();
    const outboxEventId = randomUUID();
    const requestId = `todo-fixture-${randomUUID()}`;
    await database.query(
      "INSERT INTO app_users(id,display_name,enabled) VALUES($1,'Todo fixture',true)",
      [actorId],
    );
    for (const [eventId, action] of [
      [sourceEventId, "rework.submit"],
      [todoEventId, "todo.create"],
    ] as const) {
      await database.query(
        `INSERT INTO operation_events(
           event_id,request_id,actor_id,actor_roles,authorization_capability,
           action,entity_type,entity_id
         ) VALUES($1,$2,$3,ARRAY['tail_supervisor'],'todo:view',$4,'rework_order',$5)`,
        [eventId, eventId === todoEventId ? requestId : `source-${eventId}`, actorId, action, randomUUID()],
      );
    }

    await expect(database.query(
      `INSERT INTO rework_todos(
         todo_id,todo_type,category,source_event_id,source_action,entity_type,entity_id,
         recipient_user_id,required_role,required_capability,route_descriptor,policy_key,due_at,
         dedupe_key,created_operation_event_id,created_request_id
       ) VALUES($1,'business_action','process_configuration',$2,'rework.submit','rework_order',$3,
         $4,'tail_supervisor','process:configure',$5,'general',CURRENT_TIMESTAMP,$6,$7,$8)`,
      [randomUUID(), sourceEventId, randomUUID(), actorId, JSON.stringify({
        routeName: "process_configuration", entityId: randomUUID(), todoId: randomUUID(),
      }), randomUUID(), todoEventId, requestId],
    )).rejects.toMatchObject({ code: "55000" });

    const entityId = randomUUID();
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('dx_rework.todo_event_id',$1,true),set_config('dx_rework.todo_request_id',$2,true)",
        [todoEventId, requestId],
      );
      await client.query(
        `INSERT INTO rework_todos(
           todo_id,todo_type,category,source_event_id,source_action,entity_type,entity_id,
           recipient_user_id,required_role,required_capability,route_descriptor,policy_key,due_at,
           dedupe_key,created_operation_event_id,created_request_id
         ) VALUES($1,'business_action','process_configuration',$2,'rework.submit','rework_order',$3,
           $4,'tail_supervisor','process:configure',$5,'general',CURRENT_TIMESTAMP,$6,$7,$8)`,
        [todoId, sourceEventId, entityId, actorId, JSON.stringify({
          routeName: "process_configuration", entityId, todoId,
        }), `todo:${todoId}`, todoEventId, requestId],
      );
      await client.query(
        `INSERT INTO message_outbox(event_id,topic,aggregate_type,aggregate_id,payload,recipient_key,idempotency_key)
         VALUES($1,'todo.create','rework_todo',$2,'{}'::jsonb,$3,$4)`,
        [outboxEventId, todoId, actorId, `outbox:${todoId}`],
      );
      await client.query(
        `INSERT INTO todo_delivery_attempts(
           delivery_attempt_id,todo_id,message_outbox_event_id,attempt_no,delivery_kind,
           provider,outcome,operation_event_id,operation_request_id
         ) VALUES($1,$2,$3,0,'create','dingtalk','queued',$4,$5)`,
        [randomUUID(), todoId, outboxEventId, todoEventId, requestId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await expect(database.query(
      "UPDATE rework_todos SET source_action='rework.cancel' WHERE todo_id=$1",
      [todoId],
    )).rejects.toMatchObject({ code: "55000" });

    await expect(database.query(
      "UPDATE todo_delivery_attempts SET outcome='sent' WHERE todo_id=$1",
      [todoId],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("deduplicates queued delivery, records provider results, and never revives a completed todo", async () => {
    const actorId = randomUUID();
    const entityId = randomUUID();
    const sourceEventId = randomUUID();
    const actor: TrustedActorContext = {
      actorId,
      actorRoles: ["tail_supervisor"],
      authorizationCapability: "process:configure",
      authorizationCapabilities: ["process:configure"],
      requestId: `todo-service-${randomUUID()}`,
    };
    await database.query(
      "INSERT INTO app_users(id,display_name,enabled) VALUES($1,'Todo service fixture',true)",
      [actorId],
    );
    await database.query(
      `INSERT INTO identity_mappings(
         id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at
       ) VALUES($1,$2,'dingtalk','todo-corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
      [randomUUID(), actorId, `todo-user-${actorId}`, `todo-union-${actorId}`],
    );
    await database.query(
      "INSERT INTO access_security_policy(policy_key,dingtalk_corp_id) VALUES('primary','todo-corp') ON CONFLICT DO NOTHING",
    );
    await database.query(
      `INSERT INTO operation_events(
         event_id,request_id,actor_id,actor_roles,authorization_capability,
         action,entity_type,entity_id
       ) VALUES($1,$2,$3,ARRAY['tail_supervisor'],'process:configure',
         'rework.submit','rework_order',$4)`,
      [sourceEventId, `source-${sourceEventId}`, actorId, entityId],
    );
    const service = new TodoService(database);
    const create = async (dedupeKey: string, sourceId: string) => {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        const result = await service.createInTransaction(client, actor, {
          todoType: "information",
          category: "configuration_notice",
          sourceEventId: sourceId,
          sourceAction: "rework.submit",
          entityType: "rework_order",
          entityId,
          recipientUserId: actorId,
          route: { routeName: "rework_detail", entityId },
          dedupeKey,
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };

    const first = await create(`todo:${entityId}:first`, sourceEventId);
    const duplicate = await create(`todo:${entityId}:first`, sourceEventId);
    expect(duplicate.todoId).toBe(first.todoId);
    await expect(database.query(
      "SELECT count(*)::int count FROM message_outbox WHERE aggregate_id=$1 AND topic='todo.delivery'",
      [first.todoId],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });

    const provider: DingTalkTodoProvider = {
      createTodo: async (input) => ({
        providerMessageId: "message-1",
        providerTodoId: `provider-${input.todoId}`,
        state: "created",
      }),
      completeTodo: async (input) => ({
        providerMessageId: "message-complete",
        providerTodoId: input.providerTodoId ?? `provider-${input.todoId}`,
        state: "completed",
      }),
      updateTodo: async (input) => ({
        providerMessageId: "message-update",
        providerTodoId: input.providerTodoId ?? `provider-${input.todoId}`,
        state: "updated",
      }),
    };
    expect(await new TodoDeliveryWorker(database, provider, "https://staging.example/rework/").runOnce()).toEqual({
      claimed: 1,
      sent: 1,
      failed: 0,
      suppressed: 0,
    });
    await expect(database.query(
      `SELECT attempt_no,outcome,provider_message_id
       FROM todo_delivery_attempts
       WHERE todo_id=$1 AND delivery_kind='information'
       ORDER BY attempt_no`,
      [first.todoId],
    )).resolves.toMatchObject({ rows: [
      { attempt_no: 0, outcome: "queued", provider_message_id: null },
      { attempt_no: 1, outcome: "sent", provider_message_id: "message-1" },
    ] });
    await expect(database.query(
      "SELECT status FROM rework_todos WHERE todo_id=$1",
      [first.todoId],
    )).resolves.toMatchObject({ rows: [{ status: "completed" }] });
    await database.query(
      `UPDATE message_outbox
       SET status='sent',sent_at=COALESCE(sent_at,CURRENT_TIMESTAMP),
           claimed_at=NULL,claim_token=NULL,last_error=NULL,updated_at=CURRENT_TIMESTAMP
       WHERE aggregate_id=$1 AND status<>'sent'`,
      [first.todoId],
    );

    const secondSourceEventId = randomUUID();
    await database.query(
      `INSERT INTO operation_events(
         event_id,request_id,actor_id,actor_roles,authorization_capability,
         action,entity_type,entity_id
       ) VALUES($1,$2,$3,ARRAY['tail_supervisor'],'process:configure',
         'rework.submit','rework_order',$4)`,
      [secondSourceEventId, `source-${secondSourceEventId}`, actorId, entityId],
    );
    const completed = await create(`todo:${entityId}:completed`, secondSourceEventId);
    const completionClient = await database.connect();
    try {
      await completionClient.query("BEGIN");
      const completionEventId = await new OperationEventRepository().append(completionClient, actor, {
        action: "todo.complete",
        entityType: "rework_todo",
        entityId: completed.todoId,
      });
      await completionClient.query(
        "SELECT set_config('dx_rework.todo_event_id',$1,true),set_config('dx_rework.todo_request_id',$2,true)",
        [completionEventId, actor.requestId],
      );
      await completionClient.query(
        `UPDATE rework_todos
         SET status='completed',completed_at=CURRENT_TIMESTAMP,completed_by=$2,
             completed_operation_event_id=$3
         WHERE todo_id=$1`,
        [completed.todoId, actorId, completionEventId],
      );
      await completionClient.query("COMMIT");
    } catch (error) {
      await completionClient.query("ROLLBACK");
      throw error;
    } finally {
      completionClient.release();
    }
    const noCallProvider: DingTalkTodoProvider = {
      createTodo: async () => { throw new Error("a completed todo must never call the provider"); },
      completeTodo: async () => { throw new Error("a completed todo without a binding must never call the provider"); },
      updateTodo: async () => { throw new Error("a completed todo must never call the provider"); },
    };
    expect(await new TodoDeliveryWorker(database, noCallProvider, "/").runOnce(1)).toEqual({
      claimed: 1,
      sent: 0,
      failed: 0,
      suppressed: 1,
    });
  });

  it("blocks an ineligible recipient, exposes only a routing exception, and requires an audited transfer", async () => {
    const actorId = randomUUID();
    const managerId = randomUUID();
    const inactiveRecipientId = randomUUID();
    const replacementRecipientId = randomUUID();
    const entityId = randomUUID();
    const sourceEventId = randomUUID();
    await database.query(
      `INSERT INTO app_users(id,display_name,enabled) VALUES
         ($1,'Todo actor',true),($2,'Routing manager',true),
         ($3,'Inactive recipient',false),($4,'Replacement recipient',true)`,
      [actorId, managerId, inactiveRecipientId, replacementRecipientId],
    );
    for (const userId of [actorId, managerId, replacementRecipientId]) {
      await database.query(
        `INSERT INTO identity_mappings(
           id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at
         ) VALUES($1,$2,'dingtalk','todo-corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
        [randomUUID(), userId, `todo-user-${userId}`, `todo-union-${userId}`],
      );
    }
    for (const [userId, roleCode] of [
      [actorId, "tail_supervisor"],
      [managerId, "production_management"],
      [replacementRecipientId, "tail_supervisor"],
    ] as const) {
      await access.assignRole(adminActor(), {
        userId,
        roleCode,
        reason: "controlled migration fixture",
      });
    }
    await database.query(
      "INSERT INTO access_security_policy(policy_key,dingtalk_corp_id) VALUES('primary','todo-corp') ON CONFLICT DO NOTHING",
    );
    await database.query(
      `INSERT INTO operation_events(
         event_id,request_id,actor_id,actor_roles,authorization_capability,
         action,entity_type,entity_id
       ) VALUES($1,$2,$3,ARRAY['tail_supervisor'],'process:configure',
         'rework.pending_process_configuration','rework_order',$4)`,
      [sourceEventId, `source-${sourceEventId}`, actorId, entityId],
    );
    const actor: TrustedActorContext = {
      actorId,
      actorRoles: ["tail_supervisor"],
      authorizationCapability: "process:configure",
      authorizationCapabilities: ["process:configure"],
      requestId: `todo-routing-${randomUUID()}`,
    };
    const service = new TodoService(database);
    const client = await database.connect();
    let blockedTodoId: string;
    try {
      await client.query("BEGIN");
      const blocked = await service.createInTransaction(client, actor, {
        todoType: "business_action",
        category: "process_configuration",
        sourceEventId,
        sourceAction: "rework.pending_process_configuration",
        entityType: "rework_order",
        entityId,
        recipientUserId: inactiveRecipientId,
        requiredRole: "tail_supervisor",
        requiredCapability: "process:configure",
        route: { routeName: "process_configuration", entityId },
        policyKey: "general",
        dedupeKey: `todo:${entityId}:recipient-blocked`,
        invalidRecipientRouting: {
          reason: "recipient_disabled",
          assignedToUserId: managerId,
        },
      });
      blockedTodoId = blocked.todoId;
      expect(blocked.status).toBe("blocked_recipient");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const manager: TrustedActorContext = {
      actorId: managerId,
      actorRoles: ["production_management"],
      authorizationCapability: "todo:routing_exception_manage",
      authorizationCapabilities: ["todo:routing_exception_manage", "todo:view"],
      requestId: `todo-transfer-${randomUUID()}`,
    };
    const exceptions = await service.listRoutingExceptionsForActor(manager);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({
      todoId: blockedTodoId!,
      originalRecipientUserId: inactiveRecipientId,
      assignedToUserId: managerId,
      status: "pending",
    });
    const transferred = await service.transferRoutingException(manager, {
      routingExceptionId: exceptions[0]!.routingExceptionId,
      recipientUserId: replacementRecipientId,
      reason: "已核验尾部主管角色后转交",
    });
    expect(transferred).toMatchObject({
      todoId: blockedTodoId!,
      recipientUserId: replacementRecipientId,
      status: "pending",
    });
    await expect(database.query(
      `SELECT original.status AS original_status,routing.status AS routing_status,
              transfer.delegation_scope_id
       FROM todo_recipient_routing_exceptions exception
       JOIN rework_todos original ON original.todo_id=exception.todo_id
       JOIN rework_todos routing ON routing.todo_id=exception.routing_todo_id
       JOIN todo_recipient_transfers transfer ON transfer.routing_exception_id=exception.routing_exception_id
       WHERE exception.todo_id=$1`,
      [blockedTodoId],
    )).resolves.toMatchObject({ rows: [{
      original_status: "pending",
      routing_status: "completed",
      delegation_scope_id: entityId,
    }] });
    await database.query("UPDATE app_users SET enabled=false WHERE id=$1", [managerId]);
  });

  it("re-routes a stale routing manager while retaining an auditable exception history", async () => {
    const actorId = randomUUID();
    const recipientId = randomUUID();
    const firstManagerId = randomUUID();
    const replacementManagerId = randomUUID();
    const entityId = randomUUID();
    const sourceEventId = randomUUID();
    const requestId = `todo-reroute-${randomUUID()}`;
    await database.query(
      `INSERT INTO app_users(id,display_name,enabled) VALUES
         ($1,'Todo reroute actor',true),($2,'Action recipient',true),
         ($3,'First routing manager',true),($4,'Replacement routing manager',true)`,
      [actorId, recipientId, firstManagerId, replacementManagerId],
    );
    for (const userId of [actorId, recipientId, firstManagerId, replacementManagerId]) {
      await database.query(
        `INSERT INTO identity_mappings(
           id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at
         ) VALUES($1,$2,'dingtalk','todo-corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
        [randomUUID(), userId, `reroute-user-${userId}`, `reroute-union-${userId}`],
      );
    }
    for (const [userId, roleCode] of [
      [actorId, "tail_supervisor"],
      [recipientId, "tail_supervisor"],
      [firstManagerId, "production_management"],
    ] as const) {
      await access.assignRole(adminActor(), {
        userId,
        roleCode,
        reason: "controlled routing lifecycle fixture",
      });
    }
    await database.query(
      "INSERT INTO access_security_policy(policy_key,dingtalk_corp_id) VALUES('primary','todo-corp') ON CONFLICT DO NOTHING",
    );
    await database.query(
      `INSERT INTO operation_events(
         event_id,request_id,actor_id,actor_roles,authorization_capability,
         action,entity_type,entity_id
       ) VALUES($1,$2,$3,ARRAY['tail_supervisor'],'process:configure',
         'rework.submit','rework_order',$4)`,
      [sourceEventId, `source-${sourceEventId}`, actorId, entityId],
    );
    const actor: TrustedActorContext = {
      actorId,
      actorRoles: ["tail_supervisor"],
      authorizationCapability: "process:configure",
      authorizationCapabilities: ["process:configure"],
      requestId,
    };
    const service = new TodoService(database);
    const createClient = await database.connect();
    let originalTodoId: string;
    try {
      await createClient.query("BEGIN");
      originalTodoId = (await service.createInTransaction(createClient, actor, {
        todoType: "business_action",
        category: "process_configuration",
        sourceEventId,
        sourceAction: "rework.submit",
        entityType: "rework_order",
        entityId,
        recipientUserId: recipientId,
        requiredRole: "tail_supervisor",
        requiredCapability: "process:configure",
        route: { routeName: "process_configuration", entityId },
        policyKey: "general",
        dedupeKey: `reroute:${entityId}`,
      })).todoId;
      await createClient.query("COMMIT");
    } catch (error) {
      await createClient.query("ROLLBACK");
      throw error;
    } finally {
      createClient.release();
    }

    await database.query("UPDATE app_users SET enabled=false WHERE id=$1", [recipientId]);
    const firstRevalidation = await database.connect();
    try {
      await firstRevalidation.query("BEGIN");
      expect(await service.ensureOpenRecipientEligibleInTransaction(
        firstRevalidation,
        actor,
        originalTodoId!,
      )).toBe(false);
      await firstRevalidation.query("COMMIT");
    } catch (error) {
      await firstRevalidation.query("ROLLBACK");
      throw error;
    } finally {
      firstRevalidation.release();
    }
    const first = await database.query<{
      routing_todo_id: string;
    }>(
      "SELECT routing_todo_id FROM todo_recipient_routing_exceptions WHERE todo_id=$1 AND status='pending'",
      [originalTodoId],
    );
    const firstRoutingTodoId = first.rows[0]!.routing_todo_id;

    await database.query("UPDATE app_users SET enabled=false WHERE id=$1", [firstManagerId]);
    await access.assignRole(adminActor(), {
      userId: replacementManagerId,
      roleCode: "production_management",
      reason: "controlled replacement routing manager",
    });
    const secondRevalidation = await database.connect();
    try {
      await secondRevalidation.query("BEGIN");
      expect(await service.ensureOpenRecipientEligibleInTransaction(
        secondRevalidation,
        actor,
        firstRoutingTodoId,
      )).toBe(false);
      await secondRevalidation.query("COMMIT");
    } catch (error) {
      await secondRevalidation.query("ROLLBACK");
      throw error;
    } finally {
      secondRevalidation.release();
    }
    await expect(database.query(
      `SELECT exception.status,exception.assigned_to_user_id,routing.status routing_status
       FROM todo_recipient_routing_exceptions exception
       JOIN rework_todos routing ON routing.todo_id=exception.routing_todo_id
       WHERE exception.todo_id=$1
       ORDER BY exception.created_at,exception.routing_exception_id`,
      [originalTodoId],
    )).resolves.toMatchObject({ rows: [
      { status: "cancelled", assigned_to_user_id: firstManagerId, routing_status: "cancelled" },
      { status: "pending", assigned_to_user_id: replacementManagerId, routing_status: "pending" },
    ] });
  });
});

