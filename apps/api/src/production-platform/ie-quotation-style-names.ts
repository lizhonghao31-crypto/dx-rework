import type {PoolClient} from 'pg';
import {developmentReadTables} from './development-amendment-repository.js';
import {developmentRoundsAvailable} from './development-round-repository.js';

type IeStyleTarget={kind:'processing_quote'|'sourcing_review'|'rework_review';resourceId:string;quoteId?:string;
 order:boolean;round:number|null};

/** The caller has already authorized and selected this page or exact detail.
 * Follow durable identities only and expose only the original creation name. */
export async function readIeQuotationStyleNames(db:Pick<PoolClient,'query'>,targets:readonly IeStyleTarget[]){
 if(!targets.length)return [];
 const tables=await developmentReadTables(db);
 const rounds=await developmentRoundsAvailable(db);
 const {rows}=await db.query<{name:string|null}>(`WITH authorized AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(position int,kind text,"resourceId" uuid,"quoteId" uuid,"order" boolean,round int)
 ), linked AS (
  SELECT a.position,a.round,CASE WHEN a.kind='processing_quote' AND NOT a."order" THEN q.source_id
   WHEN a.kind<>'processing_quote' OR q.source_id=mother.source_id THEN mother.source_id END AS source_id
  FROM authorized a
  LEFT JOIN digital_quotation_documents q ON a.kind='processing_quote' AND q.quote_id=a."quoteId"
    AND CASE WHEN a."order" THEN q.production_order_id=a."resourceId" ELSE q.source_id=a."resourceId" AND q.production_order_id IS NULL END
  LEFT JOIN digital_production_child_links child ON child.child_id=a."resourceId"
    AND child.module=CASE a.kind WHEN 'sourcing_review' THEN 'sourcing' WHEN 'rework_review' THEN 'rework' END
  LEFT JOIN digital_production_orders mother ON mother.production_order_id=coalesce(q.production_order_id,child.production_order_id)
 ) SELECT nullif(btrim((${rounds?`CASE WHEN x.round>1 AND chosen.round_number IS NULL THEN NULL
    WHEN chosen.round_number>1 THEN chosen.document ELSE d.document END`:`CASE WHEN x.round>1 THEN NULL ELSE d.document END`})
    ->'workbenchSheet'->>'styleName'),'') AS name
 FROM linked x LEFT JOIN ${tables.documents} d ON d.source_id=x.source_id
 ${rounds?`LEFT JOIN LATERAL (
  SELECT r.round_number,r.document FROM ${tables.rounds} r WHERE r.source_id=x.source_id
   AND (x.round IS NULL OR r.round_number=x.round) ORDER BY r.round_number DESC LIMIT 1
 ) chosen ON x.round IS DISTINCT FROM 1`:''}
 ORDER BY x.position`,[JSON.stringify(targets.map((target,position)=>({...target,position})))]);
 return rows.map(row=>row.name);
}
