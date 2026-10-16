import { exerciseRevisionApproval } from "./helpers/revision-approval-scenario.js";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { RootAuthority } from "../../apps/api/src/access/root-authority.js";
import { exerciseReceivingDifferenceAuthority } from "./helpers/receiving-difference-authority-scenario.js";
import { WorkerAwareAccessMasterDataService } from "../../apps/api/src/access/worker-aware-access-service.js";
import { exerciseWagePagination } from "./helpers/wage-pagination-scenario.js";
import { exerciseFinancePatternQueries, exerciseMixedFinancePatternScope } from "./helpers/finance-pattern-query-scenario.js";
import { exerciseFinanceOrderQueries } from "./helpers/finance-order-query-scenario.js";
import { MemberModuleBindingService } from "../../apps/api/src/access/member-module-binding-service.js";
import "./member-module-policy-postgres.cases.js";
import { exerciseAtomicOverDeduction } from "./helpers/atomic-deduction-scenario.js";
import { registerManagementReportingRoutes } from "../../apps/api/src/reporting/management-reporting-routes.js";
import { ReportExportService } from "../../apps/api/src/reporting/report-export-service.js";
import { PATTERN_ORDER_ROLES } from "@dx-rework/contracts/pattern-orders";
import { PatternRoomOrderService, patternTodoKey } from "../../apps/api/src/pattern-room/order-service.js";
import { RootAwareTodoProjectionService } from "../../apps/api/src/todos/root-aware-projection-service.js";
import Fastify from "fastify";
import { registerPatternRoomOrderRoutes } from "../../apps/api/src/pattern-room/order-routes.js";
import { registerExternalResponsibilityRoutes } from "../../apps/api/src/rework/external-responsibility-routes.js";
import { registerToolsRoutes } from "../../apps/api/src/tools/routes.js";
import type { ObjectStorage } from "../../apps/api/src/tools/storage.js";
import type { ExportJobService } from "../../apps/api/src/tools/exports.js";
import { AttachmentService } from "../../apps/api/src/tools/attachments.js";
import { registerTodoRoutes } from "../../apps/api/src/todos/routes.js";
import { readFinanceNode } from "../../apps/api/src/reporting/finance-node-reader.js";
import { FinanceNodeKeySchema } from "@dx-rework/contracts/reporting";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  CreateResponsibilityDraftSchema,
  CreateWorkReportSchema,
  ReviewProcessConfigurationSchema,
  SaveProcessConfigurationSchema,
  SubmitProcessConfigurationSchema,
} from "@dx-rework/contracts";
import {
  ApproveExternalDeductionSpecialApprovalSchema,
  CloseExternalDeductionCaseSchema,
  CreateExternalDeductionEntrySchema,
  RequestExternalDeductionSpecialApprovalSchema,
  ReturnExternalDeductionSpecialApprovalSchema,
} from "@dx-rework/contracts/external-responsibility";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { financial } from "../../apps/api/src/reporting/management-reporting-financial.js";
import { ManagementReportingService } from "../../apps/api/src/reporting/management-reporting-service.js";
import { fetchFacts } from "../../apps/api/src/reporting/management-reporting-orders.js";
import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { BusinessAwareWholeOrderReviewService } from "../../apps/api/src/rework/business-aware-whole-order-review-service.js";
import { ExternalResponsibilityApplicationService } from "../../apps/api/src/rework/external-responsibility-application-service.js";
import { ProcessConfigurationService } from "../../apps/api/src/rework/process-configuration-service.js";
import { ProcessWorkerPlanService } from "../../apps/api/src/rework/process-worker-plan-service.js";
import { ResponsibilityDeterminationApplicationService } from "../../apps/api/src/rework/responsibility-determination-application-service.js";
import { ReworkBusinessDetailService } from "../../apps/api/src/rework/rework-business-detail-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { ReworkSupplyContextService } from "../../apps/api/src/rework/supply-context-service.js";
import { TailInspectionService } from "../../apps/api/src/rework/tail-inspection-service.js";
import { ReworkV2SubmissionService } from "../../apps/api/src/rework/v2-submission-service.js";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { TodoProjectionService } from "../../apps/api/src/todos/projection-service.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
import { WageService } from "../../apps/api/src/wages/wage-service.js";
import { PatternRoomPriceService, PATTERN_HOURLY_PRICE_ID } from "../../apps/api/src/pattern-room/price-service.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

type Manifest = { migrations: Array<{ version: string; checksum: string }> };

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

runWithPostgres("current-schema N01-N11 business chain", () => {
  const schema = ownedPostgresSchema("full_chain");
  const adminPool = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });

  const access = new AccessMasterDataService(database, "corp");
  const todoService = new TodoService(database);
  const todoProjection = new TodoProjectionService(todoService);
  const initiation = new ReworkInitiationService(
    database,
    "corp",
    undefined,
    undefined,
    undefined,
    todoProjection,
  );
  const v2Submission = new ReworkV2SubmissionService(
    database,
    "corp",
    undefined,
    undefined,
    undefined,
    todoProjection,
  );
  const configuration = new ProcessConfigurationService(
    database,
    undefined,
    undefined,
    undefined,
    todoProjection,
  );
  const workerPlan = new ProcessWorkerPlanService(database);
  const work = new WorkReportingService(database, undefined, undefined, todoProjection);
  const legacyTailInspection = new TailInspectionService(
    database,
    undefined,
    undefined,
    todoProjection,
  );
  const wholeOrder = new BusinessAwareWholeOrderReviewService(database, todoProjection);
  const responsibility = new ResponsibilityDeterminationApplicationService(
    database,
    todoProjection,
  );
  const supplyContext = new ReworkSupplyContextService(database, "corp");
  const external = new ExternalResponsibilityApplicationService(database, todoProjection);
  const wages = new WageService(database, undefined, undefined, todoProjection);
  const businessDetail = new ReworkBusinessDetailService(database);

  const ids = {
    receivingWarehouse: randomUUID(),
    secondOrderMerchant: randomUUID(),
    ownerOne: randomUUID(),
    ownerTwo: randomUUID(),
    qc: randomUUID(),
    tail: randomUUID(),
    tailInspector: randomUUID(),
    ie: randomUUID(),
    worker: randomUUID(),
    merchandiser: randomUUID(),
    production: randomUUID(),
    factoryPayables: randomUUID(),
    fabricPayables: randomUUID(),
    financeDirector: randomUUID(),
    financeRead: randomUUID(),
    embroideryMerchandiser: randomUUID(),
    embroideryPayables: randomUUID(),
    administrative: randomUUID(),
    monthClose: randomUUID(),
    technicalAdmin: randomUUID(),
    patternSupervisor: randomUUID(),
    patternDesigner: randomUUID(),
    otherPatternDesigner: randomUUID(),
    otherPatternWorker: randomUUID(),
    patternRoot: randomUUID(),
  };

  let workerPersonId = "";
  let otherPatternPersonId = "";
  let tailPersonId = "";
  let factorySupplierId = "";
  let fabricSupplierId = "";
  let publicProcessId = "";

  const actor = (
    actorId: string,
    actorRoles: readonly string[],
    authorizationCapability: string,
    ...otherCapabilities: string[]
  ): TrustedActorContext => ({
    actorId,
    actorRoles,
    authorizationCapability,
    authorizationCapabilities: Array.from(new Set([
      authorizationCapability,
      ...otherCapabilities,
    ])),
    requestId: randomUUID(),
  });

  const ownerMasterData = () => actor(
    ids.ownerOne,
    ["owner_group"],
    "master_data:manage",
  );
  const qc = () => actor(ids.qc, ["quality_control"], "rework:initiate");
  const tailTodoView = () => actor(ids.tail, ["tail_supervisor"], "todo:view");
  const tailConfigure = () => actor(
    ids.tail,
    ["tail_supervisor"],
    "process:configure",
  );
  const ie = () => actor(ids.ie, ["ie_reviewer"], "process:review");
  const tailAssign = () => actor(
    ids.tail,
    ["tail_supervisor"],
    "work:assign",
    "work:report_for_worker",
  );
  const tailInspect = () => actor(
    ids.tailInspector,
    ["worker"],
    "tail_inspection:report",
  );
  const worker = () => actor(ids.worker, ["worker"], "work:report");
  const tailAudit = () => actor(
    ids.tail,
    ["tail_supervisor"],
    "submission:audit",
    "quantity:adjust",
  );
  const production = () => actor(
    ids.production,
    ["production_management"],
    "responsibility:determine",
  );
  const factoryPayables = (capability: string) => actor(
    ids.factoryPayables,
    ["factory_payables"],
    capability,
  );
  const fabricPayables = (capability: string) => actor(
    ids.fabricPayables,
    ["fabric_payables"],
    capability,
  );
  const financeDirector = () => actor(
    ids.financeDirector,
    ["finance_director"],
    "external_deduction:special_approve",
  );
  const wageView = () => actor(
    ids.financeDirector,
    ["finance_director"],
    "wage:view",
  );
  const monthCloseWage = () => actor(
    ids.monthClose,
    ["wage_month_close_accountant"],
    "wage:view",
    "wage:month_close",
    "wage:export",
  );

  beforeAll(async () => {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
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

    // Role seeding happens before the corporation policy exists. This is the
    // reviewed bootstrap path used by integration fixtures; all later actions
    // use normal production authorization functions from the current schema.
    const users = [
      [ids.receivingWarehouse, "差异权限仓管", "warehouse_receiver"],
      [ids.secondOrderMerchant, "第二订单跟单", "order_merchandiser"],
      [ids.ownerOne, "老板一", "owner_group"],
      [ids.ownerTwo, "老板二", "owner_group"],
      [ids.qc, "品控", "quality_control"],
      [ids.tail, "李同生", "tail_supervisor"],
      [ids.tailInspector, "尾查", "tail_inspector"],
      [ids.ie, "IE", "ie_reviewer"],
      [ids.worker, "工人", "worker"],
      [ids.merchandiser, "订单跟单", "order_merchandiser"],
      [ids.production, "生产管理", "production_management"],
      [ids.factoryPayables, "加工厂应付", "factory_payables"],
      [ids.fabricPayables, "面料应付", "fabric_payables"],
      [ids.financeDirector, "财务总监", "finance_director"],
      [ids.financeRead, "财务全局查看", "finance_read"],
      [ids.embroideryMerchandiser, "印绣花跟单", "embroidery_washing_merchandiser"],
      [ids.embroideryPayables, "印绣花应付", "embroidery_washing_payables"],
      [ids.administrative, "行政文员", "administrative_clerk"],
      [ids.monthClose, "工资月结", "wage_month_close_accountant"],
      [ids.technicalAdmin, "技术管理员", "system_admin"],
      [ids.patternSupervisor, "板房主管", "pattern_room_supervisor"],
      [ids.patternDesigner, "设计师", "sample_designer"],
      [ids.otherPatternDesigner, "另一设计师", "sample_designer"],
      [ids.otherPatternWorker, "另一板房师傅", "pattern_room_worker"],
    ] as const;
    for (const [userId, displayName, roleCode] of users) {
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
         ) VALUES($1,$2,$3,$2,'full-chain fixture')`,
        [randomUUID(), userId, roleCode],
      );
    }
    await database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,'pattern_room_worker',$2,'explicit dual-role fixture')", [randomUUID(), ids.worker]);
    // The same bootstrap fixture path must still obey the one-supervisor database constraint.
    await expect(database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,'pattern_room_supervisor',$2,'duplicate supervisor fixture')",[randomUUID(),ids.patternDesigner])).rejects.toMatchObject({code:"23505"});
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'Root验收',true)", [ids.patternRoot]);
    await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','corp',$3,$3,true,true,CURRENT_TIMESTAMP)", [randomUUID(), ids.patternRoot, `ding-${ids.patternRoot}`]);
    await database.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,$2,'corp')", [ids.patternRoot, `ding-${ids.patternRoot}`]);
    await access.ensureOrganizationPolicy();

    workerPersonId = (await access.createPerson(ownerMasterData(), {
      personType: "internal",
      appUserId: ids.worker,
      displayName: "工人",
      aliases: [],
      reason: "全链验收工人档案",
    })).personId;
    otherPatternPersonId = (await access.createPerson(ownerMasterData(), { personType: "internal", appUserId: ids.otherPatternWorker, displayName: "另一板房工人", aliases: [], reason: "隔离验收换人" })).personId;
    tailPersonId = (await access.createPerson(ownerMasterData(), {
      personType: "internal",
      appUserId: ids.tailInspector,
      displayName: "尾查",
      aliases: [],
      reason: "全链验收尾查档案",
    })).personId;
    factorySupplierId = (await access.createSupplier(ownerMasterData(), {
      supplierCode: "UATFAC01",
      supplierType: "factory",
      supplierName: "全链测试加工厂",
      active: true,
      changeReason: "全链验收加工厂",
    })).supplierId;
    fabricSupplierId = (await access.createSupplier(ownerMasterData(), {
      supplierCode: "UATFAB01",
      supplierType: "fabric",
      supplierName: "全链测试面料商",
      active: true,
      changeReason: "全链验收面料商",
    })).supplierId;
    publicProcessId = (await access.createProcess(ownerMasterData(), {
      processCode: "UATPROC01",
      processName: "袖口返修",
      pricingUnit: "piece",
      active: true,
      changeReason: "全链验收公共工序",
    })).processId;
  });

  afterAll(async () => {
    if (process.env.PATTERN_ROOM_EVIDENCE === "1") {
      const fixtures = await database.query("SELECT order_id,order_no,kind,style_no,task_name,status FROM pattern_room_orders ORDER BY submitted_at,order_id");
      process.stdout.write(`PATTERN_ROOM_FIXTURES ${JSON.stringify({schema,orders:fixtures.rows})}\n`);
    }
    await database.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    if (process.env.PATTERN_ROOM_EVIDENCE === "1") process.stdout.write(`PATTERN_ROOM_CLEANUP ${JSON.stringify({schema,dropped:true})}\n`);
    await adminPool.end();
  });

  it("separates all merchandisers' discrepancy handling from warehouse facts and Root-only corrections", async () => {
    await exerciseReceivingDifferenceAuthority({database,rootId:ids.patternRoot,warehouseId:ids.receivingWarehouse,
      merchants:[ids.merchandiser,ids.secondOrderMerchant],deniedIds:[ids.tail,ids.financeRead,ids.embroideryMerchandiser,ids.worker]});
  });

  it("aligns persisted finance business reads without copying writes or exports", async () => {
    const readCaps=['rework:finance_nodes:read','sourcing:view','supplier_profile:read','supplier_contract_data:read','sample:view_basic','sample:view_finance','sample:view_audit','pattern_room:prices:read','pattern_room:catalog:read','pattern_room:misc:quote'];
    const rows=(await database.query<{capability:string}>("SELECT capability FROM role_capabilities WHERE role_code='finance_read'")).rows.map(row=>row.capability);
    expect(rows).toEqual(expect.arrayContaining(readCaps));
    for(const cap of ['external_deduction:special_approve','supplier_profile:write','sample:create','sample:dispose_approve','pattern_room:prices:write','process:configure','responsibility:owner_sign','report:export','receiving:export']) expect(rows).not.toContain(cap);
    expect(rows).toContain('wage:settlement_mark');expect(rows).toContain('wage:export');
    for(const cap of ['pattern_room:prices:read','pattern_room:catalog:read','pattern_room:misc:quote']) expect((await database.query('SELECT pattern_room_authorized_price_roles($1,$2)',[ids.financeRead,cap])).rowCount).toBe(1);
    await expect(database.query("SELECT pattern_room_authorized_price_roles($1,'pattern_room:prices:write')",[ids.financeRead])).rejects.toThrow();
    // Simultaneous roles retain lawful director authority; a read-only label never grants it.
    expect((await database.query("SELECT external_responsibility_direct_role($1,'external_deduction:special_approve',ARRAY['finance_director']) allowed",[ids.financeRead])).rows[0].allowed).toBe(false);
    expect((await database.query("SELECT external_responsibility_direct_role($1,'external_deduction:special_approve',ARRAY['finance_director']) allowed",[ids.financeDirector])).rows[0].allowed).toBe(true);
  });

  it("keeps pattern room standard prices exact, authorized, versioned and repeatably initialized", async () => {
    const prices = new PatternRoomPriceService(database);
    const manager = actor(ids.ownerOne,["owner_group"],"pattern_room:prices:read","pattern_room:prices:write","pattern_room:hourly:write","pattern_room:catalog:read");
    const supervisor = actor(ids.patternSupervisor,["pattern_room_supervisor"],"pattern_room:prices:read","pattern_room:prices:write","pattern_room:hourly:write");
    const designer = actor(ids.patternDesigner,["sample_designer"],"pattern_room:catalog:read","pattern_room:prices:read","pattern_room:prices:write","pattern_room:misc:quote");
    const productionPrice = actor(ids.production,["production_management"],"pattern_room:prices:read","pattern_room:prices:write","pattern_room:hourly:write");
    const initial = await prices.management(manager);
    expect(initial.categories.map(item => item.amount)).toEqual(["15.000","40.000","40.000","40.000","40.000","40.000","40.000","80.000","60.000","60.000","80.000","100.000","60.000","80.000","100.000","100.000","80.000","80.000","100.000"]);
    expect(initial.categories.filter(item => item.unit === "套").map(item => item.name)).toEqual(["女装套装两件套","男装套装两件套"]);
    expect(initial.hourly.amount).toBeNull();
    expect((await prices.quote(designer,"hourly",PATTERN_HOURLY_PRICE_ID)).amount).toBeNull();
    const miscBeforeConfiguration = new PatternRoomOrderService(database, todoProjection, { ordersEnabled: true });
    const miscCreator = actor(ids.merchandiser, ["order_merchandiser"], "pattern_room:misc:create", ...Object.keys(PATTERN_ORDER_ROLES));
    await expect(miscBeforeConfiguration.createMisc(miscCreator, { taskName: "时薪未配置", priceVersion: 1 }, randomUUID())).rejects.toMatchObject({ statusCode: 409, code: "PRICE_NOT_CONFIGURED" });
    expect((await database.query("SELECT count(*)::int count FROM pattern_room_orders WHERE task_name='时薪未配置'")).rows[0].count).toBe(0);
    const category = initial.categories[0]!;
    const input = {version:1,amount:"18.125",enabled:true,reason:"现场确认执行价"};
    for (const kind of ["category","hourly"] as const) await expect(prices.change(supervisor,kind,category.priceId,input,randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(prices.change(productionPrice,"hourly",PATTERN_HOURLY_PRICE_ID,input,randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(prices.history(designer,category.priceId)).rejects.toMatchObject({statusCode:403});
    await expect(prices.management(designer)).rejects.toMatchObject({statusCode:403});
    await expect(database.query("SELECT pattern_room_authorized_price_roles($1,'pattern_room:hourly:write')",[ids.production])).rejects.toThrow();
    await expect(database.query("SELECT pattern_room_authorized_price_roles($1,'pattern_room:prices:write')",[ids.patternSupervisor])).rejects.toThrow();
    await expect(prices.change(productionPrice,"category",PATTERN_HOURLY_PRICE_ID,input,randomUUID())).rejects.toMatchObject({statusCode:404});
    expect((await prices.management(manager)).hourly.amount).toBeNull();
    const options = await prices.options(designer);
    expect(options).toHaveLength(19);
    expect(options.every(item => !Object.hasOwn(item,"amount") && !Object.hasOwn(item,"updatedBy"))).toBe(true);
    expect((await prices.management(supervisor)).canWriteCategories).toBe(false);
    const key = randomUUID();
    const changed = await prices.change(productionPrice,"category",category.priceId,input,key);
    expect(changed).toMatchObject({amount:"18.125",version:2});
    expect(await prices.change(productionPrice,"category",category.priceId,input,key)).toEqual(changed);
    await expect(prices.change(productionPrice,"category",category.priceId,{...input,amount:"20.000"},randomUUID())).rejects.toMatchObject({statusCode:409});
    await prices.change(manager,"hourly",PATTERN_HOURLY_PRICE_ID,{...input,amount:"28.500"},randomUUID());
    const migration = await readFile(new URL("../../apps/api/migrations/0175_pattern_room_prices.sql",import.meta.url),"utf8");
    await database.query(migration.split("-- BEGIN REPEATABLE PRICE SEED")[1]!.split("-- END REPEATABLE PRICE SEED")[0]!.replace(/^:[^\n]*\n/,""));
    expect((await prices.management(manager)).categories[0]).toMatchObject({amount:"18.125",version:2});
    expect((await prices.management(manager)).hourly).toMatchObject({amount:"28.500",version:2});
    const history = await prices.history(manager,category.priceId);
    expect(history.map(row => row.amount)).toEqual(["18.125","15.000"]);
    expect(history[0]).toMatchObject({oldAmount:"15.000",reason:input.reason,changedBy:"生产管理"});
    const disabled = await prices.change(manager,"category",category.priceId,{...input,version:2,enabled:false},randomUUID());
    expect(disabled.version).toBe(3);
    expect(await prices.options(designer)).toHaveLength(18);
    await expect(prices.quote(designer,"category",category.priceId)).rejects.toMatchObject({statusCode:404});
    expect(await prices.history(manager,category.priceId)).toHaveLength(3);
    await expect(database.query("DELETE FROM pattern_room_prices WHERE price_id=$1",[category.priceId])).rejects.toThrow();
    await expect(database.query("UPDATE pattern_room_price_history SET amount=1 WHERE price_id=$1",[category.priceId])).rejects.toThrow();
  });

  it("carries first pattern through scoped assignment, preserved materials and exactly one designer handoff", async () => {
    const service = new PatternRoomOrderService(database, todoProjection, { ordersEnabled: true });
    const caps = [...Object.keys(PATTERN_ORDER_ROLES), "todo:view"];
    const designer = actor(ids.patternDesigner, ["sample_designer"], "pattern_room:orders:view", ...caps);
    const otherDesigner = actor(ids.otherPatternDesigner, ["sample_designer"], "pattern_room:orders:view", ...caps);
    const supervisor = actor(ids.patternSupervisor, ["pattern_room_supervisor"], "pattern_room:orders:view", ...caps);
    const worker = actor(ids.worker, ["pattern_room_worker"], "pattern_room:orders:view", ...caps);
    const otherWorker = actor(ids.otherPatternWorker, ["pattern_room_worker"], "pattern_room:orders:view", ...caps);
    const owner = actor(ids.ownerOne, ["owner_group"], "pattern_room:orders:view", ...caps);
    const admin = actor(ids.technicalAdmin, ["system_admin"], "pattern_room:orders:view", ...caps);
    const files = [randomUUID(), randomUUID(), randomUUID()];
    for (const file of files) await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
      VALUES($1,$2,'制作原稿.pdf','application/pdf',10,$3,$4,'ready',CURRENT_TIMESTAMP)`, [file, `private/${file}.pdf`, "a".repeat(64), ids.patternDesigner]);
    const input = { styleNo: "PATTERN-本次款号", referenceStyleNo: "OLD-参考款号", categoryId: "92000000-0000-4000-8000-000000000002", quantity: 2, priceVersion: 1, attachmentIds: [files[0]], requiredDate: "2026-09-30" };
    await expect(new PatternRoomOrderService(database, todoProjection, { ordersEnabled: false }).create(designer, input, randomUUID())).rejects.toMatchObject({ statusCode: 503 });
    await expect(service.create(supervisor, input, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.create(designer, { ...input, attachmentIds: [] }, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.create(designer, { ...input, priceVersion: 99 }, randomUUID())).rejects.toMatchObject({ statusCode: 409, code: "PRICE_CHANGED" });
    const key = randomUUID(), created = await service.create(designer, input, key);
    expect(created).toMatchObject({ styleNo: input.styleNo, referenceStyleNo: input.referenceStyleNo, status: "pending_assignment", requiredDate: "2026-09-30", reworkCount: 0 });
    await exerciseFinancePatternQueries({database,service,orderId:created.orderId,attachmentId:files[0]!,readers:[[ids.financeDirector,"finance_director"],[ids.financeRead,"finance_read"],[ids.monthClose,"wage_month_close_accountant"]]});
    expect(created.rounds[0]).toMatchObject({ index: 0, unitPrice: "40.000", quantity: 2, agreedAmount: "80.00000000" });
    expect((await service.create(designer, input, key)).orderId).toBe(created.orderId);
    await expect(service.create(designer, { ...input, styleNo: "重复键不同内容" }, key)).rejects.toMatchObject({ statusCode: 409 });
    const listing = { page: 1, limit: 25, q: "PATTERN-本次" };
    expect((await service.list(otherDesigner, listing)).totalCount).toBe(0);
    expect((await service.list(otherWorker, listing)).totalCount).toBe(0);
    await expect(service.get(otherDesigner, created.orderId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.get(worker, created.orderId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.get(admin, created.orderId)).rejects.toMatchObject({ statusCode: 403 });
    expect((await service.list(owner, listing)).totalCount).toBe(1);
    // Reproduce pg DATE parsing in non-UTC processes even when CI itself runs in UTC.
    for (const offset of ["+08:00", "-07:00"]) {
      const calendarPool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`,
        types: { getTypeParser: (oid, format) => oid === 1082 ? (value: string) => new Date(`${value}T00:00:00${offset}`) : pg.types.getTypeParser(oid, format) },
      });
      try {
        const parsed = await calendarPool.query<{ calendar_date: Date }>("SELECT DATE '2026-09-30' AS calendar_date");
        expect(parsed.rows[0]!.calendar_date.toISOString()).toBe(new Date(`2026-09-30T00:00:00${offset}`).toISOString());
        const calendarService = new PatternRoomOrderService(calendarPool, todoProjection, { ordersEnabled: true });
        expect((await calendarService.get(designer, created.orderId)).requiredDate).toBe(input.requiredDate);
        expect((await calendarService.list(owner, listing)).items[0]?.requiredDate).toBe(input.requiredDate);
      } finally { await calendarPool.end(); }
    }
    const pending = await todoService.listForActor({ ...supervisor, authorizationCapability: "todo:view" }, { module: "pattern_room", query: "PATTERN-本次" });
    expect(pending.todos).toHaveLength(1);
    expect(pending.todos[0]).toMatchObject({ category: "pattern_room_assignment", route: { routeName: "pattern_room_order", entityId: created.orderId, roundId: created.currentRoundId }, orderContext: { styleNo: input.styleNo } });
    expect((await service.workers(supervisor, "工人")).some(person => person.personId === workerPersonId)).toBe(true);
    const firstAction = { version: created.version, roundId: created.currentRoundId, personId: workerPersonId };
    await expect(service.assign(owner, created.orderId, firstAction, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.assign(supervisor, created.orderId, { ...firstAction, roundId: randomUUID() }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    const assignKey = randomUUID(), assigned = await service.assign(supervisor, created.orderId, firstAction, assignKey);
    expect((await service.assign(supervisor, created.orderId, firstAction, assignKey)).version).toBe(assigned.version);
    expect(assigned.status).toBe("in_progress");
    const workerView = await service.get(worker, created.orderId);
    expect(workerView.rounds[0]).not.toHaveProperty("agreedAmount");
    expect(workerView.rounds[0]).not.toHaveProperty("unitPrice");
    expect(workerView.rounds[0]!.segments).toHaveLength(1);
    expect(workerView.rounds[0]!.segments[0]).toMatchObject({ workerUserId: ids.worker, amount: "80.00000000", wageEligible: false });
    const app = Fastify();
    registerPatternRoomOrderRoutes(app, { service, attachments: {} as AttachmentService, authenticate: async token => {
      const current = token === "other" ? otherDesigner : worker;
      return { id: current.actorId, businessRoles: current.actorRoles, capabilities: caps };
    } });
    registerTodoRoutes(app, { service: todoService, authenticate: async () => ({ id: ids.worker, businessRoles: ["worker"], capabilities: caps }) });
    try {
      const allowed = await app.inject({ url: `/pattern-room/orders/${created.orderId}`, headers: { cookie: "dx_rework_session=worker" } });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().rounds[0]).not.toHaveProperty("agreedAmount");
      const todoResponse = await app.inject({ url: "/todos/mine?module=pattern_room&q=PATTERN", headers: { cookie: "dx_rework_session=worker" } });
      expect(todoResponse.statusCode).toBe(200);
      expect(todoResponse.json().todos).toHaveLength(1);
      expect(todoResponse.json().todos[0]).toMatchObject({ category: "pattern_room_execution", route: { entityId: created.orderId, roundId: assigned.currentRoundId } });
      expect((await app.inject({ url: `/pattern-room/orders/${created.orderId}`, headers: { cookie: "dx_rework_session=other" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: `/pattern-room/orders/${created.orderId}/handoff`, payload: { version: assigned.version, roundId: assigned.currentRoundId }, headers: { cookie: "dx_rework_session=worker", "idempotency-key": randomUUID() } })).statusCode).toBe(403);
      expect((await app.inject({ url: "/pattern-room/orders?workerId=invalid" })).statusCode).toBe(400);
    } finally { await app.close(); }
    expect(await service.canDownload(otherWorker, { entityType: "pattern_room_attachment", entityId: files[0]! })).toBe(false);
    expect(await service.canDownload(worker, { entityType: "pattern_room_attachment", entityId: files[0]! })).toBe(true);
    const revisionInput = { ...input, version: assigned.version, roundId: assigned.currentRoundId, attachmentIds: [files[1]], reason: "袖口工艺补充" };
    const materials = { styleNo: revisionInput.styleNo, referenceStyleNo: revisionInput.referenceStyleNo, requiredDate: revisionInput.requiredDate, version: revisionInput.version, roundId: revisionInput.roundId, attachmentIds: revisionInput.attachmentIds, reason: revisionInput.reason };
    const revised = await service.updateMaterials(designer, created.orderId, materials, randomUUID());
    expect(revised.requiredDate).toBe(input.requiredDate);
    expect(revised.attachments).toHaveLength(2);
    expect(revised.attachments.find(file => file.attachmentId === files[0])?.active).toBe(false);
    expect(await service.canDownload(worker, { entityType: "pattern_room_attachment", entityId: files[0]! })).toBe(true);
    expect((await todoService.listForActor({ ...worker, authorizationCapability: "todo:view" }, { module: "pattern_room" })).todos.filter(todo => todo.entityId === created.orderId)).toHaveLength(1);
    expect((await database.query("SELECT count(*)::int count FROM rework_todos WHERE entity_id=$1 AND todo_type='information' AND category='pattern_room_material_notice'", [created.orderId])).rows[0].count).toBe(2);
    await expect(service.complete(worker, created.orderId, { version: assigned.version, roundId: assigned.currentRoundId }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.complete(otherWorker, created.orderId, { version: revised.version, roundId: revised.currentRoundId }, randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    // A forged Root marker is replaced by actual persisted roles before scope checks.
    await expect(service.complete({ ...otherWorker, actorRoles: ["root_superuser", "worker"] }, created.orderId, { version: revised.version, roundId: revised.currentRoundId }, randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    const completeKey = randomUUID(), completeInput = { version: revised.version, roundId: revised.currentRoundId };
    const completed = await service.complete(worker, created.orderId, completeInput, completeKey);
    expect((await service.complete(worker, created.orderId, completeInput, completeKey)).version).toBe(completed.version);
    expect(completed.status).toBe("pending_confirmation");
    expect(completed.rounds[0]!.segments[0]!.wageEligible).toBe(false);
    expect((await todoService.listForActor({ ...supervisor, authorizationCapability: "todo:view" }, { module: "pattern_room" })).todos.filter(todo => todo.entityId === created.orderId)).toHaveLength(0);
    expect((await todoService.listForActor({ ...designer, authorizationCapability: "todo:view" }, { module: "pattern_room" })).todos.filter(todo => todo.entityId === created.orderId).map(todo => todo.category)).toEqual(["pattern_room_handoff"]);
    await expect(service.updateMaterials(designer, created.orderId, { ...materials, version: completed.version }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    const handoffInput = { version: completed.version, roundId: completed.currentRoundId };
    await expect(service.handoff(otherDesigner, created.orderId, handoffInput, randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.handoff(supervisor, created.orderId, handoffInput, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    const handoffKey = randomUUID(), handed = await service.handoff(designer, created.orderId, handoffInput, handoffKey);
    expect((await service.handoff(designer, created.orderId, handoffInput, handoffKey)).version).toBe(handed.version);
    expect(handed.status).toBe("completed");
    expect(handed.rounds[0]!.segments[0]!.wageEligible).toBe(true);
    expect(handed.rounds[0]!.completedAt).toBe(completed.rounds[0]!.completedAt);
    expect(handed.rounds[0]!.nodes.map(node => node.stage)).toEqual(["pending_assignment", "in_progress", "pending_confirmation"]);
    expect(handed.rounds[0]!.nodes.every(node => node.exitedAt && node.elapsedSeconds >= 0)).toBe(true);
    expect((await database.query("SELECT count(*)::int count FROM pattern_room_segments WHERE round_id=$1 AND wage_eligible_at IS NOT NULL", [handed.currentRoundId])).rows[0].count).toBe(1);
    expect((await database.query("SELECT status FROM rework_todos WHERE dedupe_key=$1", [patternTodoKey(created.orderId, created.currentRoundId, "handoff")])).rows[0].status).toBe("completed");
    await expect(service.handoff(designer, created.orderId, handoffInput, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.create(otherDesigner, { ...input, attachmentIds: [files[2]] }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.create(designer, input, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    await expect(database.query("DELETE FROM pattern_room_orders WHERE order_id=$1", [created.orderId])).rejects.toThrow();
  });

  it("keeps Root first-pattern acceptance available with ordinary access closed and no normal roles", async () => {
    const service = new PatternRoomOrderService(database, new RootAwareTodoProjectionService(todoService), { ordersEnabled: false });
    const root = actor(ids.patternRoot, ["root_superuser"], "pattern_room:orders:view");
    const personId = (await access.createPerson({ ...root, authorizationCapability: "master_data:manage" }, { personType: "internal", appUserId: ids.patternRoot, displayName: "Root验收", aliases: [], reason: "Root单账号验收" })).personId;
    const fileId = randomUUID();
    await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'Root.pdf','application/pdf',10,$3,$4,'ready',CURRENT_TIMESTAMP)", [fileId, `private/${fileId}.pdf`, "b".repeat(64), ids.patternRoot]);
    const created = await service.create(root, { styleNo: "ROOT-PATTERN", categoryId: "92000000-0000-4000-8000-000000000002", quantity: 1, priceVersion: 1, attachmentIds: [fileId] }, randomUUID());
    expect((await service.workers(root, "Root")).some(person => person.personId === personId)).toBe(true);
    const assigned = await service.assign(root, created.orderId, { version: created.version, roundId: created.currentRoundId, personId }, randomUUID());
    const revised = await service.updateMaterials(root, created.orderId, { version: assigned.version, roundId: assigned.currentRoundId, styleNo: created.styleNo, attachmentIds: [fileId], reason: "Root验收资料修正" }, randomUUID());
    const completed = await service.complete(root, created.orderId, { version: revised.version, roundId: revised.currentRoundId }, randomUUID());
    const handed = await service.handoff(root, created.orderId, { version: completed.version, roundId: completed.currentRoundId }, randomUUID());
    expect(handed.status).toBe("completed");
    expect(handed.rounds[0]!.segments[0]!.wageEligible).toBe(true);
    expect((await database.query("SELECT count(*)::int count FROM user_role_assignments WHERE user_id=$1", [ids.patternRoot])).rows[0].count).toBe(0);
    // A real supervisor exists in this fixture; prerelease Root work must not create staff todos or notices.
    expect((await database.query("SELECT count(*)::int count FROM rework_todos WHERE entity_type='pattern_room_order' AND entity_id=$1", [created.orderId])).rows[0].count).toBe(0);
    expect((await database.query("SELECT supervisor_user_id FROM pattern_room_rounds WHERE round_id=$1", [created.currentRoundId])).rows[0].supervisor_user_id).toBe(ids.patternRoot);
    const action = (order: { version: number; currentRoundId: string }) => ({ version: order.version, roundId: order.currentRoundId });
    const rework = await service.requestRework(root, created.orderId, { ...action(handed), reason: "Root返工验收", reasonCategory: "other" }, randomUUID());
    const reworkAssigned = await service.assign(root, created.orderId, { ...action(rework), personId, amount: "10" }, randomUUID());
    const transferred = await service.transfer(root, created.orderId, { ...action(reworkAssigned), segmentId: reworkAssigned.rounds.at(-1)!.segments[0]!.segmentId, personId: workerPersonId, amount: "2", reason: "Root换人验收" }, randomUUID());
    const stopped = await service.cancel(root, created.orderId, { ...action(transferred), segmentId: transferred.rounds.at(-1)!.segments.at(-1)!.segmentId, amount: "3", reason: "Root取消验收" }, randomUUID());
    expect((await service.confirmCancelledFees(root, created.orderId, action(stopped), randomUUID())).status).toBe("cancelled");
    expect((await database.query("SELECT count(*)::int count FROM rework_todos WHERE entity_id=$1", [created.orderId])).rows[0].count).toBe(0);
    expect((await database.query("SELECT count(*)::int count FROM user_role_assignments WHERE user_id=$1", [ids.patternRoot])).rows[0].count).toBe(0);
  });

  it("qualifies misc work once from completed labor and exact stored hourly pricing, independently of creator closure", async () => {
    const service = new PatternRoomOrderService(database, todoProjection, { ordersEnabled: true });
    const caps = [...Object.keys(PATTERN_ORDER_ROLES), "todo:view"];
    const merchant = actor(ids.merchandiser, ["order_merchandiser"], "pattern_room:orders:view", ...caps);
    const designer = actor(ids.patternDesigner, ["sample_designer"], "pattern_room:orders:view", ...caps);
    const other = actor(ids.otherPatternDesigner, ["sample_designer"], "pattern_room:orders:view", ...caps);
    const supervisor = actor(ids.patternSupervisor, ["pattern_room_supervisor"], "pattern_room:orders:view", ...caps);
    const worker = actor(ids.worker, ["pattern_room_worker"], "pattern_room:orders:view", ...caps);
    const owner = actor(ids.ownerOne, ["owner_group"], "pattern_room:prices:read", "pattern_room:hourly:write");
    const prices = new PatternRoomPriceService(database);
    const before = (await prices.management(owner)).hourly;
    const hourly = await prices.change(owner, "hourly", PATTERN_HOURLY_PRICE_ID, { version: before.version, amount: "28.555", enabled: true, reason: "隔离测试精确时薪" }, randomUUID());
    const roundAction = (order: { version: number; currentRoundId: string }) => ({ version: order.version, roundId: order.currentRoundId });
    const headers = (token: string) => ({ cookie: `dx_rework_session=${token}`, "idempotency-key": randomUUID() });
    const app = Fastify();
    registerPatternRoomOrderRoutes(app, { service, attachments: {} as AttachmentService, authenticate: async token => {
      const current = token === "supervisor" ? supervisor : token === "worker" ? worker : token === "other" ? other : merchant;
      return { id: current.actorId, businessRoles: current.actorRoles, capabilities: caps };
    } });
    try {
      const input = { taskName: "MISC-先完成后工时", priceVersion: hourly.version };
      const response = await app.inject({ method: "POST", url: "/pattern-room/misc-orders", payload: input, headers: headers("merchant") });
      expect(response.statusCode).toBe(201);
      const created = response.json();
      expect(created).toMatchObject({ kind: "misc", taskName: input.taskName, styleNo: "", attachments: [], status: "pending_assignment" });
      expect(created.rounds[0]).toMatchObject({ unit: "小时", unitPrice: "28.555", quantity: null, actualHours: null, agreedAmount: null });
      expect((await service.list(merchant, { page: 1, limit: 1, kind: "misc", q: "MISC-" })).totalCount).toBe(1);
      expect((await service.list(merchant, { page: 1, limit: 25, kind: "pattern" })).totalCount).toBe(0);
      await expect(service.get(other, created.orderId)).rejects.toMatchObject({ statusCode: 404 });
      const deniedPattern = await app.inject({ method: "POST", url: "/pattern-room/orders", payload: { styleNo: "无权打板", categoryId: "92000000-0000-4000-8000-000000000002", priceVersion: 1, attachmentIds: [randomUUID()] }, headers: headers("merchant") });
      expect(deniedPattern.statusCode).toBe(403);
      const revised = await service.updateMiscMaterials(merchant, created.orderId, { ...roundAction(created), taskName: input.taskName, styleNo: "可选关联款号", reason: "补充关联资料" }, randomUUID());
      const assigned = await service.assign(supervisor, created.orderId, { ...roundAction(revised), personId: workerPersonId }, randomUUID());
      await expect(service.recordHours(merchant, created.orderId, { ...roundAction(assigned), hours: "1.2" }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
      await prices.change(owner, "hourly", PATTERN_HOURLY_PRICE_ID, { version: hourly.version, amount: "99.000", enabled: true, reason: "隔离测试旧单不重算" }, randomUUID());
      const completed = await service.complete(worker, created.orderId, roundAction(assigned), randomUUID());
      expect(completed.rounds[0]!.segments[0]!.wageEligible).toBe(false);
      const creatorTasks = (await todoService.listForActor({ ...merchant, authorizationCapability: "todo:view" }, { module: "pattern_room", query: input.taskName })).todos;
      expect(creatorTasks).toHaveLength(1);
      expect(creatorTasks[0]).toMatchObject({ category: "pattern_room_misc_confirmation", entityId: created.orderId });
      const confirmation = await app.inject({ method: "POST", url: `/pattern-room/orders/${created.orderId}/confirm`, payload: roundAction(completed), headers: headers("merchant") });
      expect(confirmation.statusCode).toBe(200);
      const closed = confirmation.json();
      expect(closed.status).toBe("completed");
      expect(closed.rounds[0].segments[0].wageEligible).toBe(false);
      const missingHours = (await todoService.listForActor({ ...supervisor, authorizationCapability: "todo:view" }, { module: "pattern_room", query: input.taskName })).todos;
      expect(missingHours.map(todo => todo.category)).toEqual(["pattern_room_hours"]);
      expect((await service.get(supervisor, created.orderId)).actions.hours).toBe(true);
      const invalid = await app.inject({ method: "POST", url: `/pattern-room/orders/${created.orderId}/hours`, payload: { ...roundAction(closed), hours: "1.25" }, headers: headers("supervisor") });
      expect(invalid.statusCode).toBe(400);
      const hoursHeaders = headers("supervisor"), hoursInput = { ...roundAction(closed), hours: "0.1" };
      const filled = await app.inject({ method: "POST", url: `/pattern-room/orders/${created.orderId}/hours`, payload: hoursInput, headers: hoursHeaders });
      expect(filled.statusCode).toBe(200);
      const qualified = filled.json();
      expect(qualified.rounds[0]).toMatchObject({ unitPrice: "28.555", actualHours: "0.1", agreedAmount: "2.85550000" });
      expect(qualified.rounds[0].segments[0]).toMatchObject({ actualHours: "0.1", amount: "2.85550000", wageEligible: true });
      expect((await app.inject({ method: "POST", url: `/pattern-room/orders/${created.orderId}/hours`, payload: hoursInput, headers: hoursHeaders })).json().version).toBe(qualified.version);
      await expect(service.recordHours(supervisor, created.orderId, { ...roundAction(qualified), hours: "0.2" }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
      expect((await todoService.listForActor({ ...supervisor, authorizationCapability: "todo:view" }, { module: "pattern_room", query: input.taskName })).todos).toHaveLength(0);
      expect((await database.query("SELECT count(*)::int count FROM operation_events WHERE entity_id=$1 AND action='pattern_room.misc.hours_recorded'", [created.orderId])).rows[0].count).toBe(1);
      const workerView = await service.get(worker, created.orderId);
      expect(workerView.rounds[0]).not.toHaveProperty("unitPrice");
      expect(workerView.rounds[0]).not.toHaveProperty("actualHours");
      expect(workerView.rounds[0]!.segments[0]!.actualHours).toBe("0.1");
      await expect(database.query("UPDATE pattern_room_segments SET actual_hours=1.25 WHERE segment_id=$1", [qualified.rounds[0].segments[0].segmentId])).rejects.toMatchObject({ code: "55000" });
      // The other legal ordering: hours are known before the worker completes.
      const currentPrice = (await prices.management(owner)).hourly;
      const second = await service.createMisc(designer, { taskName: "MISC-先工时后完成", priceVersion: currentPrice.version }, randomUUID());
      const secondAssigned = await service.assign(supervisor, second.orderId, { ...roundAction(second), personId: workerPersonId }, randomUUID());
      const secondHours = await service.recordHours(supervisor, second.orderId, { ...roundAction(secondAssigned), hours: "1.2" }, randomUUID());
      expect(secondHours.rounds[0]!.segments[0]!.wageEligible).toBe(false);
      await expect(service.complete(worker, second.orderId, roundAction(secondAssigned), randomUUID())).rejects.toMatchObject({ statusCode: 409 });
      const completeKey = randomUUID(), secondComplete = await service.complete(worker, second.orderId, roundAction(secondHours), completeKey);
      expect(secondComplete.rounds[0]!.segments[0]).toMatchObject({ amount: "118.80000000", wageEligible: true });
      expect((await service.complete(worker, second.orderId, roundAction(secondHours), completeKey)).version).toBe(secondComplete.version);
      await expect(service.handoff(designer, second.orderId, roundAction(secondComplete), randomUUID())).rejects.toMatchObject({ statusCode: 409 });
      expect((await todoService.listForActor({ ...supervisor, authorizationCapability: "todo:view" }, { module: "pattern_room", query: second.taskName! })).todos).toHaveLength(0);
      const confirmKey = randomUUID(), secondClosed = await service.confirmMisc(designer, second.orderId, roundAction(secondComplete), confirmKey);
      expect((await service.confirmMisc(designer, second.orderId, roundAction(secondComplete), confirmKey)).version).toBe(secondClosed.version);
      expect((await database.query("SELECT count(*)::int count FROM pattern_room_segments WHERE round_id=$1 AND wage_eligible_at IS NOT NULL", [second.currentRoundId])).rows[0].count).toBe(1);
    } finally { await app.close(); }
  });

  it("routes misc confirmation to the creator's current approved role after either legal role switch", async () => {
    const service = new PatternRoomOrderService(database, todoProjection, { ordersEnabled: true });
    const caps = [...Object.keys(PATTERN_ORDER_ROLES), "todo:view"];
    const rootAdmin = () => actor(ids.patternRoot, ["root_superuser"], "access:admin");
    const root = actor(ids.patternRoot, ["root_superuser"], "pattern_room:prices:read");
    const price = (await new PatternRoomPriceService(database).management(root)).hourly;
    const supervisor = actor(ids.patternSupervisor, ["pattern_room_supervisor"], "pattern_room:orders:view", ...caps);
    const worker = actor(ids.worker, ["pattern_room_worker"], "pattern_room:orders:view", ...caps);
    const action = (order: { version: number; currentRoundId: string }) => ({ version: order.version, roundId: order.currentRoundId });
    const merchantRole = await access.assignRole(rootAdmin(), { userId: ids.otherPatternDesigner, roleCode: "order_merchandiser", reason: "隔离验收双职责" });
    const designerRole = (await database.query("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='sample_designer' AND revoked_at IS NULL", [ids.otherPatternDesigner])).rows[0].assignment_id;
    for (const nextRole of ["order_merchandiser", "sample_designer"] as const) {
      const oldRoles = nextRole === "order_merchandiser" ? ["sample_designer", "order_merchandiser"] : ["order_merchandiser"];
      const creator = actor(ids.otherPatternDesigner, oldRoles, "pattern_room:orders:view", ...caps);
      const created = await service.createMisc(creator, { taskName: `MISC-职责切换-${nextRole}`, priceVersion: price.version }, randomUUID());
      expect((await database.query("SELECT creator_role FROM pattern_room_orders WHERE order_id=$1", [created.orderId])).rows[0].creator_role).toBe(oldRoles[0]);
      const assigned = await service.assign(supervisor, created.orderId, { ...action(created), personId: workerPersonId }, randomUUID());
      const hours = await service.recordHours(supervisor, created.orderId, { ...action(assigned), hours: "1.2" }, randomUUID());
      if (nextRole === "order_merchandiser") await access.revokeRole(rootAdmin(), designerRole, "隔离验收撤销设计师，保留跟单");
      else {
        await access.assignRole(rootAdmin(), { userId: ids.otherPatternDesigner, roleCode: "sample_designer", reason: "隔离验收恢复设计师" });
        await access.revokeRole(rootAdmin(), merchantRole.assignmentId, "隔离验收撤销跟单，保留设计师");
      }
      const completed = await service.complete(worker, created.orderId, action(hours), randomUUID());
      expect(completed.status).toBe("pending_confirmation");
      const currentCreator = actor(ids.otherPatternDesigner, [nextRole], "todo:view", ...caps);
      const pending = await todoService.listForActor(currentCreator, { module: "pattern_room", query: created.taskName! });
      expect(pending.todos).toHaveLength(1);
      expect(pending.todos[0]!.category).toBe("pattern_room_misc_confirmation");
      expect((await database.query("SELECT required_role FROM rework_todos WHERE dedupe_key=$1", [patternTodoKey(created.orderId, created.currentRoundId, "misc-confirm")])).rows[0].required_role).toBe(nextRole);
      expect((await service.confirmMisc(currentCreator, created.orderId, action(completed), randomUUID())).status).toBe("completed");
      // The creation-time audit snapshot remains intact while routing uses live authority.
      expect((await database.query("SELECT creator_role FROM pattern_room_orders WHERE order_id=$1", [created.orderId])).rows[0].creator_role).toBe(oldRoles[0]);
    }
  });

  it("keeps prerelease Root misc work isolated and explicit zero hourly work out of payable wages", async () => {
    const root = actor(ids.patternRoot, ["root_superuser"], "pattern_room:orders:view");
    const service = new PatternRoomOrderService(database, new RootAwareTodoProjectionService(todoService), { ordersEnabled: false });
    const prices = new PatternRoomPriceService(database), hourly = (await prices.management(root)).hourly;
    const zero = await prices.change(root, "hourly", PATTERN_HOURLY_PRICE_ID, { version: hourly.version, amount: "0.000", enabled: true, reason: "隔离测试明确零价" }, randomUUID());
    const personId = (await database.query("SELECT person_id FROM business_people WHERE app_user_id=$1", [ids.patternRoot])).rows[0].person_id;
    const action = (order: { version: number; currentRoundId: string }) => ({ version: order.version, roundId: order.currentRoundId });
    const created = await service.createMisc(root, { taskName: "ROOT-MISC", priceVersion: zero.version }, randomUUID());
    const assigned = await service.assign(root, created.orderId, { ...action(created), personId }, randomUUID());
    const revised = await service.updateMiscMaterials(root, created.orderId, { ...action(assigned), taskName: "ROOT-MISC-修正", reason: "验收资料修正" }, randomUUID());
    const hours = await service.recordHours(root, created.orderId, { ...action(revised), hours: "1.2" }, randomUUID());
    const completed = await service.complete(root, created.orderId, action(hours), randomUUID());
    const closed = await service.confirmMisc(root, created.orderId, action(completed), randomUUID());
    expect(closed.status).toBe("completed");
    expect(closed.rounds[0]!.segments[0]).toMatchObject({ amount: "0.00000000", wageEligible: false });
    await expect(service.recordHours(root, created.orderId, { ...action(closed), hours: "2.0" }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    expect((await database.query("SELECT count(*)::int count FROM rework_todos WHERE entity_id=$1", [closed.orderId])).rows[0].count).toBe(0);
    expect((await database.query("SELECT count(*)::int count FROM user_role_assignments WHERE user_id=$1", [ids.patternRoot])).rows[0].count).toBe(0);
  });

  const patternActor = (userId: string, roles: string[]) => actor(userId, roles, "pattern_room:orders:view", ...Object.keys(PATTERN_ORDER_ROLES), "todo:view");
  const roundAction = (order: { version: number; currentRoundId: string }) => ({ version: order.version, roundId: order.currentRoundId });
  const makePattern = async (service: PatternRoomOrderService, creator: TrustedActorContext, styleNo: string, quantity = 2, note?:string) => {
    const fileId = randomUUID();
    await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'本轮制作.pdf','application/pdf',10,$3,$4,'ready',CURRENT_TIMESTAMP)", [fileId, `private/${fileId}.pdf`, "c".repeat(64), creator.actorId]);
    return service.create(creator, { styleNo, note, categoryId: "92000000-0000-4000-8000-000000000002", quantity, priceVersion: 1, attachmentIds: [fileId] }, randomUUID());
  };
  const patternHttp = async (service: PatternRoomOrderService, current: TrustedActorContext, path: string, input: object, key: string) => {
    const app = Fastify();
    registerPatternRoomOrderRoutes(app, { service, attachments: {} as AttachmentService, authenticate: async () => ({ id: current.actorId, businessRoles: current.actorRoles, capabilities: Object.keys(PATTERN_ORDER_ROLES) }) });
    try { return await app.inject({ method: "POST", url: `/pattern-room/orders/${path}`, payload: input, headers: { cookie: "dx_rework_session=fixture", "idempotency-key": key } }); }
    finally { await app.close(); }
  };

  it("separates board workers from tail workers and creates one personnel identity on explicit role grant", async () => {
    const service = new PatternRoomOrderService(database, todoProjection, { ordersEnabled: true });
    const supervisor = patternActor(ids.patternSupervisor, ["pattern_room_supervisor"]), designer = patternActor(ids.patternDesigner, ["sample_designer"]);
    const tailWorker = patternActor(ids.tailInspector, ["worker"]);
    const options = await service.workers(supervisor, "");
    expect(options.some(person => person.personId === workerPersonId)).toBe(true);
    expect(options.some(person => person.personId === tailPersonId)).toBe(false);
    expect((await database.query("SELECT count(*)::int n FROM role_capabilities WHERE role_code='worker' AND capability LIKE 'pattern_room:%'")).rows[0].n).toBe(0);
    const created = await makePattern(service, designer, "PATTERN-板房角色隔离");
    await expect(service.get(tailWorker, created.orderId)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.assign(supervisor, created.orderId, { ...roundAction(created), personId: tailPersonId }, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.complete(tailWorker, created.orderId, roundAction(created), randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    await expect(database.query("SELECT pattern_room_authorized_order_roles($1,'pattern_room:orders:view')", [ids.tailInspector])).rejects.toMatchObject({ code: "42501" });
    const userId = randomUUID();
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'新板房师傅',true)", [userId]);
    await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','corp',$3,$3,true,true,CURRENT_TIMESTAMP)", [randomUUID(), userId, `ding-${userId}`]);
    const maintenance = new WorkerAwareAccessMasterDataService(database, "corp"), root = actor(ids.patternRoot, ["root_superuser"], "access:admin", "master_data:manage");
    const grant = await maintenance.assignRole(root, { userId, roleCode: "pattern_room_worker", reason: "独立板房角色验收" });
    const people = await database.query("SELECT person_id FROM business_people WHERE app_user_id=$1", [userId]);
    expect(people.rows).toHaveLength(1);
    expect((await service.workers(supervisor, "新板房")).map(person => person.personId)).toEqual([people.rows[0].person_id]);
    const assigned = await service.assign(supervisor, created.orderId, { ...roundAction(created), personId: people.rows[0].person_id }, randomUUID());
    const boardWorker = patternActor(userId, ["pattern_room_worker"]);
    const executionTodo = (await database.query("SELECT todo_id FROM rework_todos WHERE entity_id=$1 AND required_capability='pattern_room:orders:complete'", [created.orderId])).rows[0].todo_id;
    // Simulate a pre-split todo; production migration does not rewrite historical routing facts.
    await database.query("ALTER TABLE rework_todos DISABLE TRIGGER rework_todos_update_guard");
    try { await database.query("UPDATE rework_todos SET required_role='worker' WHERE todo_id=$1", [executionTodo]); }
    finally { await database.query("ALTER TABLE rework_todos ENABLE TRIGGER rework_todos_update_guard"); }
    const todoClient = await database.connect();
    try {
      await todoClient.query("BEGIN");
      expect(await todoService.ensureOpenRecipientEligibleInTransaction(todoClient, root, executionTodo)).toBe(true);
      await todoClient.query("ROLLBACK");
    } finally { todoClient.release(); }
    expect(await service.canDownload(boardWorker, { entityType: "pattern_room_attachment", entityId: created.attachments[0]!.attachmentId })).toBe(true);
    await maintenance.revokeRole(root, grant.assignmentId, "撤销后必须即时失去板房权限");
    await expect(service.complete(boardWorker, created.orderId, roundAction(assigned), randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    expect(await service.canDownload(boardWorker, { entityType: "pattern_room_attachment", entityId: created.attachments[0]!.attachmentId })).toBe(false);
    expect((await service.workers(supervisor, "新板房")).length).toBe(0);
    const again = await maintenance.assignRole(root, { userId, roleCode: "pattern_room_worker", reason: "复授权复用原工资身份" });
    expect((await database.query("SELECT person_id FROM business_people WHERE app_user_id=$1", [userId])).rows).toEqual(people.rows);
    expect((await service.complete(boardWorker, created.orderId, roundAction(assigned), randomUUID())).status).toBe("pending_confirmation");
    await maintenance.revokeRole(root, again.assignmentId, "验收结束");
  });

  it("preserves both concurrent worker role grants with one person and rolls back genuine creation failures", async () => {
    const root = actor(ids.patternRoot, ["root_superuser"], "access:admin", "master_data:manage");
    const newEmployee = async () => {
      const userId = randomUUID();
      await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'双角色建档验收',true)", [userId]);
      await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','corp',$3,$3,true,true,CURRENT_TIMESTAMP)", [randomUUID(), userId, `ding-${userId}`]);
      return userId;
    };
    const userId = await newEmployee();
    let reached = 0, release!: () => void;
    const bothCreating = new Promise<void>(resolve => { release = resolve; });
    class ConcurrentPersonnel extends WorkerAwareAccessMasterDataService {
      override async createPerson(...args: Parameters<WorkerAwareAccessMasterDataService["createPerson"]>) {
        reached += 1;
        if (reached === 2) release();
        await bothCreating;
        return super.createPerson(...args);
      }
    }
    const maintenance = new ConcurrentPersonnel(database, "corp");
    const grants = await Promise.all(["worker", "pattern_room_worker"].map(roleCode => maintenance.assignRole(root, { userId, roleCode, reason: "显式同时授予双角色" })));
    expect(reached).toBe(2);
    expect(grants).toHaveLength(2);
    expect((await database.query("SELECT role_code FROM user_role_assignments WHERE user_id=$1 AND revoked_at IS NULL ORDER BY role_code", [userId])).rows).toEqual([{ role_code: "pattern_room_worker" }, { role_code: "worker" }]);
    expect((await database.query("SELECT person_id FROM business_people WHERE app_user_id=$1", [userId])).rows).toHaveLength(1);
    for (const grant of grants) await maintenance.revokeRole(root, grant.assignmentId, "清理隔离授权用例");

    class FailedPersonnel extends WorkerAwareAccessMasterDataService {
      override async createPerson(): Promise<{ personId: string }> { throw new Error("person write failed"); }
    }
    const failedUser = await newEmployee();
    await expect(new FailedPersonnel(database, "corp").assignRole(root, { userId: failedUser, roleCode: "pattern_room_worker", reason: "建档失败仍须回滚" })).rejects.toThrow("person write failed");
    expect((await database.query("SELECT role_code FROM user_role_assignments WHERE user_id=$1 AND revoked_at IS NULL", [failedUser])).rows).toEqual([]);
    expect((await database.query("SELECT person_id FROM business_people WHERE app_user_id=$1", [failedUser])).rows).toEqual([]);
  });

  it("replaces rework materials within the total limit while preserving historical bindings", async () => {
    const service = new PatternRoomOrderService(database, todoProjection, { ordersEnabled: true });
    const designer = patternActor(ids.patternDesigner, ["sample_designer"]), supervisor = patternActor(ids.patternSupervisor, ["pattern_room_supervisor"]);
    const worker = patternActor(ids.worker, ["pattern_room_worker"]);
    const created = await makePattern(service, designer, "PATTERN-返工资料选择");
    const assigned = await service.assign(supervisor, created.orderId, { ...roundAction(created), personId: workerPersonId }, randomUUID());
    const completed = await service.complete(worker, created.orderId, roundAction(assigned), randomUUID());
    const originalId = completed.attachments[0]!.attachmentId;
    const added: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = randomUUID(); added.push(id);
      await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'新资料.pdf','application/pdf',10,$3,$4,'ready',CURRENT_TIMESTAMP)", [id, `private/${id}.pdf`, "c".repeat(64), designer.actorId]);
    }
    const input = { ...roundAction(completed), reason: "新版资料替换", reasonCategory: "other", attachmentIds: added };
    await expect(service.requestRework(designer, created.orderId, input, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.requestRework(designer, created.orderId, { ...input, retainedAttachmentIds: [added[0]] }, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.requestRework(designer, created.orderId, { ...input, retainedAttachmentIds: [], attachmentIds: [] }, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    expect((await service.get(designer, created.orderId)).version).toBe(completed.version);
    const requested = await service.requestRework(designer, created.orderId, { ...input, retainedAttachmentIds: [] }, randomUUID());
    expect(requested.attachments.filter(file => file.roundId === requested.currentRoundId)).toHaveLength(20);
    expect(requested.attachments.find(file => file.roundId === completed.currentRoundId && file.attachmentId === originalId)?.active).toBe(true);
    expect(requested.rounds).toHaveLength(2);
  });

  it("preserves multiple worker segments and pre/post-handoff rework without duplicate rounds or early wages", async () => {
    const service = new PatternRoomOrderService(database, todoProjection, { ordersEnabled: true });
    const designer = patternActor(ids.patternDesigner, ["sample_designer"]), supervisor = patternActor(ids.patternSupervisor, ["pattern_room_supervisor"]);
    const worker = patternActor(ids.worker, ["pattern_room_worker"]), nextWorker = patternActor(ids.otherPatternWorker, ["pattern_room_worker"]);
    const created = await makePattern(service, designer, "PATTERN-换人及多轮", 2, "只供原业务范围的制作说明");
    await expect(database.query("UPDATE pattern_room_rounds SET round_index=NULL WHERE round_id=$1", [created.currentRoundId])).rejects.toMatchObject({ code: "23514" });
    const assigned = await service.assign(supervisor, created.orderId, { ...roundAction(created), personId: workerPersonId }, randomUUID());
    await expect(service.requestRework(designer, created.orderId, { ...roundAction(assigned), reason: "尚未完工", reasonCategory: "other" }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    const firstInput = { ...roundAction(assigned), segmentId: assigned.rounds[0]!.segments[0]!.segmentId, personId: otherPatternPersonId, amount: "25.125", reason: "已做部分交接" };
    await expect(service.transfer(supervisor, created.orderId, { ...firstInput, amount: "80.001" }, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    const transferKey = randomUUID(), transferResponse = await patternHttp(service, supervisor, `${created.orderId}/transfer`, firstInput, transferKey);
    expect(transferResponse.statusCode).toBe(200);
    const transferred = transferResponse.json();
    expect((await service.transfer(supervisor, created.orderId, firstInput, transferKey)).version).toBe(transferred.version);
    await expect(service.get(worker, created.orderId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.complete(worker, created.orderId, roundAction(assigned), randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    expect((await service.get(nextWorker, created.orderId)).rounds[0]!.segments.map(segment => segment.amount)).toEqual(["54.87500000"]);
    const oldStopped = (await database.query("SELECT worker_completed_at,ended_at FROM pattern_room_segments WHERE segment_id=$1", [firstInput.segmentId])).rows[0];
    expect(oldStopped.worker_completed_at).toBeNull(); expect(oldStopped.ended_at).not.toBeNull();
    const second = await service.transfer(supervisor, created.orderId, { ...roundAction(transferred), segmentId: transferred.rounds[0]!.segments.at(-1)!.segmentId, personId: workerPersonId, amount: "10.875", reason: "再次换回原工人" }, randomUUID());
    expect(second.rounds[0]!.segments.map(segment => segment.amount)).toEqual(["25.12500000", "10.87500000", "44.00000000"]);
    expect((await service.get(worker, created.orderId)).rounds[0]!.segments.map(segment => segment.amount)).toEqual(["25.12500000", "44.00000000"]);
    const complete = await service.complete(worker, created.orderId, roundAction(second), randomUUID());
    const completedAt = complete.rounds[0]!.completedAt;
    expect(complete.rounds[0]!.segments.every(segment => !segment.wageEligible)).toBe(true);
    const input = { ...roundAction(complete), reason: "客户要求调整", reasonCategory: "customer_change" }, requestKey = randomUUID();
    const requestResponse = await patternHttp(service, supervisor, `${created.orderId}/rework`, input, requestKey);
    expect(requestResponse.statusCode).toBe(200);
    const requested = requestResponse.json();
    expect((await service.requestRework(supervisor, created.orderId, input, requestKey)).currentRoundId).toBe(requested.currentRoundId);
    await expect(service.requestRework(designer, created.orderId, input, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    expect(requested.reworkCount).toBe(0);
    expect(requested.rounds.at(-1)).toMatchObject({ index: null, roundType: "rework", agreedAmount: null });
    expect(requested.rounds.at(-1)).not.toHaveProperty("unitPrice");
    expect(requested.rounds[0]!.nodes.at(-1)!.exitReason).toBe("rework");
    expect((await database.query("SELECT status FROM rework_todos WHERE dedupe_key=$1", [patternTodoKey(created.orderId, complete.currentRoundId, "handoff")])).rows[0].status).toBe("completed");
    await expect(service.assign(supervisor, created.orderId, { ...roundAction(requested), personId: otherPatternPersonId }, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.uploadActor(supervisor, "pattern")).rejects.toMatchObject({ statusCode: 403 });
    expect((await service.uploadActor(supervisor, "pattern", "rework")).actorId).toBe(ids.patternSupervisor);
    const reworkAssigned = await service.assign(supervisor, created.orderId, { ...roundAction(requested), personId: otherPatternPersonId, amount: "7.005" }, randomUUID());
    await exerciseMixedFinancePatternScope({database,service,orderId:created.orderId,rootId:ids.patternRoot,
      readers:[worker,nextWorker,designer,patternActor(ids.otherPatternDesigner,["sample_designer"])]});
    expect(reworkAssigned.reworkCount).toBe(1); expect(reworkAssigned.rounds.at(-1)!.index).toBe(1);
    await expect(database.query("UPDATE pattern_room_rounds SET round_index=NULL WHERE round_id=$1", [reworkAssigned.currentRoundId])).rejects.toMatchObject({ code: "23514" });
    const reworkComplete = await service.complete(nextWorker, created.orderId, roundAction(reworkAssigned), randomUUID());
    expect((await service.get(supervisor, created.orderId)).rounds.flatMap(round => round.segments).every(segment => !segment.wageEligible)).toBe(true);
    const handed = await service.handoff(designer, created.orderId, roundAction(reworkComplete), randomUUID());
    expect(handed.rounds.flatMap(round => round.segments).filter(segment => segment.wageEligible)).toHaveLength(4);
    expect(handed.rounds[0]!.completedAt).toBe(completedAt);
    const eligibleBefore = (await database.query("SELECT segment_id,wage_eligible_at FROM pattern_room_segments WHERE round_id=ANY($1::uuid[]) ORDER BY segment_id", [handed.rounds.map(round => round.roundId)])).rows;
    const afterHandoff = await service.requestRework(designer, created.orderId, { ...roundAction(handed), reason: "明确零元返工", reasonCategory: "workmanship" }, randomUUID());
    const zeroAssigned = await service.assign(supervisor, created.orderId, { ...roundAction(afterHandoff), personId: otherPatternPersonId, amount: "0" }, randomUUID());
    const zeroComplete = await service.complete(nextWorker, created.orderId, roundAction(zeroAssigned), randomUUID());
    const zeroHanded = await service.handoff(designer, created.orderId, roundAction(zeroComplete), randomUUID());
    expect(zeroHanded.reworkCount).toBe(2); expect(zeroHanded.rounds.at(-1)!.segments[0]!.wageEligible).toBe(false);
    expect((await database.query("SELECT segment_id,wage_eligible_at FROM pattern_room_segments WHERE round_id=ANY($1::uuid[]) ORDER BY segment_id", [handed.rounds.map(round => round.roundId)])).rows).toEqual(eligibleBefore);
    const neverDispatched = await service.requestRework(designer, created.orderId, { ...roundAction(zeroHanded), reason: "待分配取消测试", reasonCategory: "other" }, randomUUID());
    const cancelled = await service.cancel(designer, created.orderId, { ...roundAction(neverDispatched), reason: "需求撤回" }, randomUUID());
    expect(cancelled.reworkCount).toBe(2); expect(cancelled.rounds.at(-1)).toMatchObject({ index: null, status: "cancelled", cancelledAmount: "0.00000000" });
    expect(cancelled.actions.cancelFees).toBe(false);
  });

  it("keeps cancelled partial labor separate from sample handoff and never orphans earlier unhanded work", async () => {
    const service = new PatternRoomOrderService(database, todoProjection, { ordersEnabled: true });
    const designer = patternActor(ids.patternDesigner, ["sample_designer"]), supervisor = patternActor(ids.patternSupervisor, ["pattern_room_supervisor"]), worker = patternActor(ids.worker, ["pattern_room_worker"]);
    const pending = await makePattern(service, designer, "PATTERN-未派工取消");
    await expect(service.cancel(supervisor, pending.orderId, { ...roundAction(pending), reason: "非发起人" }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    expect((await service.cancel(designer, pending.orderId, { ...roundAction(pending), reason: "发起人取消" }, randomUUID())).status).toBe("cancelled");
    const created = await makePattern(service, designer, "PATTERN-部分取消");
    const assigned = await service.assign(supervisor, created.orderId, { ...roundAction(created), personId: workerPersonId }, randomUUID());
    await expect(service.cancel(designer, created.orderId, { ...roundAction(assigned), reason: "已派工本人不能直接停工" }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    const transfer = await service.transfer(supervisor, created.orderId, { ...roundAction(assigned), segmentId: assigned.rounds[0]!.segments[0]!.segmentId, personId: otherPatternPersonId, amount: "25.125", reason: "部分完成交接" }, randomUUID());
    const cancelInput = { ...roundAction(transfer), segmentId: transfer.rounds[0]!.segments.at(-1)!.segmentId, amount: "5.125", reason: "客户停止制作" }, cancelKey = randomUUID();
    const stopResponse = await patternHttp(service, supervisor, `${created.orderId}/cancel`, cancelInput, cancelKey);
    expect(stopResponse.statusCode).toBe(200);
    const stopped = stopResponse.json();
    expect((await service.cancel(supervisor, created.orderId, cancelInput, cancelKey)).version).toBe(stopped.version);
    expect(stopped.rounds[0]).toMatchObject({ agreedAmount: "80.00000000", cancelledAmount: "30.25000000", completedAt: null, handedOverAt: null });
    expect(stopped.rounds[0]!.segments.every((segment: { wageEligible: boolean }) => !segment.wageEligible)).toBe(true);
    expect((await database.query("SELECT count(*)::int count FROM pattern_room_segments WHERE round_id=$1 AND worker_completed_at IS NOT NULL", [stopped.currentRoundId])).rows[0].count).toBe(0);
    expect((await todoService.listForActor({ ...designer, authorizationCapability: "todo:view" }, { module: "pattern_room", query: created.styleNo })).todos.map(todo => todo.category)).toEqual(["pattern_room_cancel_fees"]);
    await expect(service.handoff(designer, created.orderId, roundAction(stopped), randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    const feeKey = randomUUID(), feeResponse = await patternHttp(service, designer, `${created.orderId}/cancel-fees`, roundAction(stopped), feeKey);
    expect(feeResponse.statusCode).toBe(200);
    const confirmed = feeResponse.json();
    expect((await service.confirmCancelledFees(designer, created.orderId, roundAction(stopped), feeKey)).version).toBe(confirmed.version);
    expect(confirmed.status).toBe("cancelled"); expect(confirmed.rounds[0]!.handedOverAt).toBeNull(); expect(confirmed.rounds[0]!.feeConfirmedAt).not.toBeNull();
    expect(confirmed.rounds[0]!.segments.map((segment: { amount: string }) => segment.amount)).toEqual(["25.12500000", "5.12500000"]);
    expect(confirmed.rounds[0]!.segments.every((segment: { wageEligible: boolean }) => segment.wageEligible)).toBe(true);
    const zero = await makePattern(service, designer, "PATTERN-零费取消"), zeroAssigned = await service.assign(supervisor, zero.orderId, { ...roundAction(zero), personId: workerPersonId }, randomUUID());
    const zeroStopped = await service.cancel(supervisor, zero.orderId, { ...roundAction(zeroAssigned), segmentId: zeroAssigned.rounds[0]!.segments[0]!.segmentId, amount: "0", reason: "尚未实际制作" }, randomUUID());
    expect(zeroStopped.actions.cancelFees).toBe(false);
    await expect(service.confirmCancelledFees(designer, zero.orderId, roundAction(zeroStopped), randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    const old = await makePattern(service, designer, "PATTERN-取消返工保留旧轮费用"), oldAssigned = await service.assign(supervisor, old.orderId, { ...roundAction(old), personId: workerPersonId }, randomUUID());
    const oldComplete = await service.complete(worker, old.orderId, roundAction(oldAssigned), randomUUID());
    const requested = await service.requestRework(designer, old.orderId, { ...roundAction(oldComplete), reason: "未交接先返工", reasonCategory: "other" }, randomUUID());
    const requestCancelled = await service.cancel(designer, old.orderId, { ...roundAction(requested), reason: "新增要求撤回并停止本单" }, randomUUID());
    expect(requestCancelled.reworkCount).toBe(0); expect((await service.get(designer, old.orderId)).actions.cancelFees).toBe(true);
    const priorFees = await service.confirmCancelledFees(designer, old.orderId, roundAction(requestCancelled), randomUUID());
    expect(priorFees.rounds[0]!.segments[0]!.wageEligible).toBe(true); expect(priorFees.rounds[0]!.handedOverAt).toBeNull();
    expect(priorFees.rounds[0]!.completedAt).toBe(oldComplete.rounds[0]!.completedAt);
  });

  it("keeps misc hours per worker across transfers and records real work stops without changing qualified wages", async () => {
    const service = new PatternRoomOrderService(database, todoProjection, { ordersEnabled: true });
    const merchant = patternActor(ids.merchandiser, ["order_merchandiser"]), supervisor = patternActor(ids.patternSupervisor, ["pattern_room_supervisor"]), nextWorker = patternActor(ids.otherPatternWorker, ["pattern_room_worker"]);
    const prices = new PatternRoomPriceService(database), root = actor(ids.patternRoot, ["root_superuser"], "pattern_room:prices:read");
    const current = (await prices.management(root)).hourly;
    const price = await prices.change(root, "hourly", PATTERN_HOURLY_PRICE_ID, { version: current.version, amount: "28.555", enabled: true, reason: "隔离验收分段工时" }, randomUUID());
    const created = await service.createMisc(merchant, { taskName: "MISC-分段实际工时", priceVersion: price.version }, randomUUID());
    const assigned = await service.assign(supervisor, created.orderId, { ...roundAction(created), personId: workerPersonId }, randomUUID());
    const initialHours = await service.recordHours(supervisor, created.orderId, { ...roundAction(assigned), hours: "0.9" }, randomUUID());
    const transferred = await service.transfer(supervisor, created.orderId, { ...roundAction(initialHours), segmentId: initialHours.rounds[0]!.segments[0]!.segmentId, personId: otherPatternPersonId, hours: "1.2", reason: "原执行段实际结束" }, randomUUID());
    expect(transferred.rounds[0]).toMatchObject({ actualHours: null, agreedAmount: null });
    const hours = await service.recordHours(supervisor, created.orderId, { ...roundAction(transferred), hours: "0.1" }, randomUUID());
    expect(hours.rounds[0]).toMatchObject({ actualHours: "1.3", agreedAmount: "37.12150000" });
    const completed = await service.complete(nextWorker, created.orderId, roundAction(hours), randomUUID());
    const before = (await service.get(supervisor, created.orderId)).rounds[0]!.segments;
    expect(before.map(segment => segment.amount)).toEqual(["34.26600000", "2.85550000"]);
    expect(before.every(segment => segment.wageEligible)).toBe(true);
    const cancellation = { ...roundAction(completed), segmentId: before.at(-1)!.segmentId, reason: "结束已完成任务，保留费用" };
    await expect(service.cancel(supervisor, created.orderId, { ...cancellation, hours: "0" }, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    const closed = await service.cancel(supervisor, created.orderId, cancellation, randomUUID());
    expect(closed.rounds[0]!.segments).toEqual(before);
    const stopped = await service.createMisc(merchant, { taskName: "MISC-中途实际停止", priceVersion: price.version }, randomUUID());
    const stopAssigned = await service.assign(supervisor, stopped.orderId, { ...roundAction(stopped), personId: workerPersonId }, randomUUID());
    const stopTransfer = await service.transfer(supervisor, stopped.orderId, { ...roundAction(stopAssigned), segmentId: stopAssigned.rounds[0]!.segments[0]!.segmentId, personId: otherPatternPersonId, hours: "0.2", reason: "部分任务转交" }, randomUUID());
    await expect(service.transfer(supervisor, stopped.orderId, { ...roundAction(stopTransfer), segmentId: stopTransfer.rounds[0]!.segments.at(-1)!.segmentId, personId: workerPersonId, hours: "999999.9", reason: "超出本轮累计工时" }, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    expect((await service.get(supervisor, stopped.orderId)).version).toBe(stopTransfer.version);
    const stop = await service.cancel(supervisor, stopped.orderId, { ...roundAction(stopTransfer), segmentId: stopTransfer.rounds[0]!.segments.at(-1)!.segmentId, hours: "0.3", reason: "停止工作并确认两段实际工时" }, randomUUID());
    expect(stop.rounds[0]).toMatchObject({ actualHours: "0.5", cancelledAmount: "14.27750000", completedAt: null, handedOverAt: null });
    expect(stop.rounds[0]!.stoppedAt).not.toBeNull(); expect(stop.rounds[0]!.segments.every(segment => segment.wageEligible)).toBe(true);
    expect((await database.query("SELECT count(*)::int count FROM pattern_room_segments WHERE round_id=$1 AND worker_completed_at IS NOT NULL", [stop.currentRoundId])).rows[0].count).toBe(0);
    const zero = await service.createMisc(merchant, { taskName: "MISC-取消无实际工作", priceVersion: price.version }, randomUUID());
    const zeroAssigned = await service.assign(supervisor, zero.orderId, { ...roundAction(zero), personId: workerPersonId }, randomUUID());
    const zeroStopped = await service.cancel(supervisor, zero.orderId, { ...roundAction(zeroAssigned), segmentId: zeroAssigned.rounds[0]!.segments[0]!.segmentId, hours: "0", reason: "没有实际劳动" }, randomUUID());
    expect(zeroStopped.rounds[0]).toMatchObject({ actualHours: "0.0", agreedAmount: "0.00000000" });
    expect(zeroStopped.rounds[0]!.segments[0]!.wageEligible).toBe(false);
  });

  it("serializes a supervisor transfer racing the current worker's completion", async () => {
    const service = new PatternRoomOrderService(database, todoProjection, { ordersEnabled: true });
    const designer = patternActor(ids.patternDesigner, ["sample_designer"]), supervisor = patternActor(ids.patternSupervisor, ["pattern_room_supervisor"]), worker = patternActor(ids.worker, ["pattern_room_worker"]), nextWorker = patternActor(ids.otherPatternWorker, ["pattern_room_worker"]);
    const created = await makePattern(service, designer, "PATTERN-并发改派与完工"), assigned = await service.assign(supervisor, created.orderId, { ...roundAction(created), personId: workerPersonId }, randomUUID());
    const results = await Promise.allSettled([
      service.transfer(supervisor, created.orderId, { ...roundAction(assigned), segmentId: assigned.rounds[0]!.segments[0]!.segmentId, personId: otherPatternPersonId, amount: "20", reason: "并发原单换人" }, randomUUID()),
      service.complete(worker, created.orderId, roundAction(assigned), randomUUID()),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const current = await service.get(supervisor, created.orderId);
    expect(current.rounds[0]!.segments.filter(segment => segment.endedAt === null).length).toBeLessThanOrEqual(1);
    const complete = current.status === "in_progress" ? await service.complete(nextWorker, created.orderId, roundAction(current), randomUUID()) : current;
    expect((await service.handoff(designer, created.orderId, roundAction(complete), randomUUID())).status).toBe("completed");
  });

  // Also invoked by the mapped-PostgreSQL gate with the default Vitest config.
  // Keep the existing business-chain 60s budget for this multi-step scenario.
  it("carries one real order from N01 through N11 without losing cross-node facts", { timeout: 60_000 }, async () => {
    // N01 - QC initiates one order with the business total quantity.
    const initialImageId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'full-chain-initial.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [initialImageId, `private/${initialImageId}.webp`, "d".repeat(64), ids.qc],
    );
    const draft = await initiation.createDraft(qc(), {
      styleNo: "UAT-FULL-CHAIN",
      orderQuantity: 1_000,
      orderNo: "ORDER-FULL-001",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "supplier", supplierId: factorySupplierId },
      tailInspectionCostBearer: "processing_factory",
      inspectionReport: n01CoreInspectionReport("全链测试款"),
      problemPart: "袖口",
      problemDescription: "全链自动验收",
      reworkQuantity: 200,
      attachmentIds: [initialImageId],
    }, randomUUID());
    expect(draft.value).toMatchObject({
      status: "draft",
      reworkQuantity: 200,
      reworkNo: null,
    });
    await supplyContext.save(qc(), draft.value.reworkOrderId, {
      washingSupplierId: null,
      embroiderySupplierId: null,
      fabricSupplierId: null,
      embroideryMerchandiserUserId: ids.embroideryMerchandiser,
    });
    const submitted = await initiation.submit(
      qc(),
      draft.value.reworkOrderId,
      { expectedVersion: draft.value.version },
      randomUUID(),
    );
    expect(submitted.value).toMatchObject({
      status: "pending_process_configuration",
      reworkQuantity: 200,
      reworkNo: expect.stringMatching(/^RW-/),
    });

    await exerciseFinanceOrderQueries({database,external,orderId:submitted.value.reworkOrderId,unrelatedId:ids.otherPatternWorker,rootId:ids.patternRoot,beforeLedger:true,
      readers:[{userId:ids.factoryPayables,role:"factory_payables",types:["processing_factory"]},
        {userId:ids.fabricPayables,role:"fabric_payables",types:["fabric_supplier"]},
        {userId:ids.embroideryPayables,role:"embroidery_washing_payables",types:["embroidery_factory","washing_factory"]},
        {userId:ids.monthClose,role:"wage_month_close_accountant",types:[]},
        {userId:ids.financeDirector,role:"finance_director",types:"all"},{userId:ids.financeRead,role:"finance_read",types:"all"}]});

    const firstTodoPage = await todoService.listForActor(tailTodoView(), { module: "rework" });
    expect(firstTodoPage.moduleCounts.rework).toBeGreaterThan(0);
    expect(firstTodoPage.todos).toHaveLength(1);
    expect(firstTodoPage).toMatchObject({ page: 1, pageSize: 15, totalCount: 1, totalPages: 1 });
    expect((await todoService.listForActor(
      tailTodoView(),
      { module: "rework", query: "%" },
    )).todos).toHaveLength(0);
    expect(await todoService.getForActor(
      tailTodoView(),
      firstTodoPage.todos[0]!.todoId,
    )).toMatchObject({ todoId: firstTodoPage.todos[0]!.todoId, status: "pending" });

    // Post-creation order evidence must pass the same current-schema guards
    // used in production, while preserving the active workflow state.
    const supplementalImageId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'full-chain-supplement.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [
        supplementalImageId,
        `private/${supplementalImageId}.webp`,
        "e".repeat(64),
        ids.qc,
      ],
    );
    const supplemented = await initiation.supplementOrderImages(
      actor(ids.qc, ["quality_control"], "tools:user"),
      submitted.value.reworkOrderId,
      {
        expectedVersion: submitted.value.version,
        attachmentIds: [supplementalImageId],
      },
      randomUUID(),
    );
    expect(supplemented.value).toMatchObject({
      status: "pending_process_configuration",
      version: submitted.value.version + 1,
      attachmentIds: expect.arrayContaining([initialImageId, supplementalImageId]),
    });
    expect((await database.query(
      "SELECT entity_type,entity_id FROM attachments WHERE attachment_id=$1",
      [supplementalImageId],
    )).rows[0]).toEqual({
      entity_type: "rework_order",
      entity_id: submitted.value.reworkOrderId,
    });

    // N02 records process, planned quantity and price; N03 IE must approve it.
    const n02Input = SaveProcessConfigurationSchema.parse({
      expectedOrderVersion: supplemented.value.version,
      items: [{
        source: "catalog",
        processId: publicProcessId,
        executionKind: "worker",
        plannedQuantity: submitted.value.reworkQuantity,
        pricingUnit: "piece",
        unitPrice: 0.55,
      }, {
        source: "custom",
        customProcessName: "尾查",
        executionKind: "tail_inspection",
        plannedQuantity: 1,
        pricingUnit: "piece",
        unitPrice: 0.2,
      }],
    });
    const n02Saved = await configuration.saveDraft(
      tailConfigure(),
      submitted.value.reworkOrderId,
      n02Input,
      randomUUID(),
    );
    expect(n02Saved.value).toMatchObject({
      reworkStatus: "pending_process_configuration",
      configuration: {
        status: "draft",
        items: [
          expect.objectContaining({ executionKind: "worker", plannedQuantity: 200, unitPrice: 0.55 }),
          expect.objectContaining({ executionKind: "tail_inspection", plannedQuantity: 1, unitPrice: 0.2 }),
        ],
      },
    });
    const workerItem = n02Saved.value.configuration!.items.find((item) => item.executionKind === "worker")!;
    const tailItem = n02Saved.value.configuration!.items.find((item) => item.executionKind === "tail_inspection")!;
    const planned = await workerPlan.save(
      tailAssign(),
      submitted.value.reworkOrderId,
      {
        expectedOrderVersion: n02Saved.value.orderVersion,
        configurationId: n02Saved.value.configuration!.configurationId,
        expectedConfigurationVersion: n02Saved.value.configuration!.configurationVersion,
        assignments: [
          { configurationItemId: workerItem.configurationItemId, memberIds: [workerPersonId] },
          { configurationItemId: tailItem.configurationItemId, memberIds: [tailPersonId] },
        ],
      },
      randomUUID(),
    );
    expect(planned.value).toMatchObject({ required: true, complete: true });
    const n02Submitted = await configuration.submit(
      tailConfigure(),
      submitted.value.reworkOrderId,
      SubmitProcessConfigurationSchema.parse({
        expectedOrderVersion: n02Saved.value.orderVersion,
        expectedConfigurationVersion: n02Saved.value.configuration!.configurationVersion,
      }),
      randomUUID(),
    );
    expect(n02Submitted.value.reworkStatus).toBe("pending_ie_review");
    const n03Approved = await configuration.review(
      ie(),
      submitted.value.reworkOrderId,
      ReviewProcessConfigurationSchema.parse({
        expectedOrderVersion: n02Submitted.value.orderVersion,
        expectedConfigurationVersion: n02Submitted.value.configuration!.configurationVersion,
        decision: "approved",
      }),
      randomUUID(),
    );
    expect(n03Approved.value.reworkStatus).toBe("pending_task_assignment");
    const approvedItem = n03Approved.value.configuration!.items.find((item) => item.executionKind === "worker")!;
    const approvedTailItem = n03Approved.value.configuration!.items.find((item) => item.executionKind === "tail_inspection")!;
    expect(approvedItem).toMatchObject({
      processId: publicProcessId,
      processName: "袖口返修",
      plannedQuantity: 200,
      pricingUnit: "piece",
      unitPrice: 0.55,
    });

    expect(approvedTailItem).toMatchObject({
      processName: "整查",
      executionKind: "tail_inspection",
      plannedQuantity: 1,
      unitPrice: 0.2,
    });

    // IE approval activates the complete N02 plan into two unified execution tasks.
    const activated = await workerPlan.activateAfterIeApproval(
      submitted.value.reworkOrderId,
      n03Approved.value.configuration!.configurationVersion,
      randomUUID(),
    );
    expect(activated).toMatchObject({ reworkStatus: "in_progress", tasksCreated: 2 });
    const n04Started = await work.list(tailAssign(), submitted.value.reworkOrderId);
    expect(n04Started.reworkStatus).toBe("in_progress");
    const workerTask = n04Started.tasks.find((item) => item.executionKind === "worker")!;
    const tailTask = n04Started.tasks.find((item) => item.executionKind === "tail_inspection")!;
    expect(workerTask).toMatchObject({
      processName: "袖口返修",
      plannedQuantity: 200,
      unitPrice: 0.55,
      members: [{ personId: workerPersonId, displayName: "工人" }],
    });
    expect(tailTask).toMatchObject({
      processName: "整查",
      executionKind: "tail_inspection",
      members: [{ personId: tailPersonId, displayName: "尾查" }],
    });

    // N05 has one final completion report per assigned task; wage is still
    // generated only after N06 confirms the quantity.
    const firstReportKey = randomUUID();
    const firstReportInput = CreateWorkReportSchema.parse({
      expectedOrderVersion: n04Started.orderVersion,
      actualQuantity: 200,
      completedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const firstReport = await work.submitReport(
      worker(),
      workerTask.workTaskId,
      firstReportInput,
      firstReportKey,
    );
    const firstReplay = await work.submitReport(
      worker(),
      workerTask.workTaskId,
      firstReportInput,
      firstReportKey,
    );
    expect(firstReplay.reused).toBe(true);
    expect(firstReplay.value.workReportId).toBe(firstReport.value.workReportId);
    expect(firstReport.value.memberShares[0]?.amount).toBe(0);

    const tailReportingView = await work.list(tailInspect(), submitted.value.reworkOrderId);
    const tailReported = await work.submitReport(
      tailInspect(),
      tailTask.workTaskId,
      CreateWorkReportSchema.parse({
        expectedOrderVersion: tailReportingView.orderVersion,
        actualQuantity: 200,
        completedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      }),
      randomUUID(),
    );
    expect(tailReported.value).toMatchObject({
      workTaskId: tailTask.workTaskId,
      status: "submitted",
    });

    const n07View = await wholeOrder.get(
      tailAudit(),
      submitted.value.reworkOrderId,
    );
    expect(n07View).toMatchObject({
      reworkStatus: "pending_order_review",
      processes: [expect.objectContaining({
        configurationItemId: approvedItem.configurationItemId,
        plannedQuantity: 200,
        completedQuantity: 200,
        complete: true,
        finalUnitPrice: 0.55,
      })],
    });

    // N05 records versioned final quantities without materializing wages.
    const n05Confirmed = await wholeOrder.approve(
      tailAudit(),
      submitted.value.reworkOrderId,
      {
        expectedOrderVersion: n07View.orderVersion,
        finalQuantities: n07View.processes.map((process) => ({
          configurationItemId: process.configurationItemId,
          finalConfirmedQuantity: process.completedQuantity,
        })),
        temporaryCoefficients: [],
      },
      randomUUID(),
    );
    expect(n05Confirmed.value.reworkStatus).toBe("pending_final_quantity_ie_review");
    expect((await database.query(
      "SELECT count(*)::int count FROM rework_wage_items WHERE rework_order_id=$1",
      [submitted.value.reworkOrderId],
    )).rows[0]).toEqual({ count: 0 });

    // N06 IE approval locks settlement quantities, creates wages, then enters responsibility.
    const n06View = await wholeOrder.get(ie(), submitted.value.reworkOrderId);
    const n06Approved = await wholeOrder.reviewFinalQuantity(
      ie(),
      submitted.value.reworkOrderId,
      { expectedOrderVersion: n06View.orderVersion, decision: "approved" },
      randomUUID(),
    );
    expect(n06Approved.value).toMatchObject({
      reworkStatus: "pending_responsibility_determination",
      processes: [expect.objectContaining({
        configurationItemId: approvedItem.configurationItemId,
        finalUnitPrice: 0.55,
      })],
    });

    // N09 splits one process between two external responsible parties. Because
    // no own-factory share exists, finalization must skip owner confirmation.
    const n07Processes = [{
      configurationItemId: approvedItem.configurationItemId,
      multiplier: "1.000",
      allocations: [
        {
          responsibilityType: "processing_factory",
          shareBps: 7000,
          multiplier: "1.200",
          supplierId: factorySupplierId,
        },
        {
          responsibilityType: "fabric_supplier",
          shareBps: 3000,
          multiplier: "1.200",
          supplierId: fabricSupplierId,
        },
      ],
    }, {
      configurationItemId: tailItem.configurationItemId,
      multiplier: "1.000",
      allocations: [{
        responsibilityType: "processing_factory",
        shareBps: 10000,
        multiplier: "1.200",
        supplierId: factorySupplierId,
      }],
    }];

    await expect(responsibility.saveDraft(
      production(),
      submitted.value.reworkOrderId,
      CreateResponsibilityDraftSchema.parse({
        expectedOrderVersion: n06Approved.value.orderVersion,
        expectedCurrentDeterminationVersion: null,
        handlerUserId: ids.production,
        tailInspectionCostBearer: null,
        processes: n07Processes,
      }),
      randomUUID(),
    )).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await database.query<{
      tail_inspection_cost_bearer: string;
      tail_inspection_cost_bearer_source: string;
    }>(
      `SELECT tail_inspection_cost_bearer,tail_inspection_cost_bearer_source
       FROM rework_orders WHERE rework_order_id=$1`,
      [submitted.value.reworkOrderId],
    )).rows[0]).toEqual({
      tail_inspection_cost_bearer: "processing_factory",
      tail_inspection_cost_bearer_source: "quality_inspection",
    });

    // Own-factory tail is a real responsibility share. Older clients omit
    // the tail row, so the service must derive it from the explicit choice.
    for (const badAllocation of [
      { responsibilityType: "own_factory", shareBps: 10000, multiplier: "1.200" },
      { responsibilityType: "processing_factory", shareBps: 10000, multiplier: "1.200", supplierId: factorySupplierId },
    ]) {
      const invalidDraft = {
        expectedOrderVersion: n06Approved.value.orderVersion,
        expectedCurrentDeterminationVersion: null, handlerUserId: ids.production,
        tailInspectionCostBearer: "own_factory",
        processes: [n07Processes[0], {
          configurationItemId: tailItem.configurationItemId,
          multiplier: "1.000", allocations: [badAllocation],
        }],
      };
      if (badAllocation.responsibilityType === "own_factory") {
        // The wire contract rejects a non-1 own-factory multiplier before
        // the application service is called; assert that synchronous boundary.
        expect(() => CreateResponsibilityDraftSchema.parse(invalidDraft))
          .toThrow("Own-factory responsibility multiplier must be 1");
      } else {
        // A valid external allocation still conflicts with the explicit
        // own-factory tail bearer, which the application service must reject.
        await expect(responsibility.saveDraft(
          production(), submitted.value.reworkOrderId,
          CreateResponsibilityDraftSchema.parse(invalidDraft), randomUUID(),
        )).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      }
    }
    const ownTailDraft = await responsibility.saveDraft(
      production(), submitted.value.reworkOrderId,
      CreateResponsibilityDraftSchema.parse({
        expectedOrderVersion: n06Approved.value.orderVersion,
        expectedCurrentDeterminationVersion: null, handlerUserId: ids.production,
        tailInspectionCostBearer: "own_factory", processes: [n07Processes[0]],
      }), randomUUID(),
    );
    expect(ownTailDraft.value.determination).toMatchObject({ calculationTotal: "172.00" });
    expect(ownTailDraft.value.determination!.processes).toHaveLength(2);
    expect(ownTailDraft.value.determination!.processes.find(
      (process) => process.configurationItemId === tailItem.configurationItemId,
    )).toMatchObject({
      baseAmount: "40.00", responsibilityAmount: "40.00",
      allocations: [expect.objectContaining({ responsibilityType: "own_factory", shareBps: 10000, multiplier: "1.000", roundedAmount: "40.00" })],
    });

    const n07Draft = await responsibility.saveDraft(
      production(),
      submitted.value.reworkOrderId,
      CreateResponsibilityDraftSchema.parse({
        expectedOrderVersion: ownTailDraft.value.orderVersion,
        expectedCurrentDeterminationVersion: ownTailDraft.value.determination!.version,
        handlerUserId: ids.production,
        tailInspectionCostBearer: "processing_factory",
        processes: n07Processes,
      }),
      randomUUID(),
    );
    expect(n07Draft.value.determination).toMatchObject({
      stage: "draft",
      calculationTotal: "180.00",
    });
    expect(n07Draft.value.determination!.processes).toHaveLength(2);
    const workerResponsibility = n07Draft.value.determination!.processes.find(
      (process) => process.configurationItemId === approvedItem.configurationItemId,
    );
    expect(workerResponsibility).toMatchObject({
      baseAmount: "110.00",
      responsibilityAmount: "132.00",
      allocations: expect.arrayContaining([
        expect.objectContaining({
          responsibilityType: "fabric_supplier",
          shareBps: 3000,
          roundedAmount: "39.60",
        }),
        expect.objectContaining({
          responsibilityType: "processing_factory",
          shareBps: 7000,
          roundedAmount: "92.40",
        }),
      ]),
    });
    const tailResponsibility = n07Draft.value.determination!.processes.find(
      (process) => process.configurationItemId === tailItem.configurationItemId,
    );
    expect(tailResponsibility).toMatchObject({
      baseAmount: "40.00",
      responsibilityAmount: "48.00",
      allocations: [expect.objectContaining({
        responsibilityType: "processing_factory",
        shareBps: 10000,
        roundedAmount: "48.00",
      })],
    });
    const n07Final = await responsibility.finalize(
      production(),
      submitted.value.reworkOrderId,
      {
        expectedOrderVersion: n07Draft.value.orderVersion,
        expectedCurrentDeterminationVersion:
          n07Draft.value.determination!.version,
      },
      randomUUID(),
    );
    expect(n07Final.value.reworkStatus).toBe("completed");
    expect(n07Final.value.canOwnerSign).toBe(false);
    expect(n07Final.value.ownerSignature).toBeNull();
    const N07Notices = await database.query<{
      recipient_user_id: string;
      todo_type: string;
      category: string;
      status: string;
    }>(
      `SELECT recipient_user_id,todo_type,category,status
       FROM rework_todos
       WHERE entity_type='rework_order' AND entity_id=$1
         AND category='responsibility_finalized_notice'
       ORDER BY recipient_user_id`,
      [submitted.value.reworkOrderId],
    );
    expect(N07Notices.rows).toEqual([
      ids.embroideryMerchandiser,
      ids.merchandiser,
    ].sort().map((recipient_user_id) => ({
      recipient_user_id,
      todo_type: "information",
      category: "responsibility_finalized_notice",
      status: "pending",
    })));

    // Current-schema responsibility-card approvals must not transfer the handler.
    const cardRevision = async (reviewer: TrustedActorContext, paidAmount: string) => {
      await exerciseRevisionApproval({database, external, responsibility,
        orderId:submitted.value.reworkOrderId, configurationItemId:approvedItem.configurationItemId,
        requester:actor(ids.merchandiser,["order_merchandiser"],"external_responsibility:view","external_responsibility:request_revision","external_responsibility:sign"),
        reviewer, handler:production(), unauthorized:qc(),
        signer:actor(ids.ownerOne,["owner_group"],"responsibility:owner_sign","responsibility:determine"), paidAmount});
    };
    await cardRevision(actor(ids.ownerOne,["owner_group"],"responsibility:determine","external_responsibility:approve_revision"),"0");
    await cardRevision(actor(ids.patternRoot,["root_superuser"],"access:admin","responsibility:determine","external_responsibility:approve_revision"),"0");

    // Reopen an unpaid external determination: retire its active ledger and reuse N07/N09.
    const unpaidActor=actor(ids.production,["production_management"],"responsibility:determine","external_responsibility:approve_revision");
    const unpaidBefore=await responsibility.revisions.get(unpaidActor,submitted.value.reworkOrderId);
    const unpaid=await responsibility.revisions.reopen(unpaidActor,submitted.value.reworkOrderId,{expectedOrderVersion:unpaidBefore.orderVersion,expectedDeterminationVersion:unpaidBefore.currentVersion!,reason:"未扣款前更正责任资料"},randomUUID());
    expect(unpaid.value.paidAmount).toBe("0");
    expect((await database.query("SELECT count(*)::int count FROM rework_external_responsibility_cases WHERE rework_order_id=$1 AND status='superseded'",[submitted.value.reworkOrderId])).rows[0].count).toBe(6);
    const unpaidFinal=await responsibility.finalize(production(),submitted.value.reworkOrderId,{expectedOrderVersion:unpaid.value.orderVersion,expectedCurrentDeterminationVersion:unpaid.value.currentVersion!},randomUUID());
    // Real pending N08 cutover: existing legal recipients survive, Wu cannot sign even from a stale actor.
    const memberBindings = { li_zhonghao: ids.ownerOne, wu_yunfeng: ids.ownerTwo, li_junyue: ids.patternRoot };
    const memberCutover = await new MemberModuleBindingService(database).run(ids.patternRoot, memberBindings, true);
    expect(memberCutover.cancelled).toBeGreaterThan(0);
    expect(memberCutover.ownerTasksEnsured).toBe(0);
    const memberPending = await database.query<{ recipient_user_id: string }>("SELECT recipient_user_id FROM rework_todos WHERE entity_id=$1 AND category='owner_signature' AND status='pending'", [submitted.value.reworkOrderId]);
    expect(memberPending.rows.map(row => row.recipient_user_id).sort()).toEqual([ids.ownerOne, ids.patternRoot].sort());
    const deniedOwner = actor(ids.ownerTwo,["owner_group"],"responsibility:owner_sign","responsibility:determine");
    expect((await responsibility.get(deniedOwner,submitted.value.reworkOrderId)).canOwnerSign).toBe(false);
    await expect(responsibility.approveOwnerSignature(deniedOwner,submitted.value.reworkOrderId,{expectedOrderVersion:unpaidFinal.value.orderVersion},randomUUID())).rejects.toMatchObject({statusCode:403});
    await responsibility.approveOwnerSignature(actor(ids.ownerOne,["owner_group"],"responsibility:owner_sign","responsibility:determine"),submitted.value.reworkOrderId,{expectedOrderVersion:unpaidFinal.value.orderVersion},randomUUID());
    const historyActor = actor(ids.ownerOne, ["owner_group"], "responsibility:owner_sign");
    for (const node of ["initiation", "process_configuration", "ie_review", "work_reporting", "whole_order_review", "final_quantity_ie_review", "responsibility", "owner_signature"] as const) {
      const historical = await businessDetail.history(historyActor, submitted.value.reworkOrderId, node);
      expect(historical.node).toBe(node);
      if(node==='process_configuration'||node==='ie_review') {
        expect(historical.page?.configuration?.configuration?.items.length).toBeGreaterThan(0);
        expect(historical.page?.workerPlan).not.toBeNull();
      }
      if(node==='whole_order_review'||node==='final_quantity_ie_review') {
        expect(historical.page?.wholeOrderReview?.processes.length).toBeGreaterThan(0);
        expect(historical.page?.wholeOrderReview?.reports.some(report=>report.members.length>0)).toBe(true);
        expect(historical.page?.wholeOrderReview?.canReview).toBe(false);
        expect(historical.page?.wholeOrderReview?.canIeReview).toBe(false);
        for(const report of historical.page!.wholeOrderReview!.reports) {
          if(report.correctedAt) expect(Date.parse(report.correctedAt)).toBeLessThanOrEqual(Date.parse(historical.entry.at));
        }
        const first=historical.versions[0]!;
        const original=await businessDetail.history(historyActor,submitted.value.reworkOrderId,node,first.id);
        const confirmation=original.page?.wholeOrderReview?.finalConfirmation;
        if(confirmation?.reviewedAt) expect(Date.parse(confirmation.reviewedAt)).toBeLessThanOrEqual(Date.parse(first.at));
        expect(original.entry.id).toBe(first.id);
      }
      if(node==='responsibility'||node==='owner_signature') expect(historical.page?.responsibility?.determination).not.toBeNull();
      if(node==='work_reporting') expect(historical.page?.workTasks?.tasks.length).toBeGreaterThan(0);
      expect(historical.fields.find(field => field.label === "订单数量")?.value).toBe("1000");
      expect(historical.fields.find(field => field.label === "整查费用承担方")?.value).toBe("processing_factory");
      expect(historical.inspectionReport).toEqual(n01CoreInspectionReport("全链测试款"));
      expect(historical.versions.some(entry => entry.id === historical.entry.id)).toBe(true);
      if (node !== "initiation") expect(historical.sections.some(section => section.rows.length > 0)).toBe(true);
    }


    const externalCases = await database.query<{
      caseId: string;
      responsibilityType: string;
      supplierId: string;
      proposedAmount: string;
      status: string;
    }>(
      `SELECT case_id AS "caseId",
              responsibility_type AS "responsibilityType",
              supplier_id AS "supplierId",
              proposed_deduction_amount::text AS "proposedAmount",
              status
       FROM rework_external_responsibility_cases
       WHERE rework_order_id=$1 AND status<>'superseded'
       ORDER BY responsibility_type`,
      [submitted.value.reworkOrderId],
    );
    expect(externalCases.rows.map((item) => ({
      responsibilityType: item.responsibilityType,
      supplierId: item.supplierId,
      proposedAmount: item.proposedAmount,
      status: item.status,
    }))).toEqual([
      {
        responsibilityType: "fabric_supplier",
        supplierId: fabricSupplierId,
        proposedAmount: "39.60",
        status: "deduction_follow_up",
      },
      {
        responsibilityType: "processing_factory",
        supplierId: factorySupplierId,
        proposedAmount: "140.40",
        status: "deduction_follow_up",
      },
    ]);
    expect((await database.query<{ status: string }>(
      "SELECT status FROM rework_orders WHERE rework_order_id=$1",
      [submitted.value.reworkOrderId],
    )).rows[0]).toEqual({ status: "completed" });

    // N11 / PR-07 - exact deductions close normally; partial or failed
    // deductions require one append-only finance-director decision.
    const processingCaseId = externalCases.rows.find(
      (item) => item.responsibilityType === "processing_factory",
    )!.caseId;
    const fabricCaseId = externalCases.rows.find(
      (item) => item.responsibilityType === "fabric_supplier",
    )!.caseId;
    const initialProcessingCase = await external.getCase(
      factoryPayables("external_deduction:record"),
      processingCaseId,
    );
    const voucherIds = [randomUUID(),randomUUID()];
    for (const [index,id] of voucherIds.entries()) await database.query(
      `INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
       VALUES($1,$2,$3,$4,10,$5,$6,'ready',CURRENT_TIMESTAMP)`,
      [id,`test/voucher/${id}`,index===0?'扣款凭证.png':'特批凭证.pdf',index===0?'image/png':'application/pdf','a'.repeat(64),ids.factoryPayables]);
    const partialDeduction = await external.recordDeduction(
      factoryPayables("external_deduction:record"),
      processingCaseId,
      CreateExternalDeductionEntrySchema.parse({
        expectedCaseVersion: initialProcessingCase.caseVersion,
        entryType: "deduction",
        amount: "80.00",
        deductedOn: new Date().toISOString().slice(0, 10),
        attachmentIds: [voucherIds[0]],
      }),
      randomUUID(),
    );
    await expect(external.close(
      factoryPayables("external_deduction:close"),
      processingCaseId,
      CloseExternalDeductionCaseSchema.parse({
        expectedCaseVersion: partialDeduction.value.caseVersion,
        result: "full",
        evidenceAttachmentIds: [],
      }),
      randomUUID(),
    )).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const firstRequest = await external.requestSpecialApproval(
      factoryPayables("external_deduction:close"),
      processingCaseId,
      RequestExternalDeductionSpecialApprovalSchema.parse({
        expectedCaseVersion: partialDeduction.value.caseVersion,
        reason: "供应商只确认扣款 80 元",
        attachmentIds: [voucherIds[1]],
      }),
      randomUUID(),
    );
    expect(firstRequest.value).toMatchObject({
      status: "pending_special_approval",
      canRequestSpecialApproval: false,
      specialApproval: {
        requestVersion: 1,
        proposedAmount: "140.40",
        actualDeductedAmount: "80.00",
        remainingAmount: "60.40",
        decision: null,
      },
    });
    expect((await database.query<{
      recipientUserId: string;
      provider: string;
      outcome: string;
    }>(
      `SELECT todo.recipient_user_id AS "recipientUserId",
              attempt.provider,attempt.outcome
       FROM rework_todos todo
       JOIN todo_delivery_attempts attempt USING(todo_id)
       WHERE todo.category='external_deduction_special_approval'
         AND todo.entity_id=$1
       ORDER BY attempt.attempted_at DESC LIMIT 1`,
      [submitted.value.reworkOrderId],
    )).rows[0]).toEqual({
      recipientUserId: ids.financeDirector,
      provider: "dingtalk",
      outcome: "queued",
    });

    await expect(external.approveSpecialApproval(actor(ids.financeRead,['finance_read'],'external_deduction:special_approve'),processingCaseId,
      {expectedCaseVersion:firstRequest.value.caseVersion,expectedRequestVersion:1},randomUUID())).rejects.toMatchObject({statusCode:403});
    const readOnlyHttp=Fastify();
    registerExternalResponsibilityRoutes(readOnlyHttp,{service:external,authenticate:async()=>({id:ids.financeRead,businessRoles:['finance_read'],capabilities:['external_responsibility:view','rework:finance_nodes:read']})});
    try { expect((await readOnlyHttp.inject({method:'POST',url:`/external-responsibility-cases/${processingCaseId}/special-approval/approve`,headers:{'idempotency-key':randomUUID()},payload:{expectedCaseVersion:firstRequest.value.caseVersion,expectedRequestVersion:1}})).statusCode).toBe(403); }
    finally {await readOnlyHttp.close();}
    const returned = await external.returnSpecialApproval(
      financeDirector(),
      processingCaseId,
      ReturnExternalDeductionSpecialApprovalSchema.parse({
        expectedCaseVersion: firstRequest.value.caseVersion,
        expectedRequestVersion: 1,
        reason: "请继续与供应商核对差额",
      }),
      randomUUID(),
    );
    expect(returned.value).toMatchObject({
      status: "deduction_follow_up",
      specialApproval: { decision: { decision: "returned" } },
    });
    const secondRequest = await external.requestSpecialApproval(
      factoryPayables("external_deduction:close"),
      processingCaseId,
      RequestExternalDeductionSpecialApprovalSchema.parse({
        expectedCaseVersion: returned.value.caseVersion,
        reason: "供应商确认最终只能扣款 80 元",
        attachmentIds: [],
      }),
      randomUUID(),
    );
    expect(secondRequest.value.specialApproval).toMatchObject({
      requestVersion: 2,
      decision: null,
    });
    const speciallyClosed = await external.approveSpecialApproval(
      financeDirector(),
      processingCaseId,
      ApproveExternalDeductionSpecialApprovalSchema.parse({
        expectedCaseVersion: secondRequest.value.caseVersion,
        expectedRequestVersion: 2,
        reason: "确认按实际扣款关闭",
      }),
      randomUUID(),
    );
    expect(speciallyClosed.value).toMatchObject({
      status: "closed",
      closure: {
        result: "partial",
        proposedAmount: "140.40",
        actualDeductedAmount: "80.00",
        remainingAmount: "60.40",
      },
      specialApproval: { decision: { decision: "approved" } },
    });
    await expect(database.query(
      "UPDATE rework_external_deduction_special_decisions SET reason='tampered' WHERE special_request_id=$1",
      [speciallyClosed.value.specialApproval!.requestId],
    )).rejects.toThrow();

    let initialFabricCase = await external.getCase(
      fabricPayables("external_deduction:record"),
      fabricCaseId,
    );
    const zeroRequest=await external.requestSpecialApproval(fabricPayables("external_deduction:close"),fabricCaseId,
      {expectedCaseVersion:initialFabricCase.caseVersion,reason:"暂未实际扣款，申请确认",attachmentIds:[]},randomUUID());
    expect(zeroRequest.value.specialApproval).toMatchObject({actualDeductedAmount:"0.00",remainingAmount:"39.60"});
    initialFabricCase=(await external.returnSpecialApproval(financeDirector(),fabricCaseId,
      {expectedCaseVersion:zeroRequest.value.caseVersion,expectedRequestVersion:1,reason:"请继续核对实际扣款"},randomUUID())).value;
    const fullDeduction = await external.recordDeduction(
      fabricPayables("external_deduction:record"),
      fabricCaseId,
      CreateExternalDeductionEntrySchema.parse({
        expectedCaseVersion: initialFabricCase.caseVersion,
        entryType: "deduction",
        amount: "39.60",
        deductedOn: new Date().toISOString().slice(0, 10),
        attachmentIds: [],
      }),
      randomUUID(),
    );
    const normallyClosed = await external.close(
      fabricPayables("external_deduction:close"),
      fabricCaseId,
      CloseExternalDeductionCaseSchema.parse({
        expectedCaseVersion: fullDeduction.value.caseVersion,
        result: "full",
        evidenceAttachmentIds: [],
      }),
      randomUUID(),
    );
    expect(normallyClosed.value).toMatchObject({
      status: "closed",
      closure: { result: "full", remainingAmount: "0.00" },
    });

    /* Historical N08-B scenario retained below as reference only. Current V2
       N09/N11 execution is covered by the active assertions and Root double pass.
    expect(externalBatch!.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        responsibilityType: "processing_factory",
        supplier: expect.objectContaining({ supplierId: factorySupplierId }),
        proposedDeductionAmount: "66.00",
        actualDeductedAmount: "0.00",
        status: "deduction_follow_up",
        caseVersion: 1,
      }),
      expect.objectContaining({
        responsibilityType: "fabric_supplier",
        supplier: expect.objectContaining({ supplierId: fabricSupplierId }),
        proposedDeductionAmount: "16.50",
      }),
    ]));
    const externalCase = externalBatch!.cases.find(
      (item) => item.responsibilityType === "processing_factory",
    )!;
    const deduction = await external.recordDeduction(
      payables(),
      externalCase.caseId,
      CreateExternalDeductionEntrySchema.parse({
        expectedCaseVersion: externalCase.caseVersion,
        entryType: "deduction",
        amount: "66.00",
        deductedOn: new Date().toISOString().slice(0, 10),
        attachmentIds: [],
      }),
      randomUUID(),
    );
    expect(deduction.value).toMatchObject({
      status: "deduction_follow_up",
      actualDeductedAmount: "66.00",
      remainingAmount: "0.00",
    });
    const fabricCase = externalBatch!.cases.find(
      (item) => item.responsibilityType === "fabric_supplier",
    )!;
    const fabricDeduction = await external.recordDeduction(
      fabricPayables(),
      fabricCase.caseId,
      CreateExternalDeductionEntrySchema.parse({
        expectedCaseVersion: fabricCase.caseVersion,
        entryType: "deduction",
        amount: "16.50",
        deductedOn: new Date().toISOString().slice(0, 10),
        attachmentIds: [],
      }),
      randomUUID(),
    );
    expect(fabricDeduction.value).toMatchObject({
      status: "deduction_follow_up",
      actualDeductedAmount: "16.50",
      remainingAmount: "0.00",
    });
    const embroideryBatch = await external.get(
      embroideryMerchandiser(),
      submitted.value.reworkOrderId,
    );
    expect(embroideryBatch).not.toBeNull();
    const embroideryCase = embroideryBatch!.cases[0]!;
    expect(embroideryCase).toMatchObject({
      responsibilityType: "embroidery_factory",
      supplier: { supplierId: embroiderySupplierId },
      proposedDeductionAmount: "16.50",
      status: "deduction_follow_up",
    });
    const embroideryDeduction = await external.recordDeduction(
      embroideryPayables(),
      embroideryCase.caseId,
      CreateExternalDeductionEntrySchema.parse({
        expectedCaseVersion: embroideryCase.caseVersion,
        entryType: "deduction",
        amount: "16.50",
        deductedOn: new Date().toISOString().slice(0, 10),
        attachmentIds: [],
      }),
      randomUUID(),
    );
    expect(embroideryDeduction.value).toMatchObject({
      status: "deduction_follow_up",
      actualDeductedAmount: "16.50",
      remainingAmount: "0.00",
    });
    expect((await database.query<{ status: string }>(
      "SELECT status FROM rework_orders WHERE rework_order_id=$1",
      [submitted.value.reworkOrderId],
    )).rows[0]).toEqual({ status: "completed" });

    // N10-B - actual deduction remains a separate lifecycle after N09.
    const closed = await external.close(
      payables(),
      externalCase.caseId,
      CloseExternalDeductionCaseSchema.parse({
        expectedCaseVersion: deduction.value.caseVersion,
        result: "full",
        evidenceAttachmentIds: [],
      }),
      randomUUID(),
    );
    expect(closed.value).toMatchObject({
      status: "closed",
      closure: {
        result: "full",
        proposedAmount: "66.00",
        actualDeductedAmount: "66.00",
        remainingAmount: "0.00",
      },
    });
    await external.close(
      fabricPayables(),
      fabricCase.caseId,
      CloseExternalDeductionCaseSchema.parse({
        expectedCaseVersion: fabricDeduction.value.caseVersion,
        result: "full",
        evidenceAttachmentIds: [],
      }),
      randomUUID(),
    );
    await external.close(
      embroideryPayables(),
      embroideryCase.caseId,
      CloseExternalDeductionCaseSchema.parse({
        expectedCaseVersion: embroideryDeduction.value.caseVersion,
        result: "full",
        evidenceAttachmentIds: [],
      }),
      randomUUID(),
    );
    expect((await database.query<{ status: string }>(
      "SELECT status FROM rework_orders WHERE rework_order_id=$1",
      [submitted.value.reworkOrderId],
    )).rows[0]).toEqual({ status: "completed" });
    */

    // Wage settlement remains independent from the closed business flow.
    // The current natural month is intentionally not force-locked: the service
    // must reach ready_to_lock and then enforce the month-end barrier. The
    // historical-month lock itself remains covered by wage-workflow-postgres.
    await expect(wages.list(actor(ids.tail,["tail_supervisor"],"wage:view"))).rejects.toMatchObject({statusCode:403});
    await expect(database.query("SELECT finance_authorized_wage_roles($1,'wage:view')",[ids.tail])).rejects.toThrow();
    const sharedReports = new ManagementReportingService(database);
    const operationalReader = actor(ids.tail,["tail_supervisor"],"dashboard:site:read","wage:view");
    const operationalPage = await sharedReports.listReworkOrders(operationalReader,{limit:100,page:1});
    expect(operationalPage.items.length).toBeGreaterThan(0);
    expect(operationalPage.items.every(item => item.wageAmount === undefined)).toBe(true);
    const sitePage = await sharedReports.siteDashboard(operationalReader,{});
    expect(sitePage.kpis).not.toHaveProperty("pendingWageReview");
    expect(sitePage.recentOrders.every(item => item.wageAmount === undefined)).toBe(true);
    const financialPage = await sharedReports.listReworkOrders(actor(ids.ownerOne,["owner_group"],"report:view","wage:view"),{limit:100,page:1});
    expect(financialPage.items.some(item => item.wageAmount === "150.00")).toBe(true);
    const periods = await wages.list(wageView());
    expect(periods).toHaveLength(1);
    const wagePeriod = periods[0]!;
    expect(wagePeriod).toMatchObject({
      status: "ready_to_lock",
      sourceItemCount: 2,
      personCount: 2,
      totalAmount: "150.00",
    });
    const wageDetail = await wages.get(wageView(), wagePeriod.periodId);
    expect(wageDetail.items).toHaveLength(2);
    expect(wageDetail.items.reduce(
      (sum, item) => sum + Number(item.payableAmount),
      0,
    )).toBe(150);
    expect(wageDetail.period.totalAmount).toBe("150.00");
    await expect(wages.lock(
      monthCloseWage(),
      wagePeriod.periodId,
      wagePeriod.periodVersion,
      "全链测试月结",
      randomUUID(),
    )).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      statusCode: 409,
    });

    // Final reconciliation: no cross-node amount drift.
    const totals = await database.query<{
      report_total: string;
      responsibility_total: string;
      own_factory_total: string;
      external_total: string;
      wage_total: string;
    }>(
      `SELECT
         (SELECT sum(group_amount)::numeric(18,2)::text
          FROM rework_work_reports report
          WHERE rework_order_id=$1
            AND NOT EXISTS (
              SELECT 1 FROM rework_work_report_rejections rejection
              WHERE rejection.work_report_id=report.work_report_id
            )) report_total,
         (SELECT calculation_total::numeric(18,2)::text
          FROM rework_responsibility_determinations
          WHERE rework_order_id=$1 AND stage='finalized'
          ORDER BY determination_version DESC LIMIT 1) responsibility_total,
         (SELECT COALESCE(sum(allocation.rounded_amount),0)::numeric(18,2)::text
          FROM rework_responsibility_allocations allocation
          JOIN rework_responsibility_determinations determination
            ON determination.determination_id=allocation.determination_id
          WHERE determination.rework_order_id=$1
            AND determination.stage='finalized'
            AND allocation.responsibility_type='own_factory'
            AND NOT EXISTS(
              SELECT 1 FROM rework_responsibility_determinations successor
              WHERE successor.replaces_determination_id=determination.determination_id
            )) own_factory_total,
         (SELECT COALESCE(sum(proposed_deduction_amount),0)::numeric(18,2)::text
          FROM rework_external_responsibility_cases c JOIN rework_external_responsibility_batches b USING(batch_id) WHERE c.rework_order_id=$1 AND b.status='active') external_total,
         (SELECT sum(payable_amount)::numeric(18,2)::text
          FROM rework_wage_items WHERE rework_order_id=$1) wage_total`,
      [submitted.value.reworkOrderId],
    );
    expect(totals.rows[0]).toEqual({
      report_total: "150.00",
      responsibility_total: "180.00",
      own_factory_total: "0.00",
      external_total: "180.00",
      wage_total: "150.00",
    });
    const openBusinessTodos = await database.query<{ category: string }>(
      `SELECT category
       FROM rework_todos
       WHERE todo_type='business_action'
         AND status IN ('pending','blocked_recipient')
         AND (entity_id=$1 OR route_descriptor->>'entityId'=$1)
       ORDER BY category,todo_id`,
      [submitted.value.reworkOrderId],
    );
    expect(openBusinessTodos.rows).toEqual([]);

    await exerciseFinanceOrderQueries({database,external,orderId:submitted.value.reworkOrderId,unrelatedId:ids.otherPatternWorker,rootId:ids.patternRoot,beforeLedger:false,
      readers:[{userId:ids.factoryPayables,role:"factory_payables",types:["processing_factory"]},
        {userId:ids.fabricPayables,role:"fabric_payables",types:["fabric_supplier"]},
        {userId:ids.embroideryPayables,role:"embroidery_washing_payables",types:["embroidery_factory","washing_factory"]},
        {userId:ids.monthClose,role:"wage_month_close_accountant",types:[]},
        {userId:ids.financeDirector,role:"finance_director",types:"all"},{userId:ids.financeRead,role:"finance_read",types:"all"}]});

    // PR03: adding basic visibility never opens protected node readers, including for the original QC initiator.
    const basicQuality={...qc(),authorizationCapabilities:["tools:user","rework:initiate","rework:basic:view"]};
    await expect(configuration.get(basicQuality,submitted.value.reworkOrderId)).rejects.toMatchObject({statusCode:403});
    await expect(work.list(basicQuality,submitted.value.reworkOrderId)).rejects.toMatchObject({statusCode:403});
    await expect(wholeOrder.get(basicQuality,submitted.value.reworkOrderId)).rejects.toMatchObject({statusCode:403});
    await expect(responsibility.get(basicQuality,submitted.value.reworkOrderId)).rejects.toMatchObject({statusCode:403});

    await cardRevision(actor(ids.patternRoot,["root_superuser"],"access:admin","responsibility:determine","external_responsibility:approve_revision"),"119.60");

    // B PR08: completed/partially-paid orders reopen without rewriting wage or paid facts.
    const revisionActor = actor(ids.production,["production_management"],"responsibility:determine","external_responsibility:approve_revision");
    const ownerSignActor = () => actor(ids.ownerOne,["owner_group"],"responsibility:owner_sign","responsibility:determine");
    const revisionBefore = await responsibility.revisions.get(revisionActor,submitted.value.reworkOrderId);
    expect(revisionBefore.canReopen).toBe(true);
    const reopenInput = {expectedOrderVersion:revisionBefore.orderVersion,expectedDeterminationVersion:revisionBefore.currentVersion!,reason:"供应商补充资料，重新核对责任"};
    await expect(responsibility.revisions.reopen(qc(),submitted.value.reworkOrderId,reopenInput,randomUUID())).rejects.toMatchObject({statusCode:403});
    // A later owner assignment cannot gain the bound members' revision approval path.
    const revisionRoot=actor(ids.patternRoot,["root_superuser"],"access:admin");
    const ownerRoleAdmin=actor(ids.patternRoot,["root_superuser","owner_group"],"access:admin");
    const laterOwnerRole=await access.assignRole(ownerRoleAdmin,{userId:ids.otherPatternWorker,roleCode:"owner_group",reason:"验证名单启用后的新老板不能重判"});
    const revisionOwner=(userId:string)=>actor(userId,["owner_group"],"responsibility:determine","external_responsibility:approve_revision","business:read_all");
    try {
      for(const userId of [ids.otherPatternWorker,ids.ownerTwo]) {
        expect((await responsibility.revisions.get(revisionOwner(userId),submitted.value.reworkOrderId)).canReopen).toBe(false);
        await expect(responsibility.revisions.reopen(revisionOwner(userId),submitted.value.reworkOrderId,reopenInput,randomUUID())).rejects.toMatchObject({statusCode:403});
      }
      expect((await responsibility.revisions.get(revisionOwner(ids.ownerOne),submitted.value.reworkOrderId)).canReopen).toBe(true);
      expect((await responsibility.revisions.get(revisionRoot,submitted.value.reworkOrderId)).canReopen).toBe(true);
      expect((await responsibility.revisions.get(revisionActor,submitted.value.reworkOrderId)).orderVersion).toBe(revisionBefore.orderVersion);
    } finally { await access.revokeRole(ownerRoleAdmin,laterOwnerRole.assignmentId,"结束新老板重判隔离验收"); }
    const reopenKey=randomUUID();
    const reopened=await responsibility.revisions.reopen(revisionActor,submitted.value.reworkOrderId,reopenInput,reopenKey);
    expect(reopened.value).toMatchObject({status:"pending_responsibility_determination",paidAmount:"119.60"});
    expect((await responsibility.revisions.reopen(revisionActor,submitted.value.reworkOrderId,reopenInput,reopenKey)).reused).toBe(true);
    expect((await database.query("SELECT count(*)::int count FROM rework_todos WHERE entity_id=$1 AND category='responsibility_determination' AND status='pending'",[submitted.value.reworkOrderId])).rows[0].count).toBe(1);
    let revisedFinal=await responsibility.finalize(production(),submitted.value.reworkOrderId,{expectedOrderVersion:reopened.value.orderVersion,expectedCurrentDeterminationVersion:reopened.value.currentVersion!},randomUUID());
    expect(revisedFinal.value.reworkStatus).toBe("pending_owner_signature");
    const rejected=await responsibility.rejectOwnerSignature(ownerSignActor(),submitted.value.reworkOrderId,{expectedOrderVersion:revisedFinal.value.orderVersion},randomUUID());
    expect(rejected.value.reworkStatus).toBe("pending_responsibility_determination");
    const resaved=await responsibility.saveDraft(production(),submitted.value.reworkOrderId,CreateResponsibilityDraftSchema.parse({expectedOrderVersion:rejected.value.orderVersion,expectedCurrentDeterminationVersion:rejected.value.determination!.version,handlerUserId:ids.production,tailInspectionCostBearer:"processing_factory",processes:n07Processes.map(process=>({...process,allocations:process.allocations.map(allocation=>({...allocation,multiplier:allocation.responsibilityType==="processing_factory"&&process.configurationItemId!==tailItem.configurationItemId?"1.300":allocation.multiplier}))}))}),randomUUID());
    revisedFinal=await responsibility.finalize(production(),submitted.value.reworkOrderId,{expectedOrderVersion:resaved.value.orderVersion,expectedCurrentDeterminationVersion:resaved.value.determination!.version},randomUUID());
    const confirmed=await responsibility.approveOwnerSignature(ownerSignActor(),submitted.value.reworkOrderId,{expectedOrderVersion:revisedFinal.value.orderVersion},randomUUID());
    expect(confirmed.value.reworkStatus).toBe("completed");
    const newBatch=await external.get(factoryPayables("external_responsibility:view"),submitted.value.reworkOrderId);
    const newFactoryCase=newBatch!.cases.find(row=>row.responsibilityType==='processing_factory')!;
    expect(newFactoryCase).toMatchObject({actualDeductedAmount:"80.00",remainingAmount:"68.10"});
    expect(await financial(database,{from:"2000-01-01",to:"2100-12-31",asOf:new Date()})).toMatchObject({externalProposed:"187.70",externalDeducted:"119.60",externalRemaining:"68.10"});
    const managementRows=await fetchFacts(database,{q:"UAT-FULL-CHAIN",limit:15});
    expect(managementRows.rows[0]).toMatchObject({external_proposed_amount:"187.70",external_deducted_amount:"119.60",external_remaining_amount:"68.10"});
    const newFabricId=(await database.query("SELECT case_id FROM rework_external_responsibility_cases WHERE rework_order_id=$1 AND responsibility_type='fabric_supplier' ORDER BY created_at DESC LIMIT 1",[submitted.value.reworkOrderId])).rows[0].case_id;
    const carriedFabric=await external.getCase(fabricPayables("external_deduction:record"),newFabricId);
    expect(carriedFabric).toMatchObject({actualDeductedAmount:"39.60",remainingAmount:"0.00"});
    await exerciseAtomicOverDeduction({database,external,projection:todoProjection,currentCase:newFactoryCase,
      payables:factoryPayables("external_deduction:record"),director:financeDirector(),
      reader:actor(ids.financeRead,["finance_read"],"external_responsibility:view"),productionId:ids.production,root:actor(ids.patternRoot,["root_superuser"],"access:admin")});
    await external.close(fabricPayables("external_deduction:close"),newFabricId,{expectedCaseVersion:carriedFabric.caseVersion,result:"full",evidenceAttachmentIds:[]},randomUUID());
    expect((await external.getCase(factoryPayables("external_responsibility:view"),processingCaseId)).actualDeductedAmount).toBe("80.00");
    expect((await wages.get(wageView(),wagePeriod.periodId)).items).toEqual(wageDetail.items);
    expect((await database.query("SELECT count(*)::int count,sum(amount)::text amount FROM rework_external_deduction_entries e JOIN rework_external_responsibility_cases c USING(case_id) WHERE c.rework_order_id=$1",[submitted.value.reworkOrderId])).rows[0]).toEqual({count:3,amount:"188.70"});
    const history=await responsibility.revisions.get(revisionActor,submitted.value.reworkOrderId);
    expect(history.revisions).toHaveLength(2);
    expect(history.history.some(row=>row.signature?.decision==='rejected')).toBe(true);
    expect(history.history.some(row=>row.signature?.decision==='approved')).toBe(true);

    // PR04: read actual historical records through the separate finance capability.
    const financeReader=actor(ids.financeDirector,["finance_director"],"rework:finance_nodes:read");
    const beforeRead=await database.query("SELECT version,status FROM rework_orders WHERE rework_order_id=$1",[submitted.value.reworkOrderId]);
    const reads=new Map();
    for(const node of FinanceNodeKeySchema.options){
      const read=await readFinanceNode(database,financeReader,submitted.value.reworkOrderId,node);
      for(const section of read.sections)for(const row of section.rows)expect(row.length).toBe(section.columns.length);
      reads.set(node,read);
    }
    expect(reads.get('process_configuration').sections.find((s:{title:string})=>s.title==='工序与核价记录').rows.length).toBeGreaterThan(0);
    expect(reads.get('process_configuration').sections.find((s:{title:string})=>s.title==='工人预分配').rows.length).toBeGreaterThan(0);
    expect(reads.get('work_reporting').sections.find((s:{title:string})=>s.title==='报工记录').rows.length).toBeGreaterThan(0);
    expect(reads.get('final_quantity_ie_review').sections.find((s:{title:string})=>s.title==='最终数量与 IE 复核').rows.length).toBeGreaterThan(0);
    expect(reads.get('whole_order_review').sections.find((section:{title:string})=>section.title==='数量调整记录'))
      .toEqual(reads.get('quantity_adjustment').sections.find((section:{title:string})=>section.title==='数量调整记录'));
    expect(reads.get('responsibility').sections.find((s:{title:string})=>s.title==='责任计算明细').rows.length).toBeGreaterThan(0);
    expect(reads.get('owner_signature').sections.find((s:{title:string})=>s.title==='老板签字记录').rows.some((row:string[])=>row.includes('rejected'))).toBe(true);
    expect(reads.get('settlement_ledger').sections.find((s:{title:string})=>s.title==='实际扣款明细').rows).toHaveLength(3);
    expect(reads.get('settlement_ledger').sections.find((s:{title:string})=>s.title==='工资明细').rows.length).toBeGreaterThan(0);
    await expect(readFinanceNode(database,qc(),submitted.value.reworkOrderId,'responsibility')).rejects.toMatchObject({statusCode:403});
    await expect(configuration.saveDraft(financeReader,submitted.value.reworkOrderId,n02Input,randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(configuration.submit(financeReader,submitted.value.reworkOrderId,{expectedOrderVersion:n02Saved.value.orderVersion,expectedConfigurationVersion:n02Saved.value.configuration!.configurationVersion},randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(wholeOrder.reviewFinalQuantity(financeReader,submitted.value.reworkOrderId,{expectedOrderVersion:n06View.orderVersion,decision:"approved"},randomUUID())).rejects.toMatchObject({statusCode:403});
    const forged={...financeReader,actorId:ids.qc};
    await expect(readFinanceNode(database,forged,submitted.value.reworkOrderId,'responsibility')).rejects.toThrow();
    await expect(database.query("SELECT access_authorized_actor_roles($1,'process:configure')",[ids.financeDirector])).rejects.toThrow();
    await expect(database.query("SELECT access_authorized_actor_roles($1,'responsibility:owner_sign')",[ids.financeDirector])).rejects.toThrow();
    expect((await database.query("SELECT version,status FROM rework_orders WHERE rework_order_id=$1",[submitted.value.reworkOrderId])).rows).toEqual(beforeRead.rows);
    expect((await wages.get(wageView(),wagePeriod.periodId)).items).toEqual(wageDetail.items);
    expect(await businessDetail.canDownloadBoundAttachment(financeReader,{entityType:'external_responsibility_case',entityId:processingCaseId})).toBe(true);
    // 2026-09-15: identical finance reads, historical voucher scope, no new writes.
    const globalReader=actor(ids.financeRead,["finance_read"],"rework:finance_nodes:read","external_responsibility:view","tools:user","wage:settlement_mark");
    for (const node of FinanceNodeKeySchema.options) expect(await readFinanceNode(database,globalReader,submitted.value.reworkOrderId,node)).toEqual(reads.get(node));
    const historicalBatch=await external.get(globalReader,submitted.value.reworkOrderId);
    expect(historicalBatch!.canAllocateSuppliers).toBe(false);
    const historicalCase=historicalBatch!.historicalCases!.find(item=>item.caseId===processingCaseId)!;
    expect(historicalCase.evidenceAttachments?.map(file=>file.attachmentId).sort()).toEqual([...voucherIds].sort());
    expect(historicalCase.specialApprovalHistory?.map(request=>request.decision?.decision)).toEqual(['approved','returned']);
    expect(historicalCase.specialApprovalHistory?.[1]?.attachmentIds).toEqual([voucherIds[1]]);
    expect(historicalCase.deductions[0]?.attachmentIds).toEqual([voucherIds[0]]);
    expect(historicalCase).toMatchObject({canRecordDeduction:false,canRequestSpecialApproval:false,canDecideSpecialApproval:false,canApproveRevision:false});
    const historicalOwner=await external.getCase(factoryPayables("external_responsibility:view"),processingCaseId);
    expect(historicalOwner).toMatchObject({canRecordDeduction:false,canRequestSpecialApproval:false,canFollowUp:false});
    expect(await businessDetail.canDownloadBoundAttachment(globalReader,{entityType:'external_responsibility_case',entityId:processingCaseId})).toBe(true);
    expect(await businessDetail.canDownloadBoundAttachment(fabricPayables('external_responsibility:view'),{entityType:'external_responsibility_case',entityId:processingCaseId})).toBe(false);
    expect((await businessDetail.get(fabricPayables('external_responsibility:view'),submitted.value.reworkOrderId)).attachments.some(file=>voucherIds.includes(file.attachmentId))).toBe(false);
    await expect(database.query("SELECT access_authorized_actor_roles($1,'external_deduction:special_approve')",[ids.financeRead])).rejects.toThrow();
    expect((await database.query("SELECT finance_authorized_wage_roles($1,'wage:settlement_mark')",[ids.financeRead])).rowCount).toBe(1);

    let current=globalReader;
    let grants=0;
    const fileService=new AttachmentService(database,{createDownloadGrant:async()=>{grants++;return {downloadUrl:'https://example.invalid/test-voucher',expiresAt:new Date(Date.now()+60000).toISOString()};}} as unknown as ObjectStorage,{prefix:'test',ttlSeconds:60,maxUploadBytes:1000});
    const app=Fastify();
    const authenticate=async()=>({id:current.actorId,businessRoles:current.actorRoles,capabilities:current.authorizationCapabilities!});
    registerExternalResponsibilityRoutes(app,{service:external,authenticate});
    registerToolsRoutes(app,{attachments:fileService,exports:{} as ExportJobService,authenticate,
      canDownloadBoundAttachment:async(user,binding)=>businessDetail.canDownloadBoundAttachment({...current,actorId:user.actorId,actorRoles:user.actorRoles,authorizationCapabilities:user.capabilities},binding)});
    try {
      const httpBatch=await app.inject({url:`/rework-orders/${submitted.value.reworkOrderId}/external-responsibilities`});
      expect(httpBatch.statusCode,httpBatch.body).toBe(200);
      expect((await app.inject({url:`/tools/attachments/${voucherIds[0]}/download`})).statusCode).toBe(200);
      const writes=[['deductions',{expectedCaseVersion:historicalCase.caseVersion,entryType:'deduction',amount:'1.00',deductedOn:'2026-09-15',attachmentIds:[]}],
        ['special-approval/approve',{expectedCaseVersion:historicalCase.caseVersion,expectedRequestVersion:2}]] as const;
      for(const [path,payload] of writes) expect([403,409]).toContain((await app.inject({method:'POST',url:`/external-responsibility-cases/${processingCaseId}/${path}`,headers:{'idempotency-key':randomUUID()},payload})).statusCode);
      current=actor(ids.fabricPayables,['fabric_payables'],'external_responsibility:view','tools:user');
      expect((await app.inject({url:`/external-responsibility-cases/${processingCaseId}`})).statusCode).toBe(403);
      expect((await app.inject({url:`/tools/attachments/${voucherIds[0]}/download`})).statusCode).toBe(403);
      current=actor(ids.factoryPayables,['factory_payables'],'external_responsibility:view','tools:user');
      expect((await app.inject({url:`/tools/attachments/${voucherIds[1]}/download`})).statusCode).toBe(200);
      expect(grants).toBe(2);
    } finally {await app.close();}



  });

  const financeWages = (id = ids.financeDirector, roles = ["finance_director"]) => actor(id, roles, "wage:view", "wage:export", "wage:settlement_mark");
  const allWageDates = { from: "2020-01-01", to: "2099-12-31", limit: 500 };

  it("materializes each eligible source once, conserves old cents rules and shares the legacy wage selection", async () => {
    const reporting = new ManagementReportingService(database), finance = financeWages();
    const rows = (await database.query(`SELECT w.*,s.amount::text exact_amount FROM pattern_room_wage_items w
      JOIN pattern_room_segments s USING(segment_id) ORDER BY w.wage_item_id`)).rows;
    expect(rows.length).toBeGreaterThan(10);
    expect(new Set(rows.map(row => row.segment_id)).size).toBe(rows.length);
    expect(new Set(rows.map(row => row.wage_type))).toEqual(new Set(["first_pattern", "pattern_rework", "misc"]));
    for (const row of rows) expect(Number(row.payable_amount)).toBeGreaterThan(0);
    const balances = await database.query(`SELECT round_id,sum(payable_amount)=round(max(round_amount),2) balanced FROM pattern_room_wage_items GROUP BY round_id`);
    expect(balances.rows.every(row => row.balanced)).toBe(true);
    const transferred = rows.filter(row => row.style_no === "PATTERN-换人及多轮");
    expect(transferred).toHaveLength(4);
    expect(transferred.find(row => row.wage_type === "pattern_rework")?.payable_amount).toBe("7.01");
    const misc = rows.filter(row => row.task_name === "MISC-分段实际工时");
    expect(misc.map(row => row.payable_amount).sort()).toEqual(["2.85", "34.27"]);
    expect(rows.some(row => row.release_basis === "pattern_cancel_fees" && row.cancellation)).toBe(true);
    expect(rows.some(row => row.release_basis === "misc_stop" && row.cancellation)).toBe(true);
    const legacyBefore = (await database.query("SELECT * FROM rework_wage_items ORDER BY wage_item_id")).rows;
    const legacy = await reporting.report(finance, "wages", { ...allWageDates, wageSource: "order_rework" });
    expect(legacy.totals.wageAmount).toBe("150.00");
    const pattern = await reporting.report(finance, "wages", { ...allWageDates, wageSource: "pattern_room" });
    const combined = await reporting.report(finance, "wages", allWageDates);
    const sourceReader=actor(ids.monthClose,["wage_month_close_accountant"],"pattern_room:orders:view");
    const sourceOrders=new PatternRoomOrderService(database,todoProjection);
    for(const line of pattern.rows) {
      expect(line.sourceStatus).toBe("available");
      const source=rows.find(row=>row.wage_item_id===line.lineId)!;
      expect(line).toMatchObject({sourceOrderId:source.order_id,roundId:source.round_id,segmentId:source.segment_id});
      const original=await sourceOrders.get(sourceReader,String(line.sourceOrderId));
      expect(original.rounds.find(round=>round.roundId===line.roundId)?.segments.some(segment=>segment.segmentId===line.segmentId)).toBe(true);
      expect(original.attachments).toEqual([]);
      expect(Object.values(original.actions).every(value=>!value)).toBe(true);
    }
    expect(legacy.rows.every(row=>row.sourceStatus==="available"&&row.sourceOrderId===row.reworkOrderId)).toBe(true);
    await expect(new PatternRoomPriceService(database).management(actor(ids.monthClose,["wage_month_close_accountant"],"pattern_room:prices:read"))).rejects.toMatchObject({statusCode:403});
    const cents = (value: string) => BigInt(value.replace(".", ""));
    expect(cents(combined.totals.wageAmount!)).toBe(cents(legacy.totals.wageAmount!) + cents(pattern.totals.wageAmount!));
    expect(combined.wageSummary!.people.filter(person => person.personId === workerPersonId)).toHaveLength(1);
    expect(combined.wageSummary!.people.find(person => person.personId === workerPersonId)!.sources.some(source => source.source === "order_rework")).toBe(true);
    for (const kind of ["first_pattern", "pattern_rework", "misc"] as const) {
      const filtered = await reporting.report(finance, "wages", { ...allWageDates, wageSource: "pattern_room", patternKind: kind });
      expect(filtered.rows.length).toBeGreaterThan(0); expect(filtered.rows.every(row => row.wageKind === kind)).toBe(true);
    }
    const oldPreview = await reporting.previewWageSettlement(finance, { ...allWageDates, wageSource: "order_rework" });
    expect((await reporting.markWageSettlement(finance, { ...allWageDates, wageSource: "order_rework" }, oldPreview.lineIds)).markedCount).toBe(oldPreview.lineCount);
    const oldMarks = (await database.query("SELECT * FROM rework_wage_settlement_marks ORDER BY line_id")).rows;
    expect((await reporting.markWageSettlement(finance, allWageDates, oldPreview.lineIds)).markedCount).toBe(0);
    expect((await database.query("SELECT * FROM rework_wage_settlement_marks ORDER BY line_id")).rows).toEqual(oldMarks);
    expect((await database.query("SELECT * FROM rework_wage_items ORDER BY wage_item_id")).rows).toEqual(legacyBefore);
    const first = rows[0]!;
    await expect(database.query("UPDATE pattern_room_wage_items SET payable_amount=1 WHERE wage_item_id=$1", [first.wage_item_id])).rejects.toThrow();
    await expect(database.query("DELETE FROM pattern_room_wage_items WHERE wage_item_id=$1", [first.wage_item_id])).rejects.toThrow();
    await expect(database.query("INSERT INTO pattern_room_wage_items SELECT * FROM pattern_room_wage_items LIMIT 1")).rejects.toMatchObject({ code: "55000" });
    await expect(database.query("UPDATE pattern_room_segments SET amount=amount+1 WHERE segment_id=$1", [first.segment_id])).rejects.toMatchObject({ code: "55000" });
    await expect(database.query("UPDATE pattern_room_rounds SET completed_at=COALESCE(completed_at,CURRENT_TIMESTAMP)+interval '1 day' WHERE round_id=$1", [first.round_id])).rejects.toMatchObject({ code: "55000" });
    await database.query("SELECT materialize_pattern_round_wages($1)", [first.round_id]);
    expect((await database.query("SELECT count(*)::int count FROM pattern_room_wage_items")).rows[0].count).toBe(rows.length);
  });

  it("backfills the same release snapshots as live materialization after later misc cancellation", async () => {
    const service = new PatternRoomOrderService(database, todoProjection);
    const merchant = patternActor(ids.merchandiser, ["order_merchandiser"]), supervisor = patternActor(ids.patternSupervisor, ["pattern_room_supervisor"]);
    const price = (await new PatternRoomPriceService(database).management(actor(ids.patternRoot, ["root_superuser"], "pattern_room:prices:read"))).hourly;
    const created = await service.createMisc(merchant, { taskName: "MISC-完工后补工时取消", priceVersion: price.version }, randomUUID());
    const assigned = await service.assign(supervisor, created.orderId, { ...roundAction(created), personId: workerPersonId }, randomUUID());
    const complete = await service.complete(patternActor(ids.worker, ["pattern_room_worker"]), created.orderId, roundAction(assigned), randomUUID());
    await service.cancel(supervisor, created.orderId, { ...roundAction(complete), segmentId: complete.rounds[0]!.segments[0]!.segmentId, hours: "0.2", reason: "取消时才核定实际工时" }, randomUUID());
    const releaseColumns = "segment_id,payable_amount::text,period_month::text,release_basis,cancellation";
    const expected = (await database.query(`SELECT ${releaseColumns} FROM pattern_room_wage_items ORDER BY segment_id`)).rows;
    const oldMarks = (await database.query("SELECT line_id,wage_item_id,closure_line_id,marked_by,marked_at FROM rework_wage_settlement_marks WHERE pattern_wage_item_id IS NULL ORDER BY line_id")).rows;
    const historySchema = ownedPostgresSchema("pattern_backfill");
    await adminPool.query(`CREATE SCHEMA ${historySchema}`);
    const history = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${historySchema}` });
    try {
      // Copy genuine workflow sources, but no 0179 ledger/triggers, into an isolated pre-migration snapshot.
      for (const table of ["app_users", "business_people", "pattern_room_orders", "pattern_room_rounds", "pattern_room_segments", "rework_wage_items", "rework_wage_month_close_lines"]) {
        await history.query(`CREATE TABLE ${table} (LIKE ${schema}.${table} INCLUDING ALL)`);
        await history.query(`INSERT INTO ${table} SELECT * FROM ${schema}.${table}`);
      }
      await history.query("CREATE FUNCTION reject_operation_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$");
      const marksMigration = await readFile(new URL("../../apps/api/migrations/0171_wage_settlement_marks.sql", import.meta.url), "utf8");
      await history.query(marksMigration.slice(marksMigration.indexOf("CREATE TABLE rework_wage_settlement_marks")));
      await history.query(`INSERT INTO rework_wage_settlement_marks SELECT line_id,wage_item_id,closure_line_id,marked_by,marked_at FROM ${schema}.rework_wage_settlement_marks WHERE pattern_wage_item_id IS NULL`);
      await history.query(await readFile(new URL("../../apps/api/migrations/0179_pattern_room_unified_wages.sql", import.meta.url), "utf8"));
      expect((await history.query(`SELECT ${releaseColumns} FROM pattern_room_wage_items ORDER BY segment_id`)).rows).toEqual(expected);
      expect((await history.query("SELECT release_basis,cancellation FROM pattern_room_wage_items WHERE task_name='MISC-分段实际工时'")).rows).toEqual([{release_basis:"misc_complete",cancellation:false},{release_basis:"misc_complete",cancellation:false}]);
      expect((await history.query("SELECT release_basis,cancellation FROM pattern_room_wage_items WHERE task_name='MISC-完工后补工时取消'")).rows).toEqual([{release_basis:"misc_stop",cancellation:true}]);
      expect((await history.query("SELECT line_id,wage_item_id,closure_line_id,marked_by,marked_at FROM rework_wage_settlement_marks ORDER BY line_id")).rows).toEqual(oldMarks);
      const exported = await new ReportExportService(new ManagementReportingService(database), database, "pr06-backfill-verification").export(financeWages(), "wages", {...allWageDates,wageSource:"order_rework"});
      const xml = exported.content.toString("utf8"), sheet = [...xml.matchAll(/<worksheet[\s\S]*?<\/worksheet>/g)][1]![0];
      expect(xml).toContain('formatCode="#,##0.###"'); expect(sheet).toContain('s="4" t="n"');
    } finally { await history.end(); await adminPool.query(`DROP SCHEMA ${historySchema} CASCADE`); }
  });

  // Also invoked by the mapped-PostgreSQL gate with the default Vitest config.
  // Keep the existing business-chain 60s budget for this multi-step scenario.
  it("opens ordinary work with 501 exact wage IDs, real-person grouping, cross-month release and late unpaid rework", { timeout: 60_000 }, async () => {
    // Isolated scale fixture: real create/assign/complete/handoff; 500 historical segments are synthesized below.
    // It validates a large release and financial scope, not 501 claimed UI orders or production records.
    const service = new PatternRoomOrderService(database, todoProjection);
    const designer = patternActor(ids.patternDesigner, ["sample_designer"]), supervisor = patternActor(ids.patternSupervisor, ["pattern_room_supervisor"]), currentWorker = patternActor(ids.worker, ["pattern_room_worker"]);
    const reporting = new ManagementReportingService(database), finance = financeWages();
    const created = await makePattern(service, designer, "PR06-SCALE-MONTH", 14);
    const assigned = await service.assign(supervisor, created.orderId, { ...roundAction(created), personId: workerPersonId }, randomUUID());
    const segmentId = assigned.rounds[0]!.segments[0]!.segmentId;
    await database.query("UPDATE pattern_room_segments SET segment_index=501,amount=60,worker_name='同名验收人员' WHERE segment_id=$1", [segmentId]);
    await database.query(`INSERT INTO pattern_room_segments(segment_id,round_id,segment_index,person_id,worker_user_id,worker_name,person_type,amount,started_at,ended_at)
      SELECT gen_random_uuid(),$1,n,CASE WHEN n%2=0 THEN $2::uuid ELSE $3::uuid END,
        CASE WHEN n%2=0 THEN $4::uuid ELSE $5::uuid END,'同名验收人员','internal',1,CURRENT_TIMESTAMP-interval '2 hours',CURRENT_TIMESTAMP-interval '1 hour'
      FROM generate_series(1,500) n`, [created.currentRoundId, workerPersonId, otherPatternPersonId, ids.worker, ids.otherPatternWorker]);
    const complete = await service.complete(currentWorker, created.orderId, roundAction(assigned), randomUUID());
    const backdate = async (orderId: string, roundId: string) => {
      // Only unqualified test sources may be shifted; after materialization these facts are immutable.
      await database.query("UPDATE pattern_room_orders SET submitted_at='2026-08-31T01:00:00Z' WHERE order_id=$1", [orderId]);
      await database.query("UPDATE pattern_room_rounds SET requested_at='2026-08-31T01:00:00Z',assigned_at='2026-08-31T02:00:00Z',completed_at='2026-08-31T15:59:59Z' WHERE round_id=$1", [roundId]);
      await database.query("UPDATE pattern_room_segments SET started_at='2026-08-31T02:00:00Z',ended_at='2026-08-31T15:59:59Z',worker_completed_at=CASE WHEN worker_completed_at IS NULL THEN NULL ELSE '2026-08-31T15:59:59Z'::timestamptz END WHERE round_id=$1", [roundId]);
      await database.query("UPDATE pattern_room_node_times SET entered_at='2026-08-31T01:00:00Z',exited_at=CASE WHEN exited_at IS NULL THEN NULL ELSE '2026-08-31T15:59:59Z'::timestamptz END WHERE round_id=$1", [roundId]);
    };
    await backdate(created.orderId, created.currentRoundId);
    const filters = { from: "2026-08-01", to: "2026-08-31", wageSource: "pattern_room" as const, q: "PR06-SCALE-MONTH", limit: 500 };
    expect((await reporting.report(finance, "wages", filters)).wageSummary!.rowCount).toBe(0);
    const handed = await service.handoff(designer, created.orderId, roundAction(complete), randomUUID());
    const report = await reporting.report(finance, "wages", filters);
    expect(report.rows).toHaveLength(500); expect(report.truncated).toBe(true);
    expect(report.wageSummary).toMatchObject({ rowCount: 501, personCount: 2, pendingLineCount: 501, orderCount: 1, roundCount: 1 });
    expect(report.wageSummary!.people.map(person => person.name)).toEqual(["同名验收人员", "同名验收人员"]);
    expect(report.totals).toEqual({ wageAmount: "560.00", unsettledWageAmount: "560.00", settledWageAmount: "0.00" });
    expect(report.rows.every(row => row.periodMonth === "2026-08" && row.completedDate === "2026-08-31")).toBe(true);
    expect(report.rows.every(row => String(row.releasedAt) > "2026-09-01")).toBe(true);
    expect((await reporting.exportData(finance, "wages", filters)).data.rows).toHaveLength(501);
    const exporter = new ReportExportService(reporting, database, "pr06-isolated-verification");
    const xlsx = await exporter.export(finance, "wages", filters);
    const xml = xlsx.content.toString("utf8");
    const sheet = [...xml.matchAll(/<worksheet[\s\S]*?<\/worksheet>/g)][1]![0];
    expect((sheet.match(/<row r=/g) ?? []).length).toBe(502);
    expect(xml).toContain("首次打板"); expect(xml).toContain("工资来源"); expect(xml).toContain('formatCode="#,##0.###"');
    await exerciseWagePagination({database,reporting,actor:finance,filters});
    const preview = await reporting.previewWageSettlement(finance, filters);
    expect(preview).toMatchObject({ lineCount: 501, personCount: 2 });
    // A new August rework is confirmed after preview, so it must not inherit the old snapshot's mark.
    const request = await service.requestRework(designer, created.orderId, { ...roundAction(handed), reason: "后补交接验收", reasonCategory: "other" }, randomUUID());
    const rework = await service.assign(supervisor, created.orderId, { ...roundAction(request), personId: workerPersonId, amount: "1.005" }, randomUUID());
    const reworkComplete = await service.complete(currentWorker, created.orderId, roundAction(rework), randomUUID());
    await backdate(created.orderId, rework.currentRoundId);
    await service.handoff(designer, created.orderId, roundAction(reworkComplete), randomUUID());
    expect(await reporting.markWageSettlement(finance, filters, preview.lineIds)).toEqual({ markedCount: 501 });
    const marks = (await database.query("SELECT line_id,marked_by,marked_at FROM rework_wage_settlement_marks WHERE line_id=ANY($1::uuid[]) ORDER BY line_id", [preview.lineIds])).rows;
    expect(await reporting.markWageSettlement(financeWages(ids.monthClose, ["wage_month_close_accountant"]), filters, preview.lineIds)).toEqual({ markedCount: 0 });
    expect((await database.query("SELECT line_id,marked_by,marked_at FROM rework_wage_settlement_marks WHERE line_id=ANY($1::uuid[]) ORDER BY line_id", [preview.lineIds])).rows).toEqual(marks);
    const after = await reporting.report(finance, "wages", filters);
    expect(after.wageSummary).toMatchObject({ rowCount: 502, orderCount: 1, roundCount: 2, pendingLineCount: 1 });
    expect(after.totals).toEqual({ wageAmount: "561.01", settledWageAmount: "560.00", unsettledWageAmount: "1.01" });
    const unpaid = await reporting.report(finance, "wages", { ...filters, status: "unsettled" });
    expect(unpaid.rows).toHaveLength(1); expect(unpaid.rows[0]).toMatchObject({ wageKind: "pattern_rework", wageAmount: "1.01", markedAt: null });
    expect((await service.get(designer, created.orderId)).status).toBe("completed");
    expect((await database.query("SELECT count(*)::int count FROM rework_todos WHERE entity_id=$1 AND status='open' AND todo_type='actionable'", [created.orderId])).rows[0].count).toBe(0);
  });

  // Also invoked by the mapped-PostgreSQL gate with the default Vitest config.
  // Keep the existing business-chain 60s budget for this multi-step scenario.
  it("enforces real finance roles on unified HTTP report, settlement and XLSX with only minimal wage basis", { timeout: 60_000 }, async () => {
    const reporting = new ManagementReportingService(database), exporter = new ReportExportService(reporting, database, "pr06-http-verification");
    let current = financeWages(); const app = Fastify();
    registerManagementReportingRoutes(app, { service: reporting, exportService: exporter, authenticate: async () => ({ id: current.actorId, businessRoles: current.actorRoles, capabilities: ["wage:view", "wage:export", "wage:settlement_mark"] }) });
    const query = "from=2020-01-01&to=2099-12-31&wageSource=pattern_room&limit=500";
    try {
      for (const [id, role] of [[ids.financeDirector, "finance_director"], [ids.financeRead, "finance_read"], [ids.monthClose, "wage_month_close_accountant"], [ids.patternRoot, "root_superuser"], [ids.ownerOne, "owner_group"], [ids.production, "production_management"]] as const) {
        current = financeWages(id, [role]);
        const report = await app.inject({ url: `/management/reports/wages?${query}` });
        expect(report.statusCode).toBe(200);
        const body = report.json(); expect(body.rows.length).toBeGreaterThan(0);
        for (const row of body.rows) {expect(row).not.toHaveProperty("attachments");expect(row).not.toHaveProperty("customer");expect(row).not.toHaveProperty("requestReason");}
        expect((await app.inject({ url: `/management/reports/wages/export.xlsx?${query}` })).statusCode).toBe(200);
        expect((await app.inject({ url: `/management/wages/settlement-preview?${query}` })).statusCode).toBe(["owner_group", "production_management"].includes(role) ? 403 : 200);
      }
      for (const [id, role] of [[ids.patternSupervisor, "pattern_room_supervisor"], [ids.patternDesigner, "sample_designer"], [ids.worker, "pattern_room_worker"], [ids.merchandiser, "order_merchandiser"]] as const) {
        current = financeWages(id, [role]);
        for (const path of ["management/reports/wages", "management/reports/wages/export.xlsx", "management/wages/settlement-preview"]) expect((await app.inject({ url: `/${path}?${query}` })).statusCode).toBe(403);
        expect((await app.inject({ method: "POST", url: "/management/wages/settlement", payload: { filters: allWageDates, lineIds: [randomUUID()] } })).statusCode).toBe(403);
        // Forged financial role in a cached caller context cannot substitute for current database authority.
        await expect(reporting.report(financeWages(id), "wages", allWageDates)).rejects.toThrow();
      }
    } finally { await app.close(); }
  });

  it.each([200, 180])("recovers a required-tail order only after every unified worker and tail task has a valid report (%i pieces)", async (reportedQuantity) => {
    const imageId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'n04-required-tail-recovery.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [imageId, `private/${imageId}.webp`, "b".repeat(64), ids.qc],
    );
    const draft = await initiation.createDraft(qc(), {
      styleNo: "UAT-N04-REQUIRED-TAIL-RECOVERY",
      orderQuantity: 500,
      orderNo: "ORDER-N04-REQUIRED-TAIL-RECOVERY",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "supplier", supplierId: factorySupplierId },
      tailInspectionCostBearer: "processing_factory",
      inspectionReport: n01CoreInspectionReport("节点04需要尾查恢复测试款"),
      problemPart: "后幅",
      problemDescription: "普通返工与尾查均已上数但状态仍停在节点04",
      reworkQuantity: 200,
      attachmentIds: [imageId],
    }, randomUUID());
    const submitted = await initiation.submit(
      qc(), draft.value.reworkOrderId, { expectedVersion: draft.value.version }, randomUUID(),
    );
    const saved = await configuration.saveDraft(
      tailConfigure(),
      submitted.value.reworkOrderId,
      SaveProcessConfigurationSchema.parse({
        expectedOrderVersion: submitted.value.version,
        items: [{
          source: "catalog",
          processId: publicProcessId,
          executionKind: "worker",
          plannedQuantity: 200,
          pricingUnit: "piece",
          unitPrice: 0.55,
        }, {
          source: "custom",
          customProcessName: "尾查",
          executionKind: "tail_inspection",
          plannedQuantity: 1,
          pricingUnit: "piece",
          unitPrice: 0.2,
        }],
      }),
      randomUUID(),
    );
    const workerItem = saved.value.configuration!.items.find((item) => item.executionKind === "worker")!;
    const tailItem = saved.value.configuration!.items.find((item) => item.executionKind === "tail_inspection")!;
    await database.query(
      "ALTER TABLE rework_process_configurations DISABLE TRIGGER rework_process_configurations_guard_update",
    );
    try {
      await database.query(
        "UPDATE rework_process_configurations SET unified_execution_required=false WHERE configuration_id=$1",
        [saved.value.configuration!.configurationId],
      );
    } finally {
      await database.query(
        "ALTER TABLE rework_process_configurations ENABLE TRIGGER rework_process_configurations_guard_update",
      );
    }
    await workerPlan.save(
      tailAssign(),
      submitted.value.reworkOrderId,
      {
        expectedOrderVersion: saved.value.orderVersion,
        configurationId: saved.value.configuration!.configurationId,
        expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
        assignments: [
          { configurationItemId: workerItem.configurationItemId, memberIds: [workerPersonId] },
          { configurationItemId: tailItem.configurationItemId, memberIds: [tailPersonId] },
        ],
      },
      randomUUID(),
    );
    const queued = await configuration.submit(
      tailConfigure(),
      submitted.value.reworkOrderId,
      SubmitProcessConfigurationSchema.parse({
        expectedOrderVersion: saved.value.orderVersion,
        expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
      }),
      randomUUID(),
    );
    const approved = await configuration.review(
      ie(),
      submitted.value.reworkOrderId,
      ReviewProcessConfigurationSchema.parse({
        expectedOrderVersion: queued.value.orderVersion,
        expectedConfigurationVersion: queued.value.configuration!.configurationVersion,
        decision: "approved",
      }),
      randomUUID(),
    );
    await workerPlan.activateAfterIeApproval(
      submitted.value.reworkOrderId,
      approved.value.configuration!.configurationVersion,
      randomUUID(),
    );
    const started = await work.list(tailAssign(), submitted.value.reworkOrderId);
    const workerTask = started.tasks.find((task) => task.executionKind === "worker")!;
    const tailTask = started.tasks.find((task) => task.executionKind === "tail_inspection")!;
    await work.submitReport(worker(), workerTask.workTaskId, CreateWorkReportSchema.parse({
      expectedOrderVersion: started.orderVersion,
      actualQuantity: reportedQuantity,
      completedAt: new Date().toISOString(),
    }), randomUUID());
    const historical = await businessDetail.history(actor(ids.ownerOne, ["owner_group"], "responsibility:owner_sign"), submitted.value.reworkOrderId, "work_reporting");
    const live = await work.list(tailAssign(), submitted.value.reworkOrderId);
    const historicalTask = historical.page!.workTasks!.tasks.find(task => task.workTaskId === workerTask.workTaskId)!;
    expect(historicalTask).toMatchObject({ plannedQuantity: 200, submittedQuantity: reportedQuantity, remainingQuantity: 0, canSubmitReport: false });
    expect(historicalTask.remainingQuantity).toBe(live.tasks.find(task => task.workTaskId === workerTask.workTaskId)!.remainingQuantity);
    expect(historical.page!.workTasks!.tasks.find(task => task.workTaskId === tailTask.workTaskId)).toMatchObject({ submittedQuantity: 0, remainingQuantity: tailTask.plannedQuantity });
    const afterWorker = await work.list(tailInspect(), submitted.value.reworkOrderId);
    await work.submitReport(tailInspect(), tailTask.workTaskId, CreateWorkReportSchema.parse({
      expectedOrderVersion: afterWorker.orderVersion,
      actualQuantity: reportedQuantity,
      completedAt: new Date().toISOString(),
    }), randomUUID());

    const stuck = await work.list(tailAssign(), submitted.value.reworkOrderId);
    expect(stuck).toMatchObject({ reworkStatus: "in_progress" });
    expect(stuck.tasks.every((task) => task.remainingQuantity === 0)).toBe(true);

    const recovered = await work.completeExecution(
      tailAssign(),
      submitted.value.reworkOrderId,
      { expectedOrderVersion: stuck.orderVersion },
      randomUUID(),
    );
    expect(recovered.value).toMatchObject({
      reworkStatus: "pending_order_review",
      orderVersion: stuck.orderVersion + 1,
    });
    expect((await database.query<{ tail_inspection_required: boolean }>(
      "SELECT tail_inspection_required FROM rework_orders WHERE rework_order_id=$1",
      [submitted.value.reworkOrderId],
    )).rows[0]).toEqual({ tail_inspection_required: true });
    expect((await database.query<{ source_action: string; status: string }>(
      "SELECT source_action,status FROM rework_todos WHERE dedupe_key=$1",
      [`whole-order-review:${submitted.value.reworkOrderId}:${recovered.value.orderVersion}`],
    )).rows[0]).toEqual({ source_action: "rework.execution.complete", status: "pending" });

    const n05View = await wholeOrder.get(tailAudit(), submitted.value.reworkOrderId);
    expect(n05View).toMatchObject({
      reworkStatus: "pending_order_review",
      unifiedExecutionRequired: false,
      tailInspectionRequired: true,
      processes: [expect.objectContaining({
        configurationItemId: workerItem.configurationItemId,
        completedQuantity: reportedQuantity,
        tailCheckedQuantity: reportedQuantity,
        countGap: 0,
        complete: true,
      })],
    });
    const n05Confirmed = await wholeOrder.approve(
      tailAudit(),
      submitted.value.reworkOrderId,
      {
        expectedOrderVersion: n05View.orderVersion,
        finalQuantities: n05View.processes.map((process) => ({
          configurationItemId: process.configurationItemId,
          finalConfirmedQuantity: process.completedQuantity,
        })),
        temporaryCoefficients: [],
      },
      randomUUID(),
    );
    expect(n05Confirmed.value.reworkStatus).toBe("pending_final_quantity_ie_review");
    expect((await database.query<{
      worker_reported_quantity: string;
      tail_reported_quantity: string;
      final_confirmed_quantity: string;
    }>(
      `SELECT quantity.worker_reported_quantity::text,
              quantity.tail_reported_quantity::text,
              quantity.final_confirmed_quantity::text
       FROM rework_tail_completion_quantities quantity
       JOIN rework_tail_completion_confirmations confirmation
         ON confirmation.confirmation_id=quantity.confirmation_id
       WHERE confirmation.rework_order_id=$1`,
      [submitted.value.reworkOrderId],
    )).rows).toEqual([{
      worker_reported_quantity: reportedQuantity.toFixed(2),
      tail_reported_quantity: reportedQuantity.toFixed(2),
      final_confirmed_quantity: reportedQuantity.toFixed(2),
    }]);

  });

  it.each([
    { executionModel: "unified", legacy: false },
    { executionModel: "legacy", legacy: true },
  ])(
    "waives an existing wrong $executionModel tail report without deleting audit facts or paying tail wages",
    async ({ legacy }) => {
    const imageId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'tail-waiver.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [imageId, `private/${imageId}.webp`, "a".repeat(64), ids.qc],
    );
    const draft = await initiation.createDraft(qc(), {
      styleNo: "UAT-TAIL-WAIVER",
      orderQuantity: 500,
      orderNo: "ORDER-TAIL-WAIVER",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "supplier", supplierId: factorySupplierId },
      tailInspectionCostBearer: "processing_factory",
      inspectionReport: n01CoreInspectionReport("免尾查测试款"),
      problemPart: "后幅",
      problemDescription: "历史订单实际无需尾查",
      reworkQuantity: 200,
      attachmentIds: [imageId],
    }, randomUUID());
    const submitted = await initiation.submit(
      qc(), draft.value.reworkOrderId, { expectedVersion: draft.value.version }, randomUUID(),
    );
    const saved = await configuration.saveDraft(
      tailConfigure(),
      submitted.value.reworkOrderId,
      SaveProcessConfigurationSchema.parse({
        expectedOrderVersion: submitted.value.version,
        items: [{
          source: "catalog",
          processId: publicProcessId,
          executionKind: "worker",
          plannedQuantity: 200,
          pricingUnit: "piece",
          unitPrice: 0.55,
        }, {
          source: "custom",
          customProcessName: "尾查",
          executionKind: "tail_inspection",
          plannedQuantity: 1,
          pricingUnit: "piece",
          unitPrice: 0.2,
        }],
      }),
      randomUUID(),
    );
    const workerItem = saved.value.configuration!.items.find((item) => item.executionKind === "worker")!;
    const tailItem = saved.value.configuration!.items.find((item) => item.executionKind === "tail_inspection")!;
    if (legacy) {
      await database.query(
        "ALTER TABLE rework_process_configurations DISABLE TRIGGER rework_process_configurations_guard_update",
      );
      try {
        await database.query(
          "UPDATE rework_process_configurations SET unified_execution_required=false WHERE configuration_id=$1",
          [saved.value.configuration!.configurationId],
        );
      } finally {
        await database.query(
          "ALTER TABLE rework_process_configurations ENABLE TRIGGER rework_process_configurations_guard_update",
        );
      }
    }
    await workerPlan.save(
      tailAssign(),
      submitted.value.reworkOrderId,
      {
        expectedOrderVersion: saved.value.orderVersion,
        configurationId: saved.value.configuration!.configurationId,
        expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
        assignments: [
          { configurationItemId: workerItem.configurationItemId, memberIds: [workerPersonId] },
          { configurationItemId: tailItem.configurationItemId, memberIds: [tailPersonId] },
        ],
      },
      randomUUID(),
    );
    const queued = await configuration.submit(
      tailConfigure(),
      submitted.value.reworkOrderId,
      SubmitProcessConfigurationSchema.parse({
        expectedOrderVersion: saved.value.orderVersion,
        expectedConfigurationVersion: saved.value.configuration!.configurationVersion,
      }),
      randomUUID(),
    );
    const approved = await configuration.review(
      ie(),
      submitted.value.reworkOrderId,
      ReviewProcessConfigurationSchema.parse({
        expectedOrderVersion: queued.value.orderVersion,
        expectedConfigurationVersion: queued.value.configuration!.configurationVersion,
        decision: "approved",
      }),
      randomUUID(),
    );
    await workerPlan.activateAfterIeApproval(
      submitted.value.reworkOrderId,
      approved.value.configuration!.configurationVersion,
      randomUUID(),
    );
    const started = await work.list(tailAssign(), submitted.value.reworkOrderId);
    const workerTask = started.tasks.find((task) => task.executionKind === "worker")!;
    await work.submitReport(worker(), workerTask.workTaskId, CreateWorkReportSchema.parse({
      expectedOrderVersion: started.orderVersion,
      actualQuantity: 200,
      completedAt: new Date().toISOString(),
    }), randomUUID());
    const afterWorker = await work.list(tailInspect(), submitted.value.reworkOrderId);
    const tailTask = started.tasks.find((task) => task.executionKind === "tail_inspection")!;
    const unifiedWrongTail = await work.submitReport(
      tailInspect(),
      tailTask.workTaskId,
      CreateWorkReportSchema.parse({
        expectedOrderVersion: afterWorker.orderVersion,
        actualQuantity: 180,
        completedAt: new Date().toISOString(),
      }),
      randomUUID(),
    );
    let wrongTailReportId: string;
    let correctionTodoKey: string;
    let waiverVersion: number;
    let legacyAssignmentId: string | null = null;
    if (legacy) {
      const configurationEvent = (await database.query<{
        actor_id: string;
        event_id: string;
        request_id: string;
      }>(
        `SELECT actor_id,event_id,request_id
         FROM operation_events
         WHERE action='rework.process_configuration.submit'
           AND entity_id=$1
         ORDER BY created_at DESC,event_id DESC
         LIMIT 1`,
        [submitted.value.reworkOrderId],
      )).rows[0]!;
      legacyAssignmentId = randomUUID();
      await database.query(
        `INSERT INTO rework_tail_inspection_assignments(
           tail_inspection_assignment_id,rework_order_id,tail_inspector_user_id,
           assigned_by,operation_event_id,request_id
         ) VALUES($1,$2,$3,$4,$5,$6)`,
        [
          legacyAssignmentId,
          submitted.value.reworkOrderId,
          ids.tailInspector,
          configurationEvent.actor_id,
          configurationEvent.event_id,
          configurationEvent.request_id,
        ],
      );
      await legacyTailInspection.submit(tailInspect(), legacyAssignmentId, {
        returnedQuantity: 180,
        items: [{
          configurationItemId: workerItem.configurationItemId,
          inspectedQuantity: 180,
        }, {
          configurationItemId: tailItem.configurationItemId,
          inspectedQuantity: 180,
        }],
      }, randomUUID());
      wrongTailReportId = (await database.query<{ tail_inspection_report_id: string }>(
        `SELECT tail_inspection_report_id
         FROM rework_tail_inspection_reports
         WHERE tail_inspection_assignment_id=$1 AND status='submitted'`,
        [legacyAssignmentId],
      )).rows[0]!.tail_inspection_report_id;
      const beforeWaiver = await work.list(tailAssign(), submitted.value.reworkOrderId);
      expect(beforeWaiver.reworkStatus).toBe("pending_order_review");
      await legacyTailInspection.reject(tailAudit(), legacyAssignmentId, {
        expectedOrderVersion: beforeWaiver.orderVersion,
        reason: "尾查工序配置错误，该报数无需重报",
      }, randomUUID());
      waiverVersion = beforeWaiver.orderVersion;
      correctionTodoKey = `tail-inspection-return:${wrongTailReportId}`;
    } else {
      wrongTailReportId = unifiedWrongTail.value.workReportId;
      const beforeWaiver = await work.list(tailAssign(), submitted.value.reworkOrderId);
      expect(beforeWaiver.reworkStatus).toBe("pending_order_review");
      const rejectedWrongTail = await wholeOrder.rejectReport(
        tailAudit(),
        wrongTailReportId,
        {
          expectedOrderVersion: beforeWaiver.orderVersion,
          rejectedPersonId: tailPersonId,
          reason: "尾查工序配置错误，该报数无需重报",
        },
        randomUUID(),
      );
      expect(rejectedWrongTail.value.reworkStatus).toBe("in_progress");
      waiverVersion = rejectedWrongTail.value.orderVersion;
      correctionTodoKey = `work-report-return:${wrongTailReportId}`;
    }
    expect((await database.query<{ status: string }>(
      "SELECT status FROM rework_todos WHERE dedupe_key=$1",
      [correctionTodoKey],
    )).rows[0]).toEqual({ status: "pending" });

    await expect(initiation.waiveTailInspection(
      actor(ids.qc, ["quality_control"], "tail_inspection:waive"),
      submitted.value.reworkOrderId,
      { expectedVersion: waiverVersion, reason: "权限验证" },
      randomUUID(),
    )).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    const waived = await initiation.waiveTailInspection(
      actor(ids.ownerOne, ["owner_group"], "tail_inspection:waive"),
      submitted.value.reworkOrderId,
      { expectedVersion: waiverVersion, reason: "工序实际无需尾查，原尾查数上报错误" },
      randomUUID(),
    );
    expect(waived.value).toMatchObject({
      status: "pending_order_review",
      tailInspectionRequired: false,
      tailInspectionCostBearer: null,
      tailInspectionCostBearerSource: null,
      version: waiverVersion + 1,
    });
    if (legacy) {
      expect((await database.query(
        `SELECT report.status,assignment.revoked_at IS NOT NULL AS revoked
         FROM rework_tail_inspection_reports report
         JOIN rework_tail_inspection_assignments assignment
           ON assignment.tail_inspection_assignment_id=report.tail_inspection_assignment_id
         WHERE report.tail_inspection_report_id=$1
           AND assignment.tail_inspection_assignment_id=$2`,
        [wrongTailReportId, legacyAssignmentId],
      )).rows).toEqual([{ status: "rejected", revoked: true }]);
    } else {
      expect((await database.query(
        `SELECT report.work_report_id,task.status,
                EXISTS(SELECT 1 FROM rework_work_report_rejections rejection
                       WHERE rejection.work_report_id=report.work_report_id) AS rejected
         FROM rework_work_reports report
         JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
         WHERE report.work_report_id=$1`,
        [wrongTailReportId],
      )).rows).toEqual([{
        work_report_id: wrongTailReportId,
        status: "superseded",
        rejected: true,
      }]);
    }
    expect((await database.query<{ status: string }>(
      "SELECT status FROM rework_todos WHERE dedupe_key=$1",
      [correctionTodoKey],
    )).rows[0]).toEqual({ status: "cancelled" });
    expect((await database.query<{ source_action: string; status: string }>(
      "SELECT source_action,status FROM rework_todos WHERE dedupe_key=$1",
      [`whole-order-review:${submitted.value.reworkOrderId}:${waived.value.version}`],
    )).rows[0]).toEqual({
      source_action: "rework.tail_inspection.waive",
      status: "pending",
    });

    const reviewView = await wholeOrder.get(tailAudit(), submitted.value.reworkOrderId);
    expect(reviewView).toMatchObject({
      reworkStatus: "pending_order_review",
      tailInspectionRequired: false,
      processes: [expect.objectContaining({
        configurationItemId: workerItem.configurationItemId,
        completedQuantity: 200,
      })],
    });
    await wholeOrder.approve(tailAudit(), submitted.value.reworkOrderId, {
      expectedOrderVersion: reviewView.orderVersion,
      finalQuantities: [{
        configurationItemId: workerItem.configurationItemId,
        finalConfirmedQuantity: 200,
      }],
      temporaryCoefficients: [],
    }, randomUUID());
    const ieView = await wholeOrder.get(ie(), submitted.value.reworkOrderId);
    const finalized = await wholeOrder.reviewFinalQuantity(ie(), submitted.value.reworkOrderId, {
      expectedOrderVersion: ieView.orderVersion,
      decision: "approved",
    }, randomUUID());
    expect((await database.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM rework_wage_items wage
       JOIN rework_work_reports report ON report.work_report_id=wage.work_report_id
       WHERE wage.rework_order_id=$1 AND report.configuration_item_id=$2`,
      [submitted.value.reworkOrderId, tailItem.configurationItemId],
    )).rows[0]).toEqual({ count: 0 });
    await expect(initiation.waiveTailInspection(
      actor(ids.ownerOne, ["owner_group"], "tail_inspection:waive"),
      submitted.value.reworkOrderId,
      { expectedVersion: finalized.value.orderVersion, reason: "不应允许下游重复操作" },
      randomUUID(),
    )).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    if (!legacy) {
    // All-own responsibility has no supplier case and must still support order-level revision.
    const ownView=await responsibility.get(production(),submitted.value.reworkOrderId);
    const ownDraft=await responsibility.saveDraft(production(),submitted.value.reworkOrderId,CreateResponsibilityDraftSchema.parse({expectedOrderVersion:finalized.value.orderVersion,expectedCurrentDeterminationVersion:null,handlerUserId:ids.production,tailInspectionCostBearer:"own_factory",processes:ownView.sourceProcesses.filter(row=>row.includedInResponsibility).map(row=>({configurationItemId:row.configurationItemId,multiplier:"1.000",allocations:[{responsibilityType:"own_factory",shareBps:10000,multiplier:"1.000"}]}))}),randomUUID());
    const ownFinal=await responsibility.finalize(production(),submitted.value.reworkOrderId,{expectedOrderVersion:ownDraft.value.orderVersion,expectedCurrentDeterminationVersion:ownDraft.value.determination!.version},randomUUID());
    const owner=actor(ids.ownerOne,["owner_group"],"responsibility:owner_sign","responsibility:determine","external_responsibility:approve_revision");
    await responsibility.approveOwnerSignature(owner,submitted.value.reworkOrderId,{expectedOrderVersion:ownFinal.value.orderVersion},randomUUID());
    const ownBefore=await responsibility.revisions.get(owner,submitted.value.reworkOrderId);
    const ownReopen=await responsibility.revisions.reopen(owner,submitted.value.reworkOrderId,{expectedOrderVersion:ownBefore.orderVersion,expectedDeterminationVersion:ownBefore.currentVersion!,reason:"本厂承担责任重新核对"},randomUUID());
    expect(ownReopen.value.status).toBe("pending_responsibility_determination");
    expect((await database.query("SELECT count(*)::int count FROM rework_external_responsibility_cases WHERE rework_order_id=$1",[submitted.value.reworkOrderId])).rows[0].count).toBe(0);
    const ownResubmit=await responsibility.finalize(production(),submitted.value.reworkOrderId,{expectedOrderVersion:ownReopen.value.orderVersion,expectedCurrentDeterminationVersion:ownReopen.value.currentVersion!},randomUUID());
    await responsibility.approveOwnerSignature(owner,submitted.value.reworkOrderId,{expectedOrderVersion:ownResubmit.value.orderVersion},randomUUID());
    }
  });

  it("submits simplified N01 without retired manual-entry facts", async () => {
    const initialImageId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'n01-v2-minimal.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [initialImageId, `private/${initialImageId}.webp`, "f".repeat(64), ids.qc],
    );
    const draft = await initiation.createDraft(qc(), {
      styleNo: "UAT-N01-V2-MINIMAL",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "supplier", supplierId: factorySupplierId },
      tailInspectionCostBearer: "processing_factory",
      attachmentIds: [initialImageId],
    }, randomUUID());

    expect(draft.value).toMatchObject({
      status: "draft",
      styleNo: "UAT-N01-V2-MINIMAL",
      orderQuantity: null,
      merchandiserUserId: ids.merchandiser,
      problemPart: null,
      problemDescription: null,
      reworkQuantity: null,
      inspectionReport: null,
    });

    const submitted = await v2Submission.submit(qc(), draft.value.reworkOrderId, {
      expectedVersion: draft.value.version,
    }, randomUUID());

    expect(submitted.value).toMatchObject({
      status: "pending_process_configuration",
      styleNo: "UAT-N01-V2-MINIMAL",
      orderQuantity: null,
      merchandiserUserId: ids.merchandiser,
      problemPart: null,
      problemDescription: null,
      reworkQuantity: null,
      inspectionReport: null,
    });
    expect(submitted.value.reworkNo).toMatch(/^RW-\d{4}-\d{4}-\d{3,}$/);
  });

  it("appends tail defective quantity under audit and distinguishes an unlinked receiving source", async () => {
    const initialImageId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'tail-defective.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [initialImageId, `private/${initialImageId}.webp`, "7".repeat(64), ids.qc],
    );
    const draft = await initiation.createDraft(qc(), {
      styleNo: "UAT-TAIL-DEFECTIVE",
      orderQuantity: 20,
      orderNo: "ORDER-TAIL-DEFECTIVE",
      merchandiserUserId: ids.merchandiser,
      processingFactory: { type: "supplier", supplierId: factorySupplierId },
      tailInspectionCostBearer: "processing_factory",
      inspectionReport: n01CoreInspectionReport("尾部次品链路"),
      problemPart: "尾部",
      problemDescription: "尾部次品追加真实链路验收",
      reworkQuantity: 20,
      attachmentIds: [initialImageId],
    }, randomUUID());
    await supplyContext.save(qc(), draft.value.reworkOrderId, {
      washingSupplierId: null,
      embroiderySupplierId: null,
      fabricSupplierId: null,
      embroideryMerchandiserUserId: ids.embroideryMerchandiser,
    });
    const submitted = await initiation.submit(
      qc(),
      draft.value.reworkOrderId,
      { expectedVersion: draft.value.version },
      randomUUID(),
    );

    const tailActor = actor(ids.tail, ["tail_supervisor"], "tools:user");
    const before = await businessDetail.get(tailActor, submitted.value.reworkOrderId);
    expect(before.defectiveQuantity).toMatchObject({
      receiving: 0,
      receivingLinked: false,
      tail: 0,
      total: 0,
    });

    const idempotencyKey = randomUUID();
    const added = await businessDetail.addTailDefectiveQuantity(
      tailActor,
      submitted.value.reworkOrderId,
      { expectedVersion: before.version, quantity: 2 },
      idempotencyKey,
    );
    expect(added).toMatchObject({
      reused: false,
      value: {
        version: before.version + 1,
        defectiveQuantity: {
          receiving: 0,
          receivingLinked: false,
          tail: 2,
          total: 2,
        },
      },
    });
    const reused = await businessDetail.addTailDefectiveQuantity(
      tailActor,
      submitted.value.reworkOrderId,
      { expectedVersion: before.version, quantity: 2 },
      idempotencyKey,
    );
    expect(reused).toMatchObject({ reused: true });
    expect((await database.query(
      `SELECT entry.quantity,event.action,event.actor_id,orders.updated_by
       FROM rework_tail_defective_quantity_entries entry
       JOIN operation_events event ON event.event_id=entry.operation_event_id
       JOIN rework_orders orders ON orders.rework_order_id=entry.rework_order_id
       WHERE entry.rework_order_id=$1`,
      [submitted.value.reworkOrderId],
    )).rows).toEqual([{
      quantity: 2,
      action: "rework.tail_defective_quantity.add",
      actor_id: ids.tail,
      updated_by: ids.tail,
    }]);
  });
  it("logically deletes both board order kinds in every stage with Root audit and closed todos", async () => {
    const service = new PatternRoomOrderService(database, todoProjection, { ordersEnabled: true });
    const root = patternActor(ids.patternRoot, ["root_superuser"]), designer = patternActor(ids.patternDesigner, ["sample_designer"]);
    const supervisor = patternActor(ids.patternSupervisor, ["pattern_room_supervisor"]), boardWorker = patternActor(ids.worker, ["pattern_room_worker"]);
    const prices = new PatternRoomPriceService(database), before = (await prices.management(root)).hourly;
    const hourly = await prices.change(root, "hourly", PATTERN_HOURLY_PRICE_ID, { version: before.version, amount: "28.500", enabled: true, reason: "删除回归时薪" }, randomUUID());
    for (const kind of ["pattern", "misc"] as const) for (const stage of ["pending_assignment", "in_progress", "pending_confirmation", "completed", "cancelled"] as const) {
      const label = `DELETE-${kind}-${stage}`;
      let order = kind === "pattern" ? await makePattern(service, designer, label) : await service.createMisc(designer, { taskName: label, priceVersion: hourly.version }, randomUUID());
      expect((await service.get(root, order.orderId)).actions.delete).toBe(true);
      expect((await service.get(designer, order.orderId)).actions.delete).toBe(false);
      await expect(service.deleteOrder(designer, order.orderId, { version: order.version }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
      await expect(service.deleteOrder(root, order.orderId, { version: order.version + 1 }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
      await expect(database.query("UPDATE pattern_room_orders SET deleted_at=CURRENT_TIMESTAMP WHERE order_id=$1", [order.orderId])).rejects.toThrow();
      if (["in_progress", "pending_confirmation", "completed"].includes(stage)) order = await service.assign(supervisor, order.orderId, { ...roundAction(order), personId: workerPersonId }, randomUUID());
      if (["pending_confirmation", "completed"].includes(stage)) {
        if (kind === "misc") order = await service.recordHours(supervisor, order.orderId, { ...roundAction(order), hours: "1.0" }, randomUUID());
        order = await service.complete(boardWorker, order.orderId, roundAction(order), randomUUID());
      }
      if (stage === "completed") order = kind === "pattern" ? await service.handoff(designer, order.orderId, roundAction(order), randomUUID()) : await service.confirmMisc(designer, order.orderId, roundAction(order), randomUUID());
      if (stage === "cancelled") order = await service.cancel(designer, order.orderId, { ...roundAction(order), reason: "删除前已取消" }, randomUUID());
      expect(order.status).toBe(stage);
      const wages = (await database.query("SELECT * FROM pattern_room_wage_items WHERE order_id=$1 ORDER BY wage_item_id", [order.orderId])).rows;
      const materials = (await database.query("SELECT * FROM pattern_room_attachment_bindings WHERE order_id=$1 ORDER BY attachment_id", [order.orderId])).rows;
      const key = randomUUID(), input = { version: order.version };
      expect(await service.deleteOrder(root, order.orderId, input, key)).toEqual({ deleted: true });
      expect(await service.deleteOrder(root, order.orderId, input, key)).toEqual({ deleted: true });
      await expect(service.get(root, order.orderId)).rejects.toMatchObject({ statusCode: 404 });
      expect((await service.list(root, { q: label, page: 1, limit: 25 })).items).toEqual([]);
      expect((await database.query("SELECT count(*)::int n FROM rework_todos WHERE entity_id=$1 AND status IN ('pending','blocked_recipient')", [order.orderId])).rows[0].n).toBe(0);
      expect((await database.query("SELECT count(*)::int n FROM operation_events WHERE entity_id=$1 AND action='pattern_room.order.deleted'", [order.orderId])).rows[0].n).toBe(1);
      expect((await database.query("SELECT * FROM pattern_room_wage_items WHERE order_id=$1 ORDER BY wage_item_id", [order.orderId])).rows).toEqual(wages);
      expect((await database.query("SELECT * FROM pattern_room_attachment_bindings WHERE order_id=$1 ORDER BY attachment_id", [order.orderId])).rows).toEqual(materials);
      if (materials.length) expect(await service.canDownload(root, { entityType: "pattern_room_attachment", entityId: materials[0].attachment_id })).toBe(false);
      await expect(database.query("UPDATE pattern_room_orders SET deleted_at=NULL,deleted_by=NULL,deletion_event_id=NULL WHERE order_id=$1", [order.orderId])).rejects.toMatchObject({ code: "55000" });
    }
    const app = Fastify();
    registerPatternRoomOrderRoutes(app, { service, attachments: {} as AttachmentService, root: new RootAuthority(database, "corp", undefined), authenticate: async () => ({ id: ids.patternRoot, businessRoles: [], capabilities: [] }) });
    try {
      const order = await makePattern(service, designer, "DELETE-HTTP");
      expect((await app.inject({ method: "POST", url: `/pattern-room/orders/${order.orderId}/delete`, payload: { version: order.version }, headers: { cookie: "dx_rework_session=root", "idempotency-key": randomUUID() } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("excludes deleted board wages from reads and stale paid selections while preserving existing paid facts", async () => {
    const service = new PatternRoomOrderService(database, todoProjection), root = patternActor(ids.patternRoot, ["root_superuser"]);
    const designer = patternActor(ids.patternDesigner, ["sample_designer"]), supervisor = patternActor(ids.patternSupervisor, ["pattern_room_supervisor"]), boardWorker = patternActor(ids.worker, ["pattern_room_worker"]);
    const reporting = new ManagementReportingService(database), finance = financeWages();
    for (const settled of [true, false]) {
      let order = await makePattern(service, designer, `DELETE-WAGE-${settled}`);
      order = await service.assign(supervisor, order.orderId, { ...roundAction(order), personId: workerPersonId }, randomUUID());
      order = await service.complete(boardWorker, order.orderId, roundAction(order), randomUUID());
      order = await service.handoff(designer, order.orderId, roundAction(order), randomUUID());
      const filter = { ...allWageDates, wageSource: "pattern_room" as const, q: order.styleNo };
      const preview = await reporting.previewWageSettlement(finance, filter);
      expect(preview.lineCount).toBe(1);
      if (settled) expect((await reporting.markWageSettlement(finance, filter, preview.lineIds)).markedCount).toBe(1);
      const marks = (await database.query("SELECT * FROM rework_wage_settlement_marks WHERE line_id=ANY($1::uuid[])", [preview.lineIds])).rows;
      await service.deleteOrder(root, order.orderId, { version: order.version }, randomUUID());
      expect((await reporting.report(finance, "wages", filter)).rows).toEqual([]);
      expect((await reporting.report(finance, "wages", filter)).totals.wageAmount).toBe("0.00");
      expect((await reporting.previewWageSettlement(finance, filter)).lineCount).toBe(0);
      const exported = await new ReportExportService(reporting, database, "board-deletion-verification").export(finance, "wages", filter);
      const detailSheet = [...exported.content.toString("utf8").matchAll(/<worksheet[\s\S]*?<\/worksheet>/g)][1]![0];
      expect(detailSheet).not.toContain(order.orderNo);
      expect(detailSheet.match(/<row\b/g)).toHaveLength(1);
      expect((await reporting.markWageSettlement(finance, filter, preview.lineIds)).markedCount).toBe(0);
      const insertion = await database.query("INSERT INTO rework_wage_settlement_marks(line_id,pattern_wage_item_id,marked_by) VALUES($1,$1,$2) ON CONFLICT DO NOTHING RETURNING line_id", [preview.lineIds[0], ids.financeDirector]);
      expect(insertion.rows).toEqual([]);
      expect((await database.query("SELECT * FROM rework_wage_settlement_marks WHERE line_id=ANY($1::uuid[])", [preview.lineIds])).rows).toEqual(marks);
      expect((await database.query("SELECT wage_item_id FROM pattern_room_wage_items WHERE order_id=$1", [order.orderId])).rows).toHaveLength(1);
    }
  });

  it("serializes board deletion before a racing wage-paid marker", async () => {
    const service = new PatternRoomOrderService(database, todoProjection), root = patternActor(ids.patternRoot, ["root_superuser"]);
    const designer = patternActor(ids.patternDesigner, ["sample_designer"]), supervisor = patternActor(ids.patternSupervisor, ["pattern_room_supervisor"]), boardWorker = patternActor(ids.worker, ["pattern_room_worker"]);
    const reporting = new ManagementReportingService(database), finance = financeWages();
    let order = await makePattern(service, designer, "DELETE-WAGE-RACE");
    order = await service.assign(supervisor, order.orderId, { ...roundAction(order), personId: workerPersonId }, randomUUID());
    order = await service.complete(boardWorker, order.orderId, roundAction(order), randomUUID());
    order = await service.handoff(designer, order.orderId, roundAction(order), randomUUID());
    const filter = { ...allWageDates, wageSource: "pattern_room" as const, q: order.styleNo }, preview = await reporting.previewWageSettlement(finance, filter);
    let locked!: () => void, resume!: () => void;
    const deletionLocked = new Promise<void>(resolve => { locked = resolve; }), continueDeletion = new Promise<void>(resolve => { resume = resolve; });
    class PausingProjection extends TodoProjectionService {
      override async cancelOpenByDedupePrefix(...args: Parameters<TodoProjectionService["cancelOpenByDedupePrefix"]>) {
        locked(); await continueDeletion; return super.cancelOpenByDedupePrefix(...args);
      }
    }
    const deletion = new PatternRoomOrderService(database, new PausingProjection(todoService)).deleteOrder(root, order.orderId, { version: order.version }, randomUUID());
    await deletionLocked;
    const applicationName = `board-delete-mark-${randomUUID()}`;
    const markingPool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, application_name: applicationName });
    const marking = new ManagementReportingService(markingPool).markWageSettlement(finance, filter, preview.lineIds);
    // Observe the real INSERT blocked on the order lock before allowing deletion to commit.
    // Merely launching two promises does not guarantee that the mark used the pre-delete snapshot.
    let blocked = false;
    try {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        // pg_stat_activity truncates long SQL, so identify this dedicated client's CTE by its prefix.
        const waiting = await adminPool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'WITH unlocked_lines AS (%'", [applicationName]);
        if (waiting.rowCount) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      resume();
      expect(await deletion).toEqual({ deleted: true });
      expect(await marking).toEqual({ markedCount: 0 });
      expect((await database.query("SELECT * FROM rework_wage_settlement_marks WHERE line_id=ANY($1::uuid[])", [preview.lineIds])).rows).toEqual([]);
    } finally {
      resume();
      await Promise.allSettled([deletion, marking]);
      await markingPool.end();
    }
  });

});
