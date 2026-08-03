import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { WholeOrderReviewService } from "../../apps/api/src/rework/whole-order-review-service.js";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import {
  OperationEventRepository,
  type TrustedActorContext,
} from "../../apps/api/src/tools/repositories.js";
import { WageExportService } from "../../apps/api/src/wages/wage-export-service.js";
import { WageService } from "../../apps/api/src/wages/wage-service.js";

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
] as const;

runWithPostgres("wage reconciliation reviewed workflow", () => {
  const schema = `wage_workflow_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });
  const access = new AccessMasterDataService(database, "corp");
  const initiation = new ReworkInitiationService(database, "corp");
  const configuration = new ProcessConfigurationService(database);
  const reporting = new WorkReportingService(database);
  const orderReview = new WholeOrderReviewService(database);
  const wage = new WageService(database);
  const exporter = new WageExportService(database);
  const events = new OperationEventRepository();

  const ids = {
    admin: randomUUID(),
    qc: randomUUID(),
    tail: randomUUID(),
    ie: randomUUID(),
    worker: randomUUID(),
    administrative: randomUUID(),
    monthClose: randomUUID(),
    otherAdmin: randomUUID(),
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
    "wage:view",
    "wage:tail_review",
    "wage:adjustment_request",
    "tools:user",
  );
  const administrativeActor = () => actor(
    ids.administrative,
    ["administrative_clerk"],
    "wage:view",
    "wage:view",
    "wage:administrative_review",
    "wage:adjustment_approve",
    "wage:export",
  );
  const monthCloseActor = () => actor(
    ids.monthClose,
    ["wage_month_close_accountant"],
    "wage:view",
    "wage:view",
    "wage:month_close",
    "wage:export",
  );

  async function createCompletedWork(label: string): Promise<string> {
    const qc = actor(
      ids.qc,
      ["quality_control"],
      "rework:initiate",
      "rework:initiate",
    );
    const draft = await initiation.createDraft(qc, {
      styleNo: `WAGE-${label}`,
      merchandiserUserId: ids.tail,
      processingFactory: { type: "own_factory" },
      problemPart: "袖口",
      problemDescription: `工资流程 ${label}`,
      reworkQuantity: 1,
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
          customProcessName: `工资工序-${label}`,
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
    const configurationItemId =
      approved.value.configuration!.items[0]!.configurationItemId;
    const task = await reporting.createTask(
      tailActor("work:assign"),
      draft.value.reworkOrderId,
      {
        expectedOrderVersion: approved.value.orderVersion,
        configurationItemId,
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
        completedAt: new Date().toISOString(),
      },
      randomUUID(),
    );
    return draft.value.reworkOrderId;
  }

  async function createPastReviewedWage(label: string) {
    const orderId = await createCompletedWork(label);
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const tail = tailActor("submission:audit");
      const eventId = await events.append(client, tail, {
        action: "rework.whole_order.approve",
        entityType: "rework_order",
        entityId: orderId,
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
         ) VALUES($1,$2,$3,CURRENT_TIMESTAMP-interval '2 months',$4)`,
        [randomUUID(), orderId, ids.tail, { label }],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const currentMonth = new Date().toISOString().slice(0, 7);
    return (await wage.list(tailActor())).find(
      (period) => period.periodMonth < currentMonth,
    )!;
  }

  beforeAll(async () => {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    for (const migration of migrations) {
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
      [ids.administrative, "Administrative", "administrative_clerk"],
      [ids.monthClose, "Month Close", "wage_month_close_accountant"],
      [ids.otherAdmin, "Other Admin", "system_admin"],
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
          reason: "wage workflow fixture",
        },
      )
    ).personId;
  });

  afterAll(async () => {
    await database.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  });

  it("runs materialization, adjustment, review, month close and export", async () => {
    const period = await createPastReviewedWage("lifecycle");
    expect(period).toMatchObject({
      status: "pending_tail_review",
      sourceItemCount: 1,
      personCount: 1,
      originalTotal: "1.00",
      finalTotal: "1.00",
    });
    const detail = await wage.get(tailActor(), period.periodId);
    const item = detail.items[0]!;
    const attachmentId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'adjustment.pdf','application/pdf',1,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [attachmentId, `private/${attachmentId}.pdf`, "a".repeat(64), ids.tail],
    );
    const adjustmentKey = randomUUID();
    const input = {
      originalWageItemId: item.wageItemId,
      targetPeriodId: period.periodId,
      adjustmentAmount: "0.01",
      reason: "补一分钱",
      attachmentIds: [attachmentId],
      expectedVersion: period.periodVersion,
    } as const;
    const adjustment = await wage.requestAdjustment(
      tailActor(),
      input,
      adjustmentKey,
    );
    const replay = await wage.requestAdjustment(
      tailActor(),
      input,
      adjustmentKey,
    );
    expect(replay.reused).toBe(true);
    expect(replay.value.adjustmentId).toBe(adjustment.value.adjustmentId);
    expect((await database.query(
      "SELECT entity_type,entity_id FROM attachments WHERE attachment_id=$1",
      [attachmentId],
    )).rows[0]).toEqual({
      entity_type: "wage_adjustment",
      entity_id: adjustment.value.adjustmentId,
    });
    await wage.decideAdjustment(
      administrativeActor(),
      adjustment.value.adjustmentId,
      adjustment.value.version,
      true,
      null,
      randomUUID(),
    );
    const restarted = await wage.get(tailActor(), period.periodId);
    expect(restarted.period).toMatchObject({
      status: "pending_tail_review",
      adjustmentTotal: "0.01",
      finalTotal: "1.01",
    });
    await expect(wage.review(
      actor(
        ids.otherAdmin,
        ["system_admin"],
        "wage:view",
        "wage:view",
        "wage:tail_review",
      ),
      period.periodId,
      restarted.period.periodVersion,
      "tail",
      null,
      randomUUID(),
    )).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    const tailKey = randomUUID();
    const tailApproved = await wage.review(
      tailActor(),
      period.periodId,
      restarted.period.periodVersion,
      "tail",
      null,
      tailKey,
    );
    expect((await wage.review(
      tailActor(),
      period.periodId,
      restarted.period.periodVersion,
      "tail",
      null,
      tailKey,
    )).reused).toBe(true);
    const administrativeApproved = await wage.review(
      administrativeActor(),
      period.periodId,
      tailApproved.value.periodVersion,
      "administrative_approve",
      null,
      randomUUID(),
    );
    const locked = await wage.lock(
      monthCloseActor(),
      period.periodId,
      administrativeApproved.value.periodVersion,
      "测试月结",
      randomUUID(),
    );
    expect(locked.value.status).toBe("locked");
    const workbook = await exporter.export(
      administrativeActor(),
      period.periodId,
    );
    expect(workbook.filename).toContain("工资月结");
    expect(workbook.content.subarray(0, 2).toString()).toBe("PK");
    await expect(database.query(
      "UPDATE rework_wage_periods SET final_total=0 WHERE period_id=$1",
      [period.periodId],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      "UPDATE rework_wage_adjustments SET adjustment_amount=9 WHERE adjustment_id=$1",
      [adjustment.value.adjustmentId],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("rejects locking the current natural month", async () => {
    const orderId = await createCompletedWork("current");
    const view = await orderReview.get(
      tailActor("submission:audit"),
      orderId,
    );
    await orderReview.approve(
      tailActor("submission:audit"),
      orderId,
      { expectedOrderVersion: view.orderVersion },
      randomUUID(),
    );
    const currentMonth = new Date().toISOString().slice(0, 7);
    const current = (await wage.list(tailActor())).find(
      (period) => period.periodMonth.startsWith(currentMonth),
    )!;
    const tailApproved = await wage.review(
      tailActor(),
      current.periodId,
      current.periodVersion,
      "tail",
      null,
      randomUUID(),
    );
    const administrativeApproved = await wage.review(
      administrativeActor(),
      current.periodId,
      tailApproved.value.periodVersion,
      "administrative_approve",
      null,
      randomUUID(),
    );
    await expect(wage.lock(
      monthCloseActor(),
      current.periodId,
      administrativeApproved.value.periodVersion,
      null,
      randomUUID(),
    )).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });
});
