import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import {
  OperationEventRepository,
  type TrustedActorContext,
} from "../../apps/api/src/tools/repositories.js";

import { completeInspectionReport } from "../inspection-report-fixture.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;
const baseMigrations = [
  "0001_platform_foundation.sql",
  "0002_dingtalk_identity_access.sql",
  "0003_identity_union_continuity.sql",
  "0004_public_tools_foundation.sql",
  "0005_access_master_data.sql",
  "0006_rework_initiation.sql",
  "0056_n01_digital_inspection_report.sql",
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
] as const;
const wageMigrations = [
  "0022_wage_reconciliation_month_close.sql",
  "0023_wage_materialization_closure.sql",
  "0024_wage_adjustment_attachment_closure.sql",
  "0025_wage_completion_month_backfill_access.sql",
] as const;

runWithPostgres("wage completion-month backfill closure", () => {
  const schema = `wage_backfill_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });
  const access = new AccessMasterDataService(database, "corp");
  const initiation = new ReworkInitiationService(database, "corp");
  const configuration = new ProcessConfigurationService(database);
  const reporting = new WorkReportingService(database);
  const events = new OperationEventRepository();

  const ids = {
    admin: randomUUID(),
    qc: randomUUID(),
    tail: randomUUID(),
    ie: randomUUID(),
    worker: randomUUID(),
  };
  let workerPersonId = "";

  const actor = (
    actorId: string,
    actorRoles: readonly string[],
    authorizationCapability: string,
    ...authorizationCapabilities: string[]
  ): TrustedActorContext => ({
    actorId,
    actorRoles,
    authorizationCapability,
    authorizationCapabilities,
    requestId: randomUUID(),
  });
  const tailActor = (primary = "process:configure") => actor(
    ids.tail,
    ["order_merchandiser", "tail_supervisor"],
    primary,
    "process:configure",
    "work:assign",
    "submission:audit",
    "tools:user",
  );

  beforeAll(async () => {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    for (const migration of baseMigrations) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration}`, import.meta.url),
        "utf8",
      ));
    }

    const users = [
      [ids.admin, "Admin", "system_admin"],
      [ids.qc, "QC", "quality_control"],
      [ids.tail, "Tail", "tail_supervisor"],
      [ids.ie, "IE", "ie_reviewer"],
      [ids.worker, "Worker", "worker"],
    ] as const;
    for (const [userId, displayName, role] of users) {
      await database.query(
        "INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",
        [userId, displayName],
      );
      await database.query(
        `INSERT INTO identity_mappings(
           id,user_id,provider,corp_id,provider_user_id,union_id,
           active,employed,last_verified_at
         ) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
        [randomUUID(), userId, `ding-${userId}`, `union-${userId}`],
      );
      await database.query(
        `INSERT INTO user_role_assignments(
           assignment_id,user_id,role_code,granted_by,grant_reason
         ) VALUES($1,$2,$3,$2,'fixture')`,
        [randomUUID(), userId, role],
      );
    }
    await database.query(
      `INSERT INTO user_role_assignments(
         assignment_id,user_id,role_code,granted_by,grant_reason
       ) VALUES($1,$2,'order_merchandiser',$2,'fixture merchandiser')`,
      [randomUUID(), ids.tail],
    );
    await access.ensureOrganizationPolicy();
    workerPersonId = (
      await access.createPerson(
        actor(
          ids.admin,
          ["system_admin"],
          "master_data:manage",
          "master_data:manage",
        ),
        {
          personType: "internal",
          appUserId: ids.worker,
          displayName: "Worker",
          aliases: [],
          reason: "wage backfill fixture",
        },
      )
    ).personId;
  });

  afterAll(async () => {
    await database.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  });

  it("backfills pre-PR reviews into each report completion month", async () => {
    const qc = actor(
      ids.qc,
      ["quality_control"],
      "rework:initiate",
      "rework:initiate",
    );
    const draft = await initiation.createDraft(qc, {
      styleNo: "WAGE-BACKFILL",
      merchandiserUserId: ids.tail,
      processingFactory: { type: "own_factory" },
      problemPart: "袖口",
      problemDescription: "历史工资补录",
      reworkQuantity: 1,
      inspectionReport: completeInspectionReport(),
    }, randomUUID());
    const submitted = await initiation.submit(
      qc,
      draft.value.reworkOrderId,
      { expectedVersion: draft.value.version },
      randomUUID(),
    );
    const saved = await configuration.saveDraft(
      tailActor(),
      draft.value.reworkOrderId,
      {
        expectedOrderVersion: submitted.value.version,
        items: [{
          source: "custom",
          customProcessName: "历史工资工序",
          pricingUnit: "piece",
          plannedQuantity: 1,
          unitPrice: 1,
        }],
      },
      randomUUID(),
    );
    const queued = await configuration.submit(
      tailActor(),
      draft.value.reworkOrderId,
      {
        expectedOrderVersion: saved.value.orderVersion,
        expectedConfigurationVersion:
          saved.value.configuration!.configurationVersion,
      },
      randomUUID(),
    );
    const approved = await configuration.review(
      actor(ids.ie, ["ie_reviewer"], "process:review", "process:review"),
      draft.value.reworkOrderId,
      {
        expectedOrderVersion: queued.value.orderVersion,
        expectedConfigurationVersion:
          queued.value.configuration!.configurationVersion,
        decision: "approved",
      },
      randomUUID(),
    );
    const task = await reporting.createTask(
      tailActor("work:assign"),
      draft.value.reworkOrderId,
      {
        expectedOrderVersion: approved.value.orderVersion,
        configurationItemId:
          approved.value.configuration!.items[0]!.configurationItemId,
        mode: "individual",
        members: [{ personId: workerPersonId }],
      },
      randomUUID(),
    );
    const view = await reporting.list(
      tailActor("work:assign"),
      draft.value.reworkOrderId,
    );
    await reporting.submitReport(
      actor(ids.worker, ["worker"], "work:report", "work:report"),
      task.value.workTaskId,
      {
        expectedOrderVersion: view.orderVersion,
        actualQuantity: 1,
        completedAt: "2026-07-31T12:00:00.000Z",
      },
      randomUUID(),
    );

    const client = await database.connect();
    const reviewId = randomUUID();
    try {
      await client.query("BEGIN");
      const tail = tailActor("submission:audit");
      const eventId = await events.append(client, tail, {
        action: "rework.whole_order.approve",
        entityType: "rework_order",
        entityId: draft.value.reworkOrderId,
        before: { status: "pending_order_review" },
        after: { status: "pending_responsibility_determination" },
      });
      await client.query(
        `SELECT
           set_config('dx_rework.whole_order_review_event_id',$1,true),
           set_config('dx_rework.whole_order_review_request_id',$2,true)`,
        [eventId, tail.requestId],
      );
      await client.query(
        `INSERT INTO rework_order_reviews(
           order_review_id,rework_order_id,reviewed_by,reviewed_at,review_snapshot
         ) VALUES($1,$2,$3,'2026-08-01T01:00:00.000Z',$4)`,
        [reviewId, draft.value.reworkOrderId, ids.tail, { source: "pre-pr-12" }],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    for (const migration of wageMigrations) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration}`, import.meta.url),
        "utf8",
      ));
    }

    const materialized = await database.query<{
      period_month: string;
      order_review_id: string;
    }>(
      `SELECT period.period_month::text,item.order_review_id
       FROM rework_wage_items item
       JOIN rework_wage_periods period ON period.period_id=item.period_id
       WHERE item.order_review_id=$1`,
      [reviewId],
    );
    expect(materialized.rows).toEqual([{
      period_month: "2026-07-01",
      order_review_id: reviewId,
    }]);
    expect((await database.query(
      "SELECT 1 FROM rework_wage_periods WHERE period_month='2026-08-01'",
    )).rowCount).toBe(0);
    expect((await database.query(
      `SELECT 1 FROM role_capabilities
       WHERE role_code='administrative_clerk' AND capability='tools:user'`,
    )).rowCount).toBe(1);
  });
});
