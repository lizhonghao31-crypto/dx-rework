import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SourcingService } from "../../apps/api/src/sourcing/sourcing-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

runWithPostgres("sourcing PR03-PR05 PostgreSQL business chain", () => {
  const schema = `sourcing_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });
  const todoProjection = {
    actionableForAllAssignedRole: vi.fn(async () => [] as string[]),
    cancelOpenByDedupePrefix: vi.fn(async () => 0),
    completeOpenByDedupePrefix: vi.fn(async () => 0),
    information: vi.fn(async () => undefined),
  };
  const service = new SourcingService(database, undefined, undefined, todoProjection);
  const merchandiserId = randomUUID();
  const ieId = randomUUID();
  const managerId = randomUUID();
  const ownerId = randomUUID();
  const financeId = randomUUID();
  const factoryId = randomUUID();
  const replacementFactoryId = randomUUID();
  const evidenceId = randomUUID();

  const merchandiserActor = (requestId = randomUUID()): TrustedActorContext => ({
    actorId: merchandiserId,
    actorRoles: ["order_merchandiser"],
    authorizationCapability: "sourcing:inquiry:create",
    authorizationCapabilities: ["sourcing:view", "sourcing:inquiry:create"],
    requestId,
  });
  const ieActor = (requestId = randomUUID()): TrustedActorContext => ({
    actorId: ieId,
    actorRoles: ["ie_reviewer"],
    authorizationCapability: "sourcing:price:quote",
    authorizationCapabilities: ["sourcing:view", "sourcing:price:quote"],
    requestId,
  });
  const managerActor = (requestId = randomUUID()): TrustedActorContext => ({
    actorId: managerId,
    actorRoles: ["production_management"],
    authorizationCapability: "sourcing:decision:record",
    authorizationCapabilities: ["sourcing:view", "sourcing:decision:record"],
    requestId,
  });
  const ownerActor = (requestId = randomUUID()): TrustedActorContext => ({
    actorId: ownerId,
    actorRoles: ["owner_group"],
    authorizationCapability: "sourcing:owner:approve",
    authorizationCapabilities: ["sourcing:view", "sourcing:owner:approve"],
    requestId,
  });
  const factoryChangeActor = (requestId = randomUUID()): TrustedActorContext => ({
    ...merchandiserActor(requestId),
    authorizationCapability: "sourcing:factory_change:request",
    authorizationCapabilities: ["sourcing:view", "sourcing:factory_change:request"],
  });
  const factoryChangeVerifier = (requestId = randomUUID()): TrustedActorContext => ({
    ...managerActor(requestId),
    authorizationCapability: "sourcing:factory_change:verify",
    authorizationCapabilities: ["sourcing:view", "sourcing:factory_change:verify"],
  });
  const financeActor = (requestId = randomUUID()): TrustedActorContext => ({
    actorId: financeId,
    actorRoles: ["factory_payables"],
    authorizationCapability: "sourcing:finance:reconcile",
    authorizationCapabilities: ["sourcing:view", "sourcing:finance:reconcile"],
    requestId,
  });
  const exceptionVerifier = (requestId = randomUUID()): TrustedActorContext => ({
    ...managerActor(requestId),
    authorizationCapability: "sourcing:exception:verify",
    authorizationCapabilities: ["sourcing:view", "sourcing:exception:verify"],
  });
  const readerActor = (): TrustedActorContext => ({
    ...merchandiserActor(),
    authorizationCapability: "sourcing:view",
  });
  const rootActor = (requestId = randomUUID()): TrustedActorContext => ({
    actorId: merchandiserId,
    actorRoles: ["root_superuser"],
    authorizationCapability: "sourcing:delete",
    authorizationCapabilities: ["sourcing:view", "sourcing:delete"],
    requestId,
  });

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const migration of [
      "0001_platform_foundation.sql",
      "0002_dingtalk_identity_access.sql",
      "0003_identity_union_continuity.sql",
      "0004_public_tools_foundation.sql",
      "0005_access_master_data.sql",
    ]) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration}`, import.meta.url),
        "utf8",
      ));
    }
    await database.query(`
      DROP TRIGGER business_roles_no_insert ON business_roles;
      INSERT INTO business_roles(role_code,display_name,description)
      VALUES('finance_director','财务总监','报价选厂测试所需既有角色')
      ON CONFLICT DO NOTHING;
      CREATE TRIGGER business_roles_no_insert
        BEFORE INSERT ON business_roles FOR EACH ROW
        EXECUTE FUNCTION reject_operation_event_mutation();
    `);
    for (const migration of [
      "0096_sourcing_view_capability.sql",
      "0097_sourcing_foundation.sql",
      "0102_sourcing_ie_view_grant.sql",
      "0108_sourcing_finance_closure.sql",
      "0120_sourcing_order_facts.sql",
      "0121_sourcing_remove_contract_stage.sql",
      "0122_sourcing_case_logical_deletion.sql",
      "0123_sourcing_explicit_role_todos.sql",
      "0124_sourcing_ordered_processes.sql",
      "0125_sourcing_image_supplement.sql",
      "0126_sourcing_finance_readonly_reconciliation.sql",
      "0127_sourcing_factory_change_auxiliary.sql",
    ]) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration}`, import.meta.url),
        "utf8",
      ));
    }
    await database.query(
      `INSERT INTO app_users(id,display_name,enabled) VALUES
       ($1,'订单跟单',true),($2,'IE报价员',true),
       ($3,'生产管理',true),($4,'老板',true),($5,'应付财务',true)`,
      [merchandiserId, ieId, managerId, ownerId, financeId],
    );
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,
         uploaded_by,status,ready_at
       ) VALUES($1,$2,'款式照片.jpg','image/jpeg',128,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [evidenceId, `sourcing-test/${evidenceId}.jpg`, "a".repeat(64), merchandiserId],
    );
    await database.query(`
      ALTER TABLE supplier_catalog_items
        DISABLE TRIGGER supplier_catalog_items_require_initial_version
    `);
    await database.query(`
      ALTER TABLE supplier_catalog_versions
        DISABLE TRIGGER supplier_catalog_versions_guard_creation
    `);
    try {
      await database.query(
        `INSERT INTO supplier_catalog_items(supplier_id,supplier_code,supplier_type)
         VALUES($1,'FAC-01','factory'),($2,'FAC-02','factory')`,
        [factoryId, replacementFactoryId],
      );
      await database.query(
        `INSERT INTO supplier_catalog_versions(
           supplier_id,version,supplier_name,active,change_reason,changed_by
         ) VALUES
           ($1,1,'一号加工厂',true,'测试夹具',$3),
           ($2,1,'二号加工厂',true,'测试夹具',$3)`,
        [factoryId, replacementFactoryId, managerId],
      );
    } finally {
      await database.query(`
        ALTER TABLE supplier_catalog_versions
          ENABLE TRIGGER supplier_catalog_versions_guard_creation
      `);
      await database.query(`
        ALTER TABLE supplier_catalog_items
          ENABLE TRIGGER supplier_catalog_items_require_initial_version
      `);
    }
  });

  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("creates once, records an exact IE quote and advances the audited state", async () => {
    const createKey = randomUUID();
    const input = {
      erpOrderNo: "ERP-20260826-001",
      styleNo: "DX-260826",
      deliveryDate: "2026-09-15",
      processes: ["净色车缝", "整烫", "按样衣复核"],
      orderQuantity: 137,
      attachmentIds: [evidenceId],
    };

    const created = await service.createCase(merchandiserActor(), input, createKey);
    expect(created.reused).toBe(false);
    expect(created.value).toMatchObject({
      erpOrderId: input.erpOrderNo,
      erpOrderNo: input.erpOrderNo,
      styleNo: input.styleNo,
      laneKey: "garment_processing",
      orderQuantity: 137,
      deliveryDate: "2026-09-15",
      processDescription: "净色车缝、整烫、按样衣复核",
      processes: ["净色车缝", "整烫", "按样衣复核"],
      status: "pending_ie_quote",
      version: 1,
      ieQuote: null,
    });

    const replay = await service.createCase(merchandiserActor(), input, createKey);
    expect(replay.reused).toBe(true);
    expect(replay.value.sourcingCaseId).toBe(created.value.sourcingCaseId);
    expect((await database.query("SELECT 1 FROM sourcing_cases")).rowCount).toBe(1);
    expect((await database.query(
      "SELECT 1 FROM attachments WHERE attachment_id=$1 AND entity_type='sourcing_case' AND entity_id=$2",
      [evidenceId, created.value.sourcingCaseId],
    )).rowCount).toBe(1);
    expect(await service.listAttachments(readerActor(), created.value.sourcingCaseId)).toEqual({
      items: [{ attachmentId: evidenceId, filename: "款式照片.jpg", mimeType: "image/jpeg" }],
    });

    const quoteKey = randomUUID();
    const quoted = await service.quoteIePrice(
      ieActor(),
      created.value.sourcingCaseId,
      { unitPrice: "10.8136", quoteReason: "IE核定加工难度与标准工时" },
      quoteKey,
    );
    expect(quoted.reused).toBe(false);
    expect(quoted.value).toMatchObject({
      status: "pending_management_decision",
      version: 2,
      orderQuantity: 137,
      ieQuote: {
        quoteVersion: 1,
        unitPrice: "10.8136",
        quantity: 137,
        totalAmount: "1481.46",
        quoteReason: "IE核定加工难度与标准工时",
        quotedBy: ieId,
      },
    });

    const quoteReplay = await service.quoteIePrice(
      ieActor(),
      created.value.sourcingCaseId,
      { unitPrice: "10.8136", quoteReason: "IE核定加工难度与标准工时" },
      quoteKey,
    );
    expect(quoteReplay.reused).toBe(true);
    expect(quoteReplay.value.ieQuote?.sourcingIeQuoteId)
      .toBe(quoted.value.ieQuote?.sourcingIeQuoteId);

    const listed = await service.listCases(readerActor(), "260826");
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.sourcingCaseId).toBe(created.value.sourcingCaseId);
    expect((await service.listCases(readerActor(), "订单跟单")).items).toHaveLength(1);
    expect((await service.listCases(readerActor(), "整烫")).items).toHaveLength(1);

    expect((await database.query(
      "SELECT 1 FROM sourcing_ie_quotes WHERE sourcing_case_id=$1",
      [created.value.sourcingCaseId],
    )).rowCount).toBe(1);
    expect((await database.query(
      "SELECT 1 FROM sourcing_case_transitions WHERE sourcing_case_id=$1",
      [created.value.sourcingCaseId],
    )).rowCount).toBe(2);
    expect((await database.query(
      "SELECT 1 FROM operation_events WHERE entity_type='sourcing_case' AND entity_id=$1",
      [created.value.sourcingCaseId],
    )).rowCount).toBe(2);

    await expect(service.quoteIePrice(
      ieActor(),
      created.value.sourcingCaseId,
      { unitPrice: "11.0000" },
      randomUUID(),
    )).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      statusCode: 409,
    });

    const factories = await service.listFactories({
      ...managerActor(),
      authorizationCapability: "sourcing:view",
    });
    expect(factories.items).toEqual([
      {
        supplierId: factoryId,
        supplierCode: "FAC-01",
        supplierName: "一号加工厂",
      },
      {
        supplierId: replacementFactoryId,
        supplierCode: "FAC-02",
        supplierName: "二号加工厂",
      },
    ]);

    await expect(service.recordManagementDecision(
      managerActor(),
      created.value.sourcingCaseId,
      {
        supplierId: factoryId,
        unitPrice: "11.0000",
      },
      randomUUID(),
    )).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });

    const firstDecision = await service.recordManagementDecision(
      managerActor(),
      created.value.sourcingCaseId,
      {
        supplierId: factoryId,
        unitPrice: "11.0000",
        decisionReason: "结合产能与交期调整",
      },
      randomUUID(),
    );
    expect(firstDecision.value).toMatchObject({
      status: "pending_owner_approval",
      version: 3,
      decision: {
        decisionVersion: 1,
        sourceType: "initial",
        supplierId: factoryId,
        supplierName: "一号加工厂",
        unitPrice: "11.0000",
        quantity: 137,
        totalAmount: "1507.00",
      },
      ownerDecision: null,
    });
    expect((await service.listCases(readerActor(), "一号加工厂")).items).toHaveLength(1);
    expect((await service.listCases(readerActor(), "FAC-01")).items).toHaveLength(1);

    const rejected = await service.decideOwner(
      ownerActor(),
      created.value.sourcingCaseId,
      { decision: "rejected", decisionReason: "价格偏高，请重新核对" },
      randomUUID(),
    );
    expect(rejected.value).toMatchObject({
      status: "pending_management_decision",
      version: 4,
      ownerDecision: {
        decision: "rejected",
        decisionReason: "价格偏高，请重新核对",
      },
    });

    const revision = await service.recordManagementDecision(
      managerActor(),
      created.value.sourcingCaseId,
      {
        supplierId: factoryId,
        unitPrice: "10.8136",
        decisionReason: "按老板意见恢复 IE 核价",
      },
      randomUUID(),
    );
    expect(revision.value).toMatchObject({
      status: "pending_owner_approval",
      version: 5,
      decision: {
        decisionVersion: 2,
        sourceType: "management_revision",
        supersedesDecisionId: firstDecision.value.decision?.sourcingDecisionId,
        totalAmount: "1481.46",
      },
      ownerDecision: null,
    });

    const approved = await service.decideOwner(
      ownerActor(),
      created.value.sourcingCaseId,
      { decision: "approved" },
      randomUUID(),
    );
    expect(approved.value).toMatchObject({
      status: "pending_finance_reconciliation",
      version: 6,
      ownerDecision: {
        decision: "approved",
        sourcingDecisionId: revision.value.decision?.sourcingDecisionId,
      },
    });
    const changeRequest = await service.requestFactoryChange(
      factoryChangeActor(),
      created.value.sourcingCaseId,
      {
        supplierId: replacementFactoryId,
        unitPrice: "10.5000",
        changeReason: "一号加工厂排期冲突，申请转二号加工厂",
      },
      randomUUID(),
    );
    expect(changeRequest.value).toMatchObject({
      status: "pending_finance_reconciliation",
      version: 6,
    });
    expect((await service.getCurrentFactoryChange(
      readerActor(),
      created.value.sourcingCaseId,
    )).item).toMatchObject({
      initiatorRole: "order_merchandiser",
      status: "pending_management",
      requiresOwnerApproval: false,
    });
    const requestedChange = (await service.listTimeline(
      readerActor(),
      created.value.sourcingCaseId,
    )).items.reverse().find((entry) => entry.kind === "factory_change_request");
    expect(requestedChange).toMatchObject({
      supplierName: "二号加工厂",
      unitPrice: "10.5000",
      totalAmount: "1438.50",
    });

    const changeApproved = await service.decideFactoryChange(
      factoryChangeVerifier(),
      created.value.sourcingCaseId,
      requestedChange!.entryId,
      { decision: "approved", verificationReason: "已核实二号加工厂产能与交期" },
      randomUUID(),
    );
    expect(changeApproved.value).toMatchObject({
      status: "pending_finance_reconciliation",
      version: 6,
      decision: {
        decisionVersion: 3,
        sourceType: "factory_change",
        supplierId: replacementFactoryId,
        supplierName: "二号加工厂",
        unitPrice: "10.5000",
        totalAmount: "1438.50",
      },
    });
    expect(changeApproved.value.ownerDecision).toBeNull();

    await service.requestFactoryChange(
      factoryChangeActor(),
      created.value.sourcingCaseId,
      {
        supplierId: factoryId,
        unitPrice: "10.7000",
        changeReason: "测试第二次换厂驳回历史",
      },
      randomUUID(),
    );
    const latestRequest = (await service.listTimeline(
      readerActor(),
      created.value.sourcingCaseId,
    )).items.findLast((entry) => entry.kind === "factory_change_request");
    expect(latestRequest?.entryId).not.toBe(requestedChange?.entryId);
    const changeRejected = await service.decideFactoryChange(
      factoryChangeVerifier(),
      created.value.sourcingCaseId,
      latestRequest!.entryId,
      { decision: "rejected", verificationReason: "原厂排期仍不满足，不同意回切" },
      randomUUID(),
    );
    expect(changeRejected.value).toMatchObject({
      status: "pending_finance_reconciliation",
      version: 6,
      decision: {
        decisionVersion: 3,
        supplierId: replacementFactoryId,
      },
    });

    const financeDifference = await service.recordFinanceReconciliation(
      financeActor(),
      created.value.sourcingCaseId,
      {
        result: "difference",
        differenceFields: ["total_amount"],
        differenceReason: "发票总额与已批准选厂决定不一致",
      },
      randomUUID(),
    );
    expect(financeDifference.value).toMatchObject({
      status: "pending_exception_verification",
      version: 7,
    });
    expect((await database.query<{
      result: string;
      difference_fields: string[];
      actual_supplier_name_snapshot: string;
    }>(
      `SELECT result,difference_fields,actual_supplier_name_snapshot
       FROM sourcing_finance_reconciliations
       WHERE sourcing_case_id=$1 AND reconciliation_version=1`,
      [created.value.sourcingCaseId],
    )).rows[0]).toEqual({
      result: "difference",
      difference_fields: ["total_amount"],
      actual_supplier_name_snapshot: "二号加工厂",
    });

    const reopened = await service.decideException(
      exceptionVerifier(),
      created.value.sourcingCaseId,
      { resolution: "reconcile_again", resolutionReason: "请财务按已批准金额重新核对" },
      randomUUID(),
    );
    expect(reopened.value).toMatchObject({
      status: "pending_finance_reconciliation",
      version: 8,
    });

    const financeMatched = await service.recordFinanceReconciliation(
      financeActor(),
      created.value.sourcingCaseId,
      { result: "match" },
      randomUUID(),
    );
    expect(financeMatched.value).toMatchObject({ status: "closed", version: 9 });

    expect((await database.query(
      "SELECT 1 FROM sourcing_decisions WHERE sourcing_case_id=$1",
      [created.value.sourcingCaseId],
    )).rowCount).toBe(3);
    expect((await database.query(
      "SELECT 1 FROM sourcing_owner_decisions WHERE sourcing_case_id=$1",
      [created.value.sourcingCaseId],
    )).rowCount).toBe(2);
    const timeline = await service.listTimeline(readerActor(), created.value.sourcingCaseId);
    expect(timeline.items.filter((entry) => entry.kind === "contract")).toHaveLength(0);
    expect(timeline.items.filter((entry) => entry.kind === "factory_change_request")).toHaveLength(2);
    expect(timeline.items.filter((entry) => entry.kind === "factory_change_verification"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ decision: "approved" }),
        expect.objectContaining({ decision: "rejected" }),
      ]));
    expect(timeline.items.filter((entry) => entry.kind === "finance_reconciliation"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          version: 1,
          result: "difference",
          differenceFields: ["total_amount"],
          totalAmount: "1438.50",
        }),
        expect.objectContaining({ version: 2, result: "match", totalAmount: "1438.50" }),
      ]));
    expect(timeline.items.filter((entry) => entry.kind === "exception_verification"))
      .toEqual([expect.objectContaining({ resolution: "reconcile_again" })]);
    expect(timeline.items.find((entry) => entry.kind === "ie_quote")).toMatchObject({
      unitPrice: "10.8136",
      totalAmount: "1481.46",
    });
    expect(timeline.items.filter((entry) => entry.kind === "management_decision")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unitPrice: "11.0000", supplierName: "一号加工厂" }),
        expect.objectContaining({ unitPrice: "10.8136", supplierName: "一号加工厂" }),
      ]),
    );
    expect((await database.query(
      "SELECT 1 FROM sourcing_case_transitions WHERE sourcing_case_id=$1",
      [created.value.sourcingCaseId],
    )).rowCount).toBe(9);

    await expect(service.decideOwner(
      ownerActor(),
      created.value.sourcingCaseId,
      { decision: "approved" },
      randomUUID(),
    )).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      statusCode: 409,
    });

    expect(todoProjection.actionableForAllAssignedRole.mock.calls.map((call) => call[2].category))
      .toEqual([
        "sourcing_ie_quote",
        "sourcing_management_decision",
        "sourcing_owner_approval",
        "sourcing_management_decision",
        "sourcing_owner_approval",
        "sourcing_finance_reconcile",
        "sourcing_factory_change_verify",
        "sourcing_finance_reconcile",
        "sourcing_factory_change_verify",
        "sourcing_finance_reconcile",
        "sourcing_exception_verify",
        "sourcing_finance_reconcile",
      ]);
    expect(todoProjection.information).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        category: "sourcing_factory_change_notice",
        recipientUserId: ownerId,
        sourceAction: "sourcing.factory_change.approved",
      }),
    );
    expect(todoProjection.completeOpenByDedupePrefix.mock.calls.map((call) => call[2]))
      .toEqual([
        `sourcing:${created.value.sourcingCaseId}:ie_quote:1:`,
        `sourcing:${created.value.sourcingCaseId}:management:1:`,
        `sourcing:${created.value.sourcingCaseId}:owner:1:`,
        `sourcing:${created.value.sourcingCaseId}:management:2:`,
        `sourcing:${created.value.sourcingCaseId}:owner:2:`,
        `sourcing:${created.value.sourcingCaseId}:finance:2:1:`,
        `sourcing:${created.value.sourcingCaseId}:factory_change:${requestedChange!.entryId}:`,
        `sourcing:${created.value.sourcingCaseId}:finance:3:1:`,
        `sourcing:${created.value.sourcingCaseId}:factory_change:${latestRequest!.entryId}:`,
        `sourcing:${created.value.sourcingCaseId}:finance:3:1:`,
        `sourcing:${created.value.sourcingCaseId}:exception:1:`,
        `sourcing:${created.value.sourcingCaseId}:finance:3:2:`,
      ]);
  });

  it("enforces every factory-change initiator, price threshold and unlock boundary", async () => {
    let serial = 0;
    const openAtFirstDecision = async (label: string) => {
      serial += 1;
      const created = await service.createCase(merchandiserActor(), {
        erpOrderNo: "ERP-TRANSFER-" + label + "-" + serial,
        styleNo: "TRANSFER-" + label + "-" + serial,
        deliveryDate: "2026-10-20",
        processes: ["车缝", "整烫"],
        orderQuantity: 100,
      }, randomUUID());
      await service.quoteIePrice(
        ieActor(),
        created.value.sourcingCaseId,
        { unitPrice: "10.0000", quoteReason: "转厂链路测试" },
        randomUUID(),
      );
      await service.recordManagementDecision(
        managerActor(),
        created.value.sourcingCaseId,
        {
          supplierId: factoryId,
          unitPrice: "10.0000",
          decisionReason: "首次确认加工厂和生产单价",
        },
        randomUUID(),
      );
      return created.value.sourcingCaseId;
    };

    const locked = await service.createCase(merchandiserActor(), {
      erpOrderNo: "ERP-TRANSFER-LOCKED",
      styleNo: "TRANSFER-LOCKED",
      deliveryDate: "2026-10-20",
      processes: ["车缝"],
      orderQuantity: 100,
    }, randomUUID());
    await expect(service.requestFactoryChange(
      ownerActor(),
      locked.value.sourcingCaseId,
      {
        supplierId: replacementFactoryId,
        unitPrice: "9.5000",
        changeReason: "首次选厂前不允许转厂",
      },
      randomUUID(),
    )).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      statusCode: 409,
    });

    const managementLowCaseId = await openAtFirstDecision("MANAGEMENT-LOW");
    const managementLow = await service.requestFactoryChange(
      managerActor(),
      managementLowCaseId,
      {
        supplierId: replacementFactoryId,
        unitPrice: "9.5000",
        changeReason: "生产管理发起低价转厂",
      },
      randomUUID(),
    );
    expect(managementLow.value).toMatchObject({
      status: "pending_owner_approval",
      version: 3,
      decision: {
        decisionVersion: 2,
        sourceType: "factory_change",
        supplierId: replacementFactoryId,
        unitPrice: "9.5000",
      },
    });
    expect((await service.getCurrentFactoryChange(
      readerActor(),
      managementLowCaseId,
    )).item).toMatchObject({
      initiatorRole: "production_management",
      requiresOwnerApproval: false,
      status: "effective",
    });
    expect((await database.query(
      "SELECT 1 FROM sourcing_case_transitions WHERE sourcing_case_id=$1",
      [managementLowCaseId],
    )).rowCount).toBe(3);

    const managementHighCaseId = await openAtFirstDecision("MANAGEMENT-HIGH");
    const managementHigh = await service.requestFactoryChange(
      managerActor(),
      managementHighCaseId,
      {
        supplierId: replacementFactoryId,
        unitPrice: "10.5000",
        changeReason: "生产管理发起高价转厂",
      },
      randomUUID(),
    );
    expect(managementHigh.value).toMatchObject({
      status: "pending_owner_approval",
      version: 3,
      decision: {
        decisionVersion: 1,
        supplierId: factoryId,
      },
    });
    const managementHighState = await service.getCurrentFactoryChange(
      readerActor(),
      managementHighCaseId,
    );
    expect(managementHighState.item).toMatchObject({
      initiatorRole: "production_management",
      requiresOwnerApproval: true,
      status: "pending_owner",
    });
    const managementHighApproved = await service.decideFactoryChange(
      ownerActor(),
      managementHighCaseId,
      managementHighState.item!.factoryChangeRequestId,
      { decision: "approved", verificationReason: "老板批准高价转厂" },
      randomUUID(),
    );
    expect(managementHighApproved.value).toMatchObject({
      status: "pending_finance_reconciliation",
      version: 4,
      decision: {
        decisionVersion: 2,
        supplierId: replacementFactoryId,
        unitPrice: "10.5000",
      },
    });

    const ownerCaseId = await openAtFirstDecision("OWNER");
    const ownerDirect = await service.requestFactoryChange(
      ownerActor(),
      ownerCaseId,
      {
        supplierId: replacementFactoryId,
        unitPrice: "12.0000",
        changeReason: "老板直接决定转厂",
      },
      randomUUID(),
    );
    expect(ownerDirect.value).toMatchObject({
      status: "pending_finance_reconciliation",
      version: 4,
      decision: {
        decisionVersion: 2,
        supplierId: replacementFactoryId,
        unitPrice: "12.0000",
      },
    });
    expect((await service.getCurrentFactoryChange(
      readerActor(),
      ownerCaseId,
    )).item).toMatchObject({
      initiatorRole: "owner_group",
      requiresOwnerApproval: true,
      status: "effective",
    });

    const merchCaseId = await openAtFirstDecision("MERCH-HIGH");
    const merchRequested = await service.requestFactoryChange(
      factoryChangeActor(),
      merchCaseId,
      {
        supplierId: replacementFactoryId,
        unitPrice: "10.7500",
        changeReason: "跟单发起高价转厂",
      },
      randomUUID(),
    );
    expect(merchRequested.value).toMatchObject({
      status: "pending_owner_approval",
      version: 3,
    });
    const merchPendingManagement = await service.getCurrentFactoryChange(
      readerActor(),
      merchCaseId,
    );
    expect(merchPendingManagement.item).toMatchObject({
      initiatorRole: "order_merchandiser",
      requiresOwnerApproval: true,
      status: "pending_management",
    });
    await expect(service.recordFinanceReconciliation(
      financeActor(),
      merchCaseId,
      { result: "match" },
      randomUUID(),
    )).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      statusCode: 409,
      message: "订单转厂审批中，财务暂不能核对",
    });
    await expect(service.requestFactoryChange(
      financeActor(),
      merchCaseId,
      {
        supplierId: replacementFactoryId,
        unitPrice: "9.0000",
        changeReason: "财务无权发起转厂",
      },
      randomUUID(),
    )).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });
    await service.decideFactoryChange(
      factoryChangeVerifier(),
      merchCaseId,
      merchPendingManagement.item!.factoryChangeRequestId,
      { decision: "approved", verificationReason: "生产管理批准转厂方案" },
      randomUUID(),
    );
    expect((await service.getCurrentFactoryChange(
      readerActor(),
      merchCaseId,
    )).item).toMatchObject({ status: "pending_owner" });
    const merchApproved = await service.decideFactoryChange(
      ownerActor(),
      merchCaseId,
      merchPendingManagement.item!.factoryChangeRequestId,
      { decision: "approved", verificationReason: "老板批准高价方案" },
      randomUUID(),
    );
    expect(merchApproved.value).toMatchObject({
      status: "pending_finance_reconciliation",
      version: 4,
      decision: {
        decisionVersion: 2,
        supplierId: replacementFactoryId,
        unitPrice: "10.7500",
      },
    });

    const rejectedCaseId = await openAtFirstDecision("OWNER-REJECT");
    await service.requestFactoryChange(
      managerActor(),
      rejectedCaseId,
      {
        supplierId: replacementFactoryId,
        unitPrice: "11.0000",
        changeReason: "生产管理申请高价转厂后测试驳回",
      },
      randomUUID(),
    );
    const rejectedState = await service.getCurrentFactoryChange(readerActor(), rejectedCaseId);
    const ownerRejected = await service.decideFactoryChange(
      ownerActor(),
      rejectedCaseId,
      rejectedState.item!.factoryChangeRequestId,
      { decision: "rejected", verificationReason: "老板驳回高价转厂" },
      randomUUID(),
    );
    expect(ownerRejected.value).toMatchObject({
      status: "pending_owner_approval",
      version: 3,
      decision: {
        decisionVersion: 1,
        supplierId: factoryId,
      },
    });
    await expect(service.requestFactoryChange(
      managerActor(),
      rejectedCaseId,
      {
        supplierId: replacementFactoryId,
        unitPrice: "9.8000",
        changeReason: "驳回后重新发起低价转厂",
      },
      randomUUID(),
    )).resolves.toMatchObject({
      value: {
        decision: {
          decisionVersion: 2,
          supplierId: replacementFactoryId,
        },
      },
    });
  });

  it("lets only Root logically delete without losing evidence or blocking ERP reuse", async () => {
    const legacyProcessDescription = "旧".repeat(500);
    const attachmentId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,
         uploaded_by,status,ready_at
       ) VALUES($1,$2,'待删除测试订单.jpg','image/jpeg',128,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [attachmentId, `sourcing-test/${attachmentId}.jpg`, "b".repeat(64), merchandiserId],
    );
    const created = await service.createCase(merchandiserActor(), {
      erpOrderNo: "ERP-DELETE-1",
      styleNo: "DELETE-STYLE-1",
      deliveryDate: "2026-10-01",
      processDescription: legacyProcessDescription,
      orderQuantity: 88,
      attachmentIds: [attachmentId],
    }, randomUUID());
    expect(created.value).toMatchObject({
      processDescription: legacyProcessDescription,
      processes: [legacyProcessDescription],
    });

    await expect(service.deleteByRoot(
      merchandiserActor(),
      created.value.sourcingCaseId,
      randomUUID(),
    )).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    const key = randomUUID();
    const deleted = await service.deleteByRoot(rootActor(), created.value.sourcingCaseId, key);
    const replay = await service.deleteByRoot(rootActor(), created.value.sourcingCaseId, key);
    expect(deleted).toEqual({
      value: { sourcingCaseId: created.value.sourcingCaseId, deleted: true },
      reused: false,
    });
    expect(replay).toEqual({
      value: { sourcingCaseId: created.value.sourcingCaseId, deleted: true },
      reused: true,
    });

    expect((await service.listCases(readerActor(), "ERP-DELETE-1")).items).toHaveLength(0);
    await expect(service.getCase(readerActor(), created.value.sourcingCaseId))
      .rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    await expect(service.listAttachments(readerActor(), created.value.sourcingCaseId))
      .rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    await expect(service.listTimeline(readerActor(), created.value.sourcingCaseId))
      .rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    await expect(service.quoteIePrice(
      ieActor(),
      created.value.sourcingCaseId,
      { unitPrice: "4.5" },
      randomUUID(),
    )).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });

    expect(todoProjection.cancelOpenByDedupePrefix).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorRoles: ["root_superuser"] }),
      `sourcing:${created.value.sourcingCaseId}:`,
      "The sourcing case was deleted by root",
    );
    await expect(database.query(
      "UPDATE sourcing_cases SET style_no='tampered' WHERE sourcing_case_id=$1",
      [created.value.sourcingCaseId],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      `SELECT deleted_at,deleted_by,deletion_operation_event_id
       FROM sourcing_cases WHERE sourcing_case_id=$1`,
      [created.value.sourcingCaseId],
    )).resolves.toMatchObject({
      rows: [{
        deleted_at: expect.any(Date),
        deleted_by: merchandiserId,
        deletion_operation_event_id: expect.any(String),
      }],
    });
    await expect(database.query(
      `SELECT entity_type,entity_id,status
       FROM attachments WHERE attachment_id=$1`,
      [attachmentId],
    )).resolves.toMatchObject({
      rows: [{
        entity_type: "sourcing_case",
        entity_id: created.value.sourcingCaseId,
        status: "ready",
      }],
    });
    await expect(database.query(
      `SELECT action,authorization_capability
       FROM operation_events
       WHERE entity_type='sourcing_case' AND entity_id=$1
       ORDER BY created_at DESC,event_id DESC LIMIT 1`,
      [created.value.sourcingCaseId],
    )).resolves.toMatchObject({
      rows: [{ action: "sourcing.case.delete", authorization_capability: "sourcing:delete" }],
    });

    const replacement = await service.createCase(merchandiserActor(), {
      erpOrderNo: "ERP-DELETE-1",
      styleNo: "DELETE-STYLE-2",
      deliveryDate: "2026-10-02",
      processDescription: "重建订单工艺",
      orderQuantity: 99,
    }, randomUUID());
    expect(replacement.value.sourcingCaseId).not.toBe(created.value.sourcingCaseId);
    expect((await service.listCases(readerActor(), "ERP-DELETE-1")).items)
      .toEqual([expect.objectContaining({ sourcingCaseId: replacement.value.sourcingCaseId })]);
    expect((await database.query(
      "SELECT 1 FROM sourcing_cases WHERE erp_order_id='ERP-DELETE-1'",
    )).rowCount).toBe(2);
  });
});
