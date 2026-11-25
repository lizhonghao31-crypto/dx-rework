import {randomUUID} from 'node:crypto';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import type {DevelopmentElectronicHandoverItem,DevelopmentSampleHandoverReceipt} from '@dx-rework/contracts/digital-development-workspace';
import type {PreparationMaterialFact} from '@dx-rework/contracts/production-readiness';
import type {TrustedActorContext} from '../tools/repositories.js';
import {businessNow,observedBusinessTime} from '../acceptance-clock/business-time.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';
import {developmentDocumentSnapshot} from './development-document-snapshot.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {currentPreparationMaterials,preparationAvailable,preparationContext,preparationHash,preparationMaterialHistory,type PreparationDB} from './preparation-material-repository.js';
import {hasQuotationSchema} from './quotation-budget-basis.js';
import {formalDevelopmentHandoverEnrollment,formalDevelopmentHandoverEvidence} from './development-formal-handover-evidence.js';
import {orderTimeCreated} from './order-time-created.js';
import {appendSeriesSourceEvent} from './series-plan-facts.js';

export const DEVELOPMENT_HANDOVER_ENTITY='digital_development_handover';
export const SAMPLE_HANDOVER_EVENT='design_sample_handed_over';
const ELECTRONIC_HANDOVER_EVENT='design_electronic_documents_shared';
const FORMAL_HANDOVER_EVENT='design_formal_handover_completed';
const electronicKinds=['materials','order_quantities','quotation'] as const;

type Basis={kind:DevelopmentElectronicHandoverItem['kind'];id:string;version:number;content:string;orderId?:string};
type HandoverScope={sourceId:string;round:number;recipientId:string|null};
type ElectronicEvent={id:string;after_state:{round:number;recipientId:string;at:string;bases:Basis[]}};
type SampleDeliveryEvent={event_id:string;actor_id:string;actor_name:string|null;payload:Omit<DevelopmentSampleHandoverReceipt,'eventId'|'confirmedBy'|'confirmedByName'>};

export async function designSampleHandoverHistory(db:PreparationDB,sourceId:string,round:number){
 const events=(await db.query<SampleDeliveryEvent>(`SELECT e.id AS event_id,e.actor_id,u.display_name AS actor_name,e.after_state AS payload
  FROM audit_events e LEFT JOIN app_users u ON u.id=e.actor_id
  WHERE e.entity_type=$1 AND e.entity_id=$2 AND e.action=$3 AND e.after_state->>'round'=$4
  ORDER BY e.created_at DESC,e.id DESC`,[DEVELOPMENT_HANDOVER_ENTITY,sourceId,SAMPLE_HANDOVER_EVENT,String(round)])).rows;
 return events.map(event=>({eventId:event.event_id,...event.payload,confirmedBy:event.actor_id,confirmedByName:event.actor_name}));
}

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
   WHERE d.production_order_id=$1 AND d.version=d.confirmed_version AND (d.source_id=$2 OR d.source_id IS NULL)`,[order.id,sourceId,order.customer])).rows;
  if(quotes.length===1){const quote=quotes[0]!;bases.push({kind:'quotation',id:quote.quote_id,orderId:order.id,version:quote.version,content:String(quote.version)});}
 }
 return bases;
}

export async function readDesignElectronicHandover(db:PreparationDB,scope:HandoverScope,bases:readonly Basis[],
 handover:PreparationMaterialFact|undefined,orderState:'available'|'not_applicable'|'unavailable'):Promise<DevelopmentElectronicHandoverItem[]>{
 const currentHandover=handover?.state==='ready'&&handover.valid&&handover.recipientId===scope.recipientId?handover:undefined;
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

export async function readFormalDesignHandover(db:PreparationDB,orderId:string,sourceId:string){
 if(!await formalDevelopmentHandoverEnrollment(db,orderId,sourceId))return null;
 const row=(await db.query<{event_id:string;occurred_at:Date|string}>(`SELECT event_id,occurred_at FROM digital_series_source_events
  WHERE production_order_id=$1 AND node_key='design_handover' AND scope_ref='whole' AND source_domain='development' AND NOT voided AND business_completed`,[orderId])).rows[0];
 return {historicalCompletion:row?{eventId:row.event_id,at:new Date(row.occurred_at).toISOString()}:null};
}

/** Native callers hold the lifecycle lock and own the original write. */
export async function recordFormalDesignHandover(db:PreparationDB,actor:TrustedActorContext,orderId:string,scope:HandoverScope,
 documentVersion:number,electronic:DevelopmentElectronicHandoverItem[],sample:DevelopmentSampleHandoverReceipt|null){
 const existing=await readFormalDesignHandover(db,orderId,scope.sourceId);
 if(!existing||existing.historicalCompletion||!scope.recipientId)return;
 const origin=await orderTimeCreated(db,{kind:'order',id:orderId});
 const proof=formalDevelopmentHandoverEvidence({sourceId:scope.sourceId,round:scope.round,documentVersion,
  recipient:{id:scope.recipientId,name:null},current:sample,canConfirm:false,electronic,history:[]},origin);
 if(!proof)return;
 const time=observedBusinessTime();
 if(Date.parse(proof.assessmentEligibleAt)>Date.parse(time.now))return;
 const auditId=randomUUID();
 await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state)
  VALUES($1,$2,$3,$4,$5,$6,$7)`,[auditId,actor.requestId,actor.actorId,FORMAL_HANDOVER_EVENT,DEVELOPMENT_HANDOVER_ENTITY,
  scope.sourceId,JSON.stringify({orderId,...proof})]);
 await appendSeriesSourceEvent(db,{eventId:randomUUID(),orderId,key:'design_handover',scopeRef:'whole',sourceDomain:'development',
  sourceRecordId:auditId,sourceVersion:1,occurredAt:proof.satisfiedAt,occurredDate:null,precision:'instant',supersedesEventId:null,
  voided:false,businessCompleted:true,reason:'原面辅料、客户订单数量、已确认报价及样衣均已交给当时的主跟单'},actor.actorId,time);
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
export async function shareApprovedDesignVersions(db:PreparationDB,actor:TrustedActorContext,sourceId:string,
 formalCreation?:{orderId:string;eventId:string}){
 if((!formalCreation&&!actor.actorRoles.includes('sample_designer'))||!await preparationAvailable(db))return;
 const context=await preparationContext(db,{kind:'source',id:sourceId});
 if(!context.orderId||!context.order?.primary_merchandiser_id)return;
 // A reviewed formal confirmation is already an authoritative native write.
 // Reuse the existing recipient handover below without substituting its actor
 // for the designer or giving a later management request new sharing rights.
 const nativeCreation=formalCreation?.orderId===context.orderId&&
  await formalDevelopmentHandoverEnrollment(db,context.orderId,sourceId)===formalCreation.eventId&&
  !!(await db.query(`SELECT 1 FROM audit_events WHERE id=$1 AND entity_type='digital_production'
   AND action='digital_order_created' AND entity_id=$2 AND actor_id=$3`,[formalCreation.eventId,context.orderId,actor.actorId])).rowCount;
 if(!nativeCreation&&(context.source?.created_by!==actor.actorId||!actor.actorRoles.includes('sample_designer')))return;
 const recipientId:string=context.order.primary_merchandiser_id;
 const facts=currentPreparationMaterials(await preparationMaterialHistory(db,context),context.orderId);
 const handover=facts.find(fact=>fact.kind==='design_handover'&&fact.scopeRef==='whole'&&fact.state==='ready'&&fact.valid
  &&fact.recipientId===recipientId&&fact.resource.kind==='source'&&fact.resource.id===sourceId);
 if(!handover)return;
 const policy=new DigitalProductionAccessPolicy(db);
 if((!nativeCreation&&!await policy.lockActiveRole(actor.actorId,'sample_designer'))||!await policy.lockActiveRole(recipientId,'order_merchandiser')
  ||!await policy.allowed(actor,'order',context.orderId,'technical'))return;
 const document=await developmentDocumentRow(db,sourceId);
 if(document?.status!=='published')return;
 const order={id:context.orderId,version:Number(context.order.version),customer:String(context.order.customer_code)};
 const bases=await designElectronicBases(db,sourceId,document,order);
 const scope={sourceId,round:document.round_number,recipientId};
 await recordDesignElectronicHandover(db,actor,scope,bases,handover);
 if(await formalDevelopmentHandoverEnrollment(db,order.id,sourceId)){
  const current=await readDesignElectronicHandover(db,scope,bases,handover,'available');
  const sample=(await designSampleHandoverHistory(db,sourceId,scope.round)).find(row=>row.recipientId===recipientId&&row.documentVersion===document.version)??null;
  await recordFormalDesignHandover(db,actor,order.id,scope,document.version,current,sample);
 }
}
