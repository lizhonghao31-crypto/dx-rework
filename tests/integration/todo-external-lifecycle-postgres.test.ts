import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { TodoDeliveryWorker } from "../../apps/api/src/todos/delivery-worker.js";
import { FakeDingTalkTodoProvider } from "../../apps/api/src/todos/provider.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
import { TodoTimingService } from "../../apps/api/src/todos/timing-service.js";
import { MessageOutboxRepository, type TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

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
  "0076_dingtalk_todo_creator_identity.sql",
] as const;

runWithPostgres("PR-13 todo notification lifecycle", () => {
  const schema = `todo_foundation_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });
  const adminId = randomUUID();
  const adminActor = (capability = "access:admin"): TrustedActorContext => ({
    actorId: adminId,
    actorRoles: ["system_admin"],
    authorizationCapability: capability,
    authorizationCapabilities: [capability],
    requestId: `admin-${randomUUID()}`,
  });
  let access: AccessMasterDataService;

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const migration of migrations) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration}`, import.meta.url),
        "utf8",
      ));
    }
    await database.query(
      "INSERT INTO app_users(id,display_name,enabled) VALUES($1,'Todo runtime administrator',true)",
      [adminId],
    );
    await database.query(
      `INSERT INTO identity_mappings(
         id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at
       ) VALUES($1,$2,'dingtalk','todo-corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
      [randomUUID(), adminId, `admin-user-${adminId}`, `admin-union-${adminId}`],
    );
    // Bootstrap only: the immutable primary policy is intentionally absent, so
    // the first administrator role can be established before controlled writes.
    await database.query(
      `INSERT INTO user_role_assignments(
         assignment_id,user_id,role_code,granted_by,grant_reason
       ) VALUES($1,$2,'system_admin',$2,'initial controlled administrator')`,
      [randomUUID(), adminId],
    );
    access = new AccessMasterDataService(database, "todo-corp");
    await access.ensureOrganizationPolicy();
  });

  beforeEach(async () => {
    await database.query(
      `UPDATE message_outbox
       SET status='sent',sent_at=COALESCE(sent_at,CURRENT_TIMESTAMP),
           claimed_at=NULL,claim_token=NULL,last_error=NULL,updated_at=CURRENT_TIMESTAMP
       WHERE status<>'sent'`,
    );
    await database.query(
      `UPDATE todo_policies
       SET due_after_seconds=CASE policy_key WHEN 'general' THEN 86400 ELSE due_after_seconds END,
           first_reminder_after_due_seconds=CASE policy_key WHEN 'general' THEN 0 ELSE first_reminder_after_due_seconds END`,
    );
  });

  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  const createUser = async (
    displayName: string,
    roleCode?: string,
  ): Promise<{ userId: string; actor: TrustedActorContext }> => {
    const userId = randomUUID();
    await database.query(
      "INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",
      [userId, displayName],
    );
    await database.query(
      `INSERT INTO identity_mappings(
         id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at
       ) VALUES($1,$2,'dingtalk','todo-corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
      [randomUUID(), userId, `provider-${userId}`, `union-${userId}`],
    );
    if (roleCode) {
      await access.assignRole(adminActor(), {
        userId,
        roleCode,
        reason: `test fixture ${roleCode}`,
      });
    }
    const capabilities = roleCode === "production_management"
      ? ["todo:routing_exception_manage", "todo:view"]
      : roleCode === "tail_supervisor"
        ? ["process:configure", "todo:view"]
        : [];
    return {
      userId,
      actor: {
        actorId: userId,
        actorRoles: roleCode ? [roleCode] : ["system_admin"],
        authorizationCapability: capabilities[0] ?? "todo:view",
        authorizationCapabilities: capabilities,
        requestId: `actor-${randomUUID()}`,
      },
    };
  };

  const sourceEvent = async (
    actor: TrustedActorContext,
    action: string,
    entityId: string,
  ): Promise<string> => {
    const eventId = randomUUID();
    await database.query(
      `INSERT INTO operation_events(
         event_id,request_id,actor_id,actor_roles,authorization_capability,
         action,entity_type,entity_id
       ) VALUES($1,$2,$3,$4,$5,$6,'rework_order',$7)`,
      [
        eventId,
        `source-${eventId}`,
        actor.actorId,
        actor.actorRoles,
        actor.authorizationCapability,
        action,
        entityId,
      ],
    );
    return eventId;
  };

  const createTodo = async (
    service: TodoService,
    actor: TrustedActorContext,
    input: Parameters<TodoService["createInTransaction"]>[2],
  ) => {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const todo = await service.createInTransaction(client, actor, input);
      await client.query("COMMIT");
      return todo;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  it("installs external lifecycle tables and limits runtime authority to an explicit capability", async () => {
    const tables = await database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema=current_schema() AND table_name=ANY($1::text[])
       ORDER BY table_name`,
      [["dingtalk_todo_external_bindings", "dingtalk_todo_external_binding_events"]],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "dingtalk_todo_external_binding_events",
      "dingtalk_todo_external_bindings",
    ]);
    await expect(database.query(
      `SELECT count(*)::int count
       FROM information_schema.columns
       WHERE table_schema=current_schema()
         AND table_name='dingtalk_todo_external_bindings'
         AND column_name='creator_union_id'
         AND is_nullable='NO'`,
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(database.query(
      `SELECT count(*)::int count FROM role_capabilities
       WHERE role_code='system_admin' AND capability='todo:runtime'`,
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(database.query(
      `SELECT count(*)::int count FROM role_capabilities
       WHERE role_code='system_admin' AND capability='todo:routing_exception_manage'`,
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("reconciles a lost create response, persists one binding, and closes information todos externally", async () => {
    const recipient = await createUser("Information recipient", "tail_supervisor");
    const entityId = randomUUID();
    const sourceEventId = await sourceEvent(recipient.actor, "rework.submit", entityId);
    const service = new TodoService(database);
    const todo = await createTodo(service, recipient.actor, {
      todoType: "information",
      category: "configuration_notice",
      sourceEventId,
      sourceAction: "rework.submit",
      entityType: "rework_order",
      entityId,
      recipientUserId: recipient.userId,
      route: { routeName: "rework_detail", entityId },
      dedupeKey: `information:${entityId}`,
    });
    const provider = new FakeDingTalkTodoProvider(["response_lost"]);
    const worker = new TodoDeliveryWorker(
      database,
      provider,
      "/",
      new MessageOutboxRepository(),
      1,
    );
    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 1,
      sent: 0,
      failed: 1,
      suppressed: 0,
    });
    await expect(database.query(
      `SELECT provider_state,count(*)::int count
       FROM dingtalk_todo_external_bindings WHERE todo_id=$1 GROUP BY provider_state`,
      [todo.todoId],
    )).resolves.toMatchObject({ rows: [{ provider_state: "unknown_response", count: 1 }] });
    await database.query(
      "UPDATE message_outbox SET available_at=CURRENT_TIMESTAMP WHERE aggregate_id=$1 AND status='failed'",
      [todo.todoId],
    );
    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 1,
      sent: 1,
      failed: 0,
      suppressed: 0,
    });
    await expect(database.query(
      `SELECT status FROM rework_todos WHERE todo_id=$1`,
      [todo.todoId],
    )).resolves.toMatchObject({ rows: [{ status: "completed" }] });
    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 1,
      sent: 1,
      failed: 0,
      suppressed: 0,
    });
    await expect(database.query(
      `SELECT provider_state,provider_todo_id,count(*) OVER()::int count
       FROM dingtalk_todo_external_bindings WHERE todo_id=$1`,
      [todo.todoId],
    )).resolves.toMatchObject({ rows: [{
      provider_state: "completed",
      provider_todo_id: "fake-todo-1",
      count: 1,
    }] });
    expect(provider.calls.map((call) => call.method)).toEqual(["create", "create", "complete"]);
  });

  it("closes a blocked todo and its routing work atomically, then transfers an externally delivered todo by generation", async () => {
    const actor = await createUser("Todo actor", "tail_supervisor");
    const manager = await createUser("Routing manager", "production_management");
    const inactive = await createUser("Inactive recipient", "tail_supervisor");
    const replacement = await createUser("Replacement recipient", "tail_supervisor");
    await database.query("UPDATE app_users SET enabled=false WHERE id=$1", [inactive.userId]);
    const service = new TodoService(database);
    const entityId = randomUUID();
    const sourceEventId = await sourceEvent(actor.actor, "rework.pending_process_configuration", entityId);
    const blocked = await createTodo(service, actor.actor, {
      todoType: "business_action",
      category: "process_configuration",
      sourceEventId,
      sourceAction: "rework.pending_process_configuration",
      entityType: "rework_order",
      entityId,
      recipientUserId: inactive.userId,
      requiredRole: "tail_supervisor",
      requiredCapability: "process:configure",
      route: { routeName: "process_configuration", entityId },
      policyKey: "general",
      dedupeKey: `blocked:${entityId}`,
      invalidRecipientRouting: {
        reason: "recipient_disabled",
        assignedToUserId: manager.userId,
      },
    });
    const completionClient = await database.connect();
    try {
      await completionClient.query("BEGIN");
      expect(await service.completeOpenByDedupeKey(
        completionClient,
        { ...actor.actor, requestId: `complete-${randomUUID()}` },
        `blocked:${entityId}`,
        "Business action completed elsewhere",
      )).toBe(true);
      await completionClient.query("COMMIT");
    } catch (error: unknown) {
      await completionClient.query("ROLLBACK");
      throw error;
    } finally {
      completionClient.release();
    }
    await expect(database.query(
      `SELECT original.status original_status,routing.status routing_status,exception.status exception_status
       FROM todo_recipient_routing_exceptions exception
       JOIN rework_todos original ON original.todo_id=exception.todo_id
       JOIN rework_todos routing ON routing.todo_id=exception.routing_todo_id
       WHERE exception.todo_id=$1`,
      [blocked.todoId],
    )).resolves.toMatchObject({ rows: [{
      original_status: "completed",
      routing_status: "cancelled",
      exception_status: "cancelled",
    }] });

    await database.query(
      `UPDATE message_outbox SET status='sent',sent_at=COALESCE(sent_at,CURRENT_TIMESTAMP),
         claimed_at=NULL,claim_token=NULL,last_error=NULL WHERE status<>'sent'`,
    );
    const original = await createUser("Original recipient", "tail_supervisor");
    const transferEntityId = randomUUID();
    const transferSourceEventId = await sourceEvent(actor.actor, "rework.submit", transferEntityId);
    const transferable = await createTodo(service, actor.actor, {
      todoType: "business_action",
      category: "process_configuration",
      sourceEventId: transferSourceEventId,
      sourceAction: "rework.submit",
      entityType: "rework_order",
      entityId: transferEntityId,
      recipientUserId: original.userId,
      requiredRole: "tail_supervisor",
      requiredCapability: "process:configure",
      route: { routeName: "process_configuration", entityId: transferEntityId },
      policyKey: "general",
      dedupeKey: `transferable:${transferEntityId}`,
    });
    const provider = new FakeDingTalkTodoProvider();
    const worker = new TodoDeliveryWorker(database, provider, "https://staging.example/rework/");
    expect((await worker.runOnce()).sent).toBe(1);
    expect(provider.calls[0]).toMatchObject({
      method: "create",
      input: {
        creatorUnionId: `union-${actor.userId}`,
        recipientUnionId: `union-${original.userId}`,
      },
    });
    await expect(database.query(
      `SELECT recipient_union_id,creator_union_id
       FROM dingtalk_todo_external_bindings WHERE todo_id=$1`,
      [transferable.todoId],
    )).resolves.toMatchObject({ rows: [{
      recipient_union_id: `union-${original.userId}`,
      creator_union_id: `union-${actor.userId}`,
    }] });

    await database.query("UPDATE app_users SET enabled=false WHERE id=$1", [original.userId]);
    const revalidation = await database.connect();
    try {
      await revalidation.query("BEGIN");
      expect(await service.ensureOpenRecipientEligibleInTransaction(
        revalidation,
        { ...actor.actor, requestId: `revalidate-${randomUUID()}` },
        transferable.todoId,
      )).toBe(false);
      await revalidation.query("COMMIT");
    } catch (error: unknown) {
      await revalidation.query("ROLLBACK");
      throw error;
    } finally {
      revalidation.release();
    }
    // Deliver the routing todo before its manager resolves it, so both external
    // generations have a provider fact that must be closed.
    expect((await worker.runOnce()).sent).toBe(1);
    const exceptions = await service.listRoutingExceptionsForActor({
      ...manager.actor,
      authorizationCapability: "todo:routing_exception_manage",
      authorizationCapabilities: ["todo:routing_exception_manage", "todo:view"],
      requestId: `list-${randomUUID()}`,
    });
    expect(exceptions).toHaveLength(1);
    await service.transferRoutingException({
      ...manager.actor,
      authorizationCapability: "todo:routing_exception_manage",
      authorizationCapabilities: ["todo:routing_exception_manage", "todo:view"],
      requestId: `transfer-${randomUUID()}`,
    }, {
      routingExceptionId: exceptions[0]!.routingExceptionId,
      recipientUserId: replacement.userId,
      reason: "Controlled transfer after authority revalidation",
    });
    const transferredRun = await worker.runOnce(10);
    expect(transferredRun).toMatchObject({ claimed: 3, sent: 3, failed: 0 });
    await expect(database.query(
      `SELECT recipient_user_id,provider_state,external_generation
       FROM dingtalk_todo_external_bindings
       WHERE todo_id=$1 ORDER BY external_generation`,
      [transferable.todoId],
    )).resolves.toMatchObject({ rows: [
      { recipient_user_id: original.userId, provider_state: "completed", external_generation: 1 },
      { recipient_user_id: replacement.userId, provider_state: "active", external_generation: 2 },
    ] });
  });

  it("updates the existing external todo for a database-timed reminder without creating a duplicate binding", async () => {
    const recipient = await createUser("Reminder recipient", "tail_supervisor");
    const entityId = randomUUID();
    const sourceEventId = await sourceEvent(recipient.actor, "rework.submit", entityId);
    await database.query(
      "UPDATE todo_policies SET due_after_seconds=1,first_reminder_after_due_seconds=0 WHERE policy_key='general'",
    );
    const service = new TodoService(database);
    const todo = await createTodo(service, recipient.actor, {
      todoType: "business_action",
      category: "process_configuration",
      sourceEventId,
      sourceAction: "rework.submit",
      entityType: "rework_order",
      entityId,
      recipientUserId: recipient.userId,
      requiredRole: "tail_supervisor",
      requiredCapability: "process:configure",
      route: { routeName: "process_configuration", entityId },
      policyKey: "general",
      dedupeKey: `reminder:${entityId}`,
    });
    const provider = new FakeDingTalkTodoProvider();
    const worker = new TodoDeliveryWorker(database, provider, "https://staging.example/rework/");
    expect((await worker.runOnce()).sent).toBe(1);
    await database.query("SELECT pg_sleep(1.1)");
    const timing = await new TodoTimingService(database).runOnce({
      ...adminActor("todo:runtime"),
      authorizationCapabilities: ["todo:runtime"],
    });
    expect(timing.reminders).toBe(1);
    expect((await worker.runOnce()).sent).toBe(1);
    expect(provider.calls.map((call) => call.method)).toEqual(["create", "update"]);
    await expect(database.query(
      "SELECT count(*)::int count FROM dingtalk_todo_external_bindings WHERE todo_id=$1",
      [todo.todoId],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });
});

