import type {ProductionCollaboration} from '@dx-rework/contracts/production-collaboration';
import type {ProductionPeriodSources} from '@dx-rework/contracts/production-period';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {ProductionStatisticsResponse,StatisticsMetric,StatisticsPo} from '@dx-rework/contracts/production-statistics';
import {ApplicationError} from '../platform/errors.js';

type StoredPayload= {collaborationSources?:ProductionCollaboration;periodSources?:ProductionPeriodSources}&Omit<ProductionStatisticsResponse,'snapshotId'|'createdAt'|'expiresAt'|'freshness'|'page'|'pageSize'|'basis'>&{projectionInputs:StatisticsPo[];motherCompletion:StatisticsMetric};
const gone=():never=>{throw new ApplicationError('ANALYSIS_RESULT_EXPIRED','查询结果已过期或不再符合当前授权，请整体刷新',409);};
export type AnalysisStoredResult={result:{ruleVersion:string};watermark:string};
/** Shared PG storage, bounded and disposable. Payload contains the actual result, not only IDs. */
export class AnalysisResultStore<T extends AnalysisStoredResult=StoredPayload>{
 constructor(private readonly database:Pool){}
 async save(actorId:string,filtersHash:string,permissionHash:string,payload:T){
  const bytes=Buffer.byteLength(JSON.stringify(payload));if(bytes>5*1024*1024)throw new ApplicationError('ANALYSIS_RANGE_TOO_LARGE','当前完整结果过大，请缩小筛选范围后重试',409);
  const db=await this.database.connect();try{
   await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-analysis-results-capacity',0))");
   const encoded=JSON.stringify(payload),storedBytes=Number((await db.query('SELECT octet_length($1::jsonb::text) AS bytes',[encoded])).rows[0].bytes);if(storedBytes>5*1024*1024)throw new ApplicationError('ANALYSIS_RANGE_TOO_LARGE','当前完整结果过大，请缩小筛选范围后重试',409);
   await db.query('DELETE FROM digital_production_analysis_results WHERE expires_at<=clock_timestamp()');
   const id=randomUUID(),row=(await db.query(`WITH at AS(SELECT clock_timestamp() AS value)
    INSERT INTO digital_production_analysis_results(result_id,actor_id,filters_hash,permission_hash,rule_version,watermark,payload,created_at,expires_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,value,value+interval '15 minutes' FROM at RETURNING result_id,created_at,expires_at`,[id,actorId,filtersHash,permissionHash,payload.result.ruleVersion,payload.watermark,JSON.stringify(payload)])).rows[0]!;
   // At most8 results per actor,128 globally and64MiB of JSON payload. Eviction
   // only removes this derived cache; expired identifiers must explicitly refresh.
   await db.query(`DELETE FROM digital_production_analysis_results WHERE result_id IN(
    SELECT result_id FROM digital_production_analysis_results WHERE actor_id=$1 ORDER BY created_at DESC,result_id DESC OFFSET 8)`,[actorId]);
   await db.query(`DELETE FROM digital_production_analysis_results WHERE result_id IN(
    SELECT result_id FROM(SELECT result_id,row_number() OVER(ORDER BY created_at DESC,result_id DESC) AS position,
     sum(octet_length(payload::text)) OVER(ORDER BY created_at DESC,result_id DESC) AS bytes FROM digital_production_analysis_results) limits
    WHERE position>128 OR bytes>67108864)`);
   await db.query('COMMIT');return {snapshotId:id,createdAt:new Date(row.created_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString()};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async load(id:string,actorId:string,filtersHash:string,authorize:(payload:T)=>Promise<string>):Promise<T&{snapshotId:string;createdAt:string;expiresAt:string}>{
  const row=(await this.database.query(`SELECT result_id,created_at,expires_at,permission_hash,payload FROM digital_production_analysis_results
   WHERE result_id=$1 AND actor_id=$2 AND filters_hash=$3 AND expires_at>clock_timestamp()`,[id,actorId,filtersHash])).rows[0];
  if(!row)gone();if(await authorize(row.payload)!==row.permission_hash)gone();return {...row.payload,snapshotId:row.result_id,createdAt:new Date(row.created_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString()};
 }
}
