import {DevelopmentTechnicalService} from '../../apps/api/src/production-platform/development-technical-service.js';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {ProductionReadinessService} from '../../apps/api/src/production-platform/production-readiness-service.js';
import {BulkPreparationService} from '../../apps/api/src/production-platform/bulk-preparation-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {productionReadiness} from '../../apps/api/src/production-platform/production-readiness-repository.js';
import {confirmedTechnicalFixture} from './development-technical-fixture.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
/** Explicit production-test prerequisite; physical sample execution is not claimed by this fixture.
 * Typed material and original quality/publication commands remain real. */
export type NativeTestFabricFixture=(actions:{service:ProductionReadinessService;bulk:BulkPreparationService;orderId:string;warehouse:TrustedActorContext})=>Promise<void>;
export async function productionReadinessFixture(db:Pool,root:TrustedActorContext,orderId:string,workerId:string,warehouse:TrustedActorContext,options?:{leaveAccessoriesForReceipt?:boolean;nativeFabric?:NativeTestFabricFixture}){
 const service=new ProductionReadinessService(db),bulk=new BulkPreparationService(db),current=await service.read(root,{kind:'order',id:orderId});
 if(!current.enrolled)return current;
 const assigned=await db.query('SELECT warehouse_worker_id FROM digital_bulk_dispatch WHERE production_order_id=$1',[orderId]);
 if(!assigned.rows[0]?.warehouse_worker_id&&current.responsibility.warehouseWorkerId!==warehouse.actorId)await service.assign(root,{kind:'order',id:orderId},{expectedVersion:current.responsibility.version,warehouseWorkerId:warehouse.actorId,colorConfirmationWorkerId:null,colorConfirmationRole:null,reason:'TEST explicit production warehouse scope'},randomUUID());
 const source=current.sourceId!;
 const forms=new DigitalDevelopmentService(db,true),sheet=await forms.read(root,source),state=await productionReadiness(db,orderId);
 if(state.technical?.state!=='effective')await confirmedTechnicalFixture(db,root,source,sheet.document!,sheet.version,workerId);
 if(!(await db.query("SELECT 1 FROM digital_development_route_facts WHERE source_id=$1 AND route_version=$2 AND kind='尾查通过'",[source,sheet.roundNumber??1])).rowCount)
  await db.query("INSERT INTO digital_development_route_facts(fact_id,source_id,route_version,kind,payload,actor_id) VALUES($1,$2,$3,'尾查通过',$4,$5)",[randomUUID(),source,sheet.roundNumber??1,JSON.stringify({actualCompletedAt:businessNow().toISOString(),note:'TEST explicit completed sample prerequisite; native sample execution tested separately'}),root.actorId]);
 const refresh=await service.read(root,{kind:'order',id:orderId}),receipt=refresh.facts.find(f=>f.kind==='fabric_receipt'&&f.scopeRef==='whole');
 if(options?.nativeFabric)await options.nativeFabric({service,bulk,orderId,warehouse});
 else if(!receipt)await bulk.reportFabric(warehouse,orderId,{expectedReportId:null,expectedReceiptVersion:0,material:'TEST本单实际主料',arrivedAt:businessNow().toISOString(),inspectedAt:businessNow().toISOString(),result:'合格',note:'TEST native quality prerequisite'},randomUUID());
 const technical=new DevelopmentTechnicalService(db,true);
 const materials=await technical.read(root,source,sheet.roundNumber??1);
 for(const material of sheet.document!.materials.filter(m=>m.category!=='辅料'&&m.name.trim())){
  const old=materials.materialDecisions.find(m=>m.materialId===material.materialId);if(old?.preshrinkMethod)continue;
  await technical.saveMaterialDecision(root,source,{roundNumber:sheet.roundNumber??1,materialId:material.materialId,expectedVersion:old?.version??0,highTemperatureRequired:false,preshrinkMethod:'常规梭织预缩',basis:'TEST actual technical prerequisite, not a warehouse decision',supplierEvidenceIds:sheet.document!.files.filter(f=>f.kind==='款图').slice(0,1).map(f=>f.attachmentId),warpShrinkPercent:'1',weftShrinkPercent:'1'},randomUUID());
 }
 const readQuantities=async()=>(await db.query('SELECT l.line_id,(SELECT coalesce(sum(quantity),0)::int FROM digital_production_po_sizes s WHERE s.line_id=l.line_id) AS order_quantity FROM digital_production_po_lines l WHERE production_order_id=$1',[orderId])).rows.map(r=>({lineId:r.line_id,materialId:null,name:'TEST款号唛',quantity:r.order_quantity,unit:'枚'}));
 // Read physical counts only when this invocation needs to record a missing fact.
 let quantities:Awaited<ReturnType<typeof readQuantities>>|undefined;
 for(const kind of ['style_label_ready','accessories_ready'] as const){if(kind==='accessories_ready'&&options?.leaveAccessoriesForReceipt)continue;const latest=await service.read(root,{kind:'order',id:orderId});if(latest.facts.some(f=>f.kind===kind&&f.state==='ready'))continue;
  quantities??=await readQuantities();
  await service.record(warehouse,{kind:'order',id:orderId},{kind,scopeRef:'whole',expectedVersion:0,state:'ready',occurredAt:businessNow().toISOString(),note:'TEST physical material prerequisite',quantities,evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());}
 return service.read(root,{kind:'order',id:orderId});
}
export async function completeBulkRangeFixture(db:Pool,actor:TrustedActorContext,orderId:string,preparationId:string,kind:'纸样完成'|'唛架完成'|'预缩完成'){
 const service=new ProductionReadinessService(db),state=await service.read(actor,{kind:'order',id:orderId});
 // Preshrink and unenrolled completions do not consume a PO range.
 const lines=state.enrolled&&kind!=='预缩完成'?(await db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1',[orderId])).rows.map(r=>r.line_id as string):[];
 return new BulkPreparationService(db).complete(actor,orderId,{preparationId,kind,...(state.enrolled?{expectedReadinessRevision:state.revision,...(kind!=='预缩完成'?{range:{expectedVersion:state.ranges.filter(r=>r.preparationId===preparationId&&r.kind===kind).at(-1)?.version??0,lineIds:lines,complete:true,pendingMaterialIds:[],evidenceIds:[],note:'TEST whole applicable range completed'}}:{})}:{})},randomUUID());
}

/** A cutting-focused test explicitly prepares its requested physical count. It does not
 * change order quantity or the production gate, and denial tests do not call it. */
export async function physicalCuttingLabelsFixture(db:Pool,root:TrustedActorContext,cuttingId:string,quantity:number){
 const lines=(await db.query("SELECT production_order_id,line_id FROM digital_production_child_lines WHERE module='cutting' AND child_id=$1",[cuttingId])).rows;
 if(!lines.length)return;
 const orderId=lines[0]!.production_order_id,resource={kind:'order' as const,id:orderId},service=new ProductionReadinessService(db),state=await service.read(root,resource);
 if(!state.enrolled)return;
 const prior=state.facts.find(f=>f.kind==='style_label_ready'&&f.scopeRef==='whole'),ids=new Set(lines.map(l=>l.line_id));
 await service.record(root,resource,{kind:'style_label_ready',scopeRef:'whole',expectedVersion:prior?.version??0,state:'ready',occurredAt:businessNow().toISOString(),note:'TEST explicit physical label prerequisite for the actual count requested by this cutting case; order quantity is unchanged',quantities:[...(prior?.quantities.filter(q=>!ids.has(q.lineId))??[]),...lines.map(l=>({lineId:l.line_id,materialId:null,name:'TEST款号唛',quantity,unit:'枚'}))],evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
}
