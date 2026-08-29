import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { businessActor } from "../../apps/api/src/access/business-authority.js";
import { RootAuthority } from "../../apps/api/src/access/root-authority.js";
import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import type { AuthUser } from "../../apps/api/src/auth/service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ProcessWorkerPlanService } from "../../apps/api/src/rework/process-worker-plan-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { ReworkV2SubmissionService } from "../../apps/api/src/rework/v2-submission-service.js";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { completeInspectionReport } from "../inspection-report-fixture.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;
type Manifest = { migrations: Array<{ version: string; checksum: string }> };

runWithPostgres("PR-04 unified execution PostgreSQL", () => {
  const schema = `rework_v2_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  const access = new AccessMasterDataService(database, "corp");
  const initiation = new ReworkInitiationService(database, "corp");
  const v2Submission = new ReworkV2SubmissionService(database, "corp");
  const configuration = new ProcessConfigurationService(database);
  const workerPlan = new ProcessWorkerPlanService(database);
  const workReporting = new WorkReportingService(database);

  const ids = {
    owner: randomUUID(),
    root: randomUUID(),
    qc: randomUUID(),
    tail: randomUUID(),
    ie: randomUUID(),
    worker: randomUUID(),
    merchandiser: randomUUID(),
    tailInspector: randomUUID(),
  };
  const rootDingtalkUserId = `pr03-root-${randomUUID()}`;
  let workerPersonId = "";
  let tailPersonId = "";
  let processId = "";
  let rootAuthority: RootAuthority;

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
  const tailAssign = () => actor(ids.tail, ["tail_supervisor"], "work:assign");
  const ie = () => actor(ids.ie, ["ie_reviewer"], "process:review");
  const workerReport = () => actor(ids.worker, ["worker"], "work:report");
  const tailReport = () => actor(ids.tailInspector, ["tail_inspector"], "tail_inspection:report");

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
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
      [ids.owner, "老板", "owner_group", "owner"],
      [ids.qc, "品控", "quality_control", "qc"],
      [ids.tail, "尾部主管", "tail_supervisor", "tail"],
      [ids.ie, "IE", "ie_reviewer", "ie"],
      [ids.worker, "返工工人", "worker", "worker"],
      [ids.merchandiser, "订单跟单", "order_merchandiser", "merch"],
      [ids.tailInspector, "尾查", "tail_inspector", "tail-inspector"],
    ] as const;
    for (const [userId, displayName, roleCode, dingId] of users) {
      await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)", [userId, displayName]);
      await database.query(
        `INSERT INTO identity_mappings(
          id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at
        ) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
        [randomUUID(), userId, dingId, `union-${dingId}`],
      );
      await database.query(
        "INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$2,'PR-04 postgres fixture')",
        [randomUUID(), userId, roleCode],
      );
    }
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'Root',true)", [ids.root]);
    await database.query(
      `INSERT INTO identity_mappings(
        id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at
      ) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
      [randomUUID(), ids.root, rootDingtalkUserId, `union-${rootDingtalkUserId}`],
    );

    await access.ensureOrganizationPolicy();
    await database.query(
      "INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,$2,'corp')",
      [ids.root, rootDingtalkUserId],
    );
    rootAuthority = new RootAuthority(database, "corp", rootDingtalkUserId);
    await rootAuthority.assertConfigurationConsistency();

    workerPersonId = (await access.createPerson(owner(), {
      personType: "internal",
      appUserId: ids.worker,
      displayName: "返工工人",
      aliases: [],
      reason: "PR-04 PostgreSQL 预分配工人",
    })).personId;
    tailPersonId = (await access.createPerson(owner(), {
      personType: "internal",
      appUserId: ids.tailInspector,
      displayName: "尾查",
      aliases: [],
      reason: "PR-04 PostgreSQL 尾查特殊工序人员",
    })).personId;
    processId = (await access.createProcess(owner(), {
      processCode: "PR04PROC",
      processName: "PR04返修工序",
      pricingUnit: "piece",
      active: true,
      changeReason: "PR-04 PostgreSQL 工序",
    })).processId;
  });

  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  const createSubmittedOrder = async (styleNo: string) => {
    const attachmentId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
        attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at
      ) VALUES($1,$2,$3,'image/webp',10,$4,$5,'ready',CURRENT_TIMESTAMP)`,
      [attachmentId, `private/${attachmentId}.webp`, `${styleNo}.webp`, "a".repeat(64), ids.qc],
    );
    const draft = await initiation.createDraft(qc(), {
      styleNo,
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "own_factory" },
      tailInspectionCostBearer: "own_factory",
      problemPart: "袖口",
      problemDescription: "PR-04 统一执行验收",
      reworkQuantity: 10,
      inspectionReport: completeInspectionReport(),
      attachmentIds: [attachmentId],
    }, randomUUID());
    return v2Submission.submit(qc(), draft.value.reworkOrderId, {
      expectedVersion: draft.value.version,
    }, randomUUID());
  };

  const saveConfiguration = async (reworkOrderId: string, expectedOrderVersion: number) =>
    configuration.saveDraft(tailConfigure(), reworkOrderId, {
      expectedOrderVersion,
      items: [{
        source: "catalog",
        processId,
        executionKind: "worker",
        plannedQuantity: 1,
        pricingUnit: "piece",
        unitPrice: 0.6,
      }, {
        source: "custom",
        customProcessName: "尾查",
        executionKind: "tail_inspection",
        plannedQuantity: 1,
        pricingUnit: "piece",
        unitPrice: 0.2,
      }],
    }, randomUUID());

  it("blocks IE submission until every process has workers, then auto-activates the approved plan", async () => {
    const order = await createSubmittedOrder("PR04-PG-ORDINARY");
    const saved = await saveConfiguration(order.value.reworkOrderId, order.value.version);
    const configurationId = saved.value.configuration!.configurationId;
    const configurationVersion = saved.value.configuration!.configurationVersion;
    const workerItem = saved.value.configuration!.items.find((item) => item.executionKind === "worker")!;
    const tailItem = saved.value.configuration!.items.find((item) => item.executionKind === "tail_inspection")!;
    const itemId = workerItem.configurationItemId;

    expect((await database.query(
      "SELECT worker_preassignment_required AS required FROM rework_process_configurations WHERE configuration_id=$1",
      [configurationId],
    )).rows[0]?.required).toBe(true);

    await expect(workerPlan.assertReadyForSubmit(order.value.reworkOrderId, configurationVersion))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });

    const planned = await workerPlan.save(tailAssign(), order.value.reworkOrderId, {
      expectedOrderVersion: saved.value.orderVersion,
      configurationId,
      expectedConfigurationVersion: configurationVersion,
      assignments: [
        { configurationItemId: itemId, memberIds: [workerPersonId] },
        { configurationItemId: tailItem.configurationItemId, memberIds: [tailPersonId] },
      ],
    }, randomUUID());
    expect(planned.value).toMatchObject({ required: true, complete: true });
    await expect(workerPlan.assertReadyForSubmit(order.value.reworkOrderId, configurationVersion)).resolves.toBe(true);

    const submitted = await configuration.submit(tailConfigure(), order.value.reworkOrderId, {
      expectedOrderVersion: saved.value.orderVersion,
      expectedConfigurationVersion: configurationVersion,
      tailInspectors: [],
    }, randomUUID());
    expect(submitted.value.reworkStatus).toBe("pending_ie_review");

    const approved = await configuration.review(ie(), order.value.reworkOrderId, {
      expectedOrderVersion: submitted.value.orderVersion,
      expectedConfigurationVersion: configurationVersion,
      decision: "approved",
    }, randomUUID());
    expect(approved.value.reworkStatus).toBe("pending_task_assignment");

    const activated = await workerPlan.activateAfterIeApproval(
      order.value.reworkOrderId,
      configurationVersion,
      randomUUID(),
    );
    expect(activated).toMatchObject({ reworkStatus: "in_progress", tasksCreated: 2 });
    expect((await database.query("SELECT status FROM rework_orders WHERE rework_order_id=$1", [order.value.reworkOrderId])).rows[0]?.status).toBe("in_progress");
    expect((await database.query(
      `SELECT item.execution_kind,task.work_task_id,task.status,member.person_id
       FROM rework_work_tasks task
       JOIN rework_process_configuration_items item ON item.configuration_item_id=task.configuration_item_id
       JOIN rework_work_task_members member ON member.work_task_id=task.work_task_id
       WHERE task.rework_order_id=$1
       ORDER BY item.execution_kind`,
      [order.value.reworkOrderId],
    )).rows.map(({ execution_kind, status, person_id }) => ({ execution_kind, status, person_id }))).toEqual([
      { execution_kind: "tail_inspection", status: "active", person_id: tailPersonId },
      { execution_kind: "worker", status: "active", person_id: workerPersonId },
    ]);
    expect((await database.query(
      "SELECT count(*)::int AS count FROM rework_tail_inspection_assignments WHERE rework_order_id=$1",
      [order.value.reworkOrderId],
    )).rows[0]?.count).toBe(0);

    const activeTasks = (await database.query<{ work_task_id: string; execution_kind: "worker" | "tail_inspection" }>(
      `SELECT task.work_task_id,item.execution_kind
       FROM rework_work_tasks task
       JOIN rework_process_configuration_items item ON item.configuration_item_id=task.configuration_item_id
       WHERE task.rework_order_id=$1 AND task.status='active'`,
      [order.value.reworkOrderId],
    )).rows;
    const workerTask = activeTasks.find((task) => task.execution_kind === "worker")!;
    const tailTask = activeTasks.find((task) => task.execution_kind === "tail_inspection")!;
    const executionOrderVersion = activated!.orderVersion;
    await workReporting.submitReport(workerReport(), workerTask.work_task_id, {
      expectedOrderVersion: executionOrderVersion,
      actualQuantity: 8,
    }, randomUUID());
    await workReporting.submitReport(tailReport(), tailTask.work_task_id, {
      expectedOrderVersion: executionOrderVersion,
      actualQuantity: 10,
    }, randomUUID());
    expect((await database.query(
      "SELECT status FROM rework_orders WHERE rework_order_id=$1",
      [order.value.reworkOrderId],
    )).rows[0]?.status).toBe("pending_order_review");
    await expect(database.query(
      "UPDATE rework_process_worker_plans SET planned_by=$2 WHERE configuration_id=$1",
      [configurationId, ids.owner],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("lets Root save and batch-report a mixed worker and tail plan without ordinary role assignments", async () => {
    const order = await createSubmittedOrder("PR04-PG-ROOT");
    const saved = await saveConfiguration(order.value.reworkOrderId, order.value.version);
    const rootUser: AuthUser = { id: ids.root, displayName: "Root", capabilities: [], businessRoles: [] };
    const rootAssign = await businessActor(
      rootAuthority,
      rootUser,
      randomUUID(),
      "work:assign",
      "tail_supervisor",
    );

    const rootWorkerItem = saved.value.configuration!.items.find((item) => item.executionKind === "worker")!;
    const rootTailItem = saved.value.configuration!.items.find((item) => item.executionKind === "tail_inspection")!;
    const planned = await workerPlan.save(rootAssign, order.value.reworkOrderId, {
      expectedOrderVersion: saved.value.orderVersion,
      configurationId: saved.value.configuration!.configurationId,
      expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
      assignments: [
        { configurationItemId: rootWorkerItem.configurationItemId, memberIds: [workerPersonId] },
        { configurationItemId: rootTailItem.configurationItemId, memberIds: [tailPersonId] },
      ],
    }, randomUUID());
    expect(planned.value.complete).toBe(true);
    expect((await database.query(
      "SELECT planned_by FROM rework_process_worker_plans WHERE configuration_id=$1",
      [saved.value.configuration!.configurationId],
    )).rows[0]?.planned_by).toBe(ids.root);

    const submitted = await configuration.submit(tailConfigure(), order.value.reworkOrderId, {
      expectedOrderVersion: saved.value.orderVersion,
      expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
      tailInspectors: [],
    }, randomUUID());
    const approved = await configuration.review(ie(), order.value.reworkOrderId, {
      expectedOrderVersion: submitted.value.orderVersion,
      expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
      decision: "approved",
    }, randomUUID());
    await workerPlan.activateAfterIeApproval(
      order.value.reworkOrderId,
      approved.value.configuration!.configurationVersion,
      randomUUID(),
    );
    const rootReport = await businessActor(
      rootAuthority,
      rootUser,
      randomUUID(),
      "work:report_for_worker",
      "tail_supervisor",
    );
    const reportingView = await workReporting.list(rootReport, order.value.reworkOrderId);
    expect(reportingView.tasks.map((task) => task.executionKind).sort()).toEqual([
      "tail_inspection",
      "worker",
    ]);

    const batch = await workReporting.submitReportsBatch(rootReport, order.value.reworkOrderId, {
      expectedOrderVersion: reportingView.orderVersion,
      reports: reportingView.tasks.map((task) => ({
        workTaskId: task.workTaskId,
        actualQuantity: 5_500,
      })),
    }, randomUUID());
    expect(batch.value).toMatchObject({
      reworkOrderId: order.value.reworkOrderId,
      reworkStatus: "pending_order_review",
    });
    expect(batch.value.reports).toHaveLength(2);
    expect((await database.query(
      "SELECT count(*)::int AS count FROM rework_work_reports WHERE rework_order_id=$1",
      [order.value.reworkOrderId],
    )).rows[0]?.count).toBe(2);
  });
});
