import { historicalDigitalOrder } from '../helpers/historical-digital-order-fixture.js';
import { customerQuotationFixture } from '../helpers/customer-quotation-fixture.js';
import { ownedPostgresSchema, createOwnedPostgresSchema, releaseOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { migrationExecutionSql } from "../../scripts/deploy/migration-execution-compatibility.mjs";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import pg from "pg";
import { afterAll, beforeAll, vi } from "vitest";
import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { DigitalBudgetService } from "../../apps/api/src/production-platform/budget-service.js";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { DigitalOrderCreateSchema } from "@dx-rework/contracts/digital-production";
import { BudgetDocumentSchema } from "@dx-rework/contracts/digital-budget";
import { CuttingSourceService } from "../../apps/api/src/cutting/cutting-source-service.js";
import { ReceivingService } from "../../apps/api/src/receiving/receiving-service.js";
import { SourcingContractService } from "../../apps/api/src/sourcing/sourcing-contract-service.js";
import { SourcingContractReturnService } from "../../apps/api/src/sourcing/sourcing-contract-return-service.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
import { TodoProjectionService } from "../../apps/api/src/todos/projection-service.js";
import { SourcingProductionService } from "../../apps/api/src/sourcing/sourcing-production-service.js";
import { SourcingService } from "../../apps/api/src/sourcing/sourcing-service.js";
import { AttachmentService } from "../../apps/api/src/tools/attachments.js";
import { type TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { FakeObjectStorage } from "../../apps/api/src/tools/storage.js";

// Each suite owns a fresh complete schema, services and mutable fixture state.
export function sourcingFixture(databaseUrl: string) {
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
  const incompleteFactoryId = randomUUID();
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
    await database.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation");
    try { await database.query(`INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason)
      SELECT $1,$2,'owner_group',$2,'TEST current owner for PO approval' WHERE NOT EXISTS(
        SELECT 1 FROM user_role_assignments WHERE user_id=$2 AND role_code='owner_group' AND revoked_at IS NULL)`,[randomUUID(),ownerId]);
    } finally {await database.query("ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation");}
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
    {const stageStart=performance.now();let stageStatus='failed';try {

    await createOwnedPostgresSchema(admin,schema);
    // Exercise the current production read contract against the complete schema.
    // The previous hand-picked schema stopped at 0150 and omitted exclusion dependencies.
    const manifest = JSON.parse(await readFile(new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url), "utf8")) as { migrations: { version: string; checksum: string }[] };
    const serverVersion=Number((await database.query("SHOW server_version_num")).rows[0].server_version_num);
    await database.query(`CREATE TABLE schema_migrations (
      version text PRIMARY KEY, checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const migrationClient = await database.connect();
    try {
      for (const migration of manifest.migrations) {
        await migrationClient.query("BEGIN");
        try {
          const sql=await readFile(new URL(`../../apps/api/migrations/${migration.version}.sql`, import.meta.url), "utf8");
          await migrationClient.query(migrationExecutionSql({...migration,sql},serverVersion));
          await migrationClient.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [migration.version, migration.checksum]);
          await migrationClient.query("COMMIT");
        } catch (error) { await migrationClient.query("ROLLBACK"); throw error; }
      }
    } finally { migrationClient.release(); }
      stageStatus='completed';
    }finally {process.stdout.write(JSON.stringify({suite:'sourcing-pr03-postgres',phase:'schema_migration_ms',ms:Math.round(performance.now()-stageStart),status:stageStatus})+'\n');}}

    {const stageStart=performance.now();let stageStatus='failed';try {

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
         VALUES($1,'FAC-01','factory'),($2,'FAC-02','factory'),($3,'FAC-OFF','factory'),($4,'FAC-INCOMPLETE','factory')`,
        [factoryId, replacementFactoryId, disabledFactoryId, incompleteFactoryId],
      );
      await database.query(
        `INSERT INTO supplier_catalog_versions(
           supplier_id,version,supplier_name,active,change_reason,changed_by,
           address,contract_entity_name,party_b_representative,
           payee_name,bank_account,bank_name
         ) VALUES
           ($1,1,'一号加工厂',true,'测试夹具',$4,'广州一号路','一号加工厂有限公司','陈一','陈一','622201','测试银行一支行'),
           ($2,1,'二号加工厂',true,'测试夹具',$4,'广州二号路','二号加工厂有限公司','陈二','陈二','622202','测试银行二支行'),
           ($3,1,'停用加工厂',false,'测试夹具',$4,NULL,NULL,NULL,NULL,NULL,NULL),
           ($5,1,'待补地址加工厂',true,'测试夹具',$4,NULL,'待补地址加工厂有限公司','新厂代表','新厂收款人','622203','新厂银行')`,
        [factoryId, replacementFactoryId, disabledFactoryId, managerId, incompleteFactoryId],
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

      stageStatus='completed';
    }finally {process.stdout.write(JSON.stringify({suite:'sourcing-pr03-postgres',phase:'fixture_ms',ms:Math.round(performance.now()-stageStart),status:stageStatus})+'\n');}}
});

  afterAll(async () => {
    {const stageStart=performance.now();let stageStatus='failed';try {

    await database.end();
    await releaseOwnedPostgresSchema(admin,schema);
    await admin.end();

      stageStatus='completed';
    }finally {process.stdout.write(JSON.stringify({suite:'sourcing-pr03-postgres',phase:'cleanup_ms',ms:Math.round(performance.now()-stageStart),status:stageStatus})+'\n');}}
});
  const budgetFixture = async (threePo=false,stylePrefix="TEST-P09",secondCustomerDate="2026-11-20",historicalPreparation=false) => {
    await cycleTodoServices();
    const designerId = randomUUID();
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST P09 designer',true)", [designerId]);
    await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2::uuid,'dingtalk','corp',$2::text,$2::text,true,true,CURRENT_TIMESTAMP)", [randomUUID(), designerId]);
    await database.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation");
    try {
      await database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,'sample_designer',$3,'TEST P09 fixture')", [randomUUID(), designerId, merchandiserId]);
    } finally { await database.query("ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation"); }
    const designer: TrustedActorContext = { actorId: designerId, actorRoles: ["sample_designer"], authorizationCapability: "digital_production:view", authorizationCapabilities: ["digital_production:view", "pattern_room:orders:create"], requestId: randomUUID() };
    await database.query("UPDATE digital_production_customers SET default_merchandiser_id=$1 WHERE code='PD'", [merchandiserId]);
    const identity = new DigitalProductionIdentityService(database, true, undefined,()=>new Date("2026-09-01T00:00:00Z"));
    const createOrder=historicalPreparation?(actor:TrustedActorContext,input:Parameters<typeof historicalDigitalOrder>[2])=>historicalDigitalOrder(database,actor,input,{slaBeforePreparation:true}):identity.createOrder.bind(identity);
    const order = await createOrder(designer, DigitalOrderCreateSchema.parse({
      customerCode: "PD", productGroup: "男装", designStyleNo: `${stylePrefix}-${randomUUID()}`,
      orderDate: "2026-09-01", contractDeliveryDate: "2026-11-20", primaryMerchandiserId: merchandiserId,
      lines: [{ poNumber: `TEST-PO1-${designerId}`, color: "黑", customerWarehouseArrivalDate:"2026-11-20", sizes: [{ size: "M", quantity: 137 }] }, { poNumber: `TEST-PO2-${designerId}`, color: "白", customerWarehouseArrivalDate:secondCustomerDate, sizes: [{ size: "M", quantity: 63 }] }, ...(threePo?[{poNumber:`TEST-PO3-${designerId}`,color:"蓝",customerWarehouseArrivalDate:"2026-11-20",sizes:[{size:"M",quantity:40}]}]:[])],
    }), randomUUID());
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
    const imageId = randomUUID(), objectKey = `tests/p09/${imageId}.png`, sha256 = createHash("sha256").update(bytes).digest("hex");
    await contractStorage.writeImmutable(objectKey, bytes, { mimeType: "image/png", sha256 });
    await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST.png','image/png',$3,$4,$5,'ready',CURRENT_TIMESTAMP)", [imageId, objectKey, bytes.length, sha256, designerId]);
    const document = BudgetDocumentSchema.parse({ fabricType: "梭织", productCategory: "短裤", monthSeries: "", date: "2026-09-30", currency: "人民币", rows: [],
      freight: "0.3", cm: "8.3", salePrice: "48", outsourcingScope: "车缝、整烫", outsourcingUnitPrice: "5.25", imageAttachmentIds: [imageId] });
    await customerQuotationFixture(database,rootActor(),order.productionOrderId);
    const budget = new DigitalBudgetService(database, true);
    return { order, designer, document, imageId, budget };
  };

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
  return { cycleSnapshot, schema, admin, database, todoProjection, contractStorage, attachments, contractService, contractReturns, service, cutting, receiving, production, craftService, craftIdsByName, craftId, merchandiserId, ieId, managerId, ownerId, financeId, factoryId, replacementFactoryId, disabledFactoryId, incompleteFactoryId, evidenceId, ensureReturnTodoRecipient, readyCuttingSheet, merchandiserActor, ieActor, managerActor, ownerActor, cuttingOwnerActor, cuttingSupervisorActor, cuttingWorkerActor, cuttingRootActor, warehouseActor, factoryChangeActor, contractActor, factoryChangeVerifier, financeActor, exceptionVerifier, readerActor, unrelatedReaderActor, anotherMerchandiserReader, rootActor, budgetFixture, cycleTodoServices };
}
