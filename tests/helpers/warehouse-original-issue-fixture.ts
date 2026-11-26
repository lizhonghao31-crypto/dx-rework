import {randomUUID} from 'node:crypto';
import {CreateSupplierSchema} from '@dx-rework/contracts';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {beijingCalendarDate,DigitalOrderCreateSchema,InitialCustomerOrderDraftSchema} from '@dx-rework/contracts/digital-production';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {PatternRoomPriceService} from '../../apps/api/src/pattern-room/price-service.js';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import {ProductionReadinessService} from '../../apps/api/src/production-platform/production-readiness-service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import type {businessAnchorFixture} from './business-anchor-fixture.js';
import {prepareRewashSettings} from './order-time-rewash-fixture.js';
import type {NativeTestFabricFixture} from './production-readiness-fixture.js';

/** Actual publishes, assignment, approval and original investment. Caller
 * chooses when to exercise the warehouse's first real incoming batch. */
export async function warehouseOriginalIssueFixture(f:Awaited<ReturnType<typeof businessAnchorFixture>>,options?:{fabricPurchase?:boolean;receiptBeforeFormal?:boolean;
 fabricPurchaseQuantity?:number;exerciseFabric?:NativeTestFabricFixture}){
 await prepareRewashSettings(f);
 const root=f.root,warehouse=f.people.warehouse!,primary=f.people.merchandiser!;
 const capabilities=(await f.db.query<{capability:string}>("SELECT capability FROM role_capabilities WHERE role_code='sample_designer'")).rows.map(row=>row.capability);
 const designer={...f.people['sample-designer']!,authorizationCapabilities:capabilities};
 const patternOrders=new PatternRoomOrderService(f.db,new TodoProjectionService(new TodoService(f.db)),{ordersEnabled:true});
 const identity=new DigitalProductionIdentityService(f.db,true),design=new DigitalDevelopmentService(f.db,true,patternOrders);
 const preparation=new ProductionReadinessService(f.db),bulk=new BulkPreparationService(f.db);
 const standard=new OrderTimeSettingsService(f.db,true,true),current=await standard.read(root),purchase=current.current.nodes.material_investment;
 if(purchase?.kind!=='event')throw Error('TEST needs real purchase configuration');
 await standard.save(root,{expectedVersion:current.version,values:{...current.current,nodes:{...current.current.nodes,
  material_investment:{...purchase,accessoriesLeadTime:{minutes:1440,calendar:'continuous'}}}}},randomUUID());
 const settings=await identity.orderNumberSettings(root);
 await identity.saveOrderNumberSettings(root,{...settings.values,expectedVersion:settings.version,designers:[{userId:designer.actorId,code:'LH'}]},randomUUID());
 const scene=await f.scene('2026-11-19T04:00:00Z');
 return f.runtime.run(scene,root,async()=>{
  const photo=await f.image(designer),suffix=randomUUID().slice(0,8).toUpperCase(),supplierName=`TEST 定量供应商 ${suffix}`;
  const supplier=await f.access.createSupplier(root,CreateSupplierSchema.parse({supplierCode:`TEST-X3-ISSUE-${suffix}`,supplierName,supplierType:'fabric',changeReason:'TEST original material source'}));
  const {sourceId,orderNumber}=await identity.reserveNumberedDraft(designer,{developmentType:'头版',temporaryStyleNo:null,
   numbering:{kind:'preorder',customerCode:'PD',productGroup:'男装',salesYear:2027,salesSeries:'P02'}},randomUUID());
  const style=orderNumber!;
  const source={kind:'source' as const,id:sourceId},category=(await f.db.query("SELECT price_id FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0]!;
  const price=await new PatternRoomPriceService(f.db).quote(root,'category',category.price_id);
  const doc=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:null,
   interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,
   mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'',sizes:['M'],measurements:[{name:'胸围',values:['48']}],unit:'cm',craft:'无',washing:'免洗',materials:[],files:[{attachmentId:photo,kind:'款图'}]});
  const material={materialId:randomUUID(),category:'主布' as const,label:'主布',name:'TEST棉布',supplier:supplierName,supplierReference:supplier,
   specification:'TEST',quantity:'1',width:'150',weight:'200',composition:'棉',color:'黑',consumption:'1',requiredThisRound:false,available:false,expectedDate:null};
  const accessory={...material,materialId:randomUUID(),category:'辅料' as const,label:'腰部用绳',name:'TEST 腰绳',quantity:'520',quantityUnit:'米',expectedDate:'2026-11-20',requiredThisRound:true};
  const draft=await design.save(designer,sourceId,{expectedVersion:0,document:{...doc,patternCategoryId:category.price_id,materials:[material,accessory],
   productionPlanning:{craftSteps:[],preshrink:false},customerOrderDraft:{withOrder:true,stage:'preorder',order:InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',
    designStyleNo:style,temporaryStyleNo:null,orderDate:'',contractDeliveryDate:null,primaryMerchandiserId:primary.actorId,lines:[{color:'',deliveryDate:null,sizes:[{size:'',quantity:''}]}]})}}},randomUUID());
  await design.publishPreorder(designer,sourceId,draft.version,randomUUID());
  await design.publish(designer,sourceId,draft.version,randomUUID(),{categoryId:category.price_id,priceVersion:price.version});
  const now=businessNow().toISOString();
  await preparation.record(primary,source,{kind:'material_investment',scopeRef:'whole',expectedVersion:0,state:'partial',occurredAt:now,
   note:'TEST procurement is not available stock',quantities:[{lineId:null,materialId:accessory.materialId,name:accessory.name,quantity:520,unit:'米'},
    {lineId:null,materialId:material.materialId,name:material.name,quantity:options?.fabricPurchaseQuantity??520,unit:'米'}],
   evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
  const originalBatch=(task:Awaited<ReturnType<typeof preparation.warehouseReceiptWork>>[number])=>({kind:task.kind,scopeRef:task.scopeRef,materialId:task.materialId,lineId:task.lineId,unit:'米',supplierId:task.basis.supplierId,
   investment:task.purchase.original,materialFingerprint:task.basis.adoptedRef,expectedReceiptVersion:0,quantity:'500',occurredAt:now,
   note:'TEST original physical batch',evidenceIds:[]});
  let preorderReceipt:null|{recordId:string;version:number}=null;
  if(options?.receiptBeforeFormal){
   await preparation.assign(root,source,{expectedVersion:0,warehouseWorkerId:warehouse.actorId,colorConfirmationWorkerId:null,colorConfirmationRole:null,reason:'TEST source warehouse assignment before formalization'},randomUUID());
   const work=(await preparation.warehouseReceiptWork(warehouse,source)).find(row=>row.materialId===accessory.materialId)!;
   const saved=await preparation.recordWarehouseReceiptBatch(warehouse,source,originalBatch(work),randomUUID());
   const fact=saved.history.find(row=>row.warehouseReceipt?.materialId===accessory.materialId);
   if(!fact?.valid)throw Error('TEST source receipt must be valid before the formal instruction');
   preorderReceipt={recordId:fact.recordId,version:fact.version};
  }
  const order=await identity.createOrder(designer,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,orderDate:beijingCalendarDate(businessNow()),
   requiresColorMatching:false,productionPlanning:{craftSteps:[],preshrink:false},primaryMerchandiserId:primary.actorId,
   lines:[{formalPoNo:style+'-PO1',color:'黑',customerWarehouseArrivalDate:'2027-04-30',sizes:[{size:'M',quantity:300}]},
    {formalPoNo:style+'-PO2',color:'白',customerWarehouseArrivalDate:'2027-04-30',sizes:[{size:'M',quantity:200}]}]}),randomUUID(),sourceId);
  const {id}=await f.bulkReady('无',undefined,2,f.sourcing,{stopBeforeCompletion:true,preshrink:'无需预缩',designerActor:designer,
   existingOrder:{orderId:order.productionOrderId,sourceId},adoptSourceMaterials:true,nativeFabric:{nativeFabric:options?.exerciseFabric??(async({service,bulk,warehouse,orderId})=>{
    const resource={kind:'order' as const,id:orderId};
    const work=(await service.warehouseReceiptWork(warehouse,resource)).find(row=>row.materialId===material.materialId)!;
    const state=await service.recordWarehouseReceiptBatch(warehouse,resource,originalBatch(work),randomUUID());
    const lot=state.history.find(row=>row.warehouseReceipt?.materialId===material.materialId)!;
    await bulk.reportFabric(warehouse,orderId,{expectedReportId:null,expectedReceiptVersion:0,material:material.name,
     arrivedAt:lot.occurredAt,inspectedAt:businessNow().toISOString(),result:'合格',note:'TEST real scoped lot inspection',
     receiptBatches:[{materialId:material.materialId,receipt:{recordId:lot.recordId,version:lot.version}}]},randomUUID());
   })}});
  const resource={kind:'order' as const,id};
  const before=await bulk.read(warehouse,id),scoped=before.materials!.items.find(item=>item.name===accessory.name)!;
  const tasks=await preparation.warehouseReceiptWork(warehouse,resource),work=tasks.find(item=>item.materialId===accessory.materialId)!;
  const batch=originalBatch(work),fabric=tasks.find(item=>item.materialId===material.materialId);
  return {scene,id,warehouse,primary,bulk,preparation,scope:scoped,resource,batch,work,accessory,now,instructionVersion:before.instructionVersion!,
   fabricBatch:options?.fabricPurchase&&fabric?originalBatch(fabric):null,preorderReceipt};
 });
}
