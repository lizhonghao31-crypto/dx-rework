import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadConfig } from "@dx-rework/config";
import type {
  OwnFactoryApprovalResponse,
  ProcessConfigurationResponse,
  QuantityAdjustmentResponse,
  ResponsibilityDeterminationResponse,
  ReworkOrderResponse,
  ReworkWorkTasksResponse,
  WholeOrderReviewResponse,
  WorkReportResponse,
  WorkTaskResponse,
} from "@dx-rework/contracts";
import type {
  ExternalResponsibilityBatchResponse,
  ExternalResponsibilityCaseResponse,
} from "@dx-rework/contracts/external-responsibility";
import type {
  WageAdjustment,
  WagePeriod,
  WagePeriodDetail,
} from "@dx-rework/contracts/wages";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { businessActor } from "../../apps/api/src/access/business-authority.js";
import { RootAuthority } from "../../apps/api/src/access/root-authority.js";
import { WorkerAwareAccessMasterDataService } from "../../apps/api/src/access/worker-aware-access-service.js";
import { buildApp } from "../../apps/api/src/app.js";
import type { AuthUser } from "../../apps/api/src/auth/service.js";
import { BusinessAwareWholeOrderReviewService } from "../../apps/api/src/rework/business-aware-whole-order-review-service.js";
import { ExternalResponsibilityApplicationService } from "../../apps/api/src/rework/external-responsibility-application-service.js";
import { OwnFactoryApprovalApplicationService } from "../../apps/api/src/rework/own-factory-approval-application-service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ResponsibilityDeterminationApplicationService } from "../../apps/api/src/rework/responsibility-determination-application-service.js";
import { ReworkBusinessDetailService } from "../../apps/api/src/rework/rework-business-detail-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import { RootAwareTodoProjectionService } from "../../apps/api/src/todos/root-aware-projection-service.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
import { WageExportService } from "../../apps/api/src/wages/wage-export-service.js";
import { WageService } from "../../apps/api/src/wages/wage-service.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;
const sessionCookie = "dx_rework_session=root-single-account-gate";

type Manifest = { migrations: Array<{ version: string; checksum: string }> };
type Method = "GET" | "POST" | "PUT";

type PassFixture = Readonly<{
  app: FastifyInstance;
  database: pg.Pool;
  rootUserId: string;
  merchandiserUserId: string;
  workerPersonIds: string[];
  supplierId: string;
  processId: string;
  processName: string;
  pricingUnit: "piece" | "hour";
  plannedQuantity: number;
  unitPrice: number;
}>;

async function http<T>(
  app: FastifyInstance,
  method: Method,
  url: string,
  payload?: unknown,
): Promise<T> {
  const response = await app.inject({
    method,
    url,
    headers: {
      cookie: sessionCookie,
      ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }),
    },
    ...(payload === undefined ? {} : { payload }),
  });
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBeGreaterThanOrEqual(200);
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBeLessThan(300);
  return response.json() as T;
}

async function applyMigrations(database: pg.Pool): Promise<void> {
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
}

runWithPostgres("Root single-account two-pass HTTP business chain", () => {
  const admin = new Pool({ connectionString: databaseUrl! });

  afterAll(async () => {
    await admin.end();
  });

  async function setup(pass: 1 | 2): Promise<PassFixture & { schema: string }> {
    const schema = `root_http_${pass}_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const database = new Pool({
      connectionString: databaseUrl!,
      options: `-c search_path=${schema}`,
    });
    await applyMigrations(database);

    const rootUserId = randomUUID();
    const merchandiserUserId = randomUUID();
    const workerUserIds = pass === 1
      ? [randomUUID(), randomUUID(), randomUUID()]
      : [randomUUID()];
    const rootDingtalkUserId = `root-two-pass-${pass}`;
    const users = [
      [rootUserId, `Root 双跑 ${pass}`, rootDingtalkUserId],
      [merchandiserUserId, `订单跟单 ${pass}`, `merch-${pass}`],
      ...workerUserIds.map((id, index) => [
        id,
        `作业员工 ${pass}-${index + 1}`,
        `worker-${pass}-${index + 1}`,
      ] as const),
    ] as const;

    for (const [userId, displayName, dingId] of users) {
      await database.query(
        "INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",
        [userId, displayName],
      );
      await database.query(
        `INSERT INTO identity_mappings(
           id,user_id,provider,corp_id,provider_user_id,union_id,
           active,employed,last_verified_at
         ) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
        [randomUUID(), userId, dingId, `union-${dingId}`],
      );
    }

    const access = new WorkerAwareAccessMasterDataService(database, "corp");
    await access.ensureOrganizationPolicy();
    await database.query(
      `INSERT INTO owner_bootstrap_consumptions(
         singleton,user_id,provider_user_id,corp_id
       ) VALUES(true,$1,$2,'corp')`,
      [rootUserId, rootDingtalkUserId],
    );
    const root = new RootAuthority(database, "corp", rootDingtalkUserId);
    await root.assertConfigurationConsistency();
    const rootUser: AuthUser = {
      id: rootUserId,
      displayName: `Root 双跑 ${pass}`,
      capabilities: [],
      businessRoles: [],
    };
    const rootActor = (capability: string) =>
      businessActor(root, rootUser, randomUUID(), capability);

    // Setup uses the same immutable Root identity, but never gives Root an
    // ordinary business-role assignment. Worker grants also exercise automatic
    // internal business-person materialization.
    const accessActor = await rootActor("access:admin");
    await access.assignRole(accessActor, {
      userId: merchandiserUserId,
      roleCode: "order_merchandiser",
      reason: `Root 双跑 ${pass}：建立订单跟单事实`,
    });
    for (const [index, workerUserId] of workerUserIds.entries()) {
      await access.assignRole(accessActor, {
        userId: workerUserId,
        roleCode: "worker",
        reason: `Root 双跑 ${pass}：建立作业员工 ${index + 1}`,
      });
    }
    const people = await access.listPeople();
    const workerPersonIds = workerUserIds.map((workerUserId) => {
      const person = people.find((candidate) => candidate.appUserId === workerUserId);
      expect(person).toBeDefined();
      return person!.personId;
    });

    const masterDataActor = await rootActor("master_data:manage");
    const supplierId = (await access.createSupplier(masterDataActor, {
      supplierCode: `R${pass}FAC01`,
      supplierType: "factory",
      supplierName: `Root 双跑加工厂 ${pass}`,
      active: true,
      changeReason: `Root 双跑 ${pass} 加工厂`,
    })).supplierId;
    const pricingUnit = pass === 1 ? "piece" as const : "hour" as const;
    const processName = pass === 1 ? "袖口返修" : "小时返修";
    const processId = (await access.createProcess(masterDataActor, {
      processCode: pass === 1 ? "R1PCE01" : "R2HOUR1",
      processName,
      pricingUnit,
      active: true,
      changeReason: `Root 双跑 ${pass} 工序`,
    })).processId;

    const todoProjection = new RootAwareTodoProjectionService(new TodoService(database));
    const initiation = new ReworkInitiationService(database, "corp", undefined, undefined, undefined, todoProjection);
    const businessDetail = new ReworkBusinessDetailService(database);
    const configuration = new ProcessConfigurationService(database, undefined, undefined, undefined, todoProjection);
    const work = new WorkReportingService(database, undefined, undefined, todoProjection);
    const wholeOrder = new BusinessAwareWholeOrderReviewService(database, todoProjection);
    const responsibility = new ResponsibilityDeterminationApplicationService(database, todoProjection);
    const ownFactory = new OwnFactoryApprovalApplicationService(database, todoProjection);
    const external = new ExternalResponsibilityApplicationService(database, todoProjection);
    const wages = new WageService(database, undefined, undefined, todoProjection);
    const authenticate = async (token: string | undefined): Promise<AuthUser> => {
      expect(token).toBe("root-single-account-gate");
      return rootUser;
    };
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl!,
      DINGTALK_CORP_ID: "corp",
      DINGTALK_H5_APP_KEY: "test-h5-key",
      DINGTALK_H5_APP_SECRET: "test-h5-secret",
      DINGTALK_WEB_CLIENT_ID: "test-web-client",
      DINGTALK_WEB_CLIENT_SECRET: "test-web-secret",
      DINGTALK_QR_REDIRECT_URI: "https://example.test/rework/auth/qr/relay",
      SESSION_SECRET: "root-single-account-gate-secret-0000000000000000",
      ROOT_DINGTALK_USER_ID: rootDingtalkUserId,
      TODO_RUNTIME_ENABLED: "false",
    });
    const app = buildApp({
      config,
      checkDatabase: async () => undefined,
      getAppliedSchemaHistory: async () => null,
      rework: {
        authenticate,
        service: initiation,
        businessDetailService: businessDetail,
        root,
      },
      processConfiguration: { authenticate, service: configuration, root },
      workReporting: { authenticate, service: work, root },
      wholeOrderReview: { authenticate, service: wholeOrder, root },
      responsibilityDetermination: { authenticate, service: responsibility, root },
      ownFactoryApproval: { authenticate, service: ownFactory, root },
      externalResponsibility: { authenticate, service: external, root },
      wages: {
        authenticate,
        service: wages,
        exportService: new WageExportService(database),
        root,
      },
    });

    return {
      app,
      database,
      rootUserId,
      merchandiserUserId,
      workerPersonIds,
      supplierId,
      processId,
      processName,
      pricingUnit,
      plannedQuantity: pass === 1 ? 10 : 1.5,
      unitPrice: pass === 1 ? 0.6 : 12,
      schema,
    };
  }

  async function startOrder(pass: 1 | 2, fixture: PassFixture) {
    const draft = await http<ReworkOrderResponse>(
      fixture.app,
      "POST",
      "/rework-orders/drafts",
      {
        styleNo: `ROOT-PASS-${pass}`,
        orderNo: `ROOT-ORDER-${pass}`,
        merchandiserUserId: fixture.merchandiserUserId,
        processingFactory: { type: "supplier", supplierId: fixture.supplierId },
        problemPart: "袖口",
        problemDescription: `Root 单账号第 ${pass} 遍完整业务链`,
        reworkQuantity: 10,
      },
    );
    const submitted = await http<ReworkOrderResponse>(
      fixture.app,
      "POST",
      `/rework-orders/${draft.reworkOrderId}/submit`,
      { expectedVersion: draft.version },
    );

    const detail = await http<{
      reworkOrderId: string;
      status: string;
      styleNo: string | null;
      orderNo: string | null;
    }>(
      fixture.app,
      "GET",
      `/rework-orders/${draft.reworkOrderId}/business-detail`,
    );
    expect(detail).toMatchObject({
      reworkOrderId: draft.reworkOrderId,
      status: "pending_process_configuration",
      styleNo: `ROOT-PASS-${pass}`,
      orderNo: `ROOT-ORDER-${pass}`,
    });

    const save = (expectedOrderVersion: number) =>
      http<ProcessConfigurationResponse>(
        fixture.app,
        "PUT",
        `/rework-orders/${draft.reworkOrderId}/process-configuration/draft`,
        {
          expectedOrderVersion,
          items: [{
            source: "catalog",
            processId: fixture.processId,
            plannedQuantity: fixture.plannedQuantity,
            pricingUnit: fixture.pricingUnit,
            unitPrice: fixture.unitPrice,
          }],
        },
      );
    let saved = await save(submitted.version);
    let queued = await http<ProcessConfigurationResponse>(
      fixture.app,
      "POST",
      `/rework-orders/${draft.reworkOrderId}/process-configuration/submit`,
      {
        expectedOrderVersion: saved.orderVersion,
        expectedConfigurationVersion: saved.configuration!.configurationVersion,
      },
    );

    if (pass === 2) {
      const rejected = await http<ProcessConfigurationResponse>(
        fixture.app,
        "POST",
        `/rework-orders/${draft.reworkOrderId}/process-configuration/review`,
        {
          expectedOrderVersion: queued.orderVersion,
          expectedConfigurationVersion: queued.configuration!.configurationVersion,
          decision: "rejected",
          reason: "Root 第二遍：同账号 IE 驳回重提",
        },
      );
      expect(rejected.reworkStatus).toBe("pending_process_configuration");
      saved = await save(rejected.orderVersion);
      queued = await http<ProcessConfigurationResponse>(
        fixture.app,
        "POST",
        `/rework-orders/${draft.reworkOrderId}/process-configuration/submit`,
        {
          expectedOrderVersion: saved.orderVersion,
          expectedConfigurationVersion: saved.configuration!.configurationVersion,
        },
      );
    }

    const approved = await http<ProcessConfigurationResponse>(
      fixture.app,
      "POST",
      `/rework-orders/${draft.reworkOrderId}/process-configuration/review`,
      {
        expectedOrderVersion: queued.orderVersion,
        expectedConfigurationVersion: queued.configuration!.configurationVersion,
        decision: "approved",
      },
    );
    expect(approved.reworkStatus).toBe("pending_task_assignment");
    return {
      draft,
      approved,
      item: approved.configuration!.items[0]!,
    };
  }

  async function runResponsibilityToDeduction(
    pass: 1 | 2,
    fixture: PassFixture,
    reworkOrderId: string,
    itemId: string,
    orderVersion: number,
  ): Promise<void> {
    const multiplier = pass === 1 ? "1.000" : "2.500";
    let determination = await http<ResponsibilityDeterminationResponse>(
      fixture.app,
      "POST",
      `/rework-orders/${reworkOrderId}/responsibility-determinations/drafts`,
      {
        expectedOrderVersion: orderVersion,
        expectedCurrentDeterminationVersion: null,
        handlerUserId: fixture.rootUserId,
        processes: [{
          configurationItemId: itemId,
          multiplier,
          ...(pass === 2
            ? { highMultiplierReason: "Root 第二遍：高倍率同账号确认" }
            : {}),
          allocations: [
            { responsibilityType: "own_factory", shareBps: 5000 },
            { responsibilityType: "processing_factory", shareBps: 5000 },
          ],
        }],
      },
    );
    expect(determination.canDetermine).toBe(true);
    expect(determination.determination?.stage).toBe("draft");

    if (pass === 2) {
      expect(determination.canConfirmHighMultiplier).toBe(true);
      determination = await http<ResponsibilityDeterminationResponse>(
        fixture.app,
        "POST",
        `/responsibility-determinations/${determination.determination!.determinationId}/high-multiplier-confirm`,
        {
          expectedOrderVersion: determination.orderVersion,
          expectedCurrentDeterminationVersion: determination.determination!.version,
          reason: "Root 第二遍：自己完成高倍率确认",
        },
      );
      expect(determination.determination!.highMultiplierConfirmed).toBe(true);
    }

    const finalized = await http<ResponsibilityDeterminationResponse>(
      fixture.app,
      "POST",
      `/rework-orders/${reworkOrderId}/responsibility-determinations/finalize`,
      {
        expectedOrderVersion: determination.orderVersion,
        expectedCurrentDeterminationVersion: determination.determination!.version,
      },
    );
    expect(finalized.reworkStatus).toBe("pending_responsibility_action");

    const ownView = await http<OwnFactoryApprovalResponse>(
      fixture.app,
      "GET",
      `/rework-orders/${reworkOrderId}/own-factory-approval`,
    );
    // Root is the direct owner finalizer in this single-account gate. Its
    // N07 finalization already creates the immutable N08-A snapshot and
    // approves it in the same transaction, so a second approval must not be
    // actionable.
    expect(ownView).toMatchObject({
      reworkStatus: "pending_responsibility_action",
      canDecide: false,
      approval: {
        status: "approved",
        decision: {
          actedBy: fixture.rootUserId,
          decision: "approved",
        },
      },
    });

    const batch = await http<ExternalResponsibilityBatchResponse>(
      fixture.app,
      "GET",
      `/rework-orders/${reworkOrderId}/external-responsibilities`,
    );
    expect(batch).not.toBeNull();
    const externalItems = batch!.items.filter(
      (item) => item.responsibilityType === "processing_factory",
    );
    expect(externalItems).toHaveLength(1);
    const n07ProcessingFactoryAmount = finalized.determination!.processes
      .flatMap((process) => process.allocations)
      .find((allocation) =>
        allocation.responsibilityType === "processing_factory"
      )!.roundedAmount;
    expect(externalItems[0]).toMatchObject({
      proposedAmount: n07ProcessingFactoryAmount,
    });
    expect(batch!.cases).toHaveLength(1);
    let externalCase = batch!.cases[0]!;
    expect(externalCase).toMatchObject({
      responsibilityType: "processing_factory",
      supplier: { supplierId: fixture.supplierId },
      businessHandlerUserId: fixture.merchandiserUserId,
      proposedDeductionAmount: n07ProcessingFactoryAmount,
      actualDeductedAmount: "0.00",
      remainingAmount: n07ProcessingFactoryAmount,
      status: "pending_payables_confirmation",
      caseVersion: 1,
    });
    expect(externalCase.items.map((item) => item.externalItemId)).toEqual(
      externalItems.map((item) => item.externalItemId),
    );
    expect(externalCase.canSign).toBe(false);
    // A supplier already resolved at N07 enters the payables queue directly.
    // The current normal path records the deduction; it does not add a
    // separate "accept" click before the ledger entry.
    expect(externalCase.canRecordDeduction).toBe(true);
    externalCase = await http<ExternalResponsibilityCaseResponse>(
      fixture.app,
      "POST",
      `/external-responsibility-cases/${externalCase.caseId}/deductions`,
      {
        expectedCaseVersion: externalCase.caseVersion,
        entryType: "deduction",
        amount: externalCase.proposedDeductionAmount,
        deductedOn: new Date().toISOString().slice(0, 10),
        attachmentIds: [],
      },
    );
    expect(Number(externalCase.remainingAmount)).toBe(0);
    externalCase = await http<ExternalResponsibilityCaseResponse>(
      fixture.app,
      "POST",
      `/external-responsibility-cases/${externalCase.caseId}/close`,
      {
        expectedCaseVersion: externalCase.caseVersion,
        result: "full",
        evidenceAttachmentIds: [],
      },
    );
    expect(externalCase.status).toBe("closed");
  }

  async function runWages(pass: 1 | 2, fixture: PassFixture): Promise<void> {
    let periods = await http<WagePeriod[]>(fixture.app, "GET", "/wage-periods");
    expect(periods).toHaveLength(1);
    let period = periods[0]!;
    let detail = await http<WagePeriodDetail>(
      fixture.app,
      "GET",
      `/wage-periods/${period.periodId}`,
    );
    expect(detail.items.length).toBeGreaterThan(0);

    if (pass === 2) {
      const adjustment = await http<WageAdjustment>(
        fixture.app,
        "POST",
        "/wage-adjustments",
        {
          originalWageItemId: detail.items[0]!.wageItemId,
          targetPeriodId: period.periodId,
          adjustmentAmount: "0.01",
          reason: "Root 第二遍：自己发起工资调整",
          attachmentIds: [],
          expectedVersion: period.periodVersion,
        },
      );
      const approved = await http<WageAdjustment>(
        fixture.app,
        "POST",
        `/wage-adjustments/${adjustment.adjustmentId}/approve`,
        {
          expectedVersion: adjustment.version,
          reason: "Root 第二遍：自己审批工资调整",
        },
      );
      expect(approved.status).toBe("approved");
      periods = await http<WagePeriod[]>(fixture.app, "GET", "/wage-periods");
      period = periods[0]!;
      expect(period.adjustmentTotal).toBe("0.01");
    }

    period = await http<WagePeriod>(
      fixture.app,
      "POST",
      `/wage-periods/${period.periodId}/tail-approve`,
      { expectedVersion: period.periodVersion },
    );
    expect(period.status).toBe("pending_admin_review");
    period = await http<WagePeriod>(
      fixture.app,
      "POST",
      `/wage-periods/${period.periodId}/administrative-approve`,
      { expectedVersion: period.periodVersion },
    );
    expect(period.status).toBe("ready_to_lock");

    // This is a real accounting rule, not an identity restriction. Root must
    // still be blocked from locking the current natural month early.
    const earlyLock = await fixture.app.inject({
      method: "POST",
      url: `/wage-periods/${period.periodId}/lock`,
      headers: { cookie: sessionCookie, "idempotency-key": randomUUID() },
      payload: {
        expectedVersion: period.periodVersion,
        lockNote: "Root 双跑：验证自然月硬规则仍有效",
      },
    });
    expect(earlyLock.statusCode).toBe(409);
    expect(earlyLock.json()).toMatchObject({
      error: { code: "INVALID_STATE_TRANSITION" },
    });

    detail = await http<WagePeriodDetail>(
      fixture.app,
      "GET",
      `/wage-periods/${period.periodId}`,
    );
    expect(detail.period.status).toBe("ready_to_lock");
  }

  async function assertReconciliation(
    pass: 1 | 2,
    fixture: PassFixture,
    orderId: string,
  ): Promise<void> {
    const result = await fixture.database.query<{
      report_total: string;
      responsibility_total: string;
      own_factory_total: string;
      external_total: string;
      wage_original_total: string;
    }>(
      `SELECT
         (SELECT COALESCE(sum(report.group_amount),0)::numeric(18,2)::text
          FROM rework_work_reports report
          WHERE report.rework_order_id=$1
            AND NOT EXISTS(
              SELECT 1 FROM rework_work_report_rejections rejection
              WHERE rejection.work_report_id=report.work_report_id
            )) report_total,
         (SELECT calculation_total::numeric(18,2)::text
          FROM rework_responsibility_determinations
          WHERE rework_order_id=$1 AND stage='finalized'
          ORDER BY determination_version DESC LIMIT 1) responsibility_total,
         (SELECT own_factory_total_amount::numeric(18,2)::text
          FROM rework_own_factory_approvals
          WHERE rework_order_id=$1 ORDER BY created_at DESC LIMIT 1) own_factory_total,
         (SELECT COALESCE(sum(proposed_deduction_amount),0)::numeric(18,2)::text
          FROM rework_external_responsibility_cases
          WHERE rework_order_id=$1 AND status<>'superseded') external_total,
         (SELECT COALESCE(sum(payable_amount),0)::numeric(18,2)::text
          FROM rework_wage_items WHERE rework_order_id=$1) wage_original_total`,
      [orderId],
    );
    const totals = result.rows[0]!;
    expect(totals.report_total).toBe(totals.wage_original_total);
    const expectedResponsibility = pass === 1
      ? Number(totals.report_total)
      : Number(totals.report_total) * 2.5;
    expect(Number(totals.responsibility_total)).toBeCloseTo(expectedResponsibility, 2);
    expect(
      Number(totals.own_factory_total) + Number(totals.external_total),
    ).toBeCloseTo(Number(totals.responsibility_total), 2);
  }

  async function runPass(pass: 1 | 2): Promise<void> {
    const fixture = await setup(pass);
    try {
      const { draft, approved, item } = await startOrder(pass, fixture);
      const mode = pass === 1 ? "collective" : "individual";
      const task = await http<WorkTaskResponse>(
        fixture.app,
        "POST",
        `/rework-orders/${draft.reworkOrderId}/work-tasks`,
        {
          expectedOrderVersion: approved.orderVersion,
          configurationItemId: item.configurationItemId,
          mode,
          members: (pass === 1
            ? fixture.workerPersonIds
            : [fixture.workerPersonIds[0]!]
          ).map((personId) => ({ personId })),
        },
      );
      expect(task.canSubmitReport).toBe(true);

      const submitReport = async (
        actualQuantity: number,
        resubmitsWorkReportId?: string,
      ): Promise<WorkReportResponse> => {
        const view = await http<ReworkWorkTasksResponse>(
          fixture.app,
          "GET",
          `/rework-orders/${draft.reworkOrderId}/work-tasks`,
        );
        return http<WorkReportResponse>(
          fixture.app,
          "POST",
          `/work-tasks/${task.workTaskId}/reports`,
          {
            expectedOrderVersion: view.orderVersion,
            actualQuantity,
            completedAt: new Date(Date.now() - 60_000).toISOString(),
            ...(resubmitsWorkReportId ? { resubmitsWorkReportId } : {}),
          },
        );
      };

      if (pass === 1) {
        await submitReport(4);
        await submitReport(6);
      } else {
        let report = await submitReport(1.5);
        let review = await http<WholeOrderReviewResponse>(
          fixture.app,
          "GET",
          `/rework-orders/${draft.reworkOrderId}/whole-order-review`,
        );
        const returned = await http<WholeOrderReviewResponse>(
          fixture.app,
          "POST",
          `/work-reports/${report.workReportId}/reject`,
          {
            expectedOrderVersion: review.orderVersion,
            rejectedPersonId: fixture.workerPersonIds[0],
            reason: "Root 第二遍：自己驳回代录并重报",
          },
        );
        expect(returned.reworkStatus).toBe("in_progress");
        report = await submitReport(1.5, report.workReportId);
        expect(report.status).toBe("submitted");

        review = await http<WholeOrderReviewResponse>(
          fixture.app,
          "GET",
          `/rework-orders/${draft.reworkOrderId}/whole-order-review`,
        );
        const increase = await http<QuantityAdjustmentResponse>(
          fixture.app,
          "POST",
          `/rework-orders/${draft.reworkOrderId}/quantity-adjustments/increase`,
          {
            expectedOrderVersion: review.orderVersion,
            configurationItemId: item.configurationItemId,
            newPlannedQuantity: 2,
            reason: "Root 第二遍：自己发起数量增加",
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            requiresIeReview: true,
          },
        );
        expect(increase.status).toBe("pending_merchandiser_confirmation");

        review = await http<WholeOrderReviewResponse>(
          fixture.app,
          "GET",
          `/rework-orders/${draft.reworkOrderId}/whole-order-review`,
        );
        const confirmed = await http<QuantityAdjustmentResponse>(
          fixture.app,
          "POST",
          `/quantity-adjustments/${increase.adjustmentId}/confirm`,
          {
            expectedOrderVersion: review.orderVersion,
            expectedAdjustmentVersion: increase.adjustmentVersion,
            decision: "confirmed",
            actualCutQuantity: 2,
            actualReturnQuantity: 2,
            allowedMaximumQuantity: 2,
            reason: "Root 第二遍：自己做跟单确认",
          },
        );
        expect(confirmed.status).toBe("pending_ie_review");

        review = await http<WholeOrderReviewResponse>(
          fixture.app,
          "GET",
          `/rework-orders/${draft.reworkOrderId}/whole-order-review`,
        );
        const ieApproved = await http<QuantityAdjustmentResponse>(
          fixture.app,
          "POST",
          `/quantity-adjustments/${increase.adjustmentId}/ie-review`,
          {
            expectedOrderVersion: review.orderVersion,
            expectedAdjustmentVersion: increase.adjustmentVersion,
            decision: "approved",
            reason: "Root 第二遍：自己做 IE 数量复核",
          },
        );
        expect(ieApproved.status).toBe("effective");
        await submitReport(0.5);
      }

      const wholeView = await http<WholeOrderReviewResponse>(
        fixture.app,
        "GET",
        `/rework-orders/${draft.reworkOrderId}/whole-order-review`,
      );
      expect(wholeView.canReview).toBe(true);
      expect(wholeView.processes).toEqual([
        expect.objectContaining({ complete: true }),
      ]);
      const wholeApproved = await http<WholeOrderReviewResponse>(
        fixture.app,
        "POST",
        `/rework-orders/${draft.reworkOrderId}/whole-order-review/approve`,
        { expectedOrderVersion: wholeView.orderVersion },
      );
      expect(wholeApproved.reworkStatus).toBe("pending_responsibility_determination");

      await runResponsibilityToDeduction(
        pass,
        fixture,
        draft.reworkOrderId,
        item.configurationItemId,
        wholeApproved.orderVersion,
      );
      expect((await fixture.database.query<{ status: string }>(
        "SELECT status FROM rework_orders WHERE rework_order_id=$1",
        [draft.reworkOrderId],
      )).rows[0]?.status).toBe("completed");

      await runWages(pass, fixture);
      await assertReconciliation(pass, fixture, draft.reworkOrderId);

      // Root itself must still have zero ordinary role assignments; otherwise
      // this gate would not prove the global Root semantics.
      const rootRoles = await fixture.database.query(
        `SELECT 1 FROM user_role_assignments
         WHERE user_id=$1 AND revoked_at IS NULL`,
        [fixture.rootUserId],
      );
      expect(rootRoles.rowCount).toBe(0);
    } finally {
      await fixture.app.close();
      await fixture.database.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${fixture.schema} CASCADE`);
    }
  }

  it("runs two fresh Root orders end-to-end through distinct normal and correction paths", async () => {
    await runPass(1);
    await runPass(2);
  });
});
