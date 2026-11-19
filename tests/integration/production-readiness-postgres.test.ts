import {DigitalProductionAccessPolicy} from '../../apps/api/src/production-platform/access-policy.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
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
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {DevelopmentTechnicalService} from '../../apps/api/src/production-platform/development-technical-service.js';
import {SlaOrderApplicationService} from '../../apps/api/src/production-platform/sla-order-application.js';
import {SlaConfigurationService} from '../../apps/api/src/production-platform/sla-configuration-service.js';
import {SlaConfigurationRepository} from '../../apps/api/src/production-platform/sla-configuration-repository.js';
import {historicalDigitalOrder} from '../helpers/historical-digital-order-fixture.js';
import {SlaOrderService} from '../../apps/api/src/production-platform/sla-order-service.js';
import {SlaCalculationService} from '../../apps/api/src/production-platform/sla-calculation-service.js';
import Fastify from 'fastify';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {ApplicationError} from '../../apps/api/src/platform/errors.js';
import {registerProductionReadinessRoutes} from '../../apps/api/src/production-platform/production-readiness-routes.js';
import {registerInstructionRoutes} from '../../apps/api/src/production-platform/production-instruction-routes.js';
import {readCockpitMaterialSupplements} from '../../apps/api/src/production-platform/cockpit-actionable.js';
import {preparationWindowTodos,preparationMaterialsTodos,preparationSupplement} from '../../apps/api/src/production-platform/preparation-todos.js';
import {completeBulkRangeFixture} from '../helpers/production-readiness-fixture.js';
import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {confirmedTechnicalFixture} from '../helpers/development-technical-fixture.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {ProductionReadinessService} from '../../apps/api/src/production-platform/production-readiness-service.js';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import {readSeriesPlanFacts} from '../../apps/api/src/production-platform/series-plan-facts.js';
import {productionReadiness,styleLabelCuttingReason} from '../../apps/api/src/production-platform/production-readiness-repository.js';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {DigitalOrderCreateSchema,InitialCustomerOrderDraftSchema,beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {initialInstruction} from '@dx-rework/contracts/production-instruction';
import type {PreparationMaterialKind,PreparationResource} from '@dx-rework/contracts/production-readiness';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('production preparation native lifecycle (TEST_DATABASE_URL isolated only)',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,identity:DigitalProductionIdentityService,forms:DigitalDevelopmentService,service:ProductionReadinessService,instruction:ProductionInstructionService,bulk:BulkPreparationService;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);identity=new DigitalProductionIdentityService(f.db,true);forms=new DigitalDevelopmentService(f.db,true);service=new ProductionReadinessService(f.db);instruction=new ProductionInstructionService(f.db,true);bulk=new BulkPreparationService(f.db);});
 afterAll(async()=>{await f?.dispose();});
 // Pure template construction must not publish an unrelated source for draft tests.
 const documentFixture=(photo:string)=>DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:null,interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'',sizes:['M'],measurements:[{name:'胸围',values:['48']}],unit:'cm',craft:'无',washing:'免洗',materials:[{materialId:randomUUID(),category:'主布',label:'主布',supplier:'TEST',name:'TEST棉布',width:'150',weight:'200',composition:'棉',consumption:'1',color:'黑',specification:'TEST',quantity:'1',requiredThisRound:true,available:true,expectedDate:null}],files:[{attachmentId:photo,kind:'款图'}]});
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
   source=await flow.dispatch(f.root,ready.id,{expectedRevision:source.revision,occurredAt:businessNow().toISOString(),supplierId:f.supplierId,note:'TEST原仓库发裁片'},randomUUID());
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
 it('allows drafts before final prerequisites; starts distinct arrival and final-ready 24h clocks and binds the effective technical revision',async()=>{
  const scene=await f.scene('2026-11-02T00:00:00Z');let p!:Awaited<ReturnType<typeof setup>>,id='',orderVersion=0;
  await f.runtime.run(scene,f.root,async()=>{p=await setup();await record(p,p.resource,'fabric_receipt');const created=await order(p);id=created.productionOrderId;orderVersion=created.version;
   const doc={...initialInstruction(),unit:'cm' as const,styleName:'TEST garment',category:'上衣',date:beijingCalendarDate(businessNow()),preshrink:'无需预缩' as const,sizes:['M'],measurements:[{id:randomUUID(),name:'胸围',tolerance:'±1',method:'平量',values:['48']}],images:[{attachmentId:p.photo,kind:'款图' as const,description:'TEST'}]};
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
   const repeated=await service.deliver(p.primary,id,{instructionVersion:1,recipient:'TEST加工厂',occurredAt:businessNow().toISOString(),note:'TEST交付原版本',evidenceIds:[]},'TEST-native-delivery');
   const again=await service.deliver(p.primary,id,{instructionVersion:1,recipient:'TEST加工厂',occurredAt:businessNow().toISOString(),note:'TEST交付原版本',evidenceIds:[]},'TEST-native-delivery');expect(again.instructionDeliveries).toEqual(repeated.instructionDeliveries);
   expect(await styleLabelCuttingReason(f.db,id,(await identity.read(p.primary,id)).lines.map(l=>l.lineId))).toContain('款号唛');
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
 });
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

 it('lets a genuine preorder draft hand over material quantities and invest without publication, formal order, sizes or a full budget',async()=>{
  const designer=f.people['sample-designer']!,primary=f.people.merchandiser!,style=`TEST-PREORDER-${randomUUID()}`,source=await identity.createSource(designer,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID()),photo=await f.image(designer),materialId=randomUUID();
  const p={designer,primary,document:documentFixture(photo)};
  const document={...p.document,quantity:null,sampleSize:'',sizes:[],sizeQuantities:[],measurements:[],materials:[{...p.document.materials[0]!,materialId,quantity:'100米，预单投料量'}],files:[{attachmentId:photo,kind:'款图' as const}],customerOrderDraft:{withOrder:true,stage:'preorder' as const,order:InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,temporaryStyleNo:null,orderDate:'',contractDeliveryDate:null,lines:[{color:'',deliveryDate:null,sizes:[{size:'',quantity:''}]}]})}};
  const saved=await forms.save(p.designer,source.sourceId,{expectedVersion:0,document},randomUUID());expect(saved.status).toBe('draft');await expect(forms.publish(p.designer,source.sourceId,saved.version,randomUUID())).rejects.toMatchObject({statusCode:400});
  const resource={kind:'source' as const,id:source.sourceId};
  const handed=await service.record(p.designer,resource,{kind:'design_handover',scopeRef:'whole',expectedVersion:0,state:'ready',occurredAt:businessNow().toISOString(),note:'TEST预单投料资料已交订单跟单',quantities:[],evidenceIds:[],sourceDocumentVersion:saved.version,recipientId:p.primary.actorId},randomUUID());
  expect(handed.sourceIsPreorderDraft).toBe(true);expect(handed.facts[0]!.handoverMaterials?.[0]?.quantity).toBe('100米，预单投料量');
  await service.record(f.root,resource,{kind:'design_handover',scopeRef:'whole',expectedVersion:1,state:'ready',occurredAt:businessNow().toISOString(),note:'TEST原生Root核对并复用当前已保存投料凭证',quantities:[],evidenceIds:[photo],sourceDocumentVersion:saved.version,recipientId:p.primary.actorId},randomUUID());
  const invested=await service.record(p.primary,resource,{kind:'material_investment',scopeRef:'whole',expectedVersion:0,state:'ready',occurredAt:businessNow().toISOString(),note:'TEST实际投料',quantities:[{lineId:null,materialId,name:'TEST棉布',quantity:100,unit:'米'}],evidenceIds:[photo],sourceDocumentVersion:null,recipientId:null},randomUUID());
  expect(invested.orderId).toBeNull();expect(invested.facts.find(f=>f.kind==='material_investment')).toMatchObject({state:'ready',valid:true});
  expect((await f.db.query('SELECT count(*)::int AS n FROM digital_production_orders WHERE source_id=$1',[source.sourceId])).rows[0].n).toBe(0);
  expect((await forms.read(p.designer,source.sourceId)).status).toBe('draft');
  await forms.save(p.designer,source.sourceId,{expectedVersion:saved.version,document:{...document,instructions:'TEST尚未交接的新草稿'}},randomUUID());
  await expect(service.read(p.primary,resource)).rejects.toMatchObject({statusCode:403});
  expect((await service.read(f.root,resource)).history.find(f=>f.kind==='design_handover')?.handoverMaterials?.[0]?.quantity).toBe('100米，预单投料量');
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

});
