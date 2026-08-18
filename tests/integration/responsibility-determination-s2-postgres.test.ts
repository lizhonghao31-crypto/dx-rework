import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { AuthorizedResponsibilityDeterminationService } from "../../apps/api/src/rework/responsibility-determination-authorized-service.js";
import { OwnFactoryApprovalService } from "../../apps/api/src/rework/own-factory-approval-service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
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
] as const;

type ReviewedOrder = {
  orderId: string;
  itemId: string;
  itemIds: string[];
  orderVersion: number;
};

runWithPostgres("responsibility authorization and handler closure", () => {
  const schema = "responsibility_s2_" + randomUUID().replaceAll("-", "");
  const adminPool = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({
    connectionString: databaseUrl!,
    options: "-c search_path=" + schema,
  });
  const access = new AccessMasterDataService(database, "corp");
  const initiation = new ReworkInitiationService(database, "corp");
  const configuration = new ProcessConfigurationService(database);
  const reporting = new WorkReportingService(database);
  const review = new WholeOrderReviewService(database);
  const responsibility = new AuthorizedResponsibilityDeterminationService(database);
  const ownFactoryApproval = new OwnFactoryApprovalService(database);
  const ids = {
    admin: randomUUID(), ownerOne: randomUUID(), ownerTwo: randomUUID(),
    productionOne: randomUUID(), productionTwo: randomUUID(), delegate: randomUUID(),
    disabled: randomUUID(), outsider: randomUUID(), qc: randomUUID(),
    tail: randomUUID(), ie: randomUUID(), merch: randomUUID(), worker: randomUUID(),
  };
  let workerPersonId = "";

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

  const draftInput = (
    orderVersion: number,
    itemId: string,
    handlerUserId: string,
    multiplier = "1.000",
    highMultiplierReason: string | null = null,
  ) => ({
    expectedOrderVersion: orderVersion,
    expectedCurrentDeterminationVersion: null,
    handlerUserId,
    reason: null,
    processes: [{
      configurationItemId: itemId,
      multiplier,
      highMultiplierReason,
      allocations: [{ responsibilityType: "own_factory" as const, shareBps: 10000 }],
    }],
  });

  async function createReviewedOrder(
    label: string,
    processCount = 1,
  ): Promise<ReviewedOrder> {
    const created = await initiation.createDraft(
      actor(ids.qc, ["quality_control"], "rework:initiate"),
      {
        styleNo: "S2-" + label,
        merchandiserUserId: ids.merch,
        processingFactory: { type: "own_factory" },
        problemPart: "袖口",
        problemDescription: "S2 " + label,
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
        items: Array.from({ length: processCount }, (_, index) => ({
          source: "custom" as const,
          customProcessName: `S2 process ${label}-${index + 1}`,
          pricingUnit: "piece" as const,
          plannedQuantity: 1,
          unitPrice: 1,
        })),
      },
      randomUUID(),
    );
    const queued = await configuration.submit(
      actor(ids.tail, ["tail_supervisor"], "process:configure"),
      created.value.reworkOrderId,
      {
        expectedOrderVersion: saved.value.orderVersion,
        expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
      },
      randomUUID(),
    );
    const approved = await configuration.review(
      actor(ids.ie, ["ie_reviewer"], "process:review"),
      created.value.reworkOrderId,
      {
        expectedOrderVersion: queued.value.orderVersion,
        expectedConfigurationVersion: queued.value.configuration!.configurationVersion,
        decision: "approved",
      },
      randomUUID(),
    );
    const itemIds = approved.value.configuration!.items.map(
      (item) => item.configurationItemId,
    );
    for (const itemId of itemIds) {
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
    }
    const view = await review.get(
      actor(ids.tail, ["tail_supervisor"], "submission:audit"),
      created.value.reworkOrderId,
    );
    const reviewed = await review.approve(
      actor(ids.tail, ["tail_supervisor"], "submission:audit"),
      created.value.reworkOrderId,
      { expectedOrderVersion: view.orderVersion, temporaryCoefficients: [] },
      randomUUID(),
    );
    return {
      orderId: created.value.reworkOrderId,
      itemId: itemIds[0]!,
      itemIds,
      orderVersion: reviewed.value.orderVersion,
    };
  }

  beforeAll(async () => {
    await adminPool.query("CREATE SCHEMA " + schema);
    for (const migration of migrations) {
      await database.query(await readFile(
        new URL("../../apps/api/migrations/" + migration, import.meta.url),
        "utf8",
      ));
    }
    const users = [
      [ids.admin, "Admin", "system_admin", "corp", true],
      [ids.ownerOne, "Owner One", "owner_group", "corp", true],
      [ids.ownerTwo, "Owner Two", "owner_group", "corp", true],
      [ids.productionOne, "Production One", "production_management", "corp", true],
      [ids.productionTwo, "Production Two", "production_management", "corp", true],
      [ids.delegate, "Delegate", "worker", "corp", true],
      [ids.disabled, "Disabled", "production_management", "corp", false],
      [ids.outsider, "Outsider", "production_management", "foreign", true],
      [ids.qc, "QC", "quality_control", "corp", true],
      [ids.tail, "Tail", "tail_supervisor", "corp", true],
      [ids.ie, "IE", "ie_reviewer", "corp", true],
      [ids.merch, "Merch", "order_merchandiser", "corp", true],
      [ids.worker, "Worker", "worker", "corp", true],
    ] as const;
    for (const [userId, displayName, role, corpId, enabled] of users) {
      await database.query(
        "INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,$3)",
        [userId, displayName, enabled],
      );
      await database.query(
        `INSERT INTO identity_mappings(
           id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at
         ) VALUES($1,$2,'dingtalk',$3,$4,$5,true,true,CURRENT_TIMESTAMP)`,
        [randomUUID(), userId, corpId, "ding-" + userId, "union-" + userId],
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
      await access.createPerson(
        actor(ids.admin, ["system_admin"], "master_data:manage"),
        {
          personType: "internal",
          appUserId: ids.worker,
          displayName: "Worker",
          aliases: [],
          reason: "S2 fixture",
        },
      )
    ).personId;
  });

  afterAll(async () => {
    await database.end();
    await adminPool.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    await adminPool.end();
  });

  it("uses database roles and order-scoped delegation for handler transfer", async () => {
    const order = await createReviewedOrder("transfer");
    const production = actor(ids.productionOne, ["production_management"], "responsibility:determine");
    const forgedAdmin = actor(
      ids.admin,
      ["system_admin"],
      "responsibility:determine",
      "responsibility:takeover",
      "responsibility:confirm_high_multiplier",
    );
    await expect(responsibility.get(forgedAdmin, order.orderId)).rejects.toMatchObject({
      code: "FORBIDDEN", statusCode: 403,
    });
    await access.createDelegation(production, {
      grantorUserId: ids.productionOne,
      granteeUserId: ids.delegate,
      capability: "responsibility:determine",
      scopeType: "rework_order",
      scopeId: order.orderId,
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      reason: "订单范围判责代理",
    });
    const draft = await responsibility.saveDraft(
      production,
      order.orderId,
      draftInput(order.orderVersion, order.itemId, ids.productionOne),
      "s2-transfer-draft",
    );
    expect(draft.value).toMatchObject({
      handlerUserId: ids.productionOne,
      canDetermine: true,
      determination: { version: 1, stage: "draft" },
    });
    for (const target of [ids.disabled, ids.outsider]) {
      await expect(responsibility.transfer(
        production,
        order.orderId,
        {
          expectedOrderVersion: draft.value.orderVersion,
          expectedCurrentDeterminationVersion: 1,
          toUserId: target,
          reason: "无效目标",
        },
        "s2-invalid-" + target,
      )).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    }
    const transferred = await responsibility.transfer(
      production,
      order.orderId,
      {
        expectedOrderVersion: draft.value.orderVersion,
        expectedCurrentDeterminationVersion: 1,
        toUserId: ids.delegate,
        reason: "转交订单代理",
      },
      "s2-transfer",
    );
    expect(transferred.value).toMatchObject({
      orderVersion: draft.value.orderVersion + 1,
      handlerUserId: ids.delegate,
      canDetermine: false,
    });
    expect(await responsibility.get(
      actor(ids.delegate, ["worker"], "responsibility:determine"),
      order.orderId,
    )).toMatchObject({ handlerUserId: ids.delegate, canDetermine: true });
    await expect(responsibility.finalize(
      production,
      order.orderId,
      {
        expectedOrderVersion: transferred.value.orderVersion,
        expectedCurrentDeterminationVersion: 1,
      },
      "s2-old-handler-finalize",
    )).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
  });

  it("allows only a direct owner to take over and snapshots the effective handler", async () => {
    const order = await createReviewedOrder("takeover");
    const production = actor(ids.productionTwo, ["production_management"], "responsibility:determine");
    const draft = await responsibility.saveDraft(
      production,
      order.orderId,
      draftInput(order.orderVersion, order.itemId, ids.productionTwo),
      "s2-takeover-draft",
    );
    await expect(responsibility.takeover(
      actor(ids.admin, ["system_admin"], "responsibility:takeover"),
      order.orderId,
      {
        expectedOrderVersion: draft.value.orderVersion,
        expectedCurrentDeterminationVersion: 1,
        reason: "管理员伪造接管",
      },
      "s2-admin-takeover",
    )).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    const owner = actor(
      ids.ownerOne,
      ["owner_group"],
      "responsibility:determine",
      "responsibility:takeover",
    );
    const taken = await responsibility.takeover(
      owner,
      order.orderId,
      {
        expectedOrderVersion: draft.value.orderVersion,
        expectedCurrentDeterminationVersion: 1,
        reason: "老板介入",
      },
      "s2-owner-takeover",
    );
    expect(taken.value).toMatchObject({
      handlerUserId: ids.ownerOne,
      canDetermine: true,
      canTakeover: false,
    });
    const finalized = await responsibility.finalize(
      owner,
      order.orderId,
      {
        expectedOrderVersion: taken.value.orderVersion,
        expectedCurrentDeterminationVersion: 1,
      },
      "s2-owner-finalize",
    );
    expect(finalized.value).toMatchObject({
      reworkStatus: "completed",
      handlerUserId: ids.ownerOne,
      determination: { version: 2, stage: "finalized" },
    });
    const autoApproved = await ownFactoryApproval.get(owner, order.orderId);
    expect(autoApproved.approval).toMatchObject({
      status: "approved",
      approvalVersion: 2,
      decision: { actedBy: ids.ownerOne, decision: "approved" },
    });
    const pendingNotices = await database.query<{ count: string }>(
      `SELECT count(*)::text count FROM message_outbox
       WHERE aggregate_id=$1 AND topic='rework.own_factory_approval.pending'`,
      [autoApproved.approval!.approvalId],
    );
    expect(pendingNotices.rows[0]?.count).toBe("0");
    const persisted = await database.query<{
      handler_user_id: string; event_type: string;
      from_user_id: string; to_user_id: string;
    }>(
      `SELECT determination.handler_user_id,event.event_type,event.from_user_id,event.to_user_id
       FROM rework_responsibility_determinations determination
       JOIN rework_responsibility_handler_events event
         ON event.rework_order_id=determination.rework_order_id
       WHERE determination.rework_order_id=$1 AND determination.stage='finalized'`,
      [order.orderId],
    );
    expect(persisted.rows[0]).toEqual({
      handler_user_id: ids.ownerOne,
      event_type: "taken_over",
      from_user_id: ids.productionTwo,
      to_user_id: ids.ownerOne,
    });
  });

  it("rejects the retired process-level responsibility coefficient", async () => {
    const order = await createReviewedOrder("high");
    const submitter = actor(
      ids.ownerOne,
      ["owner_group"],
      "responsibility:determine",
      "responsibility:takeover",
      "responsibility:confirm_high_multiplier",
    );
    await expect(responsibility.saveDraft(
      submitter,
      order.orderId,
      draftInput(order.orderVersion, order.itemId, ids.ownerOne, "2.500", "特殊质量事故"),
      "s2-high-draft",
    )).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    const stored = await database.query<{ count: string }>(
      `SELECT count(*)::text count
       FROM rework_responsibility_determinations
       WHERE rework_order_id=$1`,
      [order.orderId],
    );
    expect(stored.rows[0]?.count).toBe("0");
  });

  it("creates one immutable own-factory approval, queues the other owner result notice, and rejects non-owners", async () => {
    const order = await createReviewedOrder("own-factory-approve");
    const production = actor(
      ids.productionOne,
      ["production_management"],
      "responsibility:determine",
    );
    const draft = await responsibility.saveDraft(
      production,
      order.orderId,
      draftInput(order.orderVersion, order.itemId, ids.productionOne),
      "s2-own-factory-draft",
    );
    const finalized = await responsibility.finalize(
      production,
      order.orderId,
      {
        expectedOrderVersion: draft.value.orderVersion,
        expectedCurrentDeterminationVersion: 1,
      },
      "s2-own-factory-finalize",
    );
    const ownerOne = actor(
      ids.ownerOne,
      ["owner_group"],
      "own_factory:view",
      "own_factory:approve",
    );
    const ownerTwo = actor(
      ids.ownerTwo,
      ["owner_group"],
      "own_factory:view",
      "own_factory:approve",
    );
    const now = new Date();
    await access.createDelegation(
      actor(ids.ownerOne, ["owner_group"], "delegation:manage", "own_factory:approve"),
      {
        grantorUserId: ids.ownerOne,
        granteeUserId: ids.delegate,
        capability: "own_factory:approve",
        scopeType: "rework_order",
        scopeId: order.orderId,
        validFrom: new Date(now.getTime() - 60_000).toISOString(),
        validUntil: new Date(now.getTime() + 60 * 60_000).toISOString(),
        reason: "本单临时授权",
      },
    );
    const delegatedView = await ownFactoryApproval.get(
      actor(ids.delegate, ["worker"], "work:report"),
      order.orderId,
    );
    expect(delegatedView).toMatchObject({ canView: true, canDecide: true });
    await expect(access.createDelegation(
      actor(ids.ownerOne, ["owner_group"], "delegation:manage", "own_factory:approve"),
      {
        grantorUserId: ids.ownerOne,
        granteeUserId: ids.delegate,
        capability: "own_factory:approve",
        scopeType: "global",
        validFrom: now.toISOString(),
        validUntil: new Date(now.getTime() + 60 * 60_000).toISOString(),
        reason: "不得使用全局授权",
      },
    )).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    const view = await ownFactoryApproval.get(ownerOne, order.orderId);
    expect(view).toMatchObject({
      reworkStatus: "pending_responsibility_action",
      canDecide: true,
      approval: {
        finalizedDeterminationVersion: 2,
        status: "pending",
        ownFactoryTotalAmount: "1.00",
      },
    });
    expect(view.approval!.sourceSnapshot.processes).toHaveLength(1);
    await expect(ownFactoryApproval.approve(
      actor(ids.admin, ["system_admin"], "own_factory:view", "own_factory:approve"),
      view.approval!.approvalId,
      {
        expectedOrderVersion: finalized.value.orderVersion,
        expectedApprovalVersion: view.approval!.approvalVersion,
      },
      "s2-own-factory-forged-admin",
    )).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    const sharedTodos = await database.query<{
      recipient_user_id: string;
      status: string;
    }>(
      `SELECT recipient_user_id,status FROM rework_todos
       WHERE category='own_factory_approval' AND entity_id=$1
       ORDER BY recipient_user_id`,
      [order.orderId],
    );
    expect(sharedTodos.rows).toEqual([
      { recipient_user_id: ids.ownerOne, status: "pending" },
      { recipient_user_id: ids.ownerTwo, status: "pending" },
    ]);
    const approved = await ownFactoryApproval.approve(
      ownerOne,
      view.approval!.approvalId,
      {
        expectedOrderVersion: view.orderVersion,
        expectedApprovalVersion: view.approval!.approvalVersion,
        opinion: "同意本厂承担",
      },
      "s2-own-factory-approve",
    );
    expect(approved.value).toMatchObject({
      reworkStatus: "completed",
      approval: {
        status: "approved",
        approvalVersion: 2,
        decision: { actedBy: ids.ownerOne, decision: "approved", otherOwnersNotified: true },
      },
    });
    const closedSharedTodos = await database.query<{ status: string }>(
      `SELECT status FROM rework_todos
       WHERE category='own_factory_approval' AND entity_id=$1
       ORDER BY recipient_user_id`,
      [order.orderId],
    );
    expect(closedSharedTodos.rows).toEqual([
      { status: "completed" },
      { status: "completed" },
    ]);
    await expect(ownFactoryApproval.approve(
      ownerTwo,
      view.approval!.approvalId,
      {
        expectedOrderVersion: view.orderVersion,
        expectedApprovalVersion: view.approval!.approvalVersion,
      },
      "s2-own-factory-late-owner",
    )).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    const notices = await database.query<{ recipient_key: string }>(
      `SELECT recipient_key FROM message_outbox
       WHERE aggregate_id=$1
         AND topic IN (
           'rework.own_factory_approval.pending',
           'rework.own_factory_approval.result'
         )`,
      [view.approval!.approvalId],
    );
    expect(notices.rows).toEqual([]);
    await expect(database.query(
      `UPDATE rework_own_factory_approval_decisions
       SET decision='rejected' WHERE approval_id=$1`,
      [view.approval!.approvalId],
    )).rejects.toThrow();
    await expect(database.query(
      `UPDATE rework_own_factory_approvals
       SET own_factory_total_amount=0 WHERE approval_id=$1`,
      [view.approval!.approvalId],
    )).rejects.toThrow();
  });

  it("does not create N08-A when the finalized version has no own-factory money", async () => {
    const order = await createReviewedOrder("no-own-factory-amount");
    const production = actor(
      ids.productionOne,
      ["production_management"],
      "responsibility:determine",
    );
    const draft = await responsibility.saveDraft(
      production,
      order.orderId,
      {
        ...draftInput(order.orderVersion, order.itemId, ids.productionOne),
        processes: [{
          configurationItemId: order.itemId,
          multiplier: "1.000",
          highMultiplierReason: null,
          allocations: [{ responsibilityType: "processing_factory", shareBps: 10000 }],
        }],
      },
      "s2-no-own-factory-draft",
    );
    await responsibility.finalize(
      production,
      order.orderId,
      {
        expectedOrderVersion: draft.value.orderVersion,
        expectedCurrentDeterminationVersion: 1,
      },
      "s2-no-own-factory-finalize",
    );
    const ownerView = await ownFactoryApproval.get(
      actor(ids.ownerOne, ["owner_group"], "own_factory:view", "own_factory:approve"),
      order.orderId,
    );
    expect(ownerView).toMatchObject({
      reworkStatus: "pending_responsibility_action",
      approval: null,
      history: [],
    });
  });

  it("rejects zero-bps allocations and preserves legal 0.00 lines from a positive share", async () => {
    const order = await createReviewedOrder("own-factory-zero-detail", 2);
    const production = actor(
      ids.productionOne,
      ["production_management"],
      "responsibility:determine",
    );
    await expect(responsibility.saveDraft(
      production,
      order.orderId,
      {
        expectedOrderVersion: order.orderVersion,
        expectedCurrentDeterminationVersion: null,
        handlerUserId: ids.productionOne,
        reason: "零比例必须拒绝",
        processes: [
          {
            configurationItemId: order.itemIds[0]!,
            multiplier: "1.000",
            allocations: [
              { responsibilityType: "own_factory", shareBps: 0 },
              { responsibilityType: "processing_factory", shareBps: 10000 },
            ],
          },
          {
            configurationItemId: order.itemIds[1]!,
            multiplier: "1.000",
            allocations: [{ responsibilityType: "own_factory", shareBps: 10000 }],
          },
        ],
      },
      "s2-own-factory-zero-bps-rejected",
    )).rejects.toThrow();

    const draft = await responsibility.saveDraft(
      production,
      order.orderId,
      {
        expectedOrderVersion: order.orderVersion,
        expectedCurrentDeterminationVersion: null,
        handlerUserId: ids.productionOne,
        reason: "保留正比例舍入零金额明细",
        processes: [
          {
            configurationItemId: order.itemIds[0]!,
            multiplier: "1.000",
            allocations: [
              { responsibilityType: "own_factory", shareBps: 1 },
              { responsibilityType: "processing_factory", shareBps: 9999 },
            ],
          },
          {
            configurationItemId: order.itemIds[1]!,
            multiplier: "1.000",
            allocations: [{ responsibilityType: "own_factory", shareBps: 10000 }],
          },
        ],
      },
      "s2-own-factory-zero-detail-draft",
    );
    await responsibility.finalize(
      production,
      order.orderId,
      {
        expectedOrderVersion: draft.value.orderVersion,
        expectedCurrentDeterminationVersion: 1,
      },
      "s2-own-factory-zero-detail-finalize",
    );
    const owner = actor(
      ids.ownerOne,
      ["owner_group"],
      "own_factory:view",
      "own_factory:approve",
    );
    const approval = await ownFactoryApproval.get(owner, order.orderId);
    expect(approval.approval).toMatchObject({ ownFactoryTotalAmount: "1.00" });
    expect(approval.approval!.sourceSnapshot.processes).toContainEqual(
      expect.objectContaining({
        configurationItemId: order.itemIds[0],
        ownFactoryShareBps: 1,
        ownFactoryRoundedAmount: "0.00",
      }),
    );
    expect(approval.approval!.sourceSnapshot.amountLines).toContainEqual(
      expect.objectContaining({
        configurationItemId: order.itemIds[0],
        shareBps: 1,
        roundedAmount: "0.00",
      }),
    );
    const persisted = await database.query<{
      share_bps: number;
      rounded_amount: string;
    }>(
      `SELECT allocation.share_bps,allocation.rounded_amount::text
       FROM rework_responsibility_allocations allocation
       JOIN rework_responsibility_determinations determination
         ON determination.determination_id=allocation.determination_id
       WHERE determination.rework_order_id=$1
         AND determination.stage='finalized'
         AND allocation.configuration_item_id=$2
         AND allocation.responsibility_type='own_factory'`,
      [order.orderId, order.itemIds[0]],
    );
    expect(persisted.rows).toEqual([{ share_bps: 1, rounded_amount: "0.00" }]);

    const guard = await database.query<{ definition: string }>(
      "SELECT pg_get_functiondef('guard_responsibility_line()'::regprocedure) definition",
    );
    expect(guard.rows[0]!.definition).toContain("parent_multiplier");
    expect(guard.rows[0]!.definition).toContain("parent_share_bps");
    expect(guard.rows[0]!.definition).toContain(
      "amount line inputs must match parent responsibility snapshots",
    );
  });

  it("allows exactly one concurrent terminal owner action and sends a rejection back to N07", async () => {
    const order = await createReviewedOrder("own-factory-reject");
    const production = actor(
      ids.productionTwo,
      ["production_management"],
      "responsibility:determine",
    );
    const draft = await responsibility.saveDraft(
      production,
      order.orderId,
      draftInput(order.orderVersion, order.itemId, ids.productionTwo),
      "s2-own-factory-reject-draft",
    );
    await responsibility.finalize(
      production,
      order.orderId,
      {
        expectedOrderVersion: draft.value.orderVersion,
        expectedCurrentDeterminationVersion: 1,
      },
      "s2-own-factory-reject-finalize",
    );
    const ownerOne = actor(ids.ownerOne, ["owner_group"], "own_factory:view", "own_factory:approve");
    const ownerTwo = actor(ids.ownerTwo, ["owner_group"], "own_factory:view", "own_factory:approve");
    const before = await ownFactoryApproval.get(ownerOne, order.orderId);
    const approval = before.approval!;
    const results = await Promise.allSettled([
      ownFactoryApproval.reject(
        ownerOne,
        approval.approvalId,
        {
          expectedOrderVersion: before.orderVersion,
          expectedApprovalVersion: approval.approvalVersion,
          opinion: "请重新核对责任比例",
        },
        "s2-own-factory-reject",
      ),
      ownFactoryApproval.approve(
        ownerTwo,
        approval.approvalId,
        {
          expectedOrderVersion: before.orderVersion,
          expectedApprovalVersion: approval.approvalVersion,
        },
        "s2-own-factory-concurrent-approve",
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const current = await ownFactoryApproval.get(ownerOne, order.orderId);
    expect(current.approval!.status).toMatch(/^(approved|rejected)$/);
    if (current.approval!.status === "rejected") {
      expect(current.reworkStatus).toBe("pending_responsibility_determination");
      expect(current.approval!.decision!.opinion).toBe("请重新核对责任比例");
    }
  });

  it("requires a rejection reason, returns to N07, and preserves the rejected approval before a new version", async () => {
    const order = await createReviewedOrder("own-factory-revision");
    const production = actor(
      ids.productionOne,
      ["production_management"],
      "responsibility:determine",
    );
    const draft = await responsibility.saveDraft(
      production,
      order.orderId,
      draftInput(order.orderVersion, order.itemId, ids.productionOne),
      "s2-own-factory-revision-draft",
    );
    await responsibility.finalize(
      production,
      order.orderId,
      {
        expectedOrderVersion: draft.value.orderVersion,
        expectedCurrentDeterminationVersion: 1,
      },
      "s2-own-factory-revision-finalize",
    );
    const owner = actor(ids.ownerOne, ["owner_group"], "own_factory:view", "own_factory:approve");
    const pending = await ownFactoryApproval.get(owner, order.orderId);
    await expect(ownFactoryApproval.reject(
      owner,
      pending.approval!.approvalId,
      {
        expectedOrderVersion: pending.orderVersion,
        expectedApprovalVersion: pending.approval!.approvalVersion,
        opinion: "",
      },
      "s2-own-factory-missing-reason",
    )).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    const rejected = await ownFactoryApproval.reject(
      owner,
      pending.approval!.approvalId,
      {
        expectedOrderVersion: pending.orderVersion,
        expectedApprovalVersion: pending.approval!.approvalVersion,
        opinion: "请重新核实本厂责任范围",
      },
      "s2-own-factory-revision-reject",
    );
    expect(rejected.value).toMatchObject({
      reworkStatus: "pending_responsibility_determination",
      approval: {
        status: "rejected",
        decision: { opinion: "请重新核实本厂责任范围" },
      },
      history: [{ status: "rejected", finalizedDeterminationVersion: 2 }],
    });
    const revised = await responsibility.saveDraft(
      production,
      order.orderId,
      {
        ...draftInput(rejected.value.orderVersion, order.itemId, ids.productionOne),
        expectedCurrentDeterminationVersion: 2,
        reason: "按驳回意见重建责任版本",
      },
      "s2-own-factory-revision-draft-v3",
    );
    expect(revised.value.determination).toMatchObject({ stage: "draft", version: 3 });
    const history = await ownFactoryApproval.get(owner, order.orderId);
    expect(history.history).toHaveLength(1);
    expect(history.history[0]).toMatchObject({ status: "rejected", finalizedDeterminationVersion: 2 });
  });
});
