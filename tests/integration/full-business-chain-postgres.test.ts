import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  CreateResponsibilityDraftSchema,
  CreateWorkReportSchema,
  CreateWorkTaskSchema,
  ReviewProcessConfigurationSchema,
  SaveProcessConfigurationSchema,
  SubmitProcessConfigurationSchema,
} from "@dx-rework/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { BusinessAwareWholeOrderReviewService } from "../../apps/api/src/rework/business-aware-whole-order-review-service.js";
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
  const configuration = new ProcessConfigurationService(
    database,
    undefined,
    undefined,
    undefined,
    todoProjection,
  );
  const work = new WorkReportingService(database, undefined, undefined, todoProjection);
  const wholeOrder = new BusinessAwareWholeOrderReviewService(database, todoProjection);
  const responsibility = new ResponsibilityDeterminationApplicationService(
    database,
    todoProjection,
  );
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
      orderQuantity: 1_000,
      orderNo: "ORDER-FULL-001",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "supplier", supplierId: factorySupplierId },
      inspectionReport: n01CoreInspectionReport("全链测试款"),
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

    // N02 records process, planned quantity and price; N03 IE must approve it.
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
    const approvedItem = n03Approved.value.configuration!.items[0]!;
    expect(approvedItem).toMatchObject({
      processId: publicProcessId,
      processName: "袖口返修",
      plannedQuantity: 200,
      pricingUnit: "piece",
      unitPrice: 0.55,
    });

    // N03 needs an explicit assignment confirmation before work starts.
    const task = await work.createTask(
      tailAssign(),
      submitted.value.reworkOrderId,
      CreateWorkTaskSchema.parse({
        expectedOrderVersion: n03Approved.value.orderVersion,
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
    const pendingAssignments = await work.list(
      tailAssign(),
      submitted.value.reworkOrderId,
    );
    const n04Started = await work.confirmAssignments(
      tailAssign(),
      submitted.value.reworkOrderId,
      { expectedOrderVersion: pendingAssignments.orderVersion },
      randomUUID(),
    );
    expect(n04Started.value.reworkStatus).toBe("in_progress");

    // N05 has one final completion report per assigned task; wage is still
    // generated only after N06 confirms the quantity.
    const firstReportKey = randomUUID();
    const firstReportInput = CreateWorkReportSchema.parse({
      expectedOrderVersion: n04Started.value.orderVersion,
      actualQuantity: 200,
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
    expect(firstReport.value.memberShares[0]?.amount).toBe(0);

    const n05View = await wholeOrder.get(
      tailAudit(),
      submitted.value.reworkOrderId,
    );
    expect(n05View).toMatchObject({
      reworkStatus: "pending_order_review",
      processes: [expect.objectContaining({
        configurationItemId: approvedItem.configurationItemId,
        plannedQuantity: 200,
        completedQuantity: 200,
        complete: true,
        finalUnitPrice: 0.55,
      })],
    });

    // N06 confirms valid quantities and creates wages directly from N03 price.
    const n06Approved = await wholeOrder.approve(
      tailAudit(),
      submitted.value.reworkOrderId,
      {
        expectedOrderVersion: n05View.orderVersion,
        temporaryCoefficients: [],
      },
      randomUUID(),
    );
    expect(n06Approved.value).toMatchObject({
      reworkStatus: "pending_responsibility_determination",
      processes: [expect.objectContaining({
        configurationItemId: approvedItem.configurationItemId,
        finalUnitPrice: 0.55,
      })],
    });

    // N07 records one primary responsibility for each process. Shared
    // responsibility remains explanatory text and does not split money.
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
          allocations: [{
            responsibilityType: "processing_factory",
            shareBps: 10000,
            multiplier: "1.200",
            supplierId: factorySupplierId,
          }],
        }],
      }),
      randomUUID(),
    );
    expect(n07Draft.value.determination).toMatchObject({
      stage: "draft",
      calculationTotal: "132.00",
      processes: [{
        baseAmount: "110.00",
        responsibilityAmount: "132.00",
        allocations: [expect.objectContaining({
          responsibilityType: "processing_factory",
          roundedAmount: "132.00",
        })],
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

    // N08 completes the production flow and atomically materializes the N09
    // supplier ledger from the immutable N07 responsibility facts.
    const ownerSigned = await responsibility.approveOwnerSignature(
      ownerApproval(),
      submitted.value.reworkOrderId,
      {
        expectedOrderVersion: n07Final.value.orderVersion,
      },
      randomUUID(),
    );
    expect(ownerSigned.value).toMatchObject({
      reworkStatus: "completed",
      ownerSignature: {
        decision: "approved", signedBy: ids.ownerOne,
        multiplierAdjustments: [],
      },
    });

    const externalCases = await database.query<{
      responsibilityType: string;
      supplierId: string;
      proposedAmount: string;
      status: string;
    }>(
      `SELECT responsibility_type AS "responsibilityType",
              supplier_id AS "supplierId",
              proposed_deduction_amount::text AS "proposedAmount",
              status
       FROM rework_external_responsibility_cases
       WHERE rework_order_id=$1`,
      [submitted.value.reworkOrderId],
    );
    expect(externalCases.rows).toEqual([{
      responsibilityType: "processing_factory",
      supplierId: factorySupplierId,
      proposedAmount: "132.00",
      status: "deduction_follow_up",
    }]);
    expect((await database.query<{ status: string }>(
      "SELECT status FROM rework_orders WHERE rework_order_id=$1",
      [submitted.value.reworkOrderId],
    )).rows[0]).toEqual({ status: "completed" });

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
    const periods = await wages.list(tailWage());
    expect(periods).toHaveLength(1);
    const wagePeriod = periods[0]!;
    expect(wagePeriod).toMatchObject({
      status: "pending_tail_review",
      sourceItemCount: 1,
      personCount: 1,
      originalTotal: "110.00",
      adjustmentTotal: "0.00",
      finalTotal: "110.00",
    });
    const wageDetail = await wages.get(tailWage(), wagePeriod.periodId);
    expect(wageDetail.items).toHaveLength(1);
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
         (SELECT COALESCE(sum(proposed_deduction_amount),0)::numeric(18,2)::text
          FROM rework_external_responsibility_cases WHERE rework_order_id=$1) external_total,
         (SELECT sum(payable_amount)::numeric(18,2)::text
          FROM rework_wage_items WHERE rework_order_id=$1) wage_total`,
      [submitted.value.reworkOrderId],
    );
    expect(totals.rows[0]).toEqual({
      report_total: "110.00",
      responsibility_total: "132.00",
      own_factory_total: "0.00",
      external_total: "132.00",
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
      { category: "external_deduction_follow_up" },
      { category: "wage_month_close" },
    ]);
  });

  it("submits the eight required N01 facts without retired manual-entry fields", async () => {
    const draft = await initiation.createDraft(qc(), {
      styleNo: "UAT-N01-EIGHT-FIELDS",
      orderQuantity: 120,
      processingFactory: { type: "supplier", supplierId: factorySupplierId },
      inspectionReport: n01CoreInspectionReport("八项资料提交测试款"),
    }, randomUUID());

    expect(draft.value).toMatchObject({
      merchandiserUserId: null,
      problemPart: null,
      problemDescription: null,
      reworkQuantity: null,
    });

    const submitted = await initiation.submit(qc(), draft.value.reworkOrderId, {
      expectedVersion: draft.value.version,
    }, randomUUID());

    expect(submitted.value).toMatchObject({
      status: "pending_process_configuration",
      styleNo: "UAT-N01-EIGHT-FIELDS",
      orderQuantity: 120,
      merchandiserUserId: null,
      problemPart: null,
      problemDescription: null,
      reworkQuantity: null,
    });
    expect(submitted.value.reworkNo).toMatch(/^RW-\d{4}-\d{4}-\d{3,}$/);
  });
});
