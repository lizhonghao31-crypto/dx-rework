import type {Pool,PoolClient} from 'pg';
import type {MiscAssociation,MiscAssociationSnapshot} from '@dx-rework/contracts/pattern-orders';
import type {TrustedActorContext} from '../tools/repositories.js';
import {isRootActor} from '../access/business-authority.js';
import {DigitalProductionAccessPolicy,isDigitalLeader,isDigitalTechnicalManager} from '../production-platform/access-policy.js';
import {ApplicationError} from '../platform/errors.js';
const invalid=():never=>{throw new ApplicationError('VALIDATION_ERROR','请选择当前有权限的已有开发档案或PO；资料可能已变化，请重新查询',400);};
type DB=Pick<Pool|PoolClient,'query'>;
const sourceLabel=(row:{style_no:string;customer:string|null})=>`${row.style_no} · ${row.customer??'通用开发'} · 开发档案`;
const poLabel=(row:{style_no:string;customer:string|null;po_number:string|null;color:string})=>`${row.style_no} / ${row.po_number??'PO未登记'} · ${row.color} · ${row.customer??'客户未登记'}`;
export async function listMiscAssociations(db:DB,actor:TrustedActorContext,search:string):Promise<MiscAssociationSnapshot[]>{
 const broad=isDigitalLeader(actor)||isDigitalTechnicalManager(actor),designer=actor.actorRoles.includes('sample_designer'),merch=actor.actorRoles.includes('order_merchandiser');
 // This endpoint is admitted only by the original misc-create authority. Restrict
 // before LIMIT, then use the same resource policy again when committing a choice.
 const rows=(await db.query(`WITH candidates AS (
  SELECT 'source' AS kind,s.source_id AS id,s.design_style_no AS style_no,s.customer_code AS customer,NULL::text AS po_number,NULL::text AS color,s.created_at,concat_ws(' ',s.design_style_no,s.temporary_style_no,s.customer_code) AS search_terms
  FROM digital_production_sources s WHERE ($2 OR $3 AND s.created_by=$1 OR $4 AND EXISTS(SELECT 1 FROM digital_production_orders o WHERE o.source_id=s.source_id AND o.primary_merchandiser_id=$1))
  UNION ALL
  SELECT 'po',po.line_id,coalesce(po.formal_style_no,po.temporary_style_no,o.design_style_no),o.customer_code,po.po_number,po.color,o.created_at,concat_ws(' ',o.design_style_no,o.temporary_style_no,o.customer_code,po.formal_style_no,po.temporary_style_no,po.po_number,po.color)
  FROM digital_production_po_lines po JOIN digital_production_orders o USING(production_order_id)
  WHERE ($2 OR $3 AND o.created_by=$1 OR $4 AND o.primary_merchandiser_id=$1)
 ) SELECT * FROM candidates WHERE $5='' OR strpos(lower(search_terms),lower($5))>0
 ORDER BY created_at DESC,kind,id LIMIT 30`,[actor.actorId,broad,designer,merch,search])).rows;
 return rows.map(row=>({kind:row.kind,id:row.id,styleNo:row.style_no,label:row.kind==='source'?sourceLabel(row):poLabel(row)}));
}
export async function resolveMiscAssociation(db:DB,actor:TrustedActorContext,input:{styleNo:string;association?:MiscAssociation|null|undefined},existing?:{style_no:string;misc_association?:MiscAssociationSnapshot|null}):Promise<MiscAssociationSnapshot|null>{
 if(input.association===undefined&&existing){
  if(input.styleNo!==existing.style_no)invalid();
  if(!existing.misc_association)return null; // Keep unchanged historical text; never infer an ID.
  return resolveMiscAssociation(db,actor,{styleNo:input.styleNo,association:existing.misc_association},existing);
 }
 const association=input.association;
 if(!association){if(input.styleNo)invalid();return null;}
 const policy=new DigitalProductionAccessPolicy(db);
 // Keep the effective authority snapshot current until commit, including broad
 // management and any task-participation role used by the original read policy.
 if(!isRootActor(actor))for(const role of [...new Set(actor.actorRoles)].sort())if(!await policy.lockActiveRole(actor.actorId,role))invalid();
 const previous=existing?.misc_association;
 const samePersistedChoice=previous?.kind===association.kind&&previous.id===association.id&&input.styleNo===existing?.style_no;
 const displayMatches=(styleNo:string)=>input.styleNo===styleNo||samePersistedChoice;
 if(association.kind==='source'){
  const row=(await db.query("SELECT source_id,design_style_no AS style_no,customer_code AS customer FROM digital_production_sources WHERE source_id=$1 FOR SHARE",[association.id])).rows[0];
  if(!row||!await policy.allowed(actor,'source',association.id,'technical')||!displayMatches(row.style_no))invalid();
  return {...association,styleNo:row.style_no,label:sourceLabel(row)};
 }
 const row=(await db.query("SELECT po.production_order_id,coalesce(po.formal_style_no,po.temporary_style_no,o.design_style_no) AS style_no,o.customer_code AS customer,po.po_number,po.color FROM digital_production_po_lines po JOIN digital_production_orders o USING(production_order_id) WHERE po.line_id=$1 FOR SHARE OF po,o",[association.id])).rows[0];
 if(!row||!await policy.allowed(actor,'order',row.production_order_id,'technical')||!displayMatches(row.style_no))invalid();
 return {...association,styleNo:row.style_no,label:poLabel(row)};
}
