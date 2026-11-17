import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import type {businessAnchorFixture} from './business-anchor-fixture.js';
import {OrderTimeRequestService} from '../../apps/api/src/production-platform/order-time-request-service.js';
import {orderTimeNativeExecutor} from '../../apps/api/src/production-platform/order-time-native-commands.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {publishedTechnicalFixture} from './development-technical-fixture.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {InitialCustomerOrderDraftSchema} from '@dx-rework/contracts/digital-production';
import {arrangeTestRound} from './development-arrangement-fixture.js';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import {prepareTimeFrameworkConfiguration} from '@dx-rework/contracts/order-time-settings';
import {r5OneHourConfiguration} from './r5-order-time-fixture.js';

/** Independent explicit TEST input: every applicable work, including the
 * framework-only positioning node, takes one continuous hour. The generic
 * rewash fixture retains its genuine four-hour positioning default. */
export async function prepareCurrentTaskPlanSettings(f:Awaited<ReturnType<typeof businessAnchorFixture>>){
 const settings=new OrderTimeSettingsService(f.db,true,true),before=await settings.read(f.root),values=prepareTimeFrameworkConfiguration(r5OneHourConfiguration());
 for(const [key,rule]of Object.entries(values.nodes))if(rule.kind==='work'||rule.kind==='forecast'||rule.kind==='supervision')values.nodes[key]={...rule,minutes:60,calendar:'continuous'};
 await settings.save(f.root,{expectedVersion:before.version,values},randomUUID());
}

/** Genuine published material route and native handoff. Deliberately does not
 * use the downstream production-readiness fixture's labelled synthetic paper prerequisite. */
export async function currentTaskPlanFixture(f:Awaited<ReturnType<typeof businessAnchorFixture>>,options?:{withOrder?:boolean;craft?:'无'|'印花'}){
 const scene=await f.scene('2026-11-17T08:00:00.000Z');
 const native=new PatternRoomOrderService(f.db,new TodoProjectionService(new TodoService(f.db)),{ordersEnabled:true});
 const requests=new OrderTimeRequestService(f.db,orderTimeNativeExecutor(f.db,true,native));
 const execution=new DevelopmentExecutionService(f.db,true,native);
 return f.runtime.run(scene,f.root,async()=>{
   const identity=new DigitalProductionIdentityService(f.db,true),forms=new DigitalDevelopmentService(f.db,true,native);
   const style='TEST-CURRENT-P-'+randomUUID(),source=await identity.createSource(f.root,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
   const ordering=InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,orderDate:'2026-11-17',contractDeliveryDate:'2027-03-01',requiresColorMatching:false,salesYear:2027,salesSeries:'P03',
    lines:[{formalPoNo:style,color:'黑',deliveryDate:null,customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:'2'}]}]});
   const developmentDocument=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:'2027-03-01',unit:'cm',sizes:['M'],measurements:[{name:'胸围',values:['50']}],
    interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST real original task current plan',craft:options?.craft??'无',washing:'免洗',
    productionPlanning:{craftSteps:[],preshrink:false},customerOrderDraft:{withOrder:options?.withOrder!==false,stage:'formal',order:ordering},
    materials:[{materialId:randomUUID(),category:'主布',label:'主布',supplier:'TEST',name:'TEST真实主布',width:'150',weight:'200',composition:'棉',consumption:'1',color:'黑',specification:'TEST',quantity:'1',requiredThisRound:true,available:true,expectedDate:null,pricingUnit:'米',unitPrice:'20'}],
    files:[{attachmentId:await f.image(f.root),kind:'款图'}]});
   const sourceDraft=await forms.save(f.root,source.sourceId,{expectedVersion:0,document:developmentDocument},randomUUID());
   const price=(await f.db.query("SELECT price_id,version FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0]!;
   const publish={kind:'development_publish' as const,sourceId:source.sourceId,input:{expectedVersion:sourceDraft.version,patternOrder:{categoryId:price.price_id,priceVersion:price.version}}};
   const check=await requests.check(f.root,publish),pending=await requests.submit(f.root,{operation:publish,fingerprint:check.fingerprint,reason:'TEST native framework admission before task plan read'},randomUUID());
   const reviewed=await requests.read(f.root,pending.requestId),applied=await requests.apply(f.root,pending.requestId,{expectedVersion:reviewed.version,fingerprint:reviewed.check.fingerprint,overrides:{},acceptLate:true},randomUUID());
   const orderId=applied.result!.orderId??null;if(options?.withOrder!==false)expect(orderId).toBeTruthy();
   const sourceId=source.sourceId,worker=f.people['pattern-room-worker']!;
   const fixed=await execution.read(f.root,sourceId);
   await execution.configureFixedCutting(f.root,sourceId,{expectedVersion:fixed.fixedCutting?.version??0,assigneeId:worker.actorId,reason:'TEST original fixed cutter'},randomUUID());
   const state=await execution.read(f.root,sourceId),materialTask=state.tasks.find(task=>task.taskKind==='development_materials')!;
   expect(materialTask.taskId).toBeTruthy();
   const material=state.sheet.document!.materials[0]!;
   const checks=[{materialId:material.materialId,physical:true,quantity:true,color:true,specification:true}];
   const verified=await execution.saveMaterials(f.root,sourceId,{taskId:materialTask.taskId,expectedVersion:state.materialVerification!.version,expectedDocumentVersion:state.sheet.version,entries:checks.map(row=>({...row,usage:'use' as const,note:'TEST actual native verification',confirmedWith:''})),note:'TEST actual native material verification',result:'通过'},randomUUID());
   await execution.check(f.root,sourceId,{taskId:materialTask.taskId,result:'通过',note:'TEST actual native material handoff',expectedVerificationVersion:verified.version,items:checks},randomUUID());
   await arrangeTestRound(f.db,execution,f.root,sourceId,worker.actorId);
   const actual=await execution.read(f.root,sourceId),paper=actual.tasks.find(task=>task.taskKind==='development_pattern')!;
   expect(paper.state).toBe('ready');expect(paper.assigneeId).toBe(worker.actorId);
   return {scene,orderId,sourceId,requests,native,execution,paperId:paper.taskId,worker,document:developmentDocument};
 });
}

/** Actual original paper completion and a separately approved new round. */
export async function republishedCurrentTaskPlanFixture(f:Awaited<ReturnType<typeof businessAnchorFixture>>,options?:{withOrder?:boolean}){
  const fixture=await currentTaskPlanFixture(f,options),{scene,sourceId,paperId,native,execution,requests,worker}=fixture;
  const forms=new DigitalDevelopmentService(f.db,true,native),tasks=new DigitalProductionTaskService(f.db),rounds=new DevelopmentRoundService(f.db,true,native);
  const before=await f.runtime.run(scene,f.root,async()=>{
   const sheet=await forms.read(f.root,sourceId),original=await tasks.read(f.root,paperId);
   expect(original.state).toBe('ready');
   // The exact real task is already ready. Guard against the downstream helper's
   // optional synthetic-paper branch before using its original upload/publication path.
   const count=(await f.db.query("SELECT count(*)::int n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_pattern'",[sourceId])).rows[0].n;
   const artifact=await publishedTechnicalFixture(f.db,f.root,sourceId,sheet.document!,sheet.version,worker.actorId,f.attachments,f.storage);
   expect((await f.db.query("SELECT count(*)::int n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_pattern'",[sourceId])).rows[0].n).toBe(count);
   expect(artifact).toBeTruthy();await execution.complete(f.root,sourceId,{taskId:paperId,note:'TEST actual first-round paper completion',attachmentIds:[],artifactRef:{id:artifact!.artifactSetId,version:artifact!.version,scopeRef:'整款'}},randomUUID());
   const completed=await tasks.read(f.root,paperId);expect(completed.completedAt).toBeTruthy();return completed;
  });
  await f.advance(scene,'2026-11-17T11:00:00.000Z');
  const next=await f.runtime.run(scene,f.root,async()=>{
   const sheet=await forms.read(f.root,sourceId),saved=await rounds.save(f.root,sourceId,{expectedDraftVersion:0,revision:{basedOnRound:1,document:sheet.document!,origin:'内部发现',customerComment:'',internalProblem:'TEST genuine independent new paper work',explanation:'TEST retain completed original round',categories:['版型'],affectedNodes:['纸样'],outputKind:'整件样板'}},randomUUID());
   const operation={kind:'development_revision' as const,sourceId,input:{expectedDraftVersion:saved.draftVersion,basedOnRound:1}},check=await requests.check(f.root,operation);
   const pending=await requests.submit(f.root,{operation,fingerprint:check.fingerprint,reason:'TEST actual second-round arrangement'},randomUUID()),reviewed=await requests.read(f.root,pending.requestId);
   await requests.apply(f.root,pending.requestId,{expectedVersion:reviewed.version,fingerprint:reviewed.check.fingerprint,overrides:{},acceptLate:true},randomUUID());
   const link=(await f.db.query('SELECT order_id FROM digital_development_pattern_links WHERE source_id=$1',[sourceId])).rows[0]!,pattern=await native.get(f.root,link.order_id);
   if(pattern.status==='pending_assignment'){
    const person=(await f.db.query('SELECT person_id FROM business_people WHERE app_user_id=$1 AND active',[worker.actorId])).rows[0]!;
    await native.assign(f.root,pattern.orderId,{roundId:pattern.currentRoundId,version:pattern.version,personId:person.person_id},randomUUID());
   }
   await arrangeTestRound(f.db,execution,f.root,sourceId,worker.actorId);
   const state=await execution.read(f.root,sourceId),paper=state.tasks.filter(task=>task.routeVersion===2&&task.taskKind==='development_pattern');expect(paper).toHaveLength(1);
   return {paperId:paper[0]!.taskId};
  });
  return {...fixture,paperId:next.paperId,priorPaperId:paperId,priorTask:before};
}
