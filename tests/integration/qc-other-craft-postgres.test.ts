import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  SaveProcessConfigurationSchema,
  CreateSupplierSchema,
} from "@dx-rework/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ProcessWorkerPlanService } from "../../apps/api/src/rework/process-worker-plan-service.js";
import { ReworkV2DraftService } from "../../apps/api/src/rework/v2-draft-service.js";
import { ResponsibilityDeterminationService } from "../../apps/api/src/rework/responsibility-determination-service.js";
import { ReworkBusinessDetailService } from "../../apps/api/src/rework/rework-business-detail-service.js";
import { OperationEventRepository } from "../../apps/api/src/tools/repositories.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { ReworkV2SubmissionService } from "../../apps/api/src/rework/v2-submission-service.js";
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

runWithPostgres("QC other craft PostgreSQL closure", () => {
  const schema = `qc_other_craft_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });
  const access = new AccessMasterDataService(database, "corp");
  const initiation = new ReworkInitiationService(database, "corp");
  const drafts = new ReworkV2DraftService(database, "corp");
  const v2Submission = new ReworkV2SubmissionService(database, "corp");
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

  const create = async (description: string | null = "拆线重新包边", bearer: "own_factory" | "processing_factory" = "own_factory") => {
    const supplier = bearer === "processing_factory" ? await access.createSupplier(owner(), CreateSupplierSchema.parse({
      supplierCode: `CRAFT-${randomUUID().slice(0, 8).toUpperCase()}`, supplierType: "factory", supplierName: "TEST-其他工艺加工厂", active: true, changeReason: "隔离测试",
    })) : null;
    const attachmentId = randomUUID();
    await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
      VALUES($1,$2,'test-craft.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
    [attachmentId, `private/${attachmentId}.webp`, "c".repeat(64), ids.qc]);
    return initiation.createDraft(qc(), {
      styleNo: `TEST-CRAFT-${randomUUID().slice(0, 8)}`, orderQuantity: 100,
      merchandiserUserId: ids.merchandiser, processingFactory: supplier ? { type: "supplier", supplierId: supplier.supplierId } : { type: "own_factory" },
      tailInspectionRequired: true, specialProcessType: "other_craft", otherCraftDescription: description,
      tailInspectionCostBearer: bearer, inspectionReport, attachmentIds: [attachmentId],
    }, randomUUID());
  };

  it("persists incomplete drafts, restores content through both update paths, and requires it at submission", async () => {
    const created = await create(null);
    const id = created.value.reworkOrderId;
    expect((await drafts.get(qc(), id)).otherCraftDescription).toBeNull();
    await expect(v2Submission.submit(qc(), id, { expectedVersion: 1 }, randomUUID()))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "请填写其他工艺内容" });
    const input = { expectedVersion: 1, styleNo: created.value.styleNo, merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "own_factory" as const }, tailInspectionRequired: true,
      tailInspectionCostBearer: "own_factory" as const, specialProcessType: "other_craft" as const,
      otherCraftDescription: "  拆线包边  " };
    const key = randomUUID();
    const saved = await drafts.save(qc(), id, input, key);
    expect(saved.value).toMatchObject({ specialProcessType: "other_craft", otherCraftDescription: "拆线包边" });
    expect((await drafts.save(qc(), id, input, key)).reused).toBe(true);
    // An older client omitting the new fields must retain the business subtype.
    const compatible = await initiation.updateDraft(qc(), id, { expectedVersion: saved.value.version, tailInspectionRequired: true }, randomUUID());
    expect(compatible.value).toMatchObject({ specialProcessType: "other_craft", otherCraftDescription: "拆线包边" });
    await expect(drafts.save(qc(), id, { ...input, expectedVersion: 1 }, randomUUID()))
      .rejects.toMatchObject({ code: "CONFLICT" });
    const off = await initiation.updateDraft(qc(), id, { expectedVersion: compatible.value.version, specialProcessType: "none", tailInspectionRequired: false }, randomUUID());
    expect(off.value).toMatchObject({ specialProcessType: "none", otherCraftDescription: null, tailInspectionCostBearer: null });
  });

  it("does not upgrade an old draft, including an API request forged outside the UI", async () => {
    const id = randomUUID(), actorContext = qc(), client = await database.connect();
    try {
      await client.query("BEGIN");
      const after = { reworkOrderId: id, reworkNo: null, status: "draft", styleNo: null,
        orderNo: null, orderQuantity: null, merchandiserUserId: null, processingFactory: null,
        problemPart: null, problemDescription: null, reworkQuantity: null, version: 1,
        tailInspectionRequired: true, tailInspectionCostBearer: null, tailInspectionCostBearerSource: null };
      const eventId = await new OperationEventRepository().append(client, actorContext, {
        action: "rework.draft.create", entityType: "rework_order", entityId: id, after,
      });
      await client.query("SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true)", [eventId, actorContext.requestId]);
      // Original pre-feature insert: no new columns, no disabled guards.
      await client.query("INSERT INTO rework_orders(rework_order_id,created_by,updated_by) VALUES($1,$2,$2)", [id, ids.qc]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    expect((await drafts.get(qc(), id)).specialProcessType).toBeNull();
    await expect(initiation.updateDraft(qc(), id, { expectedVersion: 1, specialProcessType: "other_craft", otherCraftDescription: "包边" }, randomUUID()))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const unchanged = await initiation.updateDraft(qc(), id, { expectedVersion: 1, tailInspectionRequired: false }, randomUUID());
    expect(unchanged.value).toMatchObject({ specialProcessType: null, tailInspectionRequired: false });
  });

  it("allows cancellation and Root deletion of incomplete other-craft drafts", async () => {
    const first = await create(null);
    const cancelled = await initiation.cancel(qc(), first.value.reworkOrderId, { expectedVersion: 1, reason: "隔离测试取消未填写的草稿" }, randomUUID());
    expect(cancelled.value.status).toBe("cancelled");
    const second = await create(null);
    const deleted = await initiation.deleteByRoot(actor(ids.owner, ["root_superuser"], "rework:delete"), second.value.reworkOrderId, randomUUID());
    expect(deleted.value.deleted).toBe(true);
  });

  const activate = async (description = "拆线重新包边", bearer: "own_factory" | "processing_factory" = "own_factory") => {
    const created = await create(description, bearer), id = created.value.reworkOrderId;
    const submitted = await v2Submission.submit(qc(), id, { expectedVersion: created.value.version }, randomUUID());
    const saved = await configuration.saveDraft(tailConfigure(), id, SaveProcessConfigurationSchema.parse({
      expectedOrderVersion: submitted.value.version,
      items: [
        { source: "custom", customProcessName: "test-返修一", plannedQuantity: 10, pricingUnit: "piece", unitPrice: 1 },
        { source: "custom", customProcessName: "test-返修二", plannedQuantity: 8, pricingUnit: "piece", unitPrice: 2 },
        { source: "custom", customProcessName: description, executionKind: "tail_inspection", plannedQuantity: 1, pricingUnit: "piece", unitPrice: 3.5 },
      ],
    }), randomUUID());
    const items = saved.value.configuration!.items;
    expect(items[2]?.processName).toBe(`其他工艺：${description}`);
    await workerPlan.save(tailAssign(), id, {
      expectedOrderVersion: saved.value.orderVersion, configurationId: saved.value.configuration!.configurationId,
      expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
      assignments: items.map((item, index) => ({ configurationItemId: item.configurationItemId, memberIds: [workerPersonIds[index]!] })),
    }, randomUUID());
    const queued = await configuration.submit(tailConfigure(), id, {
      expectedOrderVersion: saved.value.orderVersion, expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
    }, randomUUID());
    const approved = await configuration.review(ie(), id, {
      expectedOrderVersion: queued.value.orderVersion, expectedConfigurationVersion: queued.value.configuration!.configurationVersion,
      decision: "approved",
    }, randomUUID());
    await workerPlan.activateAfterIeApproval(id, approved.value.configuration!.configurationVersion, randomUUID());
    return { id, items, factory: created.value.processingFactory };
  };

  const reportAll = async (id: string, tailQuantity: number) => {
    const initial = await reporting.list(tailAssign(), id);
    const users = [ids.worker, ids.workerTwo, ids.workerThree];
    for (const task of initial.tasks) {
      const who = users[workerPersonIds.indexOf(task.members[0]!.personId)]!;
      const current = await reporting.list(tailAssign(), id);
      await reporting.submitReport(actor(who, ["worker"], task.executionKind === "tail_inspection" ? "tail_inspection:report" : "work:report"), task.workTaskId, {
        expectedOrderVersion: current.orderVersion,
        actualQuantity: task.executionKind === "tail_inspection" ? tailQuantity : task.processName.endsWith("二") ? 8 : 10,
        completedAt: new Date().toISOString(),
      }, randomUUID());
    }
  };

  it.each(["own_factory", "processing_factory"] as const)("retains other craft name, independent counts, wages and %s responsibility", async bearer => {
    // Maximum-length content also exercises the 100-char input versus prefixed snapshot boundary.
    const description = "工".repeat(100), { id, items, factory } = await activate(description, bearer);
    const tasks = await reporting.list(tailAssign(), id);
    expect(tasks.tasks).toHaveLength(3);
    expect(tasks.tasks.find(task => task.executionKind === "tail_inspection")?.processName).toBe(`其他工艺：${description}`);
    expect((await database.query("SELECT count(*)::int n FROM current_process_catalog WHERE process_name=$1", [description])).rows[0].n).toBe(0);
    await reportAll(id, 10);
    const n05 = await review.get(tailAudit(), id);
    expect(n05).toMatchObject({ specialProcessType: "other_craft", otherCraftDescription: description, reworkStatus: "pending_order_review" });
    expect(n05.processes.map(process => [process.completedQuantity, process.tailCheckedQuantity, process.complete])).toEqual([[10, 10, true], [8, 10, true]]);
    const confirmed = await review.approve(tailAudit(), id, {
      expectedOrderVersion: n05.orderVersion,
      finalQuantities: items.filter(item => item.executionKind === "worker").map((item, i) => ({ configurationItemId: item.configurationItemId, finalConfirmedQuantity: i === 0 ? 10 : 8 })),
      processPrices: items.filter(item => item.executionKind === "worker").map(item => ({ configurationItemId: item.configurationItemId, unitPrice: item.unitPrice! })), temporaryCoefficients: [],
    }, randomUUID());
    const done = await review.reviewFinalQuantity(ie(), id, { expectedOrderVersion: confirmed.value.orderVersion, decision: "approved" }, randomUUID());
    expect(done.value.reworkStatus).toBe("pending_responsibility_determination");
    const special = (await database.query(`SELECT item.process_name,report.group_amount::text,report.settlement_quantity::text
      FROM rework_work_reports report JOIN rework_process_configuration_items item USING(configuration_item_id)
      WHERE report.rework_order_id=$1 AND item.execution_kind='tail_inspection'`, [id])).rows;
    expect(special).toEqual([{ process_name: `其他工艺：${description}`, group_amount: "35.00000000", settlement_quantity: "10.00" }]);
    const responsibility = new ResponsibilityDeterminationService(database);
    const input = {
      expectedOrderVersion: done.value.orderVersion, expectedCurrentDeterminationVersion: null,
      handlerUserId: ids.owner,
      tailInspectionCostBearer: bearer,
      processes: items.map(item => ({ configurationItemId: item.configurationItemId, multiplier: "1.000",
        allocations: [{ responsibilityType: item.executionKind === "tail_inspection" ? bearer : "own_factory" as const,
          shareBps: 10000, multiplier: item.executionKind === "tail_inspection" && bearer === "processing_factory" ? "1.200" : "1.000",
          ...(item.executionKind === "tail_inspection" && factory?.type === "supplier" ? { supplierId: factory.supplierId } : {}) }] })),
    };
    await expect(responsibility.saveDraft(qc(), id, input, randomUUID())).rejects.toMatchObject({ code: "FORBIDDEN" });
    const priced = await responsibility.saveDraft(actor(ids.owner, ["owner_group"], "responsibility:determine"), id, input, randomUUID());
    expect(priced.value).toMatchObject({ specialProcessType: "other_craft", otherCraftDescription: description });
    const craftProcess = priced.value.determination!.processes.find(process => process.configurationItemId === items[2]!.configurationItemId)!;
    expect(craftProcess).toMatchObject({ processName: `其他工艺：${description}`, baseAmount: "35.00000000", responsibilityAmount: bearer === "processing_factory" ? "42.00" : "35.00" });
  });

  it("blocks excess ordinary counts and waives the special process without losing its snapshot or settling invalid reports", async () => {
    const { id } = await activate();
    await reportAll(id, 9);
    const n05 = await review.get(tailAudit(), id);
    expect(n05.processes.map(process => process.complete)).toEqual([false, true]);
    await expect(review.approve(tailAudit(), id, { expectedOrderVersion: n05.orderVersion, finalQuantities: [], processPrices: [], temporaryCoefficients: [] }, randomUUID())).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const who = actor(ids.owner, ["owner_group"], "tail_inspection:waive");
    const waived = await initiation.waiveTailInspection(who, id, { expectedVersion: n05.orderVersion, reason: "测试样本无需该工艺" }, randomUUID());
    expect(waived.value).toMatchObject({ specialProcessType: "none", otherCraftDescription: null, tailInspectionRequired: false });
    expect((await database.query(`SELECT item.process_name,item.special_process_type,EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id) rejected
      FROM rework_process_configuration_items item JOIN rework_work_reports report USING(configuration_item_id)
      WHERE report.rework_order_id=$1 AND item.execution_kind='tail_inspection'`, [id])).rows)
      .toEqual([{ process_name: "其他工艺：拆线重新包边", special_process_type: "other_craft", rejected: true }]);
    const historyService = new ReworkBusinessDetailService(database);
    const historical = await historyService.history(tailAssign(), id, "work_reporting");
    expect(historical.fields.find(field => field.label === "工艺类型")?.value).toBe("其他工艺");
    expect(historical.fields.find(field => field.label === "其他工艺内容")?.value).toBe("拆线重新包边");
    expect(historical.fields.find(field => field.label === "需要整查")?.value).toBe("否");
    expect(historical.notices).toContain("已撤销其他工艺：拆线重新包边；原工艺报数保留为历史，不计入最终数量、工资和责任。");
    expect(historical.page?.workTasks).toMatchObject({ specialProcessType: "other_craft", otherCraftDescription: "拆线重新包边" });
    const reportEntry = (await database.query("SELECT event_id FROM operation_events WHERE entity_id=$1 AND action='rework.work_report.submit' ORDER BY created_at DESC LIMIT 1", [id])).rows[0].event_id;
    const beforeWaiver = await historyService.history(tailAssign(), id, "work_reporting", reportEntry);
    expect(beforeWaiver.fields.find(field => field.label === "其他工艺内容")?.value).toBe("拆线重新包边");
    expect(beforeWaiver.fields.find(field => field.label === "需要整查")?.value).toBe("是");
    expect(beforeWaiver.notices.some(notice => notice.includes("已撤销其他工艺"))).toBe(false);
    expect((await database.query("SELECT special_process_type,other_craft_description FROM rework_orders WHERE rework_order_id=$1", [id])).rows)
      .toEqual([{ special_process_type: "none", other_craft_description: null }]);
  });
});
