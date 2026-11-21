import {ApplicationError} from '../platform/errors.js';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {PreparationMaterialFact,PreparationMaterialKind,PreparationResource,PreparationMaterialRecord,MaterialInvestmentScopeBasis} from '@dx-rework/contracts/production-readiness';
import type {DevelopmentMaterial} from '@dx-rework/contracts/digital-development';
import {PREPARATION_RULE_VERSION} from '@dx-rework/contracts/production-readiness';
import {businessNow,acceptanceBusinessContext} from '../acceptance-clock/business-time.js';
import {digitalNotFound} from './access-policy.js';
import {developmentDocumentRow} from './development-round-repository.js';

export type PreparationDB=Pick<Pool|PoolClient,'query'>;
export const preparationHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const preparationIso=(value:Date|string|null|undefined)=>value?new Date(value).toISOString():null;
export async function preparationAvailable(db:PreparationDB){return Boolean((await db.query("SELECT to_regclass('digital_preparation_material_versions') AS relation")).rows[0]?.relation);}
export async function preparationContext(db:PreparationDB,resource:PreparationResource){
 const order=(resource.kind==='order'?(await db.query('SELECT * FROM digital_production_orders WHERE production_order_id=$1',[resource.id])):(await db.query('SELECT * FROM digital_production_orders WHERE source_id=$1',[resource.id]))).rows[0]??null;
 if(resource.kind==='order'&&!order)digitalNotFound();
 const sourceId=resource.kind==='source'?resource.id:order?.source_id??null;
 const source=sourceId?(await db.query('SELECT * FROM digital_production_sources WHERE source_id=$1',[sourceId])).rows[0]??digitalNotFound():null;
 const lines=order?(await db.query('SELECT line_id,color,quantity.order_quantity FROM digital_production_po_lines p CROSS JOIN LATERAL (SELECT coalesce(sum(quantity),0)::int AS order_quantity FROM digital_production_po_sizes s WHERE s.line_id=p.line_id) quantity WHERE production_order_id=$1 ORDER BY position',[order.production_order_id])).rows:[];
 return {resource,order,source,sourceId,orderId:(order?.production_order_id as string|undefined)??null,lines};
}
export async function preparationAdoption(db:PreparationDB,resource:PreparationResource){
 return await preparationAvailable(db)?(await db.query('SELECT * FROM digital_preparation_rule_adoptions WHERE resource_kind=$1 AND resource_id=$2 ORDER BY revision DESC LIMIT 1',[resource.kind,resource.id])).rows[0]??null:null;
}
export async function enrollPreparation(db:PreparationDB,resource:PreparationResource,actorId:string,creationEventId:string){
 if(!await preparationAvailable(db)||await preparationAdoption(db,resource))return;
 await db.query(`INSERT INTO digital_preparation_rule_adoptions(adoption_id,resource_kind,resource_id,revision,rule_version,basis_revision,reason,standards,acknowledged_by,adopted_by,creation_event_id,business_time)
  VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$8,$9,$10)`,[randomUUID(),resource.kind,resource.id,PREPARATION_RULE_VERSION,`creation:${creationEventId}`,'新建档案采用本次产前规则；没有补造物料、批复或完成事实',JSON.stringify({draftMinutes:1440,finalMinutes:1440}),actorId,creationEventId,JSON.stringify({now:businessNow().toISOString(),scenarioId:acceptanceBusinessContext()?.scenarioId??null})]);
}
function definedInvestmentMaterials(materials:readonly DevelopmentMaterial[]){
 return materials.filter(row=>row.name.trim()&&row.quantity.trim()).map(row=>[row.materialId,row.category,row.name,row.quantity,row.color,row.specification,row.supplier] as const)
  .sort((a,b)=>a[0].localeCompare(b[0],'en'));
}
export function preparationInvestmentComplete(handover:Pick<PreparationMaterialFact,'investmentScopeBasis'>|undefined,investment:Pick<PreparationMaterialFact,'state'|'valid'|'quantities'|'investmentMaterialOccurrences'>|undefined){
 if(investment?.state!=='ready'||!investment.valid)return false;
 const required=handover?.investmentScopeBasis?.materialIds;
 return !required||required.length>0&&required.every(id=>investment.quantities.some(row=>row.materialId===id)
  &&investment.investmentMaterialOccurrences?.[id]?.fingerprint===handover!.investmentScopeBasis!.materialFingerprints[id]);
}

/** Version-only changes do not invalidate an explicitly handed-over preorder.
 * A different material set always requires an additional real handover. */
export function preparationHandoverCurrent(handover:Pick<PreparationMaterialFact,'sourceDocumentVersion'|'investmentScopeBasis'>,document:{version:number;materials:DevelopmentMaterial[]}){
 return handover.sourceDocumentVersion===document.version||Boolean(handover.investmentScopeBasis&&
  preparationHash(definedInvestmentMaterials(document.materials))===handover.investmentScopeBasis.fingerprint);
}

export async function preparationMaterialHistory(db:PreparationDB,context:Awaited<ReturnType<typeof preparationContext>>):Promise<PreparationMaterialFact[]>{
 if(!await preparationAvailable(db))return [];
 const rows=(await db.query(`SELECT m.*,u.display_name FROM digital_preparation_material_versions m LEFT JOIN app_users u ON u.id=m.actor_id
  WHERE (resource_kind='order' AND resource_id=$1) OR (resource_kind='source' AND resource_id=$2)
  ORDER BY recorded_at DESC,version DESC,record_id`,[context.orderId,context.sourceId])).rows;
 const result:PreparationMaterialFact[]=[];
 for(const row of rows){
  const missing: string[]=[];
  if(row.body.materialBasis&&row.body.materialBasis!==await preparationMaterialBasis(db,context,row.kind))missing.push('物料要求已变化，请核对本轮实际适用性；原物料记录保留');
  if(row.kind==='design_handover'&&context.sourceId){
   const document=await developmentDocumentRow(db,context.sourceId);
   if(!document||!preparationHandoverCurrent(row.body,{version:document.version,materials:document.document.materials}))
    missing.push('设计交接所引用资料已有新版本');
  }
  if(row.body.evidenceIds?.length){const ready=(await db.query("SELECT count(*)::int AS n FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND status='ready'",[row.body.evidenceIds])).rows[0].n;if(ready!==row.body.evidenceIds.length)missing.push('原凭证已失效或尚未完成上传');}
  result.push({...row.body,kind:row.kind,scopeRef:row.scope_ref,state:row.state,recordId:row.record_id,version:row.version,resource:{kind:row.resource_kind,id:row.resource_id},occurredAt:preparationIso(row.occurred_at),recordedAt:preparationIso(row.recorded_at)!,recordedBy:row.actor_id,operatorName:row.display_name??'',valid:!missing.length,invalidReasons:missing});
 }
 return result;
}
/** An existing order stream keeps authority after source attachment. Source-only records are adopted by reference, never copied as receipts. */
export function currentPreparationMaterials(history:PreparationMaterialFact[],orderId:string|null){
 const heads=new Map<string,PreparationMaterialFact>();
 for(const row of history){const key=`${row.kind}:${row.scopeRef}`,prior=heads.get(key);
  if(!prior||row.resource.kind==='order'&&row.resource.id===orderId&&prior.resource.kind!=='order'||row.recordId===prior.recordId&&row.version>prior.version)heads.set(key,row);
 }
 return [...heads.values()].map(row=>{
  if(row.kind!=='material_investment'||row.state!=='ready'||!row.investmentScopeBasis)return row;
  const handover=heads.get('design_handover:'+row.scopeRef);
  return handover?.state==='ready'&&handover.valid&&preparationInvestmentComplete(handover,row)
   ?row:{...row,state:'partial' as const};
 });
}
export async function currentPreparationMaterial(db:PreparationDB,orderId:string,kind:PreparationMaterialKind,scopeRef='whole'){
 const context=await preparationContext(db,{kind:'order',id:orderId});
 return currentPreparationMaterials(await preparationMaterialHistory(db,context),orderId).find(f=>f.kind===kind&&f.scopeRef===scopeRef)??null;
}
export async function preparationResponsibility(db:PreparationDB,context:Awaited<ReturnType<typeof preparationContext>>){
 if(!await preparationAvailable(db))return {version:0,warehouseWorkerId:null as string|null,colorConfirmationWorkerId:null as string|null,colorConfirmationRole:null as string|null};
 const row=(await db.query(`SELECT * FROM digital_preparation_responsibilities WHERE (resource_kind='order' AND resource_id=$1) OR (resource_kind='source' AND resource_id=$2)
  ORDER BY (resource_kind='order') DESC,version DESC LIMIT 1`,[context.orderId,context.sourceId])).rows[0];
 const dispatch=context.orderId?(await db.query('SELECT warehouse_worker_id FROM digital_bulk_dispatch WHERE production_order_id=$1',[context.orderId])).rows[0]:null;
 return {version:row?.version??0,warehouseWorkerId:dispatch?.warehouse_worker_id??row?.warehouse_worker_id??null,colorConfirmationWorkerId:row?.color_confirmation_worker_id??null,colorConfirmationRole:row?.color_confirmation_role??null};
}
/** Internal native producer; callers retain original transaction, authorization and optimistic version guards. */
export async function appendPreparationMaterial(db:PreparationDB,context:Awaited<ReturnType<typeof preparationContext>>,actorId:string,input:PreparationMaterialRecord){
 const current=currentPreparationMaterials(await preparationMaterialHistory(db,context),context.orderId);
 const prior=current.find(f=>f.kind===input.kind&&f.scopeRef===input.scopeRef);
 if((prior?.version??0)!==input.expectedVersion)throw new ApplicationError('PREPARATION_CONFLICT','物料原记录已变化，请重新读取',409);
 const handedDocument=input.kind==='design_handover'&&context.sourceId?await developmentDocumentRow(db,context.sourceId):null;
 const handoverMaterials=handedDocument?(handedDocument.document.materials as DevelopmentMaterial[]).map(m=>({
  materialId:m.materialId,category:m.category,supplier:m.supplier,name:m.name,quantity:m.quantity,color:m.color,specification:m.specification
 })):undefined;
 const target=prior?.resource??(context.sourceId?{kind:'source' as const,id:context.sourceId}:context.resource),recordId=prior?.recordId??randomUUID(),version=input.expectedVersion+1;
 let scopeBasis:MaterialInvestmentScopeBasis|undefined;
 let investmentMaterialOccurrences:PreparationMaterialFact['investmentMaterialOccurrences'];
 if(handedDocument&&input.state==='ready'&&input.scopeRef==='whole'&&
  (prior?.investmentScopeBasis||(handedDocument.status==='draft'&&handedDocument.document.customerOrderDraft?.withOrder===true&&handedDocument.document.customerOrderDraft.stage==='preorder'))){
  const materials=definedInvestmentMaterials(handedDocument.document.materials);
  scopeBasis={materialIds:materials.map(row=>row[0]),materialFingerprints:Object.fromEntries(materials.map(row=>[row[0],preparationHash(row)])),sourceDocumentVersion:handedDocument.version,fingerprint:preparationHash(materials),handoverRecordId:recordId,handoverVersion:version};
 }
 if(input.kind==='material_investment'){
  const handover=current.find(row=>row.kind==='design_handover'&&row.scopeRef===input.scopeRef&&row.state==='ready'&&row.valid);
  scopeBasis=handover?.investmentScopeBasis;
  if(scopeBasis&&(input.state==='ready'||input.state==='partial')){
   const rowKey=(row:PreparationMaterialRecord['quantities'][number])=>JSON.stringify([row.materialId,row.lineId,row.unit,row.materialId?null:row.name]);
   const quantities=[...new Map([...(prior?.quantities??[]),...input.quantities].map(row=>[rowKey(row),row])).values()];
   investmentMaterialOccurrences={...prior?.investmentMaterialOccurrences};
   for(const row of input.quantities){
    const id=row.materialId;
    if(!id||!scopeBasis.materialFingerprints[id])continue;
    const changed=!prior?.quantities.some(previous=>rowKey(previous)===rowKey(row)&&previous.quantity===row.quantity);
    if(changed||input.investmentMaterialId===id)investmentMaterialOccurrences[id]={fingerprint:scopeBasis.materialFingerprints[id]!,occurredAt:input.occurredAt!};
   }
   const complete=preparationInvestmentComplete(handover,{state:input.state,valid:true,quantities,investmentMaterialOccurrences});
   input={...input,quantities,state:input.state==='ready'&&!complete?'partial':input.state};
  }
 }
 await db.query(`INSERT INTO digital_preparation_material_versions(record_id,version,resource_kind,resource_id,kind,scope_ref,state,occurred_at,body,actor_id,recorded_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP)`,[recordId,version,target.kind,target.id,input.kind,input.scopeRef,input.state,input.occurredAt,JSON.stringify({...input,...(handoverMaterials?{handoverMaterials}:{}),...(scopeBasis?{investmentScopeBasis:scopeBasis}:{}),...(investmentMaterialOccurrences?{investmentMaterialOccurrences}:{}),materialBasis:await preparationMaterialBasis(db,context,input.kind)}),actorId]);
 return {recordId,version};
}

/** A source revision changes requirements, not the history of physical receipt or its original clock. */
export async function preparationMaterialBasis(db:PreparationDB,context:Awaited<ReturnType<typeof preparationContext>>,kind:PreparationMaterialKind){
 if(!['fabric_receipt','accessories_ready','style_label_ready'].includes(kind))return null;
 if(kind==='style_label_ready')return preparationHash({style:context.source?.design_style_no??context.order?.design_style_no,lines:context.lines.map(l=>[l.line_id,l.color])});
 const document=context.sourceId?await developmentDocumentRow(db,context.sourceId):null;
 const materials=(document?.document.materials??[]).filter((m:{category:string})=>kind==='fabric_receipt'?m.category!=='辅料':m.category==='辅料').map((m:{materialId:string;name:string;color:string;specification:string;width:string;weight:string;composition:string})=>[m.materialId,m.name,m.color,m.specification,m.width,m.weight,m.composition]).sort((a:unknown[],b:unknown[])=>String(a[0]).localeCompare(String(b[0])));
 const instruction=context.orderId&&kind==='accessories_ready'?(await db.query('SELECT document FROM digital_instruction_documents WHERE production_order_id=$1',[context.orderId])).rows[0]:null;
 return preparationHash({materials,accessories:instruction?.document.accessories??null});
}
