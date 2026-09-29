import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DigitalOrderCreateSchema, DigitalSourceCreateSchema } from "@dx-rework/contracts/digital-production";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { registerDigitalIdentityRoutes } from "../../apps/api/src/production-platform/identity-routes.js";
import { linkNewDigitalChild, resolveDigitalChild } from "../../apps/api/src/production-platform/child-link-repository.js";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { DigitalProductionAccessService } from "../../apps/api/src/production-platform/access-service.js";
import { DigitalProductionAccessPolicy } from "../../apps/api/src/production-platform/access-policy.js";
import { createDigitalTaskAccess, reassignDigitalTask } from "../../apps/api/src/production-platform/task-access-repository.js";
import { ApplicationError } from "../../apps/api/src/platform/errors.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
run("digital production P01 identities", () => {
  const schema = ownedPostgresSchema("digital_identity");
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  const designer = randomUUID(); const other = randomUUID(); const root = randomUUID();
  const actor = (id = designer, roles = ["sample_designer"]): TrustedActorContext => ({ actorId: id, actorRoles: roles, authorizationCapability: "pattern_room:orders:create", authorizationCapabilities: ["pattern_room:orders:create"], requestId: "p01-test" });
  const service = new DigitalProductionIdentityService(database, true);
  const input = () => DigitalOrderCreateSchema.parse({ customerCode: "PD", productGroup: "男装", designStyleNo: "TEST-STYLE", temporaryStyleNo: "TEST-TEMP", orderDate: "2026-09-29", lines: [
    { color: "黑", sizes: [{ size: "M", quantity: 2000 }, { size: "L", quantity: 1000 }], deliveryDate: "2026-10-10" },
    { color: "白", poNumber: "PO-2", sizes: [{ size: "M", quantity: 2000 }], deliveryDate: "2026-10-12" },
  ] });
  const sourceInput = () => DigitalSourceCreateSchema.parse({ developmentType: "头版", designStyleNo: "TEST-STYLE", temporaryStyleNo: "TEST-TEMP", customerCode: "PD" });
  const app = Fastify();
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const name of ["0001_platform_foundation.sql", "0002_dingtalk_identity_access.sql", "0216_digital_production_order_roots.sql"])
      await database.query(await readFile(new URL(`../../apps/api/migrations/${name}`, import.meta.url), "utf8"));
    // Existing-domain tables are represented only by referenced identity columns in this isolated fixture.
    // Full Gate separately replays the full real schema and original business chain.
    await database.query(`CREATE TABLE sourcing_cases(sourcing_case_id uuid PRIMARY KEY);
      CREATE TABLE cutting_orders(cutting_order_id uuid PRIMARY KEY,sourcing_case_id uuid REFERENCES sourcing_cases);
      CREATE TABLE sourcing_production_orders(production_order_id uuid PRIMARY KEY,sourcing_case_id uuid REFERENCES sourcing_cases);
      CREATE TABLE receiving_receipts(receipt_id uuid PRIMARY KEY);
      CREATE TABLE rework_orders(rework_order_id uuid PRIMARY KEY);
      CREATE TABLE pattern_room_orders(order_id uuid PRIMARY KEY);`);
    await database.query(await readFile(new URL("../../apps/api/migrations/0218_digital_production_identity.sql", import.meta.url), "utf8"));
    await database.query(`CREATE TABLE business_roles(role_code text PRIMARY KEY,display_name text,description text,enabled boolean DEFAULT true,updated_at timestamptz);
      CREATE FUNCTION fixture_role_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER business_roles_no_update BEFORE UPDATE ON business_roles FOR EACH ROW EXECUTE FUNCTION fixture_role_guard();
      CREATE TRIGGER business_roles_no_insert BEFORE INSERT ON business_roles FOR EACH ROW EXECUTE FUNCTION fixture_role_guard();
      CREATE TABLE capability_catalog(capability text,display_name text,description text);
      CREATE TRIGGER capability_catalog_no_update BEFORE UPDATE ON capability_catalog FOR EACH ROW EXECUTE FUNCTION fixture_role_guard();
      CREATE TABLE role_capabilities(role_code text,capability text);
      CREATE TRIGGER role_capabilities_no_insert BEFORE INSERT ON role_capabilities FOR EACH ROW EXECUTE FUNCTION fixture_role_guard();
      CREATE TABLE user_role_assignments(user_id uuid,role_code text,revoked_at timestamptz);
      INSERT INTO business_roles(role_code) VALUES('sample_designer'),('order_merchandiser'),('pattern_room_supervisor'),('pattern_room_worker'),('production_management'),('quality_control'),('embroidery_washing_merchandiser'),('warehouse_receiver');`);
    await database.query(await readFile(new URL("../../apps/api/migrations/0219_digital_production_access.sql", import.meta.url), "utf8"));
    await database.query(`CREATE FUNCTION fixture_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
      VALUES(NEW.id,NEW.id,'dingtalk','TEST',NEW.id::text,NEW.id::text,true,true,CURRENT_TIMESTAMP); RETURN NEW; END $$;
      CREATE TRIGGER fixture_user_identity AFTER INSERT ON app_users FOR EACH ROW EXECUTE FUNCTION fixture_identity();`);
    for (const id of [designer, other, root]) await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST P01',true)", [id]);
    for (const id of [designer, other]) await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'sample_designer')", [id]);
    app.setErrorHandler((error, _request, reply) => { const known = error as ApplicationError; reply.code(known.statusCode ?? 500).send({ error: { code: known.code, message: known.message } }); });
    registerDigitalIdentityRoutes(app, { service, accessService: new DigitalProductionAccessService(database), creationEnabled: true, authenticate: async token => {
      if (token !== designer && token !== other) throw new ApplicationError("UNAUTHORIZED", "请登录", 401);
      return { id: token, displayName: "TEST", businessRoles: ["sample_designer"], capabilities: ["pattern_room:orders:create"] };
    } });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await database.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });
  it("starts with only the sixteen customer codes and no migrated orders", async () => {
    expect((await service.customers(actor())).length).toBe(16);
    expect((await service.customers(actor())).find(item => item.code === "PD")?.productGroups).toEqual(["男装", "女装"]);
    expect((await database.query("SELECT count(*)::int AS n FROM production_order_roots")).rows[0].n).toBe(0);
  });
  it("creates stable PO rows and records no imaginary deadline or dispatch", async () => {
    const result = await service.createOrder(actor(), input(), randomUUID());
    expect(result.status).toBe("waiting_development"); expect(result.notificationPolicy).toBe("IN_APP_ONLY");
    expect(result.lines[0]?.lineId).not.toBe(result.lines[1]?.lineId);
    expect(result.lines.map(line => line.deliveryDate)).toEqual(["2026-10-10", "2026-10-12"]);
    expect(result.lines[0]?.formalStyleNo).toBeNull(); expect(result).not.toHaveProperty("dueAt");
    expect((await database.query("SELECT count(*)::int AS n FROM digital_production_child_links")).rows[0].n).toBe(0);
  });
  it("rejects normalized duplicate colors in service and database", async () => {
    const request = input(); request.lines[0]!.color = "Blue"; request.lines[1]!.color = " blue ";
    await expect(service.createOrder(actor(), request, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    const order = await service.createOrder(actor(), input(), randomUUID());
    await expect(database.query("INSERT INTO digital_production_po_lines(line_id,production_order_id,position,color) VALUES($1,$2,3,' 黑 ')", [randomUUID(), order.productionOrderId])).rejects.toMatchObject({ code: "23505" });
  });
  it("preserves source substitute numbers on confirmation and later attachment", async () => {
    const source = await service.createSource(actor(), sourceInput(), randomUUID());
    for (const temporaryStyleNo of [null, "CHANGED"]) {
      await expect(service.createOrder(actor(), { ...input(), temporaryStyleNo }, randomUUID(), source.sourceId)).rejects.toMatchObject({ statusCode: 409 });
      const order = await service.createOrder(actor(), { ...input(), temporaryStyleNo }, randomUUID());
      await expect(service.attachSource(actor(), order.productionOrderId, source.sourceId, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
      expect((await service.read(actor(), order.productionOrderId)).sourceId).toBeNull();
    }
    const confirmed = await service.createOrder(actor(), input(), randomUUID(), source.sourceId);
    expect(confirmed.temporaryStyleNo).toBe("TEST-TEMP");
  });
  it("deduplicates direct-order retries and rejects a changed payload on the same key", async () => {
    const key = randomUUID(); const request = input();
    const [a, b] = await Promise.all([service.createOrder(actor(), request, key), service.createOrder(actor(), request, key)]);
    expect(a.productionOrderId).toBe(b.productionOrderId);
    await expect(service.createOrder(actor(), { ...request, designStyleNo: "DIFFERENT" }, key)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("concurrent source confirmations with different keys create one order", async () => {
    const source = await service.createSource(actor(), sourceInput(), randomUUID());
    const [a, b] = await Promise.all([service.createOrder(actor(), input(), randomUUID(), source.sourceId), service.createOrder(actor(), input(), randomUUID(), source.sourceId)]);
    expect(a.productionOrderId).toBe(b.productionOrderId); expect(a.sourceId).toBe(source.sourceId);
    await expect(service.createOrder(actor(), { ...input(), orderDate: "2026-09-28" }, randomUUID(), source.sourceId)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("root confirmation retains the source designer's access", async () => {
    const source = await service.createSource(actor(), sourceInput(), randomUUID());
    const order = await service.createOrder(actor(root, ["root_superuser"]), input(), randomUUID(), source.sourceId);
    expect(order.createdBy).toBe(designer);
    expect((await service.read(actor(), order.productionOrderId)).sourceId).toBe(source.sourceId);
  });
  it("attaches a later development source to the original direct-order identity", async () => {
    const order = await service.createOrder(actor(), input(), randomUUID());
    const source = await service.createSource(actor(), sourceInput(), randomUUID());
    const attached = await service.attachSource(actor(), order.productionOrderId, source.sourceId, randomUUID());
    expect(attached.productionOrderId).toBe(order.productionOrderId); expect(attached.status).toBe("development_linked");
    const second = await service.createOrder(actor(), input(), randomUUID());
    await expect(service.attachSource(actor(), second.productionOrderId, source.sourceId, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
  });
  it("root cannot attach a different designer's source to a direct order", async () => {
    const third = randomUUID();
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST third designer',true)", [third]);
    const source = await service.createSource(actor(third), sourceInput(), randomUUID());
    const order = await service.createOrder(actor(), input(), randomUUID());
    await expect(service.attachSource(actor(root, ["root_superuser"]), order.productionOrderId, source.sourceId, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    expect((await service.read(actor(), order.productionOrderId)).sourceId).toBeNull();
    const ownSource = await service.createSource(actor(), sourceInput(), randomUUID());
    expect((await service.attachSource(actor(root, ["root_superuser"]), order.productionOrderId, ownSource.sourceId, randomUUID())).sourceId).toBe(ownSource.sourceId);
  });
  it("number correction preserves root, PO identity, dates and quantities; rejects stale updates", async () => {
    const order = await service.createOrder(actor(), input(), randomUUID());
    const line = order.lines[0]!;
    const changed = await service.correctNumbers(actor(), order.productionOrderId, line.lineId, { expectedVersion: 1, poNumber: "REAL-PO", formalStyleNo: "REAL-STYLE" }, randomUUID());
    expect(changed.productionOrderId).toBe(order.productionOrderId); expect(changed.lines[0]?.lineId).toBe(line.lineId);
    expect(changed.lines[0]?.sizes).toEqual(line.sizes); expect(changed.createdAt).toBe(order.createdAt);
    await expect(service.correctNumbers(actor(), order.productionOrderId, line.lineId, { expectedVersion: 1, poNumber: "STALE", formalStyleNo: null }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
  });
  it("isolates another designer in read, search, source conversion and mutation", async () => {
    const source = await service.createSource(actor(), sourceInput(), randomUUID());
    const order = await service.createOrder(actor(), input(), randomUUID());
    await expect(service.read(actor(other), order.productionOrderId)).rejects.toMatchObject({ statusCode: 404 });
    expect((await service.orders(actor(other), 1, "TEST")).items).toEqual([]);
    expect((await service.sources(actor(other), 1, "TEST")).items).toEqual([]);
    await expect(service.createOrder(actor(other), input(), randomUUID(), source.sourceId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.correctNumbers(actor(other), order.productionOrderId, order.lines[0]!.lineId, { expectedVersion: 1, poNumber: "NO", formalStyleNo: null }, randomUUID())).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.orders(actor(other, ["warehouse_keeper"]), 1, "")).rejects.toMatchObject({ statusCode: 403 });
  });
  it("disabling creation does not disable existing order reads and number corrections", async () => {
    const order = await service.createOrder(actor(), input(), randomUUID()); const closed = new DigitalProductionIdentityService(database, false);
    await expect(closed.createOrder(actor(), input(), randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    await expect(closed.createSource(actor(), sourceInput(), randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    expect((await closed.read(actor(), order.productionOrderId)).productionOrderId).toBe(order.productionOrderId);
    expect((await closed.correctNumbers(actor(), order.productionOrderId, order.lines[0]!.lineId, { expectedVersion: 1, poNumber: "LATE", formalStyleNo: null }, randomUUID())).version).toBe(2);
  });
  it("uses real child foreign keys, prevents cross-root and cross-PO mapping, and fails closed", async () => {
    const order = await service.createOrder(actor(), input(), randomUUID()); const second = await service.createOrder(actor(), input(), randomUUID());
    const childId = randomUUID(); await database.query("INSERT INTO sourcing_cases VALUES($1)", [childId]);
    const client = await database.connect();
    try {
      await linkNewDigitalChild(client, { module: "sourcing", childId, productionOrderId: order.productionOrderId, lines: [{ childLineKey: "1", lineId: order.lines[0]!.lineId }] });
      expect(await resolveDigitalChild(client, "sourcing", childId, "digital_production_v1")).toBe(order.productionOrderId);
      await expect(resolveDigitalChild(client, "sourcing", randomUUID(), "digital_production_v1")).rejects.toMatchObject({ statusCode: 409 });
      expect(await resolveDigitalChild(client, "rework", randomUUID(), "legacy")).toBeNull();
      await expect(resolveDigitalChild(client, "sourcing", childId, "legacy")).rejects.toMatchObject({ statusCode: 409 });
      await expect(linkNewDigitalChild(client, { module: "sourcing", childId, productionOrderId: second.productionOrderId, lines: [] })).rejects.toMatchObject({ statusCode: 409 });
      await expect(client.query("INSERT INTO digital_production_child_lines VALUES('sourcing',$1,'2',$2,$3)", [childId, order.productionOrderId, second.lines[0]!.lineId])).rejects.toMatchObject({ code: "23503" });
      await expect(client.query("DELETE FROM digital_production_child_links WHERE child_id=$1", [childId])).rejects.toMatchObject({ code: "55000" });
      await expect(client.query("INSERT INTO digital_production_child_links(module,child_id,production_order_id) VALUES('receiving',$1,$2)", [randomUUID(), order.productionOrderId])).rejects.toMatchObject({ code: "23503" });
    } finally { client.release(); }
  });
  it("does not route a production or cutting child from a different sourcing case", async () => {
    const order = await service.createOrder(actor(), input(), randomUUID()); const caseId = randomUUID(); const factoryId = randomUUID();
    await database.query("INSERT INTO sourcing_cases VALUES($1)", [caseId]);
    await database.query("INSERT INTO sourcing_production_orders VALUES($1,$2)", [factoryId, caseId]);
    await expect(database.query("INSERT INTO digital_production_child_links(module,child_id,production_order_id) VALUES('production',$1,$2)", [factoryId, order.productionOrderId])).rejects.toMatchObject({ code: "23514" });
  });
  it("rolls back every root and PO when customer validation fails", async () => {
    const before = (await database.query("SELECT count(*)::int AS n FROM production_order_roots")).rows[0].n;
    await expect(service.createOrder(actor(), { ...input(), customerCode: "HO", productGroup: "男装" }, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    expect((await database.query("SELECT count(*)::int AS n FROM production_order_roots")).rows[0].n).toBe(before);
  });
  it("rolls back an inserted root and PO rows if a later line violates a database constraint", async () => {
    const before = (await database.query("SELECT count(*)::int AS n FROM production_order_roots")).rows[0].n;
    const invalid = input(); invalid.lines[1]!.color = "";
    await expect(service.createOrder(actor(), invalid, randomUUID())).rejects.toMatchObject({ code: "23514" });
    expect((await database.query("SELECT count(*)::int AS n FROM production_order_roots")).rows[0].n).toBe(before);
  });
  it("revalidates scope before replaying a previous privileged response", async () => {
    const source = await service.createSource(actor(), sourceInput(), randomUUID()); const key = randomUUID();
    await service.createOrder(actor(root, ["root_superuser"]), input(), key, source.sourceId);
    await expect(service.createOrder(actor(root), input(), key, source.sourceId)).rejects.toMatchObject({ statusCode: 404 });
  });
  it("HTTP rejects anonymous access, cross-owner reads and injected quantity/owner fields", async () => {
    expect((await app.inject({ method: "GET", url: "/digital-production/orders" })).statusCode).toBe(401);
    const order = await service.createOrder(actor(), input(), randomUUID());
    const headers = { cookie: `dx_rework_session=${other}`, "idempotency-key": randomUUID() };
    expect((await app.inject({ method: "GET", url: `/digital-production/orders/${order.productionOrderId}`, headers })).statusCode).toBe(404);
    const created = await app.inject({ method: "POST", url: "/digital-production/orders", headers: { ...headers, cookie: `dx_rework_session=${designer}` }, payload: { ...input(), createdBy: other } });
    expect(created.statusCode).toBe(400);
    const patched = await app.inject({ method: "PATCH", url: `/digital-production/orders/${order.productionOrderId}/lines/${order.lines[0]!.lineId}/numbers`, headers: { ...headers, cookie: `dx_rework_session=${designer}` }, payload: { expectedVersion: 1, quantity: 999, poNumber: "HACK" } });
    expect(patched.statusCode).toBe(400);
    const own = await app.inject({ method: "GET", url: `/digital-production/orders/${order.productionOrderId}`, headers: { cookie: `dx_rework_session=${designer}` } });
    expect(own.statusCode).toBe(200); expect(own.headers["cache-control"]).toBe("no-store");
  });
  it("P02 scopes primary merchandisers, defaults, leaders and technical readers without budget leakage", async () => {
    const primary = randomUUID(); const supervisor = randomUUID();
    for (const [id, role] of [[primary, "order_merchandiser"], [supervisor, "pattern_room_supervisor"]]) {
      await database.query("INSERT INTO app_users(id,display_name) VALUES($1,'TEST ACCESS')", [id]);
      await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,$2)", [id, role]);
    }
    const access = new DigitalProductionAccessService(database); const policy = new DigitalProductionAccessPolicy(database);
    const boss = actor(root, ["root_superuser"]);
    await expect(access.setCustomerDefault(actor(), "PD", primary)).rejects.toMatchObject({ statusCode: 403 });
    await access.setCustomerDefault(boss, "PD", primary);
    const order = await service.createOrder(actor(), input(), randomUUID());
    expect(order.primaryMerchandiserId).toBe(primary);
    expect((await service.read(actor(primary, ["order_merchandiser"]), order.productionOrderId)).productionOrderId).toBe(order.productionOrderId);
    expect((await service.orders(actor(primary, ["order_merchandiser"]), 1, "TEST")).items.map(item => item.productionOrderId)).toContain(order.productionOrderId);
    expect(await policy.allowed(actor(supervisor, ["pattern_room_supervisor"]), "order", order.productionOrderId, "technical")).toBe(true);
    expect(await policy.allowed(actor(supervisor, ["pattern_room_supervisor"]), "order", order.productionOrderId, "budget")).toBe(false);
    await expect(service.correctNumbers(actor(supervisor, ["pattern_room_supervisor"]), order.productionOrderId, order.lines[0]!.lineId, { expectedVersion: 1, poNumber: "NO", formalStyleNo: null }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    const request = await access.requestDelivery(actor(primary, ["order_merchandiser"]), order.productionOrderId, { expectedVersion: 1, deliveryDate: "2026-12-20", reason: "客户同意" });
    await expect(access.decideDelivery(actor(primary, ["order_merchandiser"]), request.requestId, "approved")).rejects.toMatchObject({ statusCode: 403 });
    expect((await service.read(boss, order.productionOrderId)).contractDeliveryDate).toBeNull();
    await access.decideDelivery(boss, request.requestId, "approved");
    expect((await service.read(boss, order.productionOrderId)).contractDeliveryDate).toBe("2026-12-20");
    expect(await access.decideDelivery(boss, request.requestId, "approved")).toEqual({ decision: "approved" });
    expect(await access.assignMerchandiser(boss, order.productionOrderId, primary, 2)).toEqual({ version: 3 });
    await expect(access.assignMerchandiser(boss, order.productionOrderId, primary, 2)).rejects.toMatchObject({ statusCode: 409 });
    await access.setCustomerDefault(boss, "PD", null);
  });
  it("P02 rejects creator assignment overrides and non-root self-decisions", async () => {
    const primary = randomUUID(); const alternate = randomUUID(); const director = randomUUID();
    for (const [id, role] of [[primary, "order_merchandiser"], [alternate, "order_merchandiser"], [director, "production_management"]]) {
      await database.query("INSERT INTO app_users(id,display_name) VALUES($1,'TEST REVIEW')", [id]);
      await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,$2)", [id, role]);
    }
    await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'production_management')", [primary]);
    const access = new DigitalProductionAccessService(database);
    const boss = actor(root, ["root_superuser"]);
    await access.setCustomerDefault(boss, "PD", primary);
    const count = await database.query("SELECT count(*) FROM digital_production_orders");
    for (const primaryMerchandiserId of [alternate, null]) {
      await expect(service.createOrder(actor(), { ...input(), primaryMerchandiserId }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
      const source = await service.createSource(actor(), sourceInput(), randomUUID());
      await expect(service.createOrder(actor(), { ...input(), primaryMerchandiserId }, randomUUID(), source.sourceId)).rejects.toMatchObject({ statusCode: 403 });
    }
    expect((await database.query("SELECT count(*) FROM digital_production_orders")).rows).toEqual(count.rows);
    const order = await service.createOrder(actor(), { ...input(), primaryMerchandiserId: primary }, randomUUID());
    expect(order.primaryMerchandiserId).toBe(primary);
    expect((await service.createOrder(boss, { ...input(), primaryMerchandiserId: alternate }, randomUUID())).primaryMerchandiserId).toBe(alternate);
    const dual = actor(primary, ["order_merchandiser", "production_management"]);
    const request = await access.requestDelivery(dual, order.productionOrderId, { expectedVersion: 1, deliveryDate: "2026-12-22", reason: "客户改期" });
    for (const decision of ["approved", "rejected"] as const) await expect(access.decideDelivery(dual, request.requestId, decision)).rejects.toMatchObject({ statusCode: 403 });
    expect((await service.read(boss, order.productionOrderId)).contractDeliveryDate).toBeNull();
    expect((await database.query("SELECT * FROM digital_production_delivery_decisions WHERE request_id=$1", [request.requestId])).rows).toHaveLength(0);
    expect(await access.decideDelivery(actor(director, ["production_management"]), request.requestId, "approved")).toEqual({ decision: "approved" });
    await expect(access.decideDelivery(dual, request.requestId, "approved")).rejects.toMatchObject({ statusCode: 403 });
    const rootRequest = await access.requestDelivery(boss, order.productionOrderId, { expectedVersion: 2, deliveryDate: "2026-12-23", reason: "Root纠正" });
    expect(await access.decideDelivery(boss, rootRequest.requestId, "approved")).toEqual({ decision: "approved" });
    expect((await service.read(boss, order.productionOrderId)).contractDeliveryDate).toBe("2026-12-23");
    await access.setCustomerDefault(boss, "PD", null);
    await expect(service.createOrder(actor(), { ...input(), primaryMerchandiserId: alternate }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    expect((await service.createOrder(actor(), { ...input(), primaryMerchandiserId: null }, randomUUID())).primaryMerchandiserId).toBeNull();
  });
  it("P02 delegates only the specified resource, revokes immediately and separates QC from logistics", async () => {
    const access = new DigitalProductionAccessService(database); const policy = new DigitalProductionAccessPolicy(database);
    const boss = actor(root, ["root_superuser"]); const order = await service.createOrder(actor(), input(), randomUUID());
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    const grant = await access.delegate(boss, { resourceKind: "order", resourceId: order.productionOrderId, delegateId: other, purpose: "technical", expiresAt });
    expect(await policy.allowed(actor(other), "order", order.productionOrderId, "technical")).toBe(true);
    expect(await policy.allowed(actor(other), "order", order.productionOrderId, "budget")).toBe(false);
    expect(await access.delegate(boss, { resourceKind: "order", resourceId: order.productionOrderId, delegateId: other, purpose: "technical", expiresAt })).toEqual(grant);
    await access.revoke(boss, grant.delegationId);
    expect(await policy.allowed(actor(other), "order", order.productionOrderId, "technical")).toBe(false);
    await expect(access.delegate(boss, { resourceKind: "order", resourceId: order.productionOrderId, delegateId: other, purpose: "technical", expiresAt: "2020-01-01T00:00:00Z" })).rejects.toMatchObject({ statusCode: 409 });
    const qc = randomUUID(); const logistics = randomUUID(); const secondQc = randomUUID();
    for (const [id, role] of [[qc, "quality_control"], [logistics, "embroidery_washing_merchandiser"], [secondQc, "quality_control"]]) {
      await database.query("INSERT INTO app_users(id,display_name) VALUES($1,'TEST TASK')", [id]);
      await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,$2)", [id, role]);
    }
    const client = await database.connect(); let taskId: string;
    try { taskId = await createDigitalTaskAccess(client, boss, { orderId: order.productionOrderId, kind: "bulk_qc", assigneeId: qc }); } finally { client.release(); }
    expect(await policy.allowed(actor(qc, ["quality_control"]), "task", taskId!, "execute")).toBe(true);
    expect(await policy.allowed(actor(qc, ["quality_control"]), "order", order.productionOrderId, "technical")).toBe(false);
    await expect(access.delegate(boss, { resourceKind: "task", resourceId: taskId!, delegateId: logistics, purpose: "execute", expiresAt })).rejects.toMatchObject({ statusCode: 403 });
    const taskGrant = await access.delegate(boss, { resourceKind: "task", resourceId: taskId!, delegateId: secondQc, purpose: "execute", expiresAt });
    expect(await policy.allowed(actor(secondQc, ["quality_control"]), "task", taskId!, "execute")).toBe(true);
    expect(await policy.allowed(actor(secondQc, ["quality_control"]), "task", taskId!, "budget")).toBe(false);
    await database.query("UPDATE app_users SET enabled=false WHERE id=$1", [secondQc]);
    expect(await policy.allowed(actor(secondQc, ["quality_control"]), "task", taskId!, "execute")).toBe(false);
    await access.revoke(boss, taskGrant.delegationId);
    await database.query("UPDATE app_users SET enabled=true WHERE id=$1", [secondQc]);
    const client2 = await database.connect();
    try {
      await expect(reassignDigitalTask(client2, actor(logistics, ["embroidery_washing_merchandiser"]), taskId!, qc)).rejects.toMatchObject({ statusCode: 403 });
      await reassignDigitalTask(client2, boss, taskId!, secondQc);
      await expect(client2.query("UPDATE digital_production_task_access SET required_role='embroidery_washing_merchandiser' WHERE task_id=$1", [taskId!])).rejects.toMatchObject({ code: "55000" });
    } finally { client2.release(); }
    expect(await policy.allowed(actor(qc, ["quality_control"]), "task", taskId!, "execute")).toBe(false);
    expect(await policy.allowed(actor(secondQc, ["quality_control"]), "task", taskId!, "execute")).toBe(true);
  });

  it("P02 expiry and revoked roles cannot authorize execution or budget access", async () => {
    const access = new DigitalProductionAccessService(database); const policy = new DigitalProductionAccessPolicy(database);
    const boss = actor(root, ["root_superuser"]); const order = await service.createOrder(actor(), input(), randomUUID());
    await database.query(`INSERT INTO digital_production_delegations(delegation_id,production_order_id,delegate_id,purpose,granted_by,created_at,expires_at)
      VALUES($1,$2,$3,'technical',$4,CURRENT_TIMESTAMP-INTERVAL '2 hours',CURRENT_TIMESTAMP-INTERVAL '1 hour')`, [randomUUID(), order.productionOrderId, other, root]);
    expect(await policy.allowed(actor(other), "order", order.productionOrderId, "technical")).toBe(false);
    await expect(access.delegate(actor(other, ["pattern_room_supervisor"]), { resourceKind: "order", resourceId: order.productionOrderId, delegateId: other, purpose: "budget", expiresAt: new Date(Date.now()+3600000).toISOString() })).rejects.toMatchObject({ statusCode: 403 });
    await expect(access.assignMerchandiser(actor(), order.productionOrderId, other, 1)).rejects.toMatchObject({ statusCode: 403 });
    await expect(access.assignMerchandiser(boss, order.productionOrderId, other, 1)).rejects.toMatchObject({ statusCode: 409 });
    const response = await app.inject({ method: "PUT", url: "/digital-production/customers/PD/default-merchandiser", headers: { cookie: `dx_rework_session=${designer}` }, payload: { merchandiserId: other } });
    expect(response.statusCode).toBe(403);
    const granted = await app.inject({ method: "POST", url: "/digital-production/access/delegations", headers: { cookie: `dx_rework_session=${designer}` }, payload: { resourceKind: "order", resourceId: order.productionOrderId, delegateId: other, purpose: "technical", expiresAt: new Date(Date.now()+3600000).toISOString() } });
    expect(granted.statusCode).toBe(403);
  });

});
