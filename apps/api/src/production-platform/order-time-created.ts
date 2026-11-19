import {developmentLifecycleAvailable,developmentSourceLifecycle} from './development-source-lifecycle.js';
import type {PoolClient} from 'pg';
import type {BusinessTimeScope} from '@dx-rework/domain/business-clock';
import {validateBusinessTime} from '@dx-rework/domain/business-clock';
/** Present only for a real native creation registered by the new command.
 * Neither adoption time nor the database/audit registration clock replaces it. */
export async function orderTimeCreated(db:Pick<PoolClient,'query'>,resource:BusinessTimeScope){
 const lifecycle=resource.kind==='source'?await developmentSourceLifecycle(db,resource.id):null;
 if(lifecycle?.is_draft)return null;
 if(lifecycle?.first_event_id&&lifecycle.first_business_time)return {at:validateBusinessTime(lifecycle.first_business_time).now,evidence:'audit_events:'+lifecycle.first_event_id};
 const row=(await db.query(`SELECT created_business_time,creation_event_ref FROM digital_order_time_subjects WHERE resource_kind=$1 AND ${resource.kind==='source'?'source_id':'production_order_id'}=$2`,[resource.kind,resource.id])).rows[0];
 return row?{at:validateBusinessTime(row.created_business_time).now,evidence:String(row.creation_event_ref)}:null;
}

/** The authorized candidate set uses one bounded native lookup, never a query
 * per order or a saved actor-specific creation date. Legacy candidates do not
 * require this table merely to keep their existing registration metadata. */
export async function orderTimeCreatedMany(db:Pick<PoolClient,'query'>,resources:readonly BusinessTimeScope[]){
 const unique=[...new Map(resources.map(resource=>[resource.kind+':'+resource.id,resource])).values()];
 const result=new Map<string,{at:string;evidence:string}|{at:null;legacy:true}|null>(unique.map(resource=>[resource.kind+':'+resource.id,null]));if(!unique.length)return result;
 const lifecycle=unique.some(resource=>resource.kind==='source')&&await developmentLifecycleAvailable(db);
 const rows=(await db.query(`SELECT requested.kind AS resource_kind,requested.id::text AS resource_id,${lifecycle?"coalesce(l.first_business_time,s.created_business_time) AS created_business_time,coalesce('audit_events:'||l.first_event_id::text,s.creation_event_ref) AS creation_event_ref":"s.created_business_time,s.creation_event_ref"},
  s.resource_kind IS NULL AND EXISTS(
   SELECT 1 FROM digital_order_time_plan_versions p JOIN audit_events event ON event.id=CASE
    WHEN p.source_event_ref~'^audit_events:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN substring(p.source_event_ref FROM 14)::uuid END
   WHERE p.resource_kind=requested.kind AND p.revision=1
    AND (requested.kind='source' AND p.source_id=requested.id OR requested.kind='order' AND p.production_order_id=requested.id)
    AND event.action='order_time_arranged' AND event.entity_id=requested.id::text) AS legacy_adopted
  FROM jsonb_to_recordset($1::jsonb) AS requested(kind text,id uuid) LEFT JOIN digital_order_time_subjects s
   ON s.resource_kind=requested.kind AND coalesce(s.source_id,s.production_order_id)=requested.id
  ${lifecycle?"LEFT JOIN digital_development_source_lifecycle l ON requested.kind='source' AND l.source_id=requested.id WHERE l.is_draft IS DISTINCT FROM true":""}`,[JSON.stringify(unique)])).rows;
 for(const row of rows){const key=row.resource_kind+':'+row.resource_id;if(row.legacy_adopted===true){result.set(key,{at:null,legacy:true});continue;}try{result.set(key,{at:validateBusinessTime(row.created_business_time).now,evidence:String(row.creation_event_ref)});}catch{result.set(key,null);}}
 return result;
}

/** Original legacy creators also recorded a business-clock occurrence in their
 * audit event. Registration time is the fallback only for older native roots
 * whose creation did not store a business clock. The alias is internal SQL. */
export const cockpitLegacyOrderTimeSql=(order:'o')=>`coalesce((
 SELECT origin.after_state->'slaBusinessTime'->>'now' FROM audit_events origin
 WHERE origin.entity_type='digital_production' AND origin.action='digital_order_created'
  AND origin.entity_id=${order}.production_order_id::text
 ORDER BY origin.created_at,origin.id LIMIT 1),${order}.created_at::text)`;
