import { SourcingTransferContractReconciliation } from "../../apps/api/src/sourcing/sourcing-transfer-contract-reconciliation.js";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import "./work-analysis-postgres.cases.js";
import { readQuoteAnalysis } from "../../apps/api/src/sourcing/sourcing-analysis.js";
import { ProductionDashboardService } from "../../apps/api/src/sourcing/production-dashboard-service.js";
import { ProductionReportingService } from "../../apps/api/src/sourcing/production-reporting-service.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { CuttingSourceService } from "../../apps/api/src/cutting/cutting-source-service.js";
import { registerCuttingRoutes } from "../../apps/api/src/cutting/cutting-routes.js";
import { registerReceivingRoutes } from "../../apps/api/src/receiving/receiving-routes.js";
import { PostgresAuthStore } from "../../apps/api/src/auth/postgres-store.js";
import { ApplicationError } from "../../apps/api/src/platform/errors.js";
import { ReceivingService } from "../../apps/api/src/receiving/receiving-service.js";
import { SourcingContractService } from "../../apps/api/src/sourcing/sourcing-contract-service.js";
import { SourcingContractReturnService } from "../../apps/api/src/sourcing/sourcing-contract-return-service.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
import { SourcingTodoReconciliationService } from "../../apps/api/src/todos/sourcing-reconciliation-service.js";
import { registerTodoRoutes } from "../../apps/api/src/todos/routes.js";
import { RootAuthority } from "../../apps/api/src/access/root-authority.js";
import Fastify from "fastify";
import { TodoProjectionService } from "../../apps/api/src/todos/projection-service.js";
import { TodoDeliveryWorker } from "../../apps/api/src/todos/delivery-worker.js";
import { FakeDingTalkTodoProvider } from "../../apps/api/src/todos/provider.js";
import { SourcingProductionService } from "../../apps/api/src/sourcing/sourcing-production-service.js";
import { SourcingService } from "../../apps/api/src/sourcing/sourcing-service.js";
import { AttachmentService } from "../../apps/api/src/tools/attachments.js";
import { OperationEventRepository, type TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { FakeObjectStorage } from "../../apps/api/src/tools/storage.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

runWithPostgres("sourcing PR03-PR05 PostgreSQL business chain", () => {
  const schema = ownedPostgresSchema("sourcing");
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
  const contractReturns = new SourcingContractReturnService(database);
  const service = new SourcingService(
    database,undefined,undefined,todoProjection,contractService,
  );
  const cutting = new CuttingSourceService(database);
  const receiving = new ReceivingService(database,undefined,undefined,undefined,{allowLegacyStyleInput:true});
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
  let returnTodoRecipientConfigured = false;
  const ensureReturnTodoRecipient = async () => {
    if (returnTodoRecipientConfigured) return;
    await craftService.ensureOrganizationPolicy();
    await database.query(
      `INSERT INTO identity_mappings(
         id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at
       ) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
      [randomUUID(),merchandiserId,`ding-${merchandiserId}`,`union-${merchandiserId}`],
    );
    await database.query(
      `INSERT INTO identity_mappings(
         id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at
       ) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
      [randomUUID(),ownerId,`ding-${ownerId}`,`union-${ownerId}`],
    );
    await database.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation");
    try {
      await database.query(
        `INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason)
         VALUES($1,$2,'order_merchandiser',$2,'contract return todo fixture')`,
        [randomUUID(),merchandiserId],
      );
    } finally {
      await database.query("ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation");
    }
    returnTodoRecipientConfigured = true;
  };

  const readyCuttingSheet = async (uploadedBy: string): Promise<string> => {
    const attachmentId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,
         uploaded_by,status,ready_at
       ) VALUES($1,$2,'裁床单.png','image/png',128,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [attachmentId, `cutting-sheet/${attachmentId}.png`, "c".repeat(64), uploadedBy],
    );
    return attachmentId;
  };

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
  const warehouseActor = (requestId = randomUUID()): TrustedActorContext => ({
    actorId: ownerId,
    actorRoles: ["warehouse_receiver"],
    authorizationCapability: "receiving:create",
    authorizationCapabilities: ["receiving:create"],
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

  it("registers the assignable warehouse supervisor with exactly current receiver grants plus cutting view", async () => {
    const role = (await craftService.listRoles()).find(item => item.roleCode === "warehouse_supervisor");
    expect(role).toMatchObject({ displayName: "仓库主管" });
    const receiverGrants = (await craftService.listRoles()).find(item => item.roleCode === "warehouse_receiver")!.capabilities;
    expect(receiverGrants).toEqual(["receiving:create", "receiving:packing_manage", "tools:user"]);
    expect(role!.capabilities).toEqual([...receiverGrants, "cutting:orders:view"].sort());
    expect((await database.query("SELECT 1 FROM user_role_assignments WHERE role_code='warehouse_supervisor'")).rowCount).toBe(0);
    for (const name of ["business_roles_no_insert", "role_capabilities_no_insert"]) {
      expect((await database.query("SELECT tgenabled FROM pg_trigger WHERE tgname=$1 AND tgrelid IN ('business_roles'::regclass,'role_capabilities'::regclass)", [name])).rows).toEqual([{ tgenabled: "O" }]);
    }
  });

  it("backfills missing historical approved cutting tasks without duplicating existing or deleted sources", async () => {
    const makeApproved = async (
      suffix: string,
      lineCount: 1 | 2,
    ): Promise<string> => {
      const lines = Array.from({ length: lineCount }, (_value, index) => ({
        styleNo: `CUT-HISTORY-${suffix}-${index + 1}`,
        color: index === 0 ? "黑色" : "米白",
        quantity: 100 + index,
      }));
      const created = await service.createCase(merchandiserActor(), {
        gender: "男装" as const,
        styleName: "历史裁床补任务测试",
        estimatedCutPieceSendDate: "2026-10-01",
        deliveryDate: "2026-10-12",
        lineItems: lines,
        daxingUnitPrice: "7.0000",
        attachmentIds: [],
      }, randomUUID());
      await service.quoteIePrice(
        ieActor(),
        created.value.sourcingCaseId,
        {
          linePrices: lines.map((_line, index) => ({
            position: index + 1,
            unitPrice: "8.5000",
          })),
        },
        randomUUID(),
      );
      await service.recordManagementDecision(
        managerActor(),
        created.value.sourcingCaseId,
        {
          supplierId: factoryId,
          craftIds: [craftId("净色车缝")],
          linePrices: lines.map((_line, index) => ({
            position: index + 1,
            unitPrice: "8.5000",
          })),
        },
        randomUUID(),
      );
      await service.decideOwner(
        ownerActor(),
        created.value.sourcingCaseId,
        { decision: "approved" },
        randomUUID(),
      );
      return created.value.sourcingCaseId;
    };

    const activeCaseId = await makeApproved("ACTIVE", 2);
    const original = await database.query<{
      cutting_order_id: string;
      sourcing_line_position: number;
    }>(
      `SELECT cutting_order_id,sourcing_line_position
       FROM cutting_orders
       WHERE sourcing_case_id=$1
       ORDER BY sourcing_line_position`,
      [activeCaseId],
    );
    expect(original.rows).toHaveLength(2);
    const preserved = original.rows[0]!;
    const removed = original.rows[1]!;

    await database.query("ALTER TABLE cutting_orders DISABLE TRIGGER cutting_orders_no_delete");
    try {
      await database.query(
        "DELETE FROM cutting_orders WHERE cutting_order_id=$1",
        [removed.cutting_order_id],
      );
    } finally {
      await database.query("ALTER TABLE cutting_orders ENABLE TRIGGER cutting_orders_no_delete");
    }

    const deletedCaseId = await makeApproved("DELETED", 1);
    const deletedTask = await database.query<{ cutting_order_id: string }>(
      "SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1",
      [deletedCaseId],
    );
    await database.query("ALTER TABLE cutting_orders DISABLE TRIGGER cutting_orders_no_delete");
    try {
      await database.query(
        "DELETE FROM cutting_orders WHERE cutting_order_id=$1",
        [deletedTask.rows[0]!.cutting_order_id],
      );
    } finally {
      await database.query("ALTER TABLE cutting_orders ENABLE TRIGGER cutting_orders_no_delete");
    }
    await service.deleteByRoot(rootActor(), deletedCaseId, randomUUID());

    const migration = await readFile(
      new URL("../../apps/api/migrations/0200_cutting_historical_approved_backfill.sql", import.meta.url),
      "utf8",
    );
    await database.query(migration);

    const restored = await database.query<{
      cutting_order_id: string;
      sourcing_line_position: number;
    }>(
      `SELECT cutting_order_id,sourcing_line_position
       FROM cutting_orders
       WHERE sourcing_case_id=$1
       ORDER BY sourcing_line_position`,
      [activeCaseId],
    );
    expect(restored.rows).toHaveLength(2);
    expect(restored.rows[0]).toEqual(preserved);
    expect(restored.rows[1]?.sourcing_line_position).toBe(removed.sourcing_line_position);
    expect(restored.rows[1]?.cutting_order_id).not.toBe(removed.cutting_order_id);
    expect((await database.query(
      "SELECT 1 FROM cutting_orders WHERE sourcing_case_id=$1",
      [deletedCaseId],
    )).rowCount).toBe(0);
    expect((await database.query(
      `SELECT 1
       FROM cutting_records record
       JOIN cutting_orders cutting USING(cutting_order_id)
       WHERE cutting.sourcing_case_id=$1`,
      [activeCaseId],
    )).rowCount).toBe(0);

    await database.query(migration);
    expect((await database.query(
      "SELECT count(*)::integer AS count FROM cutting_orders WHERE sourcing_case_id=$1",
      [activeCaseId],
    )).rows[0]?.count).toBe(2);

    // Keep this fixture isolated from later list/search assertions in this shared suite.
    await service.deleteByRoot(rootActor(), activeCaseId, randomUUID());
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
      { pieceCount: 100, actualCutCount: 100, attachmentIds: [randomUUID()] },
      randomUUID(),
    )).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect((await database.query(
      "SELECT 1 FROM cutting_records WHERE cutting_order_id=$1",
      [stalePending.cuttingOrderId],
    )).rowCount).toBe(0);

    const staleCorrection = await makeApproved("CORRECTION");
    const staleCorrectionSheet = await readyCuttingSheet(ownerId);
    await cutting.record(
      cuttingSupervisorActor(),
      staleCorrection.cuttingOrderId,
      { pieceCount: 100, actualCutCount: 100, attachmentIds: [staleCorrectionSheet] },
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
    expect((await database.query(
      "SELECT 1 FROM sourcing_cases WHERE sourcing_case_id=$1",
      [created.value.sourcingCaseId],
    )).rowCount).toBe(1);
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

    const classified = await service.listCases(readerActor(), "", "pending", 1, {
      stage: "management",
      gender: "男装",
      styleName: "梭织",
    });
    expect(classified.items).toHaveLength(1);
    expect(classified.items[0]?.sourcingCaseId).toBe(created.value.sourcingCaseId);
    expect((await service.listCases(readerActor(), "", "pending", 1, { stage: "ie" })).items).toHaveLength(0);
    expect((await service.listCases(readerActor(), "", "pending", 1, { gender: "女装" })).items).toHaveLength(0);
    expect((await service.listCases(readerActor(), "", "pending", 1, { styleName: "不存在的款式" })).items).toHaveLength(0);

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
      contractVersion: 2,templateVersion: 4,status: "ready",missingFields: [],
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
      contractVersion: 3,status: "ready",missingFields: [],failureReason:null,
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

    // Historical pages must survive rejection/repricing, transfer and later finance closure.
    const historyCaseId = created.value.sourcingCaseId;
    const creationHistory = await service.nodeHistory(readerActor(), historyCaseId, "created");
    expect(creationHistory.item.ieQuote).toBeNull();
    expect(creationHistory.item.decision).toBeNull();
    expect(creationHistory.item.processes).toEqual([]);
    expect(creationHistory.attachments.map(image => image.attachmentId)).toContain(evidenceId);
    const quoteHistory = await service.nodeHistory(readerActor(), historyCaseId, "ie_quote");
    expect(quoteHistory.item.ieQuote?.totalAmount).toBe("1481.46");
    expect(quoteHistory.item.decision).toBeNull();
    const firstHistory = await service.nodeHistory(readerActor(), historyCaseId, "management", firstDecision.value.decision!.sourcingDecisionId);
    expect(firstHistory.item.decision?.totalAmount).toBe("1507.00");
    expect(firstHistory.item.ownerDecision).toBeNull();
    expect(firstHistory.versions).toHaveLength(3);
    expect(firstHistory.relatedEntries.filter(record => record.kind === "factory_change_request")).toHaveLength(2);
    expect(firstHistory.relatedEntries).toEqual(expect.arrayContaining([expect.objectContaining({kind: "factory_change_verification", decision: "rejected"})]));
    const rejectedHistory = await service.nodeHistory(readerActor(), historyCaseId, "owner", rejected.value.ownerDecision!.sourcingOwnerDecisionId);
    expect(rejectedHistory.item.ownerDecision?.decision).toBe("rejected");
    expect(rejectedHistory.item.decision?.totalAmount).toBe("1507.00");
    expect(rejectedHistory.item.approvalSnapshot).toBeNull();
    const financeHistory = await service.nodeHistory(readerActor(), historyCaseId, "finance");
    expect(financeHistory.entry.result).toBe("match");
    expect(financeHistory.item.decision?.supplierId).toBe(replacementFactoryId);
    expect(await service.nodeHistory(unrelatedReaderActor(), historyCaseId, "ie_quote")).not.toHaveProperty("item.daxingUnitPrice");
    await expect(service.nodeHistory({ ...readerActor(), authorizationCapabilities: [] }, historyCaseId, "ie_quote")).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.nodeHistory(readerActor(), historyCaseId, "owner", randomUUID())).rejects.toMatchObject({ statusCode: 404 });


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
        `sourcing:${created.value.sourcingCaseId}:ie_quote:`,
        `sourcing:${created.value.sourcingCaseId}:management:`,
        `sourcing:${created.value.sourcingCaseId}:owner:1:`,
        `sourcing:${created.value.sourcingCaseId}:management:`,
        `sourcing:${created.value.sourcingCaseId}:owner:2:`,
        `sourcing:${created.value.sourcingCaseId}:return:`,
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
    expect(changedContract).toMatchObject({status:"ready",failureReason:null});
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
    expect(original).toMatchObject({ templateVersion: 4, status: "ready" });
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
    await expect(cutting.record(cuttingWorkerActor(),stableCuttingOrderId,{pieceCount:120,actualCutCount:20,attachmentIds:[randomUUID()]},randomUUID()))
      .rejects.toMatchObject({code:"INVALID_STATE_TRANSITION"});
    await expect(cutting.record(cuttingOwnerActor(),stableCuttingOrderId,{pieceCount:120,actualCutCount:20,attachmentIds:[randomUUID()]},randomUUID()))
      .rejects.toMatchObject({statusCode:403});
    generate.mockRestore();
    await expect(service.reviseStyles(merchandiserActor(),id,edit,randomUUID())).rejects.toMatchObject({code:"INVALID_STATE_TRANSITION"});
    await contractService.generateIfReady(contractActor(),id);
    const first=await service.reviseStyles(merchandiserActor(),id,edit,randomUUID());
    expect(first.value).toMatchObject({styleNo:"FINAL-PR03",identityRevision:1,status:"pending_finance_reconciliation"});
    const formalCutting=(await cutting.listSources(cuttingOwnerActor())).items.find(item=>item.sourcingCaseId===id)!;
    expect(formalCutting).toMatchObject({cuttingOrderId:stableCuttingOrderId,formalStyleNo:"FINAL-PR03",displayStyleNo:"FINAL-PR03"});
    expect((await database.query("SELECT 1 FROM cutting_orders WHERE sourcing_case_id=$1",[id])).rowCount).toBe(1);
    const supervisorSheet=await readyCuttingSheet(ownerId);
    const workerSheet=await readyCuttingSheet(managerId);
    const concurrentRecords=await Promise.all([
      cutting.record(cuttingSupervisorActor(),stableCuttingOrderId,{pieceCount:120,actualCutCount:20,attachmentIds:[supervisorSheet]},randomUUID()),
      cutting.record(cuttingWorkerActor(),stableCuttingOrderId,{pieceCount:121,actualCutCount:20,attachmentIds:[workerSheet]},randomUUID()),
    ]);
    expect(concurrentRecords.map(result=>result.value.outcome).sort()).toEqual(["already_recorded","created"]);
    const recorded=await cutting.get(cuttingOwnerActor(),stableCuttingOrderId);
    expect(recorded).toMatchObject({status:"recorded",actualCutCount:20,outOfRange:false,record:{version:1,actualCutCount:20,corrected:false,cuttingSheetPhotos:[expect.objectContaining({mimeType:"image/png"})]}});
    expect(recorded.record!.cuttingSheetPhotos).toHaveLength(1);
    const recordedSheetId=recorded.record!.cuttingSheetPhotos[0]!.attachmentId;
    await expect(database.query("DELETE FROM attachments WHERE attachment_id=$1",[recordedSheetId]))
      .rejects.toMatchObject({code:"55000"});
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
    const suffixOptions=await receiving.listCuttingOptions("PR03");
    expect(suffixOptions).toContainEqual(expect.objectContaining({
      cuttingOrderId:stableCuttingOrderId,styleNo:"REVISED-PR03",actualCutCount:22,
    }));
    expect(await receiving.listCuttingOptions("R03")).toEqual([]);
    const deliveryAttachmentId=randomUUID();
    await database.query(`INSERT INTO attachments(
      attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,
      uploaded_by,status,ready_at
    ) VALUES($1,$2,'仓库送货单.jpg','image/jpeg',128,$3,$4,'ready',CURRENT_TIMESTAMP)`,[
      deliveryAttachmentId,`receiving-pr03/${deliveryAttachmentId}.jpg`,"b".repeat(64),ownerId,
    ]);
    const firstReceipt=await receiving.create(warehouseActor(),{
      cuttingOrderId:stableCuttingOrderId,documentQuantity:20,actualQuantity:19,
      defectiveQuantity:1,attachmentIds:[deliveryAttachmentId],
    },randomUUID());
    expect(firstReceipt.value).toMatchObject({styleNo:"REVISED-PR03",documentQuantity:20,actualQuantity:19});
    expect((await database.query("SELECT cutting_order_id FROM receiving_receipts WHERE receipt_id=$1",[firstReceipt.value.receiptId])).rows[0]!.cutting_order_id)
      .toBe(stableCuttingOrderId);
    const repeatOptions=await receiving.listRepeatOptions("PR03");
    expect(repeatOptions).toContainEqual(expect.objectContaining({
      receivingBatchId:firstReceipt.value.receivingBatchId,cuttingOrderId:stableCuttingOrderId,
      styleNo:"REVISED-PR03",actualCutCount:22,
    }));
    const jiashun=await receiving.createRepeated(warehouseActor(),{
      cuttingOrderId:stableCuttingOrderId,receivingBatchId:firstReceipt.value.receivingBatchId,
      source:"jiashun",actualQuantity:1,defectiveQuantity:0,
    },randomUUID());
    expect(jiashun.value.styleNo).toBe("REVISED-PR03");
    const otherFactory=await receiving.createRepeated(warehouseActor(),{
      cuttingOrderId:stableCuttingOrderId,receivingBatchId:firstReceipt.value.receivingBatchId,
      source:"other_factory",documentQuantity:2,actualQuantity:2,defectiveQuantity:0,
    },randomUUID());
    expect(otherFactory.value).toMatchObject({styleNo:"REVISED-PR03",documentQuantity:2,actualQuantity:2});

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

  it("keeps subsequently supplemented photos out of the earlier node page", async () => {
    const initialImage = await readyCuttingSheet(merchandiserId);
    const created = await service.createCase(merchandiserActor(), {
      gender: "女装", styleName: "历史图片", estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-10-10",
      lineItems: [{styleNo: "HISTORY-PHOTOS", color: "蓝", quantity: 20}], daxingUnitPrice: "7.00", attachmentIds: [initialImage],
    }, randomUUID());
    const id = created.value.sourcingCaseId;
    await expect(service.nodeHistory(readerActor(), id, "ie_quote")).rejects.toMatchObject({ statusCode: 404 });
    await service.quoteIePrice(ieActor(), id, {linePrices: [{position: 1, unitPrice: "8.50"}]}, randomUUID());
    const laterImage = await readyCuttingSheet(merchandiserId);
    await service.supplementImages({...merchandiserActor(), actorRoles: ["root_superuser"], authorizationCapability: "tools:user"}, id, { attachmentIds: [laterImage] }, randomUUID());
    expect((await service.listAttachments(readerActor(), id)).items).toHaveLength(2);
    expect((await service.nodeHistory(readerActor(), id, "created")).attachments.map(image => image.attachmentId)).toEqual([initialImage]);
    expect((await service.nodeHistory(readerActor(), id, "ie_quote")).attachments.map(image => image.attachmentId)).toEqual([initialImage]);
  });

  it.each(["expand", "reduce-reorder"] as const)("approves %s corrected lines against immutable approval identity, preserving creation and dispatch", async (mode) => {
    const image=await readyCuttingSheet(merchandiserId);
    const prefix=`CUT-CORRECTION-${mode}`;
    const originalLines=mode==='expand' ? [{styleNo:`${prefix}-ORIGINAL`,color:"原色",quantity:100}]
      : [1,2,3,4].map(n=>({styleNo:`${prefix}-${n}`,color:`原色${n}`,quantity:100}));
    const original={gender:"男装" as const,styleName:"裁床纠错批准回归",estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-20",
      lineItems:originalLines,daxingUnitPrice:"8",attachmentIds:[image]};
    const created=await service.createCase(merchandiserActor(),original,randomUUID());
    const id=created.value.sourcingCaseId;
    const before=await database.query("SELECT * FROM sourcing_case_lines WHERE sourcing_case_id=$1 ORDER BY position",[id]);
    const returned=await service.returnToMerchandiser(ownerActor(),id,{expectedVersion:created.value.version,reason:"核实款色后纠错"},randomUUID());
    const correctedLines=mode==='expand' ? [200,200,400,200].map((quantity,index)=>({styleNo:`${prefix}-${index+1}`,color:["暗红","白","黑","蓝"][index]!,quantity}))
      : [{...originalLines[3]!,quantity:150,color:"新蓝"},{...originalLines[0]!,quantity:250,color:"新白"}];
    await service.correctCase(merchandiserActor(),id,{gender:original.gender,styleName:original.styleName,
      estimatedCutPieceSendDate:original.estimatedCutPieceSendDate,deliveryDate:original.deliveryDate,lineItems:correctedLines,attachmentIds:[image],
      expectedVersion:returned.value.version,reason:"按核实明细重新报价"},randomUUID());
    const prices=correctedLines.map((_line,index)=>({position:index+1,unitPrice:"12.8"}));
    await service.quoteIePrice(ieActor(),id,{linePrices:prices.map(line=>({...line,unitPrice:"14"}))},randomUUID());
    await service.recordManagementDecision(managerActor(),id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:prices},randomUUID());
    const key=randomUUID();
    if(mode==='expand') {
      // Reproduce the shipped pre-0222 FK shape only in this owned synthetic schema.
      const historicalCutting=(await database.query("SELECT * FROM cutting_orders ORDER BY cutting_order_id")).rows;
      await database.query(`ALTER TABLE cutting_orders ADD CONSTRAINT cutting_orders_sourcing_case_id_sourcing_line_position_fkey
        FOREIGN KEY(sourcing_case_id,sourcing_line_position) REFERENCES sourcing_case_lines(sourcing_case_id,position) NOT VALID`);
      await database.query("ALTER TABLE cutting_orders DROP CONSTRAINT cutting_orders_approval_case_identity_fkey");
      await database.query("ALTER TABLE sourcing_approval_snapshots DROP CONSTRAINT sourcing_approval_snapshots_case_identity");
      try {
        await expect(service.decideOwner(ownerActor(),id,{decision:"approved"},key)).rejects.toMatchObject({code:"23503",constraint:"cutting_orders_sourcing_case_id_sourcing_line_position_fkey"});
        expect((await service.getCase(readerActor(),id)).status).toBe("pending_owner_approval");
        for(const table of ['sourcing_owner_decisions','sourcing_approval_snapshots','cutting_orders'])
          expect((await database.query(`SELECT count(*)::int AS n FROM ${table} WHERE sourcing_case_id=$1`,[id])).rows[0].n).toBe(0);
        expect((await database.query("SELECT count(*)::int AS n FROM operation_events WHERE entity_id=$1 AND action='sourcing.owner.approve'",[id])).rows[0].n).toBe(0);
      } finally {
        await database.query(await readFile(new URL('../../apps/api/migrations/0222_sourcing_cutting_approved_line_identity.sql',import.meta.url),'utf8'));
      }
      expect((await database.query("SELECT * FROM cutting_orders ORDER BY cutting_order_id")).rows).toEqual(historicalCutting);
      const fks=(await database.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='cutting_orders'::regclass AND contype='f'")).rows.map(row=>row.definition);
      expect(fks).toHaveLength(4);
      expect(fks).toContain('FOREIGN KEY (sourcing_case_id, approval_snapshot_id) REFERENCES sourcing_approval_snapshots(sourcing_case_id, sourcing_approval_snapshot_id)');
      expect(fks).toContain('FOREIGN KEY (approval_snapshot_id, sourcing_line_position) REFERENCES sourcing_approval_snapshot_lines(sourcing_approval_snapshot_id, "position")');
    }
    let approved:Awaited<ReturnType<SourcingService['decideOwner']>>;
    try {approved=await service.decideOwner(ownerActor(),id,{decision:"approved"},key);}
    catch(error) {
      expect((await service.getCase(readerActor(),id)).status).toBe("pending_owner_approval");
      for(const table of ['sourcing_owner_decisions','sourcing_approval_snapshots','cutting_orders'])
        expect((await database.query(`SELECT count(*)::int AS n FROM ${table} WHERE sourcing_case_id=$1`,[id])).rows[0].n).toBe(0);
      expect((await database.query("SELECT count(*)::int AS n FROM operation_events WHERE entity_id=$1 AND action='sourcing.owner.approve'",[id])).rows[0].n).toBe(0);
      throw error;
    }
    expect((await database.query("SELECT * FROM sourcing_case_lines WHERE sourcing_case_id=$1 ORDER BY position",[id])).rows).toEqual(before.rows);
    expect(approved.value.approvalSnapshot?.quantity).toBe(correctedLines.reduce((sum,line)=>sum+line.quantity,0));
    const retry=await service.decideOwner(ownerActor(),id,{decision:"approved"},key);
    expect(retry.reused).toBe(true);
    const cuttingRows=(await database.query("SELECT cutting_order_id,sourcing_line_position,approval_snapshot_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position",[id])).rows;
    expect(cuttingRows.map(line=>line.sourcing_line_position)).toEqual(prices.map(line=>line.position));
    expect((await cutting.listSources(cuttingOwnerActor())).items.filter(row=>row.sourcingCaseId===id)).toHaveLength(correctedLines.length);
    const contract=(await contractService.getCurrent(readerActor(),id)).item!;
    expect(contract.status).toBe("ready");
    const dispatch=await production.dispatch(contractActor(),id,{sourcingContractDocumentId:contract.sourcingContractDocumentId,confirmed:true},randomUUID());
    expect(dispatch.value.lines.map(line=>({styleNo:line.styleNo,quantity:line.quantity}))).toEqual(correctedLines.map(line=>({styleNo:line.styleNo,quantity:line.quantity})));
    expect((await database.query("SELECT cutting_order_id,sourcing_line_position,approval_snapshot_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position",[id])).rows).toEqual(cuttingRows);
    const other=await service.createCase(merchandiserActor(),{...original,attachmentIds:[],lineItems:[{styleNo:`${prefix}-OTHER`,color:"黑",quantity:1}]},randomUUID());
    await expect(database.query("INSERT INTO cutting_orders(cutting_order_id,sourcing_case_id,sourcing_line_position,approval_snapshot_id) VALUES($1,$2,1,$3)",
      [randomUUID(),other.value.sourcingCaseId,cuttingRows[0].approval_snapshot_id])).rejects.toMatchObject({code:"55000"});
    await expect(database.query("INSERT INTO cutting_orders(cutting_order_id,sourcing_case_id,sourcing_line_position,approval_snapshot_id) VALUES($1,$2,20,$3)",
      [randomUUID(),id,cuttingRows[0].approval_snapshot_id])).rejects.toMatchObject({code:"55000"});
  });

  it("returns an unapproved order for versioned correction and reapproval", async () => {
    const image = await readyCuttingSheet(merchandiserId);
    const replacementImage = await readyCuttingSheet(merchandiserId);
    const original = {gender:"男装" as const,styleName:"纠错测试",estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-12",lineItems:[{styleNo:"CORRECTION-01",color:"黑",quantity:100}],daxingUnitPrice:"7",attachmentIds:[image]};
    const created = await service.createCase(merchandiserActor(),original,randomUUID());
    const id = created.value.sourcingCaseId;
    const quoted = await service.quoteIePrice(ieActor(),id,{linePrices:[{position:1,unitPrice:"8.5"}]},randomUUID());
    await expect(service.returnToMerchandiser(merchandiserActor(),id,{expectedVersion:quoted.value.version,reason:"日期和数量有误"},randomUUID())).rejects.toThrow();
    const returnKey=randomUUID(); const returnInput={expectedVersion:quoted.value.version,reason:"日期和数量有误"};
    const returned=await service.returnToMerchandiser(ownerActor(),id,returnInput,returnKey);
    expect(returned.value.status).toBe("pending_merchandiser_correction");
    expect((await service.returnToMerchandiser(ownerActor(),id,returnInput,returnKey)).reused).toBe(true);
    const facts={...original,attachmentIds:[replacementImage]};
    Reflect.deleteProperty(facts,"daxingUnitPrice");
    const correction={...facts,expectedVersion:returned.value.version,reason:"核实后修改",estimatedCutPieceSendDate:"2026-10-02",lineItems:[{styleNo:"CORRECTION-01",color:"白",quantity:120}]};
    await expect(service.correctCase(merchandiserActor(),id,{...correction,deliveryDate:"2026-09-30"},randomUUID())).rejects.toThrow();
    const key=randomUUID();const corrected=await service.correctCase(merchandiserActor(),id,correction,key);
    expect(corrected.value.status).toBe("pending_ie_quote");
    expect(corrected.value.orderQuantity).toBe(120);
    expect((await service.listAttachments(readerActor(),id)).items.map(photo=>photo.attachmentId)).toEqual([replacementImage]);
    expect((await service.listCases(readerActor(),"CORRECTION-01")).items[0]?.firstImageAttachmentId).toBe(replacementImage);
    expect((await database.query("SELECT entity_id FROM attachments WHERE attachment_id=$1",[image])).rows[0]?.entity_id).toBe(id);
    expect((await service.correctCase(merchandiserActor(),id,correction,key)).reused).toBe(true);
    expect((await database.query("SELECT order_quantity FROM sourcing_cases WHERE sourcing_case_id=$1",[id])).rows[0].order_quantity).toBe(100);
    await service.quoteIePrice(ieActor(),id,{linePrices:[{position:1,unitPrice:"9"}]},randomUUID());
    await service.recordManagementDecision(managerActor(),id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:[{position:1,unitPrice:"9"}]},randomUUID());
    const current=await service.getCase(readerActor(),id);
    const secondReturn=await service.returnToMerchandiser(ownerActor(),id,{expectedVersion:current.version,reason:"再次核实颜色"},randomUUID());
    expect(secondReturn.value.ieQuote).toBeNull();
    expect(secondReturn.value.decision).toBeNull();
    const listed=await service.listCases(readerActor(),"CORRECTION-01");
    expect(listed.items[0]?.ieQuote).toBeNull();
    expect(listed.items[0]?.decision).toBeNull();
    const originalHistory=await service.nodeHistory(readerActor(),id,"created",id);
    expect(originalHistory.item.orderQuantity).toBe(100);
    expect(originalHistory.item.lineItems[0]?.color).toBe("黑");
    const firstQuoteHistory=await service.nodeHistory(readerActor(),id,"ie_quote",quoted.value.ieQuote!.sourcingIeQuoteId);
    expect(firstQuoteHistory.item.ieQuote?.quantity).toBe(100);
    await service.correctCase(merchandiserActor(),id,{...correction,expectedVersion:secondReturn.value.version},randomUUID());
    await service.quoteIePrice(ieActor(),id,{linePrices:[{position:1,unitPrice:"9"}]},randomUUID());
    await service.recordManagementDecision(managerActor(),id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:[{position:1,unitPrice:"9"}]},randomUUID());
    const approved=await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
    expect(approved.value.orderQuantity).toBe(120);
    expect(approved.value.approvalSnapshot?.estimatedCutPieceSendDate).toBe("2026-10-02");
    expect(approved.value.approvalSnapshot?.quantity).toBe(120);
    expect(approved.value.createdAt).toBe(created.value.createdAt);
    await expect(service.returnToMerchandiser(ownerActor(),id,{expectedVersion:approved.value.version,reason:"不能直接改批准事实"},randomUUID())).rejects.toThrow();
  });


  it("skips Shanghai Sundays for both deadline and elapsed hours", async () => {
    const samples: [string,string][] = [
      ["2026-09-25T02:00:00Z","2026-09-28T02:00:00.000Z"],
      ["2026-09-26T02:00:00Z","2026-09-29T02:00:00.000Z"],
      ["2026-09-27T02:00:00Z","2026-09-29T16:00:00.000Z"],
      ["2026-09-25T16:00:00Z","2026-09-28T16:00:00.000Z"],
    ];
    for (const [start,expected] of samples) {
      const result = await database.query<{due: Date}>(
        "SELECT sourcing_contract_return_add_hours($1::timestamptz,48) AS due",[start],
      );
      expect(result.rows[0]?.due.toISOString()).toBe(expected);
    }
    const elapsed = await database.query<{saturday: string;sunday: string;monday: string}>(`
      SELECT sourcing_contract_return_elapsed_seconds('2026-09-26T15:00:00Z','2026-09-26T15:59:59Z')::text AS saturday,
             sourcing_contract_return_elapsed_seconds('2026-09-26T15:00:00Z','2026-09-27T15:00:00Z')::text AS sunday,
             sourcing_contract_return_elapsed_seconds('2026-09-26T15:00:00Z','2026-09-27T17:00:00Z')::text AS monday
    `);
    expect(elapsed.rows[0]).toEqual({saturday:"3599",sunday:"3600",monday:"7200"});
    const midnight = await database.query<{due: Date}>(
      "SELECT sourcing_contract_return_add_hours('2026-09-25T16:00:00Z'::timestamptz,24) AS due",
    );
    expect(midnight.rows[0]?.due.toISOString()).toBe("2026-09-27T16:00:00.000Z");
  });

  it("covers approved orders without a date cutoff and backfills every missing historic monitor", async () => {
    const makeApproved = async (styleNo: string) => {
      const created = await service.createCase(merchandiserActor(), {
        gender: "女装",styleName: "回签测试",estimatedCutPieceSendDate: "2026-10-01",
        deliveryDate: "2026-10-20",lineItems: [{styleNo,color:"黑",quantity:20}],
        daxingUnitPrice: "8",
      },randomUUID());
      const id = created.value.sourcingCaseId;
      await service.quoteIePrice(ieActor(),id,{linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
      await service.recordManagementDecision(managerActor(),id,{
        supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:[{position:1,unitPrice:"10"}],
      },randomUUID());
      await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
      return id;
    };
    const unapproved = await service.createCase(merchandiserActor(), {
      gender:"女装",styleName:"待审批订单",estimatedCutPieceSendDate:"2026-10-01",
      deliveryDate:"2026-10-20",lineItems:[{styleNo:"RETURN-UNAPPROVED",color:"黑",quantity:20}],
      daxingUnitPrice:"8",
    },randomUUID());
    expect((await service.getCase(readerActor(),unapproved.value.sourcingCaseId)).contractReturnMonitoring).toBe(false);
    const active = await makeApproved("RETURN-ACTIVE");
    const first = await service.getCase(readerActor(),active);
    expect(first.contractReturnMonitoring).toBe(true);
    expect(first.contractReturnStatus).toBe("pending");
    if (first.contractGeneratedAt) {
      const authoritative = await database.query<{due:Date}>(
        "SELECT sourcing_contract_return_add_hours($1::timestamptz,48) AS due",[first.contractGeneratedAt]);
      expect(first.contractReturnDueAt).toBe(authoritative.rows[0]?.due.toISOString());
    }
    expect((await service.listCases(readerActor(),"RETURN-ACTIVE","all",1,{contractReturn:"all"}))
      .items.map(item=>item.sourcingCaseId)).toContain(active);

    // A previously unmonitored approved order keeps its first ready PDF clock.
    const legacy = await makeApproved("RETURN-HISTORIC");
    const historicPdf = (await contractService.getCurrent(readerActor(),legacy)).item?.generatedAt;
    await database.query("DELETE FROM sourcing_contract_return_monitors WHERE sourcing_case_id=$1",[legacy]);
    expect((await service.getCase(readerActor(),legacy)).contractReturnMonitoring).toBe(false);
    const migration = await readFile(new URL(
      "../../apps/api/migrations/0210_sourcing_contract_return_all_existing.sql",import.meta.url),"utf8");
    const backfill = migration.slice(migration.indexOf("WITH qualifying AS MATERIALIZED"));
    await database.query(backfill);
    const historic = await service.getCase(readerActor(),legacy);
    expect(historic.contractReturnMonitoring).toBe(true);
    expect(historic.contractReturnStatus).toBe("pending");
    expect(historic.contractGeneratedAt).toBe(historicPdf ?? null);
    expect(historic.contractReturnDueAt).toBe(historicPdf
      ? (await database.query<{due:Date}>(
        "SELECT sourcing_contract_return_add_hours($1::timestamptz,48) AS due",[historicPdf])).rows[0]!.due.toISOString()
      : null);
    expect((await contractReturns.get({...rootActor(),authorizationCapability:"sourcing:view"},legacy)).canUpload).toBe(true);
    expect((await service.listCases(readerActor(),"RETURN-HISTORIC","all",1,{contractReturn:"all"}))
      .items.map(item=>item.sourcingCaseId)).toContain(legacy);
    expect((await service.listCases(readerActor(),"RETURN-HISTORIC","all",1,{contractReturn:"all_overdue"}))
      .items.map(item=>item.sourcingCaseId)).not.toContain(legacy);
    await database.query(`UPDATE sourcing_contract_return_monitors
      SET contract_generated_at='2026-09-15T00:00:00Z',
          contract_return_due_at=sourcing_contract_return_add_hours('2026-09-15T00:00:00Z'::timestamptz,48)
      WHERE sourcing_case_id=$1`,[legacy]);
    expect((await service.getCase(readerActor(),legacy)).contractReturnStatus).toBe("overdue_pending");
    expect((await service.listCases(readerActor(),"RETURN-HISTORIC","all",1,{contractReturn:"all_overdue"}))
      .items.map(item=>item.sourcingCaseId)).toContain(legacy);
    await database.query(await readFile(new URL(
      "../../apps/api/migrations/0212_sourcing_contract_return_historic_deadlines.sql",import.meta.url),"utf8"));
    expect((await database.query<{contract_return_catchup:boolean}>(
      "SELECT contract_return_catchup FROM sourcing_contract_return_monitors WHERE sourcing_case_id=$1",[legacy]))
      .rows[0]?.contract_return_catchup).toBe(false);
    await database.query(backfill);
    expect((await service.getCase(readerActor(),legacy)).contractReturnStatus).toBe("overdue_pending");
    expect((await database.query("SELECT count(*)::int AS count FROM sourcing_contract_return_monitors WHERE sourcing_case_id=$1",[legacy])).rows[0]?.count).toBe(1);

    // A signed attachment is accepted even if the first PDF clock is not ready.
    const pendingPdf = await makeApproved("RETURN-NO-PDF");
    await database.query(`UPDATE sourcing_contract_return_monitors
      SET contract_generated_at=NULL,contract_return_due_at=NULL WHERE sourcing_case_id=$1`,[pendingPdf]);
    const beforePdf = await contractReturns.get({...rootActor(),authorizationCapability:"sourcing:view"},pendingPdf);
    expect(beforePdf).toMatchObject({contractReturnMonitoring:true,contractReturnStatus:"pending",canUpload:true});
    const attachmentId=randomUUID();
    await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,
      size_bytes,sha256,uploaded_by,status,ready_at)
      VALUES($1,$2,'回签.pdf','application/pdf',128,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [attachmentId,`contract-return-before-pdf/${attachmentId}`,"c".repeat(64),merchandiserId]);
    const returned=await contractReturns.submit(contractActor(),pendingPdf,[attachmentId],randomUUID());
    expect(returned.contractReturnStatus).toBe("returned_on_time");
    expect(returned.contractReturnDueAt).toBeNull();
    expect((await contractReturns.get({...rootActor(),authorizationCapability:"sourcing:view"},pendingPdf))
      .attachments.map(file=>file.attachmentId)).toEqual([attachmentId]);
    await database.query(`UPDATE sourcing_contract_return_monitors
      SET contract_generated_at=contract_returned_at + INTERVAL '1 second',
          contract_return_due_at=sourcing_contract_return_add_hours(contract_returned_at + INTERVAL '1 second',48)
      WHERE sourcing_case_id=$1`,[pendingPdf]);
    expect((await service.getCase(readerActor(),pendingPdf)).contractReturnStatus).toBe("returned_on_time");
  });
  it("retains the first file when adding a second, with role and file ownership checks", async () => {
    const previous=process.env.CONTRACT_RETURN_MONITOR_ENABLED_AT;
    process.env.CONTRACT_RETURN_MONITOR_ENABLED_AT="2020-01-01T00:00:00Z";
    try {
      const created=await service.createCase(merchandiserActor(),{
        gender:"男装",styleName:"回签附件测试",estimatedCutPieceSendDate:"2026-10-01",
        deliveryDate:"2026-10-20",lineItems:[{styleNo:"RETURN-FILE",color:"黑",quantity:20}],
        daxingUnitPrice:"8",
      },randomUUID());
      const id=created.value.sourcingCaseId;
      await service.quoteIePrice(ieActor(),id,{linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
      await service.recordManagementDecision(managerActor(),id,{
        supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:[{position:1,unitPrice:"10"}],
      },randomUUID());
      await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
      const pdfId=randomUUID(),imageId=randomUUID(),wrongOwnerId=randomUUID(),managerFileId=randomUUID();
      await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,
        size_bytes,sha256,uploaded_by,status,ready_at)
        VALUES($1,$4,'回签.pdf','application/pdf',128,$5,$7,'ready',CURRENT_TIMESTAMP),
              ($2,$4||'-image','回签补图.jpg','image/jpeg',128,$6,$8,'ready',CURRENT_TIMESTAMP),
              ($3,$4||'-wrong','其他人.png','image/png',128,$5,$8,'ready',CURRENT_TIMESTAMP),
              ($9,$4||'-manager','管理补传.png','image/png',128,$6,$10,'ready',CURRENT_TIMESTAMP)`,
        [pdfId,imageId,wrongOwnerId,`contract-return-test/${pdfId}`,"a".repeat(64),"b".repeat(64),merchandiserId,ownerId,managerFileId,managerId]);
      await expect(contractReturns.submit(financeActor(),id,[pdfId],randomUUID())).rejects.toMatchObject({statusCode:403});
      await expect(contractReturns.submit(contractActor(),id,[wrongOwnerId],randomUUID())).rejects.toMatchObject({statusCode:400});
      expect((await contractReturns.get(readerActor(),id)).contractReturnedAt).toBeNull();
      const key=randomUUID();
      const first=await contractReturns.submit(contractActor(),id,[pdfId],key);
      expect(first.contractReturnStatus).toBe("returned_on_time");
      expect(first.contractReturnedAt).toBeTruthy();
      expect(first.canUpload).toBe(true);
      expect((await contractReturns.submit(contractActor(),id,[pdfId],key)).contractReturnedAt).toBe(first.contractReturnedAt);
      await expect(contractReturns.submit(contractActor(),id,[imageId],key)).rejects.toMatchObject({statusCode:409});
      const identicalKey=randomUUID();
      await expect(contractReturns.submit(contractActor(),id,[pdfId],identicalKey)).resolves.toHaveProperty("contractReturnedAt",first.contractReturnedAt);
      await expect(contractReturns.submit(contractActor(),id,[imageId],identicalKey)).rejects.toMatchObject({statusCode:409});
      expect((await database.query("SELECT count(*)::int AS count FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1",[id])).rows[0].count).toBe(1);
      const replaced=await contractReturns.submit({...ownerActor(),authorizationCapabilities:["sourcing:view","sourcing:owner:approve"]},id,[imageId],randomUUID());
      expect(replaced.contractReturnedAt).toBe(first.contractReturnedAt);
      expect(replaced.uploadedByName).toBe("老板");
      await expect(contractReturns.submit(managerActor(),id,[managerFileId],randomUUID())).rejects.toMatchObject({statusCode:409});
      const rootView=await contractReturns.get({...rootActor(),authorizationCapability:"sourcing:view"},id);
      expect(rootView.attachments.map(file=>file.attachmentId)).toEqual([pdfId,imageId]);
      expect(rootView.history.map(version=>version.revision)).toEqual([1]);
      expect(rootView.history[0]?.attachments[0]?.attachmentId).toBe(pdfId);
      expect(rootView.canUpload).toBe(false);
      expect(rootView.uploadedFileCount).toBe(2);
      expect((await contractReturns.get(readerActor(),id)).attachments).toEqual([]);
      expect((await contractReturns.get(readerActor(),id)).history).toEqual([]);
      expect((await contractReturns.get({...readerActor(),authorizationCapabilities:["sourcing:view","supplier_contract_data:read"]},id)).attachments
        .map(file=>file.attachmentId)).toEqual([pdfId,imageId]);
      expect((await database.query("SELECT count(*)::int AS count FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1",[id])).rows[0].count).toBe(2);
      expect(service.canDownloadBoundAttachment(readerActor(),{entityType:"sourcing_contract_return",entityId:id,mimeType:"application/pdf"})).toBe(false);
      expect(service.canDownloadBoundAttachment({...rootActor(),authorizationCapability:"sourcing:view"},{entityType:"sourcing_contract_return",entityId:id,mimeType:"application/pdf"})).toBe(true);
    } finally {
      if(previous===undefined) delete process.env.CONTRACT_RETURN_MONITOR_ENABLED_AT;
      else process.env.CONTRACT_RETURN_MONITOR_ENABLED_AT=previous;
    }
  });
  it("atomically returns two PDFs, preserves single-file history and guards readiness, limits and signed downloads", async () => {
    const created=await service.createCase(merchandiserActor(),{gender:"男装",styleName:"双文件回传",estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-20",
      lineItems:[{styleNo:"RETURN-TWO",color:"黑",quantity:20}],daxingUnitPrice:"8"},randomUUID());
    const id=created.value.sourcingCaseId;
    await service.quoteIePrice(ieActor(),id,{linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.recordManagementDecision(managerActor(),id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
    const document=(await contractService.getCurrent(readerActor(),id)).item!;
    const pdfs=[randomUUID(),randomUUID(),randomUUID()];
    for (const [index,file] of pdfs.entries()) await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
      VALUES($1,$2,$3,'application/pdf',128,$4,$5,$6,CASE WHEN $6='ready' THEN CURRENT_TIMESTAMP ELSE NULL END)`,
      [file,`two-returns/${file}`,`回签${index+1}.pdf`,"a".repeat(64),rootActor().actorId,index===1?"pending":"ready"]);
    const root=rootActor();
    await expect(contractReturns.submit(root,id,[],randomUUID())).rejects.toMatchObject({statusCode:400});
    await expect(contractReturns.submit(root,id,pdfs,randomUUID())).rejects.toMatchObject({statusCode:400});
    await expect(contractReturns.submit(root,id,[pdfs[0]!,pdfs[0]!],randomUUID())).rejects.toMatchObject({statusCode:400});
    await expect(contractReturns.submit(root,id,pdfs.slice(0,2),randomUUID())).rejects.toMatchObject({statusCode:400});
    expect((await contractReturns.get({...root,authorizationCapability:"sourcing:view"},id)).contractReturnedAt).toBeNull();
    expect((await database.query("SELECT entity_type FROM attachments WHERE attachment_id=$1",[pdfs[0]])).rows[0].entity_type).toBeNull();
    await database.query("UPDATE attachments SET status='ready',ready_at=CURRENT_TIMESTAMP WHERE attachment_id=$1",[pdfs[1]]);
    const key=randomUUID();
    const returned=await contractReturns.submit(root,id,pdfs.slice(0,2),key);
    expect(returned.attachments.map(file=>file.attachmentId)).toEqual(pdfs.slice(0,2));
    expect(returned.signedContractDocumentId).toBe(document.sourcingContractDocumentId);
    expect(returned.history).toEqual([]);
    const retried=await contractReturns.submit(root,id,pdfs.slice(0,2),key);
    expect(retried.contractReturnedAt).toBe(returned.contractReturnedAt);
    expect((await database.query("SELECT count(*)::int AS n FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1",[id])).rows[0].n).toBe(1);
    expect((await database.query("SELECT count(*)::int AS n FROM operation_events WHERE entity_id=$1 AND action='sourcing.contract_return.upload'",[id])).rows[0].n).toBe(1);
    const reader={...readerActor(),authorizationCapabilities:["sourcing:view","supplier_contract_data:read"]};
    for (const file of pdfs.slice(0,2)) {
      for (const mode of ["inline","attachment"] as const) {
        await expect(attachments.createDownloadIntent(reader,file,async binding=>service.canDownloadBoundAttachment(reader,binding),mode)).resolves.toHaveProperty("downloadUrl");
        await expect(attachments.createDownloadIntent(readerActor(),file,async binding=>service.canDownloadBoundAttachment(readerActor(),binding),mode)).rejects.toMatchObject({statusCode:403});
      }
    }
    await expect(contractReturns.submit(root,id,[pdfs[2]!],randomUUID())).rejects.toMatchObject({statusCode:409});
    expect(returned.canUpload).toBe(false);
    expect(returned.uploadedFileCount).toBe(2);
  });
  it("serializes cumulative return slots and retries, combines size across submissions and preserves legacy excess files", async () => {
    const created=await service.createCase(merchandiserActor(),{gender:"男装",styleName:"分次累计回传",estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-20",
      lineItems:[{styleNo:"RETURN-CUMULATIVE",color:"黑",quantity:20}],daxingUnitPrice:"8"},randomUUID());
    const id=created.value.sourcingCaseId;
    await service.quoteIePrice(ieActor(),id,{linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.recordManagementDecision(managerActor(),id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
    const document=(await contractService.getCurrent(readerActor(),id)).item!;
    const ids=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
    for(const [index,file] of ids.entries()) await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
      VALUES($1,$2,$3,'application/pdf',$4,$5,$6,'ready',CURRENT_TIMESTAMP)`,
      [file,`cumulative/${file}`,`回签${index}.pdf`,index===0?19*1024*1024:2*1024*1024,"a".repeat(64),merchandiserId]);
    const first=await contractReturns.submit(contractActor(),id,[ids[0]!],randomUUID());
    expect(first.canUpload).toBe(true);
    expect(first.uploadedFileCount).toBe(1);
    await expect(contractReturns.submit(contractActor(),id,[ids[1]!],randomUUID())).rejects.toMatchObject({statusCode:400});
    expect((await database.query("SELECT entity_type FROM attachments WHERE attachment_id=$1",[ids[1]])).rows[0].entity_type).toBeNull();
    await database.query("UPDATE attachments SET size_bytes=1024 WHERE attachment_id=ANY($1::uuid[])",[ids.slice(1)]);
    const keys=[randomUUID(),randomUUID()];
    const concurrent=await Promise.allSettled(ids.slice(1,3).map((file,index)=>contractReturns.submit(contractActor(),id,[file],keys[index]!)));
    expect(concurrent.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    const failed=concurrent.find(result=>result.status==='rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({statusCode:409});
    const winner=concurrent.findIndex(result=>result.status==='fulfilled');
    const secondId=ids[winner+1]!;
    const view=await contractReturns.get({...rootActor(),authorizationCapability:"sourcing:view"},id);
    expect(view.attachments.map(file=>file.attachmentId)).toEqual([ids[0],secondId]);
    expect(view.history[0]?.attachments.map(file=>file.attachmentId)).toEqual([ids[0]]);
    expect(view.contractReturnedAt).toBe(first.contractReturnedAt);
    expect(view.canUpload).toBe(false);
    expect(view.uploadedFileCount).toBe(2);
    await contractReturns.submit(contractActor(),id,[secondId],keys[winner]!);
    await contractReturns.submit(contractActor(),id,[secondId],randomUUID());
    expect((await database.query("SELECT count(*)::int AS n FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1",[id])).rows[0].n).toBe(2);
    await expect(contractReturns.submit(contractActor(),id,[ids[3]!],randomUUID())).rejects.toMatchObject({statusCode:409});
    for(const file of [ids[0]!,secondId]) await expect(attachments.createDownloadIntent({...rootActor(),authorizationCapability:"sourcing:view"},file,async binding=>service.canDownloadBoundAttachment({...rootActor(),authorizationCapability:"sourcing:view"},binding))).resolves.toHaveProperty('downloadUrl');
    // Model an already-existing legacy third file in this isolated schema. Never alter that evidence in application code.
    const legacySubmission=randomUUID();
    await database.query(`INSERT INTO sourcing_contract_return_submissions(submission_id,sourcing_case_id,revision,request_id,submitted_by,submitted_at,sourcing_contract_document_id)
      VALUES($1,$2,3,$3,$4,CURRENT_TIMESTAMP,$5)`,[legacySubmission,id,randomUUID(),merchandiserId,document.sourcingContractDocumentId]);
    await database.query("UPDATE attachments SET entity_type='sourcing_contract_return',entity_id=$2 WHERE attachment_id=$1",[ids[3],id]);
    await database.query("INSERT INTO sourcing_contract_return_attachments(submission_id,attachment_id,position) VALUES($1,$2,1)",[legacySubmission,ids[3]]);
    const legacy=await contractReturns.get({...rootActor(),authorizationCapability:"sourcing:view"},id);
    expect(legacy.uploadedFileCount).toBe(3);
    expect(legacy.attachments.map(file=>file.attachmentId)).toEqual([ids[0],secondId,ids[3]]);
    expect(legacy.canUpload).toBe(false);
    expect(legacy.contractReturnedAt).toBe(first.contractReturnedAt);
    await expect(contractReturns.submit(rootActor(),id,[ids[concurrent.findIndex(result=>result.status==='rejected')+1]!],randomUUID())).rejects.toMatchObject({statusCode:409});
  });
  it("adds one actionable merchandiser todo on approval and completes it on first return", async () => {
    await ensureReturnTodoRecipient();
    const todoService=new TodoService(database);
    const realProjection=new TodoProjectionService(todoService);
    const approvingService=new SourcingService(database,undefined,undefined,{
      ...todoProjection,
      actionableForNamedRecipient:realProjection.actionableForNamedRecipient.bind(realProjection),
      completeOpenByDedupePrefix:realProjection.completeOpenByDedupePrefix.bind(realProjection),
    },contractService);
    const created=await service.createCase(merchandiserActor(),{
      gender:"男装",styleName:"通知闭环",estimatedCutPieceSendDate:"2026-10-01",
      deliveryDate:"2026-10-20",lineItems:[{styleNo:"RETURN-TODO-ONE",color:"黑",quantity:20}],
      daxingUnitPrice:"8",
    },randomUUID());
    const id=created.value.sourcingCaseId;
    await service.quoteIePrice(ieActor(),id,{linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.recordManagementDecision(managerActor(),id,{
      supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:[{position:1,unitPrice:"10"}],
    },randomUUID());
    await approvingService.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
    const rows=await database.query<{todo_id:string;recipient_user_id:string;status:string;due_at:Date|null}>(
      `SELECT todo_id,recipient_user_id,status,due_at FROM rework_todos
       WHERE entity_type='sourcing_case' AND entity_id=$1 AND category='sourcing_contract_return'`,[id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({recipient_user_id:merchandiserId,status:"pending",due_at:null});
    const todoId=rows.rows[0]!.todo_id;
    expect((await todoService.listForActor({
      ...merchandiserActor(),authorizationCapability:"todo:view",
      authorizationCapabilities:["todo:view","sourcing:view","sourcing:contract:record"],
    },{module:"sourcing"})).todos.map(todo=>todo.todoId)).toContain(todoId);
    const attempts=await database.query<{delivery_kind:string;outcome:string}>(
      "SELECT delivery_kind,outcome FROM todo_delivery_attempts WHERE todo_id=$1",[todoId]);
    expect(attempts.rows).toContainEqual({delivery_kind:"create",outcome:"queued"});
    const provider=new FakeDingTalkTodoProvider();
    await new TodoDeliveryWorker(database,provider,"https://staging.example/rework/").runOnce(100);
    const delivered=provider.calls.find(call=>call.method==="create" && call.input.todoId===todoId);
    expect(delivered?.input).toMatchObject({
      subject:"【款号:RETURN-TODO-ONE】回传合同",
      deepLink:expect.stringContaining("section=contract-return"),
    });
    await approvingService.requestFactoryChange(ownerActor(),id,{
      supplierId:replacementFactoryId,unitPrice:"12.0000",changeReason:"老板批准转厂",
    },randomUUID());
    expect((await database.query("SELECT status FROM rework_todos WHERE todo_id=$1",[todoId]))
      .rows[0]?.status).toBe("cancelled");
    const currentTodo=(await database.query<{todo_id:string}>(
      `SELECT todo_id FROM rework_todos WHERE entity_id=$1 AND category='sourcing_transfer_contract_return'
       AND status='pending'`,[id])).rows[0]?.todo_id;
    expect(currentTodo).toBeTruthy();
    const attachmentId=randomUUID();
    await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,
      size_bytes,sha256,uploaded_by,status,ready_at)
      VALUES($1,$2,'签回.pdf','application/pdf',128,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [attachmentId,`contract-return-todo/${attachmentId}`,"d".repeat(64),merchandiserId]);
    await contractReturns.submit(contractActor(),id,[attachmentId],randomUUID(),(await contractService.getCurrent(rootActor(),id)).item!.sourcingContractDocumentId);
    expect((await database.query("SELECT status FROM rework_todos WHERE todo_id=$1",[currentTodo]))
      .rows[0]?.status).toBe("completed");
    expect((await database.query("SELECT delivery_kind FROM todo_delivery_attempts WHERE todo_id=$1 ORDER BY attempted_at",[currentTodo]))
      .rows.map(row=>row.delivery_kind)).toEqual([]);
    expect((await database.query("SELECT count(*)::int AS count FROM rework_todos WHERE entity_id=$1 AND category='sourcing_transfer_contract_return'",[id]))
      .rows[0]?.count).toBe(1);
  });

  it("backfills a single pending contract todo for a historic approval and enqueues delivery once", async () => {
    await ensureReturnTodoRecipient();
    const created=await service.createCase(merchandiserActor(),{
      gender:"女装",styleName:"历史待办补录",estimatedCutPieceSendDate:"2026-10-01",
      deliveryDate:"2026-10-20",lineItems:[{styleNo:"RETURN-TODO-HISTORY",color:"黑",quantity:20}],
      daxingUnitPrice:"8",
    },randomUUID());
    const id=created.value.sourcingCaseId;
    await service.quoteIePrice(ieActor(),id,{linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.recordManagementDecision(managerActor(),id,{
      supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:[{position:1,unitPrice:"10"}],
    },randomUUID());
    await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
    expect((await database.query("SELECT count(*)::int AS count FROM rework_todos WHERE entity_id=$1 AND category='sourcing_contract_return'",[id])).rows[0]?.count).toBe(0);
    const migration=await readFile(new URL(
      "../../apps/api/migrations/0211_sourcing_contract_return_todos.sql",import.meta.url),"utf8");
    const backfill=migration.slice(migration.indexOf("DO $$"));
    await database.query(backfill);
    const createdTodos=await database.query<{todo_id:string;status:string;recipient_user_id:string}>(
      "SELECT todo_id,status,recipient_user_id FROM rework_todos WHERE entity_id=$1 AND category='sourcing_contract_return'",[id]);
    expect(createdTodos.rows).toHaveLength(1);
    expect(createdTodos.rows[0]).toMatchObject({status:"pending",recipient_user_id:merchandiserId});
    expect((await database.query("SELECT outcome FROM todo_delivery_attempts WHERE todo_id=$1",[createdTodos.rows[0]!.todo_id]))
      .rows[0]?.outcome).toBe("queued");
    await database.query(backfill);
    expect((await database.query("SELECT count(*)::int AS count FROM rework_todos WHERE entity_id=$1 AND category='sourcing_contract_return'",[id]))
      .rows[0]?.count).toBe(1);
  });
  it("refreshes template-only, supplier-only and combined information without changing approvals or return facts",async()=>{
    const created=await service.createCase(merchandiserActor(),{gender:"女装",styleName:"合同信息更新测试",estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-20",
      lineItems:[{styleNo:"CONTRACT-INFO-REFRESH",color:"红",quantity:20}],daxingUnitPrice:"8"},randomUUID());
    const id=created.value.sourcingCaseId;
    await service.quoteIePrice(ieActor(),id,{linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.recordManagementDecision(managerActor(),id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
    const management=contractService.management;
    const original=(await contractService.getCurrent(readerActor(),id)).item!;
    const originalRow=(await database.query("SELECT * FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",[original.sourcingContractDocumentId])).rows[0]!;
    const approval=(await database.query("SELECT * FROM sourcing_approval_snapshots WHERE sourcing_approval_snapshot_id=$1",[original.sourcingApprovalSnapshotId])).rows[0]!;
    const clock=(await database.query("SELECT * FROM sourcing_contract_return_monitors WHERE sourcing_case_id=$1",[id])).rows[0]!;
    const unchanged=await management.previewInformation(contractActor(),id);
    expect(unchanged.changes).toEqual([]);
    expect(await management.refreshInformation(contractActor(),id,unchanged,randomUUID())).toBe(original.sourcingContractDocumentId);
    await expect(management.previewInformation({...contractActor(),actorId:managerId},id)).rejects.toMatchObject({code:"FORBIDDEN"});
    await expect(management.templates(managerActor())).rejects.toMatchObject({code:"FORBIDDEN"});
    const template=(await management.templates(rootActor())).item;
    const templateInput={expectedVersion:template.templateVersion,templateName:template.templateName,partyAName:template.partyAName,partyAAddress:template.partyAAddress,signingPlace:template.signingPlace,
      terms:{...template.terms,logistics:template.terms.logistics+"（模板更新测试）"}};
    const saveKey=randomUUID();
    const saved=await management.saveTemplate(rootActor(),templateInput,saveKey);
    expect(saved.item.templateVersion).toBe(template.templateVersion+1);
    await management.saveTemplate(rootActor(),templateInput,saveKey);
    expect((await management.templates(rootActor())).history.filter(row=>row.templateVersion===template.templateVersion)).toHaveLength(1);
    await expect(management.saveTemplate(rootActor(),templateInput,randomUUID())).rejects.toMatchObject({statusCode:409});
    await expect(management.refreshInformation(contractActor(),id,unchanged,randomUUID())).rejects.toMatchObject({statusCode:409});
    const templatePreview=await management.previewInformation(managerActor(),id);
    expect(templatePreview.changes.map(change=>change.field)).toEqual(["templateVersion","logistics"]);
    const refreshKey=randomUUID();
    const [first,retry]=await Promise.all([
      management.refreshInformation(managerActor(),id,templatePreview,refreshKey),
      management.refreshInformation(managerActor(),id,templatePreview,refreshKey),
    ]);
    expect(retry).toBe(first);
    await contractService.generateIfReady(managerActor(),id,first);
    expect((await contractService.getCurrent(readerActor(),id)).item).toMatchObject({contractVersion:original.contractVersion+1,templateVersion:saved.item.templateVersion,status:"ready"});
    const updateSupplier=async()=>{
      await database.query("ALTER TABLE supplier_catalog_versions DISABLE TRIGGER supplier_catalog_versions_guard_creation, DISABLE TRIGGER supplier_profile_maintenance_authority");
      try{
        await database.query(`INSERT INTO supplier_catalog_versions(supplier_id,version,supplier_name,active,change_reason,changed_by,
          address,contract_entity_name,party_b_representative,payee_name,bank_account,bank_name)
          SELECT supplier_id,version+1,supplier_name,true,'合同刷新测试',$2,address||'（资料更新）',NULL,party_b_representative,payee_name,bank_account||'9',bank_name
          FROM current_supplier_catalog WHERE supplier_id=$1`,[factoryId,managerId]);
      }finally{await database.query("ALTER TABLE supplier_catalog_versions ENABLE TRIGGER supplier_catalog_versions_guard_creation, ENABLE TRIGGER supplier_profile_maintenance_authority");}
    };
    await updateSupplier();
    const supplierPreview=await management.previewInformation(contractActor(),id);
    expect(supplierPreview.changes.map(change=>change.field)).toEqual(["address","bankAccount"]);
    const supplierDocument=await management.refreshInformation(contractActor(),id,supplierPreview,randomUUID());
    await contractService.generateIfReady(contractActor(),id,supplierDocument);
    await updateSupplier();
    const now=(await management.templates(rootActor())).item;
    await management.saveTemplate(rootActor(),{...templateInput,expectedVersion:now.templateVersion,terms:{...now.terms,payment:now.terms.payment+"（合并更新测试）"}},randomUUID());
    const both=await management.previewInformation(managerActor(),id);
    expect(both.changes.map(change=>change.field)).toEqual(["address","bankAccount","templateVersion","payment"]);
    const combined=await management.refreshInformation(managerActor(),id,both,randomUUID());
    await contractService.generateIfReady(managerActor(),id,combined);
    const effective=(await database.query("SELECT approval_snapshot FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",[combined])).rows[0]!.approval_snapshot;
    expect(effective.bankAccount).toBe(String(originalRow.approval_snapshot.bankAccount)+"99");
    expect(effective.contractEntityName).toBe(originalRow.approval_snapshot.contractEntityName);
    const refreshedSupplier={address:effective.address,bankAccount:effective.bankAccount};
    await service.reviseStyles(merchandiserActor(),id,{expectedRevision:0,lines:[{position:1,styleNo:"CONTRACT-INFO-REVISED",alternateStyleNo:null}]},randomUUID());
    const withStyle=(await contractService.getCurrent(readerActor(),id)).item!;
    expect((await database.query("SELECT approval_snapshot FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",[withStyle.sourcingContractDocumentId])).rows[0]!.approval_snapshot).toMatchObject(refreshedSupplier);
    expect((await database.query("SELECT * FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",[original.sourcingContractDocumentId])).rows[0]).toEqual(originalRow);
    expect((await database.query("SELECT * FROM sourcing_approval_snapshots WHERE sourcing_approval_snapshot_id=$1",[original.sourcingApprovalSnapshotId])).rows[0]).toEqual(approval);
    expect((await database.query("SELECT * FROM sourcing_contract_return_monitors WHERE sourcing_case_id=$1",[id])).rows[0]).toEqual(clock);
    const attachmentId=randomUUID();
    await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
      VALUES($1,$2,'已回传合同.pdf','application/pdf',128,$3,$4,'ready',CURRENT_TIMESTAMP)`,[attachmentId,`contract-info-return/${attachmentId}`,"e".repeat(64),merchandiserId]);
    await contractReturns.submit(contractActor(),id,[attachmentId],randomUUID());
    const returned=(await contractReturns.get({...rootActor(),authorizationCapability:"sourcing:view"},id));
    const returnRows=(await database.query("SELECT * FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1",[id])).rows;
    expect(returned).toMatchObject({currentContractReturned:true,signedContractDocumentId:withStyle.sourcingContractDocumentId,
      signedContractVersion:withStyle.contractVersion,signedContractNumber:withStyle.contractNumber});
    expect(returnRows[0].sourcing_contract_document_id).toBe(withStyle.sourcingContractDocumentId);
    expect((await contractService.getCurrent(contractActor(),id)).item?.canRefreshInformation).toBe(false);
    expect((await contractService.getCurrent(managerActor(),id)).item?.canRefreshInformation).toBe(false);
    await expect(management.previewInformation(contractActor(),id)).rejects.toMatchObject({code:"FORBIDDEN"});
    await expect(management.previewInformation(managerActor(),id)).rejects.toMatchObject({code:"FORBIDDEN"});
    await expect(management.refreshInformation(managerActor(),id,both,randomUUID())).rejects.toMatchObject({code:"FORBIDDEN"});
    await updateSupplier();
    const rootPreview=await management.previewInformation(rootActor(),id);
    expect(rootPreview.returned).toBe(true);
    const rootDocument=await management.refreshInformation(rootActor(),id,rootPreview,randomUUID());
    await contractService.generateIfReady(rootActor(),id,rootDocument);
    expect((await contractService.getCurrent(rootActor(),id)).item?.canRefreshInformation).toBe(true);
    expect(await contractReturns.get({...rootActor(),authorizationCapability:"sourcing:view"},id)).toEqual({...returned,currentContractReturned:false,currentContractDocumentId:rootDocument,uploadedFileCount:0,uploadedTotalBytes:0});
    expect((await database.query("SELECT * FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1",[id])).rows).toEqual(returnRows);
    await expect(database.query("UPDATE sourcing_contract_return_submissions SET sourcing_contract_document_id=$2 WHERE submission_id=$1",[returnRows[0].submission_id,rootDocument]))
      .rejects.toMatchObject({code:"55000"});
    expect((await database.query("SELECT approval_snapshot FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",[withStyle.sourcingContractDocumentId])).rows[0]!.approval_snapshot).toMatchObject(refreshedSupplier);
    const newFile=randomUUID();
    await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
      VALUES($1,$2,'新版回签.pdf','application/pdf',128,$3,$4,'ready',CURRENT_TIMESTAMP)`,[newFile,`contract-info-new-return/${newFile}`,"f".repeat(64),rootActor().actorId]);
    const resign=await contractReturns.submit(rootActor(),id,[newFile],randomUUID());
    expect(resign).toMatchObject({currentContractReturned:true,signedContractDocumentId:rootDocument,
      contractReturnedAt:returned.contractReturnedAt,contractReturnDueAt:returned.contractReturnDueAt,
      contractReturnStatus:returned.contractReturnStatus});
    expect(resign.history[0]).toMatchObject({signedContractDocumentId:withStyle.sourcingContractDocumentId,
      signedContractVersion:withStyle.contractVersion,attachments:returned.attachments});
    expect((await database.query("SELECT * FROM sourcing_contract_return_submissions WHERE submission_id=$1",[returnRows[0].submission_id])).rows[0]).toEqual(returnRows[0]);
  });

  it("lets only Root append a complete contract-only edit, preserving approvals, PDFs, returns and supplier refresh inheritance",async()=>{
    const rootReader={...rootActor(),authorizationCapability:"sourcing:view"};
    const created=await service.createCase(merchandiserActor(),{gender:"女装",styleName:"人工修改合同测试",estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-20",
      lineItems:[{styleNo:"MANUAL-CONTRACT",color:"红",quantity:20}],daxingUnitPrice:"8",attachmentIds:[]},randomUUID());
    const id=created.value.sourcingCaseId;
    await service.quoteIePrice(ieActor(),id,{linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.recordManagementDecision(managerActor(),id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
    const original=(await contractService.getCurrent(rootActor(),id)).item!;
    expect(original.canEditContent).toBe(true);
    expect((await contractService.getCurrent(contractActor(),id)).item?.canEditContent).toBe(false);
    const originalRow=(await database.query("SELECT * FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",[original.sourcingContractDocumentId])).rows[0];
    const approval=(await database.query("SELECT * FROM sourcing_approval_snapshots WHERE sourcing_approval_snapshot_id=$1",[original.sourcingApprovalSnapshotId])).rows[0];
    const clock=(await database.query("SELECT * FROM sourcing_contract_return_monitors WHERE sourcing_case_id=$1",[id])).rows[0];
    const bytes=await sharp({create:{width:30,height:30,channels:3,background:"red"}}).png().toBuffer();
    const sha256=createHash("sha256").update(bytes).digest("hex");
    const uploadActor={...rootActor(),authorizationCapability:"tools:attachment:upload"};
    const intent=await attachments.createUploadIntent(uploadActor,{filename:"合同独立款图.png",mimeType:"image/png",sizeBytes:bytes.length,sha256});
    await contractStorage.writeImmutable(intent.objectKey,bytes,{mimeType:"image/png",sha256});
    await attachments.finalize(uploadActor,intent.attachmentId);
    const state=await contractService.content.get(rootActor(),id);
    const input={...state,content:{...state.content,contractNumber:"本单人工编号",partyBName:"本单人工乙方",deliveryDate:"2026-11-11",
      lines:[{...state.content.lines[0]!,quantity:33,unitPrice:"12.50",totalAmount:"412.50",imageAttachmentId:intent.attachmentId,imageSha256:sha256}],
      totalQuantity:33,totalAmount:"412.50",terms:{...state.content.terms,payment:"人工付款条款",processingResponsibility:"人工完整加工责任"}}};
    for(const actor of [contractActor(),managerActor(),financeActor()]){
      await expect(contractService.content.get(actor,id)).rejects.toMatchObject({statusCode:403});
      await expect(contractService.content.save(actor,id,input,randomUUID())).rejects.toMatchObject({statusCode:403});
    }
    const preview=await contractService.content.preview(rootActor(),id,input);expect(preview.subarray(0,4).toString()).toBe("%PDF");
    const key=randomUUID();
    const [doc,retry]=await Promise.all([contractService.content.save(rootActor(),id,input,key),contractService.content.save(rootActor(),id,input,key)]);
    expect(retry).toBe(doc);
    await contractService.generateIfReady(rootActor(),id,doc);
    const updated=(await contractService.getCurrent(rootActor(),id)).item!;
    expect(updated).toMatchObject({contractVersion:original.contractVersion+1,contractNumber:"本单人工编号",status:"ready",canEditContent:true});
    expect(updated.pdfAttachmentId).not.toBe(original.pdfAttachmentId);
    const currentDisplay=(await service.getCase(readerActor(),id)).contractDisplay;
    expect(currentDisplay).toMatchObject({sourcingContractDocumentId:doc,contractNumber:"本单人工编号",partyBName:"本单人工乙方",totalQuantity:33,totalAmount:"412.50",deliveryDate:"2026-11-11",linesMatchOrder:true});
    expect(currentDisplay?.lines[0]).toMatchObject({quantity:33,unitPrice:"12.50",imageAttachmentId:intent.attachmentId});
    if (process.env.SOURCING_UI_FIXTURE_FILE) await writeFile(process.env.SOURCING_UI_FIXTURE_FILE,JSON.stringify({
      id,detail:await service.getCase(rootReader,id),attachments:await service.listAttachments(rootReader,id),
      timeline:await service.listTimeline(rootReader,id),factoryChange:await service.getCurrentFactoryChange(rootReader,id),
      contract:await contractService.getCurrent(rootReader,id),dispatch:await production.state(rootReader,id),
      contractReturn:await contractReturns.get(rootReader,id),factories:await service.listFactories(rootReader),
      crafts:await craftService.listCrafts(),image:bytes.toString("base64"),
    }));
    expect((await service.nodeHistory(readerActor(),id,"management")).item.contractDisplay).toBeUndefined();
    expect((await contractService.content.get(rootActor(),id)).content).toEqual(input.content);
    expect((await database.query("SELECT approval_snapshot FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",[doc])).rows[0].approval_snapshot).toEqual(originalRow.approval_snapshot);
    expect((await database.query("SELECT * FROM sourcing_approval_snapshots WHERE sourcing_approval_snapshot_id=$1",[original.sourcingApprovalSnapshotId])).rows[0]).toEqual(approval);
    expect((await database.query("SELECT * FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",[original.sourcingContractDocumentId])).rows[0]).toEqual(originalRow);
    expect((await database.query("SELECT * FROM sourcing_contract_return_monitors WHERE sourcing_case_id=$1",[id])).rows[0]).toEqual(clock);
    expect((await database.query("SELECT entity_type,entity_id FROM attachments WHERE attachment_id=$1",[intent.attachmentId])).rows[0]).toMatchObject({entity_type:"sourcing_contract_document",entity_id:doc});
    const unchangedOrder=await service.getCase(rootReader,id);
    expect(unchangedOrder.orderQuantity).toBe(20);
    expect(unchangedOrder.lineItems[0]?.quantity).toBe(20);
    expect(unchangedOrder.approvalSnapshot?.quantity).toBe(20);
    expect(unchangedOrder.deliveryDate).toBe("2026-11-11");
    expect(unchangedOrder.approvalSnapshot?.deliveryDate).toBe("2026-10-20");
    expect((await service.listCases(rootReader,"MANUAL-CONTRACT")).items.find(row=>row.sourcingCaseId===id)?.deliveryDate).toBe("2026-11-11");
    expect((await service.nodeHistory(rootReader,id,"owner")).item.deliveryDate).toBe("2026-10-20");
    expect((await cutting.list(cuttingOwnerActor(),{q:"本单人工编号"})).items.find(row=>row.sourcingCaseId===id)).toMatchObject({contractNumber:"本单人工编号",deliveryDate:"2026-11-11"});
    expect((await service.listTimeline(rootReader,id)).items.find(row=>row.entryId===doc)?.contractReference).toBe("本单人工编号");
    await expect(contractService.content.save(rootActor(),id,input,randomUUID())).rejects.toMatchObject({statusCode:409});
    await expect(database.query("UPDATE sourcing_contract_content_overrides SET content='{}' WHERE sourcing_contract_document_id=$1",[doc])).rejects.toMatchObject({code:"55000"});
    const template=(await contractService.management.templates(rootActor())).item;
    await contractService.management.saveTemplate(rootActor(),{...template,expectedVersion:template.templateVersion,terms:{...template.terms,payment:"同步后的付款条款"}},randomUUID());
    const refresh=await contractService.management.previewInformation(contractActor(),id);
    const refreshed=await contractService.management.refreshInformation(contractActor(),id,refresh,randomUUID());
    await contractService.generateIfReady(contractActor(),id,refreshed);
    const inherited=await contractService.content.get(rootActor(),id);
    expect(inherited.content.lines).toEqual(input.content.lines);
    expect(inherited.content.deliveryDate).toBe("2026-11-11");expect(inherited.content.terms.payment).toBe("同步后的付款条款");
    expect(inherited.content.partyBName).toBe(refresh.changes.find(change=>change.field==="contractEntityName")?.after ?? input.content.partyBName);
    const beforeStyleTemplate=(await contractService.management.templates(rootActor())).item;
    await contractService.management.saveTemplate(rootActor(),{...beforeStyleTemplate,expectedVersion:beforeStyleTemplate.templateVersion,
      terms:{...beforeStyleTemplate.terms,payment:"改款后仍需同步的新条款"}},randomUUID());
    await service.reviseStyles(merchandiserActor(),id,{expectedRevision:0,lines:[{position:1,styleNo:"MANUAL-CONTRACT-REVISED",alternateStyleNo:null}]},randomUUID());
    const afterStyle=await contractService.content.get(rootActor(),id);
    expect(afterStyle.content.lines[0]).toMatchObject({...input.content.lines[0],styleNo:"MANUAL-CONTRACT-REVISED"});
    expect(afterStyle.content.totalAmount).toBe("412.50");expect(afterStyle.content.deliveryDate).toBe("2026-11-11");
    expect((await contractService.getCurrent(rootActor(),id)).item?.templateVersion).toBe(beforeStyleTemplate.templateVersion);
    expect(afterStyle.content.terms.payment).toBe("同步后的付款条款");
    const deferredTemplate=await contractService.management.previewInformation(contractActor(),id);
    expect(deferredTemplate.changes).toEqual(expect.arrayContaining([expect.objectContaining({field:"templateVersion"}),expect.objectContaining({field:"payment",after:"改款后仍需同步的新条款"})]));
    const withLatestTemplate=await contractService.management.refreshInformation(contractActor(),id,deferredTemplate,randomUUID());
    await contractService.generateIfReady(contractActor(),id,withLatestTemplate);
    expect((await contractService.content.get(rootActor(),id)).content.terms.payment).toBe("改款后仍需同步的新条款");
    const dispatched=await production.dispatch(contractActor(),id,{sourcingContractDocumentId:withLatestTemplate,confirmed:true},randomUUID());
    expect(dispatched.value).toMatchObject({contractNumber:"本单人工编号",deliveryDate:"2026-11-11",quantity:20});
    const dispatchFact=(await database.query("SELECT * FROM sourcing_production_orders WHERE production_order_id=$1",[dispatched.value.productionOrderId])).rows[0];
    const returnId=randomUUID();
    await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
      VALUES($1,$2,'人工合同回签.pdf','application/pdf',128,$3,$4,'ready',CURRENT_TIMESTAMP)`,[returnId,`manual-return/${returnId}`,"a".repeat(64),merchandiserId]);
    await contractReturns.submit(contractActor(),id,[returnId],randomUUID());
    const returned=await contractReturns.get(rootReader,id);
    expect(returned.signedContractNumber).toBe("本单人工编号");
    const returnedDraft=await contractService.content.get(rootActor(),id);
    const next=await contractService.content.save(rootActor(),id,{...returnedDraft,content:{...returnedDraft.content,deliveryDate:"2026-12-01"}},randomUUID());
    await contractService.generateIfReady(rootActor(),id,next);
    expect(await contractReturns.get(rootReader,id)).toMatchObject({currentContractReturned:false,contractReturnedAt:returned.contractReturnedAt,contractReturnDueAt:returned.contractReturnDueAt});
    expect((await service.getCase(rootReader,id)).deliveryDate).toBe("2026-12-01");
    expect((await production.get(rootReader,dispatched.value.productionOrderId)).deliveryDate).toBe("2026-12-01");
    expect((await database.query("SELECT * FROM sourcing_production_orders WHERE production_order_id=$1",[dispatched.value.productionOrderId])).rows[0]).toEqual(dispatchFact);
    await service.recordFinanceReconciliation(financeActor(),id,{result:"match"},randomUUID());
    const financeHistory=await service.nodeHistory(rootReader,id,"finance");
    expect(financeHistory.contractReference).toBe("本单人工编号");
    expect(financeHistory.item.deliveryDate).toBe("2026-12-01");
    await expect(contractService.content.save(rootActor(),id,{...returnedDraft,content:{...returnedDraft.content,deliveryDate:"2027-01-01"}},randomUUID())).rejects.toMatchObject({statusCode:403});
    expect((await service.getCase(rootReader,id)).deliveryDate).toBe("2026-12-01");
  });

  it("preserves the previous dashboard risk when only the contract delivery date changes",async()=>{
    const reporting=new ProductionReportingService(database);
    const dates=(await database.query<{today:string;later:string}>(
      "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date::text AS today,((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date+60)::text AS later")).rows[0]!;
    const created=await service.createCase(merchandiserActor(),{gender:"女装",styleName:"合同交期看板历史测试",
      estimatedCutPieceSendDate:dates.today,deliveryDate:dates.today,
      lineItems:[{styleNo:"CONTRACT-DATE-RISK",color:"蓝",quantity:20}],daxingUnitPrice:"8",attachmentIds:[]},randomUUID());
    const id=created.value.sourcingCaseId;
    await service.quoteIePrice(ieActor(),id,{linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.recordManagementDecision(managerActor(),id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
    const contract=(await contractService.getCurrent(rootActor(),id)).item!;
    const order=(await production.dispatch(rootActor(),id,{sourcingContractDocumentId:contract.sourcingContractDocumentId,confirmed:true},randomUUID())).value;
    await reporting.report(rootActor(),order.productionOrderId,{position:1,businessDate:dates.today,quantity:10},randomUUID());
    const dashboard=new ProductionDashboardService(database,reporting);
    const before=await dashboard.list(rootActor(),{q:"CONTRACT-DATE-RISK"});
    expect(before.items[0]!.progress.progressState).toBe("high_risk");
    const draft=await contractService.content.get(rootActor(),id);
    const document=await contractService.content.save(rootActor(),id,{...draft,content:{...draft.content,deliveryDate:dates.later}},randomUUID());
    await contractService.generateIfReady(rootActor(),id,document);
    const after=await dashboard.list(rootActor(),{q:"CONTRACT-DATE-RISK",previousAsOf:before.asOf});
    expect(after.items[0]!.order.deliveryDate).toBe(dates.later);
    expect(after.items[0]!.progress.progressState).toBe("normal");
    expect(after.events).toEqual(expect.arrayContaining([expect.objectContaining({
      kind:"progress_changed",productionOrderId:order.productionOrderId,previousState:"high_risk",progressState:"normal",
    })]));
    const historical=await new ProductionDashboardService(database,reporting,()=>new Date(before.asOf)).list(rootActor(),{q:"CONTRACT-DATE-RISK"});
    expect(historical.items[0]!.progress).toEqual(before.items[0]!.progress);
  });

  it.each(["match","difference"] as const)("permanently locks Root edits after finance %s, including drafts opened before reconciliation",async result=>{
    const created=await service.createCase(merchandiserActor(),{gender:"男装",styleName:"财务锁合同测试",estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-20",
      lineItems:[{styleNo:"FINANCE-CONTRACT-LOCK-"+result,color:"蓝",quantity:20}],daxingUnitPrice:"8",attachmentIds:[]},randomUUID());
    const id=created.value.sourcingCaseId;
    await service.quoteIePrice(ieActor(),id,{linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.recordManagementDecision(managerActor(),id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
    const draft=await contractService.content.get(rootActor(),id);
    await service.recordFinanceReconciliation(financeActor(),id,result==="match"?{result}:{result,differenceFields:["total_amount"],differenceReason:"财务已核对并发现差异"},randomUUID());
    expect((await contractService.getCurrent(rootActor(),id)).item?.canEditContent).toBe(false);
    await expect(contractService.content.get(rootActor(),id)).rejects.toMatchObject({statusCode:403});
    await expect(contractService.content.preview(rootActor(),id,draft)).rejects.toMatchObject({statusCode:403});
    await expect(contractService.content.save(rootActor(),id,{...draft,content:{...draft.content,totalAmount:"1"}},randomUUID())).rejects.toMatchObject({statusCode:403});
    expect((await database.query("SELECT count(*)::int AS count FROM sourcing_contract_documents WHERE sourcing_case_id=$1",[id])).rows[0].count).toBe(1);
  });

  it("serializes concurrent finance reconciliation and Root edits on the same order",async()=>{
    const created=await service.createCase(merchandiserActor(),{gender:"女装",styleName:"合同财务并发测试",estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-20",
      lineItems:[{styleNo:"CONTRACT-FINANCE-RACE",color:"白",quantity:20}],daxingUnitPrice:"8",attachmentIds:[]},randomUUID());
    const id=created.value.sourcingCaseId;
    await service.quoteIePrice(ieActor(),id,{linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.recordManagementDecision(managerActor(),id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
    const draft=await contractService.content.get(rootActor(),id);
    const [finance,edit]=await Promise.allSettled([
      service.recordFinanceReconciliation(financeActor(),id,{result:"match"},randomUUID()),
      contractService.content.save(rootActor(),id,{...draft,content:{...draft.content,deliveryDate:"2026-12-12"}},randomUUID()),
    ]);
    expect([finance,edit].filter(result=>result.status==="fulfilled")).toHaveLength(1);
    if (finance.status==="fulfilled") {
      expect(edit.status).toBe("rejected");
      if(edit.status==="rejected")expect(edit.reason).toMatchObject({statusCode:403});
      expect((await database.query("SELECT count(*)::int AS count FROM sourcing_contract_documents WHERE sourcing_case_id=$1",[id])).rows[0].count).toBe(1);
    } else {
      expect(finance.reason).toMatchObject({statusCode:409});
      if(edit.status!=="fulfilled")throw edit.reason;
      await contractService.generateIfReady(rootActor(),id,edit.value);
      await service.recordFinanceReconciliation(financeActor(),id,{result:"match"},randomUUID());
      expect((await contractService.getCurrent(rootActor(),id)).item?.sourcingContractDocumentId).toBe(edit.value);
    }
    await expect(contractService.content.get(rootActor(),id)).rejects.toMatchObject({statusCode:403});
  });

  it("freezes transfer craft proposals on existing orders through the unchanged approval chain", async () => {
    const open = async (label: string) => {
      const id=(await service.createCase(merchandiserActor(),{gender:"男装",styleName:label,
        estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-20",
        lineItems:[{styleNo:"CRAFT-TRANSFER-"+label,color:"黑",quantity:100}],daxingUnitPrice:"8",attachmentIds:[]},randomUUID())).value.sourcingCaseId;
      await service.quoteIePrice(ieActor(),id,{unitPrice:"10"},randomUUID());
      await service.recordManagementDecision(managerActor(),id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],unitPrice:"10"},randomUUID());
      return id;
    };
    const id=await open("EXISTING");
    const old=(await database.query("SELECT * FROM sourcing_decisions WHERE sourcing_case_id=$1",[id])).rows[0];
    const request={supplierId:replacementFactoryId,unitPrice:"9",craftIds:[craftId("整烫"),craftId("净色车缝")],changeReason:"既有单修改承包工艺"};
    const key=randomUUID();
    await service.requestFactoryChange(factoryChangeActor(),id,request,key);
    await service.requestFactoryChange(factoryChangeActor(),id,request,key);
    expect((await database.query("SELECT * FROM sourcing_factory_change_requests WHERE sourcing_case_id=$1",[id])).rowCount).toBe(1);
    expect((await service.getCase(readerActor(),id)).processes).toEqual(["净色车缝"]);
    const pending=(await service.getCurrentFactoryChange(readerActor(),id)).item!;
    expect(pending).toMatchObject({status:"pending_management",changesCrafts:true,proposedProcesses:["整烫","净色车缝"]});
    await expect(service.requestFactoryChange(managerActor(),id,request,randomUUID())).rejects.toMatchObject({code:"CONFLICT"});
    await expect(service.decideFactoryChange({...ownerActor(),authorizationCapability:"sourcing:owner:approve"},id,pending.factoryChangeRequestId,{decision:"approved",verificationReason:"不可提前审批"},randomUUID())).rejects.toMatchObject({code:"INVALID_STATE_TRANSITION"});
    await expect(service.decideFactoryChange(financeActor(),id,pending.factoryChangeRequestId,{decision:"approved",verificationReason:"越权"},randomUUID())).rejects.toMatchObject({code:"FORBIDDEN"});
    await expect(service.decideFactoryChange({...managerActor(),actorRoles:[],authorizationCapability:"sourcing:factory_change:verify"},id,pending.factoryChangeRequestId,{decision:"approved",verificationReason:"角色已撤销"},randomUUID())).rejects.toMatchObject({code:"FORBIDDEN"});
    const review={decision:"approved" as const,verificationReason:"确认工艺与价格"};
    const reviewKey=randomUUID();
    await service.decideFactoryChange({...managerActor(),authorizationCapability:"sourcing:factory_change:verify"},id,pending.factoryChangeRequestId,review,reviewKey);
    await service.decideFactoryChange({...managerActor(),authorizationCapability:"sourcing:factory_change:verify"},id,pending.factoryChangeRequestId,review,reviewKey);
    const effective=await service.getCase(readerActor(),id);
    expect(effective.processes).toEqual(["整烫","净色车缝"]);
    expect((await database.query("SELECT * FROM sourcing_decisions WHERE sourcing_decision_id=$1",[old.sourcing_decision_id])).rows[0]).toEqual(old);
    await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
    expect((await service.getCase(readerActor(),id)).approvalSnapshot?.processes).toEqual(["整烫","净色车缝"]);
    expect((await contractService.content.get(rootActor(),id)).content.processes).toEqual(["整烫","净色车缝"]);
    const catalogActor={...rootActor(),authorizationCapability:"master_data:manage"};
    const [frozenCraft]=await craftService.ensureCrafts(catalogActor,{craftNames:["冻结工艺甲"]});
    const frozenId=await open("CATALOG");
    await service.requestFactoryChange(managerActor(),frozenId,{...request,unitPrice:"11",craftIds:[frozenCraft!.craftId]},randomUUID());
    const frozen=(await service.getCurrentFactoryChange(readerActor(),frozenId)).item!;
    await craftService.reviseCraft(catalogActor,frozenCraft!.craftId,{craftName:"冻结工艺乙",active:false,changeReason:"申请后停用目录"});
    expect((await service.getCurrentFactoryChange(readerActor(),frozenId)).item?.proposedProcesses).toEqual(["冻结工艺甲"]);
    await service.decideFactoryChange(ownerActor(),frozenId,frozen.factoryChangeRequestId,review,randomUUID());
    expect((await service.getCase(readerActor(),frozenId)).processes).toEqual(["冻结工艺甲"]);
    const inactiveId=await open("INACTIVE");
    await expect(service.requestFactoryChange(ownerActor(),inactiveId,{...request,craftIds:[frozenCraft!.craftId]},randomUUID())).rejects.toMatchObject({code:"CONFLICT"});
    const rejectedId=await open("REJECTED");
    await service.requestFactoryChange(managerActor(),rejectedId,{...request,unitPrice:"11"},randomUUID());
    const rejected=(await service.getCurrentFactoryChange(readerActor(),rejectedId)).item!;
    expect(rejected.status).toBe("pending_owner");
    await service.decideFactoryChange(ownerActor(),rejectedId,rejected.factoryChangeRequestId,{decision:"rejected",verificationReason:"保留原工艺"},randomUUID());
    expect((await service.getCase(readerActor(),rejectedId)).processes).toEqual(["净色车缝"]);
    const directId=await open("OWNER");
    await service.requestFactoryChange(ownerActor(),directId,{...request,unitPrice:"12"},randomUUID());
    expect((await service.getCurrentFactoryChange(readerActor(),directId)).item?.status).toBe("effective");
    expect((await service.getCase(readerActor(),directId)).processes).toEqual(["整烫","净色车缝"]);
    const legacyId=await open("LEGACY");
    await service.requestFactoryChange(managerActor(),legacyId,{supplierId:replacementFactoryId,unitPrice:"9",changeReason:"旧客户端继承工艺"},randomUUID());
    expect((await service.getCase(readerActor(),legacyId)).processes).toEqual(["净色车缝"]);
    await expect(service.requestFactoryChange(ownerActor(),legacyId,{...request,supplierId:factoryId,craftIds:[randomUUID()]},randomUUID())).rejects.toMatchObject({code:"CONFLICT"});
    const staleId=await open("CONTRACT-BASIS");
    await service.decideOwner(ownerActor(),staleId,{decision:"approved"},randomUUID());
    await service.requestFactoryChange(managerActor(),staleId,{...request,unitPrice:"11"},randomUUID());
    const stale=(await service.getCurrentFactoryChange(readerActor(),staleId)).item!;
    const contract=await contractService.content.get(rootActor(),staleId);
    await contractService.content.save(rootActor(),staleId,{...contract,content:{...contract.content,deliveryDate:"2026-11-01",lines:[...contract.content.lines,...contract.content.lines]}},randomUUID());
    await expect(service.decideFactoryChange(ownerActor(),staleId,stale.factoryChangeRequestId,review,randomUUID())).rejects.toMatchObject({code:"CONFLICT"});
    expect((await service.getCase(readerActor(),staleId)).processes).toEqual(["净色车缝"]);
    expect((await service.getCase(readerActor(),staleId)).contractDisplay?.linesMatchOrder).toBe(false);
    await service.decideFactoryChange(ownerActor(),staleId,stale.factoryChangeRequestId,{decision:"rejected",verificationReason:"合同变化重新申请"},randomUUID());
  });


  let cycleTodoRecipientsConfigured = false;
  const cycleTodoServices = async () => {
    if (!cycleTodoRecipientsConfigured) {
      await ensureReturnTodoRecipient();
      for (const [id, role] of [[ieId, "ie_reviewer"], [managerId, "production_management"],
        [ownerId, "owner_group"], [financeId, "factory_payables"]]) {
        if (id !== ownerId) await database.query(
          `INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
           VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`,
          [randomUUID(), id, `ding-${id}`, `union-${id}`]);
        await database.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation");
        try {
          await database.query(`INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason)
            SELECT $1,$2,$3,$2,'isolated sourcing cycle regression' WHERE NOT EXISTS(
              SELECT 1 FROM user_role_assignments WHERE user_id=$2 AND role_code=$3 AND revoked_at IS NULL)`, [randomUUID(), id, role]);
        } finally { await database.query("ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation"); }
      }
      cycleTodoRecipientsConfigured = true;
    }
    const projection = new TodoProjectionService(new TodoService(database));
    return { projection, service: new SourcingService(database, undefined, undefined, projection, contractService) };
  };
  const cycleSnapshot = async (id: string) => ({
    facts: (await database.query(`SELECT
      (SELECT count(*)::int FROM sourcing_case_transitions WHERE sourcing_case_id=$1) transitions,
      (SELECT count(*)::int FROM sourcing_ie_quotes WHERE sourcing_case_id=$1) quotes,
      (SELECT count(*)::int FROM sourcing_decisions WHERE sourcing_case_id=$1) decisions,
      (SELECT count(*)::int FROM sourcing_owner_decisions WHERE sourcing_case_id=$1) owners,
      (SELECT count(*)::int FROM sourcing_case_corrections WHERE sourcing_case_id=$1) corrections,
      (SELECT count(*)::int FROM sourcing_approval_snapshots WHERE sourcing_case_id=$1) approvals`, [id])).rows[0],
    todos: (await database.query(`SELECT todo_id,category,dedupe_key,source_event_id,source_action,status,version,updated_at
      FROM rework_todos WHERE entity_id=$1 ORDER BY todo_id`, [id])).rows,
    deliveries: (await database.query(`SELECT a.* FROM todo_delivery_attempts a
      JOIN rework_todos t USING(todo_id) WHERE t.entity_id=$1 ORDER BY a.delivery_attempt_id`, [id])).rows,
  });

  it("keeps real sourcing todos distinct across repeated owner rejection and merchandiser correction cycles", async () => {
    const { projection, service: currentService } = await cycleTodoServices();
    // Persist the pre-upgrade identities on the first pass through management.
    const legacyProjection = {
      ...todoProjection,
      completeOpenByDedupePrefix: projection.completeOpenByDedupePrefix.bind(projection),
      actionableForNamedRecipient: projection.actionableForNamedRecipient.bind(projection),
      actionableForAllAssignedRole: async (...args: Parameters<TodoProjectionService["actionableForAllAssignedRole"]>) => {
        const [client, actor, input] = args;
        const event = (await client.query("SELECT before_state,after_state FROM operation_events WHERE event_id=$1", [input.sourceEventId])).rows[0];
        const legacyVersion = input.sourceAction === "sourcing.ie_price.quote" ? event.after_state.quoteVersion
          : input.sourceAction === "sourcing.owner.reject" ? Number(event.before_state.decisionVersion) + 1 : null;
        return projection.actionableForAllAssignedRole(client, actor, legacyVersion === null ? input
          : { ...input, dedupeKey: `sourcing:${input.entityId}:management:${legacyVersion}` });
      },
    };
    const legacyService = new SourcingService(database, undefined, undefined, legacyProjection, contractService);
    const image = await readyCuttingSheet(merchandiserId);
    const original = { gender: "男装" as const, styleName: "真实待办循环", estimatedCutPieceSendDate: "2026-10-01",
      deliveryDate: "2026-10-12", lineItems: [{ styleNo: "REAL-TODO-CYCLE", color: "蓝", quantity: 20 }],
      daxingUnitPrice: "7", attachmentIds: [image] };
    const createKey = randomUUID();
    const created = await legacyService.createCase(merchandiserActor(), original, createKey);
    const id = created.value.sourcingCaseId;
    const createdSnapshot = await cycleSnapshot(id);
    expect((await legacyService.createCase(merchandiserActor(), original, createKey)).reused).toBe(true);
    expect(await cycleSnapshot(id)).toEqual(createdSnapshot);
    const prices = { linePrices: [{ position: 1, unitPrice: "11" }] };
    const management = { supplierId: factoryId, craftIds: [craftId("净色车缝")], linePrices: prices.linePrices };
    const beforeDenied = await cycleSnapshot(id);
    await expect(currentService.quoteIePrice(merchandiserActor(), id, prices, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    await expect(currentService.recordManagementDecision(ieActor(), id, management, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    await expect(currentService.decideOwner(managerActor(), id, { decision: "rejected" }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    await expect(currentService.returnToMerchandiser(merchandiserActor(), id, { expectedVersion: created.value.version, reason: "越权" }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    expect(await cycleSnapshot(id)).toEqual(beforeDenied);

    type Write = (key: string) => Promise<Awaited<ReturnType<SourcingService["quoteIePrice"]>>>;
    const replays: (() => ReturnType<Write>)[] = [];
    const categories: Record<string, string> = { pending_ie_quote: "sourcing_ie_quote",
      pending_management_decision: "sourcing_management_decision", pending_owner_approval: "sourcing_owner_approval",
      pending_merchandiser_correction: "sourcing_merchandiser_correction" };
    const run = async (write: Write) => {
      const terminal = (await cycleSnapshot(id)).todos.filter(todo => ["completed", "cancelled"].includes(todo.status));
      const key = randomUUID();
      const result = await write(key);
      expect(result.reused).toBe(false);
      const snapshot = await cycleSnapshot(id);
      expect((await write(key)).reused).toBe(true);
      expect(await cycleSnapshot(id)).toEqual(snapshot);
      const newKey = randomUUID();
      await expect(write(newKey)).rejects.toMatchObject({ statusCode: 409 });
      expect(await cycleSnapshot(id)).toEqual(snapshot);
      expect((await database.query("SELECT count(*)::int count FROM idempotency_records WHERE idempotency_key=$1", [newKey])).rows[0].count).toBe(0);
      const actionable = snapshot.todos.filter(todo => ["pending", "blocked_recipient"].includes(todo.status)
        && Object.values(categories).includes(todo.category));
      expect(actionable.map(todo => todo.category)).toEqual(categories[result.value.status] ? [categories[result.value.status]] : []);
      for (const old of terminal) expect(snapshot.todos.find(todo => todo.todo_id === old.todo_id)).toEqual(old);
      replays.push(() => write(key));
      return result.value;
    };
    await run(key => legacyService.quoteIePrice(ieActor(), id, prices, key));
    for (let round = 0; round < 2; round++) {
      const actingService = round === 0 ? legacyService : currentService;
      await run(key => actingService.recordManagementDecision(managerActor(), id, management, key));
      await run(key => actingService.decideOwner(ownerActor(), id, { decision: "rejected" }, key));
      const decided = await run(key => currentService.recordManagementDecision(managerActor(), id, management, key));
      const returned = await run(key => currentService.returnToMerchandiser(ownerActor(), id,
        { expectedVersion: decided.version, reason: "核实颜色" }, key));
      const correction = { gender: original.gender, styleName: original.styleName, estimatedCutPieceSendDate: original.estimatedCutPieceSendDate,
        deliveryDate: original.deliveryDate, lineItems: [{ ...original.lineItems[0]!, color: round === 0 ? "红" : "白" }],
        attachmentIds: original.attachmentIds, expectedVersion: returned.version, reason: "颜色已核实" };
      const beforeWrongRole = await cycleSnapshot(id);
      await expect(currentService.correctCase(ieActor(), id, correction, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
      expect(await cycleSnapshot(id)).toEqual(beforeWrongRole);
      await run(key => currentService.correctCase(merchandiserActor(), id, correction, key));
      await run(key => currentService.quoteIePrice(ieActor(), id, prices, key));
    }
    await run(key => currentService.recordManagementDecision(managerActor(), id, management, key));
    await run(key => currentService.decideOwner(ownerActor(), id, { decision: "approved" }, key));
    const final = await cycleSnapshot(id);
    expect(final.facts).toMatchObject({ quotes: 3, decisions: 5, owners: 3, corrections: 2, approvals: 1 });
    expect(final.todos.find(todo => todo.dedupe_key === `sourcing:${id}:management:2:${managerId}`)?.status).toBe("completed");
    const entries = final.todos.filter(todo => todo.dedupe_key.includes(":management:transition:"));
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map(todo => todo.dedupe_key)).size).toBe(3);
    for (const replay of replays) {
      expect((await replay()).reused).toBe(true);
      expect(await cycleSnapshot(id)).toEqual(final);
    }
    expect((await currentService.getCase(readerActor(), id)).status).toBe("pending_finance_reconciliation");
  });

  it("rolls back real sourcing todo completion and creation before retrying the same IE request", async () => {
    const { projection, service: currentService } = await cycleTodoServices();
    const created = await currentService.createCase(merchandiserActor(), { gender: "男装", styleName: "报价回滚",
      estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-10-12",
      lineItems: [{ styleNo: "REAL-TODO-ROLLBACK", color: "蓝", quantity: 20 }], daxingUnitPrice: "7" }, randomUUID());
    const id = created.value.sourcingCaseId;
    const before = await cycleSnapshot(id);
    const failedProjection = {
      ...todoProjection,
      completeOpenByDedupePrefix: projection.completeOpenByDedupePrefix.bind(projection),
      actionableForAllAssignedRole: async (...args: Parameters<TodoProjectionService["actionableForAllAssignedRole"]>) => {
        await projection.actionableForAllAssignedRole(...args);
        throw new Error("isolated failure after real todo creation");
      },
    };
    const failingService = new SourcingService(database, undefined, undefined, failedProjection, contractService);
    const key = randomUUID();
    const prices = { linePrices: [{ position: 1, unitPrice: "11" }] };
    await expect(failingService.quoteIePrice(ieActor(), id, prices, key)).rejects.toThrow("isolated failure after real todo creation");
    expect(await cycleSnapshot(id)).toEqual(before);
    expect((await database.query("SELECT count(*)::int count FROM idempotency_records WHERE idempotency_key=$1", [key])).rows[0].count).toBe(0);
    const [first, retry] = await Promise.all([
      currentService.quoteIePrice(ieActor(), id, prices, key),
      currentService.quoteIePrice(ieActor(), id, prices, key),
    ]);
    expect([first.reused, retry.reused].sort()).toEqual([false, true]);
    const after = await cycleSnapshot(id);
    expect(after.facts).toMatchObject({ transitions: 2, quotes: 1 });
    expect(after.todos.filter(todo => todo.status === "pending").map(todo => todo.category)).toEqual(["sourcing_management_decision"]);
    expect(after.todos.find(todo => todo.category === "sourcing_ie_quote")?.status).toBe("completed");
    await expect(currentService.quoteIePrice(ieActor(), id, prices, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    expect(await cycleSnapshot(id)).toEqual(after);
  });


  it("only compensates an explicitly proven completed round; preview is read-only and peers receive terminal delivery", async () => {
    const { projection,service:currentService } = await cycleTodoServices();
    const secondManager = randomUUID();
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST second director',true)",[secondManager]);
    await database.query(`INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
      VALUES($1,$2::uuid,'dingtalk','corp',$2::uuid::text,$2::uuid::text,true,true,CURRENT_TIMESTAMP)`,[randomUUID(),secondManager]);
    const legacyProjection = {...todoProjection,
      actionableForAllAssignedRole:projection.actionableForAllAssignedRole.bind(projection),
      // Reproduce the pre-upgrade orphan, retaining its genuine source event.
      completeOpenByDedupePrefix:async(...args:Parameters<TodoProjectionService["completeOpenByDedupePrefix"]>)=>
        args[2].includes(":management:") ? 0 : projection.completeOpenByDedupePrefix(...args),
    };
    const oldService = new SourcingService(database,undefined,undefined,legacyProjection,contractService);
    const created = await oldService.createCase(merchandiserActor(),{gender:"男装",styleName:"TEST stale todo proof",
      estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-12",lineItems:[{styleNo:"TEST-TODO-PROOF",color:"黑",quantity:20}],daxingUnitPrice:"7"},randomUUID());
    const id = created.value.sourcingCaseId;
    const originalEvent=(await database.query("SELECT operation_event_id FROM sourcing_case_transitions WHERE sourcing_case_id=$1 AND sequence=1",[id])).rows[0].operation_event_id;
    const unknownClient=await database.connect();
    try {await unknownClient.query("BEGIN");await projection.actionableForAllAssignedRole(unknownClient,merchandiserActor(),{
      category:"sourcing_management_decision",sourceEventId:originalEvent,sourceAction:"sourcing.case.create",entityType:"sourcing_case",entityId:id,
      requiredRole:"production_management",requiredCapability:"sourcing:decision:record",route:{routeName:"sourcing_detail",entityId:id},policyKey:"general",dedupeKey:`sourcing:${id}:management:99`});await unknownClient.query("COMMIT");}
    catch(error){await unknownClient.query("ROLLBACK");throw error;}finally{unknownClient.release();}

    const prices = {linePrices:[{position:1,unitPrice:"11"}]};
    await oldService.quoteIePrice(ieActor(),id,prices,randomUUID());
    const provider = new FakeDingTalkTodoProvider();
    const worker = new TodoDeliveryWorker(database,provider,"https://todo.example.test/");
    for (let i=0;i<10;i++) { const r = await worker.runOnce(100); if (!r.claimed) break; }
    // Sequential director handover retains two recipient facts while preserving
    // the real singleton-role constraint: no relaxed production permissions.
    await database.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_revoke_only");
    try {await database.query("UPDATE user_role_assignments SET revoked_at=CURRENT_TIMESTAMP,revoked_by=$1,revoke_reason='TEST historical handover' WHERE user_id=$1 AND role_code='production_management' AND revoked_at IS NULL",[managerId]);}
    finally {await database.query("ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_revoke_only");}
    await database.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation");
    try { await database.query(`INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason)
      VALUES($1,$2,'production_management',$2,'TEST parallel director')`,[randomUUID(),secondManager]); }
    finally { await database.query("ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation"); }
    const quote = (await database.query("SELECT operation_event_id FROM sourcing_ie_quotes WHERE sourcing_case_id=$1",[id])).rows[0];
    const client = await database.connect();
    try {await client.query("BEGIN");await projection.actionableForAllAssignedRole(client,ieActor(),{
      category:"sourcing_management_decision",sourceEventId:quote.operation_event_id,sourceAction:"sourcing.ie_price.quote",entityType:"sourcing_case",entityId:id,
      requiredRole:"production_management",requiredCapability:"sourcing:decision:record",route:{routeName:"sourcing_detail",entityId:id},policyKey:"general",dedupeKey:`sourcing:${id}:management:1`});await client.query("COMMIT");}
    catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}

    await oldService.recordManagementDecision({...managerActor(),actorId:secondManager},id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:prices.linePrices},randomUUID());
    await currentService.decideOwner(ownerActor(),id,{decision:"rejected",rejectionReason:"TEST re-enter management"},randomUUID());
    const live = await currentService.createCase(merchandiserActor(),{gender:"男装",styleName:"TEST live IE",
      estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-12",lineItems:[{styleNo:"TEST-LIVE-IE",color:"白",quantity:10}],daxingUnitPrice:"7"},randomUUID());
    const repair = new SourcingTodoReconciliationService(database);

    for (let i=0;i<10;i++) { const r = await worker.runOnce(100); if (!r.claimed) break; }
    const before = await cycleSnapshot(id); const liveBefore = await cycleSnapshot(live.value.sourcingCaseId);
    const preview = await repair.preview(rootActor(),[id,live.value.sourcingCaseId]);
    expect(preview.mode).toBe("dry_run");expect(preview.results.filter(row=>row.eligible)).toHaveLength(2);
    expect(preview.results.filter(row=>!row.eligible)).toHaveLength(3);
    expect(await cycleSnapshot(id)).toEqual(before);expect(await cycleSnapshot(live.value.sourcingCaseId)).toEqual(liveBefore);
    await expect(repair.preview(managerActor(),[id])).rejects.toMatchObject({statusCode:403});
    const selected = preview.results.flatMap(row=>row.eligible?[{todoId:row.todoId,evidenceHash:row.evidenceHash}]:[]);
    await expect(repair.apply(managerActor(),selected,"TEST denial",randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(repair.apply(rootActor(),[{...selected[0]!,evidenceHash:"0".repeat(64)}],"TEST stale evidence",randomUUID())).rejects.toMatchObject({statusCode:409});
    expect(await cycleSnapshot(id)).toEqual(before);
    const key = randomUUID(); const operator = {...rootActor(),authorizationCapability:"todo:routing_exception_manage"};
    const done = await repair.apply(operator,selected,"TEST isolated compensation",key);
    expect(done.completedTodoIds.sort()).toEqual(selected.map(row=>row.todoId).sort());expect(done.reused).toBe(false);
    const after = await cycleSnapshot(id);expect(after.facts).toEqual(before.facts);
    expect(after.todos.filter(row=>selected.some(item=>item.todoId===row.todo_id)).every(row=>row.status==="completed")).toBe(true);
    expect(after.todos.find(row=>row.source_action==="sourcing.owner.reject")?.status).toBe("pending");
    expect(after.todos.find(row=>row.dedupe_key.includes(":management:99:"))?.status).toBe("pending");
    expect((await repair.apply(operator,selected,"TEST isolated compensation",key)).reused).toBe(true);
    expect(await cycleSnapshot(id)).toEqual(after);expect(await cycleSnapshot(live.value.sourcingCaseId)).toEqual(liveBefore);
    expect((await database.query(`SELECT after_state FROM operation_events WHERE action='sourcing.todo.reconcile' AND entity_id=$1`,[key])).rows[0].after_state.proofs).toHaveLength(2);
    for (let i=0;i<10;i++) { const r = await worker.runOnce(100); if (!r.claimed) break; }
    expect(provider.calls.filter(call=>call.method==="complete" && selected.some(row=>call.input.sourceKey.includes(row.todoId)))).toHaveLength(2);
    const app = Fastify();
    app.setErrorHandler((error,_request,reply)=>reply.code((error as {statusCode?:number}).statusCode??500).send({error:error.message}));
    registerTodoRoutes(app,{service:new TodoService(database),sourcingReconciliation:repair,
      root:new RootAuthority(database,"corp",`ding-${merchandiserId}`),
      authenticate:async token=>{ if (!token) throw Object.assign(new Error("unauthorized"),{statusCode:401});
        return {id:token,displayName:"TEST",businessRoles:["root_superuser"],capabilities:["todo:routing_exception_manage"]}; }});
    await app.ready();
    try {
      expect((await app.inject({method:"POST",url:"/todos/sourcing-reconciliation/preview",payload:{}})).statusCode).toBe(401);
      expect((await app.inject({method:"POST",url:"/todos/sourcing-reconciliation/preview",headers:{cookie:`dx_rework_session=${managerId}`},payload:{}})).statusCode).toBe(403);
      const result = await app.inject({method:"POST",url:"/todos/sourcing-reconciliation/preview",headers:{cookie:`dx_rework_session=${merchandiserId}`},payload:{caseIds:[id]}});
      expect(result.statusCode).toBe(200);expect(result.headers["cache-control"]).toBe("no-store");
    } finally { await app.close(); }
  });

  const openNamedCraftTransfer = async () => {
    const label=`NAME-${randomUUID()}`;
    const id=(await service.createCase(merchandiserActor(),{gender:"男装",styleName:label,
      estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-20",
      lineItems:[{styleNo:label,color:"黑",quantity:100}],daxingUnitPrice:"8",attachmentIds:[]},randomUUID())).value.sourcingCaseId;
    await service.quoteIePrice(ieActor(),id,{unitPrice:"10"},randomUUID());
    await service.recordManagementDecision(managerActor(),id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],unitPrice:"10"},randomUUID());
    return id;
  };

  it("remembers named transfer crafts in the successful order transaction for each original initiator", async () => {
    const actors=[factoryChangeActor(),managerActor(),ownerActor(),{...rootActor(),authorizationCapability:"sourcing:decision:record"}];
    for(const actor of actors) {
      const id=await openNamedCraftTransfer();
      await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
      const oldDecision=(await database.query("SELECT * FROM sourcing_decisions WHERE sourcing_case_id=$1 ORDER BY decision_version",[id])).rows;
      const oldContracts=(await database.query("SELECT * FROM sourcing_contract_documents WHERE sourcing_case_id=$1 ORDER BY contract_version",[id])).rows;
      const term=`Remember-${randomUUID()}+线，包装/装箱`;
      const input={supplierId:replacementFactoryId,unitPrice:"9",craftNames:[`  ${term}  `,"净色车缝"],changeReason:"新厂实际承包工艺"};
      const key=randomUUID();
      const first=await service.requestFactoryChange(actor,id,input,key);
      const repeated=await service.requestFactoryChange({...actor,requestId:randomUUID()},id,input,key);
      expect(first.reused).toBe(false);expect(repeated.reused).toBe(true);
      const pending=(await service.getCurrentFactoryChange(readerActor(),id)).item!;
      expect(pending.proposedProcesses).toEqual([term,"净色车缝"]);
      const catalog=(await database.query("SELECT * FROM current_craft_catalog WHERE normalized_name=lower(btrim($1))",[term])).rows;
      expect(catalog).toHaveLength(1);expect(catalog[0]).toMatchObject({version:1,craft_name:term,active:true});
      expect((await database.query("SELECT * FROM sourcing_factory_change_requests WHERE sourcing_case_id=$1",[id])).rows).toHaveLength(1);
      if(actor.authorizationCapability==="sourcing:factory_change:request") {
        expect((await service.getCase(readerActor(),id)).processes).toEqual(["净色车缝"]);
        await service.decideFactoryChange(factoryChangeVerifier(),id,pending.factoryChangeRequestId,{decision:"approved",verificationReason:"确认"},randomUUID());
      }
      expect((await service.getCase(readerActor(),id)).processes).toEqual([term,"净色车缝"]);
      expect((await contractService.content.get(rootActor(),id)).content.processes).toEqual([term,"净色车缝"]);
      for(const row of oldDecision) expect((await database.query("SELECT * FROM sourcing_decisions WHERE sourcing_decision_id=$1",[row.sourcing_decision_id])).rows[0]).toEqual(row);
      for(const row of oldContracts) expect((await database.query("SELECT * FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",[row.sourcing_contract_document_id])).rows[0]).toEqual(row);
      const another=await openNamedCraftTransfer();
      await service.requestFactoryChange(managerActor(),another,{...input,craftNames:[term.toUpperCase()]},randomUUID());
      expect((await database.query("SELECT craft_id FROM current_craft_catalog WHERE normalized_name=lower($1)",[term])).rows).toEqual([{craft_id:catalog[0].craft_id}]);
      expect((await service.getCase(readerActor(),another)).processes).toEqual([term]);
    }
  });

  it("rolls back named transfer crafts on invalid orders, duplicates, inactive terms and failed commit", async () => {
    const id=await openNamedCraftTransfer();
    const term=`Rollback-${randomUUID()}`;
    const input={supplierId:replacementFactoryId,unitPrice:"9",craftNames:[term],changeReason:"检查原事务"};
    for (const actor of [financeActor(), {...factoryChangeActor(),actorRoles:[]},
      {...managerActor(),actorRoles:["warehouse_keeper"]}, {...ownerActor(),actorRoles:["order_merchandiser"]}])
      await expect(service.requestFactoryChange(actor,id,input,randomUUID())).rejects.toMatchObject({code:"FORBIDDEN"});
    await expect(service.requestFactoryChange(factoryChangeActor(),randomUUID(),input,randomUUID())).rejects.toMatchObject({code:"NOT_FOUND"});
    await expect(service.requestFactoryChange(factoryChangeActor(),id,{...input,supplierId:factoryId},randomUUID())).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    await expect(service.requestFactoryChange(factoryChangeActor(),id,{...input,craftNames:[term,term.toUpperCase()]},randomUUID())).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    await expect(service.requestFactoryChange(factoryChangeActor(),id,{...input,craftNames:[term,"整烫"],craftIds:[craftId("净色车缝")]},randomUUID())).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    const catalogActor={...rootActor(),authorizationCapability:"master_data:manage"};
    const [inactive]=await craftService.ensureCrafts(catalogActor,{craftNames:[`Inactive-${randomUUID()}`]});
    await craftService.reviseCraft(catalogActor,inactive!.craftId,{craftName:inactive!.craftName,active:false,changeReason:"停用"});
    await expect(service.requestFactoryChange(factoryChangeActor(),id,{...input,craftNames:[term,inactive!.craftName]},randomUUID())).rejects.toMatchObject({code:"CONFLICT"});
    expect((await database.query("SELECT * FROM craft_catalog_items WHERE normalized_name=lower($1)",[term])).rowCount).toBe(0);
    expect((await database.query("SELECT active FROM current_craft_catalog WHERE craft_id=$1",[inactive!.craftId])).rows[0].active).toBe(false);
    for(const actor of [factoryChangeActor(),ownerActor()])
      await expect(craftService.ensureCrafts(actor,{craftNames:[term]})).rejects.toMatchObject({code:"CONFLICT"});
    // Force a late failure after name resolution without weakening any business guard.
    await database.query(`CREATE FUNCTION test_named_transfer_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture late transfer failure'; END $$;
      CREATE TRIGGER test_named_transfer_failure BEFORE INSERT ON sourcing_factory_change_requests FOR EACH ROW EXECUTE FUNCTION test_named_transfer_failure()`);
    try {await expect(service.requestFactoryChange(factoryChangeActor(),id,input,randomUUID())).rejects.toThrow("fixture late transfer failure");}
    finally {await database.query("DROP TRIGGER test_named_transfer_failure ON sourcing_factory_change_requests; DROP FUNCTION test_named_transfer_failure()");}
    expect((await database.query("SELECT * FROM craft_catalog_items WHERE normalized_name=lower($1)",[term])).rowCount).toBe(0);
    expect((await database.query("SELECT * FROM sourcing_factory_change_requests WHERE sourcing_case_id=$1",[id])).rowCount).toBe(0);
    const client=await database.connect();
    try {
      await client.query("BEGIN");
      const fakeCraftId=randomUUID(),fakeRequestId=randomUUID();
      const fakeCraftCode=`CRAFT_${randomUUID().replaceAll("-", "").slice(0,24).toUpperCase()}`;
      const actor=factoryChangeActor();
      const eventId=await new OperationEventRepository().append(client,actor,{action:"master_data.craft.create",entityType:"craft_catalog",entityId:fakeCraftId,
        after:{craftId:fakeCraftId,craftCode:fakeCraftCode,version:1,craftName:term,active:true,sourcingCaseId:id,factoryChangeRequestId:fakeRequestId},reason:"伪造转厂"});
      await client.query("INSERT INTO craft_catalog_items(craft_id,craft_code,craft_name,created_by,operation_event_id,request_id) VALUES($1,$2,$3,$4,$5,$6)",[fakeCraftId,fakeCraftCode,term,actor.actorId,eventId,actor.requestId]);
      await client.query("INSERT INTO craft_catalog_versions(craft_id,version,craft_name,active,change_reason,changed_by,operation_event_id,request_id) VALUES($1,1,$2,true,'伪造转厂',$3,$4,$5)",[fakeCraftId,term,actor.actorId,eventId,actor.requestId]);
      await expect(client.query("COMMIT")).rejects.toMatchObject({code:"55000"});
    } finally {await client.query("ROLLBACK");client.release();}
    expect((await database.query("SELECT * FROM craft_catalog_items WHERE normalized_name=lower($1)",[term])).rowCount).toBe(0);
  });

  it("serializes concurrent orders remembering the same term into one catalog identity", async () => {
    const ids=await Promise.all([openNamedCraftTransfer(),openNamedCraftTransfer()]);
    const term=`Concurrent-${randomUUID()}`;
    await Promise.all(ids.map((id,i)=>service.requestFactoryChange(i?ownerActor():managerActor(),id,
      {supplierId:replacementFactoryId,unitPrice:"9",craftNames:[i?term.toUpperCase():term],changeReason:"共享新词"},randomUUID())));
    const catalog=(await database.query("SELECT craft_id,craft_name FROM current_craft_catalog WHERE normalized_name=lower($1)",[term])).rows;
    expect(catalog).toHaveLength(1);
    const snapshots=(await database.query("SELECT crafts FROM sourcing_decisions WHERE sourcing_case_id=ANY($1::uuid[]) AND decision_version=2",[ids])).rows;
    expect(snapshots).toHaveLength(2);
    for(const row of snapshots)expect(row.crafts[0]).toMatchObject({craftId:catalog[0].craft_id,craftName:catalog[0].craft_name,craftVersion:1});
  });

  it("reports renamed stable names explicitly and preserves their current versions and inactive state", async () => {
    const catalogActor={...rootActor(),authorizationCapability:"master_data:manage"};
    const original=`Previous-${randomUUID()}`, renamed=`Current-${randomUUID()}`, fresh=`NotSaved-${randomUUID()}`;
    const [craft]=await craftService.ensureCrafts(catalogActor,{craftNames:[original]});
    await craftService.reviseCraft(catalogActor,craft!.craftId,{craftName:renamed,active:true,changeReason:"目录更名"});
    const id=await openNamedCraftTransfer();
    const input={supplierId:replacementFactoryId,unitPrice:"9",craftNames:[fresh,`  ${original.toUpperCase()}  `],changeReason:"曾用名转厂"};
    await expect(service.requestFactoryChange(managerActor(),id,input,randomUUID()))
      .rejects.toMatchObject({code:"CONFLICT",message:expect.stringContaining(`请使用当前名称`)});
    expect((await database.query("SELECT * FROM craft_catalog_items WHERE normalized_name=lower($1)",[fresh])).rowCount).toBe(0);
    expect((await database.query("SELECT * FROM operation_events WHERE action='master_data.craft.create' AND after_state->>'craftName'=$1",[fresh])).rowCount).toBe(0);
    expect((await database.query("SELECT * FROM sourcing_factory_change_requests WHERE sourcing_case_id=$1",[id])).rowCount).toBe(0);
    expect((await database.query("SELECT version,craft_name,active FROM current_craft_catalog WHERE craft_id=$1",[craft!.craftId])).rows)
      .toEqual([{version:2,craft_name:renamed,active:true}]);
    await service.requestFactoryChange(managerActor(),id,{...input,craftNames:[renamed.toUpperCase()]},randomUUID());
    expect((await database.query("SELECT crafts FROM sourcing_decisions WHERE sourcing_case_id=$1 AND decision_version=2",[id])).rows[0].crafts[0])
      .toMatchObject({craftId:craft!.craftId,craftVersion:2,craftName:renamed});
    await craftService.reviseCraft(catalogActor,craft!.craftId,{craftName:renamed,active:false,changeReason:"更名后停用"});
    const inactiveId=await openNamedCraftTransfer();
    await expect(service.requestFactoryChange(ownerActor(),inactiveId,input,randomUUID()))
      .rejects.toMatchObject({code:"CONFLICT",message:expect.stringContaining("已停用")});
    expect((await database.query("SELECT * FROM craft_catalog_items WHERE normalized_name=lower($1)",[fresh])).rowCount).toBe(0);
    expect((await database.query("SELECT version,active FROM current_craft_catalog WHERE craft_id=$1",[craft!.craftId])).rows)
      .toEqual([{version:3,active:false}]);
  });

  it("adds version one to a genuinely unversioned historical identity in the successful transfer", async () => {
    const actor={...rootActor(),authorizationCapability:"master_data:manage"};
    const term=`Legacy-${randomUUID()}`, legacyId=randomUUID(), legacyCode=`CRAFT_${randomUUID().replaceAll("-", "").slice(0,24).toUpperCase()}`;
    const client=await database.connect();
    try {
      await client.query("BEGIN");
      const event=await new OperationEventRepository().append(client,actor,{action:"master_data.craft.create",entityType:"craft_catalog",entityId:legacyId,
        after:{craftId:legacyId,craftCode:legacyCode,craftName:term},reason:"旧迁移稳定身份夹具"});
      await client.query("INSERT INTO craft_catalog_items(craft_id,craft_code,craft_name,created_by,operation_event_id,request_id) VALUES($1,$2,$3,$4,$5,$6)",
        [legacyId,legacyCode,term,actor.actorId,event,actor.requestId]);
      await client.query("COMMIT");
    } catch(error) {await client.query("ROLLBACK");throw error;} finally {client.release();}
    expect((await database.query("SELECT * FROM current_craft_catalog WHERE craft_id=$1",[legacyId])).rowCount).toBe(0);
    const id=await openNamedCraftTransfer();
    await service.requestFactoryChange(managerActor(),id,{supplierId:replacementFactoryId,unitPrice:"9",craftNames:[term],changeReason:"历史身份记忆"},randomUUID());
    expect((await database.query("SELECT craft_id,version,active FROM current_craft_catalog WHERE craft_id=$1",[legacyId])).rows)
      .toEqual([{craft_id:legacyId,version:1,active:true}]);
    expect((await database.query("SELECT crafts FROM sourcing_decisions WHERE sourcing_case_id=$1 AND decision_version=2",[id])).rows[0].crafts[0])
      .toMatchObject({craftId:legacyId,craftCode:legacyCode,craftVersion:1,craftName:term});
  });

  const reviewedContractCase = async (label: string, currentService = service, additionalMerchandiserUserId?:string) => {
    const id=(await currentService.createCase(merchandiserActor(),{gender:"女装",styleName:"TEST-"+label,
      estimatedCutPieceSendDate:"2026-10-04",deliveryDate:"2026-10-22",
      lineItems:[{styleNo:"TEST-"+label,color:"蓝",quantity:2020}],daxingUnitPrice:"8",attachmentIds:[],...(additionalMerchandiserUserId?{additionalMerchandiserUserId}:{})},randomUUID())).value.sourcingCaseId;
    await currentService.quoteIePrice(ieActor(),id,{unitPrice:"15.5"},randomUUID());
    await currentService.recordManagementDecision(managerActor(),id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],unitPrice:"15.5"},randomUUID());
    await currentService.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
    return id;
  };

  it("binds both authorized merchandisers to the effective transfer version, cancels old versions and completes only on current return",async()=>{
    await ensureReturnTodoRecipient();
    const second=randomUUID();
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST-second-merchandiser',true)",[second]);
    await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','corp',$3,$3,true,true,CURRENT_TIMESTAMP)",[randomUUID(),second,`ding-${second}`]);
    await database.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation");
    try { await database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,'order_merchandiser',$3,'TEST-second')",[randomUUID(),second,merchandiserId]); }
    finally { await database.query("ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation"); }
    const id=await reviewedContractCase("TRANSFER-TODO-TWO",service,second);
    const tasks=async()=> (await database.query("SELECT todo_id,recipient_user_id,status,route_descriptor FROM rework_todos WHERE entity_id=$1 AND category='sourcing_transfer_contract_return' ORDER BY todo_id",[id])).rows;
    await service.requestFactoryChange(managerActor(),id,{supplierId:replacementFactoryId,unitPrice:"16",changeReason:"TEST-requires-approval"},randomUUID());
    expect(await tasks()).toEqual([]);
    const pending=(await service.getCurrentFactoryChange(readerActor(),id)).item!;
    await service.decideFactoryChange(ownerActor(),id,pending.factoryChangeRequestId,{decision:"approved",verificationReason:"TEST-approved"},randomUUID());
    const first=(await contractService.getCurrent(rootActor(),id)).item!;
    const firstTasks=await tasks();
    expect(firstTasks).toHaveLength(2);
    expect(firstTasks.map(t=>t.recipient_user_id).sort()).toEqual([merchandiserId,second].sort());
    for(const task of firstTasks) expect(task).toMatchObject({status:"pending",route_descriptor:{transferContract:{documentId:first.sourcingContractDocumentId,version:first.contractVersion,supplierName:"二号加工厂"}}});
    await contractService.getCurrent(rootActor(),id);
    const pdf=(await database.query("SELECT pdf_attachment_id FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",[first.sourcingContractDocumentId])).rows[0].pdf_attachment_id;
    await attachments.createDownloadIntent({...rootActor(),authorizationCapability:"sourcing:view"},pdf,async()=>true);
    expect(await tasks()).toEqual(firstTasks);
    const repair=new SourcingTransferContractReconciliation(database);
    const selected=[{caseId:id,documentId:first.sourcingContractDocumentId}];
    await repair.apply(rootActor(),selected,"TEST-existing-version",randomUUID());
    await repair.apply(rootActor(),selected,"TEST-existing-version-repeated",randomUUID());
    expect(await tasks()).toEqual(firstTasks);
    await service.requestFactoryChange(managerActor(),id,{supplierId:factoryId,unitPrice:"16",changeReason:"TEST-next-transfer"},randomUUID());
    const current=(await contractService.getCurrent(rootActor(),id)).item!;
    expect(current.sourcingContractDocumentId).not.toBe(first.sourcingContractDocumentId);
    const changed=await tasks();
    expect(changed.filter(t=>t.status==='cancelled').map(t=>t.todo_id).sort()).toEqual(firstTasks.map(t=>t.todo_id).sort());
    expect(changed.filter(t=>t.status==='pending')).toHaveLength(2);
    await expect(repair.apply(rootActor(),selected,"TEST-stale",randomUUID())).rejects.toMatchObject({statusCode:409});
    const file=randomUUID();
    await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
      VALUES($1,$2,'TEST-second-return.pdf','application/pdf',128,$3,$4,'ready',CURRENT_TIMESTAMP)`,[file,`TEST-second/${file}`,"a".repeat(64),second]);
    const secondActor={...contractActor(),actorId:second};
    await expect(contractReturns.submit({...contractActor(),actorId:ieId},id,[file],randomUUID(),current.sourcingContractDocumentId)).rejects.toMatchObject({statusCode:403});
    await expect(contractReturns.submit(financeActor(),id,[file],randomUUID(),current.sourcingContractDocumentId)).rejects.toMatchObject({statusCode:403});
    await expect(contractReturns.submit(secondActor,id,[file],randomUUID(),first.sourcingContractDocumentId)).rejects.toMatchObject({statusCode:409});
    expect(await tasks()).toEqual(changed);
    const key=randomUUID();
    await contractReturns.submit(secondActor,id,[file],key,current.sourcingContractDocumentId);
    await contractReturns.submit(secondActor,id,[file],key,current.sourcingContractDocumentId);
    expect((await tasks()).filter(t=>t.status==='completed')).toHaveLength(2);
    expect((await tasks()).filter(t=>t.status==='cancelled')).toHaveLength(2);
    expect((await repair.preview(rootActor(),[id])).results).toEqual([]);
    await expect(repair.apply(rootActor(),[{caseId:id,documentId:current.sourcingContractDocumentId}],"TEST-returned",randomUUID())).rejects.toMatchObject({statusCode:409});
    // Isolated policy fixture: a read-only second merchandiser neither receives new tasks nor uploads.
    const event=(await database.query("SELECT event_id FROM operation_events WHERE entity_id=$1 LIMIT 1",[id])).rows[0].event_id;
    await database.query("ALTER TABLE business_module_owner_bindings DISABLE TRIGGER member_module_binding_guard");
    try { await database.query("INSERT INTO business_module_owner_bindings(member_key,user_id,operation_event_id) VALUES('wu_yunfeng',$1,$2),('li_zhonghao',$3,$2),('li_junyue',$4,$2)",[second,event,ownerId,merchandiserId]); }
    finally {await database.query("ALTER TABLE business_module_owner_bindings ENABLE TRIGGER member_module_binding_guard");}
    try {
      await service.requestFactoryChange(managerActor(),id,{supplierId:replacementFactoryId,unitPrice:"16",changeReason:"TEST-notify-policy"},randomUUID());
      const policyVersion=(await contractService.getCurrent(rootActor(),id)).item!;
      expect((await tasks()).filter(t=>t.status==='pending').map(t=>t.recipient_user_id)).toEqual([merchandiserId]);
      await expect(contractReturns.submit(secondActor,id,[randomUUID()],randomUUID(),policyVersion.sourcingContractDocumentId)).rejects.toMatchObject({statusCode:403});
      const rootFile=randomUUID();
      await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
        VALUES($1,$2,'TEST-root-return.pdf','application/pdf',128,$3,$4,'ready',CURRENT_TIMESTAMP)`,[rootFile,`TEST-root/${rootFile}`,"a".repeat(64),rootActor().actorId]);
      await contractReturns.submit(rootActor(),id,[rootFile],randomUUID(),policyVersion.sourcingContractDocumentId);
      expect((await tasks()).filter(t=>t.status==='pending')).toEqual([]);
    } finally {
      await database.query("ALTER TABLE business_module_owner_bindings DISABLE TRIGGER member_module_binding_guard");
      try {await database.query("DELETE FROM business_module_owner_bindings WHERE user_id=ANY($1::uuid[])",[[second,ownerId,merchandiserId]]);}
      finally {await database.query("ALTER TABLE business_module_owner_bindings ENABLE TRIGGER member_module_binding_guard");}
    }
    const taskIds=(await tasks()).map(t=>t.todo_id);
    expect((await database.query("SELECT * FROM todo_delivery_attempts WHERE todo_id=ANY($1::uuid[])",[taskIds])).rows).toEqual([]);
  });

  it("recovers missing transfer tasks explicitly with Root authorization, exact versions, atomic rollback and idempotency",async()=>{
    await ensureReturnTodoRecipient();
    const id=await reviewedContractCase("TRANSFER-TODO-RECOVERY");
    // Simulate a historical projection failure while preserving the generated PDF.
    await database.query(`CREATE FUNCTION test_transfer_generation_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.category='sourcing_transfer_contract_return' THEN RAISE EXCEPTION 'TEST-generation-projection-failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_transfer_generation_fail BEFORE INSERT ON rework_todos FOR EACH ROW EXECUTE FUNCTION test_transfer_generation_fail()`);
    try { await service.requestFactoryChange(managerActor(),id,{supplierId:replacementFactoryId,unitPrice:"15.5",changeReason:"TEST-historical-unroutable"},randomUUID()); }
    finally { await database.query("DROP TRIGGER test_transfer_generation_fail ON rework_todos; DROP FUNCTION test_transfer_generation_fail()"); }
    const current=(await contractService.getCurrent(rootActor(),id)).item!;
    expect(current.status).toBe("ready");
    expect((await database.query("SELECT * FROM operation_events WHERE entity_id=$1 AND action='sourcing.transfer_contract_todo.deferred'",[id])).rows).toHaveLength(1);
    const count=async()=>Number((await database.query("SELECT count(*) AS n FROM rework_todos WHERE entity_id=$1 AND category='sourcing_transfer_contract_return'",[id])).rows[0].n);
    expect(await count()).toBe(0);
    const repair=new SourcingTransferContractReconciliation(database);
    await expect(repair.preview(managerActor(),[id])).rejects.toMatchObject({statusCode:403});
    const preview=await repair.preview(rootActor(),[id]);
    expect(preview.results).toHaveLength(1); expect(await count()).toBe(0);
    const selected=preview.results.map(({caseId,documentId})=>({caseId,documentId}));
    await expect(repair.apply(managerActor(),selected,"TEST-forbidden",randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(repair.apply(rootActor(),[...selected,{caseId:randomUUID(),documentId:randomUUID()}],"TEST-atomic-invalid",randomUUID())).rejects.toMatchObject({statusCode:409});
    expect(await count()).toBe(0);
    await database.query(`CREATE FUNCTION test_transfer_todo_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.category='sourcing_transfer_contract_return' THEN RAISE EXCEPTION 'TEST-transfer-late-failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_transfer_todo_fail BEFORE INSERT ON rework_todos FOR EACH ROW EXECUTE FUNCTION test_transfer_todo_fail()`);
    try { await expect(repair.apply(rootActor(),selected,"TEST-late-failure",randomUUID())).rejects.toThrow("TEST-transfer-late-failure"); }
    finally { await database.query("DROP TRIGGER test_transfer_todo_fail ON rework_todos; DROP FUNCTION test_transfer_todo_fail()"); }
    expect(await count()).toBe(0);
    const key=randomUUID();
    expect((await repair.apply(rootActor(),selected,"TEST-recover",key)).reused).toBe(false);
    expect((await repair.apply(rootActor(),selected,"TEST-recover",key)).reused).toBe(true);
    await repair.apply(rootActor(),selected,"TEST-recover-again",randomUUID());
    expect(await count()).toBe(1);
    const audit=(await database.query("SELECT actor_id,after_state FROM operation_events WHERE entity_id=$1 AND action='sourcing.transfer_contract_todo.reconcile'",[key])).rows;
    expect(audit).toHaveLength(1);expect(audit[0]).toMatchObject({actor_id:rootActor().actorId,after_state:{contracts:selected}});
    const app=Fastify();
    app.setErrorHandler((error,_request,reply)=>reply.code((error as {statusCode?:number}).statusCode??500).send({error:error.message}));
    registerTodoRoutes(app,{service:new TodoService(database),transferContractReconciliation:repair,
      root:new RootAuthority(database,"corp",`ding-${merchandiserId}`),
      authenticate:async token=>{if(!token) throw Object.assign(new Error("unauthorized"),{statusCode:401});
        return {id:token,displayName:"TEST",businessRoles:["root_superuser"],capabilities:["todo:routing_exception_manage"]};}});
    await app.ready();
    try {
      for(const suffix of ['preview','apply']) {
        const url=`/todos/transfer-contract-reconciliation/${suffix}`;
        expect((await app.inject({method:"POST",url,payload:{}})).statusCode).toBe(401);
        expect((await app.inject({method:"POST",url,headers:{cookie:`dx_rework_session=${managerId}`},payload:{}})).statusCode).toBe(403);
      }
      const headers={cookie:`dx_rework_session=${merchandiserId}`};
      expect((await app.inject({method:"POST",url:"/todos/transfer-contract-reconciliation/preview",headers,payload:{caseIds:[id]}})).statusCode).toBe(200);
      expect((await app.inject({method:"POST",url:"/todos/transfer-contract-reconciliation/apply",headers,payload:{selected,reason:"TEST-no-key"}})).statusCode).toBe(400);
      const result=await app.inject({method:"POST",url:"/todos/transfer-contract-reconciliation/apply",headers:{...headers,'idempotency-key':randomUUID()},payload:{selected,reason:"TEST-route"}});
      expect(result.statusCode).toBe(200);expect(result.headers['cache-control']).toBe('no-store');
    } finally {await app.close();}
  });

  it("allocates two files and 20 MB per contract version without rewriting signed history",async()=>{
    await ensureReturnTodoRecipient();
    const id=await reviewedContractCase("VERSION-RETURN-QUOTA");
    const old=(await contractService.getCurrent(rootActor(),id)).item!;
    const makeFile=async(bytes:number)=>{
      const file=randomUUID();
      await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
        VALUES($1,$2,'TEST-version-quota.pdf','application/pdf',$3,$4,$5,'ready',CURRENT_TIMESTAMP)`,
        [file,`TEST-version-quota/${file}`,bytes,"a".repeat(64),merchandiserId]);
      return file;
    };
    const oldFiles=[await makeFile(10*1024*1024),await makeFile(10*1024*1024)];
    const first=await contractReturns.submit(contractActor(),id,oldFiles,randomUUID(),old.sourcingContractDocumentId);
    expect(first).toMatchObject({uploadedFileCount:2,uploadedTotalBytes:20*1024*1024,canUpload:false});
    const history=(await database.query("SELECT * FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1 ORDER BY revision",[id])).rows;
    await service.requestFactoryChange(managerActor(),id,{supplierId:replacementFactoryId,unitPrice:"15.5",changeReason:"TEST-version-quota"},randomUUID());
    const current=(await contractService.getCurrent(rootActor(),id)).item!;
    expect(current.sourcingContractDocumentId).not.toBe(old.sourcingContractDocumentId);
    expect(await contractReturns.get({...rootActor(),authorizationCapability:"sourcing:view"},id)).toMatchObject({uploadedFileCount:0,uploadedTotalBytes:0,canUpload:true,currentContractReturned:false});
    const fresh=[await makeFile(19*1024*1024),await makeFile(2*1024*1024)];
    await expect(contractReturns.submit(contractActor(),id,[fresh[0]!],randomUUID(),old.sourcingContractDocumentId)).rejects.toMatchObject({statusCode:409});
    await contractReturns.submit(contractActor(),id,oldFiles,randomUUID(),current.sourcingContractDocumentId);
    expect(await contractReturns.get({...rootActor(),authorizationCapability:"sourcing:view"},id)).toMatchObject({uploadedFileCount:0,currentContractReturned:false});
    await contractReturns.submit(contractActor(),id,[fresh[0]!],randomUUID(),current.sourcingContractDocumentId);
    await expect(contractReturns.submit(contractActor(),id,[fresh[1]!],randomUUID(),current.sourcingContractDocumentId)).rejects.toMatchObject({statusCode:400});
    await database.query("UPDATE attachments SET size_bytes=$2 WHERE attachment_id=$1",[fresh[1],1024*1024]);
    const finished=await contractReturns.submit(contractActor(),id,[fresh[1]!],randomUUID(),current.sourcingContractDocumentId);
    expect(finished).toMatchObject({uploadedFileCount:2,uploadedTotalBytes:20*1024*1024,canUpload:false,currentContractReturned:true,contractReturnedAt:first.contractReturnedAt});
    expect((await database.query("SELECT * FROM sourcing_contract_return_submissions WHERE submission_id=$1",[history[0].submission_id])).rows[0]).toEqual(history[0]);
    expect((await contractReturns.get({...rootActor(),authorizationCapability:"sourcing:view"},id)).history.flatMap(version=>version.attachments).map(file=>file.attachmentId)).toEqual(expect.arrayContaining(oldFiles));
    expect((await database.query("SELECT count(*)::int AS n FROM sourcing_contract_return_attachments link JOIN sourcing_contract_return_submissions submission USING(submission_id) WHERE submission.sourcing_case_id=$1",[id])).rows[0].n).toBe(4);
  });

  it("keeps historical finance and signed PDFs while Root edits an unreviewed transfer contract and finance reviews its new version",async()=>{
    const id=await reviewedContractCase("VERSION-REVIEW");
    const old=(await contractService.getCurrent(rootActor(),id)).item!;
    const file=randomUUID();
    await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
      VALUES($1,$2,'TEST-signed.pdf','application/pdf',128,$3,$4,'ready',CURRENT_TIMESTAMP)`,[file,`TEST-version-return/${file}`,"a".repeat(64),merchandiserId]);
    await contractReturns.submit(contractActor(),id,[file],randomUUID());
    await service.recordFinanceReconciliation(financeActor(),id,{result:"match"},randomUUID());
    const history=(await database.query("SELECT * FROM sourcing_finance_reconciliations WHERE sourcing_case_id=$1",[id])).rows;
    const returns=(await database.query("SELECT * FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1",[id])).rows;
    const oldRow=(await database.query("SELECT * FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",[old.sourcingContractDocumentId])).rows[0];
    expect((await contractService.getCurrent(rootActor(),id)).item?.canEditContent).toBe(false);
    await service.requestFactoryChange(managerActor(),id,{supplierId:replacementFactoryId,unitPrice:"15.5",changeReason:"TEST-original fault chain"},randomUUID());
    const transfer=(await contractService.getCurrent(rootActor(),id)).item!;
    expect(transfer.canEditContent).toBe(true);
    expect((await service.getCase(readerActor(),id)).status).toBe("pending_finance_reconciliation");
    const draft=await contractService.content.get(rootActor(),id);
    const input={...draft,content:{...draft.content,deliveryDate:"2026-10-30"}};
    const key=randomUUID();
    const [document,retry]=await Promise.all([contractService.content.save(rootActor(),id,input,key),contractService.content.save(rootActor(),id,input,key)]);
    expect(document).toBe(retry);
    await contractService.generateIfReady(rootActor(),id,document);
    expect((await service.getCase(readerActor(),id))).toMatchObject({status:"pending_finance_reconciliation",deliveryDate:"2026-10-30"});
    expect((await contractService.content.get(rootActor(),id)).content.deliveryDate).toBe("2026-10-30");
    expect((await contractReturns.get({...rootActor(),authorizationCapability:"sourcing:view"},id))).toMatchObject({currentContractReturned:false,signedContractDocumentId:old.sourcingContractDocumentId});
    expect((await database.query("SELECT * FROM sourcing_finance_reconciliations WHERE sourcing_case_id=$1",[id])).rows).toEqual(history);
    expect((await database.query("SELECT * FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1",[id])).rows).toEqual(returns);
    expect((await database.query("SELECT * FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",[old.sourcingContractDocumentId])).rows[0]).toEqual(oldRow);
    for(const user of [contractActor(),managerActor(),financeActor()]) await expect(contractService.content.get(user,id)).rejects.toMatchObject({statusCode:403});
    await service.recordFinanceReconciliation(financeActor(),id,{result:"match"},randomUUID());
    const finance=(await database.query("SELECT * FROM sourcing_finance_reconciliations WHERE sourcing_case_id=$1 ORDER BY reconciliation_version",[id])).rows;
    expect(finance).toHaveLength(2);expect(finance[0]).toEqual(history[0]);
    expect(finance[1].sourcing_contract_document_id).toBe(document);
    expect((await contractService.getCurrent(rootActor(),id)).item?.canEditContent).toBe(false);
    await expect(contractService.content.get(rootActor(),id)).rejects.toMatchObject({statusCode:403});
  });

  it("applies transfer delivery with production or Root authority, preserves unchanged clients, and rejects forged or invalid dates",async()=>{
    const id=await reviewedContractCase("TRANSFER-DELIVERY");
    for(const user of [factoryChangeActor(),ownerActor()]) await expect(service.requestFactoryChange(user,id,
      {supplierId:replacementFactoryId,unitPrice:"15.5",deliveryDate:"2026-10-30",changeReason:"TEST-denied"},randomUUID())).rejects.toMatchObject({statusCode:403});
    for(const date of ["2026-02-30","2026-10-03"]) await expect(service.requestFactoryChange(managerActor(),id,
      {supplierId:replacementFactoryId,unitPrice:"15.5",deliveryDate:date,changeReason:"TEST-invalid"},randomUUID())).rejects.toMatchObject({code:"VALIDATION_ERROR"});
    const key=randomUUID(),input={supplierId:replacementFactoryId,unitPrice:"15.5",deliveryDate:"2026-10-30",changeReason:"TEST-delivery"};
    await Promise.all([service.requestFactoryChange(managerActor(),id,input,key),service.requestFactoryChange(managerActor(),id,input,key)]);
    expect((await service.getCase(readerActor(),id))).toMatchObject({deliveryDate:"2026-10-30",status:"pending_finance_reconciliation",approvalSnapshot:{deliveryDate:"2026-10-30"}});
    expect((await contractService.content.get(rootActor(),id)).content.deliveryDate).toBe("2026-10-30");
    expect((await database.query("SELECT count(*)::int AS count FROM sourcing_factory_change_requests WHERE sourcing_case_id=$1",[id])).rows[0].count).toBe(1);
    await service.requestFactoryChange(ownerActor(),id,{supplierId:factoryId,unitPrice:"15.5",changeReason:"TEST-old client no date"},randomUUID());
    expect((await service.getCase(readerActor(),id)).deliveryDate).toBe("2026-10-30");
    await service.requestFactoryChange({...rootActor(),authorizationCapability:"sourcing:owner:approve"},id,
      {supplierId:replacementFactoryId,unitPrice:"15.5",deliveryDate:"2026-11-02",changeReason:"TEST-root date"},randomUUID());
    expect((await service.getCase(readerActor(),id)).approvalSnapshot?.deliveryDate).toBe("2026-11-02");
  });

  it("freezes increased-price delivery proposals until owner approval, keeps rejected dates inactive and rejects changed contract bases",async()=>{
    const id=await reviewedContractCase("DELIVERY-APPROVAL");
    const old=(await contractService.getCurrent(rootActor(),id)).item!;
    await service.requestFactoryChange(managerActor(),id,{supplierId:replacementFactoryId,unitPrice:"16",deliveryDate:"2026-10-30",changeReason:"TEST-price approval"},randomUUID());
    const request=(await service.getCurrentFactoryChange(readerActor(),id)).item!;
    expect(request).toMatchObject({status:"pending_owner",requiresOwnerApproval:true,proposedDeliveryDate:"2026-10-30",changesDeliveryDate:true});
    expect((await service.getCase(readerActor(),id)).deliveryDate).toBe("2026-10-22");
    expect((await contractService.getCurrent(rootActor(),id)).item?.sourcingContractDocumentId).toBe(old.sourcingContractDocumentId);
    await service.decideFactoryChange(ownerActor(),id,request.factoryChangeRequestId,{decision:"rejected",verificationReason:"TEST-reject"},randomUUID());
    expect((await service.getCase(readerActor(),id)).deliveryDate).toBe("2026-10-22");
    await service.requestFactoryChange(managerActor(),id,{supplierId:replacementFactoryId,unitPrice:"16",deliveryDate:"2026-10-30",changeReason:"TEST-approve"},randomUUID());
    const next=(await service.getCurrentFactoryChange(readerActor(),id)).item!;
    await service.decideFactoryChange(ownerActor(),id,next.factoryChangeRequestId,{decision:"approved",verificationReason:"TEST-approved"},randomUUID());
    expect((await service.getCase(readerActor(),id))).toMatchObject({deliveryDate:"2026-10-30",approvalSnapshot:{deliveryDate:"2026-10-30"}});
    await service.requestFactoryChange(managerActor(),id,{supplierId:factoryId,unitPrice:"17",deliveryDate:"2026-11-01",changeReason:"TEST-stale"},randomUUID());
    const stale=(await service.getCurrentFactoryChange(readerActor(),id)).item!;
    const draft=await contractService.content.get(rootActor(),id);
    const doc=await contractService.content.save(rootActor(),id,{...draft,content:{...draft.content,deliveryDate:"2026-11-02"}},randomUUID());
    await contractService.generateIfReady(rootActor(),id,doc);
    await expect(service.decideFactoryChange(ownerActor(),id,stale.factoryChangeRequestId,{decision:"approved",verificationReason:"TEST-stale rejected"},randomUUID())).rejects.toMatchObject({statusCode:409});
    expect((await service.getCase(readerActor(),id)).deliveryDate).toBe("2026-11-02");
  });

  it("reopens financial review and creates one real finance todo when a fresh unreviewed revision was on a closed order",async()=>{
    const {projection}=await cycleTodoServices();
    const contracts=new SourcingContractService(database,attachments,undefined,undefined,projection);
    const currentService=new SourcingService(database,undefined,undefined,projection,contracts);
    const id=await reviewedContractCase("CLOSED-FRESH",currentService);
    await currentService.recordFinanceReconciliation(financeActor(),id,{result:"match"},randomUUID());
    await currentService.reviseStyles(merchandiserActor(),id,{expectedRevision:0,lines:[{position:1,styleNo:"TEST-CLOSED-FRESH-REV",alternateStyleNo:null}]},randomUUID());
    expect((await currentService.getCase(readerActor(),id)).status).toBe("closed");
    const draft=await contracts.content.get(rootActor(),id);
    const key=randomUUID(),input={...draft,content:{...draft.content,deliveryDate:"2026-10-30"}};
    const [doc,retry]=await Promise.all([contracts.content.save(rootActor(),id,input,key),contracts.content.save(rootActor(),id,input,key)]);
    expect(retry).toBe(doc);await contracts.generateIfReady(rootActor(),id,doc);
    expect((await currentService.getCase(readerActor(),id)).status).toBe("pending_finance_reconciliation");
    const todos=(await database.query("SELECT * FROM rework_todos WHERE entity_id=$1 AND category='sourcing_finance_reconcile' AND status='pending'",[id])).rows;
    expect(todos).toHaveLength(1);expect(todos[0].dedupe_key).toContain(doc);
    await currentService.recordFinanceReconciliation(financeActor(),id,{result:"match"},randomUUID());
    expect((await database.query("SELECT status FROM rework_todos WHERE todo_id=$1",[todos[0].todo_id])).rows[0].status).toBe("completed");
  });

  it("enforces warehouse supervisor read-only cutting through HTTP, real grants and database authority while retaining receiving and mixed roles", async () => {
    const caseId = await reviewedContractCase("WAREHOUSE-SUPERVISOR");
    const order = (await cutting.listSources(cuttingOwnerActor())).items.find(item => item.sourcingCaseId === caseId)!;
    const supervisorId = randomUUID(), receiverId = randomUUID(), mixedId = randomUUID();
    await craftService.ensureOrganizationPolicy();
    // All people and assignments below belong to this disposable owned schema.
    for (const [userId, roles] of [
      [supervisorId, ["warehouse_supervisor"]],
      [receiverId, ["warehouse_receiver"]],
      [mixedId, ["warehouse_supervisor", "cutting_worker"]],
    ] as const) {
      await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST仓库角色',true)", [userId]);
      await database.query(`INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
        VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`, [randomUUID(), userId, `TEST-${userId}`, `TEST-union-${userId}`]);
      await database.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation");
      try {
        for (const role of roles) await database.query(`INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason)
          VALUES($1,$2,$3,$2,'TEST owned role fixture')`, [randomUUID(), userId, role]);
      } finally { await database.query("ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation"); }
    }
    const auth = new PostgresAuthStore(database, "corp");
    const user = (userId: string) => auth.upsertIdentity({ corpId: "corp", userId: `TEST-${userId}`, unionId: `TEST-union-${userId}`,
      active: true, employed: true, displayName: "TEST仓库角色" });
    const supervisor = await user(supervisorId), mixed = await user(mixedId), receiver = await user(receiverId);
    expect(supervisor.businessRoles).toEqual(["warehouse_supervisor"]);
    expect(supervisor.capabilities).toEqual(["cutting:orders:view", "receiving:create", "receiving:packing_manage", "tools:user"]);
    const actor = (capability: string): TrustedActorContext => ({ actorId: supervisorId, actorRoles: supervisor.businessRoles!,
      authorizationCapability: capability, authorizationCapabilities: supervisor.capabilities, requestId: randomUUID() });
    expect((await database.query("SELECT cutting_authorized_roles($1,'cutting:orders:view') roles", [supervisorId])).rows[0].roles).toEqual(["warehouse_supervisor"]);
    expect((await database.query("SELECT receiving_authorized_board_operator($1,'receiving:packing_manage') roles", [supervisorId])).rows[0].roles).toEqual(["warehouse_supervisor"]);
    for (const [functionName, capability, id] of [
      ["cutting_authorized_roles", "cutting:records:create", supervisorId],
      ["cutting_authorized_roles", "cutting:records:correct", supervisorId],
      ["cutting_authorized_roles", "cutting:orders:view", receiverId],
      ["receiving_authorized_board_operator", "receiving:resolve_difference", supervisorId],
    ]) await expect(database.query(`SELECT ${functionName}($1,$2)`, [id, capability])).rejects.toMatchObject({ code: "42501" });
    const detail = await cutting.get(actor("cutting:orders:view"), order.cuttingOrderId);
    expect(detail).toMatchObject({ canRecord: false, canCorrect: false, record: null });
    expect((await cutting.list(actor("cutting:orders:view"), { q: "WAREHOUSE-SUPERVISOR" })).items.map(item => item.cuttingOrderId)).toContain(order.cuttingOrderId);
    expect(JSON.stringify(detail)).not.toMatch(/daxingUnitPrice|unitPrice|totalAmount|bankAccount/);
    await expect(cutting.record({ ...actor("cutting:records:create"), authorizationCapabilities: ["cutting:records:create"] }, order.cuttingOrderId,
      { pieceCount: 100, actualCutCount: 2020, attachmentIds: [randomUUID()] }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });

    let httpUser = supervisor;
    const upload = vi.spyOn(attachments, "createUploadIntent").mockResolvedValue({ attachmentId: randomUUID(), objectKey: "TEST/sheet.png", uploadMethod: "POST", uploadUrl: "https://example.invalid/TEST", uploadFields: {}, expiresAt: new Date().toISOString() });
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ApplicationError ? error.statusCode : 500).send({ error: { message: error.message } }));
    registerCuttingRoutes(app, { authenticate: async () => httpUser, service: cutting, attachments });
    registerReceivingRoutes(app, { authenticate: async () => httpUser, service: receiving });
    try {
      expect((await app.inject({ method: "GET", url: "/cutting/orders?q=WAREHOUSE-SUPERVISOR" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/cutting/orders/${order.cuttingOrderId}` })).json()).toMatchObject({ canRecord: false, canCorrect: false });
      const uploadBody = { filename: "TEST.png", mimeType: "image/png", sizeBytes: 128, sha256: "a".repeat(64) };
      for (const [suffix, payload] of [
        ["records", { pieceCount: 100, actualCutCount: 2020, attachmentIds: [randomUUID()] }],
        ["corrections", { expectedVersion: 1, pieceCount: 100, actualCutCount: 2020, reason: "TEST forged" }],
        ["attachments/upload-intents", uploadBody],
      ] as const) expect((await app.inject({ method: "POST", url: `/cutting/orders/${order.cuttingOrderId}/${suffix}`, payload })).statusCode).toBe(403);
      expect(upload).not.toHaveBeenCalled();
      expect((await app.inject({ method: "GET", url: "/receiving/board/export" })).statusCode).toBe(403);
      httpUser = receiver;
      expect((await app.inject({ method: "GET", url: "/cutting/orders" })).statusCode).toBe(403);
      httpUser = mixed;
      expect((await app.inject({ method: "GET", url: `/cutting/orders/${order.cuttingOrderId}` })).json()).toMatchObject({ canRecord: true, canCorrect: false });
      expect((await app.inject({ method: "POST", url: `/cutting/orders/${order.cuttingOrderId}/attachments/upload-intents`, payload: uploadBody })).statusCode).toBe(201);
      expect(upload).toHaveBeenCalledOnce();
      expect((await database.query("SELECT cutting_authorized_roles($1,'cutting:records:create') roles", [mixedId])).rows[0].roles).toEqual(["cutting_worker", "warehouse_supervisor"]);
      const sheet = await readyCuttingSheet(mixedId);
      expect((await app.inject({ method: "POST", url: `/cutting/orders/${order.cuttingOrderId}/records`, headers: { "idempotency-key": randomUUID() },
        payload: { pieceCount: 100, actualCutCount: 2020, attachmentIds: [sheet] } })).statusCode).toBe(201);
      httpUser = supervisor;
      const recorded = (await app.inject({ method: "GET", url: `/cutting/orders/${order.cuttingOrderId}` })).json();
      expect(recorded).toMatchObject({ canRecord: false, canCorrect: false, record: { actualCutCount: 2020, recordedBy: mixedId } });
      expect(recorded.record.cuttingSheetPhotos[0].attachmentId).toBe(sheet);
      expect(await cutting.canDownload(actor("cutting:orders:view"), { entityType: "cutting_record", entityId: recorded.record.cuttingRecordId, mimeType: "image/png" })).toBe(true);
      const receiptPhoto = await readyCuttingSheet(supervisorId);
      const receipt = await app.inject({ method: "POST", url: "/receiving/receipts", headers: { "idempotency-key": randomUUID() },
        payload: { cuttingOrderId: order.cuttingOrderId, documentQuantity: 20, actualQuantity: 19, defectiveQuantity: 1, attachmentIds: [receiptPhoto] } });
      expect(receipt.statusCode, receipt.body).toBe(201);
      const receiptData = receipt.json();
      expect(receiptData.receivedBy).toBe(supervisorId);
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const board = await receiving.board(today, today, "TEST-WAREHOUSE-SUPERVISOR");
      const row = board.rows.find(item => item.receivingBatchId === receiptData.receivingBatchId)!;
      const packing = await app.inject({ method: "POST", url: `/receiving/batches/${row.receivingBatchId}/packing-revisions`, headers: { "idempotency-key": randomUUID() },
        payload: { expectedVersion: row.version, expectedPackingRevisionId: null, packingQuantity: 19 } });
      expect(packing.statusCode, packing.body).toBe(201);
      expect((await app.inject({ method: "POST", url: `/receiving/batches/${row.receivingBatchId}/packing-revisions`, headers: { "idempotency-key": randomUUID() },
        payload: { expectedVersion: row.version, expectedPackingRevisionId: packing.json().packingRevisionId, packingQuantity: 20 } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: `/receiving/batches/${row.receivingBatchId}/difference-resolutions`, payload: {
        expectedVersion: row.version, expectedDocumentQuantity: 20, expectedActualQuantity: 19,
        differenceType: "receiving", result: "TEST forged", attachmentIds: [],
      } })).statusCode).toBe(403);
      expect((await database.query("SELECT 1 FROM cutting_record_corrections WHERE cutting_record_id=$1", [recorded.record.cuttingRecordId])).rowCount).toBe(0);
      await database.query("UPDATE identity_mappings SET active=false WHERE user_id=$1", [supervisorId]);
      for (const [functionName, capability] of [["cutting_authorized_roles", "cutting:orders:view"], ["receiving_authorized_board_operator", "receiving:packing_manage"]])
        await expect(database.query(`SELECT ${functionName}($1,$2)`, [supervisorId, capability])).rejects.toMatchObject({ code: "42501" });
    } finally { await app.close(); upload.mockRestore(); }
  });
  it("summarizes all filtered sourcing orders across pages, multi-colors, transfer history and read permissions", async () => {
    const before = await service.listCases(readerActor());
    for (let index = 0; index < 17; index += 1) {
      await service.createCase(merchandiserActor(), {
        gender: "男装", styleName: "SUMMARY-PAGE-针织",
        estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-10-22",
        lineItems: [
          { styleNo: `SUMMARY-PAGE-${index}`, color: "蓝", quantity: 40 },
          { styleNo: `SUMMARY-PAGE-${index}`, color: "白", quantity: 60 + index },
        ], daxingUnitPrice: "8", attachmentIds: [],
      }, randomUUID());
    }
    const filters = { stage: "ie" as const, gender: "男装" as const, styleName: "SUMMARY-PAGE" };
    const first = await service.listCases(readerActor(), "SUMMARY-PAGE", "pending", 1, filters);
    const second = await service.listCases(readerActor(), "SUMMARY-PAGE", "pending", 2, filters);
    const beyond = await service.listCases(readerActor(), "SUMMARY-PAGE", "pending", 3, filters);
    for (const result of [first, second, beyond]) expect(result).toMatchObject({ totalCount: 17, totalOrderQuantity: 1836, totalPages: 2 });
    expect(first.items).toHaveLength(15); expect(second.items).toHaveLength(2); expect(beyond.items).toEqual([]);
    expect([...first.items, ...second.items].reduce((sum, row) => sum + row.orderQuantity, 0)).toBe(1836);
    for (const filter of [{ ...filters, gender: "女装" as const }, { ...filters, contractReturn: "all" as const }]) {
      expect(await service.listCases(readerActor(), "SUMMARY-PAGE", "pending", 1, filter)).toMatchObject({ items: [], totalCount: 0, totalOrderQuantity: 0 });
    }
    const id = await reviewedContractCase("SUMMARY-TRANSFER");
    await service.requestFactoryChange(managerActor(), id, { supplierId: replacementFactoryId, unitPrice: "15.5", changeReason: "TEST-summary transfer history" }, randomUUID());
    const transferred = await service.getCase(readerActor(), id);
    const result = await service.listCases(readerActor(), "SUMMARY-TRANSFER", "all", 1, { contractReturn: "all" });
    expect(result).toMatchObject({ totalCount: 1, totalOrderQuantity: transferred.orderQuantity });
    expect((await database.query("SELECT count(*)::int AS count FROM sourcing_contract_documents WHERE sourcing_case_id=$1", [id])).rows[0].count).toBeGreaterThan(1);
    const company = await service.listCases(readerActor(), transferred.decision!.supplierName, "all", 1, { styleName: "SUMMARY-TRANSFER", contractReturn: "all" });
    expect(company).toMatchObject({ totalCount: 1, totalOrderQuantity: 2020 });
    expect(await service.listCases(readerActor(), "SUMMARY-NOT-FOUND")).toMatchObject({ items: [], totalCount: 0, totalOrderQuantity: 0 });
    const cleared = await service.listCases(readerActor());
    expect(cleared.totalCount).toBe(before.totalCount + 18);
    expect(cleared.totalOrderQuantity).toBe(before.totalOrderQuantity + 3856);
    expect((await service.listCases(anotherMerchandiserReader(), "SUMMARY-PAGE")).totalOrderQuantity).toBe(1836);
    await expect(service.listCases({ ...readerActor(), authorizationCapabilities: [] }, "SUMMARY-PAGE")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.listCases({ ...rootActor(), authorizationCapability: "sourcing:delete" }, "SUMMARY-PAGE")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

});
