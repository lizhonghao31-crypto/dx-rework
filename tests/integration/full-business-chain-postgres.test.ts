import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  CreateResponsibilityDraftSchema,
  CreateWorkReportSchema,
  CreateWorkTaskSchema,
  RejectWorkReportSchema,
  ReviewProcessConfigurationSchema,
  ReviewWholeOrderSchema,
  SaveProcessConfigurationSchema,
  SubmitProcessConfigurationSchema,
} from "@dx-rework/contracts";
import {
  CloseExternalDeductionCaseSchema,
  CreateExternalDeductionEntrySchema,
} from "@dx-rework/contracts/external-responsibility";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { BusinessAwareWholeOrderReviewService } from "../../apps/api/src/rework/business-aware-whole-order-review-service.js";
import { ExternalResponsibilityApplicationService } from "../../apps/api/src/rework/external-responsibility-application-service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ResponsibilityDeterminationApplicationService } from "../../apps/api/src/rework/responsibility-determination-application-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { TodoProjectionService } from "../../apps/api/src/todos/projection-service.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
import { WageService } from "../../apps/api/src/wages/wage-service.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

type Manifest = { migrations: Array<{ version: string; checksum: string }> };

class LegacyIeReviewTodoProjectionService extends TodoProjectionService {
  override async completeOpenByDedupeKey(
    ..._args: Parameters<TodoProjectionService["completeOpenByDedupeKey"]>
  ): Promise<boolean> {
    void _args;
    return false;
  }
}

runWithPostgres("current-schema N01-N11 business chain", () => {
  const schema = `full_chain_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });

  const access = new AccessMasterDataService(database, "corp");
  const todoService = new TodoService(database);
  const todoProjection = new TodoProjectionService(todoService);
  const initiation = new ReworkInitiationService(
    database,
    "corp",
    undefined,
    undefined,
    undefined,
    todoProjection,
  );
  const configuration = new ProcessConfigurationService(
    database,
    undefined,
    undefined,
    undefined,
    todoProjection,
  );
  const legacyConfiguration = new ProcessConfigurationService(
    database,
    undefined,
    undefined,
    undefined,
    new LegacyIeReviewTodoProjectionService(todoService),
  );
  const work = new WorkReportingService(database, undefined, undefined, todoProjection);
  const wholeOrder = new BusinessAwareWholeOrderReviewService(database, todoProjection);
  const responsibility = new ResponsibilityDeterminationApplicationService(
    database,
    todoProjection,
  );
  const external = new ExternalResponsibilityApplicationService(database, todoProjection);
  const wages = new WageService(database, undefined, undefined, todoProjection);

  const ids = {
    ownerOne: randomUUID(),
    ownerTwo: randomUUID(),
    qc: randomUUID(),
    tail: randomUUID(),
    ie: randomUUID(),
    worker: randomUUID(),
    merchandiser: randomUUID(),
    production: randomUUID(),
    factoryPayables: randomUUID(),
    fabricPayables: randomUUID(),
    embroideryMerchandiser: randomUUID(),
    embroideryPayables: randomUUID(),
    administrative: randomUUID(),
    monthClose: randomUUID(),
    technicalAdmin: randomUUID(),
  };

  let workerPersonId = "";
  let factorySupplierId = "";
  let fabricSupplierId = "";
  let embroiderySupplierId = "";
  let publicProcessId = "";

  const actor = (
    actorId: string,
    actorRoles: readonly string[],
    authorizationCapability: string,
    ...otherCapabilities: string[]
  ): TrustedActorContext => ({
    actorId,
    actorRoles,
    authorizationCapability,
    authorizationCapabilities: Array.from(new Set([
      authorizationCapability,
      ...otherCapabilities,
    ])),
    requestId: randomUUID(),
  });

  const ownerMasterData = () => actor(
    ids.ownerOne,
    ["owner_group"],
    "master_data:manage",
  );
  const qc = () => actor(ids.qc, ["quality_control"], "rework:initiate");
  const tailConfigure = () => actor(
    ids.tail,
    ["tail_supervisor"],
    "process:configure",
  );
  const ie = () => actor(ids.ie, ["ie_reviewer"], "process:review");
  const tailAssign = () => actor(
    ids.tail,
    ["tail_supervisor"],
    "work:assign",
    "work:report_for_worker",
  );
  const worker = () => actor(ids.worker, ["worker"], "work:report");
  const tailAudit = () => actor(
    ids.tail,
    ["tail_supervisor"],
    "submission:audit",
    "quantity:adjust",
  );
  const production = () => actor(
    ids.production,
    ["production_management"],
    "responsibility:determine",
  );
  const ownerApproval = () => actor(
    ids.ownerOne,
    ["owner_group"],
    "responsibility:owner_sign",
  );
  const merchandiser = () => actor(
    ids.merchandiser,
    ["order_merchandiser"],
    "external_responsibility:view",
    "external_responsibility:sign",
    "external_deduction:follow_up",
    "external_responsibility:request_revision",
    "supplier_catalog:read",
    "tools:user",
  );
  const payables = () => actor(
    ids.factoryPayables,
    ["factory_payables"],
    "external_responsibility:view",
    "external_responsibility:payables_confirm",
    "external_deduction:follow_up",
    "external_deduction:record",
    "external_deduction:close",
    "supplier_catalog:read",
    "tools:user",
  );
  const embroideryMerchandiser = () => actor(
    ids.embroideryMerchandiser,
    ["embroidery_washing_merchandiser"],
    "external_responsibility:view",
    "external_responsibility:sign",
    "external_deduction:follow_up",
    "external_responsibility:request_revision",
    "supplier_catalog:read",
    "tools:user",
  );
  const fabricPayables = () => actor(
    ids.fabricPayables,
    ["fabric_payables"],
    "external_responsibility:view",
    "external_responsibility:payables_confirm",
    "external_deduction:follow_up",
    "external_deduction:record",
    "external_deduction:close",
    "supplier_catalog:read",
    "tools:user",
  );
  const embroideryPayables = () => actor(
    ids.embroideryPayables,
    ["embroidery_washing_payables"],
    "external_responsibility:view",
    "external_responsibility:payables_confirm",
    "external_deduction:follow_up",
    "external_deduction:record",
    "external_deduction:close",
    "supplier_catalog:read",
    "tools:user",
  );
  const tailWage = () => actor(
    ids.tail,
    ["tail_supervisor"],
    "wage:view",
    "wage:tail_review",
    "wage:adjustment_request",
  );
  const administrativeWage = () => actor(
    ids.administrative,
    ["administrative_clerk"],
    "wage:view",
    "wage:administrative_review",
    "wage:adjustment_approve",
    "wage:export",
  );
  const monthCloseWage = () => actor(
    ids.monthClose,
    ["wage_month_close_accountant"],
    "wage:view",
    "wage:month_close",
    "wage:export",
  );

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
        "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
        [migration.version, migration.checksum],
      );
    }

    // Role seeding happens before the corporation policy exists. This is the
    // reviewed bootstrap path used by integration fixtures; all later actions
    // use normal production authorization functions from the current schema.
    const users = [
      [ids.ownerOne, "老板一", "owner_group"],
      [ids.ownerTwo, "老板二", "owner_group"],
      [ids.qc, "品控", "quality_control"],
      [ids.tail, "李同生", "tail_supervisor"],
      [ids.ie, "IE", "ie_reviewer"],
      [ids.worker, "工人", "worker"],
      [ids.merchandiser, "订单跟单", "order_merchandiser"],
      [ids.production, "生产管理", "production_management"],
      [ids.factoryPayables, "加工厂应付", "factory_payables"],
      [ids.fabricPayables, "面料应付", "fabric_payables"],
      [ids.embroideryMerchandiser, "印绣花跟单", "embroidery_washing_merchandiser"],
      [ids.embroideryPayables, "印绣花应付", "embroidery_washing_payables"],
      [ids.administrative, "行政文员", "administrative_clerk"],
      [ids.monthClose, "工资月结", "wage_month_close_accountant"],
      [ids.technicalAdmin, "技术管理员", "system_admin"],
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
         ) VALUES($1,$2,$3,$2,'full-chain fixture')`,
        [randomUUID(), userId, roleCode],
      );
    }
    await access.ensureOrganizationPolicy();

    workerPersonId = (await access.createPerson(ownerMasterData(), {
      personType: "internal",
      appUserId: ids.worker,
      displayName: "工人",
      aliases: [],
      reason: "全链验收工人档案",
    })).personId;
    factorySupplierId = (await access.createSupplier(ownerMasterData(), {
      supplierCode: "UATFAC01",
      supplierType: "factory",
      supplierName: "全链测试加工厂",
      active: true,
      changeReason: "全链验收加工厂",
    })).supplierId;
    fabricSupplierId = (await access.createSupplier(ownerMasterData(), {
      supplierCode: "UATFAB01",
      supplierType: "fabric",
      supplierName: "全链测试面料商",
      active: true,
      changeReason: "全链验收面料商",
    })).supplierId;
    embroiderySupplierId = (await access.createSupplier(ownerMasterData(), {
      supplierCode: "UATEMB01",
      supplierType: "embroidery_washing",
      supplierName: "全链测试印绣花厂",
      active: true,
      changeReason: "全链验收印绣花厂",
    })).supplierId;
    publicProcessId = (await access.createProcess(ownerMasterData(), {
      processCode: "UATPROC01",
      processName: "袖口返修",
      pricingUnit: "piece",
      active: true,
      changeReason: "全链验收公共工序",
    })).processId;
  });

  afterAll(async () => {
    await database.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  });

  it("carries one real order from N01 through N11 without losing cross-node facts", async () => {
    // N01 - QC initiates one order with the business total quantity.
    const draft = await initiation.createDraft(qc(), {
      styleNo: "UAT-FULL-CHAIN",
      orderNo: "ORDER-FULL-001",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "supplier", supplierId: factorySupplierId },
      problemPart: "袖口",
      problemDescription: "全链自动验收",
      reworkQuantity: 200,
    }, randomUUID());
    expect(draft.value).toMatchObject({
      status: "draft",
      reworkQuantity: 200,
      reworkNo: null,
    });
    const submitted = await initiation.submit(
      qc(),
      draft.value.reworkOrderId,
      { expectedVersion: draft.value.version },
      randomUUID(),
    );
    expect(submitted.value).toMatchObject({
      status: "pending_process_configuration",
      reworkQuantity: 200,
      reworkNo: expect.stringMatching(/^RW-/),
    });

    // Post-creation order evidence must pass the same current-schema guards
    // used in production, while preserving the active workflow state.
    const supplementalImageId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'full-chain-supplement.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [
        supplementalImageId,
        `private/${supplementalImageId}.webp`,
        "e".repeat(64),
        ids.qc,
      ],
    );
    const supplemented = await initiation.supplementOrderImages(
      qc(),
      submitted.value.reworkOrderId,
      {
        expectedVersion: submitted.value.version,
        attachmentIds: [supplementalImageId],
      },
      randomUUID(),
    );
    expect(supplemented.value).toMatchObject({
      status: "pending_process_configuration",
      version: submitted.value.version + 1,
      attachmentIds: [supplementalImageId],
    });
    expect((await database.query(
      "SELECT entity_type,entity_id FROM attachments WHERE attachment_id=$1",
      [supplementalImageId],
    )).rows[0]).toEqual({
      entity_type: "rework_order",
      entity_id: submitted.value.reworkOrderId,
    });

    // N02 - planned quantity is fed from the N01 quantity instead of a second
    // unrelated fixture value. The business can still change it per process.
    const n02Input = SaveProcessConfigurationSchema.parse({
      expectedOrderVersion: supplemented.value.version,
      items: [{
        source: "catalog",
        processId: publicProcessId,
        plannedQuantity: submitted.value.reworkQuantity,
        pricingUnit: "piece",
        unitPrice: 0.55,
      }],
    });
    const n02Saved = await configuration.saveDraft(
      tailConfigure(),
      submitted.value.reworkOrderId,
      n02Input,
      randomUUID(),
    );
    expect(n02Saved.value).toMatchObject({
      reworkStatus: "pending_process_configuration",
      configuration: {
        status: "draft",
        items: [{ plannedQuantity: 200, unitPrice: 0.55 }],
      },
    });
    const n02Queued = await configuration.submit(
      tailConfigure(),
      submitted.value.reworkOrderId,
      SubmitProcessConfigurationSchema.parse({
        expectedOrderVersion: n02Saved.value.orderVersion,
        expectedConfigurationVersion:
          n02Saved.value.configuration!.configurationVersion,
      }),
      randomUUID(),
    );
    expect(n02Queued.value.reworkStatus).toBe("pending_ie_review");
    await expect(database.query(
      `SELECT count(*)::int open_count
       FROM rework_todos
       WHERE dedupe_key LIKE $1 AND status IN ('pending','blocked_recipient')`,
      [`process-config:${submitted.value.reworkOrderId}:%`],
    )).resolves.toMatchObject({ rows: [{ open_count: 0 }] });

    // N03 - deliberately reject once, return to N02, then resubmit and approve.
    const rejected = await legacyConfiguration.review(
      ie(),
      submitted.value.reworkOrderId,
      ReviewProcessConfigurationSchema.parse({
        expectedOrderVersion: n02Queued.value.orderVersion,
        expectedConfigurationVersion:
          n02Queued.value.configuration!.configurationVersion,
        decision: "rejected",
        reason: "全链测试：退回后重新提交",
      }),
      randomUUID(),
    );
    expect(rejected.value.reworkStatus).toBe("pending_process_configuration");
    const firstIeDedupeKey = `ie-review:${submitted.value.reworkOrderId}:${n02Queued.value.configuration!.configurationVersion}`;
    await expect(database.query(
      "SELECT status FROM rework_todos WHERE dedupe_key=$1",
      [firstIeDedupeKey],
    )).resolves.toMatchObject({ rows: [{ status: "pending" }] });
    await database.query(await readFile(
      new URL("../../apps/api/migrations/0052_ie_review_todo_completion_repair.sql", import.meta.url),
      "utf8",
    ));
    await expect(database.query(
      `SELECT todo.status,event.action,event.actor_id
       FROM rework_todos todo
       JOIN operation_events event ON event.event_id=todo.completed_operation_event_id
       WHERE todo.dedupe_key=$1`,
      [firstIeDedupeKey],
    )).resolves.toMatchObject({ rows: [{
      status: "completed",
      action: "todo.complete",
      actor_id: ids.ie,
    }] });
    const n02Resaved = await configuration.saveDraft(
      tailConfigure(),
      submitted.value.reworkOrderId,
      SaveProcessConfigurationSchema.parse({
        expectedOrderVersion: rejected.value.orderVersion,
        items: [{
          source: "catalog",
          processId: publicProcessId,
          plannedQuantity: submitted.value.reworkQuantity,
          pricingUnit: "piece",
          unitPrice: 0.55,
        }],
      }),
      randomUUID(),
    );
    const n02Requeued = await configuration.submit(
      tailConfigure(),
      submitted.value.reworkOrderId,
      SubmitProcessConfigurationSchema.parse({
        expectedOrderVersion: n02Resaved.value.orderVersion,
        expectedConfigurationVersion:
          n02Resaved.value.configuration!.configurationVersion,
      }),
      randomUUID(),
    );
    await expect(database.query(
      `SELECT count(*)::int open_count
       FROM rework_todos
       WHERE category='process_configuration_return'
         AND entity_id=$1
         AND status IN ('pending','blocked_recipient')`,
      [submitted.value.reworkOrderId],
    )).resolves.toMatchObject({ rows: [{ open_count: 0 }] });
    const approved = await configuration.review(
      ie(),
      submitted.value.reworkOrderId,
      ReviewProcessConfigurationSchema.parse({
        expectedOrderVersion: n02Requeued.value.orderVersion,
        expectedConfigurationVersion:
          n02Requeued.value.configuration!.configurationVersion,
        decision: "approved",
      }),
      randomUUID(),
    );
    expect(approved.value.reworkStatus).toBe("pending_task_assignment");
    await expect(database.query(
      `SELECT todo.status,event.action,event.actor_id
       FROM rework_todos todo
       JOIN operation_events event ON event.event_id=todo.completed_operation_event_id
       WHERE todo.dedupe_key=$1`,
      [`ie-review:${submitted.value.reworkOrderId}:${n02Requeued.value.configuration!.configurationVersion}`],
    )).resolves.toMatchObject({ rows: [{
      status: "completed",
      action: "todo.complete",
      actor_id: ids.ie,
    }] });
    const approvedItem = approved.value.configuration!.items[0]!;
    expect(approvedItem).toMatchObject({
      processId: publicProcessId,
      processName: "袖口返修",
      plannedQuantity: 200,
      pricingUnit: "piece",
      unitPrice: 0.55,
    });

    // N04 - the task receives exactly the approved N02/N03 facts.
    const task = await work.createTask(
      tailAssign(),
      submitted.value.reworkOrderId,
      CreateWorkTaskSchema.parse({
        expectedOrderVersion: approved.value.orderVersion,
        configurationItemId: approvedItem.configurationItemId,
        mode: "individual",
        members: [{ personId: workerPersonId }],
      }),
      randomUUID(),
    );
    expect(task.value).toMatchObject({
      processName: "袖口返修",
      plannedQuantity: 200,
      unitPrice: 0.55,
      members: [{ personId: workerPersonId, displayName: "工人" }],
    });

    // N05 - two reports sum to the plan. Replay of the first request must not
    // create a duplicate record.
    let workView = await work.list(
      tailAssign(),
      submitted.value.reworkOrderId,
    );
    expect(workView.reworkStatus).toBe("in_progress");
    const firstReportKey = randomUUID();
    const firstReportInput = CreateWorkReportSchema.parse({
      expectedOrderVersion: workView.orderVersion,
      actualQuantity: 120,
      completedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const firstReport = await work.submitReport(
      worker(),
      task.value.workTaskId,
      firstReportInput,
      firstReportKey,
    );
    const firstReplay = await work.submitReport(
      worker(),
      task.value.workTaskId,
      firstReportInput,
      firstReportKey,
    );
    expect(firstReplay.reused).toBe(true);
    expect(firstReplay.value.workReportId).toBe(firstReport.value.workReportId);
    expect(firstReport.value.memberShares[0]?.amount).toBe(66);

    workView = await work.list(tailAssign(), submitted.value.reworkOrderId);
    expect(workView.reworkStatus).toBe("in_progress");
    const secondReport = await work.submitReport(
      worker(),
      task.value.workTaskId,
      CreateWorkReportSchema.parse({
        expectedOrderVersion: workView.orderVersion,
        actualQuantity: 80,
        completedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      }),
      randomUUID(),
    );
    expect(secondReport.value.memberShares[0]?.amount).toBe(44);
    workView = await work.list(tailAssign(), submitted.value.reworkOrderId);
    expect(workView.reworkStatus).toBe("pending_order_review");
    expect(workView.tasks[0]).toMatchObject({
      submittedQuantity: 200,
      remainingQuantity: 0,
    });

    const returnedReport = await wholeOrder.rejectReport(
      tailAudit(),
      firstReport.value.workReportId,
      RejectWorkReportSchema.parse({
        expectedOrderVersion: workView.orderVersion,
        rejectedPersonId: workerPersonId,
        reason: "全链测试：退回后重新上数",
      }),
      randomUUID(),
    );
    expect(returnedReport.value.reworkStatus).toBe("in_progress");
    await expect(database.query(
      "SELECT status FROM rework_todos WHERE dedupe_key=$1",
      [`work-report-return:${firstReport.value.workReportId}`],
    )).resolves.toMatchObject({ rows: [{ status: "pending" }] });
    const correctedReport = await work.submitReport(
      worker(),
      task.value.workTaskId,
      CreateWorkReportSchema.parse({
        expectedOrderVersion: returnedReport.value.orderVersion,
        actualQuantity: 120,
        completedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
        resubmitsWorkReportId: firstReport.value.workReportId,
      }),
      randomUUID(),
    );
    expect(correctedReport.value.actualQuantity).toBe(120);
    await expect(database.query(
      "SELECT status FROM rework_todos WHERE dedupe_key=$1",
      [`work-report-return:${firstReport.value.workReportId}`],
    )).resolves.toMatchObject({ rows: [{ status: "completed" }] });
    workView = await work.list(tailAssign(), submitted.value.reworkOrderId);
    expect(workView.reworkStatus).toBe("pending_order_review");

    // N06 - the whole-order snapshot must reconcile to N02's plan exactly.
    const n06View = await wholeOrder.get(
      tailAudit(),
      submitted.value.reworkOrderId,
    );
    expect(n06View.processes).toEqual([
      expect.objectContaining({
        configurationItemId: approvedItem.configurationItemId,
        plannedQuantity: 200,
        completedQuantity: 200,
        complete: true,
      }),
    ]);
    expect(n06View.reports).toHaveLength(3);
    const n06Approved = await wholeOrder.approve(
      tailAudit(),
      submitted.value.reworkOrderId,
      ReviewWholeOrderSchema.parse({ expectedOrderVersion: n06View.orderVersion }),
      randomUUID(),
    );
    expect(n06Approved.value.reworkStatus)
      .toBe("pending_responsibility_determination");

    // N07 - base amount is 200 * 0.55 = 110.00.  It is split across
    // own factory, the original processing factory, an embroidery factory,
    // and a fabric supplier.
    const n07Draft = await responsibility.saveDraft(
      production(),
      submitted.value.reworkOrderId,
      CreateResponsibilityDraftSchema.parse({
        expectedOrderVersion: n06Approved.value.orderVersion,
        expectedCurrentDeterminationVersion: null,
        handlerUserId: ids.production,
        processes: [{
          configurationItemId: approvedItem.configurationItemId,
          multiplier: "1.000",
          allocations: [
            {
              responsibilityType: "own_factory",
              shareBps: 2500,
              multiplier: "1.000",
            },
            {
              responsibilityType: "processing_factory",
              shareBps: 5000,
              multiplier: "1.200",
              supplierId: factorySupplierId,
            },
            {
              responsibilityType: "embroidery_factory",
              shareBps: 1250,
              multiplier: "1.200",
              supplierId: embroiderySupplierId,
            },
            {
              responsibilityType: "fabric_supplier",
              shareBps: 1250,
              multiplier: "1.200",
              supplierId: fabricSupplierId,
            },
          ],
        }],
      }),
      randomUUID(),
    );
    expect(n07Draft.value.determination).toMatchObject({
      stage: "draft",
      calculationTotal: "126.50",
      processes: [{
        baseAmount: "110.00",
        responsibilityAmount: "126.50",
        allocations: expect.arrayContaining([
          expect.objectContaining({
            responsibilityType: "own_factory",
            roundedAmount: "27.50",
          }),
          expect.objectContaining({
            responsibilityType: "processing_factory",
            roundedAmount: "66.00",
          }),
          expect.objectContaining({
            responsibilityType: "embroidery_factory",
            roundedAmount: "16.50",
          }),
          expect.objectContaining({
            responsibilityType: "fabric_supplier",
            roundedAmount: "16.50",
          }),
        ]),
      }],
    });
    const n07Final = await responsibility.finalize(
      production(),
      submitted.value.reworkOrderId,
      {
        expectedOrderVersion: n07Draft.value.orderVersion,
        expectedCurrentDeterminationVersion:
          n07Draft.value.determination!.version,
      },
      randomUUID(),
    );
    expect(n07Final.value.reworkStatus).toBe("pending_owner_signature");
    expect(n07Final.value.canOwnerSign).toBe(false);

    // N08 - the owner signs the immutable N07 facts once. N09 ledger cards
    // are generated atomically, and the main order is then complete.
    const ownerSigned = await responsibility.approveOwnerSignature(
      ownerApproval(),
      submitted.value.reworkOrderId,
      { expectedOrderVersion: n07Final.value.orderVersion },
      randomUUID(),
    );
    expect(ownerSigned.value).toMatchObject({
      reworkStatus: "completed",
      ownerSignature: { decision: "approved", signedBy: ids.ownerOne },
    });

    const externalBatch = await external.get(
      merchandiser(),
      submitted.value.reworkOrderId,
    );
    expect(externalBatch).not.toBeNull();
    expect(externalBatch!.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        responsibilityType: "processing_factory",
        supplier: { supplierId: factorySupplierId },
        proposedDeductionAmount: "66.00",
        actualDeductedAmount: "0.00",
        status: "deduction_follow_up",
        caseVersion: 1,
      }),
      expect.objectContaining({
        responsibilityType: "fabric_supplier",
        supplier: { supplierId: fabricSupplierId },
        proposedDeductionAmount: "16.50",
      }),
    ]));
    const externalCase = externalBatch!.cases.find(
      (item) => item.responsibilityType === "processing_factory",
    )!;
    const deduction = await external.recordDeduction(
      payables(),
      externalCase.caseId,
      CreateExternalDeductionEntrySchema.parse({
        expectedCaseVersion: externalCase.caseVersion,
        entryType: "deduction",
        amount: "66.00",
        deductedOn: new Date().toISOString().slice(0, 10),
        attachmentIds: [],
      }),
      randomUUID(),
    );
    expect(deduction.value).toMatchObject({
      status: "deduction_follow_up",
      actualDeductedAmount: "66.00",
      remainingAmount: "0.00",
    });
    const fabricCase = externalBatch!.cases.find(
      (item) => item.responsibilityType === "fabric_supplier",
    )!;
    const fabricDeduction = await external.recordDeduction(
      fabricPayables(),
      fabricCase.caseId,
      CreateExternalDeductionEntrySchema.parse({
        expectedCaseVersion: fabricCase.caseVersion,
        entryType: "deduction",
        amount: "16.50",
        deductedOn: new Date().toISOString().slice(0, 10),
        attachmentIds: [],
      }),
      randomUUID(),
    );
    expect(fabricDeduction.value).toMatchObject({
      status: "deduction_follow_up",
      actualDeductedAmount: "16.50",
      remainingAmount: "0.00",
    });
    const embroideryBatch = await external.get(
      embroideryMerchandiser(),
      submitted.value.reworkOrderId,
    );
    expect(embroideryBatch).not.toBeNull();
    const embroideryCase = embroideryBatch!.cases[0]!;
    expect(embroideryCase).toMatchObject({
      responsibilityType: "embroidery_factory",
      supplier: { supplierId: embroiderySupplierId },
      proposedDeductionAmount: "16.50",
      status: "deduction_follow_up",
    });
    const embroideryDeduction = await external.recordDeduction(
      embroideryPayables(),
      embroideryCase.caseId,
      CreateExternalDeductionEntrySchema.parse({
        expectedCaseVersion: embroideryCase.caseVersion,
        entryType: "deduction",
        amount: "16.50",
        deductedOn: new Date().toISOString().slice(0, 10),
        attachmentIds: [],
      }),
      randomUUID(),
    );
    expect(embroideryDeduction.value).toMatchObject({
      status: "deduction_follow_up",
      actualDeductedAmount: "16.50",
      remainingAmount: "0.00",
    });
    expect((await database.query<{ status: string }>(
      "SELECT status FROM rework_orders WHERE rework_order_id=$1",
      [submitted.value.reworkOrderId],
    )).rows[0]).toEqual({ status: "completed" });

    // N10-B - actual deduction remains a separate lifecycle after N09.
    const closed = await external.close(
      payables(),
      externalCase.caseId,
      CloseExternalDeductionCaseSchema.parse({
        expectedCaseVersion: deduction.value.caseVersion,
        result: "full",
        evidenceAttachmentIds: [],
      }),
      randomUUID(),
    );
    expect(closed.value).toMatchObject({
      status: "closed",
      closure: {
        result: "full",
        proposedAmount: "66.00",
        actualDeductedAmount: "66.00",
        remainingAmount: "0.00",
      },
    });
    await external.close(
      fabricPayables(),
      fabricCase.caseId,
      CloseExternalDeductionCaseSchema.parse({
        expectedCaseVersion: fabricDeduction.value.caseVersion,
        result: "full",
        evidenceAttachmentIds: [],
      }),
      randomUUID(),
    );
    await external.close(
      embroideryPayables(),
      embroideryCase.caseId,
      CloseExternalDeductionCaseSchema.parse({
        expectedCaseVersion: embroideryDeduction.value.caseVersion,
        result: "full",
        evidenceAttachmentIds: [],
      }),
      randomUUID(),
    );
    expect((await database.query<{ status: string }>(
      "SELECT status FROM rework_orders WHERE rework_order_id=$1",
      [submitted.value.reworkOrderId],
    )).rows[0]).toEqual({ status: "completed" });

    // N10-A - the two N05 reports materialize into one worker's wage facts.
    // The current natural month is intentionally not force-locked: the service
    // must reach ready_to_lock and then enforce the month-end barrier. The
    // historical-month lock itself remains covered by wage-workflow-postgres.
    const periods = await wages.list(tailWage());
    expect(periods).toHaveLength(1);
    const wagePeriod = periods[0]!;
    expect(wagePeriod).toMatchObject({
      status: "pending_tail_review",
      sourceItemCount: 2,
      personCount: 1,
      originalTotal: "110.00",
      adjustmentTotal: "0.00",
      finalTotal: "110.00",
    });
    const wageDetail = await wages.get(tailWage(), wagePeriod.periodId);
    expect(wageDetail.items).toHaveLength(2);
    expect(wageDetail.items.reduce(
      (sum, item) => sum + Number(item.payableAmount),
      0,
    )).toBe(110);
    const tailReviewed = await wages.review(
      tailWage(),
      wagePeriod.periodId,
      wagePeriod.periodVersion,
      "tail",
      null,
      randomUUID(),
    );
    expect(tailReviewed.value.status).toBe("pending_admin_review");
    const adminReviewed = await wages.review(
      administrativeWage(),
      wagePeriod.periodId,
      tailReviewed.value.periodVersion,
      "administrative_approve",
      null,
      randomUUID(),
    );
    expect(adminReviewed.value.status).toBe("ready_to_lock");
    await expect(wages.lock(
      monthCloseWage(),
      wagePeriod.periodId,
      adminReviewed.value.periodVersion,
      "全链测试月结",
      randomUUID(),
    )).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      statusCode: 409,
    });

    // Final reconciliation: no cross-node amount drift.
    const totals = await database.query<{
      report_total: string;
      responsibility_total: string;
      own_factory_total: string;
      external_total: string;
      wage_total: string;
    }>(
      `SELECT
         (SELECT sum(group_amount)::numeric(18,2)::text
          FROM rework_work_reports report
          WHERE rework_order_id=$1
            AND NOT EXISTS (
              SELECT 1 FROM rework_work_report_rejections rejection
              WHERE rejection.work_report_id=report.work_report_id
            )) report_total,
         (SELECT calculation_total::numeric(18,2)::text
          FROM rework_responsibility_determinations
          WHERE rework_order_id=$1 AND stage='finalized'
          ORDER BY determination_version DESC LIMIT 1) responsibility_total,
         (SELECT COALESCE(sum(allocation.rounded_amount),0)::numeric(18,2)::text
          FROM rework_responsibility_allocations allocation
          JOIN rework_responsibility_determinations determination
            ON determination.determination_id=allocation.determination_id
          WHERE determination.rework_order_id=$1
            AND determination.stage='finalized'
            AND allocation.responsibility_type='own_factory'
            AND NOT EXISTS(
              SELECT 1 FROM rework_responsibility_determinations successor
              WHERE successor.replaces_determination_id=determination.determination_id
            )) own_factory_total,
         (SELECT sum(proposed_deduction_amount)::numeric(18,2)::text
          FROM rework_external_responsibility_cases WHERE rework_order_id=$1) external_total,
         (SELECT sum(payable_amount)::numeric(18,2)::text
          FROM rework_wage_items WHERE rework_order_id=$1) wage_total`,
      [submitted.value.reworkOrderId],
    );
    expect(totals.rows[0]).toEqual({
      report_total: "110.00",
      responsibility_total: "126.50",
      own_factory_total: "27.50",
      external_total: "99.00",
      wage_total: "110.00",
    });
    const openBusinessTodos = await database.query<{ category: string }>(
      `SELECT category
       FROM rework_todos
       WHERE todo_type='business_action'
         AND status IN ('pending','blocked_recipient')
       ORDER BY category,todo_id`,
    );
    expect(openBusinessTodos.rows).toEqual([
      { category: "wage_month_close" },
    ]);
  });
});
