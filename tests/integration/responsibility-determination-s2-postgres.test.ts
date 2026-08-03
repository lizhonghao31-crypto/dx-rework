import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { AuthorizedResponsibilityDeterminationService } from "../../apps/api/src/rework/responsibility-determination-authorized-service.js";
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
] as const;

type ReviewedOrder = { orderId: string; itemId: string; orderVersion: number };

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

  async function createReviewedOrder(label: string): Promise<ReviewedOrder> {
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
        items: [{
          source: "custom",
          customProcessName: "S2 process " + label,
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
    const itemId = approved.value.configuration!.items[0]!.configurationItemId;
    const task = await reporting.createTask(
      actor(ids.tail, ["tail_supervisor"], "work:assign"),
      created.value.reworkOrderId,
      {
        expectedOrderVersion: approved.value.orderVersion,
        configurationItemId: itemId,
        mode: "individual",
        members: [{ personId: workerPersonId }],
      },
      randomUUID(),
    );
    const listed = await reporting.list(
      actor(ids.tail, ["tail_supervisor"], "work:assign"),
      created.value.reworkOrderId,
    );
    await reporting.submitReport(
      actor(ids.worker, ["worker"], "work:report"),
      task.value.workTaskId,
      {
        expectedOrderVersion: listed.orderVersion,
        actualQuantity: 1,
        completedAt: new Date().toISOString(),
      },
      randomUUID(),
    );
    const view = await review.get(
      actor(ids.tail, ["tail_supervisor"], "submission:audit"),
      created.value.reworkOrderId,
    );
    const reviewed = await review.approve(
      actor(ids.tail, ["tail_supervisor"], "submission:audit"),
      created.value.reworkOrderId,
      { expectedOrderVersion: view.orderVersion },
      randomUUID(),
    );
    return { orderId: created.value.reworkOrderId, itemId, orderVersion: reviewed.value.orderVersion };
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
      reworkStatus: "pending_responsibility_action",
      handlerUserId: ids.ownerOne,
      determination: { version: 2, stage: "finalized" },
    });
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

  it("requires a different direct owner and exact snapshot for high multipliers", async () => {
    const order = await createReviewedOrder("high");
    const submitter = actor(
      ids.ownerOne,
      ["owner_group"],
      "responsibility:determine",
      "responsibility:takeover",
      "responsibility:confirm_high_multiplier",
    );
    const draft = await responsibility.saveDraft(
      submitter,
      order.orderId,
      draftInput(order.orderVersion, order.itemId, ids.ownerOne, "2.500", "特殊质量事故"),
      "s2-high-draft",
    );
    const determinationId = draft.value.determination!.determinationId;
    await expect(responsibility.confirmHighMultiplier(
      submitter,
      determinationId,
      {
        expectedOrderVersion: draft.value.orderVersion,
        expectedCurrentDeterminationVersion: 1,
        reason: "本人确认",
      },
      "s2-self-confirm",
    )).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    const confirmer = actor(
      ids.ownerTwo,
      ["owner_group"],
      "responsibility:confirm_high_multiplier",
    );
    const confirmed = await responsibility.confirmHighMultiplier(
      confirmer,
      determinationId,
      {
        expectedOrderVersion: draft.value.orderVersion,
        expectedCurrentDeterminationVersion: 1,
        reason: "第二位老板复核",
      },
      "s2-owner-confirm",
    );
    expect(confirmed.value).toMatchObject({
      orderVersion: draft.value.orderVersion + 1,
      canConfirmHighMultiplier: false,
      determination: { highMultiplierConfirmed: true },
    });
    const stored = await database.query<{
      confirmed_by: string;
      confirmation_snapshot: {
        determinationId: string;
        determinationVersion: number;
        submittedBy: string;
        handlerUserId: string;
        processes: Array<{
          configurationItemId: string;
          multiplier: string;
          highMultiplierReason: string;
        }>;
      };
    }>(
      `SELECT confirmed_by,confirmation_snapshot
       FROM rework_responsibility_high_multiplier_confirmations
       WHERE determination_id=$1`,
      [determinationId],
    );
    expect(stored.rows[0]).toEqual({
      confirmed_by: ids.ownerTwo,
      confirmation_snapshot: {
        determinationId,
        determinationVersion: 1,
        submittedBy: ids.ownerOne,
        handlerUserId: ids.ownerOne,
        processes: [{
          configurationItemId: order.itemId,
          multiplier: "2.500",
          highMultiplierReason: "特殊质量事故",
        }],
      },
    });
    const finalized = await responsibility.finalize(
      submitter,
      order.orderId,
      {
        expectedOrderVersion: confirmed.value.orderVersion,
        expectedCurrentDeterminationVersion: 1,
      },
      "s2-high-finalize",
    );
    expect(finalized.value).toMatchObject({
      reworkStatus: "pending_responsibility_action",
      handlerUserId: ids.ownerOne,
      determination: { stage: "finalized", version: 2 },
    });
  });
});
