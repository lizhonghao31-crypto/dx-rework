import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  CreateResponsibilityDraftSchema,
  CreateWorkReportSchema,
  ReviewProcessConfigurationSchema,
  SaveProcessConfigurationSchema,
  SubmitProcessConfigurationSchema,
} from "@dx-rework/contracts";
import {
  ApproveExternalDeductionSpecialApprovalSchema,
  CloseExternalDeductionCaseSchema,
  CreateExternalDeductionEntrySchema,
  RequestExternalDeductionSpecialApprovalSchema,
  ReturnExternalDeductionSpecialApprovalSchema,
} from "@dx-rework/contracts/external-responsibility";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { BusinessAwareWholeOrderReviewService } from "../../apps/api/src/rework/business-aware-whole-order-review-service.js";
import { ExternalResponsibilityApplicationService } from "../../apps/api/src/rework/external-responsibility-application-service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ProcessWorkerPlanService } from "../../apps/api/src/rework/process-worker-plan-service.js";
import { ResponsibilityDeterminationApplicationService } from "../../apps/api/src/rework/responsibility-determination-application-service.js";
import { ReworkBusinessDetailService } from "../../apps/api/src/rework/rework-business-detail-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { ReworkSupplyContextService } from "../../apps/api/src/rework/supply-context-service.js";
import { TailInspectionService } from "../../apps/api/src/rework/tail-inspection-service.js";
import { ReworkV2SubmissionService } from "../../apps/api/src/rework/v2-submission-service.js";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { TodoProjectionService } from "../../apps/api/src/todos/projection-service.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
import { WageService } from "../../apps/api/src/wages/wage-service.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

type Manifest = { migrations: Array<{ version: string; checksum: string }> };

const n01CoreInspectionReport = (styleName: string) => ({
  schemaVersion: 1 as const,
  styleName,
  inspectionStage: "final" as const,
  inspectionLocation: "尾部质检区",
  color: "藏青",
  sampleQuantity: 20,
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
});

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
  const v2Submission = new ReworkV2SubmissionService(
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
  const workerPlan = new ProcessWorkerPlanService(database);
  const work = new WorkReportingService(database, undefined, undefined, todoProjection);
  const legacyTailInspection = new TailInspectionService(
    database,
    undefined,
    undefined,
    todoProjection,
  );
  const wholeOrder = new BusinessAwareWholeOrderReviewService(database, todoProjection);
  const responsibility = new ResponsibilityDeterminationApplicationService(
    database,
    todoProjection,
  );
  const supplyContext = new ReworkSupplyContextService(database, "corp");
  const external = new ExternalResponsibilityApplicationService(database, todoProjection);
  const wages = new WageService(database, undefined, undefined, todoProjection);
  const businessDetail = new ReworkBusinessDetailService(database);

  const ids = {
    ownerOne: randomUUID(),
    ownerTwo: randomUUID(),
    qc: randomUUID(),
    tail: randomUUID(),
    tailInspector: randomUUID(),
    ie: randomUUID(),
    worker: randomUUID(),
    merchandiser: randomUUID(),
    production: randomUUID(),
    factoryPayables: randomUUID(),
    fabricPayables: randomUUID(),
    financeDirector: randomUUID(),
    embroideryMerchandiser: randomUUID(),
    embroideryPayables: randomUUID(),
    administrative: randomUUID(),
    monthClose: randomUUID(),
    technicalAdmin: randomUUID(),
  };

  let workerPersonId = "";
  let tailPersonId = "";
  let factorySupplierId = "";
  let fabricSupplierId = "";
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
  const tailTodoView = () => actor(ids.tail, ["tail_supervisor"], "todo:view");
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
  const tailInspect = () => actor(
    ids.tailInspector,
    ["worker"],
    "tail_inspection:report",
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
  const factoryPayables = (capability: string) => actor(
    ids.factoryPayables,
    ["factory_payables"],
    capability,
  );
  const fabricPayables = (capability: string) => actor(
    ids.fabricPayables,
    ["fabric_payables"],
    capability,
  );
  const financeDirector = () => actor(
    ids.financeDirector,
    ["finance_director"],
    "external_deduction:special_approve",
  );
  const wageView = () => actor(
    ids.tail,
    ["tail_supervisor"],
    "wage:view",
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
      [ids.tailInspector, "尾查", "tail_inspector"],
      [ids.ie, "IE", "ie_reviewer"],
      [ids.worker, "工人", "worker"],
      [ids.merchandiser, "订单跟单", "order_merchandiser"],
      [ids.production, "生产管理", "production_management"],
      [ids.factoryPayables, "加工厂应付", "factory_payables"],
      [ids.fabricPayables, "面料应付", "fabric_payables"],
      [ids.financeDirector, "财务总监", "finance_director"],
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
    tailPersonId = (await access.createPerson(ownerMasterData(), {
      personType: "internal",
      appUserId: ids.tailInspector,
      displayName: "尾查",
      aliases: [],
      reason: "全链验收尾查档案",
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
    const initialImageId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'full-chain-initial.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [initialImageId, `private/${initialImageId}.webp`, "d".repeat(64), ids.qc],
    );
    const draft = await initiation.createDraft(qc(), {
      styleNo: "UAT-FULL-CHAIN",
      orderQuantity: 1_000,
      orderNo: "ORDER-FULL-001",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "supplier", supplierId: factorySupplierId },
      tailInspectionCostBearer: "processing_factory",
      inspectionReport: n01CoreInspectionReport("全链测试款"),
      problemPart: "袖口",
      problemDescription: "全链自动验收",
      reworkQuantity: 200,
      attachmentIds: [initialImageId],
    }, randomUUID());
    expect(draft.value).toMatchObject({
      status: "draft",
      reworkQuantity: 200,
      reworkNo: null,
    });
    await supplyContext.save(qc(), draft.value.reworkOrderId, {
      washingSupplierId: null,
      embroiderySupplierId: null,
      fabricSupplierId: null,
      embroideryMerchandiserUserId: ids.embroideryMerchandiser,
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

    const firstTodoPage = await todoService.listForActor(tailTodoView(), { module: "rework" });
    expect(firstTodoPage.moduleCounts.rework).toBeGreaterThan(0);
    expect(firstTodoPage.todos).toHaveLength(1);
    expect(firstTodoPage).toMatchObject({ page: 1, pageSize: 15, totalCount: 1, totalPages: 1 });
    expect((await todoService.listForActor(
      tailTodoView(),
      { module: "rework", query: "%" },
    )).todos).toHaveLength(0);
    expect(await todoService.getForActor(
      tailTodoView(),
      firstTodoPage.todos[0]!.todoId,
    )).toMatchObject({ todoId: firstTodoPage.todos[0]!.todoId, status: "pending" });

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
      actor(ids.qc, ["quality_control"], "tools:user"),
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
      attachmentIds: expect.arrayContaining([initialImageId, supplementalImageId]),
    });
    expect((await database.query(
      "SELECT entity_type,entity_id FROM attachments WHERE attachment_id=$1",
      [supplementalImageId],
    )).rows[0]).toEqual({
      entity_type: "rework_order",
      entity_id: submitted.value.reworkOrderId,
    });

    // N02 records process, planned quantity and price; N03 IE must approve it.
    const n02Input = SaveProcessConfigurationSchema.parse({
      expectedOrderVersion: supplemented.value.version,
      items: [{
        source: "catalog",
        processId: publicProcessId,
        executionKind: "worker",
        plannedQuantity: submitted.value.reworkQuantity,
        pricingUnit: "piece",
        unitPrice: 0.55,
      }, {
        source: "custom",
        customProcessName: "尾查",
        executionKind: "tail_inspection",
        plannedQuantity: 1,
        pricingUnit: "piece",
        unitPrice: 0.2,
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
        items: [
          expect.objectContaining({ executionKind: "worker", plannedQuantity: 200, unitPrice: 0.55 }),
          expect.objectContaining({ executionKind: "tail_inspection", plannedQuantity: 1, unitPrice: 0.2 }),
        ],
      },
    });
    const workerItem = n02Saved.value.configuration!.items.find((item) => item.executionKind === "worker")!;
    const tailItem = n02Saved.value.configuration!.items.find((item) => item.executionKind === "tail_inspection")!;
    const planned = await workerPlan.save(
      tailAssign(),
      submitted.value.reworkOrderId,
      {
        expectedOrderVersion: n02Saved.value.orderVersion,
        configurationId: n02Saved.value.configuration!.configurationId,
        expectedConfigurationVersion: n02Saved.value.configuration!.configurationVersion,
        assignments: [
          { configurationItemId: workerItem.configurationItemId, memberIds: [workerPersonId] },
          { configurationItemId: tailItem.configurationItemId, memberIds: [tailPersonId] },
        ],
      },
      randomUUID(),
    );
    expect(planned.value).toMatchObject({ required: true, complete: true });
    const n02Submitted = await configuration.submit(
      tailConfigure(),
      submitted.value.reworkOrderId,
      SubmitProcessConfigurationSchema.parse({
        expectedOrderVersion: n02Saved.value.orderVersion,
        expectedConfigurationVersion: n02Saved.value.configuration!.configurationVersion,
      }),
      randomUUID(),
    );
    expect(n02Submitted.value.reworkStatus).toBe("pending_ie_review");
    const n03Approved = await configuration.review(
      ie(),
      submitted.value.reworkOrderId,
      ReviewProcessConfigurationSchema.parse({
        expectedOrderVersion: n02Submitted.value.orderVersion,
        expectedConfigurationVersion: n02Submitted.value.configuration!.configurationVersion,
        decision: "approved",
      }),
      randomUUID(),
    );
    expect(n03Approved.value.reworkStatus).toBe("pending_task_assignment");
    const approvedItem = n03Approved.value.configuration!.items.find((item) => item.executionKind === "worker")!;
    const approvedTailItem = n03Approved.value.configuration!.items.find((item) => item.executionKind === "tail_inspection")!;
    expect(approvedItem).toMatchObject({
      processId: publicProcessId,
      processName: "袖口返修",
      plannedQuantity: 200,
      pricingUnit: "piece",
      unitPrice: 0.55,
    });

    expect(approvedTailItem).toMatchObject({
      processName: "整查",
      executionKind: "tail_inspection",
      plannedQuantity: 1,
      unitPrice: 0.2,
    });

    // IE approval activates the complete N02 plan into two unified execution tasks.
    const activated = await workerPlan.activateAfterIeApproval(
      submitted.value.reworkOrderId,
      n03Approved.value.configuration!.configurationVersion,
      randomUUID(),
    );
    expect(activated).toMatchObject({ reworkStatus: "in_progress", tasksCreated: 2 });
    const n04Started = await work.list(tailAssign(), submitted.value.reworkOrderId);
    expect(n04Started.reworkStatus).toBe("in_progress");
    const workerTask = n04Started.tasks.find((item) => item.executionKind === "worker")!;
    const tailTask = n04Started.tasks.find((item) => item.executionKind === "tail_inspection")!;
    expect(workerTask).toMatchObject({
      processName: "袖口返修",
      plannedQuantity: 200,
      unitPrice: 0.55,
      members: [{ personId: workerPersonId, displayName: "工人" }],
    });
    expect(tailTask).toMatchObject({
      processName: "整查",
      executionKind: "tail_inspection",
      members: [{ personId: tailPersonId, displayName: "尾查" }],
    });

    // N05 has one final completion report per assigned task; wage is still
    // generated only after N06 confirms the quantity.
    const firstReportKey = randomUUID();
    const firstReportInput = CreateWorkReportSchema.parse({
      expectedOrderVersion: n04Started.orderVersion,
      actualQuantity: 200,
      completedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const firstReport = await work.submitReport(
      worker(),
      workerTask.workTaskId,
      firstReportInput,
      firstReportKey,
    );
    const firstReplay = await work.submitReport(
      worker(),
      workerTask.workTaskId,
      firstReportInput,
      firstReportKey,
    );
    expect(firstReplay.reused).toBe(true);
    expect(firstReplay.value.workReportId).toBe(firstReport.value.workReportId);
    expect(firstReport.value.memberShares[0]?.amount).toBe(0);

    const tailReportingView = await work.list(tailInspect(), submitted.value.reworkOrderId);
    const tailReported = await work.submitReport(
      tailInspect(),
      tailTask.workTaskId,
      CreateWorkReportSchema.parse({
        expectedOrderVersion: tailReportingView.orderVersion,
        actualQuantity: 200,
        completedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      }),
      randomUUID(),
    );
    expect(tailReported.value).toMatchObject({
      workTaskId: tailTask.workTaskId,
      status: "submitted",
    });

    const n07View = await wholeOrder.get(
      tailAudit(),
      submitted.value.reworkOrderId,
    );
    expect(n07View).toMatchObject({
      reworkStatus: "pending_order_review",
      processes: [expect.objectContaining({
        configurationItemId: approvedItem.configurationItemId,
        plannedQuantity: 200,
        completedQuantity: 200,
        complete: true,
        finalUnitPrice: 0.55,
      })],
    });

    // N05 records versioned final quantities without materializing wages.
    const n05Confirmed = await wholeOrder.approve(
      tailAudit(),
      submitted.value.reworkOrderId,
      {
        expectedOrderVersion: n07View.orderVersion,
        finalQuantities: n07View.processes.map((process) => ({
          configurationItemId: process.configurationItemId,
          finalConfirmedQuantity: process.completedQuantity,
        })),
        temporaryCoefficients: [],
      },
      randomUUID(),
    );
    expect(n05Confirmed.value.reworkStatus).toBe("pending_final_quantity_ie_review");
    expect((await database.query(
      "SELECT count(*)::int count FROM rework_wage_items WHERE rework_order_id=$1",
      [submitted.value.reworkOrderId],
    )).rows[0]).toEqual({ count: 0 });

    // N06 IE approval locks settlement quantities, creates wages, then enters responsibility.
    const n06View = await wholeOrder.get(ie(), submitted.value.reworkOrderId);
    const n06Approved = await wholeOrder.reviewFinalQuantity(
      ie(),
      submitted.value.reworkOrderId,
      { expectedOrderVersion: n06View.orderVersion, decision: "approved" },
      randomUUID(),
    );
    expect(n06Approved.value).toMatchObject({
      reworkStatus: "pending_responsibility_determination",
      processes: [expect.objectContaining({
        configurationItemId: approvedItem.configurationItemId,
        finalUnitPrice: 0.55,
      })],
    });

    // N09 splits one process between two external responsible parties. Because
    // no own-factory share exists, finalization must skip owner confirmation.
    const n07Processes = [{
      configurationItemId: approvedItem.configurationItemId,
      multiplier: "1.000",
      allocations: [
        {
          responsibilityType: "processing_factory",
          shareBps: 7000,
          multiplier: "1.200",
          supplierId: factorySupplierId,
        },
        {
          responsibilityType: "fabric_supplier",
          shareBps: 3000,
          multiplier: "1.200",
          supplierId: fabricSupplierId,
        },
      ],
    }, {
      configurationItemId: tailItem.configurationItemId,
      multiplier: "1.000",
      allocations: [{
        responsibilityType: "processing_factory",
        shareBps: 10000,
        multiplier: "1.200",
        supplierId: factorySupplierId,
      }],
    }];

    await expect(responsibility.saveDraft(
      production(),
      submitted.value.reworkOrderId,
      CreateResponsibilityDraftSchema.parse({
        expectedOrderVersion: n06Approved.value.orderVersion,
        expectedCurrentDeterminationVersion: null,
        handlerUserId: ids.production,
        tailInspectionCostBearer: null,
        processes: n07Processes,
      }),
      randomUUID(),
    )).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await database.query<{
      tail_inspection_cost_bearer: string;
      tail_inspection_cost_bearer_source: string;
    }>(
      `SELECT tail_inspection_cost_bearer,tail_inspection_cost_bearer_source
       FROM rework_orders WHERE rework_order_id=$1`,
      [submitted.value.reworkOrderId],
    )).rows[0]).toEqual({
      tail_inspection_cost_bearer: "processing_factory",
      tail_inspection_cost_bearer_source: "quality_inspection",
    });

    // Own-factory tail is a real responsibility share. Older clients omit
    // the tail row, so the service must derive it from the explicit choice.
    for (const badAllocation of [
      { responsibilityType: "own_factory", shareBps: 10000, multiplier: "1.200" },
      { responsibilityType: "processing_factory", shareBps: 10000, multiplier: "1.200", supplierId: factorySupplierId },
    ]) {
      const invalidDraft = {
        expectedOrderVersion: n06Approved.value.orderVersion,
        expectedCurrentDeterminationVersion: null, handlerUserId: ids.production,
        tailInspectionCostBearer: "own_factory",
        processes: [n07Processes[0], {
          configurationItemId: tailItem.configurationItemId,
          multiplier: "1.000", allocations: [badAllocation],
        }],
      };
      if (badAllocation.responsibilityType === "own_factory") {
        // The wire contract rejects a non-1 own-factory multiplier before
        // the application service is called; assert that synchronous boundary.
        expect(() => CreateResponsibilityDraftSchema.parse(invalidDraft))
          .toThrow("Own-factory responsibility multiplier must be 1");
      } else {
        // A valid external allocation still conflicts with the explicit
        // own-factory tail bearer, which the application service must reject.
        await expect(responsibility.saveDraft(
          production(), submitted.value.reworkOrderId,
          CreateResponsibilityDraftSchema.parse(invalidDraft), randomUUID(),
        )).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      }
    }
    const ownTailDraft = await responsibility.saveDraft(
      production(), submitted.value.reworkOrderId,
      CreateResponsibilityDraftSchema.parse({
        expectedOrderVersion: n06Approved.value.orderVersion,
        expectedCurrentDeterminationVersion: null, handlerUserId: ids.production,
        tailInspectionCostBearer: "own_factory", processes: [n07Processes[0]],
      }), randomUUID(),
    );
    expect(ownTailDraft.value.determination).toMatchObject({ calculationTotal: "172.00" });
    expect(ownTailDraft.value.determination!.processes).toHaveLength(2);
    expect(ownTailDraft.value.determination!.processes.find(
      (process) => process.configurationItemId === tailItem.configurationItemId,
    )).toMatchObject({
      baseAmount: "40.00", responsibilityAmount: "40.00",
      allocations: [expect.objectContaining({ responsibilityType: "own_factory", shareBps: 10000, multiplier: "1.000", roundedAmount: "40.00" })],
    });

    const n07Draft = await responsibility.saveDraft(
      production(),
      submitted.value.reworkOrderId,
      CreateResponsibilityDraftSchema.parse({
        expectedOrderVersion: ownTailDraft.value.orderVersion,
        expectedCurrentDeterminationVersion: ownTailDraft.value.determination!.version,
        handlerUserId: ids.production,
        tailInspectionCostBearer: "processing_factory",
        processes: n07Processes,
      }),
      randomUUID(),
    );
    expect(n07Draft.value.determination).toMatchObject({
      stage: "draft",
      calculationTotal: "180.00",
    });
    expect(n07Draft.value.determination!.processes).toHaveLength(2);
    const workerResponsibility = n07Draft.value.determination!.processes.find(
      (process) => process.configurationItemId === approvedItem.configurationItemId,
    );
    expect(workerResponsibility).toMatchObject({
      baseAmount: "110.00",
      responsibilityAmount: "132.00",
      allocations: expect.arrayContaining([
        expect.objectContaining({
          responsibilityType: "fabric_supplier",
          shareBps: 3000,
          roundedAmount: "39.60",
        }),
        expect.objectContaining({
          responsibilityType: "processing_factory",
          shareBps: 7000,
          roundedAmount: "92.40",
        }),
      ]),
    });
    const tailResponsibility = n07Draft.value.determination!.processes.find(
      (process) => process.configurationItemId === tailItem.configurationItemId,
    );
    expect(tailResponsibility).toMatchObject({
      baseAmount: "40.00",
      responsibilityAmount: "48.00",
      allocations: [expect.objectContaining({
        responsibilityType: "processing_factory",
        shareBps: 10000,
        roundedAmount: "48.00",
      })],
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
    expect(n07Final.value.reworkStatus).toBe("completed");
    expect(n07Final.value.canOwnerSign).toBe(false);
    expect(n07Final.value.ownerSignature).toBeNull();
    const N07Notices = await database.query<{
      recipient_user_id: string;
      todo_type: string;
      category: string;
      status: string;
    }>(
      `SELECT recipient_user_id,todo_type,category,status
       FROM rework_todos
       WHERE entity_type='rework_order' AND entity_id=$1
         AND category='responsibility_finalized_notice'
       ORDER BY recipient_user_id`,
      [submitted.value.reworkOrderId],
    );
    expect(N07Notices.rows).toEqual([
      ids.embroideryMerchandiser,
      ids.merchandiser,
    ].sort().map((recipient_user_id) => ({
      recipient_user_id,
      todo_type: "information",
      category: "responsibility_finalized_notice",
      status: "pending",
    })));

    const externalCases = await database.query<{
      caseId: string;
      responsibilityType: string;
      supplierId: string;
      proposedAmount: string;
      status: string;
    }>(
      `SELECT case_id AS "caseId",
              responsibility_type AS "responsibilityType",
              supplier_id AS "supplierId",
              proposed_deduction_amount::text AS "proposedAmount",
              status
       FROM rework_external_responsibility_cases
       WHERE rework_order_id=$1
       ORDER BY responsibility_type`,
      [submitted.value.reworkOrderId],
    );
    expect(externalCases.rows.map((item) => ({
      responsibilityType: item.responsibilityType,
      supplierId: item.supplierId,
      proposedAmount: item.proposedAmount,
      status: item.status,
    }))).toEqual([
      {
        responsibilityType: "fabric_supplier",
        supplierId: fabricSupplierId,
        proposedAmount: "39.60",
        status: "deduction_follow_up",
      },
      {
        responsibilityType: "processing_factory",
        supplierId: factorySupplierId,
        proposedAmount: "140.40",
        status: "deduction_follow_up",
      },
    ]);
    expect((await database.query<{ status: string }>(
      "SELECT status FROM rework_orders WHERE rework_order_id=$1",
      [submitted.value.reworkOrderId],
    )).rows[0]).toEqual({ status: "completed" });

    // N11 / PR-07 - exact deductions close normally; partial or failed
    // deductions require one append-only finance-director decision.
    const processingCaseId = externalCases.rows.find(
      (item) => item.responsibilityType === "processing_factory",
    )!.caseId;
    const fabricCaseId = externalCases.rows.find(
      (item) => item.responsibilityType === "fabric_supplier",
    )!.caseId;
    const initialProcessingCase = await external.getCase(
      factoryPayables("external_deduction:record"),
      processingCaseId,
    );
    const partialDeduction = await external.recordDeduction(
      factoryPayables("external_deduction:record"),
      processingCaseId,
      CreateExternalDeductionEntrySchema.parse({
        expectedCaseVersion: initialProcessingCase.caseVersion,
        entryType: "deduction",
        amount: "80.00",
        deductedOn: new Date().toISOString().slice(0, 10),
        attachmentIds: [],
      }),
      randomUUID(),
    );
    await expect(external.close(
      factoryPayables("external_deduction:close"),
      processingCaseId,
      CloseExternalDeductionCaseSchema.parse({
        expectedCaseVersion: partialDeduction.value.caseVersion,
        result: "full",
        evidenceAttachmentIds: [],
      }),
      randomUUID(),
    )).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const firstRequest = await external.requestSpecialApproval(
      factoryPayables("external_deduction:close"),
      processingCaseId,
      RequestExternalDeductionSpecialApprovalSchema.parse({
        expectedCaseVersion: partialDeduction.value.caseVersion,
        reason: "供应商只确认扣款 80 元",
        attachmentIds: [],
      }),
      randomUUID(),
    );
    expect(firstRequest.value).toMatchObject({
      status: "pending_special_approval",
      canRequestSpecialApproval: false,
      specialApproval: {
        requestVersion: 1,
        proposedAmount: "140.40",
        actualDeductedAmount: "80.00",
        remainingAmount: "60.40",
        decision: null,
      },
    });
    expect((await database.query<{
      recipientUserId: string;
      provider: string;
      outcome: string;
    }>(
      `SELECT todo.recipient_user_id AS "recipientUserId",
              attempt.provider,attempt.outcome
       FROM rework_todos todo
       JOIN todo_delivery_attempts attempt USING(todo_id)
       WHERE todo.category='external_deduction_special_approval'
         AND todo.entity_id=$1
       ORDER BY attempt.attempted_at DESC LIMIT 1`,
      [submitted.value.reworkOrderId],
    )).rows[0]).toEqual({
      recipientUserId: ids.financeDirector,
      provider: "dingtalk",
      outcome: "queued",
    });

    const returned = await external.returnSpecialApproval(
      financeDirector(),
      processingCaseId,
      ReturnExternalDeductionSpecialApprovalSchema.parse({
        expectedCaseVersion: firstRequest.value.caseVersion,
        expectedRequestVersion: 1,
        reason: "请继续与供应商核对差额",
      }),
      randomUUID(),
    );
    expect(returned.value).toMatchObject({
      status: "deduction_follow_up",
      specialApproval: { decision: { decision: "returned" } },
    });
    const secondRequest = await external.requestSpecialApproval(
      factoryPayables("external_deduction:close"),
      processingCaseId,
      RequestExternalDeductionSpecialApprovalSchema.parse({
        expectedCaseVersion: returned.value.caseVersion,
        reason: "供应商确认最终只能扣款 80 元",
        attachmentIds: [],
      }),
      randomUUID(),
    );
    expect(secondRequest.value.specialApproval).toMatchObject({
      requestVersion: 2,
      decision: null,
    });
    const speciallyClosed = await external.approveSpecialApproval(
      financeDirector(),
      processingCaseId,
      ApproveExternalDeductionSpecialApprovalSchema.parse({
        expectedCaseVersion: secondRequest.value.caseVersion,
        expectedRequestVersion: 2,
        reason: "确认按实际扣款关闭",
      }),
      randomUUID(),
    );
    expect(speciallyClosed.value).toMatchObject({
      status: "closed",
      closure: {
        result: "partial",
        proposedAmount: "140.40",
        actualDeductedAmount: "80.00",
        remainingAmount: "60.40",
      },
      specialApproval: { decision: { decision: "approved" } },
    });
    await expect(database.query(
      "UPDATE rework_external_deduction_special_decisions SET reason='tampered' WHERE special_request_id=$1",
      [speciallyClosed.value.specialApproval!.requestId],
    )).rejects.toThrow();

    const initialFabricCase = await external.getCase(
      fabricPayables("external_deduction:record"),
      fabricCaseId,
    );
    const fullDeduction = await external.recordDeduction(
      fabricPayables("external_deduction:record"),
      fabricCaseId,
      CreateExternalDeductionEntrySchema.parse({
        expectedCaseVersion: initialFabricCase.caseVersion,
        entryType: "deduction",
        amount: "39.60",
        deductedOn: new Date().toISOString().slice(0, 10),
        attachmentIds: [],
      }),
      randomUUID(),
    );
    const normallyClosed = await external.close(
      fabricPayables("external_deduction:close"),
      fabricCaseId,
      CloseExternalDeductionCaseSchema.parse({
        expectedCaseVersion: fullDeduction.value.caseVersion,
        result: "full",
        evidenceAttachmentIds: [],
      }),
      randomUUID(),
    );
    expect(normallyClosed.value).toMatchObject({
      status: "closed",
      closure: { result: "full", remainingAmount: "0.00" },
    });

    /* Historical N08-B scenario retained below as reference only. Current V2
       N09/N11 execution is covered by the active assertions and Root double pass.
    expect(externalBatch!.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        responsibilityType: "processing_factory",
        supplier: expect.objectContaining({ supplierId: factorySupplierId }),
        proposedDeductionAmount: "66.00",
        actualDeductedAmount: "0.00",
        status: "deduction_follow_up",
        caseVersion: 1,
      }),
      expect.objectContaining({
        responsibilityType: "fabric_supplier",
        supplier: expect.objectContaining({ supplierId: fabricSupplierId }),
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
    */

    // Wage settlement remains independent from the closed business flow.
    // The current natural month is intentionally not force-locked: the service
    // must reach ready_to_lock and then enforce the month-end barrier. The
    // historical-month lock itself remains covered by wage-workflow-postgres.
    const periods = await wages.list(wageView());
    expect(periods).toHaveLength(1);
    const wagePeriod = periods[0]!;
    expect(wagePeriod).toMatchObject({
      status: "ready_to_lock",
      sourceItemCount: 2,
      personCount: 2,
      totalAmount: "150.00",
    });
    const wageDetail = await wages.get(wageView(), wagePeriod.periodId);
    expect(wageDetail.items).toHaveLength(2);
    expect(wageDetail.items.reduce(
      (sum, item) => sum + Number(item.payableAmount),
      0,
    )).toBe(150);
    expect(wageDetail.period.totalAmount).toBe("150.00");
    await expect(wages.lock(
      monthCloseWage(),
      wagePeriod.periodId,
      wagePeriod.periodVersion,
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
         (SELECT COALESCE(sum(proposed_deduction_amount),0)::numeric(18,2)::text
          FROM rework_external_responsibility_cases WHERE rework_order_id=$1) external_total,
         (SELECT sum(payable_amount)::numeric(18,2)::text
          FROM rework_wage_items WHERE rework_order_id=$1) wage_total`,
      [submitted.value.reworkOrderId],
    );
    expect(totals.rows[0]).toEqual({
      report_total: "150.00",
      responsibility_total: "180.00",
      own_factory_total: "0.00",
      external_total: "180.00",
      wage_total: "150.00",
    });
    const openBusinessTodos = await database.query<{ category: string }>(
      `SELECT category
       FROM rework_todos
       WHERE todo_type='business_action'
         AND status IN ('pending','blocked_recipient')
       ORDER BY category,todo_id`,
    );
    expect(openBusinessTodos.rows).toEqual([]);
  });

  it("recovers a required-tail order only after every unified worker and tail task has a valid report", async () => {
    const imageId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'n04-required-tail-recovery.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [imageId, `private/${imageId}.webp`, "b".repeat(64), ids.qc],
    );
    const draft = await initiation.createDraft(qc(), {
      styleNo: "UAT-N04-REQUIRED-TAIL-RECOVERY",
      orderQuantity: 500,
      orderNo: "ORDER-N04-REQUIRED-TAIL-RECOVERY",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "supplier", supplierId: factorySupplierId },
      tailInspectionCostBearer: "processing_factory",
      inspectionReport: n01CoreInspectionReport("节点04需要尾查恢复测试款"),
      problemPart: "后幅",
      problemDescription: "普通返工与尾查均已上数但状态仍停在节点04",
      reworkQuantity: 200,
      attachmentIds: [imageId],
    }, randomUUID());
    const submitted = await initiation.submit(
      qc(), draft.value.reworkOrderId, { expectedVersion: draft.value.version }, randomUUID(),
    );
    const saved = await configuration.saveDraft(
      tailConfigure(),
      submitted.value.reworkOrderId,
      SaveProcessConfigurationSchema.parse({
        expectedOrderVersion: submitted.value.version,
        items: [{
          source: "catalog",
          processId: publicProcessId,
          executionKind: "worker",
          plannedQuantity: 200,
          pricingUnit: "piece",
          unitPrice: 0.55,
        }, {
          source: "custom",
          customProcessName: "尾查",
          executionKind: "tail_inspection",
          plannedQuantity: 1,
          pricingUnit: "piece",
          unitPrice: 0.2,
        }],
      }),
      randomUUID(),
    );
    const workerItem = saved.value.configuration!.items.find((item) => item.executionKind === "worker")!;
    const tailItem = saved.value.configuration!.items.find((item) => item.executionKind === "tail_inspection")!;
    await database.query(
      "ALTER TABLE rework_process_configurations DISABLE TRIGGER rework_process_configurations_guard_update",
    );
    try {
      await database.query(
        "UPDATE rework_process_configurations SET unified_execution_required=false WHERE configuration_id=$1",
        [saved.value.configuration!.configurationId],
      );
    } finally {
      await database.query(
        "ALTER TABLE rework_process_configurations ENABLE TRIGGER rework_process_configurations_guard_update",
      );
    }
    await workerPlan.save(
      tailAssign(),
      submitted.value.reworkOrderId,
      {
        expectedOrderVersion: saved.value.orderVersion,
        configurationId: saved.value.configuration!.configurationId,
        expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
        assignments: [
          { configurationItemId: workerItem.configurationItemId, memberIds: [workerPersonId] },
          { configurationItemId: tailItem.configurationItemId, memberIds: [tailPersonId] },
        ],
      },
      randomUUID(),
    );
    const queued = await configuration.submit(
      tailConfigure(),
      submitted.value.reworkOrderId,
      SubmitProcessConfigurationSchema.parse({
        expectedOrderVersion: saved.value.orderVersion,
        expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
      }),
      randomUUID(),
    );
    const approved = await configuration.review(
      ie(),
      submitted.value.reworkOrderId,
      ReviewProcessConfigurationSchema.parse({
        expectedOrderVersion: queued.value.orderVersion,
        expectedConfigurationVersion: queued.value.configuration!.configurationVersion,
        decision: "approved",
      }),
      randomUUID(),
    );
    await workerPlan.activateAfterIeApproval(
      submitted.value.reworkOrderId,
      approved.value.configuration!.configurationVersion,
      randomUUID(),
    );
    const started = await work.list(tailAssign(), submitted.value.reworkOrderId);
    const workerTask = started.tasks.find((task) => task.executionKind === "worker")!;
    const tailTask = started.tasks.find((task) => task.executionKind === "tail_inspection")!;
    await work.submitReport(worker(), workerTask.workTaskId, CreateWorkReportSchema.parse({
      expectedOrderVersion: started.orderVersion,
      actualQuantity: 200,
      completedAt: new Date().toISOString(),
    }), randomUUID());
    const afterWorker = await work.list(tailInspect(), submitted.value.reworkOrderId);
    await work.submitReport(tailInspect(), tailTask.workTaskId, CreateWorkReportSchema.parse({
      expectedOrderVersion: afterWorker.orderVersion,
      actualQuantity: 200,
      completedAt: new Date().toISOString(),
    }), randomUUID());

    const stuck = await work.list(tailAssign(), submitted.value.reworkOrderId);
    expect(stuck).toMatchObject({ reworkStatus: "in_progress" });
    expect(stuck.tasks.every((task) => task.remainingQuantity === 0)).toBe(true);

    const recovered = await work.completeExecution(
      tailAssign(),
      submitted.value.reworkOrderId,
      { expectedOrderVersion: stuck.orderVersion },
      randomUUID(),
    );
    expect(recovered.value).toMatchObject({
      reworkStatus: "pending_order_review",
      orderVersion: stuck.orderVersion + 1,
    });
    expect((await database.query<{ tail_inspection_required: boolean }>(
      "SELECT tail_inspection_required FROM rework_orders WHERE rework_order_id=$1",
      [submitted.value.reworkOrderId],
    )).rows[0]).toEqual({ tail_inspection_required: true });
    expect((await database.query<{ source_action: string; status: string }>(
      "SELECT source_action,status FROM rework_todos WHERE dedupe_key=$1",
      [`whole-order-review:${submitted.value.reworkOrderId}:${recovered.value.orderVersion}`],
    )).rows[0]).toEqual({ source_action: "rework.execution.complete", status: "pending" });

    const n05View = await wholeOrder.get(tailAudit(), submitted.value.reworkOrderId);
    expect(n05View).toMatchObject({
      reworkStatus: "pending_order_review",
      unifiedExecutionRequired: false,
      tailInspectionRequired: true,
      processes: [expect.objectContaining({
        configurationItemId: workerItem.configurationItemId,
        completedQuantity: 200,
        tailCheckedQuantity: 200,
        countGap: 0,
        complete: true,
      })],
    });
    const n05Confirmed = await wholeOrder.approve(
      tailAudit(),
      submitted.value.reworkOrderId,
      {
        expectedOrderVersion: n05View.orderVersion,
        finalQuantities: n05View.processes.map((process) => ({
          configurationItemId: process.configurationItemId,
          finalConfirmedQuantity: process.completedQuantity,
        })),
        temporaryCoefficients: [],
      },
      randomUUID(),
    );
    expect(n05Confirmed.value.reworkStatus).toBe("pending_final_quantity_ie_review");
    expect((await database.query<{
      worker_reported_quantity: string;
      tail_reported_quantity: string;
      final_confirmed_quantity: string;
    }>(
      `SELECT quantity.worker_reported_quantity::text,
              quantity.tail_reported_quantity::text,
              quantity.final_confirmed_quantity::text
       FROM rework_tail_completion_quantities quantity
       JOIN rework_tail_completion_confirmations confirmation
         ON confirmation.confirmation_id=quantity.confirmation_id
       WHERE confirmation.rework_order_id=$1`,
      [submitted.value.reworkOrderId],
    )).rows).toEqual([{
      worker_reported_quantity: "200.00",
      tail_reported_quantity: "200.00",
      final_confirmed_quantity: "200.00",
    }]);
  });

  it.each([
    { executionModel: "unified", legacy: false },
    { executionModel: "legacy", legacy: true },
  ])(
    "waives an existing wrong $executionModel tail report without deleting audit facts or paying tail wages",
    async ({ legacy }) => {
    const imageId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'tail-waiver.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [imageId, `private/${imageId}.webp`, "a".repeat(64), ids.qc],
    );
    const draft = await initiation.createDraft(qc(), {
      styleNo: "UAT-TAIL-WAIVER",
      orderQuantity: 500,
      orderNo: "ORDER-TAIL-WAIVER",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "supplier", supplierId: factorySupplierId },
      tailInspectionCostBearer: "processing_factory",
      inspectionReport: n01CoreInspectionReport("免尾查测试款"),
      problemPart: "后幅",
      problemDescription: "历史订单实际无需尾查",
      reworkQuantity: 200,
      attachmentIds: [imageId],
    }, randomUUID());
    const submitted = await initiation.submit(
      qc(), draft.value.reworkOrderId, { expectedVersion: draft.value.version }, randomUUID(),
    );
    const saved = await configuration.saveDraft(
      tailConfigure(),
      submitted.value.reworkOrderId,
      SaveProcessConfigurationSchema.parse({
        expectedOrderVersion: submitted.value.version,
        items: [{
          source: "catalog",
          processId: publicProcessId,
          executionKind: "worker",
          plannedQuantity: 200,
          pricingUnit: "piece",
          unitPrice: 0.55,
        }, {
          source: "custom",
          customProcessName: "尾查",
          executionKind: "tail_inspection",
          plannedQuantity: 1,
          pricingUnit: "piece",
          unitPrice: 0.2,
        }],
      }),
      randomUUID(),
    );
    const workerItem = saved.value.configuration!.items.find((item) => item.executionKind === "worker")!;
    const tailItem = saved.value.configuration!.items.find((item) => item.executionKind === "tail_inspection")!;
    if (legacy) {
      await database.query(
        "ALTER TABLE rework_process_configurations DISABLE TRIGGER rework_process_configurations_guard_update",
      );
      try {
        await database.query(
          "UPDATE rework_process_configurations SET unified_execution_required=false WHERE configuration_id=$1",
          [saved.value.configuration!.configurationId],
        );
      } finally {
        await database.query(
          "ALTER TABLE rework_process_configurations ENABLE TRIGGER rework_process_configurations_guard_update",
        );
      }
    }
    await workerPlan.save(
      tailAssign(),
      submitted.value.reworkOrderId,
      {
        expectedOrderVersion: saved.value.orderVersion,
        configurationId: saved.value.configuration!.configurationId,
        expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
        assignments: [
          { configurationItemId: workerItem.configurationItemId, memberIds: [workerPersonId] },
          { configurationItemId: tailItem.configurationItemId, memberIds: [tailPersonId] },
        ],
      },
      randomUUID(),
    );
    const queued = await configuration.submit(
      tailConfigure(),
      submitted.value.reworkOrderId,
      SubmitProcessConfigurationSchema.parse({
        expectedOrderVersion: saved.value.orderVersion,
        expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
      }),
      randomUUID(),
    );
    const approved = await configuration.review(
      ie(),
      submitted.value.reworkOrderId,
      ReviewProcessConfigurationSchema.parse({
        expectedOrderVersion: queued.value.orderVersion,
        expectedConfigurationVersion: queued.value.configuration!.configurationVersion,
        decision: "approved",
      }),
      randomUUID(),
    );
    await workerPlan.activateAfterIeApproval(
      submitted.value.reworkOrderId,
      approved.value.configuration!.configurationVersion,
      randomUUID(),
    );
    const started = await work.list(tailAssign(), submitted.value.reworkOrderId);
    const workerTask = started.tasks.find((task) => task.executionKind === "worker")!;
    await work.submitReport(worker(), workerTask.workTaskId, CreateWorkReportSchema.parse({
      expectedOrderVersion: started.orderVersion,
      actualQuantity: 200,
      completedAt: new Date().toISOString(),
    }), randomUUID());
    const afterWorker = await work.list(tailInspect(), submitted.value.reworkOrderId);
    const tailTask = started.tasks.find((task) => task.executionKind === "tail_inspection")!;
    const unifiedWrongTail = await work.submitReport(
      tailInspect(),
      tailTask.workTaskId,
      CreateWorkReportSchema.parse({
        expectedOrderVersion: afterWorker.orderVersion,
        actualQuantity: 180,
        completedAt: new Date().toISOString(),
      }),
      randomUUID(),
    );
    let wrongTailReportId: string;
    let correctionTodoKey: string;
    let waiverVersion: number;
    let legacyAssignmentId: string | null = null;
    if (legacy) {
      const configurationEvent = (await database.query<{
        actor_id: string;
        event_id: string;
        request_id: string;
      }>(
        `SELECT actor_id,event_id,request_id
         FROM operation_events
         WHERE action='rework.process_configuration.submit'
           AND entity_id=$1
         ORDER BY created_at DESC,event_id DESC
         LIMIT 1`,
        [submitted.value.reworkOrderId],
      )).rows[0]!;
      legacyAssignmentId = randomUUID();
      await database.query(
        `INSERT INTO rework_tail_inspection_assignments(
           tail_inspection_assignment_id,rework_order_id,tail_inspector_user_id,
           assigned_by,operation_event_id,request_id
         ) VALUES($1,$2,$3,$4,$5,$6)`,
        [
          legacyAssignmentId,
          submitted.value.reworkOrderId,
          ids.tailInspector,
          configurationEvent.actor_id,
          configurationEvent.event_id,
          configurationEvent.request_id,
        ],
      );
      await legacyTailInspection.submit(tailInspect(), legacyAssignmentId, {
        returnedQuantity: 180,
        items: [{
          configurationItemId: workerItem.configurationItemId,
          inspectedQuantity: 180,
        }, {
          configurationItemId: tailItem.configurationItemId,
          inspectedQuantity: 180,
        }],
      }, randomUUID());
      wrongTailReportId = (await database.query<{ tail_inspection_report_id: string }>(
        `SELECT tail_inspection_report_id
         FROM rework_tail_inspection_reports
         WHERE tail_inspection_assignment_id=$1 AND status='submitted'`,
        [legacyAssignmentId],
      )).rows[0]!.tail_inspection_report_id;
      const beforeWaiver = await work.list(tailAssign(), submitted.value.reworkOrderId);
      expect(beforeWaiver.reworkStatus).toBe("pending_order_review");
      await legacyTailInspection.reject(tailAudit(), legacyAssignmentId, {
        expectedOrderVersion: beforeWaiver.orderVersion,
        reason: "尾查工序配置错误，该报数无需重报",
      }, randomUUID());
      waiverVersion = beforeWaiver.orderVersion;
      correctionTodoKey = `tail-inspection-return:${wrongTailReportId}`;
    } else {
      wrongTailReportId = unifiedWrongTail.value.workReportId;
      const beforeWaiver = await work.list(tailAssign(), submitted.value.reworkOrderId);
      expect(beforeWaiver.reworkStatus).toBe("pending_order_review");
      const rejectedWrongTail = await wholeOrder.rejectReport(
        tailAudit(),
        wrongTailReportId,
        {
          expectedOrderVersion: beforeWaiver.orderVersion,
          rejectedPersonId: tailPersonId,
          reason: "尾查工序配置错误，该报数无需重报",
        },
        randomUUID(),
      );
      expect(rejectedWrongTail.value.reworkStatus).toBe("in_progress");
      waiverVersion = rejectedWrongTail.value.orderVersion;
      correctionTodoKey = `work-report-return:${wrongTailReportId}`;
    }
    expect((await database.query<{ status: string }>(
      "SELECT status FROM rework_todos WHERE dedupe_key=$1",
      [correctionTodoKey],
    )).rows[0]).toEqual({ status: "pending" });

    await expect(initiation.waiveTailInspection(
      actor(ids.qc, ["quality_control"], "tail_inspection:waive"),
      submitted.value.reworkOrderId,
      { expectedVersion: waiverVersion, reason: "权限验证" },
      randomUUID(),
    )).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    const waived = await initiation.waiveTailInspection(
      actor(ids.ownerOne, ["owner_group"], "tail_inspection:waive"),
      submitted.value.reworkOrderId,
      { expectedVersion: waiverVersion, reason: "工序实际无需尾查，原尾查数上报错误" },
      randomUUID(),
    );
    expect(waived.value).toMatchObject({
      status: "pending_order_review",
      tailInspectionRequired: false,
      tailInspectionCostBearer: null,
      tailInspectionCostBearerSource: null,
      version: waiverVersion + 1,
    });
    if (legacy) {
      expect((await database.query(
        `SELECT report.status,assignment.revoked_at IS NOT NULL AS revoked
         FROM rework_tail_inspection_reports report
         JOIN rework_tail_inspection_assignments assignment
           ON assignment.tail_inspection_assignment_id=report.tail_inspection_assignment_id
         WHERE report.tail_inspection_report_id=$1
           AND assignment.tail_inspection_assignment_id=$2`,
        [wrongTailReportId, legacyAssignmentId],
      )).rows).toEqual([{ status: "rejected", revoked: true }]);
    } else {
      expect((await database.query(
        `SELECT report.work_report_id,task.status,
                EXISTS(SELECT 1 FROM rework_work_report_rejections rejection
                       WHERE rejection.work_report_id=report.work_report_id) AS rejected
         FROM rework_work_reports report
         JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
         WHERE report.work_report_id=$1`,
        [wrongTailReportId],
      )).rows).toEqual([{
        work_report_id: wrongTailReportId,
        status: "superseded",
        rejected: true,
      }]);
    }
    expect((await database.query<{ status: string }>(
      "SELECT status FROM rework_todos WHERE dedupe_key=$1",
      [correctionTodoKey],
    )).rows[0]).toEqual({ status: "cancelled" });
    expect((await database.query<{ source_action: string; status: string }>(
      "SELECT source_action,status FROM rework_todos WHERE dedupe_key=$1",
      [`whole-order-review:${submitted.value.reworkOrderId}:${waived.value.version}`],
    )).rows[0]).toEqual({
      source_action: "rework.tail_inspection.waive",
      status: "pending",
    });

    const reviewView = await wholeOrder.get(tailAudit(), submitted.value.reworkOrderId);
    expect(reviewView).toMatchObject({
      reworkStatus: "pending_order_review",
      tailInspectionRequired: false,
      processes: [expect.objectContaining({
        configurationItemId: workerItem.configurationItemId,
        completedQuantity: 200,
      })],
    });
    await wholeOrder.approve(tailAudit(), submitted.value.reworkOrderId, {
      expectedOrderVersion: reviewView.orderVersion,
      finalQuantities: [{
        configurationItemId: workerItem.configurationItemId,
        finalConfirmedQuantity: 200,
      }],
      temporaryCoefficients: [],
    }, randomUUID());
    const ieView = await wholeOrder.get(ie(), submitted.value.reworkOrderId);
    const finalized = await wholeOrder.reviewFinalQuantity(ie(), submitted.value.reworkOrderId, {
      expectedOrderVersion: ieView.orderVersion,
      decision: "approved",
    }, randomUUID());
    expect((await database.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM rework_wage_items wage
       JOIN rework_work_reports report ON report.work_report_id=wage.work_report_id
       WHERE wage.rework_order_id=$1 AND report.configuration_item_id=$2`,
      [submitted.value.reworkOrderId, tailItem.configurationItemId],
    )).rows[0]).toEqual({ count: 0 });
    await expect(initiation.waiveTailInspection(
      actor(ids.ownerOne, ["owner_group"], "tail_inspection:waive"),
      submitted.value.reworkOrderId,
      { expectedVersion: finalized.value.orderVersion, reason: "不应允许下游重复操作" },
      randomUUID(),
    )).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
  });

  it("submits simplified N01 without retired manual-entry facts", async () => {
    const initialImageId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'n01-v2-minimal.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [initialImageId, `private/${initialImageId}.webp`, "f".repeat(64), ids.qc],
    );
    const draft = await initiation.createDraft(qc(), {
      styleNo: "UAT-N01-V2-MINIMAL",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "supplier", supplierId: factorySupplierId },
      tailInspectionCostBearer: "processing_factory",
      attachmentIds: [initialImageId],
    }, randomUUID());

    expect(draft.value).toMatchObject({
      status: "draft",
      styleNo: "UAT-N01-V2-MINIMAL",
      orderQuantity: null,
      merchandiserUserId: ids.merchandiser,
      problemPart: null,
      problemDescription: null,
      reworkQuantity: null,
      inspectionReport: null,
    });

    const submitted = await v2Submission.submit(qc(), draft.value.reworkOrderId, {
      expectedVersion: draft.value.version,
    }, randomUUID());

    expect(submitted.value).toMatchObject({
      status: "pending_process_configuration",
      styleNo: "UAT-N01-V2-MINIMAL",
      orderQuantity: null,
      merchandiserUserId: ids.merchandiser,
      problemPart: null,
      problemDescription: null,
      reworkQuantity: null,
      inspectionReport: null,
    });
    expect(submitted.value.reworkNo).toMatch(/^RW-\d{4}-\d{4}-\d{3,}$/);
  });

  it("appends tail defective quantity under audit and distinguishes an unlinked receiving source", async () => {
    const initialImageId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'tail-defective.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [initialImageId, `private/${initialImageId}.webp`, "7".repeat(64), ids.qc],
    );
    const draft = await initiation.createDraft(qc(), {
      styleNo: "UAT-TAIL-DEFECTIVE",
      orderQuantity: 20,
      orderNo: "ORDER-TAIL-DEFECTIVE",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "supplier", supplierId: factorySupplierId },
      tailInspectionCostBearer: "processing_factory",
      inspectionReport: n01CoreInspectionReport("尾部次品链路"),
      problemPart: "尾部",
      problemDescription: "尾部次品追加真实链路验收",
      reworkQuantity: 20,
      attachmentIds: [initialImageId],
    }, randomUUID());
    await supplyContext.save(qc(), draft.value.reworkOrderId, {
      washingSupplierId: null,
      embroiderySupplierId: null,
      fabricSupplierId: null,
      embroideryMerchandiserUserId: ids.embroideryMerchandiser,
    });
    const submitted = await initiation.submit(
      qc(),
      draft.value.reworkOrderId,
      { expectedVersion: draft.value.version },
      randomUUID(),
    );

    const tailActor = actor(ids.tail, ["tail_supervisor"], "tools:user");
    const before = await businessDetail.get(tailActor, submitted.value.reworkOrderId);
    expect(before.defectiveQuantity).toMatchObject({
      receiving: 0,
      receivingLinked: false,
      tail: 0,
      total: 0,
    });

    const idempotencyKey = randomUUID();
    const added = await businessDetail.addTailDefectiveQuantity(
      tailActor,
      submitted.value.reworkOrderId,
      { expectedVersion: before.version, quantity: 2 },
      idempotencyKey,
    );
    expect(added).toMatchObject({
      reused: false,
      value: {
        version: before.version + 1,
        defectiveQuantity: {
          receiving: 0,
          receivingLinked: false,
          tail: 2,
          total: 2,
        },
      },
    });
    const reused = await businessDetail.addTailDefectiveQuantity(
      tailActor,
      submitted.value.reworkOrderId,
      { expectedVersion: before.version, quantity: 2 },
      idempotencyKey,
    );
    expect(reused).toMatchObject({ reused: true });
    expect((await database.query(
      `SELECT entry.quantity,event.action,event.actor_id,orders.updated_by
       FROM rework_tail_defective_quantity_entries entry
       JOIN operation_events event ON event.event_id=entry.operation_event_id
       JOIN rework_orders orders ON orders.rework_order_id=entry.rework_order_id
       WHERE entry.rework_order_id=$1`,
      [submitted.value.reworkOrderId],
    )).rows).toEqual([{
      quantity: 2,
      action: "rework.tail_defective_quantity.add",
      actor_id: ids.tail,
      updated_by: ids.tail,
    }]);
  });
});

