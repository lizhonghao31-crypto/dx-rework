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
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { completeInspectionReport } from "../inspection-report-fixture.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;
type Manifest = { migrations: Array<{ version: string; checksum: string }> };

runWithPostgres("PR-03 process-worker preassignment PostgreSQL", () => {
  const schema = `rework_v2_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  const access = new AccessMasterDataService(database, "corp");
  const initiation = new ReworkInitiationService(database, "corp");
  const configuration = new ProcessConfigurationService(database);
  const workerPlan = new ProcessWorkerPlanService(database);

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
        "INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$2,'PR-03 postgres fixture')",
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
      reason: "PR-03 PostgreSQL 预分配工人",
    })).personId;
    processId = (await access.createProcess(owner(), {
      processCode: "PR03PROC",
      processName: "PR03返修工序",
      pricingUnit: "piece",
      active: true,
      changeReason: "PR-03 PostgreSQL 工序",
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
      problemPart: "袖口",
      problemDescription: "PR-03 预分配验收",
      reworkQuantity: 10,
      inspectionReport: completeInspectionReport(),
      attachmentIds: [attachmentId],
    }, randomUUID());
    return initiation.submit(qc(), draft.value.reworkOrderId, {
      expectedVersion: draft.value.version,
    }, randomUUID());
  };

  const saveConfiguration = async (reworkOrderId: string, expectedOrderVersion: number) =>
    configuration.saveDraft(tailConfigure(), reworkOrderId, {
      expectedOrderVersion,
      items: [{
        source: "catalog",
        processId,
        plannedQuantity: 1,
        pricingUnit: "piece",
        unitPrice: 0.6,
      }],
    }, randomUUID());

  it("blocks IE submission until every process has workers, then auto-activates the approved plan", async () => {
    const order = await createSubmittedOrder("PR03-PG-ORDINARY");
    const saved = await saveConfiguration(order.value.reworkOrderId, order.value.version);
    const configurationId = saved.value.configuration!.configurationId;
    const configurationVersion = saved.value.configuration!.configurationVersion;
    const itemId = saved.value.configuration!.items[0]!.configurationItemId;

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
      assignments: [{ configurationItemId: itemId, memberIds: [workerPersonId] }],
    }, randomUUID());
    expect(planned.value).toMatchObject({ required: true, complete: true });
    await expect(workerPlan.assertReadyForSubmit(order.value.reworkOrderId, configurationVersion)).resolves.toBe(true);

    const submitted = await configuration.submit(tailConfigure(), order.value.reworkOrderId, {
      expectedOrderVersion: saved.value.orderVersion,
      expectedConfigurationVersion: configurationVersion,
      tailInspectors: [{ userId: ids.tailInspector, boxScope: "PR-03" }],
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
    expect(activated).toMatchObject({ reworkStatus: "in_progress", tasksCreated: 1 });
    expect((await database.query("SELECT status FROM rework_orders WHERE rework_order_id=$1", [order.value.reworkOrderId])).rows[0]?.status).toBe("in_progress");
    expect((await database.query(
      `SELECT task.status,member.person_id
       FROM rework_work_tasks task
       JOIN rework_work_task_members member ON member.work_task_id=task.work_task_id
       WHERE task.rework_order_id=$1`,
      [order.value.reworkOrderId],
    )).rows).toEqual([{ status: "active", person_id: workerPersonId }]);
    await expect(database.query(
      "UPDATE rework_process_worker_plans SET planned_by=$2 WHERE configuration_id=$1",
      [configurationId, ids.owner],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("lets Root save a worker plan without any ordinary business-role assignment", async () => {
    const order = await createSubmittedOrder("PR03-PG-ROOT");
    const saved = await saveConfiguration(order.value.reworkOrderId, order.value.version);
    const rootUser: AuthUser = { id: ids.root, displayName: "Root", capabilities: [], businessRoles: [] };
    const rootAssign = await businessActor(
      rootAuthority,
      rootUser,
      randomUUID(),
      "work:assign",
      "tail_supervisor",
    );

    const planned = await workerPlan.save(rootAssign, order.value.reworkOrderId, {
      expectedOrderVersion: saved.value.orderVersion,
      configurationId: saved.value.configuration!.configurationId,
      expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
      assignments: [{
        configurationItemId: saved.value.configuration!.items[0]!.configurationItemId,
        memberIds: [workerPersonId],
      }],
    }, randomUUID());
    expect(planned.value.complete).toBe(true);
    expect((await database.query(
      "SELECT planned_by FROM rework_process_worker_plans WHERE configuration_id=$1",
      [saved.value.configuration!.configurationId],
    )).rows[0]?.planned_by).toBe(ids.root);
  });
});
