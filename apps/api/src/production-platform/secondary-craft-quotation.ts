import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {DevelopmentDocument} from '@dx-rework/contracts/digital-development';
import {craftStepIdentity} from '@dx-rework/contracts/digital-craft';
import type {InstructionDocument} from '@dx-rework/contracts/production-instruction';
import type {SecondaryCraftQuoteInput,SecondaryCraftDecision,SecondaryCraftDetail,SecondaryCraftList} from '@dx-rework/contracts/secondary-craft-quotation';
import type {QuotationResource} from '@dx-rework/contracts/digital-quotation';
import {acceptanceBusinessContext,acceptanceIncludesNative,businessNow} from '../acceptance-clock/business-time.js';
import {ApplicationError} from '../platform/errors.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy,digitalForbidden,digitalNotFound} from './access-policy.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {assembleQuotation,type AssembledQuotation} from './quotation-assembly.js';
import {secondaryCraftDevelopmentBasis} from './secondary-craft-development-basis.js';
import {lockSecondaryCraftApprover,readSecondaryCraftApprover} from './secondary-craft-approval-authority.js';
import {lockSecondaryCraftSupplier,readSecondaryCraftSupplierOptions} from './secondary-craft-suppliers.js';

const conflict=(message:string):never=>{throw new ApplicationError('SECONDARY_CRAFT_CONFLICT',message,409);};
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Target={rowId:string;label:string;round:number;stage:'development'|'bulk';scopeId:string;sourceVersion:number;
 basis:string;authorId:string|null;role:string;attachmentIds:string[];instructions:string;pricingUnit:string};
type Revision={
 revision_id:string;recorded_at:Date|string;row_id:string;revision:number;round_number:number;stage:Target['stage'];scope_id:string;source_version:number;basis:string;author_id:string;
 submitted:boolean;approver_id:string|null;supplier_id:string|null;supplier_version:number|null;payload:NonNullable<SecondaryCraftDetail['draft']>;
 requirement:{label:string;instructions:string;attachmentIds:string[];pricingUnit:string};
 decision_id:string|null;decision:'approved'|'returned'|null;reason:string|null;decision_actor:string|null;
 supplier_code:string|null;supplier_name:string|null;
};
export type SecondaryCraftApprovalRef={rowId:string;revision:number;decisionId:string;actorId:string};

export async function secondaryCraftReady(db:Pick<PoolClient,'query'>){
 return Boolean((await db.query(`SELECT to_regclass('digital_secondary_craft_quote_revisions') IS NOT NULL
  AND to_regclass('digital_secondary_craft_quote_decisions') IS NOT NULL
  AND to_regclass('digital_quotation_pricing_drafts') IS NOT NULL
  AND to_regclass('digital_quotation_line_reviews') IS NOT NULL
  AND (SELECT count(*)=2 FROM pg_attribute WHERE attrelid=to_regclass('digital_quotation_versions')
    AND attname IN ('secondary_craft_approvals','workbench_pricing') AND NOT attisdropped) AS ready`)).rows[0]?.ready);
}

export function requiredCraftRows(quote:AssembledQuotation){
 return quote.document.rows.filter(row=>quote.assembly
  ?quote.assembly.rows[row.rowId]?.kind==='craft'
  :row.section==='外发工序'&&quote.assignments.some(entry=>entry.rowId===row.rowId&&
   (entry.priceRole==='pattern_room_worker'||entry.priceRole==='embroidery_washing_merchandiser')));
}

export async function hasUnmappedSecondaryCraft(db:Pick<PoolClient,'query'>,quote:AssembledQuotation){
 return !quote.assembly&&hasPublishedSecondaryCraft(db,quote.source_id);
}

export async function hasPublishedSecondaryCraft(db:Pick<PoolClient,'query'>,sourceId:string|null){
 if(!sourceId)return false;
 const source=await developmentDocumentRow(db,sourceId);
 const document=source?.status==='published'?source.document as DevelopmentDocument:null;
 return Boolean(document&&(document.craft&&document.craft!=='无'
  ||document.washing&&document.washing!=='免洗'||document.craftSteps?.length));
}

async function targets(db:Pick<PoolClient,'query'>,quote:AssembledQuotation):Promise<Target[]>{
 const assembly=quote.assembly,sourceId=quote.source_id;
 const rows=requiredCraftRows(quote);
 if(!rows.length)return [];
 if(!assembly){
  const scopeId=sourceId??quote.production_order_id;
  if(!scopeId)return [];
  const source=sourceId?await developmentDocumentRow(db,sourceId):null;
  return rows.map(row=>{
   const assignment=quote.assignments.find(value=>value.rowId===row.rowId)!;
   const stage=sourceId?'development':'bulk',round=source?.round_number??1;
   // The original manual quote row is already an exact work and role identity.
   // The price adopted by this very approval is excluded from its basis.
   const basisRow={...row,unitPrice:undefined};
   return {rowId:row.rowId,label:row.name,round,stage,scopeId,sourceVersion:source?.version??quote.version,
    authorId:assignment.priceAssigneeId,role:assignment.priceRole,attachmentIds:[],instructions:row.specification,
    pricingUnit:row.unit,basis:fingerprint([quote.quote_id,stage,scopeId,round,basisRow,assignment])};
  });
 }
 if(!sourceId)return [];
 const source=await developmentDocumentRow(db,sourceId);
 const document=source?.status==='published'&&(source.round_number??1)===assembly.roundNumber?source.document as DevelopmentDocument:null;
 const orderId=quote.production_order_id;
 const instruction=orderId&&rows.some(row=>assembly.rows[row.rowId]?.stage==='bulk')
  ?(await db.query<{document:InstructionDocument;version:number}>(`SELECT v.document,v.version
    FROM digital_instruction_documents d JOIN digital_instruction_versions v
     ON v.production_order_id=d.production_order_id AND v.version=d.published_version
    WHERE d.production_order_id=$1 AND v.source_round=$2`,[orderId,assembly.roundNumber])).rows[0]:undefined;
 return rows.flatMap<Target>(row=>{
  const ref=assembly.rows[row.rowId]!,assignment=quote.assignments.find(value=>value.rowId===row.rowId);
  const common={rowId:row.rowId,label:row.name,round:assembly.roundNumber,stage:ref.stage,
   authorId:assignment?.priceAssigneeId??null,role:assignment?.priceRole??'',pricingUnit:'件'};
  if(ref.stage==='development'&&source&&document){
   if(ref.sourceRef===`craft:${document.washing}`&&document.washing!=='免洗'){
    return [{...common,scopeId:sourceId,sourceVersion:source.version,attachmentIds:[],instructions:document.washingMethod??'',
     basis:fingerprint([sourceId,assembly.roundNumber,ref.stage,ref.sourceRef,document.washingMethod??document.washingIroning])}];
   }
   const basis=secondaryCraftDevelopmentBasis({sourceId,version:source.version,round:assembly.roundNumber,document},ref);
   return basis?[{...common,scopeId:sourceId,sourceVersion:basis.sourceVersion,basis:basis.fingerprint,
    attachmentIds:basis.requirement?.attachmentIds??[],instructions:[basis.requirement?.part,basis.requirement?.specification,basis.requirement?.instructions].filter(Boolean).join(' ')}]:[];
  }
  if(ref.stage!=='bulk'||!orderId||!instruction||!ref.craftRef?.stepId)return [];
  const step=instruction.document.craftSteps?.find(item=>`craft:bulk:${craftStepIdentity(item)}`===ref.sourceRef);
  if(step?.specialCraft?.id!==ref.craftRef.libraryId||step?.specialCraft?.version!==ref.craftRef.libraryVersion)return [];
  return [{...common,scopeId:orderId,sourceVersion:instruction.version,attachmentIds:[],instructions:instruction.document.process,
   basis:fingerprint([orderId,assembly.roundNumber,ref.stage,ref.sourceRef,ref.craftRef, instruction.document.process])}];
 });
}

const revisionFields=`r.*,d.decision_id,d.decision,d.reason,d.actor_id decision_actor,
  i.supplier_code,s.supplier_name
  FROM digital_secondary_craft_quote_revisions r LEFT JOIN digital_secondary_craft_quote_decisions d
   USING(quote_id,row_id,revision)
  LEFT JOIN supplier_catalog_versions s ON s.supplier_id=r.supplier_id AND s.version=r.supplier_version
  LEFT JOIN supplier_catalog_items i ON i.supplier_id=s.supplier_id`;

async function latest(db:Pick<PoolClient,'query'>,quoteId:string){
 const {rows}=await db.query<Revision>(`SELECT DISTINCT ON (r.row_id) ${revisionFields}
  WHERE r.quote_id=$1 ORDER BY r.row_id,r.revision DESC`,[quoteId]);
 return new Map(rows.map(row=>[row.row_id,row]));
}

const current=(target:Target,row:Revision|undefined):row is Revision=>Boolean(row&&row.basis===target.basis
 &&row.round_number===target.round&&row.stage===target.stage&&row.scope_id===target.scopeId&&row.author_id===target.authorId);

function detailFor(actor:TrustedActorContext,roles:ReadonlySet<string>,approver:boolean,target:Target,row:Revision|undefined):SecondaryCraftDetail|null{
 const maker=target.authorId===actor.actorId&&roles.has(target.role);
 const approvalView=approver&&current(target,row)&&row.submitted&&row.approver_id===actor.actorId;
 if(!maker&&!approvalView)return null;
 const active=current(target,row)?row:null;
 return {target:{rowId:target.rowId,scopeId:target.scopeId,label:target.label,round:target.round,stage:target.stage,sourceVersion:target.sourceVersion,
  instructions:target.instructions,attachmentIds:target.attachmentIds,pricingUnit:target.pricingUnit},version:row?.revision??0,
  state:active?active.decision??(active.submitted?'submitted':'draft'):'pending',note:active?.reason??null,
  supplier:active?.supplier_id&&active.supplier_code&&active.supplier_name
   ?{supplierId:active.supplier_id,code:active.supplier_code,name:active.supplier_name}:null,
  draft:active?.payload??null,canEdit:maker,canDecide:approvalView&&!row?.decision,versions:[],historical:false};
}

export async function secondaryCraftDetail(db:PoolClient,actor:TrustedActorContext,quote:AssembledQuotation,roles:ReadonlySet<string>,rowId:string,
 query:{supplierSearch?:string|undefined;version?:number|undefined}={},designerHistory=false){
 if(!await secondaryCraftReady(db))conflict('联合报价流程尚未就绪');
 const target=(await targets(db,quote)).find(item=>item.rowId===rowId);
 const maker=target?.authorId===actor.actorId&&roles.has(target.role);
 const approver=roles.has('owner_group')&&await readSecondaryCraftApprover(db)===actor.actorId;
 if(!maker&&!approver&&!designerHistory)digitalNotFound();
 if(query.supplierSearch!==undefined){
  if(!maker)digitalForbidden();
  return {items:await readSecondaryCraftSupplierOptions(db,query.supplierSearch)};
 }
 const {rows:history}=await db.query<Revision>(`SELECT ${revisionFields}
  WHERE r.quote_id=$1 AND r.row_id=$2 ORDER BY r.revision DESC`,[quote.quote_id,rowId]);
 const readable=history.filter(row=>maker&&row.author_id===actor.actorId||row.submitted&&(designerHistory||approver&&row.approver_id===actor.actorId));
 const versions=readable.map(row=>row.revision);
 if(query.version===undefined){
  const detail=target?detailFor(actor,roles,approver,target,history[0]):null;
  if(detail)return {...detail,versions};
 }
 const requested=query.version===undefined?readable[0]:readable.find(item=>item.revision===query.version);
 if(!requested)return digitalNotFound();
 return {target:{rowId,scopeId:requested.scope_id,round:requested.round_number,stage:requested.stage,
  sourceVersion:requested.source_version,...requested.requirement},version:requested.revision,
  state:requested.decision??(requested.submitted?'submitted':'draft'),note:requested.reason,draft:requested.payload,
  supplier:requested.supplier_id&&requested.supplier_code&&requested.supplier_name
   ?{supplierId:requested.supplier_id,code:requested.supplier_code,name:requested.supplier_name}:null,
  canEdit:false,canDecide:false,versions,historical:true};
}

type DirectoryQuote=AssembledQuotation&{style_no:string;people:Record<string,string>};

export async function secondaryCraftDirectory(db:Pick<PoolClient,'query'>,actor:TrustedActorContext,roles:ReadonlySet<string>):Promise<SecondaryCraftList>{
 if(!await secondaryCraftReady(db))return {ready:false,items:[]};
 const makerRoles=['pattern_room_worker','embroidery_washing_merchandiser'].filter(role=>roles.has(role));
 const approver=roles.has('owner_group')&&await readSecondaryCraftApprover(db)===actor.actorId;
 if(!makerRoles.length&&!approver)return {ready:true,items:[]};
 const {rows}=await db.query<DirectoryQuote>(`SELECT q.*,coalesce(o.design_style_no,s.design_style_no) style_no,
  (SELECT jsonb_object_agg(u.id,u.display_name) FROM app_users u
   WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(q.assignments) a WHERE a->>'priceAssigneeId'=u.id::text)) people
  FROM digital_quotation_documents q
  LEFT JOIN digital_production_orders o USING(production_order_id)
  LEFT JOIN digital_production_sources s ON s.source_id=q.source_id
  WHERE NOT EXISTS (SELECT 1 FROM digital_production_resource_lifecycle l
   WHERE l.state<>'active' AND ((l.resource_kind='order' AND l.resource_id=q.production_order_id)
    OR (l.resource_kind='source' AND l.resource_id=q.source_id)))
  AND (EXISTS (SELECT 1 FROM jsonb_array_elements(q.assignments) a
    WHERE a->>'priceAssigneeId'=$1::uuid::text AND a->>'priceRole'=ANY($2::text[])
     AND (q.assembly IS NULL OR q.assembly->'rows'->(a->>'rowId')->>'kind'='craft'))
   OR ($3::boolean AND EXISTS (SELECT 1 FROM digital_secondary_craft_quote_revisions r
    WHERE r.quote_id=q.quote_id AND r.approver_id=$1::uuid AND r.submitted
     AND NOT EXISTS (SELECT 1 FROM digital_secondary_craft_quote_revisions n
       WHERE n.quote_id=r.quote_id AND n.row_id=r.row_id AND n.revision>r.revision))))
  ORDER BY q.updated_at DESC,q.quote_id`,[actor.actorId,makerRoles,approver]);
 const items:SecondaryCraftList['items']=[];
 for(const quote of rows){
  const resource:QuotationResource=quote.production_order_id?{kind:'order',id:quote.production_order_id}:{kind:'source',id:quote.source_id!};
  if(!await acceptanceIncludesNative(db,resource.id))continue;
  try{await acceptanceBusinessContext()?.assertScope(resource);}
  catch(error){if(error instanceof ApplicationError&&error.statusCode===404)continue;throw error;}
  const revisions=await latest(db,quote.quote_id);
  for(const target of await targets(db,quote)){
   const revision=revisions.get(target.rowId);
   const item=detailFor(actor,roles,approver,target,revision);
   if(!item)continue;
   items.push({resource,styleNo:quote.style_no,rowId:target.rowId,label:target.label,round:target.round,stage:target.stage,
    sourceVersion:target.sourceVersion,version:item.version,state:item.state,authorName:target.authorId?quote.people?.[target.authorId]??null:null,
    supplier:item.supplier,note:item.note,canDecide:item.canDecide,
    approvalTodoId:item.canDecide?revision?.revision_id??null:null,
    submittedAt:item.canDecide&&revision?new Date(revision.recorded_at).toISOString():null});
  }
 }
 return {ready:true,items};
}

export async function saveSecondaryCraft(db:PoolClient,actor:TrustedActorContext,quote:AssembledQuotation,roles:ReadonlySet<string>,rowId:string,
 input:SecondaryCraftQuoteInput,submit:boolean){
 if(!await secondaryCraftReady(db))conflict('联合报价流程尚未就绪');
 const target=(await targets(db,quote)).find(item=>item.rowId===rowId)??digitalNotFound();
 if(target.authorId!==actor.actorId||!roles.has(target.role))digitalForbidden();
 const row=(await latest(db,quote.quote_id)).get(rowId);
 if(input.expectedVersion!==(row?.revision??0))conflict('工艺报价版本已变，请重新核对');
 if(input.attachmentIds.some(id=>!target.attachmentIds.includes(id)))digitalForbidden();
 const approver=submit?await lockSecondaryCraftApprover(db):null;
 if(submit&&!approver)conflict('审批人待配置');
 const supplier=input.supplierId?await lockSecondaryCraftSupplier(db,input.supplierId):null;
 if(input.supplierId&&!supplier)conflict('请选择当前有效的加工厂');
 const {expectedVersion,...payload}=input;
 const revisionId=randomUUID(),at=businessNow().toISOString();
 await db.query(`INSERT INTO digital_secondary_craft_quote_revisions(quote_id,row_id,revision,round_number,
  stage,scope_id,source_version,basis,author_id,submitted,approver_id,supplier_id,supplier_version,payload,recorded_at,revision_id,requirement)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
 [quote.quote_id,rowId,expectedVersion+1,target.round,target.stage,target.scopeId,target.sourceVersion,target.basis,
  actor.actorId,submit,approver,supplier?.supplierId??null,supplier?.version??null,JSON.stringify(payload),at,revisionId,
  JSON.stringify({label:target.label,instructions:target.instructions,attachmentIds:target.attachmentIds,pricingUnit:target.pricingUnit})]);
 if(approver){
  const eventId=randomUUID();
  await db.query(`INSERT INTO digital_production_notification_events(event_id,source_key,todo_id,event_kind,created_at)
   VALUES($1,$2,$3,'secondary_craft_approval',$4)`,[eventId,`secondary-craft-approval:${revisionId}`,revisionId,at]);
  await db.query(`INSERT INTO digital_production_notification_receipts(event_id,recipient_id,source_event_id)
   VALUES($1,$2,$1)`,[eventId,approver]);
 }
 return expectedVersion+1;
}

export async function decideSecondaryCraft(db:PoolClient,actor:TrustedActorContext,quote:AssembledQuotation,roles:ReadonlySet<string>,rowId:string,input:SecondaryCraftDecision){
 if(!await secondaryCraftReady(db))conflict('联合报价流程尚未就绪');
 if(!roles.has('owner_group')||await lockSecondaryCraftApprover(db)!==actor.actorId)digitalForbidden();
 const target=(await targets(db,quote)).find(item=>item.rowId===rowId)??digitalNotFound();
 const row=(await latest(db,quote.quote_id)).get(rowId);
 if(!current(target,row)||row.revision!==input.expectedVersion||!row.submitted||row.decision||row.approver_id!==actor.actorId)
  return conflict('工艺报价已变或已处理，请重新核对');
 if(!target.authorId||!await new DigitalProductionAccessPolicy(db).lockActiveRole(target.authorId,target.role))conflict('原报价师傅已失权，请重新指派');
 if(input.decision==='approved'&&row.supplier_id&&(await lockSecondaryCraftSupplier(db,row.supplier_id))?.version!==row.supplier_version)
  conflict('加工厂已停用或资料已变，请重新选厂并送审');
 const at=businessNow().toISOString(),decisionId=randomUUID();
 await db.query(`INSERT INTO digital_secondary_craft_quote_decisions(decision_id,quote_id,row_id,revision,actor_id,decision,reason,decided_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[decisionId,quote.quote_id,rowId,row.revision,actor.actorId,input.decision,input.reason??'',at]);
 if(input.decision==='approved'&&row.payload.unit===target.pricingUnit){
  const version=quote.version+1;
  const document={...quote.document,rows:quote.document.rows.map(value=>value.rowId===rowId?{...value,unitPrice:row.payload.unitPrice}:value)};
  const prices={...quote.price_sources,[rowId]:{actorId:row.author_id,role:target.role,version,recordedAt:at,secondaryCraftDecisionId:decisionId}};
  await db.query('UPDATE digital_quotation_documents SET version=$2,document=$3,price_sources=$4,updated_by=$5,updated_at=$6 WHERE quote_id=$1',
   [quote.quote_id,version,JSON.stringify(document),JSON.stringify(prices),actor.actorId,at]);
  if(quote.source_id)await assembleQuotation(db,quote.source_id,actor.actorId,version);
 }
 return row.revision;
}

export async function approvedSecondaryCraftRows(db:Pick<PoolClient,'query'>,quote:AssembledQuotation,lock:boolean){
 const required=requiredCraftRows(quote);
 const confirmed=new Map<string,SecondaryCraftApprovalRef>();
 if(!required.length)return {required,confirmed};
 const selected=await targets(db,quote),rows=await latest(db,quote.quote_id);
 const approver=lock?await lockSecondaryCraftApprover(db):await readSecondaryCraftApprover(db);
 if(!approver)return {required,confirmed};
 const access=new DigitalProductionAccessPolicy(db);
 for(const target of selected.sort((a,b)=>a.rowId.localeCompare(b.rowId))){
  const row=rows.get(target.rowId);
  if(!current(target,row)||!row.submitted||row.decision!=='approved'||row.decision_actor!==approver||!row.decision_id||
   row.payload.unit!==target.pricingUnit||quote.price_sources[target.rowId]?.secondaryCraftDecisionId!==row.decision_id||
   required.find(value=>value.rowId===target.rowId)?.unitPrice!==row.payload.unitPrice||!target.authorId)continue;
  if(!await (lock?access.lockActiveRole(target.authorId,target.role):access.activeRole(target.authorId,target.role)))continue;
  if(row.supplier_id){
   const supplier=lock?await lockSecondaryCraftSupplier(db,row.supplier_id):(await db.query(
    "SELECT version FROM current_supplier_catalog WHERE supplier_id=$1 AND supplier_type='factory' AND active=true",[row.supplier_id])).rows[0];
   if(supplier?.version!==row.supplier_version)continue;
  }
  confirmed.set(target.rowId,{rowId:target.rowId,revision:row.revision,decisionId:row.decision_id,actorId:approver});
 }
 return {required,confirmed};
}
