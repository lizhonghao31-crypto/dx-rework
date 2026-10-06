import Fastify from "fastify";
import { registerDigitalAnalysisRoutes } from "../../apps/api/src/production-platform/reporting-routes.js";
import { DigitalAnalysisFilterSchema } from "@dx-rework/contracts/digital-production-analysis";
import { DigitalAnalysisQuery } from "../../apps/api/src/production-platform/reporting-query.js";
import { DigitalCockpitQuery } from "../../apps/api/src/production-platform/cockpit-query.js";
import { DigitalJourneyQuery } from "../../apps/api/src/production-platform/journey-query.js";
import { OrderClosureService } from "../../apps/api/src/production-platform/order-closure-service.js";
import {ProductionClosureService} from "../../apps/api/src/sourcing/production-closure-service.js";
import {DigitalProductionAccessService} from "../../apps/api/src/production-platform/access-service.js";
import {exerciseOrderClosure} from "../helpers/order-closure-fixture.js";
import {FactoryFlowService} from "../../apps/api/src/production-platform/factory-flow-service.js";
import { exerciseBulkPreparation } from "../helpers/bulk-preparation-fixture.js";
import { exerciseInstructions } from "../helpers/production-instruction-fixture.js";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
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
import { DigitalBudgetService } from "../../apps/api/src/production-platform/budget-service.js";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { DigitalProductionTaskService } from "../../apps/api/src/production-platform/task-service.js";
import { digitalTodoOrder } from "../../apps/api/src/production-platform/notification-policy.js";
import { DigitalOrderCreateSchema } from "@dx-rework/contracts/digital-production";
import { BudgetDocumentSchema } from "@dx-rework/contracts/digital-budget";
import { CuttingSourceService } from "../../apps/api/src/cutting/cutting-source-service.js";
import { ReceivingService } from "../../apps/api/src/receiving/receiving-service.js";
import { SourcingContractService } from "../../apps/api/src/sourcing/sourcing-contract-service.js";
import { SourcingContractReturnService } from "../../apps/api/src/sourcing/sourcing-contract-return-service.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
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
        `sourcing:${created.value.sourcingCaseId}:ie_quote:1:`,
        `sourcing:${created.value.sourcingCaseId}:management:1:`,
        `sourcing:${created.value.sourcingCaseId}:owner:1:`,
        `sourcing:${created.value.sourcingCaseId}:management:2:`,
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
      expect(result.value.decision?.decisionReason).toBe(reason ?? "供应链总监确认加工厂与价格");
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
  it("keeps the first persisted return when the file is replaced, with role and file ownership checks", async () => {
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
      expect(first.canUpload).toBe(false);
      expect((await contractReturns.submit(contractActor(),id,[pdfId],key)).contractReturnedAt).toBe(first.contractReturnedAt);
      await expect(contractReturns.submit(contractActor(),id,[imageId],key)).rejects.toMatchObject({statusCode:409});
      const identicalKey=randomUUID();
      await expect(contractReturns.submit(contractActor(),id,[pdfId],identicalKey)).rejects.toMatchObject({statusCode:403});
      await expect(contractReturns.submit(contractActor(),id,[imageId],identicalKey)).rejects.toMatchObject({statusCode:403});
      expect((await database.query("SELECT count(*)::int AS count FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1",[id])).rows[0].count).toBe(1);
      const replaced=await contractReturns.submit({...ownerActor(),authorizationCapabilities:["sourcing:view","sourcing:owner:approve"]},id,[imageId],randomUUID());
      expect(replaced.contractReturnedAt).toBe(first.contractReturnedAt);
      expect(replaced.uploadedByName).toBe("老板");
      const managed=await contractReturns.submit(managerActor(),id,[managerFileId],randomUUID());
      expect(managed.contractReturnedAt).toBe(first.contractReturnedAt);
      const rootView=await contractReturns.get({...rootActor(),authorizationCapability:"sourcing:view"},id);
      expect(rootView.attachments.map(file=>file.attachmentId)).toEqual([managerFileId]);
      expect(rootView.history.map(version=>version.revision)).toEqual([2,1]);
      expect(rootView.history.map(version=>version.attachments[0]?.attachmentId)).toEqual([imageId,pdfId]);
      expect(rootView.history.every(version=>!!version.uploadedByName && !!version.submittedAt)).toBe(true);
      expect(rootView.canUpload).toBe(true);
      expect((await contractReturns.get(readerActor(),id)).attachments).toEqual([]);
      expect((await contractReturns.get(readerActor(),id)).history).toEqual([]);
      expect((await contractReturns.get({...readerActor(),authorizationCapabilities:["sourcing:view","supplier_contract_data:read"]},id)).attachments
        .map(file=>file.attachmentId)).toEqual([managerFileId]);
      expect((await database.query("SELECT count(*)::int AS count FROM sourcing_contract_return_submissions WHERE sourcing_case_id=$1",[id])).rows[0].count).toBe(3);
      expect(service.canDownloadBoundAttachment(readerActor(),{entityType:"sourcing_contract_return",entityId:id,mimeType:"application/pdf"})).toBe(false);
      expect(service.canDownloadBoundAttachment({...rootActor(),authorizationCapability:"sourcing:view"},{entityType:"sourcing_contract_return",entityId:id,mimeType:"application/pdf"})).toBe(true);
    } finally {
      if(previous===undefined) delete process.env.CONTRACT_RETURN_MONITOR_ENABLED_AT;
      else process.env.CONTRACT_RETURN_MONITOR_ENABLED_AT=previous;
    }
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
      .rows[0]?.status).toBe("completed");
    const currentTodo=(await database.query<{todo_id:string}>(
      `SELECT todo_id FROM rework_todos WHERE entity_id=$1 AND category='sourcing_contract_return'
       AND status='pending'`,[id])).rows[0]?.todo_id;
    expect(currentTodo).toBeTruthy();
    const attachmentId=randomUUID();
    await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,
      size_bytes,sha256,uploaded_by,status,ready_at)
      VALUES($1,$2,'签回.pdf','application/pdf',128,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [attachmentId,`contract-return-todo/${attachmentId}`,"d".repeat(64),merchandiserId]);
    await contractReturns.submit(contractActor(),id,[attachmentId],randomUUID());
    expect((await database.query("SELECT status FROM rework_todos WHERE todo_id=$1",[currentTodo]))
      .rows[0]?.status).toBe("completed");
    expect((await database.query("SELECT delivery_kind FROM todo_delivery_attempts WHERE todo_id=$1 ORDER BY attempted_at",[currentTodo]))
      .rows.map(row=>row.delivery_kind)).toEqual(["create","complete"]);
    expect((await database.query("SELECT count(*)::int AS count FROM rework_todos WHERE entity_id=$1 AND category='sourcing_contract_return'",[id]))
      .rows[0]?.count).toBe(2);
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
  const budgetFixture = async () => {
    await ensureReturnTodoRecipient();
    const designerId = randomUUID();
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST P09 designer',true)", [designerId]);
    await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2::uuid,'dingtalk','corp',$2::text,$2::text,true,true,CURRENT_TIMESTAMP)", [randomUUID(), designerId]);
    await database.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation");
    try {
      await database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,'sample_designer',$3,'TEST P09 fixture')", [randomUUID(), designerId, merchandiserId]);
    } finally { await database.query("ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation"); }
    const designer: TrustedActorContext = { actorId: designerId, actorRoles: ["sample_designer"], authorizationCapability: "digital_production:view", authorizationCapabilities: ["digital_production:view", "pattern_room:orders:create"], requestId: randomUUID() };
    await database.query("UPDATE digital_production_customers SET default_merchandiser_id=$1 WHERE code='PD'", [merchandiserId]);
    const identity = new DigitalProductionIdentityService(database, true);
    const order = await identity.createOrder(designer, DigitalOrderCreateSchema.parse({
      customerCode: "PD", productGroup: "男装", designStyleNo: `TEST-P09-${randomUUID()}`,
      orderDate: "2026-09-30", contractDeliveryDate: "2026-11-20", primaryMerchandiserId: merchandiserId,
      lines: [{ poNumber: "TEST-PO1", color: "黑", sizes: [{ size: "M", quantity: 137 }] }, { poNumber: "TEST-PO2", color: "白", sizes: [{ size: "M", quantity: 63 }] }],
    }), randomUUID());
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
    const imageId = randomUUID(), objectKey = `tests/p09/${imageId}.png`, sha256 = createHash("sha256").update(bytes).digest("hex");
    await contractStorage.writeImmutable(objectKey, bytes, { mimeType: "image/png", sha256 });
    await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST.png','image/png',$3,$4,$5,'ready',CURRENT_TIMESTAMP)", [imageId, objectKey, bytes.length, sha256, designerId]);
    const document = BudgetDocumentSchema.parse({ fabricType: "梭织", productCategory: "短裤", monthSeries: "", date: "2026-09-30", currency: "人民币", rows: [],
      freight: "0.3", cm: "8.3", salePrice: "48", outsourcingScope: "车缝、整烫", outsourcingUnitPrice: "5.25", imageAttachmentIds: [imageId] });
    const budget = new DigitalBudgetService(database, true);
    return { order, designer, document, imageId, budget };
  };

  it('P16 keeps a source-backed analysis and improvement loop inside scope and original export rights',async()=>{
    const fixture=await budgetFixture(),primary=merchandiserActor(),root=rootActor();
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary,manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId('净色车缝'),'none',{cuttingProcess:'in_house',stopAtReady:true}))!;
    const analysis=new DigitalAnalysisQuery(database),filters=DigitalAnalysisFilterSchema.parse({from:'2020-01-01',to:'2030-12-31',customer:'PD',designer:fixture.designer.actorId,category:'上衣'});
    const result=await analysis.list(fixture.designer,filters);
    expect(result.total).toBeGreaterThan(0);expect(result.summary.newStyles).toBe(1);expect(result.rows.every(row=>row.styleNo===fixture.order.designStyleNo)).toBe(true);
    expect(result.canExport).toBe(false);expect(result.canRecord).toBe(false);
    await expect(analysis.export(fixture.designer,filters)).rejects.toMatchObject({statusCode:403});
    const stranger=await budgetFixture();expect((await analysis.list(stranger.designer,filters)).total).toBe(0);
    const worker=ready.people.pattern_room_worker!,workerResult=await analysis.list(worker,filters);
    expect(workerResult.rows.every(row=>row.assigneeId===worker.actorId||row.orderId===ready.id)).toBe(true);
    const taskId=result.rows.find(row=>row.state==='ready')!.taskId;
    const taskService=new DigitalProductionTaskService(database);await taskService.feedback(root,taskId,'TEST交接资料待核实',true,randomUUID());
    expect((await analysis.list(root,filters)).rows.find(row=>row.taskId===taskId)?.events.some(event=>event.kind==='blocked')).toBe(true);
    const note={filters,taskIds:[taskId],conclusion:'TEST发现交接条件滞留，已回看原任务，无法推断净工时',action:'TEST主管核对交接登记并记录下一次观察；不修改工资或真实权限',observeAt:new Date(Date.now()+86400000).toISOString()};
    await expect(analysis.record(fixture.designer,note,randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(analysis.record(root,{...note,taskIds:[randomUUID()]},randomUUID())).rejects.toMatchObject({statusCode:404});
    const key=randomUUID(),saved=await analysis.record(root,note,key);expect(await analysis.record(root,note,key)).toEqual(saved);
    await expect(analysis.record(root,{...note,conclusion:'TEST不同结论'},key)).rejects.toMatchObject({statusCode:409});
    const followup=await analysis.list(root,filters);expect(followup.notes.find(item=>item.id===saved.id)).toMatchObject({conclusion:note.conclusion,action:note.action,taskIds:[taskId],ruleVersion:'digital-production-p16-v2'});
    await taskService.feedback(root,taskId,'TEST回看原单后交接资料已核实',false,randomUUID());
    const observed=(await analysis.list(root,filters)).rows.find(row=>row.taskId===taskId)!;expect(observed.state).toBe('ready');expect(observed.events.some(event=>event.kind==='unblocked')).toBe(true);expect(observed.waitingSeconds).toBeGreaterThanOrEqual(0);
    const conditionTask=observed.taskId,connection=await database.connect();
    try{
      const condition=(await connection.query("SELECT condition_key FROM digital_production_task_conditions WHERE task_id=$1 LIMIT 1",[conditionTask])).rows[0].condition_key;
      await connection.query('BEGIN');await taskService.setConditionWithClient(connection,root,conditionTask,condition,false,null,'TEST前置失效发生时间未知');await connection.query('COMMIT');
      expect((await analysis.list(root,filters)).rows.find(row=>row.taskId===conditionTask)).toMatchObject({state:'blocked',unknownWaiting:1});
      await connection.query('BEGIN');await taskService.setConditionWithClient(connection,root,conditionTask,condition,true,new Date().toISOString(),'TEST前置恢复');await taskService.refreshBusinessConditionsWithClient(connection,root,conditionTask);await connection.query('COMMIT');
      const restored=(await analysis.list(root,filters)).rows.find(row=>row.taskId===conditionTask)!;
      expect(restored.state).toBe('ready');expect(restored.unknownWaiting).toBe(1);expect(restored.pendingConditions).toEqual([]);
    }finally{await connection.query('ROLLBACK');connection.release();}
    const workbook=await analysis.export(root,filters);expect(workbook.subarray(0,2).toString()).toBe('PK');
    expect((await database.query("SELECT count(*)::int AS n FROM audit_events WHERE action='digital.analysis.recorded' AND id=$1",[saved.id])).rows[0].n).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/salePrice|unitPrice|budget_amount|wageAmount/);
    const app=Fastify();app.setErrorHandler((error,_request,reply)=>{const problem=error as {statusCode?:number;message:string};reply.code(problem.statusCode??500).send({error:problem.message});});
    registerDigitalAnalysisRoutes(app,{service:new DigitalProductionIdentityService(database,true),creationEnabled:true,authenticate:async()=>({id:fixture.designer.actorId,displayName:'TEST设计师',businessRoles:['sample_designer'],capabilities:[]})},analysis);
    try{
      const query=new URLSearchParams(Object.entries(filters).map(([key,value])=>[key,String(value)])).toString();
      expect((await app.inject({method:'GET',url:`/digital-production/analysis?${query}`})).statusCode).toBe(200);
      expect((await app.inject({method:'GET',url:`/digital-production/analysis/export?${query}`})).statusCode).toBe(403);
      expect((await app.inject({method:'POST',url:'/digital-production/analysis/notes',payload:note,headers:{'idempotency-key':randomUUID()}})).statusCode).toBe(403);
      expect((await app.inject({method:'GET',url:'/digital-production/analysis?from=bad&to=bad'})).statusCode).toBe(400);
    }finally{await app.close();}

  });
  it("P09 preserves published budgets, rejects technical readers and stale or unauthorized writes", async () => {
    const { order, designer, document, imageId, budget } = await budgetFixture(), id = order.productionOrderId;
    const key = randomUUID();
    const saved = await budget.save(designer, id, { expectedVersion: 0, document }, key);
    expect((await budget.save(designer, id, { expectedVersion: 0, document }, key)).version).toBe(saved.version);
    await expect(budget.save(designer, id, { expectedVersion: 0, document: { ...document, cm: "9" } }, key)).rejects.toMatchObject({ statusCode: 409 });
    await expect(budget.save(merchandiserActor(), id, { expectedVersion: 1, document }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    const technical = { ...ieActor(), actorRoles: ["pattern_room_supervisor"], authorizationCapability: "digital_production:view" };
    await expect(budget.read(technical, id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(budget.canDownload(technical, id, imageId)).rejects.toMatchObject({ statusCode: 404 });
    expect(await budget.canDownload(designer, id, imageId)).toBe(true);
    const publishKey = randomUUID();
    const published = await Promise.all([budget.publish(designer, id, 1, publishKey), budget.publish(designer, id, 1, publishKey)]);
    expect(published.map(value => value.status)).toEqual(["published", "published"]);
    const task = (await database.query("SELECT p.task_id,t.state,a.assignee_id FROM digital_budget_preparations p JOIN digital_production_tasks t USING(task_id) JOIN digital_production_task_access a USING(task_id) WHERE p.production_order_id=$1", [id])).rows[0];
    expect(task).toMatchObject({ state: "ready", assignee_id: merchandiserId });
    await expect(new DigitalProductionTaskService(database).complete(merchandiserActor(), task.task_id, { note: "不能直接完成" }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    const disabled = new DigitalBudgetService(database, false);
    await disabled.save(designer, id, { expectedVersion: 1, document: { ...document, cm: "9" } }, randomUUID());
    expect((await budget.read(designer, id, undefined, 1)).document?.cm).toBe("8.3");
    await expect(budget.prepareSourcing(merchandiserActor(), id, 1, attachments)).rejects.toMatchObject({ statusCode: 409 });
    await expect(database.query("UPDATE digital_budget_versions SET document='{}' WHERE production_order_id=$1", [id])).rejects.toThrow("immutable");
    expect((await database.query("SELECT count(*)::int AS n FROM digital_production_task_access WHERE production_order_id=$1 AND task_kind='sourcing_preparation'", [id])).rows[0].n).toBe(1);
  });

  it("P09 carries all PO quantities and owned image copies into exactly one original sourcing case", async () => {
    const { order, designer, document, imageId, budget } = await budgetFixture(), id = order.productionOrderId;
    await budget.save(designer, id, { expectedVersion: 0, document }, randomUUID());
    await budget.publish(designer, id, 1, randomUUID());
    const prepared = await budget.prepareSourcing(merchandiserActor(), id, 1, attachments);
    expect(prepared.lineItems.map(line => line.quantity)).toEqual([137, 63]);
    expect(prepared.daxingUnitPrice).toBe("5.25");
    expect(prepared.contractDeliveryDate).toBe("2026-11-20");
    expect(prepared.images[0]!.attachmentId).not.toBe(imageId);
    expect((await budget.prepareSourcing(merchandiserActor(), id, 1, attachments)).images).toEqual(prepared.images);
    const input = {
      gender: prepared.gender, styleName: prepared.styleName, deliveryDate: "2026-11-10",
      estimatedCutPieceSendDate: "2026-10-20", daxingUnitPrice: prepared.daxingUnitPrice,
      attachmentIds: prepared.images.map(image => image.attachmentId),
      lineItems: prepared.lineItems.map(({ styleNo, alternateStyleNo, color, quantity }) => ({ styleNo, alternateStyleNo, color, quantity })),
      digitalBudget: { productionOrderId: id, budgetVersion: prepared.budgetVersion, orderVersion: prepared.orderVersion },
    };
    await expect(service.createCase(merchandiserActor(), { ...input, lineItems: input.lineItems.slice(0, 1) }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.createCase(merchandiserActor(), { ...input, daxingUnitPrice: "8.30" }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    const key = randomUUID();
    const results = await Promise.all([service.createCase(merchandiserActor(), input, key), service.createCase(merchandiserActor(), input, key)]);
    const caseId = results[0]!.value.sourcingCaseId;
    expect(results[1]!.value.sourcingCaseId).toBe(caseId);
    expect(results[0]!.value.status).toBe("pending_ie_quote");
    expect(results[0]!.value.deliveryDate).toBe("2026-11-10");
    expect((await database.query("SELECT workflow_generation FROM sourcing_cases WHERE sourcing_case_id=$1", [caseId])).rows[0].workflow_generation).toBe("digital_production_v1");
    expect((await database.query("SELECT count(*)::int AS n FROM digital_production_child_lines WHERE child_id=$1", [caseId])).rows[0].n).toBe(2);
    expect((await database.query("SELECT entity_type,entity_id FROM attachments WHERE attachment_id=$1", [imageId])).rows[0]).toEqual({ entity_type: "digital_budget", entity_id: id });
    expect((await database.query("SELECT entity_type,entity_id FROM attachments WHERE attachment_id=$1", [input.attachmentIds[0]])).rows[0]).toEqual({ entity_type: "sourcing_case", entity_id: caseId });
    expect((await database.query("SELECT t.state FROM digital_budget_preparations p JOIN digital_production_tasks t USING(task_id) WHERE p.production_order_id=$1", [id])).rows[0].state).toBe("completed");
    expect(await digitalTodoOrder(database, { routeName: "sourcing_detail", entityId: caseId })).toBe(id);
    await expect(service.createCase(merchandiserActor(), input, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    await expect(budget.save(designer, id, { expectedVersion: 1, document }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    // Corrupt only this owned test schema to prove a missing mapping never falls back to legacy.
    const corruption = await database.connect();
    try {
      await corruption.query("BEGIN");
      await corruption.query("ALTER TABLE digital_production_child_lines DISABLE TRIGGER digital_production_child_lines_immutable");
      await corruption.query("ALTER TABLE digital_production_child_links DISABLE TRIGGER digital_production_child_links_immutable");
      await corruption.query("DELETE FROM digital_production_child_lines WHERE child_id=$1", [caseId]);
      await corruption.query("DELETE FROM digital_production_child_links WHERE child_id=$1", [caseId]);
      await expect(digitalTodoOrder(corruption, { routeName: "sourcing_detail", entityId: caseId })).rejects.toMatchObject({ code: "DIGITAL_LINK_MISSING" });
    } finally { await corruption.query("ROLLBACK"); corruption.release(); }
  });


  it("P10 keeps technical versions, units, date approval and budget boundaries independent", async () => {
    const fixture=await budgetFixture();
    await fixture.budget.save(fixture.designer,fixture.order.productionOrderId,{expectedVersion:0,document:fixture.document},randomUUID());
    await exerciseInstructions(database,fixture.order,merchandiserActor(),fixture.designer,managerActor("TEST P10"),fixture.imageId);
  });

  it.each(['none','pattern-first','preshrink-first','concurrent'] as const)("P11 releases exactly one whole-order cutting task with %s preparation",async mode=>{
    await exerciseBulkPreparation(database,await budgetFixture(),service,attachments,{primary:merchandiserActor(),manager:managerActor(),owner:ownerActor(),ie:ieActor(),root:rootActor()},factoryId,craftId("净色车缝"),mode);
  });

  it("V2 hides deleted native sourcing decisions and dead record links from Journey",async()=>{
    const fixture=await budgetFixture(),root=rootActor();
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary:merchandiserActor(),manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId("净色车缝"),'pattern-first',{cuttingProcess:'in_house',stopAtReady:true}))!;
    const query=new DigitalJourneyQuery(database),before=await query.read(root,ready.id);
    expect(before.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='sourcing_owner')?.state).toBe('completed');
    expect(before.links.some(link=>link.domain==='sourcing'&&link.id===ready.caseId)).toBe(true);
    await service.deleteByRoot(root,ready.caseId,randomUUID());
    await expect(service.getCase({...root,authorizationCapability:'sourcing:view'},ready.caseId)).rejects.toMatchObject({statusCode:404});
    const after=await query.read(root,ready.id),nodes=after.stages.flatMap(stage=>stage.nodes).filter(node=>['sourcing_preparation','sourcing_ie','sourcing_director','sourcing_owner'].includes(node.key));
    expect(nodes).toHaveLength(4);
    for(const node of nodes.filter(node=>node.key!=='sourcing_preparation'))expect(node).toMatchObject({state:'uncreated',owner:null,operator:null,actualAt:null,records:[]});
    // Original digital preparation task evidence survives; deleted native approvals do not.
    expect(nodes.find(node=>node.key==='sourcing_preparation')?.records.every(record=>record.domain==='task')).toBe(true);
    expect(after.links.some(link=>link.domain==='sourcing')).toBe(false);
    expect(JSON.stringify(after)).not.toContain(ready.caseId);
    expect((await ready.bulk.read(root,ready.id)).ownerApproved).toBe(false);
  });

  it.each(['in_house','outsourced'] as const)('P12 aggregates all original PO cutting facts and syncs numbers without restarting %s',async mode=>{
    const fixture=await budgetFixture(),primary=merchandiserActor(),root=rootActor();
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary,manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId("净色车缝"),'none',{cuttingProcess:mode,stopAtReady:true}))!;
    const {id,caseId,people,cutting,bulk,instruction}=ready;
    const ids=(await database.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position',[caseId])).rows.map(r=>r.cutting_order_id);
    const internal={...people.cutting_worker!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create','cutting:orders:view']};
    const external={...primary,authorizationCapability:'cutting:records:create'};
    const recorder=mode==='in_house'?internal:external,wrong=mode==='in_house'?external:internal;
    const photo=async(actor:typeof recorder)=>{const image=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-P12.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[image,`TEST/P12/${image}`,'c'.repeat(64),actor.actorId]);return image;};
    await expect(cutting.record(wrong,ids[0],{pieceCount:2,actualCutCount:99,attachmentIds:[await photo(wrong)]},randomUUID())).rejects.toMatchObject({statusCode:403});
    await cutting.record(recorder,ids[0],{pieceCount:2,actualCutCount:99,attachmentIds:[await photo(recorder)]},randomUUID());
    expect((await bulk.read(primary,id)).cutting.completed).toBe(false);
    expect((await database.query('SELECT 1 FROM digital_bulk_cutting_completions WHERE production_order_id=$1',[id])).rowCount).toBe(0);
    const cockpit=new DigitalCockpitQuery(database),cockpitInput={stage:'bulk' as const,page:1,search:fixture.order.designStyleNo};
    const partialProgress=(await cockpit.list(primary,cockpitInput)).items.find(row=>row.orderId===id)!;
    expect((await cockpit.list(recorder,cockpitInput)).items.some(row=>row.orderId===id)).toBe(true);
    const outsider={...fixture.designer,actorId:randomUUID()};
    expect((await cockpit.list(outsider,cockpitInput)).total).toBe(0);
    expect(partialProgress.lines).toHaveLength(2);expect(partialProgress.progress).toEqual({applicable:7,completed:1});
    const before=(await bulk.read(primary,id)).tasks.find(t=>t.taskKind.startsWith('bulk_cutting'))!;
    const identity=new DigitalProductionIdentityService(database,true,service),current=await identity.read(primary,id);
    const formal=`TEST-P12-${randomUUID().slice(0,8)}`;
    await identity.correctNumbers(primary,id,current.lines[0]!.lineId,{expectedVersion:current.version,formalStyleNo:formal,poNumber:'TEST-PO-P12'},randomUUID());
    expect((await cutting.get(root,ids[0])).formalStyleNo).toBe(formal);
    expect((await instruction.read(root,id,database,1)).order.lines[0]!.formalStyleNo).toBe(formal);
    expect((await database.query('SELECT max(identity_version)::int AS n FROM sourcing_contract_documents WHERE sourcing_case_id=$1',[caseId])).rows[0].n).toBe(1);
    const after=(await bulk.read(primary,id)).tasks.find(t=>t.taskKind.startsWith('bulk_cutting'))!;
    expect([after.taskId,after.enteredAt,after.dueAt]).toEqual([before.taskId,before.enteredAt,before.dueAt]);
    const input={pieceCount:3,actualCutCount:101,attachmentIds:[await photo(recorder)]},key=randomUUID();
    await cutting.record(recorder,ids[1],input,key);await cutting.record(recorder,ids[1],input,key);
    expect((await bulk.read(primary,id)).cutting.completed).toBe(true);
    expect((await cockpit.list(primary,cockpitInput)).items.find(row=>row.orderId===id)!.progress).toEqual({applicable:7,completed:2});
    expect((await database.query('SELECT 1 FROM digital_bulk_cutting_completions WHERE production_order_id=$1',[id])).rowCount).toBe(1);
    await cutting.correct({...root,authorizationCapability:'cutting:records:correct'},ids[0],{expectedVersion:1,pieceCount:4,actualCutCount:103,reason:'TEST真实实绩更正'},randomUUID());
    const final=await bulk.read(primary,id);expect(final.cutting.lines[0]).toMatchObject({orderQuantity:137,actualCutCount:103,pieceCount:4,corrected:true});
    expect(final.tasks.find(t=>t.taskId===before.taskId)).toMatchObject({state:'completed',enteredAt:before.enteredAt,dueAt:before.dueAt});
    expect((await database.query('SELECT 1 FROM digital_bulk_cutting_completions WHERE production_order_id=$1',[id])).rowCount).toBe(1);
  });

  it("P14 reads empty receipt/packing facts before cutting for authorized users", async () => {
    const { order, designer } = await budgetFixture();
    const closure = new OrderClosureService(database);
    for (const actor of [designer, managerActor(), merchandiserActor()]) {
      const sheet = await closure.read(actor, order.productionOrderId);
      expect(sheet).toMatchObject({ stage: "等待回货与装箱", productionId: null, canClose: false, closed: null });
      expect(sheet.lines).toHaveLength(2);
      expect(sheet.lines.map(line => line.orderedQuantity)).toEqual([137, 63]);
      for (const line of sheet.lines) expect(line).toMatchObject({
        cuttingId: null, receivingBatchId: null, actualQuantity: 0, documentQuantity: 0,
        defectiveQuantity: 0, receiptCount: 0, packingQuantity: null, receipts: [], reworks: [],
      });
      expect(sheet.outstanding).toContain("TEST-PO1 黑：尚无原收货事实");
      expect(sheet.outstanding).toContain("TEST-PO2 白：尚无原装箱事实");
    }
    await expect(closure.read({ ...designer, actorId: randomUUID() }, order.productionOrderId))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it.each(['无','印花'] as const)('P13/P14 whole-order %s flow links native receiving and preserves closure facts',async secondaryCraft=>{
    const fixture=await budgetFixture(),primary=merchandiserActor(),root=rootActor(),flow=new FactoryFlowService(database),tasks=new DigitalProductionTaskService(database);
    const ready=(await exerciseBulkPreparation(database,fixture,service,attachments,{primary,manager:managerActor(),owner:ownerActor(),ie:ieActor(),root},factoryId,craftId("净色车缝"),'none',{cuttingProcess:'in_house',stopAtReady:true,secondaryCraft}))!;
    const {id,caseId,people,cutting}=ready;
    const ids=(await database.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position',[caseId])).rows.map(r=>r.cutting_order_id);
    for(const cuttingId of ids){const image=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-P13-cut.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[image,`TEST/P13/${image}`,'c'.repeat(64),root.actorId]);await cutting.record({...root,authorizationCapability:'cutting:records:create'},cuttingId,{pieceCount:1,actualCutCount:100,attachmentIds:[image]},randomUUID());}
    let state=await flow.read(primary,id);expect(state).toMatchObject({allCut:true,secondaryCraft,dispatched:false,sampleTargetDate:'2026-11-10'});
    expect(state.tasks.find(t=>t.taskKind==='factory_material_count')).toMatchObject({state:'pending',enteredAt:null,dueAt:null});
    const original=(await contractService.getCurrent(root,caseId)).item!;expect(original.status).toBe('ready');
    await expect(production.dispatch(root,caseId,{sourcingContractDocumentId:original.sourcingContractDocumentId,confirmed:true},randomUUID())).rejects.toMatchObject({statusCode:409});
    const warehouse=people.warehouse_receiver!,logistics=people.embroidery_washing_merchandiser!,qc=people.quality_control!,tail=people.pattern_room_tail_inspector!;
    if(secondaryCraft!=='无'){
      for(const [kind,actor] of [['process_logistics',logistics],['bulk_qc',qc]] as const)await tasks.reassign(root,state.tasks.find(t=>t.taskKind===kind)!.taskId,actor.actorId,randomUUID());
      const movement=async(kind:'工艺发出'|'工艺回仓')=>{state=await flow.read(logistics,id);return flow.logistics(logistics,id,{expectedRevision:state.revision,kind,occurredAt:new Date().toISOString(),supplier:'TEST印花厂',note:'TEST整款'},randomUUID());};
      await expect(flow.logistics(logistics,id,{expectedRevision:state.revision,kind:'工艺发出',occurredAt:'2000-01-01T00:00:00Z',supplier:'TEST印花厂',note:'TEST不允许早于实裁'},randomUUID())).rejects.toMatchObject({statusCode:409});
      await movement('工艺发出');await movement('工艺回仓');state=await flow.read(qc,id);
      const qcImage=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-P13-QC.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[qcImage,`TEST/P13/QC/${qcImage}`,'d'.repeat(64),qc.actorId]);
      const checks=state.lines.map((l,i)=>({lineId:l.lineId,result:i===0?'合格' as const:'需处理' as const,problem:i===0?'':'TEST印花错位，请重做',treatment:'',attachmentIds:i===0?[qcImage]:[]}));
      await expect(flow.qc(logistics,id,{expectedRevision:state.revision,checks,note:''},randomUUID())).rejects.toMatchObject({statusCode:403});
      await expect(flow.qc(tail,id,{expectedRevision:state.revision,checks,note:''},randomUUID())).rejects.toMatchObject({statusCode:404});
      state=await flow.qc(qc,id,{expectedRevision:state.revision,checks,note:''},randomUUID());expect(state.allQc).toBe(false);
      expect(await flow.canDownload(primary,id,qcImage)).toBe(true);expect(await flow.canDownload(logistics,id,qcImage)).toBe(true);expect(await flow.canDownload(tail,id,qcImage)).toBe(false);expect(await flow.canDownload(primary,randomUUID(),qcImage)).toBe(false);
      await expect(flow.qc(qc,id,{expectedRevision:state.revision,checks:[checks[0]!],note:''},randomUUID())).rejects.toMatchObject({statusCode:409});

      await expect(flow.dispatch(warehouse,id,{expectedRevision:state.revision,occurredAt:new Date().toISOString(),supplierId:factoryId,note:''},randomUUID())).rejects.toMatchObject({statusCode:409});
      await movement('工艺发出');await movement('工艺回仓');state=await flow.read(qc,id);expect(state.lines.every(l=>l.result===null)).toBe(true);
      state=await flow.qc(qc,id,{expectedRevision:state.revision,checks:state.lines.map(l=>({lineId:l.lineId,result:'合格',problem:'',treatment:'TEST已重做复查合格',attachmentIds:[]})),note:''},randomUUID());expect(state.allQc).toBe(true);
      // New issue before actual dispatch must block the entire order again.
      const qcTask=state.tasks.find(t=>t.taskKind==='bulk_qc')!;expect(qcTask.state).toBe('ready');
      state=await flow.qc(qc,id,{expectedRevision:state.revision,checks:[{lineId:state.lines[0]!.lineId,result:'需处理',problem:'TEST发厂前发现问题',treatment:'',attachmentIds:[]}],note:''},randomUUID());expect(state.allQc).toBe(false);
      state=await flow.qc(qc,id,{expectedRevision:state.revision,checks:[{lineId:state.lines[0]!.lineId,result:'合格',problem:'',treatment:'TEST复查已处理',attachmentIds:[]}],note:''},randomUUID());
      expect(state.tasks.find(t=>t.taskKind==='warehouse_dispatch')!.state).toBe('ready');
    }
    state=await flow.read(warehouse,id);await expect(flow.dispatch(warehouse,id,{expectedRevision:state.revision,occurredAt:'2000-01-01T00:00:00Z',supplierId:factoryId,note:'TEST不允许早于实裁/QC'},randomUUID())).rejects.toMatchObject({statusCode:409});
    if(secondaryCraft!=='无'){const beforeQc=new Date(Math.max(...state.checks.map(c=>new Date(c.checkedAt).getTime()))-1).toISOString();expect(new Date(beforeQc).getTime()).toBeGreaterThan(new Date(state.facts.filter(f=>f.kind==='工艺回仓').at(-1)!.occurredAt!).getTime());await expect(flow.dispatch(warehouse,id,{expectedRevision:state.revision,occurredAt:beforeQc,supplierId:factoryId,note:'TEST不能倒填至当前QC之前'},randomUUID())).rejects.toMatchObject({statusCode:409});}
    state=await flow.read(warehouse,id);const dispatchedAt=new Date().toISOString(),input={expectedRevision:state.revision,occurredAt:dispatchedAt,supplierId:factoryId,note:'TEST整款已实际发厂'},key=randomUUID();
    const dispatched=await flow.dispatch(warehouse,id,input,key);await flow.dispatch(warehouse,id,input,key);expect(dispatched.dispatched).toBe(true);expect(dispatched.productionId).toBeTruthy();
    expect((await database.query('SELECT count(*)::int n FROM sourcing_production_orders WHERE sourcing_case_id=$1',[caseId])).rows[0].n).toBe(1);
    expect(new Date((await database.query('SELECT dispatched_at FROM sourcing_production_orders WHERE sourcing_case_id=$1',[caseId])).rows[0].dispatched_at).toISOString()).toBe(dispatchedAt);
    expect((await database.query("SELECT count(*)::int n FROM digital_production_child_lines WHERE module='production' AND child_id=$1",[dispatched.productionId])).rows[0].n).toBe(2);
    expect((await database.query('SELECT 1 FROM receiving_receipts WHERE style_no=$1',[fixture.order.designStyleNo])).rowCount).toBe(0);
    state=await flow.read(primary,id);expect(state.tasks.find(t=>t.taskKind==='factory_material_count')).toMatchObject({dueAt:null,enteredAt:null});
    state=await flow.followup(primary,id,{expectedRevision:state.revision,kind:'工厂到料',occurredAt:null,trackingNumber:'',note:'TEST真实时间待确认'},randomUUID());expect(state.tasks.find(t=>t.taskKind==='factory_material_count')!.dueAt).toBeNull();
    const arrival=new Date().toISOString();state=await flow.followup(primary,id,{expectedRevision:state.revision,kind:'工厂到料',occurredAt:arrival,trackingNumber:'',note:'TEST确认工厂已实际收到'},randomUUID());
    expect(state.tasks.find(t=>t.taskKind==='factory_material_count')!.dueAt).toBe(new Date(new Date(arrival).getTime()+48*3600*1000).toISOString());
    state=await flow.followup(primary,id,{expectedRevision:state.revision,kind:'到料清点',occurredAt:new Date().toISOString(),trackingNumber:'',note:'TEST面辅料清点齐备'},randomUUID());
    state=await flow.followup(primary,id,{expectedRevision:state.revision,kind:'船样寄出',occurredAt:new Date().toISOString(),trackingNumber:'TEST-SF-001',note:'TEST齐色船样已寄出'},randomUUID());
    expect(state.tasks.filter(t=>['factory_material_count','bulk_ship_sample'].includes(t.taskKind)).every(t=>t.state==='completed')).toBe(true);
    expect((await database.query('SELECT 1 FROM sourcing_finance_reconciliations WHERE sourcing_case_id=$1',[caseId])).rowCount).toBe(0);
    const replacementId=randomUUID();await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST新主跟单',true)",[replacementId]);await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2::uuid,'dingtalk','corp',$2::text,$2::text,true,true,CURRENT_TIMESTAMP)",[randomUUID(),replacementId]);
    await database.query('ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation');try{await database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,'order_merchandiser',$3,'TEST P13换主跟单')",[randomUUID(),replacementId,root.actorId]);}finally{await database.query('ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation');}
    const access=new DigitalProductionAccessService(database),identity=new DigitalProductionIdentityService(database,true),replacement={...primary,actorId:replacementId};
    const assigned=await access.assignMerchandiser(root,id,replacementId,(await identity.read(root,id)).version);
    expect((await production.get(replacement,dispatched.productionId!)).productionOrderId).toBe(dispatched.productionId);
    expect((await production.list(replacement)).items.some(x=>x.productionOrderId===dispatched.productionId)).toBe(true);
    expect((await production.list(primary)).items.some(x=>x.productionOrderId===dispatched.productionId)).toBe(false);
    await expect(production.get(primary,dispatched.productionId!)).rejects.toMatchObject({statusCode:404});
    const reporting=new ProductionReportingService(database),dashboard=new ProductionDashboardService(database,reporting);
    expect((await dashboard.detail(replacement,dispatched.productionId!)).detail.order.productionOrderId).toBe(dispatched.productionId);
    await expect(dashboard.detail(primary,dispatched.productionId!)).rejects.toMatchObject({statusCode:404});
    await reporting.report(root,dispatched.productionId!,{position:1,businessDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),quantity:1},randomUUID());
    const reminders=new ProductionClosureService(database,undefined,()=>new Date(Date.now()+4*86400000));await reminders.setPilot(root,{supplierId:factoryId,enabled:true});
    const todoActor=(actor:typeof primary)=>({...actor,authorizationCapabilities:[...(actor.authorizationCapabilities??[]),'todo:view']});
    expect((await reminders.todos(todoActor(replacement))).some(t=>t.entityId===dispatched.productionId)).toBe(true);expect((await reminders.todos(todoActor(primary))).some(t=>t.entityId===dispatched.productionId)).toBe(false);
    await access.assignMerchandiser(root,id,primary.actorId,assigned.version);

    await exerciseOrderClosure(database,service,id,ids,{root,primary,manager:managerActor(),warehouse,qc},secondaryCraft==='无');
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
    expect(await contractReturns.get({...rootActor(),authorizationCapability:"sourcing:view"},id)).toEqual({...returned,currentContractReturned:false,currentContractDocumentId:rootDocument});
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

  it("keeps unapplied template changes available after a manual edit and rejects forged template advancement",async()=>{
    const created=await service.createCase(merchandiserActor(),{gender:"女装",styleName:"合同模板来源测试",estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-20",
      lineItems:[{styleNo:"MANUAL-TEMPLATE-PROVENANCE",color:"蓝",quantity:20}],daxingUnitPrice:"8",attachmentIds:[]},randomUUID());
    const id=created.value.sourcingCaseId;
    await service.quoteIePrice(ieActor(),id,{linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.recordManagementDecision(managerActor(),id,{supplierId:factoryId,craftIds:[craftId("净色车缝")],linePrices:[{position:1,unitPrice:"10"}]},randomUUID());
    await service.decideOwner(ownerActor(),id,{decision:"approved"},randomUUID());
    const original=(await contractService.getCurrent(rootActor(),id)).item!;
    const draft=await contractService.content.get(rootActor(),id);
    const template=(await contractService.management.templates(rootActor())).item;
    await contractService.management.saveTemplate(rootActor(),{...template,expectedVersion:template.templateVersion,
      terms:{...template.terms,payment:"等待明确同步的新付款条款"}},randomUUID());
    const input={...draft,content:{...draft.content,deliveryDate:"2026-12-03"}};
    const manual=await contractService.content.save(rootActor(),id,input,randomUUID());
    await contractService.generateIfReady(rootActor(),id,manual);
    expect((await contractService.getCurrent(rootActor(),id)).item?.templateVersion).toBe(original.templateVersion);
    expect((await contractService.content.get(rootActor(),id)).content).toEqual(input.content);
    // Reject forged manual documents at INSERT, even without any content-override row.
    const rejectManualInsert=async(actor:TrustedActorContext,sourceId:string,claimedVersion:number)=>{
    const row=(await database.query("SELECT * FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$1",[sourceId])).rows[0];
    const client=await database.connect();
    try {
      await client.query("BEGIN");
      const forged=randomUUID();
      const supplierValues=Object.fromEntries(Object.entries(row.approval_snapshot).filter(([k])=>["supplierName","supplierCode","address","contractEntityName","partyBRepresentative","payeeName","bankAccount","bankName"].includes(k)));
      const event=await new OperationEventRepository().append(client,actor,{action:"sourcing.contract.information.refresh",entityType:"sourcing_contract_document",entityId:forged,
        before:{documentId:sourceId},after:{mode:"manual_content",content:input.content,supplierValues,templateVersion:claimedVersion},reason:"TEST reject forged template advancement"});
      await expect(client.query(`INSERT INTO sourcing_contract_documents(sourcing_contract_document_id,sourcing_case_id,sourcing_approval_snapshot_id,sourcing_decision_id,
        contract_version,contract_number,template_version,approval_snapshot,missing_fields,status,prepared_by,identity_version,revision_of,information_revision,information_refresh_event_id)
        SELECT $1,sourcing_case_id,sourcing_approval_snapshot_id,sourcing_decision_id,contract_version+1,$2,$3,approval_snapshot,'{}','generation_pending',$4,
          identity_version,sourcing_contract_document_id,information_revision+1,$5 FROM sourcing_contract_documents WHERE sourcing_contract_document_id=$6`,
        [forged,'TEST-'+forged,claimedVersion,actor.actorId,event,sourceId])).rejects.toMatchObject({code:"42501"});
    } finally {await client.query("ROLLBACK");client.release();}
    };
    await rejectManualInsert(rootActor(),manual,template.templateVersion+1);
    await rejectManualInsert(managerActor(),manual,original.templateVersion);
    await rejectManualInsert(contractActor(),manual,original.templateVersion);
    const refresh=await contractService.management.previewInformation(contractActor(),id);
    expect(refresh.changes).toEqual(expect.arrayContaining([expect.objectContaining({field:"templateVersion"}),
      expect.objectContaining({field:"payment",after:"等待明确同步的新付款条款"})]));
    const refreshed=await contractService.management.refreshInformation(contractActor(),id,refresh,randomUUID());
    await contractService.generateIfReady(contractActor(),id,refreshed);
    expect((await contractService.getCurrent(rootActor(),id)).item?.templateVersion).toBe(template.templateVersion+1);
    expect((await contractService.content.get(rootActor(),id)).content).toMatchObject({deliveryDate:"2026-12-03",terms:{payment:"等待明确同步的新付款条款"}});
    await service.recordFinanceReconciliation(financeActor(),id,{result:"match"},randomUUID());
    await rejectManualInsert(rootActor(),refreshed,template.templateVersion+1);
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

});
