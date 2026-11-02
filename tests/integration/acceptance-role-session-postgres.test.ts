import { ownedPostgresSchema, createOwnedPostgresSchema, releaseOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadConfig } from "@dx-rework/config";
import { CreateSupplierSchema, PMC_READ_CAPABILITIES } from "@dx-rework/contracts";
import { QC_PROGRESS_CAPABILITY } from "@dx-rework/contracts/qc-production-progress";
import { SupplierOnboardingProfileSchema, type SupplierOnboardingDetail } from "@dx-rework/contracts/supplier-onboarding";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RootAuthority } from "../../apps/api/src/access/root-authority.js";
import { businessActor } from "../../apps/api/src/access/business-authority.js";
import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { SupplierOnboardingService } from "../../apps/api/src/access/supplier-onboarding-service.js";
import { buildApp } from "../../apps/api/src/app.js";
import { mintAcceptanceControlCode } from "../../apps/api/src/auth/acceptance-control.js";
import {
  AcceptanceDingTalkProvider,
  mintAcceptanceLoginCode,
} from "../../apps/api/src/auth/acceptance-provider.js";
import { PostgresAuthStore } from "../../apps/api/src/auth/postgres-store.js";
import { AuthService } from "../../apps/api/src/auth/service.js";
import { DigitalCockpitQuery } from "../../apps/api/src/production-platform/cockpit-query.js";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { ProductionDashboardService } from "../../apps/api/src/sourcing/production-dashboard-service.js";
import { ProductionReportingService } from "../../apps/api/src/sourcing/production-reporting-service.js";
import { SourcingService } from "../../apps/api/src/sourcing/sourcing-service.js";
import { AttachmentService } from "../../apps/api/src/tools/attachments.js";
import { ExportJobService } from "../../apps/api/src/tools/exports.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import type { ObjectStorage } from "../../apps/api/src/tools/storage.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
const inertDatabaseUrl = databaseUrl ?? "postgresql://acceptance:acceptance@127.0.0.1:1/acceptance_skip";
const runWithPostgres = databaseUrl ? describe : describe.skip;
type Manifest = { migrations: Array<{ version: string; checksum: string }> };

runWithPostgres("acceptance role sessions", () => {
  const schema = ownedPostgresSchema("acceptance_roles");
  const admin = new Pool({ connectionString: inertDatabaseUrl });
  const database = new Pool({
    connectionString: inertDatabaseUrl,
    options: `-c search_path=${schema}`,
  });
  const corpId = "corp-acceptance";
  const acceptanceSecret = "acceptance-role-session-secret-with-more-than-32-characters";
  const sessionSecret = "acceptance-session-secret-with-more-than-32-characters";
  const ids = {
    root: randomUUID(),
    worker: randomUUID(),
    pmc: randomUUID(),
    production: randomUUID(),
    applicant: randomUUID(),
    qc: randomUUID(),
    financeDirector: randomUUID(),
  };

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: inertDatabaseUrl,
    DINGTALK_CORP_ID: corpId,
    DINGTALK_H5_APP_KEY: "acceptance-disabled",
    DINGTALK_H5_APP_SECRET: "acceptance-disabled",
    DINGTALK_WEB_CLIENT_ID: "acceptance-disabled",
    DINGTALK_WEB_CLIENT_SECRET: "acceptance-disabled",
    DINGTALK_QR_REDIRECT_URI: "https://acceptance.invalid/auth/qr/callback",
    SESSION_SECRET: sessionSecret,
    ROOT_DINGTALK_USER_ID: "uat-root",
    ACCEPTANCE_LAB_ENABLED: "true",
    ACCEPTANCE_LAB_SECRET: acceptanceSecret,
  });

  const rootAuthority = new RootAuthority(database, corpId, "uat-root");
  const store = new PostgresAuthStore(database, corpId, "uat-root");
  const provider = new AcceptanceDingTalkProvider(database, corpId, acceptanceSecret);
  const auth = new AuthService(provider, store, corpId, 60 * 60_000, sessionSecret);
  const access = new AccessMasterDataService(database, corpId);
  const onboarding = new SupplierOnboardingService(database);
  const exportJobs = new ExportJobService(database);
  const readableAttachmentId = randomUUID(), boundEntityId = randomUUID();
  const downloadedObjects: string[] = [];
  let uploadGrants = 0;
  const storage = {
    createDownloadGrant: async (objectKey: string) => {
      downloadedObjects.push(objectKey);
      return { downloadUrl: "https://example.invalid/pmc-read", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
    writeImmutable: async () => undefined,
    deleteObject: async () => undefined,
    createExactSizeNonOverwritableUploadGrant: async () => { uploadGrants++; throw new Error("Pure PMC must not upload"); },
  } as unknown as ObjectStorage;
  const attachments = new AttachmentService(database, storage, { prefix: "TEST-pmc-session", maxUploadBytes: 10_000, ttlSeconds: 60 });
  const reporting = new ProductionReportingService(database);
  const rootActor = {
    actorId: ids.root,
    actorRoles: ["root_superuser", "owner_group"],
    authorizationCapability: "access:admin",
    authorizationCapabilities: ["access:admin", "supplier_profile:write"],
    requestId: randomUUID(),
  };
  let supplierId: string;
  const app = buildApp({
    config,
    checkDatabase: async () => undefined,
    getAppliedSchemaHistory: async () => null,
    auth,
    access: {
      authenticate: (token) => auth.authenticate(token),
      service: access,
      root: rootAuthority,
    },
    supplierOnboarding: { authenticate: (token) => auth.authenticate(token), root: rootAuthority, service: onboarding },
    tools: {
      authenticate: (token) => auth.authenticate(token),
      isRootUser: (id) => rootAuthority.isRootUser(id),
      attachments, exports: exportJobs,
      // Reuse #879's persisted-binding boundary fixture. Native business-object
      // attachment/history authorization is exercised by the existing business chain.
      canDownloadBoundAttachment: async (_actor, binding) => binding.attachmentId === readableAttachmentId
        && binding.entityType === "test_business" && binding.entityId === boundEntityId,
    },
    sourcing: {
      authenticate: (token) => auth.authenticate(token),
      root: rootAuthority,
      service: new SourcingService(database),
      reporting,
      dashboard: new ProductionDashboardService(database, reporting),
    },
    digitalIdentity: {
      authenticate: (token) => auth.authenticate(token),
      root: rootAuthority,
      service: new DigitalProductionIdentityService(database, true),
      creationEnabled: true,
      cockpit: new DigitalCockpitQuery(database),
    },
  });

  const seedUser = async (userId: string, alias: string, displayName: string, roleCode: string) => {
    await database.query(
      "INSERT INTO app_users(id,display_name,enabled,manual_access_disabled) VALUES($1,$2,true,false)",
      [userId, displayName],
    );
    await database.query(
      `INSERT INTO identity_mappings(
         id,user_id,provider,corp_id,provider_user_id,union_id,
         active,employed,last_verified_at
       ) VALUES($1,$2,'dingtalk',$3,$4,$5,true,true,CURRENT_TIMESTAMP)`,
      [randomUUID(), userId, corpId, `uat-${alias}`, `uat-union-${alias}`],
    );
    await database.query(
      `INSERT INTO user_role_assignments(
         assignment_id,user_id,role_code,granted_by,grant_reason
       ) VALUES($1,$2,$3,$4,'隔离验收身份')`,
      [randomUUID(), userId, roleCode, ids.root],
    );
  };

  beforeAll(async () => {
    await createOwnedPostgresSchema(admin,schema);
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

    await seedUser(ids.root, "root", "[UAT] Root", "owner_group");
    await seedUser(ids.worker, "worker-a", "[UAT] 工人甲", "worker");
    await seedUser(ids.pmc, "pmc", "[UAT] 纯 PMC", "pmc");
    await seedUser(ids.production, "pmc-production", "[UAT] 生产管理对照", "production_management");
    await seedUser(ids.applicant, "pmc-applicant", "[UAT] 申请人", "order_merchandiser");
    await seedUser(ids.qc, "qc", "[UAT] 纯质检", "quality_control");
    await seedUser(ids.financeDirector, "finance-director", "[UAT] 财务总监", "finance_director");
    await database.query(
      `INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id)
       VALUES(true,$1,'uat-root',$2)`,
      [ids.root, corpId],
    );
    await access.ensureOrganizationPolicy();
    await rootAuthority.assertConfigurationConsistency();
    supplierId = (await access.createSupplier(rootActor, CreateSupplierSchema.parse({
      supplierCode: "TEST-SESSION-PMC", supplierType: "factory", supplierName: "TEST isolated session supplier",
      address: "TEST", contractEntityName: "TEST", partyBRepresentative: "TEST", payeeName: "TEST",
      bankAccount: "TEST0001", bankName: "TEST", contactPerson: "TEST联系人", contactPhone: "TEST123456",
      changeReason: "TEST native supplier for PMC reads",
    }))).supplierId;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.end();
    await releaseOwnedPostgresSchema(admin,schema);
    await admin.end();
  });

  let loginClientNumber = 1, loginRemoteAddress = "127.0.0.1";
  beforeEach(() => {
    // Each case is an independent client of the shared app. Replays inside a
    // case retain the same client and the production login limits stay active.
    loginRemoteAddress = `127.0.0.${++loginClientNumber}`;
  });

  const login = async (alias: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/mobile",
      remoteAddress: loginRemoteAddress,
      payload: { code: mintAcceptanceLoginCode(alias, acceptanceSecret) },
    });
    expect(response.statusCode).toBe(200);
    const header = response.headers["set-cookie"];
    const raw = Array.isArray(header) ? header[0] : header;
    expect(raw).toContain("dx_rework_session=");
    return raw!.split(";", 1)[0]!;
  };

  const authenticatedActor = async (cookie: string, capability: string) => businessActor(
    rootAuthority, await auth.authenticate(cookie.slice("dx_rework_session=".length)), randomUUID(), capability,
  );

  // Adapted from #879 at 595e47e403b8f370736c869ce8f535d1a6c06fc5.
  // Reuse this full-schema fixture; 0232 is already part of release history.
  it("retains the frozen PMC database grants and rejects catalog writes through the original SQL authorities", async () => {
    const capabilities = (await database.query<{ capability: string }>("SELECT capability FROM role_capabilities WHERE role_code='pmc' ORDER BY capability")).rows.map(row => row.capability);
    expect(capabilities).toEqual([...PMC_READ_CAPABILITIES].sort());
    const catalog = (await database.query<{ capability: string }>("SELECT capability FROM capability_catalog")).rows;
    for (const { capability } of catalog) {
      if ((PMC_READ_CAPABILITIES as readonly string[]).includes(capability)) {
        expect((await database.query("SELECT access_authorized_actor_roles($1,$2) roles", [ids.pmc, capability])).rows[0].roles).toEqual(["pmc"]);
      } else {
        await expect(database.query("SELECT access_authorized_actor_roles($1,$2)", [ids.pmc, capability]), capability).rejects.toMatchObject({ code: "42501" });
      }
    }
    for (const [fn, read, write] of [
      ["pattern_room_authorized_order_roles", "pattern_room:orders:view", "pattern_room:orders:complete"],
      ["pattern_room_authorized_price_roles", "pattern_room:prices:read", "pattern_room:prices:write"],
      ["cutting_authorized_roles", "cutting:orders:view", "cutting:records:create"],
      ["finance_authorized_wage_roles", "wage:view", "wage:settlement_mark"],
      ["supplier_onboarding_authorized_roles", "read", "approve"],
    ]) {
      expect((await database.query(`SELECT ${fn}($1,$2) roles`, [ids.pmc, read])).rows[0].roles).toEqual(["pmc"]);
      await expect(database.query(`SELECT ${fn}($1,$2)`, [ids.pmc, write])).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("creates independent real sessions whose authorization is loaded from role assignments", async () => {
    const workerCookie = await login("worker-a");
    const financeCookie = await login("finance-director");
    const pmcCookie = await login("pmc");
    const qcCookie = await login("qc");

    const worker = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: workerCookie } });
    const finance = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: financeCookie } });
    const pmc = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: pmcCookie } });
    const qc = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: qcCookie } });

    for (const response of [worker, finance, pmc, qc]) expect(response.statusCode).toBe(200);

    expect(worker.json()).toMatchObject({
      status: "authorized",
      user: { id: ids.worker, isRoot: false, businessRoles: ["worker"] },
    });
    expect(finance.json()).toMatchObject({
      status: "authorized",
      user: { id: ids.financeDirector, isRoot: false, businessRoles: ["finance_director"] },
    });
    expect(worker.json().user.capabilities).not.toEqual(finance.json().user.capabilities);
    expect(worker.json().user.businessRoles).toEqual(["worker"]);
    expect(worker.json().user.capabilities).toContain("work:report");
    expect(worker.json().user.capabilities).not.toContain(QC_PROGRESS_CAPABILITY);
    expect(pmc.json().user).toMatchObject({ id: ids.pmc, isRoot: false, businessRoles: ["pmc"] });
    expect(pmc.json().user.businessRoles).toEqual(["pmc"]);
    expect(pmc.json().user.capabilities).toEqual([...PMC_READ_CAPABILITIES].sort());
    expect(qc.json().user).toMatchObject({ id: ids.qc, isRoot: false, businessRoles: ["quality_control"] });
    expect(qc.json().user.businessRoles).toEqual(["quality_control"]);
    expect(qc.json().user.capabilities).toContain(QC_PROGRESS_CAPABILITY);
    expect(qc.json().user.capabilities).not.toContain("production-reporting");
  });

  it("uses a pure PMC real cookie for business reads and HTTP write denial while retaining a separately granted worker role", async () => {
    const cookie = await login("pmc");
    const headers = { cookie };
    for (const url of ["/sourcing/cases?page=1", "/master-data/suppliers", "/production-dashboard", "/digital-production/cockpit?stage=bulk"]) {
      const response = await app.inject({ method: "GET", url, headers });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    }
    const supplier = await app.inject({ method: "GET", url: `/master-data/suppliers/${supplierId}`, headers });
    expect(supplier.statusCode).toBe(200);
    expect(supplier.body).toContain("TEST isolated session supplier");
    for (const url of ["/sourcing/cases", "/master-data/suppliers", "/digital-production/orders"]) {
      const response = await app.inject({ method: "POST", url, headers: { ...headers, "idempotency-key": randomUUID() }, payload: {} });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    }
    const assignment = await access.assignRole(rootActor, { userId: ids.pmc, roleCode: "worker", reason: "TEST legitimate additional worker role" });
    try {
      const combined = await app.inject({ method: "GET", url: "/auth/me", headers });
      expect(combined.statusCode).toBe(200);
      expect(combined.json().user.id).toBe(ids.pmc);
      expect(combined.json().user.businessRoles).toEqual(["pmc", "worker"]);
      expect(combined.json().user.capabilities).toEqual(expect.arrayContaining(["work:report", "tools:user", "sourcing:view"]));
      expect(combined.json().user.isRoot).toBe(false);
    } finally {
      await access.revokeRole(rootActor, assignment.assignmentId, "TEST remove only temporary worker role");
    }
    const pureAgain = await app.inject({ method: "GET", url: "/auth/me", headers });
    expect(pureAgain.statusCode).toBe(200);
    expect(pureAgain.headers["set-cookie"]).toBeUndefined();
    expect(pureAgain.json().user.id).toBe(ids.pmc);
    expect(pureAgain.json().user.businessRoles).toEqual(["pmc"]);
    expect(pureAgain.json().user.capabilities).toEqual([...PMC_READ_CAPABILITIES].sort());
  });

  it("matches the manager's real supplier application, sensitive profile and history while delegated PMC writes preserve facts", async () => {
    const pmcHeaders = { cookie: await login("pmc") }, managerHeaders = { cookie: await login("pmc-production") };
    const applicantHeaders = { cookie: await login("pmc-applicant"), "idempotency-key": randomUUID() };
    const profile = SupplierOnboardingProfileSchema.parse({ supplierType: "factory", supplierName: "TEST PMC session application",
      active: true, notes: "TEST", supportedCrafts: ["车缝"], dailyCapacity: 100, contactPerson: "TEST联系人", contactPhone: "TEST123456",
      address: "TEST地址", contractEntityName: null, partyBRepresentative: null, payeeName: "TEST收款人", bankAccount: "TEST001234", bankName: "TEST银行" });
    const submitted = await app.inject({ method: "POST", url: "/supplier-onboarding/requests", headers: applicantHeaders, payload: profile });
    expect(submitted.statusCode, submitted.body).toBe(200);
    const requestId: string = submitted.json().requestId, path = `/supplier-onboarding/requests/${requestId}`;
    const pmcActor = await authenticatedActor(pmcHeaders.cookie, "supplier_onboarding:read");
    const facts = async () => Promise.all([
      database.query("SELECT * FROM supplier_onboarding_requests WHERE request_id=$1", [requestId]),
      database.query("SELECT * FROM supplier_onboarding_request_versions WHERE request_id=$1 ORDER BY version", [requestId]),
      database.query("SELECT * FROM supplier_onboarding_decisions WHERE request_id=$1 ORDER BY version", [requestId]),
      database.query("SELECT supplier_id,version FROM current_supplier_catalog ORDER BY supplier_id"),
    ]).then(results => results.map(result => result.rows));
    const before = await facts();
    const delegation = await access.createDelegation(rootActor, { grantorUserId: ids.production, granteeUserId: ids.pmc,
      capability: "supplier_onboarding:approve", scopeType: "global", validFrom: new Date(Date.now() - 1_000).toISOString(),
      validUntil: new Date(Date.now() + 3_600_000).toISOString(), reason: "TEST real delegation cannot upgrade pure PMC" });
    try {
      expect((await database.query("SELECT capability FROM delegated_authorizations WHERE delegation_id=$1 AND revoked_at IS NULL", [delegation.delegationId])).rows).toEqual([{ capability: "supplier_onboarding:approve" }]);
      const current = await app.inject({ method: "GET", url: "/auth/me", headers: pmcHeaders });
      expect(current.statusCode).toBe(200); expect(current.headers["set-cookie"]).toBeUndefined();
      expect(current.json().user.businessRoles).toEqual(["pmc"]);
      expect(current.json().user.capabilities).toEqual([...PMC_READ_CAPABILITIES].sort());
      expect(current.json().user.readOnlyModules).toEqual(expect.arrayContaining(["rework", "sourcing"]));
      await expect(database.query("SELECT access_authorized_actor_roles($1,'supplier_onboarding:approve')", [ids.pmc])).rejects.toMatchObject({ code: "42501" });
      for (const action of ["approve", "return"]) {
        const denied = await app.inject({ method: "POST", url: `${path}/${action}`, headers: { ...pmcHeaders, "idempotency-key": randomUUID() }, payload: { version: 1, ...(action === "return" ? { reason: "TEST denied return" } : {}) } });
        expect(denied.statusCode, denied.body).toBe(403);
      }
      await expect(onboarding.decide({ ...pmcActor, authorizationCapability: "supplier_onboarding:approve" }, requestId, "approved", { version: 1 }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
      await expect(access.createSupplier({ ...pmcActor, authorizationCapability: "supplier_profile:write" }, CreateSupplierSchema.parse({ ...profile, supplierName: "TEST denied new supplier", supplierCode: "TEST-DENIED-PMC", changeReason: "TEST denied write" }))).rejects.toMatchObject({ statusCode: 403 });
      expect(await facts()).toEqual(before);
    } finally {
      await access.revokeDelegation(rootActor, delegation.delegationId, "TEST release only this isolated delegation");
    }
    const returned = await app.inject({ method: "POST", url: `${path}/return`, headers: { ...managerHeaders, "idempotency-key": randomUUID() }, payload: { version: 1, reason: "TEST real manager return" } });
    expect(returned.statusCode, returned.body).toBe(200);
    const returnedFacts = await facts();
    const forbiddenResubmit = await app.inject({ method: "POST", url: `${path}/resubmit`, headers: { ...pmcHeaders, "idempotency-key": randomUUID() }, payload: { version: 1, profile } });
    expect(forbiddenResubmit.statusCode).toBe(403); expect(await facts()).toEqual(returnedFacts);
    const resubmitted = await app.inject({ method: "POST", url: `${path}/resubmit`, headers: { ...applicantHeaders, "idempotency-key": randomUUID() }, payload: { version: 1, profile: { ...profile, contactPerson: "TEST已补联系人" } } });
    expect(resubmitted.statusCode, resubmitted.body).toBe(200);
    for (const url of ["/supplier-onboarding/requests?scope=all", `/master-data/suppliers/${supplierId}`, `/master-data/suppliers/${supplierId}/history`]) {
      const pmc = await app.inject({ method: "GET", url, headers: pmcHeaders }), manager = await app.inject({ method: "GET", url, headers: managerHeaders });
      expect(pmc.statusCode, pmc.body).toBe(200); expect(manager.statusCode, manager.body).toBe(200);
      expect(pmc.json()).toEqual(manager.json());
    }
    const pmcResponse = await app.inject({ method: "GET", url: path, headers: pmcHeaders });
    const managerResponse = await app.inject({ method: "GET", url: path, headers: managerHeaders });
    expect(pmcResponse.statusCode, pmcResponse.body).toBe(200);
    expect(managerResponse.statusCode, managerResponse.body).toBe(200);
    const pmcDetail = pmcResponse.json<SupplierOnboardingDetail>(), managerDetail = managerResponse.json<SupplierOnboardingDetail>();
    expect(pmcDetail.profile).toEqual(managerDetail.profile); expect(pmcDetail.profile.contactPerson).toBe("TEST已补联系人");
    expect(pmcDetail.versions).toEqual(managerDetail.versions); expect(pmcDetail.versions).toHaveLength(2);
    expect(pmcDetail.decisions).toEqual(managerDetail.decisions); expect(pmcDetail.decisions).toHaveLength(1);
    expect(pmcDetail.duplicateCheck).toMatchObject({ formalSupplierCount: 0, pendingRequestCount: 0 });
    expect(managerDetail.duplicateCheck).toMatchObject({ formalSupplierCount: 0, pendingRequestCount: 0 });
    const supplier = (await app.inject({ method: "GET", url: `/master-data/suppliers/${supplierId}`, headers: pmcHeaders })).json();
    expect(supplier).toMatchObject({ contactPhone: "TEST123456", bankAccount: "TEST0001" });
  });

  it("keeps persisted attachment bindings and private export ownership with real PMC and manager sessions", async () => {
    const pmcHeaders = { cookie: await login("pmc") }, managerHeaders = { cookie: await login("pmc-production") };
    const pmcActor = await authenticatedActor(pmcHeaders.cookie, "tools:read"), managerActor = await authenticatedActor(managerHeaders.cookie, "tools:user");
    const hidden = randomUUID(), hash = createHash("sha256").update("TEST bound document").digest("hex");
    for (const [attachmentId, entityId] of [[readableAttachmentId, boundEntityId], [hidden, randomUUID()]]) {
      await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,entity_type,entity_id,status,ready_at) VALUES($1::uuid,$1::text,'TEST.pdf','application/pdf',19,$2,$3,'test_business',$4,'ready',CURRENT_TIMESTAMP)", [attachmentId, hash, ids.production, entityId]);
    }
    const downloadsBefore = downloadedObjects.length;
    for (const headers of [pmcHeaders, managerHeaders]) {
      expect((await app.inject({ method: "GET", url: `/tools/attachments/${readableAttachmentId}/download`, headers })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/tools/attachments/${hidden}/download`, headers })).statusCode).toBe(403);
    }
    expect(downloadedObjects.slice(downloadsBefore)).toEqual([readableAttachmentId, readableAttachmentId]);
    const upload = { filename: "TEST.pdf", mimeType: "application/pdf" as const, sizeBytes: 1, sha256: "a".repeat(64) };
    const beforeAttachments = (await database.query("SELECT * FROM attachments ORDER BY attachment_id")).rows;
    expect((await app.inject({ method: "POST", url: "/tools/attachments/upload-intents", headers: pmcHeaders, payload: upload })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/tools/attachments/${readableAttachmentId}/finalize`, headers: pmcHeaders, payload: {} })).statusCode).toBe(403);
    await expect(attachments.createUploadIntent(pmcActor, upload)).rejects.toMatchObject({ statusCode: 403 });
    await expect(attachments.finalize(pmcActor, readableAttachmentId)).rejects.toMatchObject({ statusCode: 403 });
    await expect(database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by) VALUES($1::uuid,$1::text,'TEST.pdf','application/pdf',1,$2,$3)", [randomUUID(), "a".repeat(64), ids.pmc])).rejects.toMatchObject({ code: "42501" });
    expect(uploadGrants).toBe(0); expect((await database.query("SELECT * FROM attachments ORDER BY attachment_id")).rows).toEqual(beforeAttachments);
    const completeExport = async (headers: { cookie: string }, actor: TrustedActorContext) => {
      const created = await app.inject({ method: "POST", url: "/tools/exports", headers, payload: { exportType: "report", filters: {}, idempotencyKey: randomUUID() } });
      expect(created.statusCode, created.body).toBe(201);
      const client = await database.connect(); let claimed;
      try { await client.query("BEGIN"); claimed = (await exportJobs.claim(client))[0]!; await client.query("COMMIT"); }
      catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      expect(claimed.export_job_id).toBe(created.json().exportJobId);
      const file = await attachments.storeGenerated(actor, { filename: "TEST-export.pdf", mimeType: "application/pdf", content: Buffer.from("TEST-generated-report"), entityType: "export_job", entityId: claimed.export_job_id });
      await exportJobs.complete(database, claimed.export_job_id, claimed.claim_token!, file.attachmentId);
      return { exportJobId: claimed.export_job_id, attachmentId: file.attachmentId };
    };
    const pmcExport = await completeExport(pmcHeaders, pmcActor), managerExport = await completeExport(managerHeaders, managerActor);
    for (const [own, other, headers] of [[pmcExport, managerExport, pmcHeaders], [managerExport, pmcExport, managerHeaders]] as const) {
      expect((await app.inject({ method: "GET", url: `/tools/exports/${own.exportJobId}`, headers })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/tools/attachments/${own.attachmentId}/download`, headers })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/tools/exports/${other.exportJobId}`, headers })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: `/tools/attachments/${other.attachmentId}/download`, headers })).statusCode).toBe(403);
    }
  });

  it("never turns a selected business role into Root and keeps privileged routes protected", async () => {
    const workerCookie = await login("worker-a");
    const workerRoles = await app.inject({ method: "GET", url: "/access/roles", headers: { cookie: workerCookie } });
    expect(workerRoles.statusCode).toBe(403);

    const rootCookie = await login("root");
    const root = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: rootCookie } });
    expect(root.json()).toMatchObject({
      status: "authorized",
      user: { id: ids.root, isRoot: true, businessRoles: ["owner_group"] },
    });
    const rootRoles = await app.inject({ method: "GET", url: "/access/roles", headers: { cookie: rootCookie } });
    expect(rootRoles.statusCode).toBe(200);
  });

  it("rejects replay of the same signed login code through the real AuthService", async () => {
    const code = mintAcceptanceLoginCode("finance-director", acceptanceSecret);
    const first = await app.inject({ method: "POST", url: "/auth/mobile", remoteAddress: loginRemoteAddress, payload: { code } });
    const replay = await app.inject({ method: "POST", url: "/auth/mobile", remoteAddress: loginRemoteAddress, payload: { code } });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: { code: "CODE_REPLAYED" } });
  });

  it("keeps independent controller authority while switching out of and ending a real PMC business session", async () => {
    const initialPmcCookie = await login("pmc");
    for (const cookie of [initialPmcCookie, `${initialPmcCookie}; dx_acceptance_control=forged-control`]) {
      const invalidStart = await app.inject({ method: "POST", url: "/acceptance/control/start", headers: { cookie }, payload: { code: "forged-code" } });
      expect(invalidStart.statusCode, invalidStart.body).toBe(401);
      expect(invalidStart.json()).toMatchObject({ error: { code: "ACCEPTANCE_CONTROL_INVALID" } });
      const invalidSwitch = await app.inject({ method: "POST", url: "/acceptance/control/switch", headers: { cookie }, payload: { alias: "root" } });
      expect(invalidSwitch.statusCode, invalidSwitch.body).toBe(401);
      expect(invalidSwitch.json()).toMatchObject({ error: { code: "ACCEPTANCE_IDENTITY_UNAVAILABLE" } });
      const invalidEnd = await app.inject({ method: "POST", url: "/acceptance/control/end", headers: { cookie } });
      expect(invalidEnd.statusCode, invalidEnd.body).toBe(401);
      expect(invalidEnd.json()).toMatchObject({ error: { code: "ACCEPTANCE_CONTROL_REQUIRED" } });
      const unchanged = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: initialPmcCookie } });
      expect(unchanged.statusCode).toBe(200);
      expect(unchanged.json()).toMatchObject({ user: { id: ids.pmc, isRoot: false, businessRoles: ["pmc"] } });
    }
    const code = mintAcceptanceControlCode(acceptanceSecret);
    const start = await app.inject({ method: "POST", url: "/acceptance/control/start", headers: { cookie: initialPmcCookie }, payload: { code } });
    expect(start.statusCode, start.body).toBe(200);
    const controlHeader = start.headers["set-cookie"];
    const controlRaw = Array.isArray(controlHeader) ? controlHeader[0] : controlHeader;
    const controlCookie = controlRaw!.split(";", 1)[0]!;
    expect(controlCookie).toContain("dx_acceptance_control=");
    // The exact control exceptions do not authorize other acceptance/business POSTs.
    for (const url of ["/acceptance/control/reset", "/acceptance/control/switch-extra", "/acceptance/clock/scenarios", "/digital-production/orders"]) {
      const denied = await app.inject({ method: "POST", url, headers: { cookie: `${controlCookie}; ${initialPmcCookie}` }, payload: {} });
      expect(denied.statusCode, `${url}: ${denied.body}`).toBe(403);
      expect(denied.json()).toMatchObject({ error: { code: "FORBIDDEN", message: "PMC仅可查看，不能执行业务操作" } });
    }

    const restartedAuth = new AuthService(
      new AcceptanceDingTalkProvider(database, corpId, acceptanceSecret),
      new PostgresAuthStore(database, corpId, "uat-root"),
      corpId,
      60 * 60_000,
      sessionSecret,
    );
    await expect(restartedAuth.beginAcceptanceControl(code)).rejects.toMatchObject({
      code: "ACCEPTANCE_CONTROL_INVALID",
    });

    const status = await app.inject({ method: "GET", url: "/acceptance/control/status", headers: { cookie: controlCookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json().identities.map((identity: { alias: string }) => identity.alias)).toEqual(expect.arrayContaining(["root", "worker-a", "finance-director"]));

    const switchWorker = await app.inject({ method: "POST", url: "/acceptance/control/switch", headers: { cookie: `${controlCookie}; ${initialPmcCookie}` }, payload: { alias: "worker-a" } });
    expect(switchWorker.statusCode, switchWorker.body).toBe(200);
    const workerHeader = switchWorker.headers["set-cookie"];
    const workerRaw = Array.isArray(workerHeader) ? workerHeader[0] : workerHeader;
    const workerCookie = workerRaw!.split(";", 1)[0]!;
    const worker = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: workerCookie } });
    expect(worker.json()).toMatchObject({ user: { id: ids.worker, isRoot: false, businessRoles: ["worker"] } });
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: initialPmcCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/access/roles", headers: { cookie: workerCookie } })).statusCode).toBe(403);

    const switchRoot = await app.inject({ method: "POST", url: "/acceptance/control/switch", headers: { cookie: `${controlCookie}; ${workerCookie}` }, payload: { alias: "root" } });
    expect(switchRoot.statusCode).toBe(200);
    const rootHeader = switchRoot.headers["set-cookie"];
    const rootRaw = Array.isArray(rootHeader) ? rootHeader[0] : rootHeader;
    const rootCookie = rootRaw!.split(";", 1)[0]!;
    const root = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: rootCookie } });
    expect(root.json()).toMatchObject({ user: { id: ids.root, isRoot: true, businessRoles: ["owner_group"] } });
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: workerCookie } })).statusCode).toBe(401);

    const switchPmc = await app.inject({ method: "POST", url: "/acceptance/control/switch", headers: { cookie: `${controlCookie}; ${rootCookie}` }, payload: { alias: "pmc" } });
    expect(switchPmc.statusCode).toBe(200);
    const pmcHeader = switchPmc.headers["set-cookie"], pmcRaw = Array.isArray(pmcHeader) ? pmcHeader[0] : pmcHeader;
    const currentPmcCookie = pmcRaw!.split(";", 1)[0]!;
    const pmc = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: currentPmcCookie } });
    expect(pmc.statusCode).toBe(200);
    expect(pmc.json()).toMatchObject({ user: { id: ids.pmc, isRoot: false, businessRoles: ["pmc"] } });
    const end = await app.inject({ method: "POST", url: "/acceptance/control/end", headers: { cookie: `${controlCookie}; ${currentPmcCookie}` } });
    expect(end.statusCode, end.body).toBe(204);
    expect(end.headers["set-cookie"]).toEqual(expect.arrayContaining([
      expect.stringContaining("dx_acceptance_control=;"),
      expect.stringContaining("dx_rework_session=;"),
    ]));
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: rootCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: currentPmcCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/acceptance/control/status", headers: { cookie: controlCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/acceptance/control/start", payload: { code } })).statusCode).toBe(401);
  });
});
