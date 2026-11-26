import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {BudgetWashingFeeService} from '../../apps/api/src/production-platform/budget-washing-fees.js';
import {DigitalBudgetService} from '../../apps/api/src/production-platform/budget-service.js';
import {BulkWashingService} from '../../apps/api/src/production-platform/bulk-washing-service.js';
import {DigitalQuotationService} from '../../apps/api/src/production-platform/quotation-service.js';
import {QuotationConfirmationSchema} from '@dx-rework/contracts/digital-quotation';
import {adoptBulkWashingWithClient} from '../../apps/api/src/production-platform/bulk-washing-repository.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {GarmentQualityService,garmentQuality} from '../../apps/api/src/production-platform/garment-quality.js';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {r5RoleFixture} from '../helpers/r5-role-fixture.js';
import {CustomerMerchandiserDefaultsService} from '../../apps/api/src/production-platform/customer-merchandiser-defaults.js';
import type {BudgetRow,BudgetWashingFeeInput} from '@dx-rework/contracts/digital-budget';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('original budget washing-only supplements',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,service:BudgetWashingFeeService,budgets:DigitalBudgetService;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);service=new BudgetWashingFeeService(f.db);budgets=new DigitalBudgetService(f.db,true);});
 afterAll(async()=>{await f?.dispose();});
 const setup=async(rows:BudgetRow[]=[])=>{
  const ready=await f.bulkReady('无',undefined,1,undefined,{quantity:4,budgetRows:rows}),orderId=ready.id;
  const lineId=(await f.db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1',[orderId])).rows[0].line_id;
  const duration={minutes:60,calendar:'continuous' as const,reminder:{enabled:true,percent:70}},db=await f.db.connect();
  try{await db.query('BEGIN');await adoptBulkWashingWithClient(db,f.root,orderId,lineId,0,{arrangement:{mode:'after_receipt',reference:'TEST original adopted time',revision:1,accounting:'additional',washing:duration,inspection:duration},staff:{logisticsId:f.people['embroidery-washing-merchandiser']!.actorId,inspectorId:f.people.qc!.actorId},fee:{kind:'pending'},sourceRef:'TEST adopted washing'});await db.query('COMMIT');}finally{db.release();}
  const input:BudgetWashingFeeInput={expectedVersion:2,lineId,expectedWashingVersion:1,reason:'TEST 原预算无洗水行，真实补录',source:{kind:'new',row:{name:'大货洗水',specification:'',unit:'件',supplier:'TEST wash',consumption:'1',unitPrice:'2'}}};
  return {ready,orderId,lineId,input,primary:f.people.merchandiser!};
 };
 it('publishes a narrow new version and links it without rewriting original budget, quote, contract or started wash clocks',async()=>{
  const x=await setup(),{orderId,ready,primary}=x;
  const old=(await f.db.query('SELECT * FROM digital_budget_versions WHERE production_order_id=$1 AND version=2',[orderId])).rows[0];
  const originalCompletion=(await f.db.query('SELECT published_at FROM digital_budget_documents WHERE production_order_id=$1',[orderId])).rows[0];
  const sourcing=(await f.db.query('SELECT to_jsonb(c) AS body FROM sourcing_cases c WHERE sourcing_case_id=$1',[ready.caseId])).rows;
  const preparation=(await f.db.query('SELECT * FROM digital_budget_preparations WHERE production_order_id=$1',[orderId])).rows;
  const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0].cutting_order_id;
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await ready.cutting.record(cutter,cut,{pieceCount:1,actualCutCount:4,attachmentIds:[await f.image(cutter)]},randomUUID());
  const warehouse={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
  await new ReceivingService(f.db).create(warehouse,{cuttingOrderId:cut,documentQuantity:4,actualQuantity:4,attachmentIds:[await f.image(warehouse)]},randomUUID());
  const receipt=(await garmentQuality(f.db,orderId))[0]!;await new GarmentQualityService(f.db).record(f.root,orderId,{receiptId:receipt.receiptId,quantityVersion:receipt.quantityVersion,qualifiedQuantity:4,occurredAt:new Date().toISOString(),problem:''},randomUUID());
  const washing=new BulkWashingService(f.db),scope=(await washing.read(f.root,orderId)).scopes[0]!;
  await washing.record(f.people['embroidery-washing-merchandiser']!,orderId,{kind:'send',planId:scope.planId,scopeId:scope.scopeId,quantityVersion:scope.quantityVersion,expectedRevision:0,quantity:1,occurredAt:new Date().toISOString(),note:'TEST original actual wash'},randomUUID());
  const before=(await washing.read(f.root,orderId)).scopes[0]!,key=randomUUID(),result=await service.publish(primary,orderId,x.input,key);
  expect(result).toMatchObject({budgetVersion:3,lines:[{version:2,fee:{kind:'budget_row',version:3}}],history:[{baseVersion:2,version:3,action:'new'}]});
  expect(await service.publish(primary,orderId,x.input,key)).toEqual(result);
  expect((await f.db.query('SELECT * FROM digital_budget_versions WHERE production_order_id=$1 AND version=2',[orderId])).rows[0]).toEqual(old);
  expect((await f.db.query('SELECT published_at FROM digital_budget_documents WHERE production_order_id=$1',[orderId])).rows[0]).toEqual(originalCompletion);
  expect((await f.db.query('SELECT to_jsonb(c) AS body FROM sourcing_cases c WHERE sourcing_case_id=$1',[ready.caseId])).rows).toEqual(sourcing);
  expect((await f.db.query('SELECT * FROM digital_budget_preparations WHERE production_order_id=$1',[orderId])).rows).toEqual(preparation);
  const after=(await washing.read(f.root,orderId)).scopes[0]!;expect(after.windows).toEqual(before.windows);expect(after.planId).toBe(before.planId);expect(after.fee).toMatchObject({state:'referenced',version:3,unitPrice:'2',consumption:'1'});
  expect((await budgets.read(primary,orderId))).toMatchObject({version:3,canEdit:false,canPublish:false,totals:{cost:'7'}});
  await expect(budgets.save(primary,orderId,{expectedVersion:3,document:{...old.document,cm:'0'}},randomUUID())).rejects.toMatchObject({statusCode:409});
  const ref=result.lines[0]!.fee;if(ref.kind!=='budget_row')throw Error('Missing immutable fee reference');
  const adjusted=await service.publish(primary,orderId,{...x.input,expectedVersion:3,expectedWashingVersion:2,source:{kind:'adjust',rowId:ref.rowId,row:{name:'大货洗水',unit:'件',specification:'',supplier:'TEST wash',consumption:'1',unitPrice:'0'}}},randomUUID());
  expect(adjusted.budgetVersion).toBe(4);expect((await budgets.read(primary,orderId)).totals?.cost).toBe('5');
  expect((await budgets.read(primary,orderId,undefined,3)).totals?.cost).toBe('7');expect((await washing.read(f.root,orderId)).scopes[0]!.fee?.unitPrice).toBe('0');
 });
 it('advances an unlinked sourcing preparation through new and adjusted fees while retaining its task, timestamp and stale-command protection',async()=>{
  let preparationTask:string|undefined;
  const ready=await f.bulkReady('无',async(input,_key,primary)=>{
   const orderId=input.digitalBudget!.productionOrderId,lineId=input.lineItems[0]!.lineId!;
   const original=(await f.db.query('SELECT p.*,d.published_at FROM digital_budget_preparations p JOIN digital_budget_documents d USING(production_order_id) WHERE production_order_id=$1',[orderId])).rows[0];
   preparationTask=original.task_id;expect(original.budget_version).toBe(2);
   const duration={minutes:60,calendar:'continuous' as const,reminder:{enabled:true,percent:70}},db=await f.db.connect();
   try{await db.query('BEGIN');await adoptBulkWashingWithClient(db,f.root,orderId,lineId,0,{arrangement:{mode:'after_receipt',reference:'TEST before sourcing',revision:1,accounting:'additional',washing:duration,inspection:duration},staff:{logisticsId:f.people['embroidery-washing-merchandiser']!.actorId,inspectorId:f.people.qc!.actorId},fee:{kind:'pending'},sourceRef:'TEST before sourcing'});await db.query('COMMIT');}finally{db.release();}
   const supplement:BudgetWashingFeeInput={expectedVersion:2,lineId,expectedWashingVersion:1,reason:'TEST washing fee before sourcing',source:{kind:'new',row:{name:'大货洗水',specification:'',unit:'件',supplier:'TEST wash',consumption:'1',unitPrice:'2'}}};
   const result=await service.publish(primary,orderId,supplement,randomUUID());expect(result.budgetVersion).toBe(3);
   const prepared=await budgets.prepareSourcing(primary,orderId,3,f.attachments);
   expect(prepared.budgetVersion).toBe(3);expect(prepared.budgetRows.some(row=>row.category==='洗水'&&row.unitPrice==='2')).toBe(true);
   await expect(budgets.prepareSourcing(primary,orderId,2,f.attachments)).rejects.toMatchObject({code:'BUDGET_CONFLICT'});
   const ref=result.lines[0]!.fee;if(ref.kind!=='budget_row')throw Error('Missing fee basis');
   const adjusted=await service.publish(primary,orderId,{...supplement,expectedVersion:3,expectedWashingVersion:2,source:{kind:'adjust',rowId:ref.rowId,row:{name:'大货洗水',specification:'',unit:'件',supplier:'TEST wash',consumption:'1',unitPrice:'1'}}},randomUUID());expect(adjusted.budgetVersion).toBe(4);
   const current=(await f.db.query('SELECT p.*,d.published_at FROM digital_budget_preparations p JOIN digital_budget_documents d USING(production_order_id) WHERE production_order_id=$1',[orderId])).rows[0];
   expect(current).toEqual({...original,budget_version:4});
   const stale={...input,attachmentIds:prepared.images.map(image=>image.attachmentId),digitalBudget:{productionOrderId:orderId,budgetVersion:3,orderVersion:prepared.orderVersion}};
   await expect(f.sourcing.createCase(primary,stale,randomUUID())).rejects.toMatchObject({code:'BUDGET_CONFLICT'});
   const latest=await budgets.prepareSourcing(primary,orderId,4,f.attachments);
   input.attachmentIds=latest.images.map(image=>image.attachmentId);
   input.digitalBudget={productionOrderId:orderId,budgetVersion:latest.budgetVersion,orderVersion:latest.orderVersion};
  });
  expect(ready.caseId).toBeTruthy();expect(ready.input.digitalBudget?.budgetVersion).toBe(4);
  expect((await f.db.query('SELECT budget_version,task_id FROM digital_budget_preparations WHERE production_order_id=$1',[ready.id])).rows[0]).toEqual({budget_version:4,task_id:preparationTask});
  expect((await f.db.query('SELECT state FROM digital_production_tasks WHERE task_id=$1',[preparationTask])).rows[0].state).toBe('completed');
 });
 it('keeps original adopted quote basis when a newer quote exists and retains ordinary publication guards',async()=>{
  const x=await setup(),quote=new DigitalQuotationService(f.db,true),resource={kind:'order' as const,id:x.orderId};
  const before=await quote.read(f.root,resource),oldBudget=(await f.db.query('SELECT * FROM digital_budget_versions WHERE production_order_id=$1 AND version=2',[x.orderId])).rows[0];
  const saved=await quote.save(f.root,resource,{expectedVersion:before.version,document:{...before.document!,freight:'1'},assignments:before.assignments},randomUUID());
  const confirmation=QuotationConfirmationSchema.parse({...before.confirmation!,expectedVersion:saved.version,customerConfirmedTotal:'200000',
   workbenchPricing:{field:'customerUnitPrice',value:'200000'},evidenceNote:'TEST later quote remains unadopted',confirmedAt:new Date().toISOString()});
  await expect(quote.confirm(f.root,resource,confirmation,randomUUID())).rejects.toMatchObject({statusCode:403});
  await quote.confirm(f.people['sample-designer']!,resource,confirmation,randomUUID());
  await expect(service.publish(x.primary,x.orderId,{...x.input,source:{kind:'new',row:{name:'wash',unit:'件',specification:'',supplier:'TEST',consumption:'1',unitPrice:'100001'}}},randomUUID())).rejects.toMatchObject({statusCode:409});
  const published=await service.publish(x.primary,x.orderId,x.input,randomUUID());expect(published.budgetVersion).toBe(3);
  const row=(await f.db.query('SELECT * FROM digital_budget_versions WHERE production_order_id=$1 AND version=3',[x.orderId])).rows[0];expect(row.quote_version).toBe(oldBudget.quote_version);expect(row.confirmed_quote_total).toBe(oldBudget.confirmed_quote_total);
  await expect(f.db.query(`INSERT INTO digital_budget_versions(production_order_id,version,document,totals,published_by,quote_id,quote_version,budget_comparable_total,confirmed_quote_total) VALUES($1,4,$2,$3,$4,$5,$6,$7,$8)`,[x.orderId,row.document,row.totals,f.root.actorId,row.quote_id,row.quote_version,row.budget_comparable_total,row.confirmed_quote_total])).rejects.toMatchObject({code:'23514'});
  await expect(f.db.query(`INSERT INTO digital_budget_versions(production_order_id,version,document,totals,published_by,quote_id,quote_version,budget_comparable_total,confirmed_quote_total,washing_supplement) VALUES($1,4,$2,$3,$4,$5,$6,$7,$8,$9)`,[x.orderId,{...row.document,cm:'0'},row.totals,f.root.actorId,row.quote_id,row.quote_version,row.budget_comparable_total,row.confirmed_quote_total,{...row.washing_supplement,baseVersion:3}])).rejects.toMatchObject({code:'23514'});
  expect((await quote.read(f.root,resource)).confirmedVersion).toBe(saved.version);expect((await budgets.read(x.primary,x.orderId,undefined,2)).totals?.cost).toBe('5');
 });
 it('serializes competing supplements, keeps exact retry and denies unrelated, designer and revoked publishers',async()=>{
  const primary=await r5RoleFixture(f.db,f.access,{...f.root,requestId:randomUUID()},'order_merchandiser'),defaults=new CustomerMerchandiserDefaultsService(f.db);
  const original=(await defaults.selected(f.root,{codes:['PD']})).items[0]!;
  await defaults.save(f.root,{customers:[{code:'PD',expectedVersion:original.version}],primaryMerchandiserId:primary.actor.actorId,secondaryMerchandiserIds:[],mode:'replace'},randomUUID());
  expect(primary.actor.authorizationCapabilities).toContain('sourcing:inquiry:create');
  const ready=await(async()=>{try{return await f.bulkReady('无',undefined,1,undefined,{quantity:4,primaryActor:{...primary.actor,authorizationCapability:'sourcing:inquiry:create'}});}finally{
   const current=(await defaults.selected(f.root,{codes:['PD']})).items[0]!;
   await defaults.save(f.root,{customers:[{code:'PD',expectedVersion:current.version}],primaryMerchandiserId:original.primary!.id,secondaryMerchandiserIds:original.secondary.map(person=>person.id),mode:'replace'},randomUUID());
  }})();
  const lineId=ready.input.lineItems[0]!.lineId!,db=await f.db.connect(),duration={minutes:60,calendar:'continuous' as const,reminder:{enabled:true,percent:70}};
  try{await db.query('BEGIN');await adoptBulkWashingWithClient(db,f.root,ready.id,lineId,0,{arrangement:{mode:'after_receipt',accounting:'additional',reference:'TEST',revision:1,washing:duration,inspection:duration},staff:{logisticsId:f.people['embroidery-washing-merchandiser']!.actorId,inspectorId:f.people.qc!.actorId},fee:{kind:'pending'},sourceRef:'TEST'});await db.query('COMMIT');}finally{db.release();}
  const input:BudgetWashingFeeInput={expectedVersion:2,lineId,expectedWashingVersion:1,reason:'TEST parallel narrow fee',source:{kind:'new',row:{name:'wash',unit:'件',specification:'',supplier:'TEST',consumption:'1',unitPrice:'0'}}};
  await expect(service.publish(f.people['sample-designer']!,ready.id,input,randomUUID())).rejects.toMatchObject({statusCode:403});
  await expect(service.read(f.people['embroidery-washing-merchandiser']!,ready.id)).rejects.toMatchObject({statusCode:404});
  const key=randomUUID(),results=await Promise.allSettled([service.publish(primary.actor,ready.id,input,key),service.publish(primary.actor,ready.id,input,randomUUID())]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  if(results[0]?.status==='fulfilled')expect(await service.publish(primary.actor,ready.id,input,key)).toEqual(results[0].value);
  const state=await service.read(primary.actor,ready.id);expect(state.budgetVersion).toBe(3);expect(state.history).toHaveLength(1);
  await expect(service.publish(primary.actor,ready.id,{...input,expectedVersion:3,lineId:randomUUID()},randomUUID())).rejects.toMatchObject({statusCode:409});
  await f.access.revokeRole({...f.root,requestId:randomUUID()},primary.assignmentId,'TEST revoke original fee publisher');
  await expect(service.publish(primary.actor,ready.id,input,key)).rejects.toMatchObject({statusCode:404});
 });
 it('links a real published existing fee once without creating another cost version or borrowing a foreign row',async()=>{
  const row:BudgetRow={rowId:randomUUID(),section:'外发工序',category:'洗水',name:'已有大货洗水',specification:'',unit:'件',supplier:'TEST',consumption:'1',unitPrice:'2'},x=await setup([row]);
  await expect(service.publish(x.primary,x.orderId,{...x.input,source:{kind:'existing',version:2,rowId:randomUUID()}},randomUUID())).rejects.toMatchObject({statusCode:409});
  const result=await service.publish(x.primary,x.orderId,{...x.input,source:{kind:'existing',version:2,rowId:row.rowId}},randomUUID());
  expect(result).toMatchObject({budgetVersion:2,lines:[{version:2,fee:{kind:'budget_row',version:2,rowId:row.rowId}}]});
  expect((await budgets.read(x.primary,x.orderId)).totals?.cost).toBe('7');expect((await f.db.query('SELECT version FROM digital_budget_versions WHERE production_order_id=$1',[x.orderId])).rows).toEqual([{version:2}]);
 });
});
