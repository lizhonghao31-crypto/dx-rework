import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {ownedPostgresSchema} from "../helpers/owned-postgres-schema.js";
import {applyDigitalPoDateFixture} from "../helpers/digital-po-date-fixture.js";
import {DigitalProductionIdentityService} from "../../apps/api/src/production-platform/identity-service.js";
import {DigitalBudgetService} from "../../apps/api/src/production-platform/budget-service.js";
import {DigitalOrderCreateSchema,minimumInitialCustomerDate} from "@dx-rework/contracts/digital-production";
import type {BudgetDocument} from "@dx-rework/contracts/digital-budget";
import type {TrustedActorContext} from "../../apps/api/src/tools/repositories.js";
const url=process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)("shared budget final publication PostgreSQL",()=>{
 const schema=ownedPostgresSchema('shared_budget'),admin=new pg.Pool({connectionString:url}),database=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 const designer=randomUUID(),other=randomUUID(),root=randomUUID(),merch=randomUUID();
 const actor=(actorId=designer,actorRoles=['sample_designer']):TrustedActorContext=>({actorId,actorRoles,requestId:'TEST-budget',authorizationCapability:'pattern_room:orders:create',authorizationCapabilities:['pattern_room:orders:create']});
 const budget=new DigitalBudgetService(database,true),identity=new DigitalProductionIdentityService(database,true);
 beforeAll(async()=>{
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

 await database.query(await readFile(new URL('../../apps/api/migrations/0226_digital_production_budgets.sql',import.meta.url),'utf8'));
 await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST merch',true)",[merch]);
 await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'order_merchandiser')",[merch]);
 });
 afterAll(async()=>{await database.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
 const document:BudgetDocument={fabricType:'针织',productCategory:'上衣',monthSeries:'',date:'2026-10-23',currency:'人民币',rows:[],freight:'0',cm:'8',salePrice:'20',outsourcingScope:'车缝',outsourcingUnitPrice:'8',imageAttachmentIds:[]};
 const order=async()=>{
 const result=await identity.createOrder(actor(),DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:`TEST-BUDGET-${randomUUID()}`,orderDate:'2026-10-23',lines:[{color:'黑',customerWarehouseArrivalDate:minimumInitialCustomerDate(),sizes:[{size:'M',quantity:5}]}]}),randomUUID());
 await database.query('UPDATE digital_production_orders SET primary_merchandiser_id=$2 WHERE production_order_id=$1',[result.productionOrderId,merch]);return result.productionOrderId;
 };
 it('shares one draft, rejects outsiders/designer publication, freezes at own merchandiser final publication with exact retry',async()=>{
 const id=await order(),owner=actor(merch,['order_merchandiser']);
 const saved=await budget.save(actor(),id,{expectedVersion:0,document},randomUUID());
 expect(await budget.read(owner,id)).toMatchObject({version:saved.version,canEdit:true,canPublish:true});
 await expect(budget.save(actor(other),id,{expectedVersion:saved.version,document},randomUUID())).rejects.toMatchObject({statusCode:404});
 await expect(budget.publish(actor(),id,saved.version,randomUUID())).rejects.toMatchObject({statusCode:403});
 const changed=await budget.save(owner,id,{expectedVersion:saved.version,document:{...document,cm:'9'}},randomUUID());
 await expect(budget.save(actor(),id,{expectedVersion:saved.version,document},randomUUID())).rejects.toMatchObject({statusCode:409});
 const key=randomUUID(),published=await budget.publish(owner,id,changed.version,key);
 expect(published).toMatchObject({status:'published',canEdit:false,canPublish:false,document:{cm:'9'}});
 expect(await budget.publish(owner,id,changed.version,key)).toEqual(published);
 for(const user of [actor(),owner,actor(root,['root_superuser'])])await expect(budget.save(user,id,{expectedVersion:published.version,document},randomUUID())).rejects.toMatchObject({statusCode:409});
 expect((await database.query('SELECT count(*)::int n FROM digital_budget_versions WHERE production_order_id=$1',[id])).rows[0].n).toBe(1);
 await expect(database.query("UPDATE digital_budget_versions SET totals='{}' WHERE production_order_id=$1",[id])).rejects.toMatchObject({code:'55000'});
 });
 it('serializes a simultaneous edit and final publish without silently freezing different content',async()=>{
 const id=await order(),saved=await budget.save(actor(),id,{expectedVersion:0,document},randomUUID());
 const outcomes=await Promise.allSettled([budget.publish(actor(merch,['order_merchandiser']),id,saved.version,randomUUID()),budget.save(actor(),id,{expectedVersion:saved.version,document:{...document,cm:'10'}},randomUUID())]);
 expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);
 const current=await budget.read(actor(),id);expect(current.document!.cm).toBe(current.status==='published'?'8':'10');
 });
});
