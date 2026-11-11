import type {PoolClient} from 'pg';
import type {BusinessTimeScope} from '@dx-rework/domain/business-clock';
import {validateBusinessTime} from '@dx-rework/domain/business-clock';
/** Present only for a real native creation registered by the new command.
 * Neither adoption time nor the database/audit registration clock replaces it. */
export async function orderTimeCreated(db:Pick<PoolClient,'query'>,resource:BusinessTimeScope){
 const row=(await db.query(`SELECT created_business_time,creation_event_ref FROM digital_order_time_subjects WHERE resource_kind=$1 AND ${resource.kind==='source'?'source_id':'production_order_id'}=$2`,[resource.kind,resource.id])).rows[0];
 return row?{at:validateBusinessTime(row.created_business_time).now,evidence:String(row.creation_event_ref)}:null;
}

/** The authorized candidate set uses one bounded native lookup, never a query
 * per order or a saved actor-specific creation date. Legacy candidates do not
 * require this table merely to keep their existing registration metadata. */
export async function orderTimeCreatedMany(db:Pick<PoolClient,'query'>,resources:readonly BusinessTimeScope[]){
 const unique=[...new Map(resources.map(resource=>[resource.kind+':'+resource.id,resource])).values()];
 const result=new Map<string,{at:string;evidence:string}|null>(unique.map(resource=>[resource.kind+':'+resource.id,null]));if(!unique.length)return result;
 const rows=(await db.query(`SELECT s.resource_kind,coalesce(s.source_id,s.production_order_id)::text AS resource_id,s.created_business_time,s.creation_event_ref
  FROM digital_order_time_subjects s JOIN jsonb_to_recordset($1::jsonb) AS requested(kind text,id uuid)
   ON s.resource_kind=requested.kind AND coalesce(s.source_id,s.production_order_id)=requested.id`,[JSON.stringify(unique)])).rows;
 for(const row of rows){const key=row.resource_kind+':'+row.resource_id;try{result.set(key,{at:validateBusinessTime(row.created_business_time).now,evidence:String(row.creation_event_ref)});}catch{result.set(key,null);}}
 return result;
}
