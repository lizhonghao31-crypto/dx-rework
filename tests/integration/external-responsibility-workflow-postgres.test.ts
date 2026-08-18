import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { AuthorizedResponsibilityDeterminationService } from "../../apps/api/src/rework/responsibility-determination-authorized-service.js";
import { ReviewedExternalResponsibilityService } from "../../apps/api/src/rework/reviewed-external-responsibility-service.js";
import { WholeOrderReviewService } from "../../apps/api/src/rework/whole-order-review-service.js";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;
const migrations = [
  "0001_platform_foundation.sql",
  "0002_dingtalk_identity_access.sql",
  "0003_identity_union_continuity.sql",
  "0004_public_tools_foundation.sql",
  "0005_access_master_data.sql",
  "0006_rework_initiation.sql",
  "0007_process_configuration_ie_review.sql",
  "0008_worker_assignment_reporting.sql",
  "0009_whole_order_review_quantity_adjustment.sql",
  "0010_responsibility_determination_amount_engine.sql",
  "0011_responsibility_authorization_handler_closure.sql",
  "0012_responsibility_direct_delegation.sql",
  "0013_responsibility_review_closure.sql",
  "0014_responsibility_source_share_coverage.sql",
  "0015_own_factory_responsibility_approval.sql",
  "0016_responsibility_amount_contract_restore.sql",
  "0017_external_responsibility_deduction.sql",
  "0018_external_responsibility_review_closure.sql",
  "0019_external_revision_seed_ordering.sql",
  "0020_external_responsibility_codex_closure.sql",
  "0021_external_processing_factory_override_closure.sql",
  "0042_external_processing_factory_auto_route.sql",
] as const;

type ReviewedOrder = {
  orderId: string;
  itemId: string;
  orderVersion: number;
};

runWithPostgres("external responsibility reviewed workflow", () => {
  const schema = `external_workflow_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });
  const access = new AccessMasterDataService(database, "corp");
  const initiation = new ReworkInitiationService(database, "corp");
  const configuration = new ProcessConfigurationService(database);
  const reporting = new WorkReportingService(database);
  const review = new WholeOrderReviewService(database);
  const responsibility = new AuthorizedResponsibilityDeterminationService(database);
  const external = new ReviewedExternalResponsibilityService(database);

  const ids = {
    admin: randomUUID(),
    qc: randomUUID(),
    tail: randomUUID(),
    ie: randomUUID(),
    worker: randomUUID(),
    merch: randomUUID(),
    otherMerch: randomUUID(),
    delegate: randomUUID(),
    payables: randomUUID(),
    production: randomUUID(),
    embroideryMerch: randomUUID(),
  };
  let workerPersonId = "";
  let supplierId = "";

  const actor = (
    actorId: string,
    actorRoles: readonly string[],
    ...authorizationCapabilities: string[]
  ): TrustedActorContext => ({
    actorId,
    actorRoles,
    authorizationCapability: authorizationCapabilities[0]!,
    authorizationCapabilities,
    requestId: randomUUID(),
  });

  const adminActor = () => actor(
    ids.admin,
    ["system_admin"],
    "master_data:manage",
    "delegation:manage",
  );
  const merchActor = () => actor(
    ids.merch,
    ["order_merchandiser"],
    "external_responsibility:view",
    "external_responsibility:sign",
    "external_deduction:follow_up",
    "external_responsibility:request_revision",
    "supplier_catalog:read",
    "tools:user",
  );
  const payablesActor = () => actor(
    ids.payables,
    ["factory_payables"],
    "external_responsibility:view",
    "external_responsibility:payables_confirm",
    "external_deduction:follow_up",
    "external_deduction:record",
    "external_deduction:close",
    "supplier_catalog:read",
    "tools:user",
  );
  const productionActor = () => actor(
    ids.production,
    ["production_management"],
    "external_responsibility:approve_revision",
    "external_responsibility:view",
    "responsibility:determine",
  );

  async function createReviewedOrder(label: string): Promise<ReviewedOrder> {
    const created = await initiation.createDraft(
      actor(ids.qc, ["quality_control"], "rework:initiate"),
      {
        styleNo: `EXT-${label}`,
        merchandiserUserId: ids.merch,
        processingFactory: { type: "supplier", supplierId },
        problemPart: "袖口",
        problemDescription: `外部责任流程 ${label}`,
        reworkQuantity: 1,
      },
      randomUUID(),
    );
    const submitted = await initiation.submit(
      actor(ids.qc, ["quality_control"], "rework:initiate"),
      created.value.reworkOrderId,
      { expectedVersion: created.value.version },
      randomUUID(),
    );
    const saved = await configuration.saveDraft(
      actor(ids.tail, ["tail_supervisor"], "process:configure"),
      created.value.reworkOrderId,
      {
        expectedOrderVersion: submitted.value.version,
        items: [{
          source: "custom",
          customProcessName: `返查-${label}`,
          pricingUnit: "piece",
          plannedQuantity: 1,
          unitPrice: 1,
        }],
      },
      randomUUID(),
    );
    const queued = await configuration.submit(
      actor(ids.tail, ["tail_supervisor"], "process:configure"),
      created.value.reworkOrderId,
      {
        expectedOrderVersion: saved.value.orderVersion,
        expectedConfigurationVersion:
          saved.value.configuration!.configurationVersion,
      },
      randomUUID(),
    );
    const approved = await configuration.review(
      actor(ids.ie, ["ie_reviewer"], "process:review"),
      created.value.reworkOrderId,
      {
        expectedOrderVersion: queued.value.orderVersion,
        expectedConfigurationVersion:
          queued.value.configuration!.configurationVersion,
        decision: "approved",
      },
      randomUUID(),
    );
    const itemId = approved.value.configuration!.items[0]!.configurationItemId;
    const beforeTask = await reporting.list(
      actor(ids.tail, ["tail_supervisor"], "work:assign"),
      created.value.reworkOrderId,
    );
    const task = await reporting.createTask(
      actor(ids.tail, ["tail_supervisor"], "work:assign"),
      created.value.reworkOrderId,
      {
        expectedOrderVersion: beforeTask.orderVersion,
        configurationItemId: itemId,
        mode: "individual",
        members: [{ personId: workerPersonId }],
      },
      randomUUID(),
    );
    const beforeReport = await reporting.list(
      actor(ids.tail, ["tail_supervisor"], "work:assign"),
      created.value.reworkOrderId,
    );
    await reporting.submitReport(
      actor(ids.worker, ["worker"], "work:report"),
      task.value.workTaskId,
      {
        expectedOrderVersion: beforeReport.orderVersion,
        actualQuantity: 1,
        completedAt: new Date().toISOString(),
      },
      randomUUID(),
    );
    const reviewView = await review.get(
      actor(ids.tail, ["tail_supervisor"], "submission:audit"),
      created.value.reworkOrderId,
    );
    const reviewed = await review.approve(
      actor(ids.tail, ["tail_supervisor"], "submission:audit"),
      created.value.reworkOrderId,
      { expectedOrderVersion: reviewView.orderVersion, temporaryCoefficients: [] },
      randomUUID(),
    );
    return {
      orderId: created.value.reworkOrderId,
      itemId,
      orderVersion: reviewed.value.orderVersion,
    };
  }

  async function finalizeExternal(order: ReviewedOrder) {
    const production = actor(
      ids.production,
      ["production_management"],
      "responsibility:determine",
    );
    const draft = await responsibility.saveDraft(
      production,
      order.orderId,
      {
        expectedOrderVersion: order.orderVersion,
        expectedCurrentDeterminationVersion: null,
        handlerUserId: ids.production,
        processes: [{
          configurationItemId: order.itemId,
          multiplier: "1.000",
          allocations: [{
            responsibilityType: "processing_factory",
            shareBps: 10000,
          }],
        }],
      },
      randomUUID(),
    );
    return responsibility.finalize(
      production,
      order.orderId,
      {
        expectedOrderVersion: draft.value.orderVersion,
        expectedCurrentDeterminationVersion: 1,
      },
      randomUUID(),
    );
  }

  beforeAll(async () => {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    for (const migration of migrations) {
      await database.query(
        await readFile(
          new URL(`../../apps/api/migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }
    const users = [
      [ids.admin, "Admin", "system_admin"],
      [ids.qc, "QC", "quality_control"],
      [ids.tail, "Tail", "tail_supervisor"],
      [ids.ie, "IE", "ie_reviewer"],
      [ids.worker, "Worker", "worker"],
      [ids.merch, "Merch", "order_merchandiser"],
      [ids.otherMerch, "Other Merch", "order_merchandiser"],
      [ids.delegate, "Delegate", "worker"],
      [ids.payables, "Factory Payables", "factory_payables"],
      [ids.production, "Production", "production_management"],
      [
        ids.embroideryMerch,
        "Embroidery Merch",
        "embroidery_washing_merchandiser",
      ],
    ] as const;
    for (const [userId, displayName, role] of users) {
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
         ) VALUES($1,$2,$3,$2,'fixture')`,
        [randomUUID(), userId, role],
      );
    }
    await access.ensureOrganizationPolicy();
    workerPersonId = (
      await access.createPerson(adminActor(), {
        personType: "internal",
        appUserId: ids.worker,
        displayName: "Worker",
        aliases: [],
        reason: "external workflow fixture",
      })
    ).personId;
    supplierId = (
      await access.createSupplier(adminActor(), {
        supplierCode: "EXTFAC01",
        supplierType: "factory",
        supplierName: "External Factory",
        active: true,
        changeReason: "external workflow fixture",
      })
    ).supplierId;
  });

  afterAll(async () => {
    await database.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  });

  it("runs N08-B and N10-B with exact versions while N09 ignores actual-deduction completion", async () => {
    const order = await createReviewedOrder("lifecycle");
    await finalizeExternal(order);
    const batch = await external.get(merchActor(), order.orderId);
    expect(batch).toMatchObject({
      cases: [expect.objectContaining({
        status: "pending_payables_confirmation",
        proposedDeductionAmount: "1.00",
        caseVersion: 1,
      })],
    });
    const pending = batch!.cases[0]!;
    const accepted = await external.payablesAccept(
      payablesActor(),
      pending.caseId,
      { expectedCaseVersion: pending.caseVersion },
      randomUUID(),
    );
    expect(accepted.value).toMatchObject({
      status: "deduction_follow_up",
      caseVersion: 2,
      actualDeductedAmount: "0.00",
    });
    const completed = await database.query<{ status: string }>(
      "SELECT status FROM rework_orders WHERE rework_order_id=$1",
      [order.orderId],
    );
    expect(completed.rows[0]).toEqual({ status: "completed" });

    const now = Date.now();
    await access.createDelegation(adminActor(), {
      grantorUserId: ids.payables,
      granteeUserId: ids.delegate,
      capability: "external_responsibility:payables_confirm",
      scopeType: "rework_order",
      scopeId: order.orderId,
      validFrom: new Date(now - 60_000).toISOString(),
      validUntil: new Date(now + 3_600_000).toISOString(),
      reason: "confirm-only payables proxy",
    });
    const confirmOnly = actor(
      ids.delegate,
      ["worker"],
      "external_responsibility:payables_confirm",
    );
    const delegatedView = await external.getCase(confirmOnly, pending.caseId);
    expect(delegatedView).toMatchObject({
      canRecordDeduction: false,
      canClose: false,
      canFollowUp: false,
    });
    await expect(external.recordDeduction(
      confirmOnly,
      pending.caseId,
      {
        expectedCaseVersion: 3,
        entryType: "deduction",
        amount: "0.01",
        deductedOn: "2026-08-03",
        attachmentIds: [],
      },
      randomUUID(),
    )).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    const recorded = await external.recordDeduction(
      payablesActor(),
      pending.caseId,
      {
        expectedCaseVersion: 3,
        entryType: "deduction",
        amount: "1.00",
        deductedOn: "2026-08-03",
        attachmentIds: [],
      },
      randomUUID(),
    );
    expect(recorded.value).toMatchObject({
      caseVersion: 4,
      actualDeductedAmount: "1.00",
      remainingAmount: "0.00",
    });
    await expect(external.recordDeduction(
      payablesActor(),
      pending.caseId,
      {
        expectedCaseVersion: 3,
        entryType: "deduction",
        amount: "0.01",
        deductedOn: "2026-08-03",
        attachmentIds: [],
      },
      randomUUID(),
    )).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    const closed = await external.close(
      payablesActor(),
      pending.caseId,
      {
        expectedCaseVersion: 4,
        result: "full",
        evidenceAttachmentIds: [],
      },
      randomUUID(),
    );
    expect(closed.value).toMatchObject({
      status: "closed",
      caseVersion: 5,
      closure: {
        result: "full",
        actualDeductedAmount: "1.00",
        remainingAmount: "0.00",
      },
    });
  });

  it("rejects a cross-order merchandiser delegation and accepts the bound merchandiser delegation", async () => {
    const order = await createReviewedOrder("delegation");
    await finalizeExternal(order);
    const now = Date.now();
    await access.createDelegation(adminActor(), {
      grantorUserId: ids.otherMerch,
      granteeUserId: ids.delegate,
      capability: "external_responsibility:sign",
      scopeType: "rework_order",
      scopeId: order.orderId,
      validFrom: new Date(now - 60_000).toISOString(),
      validUntil: new Date(now + 3_600_000).toISOString(),
      reason: "cross-order negative fixture",
    });
    const denied = await database.query<{ permitted: boolean }>(
      "SELECT external_responsibility_can_sign($1,$2,'processing_factory') permitted",
      [ids.delegate, order.orderId],
    );
    expect(denied.rows[0]).toEqual({ permitted: false });

    await access.createDelegation(adminActor(), {
      grantorUserId: ids.merch,
      granteeUserId: ids.delegate,
      capability: "external_responsibility:sign",
      scopeType: "rework_order",
      scopeId: order.orderId,
      validFrom: new Date(now - 60_000).toISOString(),
      validUntil: new Date(now + 3_600_000).toISOString(),
      reason: "bound-order positive fixture",
    });
    const allowed = await database.query<{ permitted: boolean }>(
      "SELECT external_responsibility_can_sign($1,$2,'processing_factory') permitted",
      [ids.delegate, order.orderId],
    );
    expect(allowed.rows[0]).toEqual({ permitted: true });
    const supplierOptions = await external.listSupplierOptions(
      actor(ids.delegate, ["worker"], "external_responsibility:sign"),
      order.orderId,
    );
    expect(supplierOptions).toContainEqual(expect.objectContaining({
      supplierId,
      supplierType: "factory",
    }));
  });

  it("persists an immutable reason when a different processing factory is selected", async () => {
    const alternateSupplierId = (
      await access.createSupplier(adminActor(), {
        supplierCode: "ALTFAC02",
        supplierType: "factory",
        supplierName: "Alternate Factory",
        active: true,
        changeReason: "override reason fixture",
      })
    ).supplierId;
    const order = await createReviewedOrder("factory-override");
    await finalizeExternal(order);
    const batch = await external.get(merchActor(), order.orderId);

    await expect(external.allocateSuppliers(
      merchActor(),
      batch!.batchId,
      {
        expectedBatchVersion: batch!.batchVersion,
        allocations: [{
          responsibilityType: "processing_factory",
          supplierId: alternateSupplierId,
          externalItemIds: [batch!.items[0]!.externalItemId],
        }],
      },
      randomUUID(),
    )).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });

    const allocated = await external.allocateSuppliers(
      merchActor(),
      batch!.batchId,
      {
        expectedBatchVersion: batch!.batchVersion,
        allocations: [{
          responsibilityType: "processing_factory",
          supplierId: alternateSupplierId,
          externalItemIds: [batch!.items[0]!.externalItemId],
          processingFactoryOverrideReason: "原加工厂拒绝承担本次返工扣款",
        }],
      },
      randomUUID(),
    );
    const targetCase = allocated.value!.cases[0]!;
    const persisted = await database.query<{
      processing_factory_override_reason: string;
    }>(
      `SELECT processing_factory_override_reason
       FROM rework_external_responsibility_cases
       WHERE case_id=$1`,
      [targetCase.caseId],
    );
    expect(persisted.rows[0]).toEqual({
      processing_factory_override_reason: "原加工厂拒绝承担本次返工扣款",
    });
    await expect(database.query(
      `UPDATE rework_external_responsibility_cases
       SET processing_factory_override_reason='被覆盖的原因'
       WHERE case_id=$1`,
      [targetCase.caseId],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("approves a structured revision and atomically creates its executable N07 draft", async () => {
    const order = await createReviewedOrder("revision");
    await finalizeExternal(order);
    const batch = await external.get(merchActor(), order.orderId);
    const allocated = await external.allocateSuppliers(
      merchActor(),
      batch!.batchId,
      {
        expectedBatchVersion: batch!.batchVersion,
        allocations: [{
          responsibilityType: "processing_factory",
          supplierId,
          externalItemIds: [batch!.items[0]!.externalItemId],
        }],
      },
      randomUUID(),
    );
    const targetCase = allocated.value!.cases[0]!;
    const requested = await external.requestRevision(
      merchActor(),
      targetCase.caseId,
      {
        expectedCaseVersion: targetCase.caseVersion,
        requestedChange: {
          kind: "responsibility_type",
          configurationItemIds: [order.itemId],
          targetResponsibilityType: "own_factory",
        },
        reason: "供应商提供证据，应改成本厂承担",
        attachmentIds: [],
      },
      randomUUID(),
    );
    const pending = requested.value.revisionRequests.find(
      (item) => item.status === "pending",
    )!;
    const approved = await external.approveRevision(
      productionActor(),
      pending.revisionRequestId,
      {
        expectedCaseVersion: requested.value.caseVersion,
        expectedRevisionVersion: pending.revisionVersion,
        reason: "同意返回 N07 重新判责",
      },
      randomUUID(),
    );
    const decision = approved.value.revisionRequests.find(
      (item) => item.revisionRequestId === pending.revisionRequestId,
    )!;
    expect(decision).toMatchObject({
      status: "approved",
      seededDeterminationId: expect.any(String),
    });
    const [orderState, seed] = await Promise.all([
      database.query<{ status: string }>(
        "SELECT status FROM rework_orders WHERE rework_order_id=$1",
        [order.orderId],
      ),
      database.query<{
        stage: string;
        replaces_determination_id: string;
      }>(
        `SELECT stage,replaces_determination_id
         FROM rework_responsibility_determinations
         WHERE determination_id=$1`,
        [decision.seededDeterminationId],
      ),
    ]);
    expect(orderState.rows[0]).toEqual({
      status: "pending_responsibility_determination",
    });
    expect(seed.rows[0]).toMatchObject({
      stage: "draft",
      replaces_determination_id: batch!.finalizedDeterminationId,
    });
    const copied = await database.query<{
      process_count: number;
      allocation_count: number;
      line_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM rework_responsibility_processes WHERE determination_id=$1) process_count,
         (SELECT count(*)::int FROM rework_responsibility_allocations WHERE determination_id=$1) allocation_count,
         (SELECT count(*)::int FROM rework_responsibility_amount_lines WHERE determination_id=$1) line_count`,
      [decision.seededDeterminationId],
    );
    expect(copied.rows[0]).toEqual({
      process_count: 1,
      allocation_count: 1,
      line_count: 1,
    });
  });

  it("gives the embroidery/washing merchandiser the supplier and attachment tool capabilities", async () => {
    const capabilities = await database.query<{ capability: string }>(
      `SELECT capability
       FROM role_capabilities
       WHERE role_code='embroidery_washing_merchandiser'
         AND capability=ANY($1::text[])
       ORDER BY capability`,
      [["supplier_catalog:read", "tools:user"]],
    );
    expect(capabilities.rows.map((item) => item.capability)).toEqual([
      "supplier_catalog:read",
      "tools:user",
    ]);
  });
});
