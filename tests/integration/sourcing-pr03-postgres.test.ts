import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SourcingService } from "../../apps/api/src/sourcing/sourcing-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

runWithPostgres("sourcing PR03-PR04 PostgreSQL business chain", () => {
  const schema = `sourcing_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });
  const service = new SourcingService(database);
  const merchandiserId = randomUUID();
  const ieId = randomUUID();
  const managerId = randomUUID();
  const ownerId = randomUUID();
  const factoryId = randomUUID();

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
  const readerActor = (): TrustedActorContext => ({
    ...merchandiserActor(),
    authorizationCapability: "sourcing:view",
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
    ]) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration}`, import.meta.url),
        "utf8",
      ));
    }
    await database.query(
      `INSERT INTO app_users(id,display_name,enabled) VALUES
       ($1,'订单跟单',true),($2,'IE报价员',true),
       ($3,'生产管理',true),($4,'老板',true)`,
      [merchandiserId, ieId, managerId, ownerId],
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
         VALUES($1,'FAC-01','factory')`,
        [factoryId],
      );
      await database.query(
        `INSERT INTO supplier_catalog_versions(
           supplier_id,version,supplier_name,active,change_reason,changed_by
         ) VALUES($1,1,'一号加工厂',true,'测试夹具',$2)`,
        [factoryId, managerId],
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
      orderQuantity: 137,
    };

    const created = await service.createCase(merchandiserActor(), input, createKey);
    expect(created.reused).toBe(false);
    expect(created.value).toMatchObject({
      erpOrderId: input.erpOrderNo,
      erpOrderNo: input.erpOrderNo,
      styleNo: input.styleNo,
      laneKey: "garment_processing",
      orderQuantity: 137,
      status: "pending_ie_quote",
      version: 1,
      ieQuote: null,
    });

    const replay = await service.createCase(merchandiserActor(), input, createKey);
    expect(replay.reused).toBe(true);
    expect(replay.value.sourcingCaseId).toBe(created.value.sourcingCaseId);
    expect((await database.query("SELECT 1 FROM sourcing_cases")).rowCount).toBe(1);

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
    expect(factories.items).toEqual([{
      supplierId: factoryId,
      supplierCode: "FAC-01",
      supplierName: "一号加工厂",
    }]);

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
      status: "pending_contract",
      version: 6,
      ownerDecision: {
        decision: "approved",
        sourcingDecisionId: revision.value.decision?.sourcingDecisionId,
      },
    });
    expect((await database.query(
      "SELECT 1 FROM sourcing_decisions WHERE sourcing_case_id=$1",
      [created.value.sourcingCaseId],
    )).rowCount).toBe(2);
    expect((await database.query(
      "SELECT 1 FROM sourcing_owner_decisions WHERE sourcing_case_id=$1",
      [created.value.sourcingCaseId],
    )).rowCount).toBe(2);
    expect((await database.query(
      "SELECT 1 FROM sourcing_case_transitions WHERE sourcing_case_id=$1",
      [created.value.sourcingCaseId],
    )).rowCount).toBe(6);

    await expect(service.decideOwner(
      ownerActor(),
      created.value.sourcingCaseId,
      { decision: "approved" },
      randomUUID(),
    )).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      statusCode: 409,
    });
  });
});
