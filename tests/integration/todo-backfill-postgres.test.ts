import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { TodoBackfillService } from "../../apps/api/src/todos/backfill-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

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

runWithPostgres("PR-13 controlled todo backfill", () => {
  const schema = `todo_backfill_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });
  const qcId = randomUUID();
  const merchandiserId = randomUUID();
  const tailSupervisorId = randomUUID();
  const productionManagementId = randomUUID();
  const qcActor = (): TrustedActorContext => ({
    actorId: qcId,
    actorRoles: ["quality_control"],
    authorizationCapability: "rework:initiate",
    authorizationCapabilities: ["rework:initiate"],
    requestId: `todo-backfill-qc-${randomUUID()}`,
  });

  const createSubmittedOrder = async (styleNo: string) => {
    const service = new ReworkInitiationService(database, "todo-backfill-corp");
    const draft = await service.createDraft(qcActor(), {
      styleNo,
      merchandiserUserId: merchandiserId,
      processingFactory: { type: "own_factory" },
      problemPart: "袖口",
      problemDescription: "历史返工补建测试",
      reworkQuantity: 10,
    }, randomUUID());
    return service.submit(qcActor(), draft.value.reworkOrderId, {
      expectedVersion: draft.value.version,
    }, randomUUID());
  };

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const migration of migrations) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration}`, import.meta.url),
        "utf8",
      ));
    }
    for (const [userId, displayName] of [
      [qcId, "品控"],
      [merchandiserId, "跟单"],
      [tailSupervisorId, "尾部主管"],
      [productionManagementId, "生产管理"],
    ] as const) {
      await database.query(
        "INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",
        [userId, displayName],
      );
      await database.query(
        `INSERT INTO identity_mappings(
           id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at
         ) VALUES($1,$2,'dingtalk','todo-backfill-corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
        [randomUUID(), userId, `ding-${userId}`, `union-${userId}`],
      );
    }
    for (const [userId, roleCode] of [
      [qcId, "quality_control"],
      [merchandiserId, "order_merchandiser"],
      [tailSupervisorId, "tail_supervisor"],
      [productionManagementId, "production_management"],
    ] as const) {
      await database.query(
        `INSERT INTO user_role_assignments(
           assignment_id,user_id,role_code,granted_by,grant_reason
         ) VALUES($1,$2,$3,$4,'todo backfill fixture')`,
        [randomUUID(), userId, roleCode, productionManagementId],
      );
    }
    await database.query(
      "INSERT INTO access_security_policy(policy_key,dingtalk_corp_id) VALUES('primary','todo-backfill-corp')",
    );
  });

  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("keeps dry-run read-only, creates only once under concurrent apply, and excludes closed work", async () => {
    const pending = await createSubmittedOrder("BACKFILL-PENDING");
    const closed = await createSubmittedOrder("BACKFILL-CLOSED");
    const service = new ReworkInitiationService(database, "todo-backfill-corp");
    await service.cancel(qcActor(), closed.value.reworkOrderId, {
      expectedVersion: closed.value.version,
      reason: "历史单据已关闭",
    }, randomUUID());

    const backfill = new TodoBackfillService(database);
    const preview = await backfill.run({ mode: "dry_run", batchSize: 1 });
    expect(preview.runId).toBeNull();
    expect(preview.counters).toMatchObject({ created: 1, missingSourceEvent: 0 });
    await expect(database.query(
      "SELECT count(*)::int count FROM rework_todos",
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(database.query(
      "SELECT count(*)::int count FROM todo_backfill_runs",
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });

    const [first, second] = await Promise.all([
      backfill.run({ mode: "apply", actorUserId: productionManagementId, batchSize: 1 }),
      new TodoBackfillService(database).run({ mode: "apply", actorUserId: productionManagementId, batchSize: 1 }),
    ]);
    expect(first.counters.created + second.counters.created).toBe(1);
    expect(first.counters.existing + second.counters.existing).toBe(1);
    await expect(database.query(
      "SELECT count(*)::int count FROM rework_todos WHERE entity_id=$1",
      [pending.value.reworkOrderId],
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(database.query(
      "SELECT count(*)::int count FROM rework_todos WHERE entity_id=$1",
      [closed.value.reworkOrderId],
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("reports an unavailable historical recipient instead of inventing a replacement", async () => {
    await database.query("UPDATE app_users SET enabled=false WHERE id=$1", [tailSupervisorId]);
    const pending = await createSubmittedOrder("BACKFILL-NO-RECIPIENT");
    const result = await new TodoBackfillService(database).run({
      mode: "apply",
      actorUserId: productionManagementId,
    });
    expect(result.counters.ambiguousRecipient).toBe(1);
    await expect(database.query(
      `SELECT result FROM todo_backfill_exceptions
       WHERE entity_id=$1 ORDER BY created_at DESC`,
      [pending.value.reworkOrderId],
    )).resolves.toMatchObject({ rows: [{ result: "skipped_ambiguous_recipient" }] });
    await expect(database.query(
      "SELECT count(*)::int count FROM rework_todos WHERE entity_id=$1",
      [pending.value.reworkOrderId],
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
