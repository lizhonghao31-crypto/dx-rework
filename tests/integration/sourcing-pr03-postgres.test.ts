import "./work-analysis-postgres.cases.js";
import { readQuoteAnalysis } from "../../apps/api/src/sourcing/sourcing-analysis.js";
import { ProductionDashboardService } from "../../apps/api/src/sourcing/production-dashboard-service.js";
import { ProductionReportingService } from "../../apps/api/src/sourcing/production-reporting-service.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { CuttingSourceService } from "../../apps/api/src/cutting/cutting-source-service.js";
import { SourcingContractService } from "../../apps/api/src/sourcing/sourcing-contract-service.js";
import { SourcingProductionService } from "../../apps/api/src/sourcing/sourcing-production-service.js";
import { SourcingService } from "../../apps/api/src/sourcing/sourcing-service.js";
import { AttachmentService } from "../../apps/api/src/tools/attachments.js";
import { OperationEventRepository, type TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { FakeObjectStorage } from "../../apps/api/src/tools/storage.js";

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
  const contractStorage = new FakeObjectStorage();
  const attachments = new AttachmentService(database, contractStorage, {
    prefix: "tests",ttlSeconds: 60,maxUploadBytes: 5_000_000,
  });
  const contractService = new SourcingContractService(database, attachments);
  const service = new SourcingService(
    database,undefined,undefined,todoProjection,contractService,
  );
  const cutting = new CuttingSourceService(database);
  const production = new SourcingProductionService(database);
  const craftService = new AccessMasterDataService(database, "corp");
  const craftIdsByName = new Map<string, string>();
  const craftId = (craftName: string): string => {
    const value = craftIdsByName.get(craftName);
    if (!value) throw new Error(`missing sourcing craft fixture: ${craftName}`);
    return value;
  };
  const merchandiserId = randomUUID();
  const ieId = randomUUID();
  const managerId = randomUUID();
  const ownerId = randomUUID();
  const financeId = randomUUID();
  const factoryId = randomUUID();
  const replacementFactoryId = randomUUID();
  const disabledFactoryId = randomUUID();
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
  const cuttingOwnerActor = (requestId = randomUUID()): TrustedActorContext => ({
    ...ownerActor(requestId),
    authorizationCapability: "cutting:orders:view",
    authorizationCapabilities: ["cutting:orders:view"],
  });
  const cuttingSupervisorActor = (requestId = randomUUID()): TrustedActorContext => ({
    actorId: ownerId,
    actorRoles: ["cutting_supervisor"],
    authorizationCapability: "cutting:records:create",
    authorizationCapabilities: ["cutting:orders:view", "cutting:records:create"],
    requestId,
  });
  const cuttingWorkerActor = (requestId = randomUUID()): TrustedActorContext => ({
    actorId: managerId,
    actorRoles: ["cutting_worker"],
    authorizationCapability: "cutting:records:create",
    authorizationCapabilities: ["cutting:orders:view", "cutting:records:create"],
    requestId,
  });
  const cuttingRootActor = (requestId = randomUUID()): TrustedActorContext => ({
    actorId: merchandiserId,
    actorRoles: ["root_superuser"],
    authorizationCapability: "cutting:records:correct",
    authorizationCapabilities: ["cutting:orders:view", "cutting:records:create", "cutting:records:correct"],
    requestId,
  });
  const factoryChangeActor = (requestId = randomUUID()): TrustedActorContext => ({
    ...merchandiserActor(requestId),
    authorizationCapability: "sourcing:factory_change:request",
    authorizationCapabilities: ["sourcing:view", "sourcing:factory_change:request"],
  });
  const contractActor = (requestId = randomUUID()): TrustedActorContext => ({
    ...merchandiserActor(requestId),
    authorizationCapability: "sourcing:contract:record",
    authorizationCapabilities: ["sourcing:view", "sourcing:contract:record"],
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
  const unrelatedReaderActor = (): TrustedActorContext => ({
    actorId: randomUUID(),
    actorRoles: ["warehouse_keeper"],
    authorizationCapability: "sourcing:view",
    authorizationCapabilities: ["sourcing:view"],
    requestId: randomUUID(),
  });
  const anotherMerchandiserReader = (): TrustedActorContext => ({
    actorId: randomUUID(),
    actorRoles: ["order_merchandiser"],
    authorizationCapability: "sourcing:view",
    authorizationCapabilities: ["sourcing:view"],
    requestId: randomUUID(),
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
    // Exercise the current production read contract against the complete schema.
    // The previous hand-picked schema stopped at 0150 and omitted exclusion dependencies.
    const manifest = JSON.parse(await readFile(new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url), "utf8")) as { migrations: { version: string; checksum: string }[] };
    await database.query(`CREATE TABLE schema_migrations (
      version text PRIMARY KEY, checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const migrationClient = await database.connect();
    try {
      for (const migration of manifest.migrations) {
        await migrationClient.query("BEGIN");
        try {
          await migrationClient.query(await readFile(new URL(`../../apps/api/migrations/${migration.version}.sql`, import.meta.url), "utf8"));
          await migrationClient.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [migration.version, migration.checksum]);
          await migrationClient.query("COMMIT");
        } catch (error) { await migrationClient.query("ROLLBACK"); throw error; }
      }
    } finally { migrationClient.release(); }
    await database.query(
      `INSERT INTO app_users(id,display_name,enabled) VALUES
       ($1,'订单跟单',true),($2,'IE报价员',true),
       ($3,'生产管理',true),($4,'老板',true),($5,'应付财务',true)`,
      [merchandiserId, ieId, managerId, ownerId, financeId],
    );
    const craftFixtures = await craftService.ensureCrafts(managerActor("sourcing-craft-fixtures"), {
      craftNames: [
        "净色车缝",
        "整烫",
        "按样衣复核",
        "车缝",
        "删除测试工艺",
        "重建订单工艺",
      ],
    });
    craftFixtures.forEach((craft) => craftIdsByName.set(craft.craftName, craft.craftId));
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
        DISABLE TRIGGER supplier_catalog_versions_guard_creation, DISABLE TRIGGER supplier_profile_maintenance_authority
    `);
    try {
      await database.query(
        `INSERT INTO supplier_catalog_items(supplier_id,supplier_code,supplier_type)
         VALUES($1,'FAC-01','factory'),($2,'FAC-02','factory'),($3,'FAC-OFF','factory')`,
        [factoryId, replacementFactoryId, disabledFactoryId],
      );
      await database.query(
        `INSERT INTO supplier_catalog_versions(
           supplier_id,version,supplier_name,active,change_reason,changed_by,
           address,contract_entity_name,party_b_representative,
           payee_name,bank_account,bank_name
         ) VALUES
           ($1,1,'一号加工厂',true,'测试夹具',$4,'广州一号路','一号加工厂有限公司','陈一','陈一','622201','测试银行一支行'),
           ($2,1,'二号加工厂',true,'测试夹具',$4,'广州二号路','二号加工厂有限公司','陈二','陈二','622202','测试银行二支行'),
           ($3,1,'停用加工厂',false,'测试夹具',$4,NULL,NULL,NULL,NULL,NULL,NULL)`,
        [factoryId, replacementFactoryId, disabledFactoryId, managerId],
      );
    } finally {
      await database.query(`
        ALTER TABLE supplier_catalog_versions
          ENABLE TRIGGER supplier_catalog_versions_guard_creation, ENABLE TRIGGER supplier_profile_maintenance_authority
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

  it("registers cutting roles and capabilities without assigning employees", async () => {
    const roles = await database.query<{ role_code: string }>(
      `SELECT role_code FROM business_roles
       WHERE role_code IN ('cutting_supervisor','cutting_worker') ORDER BY role_code`,
    );
    expect(roles.rows.map((row) => row.role_code)).toEqual(["cutting_supervisor","cutting_worker"]);
    const grants = await database.query<{ role_code: string; capability: string }>(
      `SELECT role_code,capability FROM role_capabilities
       WHERE role_code IN ('cutting_supervisor','cutting_worker')
       ORDER BY role_code,capability`,
    );
    expect(grants.rows).toEqual([
      { role_code: "cutting_supervisor", capability: "cutting:orders:view" },
      { role_code: "cutting_supervisor", capability: "cutting:records:create" },
      { role_code: "cutting_supervisor", capability: "tools:user" },
      { role_code: "cutting_worker", capability: "cutting:orders:view" },
      { role_code: "cutting_worker", capability: "cutting:records:create" },
      { role_code: "cutting_worker", capability: "tools:user" },
    ]);
    expect((await database.query(
      `SELECT 1 FROM user_role_assignments
       WHERE role_code IN ('cutting_supervisor','cutting_worker')`,
    )).rowCount).toBe(0);
  });

  it("rejects cutting mutations after the source sourcing case is logically deleted", async () => {
    const makeApproved = async (suffix: string) => {
      const created = await service.createCase(merchandiserActor(), {
        gender: "男装" as const,
        styleName: "删除竞态测试",
        estimatedCutPieceSendDate: "2026-10-01",
        deliveryDate: "2026-10-10",
        lineItems: [{
          styleNo: `CUT-DELETE-${suffix}`,
          color: "黑色",
          quantity: 100,
        }],
        daxingUnitPrice: "7.0000",
        attachmentIds: [],
      }, randomUUID());
      await service.quoteIePrice(
        ieActor(), created.value.sourcingCaseId,
        { linePrices: [{ position: 1, unitPrice: "8.5000" }] },
        randomUUID(),
      );
      await service.recordManagementDecision(
        managerActor(), created.value.sourcingCaseId,
        {
          supplierId: factoryId,
          craftIds: [craftId("净色车缝")],
          linePrices: [{ position: 1, unitPrice: "8.5000" }],
        },
        randomUUID(),
      );
      await service.decideOwner(
        ownerActor(), created.value.sourcingCaseId,
        { decision: "approved" },
        randomUUID(),
      );
      const cuttingOrder = (await cutting.listSources(cuttingOwnerActor())).items.find(
        (item) => item.sourcingCaseId === created.value.sourcingCaseId,
      );
      expect(cuttingOrder).toBeDefined();
      return {
        sourcingCaseId: created.value.sourcingCaseId,
        cuttingOrderId: cuttingOrder!.cuttingOrderId,
      };
    };

    const stalePending = await makeApproved("PENDING");
    await service.deleteByRoot(rootActor(), stalePending.sourcingCaseId, randomUUID());
    await expect(cutting.record(
      cuttingWorkerActor(),
      stalePending.cuttingOrderId,
      { pieceCount: 100, actualCutCount: 100 },
      randomUUID(),
    )).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect((await database.query(
      "SELECT 1 FROM cutting_records WHERE cutting_order_id=$1",
      [stalePending.cuttingOrderId],
    )).rowCount).toBe(0);

    const staleCorrection = await makeApproved("CORRECTION");
    await cutting.record(
      cuttingSupervisorActor(),
      staleCorrection.cuttingOrderId,
      { pieceCount: 100, actualCutCount: 100 },
      randomUUID(),
    );
    await service.deleteByRoot(rootActor(), staleCorrection.sourcingCaseId, randomUUID());
    await expect(cutting.correct(
      cuttingRootActor(),
      staleCorrection.cuttingOrderId,
      {
        expectedVersion: 1,
        pieceCount: 101,
        actualCutCount: 101,
        reason: "删除后旧页面不得修正",
      },
      randomUUID(),
    )).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect((await database.query(
      `SELECT 1
       FROM cutting_record_corrections correction
       JOIN cutting_records record USING(cutting_record_id)
       WHERE record.cutting_order_id=$1`,
      [staleCorrection.cuttingOrderId],
    )).rowCount).toBe(0);
  });

  it("creates once, records an exact IE quote and advances the audited state", async () => {
    const createKey = randomUUID();
    const input = {
      gender: "男装" as const, styleName: "梭织短裤",
      estimatedCutPieceSendDate: "2026-09-10",
      deliveryDate: "2026-09-15",
      lineItems: [{
        styleNo: "DX-260826",
        color: "黑色",
        quantity: 137,
        externalUnitPrice: "12.0000",
      }],
      daxingUnitPrice: "10.0000",
      attachmentIds: [evidenceId],
    };

    const created = await service.createCase(merchandiserActor(), input, createKey);
    expect(created.reused).toBe(false);
    expect(created.value).toMatchObject({
      erpOrderId: created.value.sourcingCaseId,
      gender: "男装", styleName: "梭织短裤",
      erpOrderNo: created.value.sourcingCaseId,
      styleNo: input.lineItems[0]!.styleNo,
      laneKey: "garment_processing",
      orderQuantity: 137,
      lineItems: [{
        position: 1,
        styleNo: "DX-260826",
        alternateStyleNo: null,
        color: "黑色",
        quantity: 137,
        externalUnitPrice: null,
        legacy: false,
      }],
      daxingUnitPrice: "10.0000",
      estimatedCutPieceSendDate: "2026-09-10",
      deliveryDate: "2026-09-15",
      processDescription: null,
      processes: [],
      status: "pending_ie_quote",
      version: 1,
      ieQuote: null,
    });

    const replay = await service.createCase(merchandiserActor(), input, createKey);
    expect(replay.reused).toBe(true);
    expect(replay.value.sourcingCaseId).toBe(created.value.sourcingCaseId);
    expect((await service.listStyles(merchandiserActor(), "梭织")).map((style) => style.styleName)).toEqual(["梭织短裤"]);
    await expect(service.listStyles(ieActor(), "")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.createCase(merchandiserActor(), { ...input, gender: undefined } as never, randomUUID()))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.recordManagementDecision(managerActor(), created.value.sourcingCaseId, {
      supplierId: factoryId,unitPrice: "12.0000",craftIds: [],
    }, randomUUID())).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await database.query("SELECT 1 FROM sourcing_cases")).rowCount).toBe(1);
    expect(await service.getCase(unrelatedReaderActor(), created.value.sourcingCaseId))
      .not.toHaveProperty("daxingUnitPrice");
    expect(await service.getCase(anotherMerchandiserReader(), created.value.sourcingCaseId))
      .not.toHaveProperty("daxingUnitPrice");
    const creationAudit = await database.query<{ after_state: Record<string, unknown> }>(
      `SELECT after_state
       FROM operation_events
       WHERE action='sourcing.case.create' AND entity_id=$1
       ORDER BY created_at DESC,event_id DESC
       LIMIT 1`,
      [created.value.sourcingCaseId],
    );
    expect(creationAudit.rows[0]?.after_state).toMatchObject({ daxingUnitPriceRecorded: true });
    expect(creationAudit.rows[0]?.after_state).not.toHaveProperty("daxingUnitPrice");
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
    expect((await service.listCases(readerActor(), "整烫")).items).toHaveLength(0);
    expect((await service.listCases(readerActor(), "梭织短裤")).items).toHaveLength(1);

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
        supportedCrafts: [],
        dailyCapacity: null,
        notes: "",
        contractDataMissing: [],
      },
      {
        supplierId: replacementFactoryId,
        supplierCode: "FAC-02",
        supplierName: "二号加工厂",
        supportedCrafts: [],
        dailyCapacity: null,
        notes: "",
        contractDataMissing: [],
      },
    ]);

    await expect(service.recordManagementDecision(
      managerActor(),
      created.value.sourcingCaseId,
      {
        craftIds: [craftId("净色车缝"), craftId("整烫"), craftId("按样衣复核")],
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
        craftIds: [craftId("净色车缝"), craftId("整烫"), craftId("按样衣复核")],
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
    expect((await service.listCases(readerActor(), "整烫")).items).toHaveLength(1);
    expect(firstDecision.value.processes).toEqual(["净色车缝", "整烫", "按样衣复核"]);

    const rejected = await service.decideOwner(
      ownerActor(),
      created.value.sourcingCaseId,
      { decision: "rejected" },
      randomUUID(),
    );
    expect(rejected.value).toMatchObject({
      status: "pending_management_decision",
      version: 4,
      ownerDecision: {
        decision: "rejected",
        decisionReason: "老板驳回选厂决定",
      },
    });
    expect(rejected.value.approvalSnapshot).toBeNull();
    expect((await database.query(
      "SELECT 1 FROM cutting_orders WHERE sourcing_case_id=$1",
      [created.value.sourcingCaseId],
    )).rowCount).toBe(0);

    const revision = await service.recordManagementDecision(
      managerActor(),
      created.value.sourcingCaseId,
      {
        craftIds: [craftId("净色车缝"), craftId("整烫"), craftId("按样衣复核")],
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

    const approvalKey = randomUUID();
    const approved = await service.decideOwner(
      ownerActor(),
      created.value.sourcingCaseId,
      { decision: "approved" },
      approvalKey,
    );
    const approvalReplay = await service.decideOwner(
      ownerActor(),
      created.value.sourcingCaseId,
      { decision: "approved" },
      approvalKey,
    );
    expect(approvalReplay.reused).toBe(true);
    expect(approved.value).toMatchObject({
      status: "pending_finance_reconciliation",
      version: 6,
      ownerDecision: {
        decision: "approved",
        sourcingDecisionId: revision.value.decision?.sourcingDecisionId,
      },
      approvalSnapshot: {
        gender: "男装",styleName: "梭织短裤",processes: ["净色车缝", "整烫", "按样衣复核"],
        sourcingDecisionId: revision.value.decision?.sourcingDecisionId,
        decisionVersion: 2,
        supplierId: factoryId,
        supplierName: "一号加工厂",
        quantity: 137,
        totalAmount: "1481.46",
        daxingUnitPrice: "10.0000",
        estimatedCutPieceSendDate: "2026-09-10",
        deliveryDate: "2026-09-15",
        linePrices: [{
          position: 1,
          styleNo: "DX-260826",
          color: "黑色",
          quantity: 137,
          unitPrice: "10.8136",
          totalAmount: "1481.46",
        }],
      },
    });
    const cuttingItems = (await cutting.listSources(cuttingOwnerActor())).items
      .filter((item) => item.sourcingCaseId === created.value.sourcingCaseId);
    expect(cuttingItems).toHaveLength(1);
    expect(cuttingItems[0]).toMatchObject({
      sourcePosition: 1,
      formalStyleNo: "DX-260826",
      displayStyleNo: "DX-260826",
      color: "黑色",
      contractQuantity: 137,
      supplierId: factoryId,
      supplierName: "一号加工厂",
      merchandiserId,
    });
    expect(cuttingItems[0]).not.toHaveProperty("daxingUnitPrice");
    expect(cuttingItems[0]).not.toHaveProperty("unitPrice");
    expect(cuttingItems[0]).not.toHaveProperty("totalAmount");
    expect(cuttingItems[0]).not.toHaveProperty("bankAccount");
    await expect(cutting.listSources({
      ...unrelatedReaderActor(),
      authorizationCapability: "cutting:orders:view",
      authorizationCapabilities: ["cutting:orders:view"],
    })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    const firstContract = (await contractService.getCurrent(
      readerActor(),created.value.sourcingCaseId,
    )).item;
    expect(firstContract).toMatchObject({
      contractVersion: 2,templateVersion: 3,status: "ready",missingFields: [],
    });
    const frozenContract = (await database.query<{ approval_snapshot: Record<string, unknown> }>(
      "SELECT approval_snapshot FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",
      [firstContract!.sourcingContractDocumentId],
    )).rows[0]!.approval_snapshot;
    expect(frozenContract).toMatchObject({ gender: "男装",styleName: "梭织短裤",processes: ["净色车缝", "整烫", "按样衣复核"] });
    expect(frozenContract).not.toHaveProperty("daxingUnitPrice");
    expect(firstContract?.contractNumber).toMatch(/^DX-WF-\d{8}-\d{6}$/);
    expect(firstContract?.snapshotFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(firstContract?.pdfAttachmentId).toMatch(/^[0-9a-f-]{36}$/);
    await contractService.generateIfReady(contractActor(), created.value.sourcingCaseId);
    expect((await database.query(
      `SELECT 1 FROM attachments
       WHERE entity_type='sourcing_contract_document' AND entity_id=$1`,
      [firstContract!.sourcingContractDocumentId],
    )).rowCount).toBe(1);
    await expect(database.query(
      "UPDATE sourcing_approval_snapshots SET total_amount=1 WHERE sourcing_case_id=$1",
      [created.value.sourcingCaseId],
    )).rejects.toThrow();
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
    await expect(service.recordFinanceReconciliation(
      financeActor(),
      created.value.sourcingCaseId,
      { result: "match" },
      randomUUID(),
    )).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      statusCode: 409,
      message: "订单转厂审批中，财务暂不能核对",
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
    expect(changeApproved.value.approvalSnapshot).toMatchObject({
      gender: "男装",styleName: "梭织短裤",processes: ["净色车缝", "整烫", "按样衣复核"],
    });
    const changedContract = (await contractService.getCurrent(
      readerActor(),created.value.sourcingCaseId,
    )).item;
    expect(changedContract).toMatchObject({
      contractVersion: 3,status: "ready",missingFields: [],
    });
    expect(changedContract?.sourcingContractDocumentId)
      .not.toBe(firstContract?.sourcingContractDocumentId);
    expect((await database.query<{ total: string; distinct_total: string }>(
      `SELECT count(*)::text AS total,count(DISTINCT contract_number)::text AS distinct_total
       FROM sourcing_contract_documents WHERE sourcing_case_id=$1`,
      [created.value.sourcingCaseId],
    )).rows[0]).toEqual({ total: "2",distinct_total: "2" });

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
      contract_version: number;
      contract_fingerprint: string;
    }>(
      `SELECT result,difference_fields,actual_supplier_name_snapshot,
              contract_version,contract_fingerprint
       FROM sourcing_finance_reconciliations
       WHERE sourcing_case_id=$1 AND reconciliation_version=1`,
      [created.value.sourcingCaseId],
    )).rows[0]).toEqual({
      result: "difference",
      difference_fields: ["total_amount"],
      actual_supplier_name_snapshot: "二号加工厂",
      contract_version: 3,
      contract_fingerprint: changedContract?.snapshotFingerprint,
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
    expect(timeline.items.filter((entry) => entry.kind === "contract")).toHaveLength(2);
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
    expect(todoProjection.information.mock.calls.some(
      (call) => call[2].category === "sourcing_factory_change_notice",
    )).toBe(false);
    expect(todoProjection.completeOpenByDedupePrefix.mock.calls.map((call) => call[2]))
      .toEqual([
        `sourcing:${created.value.sourcingCaseId}:ie_quote:1:`,
        `sourcing:${created.value.sourcingCaseId}:management:1:`,
        `sourcing:${created.value.sourcingCaseId}:owner:1:`,
        `sourcing:${created.value.sourcingCaseId}:management:2:`,
        `sourcing:${created.value.sourcingCaseId}:owner:2:`,
        `sourcing:${created.value.sourcingCaseId}:finance:2:1:`,
        `sourcing:${created.value.sourcingCaseId}:factory_change:${requestedChange!.entryId}:`,
        `sourcing:${created.value.sourcingCaseId}:finance:`,
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
        gender: "男装" as const, styleName: "梭织短裤",
        estimatedCutPieceSendDate: "2026-10-15",
      deliveryDate: "2026-10-20",
          lineItems: [{
          styleNo: "TRANSFER-" + label + "-" + serial,
          color: "黑色",
          quantity: 100,
          externalUnitPrice: "12.0000",
        }],
        daxingUnitPrice: "10.0000",
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
        craftIds: [craftId("净色车缝"), craftId("整烫"), craftId("按样衣复核")],
          supplierId: factoryId,
          unitPrice: "10.0000",
          decisionReason: "首次确认加工厂和生产单价",
        },
        randomUUID(),
      );
      return created.value.sourcingCaseId;
    };

    const locked = await service.createCase(merchandiserActor(), {
      gender: "男装" as const, styleName: "梭织短裤",
      estimatedCutPieceSendDate: "2026-10-15",
      deliveryDate: "2026-10-20",
      lineItems: [{
        styleNo: "TRANSFER-LOCKED",
        color: "黑色",
        quantity: 100,
        externalUnitPrice: "12.0000",
      }],
      daxingUnitPrice: "10.0000",
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
    const managementLowOwnerApproved = await service.decideOwner(
      ownerActor(),
      managementLowCaseId,
      { decision: "approved", decisionReason: "确认低价转厂后的最新选厂版本" },
      randomUUID(),
    );
    expect(managementLowOwnerApproved.value).toMatchObject({
      status: "pending_finance_reconciliation",
      version: 4,
      decision: {
        decisionVersion: 2,
        sourceType: "factory_change",
        supplierId: replacementFactoryId,
      },
      ownerDecision: {
        decision: "approved",
      },
    });

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
    todoProjection.actionableForAllAssignedRole.mockClear();
    const managementHighInitialApproved = await service.decideOwner(
      ownerActor(),
      managementHighCaseId,
      { decision: "approved", decisionReason: "先确认原始选厂决定" },
      randomUUID(),
    );
    expect(managementHighInitialApproved.value).toMatchObject({
      status: "pending_finance_reconciliation",
      version: 4,
      decision: {
        decisionVersion: 1,
        supplierId: factoryId,
      },
    });
    expect(todoProjection.actionableForAllAssignedRole.mock.calls.some(
      (call) => call[2].category === "sourcing_finance_reconcile",
    )).toBe(false);

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
    expect(todoProjection.actionableForAllAssignedRole.mock.calls.some(
      (call) => call[2].category === "sourcing_finance_reconcile",
    )).toBe(true);

    const resumeCaseId = await openAtFirstDecision("FINANCE-RESUME");
    await service.decideOwner(
      ownerActor(),
      resumeCaseId,
      { decision: "approved" },
      randomUUID(),
    );
    await service.requestFactoryChange(
      managerActor(),
      resumeCaseId,
      {
        supplierId: replacementFactoryId,
        unitPrice: "11.0000",
        changeReason: "财务节点发起高价转厂后测试驳回恢复",
      },
      randomUUID(),
    );
    const resumeState = await service.getCurrentFactoryChange(readerActor(), resumeCaseId);
    todoProjection.actionableForAllAssignedRole.mockClear();
    const resumed = await service.decideFactoryChange(
      ownerActor(),
      resumeCaseId,
      resumeState.item!.factoryChangeRequestId,
      { decision: "rejected", verificationReason: "维持原选厂决定" },
      randomUUID(),
    );
    expect(resumed.value).toMatchObject({
      status: "pending_finance_reconciliation",
      version: 4,
      decision: {
        decisionVersion: 1,
        supplierId: factoryId,
      },
    });
    expect(todoProjection.actionableForAllAssignedRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        category: "sourcing_finance_reconcile",
        dedupeKey: `sourcing:${resumeCaseId}:finance:1:1:resume:${resumeState.item!.factoryChangeRequestId}`,
      }),
    );

    const legacyCaseId = await openAtFirstDecision("LEGACY-RESUME");
    await service.decideOwner(
      ownerActor(),
      legacyCaseId,
      { decision: "approved" },
      randomUUID(),
    );
    await service.requestFactoryChange(
      factoryChangeActor(),
      legacyCaseId,
      {
        supplierId: replacementFactoryId,
        unitPrice: "9.5000",
        changeReason: "模拟升级前遗留转厂审批",
      },
      randomUUID(),
    );
    const legacyState = await service.getCurrentFactoryChange(readerActor(), legacyCaseId);
    const legacyRequest = (await database.query<{
      sequence: number | string;
      operation_event_id: string;
      request_id: string;
      requested_by: string;
      change_reason: string;
    }>(
      `SELECT transition_row.sequence,request_row.operation_event_id,
              request_row.request_id,request_row.requested_by,request_row.change_reason
       FROM sourcing_factory_change_requests request_row
       JOIN LATERAL (
         SELECT transition.sequence
         FROM sourcing_case_transitions transition
         WHERE transition.sourcing_case_id=request_row.sourcing_case_id
         ORDER BY transition.sequence DESC LIMIT 1
       ) transition_row ON true
       WHERE request_row.factory_change_request_id=$1`,
      [legacyState.item!.factoryChangeRequestId],
    )).rows[0]!;
    await database.query(
      "ALTER TABLE sourcing_case_transitions DISABLE TRIGGER sourcing_transitions_guard_insert",
    );
    try {
      await database.query(
        `INSERT INTO sourcing_case_transitions(
           sourcing_transition_id,sourcing_case_id,sequence,from_status,to_status,
           business_action,transition_reason,actor_id,operation_event_id,request_id
         ) VALUES($1,$2,$3,'pending_finance_reconciliation',
           'pending_factory_change_verification','factory_change_requested',$4,$5,$6,$7)`,
        [
          randomUUID(),legacyCaseId,Number(legacyRequest.sequence)+1,
          legacyRequest.change_reason,legacyRequest.requested_by,
          legacyRequest.operation_event_id,legacyRequest.request_id,
        ],
      );
    } finally {
      await database.query(
        "ALTER TABLE sourcing_case_transitions ENABLE TRIGGER sourcing_transitions_guard_insert",
      );
    }
    todoProjection.actionableForAllAssignedRole.mockClear();
    const legacyResumed = await service.decideFactoryChange(
      factoryChangeVerifier(),
      legacyCaseId,
      legacyState.item!.factoryChangeRequestId,
      { decision: "rejected", verificationReason: "驳回升级前遗留申请" },
      randomUUID(),
    );
    expect(legacyResumed.value).toMatchObject({
      status: "pending_finance_reconciliation",
      version: 6,
      decision: {
        decisionVersion: 1,
        supplierId: factoryId,
      },
    });
    expect(todoProjection.actionableForAllAssignedRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        category: "sourcing_finance_reconcile",
        dedupeKey: `sourcing:${legacyCaseId}:finance:1:1:resume:${legacyState.item!.factoryChangeRequestId}`,
      }),
    );

    const ownerCaseId = await openAtFirstDecision("OWNER");
    todoProjection.completeOpenByDedupePrefix.mockClear();
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
    expect(todoProjection.completeOpenByDedupePrefix).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      `sourcing:${ownerCaseId}:owner:`,
      "老板直接转厂已生效，原老板审批待办失效",
    );
    expect((await database.query(
      "SELECT 1 FROM cutting_orders WHERE sourcing_case_id=$1",
      [ownerCaseId],
    )).rowCount).toBe(1);
    expect((await cutting.listSources(cuttingOwnerActor())).items.find(
      (item) => item.sourcingCaseId === ownerCaseId,
    )).toMatchObject({
      formalStyleNo: "TRANSFER-OWNER-5",
      supplierId: replacementFactoryId,
    });

    const exceptionCaseId = await openAtFirstDecision("EXCEPTION-TRANSFER");
    await service.decideOwner(
      ownerActor(),
      exceptionCaseId,
      { decision: "approved" },
      randomUUID(),
    );
    await service.recordFinanceReconciliation(
      financeActor(),
      exceptionCaseId,
      {
        result: "difference",
        differenceFields: ["total_amount"],
        differenceReason: "测试异常核实期间转厂",
      },
      randomUUID(),
    );
    todoProjection.completeOpenByDedupePrefix.mockClear();
    const exceptionTransfer = await service.requestFactoryChange(
      managerActor(),
      exceptionCaseId,
      {
        supplierId: replacementFactoryId,
        unitPrice: "9.5000",
        changeReason: "异常核实期间改用低价加工厂",
      },
      randomUUID(),
    );
    expect(exceptionTransfer.value).toMatchObject({
      status: "pending_finance_reconciliation",
      version: 6,
      decision: {
        decisionVersion: 2,
        supplierId: replacementFactoryId,
      },
    });
    expect(todoProjection.completeOpenByDedupePrefix).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      `sourcing:${exceptionCaseId}:exception:`,
      "转厂方案已生效，原异常核实待办失效",
    );

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

  it("carries different row prices through review and freezes one immutable approval snapshot", async () => {
    const created = await service.createCase(merchandiserActor(), {
      gender: "男装" as const, styleName: "梭织短裤",
      estimatedCutPieceSendDate: "2026-10-01",
      deliveryDate: "2026-10-08",
      lineItems: [
        { styleNo: "SSP04-A", color: "黑色", quantity: 100, externalUnitPrice: "11.0000" },
        { styleNo: "SSP04-B", alternateStyleNo: "SSP04-BX", color: "白色", quantity: 50, externalUnitPrice: "8.0000" },
      ],
      daxingUnitPrice: "7.5000",
    }, randomUUID());

    await expect(service.quoteIePrice(ieActor(), created.value.sourcingCaseId, {
      linePrices: [{ position: 1, unitPrice: "12.3456" }],
    }, randomUUID())).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const quoted = await service.quoteIePrice(ieActor(), created.value.sourcingCaseId, {
      linePrices: [
        { position: 1, unitPrice: "12.3456" },
        { position: 2, unitPrice: "9.5000" },
      ],
    }, randomUUID());
    expect(quoted.value.ieQuote).toMatchObject({
      totalAmount: "1709.56",
      linePrices: [
        { position: 1, quantity: 100, unitPrice: "12.3456", totalAmount: "1234.56" },
        { position: 2, quantity: 50, unitPrice: "9.5000", totalAmount: "475.00" },
      ],
    });

    await expect(service.recordManagementDecision(managerActor(), created.value.sourcingCaseId, {
        craftIds: [craftId("净色车缝"), craftId("整烫"), craftId("按样衣复核")],
      supplierId: disabledFactoryId,
      linePrices: quoted.value.ieQuote!.linePrices.map(({ position, unitPrice }) => ({ position, unitPrice })),
    }, randomUUID())).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const decided = await service.recordManagementDecision(managerActor(), created.value.sourcingCaseId, {
        craftIds: [craftId("净色车缝"), craftId("整烫"), craftId("按样衣复核")],
      supplierId: factoryId,
      linePrices: [
        { position: 1, unitPrice: "12.0000" },
        { position: 2, unitPrice: "10.0000" },
      ],
      decisionReason: "逐款复核标准工时",
    }, randomUUID());
    expect(decided.value.decision).toMatchObject({
      totalAmount: "1700.00",
      linePrices: [
        { position: 1, totalAmount: "1200.00" },
        { position: 2, totalAmount: "500.00" },
      ],
    });

    const approvals = await Promise.allSettled([
      service.decideOwner(ownerActor(), created.value.sourcingCaseId, { decision: "approved" }, randomUUID()),
      service.decideOwner(ownerActor(), created.value.sourcingCaseId, { decision: "approved" }, randomUUID()),
    ]);
    expect(approvals.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(approvals.filter((result) => result.status === "rejected")).toHaveLength(1);
    const approved = await service.getCase({ ...ownerActor(), authorizationCapability: "sourcing:view" }, created.value.sourcingCaseId);
    expect(approved.approvalSnapshot).toMatchObject({
      supplierId: factoryId,
      quantity: 150,
      totalAmount: "1700.00",
      daxingUnitPrice: "7.5000",
      linePrices: [
        { position: 1, styleNo: "SSP04-A", color: "黑色", quantity: 100, unitPrice: "12.0000" },
        { position: 2, styleNo: "SSP04-B", alternateStyleNo: "SSP04-BX", color: "白色", quantity: 50, unitPrice: "10.0000" },
      ],
    });
    expect((await service.getCase(unrelatedReaderActor(), created.value.sourcingCaseId)).approvalSnapshot)
      .not.toHaveProperty("daxingUnitPrice");
    expect((await database.query(
      "SELECT 1 FROM sourcing_approval_snapshots WHERE sourcing_case_id=$1",
      [created.value.sourcingCaseId],
    )).rowCount).toBe(1);
    const multiCutting = await database.query<{ sourcing_line_position: number }>(
      `SELECT sourcing_line_position FROM cutting_orders
       WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position`,
      [created.value.sourcingCaseId],
    );
    expect(multiCutting.rows.map((row) => Number(row.sourcing_line_position))).toEqual([1,2]);
    expect((await database.query<{ total_amount: string }>(
      "SELECT total_amount::text FROM sourcing_decisions WHERE sourcing_decision_id=$1",
      [decided.value.decision!.sourcingDecisionId],
    )).rows[0]?.total_amount).toBe("1700.00");
    expect((await database.query<{
      supplier_address: string | null;
      contract_entity_name: string | null;
      party_b_representative: string | null;
      payee_name: string | null;
      bank_account: string | null;
      bank_name: string | null;
    }>(
      `SELECT supplier_address,contract_entity_name,party_b_representative,
              payee_name,bank_account,bank_name
       FROM sourcing_approval_snapshots WHERE sourcing_case_id=$1`,
      [created.value.sourcingCaseId],
    )).rows[0]).toEqual({
      supplier_address: "广州一号路",
      contract_entity_name: "一号加工厂有限公司",
      party_b_representative: "陈一",
      payee_name: "陈一",
      bank_account: "622201",
      bank_name: "测试银行一支行",
    });

    const changed = await service.requestFactoryChange(managerActor(), created.value.sourcingCaseId, {
      supplierId: replacementFactoryId,
      unitPrice: "9.0000",
      changeReason: "逐款订单换厂并保留全部款色价格行",
    }, randomUUID());
    expect(changed.value).toMatchObject({
      status: "pending_finance_reconciliation",
      decision: {
        sourceType: "factory_change",
        supplierId: replacementFactoryId,
        totalAmount: "1350.00",
        linePrices: [
          { position: 1, quantity: 100, unitPrice: "9.0000", totalAmount: "900.00" },
          { position: 2, quantity: 50, unitPrice: "9.0000", totalAmount: "450.00" },
        ],
      },
      approvalSnapshot: {
        sourcingDecisionId: changed.value.decision!.sourcingDecisionId,
        totalAmount: "1350.00",
      },
    });
  });

  it("lets only Root logically delete without losing evidence or blocking ERP reuse", async () => {
    const attachmentId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,
         uploaded_by,status,ready_at
       ) VALUES($1,$2,'待删除测试订单.jpg','image/jpeg',128,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [attachmentId, `sourcing-test/${attachmentId}.jpg`, "b".repeat(64), merchandiserId],
    );
    const created = await service.createCase(merchandiserActor(), {
      gender: "男装" as const, styleName: "梭织短裤",
      estimatedCutPieceSendDate: "2026-09-26",
      deliveryDate: "2026-10-01",
      lineItems: [{
        styleNo: "DELETE-STYLE-1",
        color: "黑色",
        quantity: 88,
        externalUnitPrice: "12.0000",
      }],
      daxingUnitPrice: "10.0000",
      attachmentIds: [attachmentId],
    }, randomUUID());
    expect(created.value).toMatchObject({
      processDescription: null,
      processes: [],
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

    expect((await service.listCases(readerActor(), "DELETE-STYLE-1")).items).toHaveLength(0);
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
      gender: "男装" as const, styleName: "梭织短裤",
      estimatedCutPieceSendDate: "2026-09-27",
      deliveryDate: "2026-10-02",
      lineItems: [{
        styleNo: "DELETE-STYLE-1",
        color: "黑色",
        quantity: 99,
        externalUnitPrice: "12.0000",
      }],
      daxingUnitPrice: "10.0000",
    }, randomUUID());
    expect(replacement.value.sourcingCaseId).not.toBe(created.value.sourcingCaseId);
    expect((await service.listCases(readerActor(), "DELETE-STYLE-1")).items)
      .toEqual([expect.objectContaining({ sourcingCaseId: replacement.value.sourcingCaseId })]);
    expect((await database.query(
      "SELECT 1 FROM sourcing_cases WHERE style_no='DELETE-STYLE-1'",
    )).rowCount).toBe(2);
  });

  it("keeps approval successful when contract data is missing and freezes supplements", async () => {
    const missingSupplierId = randomUUID();
    await database.query("ALTER TABLE supplier_catalog_items DISABLE TRIGGER supplier_catalog_items_require_initial_version");
    await database.query("ALTER TABLE supplier_catalog_versions DISABLE TRIGGER supplier_catalog_versions_guard_creation, DISABLE TRIGGER supplier_profile_maintenance_authority");
    try {
      await database.query(
        `INSERT INTO supplier_catalog_items(supplier_id,supplier_code,supplier_type)
         VALUES($1,'FAC-MISSING','factory')`,
        [missingSupplierId],
      );
      await database.query(
        `INSERT INTO supplier_catalog_versions(
           supplier_id,version,supplier_name,active,change_reason,changed_by
         ) VALUES($1,1,'合同缺项加工厂',true,'测试合同缺项',$2)`,
        [missingSupplierId,managerId],
      );
    } finally {
      await database.query("ALTER TABLE supplier_catalog_versions ENABLE TRIGGER supplier_catalog_versions_guard_creation, ENABLE TRIGGER supplier_profile_maintenance_authority");
      await database.query("ALTER TABLE supplier_catalog_items ENABLE TRIGGER supplier_catalog_items_require_initial_version");
    }

    const created = await service.createCase(merchandiserActor(), {
      gender: "男装" as const, styleName: "梭织短裤",
      estimatedCutPieceSendDate: "2026-10-01",
      deliveryDate: "2026-10-15",
      lineItems: [{
        styleNo: "CONTRACT-MISSING",color: "蓝色",quantity: 10,externalUnitPrice: "8.0000",
      }],
      daxingUnitPrice: "6.5000",
    }, randomUUID());
    await service.quoteIePrice(ieActor(), created.value.sourcingCaseId, {
      unitPrice: "8.0000",
    }, randomUUID());
    await service.recordManagementDecision(managerActor(), created.value.sourcingCaseId, {
        craftIds: [craftId("净色车缝"), craftId("整烫"), craftId("按样衣复核")],
      supplierId: missingSupplierId,unitPrice: "8.0000",
    }, randomUUID());
    await expect(service.decideOwner(ownerActor(), created.value.sourcingCaseId, {
      decision: "approved",
    }, randomUUID())).resolves.toMatchObject({
      value: { status: "pending_finance_reconciliation" },
    });

    const pending = (await contractService.getCurrent(readerActor(), created.value.sourcingCaseId)).item!;
    expect(pending).toMatchObject({
      status: "pending_supplement",
      missingFields: ["address","partyBRepresentative","payeeName","bankAccount","bankName"],
    });
    expect((await production.state(contractActor(), created.value.sourcingCaseId)).canDispatch).toBe(false);
    await expect(service.reviseStyles(rootActor(),created.value.sourcingCaseId,{
      expectedRevision:0,lines:created.value.lineItems.map(line => ({position:line.position,styleNo:"EARLY-REVISION",alternateStyleNo:null})),
    },randomUUID())).rejects.toMatchObject({code:"INVALID_STATE_TRANSITION"});
    await expect(production.dispatch(contractActor(), created.value.sourcingCaseId, {
      sourcingContractDocumentId: pending.sourcingContractDocumentId, confirmed: true,
    }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    const ready = (await contractService.supplement(contractActor(), created.value.sourcingCaseId, {
      address: "广州补充地址",
      partyBRepresentative: "陈补充",
      payeeName: "陈补充",
      bankAccount: "622299",
      bankName: "测试银行补充分行",
    }, randomUUID())).item!;
    expect(ready).toMatchObject({ status: "ready",missingFields: [] });
    expect(ready.pdfAttachmentId).toMatch(/^[0-9a-f-]{36}$/);
    const frozenProduction = await production.dispatch(contractActor(), created.value.sourcingCaseId, {
      sourcingContractDocumentId: ready.sourcingContractDocumentId, confirmed: true,
    }, randomUUID());

    await database.query("ALTER TABLE supplier_catalog_versions DISABLE TRIGGER supplier_catalog_versions_guard_creation, DISABLE TRIGGER supplier_profile_maintenance_authority");
    try {
      await database.query(
        `INSERT INTO supplier_catalog_versions(
           supplier_id,version,supplier_name,active,change_reason,changed_by,
           address,contract_entity_name,party_b_representative,payee_name,bank_account,bank_name
         ) VALUES($1,2,'合同缺项加工厂已改名',true,'主档后续修改',$2,
           '新地址','新主体','新代表','新收款人','999999','新银行')`,
        [missingSupplierId,managerId],
      );
    } finally {
      await database.query("ALTER TABLE supplier_catalog_versions ENABLE TRIGGER supplier_catalog_versions_guard_creation, ENABLE TRIGGER supplier_profile_maintenance_authority");
    }
    const frozen = (await contractService.getCurrent(readerActor(), created.value.sourcingCaseId)).item!;
    expect(frozen.snapshotFingerprint).toBe(ready.snapshotFingerprint);
    expect(frozen.pdfSha256).toBe(ready.pdfSha256);
    expect((await production.get(readerActor(), frozenProduction.value.productionOrderId)).supplierName).toBe("合同缺项加工厂");
    await service.reviseStyles(merchandiserActor(),created.value.sourcingCaseId,{expectedRevision:0,lines:[{position:1,styleNo:"CONTRACT-MISSING-REVISED",alternateStyleNo:null}]},randomUUID());
    const revised=(await contractService.getCurrent(readerActor(),created.value.sourcingCaseId)).item!;
    expect(revised).toMatchObject({status:"ready",missingFields:[],contractVersion:ready.contractVersion+1});
    const retained=(await database.query("SELECT approval_snapshot FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",[revised.sourcingContractDocumentId])).rows[0]!.approval_snapshot;
    expect(retained).toMatchObject({address:"广州补充地址",payeeName:"陈补充",bankAccount:"622299",supplierName:"合同缺项加工厂"});

    await expect(contractService.supplement(contractActor(), created.value.sourcingCaseId, {
      address: "试图追改",
    }, randomUUID())).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });
  it("dispatches before finance, freezes all lines, and handles concurrent clicks without duplication", async () => {
    const created = await service.createCase(merchandiserActor(), {
      gender: "女装", styleName: "SSP06连衣裙", estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-10-20",
      lineItems: [
        { styleNo: "DISPATCH-A", color: "蓝色", quantity: 5000, externalUnitPrice: "11.0000" },
        { styleNo: "DISPATCH-B", alternateStyleNo: "ALT-B", color: "白色", quantity: 200, externalUnitPrice: "12.0000" },
      ], daxingUnitPrice: "888.1234",
    }, randomUUID());
    const id = created.value.sourcingCaseId;
    expect((await production.list(readerActor())).items.some((item) => item.sourcingCaseId === id)).toBe(false);
    await expect(production.dispatch(contractActor(), id, { sourcingContractDocumentId: randomUUID(), confirmed: true }, randomUUID()))
      .rejects.toMatchObject({ statusCode: 409 });
    const prices = [{ position: 1, unitPrice: "11.0000" }, { position: 2, unitPrice: "12.0000" }];
    await service.quoteIePrice(ieActor(), id, { linePrices: prices }, randomUUID());
    await service.recordManagementDecision(managerActor(), id, { supplierId: factoryId,
      craftIds: [craftId("净色车缝"), craftId("整烫")], linePrices: prices }, randomUUID());
    await service.decideOwner(ownerActor(), id, { decision: "approved" }, randomUUID());
    const contract = (await contractService.getCurrent(readerActor(), id)).item!;
    expect(contract.status).toBe("ready");
    expect((await database.query("SELECT 1 FROM sourcing_finance_reconciliations WHERE sourcing_case_id=$1", [id])).rowCount).toBe(0);
    expect((await production.state(contractActor(), id)).canDispatch).toBe(true);
    const input = { sourcingContractDocumentId: contract.sourcingContractDocumentId, confirmed: true as const };
    await expect(production.dispatch({ ...contractActor(), actorId: managerId }, id, input, randomUUID()))
      .rejects.toMatchObject({ statusCode: 403 });
    await expect(production.dispatch(financeActor(), id, input, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    await expect(production.dispatch(contractActor(), id, { ...input, sourcingContractDocumentId: randomUUID() }, randomUUID()))
      .rejects.toMatchObject({ statusCode: 409 });
    const key = randomUUID();
    const [first, second, third] = await Promise.all([
      production.dispatch(contractActor(), id, input, key),
      production.dispatch(contractActor(), id, input, key),
      production.dispatch(contractActor(), id, input, randomUUID()),
    ]);
    expect(new Set([first.value.productionOrderId, second.value.productionOrderId, third.value.productionOrderId]).size).toBe(1);
    await expect(production.dispatch(contractActor(), id, { ...input, sourcingContractDocumentId: randomUUID() }, key))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const order = first.value;
    expect(order).toMatchObject({
      supplierId: factoryId, supplierName: "一号加工厂", gender: "女装", styleName: "SSP06连衣裙",
      contractNumber: contract.contractNumber, contractVersion: contract.contractVersion, decisionVersion: 1,
      quantity: 5200, firstStyleNo: "DISPATCH-A", processes: ["净色车缝", "整烫"], deliveryDate: "2026-10-20",
      dispatchedBy: merchandiserId, status: "in_production", firstReportedOn: null, timeProgress: null, progressAlert: null,
      lines: [
        { position: 1, styleNo: "DISPATCH-A", color: "蓝色", quantity: 5000 },
        { position: 2, styleNo: "DISPATCH-B", alternateStyleNo: "ALT-B", color: "白色", quantity: 200 },
      ],
    });
    expect((await production.state(contractActor(), id)).canDispatch).toBe(false);
    expect((await database.query("SELECT 1 FROM sourcing_production_orders WHERE sourcing_case_id=$1", [id])).rowCount).toBe(1);
    expect((await database.query("SELECT 1 FROM operation_events WHERE action='sourcing.production.dispatch' AND entity_id=$1", [order.productionOrderId])).rowCount).toBe(1);
    const publicData = JSON.stringify([order, await production.get(readerActor(), order.productionOrderId), await production.list(readerActor())]);
    expect(publicData).not.toMatch(/daxing|888\.1234|bankAccount|unitPrice|totalAmount/);
    await expect(production.get(unrelatedReaderActor(), order.productionOrderId)).rejects.toMatchObject({ statusCode: 403 });
    await expect(production.get(anotherMerchandiserReader(), order.productionOrderId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(database.query("UPDATE sourcing_production_orders SET supplier_name_snapshot='追改' WHERE production_order_id=$1", [order.productionOrderId])).rejects.toBeDefined();
    await expect(database.query("DELETE FROM sourcing_production_lines WHERE production_order_id=$1", [order.productionOrderId])).rejects.toBeDefined();
    await expect(database.query(`INSERT INTO sourcing_production_transitions(production_transition_id,production_order_id,sequence,status,business_date,actor_id,operation_event_id)
      SELECT $1,production_order_id,2,'shipped',CURRENT_DATE,dispatched_by,operation_event_id FROM sourcing_production_orders WHERE production_order_id=$2`,
      [randomUUID(), order.productionOrderId])).rejects.toMatchObject({
        code: "55000", message: "production execution requires reporter scope and valid business date",
      });
    const prematureShipmentEventId = await new OperationEventRepository().append(database, rootActor(), {
      action: "sourcing.production.ship", entityType: "sourcing_production_order", entityId: order.productionOrderId,
      after: { status: "shipped" }, reason: "验证有权操作也不能跳过生产完成",
    });
    await expect(database.query(`INSERT INTO sourcing_production_transitions(production_transition_id,production_order_id,sequence,status,business_date,actor_id,operation_event_id)
      VALUES($1,$2,2,'shipped',(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date,$3,$4)`,
      [randomUUID(), order.productionOrderId, merchandiserId, prematureShipmentEventId]))
      .rejects.toMatchObject({ code: "55000", message: "illegal production transition" });
    expect((await database.query("SELECT count(*)::int AS count FROM sourcing_production_transitions WHERE production_order_id=$1", [order.productionOrderId])).rows[0].count).toBe(1);
    await service.recordFinanceReconciliation(financeActor(), id, { result: "match" }, randomUUID());
    expect((await production.get(readerActor(), order.productionOrderId)).status).toBe("in_production");
    await service.requestFactoryChange(managerActor(), id, {
      supplierId: replacementFactoryId, unitPrice: "9.0000", changeReason: "验证已派单后的新合同不能重复派单",
    }, randomUUID());
    const changedContract = (await contractService.getCurrent(readerActor(), id)).item!;
    expect(changedContract.status).toBe("ready");
    expect(changedContract.sourcingContractDocumentId).not.toBe(input.sourcingContractDocumentId);
    expect(await production.state(contractActor(), id)).toMatchObject({
      canDispatch: false, item: { productionOrderId: order.productionOrderId, status: "in_production" },
    });
    for (const dispatchActor of [contractActor(), rootActor()]) {
      await expect(production.dispatch(dispatchActor, id, {
        sourcingContractDocumentId: changedContract.sourcingContractDocumentId, confirmed: true,
      }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    }
    expect((await production.dispatch(contractActor(), id, input, randomUUID())).value.productionOrderId)
      .toBe(order.productionOrderId);
    expect((await database.query("SELECT 1 FROM sourcing_production_orders WHERE sourcing_case_id=$1", [id])).rowCount).toBe(1);
    expect((await production.get(readerActor(), order.productionOrderId)).supplierId).toBe(factoryId);

    expect(order.sourceCaseArchived).toBe(false);
    const beforeDeletion = await production.list(readerActor());
    await service.deleteByRoot(rootActor(), id, randomUUID());
    await expect(service.getCase(readerActor(), id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await production.get(readerActor(), order.productionOrderId)).toMatchObject({
      sourceCaseArchived: true, status: "in_production", supplierId: factoryId,
    });
    const afterDeletion = await production.list(readerActor());
    expect(afterDeletion.totalCount).toBe(beforeDeletion.totalCount);
    expect(afterDeletion.items.find((item) => item.productionOrderId === order.productionOrderId))
      .toMatchObject({ sourceCaseArchived: true, status: "in_production" });
    await expect(production.get(unrelatedReaderActor(), order.productionOrderId)).rejects.toMatchObject({ statusCode: 403 });
    await expect(production.get(anotherMerchandiserReader(), order.productionOrderId)).rejects.toMatchObject({ statusCode: 404 });
    expect((await production.list(anotherMerchandiserReader())).items.some((item) => item.productionOrderId === order.productionOrderId)).toBe(false);
    for (const [sequence, status, action] of [[2, "production_completed", "sourcing.production.complete"], [3, "shipped", "sourcing.production.ship"]] as const) {
      const eventId = await new OperationEventRepository().append(database, rootActor(), {
        action, entityType: "sourcing_production_order", entityId: order.productionOrderId, after: { status }, reason: "验证合法状态顺序",
      });
      await database.query(`INSERT INTO sourcing_production_transitions(production_transition_id,production_order_id,sequence,status,business_date,actor_id,operation_event_id)
        VALUES($1,$2,$3,$4,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date,$5,$6)`,
        [randomUUID(), order.productionOrderId, sequence, status, merchandiserId, eventId]);
      expect((await production.get(readerActor(), order.productionOrderId)).status).toBe(status);
    }
  });

  it("allows Root fallback and does not let a recorded finance difference block dispatch", async () => {
    const created = await service.createCase(merchandiserActor(), {
      gender: "男装", styleName: "SSP06外套", estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-10-20",
      lineItems: [{ styleNo: "DISPATCH-DIFF", color: "黑色", quantity: 30, externalUnitPrice: "8.0000" }], daxingUnitPrice: "6.0000",
    }, randomUUID());
    const id = created.value.sourcingCaseId;
    await service.quoteIePrice(ieActor(), id, { unitPrice: "8.0000" }, randomUUID());
    await service.recordManagementDecision(managerActor(), id, { supplierId: factoryId, unitPrice: "8.0000", craftIds: [craftId("净色车缝")] }, randomUUID());
    await service.decideOwner(ownerActor(), id, { decision: "approved" }, randomUUID());
    const contract = (await contractService.getCurrent(readerActor(), id)).item!;
    await service.recordFinanceReconciliation(financeActor(), id, { result: "difference", differenceFields: ["quantity"], differenceReason: "对账时记录差异，不是派单审批" }, randomUUID());
    await expect(production.dispatch({ ...rootActor(), actorRoles: ["root_superuser"] }, id, {
      sourcingContractDocumentId: contract.sourcingContractDocumentId, confirmed: true,
    }, randomUUID())).resolves.toMatchObject({ value: { status: "in_production" } });
  });

  it("reports within assigned scope, corrects append-only, and completes then ships without finance", async () => {
    const reporting = new ProductionReportingService(database);
    const reporterId = randomUUID();
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'驻厂测试人员',true)",[reporterId]);
    await database.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation");
    try { await database.query(`INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason)
      VALUES($1,$2,'production_reporter',$3,'驻厂测试夹具')`,[randomUUID(),reporterId,merchandiserId]); }
    finally { await database.query("ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation"); }
    const reporter = (): TrustedActorContext => ({ actorId: reporterId, actorRoles: ["production_reporter"],
      authorizationCapability: "production-reporting", authorizationCapabilities: ["production-reporting"], requestId: randomUUID() });
    const businessDate = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    const createProduction = async (suffix: string) => {
      const created = await service.createCase(merchandiserActor(), { gender:"女装",styleName:"驻厂填报验证",estimatedCutPieceSendDate:businessDate,deliveryDate:businessDate,
        lineItems:[{styleNo:`REPORT-${suffix}-A`,color:"蓝",quantity:20,externalUnitPrice:"8.0000"},{styleNo:`REPORT-${suffix}-B`,color:"白",quantity:10,externalUnitPrice:"9.0000"}],daxingUnitPrice:"777.1234" },randomUUID());
      const id=created.value.sourcingCaseId,prices=[{position:1,unitPrice:"8.0000"},{position:2,unitPrice:"9.0000"}];
      await service.quoteIePrice(ieActor(),id,{linePrices:prices},randomUUID());
      await service.recordManagementDecision(managerActor(),id,{supplierId:factoryId,linePrices:prices,craftIds:[craftId("净色车缝")]},randomUUID());
      await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
      const contract=(await contractService.getCurrent(readerActor(),id)).item!;
      return (await production.dispatch(rootActor(),id,{sourcingContractDocumentId:contract.sourcingContractDocumentId,confirmed:true},randomUUID())).value;
    };
    const order=await createProduction("ONE"),other=await createProduction("TWO");
    const dashboard=new ProductionDashboardService(database,reporting);
    expect((await dashboard.list(reporter())).items).toHaveLength(0);
    expect((await reporting.list(reporter())).items).toHaveLength(0);
    await expect(reporting.report(reporter(),order.productionOrderId,{position:1,businessDate,quantity:10},randomUUID())).rejects.toMatchObject({statusCode:403});
    const grant={userId:reporterId,scopeType:"order" as const,scopeId:order.productionOrderId,active:true};
    await reporting.setScope(rootActor(),grant,randomUUID());
    expect((await reporting.scopeDirectory(rootActor())).scopes).toContainEqual(expect.objectContaining(grant));
    expect((await reporting.list(reporter())).items.map(item=>item.productionOrderId)).toEqual([order.productionOrderId]);
    await expect(reporting.detail(reporter(),other.productionOrderId)).rejects.toMatchObject({statusCode:404});
    await expect(dashboard.detail(reporter(),other.productionOrderId)).rejects.toMatchObject({statusCode:404});
    await expect(dashboard.list(financeActor())).rejects.toMatchObject({statusCode:403});
    const pending=await dashboard.list(reporter());
    expect(pending.items.map(i=>i.order.productionOrderId)).toEqual([order.productionOrderId]);
    expect(pending.items[0]!.progress).toMatchObject({progressState:"pending_first_report",timeProgress:null,attention:false});
    const dispatchDates=(await database.query<{dispatched_on:string;before_dispatch:string}>(
      "SELECT business_date::text AS dispatched_on,(business_date-1)::text AS before_dispatch FROM sourcing_production_transitions WHERE production_order_id=$1 AND sequence=1",
      [order.productionOrderId])).rows[0]!;
    const beforeRejectedReports=await reporting.detail(reporter(),order.productionOrderId);
    for(const user of [reporter(),rootActor()]) {
      await expect(reporting.report(user,order.productionOrderId,{position:1,businessDate:dispatchDates.before_dispatch,quantity:1},randomUUID()))
        .rejects.toMatchObject({statusCode:400,message:"上报业务日期不能早于正式派单日期"});
    }
    expect(await reporting.detail(reporter(),order.productionOrderId)).toEqual(beforeRejectedReports);
    const key=randomUUID(),input={position:1,businessDate:dispatchDates.dispatched_on,quantity:10};
    const [first,duplicate]=await Promise.all([reporting.report(reporter(),order.productionOrderId,input,key),reporting.report(reporter(),order.productionOrderId,input,key)]);
    expect(first.value.order.completedQuantity).toBe(10);expect(duplicate.value.order.completedQuantity).toBe(10);
    await expect(reporting.report(reporter(),order.productionOrderId,{...input,quantity:11},key)).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
    const concurrent=await Promise.allSettled([reporting.report(reporter(),order.productionOrderId,{...input,quantity:6},randomUUID()),reporting.report(reporter(),order.productionOrderId,{...input,quantity:6},randomUUID())]);
    expect(concurrent.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    const firstReport=first.value.history[0]!;
    const beforeRejectedCorrections=await reporting.detail(reporter(),order.productionOrderId);
    for(const quantity of [0,1]) {
      await expect(reporting.correct(rootActor(),order.productionOrderId,firstReport.rootReportId,
        {expectedReportId:firstReport.reportId,businessDate:dispatchDates.before_dispatch,quantity,reason:"验证修正日期下限"},randomUUID()))
        .rejects.toMatchObject({statusCode:400,message:"上报业务日期不能早于正式派单日期"});
    }
    for(const revision of [1,2]) {
      const reportId=randomUUID(),rootReportId=revision===1?reportId:firstReport.rootReportId;
      const reason=revision===1?null:"验证数据库修正日期下限";
      const eventId=await new OperationEventRepository().append(database,{...rootActor(),authorizationCapability:"production-reporting"},{
        action:revision===1?"sourcing.production.report":"sourcing.production.correct",entityType:"sourcing_production_report",entityId:reportId,
        after:{productionOrderId:order.productionOrderId,rootReportId,revision,position:1,businessDate:dispatchDates.before_dispatch,quantity:1},
        reason:reason??"验证数据库上报日期下限",
      });
      await expect(database.query(`INSERT INTO sourcing_production_reports(report_id,root_report_id,revision,production_order_id,position,business_date,quantity,actor_id,actor_name,reason,operation_event_id)
        SELECT $1,$2,$3,$4,1,$5,1,id,display_name,$7,$8 FROM app_users WHERE id=$6`,
        [reportId,rootReportId,revision,order.productionOrderId,dispatchDates.before_dispatch,merchandiserId,reason,eventId]))
        .rejects.toMatchObject({code:"55000",message:"invalid production report authorization or date/state"});
    }
    expect(await reporting.detail(reporter(),order.productionOrderId)).toEqual(beforeRejectedCorrections);
    await reporting.correct(rootActor(),order.productionOrderId,firstReport.rootReportId,{expectedReportId:firstReport.reportId,businessDate,quantity:0,reason:"误报撤销，原值仍保留"},randomUUID());
    const corrected=await reporting.detail(reporter(),order.productionOrderId);
    expect(corrected.order.completedQuantity).toBe(6);
    expect(corrected.history.find(h=>h.reportId===firstReport.reportId)).toMatchObject({quantity:10,effective:false});
    expect(corrected.history.find(h=>h.rootReportId===firstReport.rootReportId&&h.effective)).toMatchObject({quantity:0,revision:2});
    await expect(reporting.correct(rootActor(),order.productionOrderId,firstReport.rootReportId,{expectedReportId:firstReport.reportId,businessDate,quantity:1,reason:"过期页面"},randomUUID())).rejects.toMatchObject({statusCode:409});
    await expect(database.query("UPDATE sourcing_production_reports SET quantity=1 WHERE report_id=$1",[firstReport.reportId])).rejects.toBeDefined();
    await reporting.report(reporter(),order.productionOrderId,{position:2,businessDate,quantity:10},randomUUID());
    await expect(reporting.report(reporter(),order.productionOrderId,{position:2,businessDate,quantity:1},randomUUID())).rejects.toMatchObject({statusCode:400});
    expect((await reporting.detail(readerActor(),order.productionOrderId)).canReport).toBe(false);
    await expect(reporting.detail(financeActor(),order.productionOrderId)).rejects.toMatchObject({statusCode:403});
    await reporting.setScope(rootActor(),{...grant,active:false},randomUUID());
    await expect(reporting.report(reporter(),order.productionOrderId,{...input,quantity:1},randomUUID())).rejects.toMatchObject({statusCode:403});
    await reporting.setScope(rootActor(),{userId:reporterId,scopeType:"supplier",scopeId:factoryId,active:true},randomUUID());
    expect((await reporting.list(reporter(),{supplierId:factoryId,q:"REPORT-"})).totalCount).toBe(2);
    await expect(reporting.execute(reporter(),order.productionOrderId,"ship",{businessDate,confirmed:true},randomUUID())).rejects.toMatchObject({statusCode:409});
    const running=await dashboard.list(reporter(),{q:"REPORT-ONE"});
    expect((await dashboard.detail(reporter(),order.productionOrderId)).progress).toEqual(running.items[0]!.progress);
    const laterClock=new Date(Date.now()+3*86400000);
    const laterDashboard=new ProductionDashboardService(database,reporting,()=>laterClock);
    const stale=await laterDashboard.list(reporter(),{q:"REPORT-ONE",previousAsOf:running.asOf,progressState:"stale"});
    expect(stale).toMatchObject({totalCount:1,counts:{attention:1}});
    expect(stale.items[0]!.progress).toMatchObject({progressState:"stale",daysWithoutUpdate:3});
    expect(stale.events.some(e=>e.kind==="progress_changed"&&e.progressState==="stale")).toBe(true);
    const finish=await reporting.execute(reporter(),order.productionOrderId,"complete",{businessDate,confirmed:true},randomUUID());
    expect(finish.value.order).toMatchObject({status:"production_completed",completedQuantity:16,quantity:30,firstReportedOn:businessDate});
    await expect(reporting.report(reporter(),order.productionOrderId,{...input,quantity:1},randomUUID())).rejects.toMatchObject({statusCode:409});
    const shipKey=randomUUID();
    const shipped=await reporting.execute(reporter(),order.productionOrderId,"ship",{businessDate,confirmed:true},shipKey);
    expect(shipped.value.shipment).toEqual({firstStyleNo:"REPORT-ONE-A",shippedOn:businessDate,recordedQuantity:16});
    expect((await reporting.execute(reporter(),order.productionOrderId,"ship",{businessDate,confirmed:true},shipKey)).value.shipment).toEqual(shipped.value.shipment);
    expect(JSON.stringify(shipped.value)).not.toMatch(/daxing|777\.1234|unitPrice|bankAccount|totalAmount/);
    expect(shipped.value.order.status).toBe("shipped");
    const frozen=await dashboard.detail(reporter(),order.productionOrderId);
    expect(frozen.progress).toMatchObject({frozen:true,completedQuantity:16,progressState:"completed",attention:false});
    expect((await laterDashboard.detail(reporter(),order.productionOrderId)).progress).toEqual(frozen.progress);
    const remaining=shipped.value.history.find(h=>h.effective&&h.quantity===6)!;
    await reporting.correct(rootActor(),order.productionOrderId,remaining.rootReportId,
      {expectedReportId:remaining.reportId,businessDate,quantity:3,reason:"完工后修正保留完成时看板"},randomUUID());
    const afterCorrection=await dashboard.detail(reporter(),order.productionOrderId);
    expect(afterCorrection.detail.order.completedQuantity).toBe(13);
    expect(afterCorrection.progress).toEqual(frozen.progress);
    await expect(database.query("UPDATE sourcing_production_progress_snapshots SET completed_quantity=99 WHERE production_order_id=$1",[order.productionOrderId])).rejects.toBeDefined();
    const completedBoard=await dashboard.list(reporter(),{q:"REPORT-ONE"});
    expect(completedBoard.items[0]!.progress).toEqual(frozen.progress);
    expect(completedBoard.events.some(e=>e.kind==="correct")).toBe(true);
    expect(JSON.stringify([completedBoard,afterCorrection])).not.toMatch(/daxing|777\.1234|unitPrice|bankAccount|totalAmount/);
    expect((await database.query("SELECT 1 FROM sourcing_finance_reconciliations WHERE sourcing_case_id=$1",[order.sourcingCaseId])).rowCount).toBe(0);
    await service.deleteByRoot(rootActor(),order.sourcingCaseId,randomUUID());
    expect((await reporting.detail(reporter(),order.productionOrderId)).order.sourceCaseArchived).toBe(true);
    const legacy=await createProduction("LEGACY");
    const legacyReport=await reporting.report(rootActor(),legacy.productionOrderId,{position:1,businessDate,quantity:10},randomUUID());
    await database.query("ALTER TABLE sourcing_production_transitions DISABLE TRIGGER sourcing_production_progress_capture");
    try { await reporting.execute(rootActor(),legacy.productionOrderId,"complete",{businessDate,confirmed:true},randomUUID()); }
    finally { await database.query("ALTER TABLE sourcing_production_transitions ENABLE TRIGGER sourcing_production_progress_capture"); }
    const legacyOriginal=legacyReport.value.history[0]!;
    await reporting.correct(rootActor(),legacy.productionOrderId,legacyOriginal.rootReportId,
      {expectedReportId:legacyOriginal.reportId,businessDate,quantity:0,reason:"历史完工之后的修正"},randomUUID());
    const migrationSql=await readFile(new URL("../../apps/api/migrations/0150_sourcing_production_progress_snapshot.sql",import.meta.url),"utf8");
    const backfillSql=migrationSql.slice(migrationSql.indexOf("INSERT INTO sourcing_production_progress_snapshots"),migrationSql.indexOf("CREATE FUNCTION capture_sourcing_production_progress"))
      .replace("WHERE transition.status='production_completed';","WHERE transition.status='production_completed' AND transition.production_order_id=$1;");
    await database.query("ALTER TABLE sourcing_production_progress_snapshots DISABLE TRIGGER sourcing_production_progress_snapshot_guard");
    try { await database.query(backfillSql,[legacy.productionOrderId]); }
    finally { await database.query("ALTER TABLE sourcing_production_progress_snapshots ENABLE TRIGGER sourcing_production_progress_snapshot_guard"); }
    const legacyFrozen=await dashboard.detail(rootActor(),legacy.productionOrderId);
    expect(legacyFrozen.detail.order.completedQuantity).toBe(0);
    expect(legacyFrozen.progress).toMatchObject({completedQuantity:10,firstReportedOn:businessDate,frozen:true,attention:false});
  });

  it("starts new lines without prices, records IE first, and keeps audited cutting details out of contracts", async () => {
    const created = await service.createCase(merchandiserActor(), {
      gender: "女装", styleName: "首次报价验证", estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-10-10",
      lineItems: [{ styleNo: "IE-FIRST-A", color: "黑", quantity: 100 }, { styleNo: "IE-FIRST-B", color: "白", quantity: 50 }],
      daxingUnitPrice: "987.6500", attachmentIds: [],
    }, randomUUID());
    const caseId = created.value.sourcingCaseId;
    const analysisBefore = await readQuoteAnalysis(database,{q:"IE-FIRST-A"});
    expect(analysisBefore).toMatchObject({missingInitialCount:0,items:[{initialPriceExpected:false}]});
    expect(created.value.ieQuote).toBeNull();
    expect(created.value.lineItems.map(line => line.externalUnitPrice)).toEqual([null, null]);
    const prices = [{ position: 1, unitPrice: "12.35" }, { position: 2, unitPrice: "8.50" }];
    await expect(service.quoteIePrice(merchandiserActor(), caseId, { linePrices: prices }, randomUUID()))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const quoted = await service.quoteIePrice(ieActor(), caseId, { linePrices: prices }, randomUUID());
    expect(quoted.value.ieQuote?.totalAmount).toBe("1660.00");
    const key = randomUUID();
    const input = { supplierId: factoryId, craftIds: [craftId("净色车缝")], linePrices: prices,
      cuttingProcess: "other" as const, cuttingProcessOther: "CUT-INTERNAL-PR02" };
    const decided = await service.recordManagementDecision(managerActor(), caseId, input, key);
    expect(decided.value.decision).toMatchObject({ totalAmount: "1660.00", cuttingProcess: "other", cuttingProcessOther: "CUT-INTERNAL-PR02" });
    expect((await service.recordManagementDecision(managerActor(), caseId, input, key)).reused).toBe(true);
    await expect(service.recordManagementDecision(managerActor(), caseId, { ...input, cuttingProcessOther: "不同说明" }, key))
      .rejects.toBeDefined();
    await service.decideOwner(ownerActor(), caseId, { decision: "approved" }, randomUUID());
    const stored = await database.query("SELECT approval_snapshot FROM sourcing_contract_documents WHERE sourcing_case_id=$1", [caseId]);
    expect(await readQuoteAnalysis(database,{q:"IE-FIRST-A"})).toMatchObject({missingInitialCount:0,items:[{initialPriceExpected:false,ie:[{version:1}]}]});
    expect(stored.rowCount).toBe(1);
    expect(JSON.stringify(stored.rows)).not.toMatch(/CUT-INTERNAL-PR02|cuttingProcess|987\.65|daxing/);
    await expect(database.query("UPDATE sourcing_decisions SET cutting_process='in_house',cutting_process_other=NULL WHERE sourcing_decision_id=$1", [decided.value.decision!.sourcingDecisionId]))
      .rejects.toBeDefined();
    const changed = await service.requestFactoryChange(managerActor(), caseId,
      { supplierId: replacementFactoryId, unitPrice: "8.00", changeReason: "裁床沿用验证" }, randomUUID());
    expect(changed.value.decision?.sourcingDecisionId).not.toBe(decided.value.decision?.sourcingDecisionId);
    expect(changed.value.decision).toMatchObject({ cuttingProcess: "other", cuttingProcessOther: "CUT-INTERNAL-PR02" });
  });

  it("rejects an undecodable contract picture before binding and permits correction with the same request key", async () => {
    const uploadActor = { ...merchandiserActor(), authorizationCapability: "tools:user" };
    const upload = async (bytes: Buffer, filename: string): Promise<string> => {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const intent = await attachments.createUploadIntent(uploadActor, { filename, mimeType: "image/jpeg", sizeBytes: bytes.byteLength, sha256 });
      await contractStorage.writeImmutable(intent.objectKey, bytes, { mimeType: "image/jpeg", sha256 });
      await attachments.finalize(uploadActor, intent.attachmentId);
      return intent.attachmentId;
    };
    const oversized = await sharp({ create: { width: 6400, height: 6400, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
    expect(oversized.byteLength).toBeLessThan(1_048_576);
    const oversizedId = await upload(oversized, "oversized-pixels.jpg");
    const input = { gender: "女装" as const, styleName: "款图像素边界", estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-10-10",
      lineItems: [{ alternateStyleNo: "PIXEL-BOUNDARY", color: "白", quantity: 10, imageAttachmentId: oversizedId }], daxingUnitPrice: "10", attachmentIds: [oversizedId] };
    const key = randomUUID();
    await expect(service.createCase(merchandiserActor(), input, key)).rejects.toMatchObject({ statusCode: 422, message: expect.stringContaining("oversized-pixels.jpg") });
    expect((await database.query("SELECT entity_type,entity_id FROM attachments WHERE attachment_id=$1", [oversizedId])).rows[0]).toEqual({ entity_type: null, entity_id: null });
    expect((await database.query("SELECT 1 FROM sourcing_cases WHERE style_no='PIXEL-BOUNDARY'")).rowCount).toBe(0);
    const acceptedId = await upload(await sharp(oversized).resize(400).jpeg().toBuffer(), "corrected-pixels.jpg");
    const corrected = { ...input, lineItems: [{ ...input.lineItems[0]!, imageAttachmentId: acceptedId }], attachmentIds: [oversizedId, acceptedId] };
    expect((await service.createCase(merchandiserActor(), corrected, key)).value.lineItems[0]!.imageAttachmentId).toBe(acceptedId);
    expect((await service.createCase(merchandiserActor(), corrected, key)).reused).toBe(true);
  });

  it("binds per-line pictures to the order and preserves them through a contract style revision", async () => {
    const imageIds: string[] = [];
    const uploadActor = { ...merchandiserActor(), authorizationCapability: "tools:user" };
    for (const [index, format] of (["png", "webp"] as const).entries()) {
      const bytes = await sharp({ create: { width: 100, height: 150, channels: 3, background: index ? "#c34242" : "#4268a0" } }).toFormat(format).toBuffer();
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const mimeType = `image/${format}`;
      const intent = await attachments.createUploadIntent(uploadActor, { filename: `style-${index}.${format}`, mimeType, sizeBytes: bytes.byteLength, sha256 });
      await contractStorage.writeImmutable(intent.objectKey, bytes, { mimeType, sha256 });
      await attachments.finalize(uploadActor, intent.attachmentId);
      imageIds.push(intent.attachmentId);
    }
    const input = { gender: "女装" as const, styleName: "逐款图片", estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-10-10",
      lineItems: [{ alternateStyleNo: "PIC-A", color: "蓝", quantity: 10, imageAttachmentId: imageIds[0]! },
        { alternateStyleNo: "PIC-A", color: "灰", quantity: 15, imageAttachmentId: imageIds[0]! },
        { styleNo: "PIC-B", color: "红", quantity: 20, imageAttachmentId: imageIds[1]! }], daxingUnitPrice: "987.65", attachmentIds: imageIds };
    await expect(service.createCase(merchandiserActor(), { ...input, attachmentIds: [imageIds[0]!] }, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    const created = await service.createCase(merchandiserActor(), input, randomUUID());
    const id = created.value.sourcingCaseId;
    expect(created.value.lineItems.map(line => line.imageAttachmentId)).toEqual([imageIds[0], imageIds[0], imageIds[1]]);
    await expect(attachments.readSourcingContractImage(randomUUID(), imageIds[0]!)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.createCase(merchandiserActor(), input, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    const linePrices = input.lineItems.map((_line, index) => ({ position: index + 1, unitPrice: "8.50" }));
    await service.quoteIePrice(ieActor(), id, { linePrices }, randomUUID());
    await service.recordManagementDecision(managerActor(), id, { supplierId: factoryId, craftIds: [craftId("净色车缝")], linePrices, cuttingProcess: "other", cuttingProcessOther: "IMAGE-INTERNAL-CUT" }, randomUUID());
    await service.decideOwner(ownerActor(), id, { decision: "approved" }, randomUUID());
    const original = (await contractService.getCurrent(readerActor(), id)).item!;
    expect(original).toMatchObject({ templateVersion: 3, status: "ready" });
    const query = "SELECT approval_snapshot FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1";
    const snapshot = (await database.query(query, [original.sourcingContractDocumentId])).rows[0]!.approval_snapshot;
    expect(snapshot.lines.map((line: { imageAttachmentId: string }) => line.imageAttachmentId)).toEqual([imageIds[0], imageIds[0], imageIds[1]]);
    expect(JSON.stringify(snapshot)).not.toMatch(/987\.65|IMAGE-INTERNAL-CUT|cuttingProcess|daxing/);
    await service.reviseStyles(merchandiserActor(), id, { expectedRevision: 0, lines: [
      { position: 1, styleNo: "FINAL-PIC-A", alternateStyleNo: "PIC-A" },
      { position: 2, styleNo: "FINAL-PIC-A", alternateStyleNo: "PIC-A" },
      { position: 3, styleNo: "FINAL-PIC-B", alternateStyleNo: null },
    ] }, randomUUID());
    const revised = (await contractService.getCurrent(readerActor(), id)).item!;
    expect(revised).toMatchObject({ status: "ready", contractVersion: original.contractVersion + 1 });
    expect(revised.pdfAttachmentId).not.toBe(original.pdfAttachmentId);
    const updated = (await database.query(query, [revised.sourcingContractDocumentId])).rows[0]!.approval_snapshot;
    expect(updated.lines.map((line: { imageAttachmentId: string }) => line.imageAttachmentId)).toEqual(snapshot.lines.map((line: { imageAttachmentId: string }) => line.imageAttachmentId));
    expect(updated.lines.map((line: { styleNo: string }) => line.styleNo)).toEqual(["FINAL-PIC-A", "FINAL-PIC-A", "FINAL-PIC-B"]);
    expect(updated.totalAmount).toBe(snapshot.totalAmount);
    await expect(database.query("UPDATE sourcing_case_lines SET image_attachment_id=$2 WHERE sourcing_case_id=$1", [id, imageIds[1]])).rejects.toBeDefined();
  });

  it("appends a corrected template contract while retaining the original PDF and supplements", async () => {
    const created = await service.createCase(merchandiserActor(), { gender: "男装", styleName: "历史合同纠版", estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-10-10",
      lineItems: [{ styleNo: "TEMPLATE-UPGRADE", color: "黑", quantity: 20 }], daxingUnitPrice: "7.00", attachmentIds: [] }, randomUUID());
    const id = created.value.sourcingCaseId;
    await service.quoteIePrice(ieActor(), id, { linePrices: [{ position: 1, unitPrice: "8.50" }] }, randomUUID());
    await service.recordManagementDecision(managerActor(), id, { supplierId: factoryId, craftIds: [craftId("净色车缝")], linePrices: [{ position: 1, unitPrice: "8.50" }] }, randomUUID());
    // Represent an existing V2 contract without preparing a V3 document first.
    const legacyService = new SourcingService(database, undefined, undefined, todoProjection);
    const approved = (await legacyService.decideOwner(ownerActor(), id, { decision: "approved" }, randomUUID())).value.approvalSnapshot!;
    const oldId = randomUUID();
    const payload = { gender: "男装", styleName: "历史合同纠版", supplierName: "一号加工厂", contractEntityName: "一号加工厂有限公司", address: null,
      partyBRepresentative: "陈一", payeeName: "陈一", bankAccount: "622201", bankName: "测试银行一支行", quantity: "20", totalAmount: "170.00",
      estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-10-10", processes: ["净色车缝"], approvedAt: new Date().toISOString(), lines: approved.linePrices };
    await database.query(`INSERT INTO sourcing_contract_documents(sourcing_contract_document_id,sourcing_case_id,sourcing_approval_snapshot_id,sourcing_decision_id,
      contract_version,contract_number,template_version,approval_snapshot,missing_fields,status,prepared_by)
      VALUES($1,$2,$3,$4,1,'DX-WF-20260917-'||lpad(nextval('sourcing_contract_number_seq')::text,6,'0'),2,$5,ARRAY['address'],'pending_supplement',$6)`,
    [oldId, id, approved.sourcingApprovalSnapshotId, approved.sourcingDecisionId, JSON.stringify(payload), merchandiserId]);
    const old = (await contractService.supplement(contractActor(), id, { address: "原合同补充地址" }, randomUUID())).item!;
    expect(old).toMatchObject({ templateVersion: 2, status: "ready" });
    const originalPdf = (await database.query("SELECT * FROM attachments WHERE attachment_id=$1", [old.pdfAttachmentId])).rows[0]!;
    const originalBytes = await contractStorage.readBytes(originalPdf.object_key, 5_000_000);
    const migration = await readFile("apps/api/migrations/0194_sourcing_line_images_contract_template.sql", "utf8");
    const backfill = migration.slice(migration.indexOf("INSERT INTO sourcing_contract_documents("));
    await database.query(backfill);
    const pending = (await contractService.getCurrent(readerActor(), id)).item!;
    expect(pending).toMatchObject({ templateVersion: 3, contractVersion: 2, status: "generation_pending", missingFields: [] });
    const current = (await database.query("SELECT approval_snapshot,revision_of FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1", [pending.sourcingContractDocumentId])).rows[0]!;
    expect(current.revision_of).toBe(oldId);
    expect(current.approval_snapshot).toMatchObject({ address: "原合同补充地址", totalAmount: "170.00" });
    await contractService.generateIfReady(contractActor(), id, pending.sourcingContractDocumentId);
    expect((await contractService.getCurrent(readerActor(), id)).item).toMatchObject({ status: "ready", templateVersion: 3 });
    expect((await database.query("SELECT * FROM attachments WHERE attachment_id=$1", [old.pdfAttachmentId])).rows[0]).toEqual(originalPdf);
    expect(await contractStorage.readBytes(originalPdf.object_key, 5_000_000)).toEqual(originalBytes);
    expect((await database.query("SELECT terms->>'qualityRequirements' AS clause FROM sourcing_contract_template_versions WHERE template_version=3")).rows[0]!.clause).toContain("费用由乙方承担");
  });

  it("revises delayed style identities without changing approval money or production links", async () => {
    const created = await service.createCase(merchandiserActor(), {
      gender:"女装",styleName:"后补款号",estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-10",
      lineItems:[{alternateStyleNo:"TEMP-PR03",color:"蓝",quantity:20}],daxingUnitPrice:"7.00",attachmentIds:[],
    },randomUUID());
    const id=created.value.sourcingCaseId;
    expect(created.value).toMatchObject({styleNo:"TEMP-PR03",identityRevision:0,lineItems:[{formalStyleNo:null,alternateStyleNo:"TEMP-PR03"}]});
    const edit={expectedRevision:0,lines:[{position:1,styleNo:"FINAL-PR03",alternateStyleNo:"TEMP-PR03"}]};
    await expect(service.reviseStyles(ieActor(),id,edit,randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(service.reviseStyles({...merchandiserActor(),actorId:ieId},id,edit,randomUUID())).rejects.toMatchObject({statusCode:403});
    for (const actor of [merchandiserActor(),managerActor(),rootActor()]) {
      await expect(service.reviseStyles(actor,id,edit,randomUUID())).rejects.toMatchObject({code:"INVALID_STATE_TRANSITION"});
    }
    await service.quoteIePrice(ieActor(),id,{linePrices:[{position:1,unitPrice:"8.50"}]},randomUUID());
    await expect(service.reviseStyles(rootActor(),id,edit,randomUUID())).rejects.toMatchObject({code:"INVALID_STATE_TRANSITION"});
    await service.recordManagementDecision(managerActor(),id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:[{position:1,unitPrice:"8.50"}]},randomUUID());
    await expect(service.reviseStyles(managerActor(),id,edit,randomUUID())).rejects.toMatchObject({code:"INVALID_STATE_TRANSITION"});
    const generate = vi.spyOn(contractService,"generateIfReady").mockResolvedValueOnce({item:null});
    await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
    const pendingCutting=(await cutting.listSources(cuttingOwnerActor())).items.find(item=>item.sourcingCaseId===id)!;
    expect(pendingCutting).toMatchObject({formalStyleNo:null,alternateStyleNo:"TEMP-PR03",displayStyleNo:"TEMP-PR03"});
    const stableCuttingOrderId=pendingCutting.cuttingOrderId;
    await expect(cutting.record(cuttingWorkerActor(),stableCuttingOrderId,{pieceCount:120,actualCutCount:20},randomUUID()))
      .rejects.toMatchObject({code:"INVALID_STATE_TRANSITION"});
    await expect(cutting.record(cuttingOwnerActor(),stableCuttingOrderId,{pieceCount:120,actualCutCount:20},randomUUID()))
      .rejects.toMatchObject({statusCode:403});
    generate.mockRestore();
    await expect(service.reviseStyles(merchandiserActor(),id,edit,randomUUID())).rejects.toMatchObject({code:"INVALID_STATE_TRANSITION"});
    await contractService.generateIfReady(contractActor(),id);
    const first=await service.reviseStyles(merchandiserActor(),id,edit,randomUUID());
    expect(first.value).toMatchObject({styleNo:"FINAL-PR03",identityRevision:1,status:"pending_finance_reconciliation"});
    const formalCutting=(await cutting.listSources(cuttingOwnerActor())).items.find(item=>item.sourcingCaseId===id)!;
    expect(formalCutting).toMatchObject({cuttingOrderId:stableCuttingOrderId,formalStyleNo:"FINAL-PR03",displayStyleNo:"FINAL-PR03"});
    expect((await database.query("SELECT 1 FROM cutting_orders WHERE sourcing_case_id=$1",[id])).rowCount).toBe(1);
    const concurrentRecords=await Promise.all([
      cutting.record(cuttingSupervisorActor(),stableCuttingOrderId,{pieceCount:120,actualCutCount:20},randomUUID()),
      cutting.record(cuttingWorkerActor(),stableCuttingOrderId,{pieceCount:121,actualCutCount:20},randomUUID()),
    ]);
    expect(concurrentRecords.map(result=>result.value.outcome).sort()).toEqual(["already_recorded","created"]);
    const recorded=await cutting.get(cuttingOwnerActor(),stableCuttingOrderId);
    expect(recorded).toMatchObject({status:"recorded",actualCutCount:20,outOfRange:false,record:{version:1,actualCutCount:20,corrected:false}});
    expect([ownerId,managerId]).toContain(recorded.record!.recordedBy);
    const initialRecorder=recorded.record!.recordedBy;
    const initialRecordedAt=recorded.record!.recordedAt;
    expect((await database.query("SELECT formal_style_no,actual_cut_count,style_conflict_count FROM current_cutting_style_options WHERE cutting_order_id=$1",[stableCuttingOrderId])).rows[0])
      .toMatchObject({formal_style_no:"FINAL-PR03",actual_cut_count:"20",style_conflict_count:"1"});
    const corrected=await cutting.correct(cuttingRootActor(),stableCuttingOrderId,{expectedVersion:1,pieceCount:122,actualCutCount:22,reason:"修正测试误录"},randomUUID());
    expect(corrected.value.item).toMatchObject({actualCutCount:22,outOfRange:true,record:{version:2,pieceCount:122,actualCutCount:22,recordedBy:initialRecorder,recordedAt:initialRecordedAt,corrected:true}});
    expect(corrected.value.item.record!.corrections).toEqual([
      expect.objectContaining({version:2,pieceCount:122,actualCutCount:22,reason:"修正测试误录",correctedBy:merchandiserId}),
    ]);
    await expect(cutting.correct(cuttingWorkerActor() as never,stableCuttingOrderId,{expectedVersion:2,pieceCount:123,actualCutCount:23,reason:"越权"},randomUUID()))
      .rejects.toMatchObject({statusCode:403});
    await expect(service.reviseStyles(managerActor(),id,edit,randomUUID())).rejects.toMatchObject({statusCode:409});
    const original=(await contractService.getCurrent(readerActor(),id)).item!;
    expect(original.status).toBe("ready");
    const approved=(await service.getCase(readerActor(),id)).approvalSnapshot!;
    const key=randomUUID(),secondEdit={expectedRevision:1,lines:[{position:1,styleNo:"REVISED-PR03",alternateStyleNo:null}]};
    const revised=await service.reviseStyles(managerActor(),id,secondEdit,key);
    expect((await service.reviseStyles(managerActor(),id,secondEdit,key)).reused).toBe(true);
    expect((await database.query("SELECT formal_style_no,actual_cut_count FROM current_cutting_style_options WHERE cutting_order_id=$1",[stableCuttingOrderId])).rows[0])
      .toMatchObject({formal_style_no:"REVISED-PR03",actual_cut_count:"22"});
    expect((await database.query("SELECT count(*)::integer AS count FROM cutting_records WHERE cutting_order_id=$1",[stableCuttingOrderId])).rows[0]!.count).toBe(1);
    await expect(service.reviseStyles(managerActor(),id,{...secondEdit,lines:[{position:1,styleNo:"WRONG",alternateStyleNo:null}]},key)).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
    expect(revised.value.approvalSnapshot).toEqual(approved);
    const current=(await contractService.getCurrent(readerActor(),id)).item!;
    expect(current).toMatchObject({contractVersion:original.contractVersion+1,status:"ready",sourcingApprovalSnapshotId:original.sourcingApprovalSnapshotId});
    expect(current.pdfAttachmentId).not.toBe(original.pdfAttachmentId);
    const documents=await database.query<{approval_snapshot:{lines:{styleNo:string;unitPrice:string}[];totalAmount:string};revision_of:string|null}>(
      "SELECT approval_snapshot,revision_of FROM sourcing_contract_documents WHERE sourcing_case_id=$1 ORDER BY contract_version",[id]);
    expect(documents.rows.map(row=>row.approval_snapshot.lines[0]!.styleNo)).toEqual(["TEMP-PR03","FINAL-PR03","REVISED-PR03"]);
    expect(documents.rows.map(row=>row.approval_snapshot.totalAmount)).toEqual(["170.00","170.00","170.00"]);
    expect(documents.rows[2]!.revision_of).toBe(original.sourcingContractDocumentId);
    for(const q of ["TEMP-PR03","FINAL-PR03","REVISED-PR03"]) expect((await service.listCases(readerActor(),q)).items.map(item=>item.sourcingCaseId)).toContain(id);
    await expect(production.dispatch(rootActor(),id,{sourcingContractDocumentId:original.sourcingContractDocumentId,confirmed:true},randomUUID())).rejects.toMatchObject({statusCode:409});
    const order=(await production.dispatch(rootActor(),id,{sourcingContractDocumentId:current.sourcingContractDocumentId,confirmed:true},randomUUID())).value;
    expect(order).toMatchObject({firstStyleNo:"REVISED-PR03",quantity:20,lines:[{position:1,styleNo:"REVISED-PR03",quantity:20}]});
    await service.reviseStyles(rootActor(),id,{expectedRevision:2,lines:[{position:1,styleNo:"AFTER-DISPATCH-PR03",alternateStyleNo:"ALT-PR03"}]},randomUUID());
    expect(await production.get(rootActor(),order.productionOrderId)).toMatchObject({productionOrderId:order.productionOrderId,firstStyleNo:"AFTER-DISPATCH-PR03",quantity:20,decisionVersion:1});
    const reporting=new ProductionReportingService(database);
    expect((await reporting.list(rootActor(),{q:"AFTER-DISPATCH-PR03"})).items.map(row=>row.productionOrderId)).toContain(order.productionOrderId);
    expect((await reporting.list(rootActor(),{q:"TEMP-PR03"})).items.map(row=>row.productionOrderId)).toContain(order.productionOrderId);
    expect((await database.query("SELECT style_no FROM sourcing_case_lines WHERE sourcing_case_id=$1",[id])).rows[0]!.style_no).toBeNull();
    await expect(database.query("UPDATE sourcing_style_revisions SET lines='[]' WHERE sourcing_case_id=$1",[id])).rejects.toBeDefined();
    await expect(database.query("UPDATE sourcing_contract_documents SET identity_version=99 WHERE sourcing_case_id=$1",[id])).rejects.toBeDefined();
  });

  it("checks formal/alternate duplicates, permits colors and audits confirmed repeat orders", async () => {
    const input={gender:"男装" as const,styleName:"查重测试",estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-10",
      lineItems:[{styleNo:"DUP-GUARD-A",alternateStyleNo:"TEMP-DUP-GUARD",color:"黑",quantity:5},
        {styleNo:"DUP-GUARD-A",alternateStyleNo:"TEMP-DUP-GUARD",color:"白",quantity:7}],daxingUnitPrice:"7.00",attachmentIds:[]};
    await expect(service.createCase(merchandiserActor(),{...input,lineItems:input.lineItems.map(line => ({...line,color:"黑"}))},randomUUID()))
      .rejects.toMatchObject({statusCode:400,message:expect.stringContaining("第 1 行与第 2 行")});
    const original=await service.createCase(merchandiserActor(),input,randomUUID());
    const id=original.value.sourcingCaseId;
    await expect(database.query(`INSERT INTO sourcing_case_lines(sourcing_case_id,position,style_no,color,quantity)
      VALUES($1,3,' dup-guard-a ','黑',1)`,[id])).rejects.toMatchObject({code:"23505",message:expect.stringContaining("duplicate style identity")});
    const repeat={...input,lineItems:[{styleNo:"NEW-DUP-GUARD",alternateStyleNo:"temp-dup-guard",color:"蓝",quantity:3}]};
    const key=randomUUID();
    await expect(service.createCase(merchandiserActor(),repeat,key)).rejects.toMatchObject({code:"STYLE_NUMBER_EXISTS"});
    const acknowledged={...repeat,confirmedDuplicateStyles:["TEMP-DUP-GUARD"]};
    const accepted=await service.createCase(merchandiserActor(),acknowledged,key);
    expect((await service.createCase(merchandiserActor(),acknowledged,key)).reused).toBe(true);
    expect((await service.createCase(merchandiserActor(),repeat,key)).reused).toBe(true);
    expect((await database.query("SELECT after_state FROM operation_events WHERE entity_id=$1 AND action='sourcing.case.create'",[accepted.value.sourcingCaseId])).rows[0]!.after_state.confirmedDuplicateStyles).toEqual(["temp-dup-guard"]);
    const linePrices=input.lineItems.map((_line,index)=>({position:index+1,unitPrice:"8.50"}));
    await service.quoteIePrice(ieActor(),id,{linePrices},randomUUID());
    await service.recordManagementDecision(managerActor(),id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices},randomUUID());
    await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
    await service.reviseStyles(managerActor(),id,{expectedRevision:0,lines:[1,2].map(position=>({position,styleNo:"FINAL-DUP-GUARD",alternateStyleNo:null}))},randomUUID());
    await expect(service.createCase(merchandiserActor(),{...input,lineItems:[{styleNo:"dup-guard-a",color:"绿",quantity:1}]},randomUUID()))
      .rejects.toMatchObject({code:"STYLE_NUMBER_EXISTS"});
  });

  it("rejects revised same-color aliases and cross-order collisions before contract regeneration", async () => {
    const created=await service.createCase(merchandiserActor(),{gender:"男装",styleName:"改号防重",estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-10",
      lineItems:[{styleNo:"REV-DUP-A",color:"黑",quantity:5},{styleNo:"REV-DUP-B",color:"黑",quantity:7}],daxingUnitPrice:"7.00",attachmentIds:[]},randomUUID());
    const id=created.value.sourcingCaseId, linePrices=[{position:1,unitPrice:"8.50"},{position:2,unitPrice:"8.50"}];
    await service.quoteIePrice(ieActor(),id,{linePrices},randomUUID());
    await service.recordManagementDecision(managerActor(),id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices},randomUUID());
    await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
    const duplicate={expectedRevision:0,lines:[{position:1,styleNo:"REV-DUP-A",alternateStyleNo:null},{position:2,styleNo:"REV-DUP-B",alternateStyleNo:"rev-dup-a"}]};
    await expect(service.reviseStyles(managerActor(),id,duplicate,randomUUID())).rejects.toMatchObject({statusCode:400});
    await expect(database.query(`INSERT INTO sourcing_style_revisions(sourcing_case_id,revision,lines,changed_by,operation_event_id,request_id)
      VALUES($1,1,$2::jsonb,$3,$4,'test-duplicate')`,[id,JSON.stringify(duplicate.lines),managerId,randomUUID()]))
      .rejects.toMatchObject({code:"23505",message:expect.stringContaining("duplicate revised style identity")});
    expect((await service.getCase(readerActor(),id)).identityRevision).toBe(0);
    expect((await contractService.getCurrent(readerActor(),id)).item!.contractVersion).toBe(1);
    await service.createCase(merchandiserActor(),{gender:"男装",styleName:"已用款号",estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-10",
      lineItems:[{styleNo:"TAKEN-REV-GUARD",color:"红",quantity:1}],daxingUnitPrice:"7",attachmentIds:[]},randomUUID());
    const cross={expectedRevision:0,lines:[{position:1,styleNo:"TAKEN-REV-GUARD",alternateStyleNo:null},{position:2,styleNo:"REV-DUP-B",alternateStyleNo:null}]};
    const key=randomUUID();
    await expect(service.reviseStyles(managerActor(),id,cross,key)).rejects.toMatchObject({code:"STYLE_NUMBER_EXISTS"});
    const accepted=await service.reviseStyles(managerActor(),id,{...cross,confirmedDuplicateStyles:["taken-rev-guard"]},key);
    expect(accepted.value.identityRevision).toBe(1);
    expect((await service.reviseStyles(managerActor(),id,cross,key)).reused).toBe(true);
  });

  it("serializes simultaneous cross-order style checks instead of accepting both silently", async () => {
    const input={gender:"男装" as const,styleName:"并发款号查重",estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-10",
      lineItems:[{styleNo:"CONCURRENT-DUP-GUARD",color:"黑",quantity:1}],daxingUnitPrice:"7",attachmentIds:[]};
    const results=await Promise.allSettled([service.createCase(merchandiserActor(),input,randomUUID()),service.createCase(merchandiserActor(),input,randomUUID())]);
    expect(results.filter(result => result.status==="fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status==="rejected")).toMatchObject({reason:{code:"STYLE_NUMBER_EXISTS"}});
  });

  it("requires management reasons only above matching IE prices without offsetting other reductions", async () => {
    const make = async (suffix: string) => {
      const created = await service.createCase(merchandiserActor(), {
        gender: "男装", styleName: "说明边界验证", estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-10-10",
        lineItems: [1,2].map(position => ({styleNo:`REASON-${suffix}-${position}`,color:"蓝",quantity:10})),
        daxingUnitPrice:"8",attachmentIds:[],
      },randomUUID());
      const id = created.value.sourcingCaseId;
      await service.quoteIePrice(ieActor(),id,{linePrices:[{position:1,unitPrice:"17"},{position:2,unitPrice:"20"}]},randomUUID());
      return id;
    };
    const base = {supplierId:factoryId,craftIds:[craftId("净色车缝")]};
    for (const [suffix,price,reason] of [["lower","10.8",undefined],["equal","17.0000",undefined],["voluntary","10.8","主动记录降价原因"]] as const) {
      const id = await make(suffix);
      const result = await service.recordManagementDecision(managerActor(),id,{
        ...base,linePrices:[{position:2,unitPrice:"20.00"},{position:1,unitPrice:price}],
        ...(reason ? {decisionReason:reason} : {}),
      },randomUUID());
      expect(result.value.status).toBe("pending_owner_approval");
      expect(result.value.decision?.decisionReason).toBe(reason ?? "生产管理确认加工厂与价格");
      if (price === "10.8") expect(result.value.decision?.linePrices[0]?.unitPrice).not.toBe(result.value.ieQuote?.linePrices[0]?.unitPrice);
    }
    const id = await make("mixed");
    // Total falls from 370 to 180.10, but the first line still rises by 0.01.
    const input = {...base,linePrices:[{position:2,unitPrice:"1"},{position:1,unitPrice:"17.01"}]};
    for (const reason of [undefined,"   "]) {
      await expect(service.recordManagementDecision(managerActor(),id,{...input,...(reason ? {decisionReason:reason} : {})},randomUUID()))
        .rejects.toMatchObject({statusCode:400,message:"价格高于 IE，请填写原因"});
    }
    expect((await service.getCase(readerActor(),id)).decision).toBeNull();
    await expect(service.recordManagementDecision(managerActor(),id,{...base,linePrices:[{position:1,unitPrice:"1"}]},randomUUID()))
      .rejects.toMatchObject({statusCode:400});
    for (const invalid of ["10.8元","0","-1"]) {
      await expect(service.recordManagementDecision(managerActor(),id,{...base,linePrices:[{position:1,unitPrice:invalid},{position:2,unitPrice:"1"}]},randomUUID()))
        .rejects.toMatchObject({statusCode:400});
    }
    const result = await service.recordManagementDecision(managerActor(),id,{...input,decisionReason:"第一款增加工序"},randomUUID());
    expect(result.value.decision).toMatchObject({totalAmount:"180.10",decisionReason:"第一款增加工序"});
    expect(result.value.status).toBe("pending_owner_approval");
  });

});
