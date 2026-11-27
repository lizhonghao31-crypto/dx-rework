import {ApplicationError} from '../platform/errors.js';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {PreparationMaterialFact,PreparationMaterialKind,PreparationResource,PreparationMaterialRecord,MaterialInvestmentScopeBasis,WarehouseReceiptBatchEvidence} from '@dx-rework/contracts/production-readiness';
import type {DevelopmentMaterial} from '@dx-rework/contracts/digital-development';
import type {InstructionDocument} from '@dx-rework/contracts/production-instruction';
import {PREPARATION_RULE_VERSION,preparationInvestmentRowKey as investmentRowKey} from '@dx-rework/contracts/production-readiness';
import {businessNow,acceptanceBusinessContext} from '../acceptance-clock/business-time.js';
import {digitalNotFound} from './access-policy.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {deriveStyleLabelOccurrences} from './style-label-evidence.js';
import {originalPreorderDemandBalance,PREORDER_APPLICABILITY_EVENT,projectPreorderInvestmentApplicability,readPreorderApplicabilityProofs} from './preorder-investment-evidence.js';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';

export type PreparationDB=Pick<Pool|PoolClient,'query'>;
export const preparationHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type LegacyReceiptMaterial=Pick<DevelopmentMaterial,'category'|'materialId'|'name'|'color'|'specification'|'width'|'weight'|'composition'>;

/** Keep the stored pre-batch receipt fingerprint format for old records. */
export function legacyPreparationMaterialFingerprint(
 kind:'fabric_receipt'|'accessories_ready',
 developmentMaterials:readonly LegacyReceiptMaterial[]|null|undefined,
 instructionAccessories:readonly InstructionDocument['accessories'][number][]|null|undefined,
){
 const materials=(developmentMaterials??[]).filter(material=>kind==='fabric_receipt'?material.category!=='辅料':material.category==='辅料')
  .map(material=>[material.materialId,material.name,material.color,material.specification,material.width,material.weight,material.composition])
  .sort((left,right)=>String(left[0]).localeCompare(String(right[0])));
 return preparationHash({materials,accessories:kind==='accessories_ready'?instructionAccessories??null:null});
}

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
type InvestmentMaterial=Pick<DevelopmentMaterial,'materialId'|'category'|'name'|'quantity'|'color'|'specification'|'supplier'>
 &Partial<Pick<DevelopmentMaterial,'width'|'weight'|'composition'|'supplierReference'|'quantityUnit'|'garmentColor'>>
 &{instructionSpecifications?:readonly string[]};

export function instructionInvestmentMaterials(document:Pick<InstructionDocument,'fabrics'|'accessories'|'fabricType'|'composition'>):InvestmentMaterial[]{
 return [
  ...document.fabrics.filter(row=>row.name.trim()).map(row=>{
   const colors=Object.entries(row.colors).filter(([,color])=>Boolean(color)).sort(([a],[b])=>a.localeCompare(b,'en'));
   return {materialId:row.id,category:'主布' as const,name:row.name,quantity:'',
    color:colors.map(([,color])=>color).join(' / '),specification:row.part,supplier:'',
    // The native instruction stores width and weight in the fabric remarks.
    instructionSpecifications:[document.fabricType,document.composition,row.remarks,JSON.stringify(colors)]};
  }),
  ...document.accessories.filter(row=>row.name.trim()).map(row=>({materialId:row.id,category:'辅料' as const,name:row.name,quantity:'',
   color:row.materialColor,specification:row.specification,supplier:'',
   instructionSpecifications:[row.group,row.garmentColors,row.category,row.part,row.consumption]})),
 ];
}

export async function directInvestmentInstruction(db:PreparationDB,orderId:string){
 return (await db.query<{version:number;document:InstructionDocument}>(
  'SELECT version,document FROM digital_instruction_documents WHERE production_order_id=$1 AND version>0',[orderId])).rows[0]??null;
}

export function preparationInvestmentScope(materials:readonly InvestmentMaterial[],origin:'source'|'instruction'='source'){
 const rows=materials.filter(row=>row.name.trim()&&(origin==='instruction'||row.quantity.trim()))
  .map(row=>[row.materialId,row.category,row.name,row.quantity,row.color,row.specification,row.supplier,
   ...(origin==='source'?[row.width??'',row.weight??'',row.composition??'']:row.instructionSpecifications??[])] as const)
  .sort((a,b)=>a[0].localeCompare(b[0],'en'));
 return {rows,fingerprint:preparationHash(rows),fabric:rows.some(row=>row[1]==='主布'||row[1]==='配布'),accessories:rows.some(row=>row[1]==='辅料')};
}
/** A physical batch belongs to the original invested material, not to every
 * accessory in the current instruction. Source batches keep that origin when
 * carried into the formal order. Actual changes to that same material still
 * exclude the old batch from the current scope. */
export function warehouseReceiptMaterialCurrent(kind:PreparationResource['kind'],evidence:WarehouseReceiptBatchEvidence,
 source:readonly InvestmentMaterial[]|null,instruction:InstructionDocument|null){
 const rows=(kind==='source'?source:instruction?instructionInvestmentMaterials(instruction):null)?.filter(row=>row.materialId===evidence.materialId);
 if(rows?.length!==1)return false;
 if((rows[0]?.supplierReference?.supplierId??null)!==evidence.supplierId)return false;
 const row=preparationInvestmentScope(rows,kind==='source'?'source':'instruction').rows[0];
 return Boolean(row&&preparationHash(row)===evidence.materialFingerprint);
}
export function preparationInvestmentComplete(handover:Pick<PreparationMaterialFact,'investmentScopeBasis'|'preorderApplicability'>|undefined,investment:Pick<PreparationMaterialFact,'state'|'valid'|'quantities'|'investmentMaterialOccurrences'>|undefined){
 if(investment?.state!=='ready'||!investment.valid)return false;
 if(Object.entries(handover?.preorderApplicability?.quantityDemand??{}).some(([id,row])=>
  originalPreorderDemandBalance(row.requested,row.unit,investment.quantities.filter(quantity=>quantity.materialId===id))?.remaining!=='0'))return false;
 const required=handover?.investmentScopeBasis?.materialIds;
 return !required||required.length>0&&required.every(id=>investment.quantities.some(row=>row.materialId===id)
  &&investment.investmentMaterialOccurrences?.[id]?.fingerprint===handover!.investmentScopeBasis!.materialFingerprints[id]);
}

/** Version-only changes do not invalidate an explicitly handed-over preorder.
 * A different material set always requires an additional real handover. */
export function preparationHandoverCurrent(handover:Pick<PreparationMaterialFact,'sourceDocumentVersion'|'orderInstructionVersion'|'investmentScopeBasis'|'preorderApplicability'>,
 document:{version:number;materials:readonly InvestmentMaterial[]}|null,origin:'source'|'instruction'='source'){
 const version=origin==='source'?handover.sourceDocumentVersion:handover.orderInstructionVersion;
 if(!document)return origin==='instruction'&&version===undefined;
 if(origin==='source'&&version!==document.version&&handover.preorderApplicability?.sourceVersion===document.version)return handover.preorderApplicability.full;
 return version===document.version||Boolean(handover.investmentScopeBasis&&
  preparationInvestmentScope(document.materials,origin).fingerprint===handover.investmentScopeBasis.fingerprint);
}

export const materialBasisChanged='物料要求已变化，请核对本轮实际适用性；原物料记录保留';
export const sourceHandoverChanged='设计交接所引用资料已有新版本';

type HandoverBasisDocument=Parameters<typeof preparationHandoverCurrent>[1];
function designHandoverVersionReasons(body:PreparationMaterialRecord,resourceKind:PreparationResource['kind'],orderId:string|null,
 sourceId:string|null,sourceDocument:HandoverBasisDocument,instruction:HandoverBasisDocument){
 if(body.orderInstructionVersion!==undefined&&orderId){
  return preparationHandoverCurrent(body,instruction,'instruction')?[]:['设计交接所引用的本单制单资料已有新版本'];
 }
 if(sourceId&&(resourceKind==='source'||body.sourceDocumentVersion!=null)&&!preparationHandoverCurrent(body,sourceDocument))return [sourceHandoverChanged];
 return [];
}

export async function attachCurrentPreorderApplicability(db:PreparationDB,history:PreparationMaterialFact[],
 sourceId:string|null,document:{document:Pick<DevelopmentDocument,'materials'>;version:number;round_number:number}|null|undefined,
 preloadedProofs?:Awaited<ReturnType<typeof readPreorderApplicabilityProofs>>){
 if(!sourceId||!document)return history;
 const investment=history.find(fact=>fact.kind==='material_investment'&&fact.scopeRef==='whole'&&fact.resource.kind==='source'&&fact.resource.id===sourceId);
 const handovers=history.filter(fact=>fact.kind==='design_handover'&&fact.scopeRef==='whole'&&fact.resource.kind==='source'&&fact.resource.id===sourceId);
 const initial=handovers[0],purchaseBasis=investment?.investmentScopeBasis;
 const origin=purchaseBasis&&handovers.find(fact=>fact.recordId===purchaseBasis.handoverRecordId&&fact.version===purchaseBasis.handoverVersion);
 const choices=[...new Set([initial,origin])].filter((handover):handover is PreparationMaterialFact=>
  Boolean(handover?.investmentScopeBasis?.preorder&&handover.sourceDocumentVersion!==document.version&&handover.state==='ready'&&
   !handover.invalidReasons.some(reason=>reason!==sourceHandoverChanged)));
 if(!choices.length)return history;
 const proofs=preloadedProofs??await readPreorderApplicabilityProofs(db,[sourceId]);
 const projections=new Map(choices.flatMap(handover=>{
  const projected=projectPreorderInvestmentApplicability(handover,investment,{version:document.version,roundNumber:document.round_number,
   materials:document.document.materials},proofs);
  return projected?[[handover,projected] as const]:[];
 }));
 return history.map(fact=>{
  const projection=projections.get(fact);
  if(projection){
   const invalidReasons=fact.invalidReasons.filter(reason=>reason!==sourceHandoverChanged);
   if(!projection.full)invalidReasons.push(sourceHandoverChanged);
   return {...fact,preorderApplicability:projection,invalidReasons,valid:!invalidReasons.length};
  }
  const receipt=fact.warehouseReceipt;
  const prior=origin??initial,applied=prior?projections.get(prior):undefined;
  if(fact.resource.kind==='source'&&fact.resource.id===sourceId&&receipt&&applied&&
    prior?.investmentScopeBasis?.materialFingerprints[receipt.materialId]===receipt.materialFingerprint){
   const invalidReasons=fact.invalidReasons.filter(reason=>reason!==materialBasisChanged);
   if(applied.originalFingerprints[receipt.materialId]!==receipt.materialFingerprint)invalidReasons.push(materialBasisChanged);
   return {...fact,invalidReasons,valid:!invalidReasons.length};
  }
  return fact;
 });
}

export async function preparationMaterialHistory(db:PreparationDB,context:Awaited<ReturnType<typeof preparationContext>>):Promise<PreparationMaterialFact[]>{
 if(!await preparationAvailable(db))return [];
 const rows=(await db.query(`SELECT m.*,u.display_name,proof.after_state AS applicability_confirmation
  FROM digital_preparation_material_versions m LEFT JOIN app_users u ON u.id=m.actor_id
  LEFT JOIN audit_events proof ON m.kind='material_investment' AND proof.id=(m.body->>'preorderApplicabilityConfirmationId')::uuid
   AND proof.action=$3 AND proof.entity_type='digital_preparation' AND proof.entity_id=$2::uuid::text AND proof.actor_id=m.actor_id
   AND proof.after_state->'investment'->>'recordId'=m.record_id::text
   AND proof.after_state->'investment'->>'version'=m.body->>'preorderApplicabilityAnchorVersion'
  WHERE (m.resource_kind='order' AND m.resource_id=$1) OR (m.resource_kind='source' AND m.resource_id=$2::uuid)
  ORDER BY m.recorded_at DESC,m.version DESC,m.record_id`,[context.orderId,context.sourceId,PREORDER_APPLICABILITY_EVENT])).rows;
 const result:PreparationMaterialFact[]=[];
 const orderInstruction=context.orderId&&rows.some(row=>row.kind==='design_handover'&&row.body.orderInstructionVersion!==undefined||row.resource_kind==='order'&&row.body.warehouseReceipt)
  ?await directInvestmentInstruction(db,context.orderId):null;
 const receiptSource=context.sourceId&&rows.some(row=>row.resource_kind==='source'&&(row.body.warehouseReceipt||row.kind==='design_handover'))?await developmentDocumentRow(db,context.sourceId):null;
 const instructionBasis=orderInstruction?{version:orderInstruction.version,materials:instructionInvestmentMaterials(orderInstruction.document)}:null;
 for(const row of rows){
  const missing: string[]=[];
  const receipt=row.body.warehouseReceipt as WarehouseReceiptBatchEvidence|undefined;
  if(receipt?!warehouseReceiptMaterialCurrent(row.resource_kind,receipt,receiptSource?.document.materials??null,orderInstruction?.document??null)
   :row.body.materialBasis&&row.body.materialBasis!==await preparationMaterialBasis(db,context,row.kind))missing.push(materialBasisChanged);
  if(row.kind==='design_handover'){
   const document=!(row.body.orderInstructionVersion!==undefined&&context.orderId)&&context.sourceId&&
    (row.resource_kind==='source'||row.body.sourceDocumentVersion!=null)?receiptSource??await developmentDocumentRow(db,context.sourceId):null;
   missing.push(...designHandoverVersionReasons(row.body,row.resource_kind,context.orderId,context.sourceId,
    document?{version:document.version,materials:document.document.materials}:null,instructionBasis));
  }
  if(row.body.evidenceIds?.length){const ready=(await db.query("SELECT count(*)::int AS n FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND status='ready'",[row.body.evidenceIds])).rows[0].n;if(ready!==row.body.evidenceIds.length)missing.push('原凭证已失效或尚未完成上传');}
  const proof=row.applicability_confirmation;
  result.push({...row.body,kind:row.kind,scopeRef:row.scope_ref,state:row.state,recordId:row.record_id,version:row.version,resource:{kind:row.resource_kind,id:row.resource_id},occurredAt:preparationIso(row.occurred_at),recordedAt:preparationIso(row.recorded_at)!,recordedBy:row.actor_id,operatorName:row.display_name??'',valid:!missing.length,invalidReasons:missing,
   ...(proof?{preorderApplicabilityConfirmation:{confirmedAt:proof.confirmedAt,evidenceIds:proof.sameMaterialEvidenceIds}}:{})});
 }
 return attachCurrentPreorderApplicability(db,result,context.sourceId,receiptSource);
}

type FormalPreparationPair={orderId:string;sourceId:string;version:number;round_number:number;document:Pick<DevelopmentDocument,'materials'>};

/** Only evidence consumed by the current formal-design receipt. Restrict
 * order streams to the original order and source, not every prep activity. */
export async function currentFormalPreparationHandovers(db:PreparationDB,pairs:readonly FormalPreparationPair[]){
 const result=new Map<string,PreparationMaterialFact>();
 if(!pairs.length||!await preparationAvailable(db))return result;
 const scope=JSON.stringify(pairs.map(({orderId,sourceId})=>({orderId,sourceId})));
 const rows=(await db.query<{orderId:string;record_id:string;version:number;resource_kind:PreparationResource['kind'];resource_id:string;
  kind:PreparationMaterialKind;scope_ref:string;state:PreparationMaterialFact['state'];body:PreparationMaterialRecord&{materialBasis?:string};occurred_at:Date|null;
  recorded_at:Date;actor_id:string;evidence_current:boolean}>(`WITH selected AS(
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS pair("orderId" uuid,"sourceId" uuid)
 ) SELECT pair."orderId",m.record_id,m.version,m.resource_kind,m.resource_id,m.kind,m.scope_ref,m.state,m.body,m.occurred_at,m.recorded_at,m.actor_id,
  jsonb_array_length(proof.ids)=(SELECT count(*) FROM attachments a WHERE a.status='ready' AND a.attachment_id IN
   (SELECT id::uuid FROM jsonb_array_elements_text(proof.ids) AS evidence(id))) AS evidence_current
 FROM selected pair JOIN LATERAL(
  SELECT m.* FROM digital_preparation_material_versions m WHERE m.kind='design_handover' AND m.scope_ref='whole'
   AND (m.resource_kind='source' AND m.resource_id=pair."sourceId" OR m.resource_kind='order' AND m.resource_id=pair."orderId")
  UNION ALL
  (SELECT m.* FROM digital_preparation_material_versions m WHERE m.kind='material_investment' AND m.scope_ref='whole'
   AND m.resource_kind='source' AND m.resource_id=pair."sourceId" ORDER BY m.recorded_at DESC,m.version DESC,m.record_id LIMIT 1)
 ) m ON true CROSS JOIN LATERAL (SELECT coalesce(nullif(m.body->'evidenceIds','null'::jsonb),'[]'::jsonb) AS ids) proof
 ORDER BY pair."orderId",m.recorded_at DESC,m.version DESC,m.record_id`,[scope])).rows;
 const instructionIds=[...new Set(rows.filter(row=>row.kind==='design_handover'&&row.body.orderInstructionVersion!==undefined).map(row=>row.orderId))];
 const instructions=new Map<string,HandoverBasisDocument>(instructionIds.length?(await db.query<{production_order_id:string;version:number;document:InstructionDocument}>(
  'SELECT production_order_id,version,document FROM digital_instruction_documents WHERE production_order_id=ANY($1::uuid[]) AND version>0',[instructionIds])).rows
  .map(row=>[row.production_order_id,{version:row.version,materials:instructionInvestmentMaterials(row.document)}]):[]);
 const documents=new Map(pairs.map(pair=>[pair.orderId,pair]));
 const histories=new Map<string,PreparationMaterialFact[]>();
 for(const row of rows){
  const pair=documents.get(row.orderId)!;
  const history=histories.get(pair.orderId)??[];
  const missing=row.kind==='design_handover'?designHandoverVersionReasons(row.body,row.resource_kind,pair.orderId,pair.sourceId,
   {version:pair.version,materials:pair.document.materials},instructions.get(pair.orderId)??null):[];
  if(row.body.materialBasis)missing.unshift(materialBasisChanged);
  if(!row.evidence_current)missing.push('原凭证已失效或尚未完成上传');
  history.push({...row.body,kind:row.kind,scopeRef:row.scope_ref,state:row.state,recordId:row.record_id,version:row.version,
   resource:{kind:row.resource_kind,id:row.resource_id},occurredAt:preparationIso(row.occurred_at),recordedAt:preparationIso(row.recorded_at)!,
   recordedBy:row.actor_id,operatorName:'',valid:!missing.length,invalidReasons:missing});
  histories.set(pair.orderId,history);
 }
 const sourcesNeedingProofs=pairs.filter(pair=>histories.get(pair.orderId)?.some(row=>row.kind==='design_handover'&&
  row.resource.kind==='source'&&row.investmentScopeBasis?.preorder&&row.sourceDocumentVersion!==pair.version)).map(pair=>pair.sourceId);
 const proofs=await readPreorderApplicabilityProofs(db,[...new Set(sourcesNeedingProofs)]);
 for(const pair of pairs){
  const history=histories.get(pair.orderId);
  if(!history)continue;
  const current=currentPreparationMaterials(await attachCurrentPreorderApplicability(db,history,pair.sourceId,pair,proofs),pair.orderId)
   .find(row=>row.kind==='design_handover');
  if(current)result.set(pair.orderId,current);
 }
 return result;
}
/** An existing order stream keeps authority after source attachment. Source-only records are adopted by reference, never copied as receipts. */
export function currentPreparationMaterials(history:PreparationMaterialFact[],orderId:string|null){
 const heads=new Map<string,PreparationMaterialFact>();
 for(const row of history){
  // Physical receipt batches have their own exact stream in this original
  // evidence table. They are not whole-order QA or preparation clearance.
  if(row.warehouseReceipt)continue;
  const key=`${row.kind}:${row.scopeRef}`,prior=heads.get(key);
  if(!prior||row.resource.kind==='order'&&row.resource.id===orderId&&prior.resource.kind!=='order'||row.recordId===prior.recordId&&row.version>prior.version)heads.set(key,row);
 }
 return [...heads.values()].map(row=>{
  if(row.kind!=='material_investment'||row.state!=='ready')return row;
  const handover=heads.get('design_handover:'+row.scopeRef);
  if(!row.investmentScopeBasis&&!handover?.investmentScopeBasis)return row;
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
type Quantity=PreparationMaterialRecord['quantities'][number];

function correctedInvestmentQuantities(prior:readonly Quantity[],correction:NonNullable<PreparationMaterialRecord['investmentQuantityCorrection']>,replacement:Quantity){
 const previous=prior[correction.index],original=correction.previous;
 if(!previous||investmentRowKey(previous)!==investmentRowKey(original)||previous.name!==original.name||previous.quantity!==original.quantity)
  throw new ApplicationError('PREPARATION_CONFLICT','所选投面辅料原明细已变化，请读取当前版本',409);
 if(prior.some((row,index)=>index!==correction.index&&investmentRowKey(row)===investmentRowKey(replacement)))
  throw new ApplicationError('PREPARATION_CONFLICT','订正后的物料、款色及单位已有实际记录，请核对原明细',409);
 return prior.map((row,index)=>index===correction.index?replacement:row);
}

function preorderPhysicalScopeChanges(prior:PreparationMaterialFact|undefined,handover:PreparationMaterialFact|undefined,history:readonly PreparationMaterialFact[]){
 const previous=prior?.investmentScopeBasis,next=handover?.investmentScopeBasis;
 if(!previous?.preorder||!next?.preorder||previous.handoverRecordId===next.handoverRecordId&&previous.handoverVersion===next.handoverVersion)return new Set<string>();
 const original=history.find(row=>row.kind==='design_handover'&&row.recordId===previous.handoverRecordId&&row.version===previous.handoverVersion&&
  row.resource.kind===prior?.resource.kind&&row.resource.id===prior.resource.id);
 return new Set(previous.materialIds.filter(id=>{
  const before=original?.handoverMaterials?.filter(row=>row.materialId===id),after=handover?.handoverMaterials?.filter(row=>row.materialId===id);
  if(before?.length!==1||after?.length!==1)return true;
  const old=before[0]!,current=after[0]!;
  // The historic display-based fingerprint does not distinguish equal supplier labels or physical ranges.
  return old.supplierId!==current.supplierId||(old.garmentColor??'')!==(current.garmentColor??'')||
   (old.quantityUnit??'')!==(current.quantityUnit??'');
 }));
}

function investmentQuantitiesWithEvidence(input:PreparationMaterialRecord,prior:PreparationMaterialFact|undefined,scope:MaterialInvestmentScopeBasis|undefined,quantities:Quantity[],
 changedPhysicalScope?:ReadonlySet<string>){
 const original=prior?.quantities??[],previous=new Map(original.map(row=>[investmentRowKey(row),row]));
 const evidence={...prior?.investmentQuantityOccurrences};
 if(!prior?.investmentQuantityOccurrences&&prior?.investmentMaterialOccurrences){
  const counts=new Map<string,number>();
  for(const {materialId} of original)if(materialId)counts.set(materialId,(counts.get(materialId)??0)+1);
  // Old material-level evidence identifies the row only when there is one.
  for(const row of original){
   const id=row.materialId,occurrence=id?prior.investmentMaterialOccurrences[id]:undefined;
   if(id&&occurrence&&counts.get(id)===1)evidence[investmentRowKey(row)]=occurrence;
  }
 }
 for(const row of original)if(row.materialId&&changedPhysicalScope?.has(row.materialId))delete evidence[investmentRowKey(row)];
 const correction=input.investmentQuantityCorrection;
 if(correction)delete evidence[investmentRowKey(correction.previous)];
 const selected=input.quantities.filter(row=>row.materialId&&row.materialId===input.investmentMaterialId);
 for(const row of input.quantities){
  const fingerprint=row.materialId?scope?.materialFingerprints[row.materialId]:null;
  if(!fingerprint)continue;
  const key=investmentRowKey(row);
  if(correction||previous.get(key)?.quantity!==row.quantity||selected.length===1&&selected[0]===row)
   evidence[key]={fingerprint,occurredAt:input.occurredAt!};
 }
 const rowOccurrences:NonNullable<PreparationMaterialFact['investmentQuantityOccurrences']>={};
 const materialOccurrences:NonNullable<PreparationMaterialFact['investmentMaterialOccurrences']>={};
 for(const row of quantities){
  const key=investmentRowKey(row),occurrence=evidence[key],id=row.materialId;
  if(!occurrence||!id)continue;
  rowOccurrences[key]=occurrence;
  if(scope&&occurrence.fingerprint!==scope.materialFingerprints[id])continue;
  const current=materialOccurrences[id];
  if(!current||Date.parse(occurrence.occurredAt)>Date.parse(current.occurredAt))materialOccurrences[id]=occurrence;
 }
 return {rowOccurrences,materialOccurrences};
}
/** Internal native producer; callers retain original transaction, authorization and optimistic version guards. */
export async function appendPreparationMaterial(db:PreparationDB,context:Awaited<ReturnType<typeof preparationContext>>,actorId:string,input:PreparationMaterialRecord,warehouse?:{target:PreparationResource;evidence:WarehouseReceiptBatchEvidence}){
 const history=await preparationMaterialHistory(db,context),current=currentPreparationMaterials(history,context.orderId);
 const prior=warehouse?history.filter(f=>f.warehouseReceipt&&f.kind===input.kind&&f.scopeRef===input.scopeRef&&
  f.resource.kind===warehouse.target.kind&&f.resource.id===warehouse.target.id).sort((a,b)=>b.version-a.version)[0]:
  current.find(f=>f.kind===input.kind&&f.scopeRef===input.scopeRef);
 if((prior?.version??0)!==input.expectedVersion)throw new ApplicationError('PREPARATION_CONFLICT','物料原记录已变化，请重新读取',409);
 const handedDocument=input.kind==='design_handover'&&context.sourceId?await developmentDocumentRow(db,context.sourceId):null;
 const directInstruction=input.kind==='design_handover'&&input.orderInstructionVersion!==undefined&&context.orderId
  ?await directInvestmentInstruction(db,context.orderId):null;
 const materialInputs:readonly InvestmentMaterial[]|undefined=directInstruction?instructionInvestmentMaterials(directInstruction.document):handedDocument?.document.materials;
 const handoverMaterials=materialInputs?.map(m=>({
  materialId:m.materialId,category:m.category,supplier:m.supplier,name:m.name,quantity:m.quantity,color:m.color,specification:m.specification,
  ...(!directInstruction?{width:m.width??'',weight:m.weight??'',composition:m.composition??'',quantityUnit:m.quantityUnit??'',garmentColor:m.garmentColor??''}:{}),
  ...(m.supplierReference?{supplierId:m.supplierReference.supplierId}:{})
 }));
 const investmentHandover=input.kind==='material_investment'?current.find(row=>row.kind==='design_handover'
  &&row.scopeRef===input.scopeRef&&row.state==='ready'&&row.valid):undefined;
 const target=prior?.resource??warehouse?.target??investmentHandover?.resource??(context.sourceId?{kind:'source' as const,id:context.sourceId}:context.resource),recordId=prior?.recordId??randomUUID(),version=input.expectedVersion+1;
 let scopeBasis:MaterialInvestmentScopeBasis|undefined;
 let investmentMaterialOccurrences:PreparationMaterialFact['investmentMaterialOccurrences'];
 let investmentQuantityOccurrences:PreparationMaterialFact['investmentQuantityOccurrences'];
 let preorderApplicabilityAnchorVersion:number|undefined;
 const preorder=handedDocument?.status==='draft'&&handedDocument.document.customerOrderDraft?.withOrder===true
  &&handedDocument.document.customerOrderDraft.stage==='preorder';
 if(materialInputs&&input.state==='ready'&&input.scopeRef==='whole'
  &&(directInstruction||preorder||prior?.investmentScopeBasis||context.source?.order_time_managed===true)){
  const scope=preparationInvestmentScope(materialInputs,directInstruction?'instruction':'source');
  if(scope.rows.length)scopeBasis={materialIds:scope.rows.map(row=>row[0]),materialFingerprints:Object.fromEntries(scope.rows.map(row=>[row[0],preparationHash(row)])),
   ...(directInstruction?{orderInstructionVersion:directInstruction.version}:{sourceDocumentVersion:handedDocument!.version}),
   fingerprint:scope.fingerprint,handoverRecordId:recordId,handoverVersion:version,
   ...(preorder||prior?.investmentScopeBasis?.preorder?{preorder:true as const}:{})};
 }
 if(input.kind==='material_investment'){
  scopeBasis=investmentHandover?.investmentScopeBasis;
  if(scopeBasis?.preorder&&prior?.investmentScopeBasis?.handoverRecordId===scopeBasis.handoverRecordId&&
   prior.investmentScopeBasis.handoverVersion===scopeBasis.handoverVersion)preorderApplicabilityAnchorVersion=prior.preorderApplicabilityAnchorVersion;
  const original=prior?.quantities??[],correction=input.investmentQuantityCorrection;
  const corrected=correction?correctedInvestmentQuantities(original,correction,input.quantities[0]!):null;
  if(scopeBasis&&(input.state==='ready'||input.state==='partial')){
   const quantities=corrected??[...new Map([...original,...input.quantities].map(row=>[investmentRowKey(row),row])).values()];
   const {rowOccurrences,materialOccurrences}=investmentQuantitiesWithEvidence(input,prior,scopeBasis,quantities,
    preorderPhysicalScopeChanges(prior,investmentHandover,history));
   investmentQuantityOccurrences=rowOccurrences;
   investmentMaterialOccurrences=materialOccurrences;
   const complete=preparationInvestmentComplete(investmentHandover,{state:input.state,valid:true,quantities,investmentMaterialOccurrences});
   const occurredAt=complete?scopeBasis.materialIds.map(id=>investmentMaterialOccurrences![id]!.occurredAt)
    .reduce((last,actual)=>Date.parse(actual)>Date.parse(last)?actual:last):input.occurredAt;
   input={...input,quantities,occurredAt,state:input.state==='ready'&&!complete?'partial':input.state};
  }else if(corrected){
   const {rowOccurrences,materialOccurrences}=investmentQuantitiesWithEvidence(input,prior,undefined,corrected);
   investmentQuantityOccurrences=rowOccurrences;
   investmentMaterialOccurrences=materialOccurrences;
   input={...input,quantities:corrected};
  }
 }
 const snapshot={...input};
 delete snapshot.investmentQuantityCorrection;
 const labels=input.kind==='style_label_ready'&&context.orderId?deriveStyleLabelOccurrences(context.orderId,
  context.lines.map(row=>({lineId:String(row.line_id),quantity:Number(row.order_quantity)})),
  {...input,recordId,version,resource:target,valid:true},prior):null;
 await db.query(`INSERT INTO digital_preparation_material_versions(record_id,version,resource_kind,resource_id,kind,scope_ref,state,occurred_at,body,actor_id,recorded_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP)`,[recordId,version,target.kind,target.id,input.kind,input.scopeRef,input.state,input.occurredAt,JSON.stringify({...snapshot,...(warehouse?{warehouseReceipt:warehouse.evidence}:{materialBasis:await preparationMaterialBasis(db,context,input.kind)}),...labels,...(handoverMaterials?{handoverMaterials}:{}),...(scopeBasis?{investmentScopeBasis:scopeBasis}:{}),...(investmentMaterialOccurrences?{investmentMaterialOccurrences}:{}),...(investmentQuantityOccurrences?{investmentQuantityOccurrences}:{}),...(preorderApplicabilityAnchorVersion?{preorderApplicabilityAnchorVersion}:{})}),actorId]);
 return {recordId,version};
}

/** A source revision changes requirements, not the history of physical receipt or its original clock. */
export async function preparationMaterialBasis(db:PreparationDB,context:Awaited<ReturnType<typeof preparationContext>>,kind:PreparationMaterialKind){
 if(kind==='style_label_ready')return preparationHash({style:context.source?.design_style_no??context.order?.design_style_no,lines:context.lines.map(l=>[l.line_id,l.color])});
 if(kind!=='fabric_receipt'&&kind!=='accessories_ready')return null;
 const document=context.sourceId?await developmentDocumentRow(db,context.sourceId):null;
 const instruction=context.orderId&&kind==='accessories_ready'?(await db.query('SELECT document FROM digital_instruction_documents WHERE production_order_id=$1',[context.orderId])).rows[0]:null;
 return legacyPreparationMaterialFingerprint(kind,document?.document.materials,instruction?.document.accessories);
}
