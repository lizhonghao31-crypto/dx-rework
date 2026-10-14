import { applyDigitalPoDateFixture } from "../helpers/digital-po-date-fixture.js";
import {DigitalOrderCreateSchema,InitialCustomerOrderDraftSchema,initialCustomerOrderInput,minimumInitialCustomerDate} from "@dx-rework/contracts/digital-production";
import { DigitalProductionTaskService } from "../../apps/api/src/production-platform/task-service.js";
import { DigitalCockpitQuery } from "../../apps/api/src/production-platform/cockpit-query.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { DigitalDevelopmentService } from "../../apps/api/src/production-platform/development-service.js";
import { DigitalProductionNotificationService } from "../../apps/api/src/production-platform/notification-service.js";
import { DevelopmentDocumentSchema, type DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
run("P05 development forms PostgreSQL", () => {
  const schema = ownedPostgresSchema("digital_development");
  const admin = new pg.Pool({connectionString:databaseUrl!});
  const database = new pg.Pool({connectionString:databaseUrl!,options:`-c search_path=${schema}`});
  const designer=randomUUID(), other=randomUUID(), root=randomUUID();
  const actor=(id=designer,roles=["sample_designer"]):TrustedActorContext=>({actorId:id,actorRoles:roles,authorizationCapability:"pattern_room:orders:create",authorizationCapabilities:["pattern_room:orders:create","todo:view"],requestId:"P05"});
  const service=new DigitalProductionIdentityService(database,true), development=new DigitalDevelopmentService(database,true);
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const name of ["0001_platform_foundation.sql", "0002_dingtalk_identity_access.sql", "0004_public_tools_foundation.sql", "0216_digital_production_order_roots.sql", "0217_digital_production_node_clocks.sql"])
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
    await database.query(await readFile(new URL("../../apps/api/migrations/0220_digital_production_tasks.sql", import.meta.url), "utf8"));
    await database.query(await readFile(new URL("../../apps/api/migrations/0221_digital_production_notifications.sql", import.meta.url), "utf8"));
    await database.query(await readFile(new URL("../../apps/api/migrations/0222_digital_development_documents.sql", import.meta.url), "utf8"));
  });

  afterAll(async()=>{await database.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
  const source=async()=> (await service.createSource(actor(),{developmentType:"头版",designStyleNo:`TEST-P05-${randomUUID()}`,temporaryStyleNo:null,customerCode:null},randomUUID())).sourceId;
  const draft=():DevelopmentDocument=>DevelopmentDocumentSchema.parse({template:"上衣",quantity:null,sampleSize:"",orderDate:null,returnDate:null,unit:"cm",sizes:["M"],measurements:[{name:"胸围",values:[""]}],interlining:"",placketInterlining:"",sewingThread:"",buttonholeThread:"",stitchDensity:"",washingIroning:"",packaging:"",formalSizes:"",casualSizes:"",mainLabel:false,mainLabelMethod:"",sizeLabel:false,careLabel:false,instructions:"",craft:"无",washing:"免洗",materials:[],files:[]});
  const ready=async()=>{
    const doc=draft(),id=randomUUID();
    await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$4,'test.png','image/png',100,$2,$3,'ready',CURRENT_TIMESTAMP)`,[id,"a".repeat(64),designer,`test/${id}`]);
    return {...doc,quantity:1,sampleSize:"M",orderDate:"2026-09-30",files:[{attachmentId:id,kind:"款图" as const}]};
  };
  it("persists incomplete customer PO drafts, rejects invalid initial publication without tasks, and hides PO drafts from technical readers",async()=>{
    const id=await source(),identity=await development.read(actor(),id);
    const document:DevelopmentDocument=await ready();
    const order=InitialCustomerOrderDraftSchema.parse({customerCode:"PD",productGroup:"男装",designStyleNo:identity.designStyleNo,temporaryStyleNo:null,orderDate:"2026-10-15",contractDeliveryDate:null,lines:[{color:"TEST蓝",deliveryDate:null,sizes:[{size:"M",quantity:"12."}]}]});
    document.customerOrderDraft={withOrder:true,order};
    const count=async()=>(await database.query("SELECT count(*)::int n FROM digital_production_task_access WHERE source_id=$1",[id])).rows[0].n;
    let saved=await development.save(actor(),id,{expectedVersion:0,document},randomUUID());
    expect(saved.document?.customerOrderDraft?.order.lines[0]?.sizes[0]?.quantity).toBe("12.");
    await expect(development.publish(actor(),id,saved.version,randomUUID())).rejects.toMatchObject({statusCode:400,message:expect.stringContaining("PO 1")});
    expect(await count()).toBe(0);
    order.lines[0]!.sizes[0]!.quantity="12";
    const minimum=minimumInitialCustomerDate(),prior=new Date(`${minimum}T00:00:00Z`);prior.setUTCDate(prior.getUTCDate()-1);
    order.lines[0]!.customerWarehouseArrivalDate=prior.toISOString().slice(0,10);
    saved=await development.save(actor(),id,{expectedVersion:saved.version,document},randomUUID());
    await expect(development.publish(actor(),id,saved.version,randomUUID())).rejects.toMatchObject({statusCode:400,message:expect.stringContaining("客户侧交期")});
    expect(await count()).toBe(0);
    order.lines[0]!.customerWarehouseArrivalDate=minimum;order.designStyleNo="TEST-TAMPERED";
    saved=await development.save(actor(),id,{expectedVersion:saved.version,document},randomUUID());
    await expect(development.publish(actor(),id,saved.version,randomUUID())).rejects.toMatchObject({statusCode:400,message:expect.stringContaining("当前开发来源一致")});
    expect(await count()).toBe(0);
    order.designStyleNo=identity.designStyleNo;
    saved=await development.save(actor(),id,{expectedVersion:saved.version,document},randomUUID());
    await development.publish(actor(),id,saved.version,randomUUID());
    const confirmation=DigitalOrderCreateSchema.parse(initialCustomerOrderInput(order));
    for(const patch of [
      {...confirmation.lines[0]!,color:"TEST其他颜色"},
      {...confirmation.lines[0]!,sizes:[{size:"M",quantity:13}]},
      {...confirmation.lines[0]!,customerWarehouseArrivalDate:"2099-12-31"},
    ])await expect(service.createOrder(actor(),{...confirmation,lines:[patch]},randomUUID(),id)).rejects.toMatchObject({statusCode:409,message:expect.stringContaining("已发布的订购草稿一致")});
    expect((await database.query("SELECT count(*)::int n FROM digital_production_orders WHERE source_id=$1",[id])).rows[0].n).toBe(0);
    await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'order_merchandiser')",[other]);
    await expect(service.createOrder(actor(),{...confirmation,primaryMerchandiserId:other},randomUUID(),id)).rejects.toMatchObject({statusCode:403});
    const confirmed=await service.createOrder(actor(root,['root_superuser']),{...confirmation,primaryMerchandiserId:other},randomUUID(),id);
    expect(confirmed.primaryMerchandiserId).toBe(other);
    expect(confirmed.lines[0]?.sizes[0]?.quantity).toBe(12);expect((await development.read(actor(),id)).document?.quantity).toBe(1);
    expect((await development.read(actor(),id)).productionOrderId).toBe(confirmed.productionOrderId);
    expect((await new DigitalDevelopmentService(database,false).read(actor(),id)).document?.customerOrderDraft).toEqual(document.customerOrderDraft);
    await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'pattern_room_supervisor')",[other]);
    const technical=await development.read(actor(other,['pattern_room_supervisor']),id);
    expect(technical.document?.customerOrderDraft).toBeUndefined();expect(technical.productionOrderId).toBeNull();expect(technical.document?.quantity).toBe(1);
  });
  it("retains later customer confirmation with independent PO quantities after development published without an order",async()=>{
    const id=await source(),sheet=await development.read(actor(),id),document=await ready();
    const saved=await development.save(actor(),id,{expectedVersion:0,document},randomUUID());await development.publish(actor(),id,saved.version,randomUUID());
    const confirmed=await service.createOrder(actor(),DigitalOrderCreateSchema.parse({customerCode:"PD",productGroup:"男装",designStyleNo:sheet.designStyleNo,orderDate:"2026-10-15",lines:[{color:"TEST后确认",customerWarehouseArrivalDate:minimumInitialCustomerDate(),sizes:[{size:"M",quantity:19}]}]}),randomUUID(),id);
    expect(confirmed.lines[0]?.sizes[0]?.quantity).toBe(19);expect((await development.read(actor(),id)).document?.quantity).toBe(1);
  });
  it("projects authorized style images and the declared development flow without inventing tasks",async()=>{
    const id=await source(),document=await ready();
    await development.save(actor(),id,{expectedVersion:0,document},randomUUID());
    await development.publish(actor(),id,1,randomUUID());
    const query=new DigitalCockpitQuery(database),input={stage:"development" as const,page:1,search:""};
    const row=(await query.list(actor(),input)).items.find(item=>item.sourceId===id)!;
    expect(row.category).toBe("上衣");expect(row.styleImageId).toBe(document.files[0]!.attachmentId);
    expect(row.flow).toHaveLength(7);expect(row.flow![0]).toMatchObject({key:"development_materials",state:"ready"});
    expect(row.flow!.slice(1).every(node=>node.state==="uncreated"&&node.taskId===null)).toBe(true);
    expect(row.flow!.some(node=>/printing|embroidery|washing/.test(node.key))).toBe(false);
    expect((await query.list(actor(other),input)).items.some(item=>item.sourceId===id)).toBe(false);
  });
  it("saves incomplete drafts, rejects publishing them, and rejects other designers",async()=>{
    const id=await source();const saved=await development.save(actor(),id,{expectedVersion:0,document:draft()},randomUUID());
    expect(saved.version).toBe(1);expect(saved.status).toBe("draft");
    await expect(development.publish(actor(),id,1,randomUUID())).rejects.toMatchObject({statusCode:400});
    await expect(development.read(actor(other),id)).rejects.toMatchObject({statusCode:404});
    await expect(development.save(actor(other),id,{expectedVersion:1,document:draft()},randomUUID())).rejects.toMatchObject({statusCode:403});
    expect((await database.query("SELECT count(*)::int AS n FROM digital_production_task_access WHERE source_id=$1",[id])).rows[0].n).toBe(0);
  });
  it("keeps creation-image ownership and source-scoped download permissions for designer, Root and other users",async()=>{
    const id=await source(),document=await ready();
    await development.save(actor(),id,{expectedVersion:0,document:{...document,washing:"免洗",ironing:"TEST独立整烫"}},randomUUID());
    await expect(development.authorizeUpload(actor(),id)).resolves.toBeUndefined();
    await expect(development.authorizeUpload(actor(root,['root_superuser']),id)).resolves.toBeUndefined();
    await expect(development.authorizeUpload(actor(other),id)).rejects.toMatchObject({statusCode:403});
    await expect(development.canDownload(actor(),id,document.files[0]!.attachmentId)).resolves.toBe(true);
    await expect(development.canDownload(actor(root,['root_superuser']),id,document.files[0]!.attachmentId)).resolves.toBe(true);
    await expect(development.canDownload(actor(other),id,document.files[0]!.attachmentId)).rejects.toMatchObject({statusCode:404});
    expect((await development.read(actor(),id)).document!.ironing).toBe("TEST独立整烫");
  });
  it("publishes once under concurrent retries, freezes original form, and creates a real 4h clerk task",async()=>{
    const id=await source(),document=await ready();await development.save(actor(),id,{expectedVersion:0,document},randomUUID());
    const key=randomUUID();const result=await Promise.all([development.publish(actor(),id,1,key),development.publish(actor(),id,1,key)]);
    expect(result[0].taskId).toBe(result[1].taskId);expect(result[0].status).toBe("published");
    expect((await database.query("SELECT count(*)::int AS n FROM digital_production_task_access WHERE source_id=$1",[id])).rows[0].n).toBe(1);
    const task=(await database.query("SELECT state,EXTRACT(EPOCH FROM(due_at-entered_at))::int AS seconds FROM digital_production_tasks JOIN LATERAL(SELECT due_at FROM digital_production_deadline_revisions WHERE task_id=digital_production_tasks.task_id ORDER BY revision_id DESC LIMIT 1)d ON true WHERE task_id=$1",[result[0].taskId])).rows[0];
    expect(task).toMatchObject({state:"ready",seconds:14400});
    await expect(development.save(actor(),id,{expectedVersion:2,document},randomUUID())).rejects.toMatchObject({statusCode:409});
    await expect(database.query("UPDATE digital_development_documents SET document='{}' WHERE source_id=$1",[id])).rejects.toThrow("immutable");
  });
  it("requires an expected date for missing trims, keeps material history and emits only current overdue stage",async()=>{
    const id=await source(),document=await ready(),materialId=randomUUID();
    document.materials=[{materialId,category:"辅料",label:"拉链",supplier:"",name:"拉链",width:"",weight:"",composition:"",consumption:"",color:"黑",specification:"20cm",quantity:"1",requiredThisRound:true,available:false,expectedDate:null}];
    await development.save(actor(),id,{expectedVersion:0,document},randomUUID());
    await expect(development.publish(actor(),id,1,randomUUID())).rejects.toMatchObject({statusCode:400});
    document.materials[0]!.expectedDate="2020-01-01";
    await development.save(actor(),id,{expectedVersion:1,document},randomUUID());await development.publish(actor(),id,2,randomUUID());
    const notices=new DigitalProductionNotificationService(database);await notices.runOnce();await notices.runOnce();
    const before=(await database.query("SELECT title FROM digital_development_notices WHERE source_id=$1",[id])).rows;
    expect(before).toHaveLength(1);expect(before[0].title).toContain("已逾期");
    await development.materialEvent(actor(),id,materialId,{expectedMaterialRevision:0,expectedVersion:3,action:"修改预计日期",expectedDate:"2099-01-01",note:"供应商延期"},randomUUID());
    await notices.runOnce();expect((await database.query("SELECT title FROM digital_development_notices WHERE source_id=$1",[id])).rowCount).toBe(1);
    await development.materialEvent(actor(),id,materialId,{expectedMaterialRevision:1,expectedVersion:3,action:"到货",expectedDate:null,note:"实物已到"},randomUUID());await notices.runOnce();
    await expect(development.materialEvent(actor(),id,materialId,{expectedMaterialRevision:1,expectedVersion:3,action:"修改预计日期",expectedDate:"2099-02-01",note:"旧页面"},randomUUID())).rejects.toMatchObject({statusCode:409});
    const sheet=await development.read(actor(),id);expect(sheet.materialEvents).toHaveLength(2);expect(sheet.document!.materials[0]!.expectedDate).toBe("2020-01-01");
    expect(await notices.claim(actor())).toMatchObject({notification:{route:{routeName:"digital_development",entityId:id},actionable:false}});
  });
  it("rejects cross-source attachments and conflicting idempotency payloads",async()=>{
    const first=await source(),second=await source(),document=await ready(),key=randomUUID();
    await development.save(actor(),first,{expectedVersion:0,document},key);
    await expect(development.save(actor(),second,{expectedVersion:0,document},randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(development.save(actor(),first,{expectedVersion:0,document:{...document,sampleSize:"L"}},key)).rejects.toMatchObject({statusCode:409});
  });
  it("uses the latest published round image and route while preserving the original document",async()=>{
    await database.query(await readFile(new URL("../../apps/api/migrations/0225_digital_development_rounds.sql",import.meta.url),"utf8"));
    const id=await source(),original=await ready();
    await development.save(actor(),id,{expectedVersion:0,document:original},randomUUID());await development.publish(actor(),id,1,randomUUID());
    const updated=await ready(),routeId=randomUUID(),client=await database.connect();
    try {
      await client.query("BEGIN");await development.bindFiles(client,actor(),id,updated);
      await client.query(`INSERT INTO digital_development_rounds(source_id,round_number,based_on_round,document_version,document,origin,customer_comment,internal_problem,explanation,categories,affected_nodes,output_kind,route_nodes,inherited,route_id,created_by)
        VALUES($1,2,1,3,$2,'客户新增要求','TEST 新款图','','TEST',ARRAY['款图'],ARRAY['纸样'],'整件样板',ARRAY['development_materials','development_pattern'],'{}',$3,$4)`,[id,JSON.stringify(updated),routeId,designer]);
      await new DigitalProductionTaskService(database).createWithClient(client,actor(root,['root_superuser']),{resource:{kind:'source',id},kind:'development_materials',routeId,routeVersion:2,occurrence:2,assigneeId:null});
      await client.query("COMMIT");
    } catch(error){await client.query("ROLLBACK");throw error;} finally {client.release();}
    const row=(await new DigitalCockpitQuery(database).list(actor(),{page:1,search:'',stage:'development'})).items.find(item=>item.sourceId===id)!;
    expect(row.styleImageId).toBe(updated.files[0]!.attachmentId);expect(row.styleImageId).not.toBe(original.files[0]!.attachmentId);
    expect(row.flow?.map(node=>node.key)).toEqual(['development_materials','development_pattern']);
    expect((await development.read(actor(),id,database,1)).document!.files[0]!.attachmentId).toBe(original.files[0]!.attachmentId);
  });

});
