import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

runWithPostgres("work reporting PostgreSQL contracts", () => {
  const schema = "work_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({ connectionString: databaseUrl!, options: "-c search_path=" + schema });
  const access = new AccessMasterDataService(database, "corp");
  const initiation = new ReworkInitiationService(database, "corp");
  const configuration = new ProcessConfigurationService(database);
  const reporting = new WorkReportingService(database);
  const ids = {
    admin: randomUUID(),
    qc: randomUUID(),
    tail: randomUUID(),
    ie: randomUUID(),
    merchandiser: randomUUID(),
    ineligibleWorker: randomUUID(),
    proxy: randomUUID(),
    workers: Array.from({ length: 40 }, () => randomUUID()),
  };
  let ineligiblePersonId = "";
  let temporaryPersonId = "";
  let workerPersonIds: string[] = [];

  const actor = (actorId: string, actorRoles: readonly string[], authorizationCapability: string): TrustedActorContext => ({
    actorId, actorRoles, authorizationCapability, requestId: randomUUID(),
  });
  const administrator = () => actor(ids.admin, ["system_admin"], "master_data:manage");
  const qc = () => actor(ids.qc, ["quality_control"], "rework:initiate");
  const tail = () => actor(ids.tail, ["tail_supervisor"], "process:configure");
  const tailAssign = () => actor(ids.tail, ["tail_supervisor"], "work:assign");
  const ie = () => actor(ids.ie, ["ie_reviewer"], "process:review");
  const worker = (workerId: string) => actor(workerId, ["worker"], "work:report");

  beforeAll(async () => {
    await admin.query("CREATE SCHEMA " + schema);
    for (const migration of [
      "0001_platform_foundation.sql", "0002_dingtalk_identity_access.sql", "0003_identity_union_continuity.sql",
      "0004_public_tools_foundation.sql", "0005_access_master_data.sql", "0006_rework_initiation.sql",
      "0007_process_configuration_ie_review.sql", "0008_worker_assignment_reporting.sql",
      "0009_whole_order_review_quantity_adjustment.sql", "0039_practical_quantity_amount_precision.sql",
    ]) {
      await database.query(await readFile(new URL("../../apps/api/migrations/" + migration, import.meta.url), "utf8"));
    }
    const users = [
      [ids.admin, "系统管理员"], [ids.qc, "品控一"], [ids.tail, "李同生"],
      [ids.ie, "郎飞"], [ids.merchandiser, "订单跟单"], [ids.ineligibleWorker, "未授权员工"], [ids.proxy, "授权代录"],
      ...ids.workers.map((userId, index) => [userId, "工人" + String(index + 1)]),
    ] as const;
    for (const [userId, displayName] of users) {
      await database.query("INSERT INTO app_users(id,display_name) VALUES($1,$2)", [userId, displayName]);
      await database.query(
        "INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)",
        [randomUUID(), userId, "ding-" + userId, "union-" + userId],
      );
    }
    const assignments: Array<readonly [string, string]> = [
      [ids.admin, "system_admin"], [ids.qc, "quality_control"], [ids.tail, "tail_supervisor"],
      [ids.ie, "ie_reviewer"], [ids.merchandiser, "order_merchandiser"], [ids.proxy, "order_merchandiser"],
      ...ids.workers.map((userId) => [userId, "worker"] as const),
    ];
    for (const [userId, roleCode] of assignments) {
      await database.query(
        "INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$2,'controlled bootstrap')",
        [randomUUID(), userId, roleCode],
      );
    }
    await access.ensureOrganizationPolicy();
    ineligiblePersonId = (await access.createPerson(administrator(), {
      personType: "internal", appUserId: ids.ineligibleWorker, displayName: "未授权员工", aliases: [], reason: "验证无工人角色不可分配",
    })).personId;
    temporaryPersonId = (await access.createPerson(administrator(), {
      personType: "temporary", displayName: "临时工一", aliases: [], reason: "验证授权人员代录",
    })).personId;
    workerPersonIds = await Promise.all(ids.workers.map(async (userId, index) => (
      await access.createPerson(administrator(), {
        personType: "internal", appUserId: userId, displayName: "工人" + String(index + 1), aliases: [], reason: "建立可上数工人档案",
      })
    ).personId));
  });

  afterAll(async () => {
    await database.end();
    await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    await admin.end();
  });

  it("only assigns report-eligible people, splits a realistic 40-person hourly amount, advances a completed order, and reserves ERP mappings", async () => {
    const draft = await initiation.createDraft(qc(), {
      styleNo: "PD20700001", merchandiserUserId: ids.merchandiser, processingFactory: { type: "own_factory" },
      problemPart: "袖口", problemDescription: "全量返修", reworkQuantity: 1,
    }, randomUUID());
    const submitted = await initiation.submit(qc(), draft.value.reworkOrderId, { expectedVersion: draft.value.version }, randomUUID());
    const saved = await configuration.saveDraft(tail(), submitted.value.reworkOrderId, {
      expectedOrderVersion: submitted.value.version,
      items: [{ source: "custom", customProcessName: "集体返工工序", pricingUnit: "hour", plannedQuantity: 1.5, unitPrice: 12.5 }],
    }, randomUUID());
    const queued = await configuration.submit(tail(), submitted.value.reworkOrderId, {
      expectedOrderVersion: saved.value.orderVersion,
      expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
    }, randomUUID());
    const approved = await configuration.review(ie(), submitted.value.reworkOrderId, {
      expectedOrderVersion: queued.value.orderVersion,
      expectedConfigurationVersion: queued.value.configuration!.configurationVersion,
      decision: "approved",
    }, randomUUID());
    const configurationItemId = approved.value.configuration!.items[0]!.configurationItemId;

    await expect(reporting.createTask(tailAssign(), submitted.value.reworkOrderId, {
      expectedOrderVersion: approved.value.orderVersion,
      configurationItemId, mode: "individual", members: [{ personId: ineligiblePersonId }],
    }, randomUUID())).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });

    const task = await reporting.createTask(tailAssign(), submitted.value.reworkOrderId, {
      expectedOrderVersion: approved.value.orderVersion,
      configurationItemId, mode: "collective", members: workerPersonIds.map((personId) => ({ personId })),
    }, randomUUID());
    const inProgress = await reporting.list(tailAssign(), submitted.value.reworkOrderId);
    expect(inProgress.reworkStatus).toBe("in_progress");

    const dualWorker: TrustedActorContext = {
      ...worker(ids.workers[0]!),
      authorizationCapabilities: ["work:report", "work:report_for_worker"],
    };
    const report = await reporting.submitReport(dualWorker, task.value.workTaskId, {
      expectedOrderVersion: inProgress.orderVersion, actualQuantity: 1.5, completedAt: new Date().toISOString(),
    }, randomUUID());
    expect(report.value.groupAmount).toBeNull();
    expect([0.468, 0.469]).toContain(report.value.memberShares[0]?.amount);
    expect((await reporting.list(tailAssign(), submitted.value.reworkOrderId)).reworkStatus).toBe("pending_order_review");
    expect((await database.query(
      "SELECT group_amount::numeric(18,3)::text AS group_amount FROM rework_work_reports WHERE work_report_id=$1",
      [report.value.workReportId],
    )).rows[0]).toEqual({ group_amount: "18.750" });
    expect((await database.query(
      `SELECT amount::numeric(18,3)::text AS amount,count(*)::int AS count
       FROM rework_work_report_member_shares
       WHERE work_report_id=$1
       GROUP BY amount
       ORDER BY amount`,
      [report.value.workReportId],
    )).rows).toEqual([
      { amount: "0.468", count: 10 },
      { amount: "0.469", count: 30 },
    ]);
    expect((await database.query<{ authorization_capability: string }>(
      "SELECT authorization_capability FROM operation_events WHERE entity_id=$1 AND action='rework.work_report.submit'",
      [submitted.value.reworkOrderId],
    )).rows).toEqual([{ authorization_capability: "work:report" }]);

    const externalMappings = await database.query<{ table_name: string; column_name: string }>(
      `SELECT table_name,column_name
       FROM information_schema.columns
       WHERE table_schema=$1 AND table_name=ANY($2::text[])
         AND column_name=ANY($3::text[])
       ORDER BY table_name,column_name`,
      [schema, ["rework_work_tasks", "rework_work_reports"], ["source_system", "external_id", "external_idempotency_key", "erp_node_id"]],
    );
    expect(externalMappings.rows).toHaveLength(8);
  });

  it("allows a delegated non-supervisor to proxy report a temporary worker task", async () => {
    const draft = await initiation.createDraft(qc(), {
      styleNo: "PD20700002", merchandiserUserId: ids.merchandiser, processingFactory: { type: "own_factory" },
      problemPart: "袖口", problemDescription: "临时工返修", reworkQuantity: 1,
    }, randomUUID());
    const submitted = await initiation.submit(qc(), draft.value.reworkOrderId, { expectedVersion: draft.value.version }, randomUUID());
    const saved = await configuration.saveDraft(tail(), submitted.value.reworkOrderId, {
      expectedOrderVersion: submitted.value.version,
      items: [{ source: "custom", customProcessName: "临时工代录工序", pricingUnit: "piece", plannedQuantity: 1, unitPrice: 1 }],
    }, randomUUID());
    const queued = await configuration.submit(tail(), submitted.value.reworkOrderId, {
      expectedOrderVersion: saved.value.orderVersion,
      expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
    }, randomUUID());
    const approved = await configuration.review(ie(), submitted.value.reworkOrderId, {
      expectedOrderVersion: queued.value.orderVersion,
      expectedConfigurationVersion: queued.value.configuration!.configurationVersion,
      decision: "approved",
    }, randomUUID());
    const internalTask = await reporting.createTask(tailAssign(), submitted.value.reworkOrderId, {
      expectedOrderVersion: approved.value.orderVersion,
      configurationItemId: approved.value.configuration!.items[0]!.configurationItemId,
      mode: "individual", members: [{ personId: workerPersonIds[1]! }],
    }, randomUUID());
    const inProgress = await reporting.list(tailAssign(), submitted.value.reworkOrderId);
    const task = await reporting.createTask(tailAssign(), submitted.value.reworkOrderId, {
      expectedOrderVersion: inProgress.orderVersion,
      configurationItemId: approved.value.configuration!.items[0]!.configurationItemId,
      mode: "individual", members: [{ personId: temporaryPersonId }],
    }, randomUUID());
    const proxy: TrustedActorContext = {
      ...actor(ids.proxy, ["order_merchandiser"], "work:report"),
      authorizationCapabilities: ["work:report", "work:report_for_worker"],
    };
    const delegatedTasks = await reporting.list(proxy, submitted.value.reworkOrderId);
    expect(delegatedTasks.tasks.map((assigned) => assigned.workTaskId)).toEqual([task.value.workTaskId]);
    expect(delegatedTasks.tasks.map((assigned) => assigned.workTaskId)).not.toContain(internalTask.value.workTaskId);
    const report = await reporting.submitReport(
      proxy,
      task.value.workTaskId,
      { expectedOrderVersion: delegatedTasks.orderVersion, actualQuantity: 1, completedAt: new Date().toISOString() },
      randomUUID(),
    );
    expect((await database.query<{ authorization_capability: string }>(
      "SELECT authorization_capability FROM operation_events WHERE entity_id=$1 AND action='rework.work_report.submit'",
      [submitted.value.reworkOrderId],
    )).rows).toEqual([{ authorization_capability: "work:report_for_worker" }]);
    expect(report.value.groupAmount).toBe(1);
    expect(report.value.memberShares).toEqual([{ personId: temporaryPersonId, amount: 1 }]);
  });
});
