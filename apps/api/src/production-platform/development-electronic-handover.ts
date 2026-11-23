import {randomUUID} from 'node:crypto';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import type {DevelopmentElectronicHandoverItem} from '@dx-rework/contracts/digital-development-workspace';
import type {PreparationMaterialFact} from '@dx-rework/contracts/production-readiness';
import type {TrustedActorContext} from '../tools/repositories.js';
import {businessNow} from '../acceptance-clock/business-time.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';
import {developmentDocumentSnapshot} from './development-document-snapshot.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {currentPreparationMaterials,preparationAvailable,preparationContext,preparationHash,preparationMaterialHistory,type PreparationDB} from './preparation-material-repository.js';
import {hasQuotationSchema} from './quotation-budget-basis.js';

export const DEVELOPMENT_HANDOVER_ENTITY='digital_development_handover';
const ELECTRONIC_HANDOVER_EVENT='design_electronic_documents_shared';
const electronicKinds=['materials','order_quantities','quotation'] as const;

type Basis={kind:DevelopmentElectronicHandoverItem['kind'];id:string;version:number;content:string;orderId?:string};
type HandoverScope={sourceId:string;round:number;recipientId:string|null};
type ElectronicEvent={id:string;after_state:{round:number;recipientId:string;at:string;bases:Basis[]}};

function materialBasis(document:DevelopmentDocument){
 const rows=document.materials.filter(row=>row.requiredThisRound||row.name.trim());
 if(!rows.length||rows.some(row=>!row.name.trim()||!row.supplier.trim()||!row.quantity.trim()||!row.quantityUnit?.trim()))return null;
 return preparationHash(rows.map(row=>[row.materialId,row.category,row.name,row.supplier,row.quantity,row.quantityUnit,
  row.color,row.specification,row.part??'',row.garmentColor??'',row.width,row.weight,row.composition,row.sampleAttachmentId??null,
 ]).sort(([a],[b])=>String(a).localeCompare(String(b),'en')));
}

export async function designElectronicBases(db:PreparationDB,sourceId:string,document:{version:number;document:DevelopmentDocument},
 order:{id:string;version:number;customer:string}|null):Promise<Basis[]>{
 const bases:Basis[]=[];
 const materials=materialBasis(document.document);
 if(materials)bases.push({kind:'materials',id:sourceId,version:document.version,content:materials});
 if(!order)return bases;
 const rows=(await db.query<{line_id:string;po_number:string|null;color:string;size:string|null;quantity:number|null}>(`SELECT p.line_id,p.po_number,p.color,s.size,s.quantity
  FROM digital_production_po_lines p LEFT JOIN digital_production_po_sizes s USING(line_id)
  WHERE p.production_order_id=$1 ORDER BY p.line_id,s.size COLLATE "C"`,[order.id])).rows;
 if(rows.length&&rows.every(row=>row.size&&row.quantity&&row.quantity>0))bases.push({kind:'order_quantities',id:order.id,orderId:order.id,
  version:order.version,content:preparationHash(rows)});
 if(await hasQuotationSchema(db)){
  const quotes=(await db.query<{quote_id:string;version:number}>(`SELECT d.quote_id,v.version FROM digital_quotation_documents d
   JOIN digital_quotation_versions v ON v.quote_id=d.quote_id AND v.version=d.confirmed_version AND v.customer_code=$3
   WHERE d.production_order_id=$1 AND (d.source_id=$2 OR d.source_id IS NULL)`,[order.id,sourceId,order.customer])).rows;
  if(quotes.length===1){const quote=quotes[0]!;bases.push({kind:'quotation',id:quote.quote_id,orderId:order.id,version:quote.version,content:String(quote.version)});}
 }
 return bases;
}

export async function readDesignElectronicHandover(db:PreparationDB,scope:HandoverScope,bases:readonly Basis[],
 handover:PreparationMaterialFact|undefined,orderState:'available'|'not_applicable'|'unavailable'):Promise<DevelopmentElectronicHandoverItem[]>{
 const currentHandover=handover?.state==='ready'&&handover.recipientId===scope.recipientId?handover:undefined;
 const events=scope.recipientId&&currentHandover?(await db.query<ElectronicEvent>(`SELECT id,after_state FROM audit_events
  WHERE entity_type=$1 AND entity_id=$2 AND action=$3 AND after_state->>'round'=$4 AND after_state->>'recipientId'=$5
  ORDER BY created_at DESC,id DESC`,[DEVELOPMENT_HANDOVER_ENTITY,scope.sourceId,ELECTRONIC_HANDOVER_EVENT,String(scope.round),scope.recipientId])).rows:[];
 const originalVersion=currentHandover?.sourceDocumentVersion;
 const original=scope.recipientId&&currentHandover?.valid&&originalVersion
  ?await developmentDocumentSnapshot(db,scope.sourceId,scope.round,originalVersion):undefined;
 return electronicKinds.map(kind=>{
  const basis=bases.find(item=>item.kind===kind);
  const version=basis?.version??null;
  if(orderState==='unavailable'&&kind!=='materials')return {kind,version,state:'unavailable'};
  if(orderState==='not_applicable'&&kind==='order_quantities')return {kind,version,state:'not_applicable'};
  if(!basis)return {kind,version,state:'incomplete'};
  if(!scope.recipientId)return {kind,version,state:'waiting_recipient'};
  const originalMatches=kind==='materials'&&original&&materialBasis(original.document)===basis.content;
  if(originalMatches&&currentHandover?.occurredAt)return {kind,version,state:'shared',receipt:{
   id:currentHandover.recordId,version:originalVersion!,recipientId:scope.recipientId,at:currentHandover.occurredAt,
  }};
  for(const event of events){
   const shared=event.after_state.bases.find(item=>item.kind===kind&&item.id===basis.id&&item.orderId===basis.orderId&&item.content===basis.content);
   if(shared)return {kind,version,state:'shared',receipt:{id:event.id,version:shared.version,recipientId:scope.recipientId,at:event.after_state.at}};
  }
  return {kind,version,state:'waiting_share'};
 });
}

/** The caller has just completed an authorized original handover and holds its source/order locks. */
async function recordDesignElectronicHandover(db:PreparationDB,actor:TrustedActorContext,scope:HandoverScope,
 bases:readonly Basis[],handover:PreparationMaterialFact|undefined){
 if(!scope.recipientId||!handover||handover.recipientId!==scope.recipientId)return;
 const current=await readDesignElectronicHandover(db,scope,bases,handover,bases.some(item=>Boolean(item.orderId))?'available':'not_applicable');
 const pending=bases.filter(item=>current.find(value=>value.kind===item.kind)?.state==='waiting_share');
 if(!pending.length)return;
 await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state)
  VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),actor.requestId,actor.actorId,ELECTRONIC_HANDOVER_EVENT,DEVELOPMENT_HANDOVER_ENTITY,
  scope.sourceId,JSON.stringify({round:scope.round,recipientId:scope.recipientId,at:businessNow().toISOString(),bases:pending})]);
}

/** A successful source, order or quotation command may share newly accepted
 * versions under the recipient's existing effective design handover. */
export async function shareApprovedDesignVersions(db:PreparationDB,actor:TrustedActorContext,sourceId:string){
 if(!actor.actorRoles.includes('sample_designer')||!await preparationAvailable(db))return;
 const context=await preparationContext(db,{kind:'source',id:sourceId});
 if(context.source?.created_by!==actor.actorId||!context.orderId||!context.order?.primary_merchandiser_id)return;
 const recipientId:string=context.order.primary_merchandiser_id;
 const facts=currentPreparationMaterials(await preparationMaterialHistory(db,context),context.orderId);
 const handover=facts.find(fact=>fact.kind==='design_handover'&&fact.scopeRef==='whole'&&fact.state==='ready'&&fact.valid
  &&fact.recipientId===recipientId&&fact.resource.kind==='source'&&fact.resource.id===sourceId);
 if(!handover)return;
 const policy=new DigitalProductionAccessPolicy(db);
 if(!await policy.lockActiveRole(actor.actorId,'sample_designer')||!await policy.lockActiveRole(recipientId,'order_merchandiser')
  ||!await policy.allowed(actor,'order',context.orderId,'technical'))return;
 const document=await developmentDocumentRow(db,sourceId);
 if(document?.status!=='published')return;
 const order={id:context.orderId,version:Number(context.order.version),customer:String(context.order.customer_code)};
 const bases=await designElectronicBases(db,sourceId,document,order);
 await recordDesignElectronicHandover(db,actor,{sourceId,round:document.round_number,recipientId},bases,handover);
}
