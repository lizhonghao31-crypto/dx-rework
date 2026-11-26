import {assignedWarehousePreparationResources} from '../../apps/api/src/production-platform/warehouse-assigned-resources.js';
import {readWarehouseFactoryDispatchScopes} from '../../apps/api/src/production-platform/warehouse-factory-dispatch-evidence.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {orderTimeCreated} from '../../apps/api/src/production-platform/order-time-created.js';
import {OrderTimePlanRepository} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {materialInvestmentRiskHistory} from '../../apps/api/src/production-platform/material-investment-risk-history.js';
import {DigitalProductionNotificationService} from '../../apps/api/src/production-platform/notification-service.js';
import {orderTimeNativeExecutor} from '../../apps/api/src/production-platform/order-time-native-commands.js';
import {OrderTimeRequestService} from '../../apps/api/src/production-platform/order-time-request-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {PatternRoomPriceService} from '../../apps/api/src/pattern-room/price-service.js';
import {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {prepareRewashSettings} from '../helpers/order-time-rewash-fixture.js';
import {DigitalProductionAccessPolicy} from '../../apps/api/src/production-platform/access-policy.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {DevelopmentWorkspaceQuery} from '../../apps/api/src/production-platform/development-workspace-query.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {registerDigitalIdentityRoutes} from '../../apps/api/src/production-platform/identity-routes.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import {registerBulkPreparationRoutes} from '../../apps/api/src/production-platform/bulk-preparation-routes.js';
import {nodeMaterialsFixture,nodeMaterialsFootprint} from '../helpers/node-materials-fixture.js';
import {registerOrderClosureRoutes} from '../../apps/api/src/production-platform/order-closure-routes.js';
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {nativeTaskReadiness,nativeCuttingReadiness} from '../../apps/api/src/production-platform/task-readiness-facts.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {journeyFactFingerprint} from '../../apps/api/src/production-platform/journey-fact-model.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {DevelopmentTechnicalService} from '../../apps/api/src/production-platform/development-technical-service.js';
import {SlaOrderApplicationService} from '../../apps/api/src/production-platform/sla-order-application.js';
import {SlaConfigurationService} from '../../apps/api/src/production-platform/sla-configuration-service.js';
import {SlaConfigurationRepository} from '../../apps/api/src/production-platform/sla-configuration-repository.js';
import {historicalDigitalOrder} from '../helpers/historical-digital-order-fixture.js';
import {SlaOrderService} from '../../apps/api/src/production-platform/sla-order-service.js';
import {SlaCalculationService} from '../../apps/api/src/production-platform/sla-calculation-service.js';
import Fastify from 'fastify';
import {AuthService} from '../../apps/api/src/auth/service.js';
import {PostgresAuthStore} from '../../apps/api/src/auth/postgres-store.js';
import {AcceptanceDingTalkProvider,mintAcceptanceLoginCode} from '../../apps/api/src/auth/acceptance-provider.js';
import {mintAcceptanceControlCode} from '../../apps/api/src/auth/acceptance-control.js';
import {registerAcceptanceClockRoutes} from '../../apps/api/src/acceptance-clock/routes.js';
import {registerTodoRoutes} from '../../apps/api/src/todos/routes.js';
import sharp from 'sharp';
import {createHash,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {writeFile} from 'node:fs/promises';
import {ApplicationError} from '../../apps/api/src/platform/errors.js';
import {registerProductionReadinessRoutes} from '../../apps/api/src/production-platform/production-readiness-routes.js';
import {registerInstructionRoutes} from '../../apps/api/src/production-platform/production-instruction-routes.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {readCockpitInstructionActions,readCockpitMaterialActions,readCockpitMaterialSupplements} from '../../apps/api/src/production-platform/cockpit-actionable.js';
import {materialInvestmentTodos,preparationWindowTodos,preparationMaterialsTodos,preparationSupplement} from '../../apps/api/src/production-platform/preparation-todos.js';
import {completeBulkRangeFixture} from '../helpers/production-readiness-fixture.js';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {r5RoleFixture} from '../helpers/r5-role-fixture.js';
import {confirmedTechnicalFixture} from '../helpers/development-technical-fixture.js';
import {warehouseOriginalIssueFixture} from '../helpers/warehouse-original-issue-fixture.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {ProductionReadinessService} from '../../apps/api/src/production-platform/production-readiness-service.js';
import {DigitalQuotationService} from '../../apps/api/src/production-platform/quotation-service.js';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import {readSeriesPlanFacts} from '../../apps/api/src/production-platform/series-plan-facts.js';
import {productionReadiness,styleLabelCuttingReason} from '../../apps/api/src/production-platform/production-readiness-repository.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {CreateSupplierSchema} from '@dx-rework/contracts';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {DevelopmentWorkspaceFilterSchema} from '@dx-rework/contracts/digital-development-workspace';
import {DigitalOrderCreateSchema,InitialCustomerOrderDraftSchema,beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {initialInstruction} from '@dx-rework/contracts/production-instruction';
import {demandForWarehouseReceipt,readWarehouseInstructionDemands} from '../../apps/api/src/production-platform/warehouse-instruction-demand.js';
import {preparationHash,preparationInvestmentScope} from '../../apps/api/src/production-platform/preparation-material-repository.js';
import {orderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import type {PreparationMaterialKind,PreparationResource,ProductionReadinessState} from '@dx-rework/contracts/production-readiness';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('production preparation native lifecycle (TEST_DATABASE_URL isolated only)',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,identity:DigitalProductionIdentityService,forms:DigitalDevelopmentService,service:ProductionReadinessService,instruction:ProductionInstructionService,bulk:BulkPreparationService;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);identity=new DigitalProductionIdentityService(f.db,true);forms=new DigitalDevelopmentService(f.db,true);service=new ProductionReadinessService(f.db);instruction=new ProductionInstructionService(f.db,true);bulk=new BulkPreparationService(f.db);});
 afterAll(async()=>{await f?.dispose();});
 // Pure template construction must not publish an unrelated source for draft tests.
 const documentFixture=(photo:string,{available=true}={})=>DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:null,interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'',sizes:['M'],measurements:[{name:'胸围',values:['48']}],unit:'cm',craft:'无',washing:'免洗',materials:[{materialId:randomUUID(),category:'主布',label:'主布',supplier:'TEST',name:'TEST棉布',width:'150',weight:'200',composition:'棉',consumption:'1',color:'黑',specification:'TEST',quantity:'1',requiredThisRound:true,available,expectedDate:null}],files:[{attachmentId:photo,kind:'款图'}]});
 const preorderFabricSupplier=async(supplierCode:string)=>{
  const supplier='TEST 面料供应商 '+supplierCode;
  const supplierReference=await f.access.createSupplier(f.root,CreateSupplierSchema.parse({
   supplierCode,supplierName:supplier,supplierType:'fabric',changeReason:'TEST 预下单采用有效供应商目录',
  }));
  return {supplier,supplierReference};
 };
 const setup=async()=>{
  const designer=f.people['sample-designer']!,primary=f.people.merchandiser!,warehouse=f.people.warehouse!,style=`TEST-P05-${randomUUID()}`,photo=await f.image(designer);
  const source=await identity.createSource(designer,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const document=documentFixture(photo);
  const saved=await forms.save(designer,source.sourceId,{expectedVersion:0,document},randomUUID());await forms.publish(designer,source.sourceId,saved.version,randomUUID());
  const resource:PreparationResource={kind:'source',id:source.sourceId};
  await service.assign(f.root,resource,{expectedVersion:0,warehouseWorkerId:warehouse.actorId,colorConfirmationWorkerId:null,colorConfirmationRole:null,reason:'TEST explicit warehouse; no extra production permissions'},randomUUID());
  const handover=await service.record(designer,resource,{kind:'design_handover',scopeRef:'whole',expectedVersion:0,state:'ready',occurredAt:businessNow().toISOString(),note:'TEST published original documents',quantities:[],evidenceIds:[photo],sourceDocumentVersion:(await forms.read(designer,source.sourceId)).version,recipientId:primary.actorId},randomUUID());
  return {designer,primary,warehouse,style,photo,sourceId:source.sourceId,resource,document,handover};
 };
 const record=async(p:Awaited<ReturnType<typeof setup>>,resource:PreparationResource,kind:PreparationMaterialKind,state:'ready'|'partial'|'unknown'='ready')=>{
  const current=await service.read(f.root,resource),prior=current.facts.find(f=>f.kind===kind&&f.scopeRef==='whole');
  return service.record(kind==='material_investment'?p.primary:p.warehouse,resource,{kind,scopeRef:'whole',expectedVersion:prior?.version??0,state,occurredAt:state==='unknown'?null:businessNow().toISOString(),note:'TEST actual native material record',quantities:kind==='material_investment'?[{lineId:null,materialId:p.document.materials[0]!.materialId,name:'TEST棉布',quantity:100,unit:'米'}]:[],evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
 };
 const order=async(p:Awaited<ReturnType<typeof setup>>)=>identity.createOrder(p.designer,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:p.style,orderDate:beijingCalendarDate(businessNow()),primaryMerchandiserId:p.primary.actorId,lines:[{formalPoNo:`TEST-${randomUUID()}`,color:'黑',customerWarehouseArrivalDate:'2027-08-15',sizes:[{size:'M',quantity:10}]}]}),randomUUID(),p.sourceId);
 it('X2 does not hand over a saved numbered preorder until it is effectively published',async()=>{
  const designer=f.people['sample-designer']!,primary=f.people.merchandiser!;
  const current=await identity.orderNumberSettings(f.root);
  await identity.saveOrderNumberSettings(f.root,{expectedVersion:current.version,...current.values,
   designers:[{userId:designer.actorId,code:'LH'}]},randomUUID());
  const {sourceId,orderNumber}=await identity.reserveNumberedDraft(designer,{developmentType:'头版',temporaryStyleNo:null,
   numbering:{kind:'preorder',customerCode:'PD',productGroup:'男装',salesYear:2027,salesSeries:'P01'}},randomUUID());
  expect(orderNumber).toBe('PDMLH2027P01-001');
  const resource={kind:'source' as const,id:sourceId},photo=await f.image(designer);
  const document=documentFixture(photo,{available:false}),supplier=await preorderFabricSupplier('TEST-PO-DRAFT-FABRIC');
  const draft=await forms.save(designer,sourceId,{expectedVersion:0,document:{...document,materials:document.materials.map(material=>({...material,...supplier})),
   quantity:null,sampleSize:'',sizes:[],sizeQuantities:[],measurements:[],customerOrderDraft:{withOrder:true,stage:'preorder',
    order:InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:orderNumber,
     primaryMerchandiserId:primary.actorId,temporaryStyleNo:null,orderDate:'',contractDeliveryDate:null,
     lines:[{color:'',poNumber:null,formalStyleNo:null,temporaryStyleNo:null,colorForeign:null,deliveryDate:null,
      sizes:[{size:'',quantity:''}]}]})}}},randomUUID());
  expect(draft).toMatchObject({status:'draft',publishedAt:null,productionOrderId:null,taskId:null});
  const handover={kind:'design_handover' as const,scopeRef:'whole',expectedVersion:0,state:'ready' as const,
   occurredAt:businessNow().toISOString(),note:'TEST draft saving is not handover',quantities:[],evidenceIds:[photo],
   sourceDocumentVersion:draft.version,recipientId:primary.actorId};
  await expect(service.record(designer,resource,handover,randomUUID())).rejects.toMatchObject({statusCode:409});
  await expect(service.authorizeAttachmentUpload(designer,resource)).rejects.toMatchObject({statusCode:409});
  const quoteRow=randomUUID();
  await expect(new DigitalQuotationService(f.db,true).save(designer,resource,{expectedVersion:0,
   document:{fabricType:'针织',productCategory:'上衣',monthSeries:'',date:null,currency:'人民币',freight:'',cm:'',salePrice:'',
    outsourcingScope:'',outsourcingUnitPrice:'',imageAttachmentIds:[],rows:[{rowId:quoteRow,section:'主料',category:'',
     name:'TEST棉布',specification:'TEST',unit:'米',supplier:'TEST',consumption:'',unitPrice:''}]},
   assignments:[{rowId:quoteRow,technicalAssigneeId:null,priceAssigneeId:designer.actorId,priceRole:'sample_designer'}]},randomUUID()))
   .rejects.toMatchObject({code:'QUOTATION_CONFLICT',statusCode:409});
  expect((await f.db.query('SELECT 1 FROM digital_quotation_documents WHERE source_id=$1',[sourceId])).rowCount).toBe(0);
  await expect(f.db.query(`INSERT INTO digital_preparation_material_versions
    (record_id,version,resource_kind,resource_id,kind,scope_ref,state,occurred_at,body,actor_id,recorded_at)
    VALUES($1,1,'source',$2,'design_handover','whole','ready',$3,$4,$5,CURRENT_TIMESTAMP)`,
  [randomUUID(),sourceId,handover.occurredAt,JSON.stringify(handover),designer.actorId])).rejects.toMatchObject({code:'23514'});
  await expect(service.read(primary,resource)).rejects.toMatchObject({statusCode:403});
  const taskClient=await f.db.connect();
  try{
   await taskClient.query('BEGIN');
   await expect(new DigitalProductionTaskService(f.db).createWithClient(taskClient,f.root,{resource,kind:'development_materials',
    routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:null})).rejects.toMatchObject({code:'23514'});
  }finally{await taskClient.query('ROLLBACK');taskClient.release();}
  expect(await service.read(designer,resource)).toMatchObject({facts:[],history:[],canRecord:[]});
  expect((await materialInvestmentTodos(f.db,primary)).some(item=>item.entityId===sourceId)).toBe(false);
  expect(await orderTimeCreated(f.db,resource)).toBeNull();
  expect(await new OrderTimePlanRepository(f.db).current(resource)).toBeNull();
  await new DigitalProductionTaskService(f.db).controlResource(designer,resource,'cancel','TEST取消未发布的预下单',randomUUID());
  await expect(forms.publishPreorder(designer,sourceId,draft.version,randomUUID())).rejects.toMatchObject({statusCode:409});
  expect((await f.db.query('SELECT 1 FROM digital_development_preorder_publications WHERE source_id=$1',[sourceId])).rowCount).toBe(0);
  expect((await f.db.query("SELECT 1 FROM audit_events WHERE entity_id=$1 AND action='digital_development_preorder_published'",[sourceId])).rowCount).toBe(0);
 });
 it('X3 reads work for an effectively published and assigned X2 preorder only after its real scoped investment, without a formal SLA',async()=>{
  const designer=f.people['sample-designer']!,primary=f.people.merchandiser!,warehouse=f.people.warehouse!;
  const settings=await identity.orderNumberSettings(f.root);
  await identity.saveOrderNumberSettings(f.root,{expectedVersion:settings.version,...settings.values,
   designers:[{userId:designer.actorId,code:'LH'}]},randomUUID());
  const {sourceId,orderNumber}=await identity.reserveNumberedDraft(designer,{developmentType:'头版',temporaryStyleNo:null,
   numbering:{kind:'preorder',customerCode:'PD',productGroup:'男装',salesYear:2028,salesSeries:'P05'}},randomUUID());
  const resource={kind:'source' as const,id:sourceId},photo=await f.image(designer);
  const document=documentFixture(photo,{available:false}),supplier=await preorderFabricSupplier('TEST-X3-PREORDER-FABRIC');
  const material={...document.materials[0]!,...supplier};
  const saved=await forms.save(designer,sourceId,{expectedVersion:0,document:{...document,materials:[material],
    quantity:null,sampleSize:'',sizes:[],sizeQuantities:[],measurements:[],customerOrderDraft:{withOrder:true,stage:'preorder',
     order:InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:orderNumber,primaryMerchandiserId:primary.actorId,
      temporaryStyleNo:null,orderDate:'',contractDeliveryDate:null,lines:[{color:'',poNumber:null,formalStyleNo:null,temporaryStyleNo:null,
       colorForeign:null,deliveryDate:null,sizes:[{size:'',quantity:''}]}]})}}},randomUUID());
  await expect(service.warehouseReceiptWork(warehouse,resource)).rejects.toMatchObject({statusCode:403});
  const published=await forms.publishPreorder(designer,sourceId,saved.version,randomUUID());
  expect(await orderTimeCreated(f.db,resource)).toBeNull();
  expect((await f.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[sourceId])).rowCount).toBe(0);
  await service.assign(f.root,resource,{expectedVersion:0,warehouseWorkerId:warehouse.actorId,colorConfirmationWorkerId:null,colorConfirmationRole:null,
   reason:'TEST original warehouse assigned after real X2 publication'},randomUUID());
  expect(await service.warehouseReceiptWork(warehouse,resource)).toEqual([]);
  const actual=businessNow().toISOString();
  const deposited=await service.record(primary,resource,{kind:'material_investment',scopeRef:'whole',expectedVersion:0,state:'partial',
    occurredAt:actual,note:'TEST real partial purchase, warehouse work originates here',quantities:[{lineId:null,materialId:material.materialId,name:material.name,quantity:20,unit:'米'}],
    evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
  const origin=deposited.facts.find(item=>item.kind==='material_investment')!;
  expect(await service.warehouseReceiptWork(warehouse,resource)).toMatchObject([{materialId:material.materialId,received:null,
    purchase:{original:{recordId:origin.recordId,version:origin.version},investedAt:actual,invested:{quantity:'20',unit:'米'}}}]);
  await expect(service.warehouseReceiptWork(primary,resource)).rejects.toMatchObject({statusCode:403});
  expect(published.version).toBe(saved.version);
  expect(await orderTimeCreated(f.db,resource)).toBeNull();
  expect(await new OrderTimePlanRepository(f.db).current(resource)).toBeNull();
  expect((await f.db.query("SELECT 1 FROM digital_preparation_material_versions WHERE resource_id=$1 AND kind='fabric_receipt'",[sourceId])).rowCount).toBe(0);
  const [original]=await service.warehouseReceiptWork(warehouse,resource);
  expect(original).toBeDefined();
  const command={kind:'fabric_receipt' as const,scopeRef:'whole',materialId:material.materialId,lineId:null,unit:'米',supplierId:original!.basis.supplierId,
   investment:original!.purchase.original,materialFingerprint:original!.basis.adoptedRef,expectedReceiptVersion:0,
   quantity:'12',occurredAt:businessNow().toISOString(),note:'TEST first physical warehouse batch',evidenceIds:[]};
  expect(command.supplierId).toBe(supplier.supplierReference.supplierId);
  await expect(service.recordWarehouseReceiptBatch(warehouse,resource,{...command,supplierId:randomUUID()},randomUUID())).rejects.toMatchObject({statusCode:409});
  const idempotencyKey=randomUUID();
  await expect(service.recordWarehouseReceiptBatch(primary,resource,command,randomUUID())).rejects.toMatchObject({statusCode:403});
  const first=await service.recordWarehouseReceiptBatch(warehouse,resource,command,idempotencyKey);
  expect(await service.recordWarehouseReceiptBatch(warehouse,resource,command,idempotencyKey)).toEqual(first);
  const recorded=first.history.find(item=>item.warehouseReceipt)!;
  expect(recorded).toMatchObject({version:1,occurredAt:command.occurredAt,warehouseReceipt:{quantity:'12'}});
  expect(first.facts.some(item=>item.kind==='fabric_receipt')).toBe(false); // new batch alone is not old quality/production clearance
  expect(await service.warehouseReceiptWork(warehouse,resource)).toMatchObject([{received:{quantity:'12',unit:'米'},
   balance:{procurementRemaining:'8',productionShortage:null}}]);
  const incoming={...command,expectedReceiptVersion:1,quantity:'5',note:'TEST another independent physical warehouse batch'};
  await service.recordWarehouseReceiptBatch(warehouse,resource,incoming,randomUUID());
  const correction={...command,expectedReceiptVersion:2,quantity:'10',replaces:{recordId:recorded.recordId,version:1},
   note:'TEST correct only the first batch original evidence'};
  await service.recordWarehouseReceiptBatch(warehouse,resource,correction,randomUUID());
  await expect(service.recordWarehouseReceiptBatch(warehouse,resource,{...correction,expectedReceiptVersion:3},randomUUID())).rejects.toMatchObject({statusCode:409});
  await expect(service.recordWarehouseReceiptBatch(warehouse,resource,{...incoming,expectedReceiptVersion:3,unit:'码'},randomUUID())).rejects.toMatchObject({statusCode:409});
  await expect(service.recordWarehouseReceiptBatch(warehouse,resource,{...incoming,expectedReceiptVersion:3,
   occurredAt:new Date(Date.parse(actual)-60000).toISOString()},randomUUID())).rejects.toMatchObject({statusCode:409});
  const after=await service.read(warehouse,resource);
  expect(after.history.filter(item=>item.kind==='fabric_receipt').map(item=>[item.version,item.warehouseReceipt?.quantity]).sort((a,b)=>Number(a[0])-Number(b[0])))
   .toEqual([[1,'12'],[2,'5'],[3,'10']]);
  expect(after.facts.some(item=>item.kind==='fabric_receipt')).toBe(false);
  expect(await service.warehouseReceiptWork(warehouse,resource)).toMatchObject([{received:{quantity:'15',unit:'米'},
   balance:{procurementRemaining:'5',productionShortage:null}}]);
  const filter={page:1,search:orderNumber!};
  const queue=await service.warehouseReceipts(warehouse,filter);
  expect(queue).toMatchObject({total:1,items:[{resource,orderNumber,materialId:material.materialId,received:{quantity:'15',unit:'米'}}]});
  expect(await service.warehouseReceipts(warehouse,{...filter,page:2})).toEqual({total:1,page:2,items:[]});
  expect(await service.warehouseReceipts(warehouse,{page:1,search:'TEST-NOT-OUR-WAREHOUSE-ORDER'})).toEqual({total:0,page:1,items:[]});
  await expect(service.warehouseReceipts(primary,filter)).rejects.toMatchObject({statusCode:403});
  const next={...incoming,expectedReceiptVersion:3,quantity:'1',note:'TEST concurrent next physical receipt'};
  const race=await Promise.allSettled([service.recordWarehouseReceiptBatch(warehouse,resource,next,randomUUID()),
   service.recordWarehouseReceiptBatch(warehouse,resource,{...next,note:'TEST simultaneous different receipt'},randomUUID())]);
  expect(race.filter(row=>row.status==='fulfilled')).toHaveLength(1);
  const rejected=race.find(row=>row.status==='rejected');
  expect(rejected&&rejected.reason).toMatchObject({statusCode:409});
  expect(await service.warehouseReceiptWork(warehouse,resource)).toMatchObject([{received:{quantity:'16',unit:'米'},
   balance:{procurementRemaining:'4',productionShortage:null}}]);
  expect(await orderTimeCreated(f.db,resource)).toBeNull();

 });
 it('X3 native warehouse list candidates follow the original active assignment, not a role or an old source assignment',async()=>{
  const p=await setup();
  expect(await assignedWarehousePreparationResources(f.db,p.warehouse)).toContainEqual(p.resource);
  await expect(assignedWarehousePreparationResources(f.db,p.primary)).rejects.toMatchObject({statusCode:403});
  const target=await order(p),formal={kind:'order' as const,id:target.productionOrderId};
  const after=await assignedWarehousePreparationResources(f.db,p.warehouse);
  expect(after).toContainEqual(formal);expect(after).not.toContainEqual(p.resource);
  const version=(await service.read(f.root,formal)).responsibility.version;
  await service.assign(f.root,formal,{expectedVersion:version,warehouseWorkerId:null,colorConfirmationWorkerId:null,colorConfirmationRole:null,
   reason:'TEST active formal assignment deliberately does not leave an obsolete source match'},randomUUID());
  expect(await assignedWarehousePreparationResources(f.db,p.warehouse)).not.toContainEqual(formal);
  expect(await assignedWarehousePreparationResources(f.db,p.warehouse)).not.toContainEqual(p.resource);
 });
 it('X3 pages and searches the exact assigned original warehouse preshrink task before paging',async()=>{
  const ready=await f.bulkReady('无',undefined,1,f.sourcing,{stopBeforeCompletion:true}),warehouse=f.people.warehouse!;
  const orders=await identity.read(f.root,ready.id),task=(await bulk.read(warehouse,ready.id)).tasks.find(item=>item.taskKind==='warehouse_preshrink')!;
  expect(task).toBeDefined();expect(task.assigneeId).toBe(warehouse.actorId);
  const originalTasks=new DigitalProductionTaskService(f.db),query={kind:'preshrink' as const,status:'open' as const,page:1,
   search:orders.lines[0]!.formalPoNo!};
  const page=await originalTasks.list(warehouse,query.page,query);
  expect(page).toMatchObject({total:1,page:1,items:[{taskId:task.taskId,orderId:ready.id,taskKind:'warehouse_preshrink',dueAt:task.dueAt}]});
  await expect(originalTasks.list(f.people.merchandiser!,query.page,query)).rejects.toMatchObject({statusCode:403});
  expect(await originalTasks.list(warehouse,2,{...query,page:2})).toMatchObject({total:1,page:2,items:[]});
  expect(await originalTasks.list(warehouse,1,{...query,search:'TEST-not-this-source'})).toMatchObject({total:0,items:[]});
  expect(await originalTasks.list(warehouse,1,{...query,status:'completed'})).toMatchObject({total:0,items:[]});
 });
 for(const external of [false,true])it(`P01 records each PO cutting gate only after its actual labels and retains earlier PO readiness (${external?'external':'internal'})`,async()=>{
  const scene=await f.scene('2026-11-09T08:00:00.000Z'),run=<T,>(action:()=>Promise<T>)=>f.runtime.run(scene,f.root,action);
  const ready=await run(async()=>{
   const ready=await f.bulkReady('无',undefined,2,f.sourcing,{stopBeforeCompletion:true,cuttingProcess:external?'outsourced':'in_house'}),resource={kind:'order' as const,id:ready.id},state=await service.read(f.root,resource),prior=state.facts.find(f=>f.kind==='style_label_ready')!;
   await service.record(f.people.warehouse!,resource,{kind:'style_label_ready',scopeRef:'whole',expectedVersion:prior.version,state:'ready',occurredAt:businessNow().toISOString(),note:'TEST first PO10/10; second PO9/10',quantities:state.lines.map((line,i)=>({lineId:line.lineId,materialId:null,name:'TEST款号唛',quantity:i?9:10,unit:'枚'})),evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
   for(const kind of ['纸样完成','唛架完成','预缩完成'] as const)await completeBulkRangeFixture(f.db,kind==='预缩完成'?f.people.warehouse!:f.people['pattern-room-worker']!,ready.id,ready.preparationId,kind);
   return {...ready,lines:state.lines};
  });
  const task=(await f.db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind=$2",[ready.id,external?'bulk_cutting_external':'bulk_cutting'])).rows[0];
  const first=await nativeCuttingReadiness(f.db,[task.task_id]);
  // This original legacy fixture has no new order-time adoption. Its external
  // whole-task policy remains unlimited; PO-native clocks are separate.
  const originalTasks=new DigitalProductionTaskService(f.db),taskRead=await run(()=>originalTasks.read(f.root,task.task_id)),taskHistory=await run(()=>originalTasks.history(f.root,task.task_id));
  expect(taskRead.slaHours).toBe(external?null:24);expect(taskHistory.revisions.at(-1)?.hasSla).toBe(!external);
  expect(first).toHaveLength(1);expect(first[0]).toMatchObject({lineId:ready.lines[0]!.lineId,firstReadyAt:'2026-11-09T08:00:00.000Z'});
  expect((await nativeTaskReadiness(f.db,[task.task_id])).get(task.task_id)?.firstReadyAt).toBeNull();
  await f.advance(scene,'2026-11-09T09:00:00.000Z');
  await run(async()=>{
   const principal=external?ready.primary:f.people['cutting-worker']!;
   const capabilities=(await f.db.query('SELECT DISTINCT capability FROM user_role_assignments a JOIN role_capabilities c USING(role_code) JOIN business_roles role USING(role_code) WHERE a.user_id=$1 AND a.revoked_at IS NULL AND role.enabled',[principal.actorId])).rows.map(row=>row.capability as string);
   const cutter={...principal,authorizationCapability:'cutting:records:create',authorizationCapabilities:capabilities};
   await ready.cutting.record(cutter,first[0]!.cuttingOrderId,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
  });
  await f.advance(scene,'2026-11-09T12:00:00.000Z');
  await run(async()=>{
   const resource={kind:'order' as const,id:ready.id},state=await service.read(f.root,resource),prior=state.facts.find(f=>f.kind==='style_label_ready')!;
   await service.record(f.people.warehouse!,resource,{kind:'style_label_ready',scopeRef:'whole',expectedVersion:prior.version,state:'ready',occurredAt:businessNow().toISOString(),note:'TEST second PO physical labels now10/10',quantities:state.lines.map(line=>({lineId:line.lineId,materialId:null,name:'TEST款号唛',quantity:10,unit:'枚'})),evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
  });
  const final=await nativeCuttingReadiness(f.db,[task.task_id]);
  expect(final).toHaveLength(2);expect(final.find(f=>f.lineId===ready.lines[0]!.lineId)).toEqual(first[0]);
  expect(final.find(f=>f.lineId===ready.lines[1]!.lineId)?.firstReadyAt).toBe('2026-11-09T12:00:00.000Z');
  expect((await nativeTaskReadiness(f.db,[task.task_id])).get(task.task_id)?.firstReadyAt).toBe('2026-11-09T12:00:00.000Z');
  const joined=await run(()=>new DigitalJourneyQuery(f.db).read(f.root,ready.id,undefined,true));
  expect(joined.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='cutting_gate'&&node.current)).toMatchObject({actualAt:'2026-11-09T12:00:00.000Z',actualQuality:'verified',enteredAt:null});
  await run(()=>new DigitalJourneyQuery(f.db).read(f.root,ready.id,undefined,true));
  expect(await nativeCuttingReadiness(f.db,[task.task_id])).toEqual(final);
  const model=await run(()=>new JourneyFactRepository(f.db).buildOne({kind:'order',id:ready.id}));
  expect(model.model.cuttingReadiness).toEqual(final);
  expect(model.model.nodes.find(node=>node.key==='cutting_gate'&&node.current)).toMatchObject({actualAt:'2026-11-09T12:00:00.000Z',actualQuality:'verified'});
  const stored=await run(async()=>{const db=await f.db.connect();try{return new JourneyFactRepository(f.db).readStoredWithClient(db,{kind:'order',id:ready.id});}finally{db.release();}});
  expect(stored.status).toBe('ready');
  expect(stored.model?.nodes.find(node=>node.key==='cutting_gate'&&node.current)).toMatchObject({actualAt:'2026-11-09T12:00:00.000Z',actualQuality:'verified'});
  await run(async()=>{
   const tasks=new DigitalProductionTaskService(f.db);
   await tasks.correctTime(f.root,task.task_id,{eventId:first[0]!.eventId!,occurredAt:null,reason:'TEST scoped first-ready correction must not alter sibling PO or whole-task clock'},randomUUID());
   await tasks.controlResource(f.root,{kind:'order',id:ready.id},'pause','TEST ordinary pause',randomUUID());
   await tasks.controlResource(f.root,{kind:'order',id:ready.id},'resume','TEST ordinary restore',randomUUID());
  });
  const corrected=await nativeCuttingReadiness(f.db,[task.task_id]);
  expect(corrected.find(f=>f.lineId===ready.lines[0]!.lineId)).toMatchObject({eventId:first[0]!.eventId,firstReadyAt:null,quality:'缺失'});
  expect(corrected.find(f=>f.lineId===ready.lines[1]!.lineId)).toEqual(final.find(f=>f.lineId===ready.lines[1]!.lineId));
  expect((await nativeTaskReadiness(f.db,[task.task_id])).get(task.task_id)?.firstReadyAt).toBe('2026-11-09T12:00:00.000Z');
  // The corrected PO has no credible readiness; no aggregate completion time
  // may be borrowed from the other PO or the whole-task activation clock.
  const unknown=await run(()=>new DigitalJourneyQuery(f.db).read(f.root,ready.id,undefined,true));
  expect(unknown.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='cutting_gate'&&node.current)?.actualAt).toBeNull();
  const correctedModel=await run(()=>new JourneyFactRepository(f.db).buildOne({kind:'order',id:ready.id}));
  expect(correctedModel.model.nodes.find(node=>node.key==='cutting_gate'&&node.current)?.actualAt).toBeNull();
  if(external){
   const legacy=(await f.db.query(`SELECT r.*,p.sla_seconds AS legacy_seconds FROM digital_production_deadline_revisions r JOIN digital_production_deadline_policies p ON p.node_key=r.policy_node_key AND p.version=r.policy_version WHERE r.task_id=$1 ORDER BY r.revision_id DESC LIMIT 1`,[task.task_id])).rows[0];
   expect(legacy.legacy_seconds).toBeNull();
   // Explicit historical adopted-basis fixture over the same real external
   // task. This is not a company publication or a fabricated PO readiness.
   const basis={...legacy.sla_basis,seconds:86400,enteredAt:legacy.entered_at?.toISOString()??null,basis:['TEST finite external adopted history']};
   await f.db.query(`INSERT INTO digital_production_deadline_revisions(task_id,policy_node_key,policy_version,entered_at,warning_at,due_at,reason,event_id,changed_by,sla_basis)
    VALUES($1,$2,$3,$4,$5,$6,'correction',$7,$8,$9)`,[task.task_id,legacy.policy_node_key,legacy.policy_version,legacy.entered_at,legacy.warning_at,legacy.due_at,legacy.event_id,f.root.actorId,JSON.stringify(basis)]);
   expect((await run(()=>originalTasks.read(f.root,task.task_id))).slaHours).toBe(24);
   expect((await run(()=>originalTasks.history(f.root,task.task_id))).revisions.at(-1)?.hasSla).toBe(true);
   expect(await nativeCuttingReadiness(f.db,[task.task_id])).toEqual(corrected);
  }
 });
 for(const external of [false,true])for(const poCount of [1,2])it(`P01 records legitimate 95-of-100 actual cutting readiness without borrowing sibling quantity (${external?'external':'internal'}, ${poCount} PO)`,async()=>{
  const scene=await f.scene('2026-11-09T08:00:00.000Z'),run=<T,>(action:()=>Promise<T>)=>f.runtime.run(scene,f.root,action);
  const ready=await run(async()=>{
   const ready=await f.bulkReady('无',undefined,poCount,f.sourcing,{stopBeforeCompletion:true,quantity:100,cuttingProcess:external?'outsourced':'in_house'}),resource={kind:'order' as const,id:ready.id},state=await service.read(f.root,resource),prior=state.facts.find(f=>f.kind==='style_label_ready')!;
   await service.record(f.people.warehouse!,resource,{kind:'style_label_ready',scopeRef:'whole',expectedVersion:prior.version,state:'ready',occurredAt:businessNow().toISOString(),note:'TEST actual planned cut95; original PO100',quantities:state.lines.map(line=>({lineId:line.lineId,materialId:null,name:'TEST款号唛',quantity:95,unit:'枚'})),evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
   for(const kind of ['纸样完成','唛架完成','预缩完成'] as const)await completeBulkRangeFixture(f.db,kind==='预缩完成'?f.people.warehouse!:f.people['pattern-room-worker']!,ready.id,ready.preparationId,kind);
   return {...ready,lines:state.lines};
  });
  const task=(await f.db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind=$2",[ready.id,external?'bulk_cutting_external':'bulk_cutting'])).rows[0];
  expect(await nativeCuttingReadiness(f.db,[task.task_id])).toEqual([]);
  expect((await nativeTaskReadiness(f.db,[task.task_id])).get(task.task_id)?.firstReadyAt).toBeNull();
  const cuts=(await f.db.query("SELECT child_id FROM digital_production_child_lines WHERE production_order_id=$1 AND module='cutting' AND child_line_key='record' ORDER BY line_id",[ready.id])).rows;
  const principal=external?ready.primary:f.people['cutting-worker']!,capabilities=(await f.db.query('SELECT DISTINCT capability FROM user_role_assignments a JOIN role_capabilities c USING(role_code) JOIN business_roles role USING(role_code) WHERE a.user_id=$1 AND a.revoked_at IS NULL AND role.enabled',[principal.actorId])).rows.map(row=>row.capability as string),cutter={...principal,authorizationCapability:'cutting:records:create',authorizationCapabilities:capabilities};
  await f.advance(scene,'2026-11-09T09:00:00.000Z');
  await run(async()=>{
   const body={pieceCount:1,actualCutCount:95,attachmentIds:[await f.image(cutter)]},key=randomUUID();
   await ready.cutting.record(cutter,cuts[0]!.child_id,body,key);
   const count=await nativeCuttingReadiness(f.db,[task.task_id]);
   expect(count).toHaveLength(1);expect(count[0]).toMatchObject({cuttingOrderId:cuts[0]!.child_id,firstReadyAt:'2026-11-09T09:00:00.000Z'});
   expect(count[0]!.basis).toContain('actual-cut-quantity:95');
   expect((await nativeTaskReadiness(f.db,[task.task_id])).get(task.task_id)?.firstReadyAt).toBe(poCount===1?'2026-11-09T09:00:00.000Z':null);
   await ready.cutting.record(cutter,cuts[0]!.child_id,body,key);
   expect(await nativeCuttingReadiness(f.db,[task.task_id])).toEqual(count);
  });
  if(poCount===2){
   await f.advance(scene,'2026-11-09T12:00:00.000Z');
   await run(async()=>ready.cutting.record(cutter,cuts[1]!.child_id,{pieceCount:1,actualCutCount:95,attachmentIds:[await f.image(cutter)]},randomUUID()));
   const final=await nativeCuttingReadiness(f.db,[task.task_id]);
   expect(final).toHaveLength(2);expect(final.find(f=>f.cuttingOrderId===cuts[0]!.child_id)?.firstReadyAt).toBe('2026-11-09T09:00:00.000Z');
   expect(final.find(f=>f.cuttingOrderId===cuts[1]!.child_id)?.firstReadyAt).toBe('2026-11-09T12:00:00.000Z');
   expect((await nativeTaskReadiness(f.db,[task.task_id])).get(task.task_id)?.firstReadyAt).toBe('2026-11-09T12:00:00.000Z');
  }
  expect((await f.db.query('SELECT actual_cut_count FROM cutting_records WHERE cutting_order_id=ANY($1::uuid[])',[cuts.map(cut=>cut.child_id)])).rows.map(row=>Number(row.actual_cut_count))).toEqual(Array(poCount).fill(95));
 });
 it('P01 cutting readiness waits for actual technical test evidence and records its native update',async()=>{
  const scene=await f.scene('2026-11-09T08:00:00.000Z'),run=<T,>(action:()=>Promise<T>)=>f.runtime.run(scene,f.root,action),technical=new DevelopmentTechnicalService(f.db,true);
  const ready=await run(async()=>{
   const ready=await f.bulkReady('无',undefined,1,f.sourcing,{stopBeforeCompletion:true});
   await completeBulkRangeFixture(f.db,f.people.warehouse!,ready.id,ready.preparationId,'预缩完成');
   const state=await technical.read(f.root,ready.sourceId),material=state.materialDecisions[0]!;
   await technical.saveMaterialDecision(f.root,ready.sourceId,{roundNumber:1,materialId:material.materialId,expectedVersion:material.version,highTemperatureRequired:null,preshrinkMethod:material.preshrinkMethod,basis:'TEST actual applicability not yet determined',supplierEvidenceIds:[],warpShrinkPercent:null,weftShrinkPercent:null},randomUUID());
   for(const kind of ['纸样完成','唛架完成'] as const)await completeBulkRangeFixture(f.db,f.people['pattern-room-worker']!,ready.id,ready.preparationId,kind);
   return {...ready,material};
  });
  const task=(await f.db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind='bulk_cutting'",[ready.id])).rows[0];
  expect(await nativeCuttingReadiness(f.db,[task.task_id])).toEqual([]);
  expect((await nativeTaskReadiness(f.db,[task.task_id])).get(task.task_id)?.firstReadyAt).toBeNull();
  await f.advance(scene,'2026-11-09T12:00:00.000Z');
  await run(()=>technical.saveMaterialDecision(f.root,ready.sourceId,{roundNumber:1,materialId:ready.material.materialId,expectedVersion:ready.material.version+1,highTemperatureRequired:false,preshrinkMethod:ready.material.preshrinkMethod,basis:'TEST actual technical applicability now confirmed',supplierEvidenceIds:[],warpShrinkPercent:null,weftShrinkPercent:null},randomUUID()));
  expect((await nativeCuttingReadiness(f.db,[task.task_id]))[0]?.firstReadyAt).toBe('2026-11-09T12:00:00.000Z');
 });
 it('keeps two native label receipt dates independent and refuses an old cached false completion',async()=>{
  const t1='2026-11-02T00:00:00.000Z',t2='2026-11-02T03:00:00.000Z';
  const scene=await f.scene(t1),run=<T,>(action:()=>Promise<T>)=>f.runtime.run(scene,f.root,action);
  const p=await run(setup);
  const created=await run(()=>identity.createOrder(p.designer,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:p.style,orderDate:'2026-11-02',salesYear:2026,salesSeries:'P12',requiresColorMatching:false,primaryMerchandiserId:p.primary.actorId,lines:[['蓝',35],['绿',25]].map(([color,quantity])=>({formalPoNo:`TEST-${randomUUID()}`,color,customerWarehouseArrivalDate:'2027-08-15',sizes:[{size:'M',quantity}]}))}),randomUUID(),p.sourceId));
  const resource={kind:'order' as const,id:created.productionOrderId};
  const [blue,green]=(await run(()=>service.read(p.warehouse,resource))).lines;
  const originalFile=await f.image(p.warehouse);
  const save=(expectedVersion:number,greenQty:number,key=randomUUID())=>service.record(p.warehouse,resource,{kind:'style_label_ready',scopeRef:'whole',expectedVersion,state:'ready',occurredAt:businessNow().toISOString(),note:'TEST actual label quantities',quantities:[blue!,green!].map((line,index)=>({lineId:line.lineId,materialId:null,name:'TEST款号唛',quantity:index===0?35:greenQty,unit:'枚'})),evidenceIds:expectedVersion===0?[originalFile]:[],sourceDocumentVersion:null,recipientId:null},key);
  const actual=async()=>(await readSeriesPlanFacts(f.db,resource.id,p.sourceId,'PD')).facts.filter(value=>value.key==='style_label_ready');
  const whole=async()=>(await new DigitalJourneyQuery(f.db).read(f.root,resource.id)).stages.flatMap(stage=>stage.nodes).find(node=>node.key==='series_style_label_ready');
  const byScope=(rows:Awaited<ReturnType<typeof actual>>,scope:string)=>rows.find(row=>row.scopeRef===(scope==='whole'?scope:`po:${scope}`));
  const firstKey=randomUUID();
  const [first,replay]=await run(()=>Promise.all([save(0,24,firstKey),save(0,24,firstKey)]));
  expect(replay).toEqual(first);
  await expect(run(()=>save(0,25,firstKey))).rejects.toMatchObject({statusCode:409});
  const original=first.facts.find(row=>row.kind==='style_label_ready')!;
  expect(original).toMatchObject({version:1,state:'ready',occurredAt:t1});
  expect(await styleLabelCuttingReason(f.db,resource.id,[blue!.lineId])).toBeNull();
  expect(await styleLabelCuttingReason(f.db,resource.id,[green!.lineId])).toContain('款号唛');
  const firstRead=await run(actual);
  expect.soft(byScope(firstRead,blue!.lineId)).toMatchObject({started:true,completed:true,occurredAt:t1});
  expect.soft(byScope(firstRead,green!.lineId)).toMatchObject({started:true,completed:false,occurredAt:null});
  expect.soft(byScope(firstRead,'whole')).toMatchObject({completed:false,occurredAt:null});
  expect.soft(await run(whole)).toMatchObject({state:'active',actualAt:null});
  const repo=new JourneyFactRepository(f.db),built=await run(()=>repo.buildOne(resource));
  const oldModel=structuredClone(built.model),label=oldModel.nodes.find(node=>node.key==='series_style_label_ready')!;
  expect(label).toBeDefined();label.state='completed';label.actualAt=t1;
  await f.db.query(`UPDATE digital_journey_fact_models SET calculation_version='journey-facts-material-investment-v19',payload=$2,source_fingerprint=$3 WHERE resource_kind='order' AND resource_id=$1`,[resource.id,JSON.stringify(oldModel),journeyFactFingerprint(oldModel)]);
  await run(async()=>{const db=await f.db.connect();try{
   expect.soft(await repo.readStoredWithClient(db,resource)).toMatchObject({status:'obsolete',model:null});
   const selections=await repo.readSelectionsWithClient(db,[resource],t1);
   expect.soft(selections.items.get('order:'+resource.id)).toMatchObject({status:'obsolete',facts:null});
  }finally{db.release();}});
  await f.advance(scene,t2);
  const key2=randomUUID(),beforeRollback=await nodeMaterialsFootprint(f.db);
  const dirtyBefore=(await f.db.query('SELECT * FROM digital_journey_fact_changes WHERE resource_id=$1 ORDER BY transaction_id',[resource.id])).rows;
  const failing=vi.spyOn(BulkPreparationService.prototype,'sync').mockRejectedValueOnce(new Error('TEST real transaction interrupted after label append and bridge'));
  try{await expect(run(()=>save(1,25,key2))).rejects.toThrow('TEST real transaction interrupted');}finally{failing.mockRestore();}
  expect(await nodeMaterialsFootprint(f.db)).toEqual(beforeRollback);
  expect((await f.db.query('SELECT * FROM digital_journey_fact_changes WHERE resource_id=$1 ORDER BY transaction_id',[resource.id])).rows).toEqual(dirtyBefore);
  const second=await run(()=>save(1,25,key2));
  await expect(run(()=>save(1,24))).rejects.toMatchObject({statusCode:409});
  expect(second.facts.find(row=>row.kind==='style_label_ready')).toMatchObject({recordId:original.recordId,version:2,state:'ready',occurredAt:t2});
  expect(second.history.find(row=>row.recordId===original.recordId&&row.version===1)).toEqual(original);
  const secondRead=await run(actual);
  expect.soft(byScope(secondRead,blue!.lineId)).toMatchObject({completed:true,occurredAt:t1});
  expect.soft(byScope(secondRead,green!.lineId)).toMatchObject({completed:true,occurredAt:t2});
  expect.soft(byScope(secondRead,'whole')).toMatchObject({completed:true,occurredAt:t2});
  await run(()=>repo.buildOne(resource));
  expect(await run(whole)).toMatchObject({state:'completed',actualAt:t2});
  const receiptRows=async()=> (await f.db.query(`SELECT source_version,business_completed,occurred_at FROM digital_series_source_events
   WHERE production_order_id=$1 AND source_record_id=$2 AND node_key='style_label_ready' ORDER BY source_version`,[resource.id,original.recordId])).rows;
  expect(await receiptRows()).toEqual([
   {source_version:1,business_completed:false,occurred_at:new Date(t1)},
   {source_version:2,business_completed:true,occurred_at:new Date(t2)},
  ]);

  await f.db.query("UPDATE attachments SET status='rejected',ready_at=NULL,rejection_reason='TEST T1 evidence unavailable' WHERE attachment_id=$1",[originalFile]);
  const invalidated=await run(actual);
  expect(byScope(invalidated,blue!.lineId)).toMatchObject({completed:true,occurredAt:null});
  expect(byScope(invalidated,green!.lineId)).toMatchObject({completed:true,occurredAt:t2});
  expect(byScope(invalidated,'whole')).toMatchObject({completed:true,occurredAt:null});
  expect(byScope(invalidated,'whole')?.derivation?.evidenceRevision).not.toBe(byScope(secondRead,'whole')?.derivation?.evidenceRevision);
  await run(async()=>{const db=await f.db.connect();try{
   expect(await repo.readStoredWithClient(db,resource)).toMatchObject({status:'pending',model:null});
  }finally{db.release();}});

  // Append a fixture record in the old JSON format through the same immutable table.
  await f.db.query(`INSERT INTO digital_preparation_material_versions
   (record_id,version,resource_kind,resource_id,kind,scope_ref,state,occurred_at,body,actor_id,recorded_at)
   SELECT record_id,3,resource_kind,resource_id,kind,scope_ref,state,occurred_at,
    body-'styleLabelOccurrences'-'styleLabelRequirementsBasis',actor_id,recorded_at
   FROM digital_preparation_material_versions WHERE record_id=$1 AND version=2`,[original.recordId]);
  const oldReceipt=(await run(()=>service.read(p.warehouse,resource))).facts.find(row=>row.kind==='style_label_ready')!;
  const requirementRevision=(rows:Awaited<ReturnType<typeof actual>>)=>byScope(rows,'whole')?.derivation?.requirementsRevision;
  const oldSatisfied=await run(actual);
  expect(byScope(oldSatisfied,'whole')).toMatchObject({completed:true,occurredAt:null,precision:'unknown'});
  await f.db.query('UPDATE digital_production_po_sizes SET quantity=26 WHERE line_id=$1',[green!.lineId]);
  const larger=await run(actual);
  expect(byScope(larger,'whole')).toMatchObject({completed:false,occurredAt:null});
  expect(requirementRevision(larger)).not.toBe(requirementRevision(oldSatisfied));
  expect(await styleLabelCuttingReason(f.db,resource.id,[green!.lineId])).toContain('款号唛');
  await f.db.query('UPDATE digital_production_po_sizes SET quantity=25 WHERE line_id=$1',[green!.lineId]);
  const restored=await run(actual);
  expect(byScope(restored,'whole')).toMatchObject({completed:true,occurredAt:null,precision:'unknown'});
  expect(requirementRevision(restored)).toBe(requirementRevision(oldSatisfied));
  expect((await run(()=>service.read(p.warehouse,resource))).facts.find(row=>row.kind==='style_label_ready')).toEqual(oldReceipt);
  expect(await receiptRows()).toHaveLength(2);

  await f.advance(scene,'2026-11-02T04:00:00.000Z');
  await run(()=>service.record(p.warehouse,resource,{kind:'style_label_ready',scopeRef:'whole',expectedVersion:3,state:'withdrawn',occurredAt:null,
   note:'TEST withdraw latest warehouse snapshot',quantities:[],evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID()));
  expect(byScope(await run(actual),'whole')).toMatchObject({completed:false,occurredAt:null});
  expect(await run(whole)).toMatchObject({actualAt:null});
  const replacement=await run(()=>save(4,25));
  expect(replacement.history.find(row=>row.kind==='style_label_ready'&&row.version===3)).toEqual(oldReceipt);
  expect(byScope(await run(actual),'whole')).toMatchObject({completed:true,occurredAt:'2026-11-02T04:00:00.000Z'});
  expect((await receiptRows()).map(row=>row.business_completed)).toEqual([false,true,false,true]);
 });
 it('projects real two-PO label shortages by scope and does not mutate tasks, plans, facts, reminders or windows',async()=>{
  const scene=await f.scene('2026-11-02T00:00:00Z');await f.runtime.run(scene,f.root,async()=>{
   const ready=await f.bulkReady('无',undefined,2,f.sourcing,{stopBeforeCompletion:true}),resource={kind:'order' as const,id:ready.id},state=await service.read(f.root,resource),prior=state.facts.find(r=>r.kind==='style_label_ready')!;
   expect(state.lines).toHaveLength(2);
   await service.record(f.people.warehouse!,resource,{kind:'style_label_ready',scopeRef:'whole',expectedVersion:prior.version,state:'ready',occurredAt:businessNow().toISOString(),note:'TEST A实物足量，B仅9枚；不按整单链接推断齐套',quantities:state.lines.map((line,i)=>({lineId:line.lineId,materialId:null,name:'TEST款号唛',quantity:i===0?line.orderQuantity:line.orderQuantity-1,unit:'枚'})),evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
   const before=await nodeMaterialsFootprint(f.db),projected=await nodeMaterialsFixture(f.db,f.root,ready.id,'cutting_gate');
   expect(projected.data.rows.find(r=>r.id==='style-label-'+state.lines[0]!.lineId)?.state).toBe('effective');expect(projected.data.rows.find(r=>r.id==='style-label-'+state.lines[1]!.lineId)?.state).toBe('missing');
   expect(await styleLabelCuttingReason(f.db,ready.id,[state.lines[0]!.lineId])).toBeNull();expect(await styleLabelCuttingReason(f.db,ready.id,[state.lines[1]!.lineId])).toContain('款号唛');
   await projected.query.nodeMaterials(f.root,projected.order.id,projected.node.instanceId);expect(await nodeMaterialsFootprint(f.db)).toEqual(before);
   await expect(projected.query.nodeMaterials(f.people['worker-a']!,projected.order.id,projected.node.instanceId)).rejects.toMatchObject({statusCode:403});
   await expect(projected.query.nodeMaterials(f.root,projected.order.id,'foreign:'+randomUUID())).rejects.toMatchObject({statusCode:404});
   await expect(projected.query.nodeMaterials(f.root,projected.order.id,'factory_material_count:0')).rejects.toMatchObject({statusCode:404});
   const app=Fastify();app.setErrorHandler((error,_request,reply)=>{const e=error as ApplicationError;void reply.code(e.statusCode??500).send({error:{code:e.code,message:e.message}});});
   registerDigitalIdentityRoutes(app,{service:identity,creationEnabled:false,journeys:projected.query,root:new RootAuthority(f.db,'TEST',undefined),authenticate:async token=>{if(!token)throw new ApplicationError('UNAUTHORIZED','TEST需登录',401);const roles=(await f.db.query('SELECT role_code FROM user_role_assignments WHERE user_id=$1 AND revoked_at IS NULL',[token])).rows.map(r=>r.role_code);const capabilities=(await f.db.query('SELECT DISTINCT capability FROM role_capabilities WHERE role_code=ANY($1::text[])',[roles])).rows.map(r=>r.capability);return {id:token,displayName:'TEST',businessRoles:roles,capabilities};}});
   try{const path=`/digital-production/journeys/${projected.order.id}/node-materials`,headers={cookie:`dx_rework_session=${f.root.actorId}`};
    expect((await app.inject({method:'GET',url:path+'?instanceId='+encodeURIComponent(projected.node.instanceId)})).statusCode).toBe(401);
    const ok=await app.inject({method:'GET',url:path+'?instanceId='+encodeURIComponent(projected.node.instanceId),headers});expect(ok.statusCode).toBe(200);expect(ok.headers['cache-control']).toContain('no-store');expect(ok.json().rows.find((r:{id:string})=>r.id===projected.data.rows.find(r=>r.id.startsWith('style-label-'))!.id).state).toBe('effective');
    expect((await app.inject({method:'GET',url:path+'?instanceId=foreign',headers})).statusCode).toBe(404);expect((await app.inject({method:'GET',url:path+'?instanceId=x&round=0',headers})).statusCode).toBe(400);
    expect(await nodeMaterialsFootprint(f.db)).toEqual(before);
   }finally{await app.close();}

  });
 });
 it('keeps original legal packing independent of unfinished responsibility and finance in the new projection',async()=>{
  const scene=await f.scene('2026-11-04T08:00:00Z');await f.runtime.run(scene,f.root,async()=>{
   const work=await f.reworkReady(),root={...f.root,authorizationCapability:'receiving:packing_manage',authorizationCapabilities:[...(f.root.authorizationCapabilities??[]),'receiving:packing_manage']},receiving=new ReceivingService(f.db);
   const batch=(await f.db.query('SELECT receiving_batch_id FROM receiving_receipts r JOIN digital_production_child_lines c ON c.child_id=r.receipt_id AND c.module=\'receiving\' WHERE c.production_order_id=$1',[work.ready.id])).rows[0].receiving_batch_id;
   expect((await f.db.query('SELECT status FROM rework_orders WHERE rework_order_id=$1',[work.id])).rows[0].status).not.toBe('completed');
   const row=(await receiving.board(beijingCalendarDate(businessNow()),work.ready.input.lineItems[0]!.styleNo!)).rows.find(r=>r.receivingBatchId===batch)!;expect(row).toBeDefined();
   await receiving.recordPacking(root,{receivingBatchId:batch,expectedVersion:row.version,expectedPackingRevisionId:null,packingQuantity:10},randomUUID());
   const projection=await nodeMaterialsFixture(f.db,f.root,work.ready.id,'packing');expect(projection.data.rows.some(r=>r.id.startsWith('packing-')&&r.state==='present')).toBe(true);
   expect(projection.data.rows.some(r=>r.purpose==='input'&&/责任签字|财务|工资|老板签字/.test(r.label))).toBe(false);
   const journey=await new DigitalJourneyQuery(f.db).read(f.root,work.ready.id),reworks=journey.stages.flatMap(s=>s.nodes).filter(n=>n.key==='rework');
   expect(reworks.some(n=>n.instanceId===work.id)).toBe(true);expect(reworks.some(n=>n.instanceId==='rework:0'&&n.state==='uncreated')).toBe(false);
   expect((await f.db.query('SELECT status FROM rework_orders WHERE rework_order_id=$1',[work.id])).rows[0].status).not.toBe('completed');
  });
 });
 it('uses current native bulk prerequisites when the last instruction and selected developer history still point to round1',async()=>{
  const ready=await f.bulkReady('无',undefined,1,f.sourcing,{stopBeforeCompletion:true}),rounds=new DevelopmentRoundService(f.db,true),old=await forms.read(f.root,ready.sourceId);
  const designer=f.people['sample-designer']!,before=await bulk.read(designer,ready.id);
  expect(before.publishedBasis).toMatchObject({instructionVersion:1,sourceId:ready.sourceId,sourceRound:1,technicalBasisState:'recorded',technicalArtifact:{sourceId:ready.sourceId,roundNumber:1,version:1}});
  const draft=await rounds.save(f.root,ready.sourceId,{expectedDraftVersion:0,revision:{basedOnRound:1,document:old.document!,origin:'内部发现',customerComment:'',internalProblem:'TEST新纸样待做，旧制单不能证明当前依据有效',explanation:'TEST当前大货资料与查看历史分离',categories:['版型'],affectedNodes:['纸样','裁板','车板'],outputKind:'整件样板'}},randomUUID());
  await rounds.publish(f.root,ready.sourceId,{expectedDraftVersion:draft.draftVersion,basedOnRound:1},randomUUID());
  const query=new DigitalJourneyQuery(f.db),history=await query.read(f.root,ready.id,1),node=history.stages.flatMap(s=>s.nodes).find(n=>n.key==='production_instruction'&&n.current)!;expect(history.selectedRound).toBe(1);expect(history.adoptedRound).toBe(1);
  const native=await productionReadiness(f.db,ready.id);expect(native.document?.round_number).toBe(2);expect(native.finalReasons.length).toBeGreaterThan(0);
  const projected=await query.nodeMaterials(f.root,history.id,node.instanceId,1),basis=projected.rows.find(r=>r.id==='technical-basis')!;
  expect(basis.state).not.toBe('effective');expect(basis.records[0]!.url).toContain('round=2');expect(projected.rows.find(r=>r.id==='instruction-prerequisites')?.state).not.toBe('effective');
  const original=projected.rows.find(r=>r.id==='instruction-output')!;
  expect(original).toMatchObject({state:'effective',versionLabel:'已发布 v1'});expect(original.reason).toContain('原件仍保留');expect(original.records[0]!.url).toContain('instructionVersion=1');
  const after=await bulk.read(designer,ready.id);
  expect(after.publishedBasis).toEqual(before.publishedBasis);expect(after.instructionValid).toBe(false);expect(after.preparationId).toBeNull();
  // Current task references and every original readiness guard remain current;
  // the separate frozen published basis is still independently readable.
  expect(after.reference.instructionVersion).toBeNull();
  const exact=await new DevelopmentTechnicalService(f.db,true).history(designer,ready.sourceId,{roundNumber:1,scopeRef:'整款',kind:'artifacts',version:after.publishedBasis!.technicalArtifact!.version,view:'directory'});
  expect(exact.items[0]).toMatchObject({artifactSetId:after.publishedBasis!.technicalArtifact!.id,roundNumber:1,version:1});expect(Object.hasOwn(exact.items[0]!,'body')).toBe(false);
 });
 it('R2-02: completed print, post-cutting QC and warehouse batches keep the exact source D/C without relying on an enrolled-plan projection',async()=>{
  const scene=await f.scene('2026-11-02T08:00:00Z');await f.runtime.run(scene,f.root,async()=>{
   const ready=await f.bulkReady('印花'),flow=new FactoryFlowService(f.db),tasks=new DigitalProductionTaskService(f.db),cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   const cuts=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position',[ready.caseId])).rows;
   for(const cut of cuts)await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
   let source=await flow.read(f.root,ready.id);
   for(const [kind,role]of [['process_logistics','embroidery_washing_merchandiser'],['bulk_qc','quality_control']] as const){const person=Object.values(f.people).find(person=>person.actorRoles.includes(role))!;await tasks.reassign(f.root,source.tasks.find(t=>t.taskKind===kind)!.taskId,person.actorId,randomUUID());}
   source=await flow.read(f.root,ready.id);source=await flow.logistics(f.root,ready.id,{expectedRevision:source.revision,kind:'工艺发出',occurredAt:businessNow().toISOString(),supplier:'TEST原印花厂',note:'TEST native scope'},randomUUID());
   await f.advance(scene,'2026-11-02T08:01:00Z');
   source=await flow.logistics(f.root,ready.id,{expectedRevision:source.revision,kind:'工艺回仓',occurredAt:businessNow().toISOString(),supplier:'TEST原印花厂',note:'TEST original return'},randomUUID());
   source=await flow.qc(f.root,ready.id,{expectedRevision:source.revision,checks:source.lines.map(line=>({lineId:line.lineId,result:'合格',problem:'',treatment:'',attachmentIds:[]})),note:'TEST原裁后QC'},randomUUID());
   expect(await readWarehouseFactoryDispatchScopes(f.db,ready.id)).toEqual([]);
   const dispatchAt=businessNow().toISOString(),dispatch={expectedRevision:source.revision,occurredAt:dispatchAt,supplierId:f.supplierId,note:'TEST原仓库发裁片'},dispatchKey=randomUUID();
   source=await flow.dispatch(f.root,ready.id,dispatch,dispatchKey);
   expect(await flow.dispatch(f.root,ready.id,dispatch,dispatchKey)).toEqual(source);
   const dispatchFact=source.facts.find(fact=>fact.kind==='仓库实际发厂')!;
   const scopes=await readWarehouseFactoryDispatchScopes(f.db,ready.id);
   expect(scopes).toEqual(source.lines.map((line,index)=>({orderId:ready.id,factId:dispatchFact.factId,dispatchedAt:dispatchAt,productionId:source.productionId,
    factoryDecisionId:null,cuttingOrderId:cuts[index]!.cutting_order_id,lineId:line.lineId,quantity:10})));
   expect(await readWarehouseFactoryDispatchScopes(f.db,randomUUID())).toEqual([]);
   const before=await nodeMaterialsFootprint(f.db),journey=await new DigitalJourneyQuery(f.db).read(f.root,ready.id),compact=await new DigitalJourneyQuery(f.db).read(f.root,ready.id,undefined,true);
   expect(journey.supervision).toBeUndefined();
   for(const key of ['process_logistics','bulk_qc','warehouse_dispatch']){
    const originals=source.batchWindows!.filter(w=>w.kind===key);expect(originals.length).toBeGreaterThan(0);expect(originals.every(w=>w.complete&&w.dueAt&&w.completedAt)).toBe(true);
    for(const result of [journey,compact]){const node=result.stages.flatMap(stage=>stage.nodes).find(n=>n.key===key&&n.current)!;expect(node.nativeWindows?.map(w=>[w.evidence,w.deadline,w.completedAt])).toEqual(originals.map(w=>[w.evidence,w.dueAt,w.completedAt]));}
   }
   expect(await nodeMaterialsFootprint(f.db)).toEqual(before);
  });
 });
 it('serves current materials to an assigned bulk worker without granting its linked development source or explicit history',async()=>{
  const ready=await f.bulkReady('无',undefined,1,f.sourcing,{stopBeforeCompletion:true}),person=f.people['worker-a']!;
  await f.access.assignRole(f.root,{userId:person.actorId,roleCode:'pattern_room_worker',reason:'TEST真实单单纸样分派，无开发源权限'});
  const worker={...person,actorRoles:[...person.actorRoles,'pattern_room_worker']},task=(await bulk.read(f.root,ready.id)).tasks.find(t=>t.taskKind==='bulk_pattern')!;
  await new DigitalProductionTaskService(f.db).reassign(f.root,task.taskId,worker.actorId,randomUUID());
  const policy=new DigitalProductionAccessPolicy(f.db);expect(await policy.allowed(worker,'order',ready.id,'technical')).toBe(true);expect(await policy.allowed(worker,'source',ready.sourceId,'technical')).toBe(false);
  expect((await bulk.read(worker,ready.id)).publishedBasis).toMatchObject({sourceId:null,technicalArtifact:null,technicalBasisState:'restricted'});
  const projected=await nodeMaterialsFixture(f.db,worker,ready.id,'bulk_pattern');expect(projected.order.selectedRound).toBe(1);expect(projected.data.rows.some(r=>r.id==='material-fabric_receipt')).toBe(true);expect(projected.data.rows.some(r=>r.id==='technical-basis'||r.records.some(v=>v.domain==='development'))).toBe(false);
  await expect(projected.query.nodeMaterials(worker,projected.order.id,projected.node.instanceId,1)).rejects.toMatchObject({statusCode:404});
 });
 it('reads the selected PO review scope while whole-style technical evidence remains effective',async()=>{
  const ready=await f.bulkReady('无',undefined,2,f.sourcing,{stopBeforeCompletion:true}),technical=new DevelopmentTechnicalService(f.db,true),whole=await technical.read(f.root,ready.sourceId),po=(await identity.read(f.root,ready.id)).lines[1]!,scopeRef='po:'+po.lineId;
  expect(whole.effective?.state).toBe('effective');const final=await technical.recordComment(f.root,ready.sourceId,{roundNumber:1,scopeRef,expectedVersion:0,isFinal:true,decision:'changes_required',text:'TEST仅此PO客户最终评语要求复核',evidenceRefs:[],evidenceNote:'TEST实际PO最终评语',occurredAt:null},randomUUID());
  expect((await technical.read(f.root,ready.sourceId,1,'整款')).effective?.state).toBe('effective');expect((await technical.read(f.root,ready.sourceId,1,scopeRef)).effective?.state).not.toBe('effective');
  const projected=await nodeMaterialsFixture(f.db,f.root,ready.id,'development_size_review',final.reviewTaskId!),row=projected.data.rows.find(r=>r.id==='technical-basis')!;
  expect(row.state).not.toBe('effective');expect(row.scope).toContain(po.poNumber!);expect(row.scope).toContain(po.color);expect(row.owner?.id).toBe(projected.node.owner?.id);expect(row.records[0]?.id).toBe(final.reviewTaskId);
 });
 it('keeps preorder material work independent, reuses original receipts and bridges partial/unknown heads without fallback resurrection',async()=>{
  const p=await setup();expect(p.handover.orderId).toBeNull();
  await record(p,p.resource,'material_investment');await record(p,p.resource,'fabric_receipt','partial');
  const created=await order(p),id=created.productionOrderId,target={kind:'order' as const,id};
  let facts=await readSeriesPlanFacts(f.db,id,p.sourceId,'PD');expect(facts.facts.find(x=>x.key==='fabric_receipt')).toMatchObject({started:true,completed:false});
  const after=await record(p,target,'fabric_receipt');const receipt=after.facts.find(f=>f.kind==='fabric_receipt')!;
  expect(receipt.resource).toEqual(p.resource);expect(receipt.version).toBe(2);expect(after.draftWindow.minutes).toBe(1440);
  await record(p,target,'fabric_receipt','unknown');facts=await readSeriesPlanFacts(f.db,id,p.sourceId,'PD');expect(facts.facts.some(x=>x.key==='fabric_receipt')).toBe(false);
  const projected=await nodeMaterialsFixture(f.db,f.root,id,'production_instruction');expect(projected.data.rows.find(r=>r.id==='material-fabric_receipt')?.state).toBe('unknown');
  expect((await service.read(p.warehouse,target)).history.filter(x=>x.kind==='fabric_receipt')).toHaveLength(3);
  await expect(service.read(f.people['worker-a']!,target)).rejects.toMatchObject({statusCode:403});
  await expect(service.record(p.primary,target,{kind:'fabric_receipt',scopeRef:'whole',expectedVersion:3,state:'ready',occurredAt:businessNow().toISOString(),note:'TEST unauthorized',quantities:[],evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID())).rejects.toMatchObject({statusCode:403});
 });
 it('uses the effective handover and its native handler for cockpit preparation actions',async()=>{
  const p=await setup();
  const actions=async(orderId:string|null)=>{
   const id=orderId??p.sourceId,client=await f.db.connect();
   try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return (await readCockpitMaterialActions(client,[{id,sourceId:p.sourceId,orderId,asOf:businessNow().toISOString()}])).get(id);
   }finally{await client.query('ROLLBACK');client.release();}
  };
  expect((await service.read(p.primary,p.resource)).canRecord).toContain('material_investment');
  expect(await actions(null)).toEqual([expect.objectContaining({
   handlerId:p.primary.actorId,missingObject:'投面辅料',originalRoute:`/ui/digital-production?materialSource=${p.sourceId}&materialKind=material_investment`
  })]);
  await record(p,p.resource,'material_investment');
  expect(await actions(null)).toEqual([]);
  const created=await order(p),target={kind:'order' as const,id:created.productionOrderId};
  await service.record(p.designer,target,{kind:'design_handover',scopeRef:'whole',expectedVersion:1,state:'withdrawn',occurredAt:null,
   note:'TEST explicitly withdrew the current handover',quantities:[],evidenceIds:[p.photo],
   sourceDocumentVersion:(await forms.read(p.designer,p.sourceId)).version,recipientId:p.primary.actorId},randomUUID());
  expect(await actions(target.id)).toEqual([expect.objectContaining({
   handlerId:p.designer.actorId,evidenceId:p.handover.facts.find(fact=>fact.kind==='design_handover')!.recordId,missingObject:'设计交资料',
   originalRoute:`/ui/digital-production?bulk=${target.id}&materialKind=design_handover`
  })]);
 });
 it('allows drafts before final prerequisites; starts distinct arrival and final-ready 24h clocks and binds the effective technical revision',async()=>{
  const scene=await f.scene('2026-11-02T00:00:00Z');let p!:Awaited<ReturnType<typeof setup>>,id='',orderVersion=0;
  await f.runtime.run(scene,f.root,async()=>{p=await setup();await record(p,p.resource,'fabric_receipt');const created=await order(p);id=created.productionOrderId;orderVersion=created.version;
   const original=await instruction.read(p.primary,id);
   const doc={...initialInstruction(),fabrics:original.document.fabrics,unit:'cm' as const,styleName:'TEST garment',category:'上衣',date:beijingCalendarDate(businessNow()),preshrink:'无需预缩' as const,sizes:['M'],measurements:[{id:randomUUID(),name:'胸围',tolerance:'±1',method:'平量',values:['48']}],images:[{attachmentId:p.photo,kind:'款图' as const,description:'TEST'}]};
   const saved=await instruction.save(p.primary,id,{expectedVersion:0,orderVersion,sourceRound:1,document:doc},randomUUID());expect(saved.readiness?.draftWindow.startedAt).toBe('2026-11-02T00:00:00.000Z');
   await expect(instruction.publish(p.primary,id,{expectedVersion:1,orderVersion},randomUUID())).rejects.toMatchObject({statusCode:409});
   await expect(instruction.publish(p.primary,id,{expectedVersion:1,orderVersion,expectedReadinessRevision:saved.readiness!.revision},randomUUID())).rejects.toMatchObject({statusCode:409});
  });
  await f.advance(scene,'2026-11-02T06:00:00Z');await f.runtime.run(scene,f.root,async()=>{
   await confirmedTechnicalFixture(f.db,f.root,p.sourceId,p.document,(await forms.read(f.root,p.sourceId)).version,f.people['pattern-room-worker']!.actorId);
   await f.db.query("INSERT INTO digital_development_route_facts(fact_id,source_id,route_version,kind,payload,actor_id) VALUES($1,$2,1,'尾查通过',$3,$4)",[randomUUID(),p.sourceId,JSON.stringify({actualCompletedAt:businessNow().toISOString(),note:'TEST explicit sample prerequisite'}),f.root.actorId]);
   const before=await service.read(p.warehouse,{kind:'order',id}),receipt=before.facts.find(f=>f.kind==='fabric_receipt')!;
   await bulk.reportFabric(p.warehouse,id,{expectedReportId:null,expectedReceiptVersion:receipt.version,material:'TEST cotton',arrivedAt:receipt.occurredAt,inspectedAt:businessNow().toISOString(),result:'不合格',note:'TEST real quality failure'},randomUUID());
   expect((await preparationWindowTodos(f.db,p.primary)).filter(t=>t.entityId===id)).toHaveLength(0);
   expect((await service.read(p.primary,{kind:'order',id})).draftWindow.startedAt).toBe('2026-11-02T00:00:00.000Z');
   const report=(await bulk.read(p.warehouse,id)).fabric!.report!;
   await bulk.decideFabric(f.root,id,{reportId:report.reportId,expectedDecisionId:null,allowUse:true,note:'TEST authorized quality decision'},randomUUID());
   const ready=await service.read(p.primary,{kind:'order',id});expect(ready.finalReasons).toEqual([]);expect((await preparationWindowTodos(f.db,p.primary)).filter(t=>t.entityId===id)).toHaveLength(1);expect(ready.finalWindow.startedAt).toBe('2026-11-02T06:00:00.000Z');expect(ready.finalWindow.dueAt).toBe('2026-11-03T06:00:00.000Z');
   expect((await f.db.query('SELECT count(*)::int AS n FROM digital_budget_documents WHERE production_order_id=$1',[id])).rows[0].n).toBe(0);
   const projected=await nodeMaterialsFixture(f.db,p.primary,id,'production_instruction');expect(projected.data.rows.find(r=>r.id==='instruction-prerequisites')?.state).toBe('effective');expect(projected.data.rows.some(r=>r.id==='budget'||r.label==='预算')).toBe(false);
   const published=await instruction.publish(p.primary,id,{expectedVersion:1,orderVersion,expectedReadinessRevision:ready.revision},randomUUID());expect(published.readiness?.finalWindow.status).toBe('completed_on_time');expect((await preparationWindowTodos(f.db,p.primary)).filter(t=>t.entityId===id)).toHaveLength(0);
   expect((await productionReadiness(f.db,id)).technical?.revision).toBe(ready.technicalRevision);
   const sourceMaterial=preparationInvestmentScope(p.document.materials).rows[0]!;
   const demand=()=>readWarehouseInstructionDemands(f.db,[id]);
   const warehouseBasis={resource:p.resource,kind:'fabric_receipt' as const,lineId:null,scopeRef:'whole',materialId:sourceMaterial[0],
    supplierId:null,adoptedRef:preparationHash(sourceMaterial),unit:'米'};
   const nativeDemand=(await demand()).get(id);
   expect(nativeDemand).toMatchObject({version:1,demand:{sourceId:p.sourceId,rows:[{instructionMaterialId:published.document.fabrics[0]!.id,sourceMaterialId:warehouseBasis.materialId}]}});
   expect(demandForWarehouseReceipt(nativeDemand,warehouseBasis,ready.lines)).toEqual({quantity:'10',unit:'米'});
   expect(demandForWarehouseReceipt(nativeDemand,{...warehouseBasis,unit:'码'},ready.lines)).toBeNull();
   expect(demandForWarehouseReceipt(nativeDemand,{...warehouseBasis,materialId:randomUUID()},ready.lines)).toBeNull();
   expect(demandForWarehouseReceipt(nativeDemand,warehouseBasis,ready.lines.map(line=>({...line,orderQuantity:11})))).toBeNull();
   const repeated=await service.deliver(p.primary,id,{instructionVersion:1,recipient:'TEST加工厂',occurredAt:businessNow().toISOString(),note:'TEST交付原版本',evidenceIds:[]},'TEST-native-delivery');
   const again=await service.deliver(p.primary,id,{instructionVersion:1,recipient:'TEST加工厂',occurredAt:businessNow().toISOString(),note:'TEST交付原版本',evidenceIds:[]},'TEST-native-delivery');expect(again.instructionDeliveries).toEqual(repeated.instructionDeliveries);
   expect(await styleLabelCuttingReason(f.db,id,(await identity.read(p.primary,id)).lines.map(l=>l.lineId))).toContain('款号唛');
   const instructionActions=async()=>{
    const client=await f.db.connect();
    try{
     await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
     const result=await readCockpitInstructionActions(f.db,client,f.root,[{id,orderId:id,asOf:businessNow().toISOString()}]);
     return result.items.get(id);
    }finally{await client.query('ROLLBACK');client.release();}
   };
   expect(await instructionActions()).toBeUndefined();
   const revised=await instruction.save(p.primary,id,{expectedVersion:published.version,orderVersion,document:{...published.document,
    fabrics:published.document.fabrics.map(row=>({...row,remarks:row.remarks+' 已订正规格'}))}},randomUUID());
   expect(revised.publishedVersion).toBe(1);
   expect(revised.version).toBe(2);
   expect((await demand()).get(id)).toEqual(nativeDemand); // saving a draft leaves the adopted original alone
   expect(await instructionActions()).toEqual([expect.objectContaining({handlerId:p.primary.actorId,evidenceId:`instruction:${id}:v2`})]);
   await instruction.publish(p.primary,id,{expectedVersion:2,orderVersion,expectedReadinessRevision:revised.readiness!.revision},randomUUID());
   expect(await instructionActions()).toBeUndefined();
   expect((await demand()).get(id)).toMatchObject({version:2,demand:{rows:[],tracked:[published.document.fabrics[0]!.id]}});
   expect((await f.db.query("SELECT basis_json->'warehouseDemand' AS demand FROM digital_instruction_preparation_bases WHERE production_order_id=$1 AND instruction_version=1",[id])).rows[0]?.demand).toEqual(nativeDemand?.demand);
  });
 });
 it('reads one and four original partial-work requirements in the same number of SQL statements',async()=>{
  const scene=await f.scene('2026-11-09T00:00:00Z');
  const candidates=await f.runtime.run(scene,f.root,async()=>{
   const result:Array<{id:string;orderId:string;asOf:string}>=[];
   for(let index=0;index<4;index++){
    const ready=await f.bulkReady('无',undefined,1,f.sourcing,{stopBeforeCompletion:true,accessory:true});
    const accessory=(await bulk.read(ready.primary,ready.id)).materials!.items[0]!.id;
    const order={kind:'order' as const,id:ready.id};
    const old=(await service.read(f.root,order)).facts.find(fact=>fact.kind==='accessories_ready')!;
    await service.record(f.people.warehouse!,order,{expectedVersion:old.version,state:'unknown',occurredAt:null,
     note:'TEST原待补辅料',kind:'accessories_ready',scopeRef:'whole',quantities:[],evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
    const pattern=f.people['pattern-room-worker']!,current=await service.read(pattern,order);
    await bulk.complete(pattern,ready.id,{preparationId:ready.preparationId,kind:'纸样完成',expectedReadinessRevision:current.revision,range:{
     expectedVersion:0,lineIds:(await identity.read(ready.primary,ready.id)).lines.map(line=>line.lineId),complete:false,
     pendingMaterialIds:[accessory],note:'TEST局部纸样可完成',evidenceIds:[]
    }},randomUUID());
    result.push({id:ready.id,orderId:ready.id,asOf:businessNow().toISOString()});
   }
   return result;
  });
  const transaction=await f.db.connect(),statements:string[]=[];
  const counted=new Proxy(transaction,{get(target,key){
   if(key==='query')return (sql:string,args:unknown[])=>{statements.push(sql);return target.query(sql,args);};
   const value:unknown=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  try{
   await transaction.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const one=await readCockpitMaterialSupplements(counted,candidates.slice(0,1)),small=statements.splice(0);
   const many=await readCockpitMaterialSupplements(counted,candidates);
   expect(many.size).toBe(4);
   expect(many.get(candidates[0]!.id)).toEqual(one.get(candidates[0]!.id));
   for(const {id} of candidates)expect(many.get(id)).toMatchObject([{
    category:'preparation_material',handlerId:f.people.warehouse!.actorId,
    originalRoute:`/ui/digital-production?bulk=${id}&materialKind=accessories_ready`
   }]);
   expect(statements.some(statement=>statement.includes('__dx_cockpit_candidate')&&statement.includes(' UNION ALL '))).toBe(true);
   expect(statements.length).toBeLessThanOrEqual(small.length+2);
   console.log(`Cockpit native supplement SQL: one=${small.length}, four=${statements.length}`);
  }finally{await transaction.query('ROLLBACK');transaction.release();}
 },testExecutionConfig.correctnessTimeoutMs);
 it('keeps partial ordinary-order work in the original 48h window; replenishment at60h and complete65h remain17h late',async()=>{
  const scene=await f.scene('2026-11-10T00:00:00Z');let ready!:Awaited<ReturnType<typeof f.bulkReady>>,accessory='';
  await f.runtime.run(scene,f.root,async()=>{ready=await f.bulkReady('无',undefined,1,f.sourcing,{stopBeforeCompletion:true,accessory:true});
   if(process.env.PREPARATION_UI_INPUT)await writeFile(process.env.PREPARATION_UI_INPUT,JSON.stringify({bulk:await bulk.read(f.root,ready.id),instruction:await instruction.read(f.root,ready.id),readiness:await service.read(f.root,{kind:'order',id:ready.id}),people:Object.values(f.people).map(p=>({id:p.actorId,displayName:`TEST ${p.actorRoles[0]}`,roles:p.actorRoles}))}));
   accessory=(await bulk.read(ready.primary,ready.id)).materials!.items[0]!.id;
   const current=await service.read(f.root,{kind:'order',id:ready.id}),old=current.facts.find(x=>x.kind==='accessories_ready')!;
   await service.record(f.people.warehouse!,{kind:'order',id:ready.id},{expectedVersion:old.version,state:'unknown',occurredAt:null,note:'TEST纽扣仍待补；不重置原纸样唛架时钟',kind:'accessories_ready',scopeRef:'whole',quantities:[],evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
  });
  await f.advance(scene,'2026-11-11T00:00:00Z');await f.runtime.run(scene,f.root,async()=>{
   const sheet=await bulk.read(f.people['pattern-room-worker']!,ready.id),current=await service.read(f.people['pattern-room-worker']!,{kind:'order',id:ready.id});
   const lineIds=(await identity.read(ready.primary,ready.id)).lines.map(l=>l.lineId);
   const partial={preparationId:ready.preparationId,kind:'纸样完成' as const,expectedReadinessRevision:current.revision,range:{expectedVersion:0,lineIds,complete:false,pendingMaterialIds:[accessory],note:'TEST已做不受纽扣影响部分',evidenceIds:[]}},key=randomUUID();await bulk.complete(f.people['pattern-room-worker']!,ready.id,partial,key);
   // Simulate the client losing that response: after a fresh read, replay the immutable v0 body/key.
   expect((await bulk.read(f.root,ready.id)).readiness!.ranges.filter(r=>r.preparationId===ready.preparationId&&r.kind==='纸样完成')).toHaveLength(1);await bulk.complete(f.people['pattern-room-worker']!,ready.id,partial,key);expect((await bulk.read(f.root,ready.id)).readiness!.ranges.filter(r=>r.preparationId===ready.preparationId&&r.kind==='纸样完成')).toHaveLength(1);
   expect((await bulk.read(ready.primary,ready.id)).facts.some(x=>x.kind==='纸样完成')).toBe(false);expect((await preparationMaterialsTodos(f.db,f.people.warehouse!)).filter(t=>t.entityId===ready.id)).toHaveLength(1);
   const projected=await nodeMaterialsFixture(f.db,f.root,ready.id,'bulk_pattern');expect(projected.data.rows.some(r=>r.id.startsWith('range-')&&r.state==='partial')).toBe(true);expect(projected.data.rows.find(r=>r.id==='material-accessories_ready')?.state).toBe('unknown');
   expect((await bulk.read(ready.primary,ready.id)).tasks.some(x=>x.taskKind==='bulk_cutting')).toBe(false);
   const pattern=sheet.tasks.find(t=>t.taskKind==='bulk_pattern')!;expect(pattern.dueAt).toBe('2026-11-12T00:00:00.000Z');
   await expect(completeBulkRangeFixture(f.db,f.people['pattern-room-worker']!,ready.id,ready.preparationId,'纸样完成')).rejects.toMatchObject({statusCode:409});
  });
  await f.advance(scene,'2026-11-12T12:00:00Z');await f.runtime.run(scene,f.root,async()=>{
   const current=await service.read(f.root,{kind:'order',id:ready.id}),old=current.facts.find(x=>x.kind==='accessories_ready')!;
   await service.record(f.people.warehouse!,{kind:'order',id:ready.id},{kind:'accessories_ready',scopeRef:'whole',expectedVersion:old.version,state:'ready',occurredAt:businessNow().toISOString(),note:'TEST60小时纽扣补到',quantities:[{lineId:null,materialId:accessory,name:'TEST纽扣',quantity:10,unit:'粒'}],evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
  });
  await f.runtime.run(scene,f.root,async()=>{expect((await preparationMaterialsTodos(f.db,f.people.warehouse!)).filter(t=>t.entityId===ready.id)).toHaveLength(0);const task=(await bulk.read(f.root,ready.id)).tasks.find(t=>t.taskKind==='bulk_pattern')!;expect((await preparationSupplement(f.db,task.taskId))?.ready).toBe(true);});
  await f.advance(scene,'2026-11-12T17:00:00Z');await f.runtime.run(scene,f.root,async()=>{
   for(const kind of ['纸样完成','唛架完成'] as const)await completeBulkRangeFixture(f.db,f.people['pattern-room-worker']!,ready.id,ready.preparationId,kind);
   const task=(await bulk.read(f.root,ready.id)).tasks.find(t=>t.taskKind==='bulk_pattern')!;expect(task.state).toBe('completed');expect(task.dueAt).toBe('2026-11-12T00:00:00.000Z');expect(task.completedAt).toBe('2026-11-12T17:00:00.000Z');expect((Date.parse(task.completedAt!)-Date.parse(task.dueAt!))/3600000).toBe(17);
   expect((await f.db.query("SELECT count(*)::int AS n FROM digital_production_task_events WHERE task_id=$1 AND event_kind='completed'",[task.taskId])).rows[0].n).toBe(1);
  });
 });
 it('preserves black PO labels and actual cutting while appending white PO labels, with a real stale-version conflict',async()=>{
  const ready=await f.bulkReady('无',undefined,2),resource={kind:'order' as const,id:ready.id},warehouse=f.people.warehouse!;
  const initial=await service.read(warehouse,resource),black=initial.lines.find(l=>l.color==='黑')!,white=initial.lines.find(l=>l.color==='白')!;
  const blackRow={lineId:black.lineId,materialId:null,name:'TEST黑PO款号唛',quantity:black.orderQuantity,unit:'枚'};
  const body={kind:'style_label_ready' as const,scopeRef:'whole',expectedVersion:initial.facts.find(x=>x.kind==='style_label_ready')!.version,state:'ready' as const,occurredAt:businessNow().toISOString(),note:'TEST原黑PO实物保留，白PO待追加',quantities:[blackRow],evidenceIds:[],sourceDocumentVersion:null,recipientId:null};
  const first=await service.record(warehouse,resource,body,randomUUID()),version=first.facts.find(x=>x.kind==='style_label_ready')!.version;
  const cutting=(await bulk.read(f.root,ready.id)).cutting.lines.find(l=>l.lineId===black.lineId)!;
  const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
  await ready.cutting.record(cutter,cutting.cuttingOrderId!,{pieceCount:1,actualCutCount:1,attachmentIds:[await f.image(cutter)]},randomUUID());
  const appended={...body,expectedVersion:version,quantities:[blackRow,{lineId:white.lineId,materialId:null,name:'TEST白PO款号唛',quantity:white.orderQuantity,unit:'枚'}],note:'TEST只追加白PO，不覆盖黑PO'};
  const results=await Promise.allSettled([service.record(warehouse,resource,appended,randomUUID()),service.record(warehouse,resource,appended,randomUUID())]);
  expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect((results.find(x=>x.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({statusCode:409});
  const state=await service.read(warehouse,resource),labels=state.facts.find(x=>x.kind==='style_label_ready')!;expect(labels.version).toBe(version+1);expect(labels.quantities).toEqual(appended.quantities);
  expect(state.history.find(x=>x.kind==='style_label_ready'&&x.version===version)!.quantities).toEqual([blackRow]);
  expect((await bulk.read(f.root,ready.id)).cutting.lines.find(l=>l.lineId===black.lineId)!.actualCutCount).toBe(1);
  expect(await styleLabelCuttingReason(f.db,ready.id,[white.lineId],white.orderQuantity)).toBeNull();
  await expect(service.record(ready.primary,resource,{...appended,expectedVersion:version+1},randomUUID())).rejects.toMatchObject({statusCode:403});
 });
 it('orders same-time reversed-UUID range history by preparation and kind version, keeps real old-page409 and the original48h clock',async()=>{
  const scene=await f.scene('2026-11-10T00:00:00Z');let ready!:Awaited<ReturnType<typeof f.bulkReady>>,due='';
  await f.runtime.run(scene,f.root,async()=>{
   ready=await f.bulkReady('无',undefined,2,f.sourcing,{stopBeforeCompletion:true});const sheet=await bulk.read(f.root,ready.id),task=sheet.tasks.find(t=>t.taskKind==='bulk_pattern')!;due=task.dueAt!;
   const state=await service.read(f.root,{kind:'order',id:ready.id}),lineIds=state.lines.map(l=>l.lineId);
   // Deterministic existing immutable history: equal actual timestamps, v1 UUID > v2 UUID.
   // No old row, clock, trigger, permission, or completion fact is rewritten.
   for(const [id,kind,version] of [['ffffffff-ffff-4fff-8fff-fffffffffff1','纸样完成',1],['00000000-0000-4000-8000-000000000001','纸样完成',2],['00000000-0000-4000-8000-000000000002','唛架完成',1]] as const){
    await f.db.query(`INSERT INTO digital_bulk_work_ranges(range_id,preparation_id,task_id,kind,version,line_ids,complete,pending_material_ids,note,evidence_ids,basis_json,actor_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,false,'{}',$7,'{}',$8,$9,$10)`,[id,ready.preparationId,task.taskId,kind,version,[lineIds[0]],'TEST已做局部 '+kind+' v'+version,JSON.stringify({readinessRevision:state.revision,technicalRevision:state.technicalRevision}),f.people['pattern-room-worker']!.actorId,businessNow().toISOString()]);
   }
   const current=await service.read(f.root,{kind:'order',id:ready.id});expect(current.ranges.filter(r=>r.preparationId===ready.preparationId&&r.kind==='纸样完成').map(r=>r.version)).toEqual([1,2]);expect(current.ranges.filter(r=>r.kind==='唛架完成').map(r=>r.version)).toEqual([1]);
   if(process.env.PREPARATION_UI_INPUT)await writeFile(process.env.PREPARATION_UI_INPUT,JSON.stringify({bulk:await bulk.read(f.root,ready.id),instruction:await instruction.read(f.root,ready.id),readiness:current,people:Object.values(f.people).map(p=>({id:p.actorId,displayName:'TEST '+p.actorRoles[0],roles:p.actorRoles}))}));
   const body={preparationId:ready.preparationId,kind:'纸样完成' as const,expectedReadinessRevision:current.revision,range:{expectedVersion:1,lineIds:[lineIds[0]!],complete:false,pendingMaterialIds:[],note:'TEST旧页不能覆盖',evidenceIds:[]}};
   await expect(bulk.complete(f.people['pattern-room-worker']!,ready.id,body,randomUUID())).rejects.toMatchObject({statusCode:409});
   const next={...body,range:{...body.range,expectedVersion:2,note:'TEST并发局部追加'}};
   const attempts=await Promise.allSettled([bulk.complete(f.people['pattern-room-worker']!,ready.id,next,randomUUID()),bulk.complete(f.people['pattern-room-worker']!,ready.id,next,randomUUID())]);expect(attempts.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect((attempts.find(x=>x.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({statusCode:409});
   expect((await bulk.read(f.root,ready.id)).facts.some(x=>x.kind==='纸样完成'||x.kind==='唛架完成')).toBe(false);
  });
  await f.advance(scene,'2026-11-12T17:00:00Z');await f.runtime.run(scene,f.root,async()=>{
   for(const kind of ['纸样完成','唛架完成'] as const)await completeBulkRangeFixture(f.db,f.people['pattern-room-worker']!,ready.id,ready.preparationId,kind);
   const sheet=await bulk.read(f.root,ready.id),task=sheet.tasks.find(t=>t.taskKind==='bulk_pattern')!;expect(task.dueAt).toBe(due);expect((Date.parse(task.completedAt!)-Date.parse(due))/3600000).toBe(17);
   expect(sheet.readiness!.ranges.filter(r=>r.preparationId===ready.preparationId&&r.kind==='纸样完成').map(r=>r.version)).toEqual([1,2,3,4]);expect(sheet.readiness!.ranges.filter(r=>r.preparationId===ready.preparationId&&r.kind==='唛架完成').map(r=>r.version)).toEqual([1,2]);
  });
 });

 it('rejects stale parallel edits, cross-order material lines and cross-role replay, retaining immutable historical facts',async()=>{
  const p=await setup(),created=await order(p),resource={kind:'order' as const,id:created.productionOrderId};
  const command={kind:'fabric_receipt' as const,scopeRef:'whole',expectedVersion:0,state:'ready' as const,occurredAt:businessNow().toISOString(),note:'TEST concurrent actual receipt',quantities:[],evidenceIds:[],sourceDocumentVersion:null,recipientId:null};
  const results=await Promise.allSettled([service.record(p.warehouse,resource,command,randomUUID()),service.record(p.warehouse,resource,command,randomUUID())]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const rejected=results.find(r=>r.status==='rejected') as PromiseRejectedResult;expect(rejected.reason).toMatchObject({statusCode:409});
  const current=await service.read(p.warehouse,resource);expect(current.history.filter(x=>x.kind==='fabric_receipt')).toHaveLength(1);
  await expect(service.record(p.warehouse,resource,{...command,kind:'style_label_ready',quantities:[{lineId:randomUUID(),materialId:null,name:'TEST款号唛',quantity:10,unit:'枚'}]},randomUUID())).rejects.toMatchObject({statusCode:409});
  await expect(f.db.query("UPDATE digital_preparation_material_versions SET state='withdrawn' WHERE record_id=$1",[current.facts.find(x=>x.kind==='fabric_receipt')!.recordId])).rejects.toThrow('immutable');
 });

 it('enforces original HTTP authorization and version guards, including no-key/extra fields and post-revocation retries',async()=>{
  const p=await setup(),created=await order(p),id=created.productionOrderId,app=Fastify();
  const users={warehouse:p.warehouse,primary:p.primary,designer:p.designer};
  const deps={service:identity,creationEnabled:true,authenticate:async(token:string|undefined)=>{const who=users[token as keyof typeof users];if(!who)throw new ApplicationError('UNAUTHORIZED','TEST login required',401);return {id:who.actorId,displayName:'TEST current user',businessRoles:who.actorRoles,capabilities:['digital_production:view']};}};
  app.setErrorHandler((error,_request,reply)=>{const e=error as ApplicationError;void reply.code(e.statusCode??500).send({code:e.code,message:e.message});});
  registerProductionReadinessRoutes(app,deps,service,f.attachments);registerInstructionRoutes(app,deps,instruction,f.attachments);await app.ready();
  const base=`/digital-production/orders/${id}/production-readiness`,headers={cookie:'dx_rework_session=warehouse','idempotency-key':randomUUID()},payload={kind:'fabric_receipt',scopeRef:'whole',expectedVersion:0,state:'ready',occurredAt:businessNow().toISOString(),note:'TEST native HTTP receipt',quantities:[],evidenceIds:[],sourceDocumentVersion:null,recipientId:null};
  try{
   expect((await app.inject({method:'GET',url:base})).statusCode).toBe(401);
   expect((await app.inject({method:'POST',url:base+'/materials',headers:{cookie:headers.cookie},payload})).statusCode).toBe(409);
   expect((await app.inject({method:'POST',url:base+'/materials',headers,payload:{...payload,completed:true}})).statusCode).toBe(400);
   expect((await app.inject({method:'POST',url:base+'/materials',headers:{...headers,cookie:'dx_rework_session=primary'},payload})).statusCode).toBe(403);
   const saved=await app.inject({method:'POST',url:base+'/materials',headers,payload});expect(saved.statusCode).toBe(200);
   expect((await app.inject({method:'POST',url:base+'/materials',headers,payload})).json().history).toEqual(saved.json().history);
   await f.db.query('UPDATE identity_mappings SET employed=false WHERE user_id=$1',[p.warehouse.actorId]);
   expect((await app.inject({method:'POST',url:base+'/materials',headers,payload})).statusCode).toBe(403);
   await f.db.query('UPDATE identity_mappings SET employed=true WHERE user_id=$1',[p.warehouse.actorId]);
   expect((await app.inject({method:'POST',url:`/digital-production/orders/${id}/series-source-events`,headers,payload})).statusCode).toBe(404);
   expect((await app.inject({method:'POST',url:`/digital-production/orders/${id}/instruction/publish`,headers,payload:{expectedVersion:1,orderVersion:created.version}})).statusCode).toBe(403);
  }finally{await f.db.query('UPDATE identity_mappings SET employed=true WHERE user_id=$1',[p.warehouse.actorId]);await app.close();}
 });
 it('uses the private upload/finalize/bind/download path and rejects a different order and unavailable current evidence',async()=>{
  const p=await setup(),created=await order(p),resource={kind:'order' as const,id:created.productionOrderId};
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer(),sha256=createHash('sha256').update(bytes).digest('hex');
  const upload=await f.attachments.createUploadIntent(p.warehouse,{filename:'TEST-long-'.repeat(8)+'.png',mimeType:'image/png',sizeBytes:bytes.length,sha256});
  await f.storage.writeImmutable(upload.objectKey,bytes,{mimeType:'image/png',sha256});await f.attachments.finalize(p.warehouse,upload.attachmentId);
  const input={kind:'fabric_receipt' as const,scopeRef:'whole',expectedVersion:0,state:'ready' as const,occurredAt:businessNow().toISOString(),note:'TEST private native receipt evidence',quantities:[],evidenceIds:[upload.attachmentId],sourceDocumentVersion:null,recipientId:null};
  await service.record(p.warehouse,resource,input,randomUUID());
  await expect(f.attachments.createDownloadIntent(p.primary,upload.attachmentId,()=>service.canDownload(p.primary,resource,upload.attachmentId))).resolves.toHaveProperty('downloadUrl');
  const other=await setup(),otherOrder=await order(other),otherResource={kind:'order' as const,id:otherOrder.productionOrderId};
  await expect(f.attachments.createDownloadIntent(other.designer,upload.attachmentId,()=>service.canDownload(other.designer,otherResource,upload.attachmentId))).rejects.toMatchObject({statusCode:403});
  await expect(service.record(other.warehouse,otherResource,{...input},randomUUID())).rejects.toMatchObject({statusCode:403});
  await f.db.query("UPDATE attachments SET status='rejected',ready_at=NULL,rejection_reason='TEST unavailable current file' WHERE attachment_id=$1",[upload.attachmentId]);
  const current=await service.read(p.primary,resource);expect(current.facts.find(f=>f.kind==='fabric_receipt')?.valid).toBe(false);expect((await readSeriesPlanFacts(f.db,created.productionOrderId,p.sourceId,'PD')).facts.find(x=>x.key==='fabric_receipt')).toMatchObject({started:true,completed:false});
  expect((await productionReadiness(f.db,created.productionOrderId)).finalReasons).toContain('当前主料到仓记录尚未有效备齐');
 });

 it('blocks readiness evidence writes across cancellation and keeps the original authorized receipt',async()=>{
  const p=await setup(),created=await order(p),resource={kind:'order' as const,id:created.productionOrderId};
  const users={primary:p.primary,unrelated:f.people['worker-a']!};
  const deps={service:identity,creationEnabled:true,authenticate:async(token:string|undefined)=>{
   const who=users[token as keyof typeof users];if(!who)throw new ApplicationError('UNAUTHORIZED','TEST login required',401);
   return {id:who.actorId,displayName:'TEST current user',businessRoles:who.actorRoles,capabilities:['digital_production:view']};
  }};
  const app=Fastify();
  app.setErrorHandler((error,_request,reply)=>{const e=error as ApplicationError;void reply.code(e.statusCode??500).send({code:e.code,message:e.message});});
  registerProductionReadinessRoutes(app,deps,service,f.attachments);await app.ready();
  const orderBase=`/digital-production/orders/${resource.id}/production-readiness`,sourceBase=`/digital-production/sources/${p.sourceId}/production-readiness`;
  const headers={cookie:'dx_rework_session=primary'},post=(url:string,payload:object,key=randomUUID())=>app.inject({method:'POST',url,payload,headers:{...headers,'idempotency-key':key}});
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer(),sha256=createHash('sha256').update(bytes).digest('hex');
  const file={filename:'TEST material evidence.png',mimeType:'image/png',sizeBytes:bytes.length,sha256};
  const create=async(base:string)=>{const result=await post(base+'/upload-intents',file);expect(result.statusCode,result.body).toBe(200);
   const upload=result.json<{objectKey:string;attachmentId:string}>();await f.storage.writeImmutable(upload.objectKey,bytes,file);return upload;};
  try{
   const original=await create(orderBase),finalize=(id:string,base=orderBase)=>post(`${base}/attachments/${id}/finalize`,{});
   const finished=await finalize(original.attachmentId);expect(finished.statusCode,finished.body).toBe(200);
   expect((await finalize(original.attachmentId)).json()).toEqual(finished.json());
   const material=p.document.materials[0]!,key=randomUUID();
   const input={kind:'material_investment',scopeRef:'whole',expectedVersion:0,state:'partial',occurredAt:businessNow().toISOString(),note:'TEST existing material investment',
    quantities:[{lineId:null,materialId:material.materialId,name:material.name,quantity:10,unit:'米'}],evidenceIds:[original.attachmentId],sourceDocumentVersion:null,recipientId:null,investmentMaterialId:material.materialId};
   const saved=await post(orderBase+'/materials',input,key);expect(saved.statusCode,saved.body).toBe(200);
   const current=saved.json<ProductionReadinessState>();expect(current.canRecord).toContain('material_investment');
   const pending=await create(sourceBase);
   const head=f.storage.head.bind(f.storage);
   let startVerification!:()=>void,resumeVerification!:()=>void;
   const verifying=new Promise<void>(resolve=>{startVerification=resolve;});
   const released=new Promise<void>(resolve=>{resumeVerification=resolve;});
   const probe=vi.spyOn(f.storage,'head').mockImplementation(async objectKey=>{
    if(objectKey===pending.objectKey){startVerification();await released;}
    return head(objectKey);
   });
   const inFlight=Promise.resolve(finalize(pending.attachmentId,sourceBase));
   const attachmentsBefore=(await f.db.query('SELECT count(*)::int count FROM attachments WHERE uploaded_by=$1',[p.primary.actorId])).rows[0].count;
   try{
    await Promise.race([verifying,inFlight.then(response=>{throw Error(`Verification did not start: ${response.statusCode} ${response.body}`);})]);
    const control=new DigitalProductionTaskService(f.db,'TEST native cancellation');
    expect(await control.controlResource(p.primary,resource,'cancel','TEST cancelled during evidence verification',randomUUID())).toMatchObject({state:'cancelled'});
   }finally{resumeVerification();probe.mockRestore();}
   const stopped=await inFlight;expect(stopped.statusCode,stopped.body).toBe(409);
   const conflict={code:'PREPARATION_CONFLICT',message:'订单或开发来源已暂停、取消，不能新增办理事实'};
   expect(stopped.json()).toMatchObject(conflict);
   for(const base of [orderBase,sourceBase]){
    const blocked=await post(base+'/upload-intents',file);expect(blocked.statusCode,blocked.body).toBe(409);expect(blocked.json()).toMatchObject(conflict);
    expect((await finalize(pending.attachmentId,base)).json()).toMatchObject(conflict);
    const read=await app.inject({method:'GET',url:base,headers});expect(read.statusCode,read.body).toBe(200);
    expect(read.json()).toMatchObject({canRecord:[],canAssign:false,canDeliverInstruction:false,canAcknowledgeAdoption:false,canAdopt:false,history:current.history});
   }
   expect((await post(orderBase+'/materials',input,key)).json()).toMatchObject(conflict);
   expect((await f.db.query('SELECT count(*)::int count FROM attachments WHERE uploaded_by=$1',[p.primary.actorId])).rows[0].count).toBe(attachmentsBefore);
   expect((await f.db.query('SELECT status,entity_type,entity_id FROM attachments WHERE attachment_id=$1',[pending.attachmentId])).rows[0])
    .toEqual({status:'pending',entity_type:null,entity_id:null});
   const url=orderBase+'/attachments/'+original.attachmentId;
   const download=await app.inject({method:'GET',url,headers});expect(download.statusCode,download.body).toBe(302);expect(download.headers.location).toBeTruthy();
   expect((await app.inject({method:'GET',url,headers:{cookie:'dx_rework_session=unrelated'}})).statusCode).toBe(403);
  }finally{await app.close();}
 });

 it('keeps an unfinished paper/marker clock when the same round receives another instruction version',async()=>{
  const scene=await f.scene('2026-11-20T00:00:00Z');let ready!:Awaited<ReturnType<typeof f.bulkReady>>,oldDue='';
  await f.runtime.run(scene,f.root,async()=>{ready=await f.bulkReady('无',undefined,1,f.sourcing,{stopBeforeCompletion:true});oldDue=(await bulk.read(f.root,ready.id)).tasks.find(t=>t.taskKind==='bulk_pattern')!.dueAt!;});
  await f.advance(scene,'2026-11-20T06:00:00Z');await f.runtime.run(scene,f.root,async()=>{
   const sheet=await instruction.read(ready.primary,ready.id);await instruction.save(ready.primary,ready.id,{expectedVersion:sheet.version,orderVersion:sheet.order.version,document:{...sheet.document,comments:'TEST same-round instruction clarification'}},randomUUID());
   const current=await instruction.read(ready.primary,ready.id);await instruction.publish(ready.primary,ready.id,{expectedVersion:current.version,orderVersion:current.order.version,expectedReadinessRevision:current.readiness!.revision},randomUUID());
   const after=await bulk.read(f.root,ready.id);expect(after.preparationId).not.toBe(ready.preparationId);expect(after.tasks.find(t=>t.taskKind==='bulk_pattern')!.dueAt).toBe(oldDue);
   const prep=(await f.db.query('SELECT clock_origin_preparation_id,supplement_of_preparation_id FROM digital_bulk_preparations WHERE preparation_id=$1',[after.preparationId])).rows[0];expect(prep).toMatchObject({clock_origin_preparation_id:ready.preparationId,supplement_of_preparation_id:null});
  });
 });
 it('retains the actual old72h sheet snapshot during explicit in-flight adoption without backfilling confirmation or completion',async()=>{
  const p=await setup(),created=await historicalDigitalOrder(f.db,p.designer,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:p.style,orderDate:beijingCalendarDate(businessNow()),primaryMerchandiserId:p.primary.actorId,lines:[{formalPoNo:`TEST-OLD-${randomUUID()}`,color:'黑',customerWarehouseArrivalDate:'2027-08-15',sizes:[{size:'M',quantity:10}]}]}),{slaBeforePreparation:true});
  await identity.attachSource(p.designer,created.productionOrderId,p.sourceId,randomUUID());const id=created.productionOrderId;
  await confirmedTechnicalFixture(f.db,f.root,p.sourceId,p.document,(await forms.read(f.root,p.sourceId)).version,f.people['pattern-room-worker']!.actorId);
  const order=await identity.read(p.primary,id),doc={...initialInstruction(),unit:'cm' as const,styleName:'TEST historical sheet',category:'上衣',date:beijingCalendarDate(businessNow()),preshrink:'无需预缩' as const,sizes:['M'],measurements:[{id:randomUUID(),name:'胸围',tolerance:'±1',method:'平量',values:['48']}],images:[{attachmentId:p.photo,kind:'款图' as const,description:'TEST'}]};
  await instruction.save(p.primary,id,{expectedVersion:0,orderVersion:order.version,sourceRound:1,document:doc},randomUUID());await instruction.publish(p.primary,id,{expectedVersion:1,orderVersion:order.version},randomUUID());
  const sla=new SlaOrderService(f.db),before=await sla.read(f.root,id),snapshots=(await f.db.query('SELECT * FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision',[id])).rows;
  expect(before.status).toBe('planned');if(before.status!=='planned')throw Error('missing historical SLA fixture');expect(before.current.plan.nodes.find(n=>n.id==='production_sheet')!.minutes).toBe(4320);
  const preview=await service.read(p.primary,{kind:'order',id});expect(preview.enrolled).toBe(false);
  const ack=await service.adopt(p.primary,{kind:'order',id},{previewRevision:preview.revision,reason:'TEST main merchandiser reviewed current evidence'},randomUUID(),true);expect(ack.adoptionAcknowledged).toBe(true);
  await expect(service.adopt(p.primary,{kind:'order',id},{previewRevision:preview.revision,reason:'TEST unauthorized own adoption'},randomUUID())).rejects.toMatchObject({statusCode:403});
  await service.adopt(f.root,{kind:'order',id},{previewRevision:preview.revision,reason:'TEST explicit manager adoption; keep completed history'},randomUUID());
  const after=await sla.read(f.root,id);expect(after.status).toBe('planned');if(after.status!=='planned')throw Error('missing retained SLA');expect(after.facts.production_sheet).toEqual(before.facts.production_sheet);
  expect((await f.db.query('SELECT * FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision',[id])).rows).toEqual(snapshots);
  expect((await f.db.query('SELECT count(*)::int AS n FROM digital_preparation_windows WHERE production_order_id=$1',[id])).rows[0].n).toBe(0);
  const calculation=await new SlaCalculationService(f.db).preview(f.root,{selection:{mode:'instance',kind:'order',id,range:'preparation'}});
  expect(calculation.context.bindings.preparation).toMatchObject({retainLegacy:true});
  expect(calculation.current.rows.find(n=>n.id==='production_sheet')).toMatchObject({minutes:4320,basis:'actual',end:{at:before.facts.production_sheet!.completedAt}});
  expect(calculation.current.rows.some(n=>['preparation_draft','preparation_final'].includes(n.id))).toBe(false);
  expect((await bulk.read(f.root,id)).instructionValid).toBe(true);
 });

 it.each([['quantity','120米'],['width','150cm'],['weight','180g/m²'],['composition','100%聚酯']] as const)('lets a genuine preorder draft invest without a formal order and renews evidence after a %s change',async(changedField,changedValue)=>{
  const designer=f.people['sample-designer']!,primary=f.people.merchandiser!,style=`TEST-PREORDER-${randomUUID()}`,source=await identity.createSource(designer,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID(),true),photo=await f.image(designer),unshared=await f.image(designer),materialId=randomUUID(),accessoryId=randomUUID();
  const p={designer,primary,document:documentFixture(photo,{available:false})};
  const document={...p.document,quantity:null,sampleSize:'',sizes:[],sizeQuantities:[],measurements:[],materials:[{...p.document.materials[0]!,materialId,quantity:'100米，预单投料量'},{...p.document.materials[0]!,materialId:accessoryId,category:'辅料' as const,name:'TEST原辅料',quantity:'15枚'}],files:[{attachmentId:photo,kind:'款图' as const},{attachmentId:unshared,kind:'局部图' as const}],customerOrderDraft:{withOrder:true,stage:'preorder' as const,order:InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,temporaryStyleNo:null,orderDate:'',contractDeliveryDate:null,lines:[{color:'',deliveryDate:null,sizes:[{size:'',quantity:''}]}]})}};
  const saved=await forms.save(p.designer,source.sourceId,{expectedVersion:0,document},randomUUID());
  expect(saved).toMatchObject({status:'draft',materialEvents:[],document:{materials:[{available:false},{available:false}]}});
  await expect(forms.publish(p.designer,source.sourceId,saved.version,randomUUID())).rejects.toMatchObject({statusCode:400});
  const resource={kind:'source' as const,id:source.sourceId};
  const handed=await service.record(p.designer,resource,{kind:'design_handover',scopeRef:'whole',expectedVersion:0,state:'ready',occurredAt:businessNow().toISOString(),note:'TEST预单投料资料已交订单跟单',quantities:[],evidenceIds:[],sourceDocumentVersion:saved.version,recipientId:p.primary.actorId},randomUUID());
  expect(handed.sourceIsPreorderDraft).toBe(true);expect(handed.facts[0]!.handoverMaterials?.[0]?.quantity).toBe('100米，预单投料量');
  await service.record(f.root,resource,{kind:'design_handover',scopeRef:'whole',expectedVersion:1,state:'ready',occurredAt:businessNow().toISOString(),note:'TEST原生Root核对并复用当前已保存投料凭证',quantities:[],evidenceIds:[photo],sourceDocumentVersion:saved.version,recipientId:p.primary.actorId},randomUUID());
  const handoverId=handed.facts[0]!.recordId;
  expect(await materialInvestmentTodos(f.db,p.primary,{todoId:handoverId})).toMatchObject([{todoId:handoverId,dueAt:null,
   route:{routeName:'digital_source_material_investment',entityId:source.sourceId,todoId:handoverId}}]);
  expect(await materialInvestmentTodos(f.db,f.people.warehouse!,{todoId:handoverId})).toEqual([]);
  await expect(forms.read(p.primary,source.sourceId)).rejects.toMatchObject({statusCode:404});
  const body={kind:'material_investment' as const,scopeRef:'whole',expectedVersion:0,state:'ready' as const,occurredAt:businessNow().toISOString(),
   note:'TEST实际投料',quantities:[{lineId:null,materialId,name:'TEST棉布',quantity:100,unit:'米'}],evidenceIds:[photo],sourceDocumentVersion:null,recipientId:null};
  expect(await service.canDownload(p.primary,resource,unshared)).toBe(false);
  await expect(service.record(p.primary,resource,{...body,evidenceIds:[unshared]},randomUUID())).rejects.toMatchObject({statusCode:403});
  const key=randomUUID(),partial=await service.record(p.primary,resource,body,key);
  expect((await service.record(p.primary,resource,body,key)).facts).toEqual(partial.facts);
  expect(partial.facts.find(f=>f.kind==='material_investment')).toMatchObject({state:'partial',valid:true});
  expect(await materialInvestmentTodos(f.db,p.primary,{todoId:handoverId})).toHaveLength(1);
  const invested=await service.record(p.primary,resource,{...body,expectedVersion:1,
   quantities:[{lineId:null,materialId:accessoryId,name:'TEST原辅料',quantity:15,unit:'枚'}]},randomUUID());
  expect(invested.orderId).toBeNull();expect(invested.facts.find(f=>f.kind==='material_investment')).toMatchObject({state:'ready',version:2,valid:true,
   quantities:[expect.objectContaining({materialId,quantity:100}),expect.objectContaining({materialId:accessoryId,quantity:15})]});
  expect(await materialInvestmentTodos(f.db,p.primary,{todoId:handoverId})).toEqual([]);
  expect((await f.db.query('SELECT count(*)::int AS n FROM digital_production_orders WHERE source_id=$1',[source.sourceId])).rows[0].n).toBe(0);
  expect((await forms.read(p.designer,source.sourceId)).status).toBe('draft');
  const edited=await forms.save(p.designer,source.sourceId,{expectedVersion:saved.version,document:{...document,instructions:'TEST非材料文字订正'}},randomUUID());
  expect((await service.read(p.primary,resource)).facts.find(f=>f.kind==='material_investment')).toMatchObject({state:'ready',valid:true});
  const revised=await forms.save(p.designer,source.sourceId,{expectedVersion:edited.version,document:{...document,materials:document.materials.map(row=>row.materialId===materialId?{...row,[changedField]:changedValue}:row)}},randomUUID());
  await expect(service.read(p.primary,resource)).rejects.toMatchObject({statusCode:403});
  expect((await service.read(f.root,resource)).history.find(f=>f.kind==='design_handover')?.handoverMaterials?.[0]?.quantity).toBe('100米，预单投料量');
  await service.record(p.designer,resource,{kind:'design_handover',scopeRef:'whole',expectedVersion:2,state:'ready',occurredAt:businessNow().toISOString(),
   note:'TEST 补交主布新规格，原辅料不重投',quantities:[],evidenceIds:[],sourceDocumentVersion:revised.version,recipientId:p.primary.actorId},randomUUID());
  const renewed=(await service.read(p.primary,resource)).facts.find(f=>f.kind==='material_investment')!;
  expect(renewed).toMatchObject({state:'partial',version:2,recordId:invested.facts.find(f=>f.kind==='material_investment')!.recordId});
  expect(await materialInvestmentTodos(f.db,p.primary,{todoId:handoverId})).toHaveLength(1);
  const correction={...body,expectedVersion:2,investmentMaterialId:materialId,quantities:[{...body.quantities[0]!,quantity:changedField==='quantity'?120:100}]};
  await expect(service.record(p.primary,resource,correction,randomUUID())).rejects.toMatchObject({statusCode:403});
  const completed=await service.record(p.primary,resource,{...correction,evidenceIds:[]},randomUUID());
  const final=completed.facts.find(f=>f.kind==='material_investment')!;
  expect(final).toMatchObject({state:'ready',version:3,recordId:renewed.recordId});
  expect(final.investmentMaterialOccurrences?.[accessoryId]).toEqual(renewed.investmentMaterialOccurrences?.[accessoryId]);
  expect(await materialInvestmentTodos(f.db,p.primary,{todoId:handoverId})).toEqual([]);
 });

 it('restricts preorder handover files, prior writes and receipts after the actual recipient changes',async()=>{
  const designer=f.people['sample-designer']!,first=f.people.merchandiser!,second=(await r5RoleFixture(f.db,f.access,f.root,'order_merchandiser')).actor;
  const style='TEST-PREORDER-RECIPIENT-'+randomUUID(),materialId=randomUUID();
  const {sourceId}=await identity.createSource(designer,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID(),true);
  const resource={kind:'source' as const,id:sourceId},oldShared=await f.image(designer),currentShared=await f.image(designer),oldReceipt=await f.image(first);
  const baseDocument=documentFixture(oldShared,{available:false}),draft=await forms.save(designer,sourceId,{expectedVersion:0,document:{
   ...baseDocument,materials:[{...baseDocument.materials[0]!,materialId,quantity:'20米'}],
   customerOrderDraft:{withOrder:true,stage:'preorder',order:InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,temporaryStyleNo:null,orderDate:'',contractDeliveryDate:null,lines:[{color:'',deliveryDate:null,sizes:[{size:'',quantity:''}]}]})}}},randomUUID());
  expect(draft).toMatchObject({status:'draft',materialEvents:[],document:{materials:[{available:false}]}});
  const at=businessNow().toISOString(),handover=async(version:number,recipientId:string,evidenceIds:string[])=>service.record(designer,resource,{
   kind:'design_handover',scopeRef:'whole',expectedVersion:version,state:'ready',occurredAt:at,note:'TEST actual handover '+version,
   quantities:[],evidenceIds,sourceDocumentVersion:draft.version,recipientId},randomUUID());
  await handover(0,first.actorId,[oldShared]);
  const purchase={kind:'material_investment' as const,scopeRef:'whole',expectedVersion:0,state:'ready' as const,occurredAt:at,
   note:'TEST original purchase',quantities:[{lineId:null,materialId,name:'TEST主布',quantity:20,unit:'米'}],evidenceIds:[oldShared,oldReceipt],sourceDocumentVersion:null,recipientId:null};
  const key=randomUUID(),receipt=await service.record(first,resource,purchase,key),app=Fastify();
  const users={first,second};
  const deps={service:identity,creationEnabled:true,authenticate:async(token:string|undefined)=>{const who=users[token as keyof typeof users];if(!who)throw new ApplicationError('UNAUTHORIZED','TEST login required',401);return {id:who.actorId,displayName:'TEST ordinary merch',businessRoles:who.actorRoles,capabilities:['digital_production:view']};}};
  app.setErrorHandler((error,_request,reply)=>{const e=error as ApplicationError;void reply.code(e.statusCode??500).send({code:e.code});});
  registerProductionReadinessRoutes(app,deps,service,f.attachments);await app.ready();
  const base='/digital-production/sources/'+sourceId+'/production-readiness';
  const get=(who:keyof typeof users,id?:string)=>app.inject({method:'GET',url:base+(id?'/attachments/'+id:''),headers:{cookie:'dx_rework_session='+who}});
  try{
   expect((await get('first',oldShared)).statusCode).toBe(302);
   expect((await get('first',oldReceipt)).statusCode).toBe(302);
   await handover(1,second.actorId,[currentShared]);
   expect((await get('first',oldShared)).statusCode).toBe(403);
   await expect(service.record(first,resource,purchase,key)).rejects.toMatchObject({statusCode:403});
   const response=await get('second');
   expect(response.statusCode).toBe(200);
   expect(response.body).not.toContain(oldShared);
   expect(response.body).not.toContain(oldReceipt);
   expect(response.json().history.filter((row:{kind:string})=>row.kind==='design_handover')).toMatchObject([{version:2,evidenceIds:[currentShared]}]);
   expect(response.json().facts.find((row:{kind:string})=>row.kind==='material_investment')).toMatchObject({recordId:receipt.facts.find(row=>row.kind==='material_investment')!.recordId,version:1,state:'ready',evidenceIds:[]});
   expect((await get('second',oldShared)).statusCode).toBe(403);
   expect((await get('second',oldReceipt)).statusCode).toBe(403);
   expect((await get('second',currentShared)).statusCode).toBe(302);
   await expect(service.record(second,resource,{...purchase,expectedVersion:1,evidenceIds:[oldReceipt]},randomUUID())).rejects.toMatchObject({statusCode:403});
   await handover(2,first.actorId,[currentShared]);
   const recovered=await service.record(first,resource,purchase,key);
   expect(JSON.stringify(recovered)).not.toContain(oldShared);
   expect(recovered.facts.find(row=>row.kind==='material_investment')).toMatchObject({version:1,evidenceIds:[oldReceipt]});
   expect((await get('first',oldShared)).statusCode).toBe(403);
   expect((await get('first',oldReceipt)).statusCode).toBe(302);
   const history=(await service.read(f.root,resource)).history;
   expect(history.filter(row=>row.kind==='design_handover')).toHaveLength(3);
   expect(history.find(row=>row.kind==='material_investment')?.evidenceIds).toEqual([oldShared,oldReceipt]);
  }finally{await app.close();}
 });

 it('counts physical labels only as normalized pieces, never as boxes or lengths',async()=>{
  const p=await setup(),created=await order(p),resource={kind:'order' as const,id:created.productionOrderId},line=(await identity.read(p.primary,resource.id)).lines[0]!.lineId;
  const q={lineId:line,materialId:null,name:'TEST款号唛',quantity:60,unit:'枚'},body={kind:'style_label_ready' as const,scopeRef:'whole',expectedVersion:0,state:'ready' as const,occurredAt:businessNow().toISOString(),note:'TEST discrete pieces, no package conversion',quantities:[q],evidenceIds:[],sourceDocumentVersion:null,recipientId:null};
  for(const unit of ['箱','米'])await expect(service.record(p.warehouse,resource,{...body,quantities:[q,{...q,name:'TEST第二批',quantity:40,unit}]},randomUUID())).rejects.toThrow('款号唛须按');
  await service.record(p.warehouse,resource,body,randomUUID());expect(await styleLabelCuttingReason(f.db,resource.id,[line],100)).toContain('款号唛');
  const saved=await service.record(p.warehouse,resource,{...body,expectedVersion:1,quantities:[q,{...q,name:'TEST第二批',quantity:40,unit:'个'}]},randomUUID());expect(saved.facts.find(x=>x.kind==='style_label_ready')!.quantities.map(q=>q.unit)).toEqual(['枚','枚']);expect(await styleLabelCuttingReason(f.db,resource.id,[line],100)).toBeNull();
 });
 it('invalidates warehouse readiness in the receipt correction transaction and rejects stale preshrink completion',async()=>{
  const ready=await f.bulkReady('无',undefined,1,f.sourcing,{stopBeforeCompletion:true}),resource={kind:'order' as const,id:ready.id};
  const before=await bulk.read(f.root,ready.id);expect(before.tasks.find(t=>t.taskKind==='warehouse_preshrink')!.state).toBe('ready');
  const current=await service.read(f.root,resource),receipt=current.facts.find(x=>x.kind==='fabric_receipt');
  const selection={mode:'instance' as const,kind:'order' as const,id:ready.id,range:'preparation' as const},calculator=new SlaCalculationService(f.db),calculatedBefore=await calculator.preview(f.root,{selection});
  const windows=calculatedBefore.current.rows.filter(n=>n.id==='preparation_draft'||n.id==='preparation_final');
  expect(windows).toHaveLength(2);expect(windows.every(n=>n.start.at!==null)).toBe(true);
  expect(windows.find(n=>n.id==='preparation_final')!.basis).toBe('actual');
  await service.record(f.people.warehouse!,resource,{kind:'fabric_receipt',scopeRef:'whole',expectedVersion:receipt?.version??0,state:'unknown',occurredAt:null,note:'TEST receipt corrected to unknown after earlier release',quantities:[],evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
  const after=await bulk.read(f.root,ready.id);expect(after.fabric!.usable).toBe(false);expect(after.tasks.find(t=>t.taskKind==='warehouse_preshrink')!.state).not.toBe('ready');
  const calculatedAfter=await calculator.preview(f.root,{selection});
  expect(calculatedAfter.current.rows.filter(n=>n.id==='preparation_draft'||n.id==='preparation_final')).toEqual(windows);
  expect(calculatedAfter.contextDigest).not.toBe(calculatedBefore.contextDigest);
  await expect(completeBulkRangeFixture(f.db,f.people.warehouse!,ready.id,ready.preparationId,'预缩完成')).rejects.toMatchObject({statusCode:409});
  expect((await bulk.read(f.root,ready.id)).facts.some(x=>x.kind==='预缩完成')).toBe(false);expect((await bulk.read(f.root,ready.id)).tasks.some(t=>t.taskKind==='bulk_cutting')).toBe(false);
 });
 it.each(['native_tail','confirmed_repeat'] as const)('starts final24h immediately when %s is the last prerequisite',async last=>{
  const scene=await f.scene('2026-12-01T00:00:00Z');let p!:Awaited<ReturnType<typeof setup>>,id='';
  await f.runtime.run(scene,f.root,async()=>{p=await setup();id=(await order(p)).productionOrderId;await record(p,{kind:'order',id},'fabric_receipt');
   await confirmedTechnicalFixture(f.db,f.root,p.sourceId,p.document,(await forms.read(f.root,p.sourceId)).version,f.people['pattern-room-worker']!.actorId);
   const receipt=(await service.read(f.root,{kind:'order',id})).facts.find(x=>x.kind==='fabric_receipt')!;await bulk.reportFabric(p.warehouse,id,{expectedReportId:null,expectedReceiptVersion:receipt.version,material:'TEST fabric',arrivedAt:receipt.occurredAt,inspectedAt:businessNow().toISOString(),result:'合格',note:'TEST earlier quality release'},randomUUID());
   expect((await service.read(p.primary,{kind:'order',id})).finalWindow.startedAt).toBeNull();expect((await preparationWindowTodos(f.db,p.primary)).some(t=>t.entityId===id&&t.taskTitle==='前提已齐：发布有效制单')).toBe(false);
  });
  await f.advance(scene,'2026-12-01T06:00:00Z');await f.runtime.run(scene,f.root,async()=>{
   if(last==='confirmed_repeat'){
    await new DevelopmentTechnicalService(f.db,true).savePreparationBasis(p.designer,p.sourceId,{roundNumber:1,expectedVersion:0,basis:'confirmed_repeat',finalFabric:true,finalCraft:true,sampleEvidenceIds:[p.photo],customerFabricEvidenceIds:[p.photo],note:'TEST designer now confirms original sample and customer fabric evidence'},randomUUID());
   }else{
    // Fixture creates a real tail task; the native execution command still enforces photo and measured-size evidence.
    const client=await f.db.connect();let taskId='';try{await client.query('BEGIN');const tasks=new DigitalProductionTaskService(f.db),inspector=Object.values(f.people).find(p=>p.actorRoles.includes('pattern_room_tail_inspector'))!;const task=await tasks.createWithClient(client,f.root,{resource:{kind:'source',id:p.sourceId},kind:'development_tail_check',routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:inspector.actorId});taskId=task.taskId;await tasks.setConditionWithClient(client,f.root,taskId,'washing_finished',true,undefined,'TEST native no-wash applicability');await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    const execution=new DevelopmentExecutionService(f.db,true),photo=await f.image(f.root);await execution.recordUploadPurpose(f.root,p.sourceId,photo,'尾查照片',taskId);
    await execution.route(f.root,p.sourceId,{taskId,note:'TEST native last tail prerequisite',result:'通过',craftExecution:null,nextAssigneeId:null,sentDate:null,trackingNo:null,attachmentIds:[photo],measurements:[{name:'胸围',values:['48']}]},randomUUID());
   }
   const state=await service.read(p.primary,{kind:'order',id});expect(state.finalReasons).toEqual([]);expect(state.finalWindow.startedAt).toBe('2026-12-01T06:00:00.000Z');expect(state.finalWindow.dueAt).toBe('2026-12-02T06:00:00.000Z');expect((await preparationWindowTodos(f.db,p.primary)).filter(t=>t.entityId===id&&t.taskTitle==='前提已齐：发布有效制单')).toHaveLength(1);
  });
 });
 it('does not reuse an earlier SLA application for new supplemental work and preserves an explicitly applied unfinished supplement across replacement',async()=>{
  const scene=await f.scene('2026-12-10T00:00:00Z'),applications=new SlaOrderApplicationService(f.db,'TEST supplemental preview secret '.repeat(3));let ready!:Awaited<ReturnType<typeof f.bulkReady>>,version=0,oldValues!:Awaited<ReturnType<SlaConfigurationRepository['initialStandard']>>['values'];
  const apply=async()=>{const input={orderId:ready.id,configurationVersion:version,parameterKeys:['bulk_pattern'],reason:'TEST explicitly apply only existing unfinished work'},preview=await applications.preview(f.root,input);return applications.apply(f.root,{...input,previewToken:preview.token},randomUUID());};
  const replace=async(note:string)=>{const old=await instruction.read(ready.primary,ready.id);await instruction.save(ready.primary,ready.id,{expectedVersion:old.version,orderVersion:old.order.version,document:{...old.document,comments:note}},randomUUID());const saved=await instruction.read(ready.primary,ready.id);await instruction.publish(ready.primary,ready.id,{expectedVersion:saved.version,orderVersion:saved.order.version,expectedReadinessRevision:saved.readiness!.revision},randomUUID());return bulk.read(f.root,ready.id);};
  await f.runtime.run(scene,f.root,async()=>{ready=await f.bulkReady('无',undefined,1,f.sourcing,{stopBeforeCompletion:true});});const client=await f.db.connect();try{await client.query('BEGIN');const config=await new SlaConfigurationRepository(client).initialStandard(f.root.actorId);oldValues=config.values;const values={...config.values,bulk_pattern:{kind:'duration' as const,minutes:3600}};version=(await new SlaConfigurationService().publishNewStandard(client,f.root,{expectedVersion:config.version,values,reason:'TEST sixty hour explicit standard',requestKey:randomUUID()})).version;await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}await f.runtime.run(scene,f.root,async()=>{await apply();for(const kind of ['纸样完成','唛架完成'] as const)await completeBulkRangeFixture(f.db,f.people['pattern-room-worker']!,ready.id,ready.preparationId,kind);});
  const restoreDefault=async()=>{const client=await f.db.connect();try{await client.query('BEGIN');const config=await new SlaConfigurationRepository(client).current();await new SlaConfigurationService().publishNewStandard(client,f.root,{expectedVersion:config!.version,values:oldValues,reason:'TEST restore default after explicit-application regression',requestKey:randomUUID()});await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}};
  try{
   await f.advance(scene,'2026-12-10T04:00:00Z');let supplementalId='',due='';await f.runtime.run(scene,f.root,async()=>{const next=await replace('TEST S1 new work after completed original');supplementalId=next.preparationId!;expect(next.tasks.find(t=>t.taskKind==='bulk_pattern')!.dueAt).toBeNull();});
   await f.advance(scene,'2026-12-10T06:00:00Z');await f.runtime.run(scene,f.root,async()=>{const next=await replace('TEST S2 replaces S1 before any explicit deadline');expect(next.tasks.find(t=>t.taskKind==='bulk_pattern')!.dueAt).toBeNull();await apply();due=(await bulk.read(f.root,ready.id)).tasks.find(t=>t.taskKind==='bulk_pattern')!.dueAt!;expect(due).toBe('2026-12-12T16:00:00.000Z');});
   await f.advance(scene,'2026-12-10T08:00:00Z');await f.runtime.run(scene,f.root,async()=>{const next=await replace('TEST S3 replaces explicitly applied S2, retains S1 window root');expect(next.preparationId).not.toBe(supplementalId);expect(next.tasks.find(t=>t.taskKind==='bulk_pattern')!.dueAt).toBe(due);const row=(await f.db.query('SELECT clock_origin_preparation_id,supplement_of_preparation_id FROM digital_bulk_preparations WHERE preparation_id=$1',[next.preparationId])).rows[0];expect(row).toMatchObject({clock_origin_preparation_id:supplementalId,supplement_of_preparation_id:ready.preparationId});await bulk.dispatch(f.root,ready.id,{expectedVersion:next.dispatch.version,patternWorkerId:f.people['pattern-room-worker']!.actorId,deliverPattern:true},randomUUID());for(const kind of ['纸样完成','唛架完成'] as const)await completeBulkRangeFixture(f.db,f.people['pattern-room-worker']!,ready.id,next.preparationId!,kind);});
   await f.advance(scene,'2026-12-10T10:00:00Z');await f.runtime.run(scene,f.root,async()=>{const next=await replace('TEST S4 is genuinely new work after S3 completed');expect(next.tasks.find(t=>t.taskKind==='bulk_pattern')!.dueAt).toBeNull();});
  }finally{await restoreDefault();}
 });

 it('reads original partial range evidence through the same private order attachment authority',async()=>{
  const scene=await f.scene('2026-11-02T00:00:00Z');await f.runtime.run(scene,f.root,async()=>{
   const ready=await f.bulkReady('无',undefined,1,f.sourcing,{stopBeforeCompletion:true}),worker=f.people['pattern-room-worker']!,resource={kind:'order' as const,id:ready.id};
   const bytes=await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer(),sha256=createHash('sha256').update(bytes).digest('hex');
   const upload=await f.attachments.createUploadIntent(worker,{filename:'TEST original range evidence.png',mimeType:'image/png',sizeBytes:bytes.length,sha256});await f.storage.writeImmutable(upload.objectKey,bytes,{mimeType:'image/png',sha256});await f.attachments.finalize(worker,upload.attachmentId);
   const state=await service.read(worker,resource);
   await bulk.complete(worker,ready.id,{preparationId:ready.preparationId,kind:'纸样完成',expectedReadinessRevision:state.revision,range:{expectedVersion:0,lineIds:[state.lines[0]!.lineId],complete:false,pendingMaterialIds:[],note:'TEST actual partial work with original evidence',evidenceIds:[upload.attachmentId]}},randomUUID());
   const read=await service.read(ready.primary,resource),range=read.ranges.at(-1)!;expect(range.evidenceIds).toEqual([upload.attachmentId]);expect(range.basis).toMatchObject({readinessRevision:state.revision,technicalRevision:state.technicalRevision});expect(range.complete).toBe(false);
   await expect(f.attachments.createDownloadIntent(ready.primary,upload.attachmentId,()=>service.canDownload(ready.primary,resource,upload.attachmentId),'inline')).resolves.toHaveProperty('downloadUrl');
   const other=await setup(),otherOrder=await order(other),otherResource={kind:'order' as const,id:otherOrder.productionOrderId};
   expect(await service.canDownload(other.primary,otherResource,upload.attachmentId)).toBe(false);await expect(f.attachments.createDownloadIntent(other.primary,upload.attachmentId,()=>service.canDownload(other.primary,otherResource,upload.attachmentId),'inline')).rejects.toMatchObject({statusCode:403});
   expect((await bulk.read(worker,ready.id)).facts.some(f=>f.kind==='纸样完成')).toBe(false);
  });
 });
 it('pages actual fabric history through original GET authority and rejects another orders cursor',async()=>{
  const scene=await f.scene('2026-11-02T00:00:00Z');await f.runtime.run(scene,f.root,async()=>{
   const p=await setup(),created=await order(p),oid=created.productionOrderId,closure=new OrderClosureService(f.db);
   let previous:string|null=null;for(let n=0;n<21;n++){
    const state=await service.read(p.warehouse,{kind:'order',id:oid});await bulk.reportFabric(p.warehouse,oid,{expectedReportId:previous,expectedReceiptVersion:state.facts.find(m=>m.kind==='fabric_receipt')?.version??0,material:'TEST original reported fabric',arrivedAt:businessNow().toISOString(),inspectedAt:businessNow().toISOString(),result:'合格',note:`TEST actual report ${n}`},randomUUID());previous=(await bulk.read(p.warehouse,oid)).fabric!.report!.reportId;
   }
   const first=await bulk.documentHistory(p.primary,oid);expect(first.items).toHaveLength(20);expect(first.nextBeforeId).toBeTruthy();const second=await bulk.documentHistory(p.primary,oid,first.nextBeforeId!);expect(second.items).toHaveLength(1);expect(new Set([...first.items,...second.items].map(v=>v.eventId)).size).toBe(21);expect(second.nextBeforeId).toBeNull();
   const other=await setup(),otherOrder=await order(other);await expect(bulk.documentHistory(f.root,otherOrder.productionOrderId,first.nextBeforeId!)).rejects.toMatchObject({statusCode:404});
   const app=Fastify(),deps={service:identity,creationEnabled:true,authenticate:async(token:string|undefined)=>{if(token!=='primary')throw new ApplicationError('UNAUTHORIZED','TEST login required',401);return {id:p.primary.actorId,displayName:'TEST primary',businessRoles:p.primary.actorRoles,capabilities:['digital_production:view']};}};
   app.setErrorHandler((error,_r,reply)=>{const e=error as ApplicationError;void reply.code(e.statusCode??500).send({code:e.code,message:e.message});});registerBulkPreparationRoutes(app,deps,bulk);registerOrderClosureRoutes(app,deps,closure);await app.ready();
   try{const url=`/digital-production/orders/${oid}/bulk-preparation/history`,headers={cookie:'dx_rework_session=primary'};expect((await app.inject({method:'GET',url})).statusCode).toBe(401);const native=await app.inject({method:'GET',url,headers});expect(native.statusCode).toBe(200);expect(native.json().items.map((v:{eventId:string})=>v.eventId)).toEqual(first.items.map(v=>v.eventId));expect((await app.inject({method:'GET',url:url+'?kind=anything',headers})).statusCode).toBe(400);expect((await app.inject({method:'GET',url:`/digital-production/orders/${oid}/closure/history`,headers})).json()).toMatchObject({orderId:oid,family:'receipt_quality',items:[]});
    await f.db.query('UPDATE identity_mappings SET employed=false WHERE user_id=$1',[p.primary.actorId]);expect((await app.inject({method:'GET',url,headers})).statusCode).toBe(404); // Same existence-hiding policy as the original bulk reader.
   }finally{await f.db.query('UPDATE identity_mappings SET employed=true WHERE user_id=$1',[p.primary.actorId]);await app.close();}
  });
 });

 const materialTimerFixture=async(fixture=f)=>{
  await prepareRewashSettings(fixture);
  const patternOrders=new PatternRoomOrderService(fixture.db,new TodoProjectionService(new TodoService(fixture.db)),{ordersEnabled:true});
  return {f:fixture,db:fixture.db,patternOrders,orderTimeRequests:new OrderTimeRequestService(fixture.db,orderTimeNativeExecutor(fixture.db,true,patternOrders))};
 };
 it('R1 exposes numbered options and warehouse routes through normal API startup',async()=>{
  const dbUrl=new URL(url!);
  const schema=(await f.db.query<{schema:string}>('SELECT current_schema() AS schema')).rows[0]!.schema;
  dbUrl.searchParams.set('options',`-c search_path=${schema}`);
  const labSecret=randomBytes(32).toString('base64url');
  for(const enabled of [false,true]){
   const socket=createServer().listen(0,'127.0.0.1');
   await once(socket,'listening');
   const address=socket.address();
   if(!address||typeof address==='string')throw Error('TEST expected a loopback server address');
   const {port}=address;
   await new Promise<void>((resolve,reject)=>socket.close(error=>error?reject(error):resolve()));
   const server=spawn(process.execPath,['--import','tsx','apps/api/src/server.ts'],{env:{
    PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),DATABASE_URL:dbUrl.toString(),
    DINGTALK_CORP_ID:'anchor-test',DINGTALK_H5_APP_KEY:'TEST',DINGTALK_H5_APP_SECRET:'TEST',
    DINGTALK_WEB_CLIENT_ID:'TEST',DINGTALK_WEB_CLIENT_SECRET:'TEST',DINGTALK_QR_REDIRECT_URI:'https://example.test/callback',
    ROOT_DINGTALK_USER_ID:'uat-root',SESSION_SECRET:randomBytes(32).toString('base64url'),ACCEPTANCE_LAB_ENABLED:'true',
    ACCEPTANCE_LAB_SECRET:labSecret,
    DIGITAL_PRODUCTION_ENABLED:'true',DIGITAL_PRODUCTION_CREATION_ENABLED:'true',
    DIGITAL_WORKBENCH_NUMBERED_CREATION_ENABLED:String(enabled),TODO_RUNTIME_ENABLED:'false',
    TODO_DELIVERY_ENABLED:'false',TODO_TIMING_ENABLED:'false',
   },stdio:['ignore','ignore','pipe']});
   const exited=once(server,'exit');
   let stderr='';
   server.stderr?.on('data',chunk=>{stderr+=String(chunk);});
   const origin=`http://127.0.0.1:${port}`;
   const route=(path:string,headers?:HeadersInit)=>fetch(`${origin}/digital-production/${path}`,{headers,signal:AbortSignal.timeout(3000)});
   const login=async(alias:string)=>{
    const response=await fetch(origin+'/auth/mobile',{method:'POST',headers:{'content-type':'application/json'},
     body:JSON.stringify({code:mintAcceptanceLoginCode(alias,labSecret)}),signal:AbortSignal.timeout(3000)});
    expect(response.status).toBe(200);
    return {cookie:response.headers.getSetCookie().find(cookie=>cookie.startsWith('dx_rework_session='))!.split(';',1)[0]!};
   };
   try{
    let online=false;
    for(let attempt=0;attempt<120&&!online&&server.exitCode===null;attempt++){
     online=await fetch(origin+'/health/live',{signal:AbortSignal.timeout(500)}).then(r=>r.ok,()=>false);
     if(!online)await delay(100);
    }
    if(!online)throw Error(`TEST normal API did not start: ${stderr}`);
    const designer=await login('sample-designer'),warehouse=await login('warehouse');
    const options=await (await route('options',designer)).json();
    expect(options).toMatchObject({creationEnabled:true});
    expect(options.workbenchNumberedCreation).toBe(enabled?true:undefined);
    expect((await route('sources/numbered-drafts/receipt',designer)).status).toBe(enabled?400:404);
    expect((await route('warehouse/receipts',warehouse)).status).toBe(enabled?200:404);
    const craft=await route(`orders/${randomUUID()}/factory-flow/warehouse-craft`,warehouse);
    expect(craft.status).toBe(404);
    if(enabled)expect(await craft.text()).toContain('资料不存在或不在授权范围');
   }finally{
    server.kill('SIGTERM');
    await exited;
   }
  }
 },testExecutionConfig.correctnessTimeoutMs);
 it('X3 guards native accessory issues and receipt corrections using only the current original lot and adopted demand',async()=>{
  const own=await businessAnchorFixture(url!);
  try{
   const {scene,id,warehouse,primary,bulk,preparation,scope:scoped,resource,batch,work,accessory,now,instructionVersion}=await warehouseOriginalIssueFixture(own);
   await own.runtime.run(scene,own.root,async()=>{
    expect(scoped).toMatchObject({issueOptions:[]});
    const input={supplierId:own.supplierId,instructionVersion,occurredAt:now,note:'TEST physical accessory issue'};
    await expect(bulk.dispatchMaterials(warehouse,id,{...input,items:[{materialId:scoped.id,quantity:1,unit:'米'}]},randomUUID())).rejects.toMatchObject({statusCode:409});
    expect(work).toMatchObject({materialId:accessory.materialId,productionRequired:{quantity:'500',unit:'米'},received:null});
    const saved=await preparation.recordWarehouseReceiptBatch(warehouse,resource,batch,randomUUID());
    expect(saved.history.filter(row=>row.warehouseReceipt?.materialId===accessory.materialId)).toMatchObject([{valid:true,warehouseReceipt:{quantity:'500'}}]);
    expect((await preparation.warehouseReceiptWork(warehouse,resource)).filter(item=>item.materialId===accessory.materialId))
     .toMatchObject([{received:{quantity:'500',unit:'米'},productionRequired:{quantity:'500',unit:'米'}}]);
    const page=(await bulk.read(warehouse,id)).materials!,option=page.items.find(item=>item.id===scoped.id)?.issueOptions?.[0];
    expect(page.canDispatch).toBe(true);
    expect(option).toMatchObject({required:'500',remaining:'500'});
    const lot=option!.lots[0]!.receipt;
    const command=(quantity:number,receipt=lot)=>({...input,items:[{materialId:scoped.id,quantity,unit:'米',
     scope:{scopeRef:'whole',lineId:null,allocations:[{receipt,quantity:String(quantity)}]}}]});
    await expect(bulk.dispatchMaterials(primary,id,command(300),randomUUID())).rejects.toMatchObject({statusCode:403});
    const key=randomUUID(),first=await bulk.dispatchMaterials(warehouse,id,command(300),key);
    const replay=await bulk.dispatchMaterials(warehouse,id,command(300),key);
    expect(JSON.parse(JSON.stringify(replay))).toEqual(JSON.parse(JSON.stringify(first)));
    expect((await bulk.read(warehouse,id)).materials?.history).toHaveLength(1);
    expect(first.materials?.items.find(item=>item.id===scoped.id)?.issueOptions?.[0]).toMatchObject({remaining:'200'});
    await expect(bulk.dispatchMaterials(warehouse,id,command(201),randomUUID())).rejects.toMatchObject({statusCode:409});
    await expect(preparation.recordWarehouseReceiptBatch(warehouse,resource,{...batch,expectedReceiptVersion:1,replaces:lot,quantity:'299'},randomUUID())).rejects.toMatchObject({statusCode:409});
    await preparation.recordWarehouseReceiptBatch(warehouse,resource,{...batch,expectedReceiptVersion:1,replaces:lot,quantity:'490'},randomUUID());
    await expect(bulk.dispatchMaterials(warehouse,id,command(10),randomUUID())).rejects.toMatchObject({statusCode:409});
    const next=command(190,{recordId:lot.recordId,version:2});
    const race=await Promise.allSettled([bulk.dispatchMaterials(warehouse,id,next,randomUUID()),
     bulk.dispatchMaterials(warehouse,id,{...next,note:'TEST same stock different request'},randomUUID())]);
    expect(race.filter(outcome=>outcome.status==='fulfilled')).toHaveLength(1);
    expect(race.find(outcome=>outcome.status==='rejected')).toMatchObject({reason:{statusCode:409}});
    const second=await bulk.read(warehouse,id);
    expect(second.materials?.history.map(row=>row.items[0]?.quantity)).toEqual([300,190]);
    const received=(await preparation.warehouseReceiptWork(warehouse,resource)).find(item=>item.materialId===accessory.materialId);
    expect(received).toMatchObject({received:{quantity:'490',unit:'米'},balance:{procurementRemaining:'30'}});
   });
  }finally{await own.dispose();}
 });
 it('X3 preserves the same preorder accessory lot for issue and correction after saving the first formal instruction',async()=>{
  const own=await businessAnchorFixture(url!);
  try{
   const fixture=await warehouseOriginalIssueFixture(own,{receiptBeforeFormal:true});
   const {scene,id,warehouse,bulk,preparation,resource,preorderReceipt,batch,accessory,instructionVersion,scope,now}=fixture;
   await own.runtime.run(scene,own.root,async()=>{
    const fact=(await preparation.read(warehouse,resource)).history.find(row=>row.recordId===preorderReceipt!.recordId&&row.version===1);
    expect(fact).toMatchObject({valid:true,resource:{kind:'source'},warehouseReceipt:{materialId:accessory.materialId,quantity:'500'}});
    expect((await preparation.warehouseReceiptWork(warehouse,resource)).filter(item=>item.materialId===accessory.materialId))
     .toMatchObject([{received:{quantity:'500',unit:'米'},activeBatches:[{ref:preorderReceipt}]}]);
    const listed=await preparation.warehouseReceipts(warehouse,{page:1,search:accessory.name,status:'open'});
    expect(listed.items).toEqual([expect.objectContaining({resource,materialId:accessory.materialId,received:{quantity:'500',unit:'米'}})]);
    const numbered=listed.items[0]!.issuedOrderNumber;
    expect(numbered).toBeTruthy();
    for(const search of [numbered!,numbered!+'-po1',numbered!+'-po2']){
     expect(await preparation.warehouseReceipts(warehouse,{page:1,search,status:'open'}))
      .toEqual({page:1,total:1,items:listed.items});
    }
    expect(await preparation.warehouseReceipts(warehouse,{page:2,search:numbered!+'-PO2',status:'open'}))
     .toEqual({page:2,total:1,items:[]});
    await expect(preparation.warehouseReceipts(own.people.merchandiser!,{page:1,search:numbered!+'-PO2',status:'open'}))
     .rejects.toMatchObject({statusCode:403});
    await bulk.dispatchMaterials(warehouse,id,{supplierId:own.supplierId,instructionVersion,occurredAt:now,note:'TEST original source receipt reused',
     items:[{materialId:scope.id,quantity:300,unit:'米',scope:{scopeRef:'whole',lineId:null,allocations:[{receipt:preorderReceipt!,quantity:'300'}]}}]},randomUUID());
    await expect(preparation.recordWarehouseReceiptBatch(warehouse,resource,{...batch,expectedReceiptVersion:1,replaces:preorderReceipt,quantity:'299'},randomUUID())).rejects.toMatchObject({statusCode:409});
    const correction=await preparation.recordWarehouseReceiptBatch(warehouse,resource,{...batch,expectedReceiptVersion:1,replaces:preorderReceipt,quantity:'490'},randomUUID());
    expect(correction.history.filter(row=>row.recordId===preorderReceipt!.recordId).map(row=>[row.version,row.valid,row.warehouseReceipt?.quantity])).toEqual([[2,true,'490'],[1,true,'500']]);
    expect((await preparation.warehouseReceiptWork(warehouse,resource)).filter(item=>item.materialId===accessory.materialId))
     .toMatchObject([{received:{quantity:'490',unit:'米'}}]);
   });
  }finally{await own.dispose();}
 });
 it('X3 uses the same assigned warehouse report and management decision for exact fabric receipt versions',async()=>{
  const own=await businessAnchorFixture(url!);
  try{
   const prepared=await warehouseOriginalIssueFixture(own,{fabricPurchase:true}),{scene,id,warehouse,bulk,preparation,resource,now,fabricBatch}=prepared;
   await own.runtime.run(scene,own.root,async()=>{
    expect(fabricBatch?.kind).toBe('fabric_receipt');
    const saved=await preparation.read(warehouse,resource);
    const record=saved.history.find(row=>row.warehouseReceipt?.kind==='fabric_receipt')!,current=await bulk.read(warehouse,id);
    const lot={materialId:fabricBatch!.materialId,receipt:{recordId:record.recordId,version:record.version}};
    const input={expectedReportId:current.fabric!.report!.reportId,expectedReceiptVersion:0,material:'TEST 同范围面料',
     arrivedAt:record.occurredAt,inspectedAt:now,result:'不合格' as const,note:'TEST actual lot inspection, independent of the arrival'};
    await expect(bulk.reportFabric(warehouse,id,{...input,receiptBatches:[{...lot,materialId:randomUUID()}]},randomUUID())).rejects.toMatchObject({statusCode:409});
    const report=await bulk.reportFabric(warehouse,id,{...input,receiptBatches:[lot]},randomUUID());
    expect(report.fabric).toMatchObject({usable:false,warehouseCoverageCurrent:true,report:{receiptBatches:[lot],result:'不合格'}});
    const issue=report.materials!.items.find(item=>item.kind==='fabric')!;
    expect(issue.issueOptions).toEqual([]);
    const issueBody={instructionVersion:report.instructionVersion!,supplierId:own.supplierId,occurredAt:now,note:'TEST exact qualified fabric issue',
     items:[{materialId:issue.id,unit:'米',quantity:300,scope:{scopeRef:'whole',lineId:null,allocations:[{receipt:lot.receipt,quantity:'300'}]}}]};
    await expect(bulk.dispatchMaterials(warehouse,id,issueBody,randomUUID())).rejects.toMatchObject({statusCode:409});
    const decision={reportId:report.fabric!.report!.reportId,expectedDecisionId:null,allowUse:true,note:'TEST explicit authorized decision for the exact inspection'};
    await expect(bulk.decideFabric(warehouse,id,decision,randomUUID())).rejects.toMatchObject({statusCode:403});
    const authorized=await bulk.decideFabric(own.root,id,decision,randomUUID());
    expect(authorized.fabric).toMatchObject({usable:true,warehouseCoverageCurrent:true});
    expect(authorized.materials?.items.find(item=>item.id===issue.id)?.issueOptions).toMatchObject([{remaining:'500'}]);
    const issueDone=await bulk.dispatchMaterials(warehouse,id,issueBody,randomUUID());
    expect(issueDone.materials?.items.find(item=>item.id===issue.id)?.issueOptions).toMatchObject([{remaining:'200'}]);
    await expect(preparation.recordWarehouseReceiptBatch(warehouse,resource,{...fabricBatch!,expectedReceiptVersion:1,replaces:lot.receipt,quantity:'299'},randomUUID()))
     .rejects.toMatchObject({statusCode:409});
    await preparation.recordWarehouseReceiptBatch(warehouse,resource,{...fabricBatch!,expectedReceiptVersion:1,replaces:lot.receipt,quantity:'490'},randomUUID());
    const changed=await bulk.read(warehouse,id);
    expect(changed.fabric).toMatchObject({usable:false,warehouseCoverageCurrent:false,report:{receiptBatches:[lot]},decision:{allowUse:true}});
    await expect(bulk.reportFabric(warehouse,id,{...input,expectedReportId:report.fabric!.report!.reportId},randomUUID())).rejects.toMatchObject({statusCode:409});
    const next={...lot,receipt:{...lot.receipt,version:2}};
    const revised=await bulk.reportFabric(warehouse,id,{...input,expectedReportId:report.fabric!.report!.reportId,result:'合格',receiptBatches:[next]},randomUUID());
    expect(revised.fabric).toMatchObject({usable:true,warehouseCoverageCurrent:true,report:{receiptBatches:[next]},decision:null});
    expect(revised.materials?.items.find(item=>item.id===issue.id)?.issueOptions).toMatchObject([{remaining:'190',lots:[{receipt:next.receipt}]}]);
   });
  }finally{await own.dispose();}
 });
 it('Acceptance R5 saves the draft without arrival, then separates 90% inspection from official publication',async()=>{
  const own=await businessAnchorFixture(url!);
  try{
   const merch=own.people.merchandiser!;
   const instructions=new ProductionInstructionService(own.db,true);
   const result=await warehouseOriginalIssueFixture(own,{fabricPurchaseQuantity:500,exerciseFabric:async({service,bulk,warehouse,orderId})=>{
    const resource={kind:'order' as const,id:orderId},now=businessNow().toISOString();
    const draft=await instructions.read(merch,orderId);
    expect(draft).toMatchObject({version:1,publishedVersion:null});
    const blockPublish=async()=>{
     const current=await instructions.read(merch,orderId),readiness=await service.read(merch,resource);
     await expect(instructions.publish(merch,orderId,{expectedVersion:current.version,orderVersion:current.currentOrderVersion,expectedReadinessRevision:readiness.revision},randomUUID()))
      .rejects.toMatchObject({statusCode:409});
    };
    const work=(await service.warehouseReceiptWork(warehouse,resource)).find(row=>row.kind==='fabric_receipt')!;
    const baseBatch={kind:'fabric_receipt',scopeRef:work.scopeRef,materialId:work.materialId,lineId:work.lineId,unit:'米',supplierId:work.basis.supplierId,
     investment:work.purchase.original,materialFingerprint:work.basis.adoptedRef,expectedReceiptVersion:0,occurredAt:now,note:'TEST native R5 fabric lot'};
    const report={expectedReportId:null,expectedReceiptVersion:0,material:work.name,arrivedAt:now,inspectedAt:now,result:'不合格' as const,note:'TEST actual R5 quality'};
    await blockPublish();
    await expect(bulk.reportFabric(warehouse,orderId,report,randomUUID())).rejects.toMatchObject({statusCode:409});
    const partial=await service.recordWarehouseReceiptBatch(warehouse,resource,{...baseBatch,quantity:'449'},randomUUID());
    const first=partial.history.find(row=>row.warehouseReceipt?.materialId===work.materialId)!;
    const references=[{materialId:work.materialId,receipt:{recordId:first.recordId,version:first.version}}];
    await expect(bulk.reportFabric(warehouse,orderId,{...report,receiptBatches:references},randomUUID())).rejects.toMatchObject({statusCode:409});
    const next=await service.recordWarehouseReceiptBatch(warehouse,resource,{...baseBatch,expectedReceiptVersion:1,quantity:'1'},randomUUID());
    const second=next.history.find(row=>row.warehouseReceipt?.materialId===work.materialId&&row.version===2)!;
    const known=await bulk.read(warehouse,orderId);
    expect(known.fabric).toMatchObject({warehouseInspection:{eligible:true},usable:false,report:null});
    await blockPublish();
    const rejected=await bulk.reportFabric(warehouse,orderId,{...report,receiptBatches:[...references,{materialId:work.materialId,receipt:{recordId:second.recordId,version:second.version}}]},randomUUID());
    expect(rejected.fabric).toMatchObject({usable:false,warehouseCoverageCurrent:true,report:{result:'不合格'}});
    await blockPublish();
    const accepted=await bulk.decideFabric(own.root,orderId,{reportId:rejected.fabric!.report!.reportId,expectedDecisionId:null,allowUse:true,note:'TEST original authorized quality decision'},randomUUID());
    expect(accepted.fabric).toMatchObject({usable:true,warehouseCoverageCurrent:true});
    expect((await service.warehouseReceiptWork(warehouse,resource)).find(row=>row.materialId===work.materialId)).toMatchObject({
     received:{quantity:'450',unit:'米'},balance:{procurementRemaining:'50'}});
    expect((await service.read(warehouse,resource)).facts.some(row=>row.kind==='fabric_receipt'&&row.state==='ready')).toBe(false);
   }});
   await own.runtime.run(result.scene,own.root,async()=>{
    expect(await instructions.read(merch,result.id)).toMatchObject({version:1,publishedVersion:1});
   });
  }finally{await own.dispose();}
 },50_000);
 it.each([{requiresColorMatching:true,fill:false},{requiresColorMatching:false,fill:false},{requiresColorMatching:false,fill:true},{requiresColorMatching:true,fill:true}])('X2 original preorder to T0, color matching=$requiresColorMatching and R4 confirmed fill=$fill',async({requiresColorMatching,fill})=>{
  const h=await materialTimerFixture(),persona=f.people['sample-designer']!,merch=f.people.merchandiser!,root=f.root;
  const capabilities=(await f.db.query<{capability:string}>("SELECT capability FROM role_capabilities WHERE role_code='sample_designer'")).rows.map(row=>row.capability);
  const designer={...persona,authorizationCapabilities:capabilities};
  const calendars=new OrderTimeSettingsService(f.db,true,true),currentCalendar=await calendars.read(root);
  const purchase=currentCalendar.current.nodes.material_investment;
  if(purchase?.kind!=='event')throw Error('TEST missing original purchase lead time');
  await calendars.save(root,{expectedVersion:currentCalendar.version,values:{...currentCalendar.current,
   nodes:{...currentCalendar.current.nodes,material_investment:{...purchase,accessoriesLeadTime:{minutes:1440,calendar:'continuous'}}}}},randomUUID());
  const started='2026-11-20T04:00:00.000Z',investedAt='2026-11-22T04:00:00.000Z',formalAt='2026-12-01T04:00:00.000Z';
  const scene=await f.scene(started),identity=new DigitalProductionIdentityService(f.db,true),forms=new DigitalDevelopmentService(f.db,true,h.patternOrders);
  const settings=await identity.orderNumberSettings(root);
  await identity.saveOrderNumberSettings(root,{...settings.values,expectedVersion:settings.version,designers:[{userId:designer.actorId,code:'LH'}]},randomUUID());
  const supplier=await preorderFabricSupplier(fill?(requiresColorMatching?'TEST-R4-FILL-A-FABRIC':'TEST-R4-FILL-B-FABRIC'):requiresColorMatching?'TEST-PO-T0-A-FABRIC':'TEST-PO-T0-B-FABRIC');
  const original=await f.runtime.run(scene,designer,async()=>{
   const {sourceId,orderNumber}=await identity.reserveNumberedDraft(designer,{developmentType:'头版',temporaryStyleNo:null,
    numbering:{kind:'preorder',customerCode:'PD',productGroup:'男装',salesYear:2027,salesSeries:'P02'}},randomUUID());
   const resource={kind:'source' as const,id:sourceId},base=initialDevelopmentDocument(),photo=await f.image(designer);
   const material={...base.materials[0]!,...supplier,name:'TEST 预下单主布',quantity:fill?'520米':'75米',specification:fill?'':'TEST 已知原布规格'};
   const accessory={...material,materialId:randomUUID(),category:'辅料' as const,label:'辅料',name:'TEST 后续辅料',quantity:'12件',expectedDate:'2026-11-24'};
   const document=DevelopmentDocumentSchema.parse({...base,materials:[material,accessory],files:[{attachmentId:photo,kind:'款图'}],
    productionPlanning:{craftSteps:[],preshrink:false},customerOrderDraft:{withOrder:true,stage:'preorder',
     order:{customerCode:'PD',productGroup:'男装',designStyleNo:orderNumber,temporaryStyleNo:null,orderDate:'',contractDeliveryDate:null,
      primaryMerchandiserId:merch.actorId,lines:[{color:'',deliveryDate:null,sizes:[{size:'',quantity:''}]}]}}});
   const saved=await forms.save(designer,sourceId,{expectedVersion:0,document},randomUUID()),key=randomUUID();
   await expect(forms.publish(designer,sourceId,saved.version,randomUUID())).rejects.toMatchObject({statusCode:409});
   await expect(forms.publishPreorder(designer,sourceId,saved.version+1,randomUUID())).rejects.toMatchObject({statusCode:409});
   expect(await forms.submissionReceipt(designer,sourceId,'publish_preorder',key)).toEqual({status:'unconfirmed'});
   const published=await Promise.all([forms.publishPreorder(designer,sourceId,saved.version,key),forms.publishPreorder(designer,sourceId,saved.version,randomUUID())]);
   expect(published).toEqual([{sourceId,version:saved.version,publishedAt:started},{sourceId,version:saved.version,publishedAt:started}]);
   expect(await forms.publishPreorder(designer,sourceId,saved.version,key)).toEqual(published[0]);
   expect(await forms.submissionReceipt(designer,sourceId,'publish_preorder',key)).toEqual({status:'completed',operation:'publish_preorder',sourceId,documentVersion:saved.version,publishedAt:started});
   expect(await forms.submissionReceipt(designer,sourceId,'publish',key)).toEqual({status:'unconfirmed'});
   await expect(forms.submissionReceipt(merch,sourceId,'publish_preorder',key)).rejects.toMatchObject({statusCode:404});
   expect(await forms.read(designer,sourceId)).toMatchObject({preorderPublication:{at:started,documentVersion:saved.version},productionOrderId:null,taskId:null});
   const archived=(await f.db.query(`SELECT document_version,document FROM digital_development_preorder_publications WHERE source_id=$1`,[sourceId])).rows;
   expect(archived).toEqual([{document_version:saved.version,document:saved.document}]);
   expect(await forms.publishedVersion(designer,sourceId,1,saved.version)).toMatchObject({document:saved.document,publishedAt:started});
   const listed=(await forms.publishedVersions(designer,sourceId,1)).items;
   expect(listed).toMatchObject([{documentVersion:saved.version,reason:'预下单发布'}]);
   expect(new Date(listed[0]!.publishedAt).toISOString()).toBe(started);
   expect((await identity.developmentDrafts(designer,1,orderNumber!)).items).toEqual([]);
   expect((await identity.sources(designer,1,orderNumber!)).items).toMatchObject([{sourceId}]);
   const handover=(await service.read(designer,resource)).facts.find(row=>row.kind==='design_handover')!;
   expect(handover).toMatchObject({version:1,recipientId:merch.actorId,occurredAt:started,investmentScopeBasis:{preorder:true}});
   expect((await service.read(designer,resource)).history).toHaveLength(1);
   expect(await orderTimeCreated(f.db,resource)).toBeNull();
   expect(await new OrderTimePlanRepository(f.db).current(resource)).toBeNull();
   await expect(h.orderTimeRequests.check(designer,{kind:'arrangement',resource})).rejects.toMatchObject({statusCode:409});
   let developmentTaskId:string|null=null;
   if(requiresColorMatching&&!fill){
    const category=(await f.db.query("SELECT price_id FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0]!;
    const price=await new PatternRoomPriceService(f.db).quote(root,'category',category.price_id);
    const current=await forms.read(designer,sourceId);
    const technical=await forms.save(designer,sourceId,{expectedVersion:current.version,document:{...current.document!,
     quantity:1,sizes:['M'],sizeQuantities:[1],sampleSize:'M',measurements:[{name:'胸围',values:['48']}],patternCategoryId:category.price_id}},randomUUID());
    const released=await forms.publish(designer,sourceId,technical.version,randomUUID(),{categoryId:category.price_id,priceVersion:price.version});
    developmentTaskId=released.taskId;
    expect(developmentTaskId).toBeTruthy();
    const recorded=(await f.db.query('SELECT state,entered_at,entered_quality FROM digital_production_tasks WHERE task_id=$1',[developmentTaskId])).rows[0];
    expect(recorded).toMatchObject({state:'ready',entered_at:new Date(started),entered_quality:'现场登记'});
    expect(await new DigitalProductionTaskService(f.db).read(root,developmentTaskId!)).toMatchObject({dueAt:null,warningAt:null,slaHours:null});
    expect(await orderTimeCreated(f.db,resource)).toBeNull();
    expect(await new OrderTimePlanRepository(f.db).current(resource)).toBeNull();
   }
   return {resource,sourceId,orderNumber,handover,material,accessory,developmentTaskId};
  });
  if(requiresColorMatching&&!fill){
   // The ordinary workbench can read other orders. Don't attach this
   // single-order simulated clock to that broader authorized read.
   const workspace=await new DevelopmentWorkspaceQuery(new DigitalJourneyQuery(f.db)).designer(designer,
    DevelopmentWorkspaceFilterSchema.parse({search:original.orderNumber,layout:'workbench'}));
   expect(workspace.items).toMatchObject([{view:'developing',journey:{sourceId:original.sourceId,orderId:null}}]);
  }
  await f.advance(scene,investedAt);
  const fact=await f.runtime.run(scene,merch,async()=>{
   expect(await materialInvestmentTodos(f.db,merch,{todoId:original.handover.recordId})).toMatchObject([{dueAt:null}]);
   const quantities=[{materialId:original.material.materialId,lineId:null,name:original.material.name,quantity:fill?520:75,unit:'米'}];
   if(requiresColorMatching)quantities.push({materialId:original.accessory.materialId,lineId:null,name:original.accessory.name,quantity:12,unit:'件'});
   const state=await service.record(merch,original.resource,{kind:'material_investment',scopeRef:'whole',expectedVersion:0,state:'ready',
    occurredAt:investedAt,note:'TEST 预下单期间实际投料',quantities,evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
   expect(state.materialInvestmentReminder).toBeUndefined();
   return state.facts.find(row=>row.kind==='material_investment')!;
  });
  const confirmationAt='2026-11-25T04:00:00.000Z';
  await f.advance(scene,fill?confirmationAt:formalAt);
  let acceptedBatch:{recordId:string;version:number}|undefined;
  if(fill){
   const warehouse=f.people.warehouse!;
   await f.runtime.run(scene,root,async()=>{
    await service.assign(root,original.resource,{expectedVersion:0,warehouseWorkerId:warehouse.actorId,
     colorConfirmationWorkerId:null,colorConfirmationRole:null,reason:'TEST 原预下单指定收料岗'},randomUUID());
    const [item]=await service.warehouseReceiptWork(warehouse,original.resource);
    expect(item?.purchase).toMatchObject({original:{recordId:fact.recordId,version:fact.version},investedAt,invested:{quantity:'520',unit:'米'}});
    const result=await service.recordWarehouseReceiptBatch(warehouse,original.resource,{kind:item!.kind,materialId:item!.materialId,lineId:item!.lineId,
     supplierId:item!.basis.supplierId,scopeRef:item!.scopeRef,unit:'米',investment:item!.purchase.original,materialFingerprint:item!.basis.adoptedRef,
     expectedReceiptVersion:0,quantity:'490',occurredAt:investedAt,note:'TEST 原真实收料'},randomUUID());
    const saved=result.history.find(row=>row.warehouseReceipt?.materialId===original.material.materialId)!;
    acceptedBatch={recordId:saved.recordId,version:saved.version};
   });
   await f.runtime.run(scene,designer,async()=>{
    const current=await forms.read(designer,original.sourceId);
    const pattern=requiresColorMatching?(await f.db.query("SELECT price_id FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0]:null;
    await forms.save(designer,original.sourceId,{expectedVersion:current.version,document:{...current.document!,
     ...(pattern?{quantity:1,sizes:['M'],sizeQuantities:[1],sampleSize:'M',measurements:[{name:'胸围',values:['48']}],patternCategoryId:pattern.price_id}:{}),
     materials:current.document!.materials.map(material=>
      material.materialId===original.material.materialId?{...material,specification:'TEST 按原采购凭证补原规格'}:material)}},randomUUID());
   });
   await f.runtime.run(scene,merch,async()=>{
    const pending=await service.read(merch,original.resource),candidate=pending.preorderApplicabilityCandidates?.[0];
    expect(candidate).toMatchObject({materialId:original.material.materialId,state:'needs_same_material_proof',fields:['specification']});
    expect(pending.facts.find(row=>row.kind==='design_handover')?.valid).toBe(false);
    expect((await service.warehouseReceiptWork(warehouse,original.resource)).filter(row=>row.materialId===original.material.materialId)).toEqual([]);
    const file=await f.image(merch),{materialId,sourceVersion,roundNumber,handover,investment}=candidate!;
    const payload={materialId,sourceVersion,roundNumber,handover,investment,evidenceIds:[file],note:'TEST 原跟单凭原购布资料确认同一实际材料'},key=randomUUID();
    await expect(service.confirmPreorderMaterial(designer,original.resource,payload,randomUUID())).rejects.toMatchObject({statusCode:403});
    const applied=await service.confirmPreorderMaterial(merch,original.resource,payload,key);
    expect(applied.preorderApplicabilityCandidates).toBeUndefined();
    expect(applied.facts.find(row=>row.kind==='design_handover')).toMatchObject({valid:true,recordId:original.handover.recordId,occurredAt:started});
    expect(applied.facts.find(row=>row.kind==='material_investment')).toMatchObject({recordId:fact.recordId,version:fact.version+1,occurredAt:investedAt,
     evidenceIds:fact.evidenceIds,preorderApplicabilityConfirmation:{confirmedAt:confirmationAt,evidenceIds:[file]}});
    expect(applied.history.find(row=>row.recordId===fact.recordId&&row.version===fact.version)).not.toHaveProperty('preorderApplicabilityConfirmation');
    expect(await service.canDownload(merch,original.resource,file)).toBe(true);
    expect(await service.canDownload(merch,original.resource,await f.image(merch))).toBe(false);
    expect(await service.canDownload(warehouse,original.resource,file)).toBe(false);
    expect((await service.read(warehouse,original.resource)).history.some(row=>row.preorderApplicabilityConfirmation)).toBe(false);
    expect((await service.confirmPreorderMaterial(merch,original.resource,payload,key)).facts).toEqual(applied.facts);
    expect((await service.warehouseReceiptWork(warehouse,original.resource)).filter(row=>row.materialId===materialId)).toMatchObject([{activeBatches:[{ref:acceptedBatch}],received:{quantity:'490',unit:'米'},purchase:{investedAt}}]);
    expect((await service.warehouseReceipts(warehouse,{page:1,search:original.orderNumber!,status:'open'})).items).toContainEqual(
     expect.objectContaining({resource:original.resource,materialId,received:{quantity:'490',unit:'米'}}));
   });
   if(requiresColorMatching)await f.runtime.run(scene,designer,async()=>{
    const current=await forms.read(designer,original.sourceId),categoryId=current.document!.patternCategoryId!;
    const price=await new PatternRoomPriceService(f.db).quote(root,'category',categoryId);
    const released=await forms.publish(designer,original.sourceId,current.version,randomUUID(),{categoryId,priceVersion:price.version});
    expect(released.taskId).toBeTruthy();original.developmentTaskId=released.taskId;
   });
   await f.advance(scene,formalAt);
  }
  const input=DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:original.orderNumber,orderDate:'2026-11-20',
   requiresColorMatching,productionPlanning:{craftSteps:[],preshrink:false},primaryMerchandiserId:merch.actorId,
   lines:[{formalPoNo:`${original.orderNumber}-PO`,color:'黑',customerWarehouseArrivalDate:requiresColorMatching?'2027-04-30':'2026-12-02',sizes:[{size:'M',quantity:2}]}]});
  let approvedOrderId:string|null=null;
  if(!requiresColorMatching){
   const operation={kind:'confirm_order' as const,sourceId:original.sourceId,input};
   const pending=await f.runtime.run(scene,designer,async()=>{
    await expect(identity.createOrder(designer,input,randomUUID(),original.sourceId)).rejects.toMatchObject({code:'ORDER_TIME_REQUEST_REQUIRED'});
    const check=await h.orderTimeRequests.check(designer,operation);
    expect(check.feasibility).toBe('insufficient');
    return h.orderTimeRequests.submit(designer,{operation,fingerprint:check.fingerprint,reason:'TEST 短交期按原申请审批'},randomUUID());
   });
   expect(await new OrderTimePlanRepository(f.db).current(original.resource)).toBeNull();
   const applied=await f.runtime.run(scene,root,async()=>{
    const current=await h.orderTimeRequests.read(root,pending.requestId);
    const approval={expectedVersion:current.version,fingerprint:current.check.fingerprint,overrides:{},acceptLate:true},key=randomUUID();
    const result=await h.orderTimeRequests.apply(root,pending.requestId,approval,key);
    expect(await h.orderTimeRequests.apply(root,pending.requestId,approval,key)).toEqual(result);
    return result;
   });
   expect(applied).toMatchObject({state:'applied',result:{orderId:expect.any(String)}});
   approvedOrderId=applied.result!.orderId;
  }
  const created=approvedOrderId?await f.runtime.run(scene,designer,()=>identity.read(designer,approvedOrderId!)):await f.runtime.run(scene,designer,async()=>{
   const key=randomUUID(),result=await identity.createOrder(designer,input,key,original.sourceId);
   expect(await identity.createOrder(designer,input,key,original.sourceId)).toEqual(result);
   return result;
  });
  const resource={kind:'order' as const,id:created.productionOrderId};
  await f.runtime.run(scene,merch,async()=>{
   expect(await orderTimeCreated(f.db,resource)).toMatchObject({at:formalAt});
   expect(await orderTimeCreated(f.db,original.resource)).toBeNull();
   const plan=await new OrderTimePlanRepository(f.db).current(resource);
   expect(plan?.input.frameworkContext).toMatchObject({route:requiresColorMatching?'A':'B',acceptedAt:{value:formalAt}});
   if(original.developmentTaskId){
    const clocks=(await f.db.query(`SELECT entered_at::text,due_at::text,sla_basis FROM digital_production_deadline_revisions
     WHERE task_id=$1 ORDER BY revision_id`,[original.developmentTaskId])).rows;
    expect(clocks).toHaveLength(2);
    expect(clocks[0]).toMatchObject({due_at:null,sla_basis:{preorderNonAssessable:true}});
    expect(new Date(clocks[1]!.entered_at).toISOString()).toBe(formalAt);
    expect(clocks[1]!.due_at).toBeTruthy();
    const originalTime=(await f.db.query('SELECT entered_at FROM digital_production_tasks WHERE task_id=$1',[original.developmentTaskId])).rows[0]!.entered_at;
    expect(new Date(originalTime).toISOString()).toBe(fill?confirmationAt:started);
   }
   const state=await service.read(merch,resource);
   expect(state.facts.find(row=>row.kind==='design_handover')).toMatchObject({recordId:original.handover.recordId,occurredAt:started});
   expect(state.facts.find(row=>row.kind==='material_investment')).toMatchObject({recordId:fact.recordId,occurredAt:investedAt,state:requiresColorMatching?'ready':'partial'});
   if(fill){
    const physical=state.history.find(row=>row.recordId===acceptedBatch?.recordId&&row.version===acceptedBatch?.version);
    expect(physical).toMatchObject({occurredAt:investedAt,valid:true,warehouseReceipt:{quantity:'490'}});
    expect(plan?.input.materialInvestmentScope?.reference).toContain(original.handover.investmentScopeBasis!.fingerprint);
   }
   if(requiresColorMatching){
    expect(state.materialInvestmentReminder).toBeUndefined();
    expect(await materialInvestmentTodos(f.db,merch,{todoId:original.handover.recordId})).toEqual([]);
   }else{
    expect(state.materialInvestmentReminder).toMatchObject({startedAt:formalAt});
    expect(await materialInvestmentTodos(f.db,merch,{todoId:original.handover.recordId})).toMatchObject([{route:{entityId:created.productionOrderId}}]);
   }
  });
 });
 it.each(['quantity','supplier'] as const)('R4 native preorder changes only the affected physical scope: %s',async(change)=>{
  const designer=f.people['sample-designer']!,merch=f.people.merchandiser!,warehouse=f.people.warehouse!,root=f.root;
  const forms=new DigitalDevelopmentService(f.db,true),start='2026-12-04T04:00:00.000Z',changeAt='2026-12-05T04:00:00.000Z';
  const scene=await f.scene(start),settings=await identity.orderNumberSettings(root);
  await identity.saveOrderNumberSettings(root,{...settings.values,expectedVersion:settings.version,designers:[{userId:designer.actorId,code:'LH'}]},randomUUID());
  const supplier=await preorderFabricSupplier('TEST-R4-NATIVE-'+change.toUpperCase()),nextSupplier=change==='supplier'?await preorderFabricSupplier('TEST-R4-NEW-SUPPLIER'):null;
  const initial=await f.runtime.run(scene,designer,async()=>{
   const {sourceId,orderNumber}=await identity.reserveNumberedDraft(designer,{developmentType:'头版',temporaryStyleNo:null,
    numbering:{kind:'preorder',customerCode:'PD',productGroup:'男装',salesYear:2027,salesSeries:'R04'}},randomUUID());
   const base=initialDevelopmentDocument(),photo=await f.image(designer);
   const fabric={...base.materials[0]!,...supplier,name:'TEST 原实购主布',quantity:'520米',specification:'TEST 原规格'};
   const stable={...fabric,materialId:randomUUID(),category:'配布' as const,name:'TEST 不变配布',quantity:'120米'};
   const document=DevelopmentDocumentSchema.parse({...base,materials:[fabric,stable],files:[{attachmentId:photo,kind:'款图'}],
    productionPlanning:{craftSteps:[],preshrink:false},customerOrderDraft:{withOrder:true,stage:'preorder',
     order:{customerCode:'PD',productGroup:'男装',designStyleNo:orderNumber,temporaryStyleNo:null,orderDate:'',contractDeliveryDate:null,
      primaryMerchandiserId:merch.actorId,lines:[{color:'',deliveryDate:null,sizes:[{size:'',quantity:''}]}]}}});
   const saved=await forms.save(designer,sourceId,{expectedVersion:0,document},randomUUID());
   await forms.publishPreorder(designer,sourceId,saved.version,randomUUID());
   return {resource:{kind:'source' as const,id:sourceId},fabric,stable,orderNumber};
  });
  const {resource,fabric,stable,orderNumber}=initial;
  const quantities=[{materialId:fabric.materialId,lineId:null,name:fabric.name,quantity:520,unit:'米'},
   {materialId:stable.materialId,lineId:null,name:stable.name,quantity:120,unit:'米'}];
  const purchase={kind:'material_investment' as const,scopeRef:'whole',expectedVersion:0,state:'ready' as const,occurredAt:start,
   note:'TEST 原采购实绩',quantities,evidenceIds:[],sourceDocumentVersion:null,recipientId:null};
  const original=await f.runtime.run(scene,merch,async()=>{
   const state=await service.record(merch,resource,purchase,randomUUID());
   return state.facts.find(row=>row.kind==='material_investment')!;
  });
  const oldWrites=await f.runtime.run(scene,root,async()=>{
   await service.assign(root,resource,{expectedVersion:0,warehouseWorkerId:warehouse.actorId,
    colorConfirmationWorkerId:null,colorConfirmationRole:null,reason:'TEST 原预下单实际仓管'},randomUUID());
   const items=await service.warehouseReceiptWork(warehouse,resource);
   expect(items).toHaveLength(2);
   const result=new Map<string,{recordId:string;version:number}>();
   const requests=[];
   for(const item of items){
    const quantity=item.materialId===fabric.materialId?'490':'110';
    const payload={kind:item.kind,materialId:item.materialId,lineId:item.lineId,supplierId:item.basis.supplierId,scopeRef:item.scopeRef,
     unit:'米',investment:item.purchase.original,materialFingerprint:item.basis.adoptedRef,expectedReceiptVersion:0,quantity,occurredAt:start,note:'TEST 原入仓批次'};
    const state=await service.recordWarehouseReceiptBatch(warehouse,resource,payload,randomUUID());
    const row=state.history.find(entry=>entry.warehouseReceipt?.materialId===item.materialId)!;
    result.set(item.materialId,{recordId:row.recordId,version:row.version});
    requests.push(payload);
   }
   return {batches:result,requests};
  });
  await f.advance(scene,changeAt);
  const saveChange=(patch:Partial<typeof fabric>)=>f.runtime.run(scene,designer,async()=>{
   const current=await forms.read(designer,resource.id);
   return forms.save(designer,resource.id,{expectedVersion:current.version,document:{...current.document!,
    materials:current.document!.materials.map(material=>material.materialId===fabric.materialId?{...material,...patch}:material)}},randomUUID());
  });
  const expectedOld=(materialId:string,amount:string)=>({materialId,received:{quantity:amount,unit:'米'},
   activeBatches:[{ref:oldWrites.batches.get(materialId)}]});
  if(change==='quantity'){
   await saveChange({quantity:'580米'});
   await f.runtime.run(scene,merch,async()=>{
    const current=await service.read(merch,resource);
    expect(current.facts.find(row=>row.kind==='design_handover')?.preorderApplicability?.quantityDemand).toMatchObject({
     [fabric.materialId]:{requested:'580',originallyRecorded:'520',remaining:'60',unit:'米'},
    });
    expect(current.facts.find(row=>row.kind==='material_investment')).toMatchObject({state:'partial',recordId:original.recordId,occurredAt:start});
    const rows=await service.warehouseReceiptWork(warehouse,resource);
    expect(rows).toHaveLength(2);
    expect(rows.find(row=>row.materialId===fabric.materialId)).toMatchObject(expectedOld(fabric.materialId,'490'));
    expect(rows.find(row=>row.materialId===stable.materialId)).toMatchObject(expectedOld(stable.materialId,'110'));
   });
   await saveChange({quantity:'490米'});
   await f.runtime.run(scene,merch,async()=>{
    const current=await service.read(merch,resource);
    expect(current.facts.find(row=>row.kind==='design_handover')?.preorderApplicability?.quantityDemand).toMatchObject({
     [fabric.materialId]:{requested:'490',originallyRecorded:'520',remaining:'0',unit:'米'},
    });
    expect(current.facts.find(row=>row.kind==='material_investment')).toMatchObject({state:'ready',recordId:original.recordId,version:original.version,
     occurredAt:start,quantities:expect.arrayContaining([{...quantities[0]}])});
   });
   await saveChange({quantity:'580米'});
   await f.runtime.run(scene,merch,async()=>{
    const received=await service.record(merch,resource,{...purchase,expectedVersion:original.version,occurredAt:changeAt,
     quantities:[{...quantities[0]!,quantity:580}],investmentMaterialId:fabric.materialId,note:'TEST 已实际补投60米'},randomUUID());
    expect(received.facts.find(row=>row.kind==='material_investment')).toMatchObject({state:'ready',recordId:original.recordId,version:original.version+1});
    expect(received.history.find(row=>row.recordId===original.recordId&&row.version===original.version)).toMatchObject({occurredAt:start,quantities});
    const view=await service.warehouseReceiptWork(warehouse,resource);
    expect(view).toHaveLength(2);
    expect(view.find(row=>row.materialId===fabric.materialId)).toMatchObject({...expectedOld(fabric.materialId,'490'),purchase:{invested:{quantity:'580',unit:'米'}}});
    expect(view.find(row=>row.materialId===stable.materialId)).toMatchObject(expectedOld(stable.materialId,'110'));
   });
  }else{
   const saved=await saveChange(nextSupplier!);
   await f.runtime.run(scene,warehouse,async()=>{
    expect(await service.warehouseReceiptWork(warehouse,resource)).toMatchObject([expectedOld(stable.materialId,'110')]);
    expect((await service.warehouseReceipts(warehouse,{page:1,search:orderNumber!,status:'open'})).items).toMatchObject([
     {materialId:stable.materialId,received:{quantity:'110',unit:'米'}},
    ]);
    const old=oldWrites.requests.find(row=>row.materialId===fabric.materialId)!;
    await expect(service.recordWarehouseReceiptBatch(warehouse,resource,{...old,expectedReceiptVersion:1,quantity:'10',occurredAt:changeAt},randomUUID()))
     .rejects.toMatchObject({statusCode:409});
   });
   await f.runtime.run(scene,designer,async()=>{
    const state=await service.read(designer,resource),handover=state.facts.find(row=>row.kind==='design_handover')!;
    await service.record(designer,resource,{kind:'design_handover',scopeRef:'whole',expectedVersion:handover.version,state:'ready',occurredAt:changeAt,
     note:'TEST 交接已换供方的当前资料',quantities:[],evidenceIds:[],sourceDocumentVersion:saved.version,recipientId:merch.actorId},randomUUID());
   });
   await f.runtime.run(scene,warehouse,async()=>{
    expect(await service.warehouseReceiptWork(warehouse,resource)).toMatchObject([expectedOld(stable.materialId,'110')]);
   });
   await f.runtime.run(scene,merch,async()=>{
    const revised=await service.record(merch,resource,{...purchase,expectedVersion:original.version,occurredAt:changeAt,
     quantities:[{...quantities[0]!,quantity:40}],investmentMaterialId:fabric.materialId,note:'TEST 已向新供应商实投40米'},randomUUID());
    expect(revised.history.find(row=>row.recordId===original.recordId&&row.version===original.version)).toMatchObject({occurredAt:start,quantities});
    const rows=await service.warehouseReceiptWork(warehouse,resource);
    expect(rows.find(row=>row.materialId===fabric.materialId)).toMatchObject({basis:{supplierId:nextSupplier!.supplierReference.supplierId},
     purchase:{invested:{quantity:'40',unit:'米'}},received:null,activeBatches:[]});
    expect(rows.find(row=>row.materialId===stable.materialId)).toMatchObject(expectedOld(stable.materialId,'110'));
    expect((await service.read(root,resource)).history.find(row=>row.recordId===oldWrites.batches.get(fabric.materialId)?.recordId))
     .toMatchObject({valid:false,warehouseReceipt:{quantity:'490'},occurredAt:start});
   });
  }
 });
 it.each([true,false])('keeps the original purchase record and calendar after real formal conversion, preorder=%s',async(preorder)=>{
  const h=await materialTimerFixture();
  const designer=h.f.people['sample-designer']!,merch=h.f.people.merchandiser!,root=h.f.root,style='TEST-FORMAL-PREORDER-'+randomUUID();
  const started='2026-11-19T04:00:00.000Z',scene=await h.f.scene(started);
  const identity=new DigitalProductionIdentityService(h.db,true),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders),
   preparation=new ProductionReadinessService(h.db),requests=h.orderTimeRequests!,notifications=new DigitalProductionNotificationService(h.db);
  const photo=await h.f.image(designer);
  const order=InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,temporaryStyleNo:null,
   orderDate:'2026-11-19',contractDeliveryDate:null,requiresColorMatching:false,salesYear:2027,salesSeries:'P03',primaryMerchandiserId:merch.actorId,
   lines:[{formalPoNo:style+'-PO',color:'黑',deliveryDate:null,customerWarehouseArrivalDate:'2027-04-30',sizes:[{size:'M',quantity:'2'}]}]});
  const original=await h.f.runtime.run(scene,designer,async()=>{
   const {sourceId}=await identity.createSource(designer,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID(),true);
   const category=(await h.db.query("SELECT price_id FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0]!;
   const price=await new PatternRoomPriceService(h.db).quote(root,'category',category.price_id);
   const draft=initialDevelopmentDocument(),material={...draft.materials[0]!,name:'TEST 真预下单材料',quantity:'75米',supplier:'TEST 供应商',specification:'TEST 原布规格'};
   const secondMaterial={...material,materialId:randomUUID(),name:'TEST 配布原记录',quantity:'20米'};
   const document={...draft,quantity:1,files:[{attachmentId:photo,kind:'款图' as const}],patternCategoryId:category.price_id,
    materials:[material,secondMaterial],productionPlanning:{craftSteps:[],preshrink:false},customerOrderDraft:preorder?{withOrder:true,stage:'preorder' as const,order}:null};
   const sheet=await forms.save(designer,sourceId,{expectedVersion:0,document},randomUUID()),resource={kind:'source' as const,id:sourceId};
   const version=preorder?sheet.version:(await forms.publish(root,sourceId,sheet.version,randomUUID(),{categoryId:category.price_id,priceVersion:price.version})).version;
   const handover=await preparation.record(designer,resource,{kind:'design_handover',scopeRef:'whole',expectedVersion:0,state:'ready',
    occurredAt:started,note:'TEST 正式前交接',quantities:[],evidenceIds:[],sourceDocumentVersion:version,recipientId:merch.actorId},randomUUID());
   const fact=handover.facts.find(entry=>entry.kind==='design_handover')!;
   expect(Boolean(await orderTimeCreated(h.db,resource))).toBe(!preorder);
   return {sourceId,resource,category,price,document,version,handoverId:fact.recordId,material,secondMaterial};
  });
  const warehouse=h.f.people.warehouse!;
  if(!preorder){
   await h.f.runtime.run(scene,root,()=>preparation.assign(root,original.resource,{expectedVersion:0,warehouseWorkerId:warehouse.actorId,
    colorConfirmationWorkerId:null,colorConfirmationRole:null,reason:'TEST assigned native receiving role before any actual investment'},randomUUID()));
   expect(await h.f.runtime.run(scene,warehouse,()=>preparation.warehouseReceiptWork(warehouse,original.resource))).toEqual([]);
  }
  const actual={kind:'material_investment' as const,scopeRef:'whole',expectedVersion:0,state:'partial' as const,
   occurredAt:started,note:'TEST 首批部分投料，保留在同一投料记录',quantities:[{lineId:null,materialId:original.material.materialId,
    name:original.material.name,quantity:20,unit:'米'}],evidenceIds:[],sourceDocumentVersion:null,recipientId:null};
  const initial=await h.f.runtime.run(scene,merch,async()=>{
   const result=await preparation.record(merch,original.resource,actual,randomUUID());
   expect(await materialInvestmentTodos(h.db,merch,{todoId:original.handoverId})).toMatchObject([{dueAt:null,route:{routeName:'digital_source_material_investment'}}]);
   return result.facts.find(record=>record.kind==='material_investment')!;
  });
  if(preorder){
   // This original legacy draft has not passed the later X2 publication boundary.
   await expect(h.f.runtime.run(scene,warehouse,()=>preparation.warehouseReceiptWork(warehouse,original.resource))).rejects.toMatchObject({statusCode:403});
  }else{
   expect(await h.f.runtime.run(scene,warehouse,()=>preparation.warehouseReceiptWork(warehouse,original.resource)))
    .toMatchObject([{materialId:original.material.materialId,received:null,purchase:{original:{recordId:initial.recordId,version:1},investedAt:started,invested:{quantity:'20',unit:'米'}}}]);
  }
  await h.f.advance(scene,preorder?'2026-11-20T04:00:00.000Z':'2026-11-19T04:10:00.000Z');
  const pending=await h.f.runtime.run(scene,designer,async()=>{
   const operation=preorder?await (async()=>{
    const sheet=await forms.save(designer,original.sourceId,{expectedVersion:original.version,
     document:{...original.document,customerOrderDraft:{withOrder:true,stage:'formal',order}}},randomUUID());
    return {kind:'development_publish' as const,sourceId:original.sourceId,input:{expectedVersion:sheet.version,
     patternOrder:{categoryId:original.category.price_id,priceVersion:original.price.version}}};
   })():{kind:'confirm_order' as const,sourceId:original.sourceId,input:DigitalOrderCreateSchema.parse({...order,
    productionPlanning:{craftSteps:[],preshrink:false},lines:order.lines.map(line=>({...line,sizes:[{size:'M',quantity:2}]}))})};
   const check=await requests.check(designer,operation);
   return requests.submit(designer,{operation,fingerprint:check.fingerprint,reason:'TEST 原预下单转正式'},randomUUID());
  });
  const orderId=await h.f.runtime.run(scene,root,async()=>{
   const review=await requests.read(root,pending.requestId);
   const applied=await requests.apply(root,pending.requestId,{expectedVersion:review.version,fingerprint:review.check.fingerprint,overrides:{},acceptLate:true},randomUUID());
   expect(applied.state).toBe('applied');return applied.result!.orderId!;
  });
  const resource={kind:'order' as const,id:orderId};
  if(preorder)await h.f.runtime.run(scene,root,async()=>{
   const before=await preparation.read(root,resource);
   await preparation.assign(root,resource,{expectedVersion:before.responsibility.version,warehouseWorkerId:warehouse.actorId,
    colorConfirmationWorkerId:null,colorConfirmationRole:null,reason:'TEST assign warehouse after this legacy draft becomes a real order'},randomUUID());
  });
  const [warehouseTask]=await h.f.runtime.run(scene,warehouse,()=>preparation.warehouseReceiptWork(warehouse,resource));
  expect(warehouseTask).toMatchObject({kind:'fabric_receipt',materialId:original.material.materialId,lineId:null,received:null,
   purchase:{original:{recordId:initial.recordId,version:1},investedAt:started,invested:{quantity:'20',unit:'米'}},
   balance:{procurementRemaining:null,productionShortage:null}});
  await expect(h.f.runtime.run(scene,merch,()=>preparation.warehouseReceiptWork(merch,resource))).rejects.toMatchObject({statusCode:403});
  const reminder=await h.f.runtime.run(scene,merch,async()=>{
   const plan=await new OrderTimePlanRepository(h.db).current(resource);
   const predecessor=plan?.input.work.find(work=>work.parameterKey==='material_investment')?.dependsOn;
   expect(predecessor).toContain('design_handover');
   if(preorder)expect(predecessor).toEqual(['design_handover']);
   const state=await preparation.read(merch,resource);
   expect(state.facts.find(record=>record.kind==='material_investment')).toMatchObject({recordId:initial.recordId,version:1,state:'partial',occurredAt:started});
   expect(state.materialInvestmentReminder).toMatchObject({handoverId:original.handoverId,startedAt:started,percent:70,closed:null,status:'waiting'});
   expect(await materialInvestmentTodos(h.db,merch,{todoId:original.handoverId})).toMatchObject([{todoId:original.handoverId,route:{routeName:'digital_order_material_investment',entityId:orderId}}]);
   const workbench=new TodoService(h.db,undefined,undefined,undefined,notifications);
   const readCapabilities=(await h.db.query<{capability:string}>(`SELECT c.capability FROM user_role_assignments a JOIN role_capabilities c USING(role_code)
    WHERE a.user_id=$1 AND a.role_code='order_merchandiser' AND a.revoked_at IS NULL`,[merch.actorId])).rows.map(row=>row.capability);
   expect(readCapabilities).toContain('todo:view');
   const selected=await workbench.merchandiserActionPage({...merch,authorizationCapability:'todo:view',authorizationCapabilities:readCapabilities},
    {kind:'preparation',search:orderId,page:1});
   expect(selected.items).toEqual(expect.arrayContaining([expect.objectContaining({itemId:original.handoverId,dueAt:state.materialInvestmentReminder!.dueAt,
    originalOrderId:orderId,poNumbers:[style+'-PO'],route:{routeName:'digital_order_material_investment',entityId:orderId,todoId:original.handoverId}})]));
   return state.materialInvestmentReminder!;
  });
  expect(reminder.warningAt).toBeTruthy();
  await h.f.advance(scene,reminder.warningAt!);
  await h.f.runtime.run(scene,root,async()=>{
   await notifications.runOnce();await notifications.runOnce();
   expect((await h.db.query("SELECT count(*)::int n FROM digital_production_notification_events WHERE event_kind='material_investment' AND todo_id=$1",[original.handoverId])).rows[0]!.n).toBe(1);
  });
  await h.f.runtime.run(scene,merch,async()=>{
   const close={fingerprint:reminder.fingerprint,reason:'TEST 已和供应商核对，继续领料'},key=randomUUID();
   const closed=await preparation.closeMaterialInvestmentReminder(merch,resource,close,key);
   expect(closed.materialInvestmentReminder).toMatchObject({closed:{actorId:merch.actorId,reason:close.reason},status:'warning'});
   expect((await preparation.closeMaterialInvestmentReminder(merch,resource,close,key)).materialInvestmentReminder).toEqual(closed.materialInvestmentReminder);
   expect(await materialInvestmentTodos(h.db,merch,{todoId:original.handoverId})).toHaveLength(1);
  });
  const completeAt=new Date(Date.parse(reminder.dueAt)+3600000).toISOString();
  await h.f.advance(scene,completeAt);
  await h.f.runtime.run(scene,merch,async()=>{
   const later=await preparation.record(merch,resource,{...actual,expectedVersion:1,occurredAt:completeAt,
    quantities:[{...actual.quantities[0]!,quantity:75}]},randomUUID());
   expect(later.facts.find(record=>record.kind==='material_investment')).toMatchObject({recordId:initial.recordId,version:2,state:'partial'});
   const earlierAt=new Date(Date.parse(reminder.dueAt)-3600000).toISOString();
   const result=await preparation.record(merch,resource,{...actual,expectedVersion:2,state:'ready',occurredAt:earlierAt,
    quantities:[{lineId:null,materialId:original.secondMaterial.materialId,name:original.secondMaterial.name,quantity:20,unit:'米'}]},randomUUID());
   expect(result.facts.find(record=>record.kind==='material_investment')).toMatchObject({recordId:initial.recordId,version:3,state:'ready',occurredAt:completeAt,
    investmentMaterialOccurrences:{[original.material.materialId]:{occurredAt:completeAt},[original.secondMaterial.materialId]:{occurredAt:earlierAt}}});
   expect(await materialInvestmentTodos(h.db,merch,{todoId:original.handoverId})).toEqual([]);
   expect(await materialInvestmentRiskHistory(h.db,orderId,completeAt)).toMatchObject([{at:completeAt,deadline:reminder.dueAt,assessment:'late',overdueSeconds:3600}]);
  });
 });
 const directMaterialOrder=async(poCount=1,fixture=f,started='2027-04-25T04:00:00.000Z',daysUntilDelivery=5)=>{
  const h=await materialTimerFixture(fixture);
  const designer=h.f.people['sample-designer']!,merch=h.f.people.merchandiser!,root=h.f.root,style='TEST-DIRECT-MATERIAL-'+randomUUID();
  const scene=await h.f.scene(started),requests=h.orderTimeRequests!,orderDate=beijingCalendarDate(new Date(started));
  const deliveryDate=beijingCalendarDate(new Date(Date.parse(started)+daysUntilDelivery*86_400_000));
  const input=DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,orderDate,
   requiresColorMatching:false,salesYear:Number(orderDate.slice(0,4)),salesSeries:'P03',primaryMerchandiserId:merch.actorId,
   lines:Array.from({length:poCount},(_,index)=>({formalPoNo:style+'-PO-'+(index+1),color:index?'白':'黑',
    customerWarehouseArrivalDate:deliveryDate,sizes:[{size:'M',quantity:2}]}))});
  const operation={kind:'direct_order' as const,input,route:{craftSteps:[],preshrink:false}};
  const submitted=await h.f.runtime.run(scene,designer,async()=>{
   const check=await requests.check(designer,operation);
   return requests.submit(designer,{operation,fingerprint:check.fingerprint,reason:'TEST 由原入口建立无开发来源的正式单'},randomUUID());
  });
  const orderId=await h.f.runtime.run(scene,root,async()=>{
   const pending=await requests.read(root,submitted.requestId);
   const done=await requests.apply(root,pending.requestId,{expectedVersion:pending.version,fingerprint:pending.check.fingerprint,overrides:{},acceptLate:true},randomUUID());
   expect(done.state).toBe('applied');return done.result!.orderId!;
  });
  return {h,designer,merch,root,style,started,scene,requests,orderId};
 };
 it('uses the guarded clock on the real material panel, scan, claim and todo through a late B order',async()=>{
  const fixture=await businessAnchorFixture(url!),app=Fastify({logger:false});
  try{
   const future=new Date(Math.max(Date.parse('2027-04-25T04:00:00.000Z'),Date.now()+7*86_400_000)).toISOString();
   const {h,designer,merch,root,started,scene,orderId,requests}=await directMaterialOrder(1,fixture,future,120);
   const resource={kind:'order' as const,id:orderId},runtime=h.f.runtime,repo=new OrderTimePlanRepository(h.db);
   const preparation=new ProductionReadinessService(h.db),instructions=new ProductionInstructionService(h.db,true);
   const notifications=new DigitalProductionNotificationService(h.db),identity=new DigitalProductionIdentityService(h.db,true);
   const secret=runtime.secret,corp='anchor-test',authority=new RootAuthority(h.db,corp,'uat-root');
   const auth=new AuthService(new AcceptanceDingTalkProvider(h.db,corp,secret),new PostgresAuthStore(h.db,corp,'uat-root'),corp,3600000,secret);
   const authenticate=(token:string|undefined)=>auth.authenticate(token);
   app.setErrorHandler((error,_request,reply)=>reply.code((error as ApplicationError).statusCode??500).send({error:{message:error.message}}));
   registerAcceptanceClockRoutes(app,runtime,auth,authority);
   registerDigitalIdentityRoutes(app,{authenticate,root:authority,service:identity,creationEnabled:true,readinessService:preparation,developmentAttachments:h.f.attachments,notificationService:notifications});
   registerTodoRoutes(app,{authenticate,root:authority,service:new TodoService(h.db,undefined,undefined,undefined,notifications)});
   const login=async(role:string)=>{
    const control=await auth.beginAcceptanceControl(mintAcceptanceControlCode(secret));
    const business=await auth.switchAcceptanceIdentity(control,role);
    return `dx_acceptance_control=${control}; dx_rework_session=${business.token}`;
   };
   const rootCookie=await login('root'),firstTab=await login('merchandiser'),secondTab=await login('merchandiser');
   const get=(url:string,cookie=firstTab)=>app.inject({method:'GET',url,headers:{cookie}});
   const post=(url:string,cookie:string,payload:object,headers:Record<string,string>={})=>app.inject({method:'POST',url,headers:{cookie,'idempotency-key':randomUUID(),...headers},payload});
   const check=async<Body,>(result:Awaited<ReturnType<typeof get>>|ReturnType<typeof get>)=>{
    const response=await result;expect(response.statusCode,response.body).toBe(200);return response.json<Body>();
   };
   const fabric=randomUUID(),lining=randomUUID();
   const handover=async(id:string,at:string)=>{
    const current=await instructions.read(merch,id);
    const saved=await instructions.save(merch,id,{expectedVersion:current.version,orderVersion:current.currentOrderVersion,
     document:{...initialInstruction(),secondaryCraft:'无',preshrink:'无需预缩',
      fabrics:[{id:fabric,name:'TEST 主布',part:'本身',colors:{},remarks:''},{id:lining,name:'TEST 配布',part:'里料',colors:{},remarks:''}]}},randomUUID());
    return preparation.record(root,{kind:'order',id},{kind:'design_handover',scopeRef:'whole',expectedVersion:0,state:'ready',occurredAt:at,
     note:'TEST 原制单按本单交接',quantities:[],evidenceIds:[],sourceDocumentVersion:null,orderInstructionVersion:saved.version,recipientId:merch.actorId},randomUUID());
   };
   await runtime.run(scene,root,async()=>{
    await handover(orderId,started);
    const operation={kind:'arrangement' as const,resource},proposal=await requests.check(root,operation);
    expect(proposal.framework?.milestones.find(row=>row.key==='material_investment')).toMatchObject({target:{at:expect.any(String)}});
    await requests.arrange(root,{resource,fingerprint:proposal.fingerprint,overrides:{},acceptLate:true},randomUUID());
   });
   const base=`/digital-production/orders/${orderId}/production-readiness`,initial=await get(base);
   expect(initial.headers['x-acceptance-clock']).toBe('scenario');
   const initialState=await check<ProductionReadinessState>(initial),reminder=initialState.materialInvestmentReminder!;
   expect(reminder).toMatchObject({enabled:true,percent:70,status:'waiting',startedAt:started});
   const adopted=await repo.current(resource),[plan]=Object.values(adopted?.input.frameworkPlans??{});
   expect(plan?.input.route).toBe('B');
   const warningAt=reminder.warningAt!,beforeWarning=new Date(Date.parse(warningAt)-1).toISOString();
   const partialInput={kind:'material_investment' as const,scopeRef:'whole',expectedVersion:0,state:'partial' as const,occurredAt:started,
    note:'TEST 实投主布10米，预计40米',quantities:[{lineId:null,materialId:fabric,name:'TEST 主布',quantity:10,unit:'米'}],
    evidenceIds:[],sourceDocumentVersion:null,recipientId:null,investmentMaterialId:fabric};
   expect(Date.parse(started)).toBeGreaterThan(Date.now());
   const partial=await check<ProductionReadinessState>(post(`${base}/materials`,firstTab,partialInput));
   const investment=partial.facts.find(fact=>fact.kind==='material_investment')!;
   expect(investment).toMatchObject({version:1,state:'partial',occurredAt:started,quantities:partialInput.quantities});

   const other=await runtime.create(root,{name:'TEST other preparation scene',requestKey:randomUUID()});
   const sourceRead=await get(`/digital-production/sources/${other.sourceIds[0]}/production-readiness`,rootCookie);
   expect(sourceRead.statusCode,sourceRead.body).toBe(200);expect(sourceRead.headers['x-acceptance-clock']).toBe('scenario');
   expect((await post(`${base}/materials`,firstTab,{...partialInput,expectedVersion:1},{'x-acceptance-scenario':other.scenarioId})).statusCode).toBe(409);
   const ordinary=await identity.createOrder(designer,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:`TEST-UNBOUND-${randomUUID()}`,
    orderDate:beijingCalendarDate(businessNow()),requiresColorMatching:false,primaryMerchandiserId:merch.actorId,productionPlanning:{craftSteps:[],preshrink:false},
    lines:[{formalPoNo:`TEST-UNBOUND-${randomUUID()}`,color:'黑',customerWarehouseArrivalDate:beijingCalendarDate(new Date(Date.parse(future)+30*86_400_000)),sizes:[{size:'M',quantity:40}]}]}),randomUUID());
   const ordinaryState=await handover(ordinary.productionOrderId,businessNow().toISOString());
   const ordinaryPath=`/digital-production/orders/${ordinary.productionOrderId}/production-readiness`,ordinaryLine=ordinaryState.lines[0]!.lineId;
   expect((await get(ordinaryPath)).headers['x-acceptance-clock']).toBeUndefined();
   const denied=await post(`${ordinaryPath}/materials`,firstTab,{...partialInput,quantities:[{...partialInput.quantities[0]!,lineId:ordinaryLine}]});
   expect(denied.statusCode,denied.body).toBe(409);expect(denied.body).toContain('实际时间不能在未来');
   expect((await check<ProductionReadinessState>(get(ordinaryPath))).facts.some(row=>row.kind==='material_investment')).toBe(false);

   const scan=()=>check(post(`/acceptance/clock/scenarios/${scene}/scan`,rootCookie,{requestKey:randomUUID()}));
   const notices=async()=> (await h.db.query(`SELECT event_id FROM digital_production_notification_events
    WHERE event_kind='material_investment' AND todo_id=$1`,[reminder.handoverId])).rows.map(row=>row.event_id as string);
   await h.f.advance(scene,beforeWarning);await scan();expect(await notices()).toEqual([]);
   await h.f.advance(scene,warningAt);
   await notifications.runOnce();expect(await notices()).toEqual([]);
   await Promise.all([scan(),scan()]);
   const [eventId]=await notices();expect(await notices()).toHaveLength(1);
   expect((await h.db.query('SELECT business_time,recipient_id FROM acceptance_sla_clock_receipts WHERE scenario_id=$1 AND native_event_id=$2',[scene,eventId])).rows)
    .toEqual([{business_time:new Date(warningAt),recipient_id:merch.actorId}]);
   expect((await h.db.query('SELECT count(*)::int n FROM acceptance_sla_clock_receipts WHERE scenario_id=$1 AND native_event_id=$2',[other.scenarioId,eventId])).rows[0].n).toBe(0);
   expect((await check<ProductionReadinessState>(get(base))).materialInvestmentReminder).toMatchObject({status:'warning',canClose:true});
   const claim=async(cookie:string)=>check<{notification:{eventId:string;title:string;route:{entityId:string}}|null}>(post('/digital-production/notifications/claim?remaining=1',cookie,{}));
   const claims=[];
   for(let batch=0;batch<8;batch++){
    const pair=await Promise.all([claim(firstTab),claim(secondTab)]);
    claims.push(...pair);
    if(pair.every(result=>result.notification===null))break;
   }
   expect(claims.filter(row=>row.notification?.eventId===eventId)).toEqual([expect.objectContaining({notification:expect.objectContaining({title:'投面辅料临近截止',route:expect.objectContaining({entityId:orderId})})})]);
   expect(await check(get(`/digital-production/notifications/${eventId}?remaining=1`,secondTab))).toMatchObject({notification:{eventId}});
   await check(post(`/digital-production/notifications/${eventId}/acknowledge`,firstTab,{}));
   const todoUrl=`/todos/mine/${reminder.handoverId}`;
   const todo=await check<{status:string;contentToken:string;route:object}>(get(todoUrl));
   expect(todo).toMatchObject({status:'pending',route:{entityId:orderId}});
   await check(post(`${todoUrl}/read`,secondTab,{contentToken:todo.contentToken,route:todo.route}));
   expect(await check(get(todoUrl))).toMatchObject({unread:false,status:'pending'});
   const closed=await check<ProductionReadinessState>(post(`${base}/material-investment-reminder/close`,firstTab,{fingerprint:reminder.fingerprint,reason:'TEST 已联系，继续实际投料'}));
   expect(closed.materialInvestmentReminder).toMatchObject({status:'warning',closed:{at:warningAt,actorId:merch.actorId}});
   expect(await check(get(todoUrl))).toMatchObject({status:'pending'});

   const lateAt=new Date(Date.parse(reminder.dueAt)+60_000).toISOString();
   await h.f.advance(scene,lateAt);await scan();expect(await notices()).toEqual([eventId]);
   const late=await check<ProductionReadinessState>(get(base));
   expect(late.materialInvestmentReminder).toMatchObject({status:'overdue',dueAt:reminder.dueAt});
   expect(late.facts.find(fact=>fact.kind==='material_investment')).toMatchObject({recordId:investment.recordId,state:'partial',occurredAt:started});
   const fullInput={...partialInput,expectedVersion:1,state:'ready',occurredAt:lateAt,investmentMaterialId:undefined,
    quantities:[{...partialInput.quantities[0]!,quantity:40},{lineId:null,materialId:lining,name:'TEST 配布',quantity:20,unit:'米'}]};
   const completed=await check<ProductionReadinessState>(post(`${base}/materials`,firstTab,fullInput));
   expect(completed.facts.find(fact=>fact.kind==='material_investment')).toMatchObject({recordId:investment.recordId,state:'ready',occurredAt:lateAt});
   expect(completed.materialInvestmentReminder).toBeUndefined();
   expect((await get(todoUrl)).statusCode).toBe(404);
   expect(await repo.current(resource)).toEqual(adopted);
   expect(await materialInvestmentRiskHistory(h.db,orderId,lateAt)).toMatchObject([{at:lateAt,deadline:reminder.dueAt,assessment:'late',overdueSeconds:60}]);
  }finally{await app.close();await fixture.dispose();}
 });
 const attachDirectMaterialOrderSource=async({h,designer,root,style,orderId}:Awaited<ReturnType<typeof directMaterialOrder>>)=>{
   const identity=new DigitalProductionIdentityService(h.db,true),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders);
   const owner=(await identity.read(root,orderId)).createdBy===designer.actorId?designer:root;
   const {sourceId}=await identity.createSource(owner,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID(),true);
   const price=(await h.db.query("SELECT price_id,version FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0]!;
   const draft=await forms.save(owner,sourceId,{expectedVersion:0,document:{...initialDevelopmentDocument(),quantity:1,
    files:[{attachmentId:await h.f.image(owner),kind:'款图'}],patternCategoryId:price.price_id}},randomUUID());
   const published=await forms.publish(root,sourceId,draft.version,randomUUID(),{categoryId:price.price_id,priceVersion:price.version});
   expect((await identity.attachSource(root,orderId,sourceId,randomUUID())).sourceId).toBe(sourceId);
   return {sourceId,version:published.version};
 };
 it.each([
  ['composition',false],['fabric remarks',false],['composition after attaching a historical source',true],
 ] as const)('requires new direct-order material evidence after %s changes in the saved instruction',async(field,linkSource)=>{
  const order=await directMaterialOrder(),{h,designer,merch,root,started,scene,orderId}=order,resource={kind:'order' as const,id:orderId};
  const preparation=new ProductionReadinessService(h.db),instruction=new ProductionInstructionService(h.db,true),fabricId=randomUUID(),accessoryId=randomUUID();
  const original={...initialInstruction(),secondaryCraft:'无' as const,preshrink:'无需预缩' as const,composition:'100%纯棉',
   fabrics:[{id:fabricId,name:'TEST主布',part:'本身',colors:{},remarks:'幅宽145cm／克重140g'}],
   accessories:[{id:accessoryId,group:'车缝' as const,garmentColors:'',materialColor:'黑',name:'TEST纽扣',category:'',part:'门襟',specification:'20mm',consumption:'2枚',remarks:''}]};
  const save=async(document:typeof original)=>h.f.runtime.run(scene,merch,async()=>{
   const current=await instruction.read(merch,orderId);
   return (await instruction.save(merch,orderId,{expectedVersion:current.version,orderVersion:current.currentOrderVersion,document},randomUUID())).version;
  });
  const handover=async(expectedVersion:number,orderInstructionVersion:number,occurredAt=started)=>h.f.runtime.run(scene,root,()=>preparation.record(root,resource,{
   kind:'design_handover',scopeRef:'whole',expectedVersion,state:'ready',occurredAt,note:'TEST 实际制单交接',quantities:[],evidenceIds:[],
   sourceDocumentVersion:null,orderInstructionVersion,recipientId:merch.actorId},randomUUID()));
  const purchase={kind:'material_investment' as const,scopeRef:'whole',expectedVersion:0,state:'ready' as const,occurredAt:started,note:'TEST 原实际投料',
   quantities:[{lineId:null,materialId:fabricId,name:'TEST主布',quantity:20,unit:'米'},{lineId:null,materialId:accessoryId,name:'TEST纽扣',quantity:4,unit:'枚'}],
   evidenceIds:[],sourceDocumentVersion:null,recipientId:null};
  const handed=(await handover(0,await save(original))).facts.find(row=>row.kind==='design_handover')!;
  const before=(await h.f.runtime.run(scene,merch,()=>preparation.record(merch,resource,purchase,randomUUID()))).facts.find(row=>row.kind==='material_investment')!;
  expect(before).toMatchObject({state:'ready',version:1});
  const linked=linkSource?await h.f.runtime.run(scene,root,()=>attachDirectMaterialOrderSource(order)):null;
  await save({...original,comments:'TEST 非材料正文更正'});
  expect((await preparation.read(merch,resource)).facts.find(row=>row.kind==='material_investment')).toMatchObject({state:'ready',version:1});
  const revised=field.startsWith('composition')?{...original,composition:'100%聚酯'}:{...original,fabrics:[{...original.fabrics[0]!,remarks:'幅宽155cm／克重155g'}]};
  const revision=await save(revised);
  const pending=await preparation.read(merch,resource);
  expect(pending.facts.find(row=>row.kind==='design_handover')).toMatchObject({recordId:handed.recordId,valid:false});
  expect(pending.facts.find(row=>row.kind==='material_investment')).toMatchObject({state:'partial',recordId:before.recordId,version:1});
  const reread=(await readSeriesPlanFacts(h.db,orderId,linked?.sourceId??null,'PD')).facts.find(row=>row.key==='material_investment');
  expect(reread).toMatchObject({sourceRecordId:before.recordId,completed:false});
  const renewedAt=linked?'2027-04-25T05:00:00.000Z':started;
  if(linked){
   await h.f.advance(scene,renewedAt);
   const sourceResource={kind:'source' as const,id:linked.sourceId};
   const sourceRead=await preparation.read(root,sourceResource);
   expect.soft(sourceRead.canRecord).not.toContain('design_handover');
   expect.soft(sourceRead.orderInstructionVersion).toBeUndefined();
   const originalRequest={...purchase,kind:'design_handover' as const,expectedVersion:1,occurredAt:renewedAt,
    quantities:[],orderInstructionVersion:revision,recipientId:merch.actorId};
   await h.f.runtime.run(scene,root,async()=>{
    await expect(preparation.record(root,sourceResource,originalRequest,randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(preparation.record(root,sourceResource,{...originalRequest,orderInstructionVersion:undefined,sourceDocumentVersion:linked.version},randomUUID())).rejects.toMatchObject({statusCode:403});
   });
   const renewal=await preparation.read(root,resource);
   expect(renewal).toMatchObject({sourceId:linked.sourceId,orderInstructionVersion:revision});
   const historicalDesigner=await preparation.read(designer,resource);
   expect(historicalDesigner.canRecord).not.toContain('design_handover');
   expect(historicalDesigner.orderInstructionVersion).toBeUndefined();
   await expect(handover(1,handed.orderInstructionVersion!)).rejects.toMatchObject({statusCode:409});
  }
  const renewed=await handover(1,revision,renewedAt),renewedHandover=renewed.facts.find(row=>row.kind==='design_handover')!,basis=renewedHandover.investmentScopeBasis!;
  if(linked){
   expect(renewedHandover).toMatchObject({recordId:handed.recordId,version:2,resource,sourceDocumentVersion:null,orderInstructionVersion:revision,valid:true,occurredAt:renewedAt});
   expect(basis.materialIds).toEqual(expect.arrayContaining([fabricId,accessoryId]));
   const wrongBasis={...purchase,kind:'design_handover' as const,expectedVersion:2,quantities:[],sourceDocumentVersion:linked.version,recipientId:merch.actorId};
   await h.f.runtime.run(scene,root,async()=>{
    await expect(preparation.record(root,resource,wrongBasis,randomUUID())).rejects.toMatchObject({statusCode:409});
    await expect(preparation.record(designer,resource,{...wrongBasis,sourceDocumentVersion:null,orderInstructionVersion:revision},randomUUID())).rejects.toMatchObject({statusCode:403});
   });
   expect((await preparation.read(root,resource)).facts.find(row=>row.kind==='design_handover')).toEqual(renewedHandover);
  }
  expect(basis.materialFingerprints[fabricId]).not.toBe(handed.investmentScopeBasis!.materialFingerprints[fabricId]);
  expect(basis.materialFingerprints[accessoryId]).toBe(handed.investmentScopeBasis!.materialFingerprints[accessoryId]);
  const todos=()=>h.f.runtime.run(scene,merch,()=>materialInvestmentTodos(h.db,merch,{todoId:handed.recordId}));
  expect(await todos()).toMatchObject([{dueAt:null,route:{entityId:orderId}}]);
  const result=await h.f.runtime.run(scene,merch,()=>preparation.record(merch,resource,{...purchase,expectedVersion:1,occurredAt:renewedAt,
   investmentMaterialId:fabricId,quantities:[purchase.quantities[0]!] },randomUUID()));
  const completed=result.facts.find(row=>row.kind==='material_investment')!;
  expect(completed).toMatchObject({recordId:before.recordId,version:2,state:'ready'});
  expect(completed.investmentMaterialOccurrences?.[accessoryId]).toEqual(before.investmentMaterialOccurrences?.[accessoryId]);
  expect(await todos()).toEqual([]);
 });

 it('replaces corrected investment rows without completing a missing material, and retains genuine independent additions',async()=>{
  const {h,merch,root,scene,started,orderId,requests}=await directMaterialOrder(2);
  const resource={kind:'order' as const,id:orderId},service=new ProductionReadinessService(h.db),instruction=new ProductionInstructionService(h.db,true);
  const fabricA=randomUUID(),fabricB=randomUUID();
  const handover=await h.f.runtime.run(scene,root,async()=>{
   const current=await instruction.read(merch,orderId);
   const saved=await instruction.save(merch,orderId,{expectedVersion:current.version,orderVersion:current.currentOrderVersion,
    document:{...initialInstruction(),secondaryCraft:'无',preshrink:'无需预缩',
     fabrics:[{id:fabricA,name:'TEST A布',part:'本身',colors:{},remarks:''},{id:fabricB,name:'TEST B布',part:'本身',colors:{},remarks:''}]}},randomUUID());
   const state=await service.record(root,resource,{kind:'design_handover',scopeRef:'whole',expectedVersion:0,state:'ready',occurredAt:started,
    note:'TEST 实际交接 A 与 B',quantities:[],evidenceIds:[],sourceDocumentVersion:null,orderInstructionVersion:saved.version,recipientId:merch.actorId},randomUUID());
   const check=await requests.check(root,{kind:'arrangement',resource});
   await requests.arrange(root,{resource,fingerprint:check.fingerprint,overrides:{},acceptLate:true},randomUUID());
   return {fact:state.facts.find(row=>row.kind==='design_handover')!,lines:state.lines};
  });
  const rowA={lineId:handover.lines[0]!.lineId,materialId:fabricA,name:'TEST A布',quantity:20,unit:'米'};
  const rowB={lineId:handover.lines[1]!.lineId,materialId:fabricB,name:'TEST B布',quantity:12,unit:'米'};
  const input={kind:'material_investment' as const,scopeRef:'whole',expectedVersion:0,state:'ready' as const,occurredAt:started,
   note:'TEST 原投料登记',quantities:[rowA],evidenceIds:[],sourceDocumentVersion:null,recipientId:null,investmentMaterialId:fabricA};
  const record=(value:typeof input&{investmentQuantityCorrection?:{index:number;previous:typeof rowA}})=>
   h.f.runtime.run(scene,merch,()=>service.record(merch,resource,value,randomUUID()));
  const first=await record(input),initial=first.facts.find(row=>row.kind==='material_investment')!;
  expect(initial).toMatchObject({state:'partial',version:1,quantities:[rowA]});
  expect(first.materialInvestmentReminder?.dueAt).toBeTruthy();
  const correctionTime='2027-04-25T05:00:00.000Z';await h.f.advance(scene,correctionTime);
  const correction={...input,expectedVersion:1,occurredAt:correctionTime,note:'TEST 原 A 误记，实际为 B',quantities:[rowB],
   investmentMaterialId:fabricB,investmentQuantityCorrection:{index:0,previous:rowA}};
  const corrected=await record(correction),replacement=corrected.facts.find(row=>row.kind==='material_investment')!;
  expect(replacement).toMatchObject({recordId:initial.recordId,version:2,state:'partial',quantities:[rowB],occurredAt:correctionTime});
  expect(replacement.investmentMaterialOccurrences?.[fabricA]).toBeUndefined();
  expect(corrected.history.find(row=>row.recordId===initial.recordId&&row.version===1)).toMatchObject({quantities:[rowA],occurredAt:started});
  expect(corrected.materialInvestmentReminder?.dueAt).toBe(first.materialInvestmentReminder!.dueAt);
  expect(await h.f.runtime.run(scene,merch,()=>materialInvestmentTodos(h.db,merch,{todoId:handover.fact.recordId})))
   .toMatchObject([{dueAt:first.materialInvestmentReminder!.dueAt}]);
  await expect(record(correction)).rejects.toMatchObject({statusCode:409});
  await expect(record({...correction,expectedVersion:2})).rejects.toMatchObject({statusCode:409});

  const actualTime='2027-04-25T06:00:00.000Z';await h.f.advance(scene,actualTime);
  await record({...input,expectedVersion:2,occurredAt:actualTime,note:'TEST 从 B 订正为真实 A',investmentQuantityCorrection:{index:0,previous:rowB}});
  const added=await record({...input,expectedVersion:3,occurredAt:actualTime,note:'TEST 独立追加真实 B',quantities:[rowB],investmentMaterialId:fabricB});
  expect(added.facts.find(row=>row.kind==='material_investment')).toMatchObject({recordId:initial.recordId,version:4,state:'ready',quantities:[rowA,rowB]});
  expect(added.materialInvestmentReminder).toBeUndefined();
  expect(await h.f.runtime.run(scene,merch,()=>materialInvestmentTodos(h.db,merch,{todoId:handover.fact.recordId}))).toEqual([]);
  const moved={...rowA,lineId:handover.lines[1]!.lineId,unit:'码',quantity:22};
  const movedResult=await record({...input,expectedVersion:4,occurredAt:actualTime,note:'TEST 订正 A 的 PO 及单位',quantities:[moved],
   investmentQuantityCorrection:{index:0,previous:rowA}});
  const movedInvestment=movedResult.facts.find(row=>row.kind==='material_investment')!;
  expect(movedInvestment).toMatchObject({version:5,state:'ready',quantities:[moved,rowB]});
  expect(movedInvestment.investmentMaterialOccurrences?.[fabricB]).toEqual(
   added.facts.find(row=>row.kind==='material_investment')!.investmentMaterialOccurrences?.[fabricB]);
  expect(movedResult.history.find(row=>row.recordId===initial.recordId&&row.version===4)).toMatchObject({quantities:[rowA,rowB]});
 });
 it('Acceptance H1 projects an exact PO receipt and the shared positive control without mixing original snapshots',async()=>{
  const {h,merch,root,scene,started,orderId}=await directMaterialOrder(2);
  const resource={kind:'order' as const,id:orderId},receipts=new ProductionReadinessService(h.db);
  const instructions=new ProductionInstructionService(h.db,true),warehouse=h.f.people.warehouse!;
  const perPO=randomUUID(),shared=randomUUID();
  await h.f.runtime.run(scene,root,async()=>{
   const current=await instructions.read(merch,orderId);
   const saved=await instructions.save(merch,orderId,{expectedVersion:current.version,orderVersion:current.currentOrderVersion,
    document:{...initialInstruction(),secondaryCraft:'无',preshrink:'无需预缩',
     fabrics:[{id:perPO,name:'TEST H1 原 PO 主布',part:'本身',colors:{},remarks:''},{id:shared,name:'TEST H1 共享料',part:'本身',colors:{},remarks:''}]}},randomUUID());
   const common={scopeRef:'whole',expectedVersion:0,state:'ready' as const,occurredAt:started,evidenceIds:[],sourceDocumentVersion:null,recipientId:null};
   const handover=await receipts.record(root,resource,{...common,kind:'design_handover',note:'TEST 原实物采购范围交接',quantities:[],
    orderInstructionVersion:saved.version,recipientId:merch.actorId},randomUUID());
   const [a,b]=handover.lines;
   const purchase={materialId:perPO,lineId:a!.lineId,name:'TEST H1 原 PO 主布',quantity:60,unit:'米'};
   await receipts.record(merch,resource,{...common,kind:'material_investment',note:'TEST 原实际投料',quantities:[purchase,
    {materialId:shared,lineId:null,name:'TEST H1 共享料',quantity:60,unit:'米'}]},randomUUID());
   await receipts.assign(root,resource,{expectedVersion:0,warehouseWorkerId:warehouse.actorId,colorConfirmationWorkerId:null,colorConfirmationRole:null,
    reason:'TEST 原收料任务指派'},randomUUID());
   const old=(expectedVersion:number,quantities:Array<typeof purchase>)=>receipts.record(warehouse,resource,
    {...common,expectedVersion,kind:'fabric_receipt',note:'TEST 同一资源原整单快照',quantities},randomUUID());
   await old(0,[{...purchase,lineId:b!.lineId,quantity:3}]);
   const work=()=>receipts.warehouseReceiptWork(warehouse,resource);
   const native=await work();
   const recordBatch=(item:typeof native[number],quantity:string,expectedReceiptVersion=0,replaces?:{recordId:string;version:number})=>
    receipts.recordWarehouseReceiptBatch(warehouse,resource,{kind:item.kind,scopeRef:item.scopeRef,lineId:item.lineId,materialId:item.materialId,
     supplierId:item.basis.supplierId,unit:'米',investment:item.purchase.original,materialFingerprint:item.basis.adoptedRef,quantity,
     expectedReceiptVersion,occurredAt:started,note:'TEST 原仓库实际批次',...(replaces?{replaces}:{})},randomUUID());
   const exact= native.find(row=>row.materialId===perPO)!,commonTask=native.find(row=>row.materialId===shared)!;
   await recordBatch(exact,'20');
   await recordBatch(commonTask,'10');
   const found=(await work()).find(row=>row.materialId===perPO)!;
   expect(found).toMatchObject({lineId:a!.lineId,scopeRef:'whole',received:{quantity:'20',unit:'米'},balance:{procurementRemaining:'40'},
    activeBatches:[{quantity:{quantity:'20',unit:'米'}}]});
   expect(found.productionRequired).toBeNull();
   const page=await receipts.warehouseReceipts(warehouse,{search:'TEST H1 原 PO 主布',status:'open',page:1});
   expect(page.items).toMatchObject([{lineId:a!.lineId,materialId:perPO,received:{quantity:'20',unit:'米'},balance:{procurementRemaining:'40'}}]);
   const poLabels=(await h.db.query<{po_number:string}>('SELECT coalesce(po_number,formal_style_no) AS po_number FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position',[orderId])).rows;
   const byPo=(position:number)=>receipts.warehouseReceipts(warehouse,{search:poLabels[position]!.po_number,status:'open',page:1});
   const [poA,poB]=await Promise.all([byPo(0),byPo(1)]);
   expect(poA.items.map(row=>row.materialId).sort()).toEqual([perPO,shared].sort());
   expect(poB.items.map(row=>row.materialId)).toEqual([shared]);
   expect(poA.items.find(row=>row.materialId===perPO)).toMatchObject({received:{quantity:'20',unit:'米'},balance:{procurementRemaining:'40'}});
   expect(poB.items[0]).toMatchObject({received:{quantity:'10',unit:'米'},balance:{procurementRemaining:'50'}});
   expect((await work()).find(row=>row.materialId===shared)).toMatchObject({lineId:null,received:{quantity:'10',unit:'米'},balance:{procurementRemaining:'50'}});
   const oldOverlap=await old(1,[{...purchase,quantity:22}]);
   expect((await work()).find(row=>row.materialId===perPO)).toMatchObject({received:null,balance:{procurementRemaining:null},
    activeBatches:[{quantity:{quantity:'20'}}]});
   const oldMarker=await old(2,[]);
   expect(oldMarker.history.find(row=>row.kind==='fabric_receipt'&&row.scopeRef==='whole'&&row.version===2)?.quantities)
    .toEqual(oldOverlap.facts.find(row=>row.kind==='fabric_receipt')?.quantities);
   await recordBatch(exact,'18',1,found.activeBatches[0]!.ref);
   expect((await work()).find(row=>row.materialId===perPO)).toMatchObject({received:{quantity:'18',unit:'米'},balance:{procurementRemaining:'42'},
    activeBatches:[{ref:{recordId:found.activeBatches[0]!.ref.recordId,version:2}}]});
   expect((await work()).find(row=>row.materialId===shared)).toMatchObject({received:{quantity:'10',unit:'米'},balance:{procurementRemaining:'50'}});
  });
 });
 it('adopts the first material cutoff for the same formal handover only after supplying its missing lead time',async()=>{
  const {h,merch,root,scene,started,orderId,requests}=await directMaterialOrder();
  const resource={kind:'order' as const,id:orderId},operation={kind:'arrangement' as const,resource};
  const preparation=new ProductionReadinessService(h.db),instruction=new ProductionInstructionService(h.db,true),repo=new OrderTimePlanRepository(h.db);
  const accessoryId=randomUUID();
  const original={...initialInstruction(),secondaryCraft:'无' as const,preshrink:'无需预缩' as const,
   accessories:[{id:accessoryId,group:'车缝' as const,garmentColors:'',materialColor:'黑',name:'TEST 原制单纽扣',
    category:'',part:'门襟',specification:'15mm',consumption:'2枚',remarks:''}]};
  const save=async(document:typeof original)=>{
   const current=await instruction.read(merch,orderId);
   return instruction.save(merch,orderId,{expectedVersion:current.version,orderVersion:current.currentOrderVersion,document},randomUUID());
  };
  const adopted=async()=>{
   const record=(await repo.current(resource))!;
   const milestones=Object.values(record.input.frameworkPlans!)[0]!.milestones;
   return {record,milestones,material:milestones.find(row=>row.key==='material_investment')!};
  };
  const first=await h.f.runtime.run(scene,root,async()=>{
   const saved=await save(original);
   await preparation.record(root,resource,{kind:'design_handover',scopeRef:'whole',expectedVersion:0,state:'ready',occurredAt:started,
    note:'TEST 正式交接辅料范围，采购周期尚缺',quantities:[],evidenceIds:[],sourceDocumentVersion:null,
    orderInstructionVersion:saved.version,recipientId:merch.actorId},randomUUID());
   const check=await requests.check(root,operation);
   await requests.arrange(root,{resource,fingerprint:check.fingerprint,overrides:{},acceptLate:true},randomUUID());
   const result=await adopted();
   expect(result.material).toMatchObject({target:{at:null},materialInvestmentTargetBasis:{scope:{fabric:false,accessories:true},branches:[{kind:'accessories',leadTime:null}]}});
   expect((await preparation.read(merch,resource)).materialInvestmentReminder).toBeUndefined();
   return result;
  });
  const settings=new OrderTimeSettingsService(h.db),standard=await settings.read(root);
  const rule=orderTimeRule(first.record.input.plan,'material_investment')?.rule;
  if(rule?.kind!=='event')throw Error('Expected original material event');
  const supplied={...rule,accessoriesLeadTime:{minutes:1440,calendar:'continuous' as const}};
  await settings.save(root,{expectedVersion:standard.version,values:{...standard.current,nodes:{...standard.current.nodes,material_investment:supplied}}},randomUUID());
  expect((await adopted()).record).toEqual(first.record);
  expect((await preparation.read(merch,resource)).materialInvestmentReminder).toBeUndefined();
  await h.f.runtime.run(scene,root,async()=>{
   await save({...original,accessories:[{...original.accessories[0]!,specification:'25mm'}]});
   const wrongScope=await requests.check(root,operation);
   expect(wrongScope.framework?.milestones.find(row=>row.key==='material_investment')?.target.at).toBeNull();
   await save(original);
   const expectedArrival=first.milestones.find(row=>row.key==='accessories_ready')!.target;
   const expectedDue=new Date(Date.parse(expectedArrival.at!)-86_400_000).toISOString();
   const preview=await requests.check(root,operation);
   expect(preview.framework?.milestones.find(row=>row.key==='material_investment')?.target).toMatchObject({at:expectedDue,exclusive:expectedArrival.exclusive});
   expect((await preparation.read(merch,resource)).materialInvestmentReminder).toBeUndefined();
   expect((await adopted()).record).toEqual(first.record);
   await requests.arrange(root,{resource,fingerprint:preview.fingerprint,overrides:{},acceptLate:true},randomUUID());
   const second=await adopted();
   expect(second.material.target.at).toBe(expectedDue);
   expect(second.material.materialInvestmentTargetBasis?.scope).toEqual(first.material.materialInvestmentTargetBasis?.scope);
   expect(second.milestones.filter(row=>row.key!=='material_investment')).toEqual(first.milestones.filter(row=>row.key!=='material_investment'));
   const reminder=(await preparation.read(merch,resource)).materialInvestmentReminder!;
   expect(reminder).toMatchObject({dueAt:expectedDue,startedAt:started,adoptedPlanId:second.record.id});
   expect(await materialInvestmentTodos(h.db,merch,{todoId:reminder.handoverId})).toMatchObject([{dueAt:expectedDue}]);
   const third={material_investment:{...supplied,accessoriesLeadTime:{...supplied.accessoriesLeadTime,minutes:2880}}};
   const thirdPreview=await requests.check(root,operation,third);
   await requests.arrange(root,{resource,fingerprint:thirdPreview.fingerprint,overrides:third,acceptLate:true},randomUUID());
   expect((await adopted()).material).toEqual(second.material);
   expect((await adopted()).milestones.filter(row=>row.key!=='material_investment')).toEqual(first.milestones.filter(row=>row.key!=='material_investment'));
   expect((await preparation.read(merch,resource)).materialInvestmentReminder?.dueAt).toBe(expectedDue);
   const old=(await h.db.query('SELECT input_snapshot FROM digital_order_time_plan_versions WHERE plan_version_id=$1',[first.record.id])).rows[0];
   expect(old.input_snapshot).toEqual(first.record.input);
  });
 });
 it.each(['before','after'] as const)('uses the original direct order handover and overdue cutoff when the source is linked %s adoption',async(linkWhen)=>{
  const order=await directMaterialOrder(),{h,merch,root,started,scene,requests,orderId}=order;
  const preparation=new ProductionReadinessService(h.db),instruction=new ProductionInstructionService(h.db,true),plans=new OrderTimePlanRepository(h.db);
  const resource={kind:'order' as const,id:orderId},materialId=randomUUID();
  const handover={kind:'design_handover' as const,scopeRef:'whole',expectedVersion:0,state:'ready' as const,occurredAt:started,
   note:'TEST 无来源正式单的实际交接',quantities:[],evidenceIds:[],sourceDocumentVersion:null,recipientId:merch.actorId};
  const noTarget=await h.f.runtime.run(scene,root,async()=>{
   const state=await preparation.record(root,resource,handover,randomUUID()),fact=state.facts.find(row=>row.kind==='design_handover')!;
   expect(state.sourceId).toBeNull();expect(fact.investmentScopeBasis).toBeUndefined();
   expect((await materialInvestmentTodos(h.db,merch,{todoId:fact.recordId}))[0]).toMatchObject({dueAt:null,route:{entityId:orderId}});
   return {original:await plans.current(resource),handoverId:fact.recordId};
  });
  const originalInvestment=await h.f.runtime.run(scene,merch,async()=>{
   const saved=await preparation.record(merch,resource,{...handover,kind:'material_investment',recipientId:null,
    quantities:[{lineId:null,materialId:null,name:'TEST 原单无明细的投料',quantity:10,unit:'米'}]},randomUUID());
   const fact=saved.facts.find(row=>row.kind==='material_investment')!;
   expect(fact).toMatchObject({state:'ready',version:1});expect(fact.investmentScopeBasis).toBeUndefined();
   return fact;
  });
  const version=await h.f.runtime.run(scene,merch,async()=>{
   const current=await instruction.read(merch,orderId);
   expect(current.canEdit).toBe(true);
   return (await instruction.save(merch,orderId,{expectedVersion:current.version,orderVersion:current.currentOrderVersion,
    document:{...initialInstruction(),secondaryCraft:'无',preshrink:'无需预缩',fabrics:[{id:materialId,name:'TEST 本单原制单主布',part:'本身',colors:{},remarks:''}]}},randomUUID())).version;
  });
  const cutoff=await h.f.runtime.run(scene,root,async()=>{
   await expect(preparation.record(root,resource,{...handover,expectedVersion:1},randomUUID())).rejects.toMatchObject({statusCode:409});
   const authorized=await preparation.record(root,resource,{...handover,expectedVersion:1,orderInstructionVersion:version},randomUUID());
   expect(authorized.facts.find(row=>row.kind==='design_handover')).toMatchObject({resource,recordId:noTarget.handoverId,
    investmentScopeBasis:{orderInstructionVersion:version,materialIds:[materialId]}});
   expect(authorized.facts.find(row=>row.kind==='material_investment')).toMatchObject({recordId:originalInvestment.recordId,state:'partial',version:1});
   expect(authorized.history.find(row=>row.recordId===originalInvestment.recordId)).toMatchObject({state:'ready',occurredAt:originalInvestment.occurredAt});
   expect((await preparation.read(merch,resource)).materialInvestmentReminder).toBeUndefined();
   if(linkWhen==='before'){
    await attachDirectMaterialOrderSource(order);
    expect((await materialInvestmentTodos(h.db,merch,{todoId:noTarget.handoverId}))[0]).toMatchObject({dueAt:null,route:{entityId:orderId}});
   }
   const check=await requests.check(root,{kind:'arrangement',resource});
   await requests.arrange(root,{resource,fingerprint:check.fingerprint,overrides:{},acceptLate:true},randomUUID());
   const exact=await plans.current(resource),targets=(saved:NonNullable<typeof exact>)=>Object.values(saved.input.frameworkPlans!)[0]!.milestones;
   expect(targets(exact!).filter(row=>row.key!=='material_investment').map(row=>row.target))
    .toEqual(targets(noTarget.original!).filter(row=>row.key!=='material_investment').map(row=>row.target));
   const target=targets(exact!).find(row=>row.key==='material_investment')!;
   expect(target.materialInvestmentTargetBasis).toMatchObject({scope:{reference:expect.stringContaining('order:'+orderId+':')}});
   expect(target.target.at).toBeTruthy();
   return target.target.at!;
  });
  await h.f.runtime.run(scene,root,async()=>{
   const reminder=(await preparation.read(merch,resource)).materialInvestmentReminder!;
   expect(reminder).toMatchObject({handoverId:noTarget.handoverId,startedAt:started,dueAt:cutoff,warningAt:null,status:'overdue',canClose:true});
   expect((await materialInvestmentTodos(h.db,merch,{todoId:noTarget.handoverId}))[0]).toMatchObject({dueAt:cutoff});
   const notify=new DigitalProductionNotificationService(h.db);await notify.runOnce();await notify.runOnce();
   expect((await h.db.query("SELECT count(*)::int AS n FROM digital_production_notification_events WHERE event_kind='material_investment' AND todo_id=$1",[noTarget.handoverId])).rows[0]!.n).toBe(1);
   if(linkWhen==='after')await attachDirectMaterialOrderSource(order);
   expect((await preparation.read(merch,resource)).materialInvestmentReminder).toMatchObject({fingerprint:reminder.fingerprint,dueAt:cutoff});
   expect((await materialInvestmentTodos(h.db,merch,{todoId:noTarget.handoverId}))[0]).toMatchObject({dueAt:cutoff,route:{entityId:orderId}});
   await notify.runOnce();
   expect((await h.db.query("SELECT count(*)::int AS n FROM digital_production_notification_events WHERE event_kind='material_investment' AND todo_id=$1",[noTarget.handoverId])).rows[0]!.n).toBe(1);
   await expect(preparation.closeMaterialInvestmentReminder(h.f.people.warehouse!,resource,{fingerprint:reminder.fingerprint,reason:'TEST 不具原权限'},randomUUID())).rejects.toMatchObject({statusCode:403});
   await preparation.closeMaterialInvestmentReminder(merch,resource,{fingerprint:reminder.fingerprint,reason:'TEST 已处理逾期提醒'},randomUUID());
   expect((await materialInvestmentTodos(h.db,merch,{todoId:noTarget.handoverId}))[0]).toMatchObject({dueAt:cutoff});
   await preparation.record(merch,resource,{...handover,kind:'material_investment',expectedVersion:1,recipientId:null,
    quantities:[{lineId:null,materialId,name:'TEST 本单原制单主布',quantity:20,unit:'米'}]},randomUUID());
   expect(await materialInvestmentTodos(h.db,merch,{todoId:noTarget.handoverId})).toEqual([]);
   const journey=await new DigitalJourneyQuery(h.db).read(root,orderId,undefined,true);
   expect(journey.riskHistory).toEqual(expect.arrayContaining([expect.objectContaining({label:'投面辅料',deadline:cutoff,assessment:'late'})]));
  });
 });
});
