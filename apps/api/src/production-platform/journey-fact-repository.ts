import type {Pool,PoolClient} from 'pg';
import type {BusinessTime,BusinessTimeScope} from '@dx-rework/domain/business-clock';
import {assertBusinessClockUnchanged,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {reuseJourneySnapshotReads} from './journey-snapshot-reads.js';
import {DigitalJourneyQuery} from './journey-query.js';
import {JOURNEY_FACT_CALCULATION_VERSION,journeyFactFingerprint,type JourneyFactModel} from './journey-fact-model.js';

type Row={source_version:string;applied_source_version:string|null;calculation_version:string|null;source_fingerprint:string|null;payload:JourneyFactModel|null;clock_scenario_id:string|null;clock_revision:string;observed_at:Date|null};
export type JourneyStoredFact={sourceVersion:string;appliedSourceVersion:string|null;status:'missing'|'pending'|'obsolete'|'ready';model:JourneyFactModel|null};
/** Server-internal foundation. No route, implicit GET backfill, background task,
 * actor impersonation or cross-user result is introduced in PERF01.
 */
export class JourneyFactRepository{
 constructor(private readonly database:Pool){}
 async buildOne(resource:BusinessTimeScope){
  const client=await this.database.connect(),db=reuseJourneySnapshotReads(client);
  let result:{resource:BusinessTimeScope;sourceVersion:string;sourceFingerprint:string;model:JourneyFactModel},observed:BusinessTime;
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
   const time=await new ContextBusinessClock(this.database,db).read(resource);observed=time;
   // Establish the exact resource identity before creating a derived row.
   const model=await new DigitalJourneyQuery(this.database).buildFactsWithClient(db,resource,time.now);
   await db.query(`INSERT INTO digital_journey_fact_models(resource_kind,resource_id,source_id,production_order_id)
    VALUES($1,$2,$3,$4) ON CONFLICT(resource_kind,resource_id) DO NOTHING`,[resource.kind,resource.id,model.sourceId,model.orderId]);
   const row=(await db.query<Row>('SELECT * FROM digital_journey_fact_models WHERE resource_kind=$1 AND resource_id=$2 FOR UPDATE',[resource.kind,resource.id])).rows[0]!;
   const sourceFingerprint=journeyFactFingerprint(model);
   await db.query(`UPDATE digital_journey_fact_models SET source_id=$3,production_order_id=$4,applied_source_version=source_version,
    calculation_version=$5,source_fingerprint=$6,payload=$7,clock_scenario_id=$8,clock_revision=$9,observed_at=$10,built_at=CURRENT_TIMESTAMP
    WHERE resource_kind=$1 AND resource_id=$2 AND source_version=$11`,[resource.kind,resource.id,model.sourceId,model.orderId,JOURNEY_FACT_CALCULATION_VERSION,sourceFingerprint,JSON.stringify(model),time.scenarioId,time.revision,time.now,row.source_version]);
   await assertBusinessClockUnchanged(new ContextBusinessClock(this.database,db),resource,time);
   await db.query('COMMIT');
   result={resource,sourceVersion:row.source_version,sourceFingerprint,model};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{client.release();}
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
  const row=(await db.query<Row>('SELECT * FROM digital_journey_fact_models WHERE resource_kind=$1 AND resource_id=$2',[resource.kind,resource.id])).rows[0];
  if(!row)return {sourceVersion:'0',appliedSourceVersion:null,status:'missing',model:null};
  const time=await new ContextBusinessClock(this.database,db).read(resource);
  const status=row.source_version!==row.applied_source_version||!row.payload||row.clock_scenario_id!==time.scenarioId||row.clock_revision!==String(time.revision)?'pending':row.calculation_version!==JOURNEY_FACT_CALCULATION_VERSION?'obsolete':'ready';
  if(status==='ready'&&journeyFactFingerprint(row.payload!)!==row.source_fingerprint)throw new Error('Journey fact payload fingerprint mismatch');
  return {sourceVersion:row.source_version,appliedSourceVersion:row.applied_source_version,status,model:status==='ready'?row.payload:null};
 }
}
