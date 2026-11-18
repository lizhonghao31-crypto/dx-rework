import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import type {businessAnchorFixture} from './business-anchor-fixture.js';
import {OrderTimeRequestService} from '../../apps/api/src/production-platform/order-time-request-service.js';
import {orderTimeNativeExecutor} from '../../apps/api/src/production-platform/order-time-native-commands.js';
import {OrderTimePlanRepository} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {BulkWashingService} from '../../apps/api/src/production-platform/bulk-washing-service.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {GarmentQualityService,garmentQuality} from '../../apps/api/src/production-platform/garment-quality.js';
import {DevelopmentTechnicalService} from '../../apps/api/src/production-platform/development-technical-service.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {InitialCustomerOrderDraftSchema} from '@dx-rework/contracts/digital-production';
import {prepareTimeFrameworkConfiguration} from '@dx-rework/contracts/order-time-settings';
import {r5OneHourConfiguration} from './r5-order-time-fixture.js';
import type {BulkWashingAdoption} from '@dx-rework/contracts/bulk-washing';

/** Real original admission and failed washing, shared only by these rewash regressions. */
export async function prepareRewashSettings(f:Awaited<ReturnType<typeof businessAnchorFixture>>){
  const settings=new OrderTimeSettingsService(f.db,true,true),current=await settings.read(f.root);
  const values=r5OneHourConfiguration();
  values.nodes.factory_production_work={kind:'forecast',minutes:240,calendar:'continuous',reminder:{enabled:true,percent:70}};
  await settings.save(f.root,{expectedVersion:current.version,values:prepareTimeFrameworkConfiguration(values)},randomUUID());

}
export async function admittedFrameworkProductionFixture(f:Awaited<ReturnType<typeof businessAnchorFixture>>){
 return admittedProductionFixture(f,true);
}
/** The same original admission supports both stored arrangement formats. */
export async function admittedProductionFixture(f:Awaited<ReturnType<typeof businessAnchorFixture>>,framework:boolean,options?:{poCount?:number;cuttingProcess?:'in_house'|'outsourced';preshrink?:'需要预缩'|'无需预缩'}){
 const admitted=await admittedOrderFixture(f,options),{scene,orderId,sourceId,resource,repo}=admitted;
 return f.runtime.run(scene,f.root,async()=>{
   expect(Boolean((await repo.current(resource()))!.input.frameworkPlans)).toBe(framework);
   const ready=await f.bulkReady('无',undefined,options?.poCount??1,undefined,{quantity:2,designerActor:f.root,existingOrder:{orderId,sourceId},...(options?.cuttingProcess?{cuttingProcess:options.cuttingProcess}:{}),...(options?.preshrink?{preshrink:options.preshrink}:{})});
   const lineId=(await f.db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1',[orderId])).rows[0].line_id;
   // This original fixture explicitly created a customer approval without a
   // time. Complete only that known fixture precondition via the supported
   // audited supplement; do not manufacture a replacement approval/review.
   const technical=new DevelopmentTechnicalService(f.db,true),sheet=await technical.read(f.root,ready.sourceId);
   const comment=sheet.comments.find(row=>row.isFinal&&row.decision==='approved')!;
   if(comment&&!comment.occurredAt)await technical.supplementCommentTime(f.root,ready.sourceId,{commentId:comment.commentId,commentVersion:comment.version,
    actualTime:{precision:'instant',at:'2026-11-17T08:00:00.000Z'},note:'TEST known original fixture approval occurrence'},randomUUID());
   return {...admitted,lineId,ready};
 });
}
/** Real admission with the original development work still waiting for material verification. */
export async function admittedOrderFixture(f:Awaited<ReturnType<typeof businessAnchorFixture>>,options?:{poCount?:number;startAt?:string}){
 const scene=await f.scene(options?.startAt??'2026-11-17T08:00:00.000Z');
 const native=new PatternRoomOrderService(f.db,new TodoProjectionService(new TodoService(f.db)),{ordersEnabled:true});
 const requests=new OrderTimeRequestService(f.db,orderTimeNativeExecutor(f.db,true,native)),washing=new BulkWashingService(f.db),repo=new OrderTimePlanRepository(f.db);
 return f.runtime.run(scene,f.root,async()=>{
   expect((await f.db.query("SELECT current_setting('is_superuser') AS value")).rows[0].value).toBe('off');
   // Establish the real admission first. A legacy bulk fixture has no frozen
   // framework and must remain ineligible for three-layer washing changes.
   const identity=new DigitalProductionIdentityService(f.db,true),forms=new DigitalDevelopmentService(f.db,true,native);
   const style='TEST-REWASH-PLAN-'+randomUUID(),source=await identity.createSource(f.root,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
   const ordering=InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,orderDate:'2026-11-17',contractDeliveryDate:'2027-03-01',requiresColorMatching:false,salesYear:2027,salesSeries:'P03',
    lines:Array.from({length:options?.poCount??1},(_,index)=>({formalPoNo:style+(options?.poCount&&options.poCount>1?'-'+(index+1):''),color:index?'白':'黑',deliveryDate:null,customerWarehouseArrivalDate:index?'2027-03-03':'2027-03-01',sizes:[{size:'M',quantity:'2'}]}))});
   const developmentDocument=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:'2027-03-01',unit:'cm',sizes:['M'],measurements:[{name:'胸围',values:['50']}],
    interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST original admitted washing order',craft:'无',washing:'免洗',
    productionPlanning:{craftSteps:[],preshrink:false},customerOrderDraft:{withOrder:true,stage:'formal',order:ordering},
    materials:[{materialId:randomUUID(),category:'主布',label:'主布',supplier:'TEST',name:'TEST真实主布',width:'150',weight:'200',composition:'棉',consumption:'1',color:'黑',specification:'TEST',quantity:'1',requiredThisRound:true,available:true,expectedDate:null,pricingUnit:'米',unitPrice:'20'}],
    files:[{attachmentId:await f.image(f.root),kind:'款图'}]});
   const sourceDraft=await forms.save(f.root,source.sourceId,{expectedVersion:0,document:developmentDocument},randomUUID());
   const price=(await f.db.query("SELECT price_id,version FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0]!;
   const publish={kind:'development_publish' as const,sourceId:source.sourceId,input:{expectedVersion:sourceDraft.version,patternOrder:{categoryId:price.price_id,priceVersion:price.version}}};
   const check=await requests.check(f.root,publish),pending=await requests.submit(f.root,{operation:publish,fingerprint:check.fingerprint,reason:'TEST native framework order before washing'},randomUUID());
   const reviewed=await requests.read(f.root,pending.requestId),applied=await requests.apply(f.root,pending.requestId,{expectedVersion:reviewed.version,fingerprint:reviewed.check.fingerprint,overrides:{},acceptLate:true},randomUUID());
   const orderId=applied.result!.orderId!;expect(orderId).toBeTruthy();
   const resource=()=>({kind:'order' as const,id:orderId});
   const command=async()=>{const scope=(await washing.read(f.root,orderId)).scopes[0]!;return {planId:scope.planId,scopeId:scope.scopeId,quantityVersion:scope.quantityVersion,expectedRevision:scope.revision,occurredAt:'2026-11-17T08:00:00.000Z',note:'TEST exact native washing scope'};};
   return {scene,orderId,sourceId:source.sourceId,requests,washing,repo,resource,command};
 });
}
export async function failedFrameworkWashingFixture(f:Awaited<ReturnType<typeof businessAnchorFixture>>,mode:'factory'|'after_receipt'){
 const {scene,orderId,lineId,ready,requests,washing,repo,resource,command}=await admittedFrameworkProductionFixture(f);
 return f.runtime.run(scene,f.root,async()=>{
   const duration={minutes:60,calendar:'continuous' as const,reminder:{enabled:true,percent:70}};
   const document:BulkWashingAdoption={arrangement:{mode,reference:'TEST frozen original washing',revision:1,accounting:mode==='factory'?'included_in_factory':'additional',washing:duration,inspection:duration},
    staff:{logisticsId:f.people['embroidery-washing-merchandiser']!.actorId,inspectorId:f.people.qc!.actorId},fee:{kind:'pending'},sourceRef:'TEST original manager adoption'};
   const adoption=[{lineId,expectedVersion:0,document}],operation={kind:'arrangement' as const,resource:resource()};
   const preview=await requests.check(f.root,operation,{},adoption);
   expect(preview.feasibility,JSON.stringify(preview.coverage)).not.toBe('unknown');
   await requests.arrange(f.root,{resource:resource(),fingerprint:preview.fingerprint,overrides:{},washing:adoption,acceptLate:true},randomUUID());
   const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0].cutting_order_id;
   const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   await ready.cutting.record(cutter,cut,{pieceCount:1,actualCutCount:2,attachmentIds:[await f.image(cutter)]},randomUUID());
   if(mode==='factory'){
    const flow=new FactoryFlowService(f.db),state=await flow.read(f.root,orderId);
    await flow.dispatch(f.root,orderId,{expectedRevision:state.revision,supplierId:f.supplierId,note:'TEST real original dispatch'},randomUUID());
   }else{
    const warehouse={...f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']};
    await new ReceivingService(f.db).create(warehouse,{cuttingOrderId:cut,documentQuantity:2,actualQuantity:2,attachmentIds:[await f.image(warehouse)]},randomUUID());
    const receipt=(await garmentQuality(f.db,orderId))[0]!;
    await new GarmentQualityService(f.db).record(f.root,orderId,{receiptId:receipt.receiptId,quantityVersion:receipt.quantityVersion,qualifiedQuantity:2,occurredAt:'2026-11-17T08:00:00.000Z',problem:''},randomUUID());
   }
   const start=await washing.record(f.root,orderId,{...await command(),kind:mode==='factory'?'factory_start':'send',quantity:2},randomUUID());
   const complete=await washing.record(f.root,orderId,mode==='factory'?{...await command(),kind:'factory_complete',startId:start.eventId,quantity:2}:{...await command(),kind:'return',sendId:start.eventId,quantity:2},randomUUID());
   const inspectionId=(await washing.record(f.root,orderId,{...await command(),kind:'inspection',completionId:complete.eventId,quantity:2,qualifiedQuantity:1},randomUUID())).eventId;
   return {scene,orderId,lineId,inspectionId,requests,washing,repo,resource,command,operation};
 });
}
