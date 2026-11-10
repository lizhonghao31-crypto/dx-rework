import {ApplicationError} from '../platform/errors.js';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {SettingsPlanningSchema,type SettingsPlanning,type SettingsSetRecord} from '@dx-rework/contracts/sla-settings-sets';
type DB=Pick<PoolClient,'query'>;
export async function lockSettingsStandards(db:DB){
 await db.query('LOCK TABLE digital_sla_configurations IN SHARE ROW EXCLUSIVE MODE');
 await db.query('LOCK TABLE digital_development_cycle_standards IN SHARE ROW EXCLUSIVE MODE');
 if((await db.query("SELECT to_regclass('digital_timeline_standard_versions') AS relation")).rows[0]?.relation)await db.query('LOCK TABLE digital_timeline_standard_versions IN SHARE ROW EXCLUSIVE MODE');
}
export function settingsSetRecord(row:Record<string,unknown>):SettingsSetRecord{
 return {setId:String(row.standard_id),version:Number(row.version),unifiedVersion:Number(row.unified_version),developmentVersion:Number(row.development_version),planning:SettingsPlanningSchema.parse(row.planning_json),reason:String(row.reason??''),recordedAt:new Date(row.recorded_at as string|Date).toISOString(),sourceSetId:row.source_standard_id?String(row.source_standard_id):null};
}
export async function latestSettingsSet(db:DB):Promise<SettingsSetRecord|null>{
 const row=(await db.query(`SELECT s.*,c.version AS unified_version FROM digital_timeline_standard_versions s JOIN digital_sla_configurations c ON c.configuration_id=s.unified_configuration_id ORDER BY s.version DESC LIMIT 1`)).rows[0];
 return row?settingsSetRecord(row):null;
}
/** Caller owns the same publication transaction and standard locks. An old
 * one-side API creates a new pair of the actual current versions; it never
 * rewrites or guesses a historical pair. */
export async function appendCurrentSettingsSet(db:DB,actorId:string,requestKey:string,options?:{planning:SettingsPlanning;reason:string;sourceSetId?:string|null}){
 if(!(await db.query("SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('digital_timeline_standard_versions') AND attname='reason' AND NOT attisdropped")).rowCount)return null;
 await lockSettingsStandards(db);
 const current=(await db.query(`SELECT c.configuration_id,c.version AS unified_version,d.version AS development_version FROM digital_sla_configurations c CROSS JOIN digital_development_cycle_standards d ORDER BY c.version DESC,d.version DESC LIMIT 1`)).rows[0];
 if(!current)return null;
 const previous=await latestSettingsSet(db),planning=SettingsPlanningSchema.parse(options?.planning??previous?.planning??{});
 const existing=(await db.query('SELECT s.*,c.version AS unified_version FROM digital_timeline_standard_versions s JOIN digital_sla_configurations c ON c.configuration_id=s.unified_configuration_id WHERE s.request_key=$1',[requestKey])).rows[0];
 if(existing){
  if(existing.created_by!==actorId||options&&(existing.unified_version!==current.unified_version||existing.development_version!==current.development_version||!isDeepStrictEqual(SettingsPlanningSchema.parse(existing.planning_json),planning)||existing.reason!==options.reason||(existing.source_standard_id??null)!==(options.sourceSetId??null)))throw new ApplicationError('SLA_SETTINGS_SET_CONFLICT','原发布标识不能用于不同的组合标准',409);
  return settingsSetRecord(existing);
 }
 if(!options&&previous&&previous.unifiedVersion===current.unified_version&&previous.developmentVersion===current.development_version&&isDeepStrictEqual(previous.planning,planning))return previous;
 const row=(await db.query(`INSERT INTO digital_timeline_standard_versions(standard_id,version,unified_configuration_id,development_version,planning_json,created_by,request_key,reason,source_standard_id)
 SELECT $1,coalesce(max(version),0)+1,$2,$3,$4,$5,$6,$7,$8 FROM digital_timeline_standard_versions RETURNING *`,[randomUUID(),current.configuration_id,current.development_version,JSON.stringify(planning),actorId,requestKey,options?.reason??'按现行两侧标准组成新版本',options?.sourceSetId??null])).rows[0];
 return settingsSetRecord({...row,unified_version:current.unified_version});
}

/** Bind the unchanged counterpart and pair to the existing one-side preview.
 * Old clients keep their public body shape but cannot silently publish against
 * a counterpart changed by another window after preview. */
export async function settingsPublicationBasis(db:DB){
 if(!(await db.query("SELECT to_regclass('digital_timeline_standard_versions') AS relation")).rows[0]?.relation)return null;
 const row=(await db.query(`SELECT (SELECT coalesce(max(version),0) FROM digital_sla_configurations) AS unified,
 (SELECT coalesce(max(version),0) FROM digital_development_cycle_standards) AS development,
 (SELECT coalesce(max(version),0) FROM digital_timeline_standard_versions) AS set`)).rows[0];
 return {unified:Number(row.unified),development:Number(row.development),set:Number(row.set)};
}
