import type {Pool,PoolClient} from 'pg';
import type {BusinessTime,BusinessTimeScope} from '@dx-rework/domain/business-clock';
import {assertBusinessClockUnchanged,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {reuseJourneySnapshotReads} from './journey-snapshot-reads.js';
import {DigitalJourneyQuery} from './journey-query.js';
import {JOURNEY_FACT_CALCULATION_VERSION,journeyFactFingerprint,type JourneyFactModel} from './journey-fact-model.js';

type Row={source_version:string;applied_source_version:string|null;calculation_version:string|null;source_fingerprint:string|null;payload:JourneyFactModel|null;clock_scenario_id:string|null;clock_revision:string;observed_at:Date|null};
export class JourneyFactBusy extends Error{constructor(){super('Journey fact construction is already running');}}
type Built={resource:BusinessTimeScope;sourceVersion:string;sourceFingerprint:string;model:JourneyFactModel;retired:false};
type Retired={resource:BusinessTimeScope;retired:true};
export type JourneyStoredFact={sourceVersion:string;appliedSourceVersion:string|null;status:'missing'|'pending'|'obsolete'|'ready';model:JourneyFactModel|null};
/** Server-internal facts; no route, implicit GET backfill, actor impersonation
 * or cross-user authorization result. Native invalidations commit with business data. */
export class JourneyFactRepository{
 constructor(private readonly database:Pool){}
 async buildOne(resource:BusinessTimeScope):Promise<Built>;
 async buildOne(resource:BusinessTimeScope,options:{retireMissing:true}):Promise<Built|Retired>;
 async buildOne(resource:BusinessTimeScope,options?:{retireMissing:true}):Promise<Built|Retired>{
  const client=await this.database.connect(),db=reuseJourneySnapshotReads(client);
  let result:Built,observed:BusinessTime,timedOut=false;
  // Terminating this owned connection bounds even a hung build, rolls its own
  // transaction back and releases its advisory lock. No other request is cancelled.
  const timer=setTimeout(()=>{timedOut=true;client.release(true);},100_000);timer.unref();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
   await db.query("SET LOCAL statement_timeout='90s'");
   await db.query("SET LOCAL idle_in_transaction_session_timeout='100s'");
   const locked=(await db.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) AS locked',['journey-fact:'+resource.kind,resource.id])).rows[0]!.locked;
   if(!locked)throw new JourneyFactBusy();
   // No sequence watermark: transactions allocated earlier can commit later.
   // Acknowledge only the exact dirty transactions visible in this snapshot.
   const pending=(await db.query<{transaction_id:string}>('SELECT transaction_id FROM digital_journey_fact_changes WHERE resource_kind=$1 AND resource_id=$2',[resource.kind,resource.id])).rows.map(r=>r.transaction_id);
   if(options?.retireMissing){
    const exists=resource.kind==='order'
     ?(await db.query('SELECT 1 FROM digital_production_orders WHERE production_order_id=$1',[resource.id])).rowCount
     :(await db.query('SELECT 1 FROM digital_production_sources s WHERE s.source_id=$1 AND NOT EXISTS(SELECT 1 FROM digital_production_orders o WHERE o.source_id=s.source_id)',[resource.id])).rowCount;
    if(!exists){await db.query('DELETE FROM digital_journey_fact_models WHERE resource_kind=$1 AND resource_id=$2',[resource.kind,resource.id]);
     await db.query('DELETE FROM digital_journey_fact_changes WHERE resource_kind=$1 AND resource_id=$2 AND transaction_id=ANY($3::bigint[])',[resource.kind,resource.id,pending]);
     await db.query('DELETE FROM digital_journey_fact_retries WHERE resource_kind=$1 AND resource_id=$2',[resource.kind,resource.id]);
     await db.query('COMMIT');return {resource,retired:true};}
   }
   const time=await new ContextBusinessClock(this.database,db).read(resource);observed=time;
   // Establish the exact resource identity before creating a derived row.
   const model=await new DigitalJourneyQuery(this.database).buildFactsWithClient(db,resource,time.now);
   await db.query(`INSERT INTO digital_journey_fact_models(resource_kind,resource_id,source_id,production_order_id)
    VALUES($1,$2,$3,$4) ON CONFLICT(resource_kind,resource_id) DO NOTHING`,[resource.kind,resource.id,model.sourceId,model.orderId]);
   const row=(await db.query<Row>('SELECT * FROM digital_journey_fact_models WHERE resource_kind=$1 AND resource_id=$2 FOR UPDATE',[resource.kind,resource.id])).rows[0]!;
   const sourceFingerprint=journeyFactFingerprint(model);
   const version=BigInt(row.source_version)+(row.applied_source_version!==null&&pending.length?1n:0n);
   await db.query(`UPDATE digital_journey_fact_models SET source_id=$3,production_order_id=$4,source_version=$12,applied_source_version=$12,
    calculation_version=$5,source_fingerprint=$6,payload=$7,clock_scenario_id=$8,clock_revision=$9,observed_at=$10,built_at=CURRENT_TIMESTAMP
    WHERE resource_kind=$1 AND resource_id=$2 AND source_version=$11`,[resource.kind,resource.id,model.sourceId,model.orderId,JOURNEY_FACT_CALCULATION_VERSION,sourceFingerprint,JSON.stringify(model),time.scenarioId,time.revision,time.now,row.source_version,version.toString()]);
   await assertBusinessClockUnchanged(new ContextBusinessClock(this.database,db),resource,time);
   await db.query('DELETE FROM digital_journey_fact_changes WHERE resource_kind=$1 AND resource_id=$2 AND transaction_id=ANY($3::bigint[])',[resource.kind,resource.id,pending]);
   await db.query('DELETE FROM digital_journey_fact_retries WHERE resource_kind=$1 AND resource_id=$2',[resource.kind,resource.id]);
   await db.query('COMMIT');
   result={resource,sourceVersion:version.toString(),sourceFingerprint,model,retired:false};
  }catch(error){if(!timedOut)await db.query('ROLLBACK');throw error;}finally{clearTimeout(timer);if(!timedOut)client.release();}
  // A repeatable-read transaction cannot observe an externally committed clock
  // change. Recheck after release as the existing Journey read does. A stored
  // older clock revision is also rejected independently by readStoredWithClient.
  await assertBusinessClockUnchanged(new ContextBusinessClock(this.database),resource,observed);
  return result;
 }
 /** Internal status only; a future authorized reader must check current scope,
  * clock and time-sensitive rules again. Pending/obsolete never returns old facts.
  */
  async readStoredWithClient(db:PoolClient,resource:BusinessTimeScope):Promise<JourneyStoredFact>{
  const row=(await db.query<Row&{pending:boolean}>(`SELECT m.*,EXISTS(SELECT 1 FROM digital_journey_fact_changes c
   WHERE c.resource_kind=m.resource_kind AND c.resource_id=m.resource_id) AS pending
   FROM digital_journey_fact_models m WHERE resource_kind=$1 AND resource_id=$2`,[resource.kind,resource.id])).rows[0];
  if(!row)return {sourceVersion:'0',appliedSourceVersion:null,status:'missing',model:null};
  const time=await new ContextBusinessClock(this.database,db).read(resource);
  const status=row.pending||row.source_version!==row.applied_source_version||!row.payload||row.clock_scenario_id!==time.scenarioId||row.clock_revision!==String(time.revision)?'pending':row.calculation_version!==JOURNEY_FACT_CALCULATION_VERSION?'obsolete':'ready';
  if(status==='ready'&&journeyFactFingerprint(row.payload!)!==row.source_fingerprint)throw new Error('Journey fact payload fingerprint mismatch');
  return {sourceVersion:row.source_version,appliedSourceVersion:row.applied_source_version,status,model:status==='ready'?row.payload:null};
 }
}
