import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { TodoDeliveryWorker } from "../../apps/api/src/todos/delivery-worker.js";
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
] as const;

runWithPostgres("PR-13 todo notification foundation migration", () => {
  const schema = `todo_foundation_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const migration of migrations) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration}`, import.meta.url),
        "utf8",
      ));
    }
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

    const provider = { deliver: async () => ({ providerMessageId: "message-1" }) };
    expect(await new TodoDeliveryWorker(database, provider, "/").runOnce()).toEqual({
      claimed: 1,
      sent: 1,
      failed: 0,
      suppressed: 0,
    });
    await expect(database.query(
      `SELECT attempt_no,outcome,provider_message_id
       FROM todo_delivery_attempts WHERE todo_id=$1 ORDER BY attempt_no`,
      [first.todoId],
    )).resolves.toMatchObject({ rows: [
      { attempt_no: 0, outcome: "queued", provider_message_id: null },
      { attempt_no: 1, outcome: "sent", provider_message_id: "message-1" },
    ] });

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
    expect(await new TodoDeliveryWorker(database, {
      deliver: async () => { throw new Error("a completed todo must never call the provider"); },
    }, "/").runOnce()).toEqual({
      claimed: 1,
      sent: 0,
      failed: 0,
      suppressed: 1,
    });
  });

  it("revalidates stale recipients and keeps routing transfer facts intact", async () => {
    const actorId = randomUUID();
    const managerId = randomUUID();
    const staleRecipientId = randomUUID();
    const invalidReplacementId = randomUUID();
    const replacementRecipientId = randomUUID();
    const delegationGrantorId = randomUUID();
    const delegatedRecipientId = randomUUID();
    const staleDelegatedRecipientId = randomUUID();
    const firstEntityId = randomUUID();
    const secondEntityId = randomUUID();
    await database.query(
      `INSERT INTO app_users(id,display_name,enabled) VALUES
         ($1,'Todo actor',true),($2,'Routing manager',true),
         ($3,'Recipient active at creation',true),($4,'Invalid replacement',false),
         ($5,'Replacement recipient',true),($6,'Delegation grantor',true),
         ($7,'Delegated recipient',true),($8,'Stale delegated recipient',true)`,
      [
        actorId, managerId, staleRecipientId, invalidReplacementId, replacementRecipientId,
        delegationGrantorId, delegatedRecipientId, staleDelegatedRecipientId,
      ],
    );
    for (const userId of [
      actorId, managerId, staleRecipientId, replacementRecipientId, delegationGrantorId,
      delegatedRecipientId, staleDelegatedRecipientId,
    ]) {
      await database.query(
        `INSERT INTO identity_mappings(
           id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at
         ) VALUES($1,$2,'dingtalk','todo-corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
        [randomUUID(), userId, `todo-user-${userId}`, `todo-union-${userId}`],
      );
    }
    for (const [userId, roleCode] of [
      [actorId, "tail_supervisor"],
      [actorId, "owner_group"],
      [managerId, "production_management"],
      [staleRecipientId, "tail_supervisor"],
      [replacementRecipientId, "tail_supervisor"],
      [delegationGrantorId, "tail_supervisor"],
    ] as const) {
      await database.query(
        `INSERT INTO user_role_assignments(
           assignment_id,user_id,role_code,granted_by,grant_reason
         ) VALUES($1,$2,$3,$4,'migration fixture')`,
        [randomUUID(), userId, roleCode, actorId],
      );
    }
    await database.query(
      `INSERT INTO access_security_policy(policy_key,dingtalk_corp_id)
       VALUES('primary','todo-corp')
       ON CONFLICT(policy_key) DO UPDATE SET dingtalk_corp_id=EXCLUDED.dingtalk_corp_id`,
    );
    const delegationActor: TrustedActorContext = {
      actorId,
      actorRoles: ["owner_group"],
      authorizationCapability: "delegation:manage",
      authorizationCapabilities: ["delegation:manage"],
      requestId: `todo-delegation-${randomUUID()}`,
    };
    const access = new AccessMasterDataService(database, "todo-corp");
    const staleDelegation = await access.createDelegation(delegationActor, {
      grantorUserId: delegationGrantorId,
      granteeUserId: staleDelegatedRecipientId,
      capability: "process:configure",
      scopeType: "rework_order",
      scopeId: firstEntityId,
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      reason: "验证失效代理不可接收待办",
    });
    const validDelegation = await access.createDelegation(delegationActor, {
      grantorUserId: delegationGrantorId,
      granteeUserId: delegatedRecipientId,
      capability: "process:configure",
      scopeType: "rework_order",
      scopeId: firstEntityId,
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      reason: "验证完整代理链允许受控转交",
    });

    const actor: TrustedActorContext = {
      actorId,
      actorRoles: ["tail_supervisor"],
      authorizationCapability: "process:configure",
      authorizationCapabilities: ["process:configure"],
      requestId: `todo-routing-${randomUUID()}`,
    };
    const service = new TodoService(database);
    const createActionable = async (entityId: string, suffix: string) => {
      const sourceEventId = randomUUID();
      await database.query(
        `INSERT INTO operation_events(
           event_id,request_id,actor_id,actor_roles,authorization_capability,
           action,entity_type,entity_id
         ) VALUES($1,$2,$3,ARRAY['tail_supervisor'],'process:configure',
           'rework.pending_process_configuration','rework_order',$4)`,
        [sourceEventId, `source-${sourceEventId}`, actorId, entityId],
      );
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        const todo = await service.createInTransaction(client, actor, {
          todoType: "business_action",
          category: "process_configuration",
          sourceEventId,
          sourceAction: "rework.pending_process_configuration",
          entityType: "rework_order",
          entityId,
          recipientUserId: staleRecipientId,
          requiredRole: "tail_supervisor",
          requiredCapability: "process:configure",
          route: { routeName: "process_configuration", entityId },
          policyKey: "general",
          dedupeKey: `todo:${entityId}:${suffix}`,
        });
        await client.query("COMMIT");
        return todo;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };

    const deliveryTodo = await createActionable(firstEntityId, "delivery-revalidation");
    const closingTodo = await createActionable(secondEntityId, "closure-revalidation");
    await database.query("UPDATE app_users SET enabled=false WHERE id=ANY($1::uuid[])", [
      [staleRecipientId, staleDelegatedRecipientId],
    ]);

    let providerCalls = 0;
    expect(await new TodoDeliveryWorker(database, {
      deliver: async () => {
        providerCalls += 1;
        throw new Error("stale recipient must be suppressed before provider delivery");
      },
    }, "/").runOnce(1)).toEqual({
      claimed: 1,
      sent: 0,
      failed: 0,
      suppressed: 1,
    });
    expect(providerCalls).toBe(0);

    const manager: TrustedActorContext = {
      actorId: managerId,
      actorRoles: ["production_management"],
      authorizationCapability: "todo:routing_exception_manage",
      authorizationCapabilities: ["todo:routing_exception_manage", "todo:view"],
      requestId: `todo-transfer-${randomUUID()}`,
    };
    const exceptions = await service.listRoutingExceptionsForActor(manager);
    const deliveryException = exceptions.find((row) => row.todoId === deliveryTodo.todoId);
    expect(deliveryException).toMatchObject({
      originalRecipientUserId: staleRecipientId,
      assignedToUserId: managerId,
      status: "pending",
    });

    await expect(database.query(
      `UPDATE todo_recipient_routing_exceptions
       SET routing_todo_id=$2 WHERE routing_exception_id=$1`,
      [deliveryException!.routingExceptionId, deliveryTodo.todoId],
    )).rejects.toMatchObject({ code: "55000" });

    await expect(service.transferRoutingException(manager, {
      routingExceptionId: deliveryException!.routingExceptionId,
      recipientUserId: invalidReplacementId,
      reason: "失效人员不可接收转交",
    })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    await expect(service.transferRoutingException(manager, {
      routingExceptionId: deliveryException!.routingExceptionId,
      recipientUserId: staleDelegatedRecipientId,
      delegationId: staleDelegation.delegationId,
      reason: "停用代理人员不可接收转交",
    })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    const transferred = await service.transferRoutingException(manager, {
      routingExceptionId: deliveryException!.routingExceptionId,
      recipientUserId: delegatedRecipientId,
      delegationId: validDelegation.delegationId,
      reason: "已核验完整订单代理链后转交",
    });
    expect(transferred).toMatchObject({
      todoId: deliveryTodo.todoId,
      recipientUserId: delegatedRecipientId,
      status: "pending",
    });
    await expect(database.query(
      "SELECT delegation_id FROM rework_todos WHERE todo_id=$1",
      [deliveryTodo.todoId],
    )).resolves.toMatchObject({ rows: [{ delegation_id: validDelegation.delegationId }] });

    const closeClient = await database.connect();
    try {
      await closeClient.query("BEGIN");
      expect(await service.ensureOpenRecipientEligibleInTransaction(
        closeClient,
        actor,
        closingTodo.todoId,
      )).toBe(false);
      expect(await service.cancelOpenByDedupeKey(
        closeClient,
        actor,
        `todo:${secondEntityId}:closure-revalidation`,
        "业务版本已替代",
      )).toBe(true);
      await closeClient.query("COMMIT");
    } catch (error) {
      await closeClient.query("ROLLBACK");
      throw error;
    } finally {
      closeClient.release();
    }

    await expect(database.query(
      `SELECT original.status AS original_status,routing.status AS routing_status,
              exception.status AS exception_status
       FROM todo_recipient_routing_exceptions exception
       JOIN rework_todos original ON original.todo_id=exception.todo_id
       JOIN rework_todos routing ON routing.todo_id=exception.routing_todo_id
       WHERE exception.todo_id=$1`,
      [closingTodo.todoId],
    )).resolves.toMatchObject({ rows: [{
      original_status: "cancelled",
      routing_status: "cancelled",
      exception_status: "cancelled",
    }] });
  });
});
