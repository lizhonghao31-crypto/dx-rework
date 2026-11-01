import { ownedPostgresSchema, createOwnedPostgresSchema, dropOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadConfig } from "@dx-rework/config";
import type {
  ProcessConfigurationResponse,
  ResponsibilityDeterminationResponse,
  ReworkOrderResponse,
  ReworkWorkTasksResponse,
  WholeOrderReviewResponse,
  WorkReportResponse,
} from "@dx-rework/contracts";
import type {
  ExternalResponsibilityBatchResponse,
  ExternalResponsibilityCaseResponse,
} from "@dx-rework/contracts/external-responsibility";
import type { WagePeriod, WagePeriodDetail } from "@dx-rework/contracts/wages";
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
import { ProcessWorkerPlanService } from "../../apps/api/src/rework/process-worker-plan-service.js";
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

type PassFixture = Readonly<{
  app: FastifyInstance;
  database: pg.Pool;
  rootUserId: string;
  businessDetail: ReworkBusinessDetailService;
  merchandiserUserId: string;
  tailInspectorUserId: string;
  tailPersonId: string;
  workerPersonIds: string[];
  supplierId: string;
  processId: string;
  processName: string;
  pricingUnit: "piece";
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
}

runWithPostgres("Root single-account two-pass HTTP business chain", () => {
  const admin = new Pool({ connectionString: databaseUrl! });

  afterAll(async () => {
    await admin.end();
  });

  async function setup(pass: 1 | 2): Promise<PassFixture & { schema: string }> {
    const schema = ownedPostgresSchema(`root_http_${pass}`);
    await createOwnedPostgresSchema(admin,schema);
    const database = new Pool({
      connectionString: databaseUrl!,
      options: `-c search_path=${schema}`,
    });
    await applyMigrations(database);

    const rootUserId = randomUUID();
    const merchandiserUserId = randomUUID();
    const tailInspectorUserId = randomUUID();
    const workerUserIds = pass === 1
      ? [randomUUID(), randomUUID(), randomUUID()]
      : [randomUUID()];
    const rootDingtalkUserId = `root-two-pass-${pass}`;
    const users = [
      [rootUserId, `Root 双跑 ${pass}`, rootDingtalkUserId],
      [merchandiserUserId, `订单跟单 ${pass}`, `merch-${pass}`],
      [tailInspectorUserId, `尾查 ${pass}`, `tail-inspector-${pass}`],
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
    await access.assignRole(accessActor, {
      userId: tailInspectorUserId,
      roleCode: "tail_inspector",
      reason: `Root 双跑 ${pass}：建立尾查事实`,
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
    const tailPerson = people.find((candidate) => candidate.appUserId === tailInspectorUserId);
    expect(tailPerson).toBeDefined();
    const tailPersonId = tailPerson!.personId;

    const masterDataActor = await rootActor("master_data:manage");
    if (pass === 2) {
      workerPersonIds[0] = (await access.createPerson(masterDataActor, {
        personType: "temporary",
        displayName: "Root 双跑临时工",
        aliases: [],
        reason: "验证临时工工资与外部扣款倍率隔离",
      })).personId;
    }
    const supplierId = (await access.createSupplier(masterDataActor, {
      supplierCode: `R${pass}FAC01`,
      supplierType: "factory",
      supplierName: `Root 双跑加工厂 ${pass}`,
      active: true,
      changeReason: `Root 双跑 ${pass} 加工厂`,
    })).supplierId;
    const pricingUnit = "piece" as const;
    const processName = pass === 1 ? "袖口返修" : "临时工返修";
    const processId = (await access.createProcess(masterDataActor, {
      processCode: pass === 1 ? "R1PCE01" : "R2PCE01",
      processName,
      pricingUnit,
      active: true,
      changeReason: `Root 双跑 ${pass} 工序`,
    })).processId;

    const todoProjection = new RootAwareTodoProjectionService(new TodoService(database));
    const initiation = new ReworkInitiationService(database, "corp", undefined, undefined, undefined, todoProjection);
    const businessDetail = new ReworkBusinessDetailService(database);
    const configuration = new ProcessConfigurationService(database, undefined, undefined, undefined, todoProjection);
    const workerPlan = new ProcessWorkerPlanService(database);
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
      processConfiguration: { authenticate, service: configuration, workerPlan, root },
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
      businessDetail,
      merchandiserUserId,
      tailInspectorUserId,
      tailPersonId,
      workerPersonIds,
      supplierId,
      processId,
      processName,
      pricingUnit,
      plannedQuantity: pass === 1 ? 10 : 2,
      unitPrice: pass === 1 ? 0.6 : 9,
      schema,
    };
  }

  async function startOrder(pass: 1 | 2, fixture: PassFixture) {
    const receivingBatchId = randomUUID();
    await fixture.database.query(
      `INSERT INTO receiving_batches(
         receiving_batch_id,style_no,created_by,created_at,delivery_note_quantity,
         document_quantity_adjustment,actual_quantity_adjustment
       ) VALUES($1,$2,$3,CURRENT_TIMESTAMP,100,100,100)`,
      [receivingBatchId, `ROOT-PASS-${pass}`, fixture.rootUserId],
    );
    const initialImageId = randomUUID();
    await fixture.database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,$3,'image/webp',10,$4,$5,'ready',CURRENT_TIMESTAMP)`,
      [
        initialImageId,
        `private/${initialImageId}.webp`,
        `root-pass-${pass}-initial.webp`,
        "e".repeat(64),
        fixture.rootUserId,
      ],
    );
    const draft = await http<ReworkOrderResponse>(
      fixture.app,
      "POST",
      "/rework-orders/drafts",
      {
        receivingBatchId,
        styleNo: `ROOT-PASS-${pass}`,
        orderQuantity: 100,
        orderNo: `ROOT-ORDER-${pass}`,
        merchandiserUserId: fixture.merchandiserUserId,
        processingFactory: { type: "supplier", supplierId: fixture.supplierId },
        tailInspectionCostBearer: "processing_factory",
        inspectionReport: n01CoreInspectionReport(`Root 全链测试款 ${pass}`),
        problemPart: "袖口",
        problemDescription: `Root 单账号第 ${pass} 遍完整业务链`,
        reworkQuantity: 10,
        attachmentIds: [initialImageId],
      },
    );
    const submitted = await http<ReworkOrderResponse>(
      fixture.app,
      "POST",
      `/rework-orders/${draft.reworkOrderId}/submit`,
      { expectedVersion: draft.version },
    );

    const supplementalImageId = randomUUID();
    await fixture.database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,$3,'image/webp',10,$4,$5,'ready',CURRENT_TIMESTAMP)`,
      [
        supplementalImageId,
        `private/${supplementalImageId}.webp`,
        `root-pass-${pass}-supplement.webp`,
        "f".repeat(64),
        fixture.rootUserId,
      ],
    );
    const supplemented = await http<ReworkOrderResponse>(
      fixture.app,
      "POST",
      `/rework-orders/${draft.reworkOrderId}/supplemental-images`,
      {
        expectedVersion: submitted.version,
        attachmentIds: [supplementalImageId],
      },
    );
    expect(supplemented).toMatchObject({
      status: "pending_process_configuration",
      version: submitted.version + 1,
      attachmentIds: expect.arrayContaining([initialImageId, supplementalImageId]),
    });

    const directDetail = await fixture.businessDetail.get({
      actorId: fixture.rootUserId,
      actorRoles: ["root_superuser"],
      authorizationCapability: "business:detail:read",
      authorizationCapabilities: ["business:read_all"],
      requestId: randomUUID(),
    }, draft.reworkOrderId);
    expect(directDetail.reworkOrderId).toBe(draft.reworkOrderId);

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
            executionKind: "worker",
            plannedQuantity: fixture.plannedQuantity,
            pricingUnit: fixture.pricingUnit,
            unitPrice: fixture.unitPrice,
          }, {
            source: "custom",
            customProcessName: "尾查",
            executionKind: "tail_inspection",
            plannedQuantity: 1,
            pricingUnit: "piece",
            unitPrice: 0.2,
          }],
        },
      );
    const saved = await save(supplemented.version);
    const workerItem = saved.configuration!.items.find((item) => item.executionKind === "worker")!;
    const tailItem = saved.configuration!.items.find((item) => item.executionKind === "tail_inspection")!;
    const plan = await http<{ complete: boolean }>(
      fixture.app,
      "PUT",
      `/rework-orders/${draft.reworkOrderId}/process-worker-plan`,
      {
        expectedOrderVersion: saved.orderVersion,
        configurationId: saved.configuration!.configurationId,
        expectedConfigurationVersion: saved.configuration!.configurationVersion,
        assignments: [
          { configurationItemId: workerItem.configurationItemId, memberIds: [fixture.workerPersonIds[0]!] },
          { configurationItemId: tailItem.configurationItemId, memberIds: [fixture.tailPersonId] },
        ],
      },
    );
    expect(plan.complete).toBe(true);
    const submittedConfiguration = await http<ProcessConfigurationResponse>(
      fixture.app,
      "POST",
      `/rework-orders/${draft.reworkOrderId}/process-configuration/submit`,
      {
        expectedOrderVersion: saved.orderVersion,
        expectedConfigurationVersion: saved.configuration!.configurationVersion,
      },
    );
    expect(submittedConfiguration.reworkStatus).toBe("pending_ie_review");
    const approved = await http<ProcessConfigurationResponse>(
      fixture.app,
      "POST",
      `/rework-orders/${draft.reworkOrderId}/process-configuration/review`,
      {
        expectedOrderVersion: submittedConfiguration.orderVersion,
        expectedConfigurationVersion: submittedConfiguration.configuration!.configurationVersion,
        decision: "approved",
      },
    );
    expect(approved.reworkStatus).toBe("in_progress");
    const approvedWorkerItem = approved.configuration!.items.find((item) => item.executionKind === "worker")!;
    const approvedTailItem = approved.configuration!.items.find((item) => item.executionKind === "tail_inspection")!;
    expect(approvedWorkerItem).toMatchObject({
      plannedQuantity: fixture.plannedQuantity,
      unitPrice: fixture.unitPrice,
    });
    return {
      draft,
      approved,
      item: approvedWorkerItem,
      tailItem: approvedTailItem,
    };
  }

  async function runResponsibilityToDeduction(
    fixture: PassFixture,
    reworkOrderId: string,
    itemId: string,
    tailItemId: string,
    orderVersion: number,
    expectedDeductionAmount: string,
  ): Promise<void> {
    const determination = await http<ResponsibilityDeterminationResponse>(
      fixture.app,
      "POST",
      `/rework-orders/${reworkOrderId}/responsibility-determinations/drafts`,
      {
        expectedOrderVersion: orderVersion,
        expectedCurrentDeterminationVersion: null,
        handlerUserId: fixture.rootUserId,
        tailInspectionCostBearer: "processing_factory",
        processes: [{
          configurationItemId: itemId,
          multiplier: "1.000",
          allocations: [{
            responsibilityType: "processing_factory",
            shareBps: 10000,
            multiplier: "1.200",
            supplierId: fixture.supplierId,
          }],
        }, {
          configurationItemId: tailItemId,
          multiplier: "1.000",
          allocations: [{
            responsibilityType: "processing_factory",
            shareBps: 10000,
            multiplier: "1.200",
            supplierId: fixture.supplierId,
          }],
        }],
      },
    );
    expect(determination.canDetermine).toBe(true);
    const finalized = await http<ResponsibilityDeterminationResponse>(
      fixture.app,
      "POST",
      `/rework-orders/${reworkOrderId}/responsibility-determinations/finalize`,
      {
        expectedOrderVersion: determination.orderVersion,
        expectedCurrentDeterminationVersion: determination.determination!.version,
      },
    );
    expect(finalized).toMatchObject({
      reworkStatus: "completed",
      ownerSignature: null,
    });
    const batch = await http<ExternalResponsibilityBatchResponse | null>(
      fixture.app,
      "GET",
      `/rework-orders/${reworkOrderId}/external-responsibilities`,
    );
    expect(batch).not.toBeNull();
    expect(batch!.cases).toHaveLength(1);
    let externalCase = batch!.cases[0]!;
    expect(externalCase).toMatchObject({
      responsibilityType: "processing_factory",
      supplier: { supplierId: fixture.supplierId },
      status: "deduction_follow_up",
      caseVersion: 1,
      actualDeductedAmount: "0.00",
      remainingAmount: externalCase.proposedDeductionAmount,
      canSign: false,
      canRecordDeduction: true,
    });
    expect(externalCase.proposedDeductionAmount).toBe(expectedDeductionAmount);

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
    expect(externalCase.remainingAmount).toBe("0.00");

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
    expect(externalCase).toMatchObject({
      status: "closed",
      closure: {
        result: "full",
        remainingAmount: "0.00",
      },
    });
  }

  async function runWages(fixture: PassFixture): Promise<void> {
    const periods = await http<WagePeriod[]>(fixture.app, "GET", "/wage-periods");
    expect(periods).toHaveLength(1);
    const period = periods[0]!;
    const detail = await http<WagePeriodDetail>(
      fixture.app,
      "GET",
      `/wage-periods/${period.periodId}`,
    );
    expect(detail.items.length).toBeGreaterThan(0);
    expect(detail.period.totalAmount).toBe(
      detail.items.reduce((sum, item) => sum + Number(item.payableAmount), 0).toFixed(2),
    );

    // Wage data is read-only reference material for finance reconciliation.
    // Month-close and accountant-lock actions are intentionally unavailable.
    const disabledLock = await fixture.app.inject({
      method: "POST",
      url: `/wage-periods/${period.periodId}/lock`,
      headers: { cookie: sessionCookie, "idempotency-key": randomUUID() },
      payload: {
        expectedVersion: period.periodVersion,
        lockNote: "该操作不应对外提供",
      },
    });
    expect(disabledLock.statusCode).toBe(404);

    const detailAfterDisabledLock = await http<WagePeriodDetail>(
      fixture.app,
      "GET",
      `/wage-periods/${period.periodId}`,
    );
    expect(detailAfterDisabledLock.period.totalAmount).toBe(detail.period.totalAmount);
    expect(detailAfterDisabledLock.items).toEqual(detail.items);
  }

  async function assertReconciliation(
    fixture: PassFixture,
    orderId: string,
  ): Promise<void> {
    const result = await fixture.database.query<{
      reportTotal: string;
      responsibilityBaseTotal: string;
      responsibilityTotal: string;
      externalTotal: string;
      wageTotal: string;
    }>(
      `SELECT
         (SELECT COALESCE(sum(report.group_amount),0)::numeric(18,2)::text
          FROM rework_work_reports report
          WHERE report.rework_order_id=$1
            AND NOT EXISTS(
              SELECT 1 FROM rework_work_report_rejections rejection
              WHERE rejection.work_report_id=report.work_report_id
            )) AS "reportTotal",
         (SELECT COALESCE(sum(process.base_amount),0)::numeric(18,2)::text
          FROM rework_responsibility_processes process
          WHERE process.determination_id=(
            SELECT determination.determination_id
            FROM rework_responsibility_determinations determination
            WHERE determination.rework_order_id=$1
              AND determination.stage='finalized'
            ORDER BY determination.determination_version DESC
            LIMIT 1
          )) AS "responsibilityBaseTotal",
         (SELECT calculation_total::numeric(18,2)::text
          FROM rework_responsibility_determinations
          WHERE rework_order_id=$1 AND stage='finalized'
          ORDER BY determination_version DESC LIMIT 1) AS "responsibilityTotal",
         (SELECT COALESCE(sum(proposed_deduction_amount),0)::numeric(18,2)::text
          FROM rework_external_responsibility_cases
          WHERE rework_order_id=$1 AND status<>'superseded') AS "externalTotal",
         (SELECT COALESCE(sum(payable_amount),0)::numeric(18,2)::text
          FROM rework_wage_items WHERE rework_order_id=$1) AS "wageTotal"`,
      [orderId],
    );
    const totals = result.rows[0]!;
    expect(totals.reportTotal).toBe(totals.wageTotal);
    expect(Number(totals.responsibilityTotal)).toBeCloseTo(Number(totals.responsibilityBaseTotal) * 1.2, 2);
    expect(totals.externalTotal).toBe(totals.responsibilityTotal);
  }

  async function runPass(pass: 1 | 2): Promise<void> {
    const fixture = await setup(pass);
    try {
      const { draft, item, tailItem } = await startOrder(pass, fixture);
      const started = await http<ReworkWorkTasksResponse>(
        fixture.app,
        "GET",
        `/rework-orders/${draft.reworkOrderId}/work-tasks`,
      );
      expect(started.reworkStatus).toBe("in_progress");
      const task = started.tasks.find((candidate) => candidate.executionKind === "worker")!;
      const tailTask = started.tasks.find((candidate) => candidate.executionKind === "tail_inspection")!;
      expect(task).toBeDefined();
      expect(tailTask).toBeDefined();

      const submitReport = async (
        workTaskId: string,
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
          `/work-tasks/${workTaskId}/reports`,
          {
            expectedOrderVersion: view.orderVersion,
            actualQuantity: fixture.plannedQuantity,
            completedAt: new Date(Date.now() - 60_000).toISOString(),
            ...(resubmitsWorkReportId ? { resubmitsWorkReportId } : {}),
          },
        );
      };

      let report = await submitReport(task.workTaskId);
      const tailReported = await submitReport(tailTask.workTaskId);
      expect(tailReported).toMatchObject({
        workTaskId: tailTask.workTaskId,
        status: "submitted",
      });
      if (pass === 2) {
        const review = await http<WholeOrderReviewResponse>(
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
            reason: "Root 第二遍：自己驳回后重报",
          },
        );
        expect(returned.reworkStatus).toBe("in_progress");
        report = await submitReport(task.workTaskId, report.workReportId);
      }
      expect(report.status).toBe("submitted");

      let n05 = await http<WholeOrderReviewResponse>(
        fixture.app,
        "GET",
        `/rework-orders/${draft.reworkOrderId}/whole-order-review`,
      );
      expect(n05.processes).toEqual([
        expect.objectContaining({ complete: true, finalUnitPrice: fixture.unitPrice }),
      ]);
      if (pass === 2) {
        const workerCorrected = await http<WholeOrderReviewResponse>(
          fixture.app,
          "POST",
          `/work-reports/${report.workReportId}/effective-quantity`,
          { expectedOrderVersion: n05.orderVersion, effectiveQuantity: 1 },
        );
        expect(workerCorrected.reports.find((candidate) => candidate.workReportId === report.workReportId)).toMatchObject({
          actualQuantity: 2,
          effectiveQuantity: 1,
          corrected: true,
        });
        n05 = await http<WholeOrderReviewResponse>(
          fixture.app,
          "POST",
          `/work-reports/${tailReported.workReportId}/effective-quantity`,
          { expectedOrderVersion: workerCorrected.orderVersion, effectiveQuantity: 1 },
        );
        expect(n05.processes).toEqual([
          expect.objectContaining({ completedQuantity: 1, tailCheckedQuantity: 1, complete: true }),
        ]);
      }
      const n06Confirmed = await http<WholeOrderReviewResponse>(
        fixture.app,
        "POST",
        `/rework-orders/${draft.reworkOrderId}/whole-order-review/approve`,
        {
          expectedOrderVersion: n05.orderVersion,
          temporaryCoefficients: pass === 2 ? [{
            configurationItemId: item.configurationItemId,
            personId: fixture.workerPersonIds[0]!,
            multiplier: 1.3,
            reason: "旺季临时工加价",
          }] : [],
        },
      );
      expect(n06Confirmed.reworkStatus).toBe("pending_final_quantity_ie_review");
      const n06Approved = await http<WholeOrderReviewResponse>(
        fixture.app,
        "POST",
        `/rework-orders/${draft.reworkOrderId}/whole-order-review/ie-review`,
        { expectedOrderVersion: n06Confirmed.orderVersion, decision: "approved" },
      );
      expect(n06Approved.reworkStatus).toBe("pending_responsibility_determination");
      const generatedWage = (await fixture.database.query<{ payable_amount: string }>(
        `SELECT payable_amount::text FROM rework_wage_items
         WHERE rework_order_id=$1 AND person_id=$2`,
        [draft.reworkOrderId, fixture.workerPersonIds[0]],
      )).rows[0]?.payable_amount;
      expect(generatedWage).toBe(pass === 2 ? "11.70" : "6.00");

      await runResponsibilityToDeduction(
        fixture,
        draft.reworkOrderId,
        item.configurationItemId,
        tailItem.configurationItemId,
        n06Approved.orderVersion,
        pass === 2 ? "11.04" : "9.60",
      );
      expect((await fixture.database.query<{ status: string }>(
        "SELECT status FROM rework_orders WHERE rework_order_id=$1",
        [draft.reworkOrderId],
      )).rows[0]?.status).toBe("completed");

      const completedOrder = (await fixture.database.query<{ version: number }>(
        "SELECT version FROM rework_orders WHERE rework_order_id=$1",
        [draft.reworkOrderId],
      )).rows[0]!;
      const completedImageId = randomUUID();
      await fixture.database.query(
        `INSERT INTO attachments(
           attachment_id,object_key,original_filename,mime_type,size_bytes,
           sha256,uploaded_by,status,ready_at
         ) VALUES($1,$2,$3,'image/webp',10,$4,$5,'ready',CURRENT_TIMESTAMP)`,
        [
          completedImageId,
          `private/${completedImageId}.webp`,
          `root-pass-${pass}-completed.webp`,
          "c".repeat(64),
          fixture.rootUserId,
        ],
      );
      const completedSupplement = await http<ReworkOrderResponse>(
        fixture.app,
        "POST",
        `/rework-orders/${draft.reworkOrderId}/supplemental-images`,
        {
          expectedVersion: completedOrder.version,
          attachmentIds: [completedImageId],
        },
      );
      expect(completedSupplement).toMatchObject({
        status: "completed",
        version: completedOrder.version + 1,
        attachmentIds: expect.arrayContaining([completedImageId]),
      });

      await runWages(fixture);
      await assertReconciliation(fixture, draft.reworkOrderId);

      const rootRoles = await fixture.database.query(
        `SELECT 1 FROM user_role_assignments
         WHERE user_id=$1 AND revoked_at IS NULL`,
        [fixture.rootUserId],
      );
      expect(rootRoles.rowCount).toBe(0);
    } finally {
      await fixture.app.close();
      await fixture.database.end();
      await dropOwnedPostgresSchema(admin,fixture.schema);
    }
  }

  it("runs two fresh Root orders end-to-end through distinct normal and correction paths", async () => {
    await runPass(1);
    await runPass(2);
  });
});
