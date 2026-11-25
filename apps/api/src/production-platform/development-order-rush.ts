import type {PoolClient} from 'pg';
import {effectiveDevelopmentSourceSql} from './development-source-lifecycle.js';

type DB=Pick<PoolClient,'query'>;
export type RushIdentity={sourceId:string|null;orderId:string|null};

export function developmentRushKey({sourceId,orderId}:RushIdentity){
 return orderId?`order:${orderId}`:sourceId?`source:${sourceId}`:null;
}

/** Caller supplies only the identities already authorized in this snapshot.
 * Do not bridge by style, PO, draft payload, assignment priority or an SLA
 * request. A formal order inherits only from its real source FK. */
export async function readDevelopmentOrderRush(db:DB,authorized:readonly RushIdentity[]){
 const orders=[...new Set(authorized.flatMap(row=>row.orderId?[row.orderId]:[]))];
 const sources=[...new Set(authorized.flatMap(row=>!row.orderId&&row.sourceId?[row.sourceId]:[]))];
 if(!orders.length&&!sources.length)return new Set<string>();
 const relations=(await db.query<{development:string|null;preorders:string|null;current_round:string|null;amended_round:string|null}>(`SELECT
  to_regclass('digital_development_documents')::text AS development,
  to_regclass('digital_development_preorder_publications')::text AS preorders,
  to_regclass('digital_development_current_documents')::text AS current_round,
  to_regclass('digital_development_amended_current_documents')::text AS amended_round`)).rows[0];
 if(!relations?.development)return new Set<string>();
 const effective=await effectiveDevelopmentSourceSql(db,'requested.source_id');
 const frozen=relations.preorders?"pre.document->'rush'":"NULL::jsonb";
 const versionView=relations.amended_round?'digital_development_amended_current_documents'
  :relations.current_round?'digital_development_current_documents':null;
 // The current published immutable revision may record a legal correction.
 // Older inputs without the new field still inherit their original choice.
 const published=versionView?"COALESCE(current_version.document->'rush',d.document->'rush')":"d.document->'rush'";
 const {rows}=await db.query<{kind:'order'|'source';id:string}>(`WITH requested AS (
  SELECT 'source'::text AS kind,id,id AS source_id FROM unnest($1::uuid[]) selected(id)
  UNION ALL
  SELECT 'order',o.production_order_id,o.source_id FROM digital_production_orders o
   WHERE o.production_order_id=ANY($2::uuid[]) AND o.source_id IS NOT NULL
 )
 SELECT requested.kind,requested.id FROM requested
 LEFT JOIN digital_development_documents d USING(source_id)
 ${versionView?`LEFT JOIN ${versionView} current_version USING(source_id)`:''}
 ${relations.preorders?'LEFT JOIN digital_development_preorder_publications pre USING(source_id)':''}
 WHERE ${effective}
 AND COALESCE(CASE WHEN d.status='published' THEN ${published} END,${frozen})='true'::jsonb`,[sources,orders]);
 return new Set(rows.map(row=>`${row.kind}:${row.id}`));
}

/** Page enrichment only: preserve the exact authorized selection and order. */
export async function projectDevelopmentOrderRush<T extends RushIdentity>(db:DB,authorized:readonly T[]){
 const rush=await readDevelopmentOrderRush(db,authorized);
 return authorized.map(item=>rush.has(developmentRushKey(item)??'')?{...item,orderRush:true as const}:item);
}

/** Quote directories expose the authorized native resource rather than both IDs. */
export async function projectDevelopmentRushResources<T extends {resource:{kind:'source'|'order';id:string}}>(db:DB,authorized:readonly T[]):Promise<Array<T & {orderRush?:true}>>{
 const rush=await readDevelopmentOrderRush(db,authorized.map(({resource})=>({
  sourceId:resource.kind==='source'?resource.id:null,orderId:resource.kind==='order'?resource.id:null,
 })));
 return authorized.map(item=>rush.has(`${item.resource.kind}:${item.resource.id}`)?{...item,orderRush:true as const}:item);
}

/** Reorder only within existing positions for the very same actionable kind.
 * Unrelated task types, waiting rows and relative order otherwise stay put. */
export function prioritizeWithinRushGroups<T>(items:readonly T[],group:(item:T)=>string|null,rush:(item:T)=>boolean):T[]{
 const groups=new Map<string,{indices:number[];urgent:T[];normal:T[]}>();
 items.forEach((item,index)=>{
  const key=group(item);if(!key)return;
  const choices=groups.get(key)??{indices:[],urgent:[],normal:[]};
  choices.indices.push(index);(rush(item)?choices.urgent:choices.normal).push(item);groups.set(key,choices);
 });
 const sorted=[...items];
 for(const {indices,urgent,normal} of groups.values()){
  const ordered=[...urgent,...normal];indices.forEach((index,position)=>{sorted[index]=ordered[position]!;});
 }
 return sorted;
}
