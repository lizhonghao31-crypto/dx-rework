import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import Fastify from 'fastify';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {ownedPostgresSchema,createOwnedPostgresSchema,releaseOwnedPostgresSchema} from '../helpers/owned-postgres-schema.js';
import {applyDigitalPoDateFixture} from '../helpers/digital-po-date-fixture.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalBudgetService} from '../../apps/api/src/production-platform/budget-service.js';
import {DigitalQuotationService} from '../../apps/api/src/production-platform/quotation-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {registerQuotationRoutes} from '../../apps/api/src/production-platform/quotation-routes.js';
import {ensureQuotationBudget} from '../../apps/api/src/production-platform/quotation-budget-basis.js';
import {ApplicationError} from '../../apps/api/src/platform/errors.js';
import {DigitalOrderCreateSchema,minimumInitialCustomerDate} from '@dx-rework/contracts/digital-production';
import {QuotationConfirmationSchema,type QuotationResource} from '@dx-rework/contracts/digital-quotation';
import type {BudgetDocument} from '@dx-rework/contracts/digital-budget';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
const url=process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('PR02 customer-confirmed quotation to bounded budget PostgreSQL',()=>{
 const schema=ownedPostgresSchema('customer_quote'),admin=new pg.Pool({connectionString:url}),database=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 const designer=randomUUID(),other=randomUUID(),root=randomUUID(),merch=randomUUID(),tech=randomUUID(),ie=randomUUID();let legacyId:string;
 const actor=(actorId=designer,actorRoles=['sample_designer']):TrustedActorContext=>({actorId,actorRoles,requestId:'TEST-quote',authorizationCapability:'digital_production:view',authorizationCapabilities:['digital_production:view','pattern_room:orders:create']});
 const budget=new DigitalBudgetService(database,true),identity=new DigitalProductionIdentityService(database,true),quotes=new DigitalQuotationService(database,true);
 const owner=()=>actor(merch,['order_merchandiser']);
 const baseDocument=():BudgetDocument=>({fabricType:'针织',productCategory:'上衣',monthSeries:'',date:'2026-11-01',currency:'人民币',rows:[],freight:'0',cm:'0',salePrice:'999',outsourcingScope:'车缝',outsourcingUnitPrice:'8',imageAttachmentIds:[]});
 const order=async(sourceId?:string,designStyleNo?:string)=>{const result=await identity.createOrder(actor(),DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:designStyleNo??`TEST-QUOTE-${randomUUID()}`,orderDate:'2026-10-23',lines:[{color:'黑',customerWarehouseArrivalDate:minimumInitialCustomerDate(),sizes:[{size:'M',quantity:5}]}]}),randomUUID(),sourceId??null);await database.query('UPDATE digital_production_orders SET primary_merchandiser_id=$2 WHERE production_order_id=$1',[result.productionOrderId,merch]);return result.productionOrderId;};
 const confirmation=(version:number,total='20')=>QuotationConfirmationSchema.parse({expectedVersion:version,customerCode:'PD',customerConfirmedTotal:total,amountScope:'per_piece',quantity:null,quantityUnit:'件',currency:'人民币',taxBasis:'excludes_tax',sourceKind:'explicit_customer_confirmation',sourceField:'customerConfirmedTotal',templateVersion:'online-quotation-v1',evidenceNote:'TEST 客户邮件：确认每件20元，不使用内部成本或销售价替代',confirmedAt:'2026-01-01T00:00:00Z'});
 const readyQuote=async(resource:QuotationResource,process=false)=>{const rowId=randomUUID(),document={...baseDocument(),rows:[{rowId,section:process?'外发工序' as const:'主料' as const,category:'',name:'TEST 面料',specification:'TEST',unit:'米',supplier:'TEST',consumption:'',unitPrice:process?'':'10'}]};let sheet=await quotes.save(actor(),resource,{expectedVersion:0,document,assignments:[{rowId,technicalAssigneeId:tech,priceAssigneeId:process?ie:designer,priceRole:process?'ie_reviewer':'sample_designer'}]},randomUUID());sheet=await quotes.fillRow(actor(tech,['pattern_room_worker']),resource,rowId,{expectedVersion:sheet.version,consumption:'1'},randomUUID());if(process)sheet=await quotes.fillRow(actor(ie,['ie_reviewer']),resource,rowId,{expectedVersion:sheet.version,unitPrice:'10'},randomUUID());return {sheet,rowId};};
 beforeAll(async()=>{
 await createOwnedPostgresSchema(admin,schema);
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
      INSERT INTO business_roles(role_code) VALUES('sample_designer'),('order_merchandiser'),('pattern_room_supervisor'),('pattern_room_worker'),('production_management'),('quality_control'),('embroidery_washing_merchandiser'),('warehouse_receiver'),('ie_reviewer');`);
    await database.query(await readFile(new URL("../../apps/api/migrations/0219_digital_production_access.sql", import.meta.url), "utf8"));
    await database.query(`CREATE FUNCTION fixture_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
      VALUES(NEW.id,NEW.id,'dingtalk','TEST',NEW.id::text,NEW.id::text,true,true,CURRENT_TIMESTAMP); RETURN NEW; END $$;
      CREATE TRIGGER fixture_user_identity AFTER INSERT ON app_users FOR EACH ROW EXECUTE FUNCTION fixture_identity();`);
    for (const id of [designer, other, root,tech,ie]) await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST P01',true)", [id]);
    for (const id of [designer, other]) await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'sample_designer')", [id]);
    await database.query(await readFile(new URL("../../apps/api/migrations/0220_digital_production_tasks.sql", import.meta.url), "utf8"));

 await database.query(await readFile(new URL('../../apps/api/migrations/0226_digital_production_budgets.sql',import.meta.url),'utf8'));
 await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST merch',true)",[merch]);
 await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'order_merchandiser')",[merch]);
 await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'pattern_room_worker'),($2,'ie_reviewer')",[tech,ie]);
 legacyId=await order();await budget.save(actor(),legacyId,{expectedVersion:0,document:baseDocument()},randomUUID());
 await database.query(await readFile(new URL('../../apps/api/migrations/0267_customer_quotation_budget_basis.sql',import.meta.url),'utf8'));
 for(const name of ['0221_digital_production_notifications.sql','0222_digital_development_documents.sql'])await database.query(await readFile(new URL(`../../apps/api/migrations/${name}`,import.meta.url),'utf8'));
 });
 afterAll(async()=>{await database.end();await releaseOwnedPostgresSchema(admin,schema);await admin.end();});
 it('enrols every new formal order at database boundary and preserves historical budgets without fabricated quotes',async()=>{
   const id=await order();expect((await budget.read(owner(),id)).comparison?.policy).toBe('quote_v1');
   await expect(budget.save(owner(),id,{expectedVersion:0,document:baseDocument()},randomUUID())).rejects.toMatchObject({statusCode:409});
   expect((await budget.read(owner(),legacyId)).comparison?.policy).toBe('legacy');
   expect((await budget.publish(owner(),legacyId,1,randomUUID())).status).toBe('published');
   expect((await database.query('SELECT * FROM digital_quotation_versions')).rows).toHaveLength(0);
 });
 it('requires real technical input and assigned prices, redacts full costs, and rejects cross-order and unauthorized fields',async()=>{
   const id=await order(),resource={kind:'order' as const,id},ready=await readyQuote(resource,true);
   const technical=await quotes.read(actor(tech,['pattern_room_worker']),resource);expect(technical.document).toBeNull();expect(technical.confirmation).toBeNull();expect(technical.rows[0]!.unitPrice).toBeNull();
   expect((await quotes.list(actor(tech,['pattern_room_worker']))).items.some(item=>item.resource.id===id)).toBe(true);
   expect((await quotes.list(actor(other))).items.some(item=>item.resource.id===id)).toBe(false);
   const price=await quotes.read(actor(ie,['ie_reviewer']),resource);expect(price.rows).toHaveLength(1);expect(price.rows[0]!.unitPrice).toBe('10');expect(price.document).toBeNull();
   await expect(quotes.read(actor(other),resource)).rejects.toMatchObject({statusCode:404});
   await expect(quotes.read(actor(tech,['pattern_room_worker']),{kind:'order',id:await order()})).rejects.toMatchObject({statusCode:404});
   await expect(quotes.fillRow(actor(tech,['pattern_room_worker']),resource,ready.rowId,{expectedVersion:ready.sheet.version,unitPrice:'0'},randomUUID())).rejects.toMatchObject({statusCode:403});
   await expect(quotes.fillRow(actor(ie,['ie_reviewer']),resource,ready.rowId,{expectedVersion:ready.sheet.version,consumption:'0'},randomUUID())).rejects.toMatchObject({statusCode:403});
   await expect(budget.read(actor(tech,['pattern_room_worker']),id)).rejects.toMatchObject({statusCode:404});
 });
 for(const [label,total,passes] of [['below','20',true],['equal','10',true],['above','9.999999',false]] as const)it(`compares only frozen customer total: ${label}, no Root bypass or salePrice substitution`,async()=>{
   const id=await order(),resource={kind:'order' as const,id},ready=await readyQuote(resource);
   const key=randomUUID();const confirmed=await quotes.confirm(actor(),resource,confirmation(ready.sheet.version,total),key);
   expect(await quotes.confirm(actor(),resource,confirmation(ready.sheet.version,total),key)).toEqual(confirmed);
   const draft=await budget.read(owner(),id);expect(draft.version).toBe(1);expect(draft.comparison).toMatchObject({confirmedQuoteTotal:total,budgetComparableTotal:'10'});
   if(passes){const published=await budget.publish(owner(),id,draft.version,randomUUID(),ready.sheet.version);expect(published.status).toBe('published');}
   else for(const a of [owner(),actor(root,['root_superuser'])])await expect(budget.publish(a,id,draft.version,randomUUID(),ready.sheet.version)).rejects.toMatchObject({code:'BUDGET_TOTAL_EXCEEDS_QUOTE',statusCode:409});
   expect(Number((await database.query('SELECT count(*) FROM digital_budget_quote_conversions WHERE production_order_id=$1',[id])).rows[0].count)).toBe(1);
 });
 it('uses exact unrounded 12-place budget products and order quantity, not rounded display or internal cost as quotation',async()=>{
   const id=await order(),resource={kind:'order' as const,id},ready=await readyQuote(resource);let q=await quotes.fillRow(actor(tech,['pattern_room_worker']),resource,ready.rowId,{expectedVersion:ready.sheet.version,consumption:'0.000001'},randomUUID());
   q=await quotes.read(actor(),resource);const doc={...q.document!,rows:q.document!.rows.map(r=>({...r,unitPrice:'0.000001'}))};q=await quotes.save(actor(),resource,{expectedVersion:q.version,document:doc,assignments:q.assignments},randomUUID());
   await quotes.confirm(actor(),resource,{...confirmation(q.version,'0'),amountScope:'order_total',quantity:5},randomUUID());
   const draft=await budget.read(owner(),id);expect(draft.comparison?.budgetComparableTotal).toBe('0.000000000005');
   await expect(budget.publish(owner(),id,1,randomUUID(),q.version)).rejects.toMatchObject({code:'BUDGET_TOTAL_EXCEEDS_QUOTE'});
 });
 it('makes one budget when confirmation precedes formal order, remains pending for pure development, and tolerates duplicate conversion events',async()=>{
   const source=await identity.createSource(actor(),{developmentType:'头版',designStyleNo:`TEST-SOURCE-${randomUUID()}`,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
   const resource={kind:'source' as const,id:source.sourceId},ready=await readyQuote(resource);await quotes.confirm(actor(),resource,confirmation(ready.sheet.version),randomUUID());
   expect((await quotes.read(actor(),resource)).budget.state).toBe('waiting_formal_order');
   // A published development is the precondition; formal confirmation itself
   // uses the actual identity command, including its conversion hook.
   const pre=await database.connect();try{await pre.query('BEGIN');const task=await new DigitalProductionTaskService(database).createWithClient(pre,actor(root,['root_superuser']),{resource,kind:'development_materials',routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:null});await pre.query("INSERT INTO digital_development_documents(source_id,version,status,document,published_at,task_id,updated_by) VALUES($1,1,'published','{}',CURRENT_TIMESTAMP,$2,$3)",[source.sourceId,task.taskId,designer]);await pre.query('COMMIT');}catch(e){await pre.query('ROLLBACK');throw e;}finally{pre.release();}
   const id=await order(source.sourceId,(await quotes.read(actor(),resource)).designStyleNo);
   const db=await database.connect();try{await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");await ensureQuotationBudget(db,id,designer);await ensureQuotationBudget(db,id,designer);await db.query('COMMIT');}finally{db.release();}
   expect((await budget.read(owner(),id)).version).toBe(1);expect((await quotes.read(actor(),resource)).budget.state).toBe('created');
 });
 it('freezes quote snapshots, detects confirmed revisions, and explicitly adopts without overwriting the published budget',async()=>{
   const id=await order(),resource={kind:'order' as const,id},ready=await readyQuote(resource);await quotes.confirm(actor(),resource,confirmation(ready.sheet.version),randomUUID());
   await budget.publish(owner(),id,1,randomUUID(),ready.sheet.version);
   let next=await quotes.fillRow(actor(tech,['pattern_room_worker']),resource,ready.rowId,{expectedVersion:ready.sheet.version,consumption:'0.9'},randomUUID());
   next=await quotes.confirm(actor(),resource,confirmation(next.version,'21'),randomUUID());const current=await budget.read(owner(),id);
   expect(current).toMatchObject({version:1,status:'published',canAdoptQuotation:true,canSubmitSourcing:false});
   expect(current.comparison?.state).toBe('review_required');
   const adopted=await budget.adoptQuotation(owner(),id,{expectedVersion:1,sourceQuoteVersion:next.version},randomUUID());expect(adopted).toMatchObject({status:'draft',version:2,document:{rows:[{consumption:'1'}]}});
   expect((await database.query('SELECT document FROM digital_budget_versions WHERE production_order_id=$1 AND version=1',[id])).rows[0].document.rows[0].consumption).toBe('1');
   await expect(database.query("UPDATE digital_quotation_versions SET confirmation='{}' WHERE quote_id=$1",[next.quoteId])).rejects.toMatchObject({code:'55000'});
   expect((await quotes.read(actor(),resource,undefined,ready.sheet.version)).confirmation?.customerConfirmedTotal).toBe('20');
 });
 it('rejects tax/quantity mismatches, stale quote versions, and atomic publish vs quote confirmation races',async()=>{
   const id=await order(),resource={kind:'order' as const,id},ready=await readyQuote(resource);await quotes.confirm(actor(),resource,{...confirmation(ready.sheet.version,'100'),amountScope:'order_total',quantity:6},randomUUID());
   expect((await budget.read(owner(),id)).comparison?.state).toBe('incomparable');await expect(budget.publish(owner(),id,1,randomUUID(),ready.sheet.version)).rejects.toMatchObject({statusCode:409});
   let q=await quotes.fillRow(actor(tech,['pattern_room_worker']),resource,ready.rowId,{expectedVersion:ready.sheet.version,consumption:'1'},randomUUID());
   await quotes.confirm(actor(),resource,{...confirmation(q.version),taxBasis:'includes_tax'},randomUUID());let b=await budget.adoptQuotation(owner(),id,{expectedVersion:1,sourceQuoteVersion:q.version},randomUUID());expect(b.comparison?.state).toBe('incomparable');
   q=await quotes.fillRow(actor(tech,['pattern_room_worker']),resource,ready.rowId,{expectedVersion:q.version,consumption:'1'},randomUUID());await quotes.confirm(actor(),resource,confirmation(q.version),randomUUID());b=await budget.adoptQuotation(owner(),id,{expectedVersion:b.version,sourceQuoteVersion:q.version},randomUUID());
   await expect(budget.publish(owner(),id,b.version,randomUUID(),q.version-1)).rejects.toMatchObject({statusCode:409});
   const revision=await quotes.fillRow(actor(tech,['pattern_room_worker']),resource,ready.rowId,{expectedVersion:q.version,consumption:'1'},randomUUID());
   const results=await Promise.allSettled([budget.publish(owner(),id,b.version,randomUUID(),q.version),quotes.confirm(actor(),resource,confirmation(revision.version,'30'),randomUUID())]);
   expect(results[1]!.status).toBe('fulfilled');if(results[0]!.status==='rejected')expect(results[0]!.reason).toMatchObject({statusCode:409});
   const after=await budget.read(owner(),id);expect(after.canSubmitSourcing).toBe(false);
 });
 it('does not replay cached full-cost bodies after reassignment or revoked employment',async()=>{
   const id=await order(),resource={kind:'order' as const,id},ready=await readyQuote(resource),key=randomUUID(),input={expectedVersion:ready.sheet.version,consumption:'2'};
   await quotes.fillRow(actor(tech,['pattern_room_worker']),resource,ready.rowId,input,key);
   await database.query("UPDATE identity_mappings SET employed=false WHERE user_id=$1",[tech]);
   try{await expect(quotes.fillRow(actor(tech,['pattern_room_worker']),resource,ready.rowId,input,key)).rejects.toMatchObject({statusCode:404});expect((await quotes.list(actor(tech,['pattern_room_worker']))).items).toEqual([]);}finally{await database.query('UPDATE identity_mappings SET employed=true WHERE user_id=$1',[tech]);}
 });
 it('freezes the actual customer and contributors and rejects cross-order database references',async()=>{
   const id=await order(),resource={kind:'order' as const,id},ready=await readyQuote(resource,true);
   await expect(quotes.confirm(actor(),resource,{...confirmation(ready.sheet.version),customerCode:'PI'},randomUUID())).rejects.toMatchObject({statusCode:409});
   await quotes.confirm(actor(),resource,confirmation(ready.sheet.version),randomUUID());
   const stored=(await database.query('SELECT * FROM digital_quotation_versions WHERE quote_id=$1 AND version=$2',[ready.sheet.quoteId,ready.sheet.version])).rows[0];
   expect(stored.customer_code).toBe('PD');expect(stored.consumption_sources[ready.rowId].actorId).toBe(tech);expect(stored.price_sources[ready.rowId].actorId).toBe(ie);
   await expect(database.query('INSERT INTO digital_budget_quote_conversions(production_order_id,quote_id,quote_version,created_budget_version) VALUES($1,$2,$3,1)',[await order(),ready.sheet.quoteId,ready.sheet.version])).rejects.toMatchObject({code:'23503'});
 });
 it('enforces scoped row authorization through HTTP, strict source identity and idempotency headers',async()=>{
   const id=await order(),resource={kind:'order' as const,id},ready=await readyQuote(resource),app=Fastify();
   app.setErrorHandler((error,_request,reply)=>{const e=error as ApplicationError;void reply.code(e.statusCode??500).send({code:e.code,message:e.message});});
   registerQuotationRoutes(app,{service:identity,creationEnabled:true,authenticate:async token=>{if(!token)throw new ApplicationError('UNAUTHORIZED','请登录',401);return {id:tech,displayName:'TEST 技术',businessRoles:['pattern_room_worker'],capabilities:[]};}},quotes);await app.ready();
   try{const base=`/digital-production/orders/${id}/quotation`,headers={cookie:'dx_rework_session=TEST'};
    expect((await app.inject({method:'GET',url:base})).statusCode).toBe(401);
    expect((await app.inject({method:'GET',url:base,headers})).json().document).toBeNull();
    expect((await app.inject({method:'POST',url:base+`/rows/${ready.rowId}`,headers:{...headers,'idempotency-key':randomUUID()},payload:{expectedVersion:ready.sheet.version,unitPrice:'0'}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:base+`/rows/${ready.rowId}`,headers,payload:{expectedVersion:ready.sheet.version,consumption:'2'}})).statusCode).toBe(409);
   }finally{await app.close();}
 });
});
