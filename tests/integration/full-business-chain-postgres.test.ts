import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  CreateResponsibilityDraftSchema,
  CreateWorkReportSchema,
  CreateWorkTaskSchema,
  ReviewProcessConfigurationSchema,
  ReviewWholeOrderSchema,
  SaveProcessConfigurationSchema,
  SubmitProcessConfigurationSchema,
} from "@dx-rework/contracts";
import {
  AllocateExternalSuppliersSchema,
  CloseExternalDeductionCaseSchema,
  CreateExternalDeductionEntrySchema,
  PayablesAcceptExternalResponsibilityCaseSchema,
  SubmitExternalResponsibilityCaseSchema,
} from "@dx-rework/contracts/external-responsibility";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { BusinessAwareWholeOrderReviewService } from "../../apps/api/src/rework/business-aware-whole-order-review-service.js";
import { ExternalResponsibilityApplicationService } from "../../apps/api/src/rework/external-responsibility-application-service.js";
import { OwnFactoryApprovalApplicationService } from "../../apps/api/src/rework/own-factory-approval-application-service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ResponsibilityDeterminationApplicationService } from "../../apps/api/src/rework/responsibility-determination-application-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { WageService } from "../../apps/api/src/wages/wage-service.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

type Manifest = { migrations: Array<{ version: string; checksum: string }> };

runWithPostgres("current-schema N01-N10 business chain", () => {
  const schema = `full_chain_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });

  const access = new AccessMasterDataService(database, "corp");
  const initiation = new ReworkInitiationService(database, "corp");
  const configuration = new ProcessConfigurationService(database);
  const work = new WorkReportingService(database);
  const wholeOrder = new BusinessAwareWholeOrderReviewService(database);
  const responsibility = new ResponsibilityDeterminationApplicationService(database);
  const ownFactory = new OwnFactoryApprovalApplicationService(database);
  const external = new ExternalResponsibilityApplicationService(database);
  const wages = new WageService(database);

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
    "own_factory:view",
    "own_factory:approve",
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
    for (const migration of manifest.migrations) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration.version}.sql`, import.meta.url),
        "utf8",
      ));
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

  it("carries one real order from N01 through N10 without losing cross-node facts", async () => {
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

    // N02 - planned quantity is fed from the N01 quantity instead of a second
    // unrelated fixture value. The business can still change it per process.
    const n02Input = SaveProcessConfigurationSchema.parse({
      expectedOrderVersion: submitted.value.version,
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

    // N03 - deliberately reject once, return to N02, then resubmit and approve.
    const rejected = await configuration.review(
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
    expect(n06View.reports).toHaveLength(2);
    const n06Approved = await wholeOrder.approve(
      tailAudit(),
      submitted.value.reworkOrderId,
      ReviewWholeOrderSchema.parse({ expectedOrderVersion: n06View.orderVersion }),
      randomUUID(),
    );
    expect(n06Approved.value.reworkStatus)
      .toBe("pending_responsibility_determination");

    // N07 - base amount is 200 * 0.55 = 110.00, split equally between
    // own-factory and processing-factory responsibility.
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
            { responsibilityType: "own_factory", shareBps: 5000 },
            { responsibilityType: "processing_factory", shareBps: 5000 },
          ],
        }],
      }),
      randomUUID(),
    );
    expect(n07Draft.value.determination).toMatchObject({
      stage: "draft",
      calculationTotal: "110.00",
      processes: [{
        baseAmount: "110.00",
        responsibilityAmount: "110.00",
        allocations: expect.arrayContaining([
          expect.objectContaining({
            responsibilityType: "own_factory",
            roundedAmount: "55.00",
          }),
          expect.objectContaining({
            responsibilityType: "processing_factory",
            roundedAmount: "55.00",
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
    expect(n07Final.value.reworkStatus).toBe("pending_responsibility_action");

    const ownView = await ownFactory.get(
      ownerApproval(),
      submitted.value.reworkOrderId,
    );
    expect(ownView.approval).toMatchObject({
      status: "pending",
      ownFactoryTotalAmount: "55.00",
    });
    const externalBatch = await external.get(
      merchandiser(),
      submitted.value.reworkOrderId,
    );
    expect(externalBatch).not.toBeNull();
    expect(externalBatch!.items).toEqual([
      expect.objectContaining({
        responsibilityType: "processing_factory",
        proposedAmount: "55.00",
      }),
    ]);

    // N08-A - own-factory approval alone must not finish an order that still
    // has an unresolved N08-B branch.
    const ownApproved = await ownFactory.approve(
      ownerApproval(),
      ownView.approval!.approvalId,
      {
        expectedOrderVersion: ownView.orderVersion,
        expectedApprovalVersion: ownView.approval!.approvalVersion,
        opinion: "全链测试：同意本厂承担",
      },
      randomUUID(),
    );
    expect(ownApproved.value.reworkStatus).toBe("pending_responsibility_action");

    // N08-B - allocate the exact N01 processing factory, sign, and let the
    // corresponding payables role confirm. N09 should finish here even though
    // actual deduction is still zero.
    const allocated = await external.allocateSuppliers(
      merchandiser(),
      externalBatch!.batchId,
      AllocateExternalSuppliersSchema.parse({
        expectedBatchVersion: externalBatch!.batchVersion,
        allocations: [{
          responsibilityType: "processing_factory",
          supplierId: factorySupplierId,
          externalItemIds: [externalBatch!.items[0]!.externalItemId],
        }],
      }),
      randomUUID(),
    );
    const externalCase = allocated.value!.cases[0]!;
    expect(externalCase).toMatchObject({
      proposedDeductionAmount: "55.00",
      actualDeductedAmount: "0.00",
      status: "pending_business_signoff",
    });
    const signed = await external.submit(
      merchandiser(),
      externalCase.caseId,
      SubmitExternalResponsibilityCaseSchema.parse({
        expectedCaseVersion: externalCase.caseVersion,
        attachmentIds: [],
      }),
      randomUUID(),
    );
    expect(signed.value.status).toBe("pending_payables_confirmation");
    const accepted = await external.payablesAccept(
      payables(),
      externalCase.caseId,
      PayablesAcceptExternalResponsibilityCaseSchema.parse({
        expectedCaseVersion: signed.value.caseVersion,
      }),
      randomUUID(),
    );
    expect(accepted.value).toMatchObject({
      status: "deduction_follow_up",
      actualDeductedAmount: "0.00",
      remainingAmount: "55.00",
    });
    expect((await database.query<{ status: string }>(
      "SELECT status FROM rework_orders WHERE rework_order_id=$1",
      [submitted.value.reworkOrderId],
    )).rows[0]).toEqual({ status: "completed" });

    // N10-B - actual deduction remains a separate lifecycle after N09.
    const deduction = await external.recordDeduction(
      payables(),
      externalCase.caseId,
      CreateExternalDeductionEntrySchema.parse({
        expectedCaseVersion: accepted.value.caseVersion,
        entryType: "deduction",
        amount: "55.00",
        deductedOn: new Date().toISOString().slice(0, 10),
        attachmentIds: [],
      }),
      randomUUID(),
    );
    expect(deduction.value).toMatchObject({
      actualDeductedAmount: "55.00",
      remainingAmount: "0.00",
    });
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
        proposedAmount: "55.00",
        actualDeductedAmount: "55.00",
        remainingAmount: "0.00",
      },
    });
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
          FROM rework_work_reports WHERE rework_order_id=$1) report_total,
         (SELECT calculation_total::numeric(18,2)::text
          FROM rework_responsibility_determinations
          WHERE rework_order_id=$1 AND stage='finalized'
          ORDER BY determination_version DESC LIMIT 1) responsibility_total,
         (SELECT own_factory_total_amount::numeric(18,2)::text
          FROM rework_own_factory_approvals
          WHERE rework_order_id=$1 ORDER BY created_at DESC LIMIT 1) own_factory_total,
         (SELECT sum(proposed_deduction_amount)::numeric(18,2)::text
          FROM rework_external_responsibility_cases WHERE rework_order_id=$1) external_total,
         (SELECT sum(payable_amount)::numeric(18,2)::text
          FROM rework_wage_items WHERE rework_order_id=$1) wage_total`,
      [submitted.value.reworkOrderId],
    );
    expect(totals.rows[0]).toEqual({
      report_total: "110.00",
      responsibility_total: "110.00",
      own_factory_total: "55.00",
      external_total: "55.00",
      wage_total: "110.00",
    });
  });
});
