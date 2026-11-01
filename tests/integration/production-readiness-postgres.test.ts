import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {DevelopmentTechnicalService} from '../../apps/api/src/production-platform/development-technical-service.js';
import {SlaOrderApplicationService} from '../../apps/api/src/production-platform/sla-order-application.js';
import {SlaConfigurationService} from '../../apps/api/src/production-platform/sla-configuration-service.js';
import {SlaConfigurationRepository} from '../../apps/api/src/production-platform/sla-configuration-repository.js';
import {historicalDigitalOrder} from '../helpers/historical-digital-order-fixture.js';
import {SlaOrderService} from '../../apps/api/src/production-platform/sla-order-service.js';
import Fastify from 'fastify';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {ApplicationError} from '../../apps/api/src/platform/errors.js';
import {registerProductionReadinessRoutes} from '../../apps/api/src/production-platform/production-readiness-routes.js';
import {registerInstructionRoutes} from '../../apps/api/src/production-platform/production-instruction-routes.js';
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
 const setup=async()=>{
  const designer=f.people['sample-designer']!,primary=f.people.merchandiser!,warehouse=f.people.warehouse!,style=`TEST-P05-${randomUUID()}`,photo=await f.image(designer);
  const source=await identity.createSource(designer,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:null,interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'',sizes:['M'],measurements:[{name:'胸围',values:['48']}],unit:'cm',craft:'无',washing:'免洗',materials:[{materialId:randomUUID(),category:'主布',label:'主布',supplier:'TEST',name:'TEST棉布',width:'150',weight:'200',composition:'棉',consumption:'1',color:'黑',specification:'TEST',quantity:'1',requiredThisRound:true,available:true,expectedDate:null}],files:[{attachmentId:photo,kind:'款图'}]});
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
 it('keeps preorder material work independent, reuses original receipts and bridges partial/unknown heads without fallback resurrection',async()=>{
  const p=await setup();expect(p.handover.orderId).toBeNull();
  await record(p,p.resource,'material_investment');await record(p,p.resource,'fabric_receipt','partial');
  const created=await order(p),id=created.productionOrderId,target={kind:'order' as const,id};
  let facts=await readSeriesPlanFacts(f.db,id,p.sourceId,'PD');expect(facts.facts.find(x=>x.key==='fabric_receipt')).toMatchObject({started:true,completed:false});
  const after=await record(p,target,'fabric_receipt');const receipt=after.facts.find(f=>f.kind==='fabric_receipt')!;
  expect(receipt.resource).toEqual(p.resource);expect(receipt.version).toBe(2);expect(after.draftWindow.minutes).toBe(1440);
  await record(p,target,'fabric_receipt','unknown');facts=await readSeriesPlanFacts(f.db,id,p.sourceId,'PD');expect(facts.facts.some(x=>x.key==='fabric_receipt')).toBe(false);
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
   const published=await instruction.publish(p.primary,id,{expectedVersion:1,orderVersion,expectedReadinessRevision:ready.revision},randomUUID());expect(published.readiness?.finalWindow.status).toBe('completed_on_time');expect((await preparationWindowTodos(f.db,p.primary)).filter(t=>t.entityId===id)).toHaveLength(0);
   expect((await productionReadiness(f.db,id)).technical?.revision).toBe(ready.technicalRevision);
   const repeated=await service.deliver(p.primary,id,{instructionVersion:1,recipient:'TEST加工厂',occurredAt:businessNow().toISOString(),note:'TEST交付原版本',evidenceIds:[]},'TEST-native-delivery');
   const again=await service.deliver(p.primary,id,{instructionVersion:1,recipient:'TEST加工厂',occurredAt:businessNow().toISOString(),note:'TEST交付原版本',evidenceIds:[]},'TEST-native-delivery');expect(again.instructionDeliveries).toEqual(repeated.instructionDeliveries);
   expect(await styleLabelCuttingReason(f.db,id,(await identity.read(p.primary,id)).lines.map(l=>l.lineId))).toContain('款号唛');
  });
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
  expect((await bulk.read(f.root,id)).instructionValid).toBe(true);
 });

 it('lets a genuine preorder draft hand over material quantities and invest without publication, formal order, sizes or a full budget',async()=>{
  const p=await setup(),style=`TEST-PREORDER-${randomUUID()}`,source=await identity.createSource(p.designer,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID()),photo=await f.image(p.designer),materialId=randomUUID();
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
  await service.record(f.people.warehouse!,resource,{kind:'fabric_receipt',scopeRef:'whole',expectedVersion:receipt?.version??0,state:'unknown',occurredAt:null,note:'TEST receipt corrected to unknown after earlier release',quantities:[],evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
  const after=await bulk.read(f.root,ready.id);expect(after.fabric!.usable).toBe(false);expect(after.tasks.find(t=>t.taskKind==='warehouse_preshrink')!.state).not.toBe('ready');
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
   await f.advance(scene,'2026-12-10T04:00:00Z');let supplementalId='',due='';await f.runtime.run(scene,f.root,async()=>{const next=await replace('TEST new work after completed original');supplementalId=next.preparationId!;expect(next.tasks.find(t=>t.taskKind==='bulk_pattern')!.dueAt).toBeNull();await apply();due=(await bulk.read(f.root,ready.id)).tasks.find(t=>t.taskKind==='bulk_pattern')!.dueAt!;expect(due).toBe('2026-12-12T16:00:00.000Z');});
   await f.advance(scene,'2026-12-10T08:00:00Z');await f.runtime.run(scene,f.root,async()=>{const next=await replace('TEST same unfinished supplemental scope clarification');expect(next.preparationId).not.toBe(supplementalId);expect(next.tasks.find(t=>t.taskKind==='bulk_pattern')!.dueAt).toBe(due);const row=(await f.db.query('SELECT clock_origin_preparation_id,supplement_of_preparation_id FROM digital_bulk_preparations WHERE preparation_id=$1',[next.preparationId])).rows[0];expect(row).toMatchObject({clock_origin_preparation_id:supplementalId,supplement_of_preparation_id:ready.preparationId});});
  }finally{await restoreDefault();}
 });

});
