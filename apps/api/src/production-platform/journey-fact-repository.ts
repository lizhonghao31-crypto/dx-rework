import {effectiveDevelopmentSourceSql} from './development-source-lifecycle.js';
import {wholeOrderActiveSql} from './whole-order-visibility.js';
import {buildFixedReworkTargets} from './fixed-rework-progress.js';
import type {Pool,PoolClient} from 'pg';
import type {BusinessTime,BusinessTimeScope} from '@dx-rework/domain/business-clock';
import {assertBusinessClockUnchanged,businessScopeKey,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {reuseJourneySnapshotReads} from './journey-snapshot-reads.js';
import {DigitalJourneyQuery} from './journey-query.js';
import {JOURNEY_FACT_CALCULATION_VERSION,journeyFactFingerprint,journeyValueFingerprint,type JourneyFactModel} from './journey-fact-model.js';
import {journeyFactGenerationEnabled} from './journey-fact-generation.js';
import type {JourneySelectionFacts} from './journey-selection-facts.js';
import {FixedTimelineAdoptionRepository} from './fixed-timeline-adoptions.js';
import {styleLabelModelVersionSql} from './style-label-model-compatibility.js';

type Row={source_version:string;applied_source_version:string|null;calculation_version:string|null;source_fingerprint:string|null;payload:JourneyFactModel|null;clock_scenario_id:string|null;clock_revision:string;observed_at:Date|null};
export class JourneyFactBusy extends Error{constructor(){super('Journey fact construction is already running');}}
type Built={resource:BusinessTimeScope;sourceVersion:string;sourceFingerprint:string;model:JourneyFactModel;retired:false};
type Retired={resource:BusinessTimeScope;retired:true};
export type JourneyStoredFact={sourceVersion:string;appliedSourceVersion:string|null;status:'missing'|'pending'|'obsolete'|'ready';model:JourneyFactModel|null};
export type JourneyStoredSelection={sourceVersion:string;appliedSourceVersion:string|null;status:JourneyStoredFact['status']|'failed';facts:JourneySelectionFacts|null};
/** Server-internal facts; no route, implicit GET backfill, actor impersonation
 * or cross-user authorization result. Native invalidations commit with business data. */
export class JourneyFactRepository{
 constructor(private readonly database:Pool){}
 async buildOne(resource:BusinessTimeScope):Promise<Built>;
 async buildOne(resource:BusinessTimeScope,options:{retireMissing:true}):Promise<Built|Retired>;
 async buildOne(resource:BusinessTimeScope,options?:{retireMissing:true}):Promise<Built|Retired>{
  if(!journeyFactGenerationEnabled())throw Error('JOURNEY_DERIVATION_READ_ONLY_COMPATIBLE');
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
   let pending=(await db.query<{transaction_id:string}>('SELECT transaction_id FROM digital_journey_fact_changes WHERE resource_kind=$1 AND resource_id=$2',[resource.kind,resource.id])).rows.map(r=>r.transaction_id);
   if(options?.retireMissing){
    const exists=resource.kind==='order'
     ?(await db.query(`SELECT 1 FROM digital_production_orders WHERE production_order_id=$1 AND ${await wholeOrderActiveSql(db,'order','production_order_id')}`,[resource.id])).rowCount
     :(await db.query(`SELECT 1 FROM digital_production_sources s WHERE s.source_id=$1 AND ${await effectiveDevelopmentSourceSql(db,'s.source_id')} AND ${await wholeOrderActiveSql(db,'source','s.source_id')} AND NOT EXISTS(SELECT 1 FROM digital_production_orders o WHERE o.source_id=s.source_id)`,[resource.id])).rowCount;
    if(!exists){await db.query('DELETE FROM digital_journey_fact_models WHERE resource_kind=$1 AND resource_id=$2',[resource.kind,resource.id]);
     await db.query('DELETE FROM digital_journey_fact_changes WHERE resource_kind=$1 AND resource_id=$2 AND transaction_id=ANY($3::bigint[])',[resource.kind,resource.id,pending]);
     await db.query('DELETE FROM digital_journey_fact_retries WHERE resource_kind=$1 AND resource_id=$2',[resource.kind,resource.id]);
     await db.query('COMMIT');return {resource,retired:true};}
   }
   // Derive fixed targets only in the existing bounded object's write worker,
   // from its immutable original inputs. A target failure keeps this object's
   // dirty entry/retry; it cannot roll back the already committed business action.
   // Use the same original client and RR transaction, before capturing the dirty
   // transaction set, so these derived writes do not cause a second rebuild.
   // Derived writes must use the same proxy as reads: their native dirty
   // triggers invalidate cached reads before the second pending-set capture.
   const timelines=new FixedTimelineAdoptionRepository(db),adoption=await timelines.existing(resource);
   if(adoption){
    const buildTargets=async(saved:NonNullable<typeof adoption>)=>{
     if(saved.input.resource.kind==='source'&&saved.input.round>1){const origin=await timelines.existing(saved.input.resource,1);if(origin)await timelines.buildPendingTargets(origin);}
     await timelines.buildPendingTargets(saved);
    };
    const sourceId=resource.kind==='order'&&typeof adoption.input.sourceVersions.sourceId==='string'?adoption.input.sourceVersions.sourceId:null;
    const source=sourceId?await timelines.existing({kind:'source',id:sourceId},Number(adoption.input.sourceVersions.sourceRound)):null;
    // Shared source B is its own original adopted target, never re-frozen from
    // a later PO constraint. This remains the bounded worker, not a GET write.
    if(source)await buildTargets(source);
    await buildTargets(adoption);
    await buildFixedReworkTargets(db,adoption);
   }
   pending=(await db.query<{transaction_id:string}>('SELECT transaction_id FROM digital_journey_fact_changes WHERE resource_kind=$1 AND resource_id=$2',[resource.kind,resource.id])).rows.map(r=>r.transaction_id);
   const time=await new ContextBusinessClock(this.database,db).read(resource);observed=time;
   // Establish the exact resource identity before creating a derived row.
   let selection:{facts:JourneySelectionFacts;expiresAt:string|null}|undefined;
   const model=await new DigitalJourneyQuery(this.database).buildFactsWithClient(db,resource,time.now,value=>{selection=value;});
   if(!selection)throw Error('Journey selector was not constructed in the native snapshot');
   if(!selection.facts.frames?.length)throw Error('Journey selector has no compiled observation');
   const fullSelection={version:selection.facts.version,cancelled:selection.facts.cancelled,closedAt:selection.facts.closedAt,
    frames:selection.facts.frames.map(({from,fullSignals,coverage,customerReminderDate,schedule})=>({from,fullSignals,coverage,customerReminderDate,schedule}))};
   await db.query(`INSERT INTO digital_journey_fact_models(resource_kind,resource_id,source_id,production_order_id)
    VALUES($1,$2,$3,$4) ON CONFLICT(resource_kind,resource_id) DO NOTHING`,[resource.kind,resource.id,model.sourceId,model.orderId]);
   const row=(await db.query<Row>('SELECT * FROM digital_journey_fact_models WHERE resource_kind=$1 AND resource_id=$2 FOR UPDATE',[resource.kind,resource.id])).rows[0]!;
   const sourceFingerprint=journeyFactFingerprint(model);
   const version=BigInt(row.source_version)+(row.applied_source_version!==null&&pending.length?1n:0n);
   await db.query(`UPDATE digital_journey_fact_models SET source_id=$3,production_order_id=$4,source_version=$12,applied_source_version=$12,
    calculation_version=$5,source_fingerprint=$6,payload=$7,clock_scenario_id=$8,clock_revision=$9,observed_at=$10,built_at=CURRENT_TIMESTAMP,
    selection_json=$13,selection_fingerprint=$14,selection_expires_at=$15,
    selection_integrity=md5(($13::jsonb)::text||$14::text),selection_full_json=$16::jsonb,
    selection_full_integrity=md5(($16::jsonb)::text||$14::text)
    WHERE resource_kind=$1 AND resource_id=$2 AND source_version=$11`,[resource.kind,resource.id,model.sourceId,model.orderId,JOURNEY_FACT_CALCULATION_VERSION,sourceFingerprint,JSON.stringify(model),time.scenarioId,time.revision,time.now,row.source_version,version.toString(),JSON.stringify(selection.facts),journeyValueFingerprint(selection.facts),selection.expiresAt,JSON.stringify(fullSelection)]);
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
  const row=(await db.query<Row&{pending:boolean;version_compatible:boolean}>(`SELECT m.*,
   ${await styleLabelModelVersionSql(db,'m.calculation_version','$3','m.resource_kind','m.resource_id')} AS version_compatible,EXISTS(SELECT 1 FROM digital_journey_fact_changes c
   WHERE c.resource_kind=m.resource_kind AND c.resource_id=m.resource_id) AS pending
   FROM digital_journey_fact_models m WHERE resource_kind=$1 AND resource_id=$2`,[resource.kind,resource.id,JOURNEY_FACT_CALCULATION_VERSION])).rows[0];
  if(!row)return {sourceVersion:'0',appliedSourceVersion:null,status:'missing',model:null};
  const time=await new ContextBusinessClock(this.database,db).read(resource);
  const status=row.pending||row.source_version!==row.applied_source_version||!row.payload||row.clock_scenario_id!==time.scenarioId||row.clock_revision!==String(time.revision)?'pending':!row.version_compatible?'obsolete':'ready';
  if(status==='ready'&&journeyFactFingerprint(row.payload!)!==row.source_fingerprint)throw new Error('Journey fact payload fingerprint mismatch');
  return {sourceVersion:row.source_version,appliedSourceVersion:row.applied_source_version,status,model:status==='ready'?row.payload:null};
 }
 /** Internal only: caller supplies its already-authorized candidates and owns
  * one read snapshot. This reads no full payload/SLA JSON and constructs nothing.
  * Every requested object has an explicit result; one corrupt selector does not
  * erase independently ready mothers. DB/scope failures still reject the read. */
 async readSelectionsWithClient(db:PoolClient,resources:readonly BusinessTimeScope[],asOf:string){
  const unique=new Map(resources.map(scope=>[businessScopeKey(scope),scope])),items=new Map<string,JourneyStoredSelection>();
  const clocks=await new ContextBusinessClock(this.database,db).readMany([...unique.values()],()=>new Date(asOf));
  if(!unique.size)return {items,clocks};
  type SelectionRow=Pick<Row,'source_version'|'applied_source_version'|'calculation_version'|'clock_scenario_id'|'clock_revision'>&{
   resource_kind:'source'|'order';resource_id:string;model_id:string|null;pending:boolean;build_failed:boolean;version_compatible:boolean;selection_json:JourneySelectionFacts|null;selection_fingerprint:string|null;selection_expires_at:Date|null};
  const rows=(await db.query<SelectionRow>(`SELECT requested.kind AS resource_kind,requested.id AS resource_id,m.resource_id AS model_id,
   m.source_version,m.applied_source_version,m.calculation_version,m.clock_scenario_id,m.clock_revision,
   m.selection_json,m.selection_fingerprint,m.selection_expires_at,
   ${await styleLabelModelVersionSql(db,'m.calculation_version','$3','requested.kind','requested.id')} AS version_compatible,
   EXISTS(SELECT 1 FROM digital_journey_fact_changes c WHERE c.resource_kind=requested.kind AND c.resource_id=requested.id) AS pending,
   EXISTS(SELECT 1 FROM digital_journey_fact_retries retry JOIN digital_journey_fact_changes change USING(resource_kind,resource_id)
    WHERE retry.resource_kind=requested.kind AND retry.resource_id=requested.id) AS build_failed
   FROM unnest($1::text[],$2::uuid[]) AS requested(kind,id)
   LEFT JOIN digital_journey_fact_models m ON m.resource_kind=requested.kind AND m.resource_id=requested.id`,
  [[...unique.values()].map(scope=>scope.kind),[...unique.values()].map(scope=>scope.id),JOURNEY_FACT_CALCULATION_VERSION])).rows;
  for(const row of rows){
   const key=businessScopeKey({kind:row.resource_kind,id:row.resource_id}),time=clocks.get(key)!;
   let status:JourneyStoredSelection['status']=!row.model_id?'missing':row.pending||row.source_version!==row.applied_source_version
    ||row.clock_scenario_id!==time.scenarioId||row.clock_revision!==String(time.revision)?'pending'
    :!row.version_compatible?'obsolete'
    :!row.selection_json||!row.selection_fingerprint||row.selection_expires_at&&row.selection_expires_at.getTime()<=Date.parse(time.now)?'pending':'ready';
   if(row.build_failed&&(row.pending||!row.model_id))status='failed';
   if(status==='ready'){
    const value=row.selection_json!;
    if((value as {version:string}).version==='journey-selection-v1')status='pending';
    else if(value.version!=='journey-selection-v2'||!Array.isArray(value.nodes)||!Array.isArray(value.nativeNodes)||!Array.isArray(value.untimedNodes)
     ||!Array.isArray(value.tasks)||!Array.isArray(value.coverage)||!Array.isArray(value.deliveryRisks)
     ||journeyValueFingerprint(value)!==row.selection_fingerprint)status='failed';
   }
   items.set(key,{sourceVersion:row.source_version??'0',appliedSourceVersion:row.applied_source_version??null,status,facts:status==='ready'?row.selection_json:null});
  }
  return {items,clocks};
 }
}
