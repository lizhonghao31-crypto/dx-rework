import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  CreateWorkReportSchema,
  ReviewProcessConfigurationSchema,
  SaveProcessConfigurationSchema,
  SubmitProcessConfigurationSchema,
} from "@dx-rework/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ProcessWorkerPlanService } from "../../apps/api/src/rework/process-worker-plan-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { WholeOrderReviewService } from "../../apps/api/src/rework/whole-order-review-service.js";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;
type Manifest = { migrations: Array<{ version: string; checksum: string }> };

const inspectionReport = {
  schemaVersion: 1 as const,
  styleName: "test-不整查-N05",
  inspectionStage: "final" as const,
  inspectionLocation: "尾部质检区",
  color: "黑色",
  sampleQuantity: 10,
  measurementUnit: "cm" as const,
  measurementPrecision: 0.1 as const,
  sizeSamples: [],
  documentChecks: {
    confirmationSample: false,
    approvalCard: false,
    supplierSelfInspection: false,
    bulkFabricInspection: false,
    exceptionReason: null,
  },
  fabricMatch: null,
  fabricMismatchReason: null,
  fitDecision: null,
  factoryPreparation: null,
  materialChecks: { physicalPerformance: null, washTest: null, productMarking: null },
  issues: [],
  nonconformanceCause: null,
  approvalOpinion: null,
  supplierSignatoryName: null,
  supplierSignedOn: null,
  inspectionDate: null,
  disposition: "rework" as const,
};

runWithPostgres("optional tail inspection PostgreSQL closure", () => {
  const schema = `optional_tail_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });
  const access = new AccessMasterDataService(database, "corp");
  const initiation = new ReworkInitiationService(database, "corp");
  const configuration = new ProcessConfigurationService(database);
  const workerPlan = new ProcessWorkerPlanService(database);
  const reporting = new WorkReportingService(database);
  const review = new WholeOrderReviewService(database);
  const ids = {
    owner: randomUUID(),
    qc: randomUUID(),
    tail: randomUUID(),
    ie: randomUUID(),
    worker: randomUUID(),
    workerTwo: randomUUID(),
    workerThree: randomUUID(),
    merchandiser: randomUUID(),
  };
  let workerPersonIds: string[] = [];

  const actor = (
    actorId: string,
    actorRoles: readonly string[],
    authorizationCapability: string,
    ...otherCapabilities: string[]
  ): TrustedActorContext => ({
    actorId,
    actorRoles,
    authorizationCapability,
    authorizationCapabilities: Array.from(new Set([authorizationCapability, ...otherCapabilities])),
    requestId: randomUUID(),
  });
  const owner = () => actor(ids.owner, ["owner_group"], "master_data:manage");
  const qc = () => actor(ids.qc, ["quality_control"], "rework:initiate");
  const tailConfigure = () => actor(ids.tail, ["tail_supervisor"], "process:configure");
  const tailAssign = () => actor(ids.tail, ["tail_supervisor"], "work:assign", "work:report_for_worker");
  const tailAudit = () => actor(ids.tail, ["tail_supervisor"], "submission:audit");
  const ie = () => actor(ids.ie, ["ie_reviewer"], "process:review");
  const worker = () => actor(ids.worker, ["worker"], "work:report");

  beforeAll(async () => {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const manifest = JSON.parse(await readFile(
      new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url),
      "utf8",
    )) as Manifest;
    await database.query(`
      CREATE TABLE schema_migrations (
        version text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    for (const migration of manifest.migrations) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration.version}.sql`, import.meta.url),
        "utf8",
      ));
      await database.query(
        "INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",
        [migration.version, migration.checksum],
      );
    }

    const users = [
      [ids.owner, "老板", "owner_group"],
      [ids.qc, "质检", "quality_control"],
      [ids.tail, "尾部主管", "tail_supervisor"],
      [ids.ie, "IE", "ie_reviewer"],
      [ids.worker, "工人", "worker"],
      [ids.workerTwo, "工人二", "worker"],
      [ids.workerThree, "工人三", "worker"],
      [ids.merchandiser, "订单跟单", "order_merchandiser"],
    ] as const;
    for (const [userId, displayName, roleCode] of users) {
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
         ) VALUES($1,$2,$3,$2,'optional-tail fixture')`,
        [randomUUID(), userId, roleCode],
      );
    }
    await access.ensureOrganizationPolicy();
    workerPersonIds = await Promise.all([
      [ids.worker, "工人"],
      [ids.workerTwo, "工人二"],
      [ids.workerThree, "工人三"],
    ].map(async ([appUserId, displayName]) => (await access.createPerson(owner(), {
      personType: "internal",
      appUserId,
      displayName,
      aliases: [],
      reason: "不整查全链回归",
    })).personId));
  });

  afterAll(async () => {
    await database.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  });

  it("moves an explicitly no-tail order through N06 approval without a tail fact", async () => {
    const attachmentId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'test-optional-tail.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [attachmentId, `private/${attachmentId}.webp`, "a".repeat(64), ids.qc],
    );
    const draft = await initiation.createDraft(qc(), {
      styleNo: "test-optional-tail-n05",
      orderQuantity: 100,
      orderNo: "test-optional-tail-n05",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "own_factory" },
      inspectionReport,
      problemPart: "袖口",
      problemDescription: "test-不整查-N05",
      reworkQuantity: 10,
      tailInspectionRequired: false,
      attachmentIds: [attachmentId],
    }, randomUUID());
    const submitted = await initiation.submit(
      qc(),
      draft.value.reworkOrderId,
      { expectedVersion: draft.value.version },
      randomUUID(),
    );
    expect(submitted.value.tailInspectionRequired).toBe(false);

    const saved = await configuration.saveDraft(
      tailConfigure(),
      draft.value.reworkOrderId,
      SaveProcessConfigurationSchema.parse({
        expectedOrderVersion: submitted.value.version,
        items: [{
          source: "custom",
          customProcessName: "test-不整查工序",
          executionKind: "worker",
          plannedQuantity: 10,
          pricingUnit: "piece",
          unitPrice: 0.2,
        }],
      }),
      randomUUID(),
      randomUUID(),
    );
    const workerItem = saved.value.configuration!.items[0]!;
    const planned = await workerPlan.save(
      tailAssign(),
      draft.value.reworkOrderId,
      {
        expectedOrderVersion: saved.value.orderVersion,
        configurationId: saved.value.configuration!.configurationId,
        expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
        assignments: [{ configurationItemId: workerItem.configurationItemId, memberIds: workerPersonIds }],
      },
      randomUUID(),
    );
    expect(planned.value).toMatchObject({ required: true, complete: true });
    const queued = await configuration.submit(
      tailConfigure(),
      draft.value.reworkOrderId,
      SubmitProcessConfigurationSchema.parse({
        expectedOrderVersion: saved.value.orderVersion,
        expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
      }),
      randomUUID(),
    );
    const approved = await configuration.review(
      ie(),
      draft.value.reworkOrderId,
      ReviewProcessConfigurationSchema.parse({
        expectedOrderVersion: queued.value.orderVersion,
        expectedConfigurationVersion: queued.value.configuration!.configurationVersion,
        decision: "approved",
      }),
      randomUUID(),
    );
    const activated = await workerPlan.activateAfterIeApproval(
      draft.value.reworkOrderId,
      approved.value.configuration!.configurationVersion,
      randomUUID(),
    );
    expect(activated).toMatchObject({ reworkStatus: "in_progress", tasksCreated: 1 });

    const tasks = await reporting.list(tailAssign(), draft.value.reworkOrderId);
    expect(tasks.tasks).toHaveLength(1);
    expect(tasks.tasks[0]).toMatchObject({ executionKind: "worker", mode: "collective" });
    await reporting.submitReport(
      worker(),
      tasks.tasks[0]!.workTaskId,
      CreateWorkReportSchema.parse({
        expectedOrderVersion: tasks.orderVersion,
        actualQuantity: 10,
        completedAt: new Date().toISOString(),
      }),
      randomUUID(),
    );

    const n05 = await review.get(tailAudit(), draft.value.reworkOrderId);
    expect(n05).toMatchObject({
      reworkStatus: "pending_order_review",
      tailInspectionRequired: false,
      processes: [expect.objectContaining({
        configurationItemId: workerItem.configurationItemId,
        completedQuantity: 10,
        tailCheckedQuantity: 0,
        complete: true,
      })],
    });
    const confirmed = await review.approve(
      tailAudit(),
      draft.value.reworkOrderId,
      {
        expectedOrderVersion: n05.orderVersion,
        finalQuantities: [{
          configurationItemId: workerItem.configurationItemId,
          finalConfirmedQuantity: 10,
        }],
        processPrices: [{
          configurationItemId: workerItem.configurationItemId,
          unitPrice: 0.25,
        }],
        temporaryCoefficients: [],
      },
      randomUUID(),
    );
    expect(confirmed.value.reworkStatus).toBe("pending_final_quantity_ie_review");
    expect(confirmed.value.finalConfirmation?.prices).toEqual([{
      configurationItemId: workerItem.configurationItemId,
      originalUnitPrice: 0.2,
      proposedUnitPrice: 0.25,
      changed: true,
    }]);
    expect((await database.query(
      "SELECT unit_price::text FROM rework_process_configuration_items WHERE configuration_item_id=$1",
      [workerItem.configurationItemId],
    )).rows).toEqual([{ unit_price: "0.200" }]);
    expect((await database.query(
      `SELECT worker_reported_quantity::text,tail_reported_quantity::text,final_confirmed_quantity::text
       FROM rework_tail_completion_quantities quantity
       JOIN rework_tail_completion_confirmations confirmation USING(confirmation_id)
       WHERE confirmation.rework_order_id=$1`,
      [draft.value.reworkOrderId],
    )).rows).toEqual([{
      worker_reported_quantity: "10.00",
      tail_reported_quantity: "0.00",
      final_confirmed_quantity: "10.00",
    }]);

    const ieApproved = await review.reviewFinalQuantity(
      ie(),
      draft.value.reworkOrderId,
      {
        expectedOrderVersion: confirmed.value.orderVersion,
        decision: "approved",
      },
      randomUUID(),
    );
    expect(ieApproved.value).toMatchObject({
      reworkStatus: "pending_responsibility_determination",
      tailInspectionRequired: false,
    });
    expect(ieApproved.value.orderVersion).toBe(confirmed.value.orderVersion + 1);
    expect((await database.query(
      `SELECT report.settlement_quantity::text,report.group_amount::text
       FROM rework_work_reports report
       WHERE report.rework_order_id=$1 AND report.status='submitted'`,
      [draft.value.reworkOrderId],
    )).rows).toEqual([{
      settlement_quantity: "10.00",
      group_amount: "2.499",
    }]);
    expect((await database.query(
      `SELECT amount::text FROM rework_work_report_member_shares share
       JOIN rework_work_reports report USING(work_report_id)
       WHERE report.rework_order_id=$1 ORDER BY share.person_id`,
      [draft.value.reworkOrderId],
    )).rows).toEqual([
      { amount: "0.833" },
      { amount: "0.833" },
      { amount: "0.833" },
    ]);
    expect((await database.query(
      "SELECT unit_price::text FROM rework_process_configuration_items WHERE configuration_item_id=$1",
      [workerItem.configurationItemId],
    )).rows).toEqual([{ unit_price: "0.250" }]);
    expect((await database.query(
      `SELECT count(*)::int AS count,bool_and(reviewed_by=$2) AS reviewed_by_ie
       FROM rework_order_reviews WHERE rework_order_id=$1`,
      [draft.value.reworkOrderId, ids.ie],
    )).rows).toEqual([{ count: 1, reviewed_by_ie: true }]);
  });
});
