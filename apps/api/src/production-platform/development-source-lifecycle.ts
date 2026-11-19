import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {BusinessTime} from '@dx-rework/domain/business-clock';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {enrollPreparation} from './preparation-material-repository.js';

type DB=Pick<PoolClient,'query'>;
type Lifecycle={is_draft:boolean;first_event_id:string|null;first_business_time:BusinessTime|null};
const installed=new WeakSet<DB>();

export async function developmentLifecycleAvailable(db:DB){
 if(installed.has(db))return true;
 const available=Boolean((await db.query("SELECT to_regclass('digital_development_source_lifecycle') AS relation")).rows[0]?.relation);
 if(available)installed.add(db);
 return available;
}

export async function developmentSourceLifecycle(db:DB,sourceId:string):Promise<Lifecycle|null>{
 if(!await developmentLifecycleAvailable(db))return null;
 return (await db.query<Lifecycle>('SELECT is_draft,first_event_id,first_business_time FROM digital_development_source_lifecycle WHERE source_id=$1',[sourceId])).rows[0]??null;
}

/** column is an internal SQL reference supplied by the query builder. */
export async function effectiveDevelopmentSourceSql(db:DB,column:string){
 return await developmentLifecycleAvailable(db)
  ?`NOT EXISTS (SELECT 1 FROM digital_development_source_lifecycle lifecycle WHERE lifecycle.source_id=${column} AND lifecycle.is_draft)`
  :'true';
}

/** Caller has locked the original source/document. All writes share the
 * native publication transaction, including application of an approval. */
export async function activateDevelopmentDraft(db:PoolClient,actor:TrustedActorContext,sourceId:string,time:BusinessTime){
 if(!(await developmentSourceLifecycle(db,sourceId))?.is_draft)return null;
 const facts=(await db.query(`SELECT s.created_by,
  EXISTS(SELECT 1 FROM digital_order_time_subjects WHERE source_id=s.source_id AND effective) OR
  EXISTS(SELECT 1 FROM digital_order_time_plan_versions WHERE source_id=s.source_id) OR
  EXISTS(SELECT 1 FROM digital_timeline_adoptions WHERE resource_kind='source' AND source_id=s.source_id) OR
  EXISTS(SELECT 1 FROM digital_development_sla_plans WHERE source_id=s.source_id) OR
  EXISTS(SELECT 1 FROM digital_development_technical_enrollments WHERE source_id=s.source_id) AS previously_adopted
  FROM digital_production_sources s WHERE s.source_id=$1`,[sourceId])).rows[0];
 if(facts.previously_adopted)throw new ApplicationError('DEVELOPMENT_DRAFT_TIMELINE_CONFLICT','原草稿已有生效或冻结的时效记录，请先核对原档案',409);
 const eventId=randomUUID();
 await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state)
  VALUES($1,$2,$3,'digital_development_first_published','digital_production',$4,$5)`,
  [eventId,actor.requestId,actor.actorId,sourceId,JSON.stringify({businessTime:time,createdBy:facts.created_by})]);
 await db.query('INSERT INTO digital_development_first_publications(source_id,event_id,business_time) VALUES($1,$2,$3)',[sourceId,eventId,JSON.stringify(time)]);
 await db.query(`INSERT INTO digital_order_time_subjects(resource_kind,source_id,effective,created_by,created_business_time,creation_event_ref)
  VALUES('source',$1,true,$2,$3,$4) ON CONFLICT(source_id) DO UPDATE SET effective=true`,
  [sourceId,facts.created_by,JSON.stringify(time),'audit_events:'+eventId]);
 await enrollPreparation(db,{kind:'source',id:sourceId},facts.created_by,eventId);
 return {eventId,createdBy:String(facts.created_by)};
}
