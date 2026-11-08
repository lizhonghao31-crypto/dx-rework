import type {Pool} from 'pg';
import {JOURNEY_FACT_CALCULATION_VERSION} from './journey-fact-model.js';
import {JourneyFactRepository,JourneyFactBusy} from './journey-fact-repository.js';

export const JOURNEY_FACT_UPDATE_LIMIT=16;
export const JOURNEY_FACT_UPDATE_CONCURRENCY=2;
type Pending={resource_kind:'source'|'order';resource_id:string};
export class JourneyFactUpdates{
 constructor(private readonly database:Pool,private readonly repository=new JourneyFactRepository(database)){}
 /** One bounded batch. A failed mother has its own backoff, not a batch rollback. */
 async runOnce(){
  // Only genuine future-fact rechecks expire. Ordinary SLA/date transitions
  // are already compiled; midnight must not enqueue every mother again.
  // Guarded clocks change through their existing native invalidations.
  await this.database.query(`INSERT INTO digital_journey_fact_changes(resource_kind,resource_id,reason)
   SELECT m.resource_kind,m.resource_id,'backfill' FROM digital_journey_fact_models m
   WHERE m.clock_scenario_id IS NULL AND m.selection_expires_at<=clock_timestamp()
    AND m.calculation_version=$2 AND m.source_version=m.applied_source_version
    AND NOT EXISTS(SELECT 1 FROM digital_journey_fact_changes c WHERE c.resource_kind=m.resource_kind AND c.resource_id=m.resource_id)
   ORDER BY m.selection_expires_at,m.resource_kind,m.resource_id LIMIT $1 ON CONFLICT DO NOTHING`,[JOURNEY_FACT_UPDATE_LIMIT,JOURNEY_FACT_CALCULATION_VERSION]);
  const pending=(await this.database.query<Pending&{transaction_ids:string[]}>(`SELECT c.resource_kind,c.resource_id,array_agg(c.transaction_id::text) AS transaction_ids FROM digital_journey_fact_changes c
   LEFT JOIN digital_journey_fact_retries r USING(resource_kind,resource_id)
   WHERE r.retry_after IS NULL OR r.retry_after<=clock_timestamp()
   GROUP BY c.resource_kind,c.resource_id ORDER BY min(CASE c.reason WHEN 'native' THEN 0 ELSE 1 END),min(c.registered_at),c.resource_kind,c.resource_id LIMIT $1`,[JOURNEY_FACT_UPDATE_LIMIT])).rows;
  const result={built:0,retired:0,failed:0,busy:0};let index=0;
  const workers=await Promise.allSettled(Array.from({length:Math.min(JOURNEY_FACT_UPDATE_CONCURRENCY,pending.length)},async()=>{
   for(;;){const row=pending[index++];if(!row)return;const resource={kind:row.resource_kind,id:row.resource_id};
    try{const built=await this.repository.buildOne(resource,{retireMissing:true});if(built.retired)result.retired++;else result.built++;}
    catch(error){if(error instanceof JourneyFactBusy){result.busy++;continue;}result.failed++;
     // Do not persist exception messages, business payloads, credentials or actor data.
     const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
     await this.database.query(`INSERT INTO digital_journey_fact_retries(resource_kind,resource_id,attempts,retry_after,error_code)
      SELECT $1,$2,1,clock_timestamp()+interval '1 second',$3 WHERE EXISTS(
       SELECT 1 FROM digital_journey_fact_changes WHERE resource_kind=$1 AND resource_id=$2 AND transaction_id=ANY($4::bigint[]))
      ON CONFLICT(resource_kind,resource_id) DO UPDATE SET attempts=least(digital_journey_fact_retries.attempts+1,20),
       retry_after=clock_timestamp()+make_interval(secs=>least(300,power(2,least(digital_journey_fact_retries.attempts,9)))::int),error_code=EXCLUDED.error_code`,
     [resource.kind,resource.id,code==='CONFLICT'?'CLOCK_CHANGED':code==='57014'||code==='25P03'?'TIMEOUT':'BUILD_FAILED',row.transaction_ids]);
    }
   }
  }));
  // A failure recording retry state must not let still-running siblings escape
  // the runtime's overlap/shutdown guard. Drain every owned worker first.
  if(workers.some(worker=>worker.status==='rejected'))throw Error('Journey fact retry registration failed');
  return result;
 }
 /** Explicit, cursor-bounded startup reconciliation for new calculation versions
  * or a whole application rollback that stopped registering native mutations.
  * It never runs in a list/detail GET and never constructs payloads itself. */
 async registerBackfill(after:string|null=null,limit=200,force=false){
  if(!Number.isInteger(limit)||limit<1||limit>200)throw Error('Invalid journey backfill batch size');
  const rows=(await this.database.query<Pending&{cursor:string}>(`WITH resources AS (
    SELECT 'order'::text resource_kind,production_order_id resource_id FROM digital_production_orders
    UNION ALL SELECT 'source',s.source_id FROM digital_production_sources s
     WHERE NOT EXISTS(SELECT 1 FROM digital_production_orders o WHERE o.source_id=s.source_id)
   ) SELECT r.*,r.resource_kind||':'||r.resource_id::text cursor FROM resources r
   LEFT JOIN digital_journey_fact_models m USING(resource_kind,resource_id)
   WHERE ($1::text IS NULL OR r.resource_kind||':'||r.resource_id::text>$1)
    AND ($4::boolean OR m.resource_id IS NULL OR m.calculation_version IS DISTINCT FROM $2)
   ORDER BY cursor LIMIT $3`,[after,JOURNEY_FACT_CALCULATION_VERSION,limit,force])).rows;
  if(rows.length)await this.database.query(`INSERT INTO digital_journey_fact_changes(resource_kind,resource_id,reason)
   SELECT kind,id,'backfill' FROM unnest($1::text[],$2::uuid[]) x(kind,id) ON CONFLICT DO NOTHING`,[rows.map(r=>r.resource_kind),rows.map(r=>r.resource_id)]);
  return {registered:rows.length,cursor:rows.at(-1)?.cursor??null,done:rows.length<limit};
 }
}

export class JourneyFactRuntime{
 private timer:ReturnType<typeof setInterval>|undefined;
 private running:Promise<void>|undefined;
 private backfill:string|null=null;
 private backfillDone=false;
 constructor(private readonly updates:Pick<JourneyFactUpdates,'runOnce'|'registerBackfill'>,private readonly logger:{warn(value:unknown,message:string):void},private readonly intervalMs=2000){
  if(!Number.isFinite(intervalMs)||intervalMs<1000)throw Error('Invalid journey fact update interval');
 }
 private kick=()=>{if(this.running)return;this.running=(async()=>{
  if(!this.backfillDone){const page=await this.updates.registerBackfill(this.backfill);this.backfill=page.cursor;this.backfillDone=page.done;}
  const result=await this.updates.runOnce();if(result.failed)this.logger.warn({failed:result.failed},'journey fact update pending for individual orders');
 })().catch(()=>this.logger.warn({},'journey fact update batch failed')).finally(()=>{this.running=undefined;});};
 start(){if(this.timer)return;this.timer=setInterval(this.kick,this.intervalMs);this.timer.unref();this.kick();}
 async stop(){if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.running;}
}
