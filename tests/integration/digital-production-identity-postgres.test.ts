import {historicalDigitalOrder} from "../helpers/historical-digital-order-fixture.js";
import { PoCustomerDateService } from "../../apps/api/src/production-platform/po-customer-date-service.js";
import { applyDigitalPoDateFixture } from "../helpers/digital-po-date-fixture.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { DigitalPoDateRepository } from "../../apps/api/src/production-platform/po-date-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
run("digital production P01 identities", () => {
  const schema = ownedPostgresSchema("digital_identity");
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  const designer = randomUUID(); const other = randomUUID(); const root = randomUUID();
  const actor = (id = designer, roles = ["sample_designer"]): TrustedActorContext => ({ actorId: id, actorRoles: roles, authorizationCapability: "pattern_room:orders:create", authorizationCapabilities: ["pattern_room:orders:create"], requestId: "p01-test" });
  let today = new Date("2026-09-01T00:00:00Z");
  const service = new DigitalProductionIdentityService(database, true, undefined, () => today);
  let style="";
  beforeEach(()=>{style=`TEST-STYLE-${randomUUID()}`;today=new Date("2026-09-01T00:00:00Z");});
  const input = (designStyleNo=style) => DigitalOrderCreateSchema.parse({ customerCode: "PD", productGroup: "男装", designStyleNo, temporaryStyleNo: "TEST-TEMP", orderDate: "2026-09-29", lines: [
    { color: "黑", sizes: [{ size: "M", quantity: 2000 }, { size: "L", quantity: 1000 }], deliveryDate: "2026-10-10" },
    { color: "白", poNumber: "PO-2", sizes: [{ size: "M", quantity: 2000 }], deliveryDate: "2026-10-12" },
  ] });
  const sourceInput = (designStyleNo=style) => DigitalSourceCreateSchema.parse({ developmentType: "头版", designStyleNo, temporaryStyleNo: "TEST-TEMP", customerCode: "PD" });
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
    await applyDigitalPoDateFixture(database);
    await database.query("CREATE TABLE digital_development_documents(source_id uuid PRIMARY KEY REFERENCES digital_production_sources,status text NOT NULL)");
    const lifecycleSql=await readFile(new URL("../../apps/api/migrations/0220_digital_production_tasks.sql",import.meta.url),"utf8");
    await database.query(lifecycleSql.match(/CREATE TABLE digital_production_resource_lifecycle[\s\S]*?\n\);/)![0]);
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
    await database.query("INSERT INTO role_capabilities(role_code,capability) VALUES('order_merchandiser','sourcing:view'),('order_merchandiser','sourcing:inquiry:create'),('order_merchandiser','sourcing:contract:record')");
    await database.query(`CREATE FUNCTION fixture_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
      VALUES(NEW.id,NEW.id,'dingtalk','TEST',NEW.id::text,NEW.id::text,true,true,CURRENT_TIMESTAMP); RETURN NEW; END $$;
      CREATE TRIGGER fixture_user_identity AFTER INSERT ON app_users FOR EACH ROW EXECUTE FUNCTION fixture_identity();`);
    for (const id of [designer, other, root]) await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST P01',true)", [id]);
    for (const id of [designer, other]) await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'sample_designer')", [id]);
    app.setErrorHandler((error, _request, reply) => { const known = error as ApplicationError; reply.code(known.statusCode ?? 500).send({ error: { code: known.code, message: known.message } }); });
    registerDigitalIdentityRoutes(app, { service, accessService: new DigitalProductionAccessService(database), creationEnabled: true, authenticate: async token => {
      if (token !== designer && token !== other && token !== root) throw new ApplicationError("UNAUTHORIZED", "请登录", 401);
      return { id: token, displayName: "TEST", businessRoles: token===root?["root_superuser"]:["sample_designer"], capabilities: ["pattern_room:orders:create"] };
    } });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await database.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });
  const publishedSource=async(currentActor=actor(),request=sourceInput())=>{
    const value=await service.createSource(currentActor,request,randomUUID());
    await database.query("INSERT INTO digital_development_documents VALUES($1,'published')",[value.sourceId]);
    return value;
  };
  const tx = async <T,>(work:(client:pg.PoolClient)=>Promise<T>)=>{
    const client = await database.connect();
    try {await client.query("BEGIN");const result=await work(client);await client.query("COMMIT");return result;}
    catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  };
  const approvedDate = async (client:pg.PoolClient,orderId:string,lineId:string,kind:"customer"|"factory",date:string,version:number,
    currentActor=actor(root,["root_superuser"]),existingEventId?:string)=>{
    const column=kind==="customer"?"customer_warehouse_arrival_date":"factory_delivery_date";
    const oldDate=(await client.query(`SELECT ${column}::text AS date FROM digital_production_po_lines WHERE line_id=$1`,[lineId])).rows[0].date;
    const eventId=existingEventId??randomUUID();
    if(!existingEventId)await client.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state)
      VALUES($1,$2,$3,$4,'digital_production',$5,$6)`,[eventId,currentActor.requestId,currentActor.actorId,
      kind==="customer"?"digital_po_customer_dates_approved":"digital_po_factory_dates_approved",orderId,
      {reason:"TEST explicit approved promise",dateChanges:[{lineId,dateKind:kind,oldDate,date,expectedVersion:version}]}]);
    await new DigitalPoDateRepository(client).applyWithClient(currentActor,orderId,kind==="customer"?"approved_customer_change":"approved_factory_change",
      [{lineId,date,expectedVersion:version}],eventId);
    return eventId;
  };
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
    const source = await publishedSource();
    for (const temporaryStyleNo of [null, "CHANGED"]) {
      await expect(service.createOrder(actor(), { ...input(), temporaryStyleNo }, randomUUID(), source.sourceId)).rejects.toMatchObject({ statusCode: 409 });
      const order = await historicalDigitalOrder(database,actor(), { ...input(), temporaryStyleNo });
      await expect(service.attachSource(actor(), order.productionOrderId, source.sourceId, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
      expect((await service.read(actor(), order.productionOrderId)).sourceId).toBeNull();
    }
    const fresh=await publishedSource(actor(),sourceInput(`${style}-CONFIRM`));
    const confirmed = await service.createOrder(actor(), input(`${style}-CONFIRM`), randomUUID(), fresh.sourceId);
    expect(confirmed.temporaryStyleNo).toBe("TEST-TEMP");
  });
  it("deduplicates direct-order retries and rejects a changed payload on the same key", async () => {
    const key = randomUUID(); const request = input();
    const [a, b] = await Promise.all([service.createOrder(actor(), request, key), service.createOrder(actor(), request, key)]);
    expect(a.productionOrderId).toBe(b.productionOrderId);
    await expect(service.createOrder(actor(), { ...request, designStyleNo: "DIFFERENT" }, key)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("serializes normalized duplicate sources and orders without exposing another owner's facts",async()=>{
    const sources=await Promise.allSettled([service.createSource(actor(),sourceInput(),randomUUID()),service.createSource(actor(other),sourceInput(` ${style.toLowerCase()} `),randomUUID())]);
    expect(sources.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect(sources.find(result=>result.status==="rejected")).toMatchObject({reason:{statusCode:409,message:"该编号已有开发档案，请打开原档案继续办理"}});
    const orders=await Promise.allSettled([service.createOrder(actor(),input(),randomUUID()),service.createOrder(actor(other),input(style.toLowerCase()),randomUUID())]);
    expect(orders.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect(orders.find(result=>result.status==="rejected")).toMatchObject({reason:{statusCode:409,message:"该编号已有客户订单，请打开原档案继续办理"}});
  });
  it("requires published development before a first source confirmation and leaves drafts without roots",async()=>{
    const source=await service.createSource(actor(),sourceInput(),randomUUID());
    await expect(service.createOrder(actor(),input(),randomUUID(),source.sourceId)).rejects.toMatchObject({statusCode:409,message:"请先发布开发单，再正式确认客户订单"});
    expect((await database.query("SELECT count(*)::int n FROM digital_production_orders WHERE source_id=$1",[source.sourceId])).rows[0].n).toBe(0);
  });
  it("enforces every initial PO date, accepts the natural-month boundary and replays success after the calendar advances",async()=>{
    today=new Date("2026-01-31T01:00:00Z");
    const request=input();request.lines.forEach(line=>{line.deliveryDate="2026-02-28";});
    const invalid={...request,lines:request.lines.map((line,index)=>({...line,deliveryDate:index===1?"2026-02-27":line.deliveryDate}))};
    await expect(service.createOrder(actor(),invalid,randomUUID())).rejects.toMatchObject({statusCode:400,message:expect.stringContaining("PO 2")});
    await expect(service.createOrder(actor(),{...request,lines:request.lines.map((line,index)=>({...line,deliveryDate:index===1?null:line.deliveryDate}))},randomUUID())).rejects.toMatchObject({statusCode:400});
    const key=randomUUID(),order=await service.createOrder(actor(),request,key);
    today=new Date("2026-10-14T18:00:00Z");
    expect((await service.createOrder(actor(),request,key)).productionOrderId).toBe(order.productionOrderId);
    expect((await service.read(actor(),order.productionOrderId)).lines.map(line=>line.deliveryDate)).toEqual(["2026-02-28","2026-02-28"]);
    await expect(service.createOrder(actor(),{...request,designStyleNo:`${style}-LATE`},randomUUID())).rejects.toMatchObject({statusCode:400});
  });
  it("concurrent source confirmations with different keys create one order", async () => {
    const source = await publishedSource();
    const [a, b] = await Promise.all([service.createOrder(actor(), input(), randomUUID(), source.sourceId), service.createOrder(actor(), input(), randomUUID(), source.sourceId)]);
    expect(a.productionOrderId).toBe(b.productionOrderId); expect(a.sourceId).toBe(source.sourceId);
    await expect(service.createOrder(actor(), { ...input(), orderDate: "2026-09-28" }, randomUUID(), source.sourceId)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("root confirmation retains the source designer's access", async () => {
    const source = await publishedSource();
    const order = await service.createOrder(actor(root, ["root_superuser"]), input(), randomUUID(), source.sourceId);
    expect(order.createdBy).toBe(designer);
    expect((await service.read(actor(), order.productionOrderId)).sourceId).toBe(source.sourceId);
  });
  it("attaches a later development source to the original direct-order identity", async () => {
    const order = await service.createOrder(actor(), input(), randomUUID());
    const source = await publishedSource();
    const attached = await service.attachSource(actor(), order.productionOrderId, source.sourceId, randomUUID());
    expect(attached.productionOrderId).toBe(order.productionOrderId); expect(attached.status).toBe("development_linked");
    const second = await service.createOrder(actor(), input(`${style}-SECOND`), randomUUID());
    await expect(service.attachSource(actor(), second.productionOrderId, source.sourceId, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
  });
  it("root cannot attach a different designer's source to a direct order", async () => {
    const third = randomUUID();
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST third designer',true)", [third]);
    const source = await service.createSource(actor(third), sourceInput(), randomUUID());
    const order = await service.createOrder(actor(), input(), randomUUID());
    await expect(service.attachSource(actor(root, ["root_superuser"]), order.productionOrderId, source.sourceId, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    expect((await service.read(actor(), order.productionOrderId)).sourceId).toBeNull();
    const ownSourceId=randomUUID();
    await database.query("INSERT INTO digital_production_sources(source_id,created_by,development_type,design_style_no,temporary_style_no,customer_code) VALUES($1,$2,'头版',$3,'TEST-TEMP','PD')",[ownSourceId,designer,style]);
    const ownSource={sourceId:ownSourceId};
    expect((await service.attachSource(actor(root, ["root_superuser"]), order.productionOrderId, ownSource.sourceId, randomUUID())).sourceId).toBe(ownSource.sourceId);
  });
  it("number correction preserves root, PO identity, dates and quantities; rejects stale updates", async () => {
    const order = await service.createOrder(actor(), input(), randomUUID());
    const line = order.lines[0]!;
    const changed = await service.correctNumbers(actor(), order.productionOrderId, line.lineId, { expectedVersion: 1, poNumber: "REAL-PO", formalStyleNo: "REAL-PO" }, randomUUID());
    expect(changed.productionOrderId).toBe(order.productionOrderId); expect(changed.lines[0]?.lineId).toBe(line.lineId);
    expect(changed.lines[0]?.sizes).toEqual(line.sizes); expect(changed.createdAt).toBe(order.createdAt);
    await expect(service.correctNumbers(actor(), order.productionOrderId, line.lineId, { expectedVersion: 1, poNumber: "STALE", formalStyleNo: null }, randomUUID())).rejects.toMatchObject({ statusCode: 409 });
  });
  it("isolates another designer in read, search, source conversion and mutation", async () => {
    const source = await publishedSource();
    const order = await service.createOrder(actor(), input(), randomUUID());
    await expect(service.read(actor(other), order.productionOrderId)).rejects.toMatchObject({ statusCode: 404 });
    expect((await service.orders(actor(other), 1, style)).items).toEqual([]);
    expect((await service.sources(actor(other), 1, style)).items).toEqual([]);
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
    const order = await service.createOrder(actor(), input(), randomUUID()); const second = await service.createOrder(actor(), input(`${style}-SECOND`), randomUUID());
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
    const source = await publishedSource(); const key = randomUUID();
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
  it("PR02 applies only selected PO promises, rejects spoofed/current-secondary roles and keeps legacy facts and stable quantities",async()=>{
    const primary=randomUUID(),secondary=randomUUID(),director=randomUUID(),owner=randomUUID();
    for(const [id,role] of [[primary,"order_merchandiser"],[secondary,"order_merchandiser"],[director,"production_management"],[owner,"owner_group"]]){
      await database.query("INSERT INTO app_users(id,display_name) VALUES($1,'TEST PO dates')",[id]);
      await database.query("INSERT INTO business_roles(role_code) VALUES($1) ON CONFLICT DO NOTHING",[role]);
      await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,$2)",[id,role]);
    }
    const boss=actor(root,["root_superuser"]),dates=new PoCustomerDateService(database),access=new DigitalProductionAccessService(database);
    const order=await historicalDigitalOrder(database,boss,DigitalOrderCreateSchema.parse({...input(),primaryMerchandiserId:primary,lines:[
      {formalPoNo:"TEST-DATE-1",color:"黑",customerWarehouseArrivalDate:"2026-12-10",sizes:[{size:"M",quantity:11}]},
      {formalPoNo:"TEST-DATE-2",color:"白",customerWarehouseArrivalDate:"2026-12-12",sizes:[{size:"M",quantity:13}]},
      {formalPoNo:null,temporaryStyleNo:"TEST-ALT",color:"蓝",sizes:[{size:"M",quantity:17}]},
    ]})),id=order.productionOrderId,p=actor(primary,["order_merchandiser"]),m=actor(director,["production_management"]);
    await database.query("INSERT INTO digital_production_delegations(delegation_id,production_order_id,delegate_id,purpose,granted_by,expires_at) VALUES($1,$2,$3,'technical',$4,CURRENT_TIMESTAMP+interval '1 day')",[randomUUID(),id,secondary,root]);
    const inputDate={orderVersion:order.version,reason:"TEST客户确认选中一条",changes:[{lineId:order.lines[1]!.lineId,expectedVersion:1,date:"2026-12-20"}]};
    await expect(dates.request(actor(secondary,["order_merchandiser"]),id,inputDate,randomUUID())).rejects.toMatchObject({statusCode:404});
    await expect(dates.request(actor(owner,["owner_group"]),id,inputDate,randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(access.requestDelivery(p,id,{expectedVersion:order.version,deliveryDate:"2026-12-20",reason:"旧整单入口"})).rejects.toMatchObject({statusCode:409});
    const snap=()=>database.query("SELECT line_id,po_number,formal_style_no,temporary_style_no,color,delivery_date::text FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position",[id]);
    const prior=(await snap()).rows,key=randomUUID();
    const [request,retry]=await Promise.all([dates.request(p,id,inputDate,key),dates.request(p,id,inputDate,key)]);expect(retry).toEqual(request);
    await expect(dates.request(p,id,{...inputDate,reason:"different"},key)).rejects.toMatchObject({statusCode:409});
    await expect(dates.decide(actor(owner,["owner_group"]),id,request.requestId,true,randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(dates.decide(actor(secondary,["production_management"]),id,request.requestId,true,randomUUID())).rejects.toMatchObject({statusCode:403});
    const decisionKey=randomUUID();await dates.decide(m,id,request.requestId,true,decisionKey);await dates.decide(m,id,request.requestId,true,decisionKey);
    const current=await service.read(boss,id);expect(current.version).toBe(order.version+1);
    expect(current.lines.map(line=>line.customerWarehouseArrivalDate)).toEqual(["2026-12-10","2026-12-20",null]);
    expect(current.lines.map(line=>line.factoryDeliveryDate)).toEqual([null,null,null]);
    expect(current.lines.map(line=>line.sizes)).toEqual(order.lines.map(line=>line.sizes));expect((await snap()).rows).toEqual(prior);
    const history=await dates.read(p,id);expect(history.canRequestDate).toBe(true);expect(history.canApproveDate).toBe(false);
    expect(history.dateRequests[0]).toMatchObject({source:"po",status:"已批准",requestedBy:"TEST PO dates",decidedBy:"TEST PO dates",changes:[{lineId:order.lines[1]!.lineId,date:"2026-12-20"}]});
    expect((await database.query("SELECT count(*)::int n FROM digital_po_date_changes WHERE production_order_id=$1 AND source='approved_customer_change'",[id])).rows[0].n).toBe(1);
    await expect(database.query("UPDATE digital_po_customer_requests SET reason='forged' WHERE request_id=$1",[request.requestId])).rejects.toThrow("immutable");
    await expect(database.query("UPDATE digital_po_customer_request_lines SET new_date='2027-01-01' WHERE request_id=$1",[request.requestId])).rejects.toThrow("immutable");
    await database.query("UPDATE user_role_assignments SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND role_code='order_merchandiser'",[primary]);
    await expect(dates.request(p,id,{...inputDate,orderVersion:current.version},randomUUID())).rejects.toMatchObject({statusCode:404});
    await database.query("UPDATE user_role_assignments SET revoked_at=NULL WHERE user_id=$1",[primary]);
    const stale=await dates.request(p,id,{orderVersion:current.version,reason:"TEST待处理旧版本",changes:[{lineId:current.lines[0]!.lineId,expectedVersion:1,date:"2026-12-25"},{lineId:current.lines[1]!.lineId,expectedVersion:2,date:"2026-12-27"}]},randomUUID());
    const legacyPanelRequest=(await access.deliveryRequests(m,id)).find(row=>row.requestId===stale.requestId)!;
    expect(legacyPanelRequest).toMatchObject({source:"po",approvalBlockedReason:null});
    expect(legacyPanelRequest.changes).toEqual(expect.arrayContaining([{lineId:current.lines[0]!.lineId,poNumber:"TEST-DATE-1",color:"黑",oldDate:"2026-12-10",date:"2026-12-25",expectedVersion:1},{lineId:current.lines[1]!.lineId,poNumber:"TEST-DATE-2",color:"白",oldDate:"2026-12-20",date:"2026-12-27",expectedVersion:2}]));
    await service.correctNumbers(boss,id,current.lines[0]!.lineId,{expectedVersion:current.version,formalPoNo:"TEST-DATE-1-REV"},randomUUID());
    await expect(dates.decide(m,id,stale.requestId,true,randomUUID())).rejects.toMatchObject({statusCode:409});
    expect((await dates.read(m,id)).dateRequests.find(row=>row.requestId===stale.requestId)?.approvalBlockedReason).toContain("母单已更新");
    expect((await access.deliveryRequests(m,id)).find(row=>row.requestId===stale.requestId)?.approvalBlockedReason).toContain("母单已更新");
    await dates.decide(m,id,stale.requestId,false,randomUUID());
    const live=await service.read(boss,id),legacy=randomUUID();
    await database.query("INSERT INTO digital_production_delivery_requests(request_id,production_order_id,expected_version,previous_date,requested_date,reason,requested_by) VALUES($1,$2,$3,'2026-12-10','2026-12-28','TEST历史分歧不得猜',$4)",[legacy,id,live.version,primary]);
    await expect(access.decideDelivery(m,legacy,"approved")).rejects.toMatchObject({statusCode:409});await access.decideDelivery(m,legacy,"rejected");
    const paused=await dates.request(p,id,{orderVersion:live.version,reason:"暂停待审批",changes:[{lineId:live.lines[0]!.lineId,expectedVersion:1,date:"2026-12-26"}]},randomUUID());
    for(const state of ["paused","cancelled"]){
      await database.query("INSERT INTO digital_production_resource_lifecycle(resource_kind,resource_id,state,changed_by) VALUES('order',$1,$2,$3) ON CONFLICT(resource_kind,resource_id) DO UPDATE SET state=EXCLUDED.state",[id,state,primary]);
      await expect(dates.request(p,id,{orderVersion:live.version,reason:"停用新申请",changes:[{lineId:live.lines[0]!.lineId,expectedVersion:1,date:"2026-12-27"}]},randomUUID())).rejects.toMatchObject({statusCode:409});
      await expect(dates.decide(m,id,paused.requestId,true,randomUUID())).rejects.toMatchObject({statusCode:409});
      expect((await dates.read(p,id)).canRequestDate).toBe(false);
    }
    await dates.decide(m,id,paused.requestId,false,randomUUID());
    await database.query("UPDATE digital_production_resource_lifecycle SET state='active' WHERE resource_kind='order' AND resource_id=$1",[id]);
    await tx(async client=>{await approvedDate(client,id,live.lines[0]!.lineId,"factory","2026-12-09",0);});
    await expect(dates.request(p,id,{orderVersion:live.version,reason:"不能早于工厂",changes:[{lineId:live.lines[0]!.lineId,expectedVersion:1,date:"2026-12-08"}]},randomUUID())).rejects.toMatchObject({statusCode:409});
    await expect(dates.request(p,id,{orderVersion:live.version,reason:"不能串单",changes:[{lineId:randomUUID(),expectedVersion:0,date:"2026-12-20"}]},randomUUID())).rejects.toMatchObject({statusCode:409});
    await expect(dates.request(p,id,{orderVersion:live.version,reason:"重复PO",changes:[inputDate.changes[0]!,inputDate.changes[0]!]},randomUUID())).rejects.toMatchObject({statusCode:400});
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
    const request = await new PoCustomerDateService(database).request(actor(primary,["order_merchandiser"]),order.productionOrderId,{orderVersion:1,reason:"客户同意",changes:order.lines.map(line=>({lineId:line.lineId,expectedVersion:line.customerDateVersion??0,date:"2026-12-20"}))},randomUUID());
    await expect(access.decideDelivery(actor(primary, ["order_merchandiser"]), request.requestId, "approved")).rejects.toMatchObject({ statusCode: 403 });
    expect((await service.read(boss, order.productionOrderId)).contractDeliveryDate).toBeNull();
    await access.decideDelivery(boss, request.requestId, "approved");
    expect((await service.read(boss, order.productionOrderId)).lines.map(line=>line.customerWarehouseArrivalDate)).toEqual(["2026-12-20","2026-12-20"]);
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
      const source = await publishedSource(actor(),sourceInput(`${style}-${primaryMerchandiserId}`));
      await expect(service.createOrder(actor(), { ...input(`${style}-${primaryMerchandiserId}`), primaryMerchandiserId }, randomUUID(), source.sourceId)).rejects.toMatchObject({ statusCode: 403 });
    }
    expect((await database.query("SELECT count(*) FROM digital_production_orders")).rows).toEqual(count.rows);
    const order = await service.createOrder(actor(), { ...input(), primaryMerchandiserId: primary }, randomUUID());
    expect(order.primaryMerchandiserId).toBe(primary);
    expect((await service.createOrder(boss, { ...input(`${style}-BOSS`), primaryMerchandiserId: alternate }, randomUUID())).primaryMerchandiserId).toBe(alternate);
    const dual = actor(primary, ["order_merchandiser", "production_management"]);
    const request = await new PoCustomerDateService(database).request(dual,order.productionOrderId,{orderVersion:1,reason:"客户改期",changes:order.lines.map(line=>({lineId:line.lineId,expectedVersion:line.customerDateVersion??0,date:"2026-12-22"}))},randomUUID());
    for (const decision of ["approved", "rejected"] as const) await expect(access.decideDelivery(dual, request.requestId, decision)).rejects.toMatchObject({ statusCode: 403 });
    expect((await service.read(boss, order.productionOrderId)).contractDeliveryDate).toBeNull();
    expect((await database.query("SELECT * FROM digital_po_customer_decisions WHERE request_id=$1", [request.requestId])).rows).toHaveLength(0);
    expect(await access.decideDelivery(actor(director, ["production_management"]), request.requestId, "approved")).toEqual({ decision: "approved" });
    await expect(access.decideDelivery(dual, request.requestId, "approved")).rejects.toMatchObject({ statusCode: 403 });
    const rootRequest = await new PoCustomerDateService(database).request(boss,order.productionOrderId,{orderVersion:2,reason:"Root纠正",changes:order.lines.map(line=>({lineId:line.lineId,expectedVersion:(line.customerDateVersion??0)+1,date:"2026-12-23"}))},randomUUID());
    expect(await access.decideDelivery(boss, rootRequest.requestId, "approved")).toEqual({ decision: "approved" });
    expect((await service.read(boss, order.productionOrderId)).lines.map(line=>line.customerWarehouseArrivalDate)).toEqual(["2026-12-23","2026-12-23"]);
    await access.setCustomerDefault(boss, "PD", null);
    await expect(service.createOrder(actor(), { ...input(`${style}-ALT`), primaryMerchandiserId: alternate }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    expect((await service.createOrder(actor(), { ...input(`${style}-NO-PRIMARY`), primaryMerchandiserId: null }, randomUUID())).primaryMerchandiserId).toBeNull();
  });
  it("PR05 retires historical digital grants while preserving ordinary QC task reassignment", async () => {
    const access = new DigitalProductionAccessService(database); const policy = new DigitalProductionAccessPolicy(database);
    const boss = actor(root, ["root_superuser"]); const order = await service.createOrder(actor(), input(), randomUUID());
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    const historical=randomUUID();
    await database.query("INSERT INTO digital_production_delegations(delegation_id,production_order_id,delegate_id,purpose,granted_by,expires_at) VALUES($1,$2,$3,'technical',$4,$5)",[historical,order.productionOrderId,other,root,expiresAt]);
    const history=(await database.query("SELECT * FROM digital_production_delegations WHERE delegation_id=$1",[historical])).rows[0];
    expect(await policy.allowed(actor(other), "order", order.productionOrderId, "technical")).toBe(false);
    expect(await policy.allowed(actor(other), "order", order.productionOrderId, "budget")).toBe(false);
    await expect(access.delegate(boss, { resourceKind: "order", resourceId: order.productionOrderId, delegateId: other, purpose: "technical", expiresAt })).rejects.toMatchObject({statusCode:403});
    await expect(access.delegations(boss,"order",order.productionOrderId)).rejects.toMatchObject({statusCode:403});
    await expect(access.revoke(boss,historical)).rejects.toMatchObject({statusCode:403});
    const headers={cookie:`dx_rework_session=${root}`};
    expect((await app.inject({method:"POST",url:"/digital-production/access/delegations",headers,payload:{resourceKind:"order",resourceId:order.productionOrderId,delegateId:other,purpose:"technical",expiresAt}})).statusCode).toBe(403);
    expect((await app.inject({method:"GET",url:`/digital-production/access/delegations/order/${order.productionOrderId}`,headers})).statusCode).toBe(403);
    expect((await app.inject({method:"POST",url:`/digital-production/access/delegations/${historical}/revoke`,headers})).statusCode).toBe(403);
    expect((await database.query("SELECT * FROM digital_production_delegations WHERE delegation_id=$1",[historical])).rows[0]).toEqual(history);
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
    await database.query("INSERT INTO digital_production_delegations(delegation_id,task_id,delegate_id,purpose,granted_by,expires_at) VALUES($1,$2,$3,'execute',$4,$5)",[randomUUID(),taskId!,secondQc,root,expiresAt]);
    expect(await policy.allowed(actor(secondQc, ["quality_control"]), "task", taskId!, "execute")).toBe(false);
    expect(await policy.allowed(actor(secondQc, ["quality_control"]), "task", taskId!, "budget")).toBe(false);
    await database.query("UPDATE app_users SET enabled=false WHERE id=$1", [secondQc]);
    expect(await policy.allowed(actor(secondQc, ["quality_control"]), "task", taskId!, "execute")).toBe(false);
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

  it("PR05 rejects revoked and concurrently disabled targets and validates current personnel actor roles",async()=>{
    const access=new DigitalProductionAccessService(database),boss=actor(root,["root_superuser"]),target=randomUUID(),manager=randomUUID();
    for(const [id,role] of [[target,"order_merchandiser"],[manager,"production_management"]]){
      await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST CURRENT PERSONNEL',true)",[id]);
      await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,$2)",[id,role]);
    }
    const order=await service.createOrder(actor(),input(),randomUUID());
    await database.query("UPDATE user_role_assignments SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1",[target]);
    await expect(access.assignMerchandiser(boss,order.productionOrderId,target,order.version)).rejects.toMatchObject({statusCode:409});
    await expect(access.setCustomerDefault(boss,"PD",target)).rejects.toMatchObject({statusCode:409});
    await database.query("UPDATE user_role_assignments SET revoked_at=NULL WHERE user_id=$1",[target]);
    const client=await database.connect();
    try{
      await client.query("BEGIN");await client.query("UPDATE app_users SET enabled=false WHERE id=$1",[target]);
      const assigning=access.assignMerchandiser(boss,order.productionOrderId,target,order.version);
      await client.query("COMMIT");await expect(assigning).rejects.toMatchObject({statusCode:409});
    }finally{client.release();}
    expect((await service.read(boss,order.productionOrderId)).version).toBe(order.version);
    await database.query("UPDATE user_role_assignments SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1",[manager]);
    const staleManager=actor(manager,["production_management"]);
    expect(await access.options(staleManager)).toMatchObject({manage:false,customers:false});
    await expect(access.setCustomerDefault(staleManager,"PD",null)).rejects.toMatchObject({statusCode:403});
    await expect(access.assignMerchandiser(staleManager,order.productionOrderId,target,order.version)).rejects.toMatchObject({statusCode:403});
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


  it("preserves historical missing dates and one formal PO without changing quantities or stable identities",async()=>{
    const request=DigitalOrderCreateSchema.parse({...input(),lines:[
      {formalPoNo:" PO-A ",color:"A",customerWarehouseArrivalDate:"2026-12-10",sizes:[{size:"M",quantity:5}]},
      {formalPoNo:"PO-B",color:"B",customerWarehouseArrivalDate:"2026-12-12",sizes:[{size:"L",quantity:7}]},
      {formalPoNo:null,temporaryStyleNo:"TEMP-C",color:"C",sizes:[{size:"S",quantity:3}]},
    ]});
    const order=await historicalDigitalOrder(database,actor(),request);
    expect(order.lines.map(row=>row.formalPoNo)).toEqual(["PO-A","PO-B",null]);
    expect(order.lines.map(row=>row.poNumber)).toEqual(order.lines.map(row=>row.formalStyleNo));
    expect(order.lines.map(row=>row.customerWarehouseArrivalDate)).toEqual(["2026-12-10","2026-12-12",null]);
    expect(order.lines.map(row=>row.factoryDeliveryDate)).toEqual([null,null,null]);
    expect(order.lines.map(row=>row.customerDateVersion)).toEqual([1,1,0]);
    expect(order.lines.map(row=>row.sizes)).toEqual(request.lines.map(row=>row.sizes));
    expect((await service.read(actor(),order.productionOrderId)).lines.map(row=>row.lineId)).toEqual(order.lines.map(row=>row.lineId));
    expect((await database.query("SELECT count(*)::int n FROM digital_po_date_changes WHERE production_order_id=$1",[order.productionOrderId])).rows[0].n).toBe(2);
    await expect(service.correctNumbers(actor(),order.productionOrderId,order.lines[1]!.lineId,{expectedVersion:1,formalPoNo:" po-a ",poNumber:null,formalStyleNo:null},randomUUID())).rejects.toMatchObject({statusCode:400});
    expect((await service.read(actor(),order.productionOrderId)).version).toBe(1);
  });
  it("keeps two independent versioned promises and exact approval replay; rejects a later factory or earlier customer",async()=>{
    const order=await service.createOrder(actor(),input(),randomUUID());const a=order.lines[0]!;const b=order.lines[1]!;
    const event=await tx(c=>approvedDate(c,order.productionOrderId,a.lineId,"factory","2026-10-09",0));
    await tx(c=>approvedDate(c,order.productionOrderId,a.lineId,"factory","2026-10-09",0,actor(root,["root_superuser"]),event));
    await tx(c=>approvedDate(c,order.productionOrderId,a.lineId,"customer","2026-10-11",1));
    const after=await service.read(actor(),order.productionOrderId);
    expect(after.lines[0]).toMatchObject({lineId:a.lineId,customerWarehouseArrivalDate:"2026-10-11",factoryDeliveryDate:"2026-10-09",customerDateVersion:2,factoryDateVersion:1});
    expect(after.lines[1]).toEqual(b);expect(after.lines[0]!.sizes).toEqual(a.sizes);
    const count=(await database.query("SELECT count(*)::int n FROM digital_po_date_changes WHERE production_order_id=$1",[order.productionOrderId])).rows[0].n;
    await expect(tx(c=>approvedDate(c,order.productionOrderId,a.lineId,"factory","2026-10-12",1))).rejects.toMatchObject({statusCode:409});
    await expect(tx(c=>approvedDate(c,order.productionOrderId,a.lineId,"customer","2026-10-08",2))).rejects.toMatchObject({statusCode:409});
    await expect(tx(c=>approvedDate(c,order.productionOrderId,a.lineId,"factory","2026-10-08",0))).rejects.toMatchObject({statusCode:409});
    expect((await database.query("SELECT count(*)::int n FROM digital_po_date_changes WHERE production_order_id=$1",[order.productionOrderId])).rows[0].n).toBe(count);
    expect((await database.query("SELECT delivery_date::text date FROM digital_production_po_lines WHERE line_id=$1",[a.lineId])).rows[0].date).toBe("2026-10-10");
  });
  it("allows a live director but denies designers and owners; concurrent stale approvals never overwrite a newer PO date",async()=>{
    const manager=randomUUID();await database.query("INSERT INTO app_users(id,display_name) VALUES($1,'TEST director')",[manager]);
    await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'production_management')",[manager]);
    const director=actor(manager,["production_management"]);
    const order=await service.createOrder(actor(),input(),randomUUID());const line=order.lines[0]!;
    for(const forbidden of [actor(),actor(other),actor(other,["owner_group"])])await expect(tx(c=>approvedDate(c,order.productionOrderId,line.lineId,"customer","2026-10-20",1,forbidden))).rejects.toMatchObject({statusCode:403});
    const concurrent=await Promise.allSettled([tx(c=>approvedDate(c,order.productionOrderId,line.lineId,"customer","2026-10-20",1,director)),
      tx(c=>approvedDate(c,order.productionOrderId,line.lineId,"customer","2026-10-21",1,director))]);
    expect(concurrent.filter(row=>row.status==="fulfilled")).toHaveLength(1);
    expect(concurrent.filter(row=>row.status==="rejected")).toHaveLength(1);
    expect((await service.read(actor(),order.productionOrderId)).lines[0]!.customerDateVersion).toBe(2);
    expect((await database.query("SELECT count(*)::int n FROM digital_po_date_changes WHERE line_id=$1",[line.lineId])).rows[0].n).toBe(2);
  });
  it("locks the current reviewed factory document even for Root without locking an independent customer promise",async()=>{
    const order=await service.createOrder(actor(),input(),randomUUID());const line=order.lines[0]!;const child=randomUUID();
    await database.query("INSERT INTO sourcing_cases VALUES($1)",[child]);
    await tx(client=>linkNewDigitalChild(client,{module:"sourcing",childId:child,productionOrderId:order.productionOrderId,lines:[{childLineKey:"1",lineId:line.lineId}]}));
    await tx(client=>approvedDate(client,order.productionOrderId,line.lineId,"factory","2026-10-09",0));
    const reviewed=randomUUID();
    await database.query("INSERT INTO sourcing_contract_documents VALUES($1,$2,NULL,1)",[reviewed,child]);
    await database.query("INSERT INTO sourcing_finance_reconciliations VALUES($1,$2)",[child,reviewed]);
    await expect(tx(client=>approvedDate(client,order.productionOrderId,line.lineId,"factory","2026-10-08",1))).rejects.toMatchObject({statusCode:409});
    await tx(client=>approvedDate(client,order.productionOrderId,line.lineId,"customer","2026-10-11",1));
    expect((await service.read(actor(),order.productionOrderId)).lines[0]).toMatchObject({factoryDeliveryDate:"2026-10-09",factoryDateVersion:1,customerWarehouseArrivalDate:"2026-10-11",customerDateVersion:2});
    await database.query("INSERT INTO sourcing_contract_documents VALUES($1,$2,NULL,2)",[randomUUID(),child]);
    await tx(client=>approvedDate(client,order.productionOrderId,line.lineId,"factory","2026-10-08",1));
    expect((await service.read(actor(),order.productionOrderId)).lines[0]).toMatchObject({factoryDeliveryDate:"2026-10-08",factoryDateVersion:2});
  });
  it("detects historical number conflicts without rewriting them and denies unaudited or orphan effective date writes",async()=>{
    const order=await service.createOrder(actor(),input(),randomUUID());const line=order.lines[0]!;
    // Only this owned fixture: represent a row that existed before the prospective trigger.
    await database.query("ALTER TABLE digital_production_po_lines DISABLE TRIGGER digital_po_number_identity_guard");
    try{await database.query("UPDATE digital_production_po_lines SET po_number='OLD-PO',formal_style_no='OLD-STYLE' WHERE line_id=$1",[line.lineId]);}
    finally{await database.query("ALTER TABLE digital_production_po_lines ENABLE TRIGGER digital_po_number_identity_guard");}
    const historical=await service.read(actor(),order.productionOrderId);
    expect(historical.lines[0]).toMatchObject({lineId:line.lineId,poNumber:"OLD-PO",formalStyleNo:"OLD-STYLE",formalPoNo:null,poIdentityConflict:true});
    await expect(database.query("UPDATE digital_production_po_lines SET customer_warehouse_arrival_date='2026-12-10',customer_date_version=2 WHERE line_id=$1",[line.lineId])).rejects.toMatchObject({code:"55000"});
    await expect(database.query("UPDATE digital_po_date_changes SET new_date='2026-12-10' WHERE line_id=$1",[line.lineId])).rejects.toMatchObject({code:"55000"});
    await expect(tx(async client=>{
      const date="2026-12-10";const eventId=randomUUID();
      await client.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state)
        VALUES($1,'p01-test',$2,'digital_po_customer_dates_approved','digital_production',$3,$4)`,[eventId,root,order.productionOrderId,
        {reason:"TEST orphan fact",dateChanges:[{lineId:line.lineId,dateKind:"customer",oldDate:"2026-10-10",date,expectedVersion:1}]}]);
      await client.query(`INSERT INTO digital_po_date_changes(change_id,production_order_id,line_id,date_kind,old_date,new_date,version,source,approval_event_id,changed_by,request_id,reason)
        VALUES($1,$2,$3,'customer','2026-10-10',$4,2,'approved_customer_change',$5,$6,'p01-test','TEST orphan')`,[randomUUID(),order.productionOrderId,line.lineId,date,eventId,root]);
    })).rejects.toMatchObject({code:"55000"});
    expect((await service.read(actor(),order.productionOrderId)).lines[0]).toEqual(historical.lines[0]);
  });
});
