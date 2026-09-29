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
    for (const id of [designer, other, root]) await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST P01',true)", [id]);
    app.setErrorHandler((error, _request, reply) => { const known = error as ApplicationError; reply.code(known.statusCode ?? 500).send({ error: { code: known.code, message: known.message } }); });
    registerDigitalIdentityRoutes(app, { service, creationEnabled: true, authenticate: async token => {
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
});
