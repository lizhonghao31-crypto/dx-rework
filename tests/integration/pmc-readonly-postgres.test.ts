import { ownedPostgresSchema, createOwnedPostgresSchema, releaseOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CUTTING_FINANCE_READ_ROLES, PMC_READ_CAPABILITIES } from "@dx-rework/contracts";
import { applyMigrations, discoverValidatedMigrations } from "../../scripts/migration-lib.mjs";
import { assertTestDatabaseTarget } from "../../scripts/test-database-safety.mjs";
import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { PostgresAuthStore } from "../../apps/api/src/auth/postgres-store.js";
import { SupplierOnboardingService } from "../../apps/api/src/access/supplier-onboarding-service.js";
import { registerSupplierOnboardingRoutes } from "../../apps/api/src/access/supplier-onboarding-routes.js";
import { RootAuthority } from "../../apps/api/src/access/root-authority.js";
import { AttachmentService } from "../../apps/api/src/tools/attachments.js";
import { registerToolsRoutes } from "../../apps/api/src/tools/routes.js";
import { ExportJobService } from "../../apps/api/src/tools/exports.js";
import { registerPmcReadonlyHttpGuard } from "../../apps/api/src/access/pmc-readonly-http.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import type { ObjectStorage } from "../../apps/api/src/tools/storage.js";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("PMC full-schema independent read authority", () => {
  const schema = ownedPostgresSchema("pmc_role");
  const scoped = new URL(url ?? "postgresql://unused/unused");scoped.searchParams.set("options", `-c search_path=${schema}`);
  const admin = new pg.Pool({ connectionString: url });
  const db = new pg.Pool({ connectionString: scoped.toString() });
  const access = new AccessMasterDataService(db, "corp");
  const ids: Record<string, string> = {};
  const actors: Record<string, TrustedActorContext> = {};
  const root = () => actors.root!;
  const pmcMigration = "0232_pmc_readonly_role";
  let laterVersions: string[];
  let oldHistory: unknown[], oldGrants: unknown[], oldCapabilities: unknown[];
  const financeRead = "cutting:orders:view";
  const financeRoles = [
    "finance_director", "finance_read", "factory_payables", "embroidery_washing_payables",
    "fabric_payables", "wage_month_close_accountant",
  ];
  const input = (name: string) => ({ supplierCode: `PMC_${randomUUID().slice(0,8).toUpperCase()}`, supplierName: name, supplierType: "factory" as const,
    active: true, notes: "", supportedCrafts: ["车缝"], dailyCapacity: 100, contactPerson: "TEST联系人", contactPhone: "123456789", address: "TEST地址",
    contractEntityName: null, partyBRepresentative: null, payeeName: "TEST收款人", bankAccount: "001234567890", bankName: "TEST银行", changeReason: "隔离测试" });
  const session = async (name: string) => {
    const token = `pmc-test-${name}-${randomUUID()}`;
    const store = new PostgresAuthStore(db, "corp");
    await store.createSession({ id: randomUUID(), tokenHash: createHash("sha256").update(token).digest("hex"), userId: ids[name]!, expiresAt: new Date(Date.now()+3600000), revokedAt: null });
    return (await store.findSession(createHash("sha256").update(token).digest("hex"), new Date()))!.user;
  };
  beforeAll(async () => {
    await assertTestDatabaseTarget(url!);
    await createOwnedPostgresSchema(admin, schema);
    // Genuine previous schema, then the official incremental migrator; no partial DDL fixtures.
    await db.query("CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    const migrations = await discoverValidatedMigrations();
    const pmcIndex = migrations.findIndex(migration => migration.version === pmcMigration);
    expect(pmcIndex).toBeGreaterThan(0);
    laterVersions = migrations.slice(pmcIndex).map(migration => migration.version);
    for (const migration of migrations.slice(0,pmcIndex)) {
      await db.query("BEGIN");await db.query(migration.sql);
      await db.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [migration.version,migration.checksum]);await db.query("COMMIT");
    }
    oldHistory = (await db.query("SELECT * FROM schema_migrations ORDER BY version")).rows;
    oldGrants = (await db.query("SELECT * FROM user_role_assignments ORDER BY assignment_id")).rows;
    oldCapabilities = (await db.query("SELECT * FROM role_capabilities ORDER BY role_code,capability")).rows;
    expect((await applyMigrations(scoped.toString())).applied).toEqual(laterVersions);
    expect(laterVersions[0]).toBe(pmcMigration);
    expect((await db.query("SELECT * FROM user_role_assignments ORDER BY assignment_id")).rows).toEqual(oldGrants);
    await access.ensureOrganizationPolicy();
    for (const [name, roles] of Object.entries({ root: [], pm: ["production_management"], pmc: ["pmc"], multi: ["pmc","pattern_room_worker"], applicant: ["order_merchandiser"], worker: ["worker"], disabled: ["pmc"] })) {
      const id=randomUUID();ids[name]=id;
      await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",[id,name]);
      await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','corp',$3,$3,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id,name]);
      actors[name]={actorId:id,actorRoles:roles,authorizationCapability:"access:admin",authorizationCapabilities:["access:admin"],requestId:randomUUID()};
      if(name==="root") { actors[name]!.actorRoles=["root_superuser"];await db.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,'root','corp')",[id]); }
      else for(const roleCode of roles) await access.assignRole({...root(),requestId:randomUUID()},{userId:id,roleCode,reason:"PMC隔离回归"});
    }
  },120000);
  afterAll(async () => { await db.end();await releaseOwnedPostgresSchema(admin, schema);await admin.end(); });

  it("appends only the independent role/read grants, preserving historical checksums/timestamps and zero employee grants", async () => {
    expect((await db.query("SELECT * FROM schema_migrations WHERE version < $1 ORDER BY version",[pmcMigration])).rows).toEqual(oldHistory);
    const caps=(await db.query<{capability:string}>("SELECT capability FROM role_capabilities WHERE role_code='pmc' ORDER BY capability")).rows.map(r=>r.capability);
    expect(caps).toEqual([...PMC_READ_CAPABILITIES].sort());
    const untouched = await db.query("SELECT * FROM role_capabilities WHERE role_code=ANY($1::text[]) ORDER BY role_code,capability",
      [[...new Set((oldCapabilities as {role_code:string}[]).map(row=>row.role_code))]]);
    const approvedFinance = new Set(financeRoles);
    const financeCutting = untouched.rows.filter(row => approvedFinance.has(row.role_code) && row.capability === financeRead);
    expect(financeCutting.map(({role_code,capability})=>({role_code,capability}))).toEqual(financeRoles.toSorted().map(role_code => ({ role_code, capability: financeRead })));
    expect(untouched.rows.filter(row => !approvedFinance.has(row.role_code) || row.capability !== financeRead)).toEqual(oldCapabilities);
    expect((await db.query("SELECT display_name,enabled FROM business_roles WHERE role_code='pmc'")).rows).toEqual([{display_name:"PMC",enabled:true}]);
    expect((await applyMigrations(scoped.toString())).applied).toEqual([]);
  });
  it("authorizes every frozen read and rejects every other catalog capability at the database boundary", async () => {
    const catalog=(await db.query<{capability:string}>("SELECT capability FROM capability_catalog")).rows;
    for(const {capability} of catalog) {
      if((PMC_READ_CAPABILITIES as readonly string[]).includes(capability)) expect((await db.query("SELECT access_authorized_actor_roles($1,$2) roles",[ids.pmc,capability])).rows[0].roles).toEqual(["pmc"]);
      else await expect(db.query("SELECT access_authorized_actor_roles($1,$2)",[ids.pmc,capability]),capability).rejects.toMatchObject({code:"42501"});
    }
    for(const [fn,cap] of [["pattern_room_authorized_order_roles","pattern_room:orders:view"],["pattern_room_authorized_price_roles","pattern_room:prices:read"],["cutting_authorized_roles","cutting:orders:view"],["finance_authorized_wage_roles","wage:view"],["supplier_onboarding_authorized_roles","read"]]) {
      expect((await db.query(`SELECT ${fn}($1,$2) roles`,[ids.pmc,cap])).rows[0].roles).toEqual(["pmc"]);
    }
    for(const [fn,cap] of [["pattern_room_authorized_order_roles","pattern_room:orders:complete"],["pattern_room_authorized_price_roles","pattern_room:prices:write"],["cutting_authorized_roles","cutting:records:create"],["finance_authorized_wage_roles","wage:settlement_mark"],["supplier_onboarding_authorized_roles","approve"]]) await expect(db.query(`SELECT ${fn}($1,$2)`,[ids.pmc,cap])).rejects.toMatchObject({code:"42501"});
    expect((await db.query("SELECT external_responsibility_can_view_all($1) allowed,own_factory_approval_can_view($1,$2) own",[ids.pmc,randomUUID()])).rows[0]).toEqual({allowed:true,own:true});
  });
  it("authorizes exactly six new finance cutting readers through real sessions and SQL",async()=>{
    expect([...CUTTING_FINANCE_READ_ROLES]).toEqual(financeRoles);
    const idsByRole = new Map<string,string>();
    for (const role of [...financeRoles, "sample_finance"]) {
      const id = randomUUID(); ids[role] = id; idsByRole.set(role,id);
      await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",[id,"TEST "+role]);
      await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','corp',$3,$3,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id,role]);
      await access.assignRole({...root(),requestId:randomUUID()},{userId:id,roleCode:role,reason:"TEST finance cutting grant"});
      const user = await session(role);
      expect(user.businessRoles).toEqual([role]);
      if (role === "sample_finance") {
        expect(user.capabilities).not.toContain(financeRead);
        await expect(db.query("SELECT cutting_authorized_roles($1,$2)",[id,financeRead])).rejects.toMatchObject({code:"42501"});
      } else {
        expect(user.capabilities).toContain(financeRead);
        expect((await db.query("SELECT cutting_authorized_roles($1,$2) AS roles",[id,financeRead])).rows[0].roles).toEqual([role]);
      }
      for (const capability of ["cutting:records:create","cutting:records:correct"]) {
        expect(user.capabilities).not.toContain(capability);
        await expect(db.query("SELECT cutting_authorized_roles($1,$2)",[id,capability])).rejects.toMatchObject({code:"42501"});
      }
    }
    const sampleId=idsByRole.get("sample_finance")!;
    const grant=await access.assignRole({...root(),requestId:randomUUID()},{userId:sampleId,roleCode:"finance_read",reason:"TEST dual-role union"});
    const store=new PostgresAuthStore(db,"corp"),tokenHash=createHash("sha256").update(randomUUID()).digest("hex");
    await store.createSession({id:randomUUID(),tokenHash,userId:sampleId,expiresAt:new Date(Date.now()+3600000),revokedAt:null});
    expect((await store.findSession(tokenHash,new Date()))!.user.capabilities).toContain(financeRead);
    await access.revokeRole({...root(),requestId:randomUUID()},grant.assignmentId,"TEST revoke temporary finance read");
    const remaining=(await store.findSession(tokenHash,new Date()))!.user;
    expect(remaining.businessRoles).toEqual(["sample_finance"]);
    expect(remaining.capabilities).not.toContain(financeRead);
    await expect(db.query("SELECT cutting_authorized_roles($1,$2)",[sampleId,financeRead])).rejects.toMatchObject({code:"42501"});
  });
  it("filters delegated writes in real sessions and SQL without revoking other roles or Root",async()=>{
    await access.createDelegation(root(),{grantorUserId:ids.pm!,granteeUserId:ids.pmc!,capability:"sourcing:decision:record",scopeType:"global",validFrom:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+3600000).toISOString(),reason:"测试不能升级纯PMC"});
    const user=await session("pmc");expect(user.capabilities).toEqual(expect.arrayContaining([...PMC_READ_CAPABILITIES]));
    expect(user.capabilities).not.toContain("sourcing:decision:record");expect(user.readOnlyModules).toEqual(expect.arrayContaining(["rework","sourcing"]));
    await expect(db.query("SELECT access_authorized_actor_roles($1,'sourcing:decision:record')",[ids.pmc])).rejects.toMatchObject({code:"42501"});
    const pm=await session("pm");
    await access.assignRole({...root(),requestId:randomUUID()},{userId:ids.pm!,roleCode:"pmc",reason:"叠加只读岗不改变原生产管理操作"});
    const multi=await session("pm");
    expect([...multi.capabilities].filter(c=>!PMC_READ_CAPABILITIES.includes(c as never)).sort()).toEqual([...pm.capabilities].filter(c=>!PMC_READ_CAPABILITIES.includes(c as never)).sort());
    expect(multi.readOnlyModules).not.toContain("sourcing");
    expect((await db.query("SELECT pattern_room_authorized_order_roles($1,'pattern_room:orders:complete') roles",[ids.multi])).rows[0].roles).toEqual(["pattern_room_worker","pmc"]);
    for(const name of ["pm","root"]) expect((await db.query("SELECT pattern_room_authorized_price_roles($1,'pattern_room:prices:write') roles",[ids[name]])).rows[0].roles).toContain(name==="root"?"root_superuser":"production_management");
  });
  it("reads the same real supplier application/profile/history but rejects direct/HTTP approval and supplier mutations",async()=>{
    const service=new SupplierOnboardingService(db);
    const {supplierCode:_code,changeReason:_reason,...profile}=input("TEST PMC申请");void _code;void _reason;
    const submitted=await service.submit({...actors.applicant!,authorizationCapability:"supplier_onboarding:request"},profile,randomUUID());
    const pm={...actors.pm!,authorizationCapability:"supplier_onboarding:approve"},pmc={...actors.pmc!,authorizationCapability:"supplier_onboarding:read"};
    expect(await service.list(pmc,"all")).toEqual(await service.list(pm,"all"));
    const detail=await service.get(pmc,submitted.response.requestId);expect(detail.profile).toEqual((await service.get(pm,submitted.response.requestId)).profile);expect(detail.duplicateCheck).toBeDefined();
    await expect(service.decide(pmc,detail.requestId,"approved",{version:1},randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(access.createSupplier({...pmc,authorizationCapability:"supplier_profile:write"},input("禁止新增"))).rejects.toMatchObject({statusCode:403});
    await expect(access.previewSupplierBatch({...pmc,authorizationCapability:"supplier_profile:write"},[])).rejects.toMatchObject({statusCode:403});
    const rootAuthority=new RootAuthority(db,"corp","root");const user=await session("pmc");const app=Fastify();
    registerPmcReadonlyHttpGuard(app,async()=>user);registerSupplierOnboardingRoutes(app,{authenticate:async()=>user,root:rootAuthority,service});
    try {
      expect((await app.inject({url:"/supplier-onboarding/requests?scope=all"})).statusCode).toBe(200);
      expect((await app.inject({url:`/supplier-onboarding/requests/${detail.requestId}`})).statusCode).toBe(200);
      expect((await app.inject({method:"POST",url:`/supplier-onboarding/requests/${detail.requestId}/approve`,headers:{cookie:"dx_rework_session=test","idempotency-key":randomUUID()},payload:{version:1}})).statusCode).toBe(403);
      expect((await db.query("SELECT * FROM supplier_onboarding_decisions WHERE request_id=$1",[detail.requestId])).rowCount).toBe(0);
    }finally{await app.close();}
    const created=await access.createSupplier({...pm,authorizationCapability:"supplier_profile:write"},input("TEST PMC供应商"));
    const supplier=await access.getSupplier(created.supplierId,true);expect(supplier.contactPhone).toBe("123456789");expect((await access.listSupplierHistory(created.supplierId,true)).length).toBe(1);
  });
  it("retains bound-attachment scope, permits existing export metadata, and denies upload side effects/service/SQL bypasses",async()=>{
    let grants=0,uploads=0;
    const storage={createDownloadGrant:async()=>{grants++;return{downloadUrl:"https://example.invalid/read",expiresAt:new Date(Date.now()+60000).toISOString()};},writeImmutable:async()=>undefined,deleteObject:async()=>undefined,createExactSizeNonOverwritableUploadGrant:async()=>{uploads++;throw new Error("must not upload");}} as unknown as ObjectStorage;
    const attachments=new AttachmentService(db,storage,{prefix:"test",maxUploadBytes:10000,ttlSeconds:60});
    const id=randomUUID(),hidden=randomUUID(),owner=ids.pm!;
    for(const attachmentId of [id,hidden]) await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,entity_type,entity_id,status,ready_at) VALUES($1,$2,'TEST.pdf','application/pdf',1,$3,$4,'test_business',$5,'ready',CURRENT_TIMESTAMP)",[attachmentId,attachmentId,"a".repeat(64),owner,attachmentId]);
    const user=await session("pmc"),trusted={...actors.pmc!,authorizationCapability:"tools:read",authorizationCapabilities:user.capabilities};
    const app=Fastify();registerToolsRoutes(app,{authenticate:async()=>user,attachments,exports:new ExportJobService(db),canDownloadBoundAttachment:async(_actor,binding)=>binding.attachmentId===id});
    try {
      expect((await app.inject({url:`/tools/attachments/${id}/download`})).statusCode).toBe(200);
      expect((await app.inject({url:`/tools/attachments/${hidden}/download`})).statusCode).toBe(403);
      expect(grants).toBe(1);
      await expect(attachments.createUploadIntent(trusted,{filename:"TEST.pdf",mimeType:"application/pdf",sizeBytes:1,sha256:"a".repeat(64)})).rejects.toMatchObject({statusCode:403});
      await expect(attachments.finalize(trusted,id)).rejects.toMatchObject({statusCode:403});expect(uploads).toBe(0);
      await expect(db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by) VALUES($1::uuid,$1::text,'TEST.pdf','application/pdf',1,$2,$3)",[randomUUID(),"a".repeat(64),ids.pmc])).rejects.toMatchObject({code:"42501"});
      const created=await app.inject({method:"POST",url:"/tools/exports",payload:{exportType:"report",filters:{},idempotencyKey:randomUUID()}});expect(created.statusCode).toBe(201);
      const exports=new ExportJobService(db),client=await db.connect();let claimed;
      try{await client.query("BEGIN");claimed=(await exports.claim(client))[0]!;await client.query("COMMIT");}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
      expect(claimed.export_job_id).toBe(created.json().exportJobId);
      const result=await attachments.storeGenerated(trusted,{filename:"TEST-export.pdf",mimeType:"application/pdf",content:Buffer.from("TEST-generated-report"),entityType:"export_job",entityId:claimed.export_job_id});
      await exports.complete(db,claimed.export_job_id,claimed.claim_token!,result.attachmentId);
      expect((await app.inject({url:`/tools/attachments/${result.attachmentId}/download`})).statusCode).toBe(200);
    }finally{await app.close();}
  });
  it("denies inactive/foreign-organization identities rather than using a stale PMC snapshot",async()=>{
    await db.query("UPDATE identity_mappings SET employed=false WHERE user_id=$1",[ids.disabled]);
    await expect(db.query("SELECT access_authorized_actor_roles($1,'sourcing:view')",[ids.disabled])).rejects.toMatchObject({code:"42501"});
    const service=new SupplierOnboardingService(db);
    await expect(service.list({...actors.disabled!,authorizationCapability:"supplier_onboarding:read"},"all")).rejects.toMatchObject({statusCode:403});
    await expect(db.query("UPDATE identity_mappings SET corp_id='unrelated-corp' WHERE user_id=$1",[ids.disabled])).rejects.toMatchObject({code:"55000"});
    const foreignId=randomUUID();
    await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'foreign',true)",[foreignId]);
    await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','unrelated-corp','foreign','foreign',true,true,CURRENT_TIMESTAMP)",[randomUUID(),foreignId]);
    await expect(access.assignRole({...root(),requestId:randomUUID()},{userId:foreignId,roleCode:"pmc",reason:"拒绝外公司身份"})).rejects.toMatchObject({statusCode:404});
    await expect(db.query("SELECT access_authorized_actor_roles($1,'wage:view')",[ids.disabled])).rejects.toMatchObject({code:"42501"});
  });
});
