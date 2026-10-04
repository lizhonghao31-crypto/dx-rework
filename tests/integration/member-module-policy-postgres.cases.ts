import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { RootAwareTodoProjectionService } from "../../apps/api/src/todos/root-aware-projection-service.js";
import { CreateSupplierSchema } from "@dx-rework/contracts";
import { SourcingService } from "../../apps/api/src/sourcing/sourcing-service.js";
import { SourcingContractService } from "../../apps/api/src/sourcing/sourcing-contract-service.js";
import { SourcingProductionService } from "../../apps/api/src/sourcing/sourcing-production-service.js";
import { ProductionReportingService } from "../../apps/api/src/sourcing/production-reporting-service.js";
import { ProductionClosureService } from "../../apps/api/src/sourcing/production-closure-service.js";
import { AttachmentService } from "../../apps/api/src/tools/attachments.js";
import { FakeObjectStorage } from "../../apps/api/src/tools/storage.js";
import { shanghaiDay } from "@dx-rework/domain";
import Fastify from "fastify";
import { registerReworkRoutes } from "../../apps/api/src/rework/routes.js";
import { registerMemberModuleHttpGuard } from "../../apps/api/src/access/member-module-http.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { MemberModuleBindingService } from "../../apps/api/src/access/member-module-binding-service.js";
import { effectiveMemberAuthorization, memberCanReceiveFact } from "../../apps/api/src/access/member-module-policy.js";
import { PostgresAuthStore } from "../../apps/api/src/auth/postgres-store.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { OperationEventRepository, type TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
import { TodoProjectionService } from "../../apps/api/src/todos/projection-service.js";
import { TodoDeliveryWorker } from "../../apps/api/src/todos/delivery-worker.js";
import { FakeDingTalkTodoProvider } from "../../apps/api/src/todos/provider.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
(databaseUrl ? describe : describe.skip)("verified owner module policy current PostgreSQL", () => {
  const schema = ownedPostgresSchema("full_chain");
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  const ids = { li_zhonghao: randomUUID(), wu_yunfeng: randomUUID(), li_junyue: randomUUID() };
  const extraOwner = randomUUID();
  const events = new OperationEventRepository();
  const todos = new TodoService(database);
  const projection = new TodoProjectionService(todos);
  const binder = new MemberModuleBindingService(database, todos);
  const initiation = new ReworkInitiationService(database, "corp");
  const contracts = new SourcingContractService(database, new AttachmentService(database, new FakeObjectStorage(), { prefix: "tests", ttlSeconds: 60, maxUploadBytes: 5000000 }));
  let productionCaseId = "", productionSupplierId = "";
  const actor = (id: string, capability = "rework:initiate"): TrustedActorContext => ({
    actorId: id, actorRoles: id === ids.li_junyue ? ["root_superuser", "quality_control"] : ["owner_group", "quality_control", "production_management", "ie_reviewer"],
    authorizationCapability: capability, authorizationCapabilities: [capability, "business:read_all", "sourcing:view"], requestId: randomUUID(),
  });
  const tx = async <T,>(work: (client: pg.PoolClient) => Promise<T>) => {
    const client = await database.connect();
    try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  };
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await database.query("CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64),applied_at timestamptz DEFAULT CURRENT_TIMESTAMP)");
    const manifest = JSON.parse(await readFile(new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url), "utf8")) as { migrations: { version: string; checksum: string }[] };
    for (const migration of manifest.migrations) { await database.query(await readFile(new URL(`../../apps/api/migrations/${migration.version}.sql`, import.meta.url), "utf8")); await database.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",[migration.version,migration.checksum]); }
    for (const [key, id] of [...Object.entries(ids), ["extra_owner", extraOwner]]) {
      await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)", [id, `测试映射-${key}`]);
      await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','corp',$3,$3,true,true,CURRENT_TIMESTAMP)", [randomUUID(), id, `ding-${id}`]);
      if (id !== ids.li_junyue) for (const role of id === ids.wu_yunfeng ? ["owner_group", "quality_control", "production_management", "ie_reviewer"] : id === extraOwner ? ["owner_group", "factory_payables"] : ["owner_group", "quality_control"]) {
        await database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$2,'isolated verified member fixture')", [randomUUID(), id, role]);
      }
    }
    await database.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,$2,'corp')", [ids.li_junyue, `ding-${ids.li_junyue}`]);
    await new AccessMasterDataService(database, "corp").ensureOrganizationPolicy();
  }, 120_000);
  afterAll(async () => { await database.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });

  it("atomically binds three verified IDs, preserves old reads and audits, denies stale mixed-role writes and closes old deliveries", async () => {
    await new AccessMasterDataService(database, "corp").createDelegation(actor(ids.li_junyue,"delegation:manage"), {
      grantorUserId:ids.li_zhonghao,granteeUserId:ids.wu_yunfeng,capability:"sourcing:owner:approve",scopeType:"global",
      validFrom:new Date(Date.now()-60_000).toISOString(),validUntil:new Date(Date.now()+3_600_000).toISOString(),reason:"切换前已存在的真实委派验收",
    });
    const original = (await initiation.createDraft(actor(ids.wu_yunfeng), { styleNo: "MEMBER-READ-HISTORY" }, randomUUID())).value;
    const oldSession = new PostgresAuthStore(database, "corp");
    const token = randomUUID();
    await oldSession.createSession({ id: randomUUID(), tokenHash: token, userId: ids.wu_yunfeng, expiresAt: new Date(Date.now() + 60_000), revokedAt: null });
    expect((await oldSession.findSession(token, new Date()))?.user.capabilities).toContain("rework:initiate");
    const source = (await database.query<{ event_id: string }>("SELECT event_id FROM operation_events WHERE action='rework.draft.create' AND entity_id=$1", [original.reworkOrderId])).rows[0]!.event_id;
    await tx(async client => {
      await projection.actionableForRecipient(client, actor(ids.li_junyue), {
        category: "owner_signature", sourceEventId: source, sourceAction: "rework.draft.create", entityType: "rework_order", entityId: original.reworkOrderId,
        recipientUserId: ids.wu_yunfeng, requiredRole: "owner_group", requiredCapability: "responsibility:owner_sign",
        route: { routeName: "responsibility_detail", entityId: original.reworkOrderId }, policyKey: "general", dedupeKey: `member-old:${ids.wu_yunfeng}`,
      });
    });
    const provider = new FakeDingTalkTodoProvider();
    const delivery = new TodoDeliveryWorker(database, provider, "https://staging.example/rework/");
    expect((await delivery.runOnce(50)).sent).toBeGreaterThan(0);
    expect(provider.calls.some(call => call.method === "create" && "recipientUserId" in call.input && call.input.recipientUserId === ids.wu_yunfeng)).toBe(true);
    await tx(client => projection.information(client, actor(ids.li_junyue), {
      category: "order_completed", sourceEventId: source, sourceAction: "rework.draft.create", entityType: "rework_order", entityId: original.reworkOrderId,
      recipientUserId: ids.wu_yunfeng, route: { routeName: "rework_detail", entityId: original.reworkOrderId }, dedupeKey: "member-queued",
    }));
    const preview = await binder.run(ids.li_junyue, ids);
    expect(preview.pendingTodoIds).toHaveLength(2);
    expect((await database.query("SELECT * FROM business_module_owner_bindings")).rows).toEqual([]);
    await expect(binder.run(ids.wu_yunfeng, ids, true)).rejects.toMatchObject({ statusCode: 403 });
    await expect(binder.run(ids.li_junyue, { ...ids, li_zhonghao: ids.wu_yunfeng }, true)).rejects.toMatchObject({ statusCode: 400 });
    const applied = await binder.run(ids.li_junyue, ids, true);
    expect(applied.cancelled).toBe(2);
    expect((await binder.run(ids.li_junyue, ids, true)).cancelled).toBe(0);
    const session = (await oldSession.findSession(token, new Date()))!.user;
    expect(session.readOnlyModules).toEqual(["rework", "sourcing"]);
    expect(session.effectiveWriteCapabilities).not.toContain("rework:initiate");
    expect(session.effectiveWriteCapabilities).not.toContain("sourcing:owner:approve");
    expect(session.capabilities).toContain("business:read_all");
    expect(session.capabilities).toContain("supplier_profile:write");
    expect((await database.query("SELECT * FROM delegated_authorizations WHERE grantee_user_id=$1 AND revoked_at IS NULL",[ids.wu_yunfeng])).rowCount).toBe(1);
    const beforeNewProjection = (await database.query("SELECT * FROM rework_todos WHERE recipient_user_id=$1",[ids.wu_yunfeng])).rowCount;
    await tx(client => projection.information(client, actor(ids.li_junyue), {
      category:"order_completed",sourceEventId:source,sourceAction:"rework.draft.create",entityType:"rework_order",entityId:original.reworkOrderId,
      recipientUserId:ids.wu_yunfeng,route:{routeName:"rework_detail",entityId:original.reworkOrderId},dedupeKey:"new-projection-suppressed",
    }));
    expect((await database.query("SELECT * FROM rework_todos WHERE recipient_user_id=$1",[ids.wu_yunfeng])).rowCount).toBe(beforeNewProjection);
    const app = Fastify();
    const authenticate = async () => (await oldSession.findSession(token, new Date()))!.user;
    registerMemberModuleHttpGuard(app, authenticate);
    registerReworkRoutes(app, { authenticate, service: initiation });
    const get = await app.inject({ method: "GET", url: `/rework-orders/${original.reworkOrderId}` });
    expect(get.statusCode).toBe(200);
    const denied = await app.inject({ method: "POST", url: "/rework-orders/drafts", headers: { "idempotency-key": randomUUID() }, payload: { styleNo: "HTTP-DENIED" } });
    expect(denied.statusCode).toBe(403);
    await app.close();
    const history = await initiation.getOwn(actor(ids.wu_yunfeng), original.reworkOrderId);
    expect(history.styleNo).toBe("MEMBER-READ-HISTORY");
    const count = (await database.query("SELECT * FROM rework_orders")).rowCount;
    await expect(initiation.createDraft(actor(ids.wu_yunfeng), { styleNo: "DENIED" }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    expect((await database.query("SELECT * FROM rework_orders")).rowCount).toBe(count);
    const createCount = provider.calls.filter(call => call.method === "create").length;
    await delivery.runOnce(50);
    expect(provider.calls.slice(createCount).some(call => call.method === "complete")).toBe(true);
    expect(provider.calls.filter(call => call.method === "create" && "recipientUserId" in call.input && call.input.recipientUserId === ids.wu_yunfeng)).toHaveLength(1);
    expect((await database.query("SELECT status,cancelled_reason FROM rework_todos WHERE recipient_user_id=$1", [ids.wu_yunfeng])).rows.every(row => row.status === "cancelled" && row.cancelled_reason)).toBe(true);
    await expect(initiation.createDraft(actor(ids.li_junyue), { styleNo: "ROOT-STILL-WRITES" }, randomUUID())).resolves.toHaveProperty("value");
    await expect(initiation.createDraft(actor(ids.li_zhonghao), { styleNo: "LI-STILL-WRITES" }, randomUUID())).resolves.toHaveProperty("value");
  });

  it("enforces both modules against forged owner snapshots and preserves other modules and read auditing", async () => {
    for (const [action, capability] of [
      ["rework.responsibility.owner_sign", "responsibility:owner_sign"], ["rework.attachments.supplement", "tools:user"],
      ["rework.tail_inspection.waive", "tail_inspection:waive"], ["rework.responsibility.reopen", "responsibility:takeover"],
      ["sourcing.owner.approve", "sourcing:owner:approve"], ["sourcing.factory_change.effective", "sourcing:owner:approve"],
      ["sourcing.production.report", "production-reporting"], ["sourcing.ie_price.quote", "sourcing:price:quote"],
    ]) {
      await expect(tx(client => events.append(client, actor(ids.wu_yunfeng, capability), { action: action!, entityType: "rework_order", entityId: randomUUID() }))).rejects.toMatchObject({ statusCode: 403 });
    }
    for (const id of [ids.li_zhonghao, ids.li_junyue]) {
      const auth = await effectiveMemberAuthorization(database, id, ["responsibility:owner_sign", "sourcing:owner:approve"]);
      expect(auth.capabilities).toHaveLength(2); expect(auth.readOnlyModules).toEqual([]);
    }
    expect((await effectiveMemberAuthorization(database, extraOwner, ["sourcing:owner:approve", "sourcing:view"])).capabilities).toEqual(["sourcing:view"]);
    await expect(tx(client => events.append(client, actor(extraOwner, "sourcing:owner:approve"), { action: "sourcing.owner.approve", entityType: "sourcing_case", entityId: randomUUID() }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(tx(client => events.append(client, actor(ids.wu_yunfeng, "sample:update_basic"), { action: "sample.basic.update", entityType: "sample", entityId: randomUUID() }))).resolves.toBeTypeOf("string");
    await expect(tx(client => events.append(client, actor(ids.wu_yunfeng, "tools:user"), { action: "attachment.download_grant_issued", entityType: "attachment", entityId: randomUUID() }))).resolves.toBeTypeOf("string");
    expect(await memberCanReceiveFact(database, ids.wu_yunfeng, "sourcing.owner.approve", "sourcing_case")).toBe(false);
    expect(await memberCanReceiveFact(database, ids.wu_yunfeng, "pattern_room.order.create", "pattern_room_order")).toBe(true);
    const prior = (await database.query<{ todo_id: string }>("SELECT todo_id FROM rework_todos WHERE recipient_user_id=$1 LIMIT 1", [ids.wu_yunfeng])).rows[0]!;
    expect(await memberCanReceiveFact(database, ids.wu_yunfeng, "todo.escalate", "rework_todo", prior.todo_id)).toBe(false);
  });
  it("restricts revision approvals through owner membership while preserving independent production authority", async () => {
    const capability = "external_responsibility:approve_revision";
    const permission = async (id: string, roles = ["owner_group", "production_management"]) => (await database.query<{ allowed: boolean }>(
      "SELECT external_responsibility_direct_role($1,$2,$3::text[]) allowed", [id, capability, roles],
    )).rows[0]!.allowed;
    for (const id of [ids.wu_yunfeng, extraOwner]) {
      expect(await permission(id)).toBe(false);
      expect((await effectiveMemberAuthorization(database, id, [capability])).capabilities).toEqual([]);
      for (const decision of ["approved", "rejected"]) {
        await expect(tx(client => events.append(client, actor(id, capability), {
          action: `rework.external_responsibility.revision.${decision}`, entityType: "rework_order", entityId: randomUUID(),
        }))).rejects.toMatchObject({ statusCode: 403 });
      }
    }
    for (const id of [ids.li_zhonghao, ids.li_junyue]) {
      expect(await permission(id)).toBe(true);
      expect((await effectiveMemberAuthorization(database, id, [capability])).capabilities).toEqual([capability]);
    }
    const access = new AccessMasterDataService(database, "corp");
    const priorProduction = (await database.query<{ assignment_id: string }>("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='production_management' AND revoked_at IS NULL",[ids.wu_yunfeng])).rows[0]!;
    await access.revokeRole(actor(ids.li_junyue,"access:admin"),priorProduction.assignment_id,"隔离验收按唯一生产管理规则切换职责");
    const grant = await access.assignRole(actor(ids.li_junyue, "role:assign"), { userId: extraOwner, roleCode: "production_management", reason: "独立生产管理重判权限验收" });
    try {
      expect(await permission(extraOwner)).toBe(true);
      expect(await permission(extraOwner, ["production_management"])).toBe(true);
      expect(await permission(extraOwner, ["owner_group"])).toBe(false);
      expect((await database.query<{ owner: boolean; production: boolean }>(
        "SELECT todo_user_has_direct_role($1,'owner_group',$2) AS owner,todo_user_has_direct_role($1,'production_management',$2) production", [extraOwner, capability],
      )).rows[0]).toEqual({ owner: false, production: true });
      expect((await effectiveMemberAuthorization(database, extraOwner, [capability])).capabilities).toEqual([capability]);
      await expect(tx(client => events.append(client, actor(extraOwner, capability), {
        action: "rework.external_responsibility.revision.approved", entityType: "rework_order", entityId: randomUUID(),
      }))).resolves.toBeTypeOf("string");
    } finally {
      await access.revokeRole(actor(ids.li_junyue, "role:assign"), grant.assignmentId, "结束隔离生产管理兼职验收");
      await access.assignRole(actor(ids.li_junyue,"access:admin"),{userId:ids.wu_yunfeng,roleCode:"production_management",reason:"恢复隔离验收原兼职身份"});
    }
    expect(await permission(extraOwner)).toBe(false);
  });

  it("keeps a real sourcing order readable while only Li can approve and rejected writes leave the exact state intact", async () => {
    const access = new AccessMasterDataService(database, "corp");
    const supplier = await access.createSupplier(actor(ids.li_junyue,"supplier_profile:write"), CreateSupplierSchema.parse({
      supplierCode:"MEMBER-FACTORY", supplierType:"factory", supplierName:"测试成员权限工厂", active:true, changeReason:"隔离验收",
      address:"测试路1号",contractEntityName:"测试成员工厂有限公司",partyBRepresentative:"测试代表",payeeName:"测试收款人",bankAccount:"622200000000",bankName:"测试银行" }));
    const crafts = await access.ensureCrafts(actor(ids.li_junyue,"master_data:manage"), { craftNames:["成员分权验收工艺"] });
    const attachment = randomUUID();
    await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'验收.jpg','image/jpeg',128,$3,$4,'ready',CURRENT_TIMESTAMP)",[attachment,`member-test/${attachment}.jpg`,"a".repeat(64),ids.li_junyue]);
    const sourcing = new SourcingService(database,undefined,undefined,new RootAwareTodoProjectionService(todos),contracts);
    const created = await sourcing.createCase(actor(ids.li_junyue,"sourcing:inquiry:create"), {
      gender:"男装",styleName:"成员权限验收",estimatedCutPieceSendDate:"2026-09-15",deliveryDate:"2026-09-30",
      lineItems:[{styleNo:"MEMBER-SOURCE",color:"黑色",quantity:10,externalUnitPrice:"10.0000"}],daxingUnitPrice:"10.0000",attachmentIds:[attachment],
    },randomUUID());
    const id = created.value.sourcingCaseId;
    await sourcing.quoteIePrice(actor(ids.li_junyue,"sourcing:price:quote"),id,{unitPrice:"10.0000"},randomUUID());
    const decision = await sourcing.recordManagementDecision(actor(ids.li_junyue,"sourcing:decision:record"),id,{supplierId:supplier.supplierId,unitPrice:"10.0000",craftIds:crafts.map(craft=>craft.craftId)},randomUUID());
    expect(decision.value.status).toBe("pending_owner_approval");
    for (const owner of [ids.li_zhonghao,ids.wu_yunfeng,ids.li_junyue]) expect((await sourcing.getCase(actor(owner,"sourcing:view"),id)).sourcingCaseId).toBe(id);
    const before = (await database.query("SELECT * FROM sourcing_owner_decisions WHERE sourcing_case_id=$1",[id])).rowCount;
    await expect(sourcing.decideOwner(actor(ids.wu_yunfeng,"sourcing:owner:approve"),id,{decision:"approved"},randomUUID())).rejects.toMatchObject({statusCode:403});
    expect((await database.query("SELECT * FROM sourcing_owner_decisions WHERE sourcing_case_id=$1",[id])).rowCount).toBe(before);
    expect((await sourcing.getCase(actor(ids.wu_yunfeng,"sourcing:view"),id)).status).toBe("pending_owner_approval");
    expect((await sourcing.decideOwner(actor(ids.li_zhonghao,"sourcing:owner:approve"),id,{decision:"approved"},randomUUID())).value.status).toBe("pending_finance_reconciliation");
    expect((await database.query("SELECT * FROM rework_todos WHERE entity_id=$1 AND recipient_user_id=$2",[id,ids.wu_yunfeng])).rowCount).toBe(0);
    productionCaseId=id; productionSupplierId=supplier.supplierId;
  });

  it("suppresses virtual production risks and their unread counts while retaining production reads and other recipients", async () => {
    const root = actor(ids.li_junyue,"sourcing:view");
    const contract = (await contracts.getCurrent(root,productionCaseId)).item!;
    const production = new SourcingProductionService(database);
    const dispatched = await production.dispatch(root,productionCaseId,{sourcingContractDocumentId:contract.sourcingContractDocumentId,confirmed:true},randomUUID());
    const id = dispatched.value.productionOrderId;
    const closure = new ProductionClosureService(database,undefined,()=>new Date(Date.now()+3*86400000));
    const reporting = new ProductionReportingService(database,undefined,undefined,closure);
    await closure.setPilot(root,{supplierId:productionSupplierId,enabled:true});
    await reporting.report(root,id,{position:1,businessDate:shanghaiDay(new Date()),quantity:1},randomUUID());
    const view = (userId:string) => actor(userId,"todo:view");
    const allowed = await closure.todos(view(ids.li_zhonghao));
    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toMatchObject({category:"production_stale",unread:true,entityId:id});
    expect((await closure.todos(view(ids.li_junyue))).map(todo=>todo.todoId)).toContain(allowed[0]!.todoId);
    expect(await closure.todos(view(ids.wu_yunfeng))).toEqual([]);
    const combined = new TodoService(database,undefined,undefined,closure);
    const list = await combined.listForActor(view(ids.wu_yunfeng),{module:"production"});
    expect(list.todos).toEqual([]);
    expect(list.moduleCounts.production).toBe(0);
    expect(await combined.countIndicatorForActor(view(ids.wu_yunfeng))).toEqual({pendingCount:0});
    expect((await combined.countIndicatorForActor(view(ids.li_zhonghao))).pendingCount).toBeGreaterThan(0);
    await expect(closure.markRead(view(ids.wu_yunfeng),allowed[0]!.todoId)).rejects.toMatchObject({statusCode:404});
    expect((await production.get(actor(ids.wu_yunfeng,"sourcing:view"),id)).productionOrderId).toBe(id);
    expect((await database.query("SELECT 1 FROM sourcing_production_alerts WHERE alert_id=$1 AND resolved_at IS NULL",[allowed[0]!.todoId])).rowCount).toBe(1);
  });

});
