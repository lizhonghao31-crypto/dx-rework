import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadConfig } from "@dx-rework/config";
import type {
  ExternalResponsibilityBatchResponse,
  ExternalResponsibilityCaseResponse,
} from "@dx-rework/contracts/external-responsibility";
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
  WageAdjustment,
  WagePeriod,
  WagePeriodDetail,
} from "@dx-rework/contracts/wages";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  businessActor,
} from "../../apps/api/src/access/business-authority.js";
import { RootAuthority } from "../../apps/api/src/access/root-authority.js";
import { WorkerAwareAccessMasterDataService } from "../../apps/api/src/access/worker-aware-access-service.js";
import { buildApp } from "../../apps/api/src/app.js";
import type { AuthUser } from "../../apps/api/src/auth/service.js";
import { BusinessAwareWholeOrderReviewService } from "../../apps/api/src/rework/business-aware-whole-order-review-service.js";
import { ExternalResponsibilityApplicationService } from "../../apps/api/src/rework/external-responsibility-application-service.js";
import { OwnFactoryApprovalApplicationService } from "../../apps/api/src/rework/own-factory-approval-application-service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ResponsibilityDeterminationApplicationService } from "../../apps/api/src/rework/responsibility-determination-application-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import { RootAwareTodoProjectionService } from "../../apps/api/src/todos/root-aware-projection-service.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
import { WageExportService } from "../../apps/api/src/wages/wage-export-service.js";
import { WageService } from "../../apps/api/src/wages/wage-service.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

type Manifest = { migrations: Array<{ version: string; checksum: string }> };
type HttpMethod = "GET" | "POST" | "PUT";

const sessionCookie = "dx_rework_session=root-single-account-gate";

async function request<T>(
  app: FastifyInstance,
  method: HttpMethod,
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
  expect(
    response.statusCode,
    `${method} ${url} failed: ${response.body}`,
  ).toBeGreaterThanOrEqual(200);
  expect(
    response.statusCode,
    `${method} ${url} failed: ${response.body}`,
  ).toBeLessThan(300);
  return response.json() as T;
}

async function applyCurrentMigrations(database: pg.Pool): Promise<void> {
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

runWithPostgres("Root single-account two-pass business gate", () => {
  const adminPool = new Pool({ connectionString: databaseUrl! });

  afterAll(async () => {
    await adminPool.end();
  });

  async function runPass(pass: 1 | 2): Promise<void> {
    const schema = `root_chain_${pass}_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const database = new Pool({
      connectionString: databaseUrl!,
      options: `-c search_path=${schema}`,
    });
    let app: FastifyInstance | undefined;

    try {
      await applyCurrentMigrations(database);

      const rootUserId = randomUUID();
      const rootDingtalkUserId = `root-gate-${pass}`;
      const merchandiserUserId = randomUUID();
      const workerUserIds = [randomUUID(), randomUUID(), randomUUID()];
      const allUsers = [
        [rootUserId, `Root ${pass}`, rootDingtalkUserId],
        [merchandiserUserId, `跟单 ${pass}`, `merch-${pass}`],
        ...workerUserIds.map((userId, index) => [
          userId,
          `工人${index + 1}-${pass}`,
          `worker-${pass}-${index + 1}`,
        ] as const),
      ] as const;

      for (const [userId, displayName, providerUserId] of allUsers) {
        await database.query(
          "INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",
          [userId, displayName],
        );
        await database.query(
          `INSERT INTO identity_mappings(
             id,user_id,provider,corp_id,provider_user_id,union_id,
             active,employed,last_verified_at
           ) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
          [randomUUID(), userId, providerUserId, `union-${providerUserId}`],
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

      const rootAuthority = new RootAuthority(
        database,
        "corp",
        rootDingtalkUserId,
      );
      await rootAuthority.assertConfigurationConsistency();
      const rootUser: AuthUser = {
        id: rootUserId,
        displayName: `Root ${pass}`,
        capabilities: [],
        businessRoles: [],
      };
      const rootActor = (capability: string, actingRole?: string) =>
        businessActor(
          rootAuthority,
          rootUser,
          randomUUID(),
          capability,
          actingRole,
        );

      const accessActor = await rootActor("access:admin", "owner_group");
      await access.assignRole(accessActor, {
        userId: merchandiserUserId,
        roleCode: "order_merchandiser",
        reason: `Root 双跑 ${pass}：建立跟单业务事实`,
      });
      for (const [index, workerUserId] of workerUserIds.entries()) {
        await access.assignRole(accessActor, {
          userId: workerUserId,
          roleCode: "worker",
          reason: `Root 双跑 ${pass}：建立工人 ${index + 1}`,
        });
      }

      const people = await access.listPeople();
      const workerPersonIds = workerUserIds.map((workerUserId) => {
        const person = people.find((item) => item.appUserId === workerUserId);
        expect(person, `worker person materialization missing for ${workerUserId}`)
          .toBeDefined();
        return person!.personId;
      });

      const masterDataActor = await rootActor("master_data:manage");
      const supplierId = (await access.createSupplier(masterDataActor, {
        supplierCode: `R${pass}FAC01`,
        supplierType: "factory",
        supplierName: `Root 双跑加工厂 ${pass}`,
        active: true,
        changeReason: `Root 双跑 ${pass} 基础资料`,
      })).supplierId;
      const pieceProcessId = (await access.createProcess(masterDataActor, {
        processCode: `R${pass}PCE01`,
        processName: `袖口返修-${pass}`,
        pricingUnit: "piece",
        active: true,
        changeReason: `Root 双跑 ${pass} 按件工序`,
      })).processId;
      const hourProcessId = (await access.createProcess(masterDataActor, {
        processCode: `R${pass}HOUR1`,
        processName: `小时返修-${pass}`,
        pricingUnit: "hour",
        active: true,
        changeReason: `Root 双跑 ${pass} 按小时工序`,
      })).processId;

      const todos = new RootAwareTodoProjectionService(new TodoService(database));
      const initiation = new ReworkInitiationService(
        database,
        "corp",
        undefined,
        undefined,
        undefined,
        todos,
      );
      const processConfiguration = new ProcessConfigurationService(
        database,
        undefined,
        undefined,
        undefined,
        todos,
      );
      const workReporting = new WorkReportingService(
        database,
        undefined,
        undefined,
        todos,
      );
      const wholeOrderReview = new BusinessAwareWholeOrderReviewService(
        database,
        todos,
      );
      const responsibility = new ResponsibilityDeterminationApplicationService(
        database,
        todos,
      );
      const ownFactory = new OwnFactoryApprovalApplicationService(database, todos);
      const external = new ExternalResponsibilityApplicationService(database, todos);
      const wages = new WageService(database, undefined, undefined, todos);
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
      app = buildApp({
        config,
        checkDatabase: async () => undefined,
        getAppliedSchemaHistory: async () => null,
        rework: {
          authenticate,
          service: initiation,
          root: rootAuthority,
        },
        processConfiguration: {
          authenticate,
          service: processConfiguration,
          root: rootAuthority,
        },
        workReporting: {
          authenticate,
          service: workReporting,
          root: rootAuthority,
        },
        wholeOrderReview: {
          authenticate,
          service: wholeOrderReview,
          root: rootAuthority,
        },
        responsibilityDetermination: {
          authenticate,
          service: responsibility,
          root: rootAuthority,
        },
        ownFactoryApproval: {
          authenticate,
          service: ownFactory,
          root: rootAuthority,
        },
        externalResponsibility: {
          authenticate,
          service: external,
          root: rootAuthority,
        },
        wages: {
          authenticate,
          service: wages,
          exportService: new WageExportService(database),
          root: rootAuthority,
        },
      });

      // N01: the Root account itself creates and submits a real order.
      const draft = await request<ReworkOrderResponse>(
        app,
        "POST",
        "/rework-orders/drafts",
        {
          styleNo: `ROOT-TWO-PASS-${pass}`,
          orderNo: `ROOT-ORDER-${pass}`,
          merchandiserUserId,
          processingFactory: { type: "supplier", supplierId },
          problemPart: "袖口",
          problemDescription: `Root 单账号第 ${pass} 遍全链验收`,
          reworkQuantity: 10,
        },
      );
      expect(draft.status).toBe("draft");
      const submitted = await request<ReworkOrderResponse>(
        app,
        "POST",
        `/rework-orders/${draft.reworkOrderId}/submit`,
        { expectedVersion: draft.version },
      );
      expect(submitted.status).toBe("pending_process_configuration");

      // N02/N03: Root configures both practical units and self-reviews IE.
      const saveConfiguration = async (expectedOrderVersion: number) =>
        request<ProcessConfigurationResponse>(
          app!,
          "PUT",
          `/rework-orders/${draft.reworkOrderId}/process-configuration/draft`,
          {
            expectedOrderVersion,
            items: [
              {
                source: "catalog",
                processId: pieceProcessId,
                plannedQuantity: 10,
                pricingUnit: "piece",
                unitPrice: 0.55,
              },
              {
                source: "catalog",
                processId: hourProcessId,
                plannedQuantity: 1.5,
                pricingUnit: "hour",
                unitPrice: 12.5,
              },
            ],
          },
        );
      let configured = await saveConfiguration(submitted.version);
      let queued = await request<ProcessConfigurationResponse>(
        app,
        "POST",
        `/rework-orders/${draft.reworkOrderId}/process-configuration/submit`,
        {
          expectedOrderVersion: configured.orderVersion,
          expectedConfigurationVersion:
            configured.configuration!.configurationVersion,
        },
      );
      expect(queued.reworkStatus).toBe("pending_ie_review");

      if (pass === 2) {
        const rejected = await request<ProcessConfigurationResponse>(
          app,
          "POST",
          `/rework-orders/${draft.reworkOrderId}/process-configuration/review`,
          {
            expectedOrderVersion: queued.orderVersion,
            expectedConfigurationVersion:
              queued.configuration!.configurationVersion,
            decision: "rejected",
            reason: "Root 第二遍：验证同账号 IE 驳回后重提",
          },
        );
        expect(rejected.reworkStatus).toBe("pending_process_configuration");
        configured = await saveConfiguration(rejected.orderVersion);
        queued = await request<ProcessConfigurationResponse>(
          app,
          "POST",
          `/rework-orders/${draft.reworkOrderId}/process-configuration/submit`,
          {
            expectedOrderVersion: configured.orderVersion,
            expectedConfigurationVersion:
              configured.configuration!.configurationVersion,
          },
        );
      }

      const approved = await request<ProcessConfigurationResponse>(
        app,
        "POST",
        `/rework-orders/${draft.reworkOrderId}/process-configuration/review`,
        {
          expectedOrderVersion: queued.orderVersion,
          expectedConfigurationVersion: queued.configuration!.configurationVersion,
          decision: "approved",
        },
      );
      expect(approved.reworkStatus).toBe("pending_task_assignment");
      const pieceItem = approved.configuration!.items.find(
        (item) => item.processId === pieceProcessId,
      )!;
      const hourItem = approved.configuration!.items.find(
        (item) => item.processId === hourProcessId,
      )!;

      // N04: Root creates one collective and one individual task.
      const pieceTask = await request<WorkTaskResponse>(
        app,
        "POST",
        `/rework-orders/${draft.reworkOrderId}/work-tasks`,
        {
          expectedOrderVersion: approved.orderVersion,
          configurationItemId: pieceItem.configurationItemId,
          mode: "collective",
          members: workerPersonIds.map((personId) => ({ personId })),
        },
      );
      let workView = await request<ReworkWorkTasksResponse>(
        app,
        "GET",
        `/rework-orders/${draft.reworkOrderId}/work-tasks`,
      );
      const hourTask = await request<WorkTaskResponse>(
        app,
        "POST",
        `/rework-orders/${draft.reworkOrderId}/work-tasks`,
        {
          expectedOrderVersion: workView.orderVersion,
          configurationItemId: hourItem.configurationItemId,
          mode: "individual",
          members: [{ personId: workerPersonIds[0] }],
        },
      );
      expect(pieceTask.canSubmitReport).toBe(true);
      expect(hourTask.canSubmitReport).toBe(true);

      const submitReport = async (
        taskId: string,
        actualQuantity: number,
        resubmitsWorkReportId?: string,
      ): Promise<WorkReportResponse> => {
        workView = await request<ReworkWorkTasksResponse>(
          app!,
          "GET",
          `/rework-orders/${draft.reworkOrderId}/work-tasks`,
        );
        return request<WorkReportResponse>(
          app!,
          "POST",
          `/work-tasks/${taskId}/reports`,
          {
            expectedOrderVersion: workView.orderVersion,
            actualQuantity,
            completedAt: new Date(Date.now() - 60_000).toISOString(),
            ...(resubmitsWorkReportId ? { resubmitsWorkReportId } : {}),
          },
        );
      };

      // N05: all reports are submitted by Root on behalf of internal workers.
      let hourReport: WorkReportResponse;
      if (pass === 1) {
        await submitReport(pieceTask.workTaskId, 4);
        await submitReport(pieceTask.workTaskId, 6);
        hourReport = await submitReport(hourTask.workTaskId, 1.5);
      } else {
        await submitReport(pieceTask.workTaskId, 10);
        hourReport = await submitReport(hourTask.workTaskId, 1.5);
      }
      workView = await request<ReworkWorkTasksResponse>(
        app,
        "GET",
        `/rework-orders/${draft.reworkOrderId}/work-tasks`,
      );
      expect(workView.reworkStatus).toBe("pending_order_review");

      // Pass 2 deliberately returns one report and then lets the same Root
      // resubmit it. It also exercises Root self-confirm/self-IE-review for a
      // quantity increase before adding the final piece.
      if (pass === 2) {
        let reviewView = await request<WholeOrderReviewResponse>(
          app,
          "GET",
          `/rework-orders/${draft.reworkOrderId}/whole-order-review`,
        );
        const returned = await request<WholeOrderReviewResponse>(
          app,
          "POST",
          `/work-reports/${hourReport.workReportId}/reject`,
          {
            expectedOrderVersion: reviewView.orderVersion,
            rejectedPersonId: workerPersonIds[0],
            reason: "Root 第二遍：验证上数退回重报",
          },
        );
        expect(returned.reworkStatus).toBe("in_progress");
        hourReport = await submitReport(
          hourTask.workTaskId,
          1.5,
          hourReport.workReportId,
        );
        expect(hourReport.status).toBe("submitted");

        reviewView = await request<WholeOrderReviewResponse>(
          app,
          "GET",
          `/rework-orders/${draft.reworkOrderId}/whole-order-review`,
        );
        const increase = await request<QuantityAdjustmentResponse>(
          app,
          "POST",
          `/rework-orders/${draft.reworkOrderId}/quantity-adjustments/increase`,
          {
            expectedOrderVersion: reviewView.orderVersion,
            configurationItemId: pieceItem.configurationItemId,
            newPlannedQuantity: 11,
            reason: "Root 第二遍：验证数量增加同账号闭环",
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            requiresIeReview: true,
          },
        );
        expect(increase.status).toBe("pending_merchandiser_confirmation");

        reviewView = await request<WholeOrderReviewResponse>(
          app,
          "GET",
          `/rework-orders/${draft.reworkOrderId}/whole-order-review`,
        );
        const confirmed = await request<QuantityAdjustmentResponse>(
          app,
          "POST",
          `/quantity-adjustments/${increase.adjustmentId}/confirm`,
          {
            expectedOrderVersion: reviewView.orderVersion,
            expectedAdjustmentVersion: increase.adjustmentVersion,
            decision: "confirmed",
            actualCutQuantity: 11,
            actualReturnQuantity: 11,
            allowedMaximumQuantity: 11,
            reason: "Root 同账号跟单确认",
          },
        );
        expect(confirmed.status).toBe("pending_ie_review");

        reviewView = await request<WholeOrderReviewResponse>(
          app,
          "GET",
          `/rework-orders/${draft.reworkOrderId}/whole-order-review`,
        );
        const ieReviewed = await request<QuantityAdjustmentResponse>(
          app,
          "POST",
          `/quantity-adjustments/${increase.adjustmentId}/ie-review`,
          {
            expectedOrderVersion: reviewView.orderVersion,
            expectedAdjustmentVersion: increase.adjustmentVersion,
            decision: "approved",
            reason: "Root 同账号 IE 数量复核",
          },
        );
        expect(ieReviewed.status).toBe("effective");
        await submitReport(pieceTask.workTaskId, 1);
      }

      // N06: server facts must show both processes complete before Root approves.
      const wholeView = await request<WholeOrderReviewResponse>(
        app,
        "GET",
        `/rework-orders/${draft.reworkOrderId}/whole-order-review`,
      );
      expect(wholeView.canReview).toBe(true);
      expect(wholeView.processes.every((process) => process.complete)).toBe(true);
      const wholeApproved = await request<WholeOrderReviewResponse>(
        app,
        "POST",
        `/rework-orders/${draft.reworkOrderId}/whole-order-review/approve`,
        { expectedOrderVersion: wholeView.orderVersion },
      );
      expect(wholeApproved.reworkStatus)
        .toBe("pending_responsibility_determination");

      // N07: Root owns the handler slot. Pass 2 also self-confirms >2x.
      const multiplier = pass === 2 ? "2.500" : "1.000";
      let determination = await request<ResponsibilityDeterminationResponse>(
        app,
        "POST",
        `/rework-orders/${draft.reworkOrderId}/responsibility-determinations/drafts`,
        {
          expectedOrderVersion: wholeApproved.orderVersion,
          expectedCurrentDeterminationVersion: null,
          handlerUserId: rootUserId,
          processes: [pieceItem, hourItem].map((item) => ({
            configurationItemId: item.configurationItemId,
            multiplier,
            ...(pass === 2
              ? { highMultiplierReason: "Root 第二遍：高倍率同账号确认" }
              : {}),
            allocations: [
              { responsibilityType: "own_factory", shareBps: 5000 },
              { responsibilityType: "processing_factory", shareBps: 5000 },
            ],
          })),
        },
      );
      expect(determination.canDetermine).toBe(true);
      if (pass === 2) {
        expect(determination.canConfirmHighMultiplier).toBe(true);
        determination = await request<ResponsibilityDeterminationResponse>(
          app,
          "POST",
          `/responsibility-determinations/${determination.determination!.determinationId}/high-multiplier-confirm`,
          {
            expectedOrderVersion: determination.orderVersion,
            expectedCurrentDeterminationVersion:
              determination.determination!.version,
            reason: "Root 第二遍：同账号完成高倍率独立确认",
          },
        );
        expect(determination.determination!.highMultiplierConfirmed).toBe(true);
      }
      const finalized = await request<ResponsibilityDeterminationResponse>(
        app,
        "POST",
        `/rework-orders/${draft.reworkOrderId}/responsibility-determinations/finalize`,
        {
          expectedOrderVersion: determination.orderVersion,
          expectedCurrentDeterminationVersion:
            determination.determination!.version,
        },
      );
      expect(finalized.reworkStatus).toBe("pending_responsibility_action");

      // N08-A: Root approves its own-factory branch.
      const ownView = await request<OwnFactoryApprovalResponse>(
        app,
        "GET",
        `/rework-orders/${draft.reworkOrderId}/own-factory-approval`,
      );
      expect(ownView.canDecide).toBe(true);
      expect(ownView.approval?.status).toBe("pending");
      const ownApproved = await request<OwnFactoryApprovalResponse>(
        app,
        "POST",
        `/own-factory-approvals/${ownView.approval!.approvalId}/approve`,
        {
          expectedOrderVersion: ownView.orderVersion,
          expectedApprovalVersion: ownView.approval!.approvalVersion,
          opinion: `Root 第 ${pass} 遍同意本厂承担`,
        },
      );
      expect(ownApproved.approval?.status).toBe("approved");

      // N08-B/N09/N10-B: the same Root performs allocation, business signoff,
      // payables confirmation, actual deduction and close.
      const externalBatch = await request<ExternalResponsibilityBatchResponse>(
        app,
        "GET",
        `/rework-orders/${draft.reworkOrderId}/external-responsibilities`,
      );
      expect(externalBatch).not.toBeNull();
      const processingItems = externalBatch!.items.filter(
        (item) => item.responsibilityType === "processing_factory",
      );
      expect(processingItems.length).toBeGreaterThan(0);
      const allocated = await request<ExternalResponsibilityBatchResponse>(
        app,
        "POST",
        `/external-responsibility-batches/${externalBatch!.batchId}/allocate-suppliers`,
        {
          expectedBatchVersion: externalBatch!.batchVersion,
          allocations: [{
            responsibilityType: "processing_factory",
            supplierId,
            externalItemIds: processingItems.map((item) => item.externalItemId),
          }],
        },
      );
      const externalCase = allocated!.cases[0]!;
      expect(externalCase.canSign).toBe(true);
      let caseView = await request<ExternalResponsibilityCaseResponse>(
        app,
        "POST",
        `/external-responsibility-cases/${externalCase.caseId}/submit`,
        {
          expectedCaseVersion: externalCase.caseVersion,
          remark: `Root 第 ${pass} 遍业务签收`,
          attachmentIds: [],
        },
      );
      expect(caseView.status).toBe("pending_payables_confirmation");
      expect(caseView.canPayablesConfirm).toBe(true);
      caseView = await request<ExternalResponsibilityCaseResponse>(
        app,
        "POST",
        `/external-responsibility-cases/${externalCase.caseId}/payables-accept`,
        { expectedCaseVersion: caseView.caseVersion },
      );
      expect(caseView.status).toBe("deduction_follow_up");
      expect(caseView.canRecordDeduction).toBe(true);
      caseView = await request<ExternalResponsibilityCaseResponse>(
        app,
        "POST",
        `/external-responsibility-cases/${externalCase.caseId}/deductions`,
        {
          expectedCaseVersion: caseView.caseVersion,
          entryType: "deduction",
          amount: caseView.proposedDeductionAmount,
          deductedOn: new Date().toISOString().slice(0, 10),
          attachmentIds: [],
        },
      );
      expect(Number(caseView.remainingAmount)).toBe(0);
      caseView = await request<ExternalResponsibilityCaseResponse>(
        app,
        "POST",
        `/external-responsibility-cases/${externalCase.caseId}/close`,
        {
          expectedCaseVersion: caseView.caseVersion,
          result: "full",
          evidenceAttachmentIds: [],
        },
      );
      expect(caseView.status).toBe("closed");

      const orderState = await database.query<{ status: string }>(
        "SELECT status FROM rework_orders WHERE rework_order_id=$1",
        [draft.reworkOrderId],
      );
      expect(orderState.rows[0]?.status).toBe("completed");

      // N10-A: Root does every wage role. Pass 2 additionally requests and
      // approves its own wage adjustment before reviewing the month.
      let wagePeriods = await request<WagePeriod[]>(app, "GET", "/wage-periods");
      expect(wagePeriods).toHaveLength(1);
      let wagePeriod = wagePeriods[0]!;
      let wageDetail = await request<WagePeriodDetail>(
        app,
        "GET",
        `/wage-periods/${wagePeriod.periodId}`,
      );
      expect(wageDetail.items.length).toBeGreaterThan(0);
      if (pass === 2) {
        const adjustment = await request<WageAdjustment>(
          app,
          "POST",
          "/wage-adjustments",
          {
            originalWageItemId: wageDetail.items[0]!.wageItemId,
            targetPeriodId: wagePeriod.periodId,
            adjustmentAmount: "0.01",
            reason: "Root 第二遍：工资调整同账号审批",
            attachmentIds: [],
            expectedVersion: wagePeriod.periodVersion,
          },
        );
        expect(adjustment.status).toBe("pending");
        const decided = await request<WageAdjustment>(
          app,
          "POST",
          `/wage-adjustments/${adjustment.adjustmentId}/approve`,
          {
            expectedVersion: adjustment.version,
            reason: "Root 同账号批准工资调整",
          },
        );
        expect(decided.status).toBe("approved");
        wagePeriods = await request<WagePeriod[]>(app, "GET", "/wage-periods");
        wagePeriod = wagePeriods[0]!;
        expect(wagePeriod.adjustmentTotal).toBe("0.01");
      }

      wagePeriod = await request<WagePeriod[]>(app, "GET", "/wage-periods")
        .then((periods) => periods[0]!);
      wagePeriod = await request<WagePeriod>(
        app,
        "POST",
        `/wage-periods/${wagePeriod.periodId}/tail-approve`,
        { expectedVersion: wagePeriod.periodVersion },
      );
      expect(wagePeriod.status).toBe("pending_admin_review");
      wagePeriod = await request<WagePeriod>(
        app,
        "POST",
        `/wage-periods/${wagePeriod.periodId}/administrative-approve`,
        { expectedVersion: wagePeriod.periodVersion },
      );
      expect(wagePeriod.status).toBe("ready_to_lock");

      // Current-month lock remains a real accounting rule; Root must not bypass
      // it merely because identity/role restrictions are disabled for Root.
      const earlyLock = await app.inject({
        method: "POST",
        url: `/wage-periods/${wagePeriod.periodId}/lock`,
        headers: {
          cookie: sessionCookie,
          "idempotency-key": randomUUID(),
        },
        payload: {
          expectedVersion: wagePeriod.periodVersion,
          lockNote: "Root 双跑：验证自然月硬规则仍有效",
        },
      });
      expect(earlyLock.statusCode).toBe(409);
      expect(earlyLock.json()).toMatchObject({
        error: { code: "INVALID_STATE_TRANSITION" },
      });

      // The Root fixture intentionally has no ordinary business-role binding.
      // Every business action above therefore proves the Root policy instead of
      // accidentally passing because Root also held the real role.
      const rootRoles = await database.query<{ role_code: string }>(
        `SELECT role_code FROM user_role_assignments
         WHERE user_id=$1 AND revoked_at IS NULL`,
        [rootUserId],
      );
      expect(rootRoles.rows).toEqual([]);

      const totals = await database.query<{
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
        [draft.reworkOrderId],
      );
      const total = totals.rows[0]!;
      expect(total.report_total).toBe(total.responsibility_total);
      expect(total.report_total).toBe(total.wage_original_total);
      expect(
        Number(total.own_factory_total) + Number(total.external_total),
      ).toBeCloseTo(Number(total.responsibility_total), 2);

      wageDetail = await request<WagePeriodDetail>(
        app,
        "GET",
        `/wage-periods/${wagePeriod.periodId}`,
      );
      expect(wageDetail.period.status).toBe("ready_to_lock");
    } finally {
      if (app) await app.close();
      await database.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  }

  it("creates two fresh Root orders and carries both through the complete business chain", async () => {
    await runPass(1);
    await runPass(2);
  });
});
