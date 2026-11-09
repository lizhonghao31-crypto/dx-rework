import type {CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import {productionReadinessFixture,completeBulkRangeFixture} from './production-readiness-fixture.js';
import {customerQuotationFixture} from './customer-quotation-fixture.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import sharp from 'sharp';
import {migrationExecutionSql} from '../../scripts/deploy/migration-execution-compatibility.mjs';
import {assertTestDatabaseTarget} from '../../scripts/test-database-safety.mjs';
import { ownedPostgresSchema, createOwnedPostgresSchema, releaseOwnedPostgresSchema } from './owned-postgres-schema.js';
import {verifyAcceptanceClockServer} from '../../apps/api/src/acceptance-clock/guard.js';
import {AcceptanceClockRuntime} from '../../apps/api/src/acceptance-clock/runtime.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {SlaConfigurationRepository} from '../../apps/api/src/production-platform/sla-configuration-repository.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {DigitalBudgetService} from '../../apps/api/src/production-platform/budget-service.js';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import {CuttingService} from '../../apps/api/src/cutting/cutting-source-service.js';
import {SourcingService} from '../../apps/api/src/sourcing/sourcing-service.js';
import {SourcingContractService} from '../../apps/api/src/sourcing/sourcing-contract-service.js';
import {AccessMasterDataService} from '../../apps/api/src/access/service.js';
import {AttachmentService} from '../../apps/api/src/tools/attachments.js';
import {FakeObjectStorage} from '../../apps/api/src/tools/storage.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import {maintainAcceptanceCuttingWorker} from '../../scripts/acceptance/cutting-worker-maintenance.js';
import {DigitalOrderCreateSchema,beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {BudgetDocumentSchema} from '@dx-rework/contracts/digital-budget';
import {initialInstruction} from '@dx-rework/contracts/production-instruction';
import {CreateSupplierSchema} from '@dx-rework/contracts';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {ReworkInitiationService} from '../../apps/api/src/rework/service.js';
import {ProcessConfigurationService} from '../../apps/api/src/rework/process-configuration-service.js';
import {ProcessWorkerPlanService} from '../../apps/api/src/rework/process-worker-plan-service.js';
import {WorkReportingService} from '../../apps/api/src/rework/work-reporting-service.js';
import {completeInspectionReport} from '../inspection-report-fixture.js';

/** Full current schema and original supported UAT seeder; no trigger or clock guards disabled. */
export async function businessAnchorFixture(url:string,options?:{throughVersion?:string}){
 await assertTestDatabaseTarget(url);
 const databaseTarget=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL===url&&url!==process.env.TEST_DATABASE_URL?'acceptance-clock':undefined;
 const schema=ownedPostgresSchema('business_anchors',databaseTarget),admin=new pg.Pool({connectionString:url});
 await createOwnedPostgresSchema(admin,schema);
 const db=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,application_name:schema,max:10,connectionTimeoutMillis:3000});
 const dispose=async()=>{await db.end();await releaseOwnedPostgresSchema(admin, schema);await admin.end();};
 try{
  const version=Number((await db.query('SHOW server_version_num')).rows[0].server_version_num);
  const manifest=JSON.parse(await readFile(new URL('../../apps/api/src/platform/migration-manifest.json',import.meta.url),'utf8'));
  if(options?.throughVersion&&!manifest.migrations.some((row:{version:string})=>row.version===options.throughVersion))throw Error('Exact historical fixture migration required');
  await db.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  for(const migration of manifest.migrations.filter((row:{version:string})=>!options?.throughVersion||row.version<=options.throughVersion)){const sql=await readFile(new URL(`../../apps/api/migrations/${migration.version}.sql`,import.meta.url),'utf8');await db.query(migrationExecutionSql({...migration,sql},version));await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[migration.version,migration.checksum]);}
  const scoped=new URL(url);scoped.searchParams.set('options',`-c search_path=${schema}`);
  const env={...process.env,DATABASE_URL:'',TEST_DATABASE_URL:url,NODE_ENV:'test',ACCEPTANCE_LAB_ENABLED:'true',ROOT_DINGTALK_USER_ID:'uat-root',DINGTALK_CORP_ID:'anchor-test',ACCEPTANCE_DATABASE_URL:scoped.toString()};
  await promisify(execFile)(process.execPath,['--import','tsx','scripts/acceptance/seed-role-users.ts'],{cwd:process.cwd(),env});
  await maintainAcceptanceCuttingWorker(db,env,['--apply',`--expected-user-id=${randomUUID()}`]);
  const people:Record<string,TrustedActorContext>={};
  for(const row of (await db.query(`SELECT i.user_id,i.provider_user_id,r.role_code FROM identity_mappings i JOIN user_role_assignments r ON r.user_id=i.user_id AND r.revoked_at IS NULL WHERE i.corp_id=$1`,[env.DINGTALK_CORP_ID])).rows){
   people[row.provider_user_id.slice(4)]={actorId:row.user_id,actorRoles:row.provider_user_id==='uat-root'?['root_superuser','owner_group']:[row.role_code],authorizationCapability:'digital_production:view',authorizationCapabilities:['digital_production:view','pattern_room:orders:create','sourcing:view','sourcing:inquiry:create','sourcing:price:quote','sourcing:decision:record','sourcing:owner:approve'],requestId:randomUUID()};
  }
  for(const [alias,capability] of Object.entries({'production-management':'sourcing:decision:record',owner:'sourcing:owner:approve',ie:'sourcing:price:quote',merchandiser:'sourcing:inquiry:create'}))people[alias]={...people[alias]!,authorizationCapability:capability};
  await db.query("UPDATE digital_production_customers SET default_merchandiser_id=$1 WHERE code='PD'",[people.merchandiser!.actorId]);
  const root=people.root!,runtime=new AcceptanceClockRuntime(db,await verifyAcceptanceClockServer(db,url,env),'TEST-only-business-anchor-'.repeat(3),true);
  const storage=new FakeObjectStorage(),attachments=new AttachmentService(db,storage,{prefix:'TEST',ttlSeconds:60,maxUploadBytes:1000000});
  const contracts=new SourcingContractService(db,attachments),sourcing=new SourcingService(db,undefined,undefined,undefined,contracts);
  const access=new AccessMasterDataService(db,env.DINGTALK_CORP_ID);
  const supplier=await access.createSupplier(root,CreateSupplierSchema.parse({supplierCode:'TEST-ANCHOR-FACTORY',supplierType:'factory',supplierName:'TEST anchor factory',address:'TEST',contractEntityName:'TEST factory',partyBRepresentative:'TEST',payeeName:'TEST',bankAccount:'TEST0001',bankName:'TEST',changeReason:'TEST isolated native fixture'}));
  const craft=(await access.ensureCrafts(people['production-management']!,{craftNames:['TEST车缝']}))[0]!;
  const image=async(actor:TrustedActorContext)=>{
   const bytes=await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer(),id=randomUUID(),key=`TEST-anchor/${id}`,hash=createHash('sha256').update(bytes).digest('hex');
   await storage.writeImmutable(key,bytes,{mimeType:'image/png',sha256:hash});
   await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST.png','image/png',$3,$4,$5,'ready',CURRENT_TIMESTAMP)",[id,key,bytes.length,hash,actor.actorId]);
   return id;
  };
  // Past time is an INITIAL condition in a new isolated scenario, never a change to old history.
  const scene=async(at:string)=>{
   const id=randomUUID(),client=await db.connect();
   try{await client.query('BEGIN');const config=await new SlaConfigurationRepository(client).initialStandard(root.actorId);
    await client.query(`INSERT INTO acceptance_sla_clock_scenarios(scenario_id,name,corporation_id,initial_time,business_now,configuration_id,created_by,request_key) VALUES($1,'TEST native anchors',$2,$3,$3,$4,$5,$6)`,[id,env.DINGTALK_CORP_ID,at,config.configurationId,root.actorId,randomUUID()]);
    await client.query('COMMIT');return id;
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  };
  const advance=async(id:string,at:string)=>runtime.run(id,root,async()=>{const row=await runtime.repository.row(id);await runtime.repository.change(id,root.actorId,{expectedVersion:row.version,requestKey:randomUUID(),at});});
  const bulkReady=async(secondaryCraft:'无'|'印花'|'绣花'|'印绣花',beforeCreate?:(input:Parameters<SourcingService['createCase']>[1],key:string,primary:TrustedActorContext)=>Promise<void>,poCount=1,sourcingCommands=sourcing,options?:{stopBeforeCompletion?:boolean;cuttingProcess?:'in_house'|'outsourced';accessory?:boolean;quantity?:number;primaryActor?:TrustedActorContext;designerActor?:TrustedActorContext;stylePrefix?:string;craftSteps?:CraftStepChoice[]})=>{
   const designer=options?.designerActor??people['sample-designer']!,primary=options?.primaryActor??people.merchandiser!,manager=people['production-management']!,owner=people.owner!,ie=people.ie!;
   const identity=new DigitalProductionIdentityService(db,true),forms=new DigitalDevelopmentService(db,true),bulk=new BulkPreparationService(db),instruction=new ProductionInstructionService(db,true),budget=new DigitalBudgetService(db,true);
   const style=`${options?.stylePrefix??'TEST-ANCHOR-'}${randomUUID()}`;
   const order=await identity.createOrder(designer,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,orderDate:beijingCalendarDate(businessNow()),primaryMerchandiserId:primary.actorId,lines:Array.from({length:poCount},(_,index)=>({formalPoNo:poCount===1?style:`${style}-${index+1}`,color:index?'白':'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:options?.quantity??10}]}))}),randomUUID());
   const id=order.productionOrderId,source=await identity.createSource(designer,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
   await identity.attachSource(designer,id,source.sourceId,randomUUID());
   const photo=await image(designer);
   const development=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:null,unit:'inch',sizes:['M'],measurements:[{name:'袖长',values:['6']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'',craft:'无',washing:'免洗',materials:[{materialId:randomUUID(),category:'主布',label:'主布',supplier:'TEST',name:'TEST真实主布',width:'150',weight:'200',composition:'棉',consumption:'1',color:'黑',specification:'TEST',quantity:'1',requiredThisRound:true,available:true,expectedDate:null}],files:[{attachmentId:photo,kind:'款图'}]});
   const saved=await forms.save(designer,source.sourceId,{expectedVersion:0,document:development},randomUUID());await forms.publish(designer,source.sourceId,saved.version,randomUUID());
   // Development completion is a fixture precondition; the production path below uses native commands.
   await db.query("INSERT INTO digital_development_route_facts(fact_id,source_id,route_version,kind,payload,actor_id) VALUES($1,$2,1,'最终设计确认','{}',$3)",[randomUUID(),source.sourceId,designer.actorId]);
   // This clock fixture performs a real warehouse preshrink action below; request it explicitly.
   const current=await identity.read(primary,id),instructionDoc={...initialInstruction(),...(options?.accessory?{accessories:[{id:randomUUID(),group:'车缝' as const,garmentColors:'黑',materialColor:'黑',name:'TEST纽扣',category:'扣',part:'门襟',specification:'TEST',consumption:'1',remarks:''}]}:{}),styleName:'TEST产前',secondaryCraft,...(options?.craftSteps?{craftSteps:options.craftSteps}:{}),category:'上衣',date:beijingCalendarDate(businessNow()),preshrink:'需要预缩' as const,sizes:['M'],measurements:[{id:randomUUID(),name:'袖长',tolerance:'±1/4',method:'平量',values:['6']}],images:[{attachmentId:photo,kind:'款图' as const,description:'TEST'}]};
   await instruction.save(primary,id,{expectedVersion:0,orderVersion:current.version,sourceRound:1,document:instructionDoc},randomUUID());const readyBasis=await productionReadinessFixture(db,root,id,people['pattern-room-worker']!.actorId,people.warehouse!);await instruction.publish(primary,id,{expectedVersion:1,orderVersion:current.version,expectedReadinessRevision:readyBasis.revision},randomUUID());
   await bulk.dispatch(manager,id,{expectedVersion:0,patternWorkerId:people['pattern-room-worker']!.actorId,warehouseWorkerId:people.warehouse!.actorId,cuttingWorkerId:people['cutting-worker']!.actorId,deliverPattern:false},randomUUID());
   await customerQuotationFixture(db,root,id);
   const budgetImage=await image(designer),budgetDoc=BudgetDocumentSchema.parse({fabricType:'梭织',productCategory:'上衣',date:beijingCalendarDate(businessNow()),currency:'人民币',monthSeries:'',rows:[],freight:'0',cm:'5',salePrice:'20',outsourcingScope:'车缝',outsourcingUnitPrice:'5',imageAttachmentIds:[budgetImage]});
   await budget.save(designer,id,{expectedVersion:1,document:budgetDoc},randomUUID());await budget.publish(primary,id,2,randomUUID());
   const prepared=await budget.prepareSourcing(primary,id,2,attachments);
   const input={gender:prepared.gender,styleName:prepared.styleName,deliveryDate:'2026-12-10',estimatedCutPieceSendDate:'2026-11-01',daxingUnitPrice:prepared.daxingUnitPrice,attachmentIds:prepared.images.map(i=>i.attachmentId),lineItems:prepared.lineItems.map(({lineId,styleNo,alternateStyleNo,color,quantity})=>({lineId,styleNo,alternateStyleNo,color,quantity,factoryDeliveryDate:'2026-12-10'})),digitalBudget:{productionOrderId:id,budgetVersion:prepared.budgetVersion,orderVersion:prepared.orderVersion}};
   const key=randomUUID();await beforeCreate?.(input,key,primary);
   const created=await sourcingCommands.createCase(primary,input,key),caseId=created.value.sourcingCaseId;
   const prices=input.lineItems.map((_,index)=>({position:index+1,unitPrice:'5'}));await sourcingCommands.quoteIePrice(ie,caseId,{linePrices:prices},randomUUID());await sourcingCommands.recordManagementDecision(manager,caseId,{supplierId:supplier.supplierId,craftIds:[craft.craftId],linePrices:prices,cuttingProcess:options?.cuttingProcess??'in_house'},randomUUID());
   await sourcingCommands.decideOwner(owner,caseId,{decision:'approved'},randomUUID());
   // The final customer/size prerequisites were established before final publication above.
   await bulk.dispatch(people['development-clerk']!,id,{expectedVersion:1,patternWorkerId:people['pattern-room-worker']!.actorId,deliverPattern:true},randomUUID());
   {const fabric=(await bulk.read(people.warehouse!,id)).fabric;if(!fabric?.usable)throw Error('TEST final instruction prerequisite must retain actual usable fabric');}
   const sheet=await bulk.read(primary,id);
   if(!options?.stopBeforeCompletion)for(const kind of ['纸样完成','唛架完成','预缩完成'] as const)await completeBulkRangeFixture(db,kind==='预缩完成'?people.warehouse!:people['pattern-room-worker']!,id,sheet.preparationId!,kind);
   return {id,caseId,sourceId:source.sourceId,preparationId:sheet.preparationId!,input,key,cutting:new CuttingService(db),primary};
  };
  const reworkReady=async()=>{
   const ready=await bulkReady('无'),cut=(await db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0];
   const cutter={...people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await image(cutter)]},randomUUID());
   const warehouse={...people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
   const receipt=await new ReceivingService(db).create(warehouse,{cuttingOrderId:cut.cutting_order_id,documentQuantity:10,actualQuantity:10,attachmentIds:[await image(warehouse)]},randomUUID());
   const qc={...people.qc!,authorizationCapability:'rework:initiate',authorizationCapabilities:['rework:initiate']};
   const initiation=new ReworkInitiationService(db,env.DINGTALK_CORP_ID),configuration=new ProcessConfigurationService(db),plan=new ProcessWorkerPlanService(db),work=new WorkReportingService(db);
   const draft=await initiation.createDraft(qc,{receivingBatchId:receipt.value.receivingBatchId,styleNo:ready.input.lineItems[0]!.styleNo!,orderQuantity:10,merchandiserUserId:people.merchandiser!.actorId,processingFactory:{type:'supplier',supplierId:supplier.supplierId},tailInspectionRequired:false,inspectionReport:completeInspectionReport(),problemPart:'袖口',problemDescription:'TEST native clock',reworkQuantity:10,attachmentIds:[await image(qc)]},randomUUID());
   const submitted=await initiation.submit(qc,draft.value.reworkOrderId,{expectedVersion:draft.value.version},randomUUID());
   const id=submitted.value.reworkOrderId,master={...root,authorizationCapability:'master_data:manage',authorizationCapabilities:['master_data:manage','access:admin']};
   const process=await access.createProcess(master,{processCode:`TEST${randomUUID().slice(0,8).toUpperCase()}`,processName:'TEST修补',pricingUnit:'piece',active:true,changeReason:'TEST native clock'});
   const tail={...people['tail-supervisor']!,authorizationCapability:'process:configure',authorizationCapabilities:['process:configure','work:assign']};
   const saved=await configuration.saveDraft(tail,id,{expectedOrderVersion:submitted.value.version,items:[{source:'catalog',processId:process.processId,executionKind:'worker',plannedQuantity:10,pricingUnit:'piece',unitPrice:1}]},randomUUID());
   const own=(await db.query('SELECT person_id FROM business_people WHERE app_user_id=$1',[people['worker-a']!.actorId])).rows[0].person_id;
   const temporary=(await access.createPerson(master,{personType:'temporary',displayName:'TEST临时工',aliases:[],reason:'TEST native batch capability groups'})).personId;
   const assign={...tail,authorizationCapability:'work:assign'};
   await plan.save(assign,id,{expectedOrderVersion:saved.value.orderVersion,configurationId:saved.value.configuration!.configurationId,expectedConfigurationVersion:saved.value.configuration!.configurationVersion,assignments:[{configurationItemId:saved.value.configuration!.items[0]!.configurationItemId,memberIds:[own,temporary]}]},randomUUID());
   const queued=await configuration.submit(tail,id,{expectedOrderVersion:saved.value.orderVersion,expectedConfigurationVersion:saved.value.configuration!.configurationVersion},randomUUID());
   const ie={...people.ie!,authorizationCapability:'process:review',authorizationCapabilities:['process:review']};
   const approved=await configuration.review(ie,id,{expectedOrderVersion:queued.value.orderVersion,expectedConfigurationVersion:queued.value.configuration!.configurationVersion,decision:'approved'},randomUUID());
   await plan.activateAfterIeApproval(id,approved.value.configuration!.configurationVersion,randomUUID());
   const state=await work.list(assign,id),worker={...people['worker-a']!,authorizationCapability:'work:report',authorizationCapabilities:['work:report','work:report_for_worker']};
   const validFrom=new Date(Date.now()-1000).toISOString(),validUntil=new Date(Date.now()+86400000).toISOString();
   await access.createDelegation({...root,authorizationCapability:'access:admin'}, {grantorUserId:tail.actorId,granteeUserId:worker.actorId,capability:'work:report_for_worker',scopeType:'global',validFrom,validUntil,reason:'TEST temporary worker proxy'});
   return {ready,id,work,state,worker,own,temporary,assign};
  };
  return {db,people,root,runtime,storage,attachments,contracts,sourcing,access,image,scene,advance,bulkReady,reworkReady,supplierId:supplier.supplierId,dispose};
 }catch(error){await dispose();throw error;}
}
