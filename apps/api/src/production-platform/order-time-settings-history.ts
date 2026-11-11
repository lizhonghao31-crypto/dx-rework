import type {PoolClient} from 'pg';
import {DevelopmentCycleValuesSchema} from '@dx-rework/contracts/digital-development-technical';
import {OrderTimeStandardSchema} from '@dx-rework/contracts/order-time-plan';
import {orderTimeConfigurationFromLegacy,type OrderTimeHistoryKind,type OrderTimeHistoryRecord} from '@dx-rework/contracts/order-time-settings';
import {ApplicationError} from '../platform/errors.js';
import {SlaConfigurationRepository} from './sla-configuration-repository.js';

const visible=`NOT EXISTS(SELECT 1 FROM digital_order_time_history_events hidden WHERE hidden.entry_kind=history.kind AND hidden.entry_id=history.id)`;
// Only metadata is selected before pagination. Missing old counterparts stay
// unknown; reading history never borrows today's development/planning values.
const history=`WITH history AS (
 SELECT 'order_time'::text AS kind,standard_id::text AS id,version,recorded_at FROM digital_order_time_standards
 UNION ALL SELECT 'legacy_set',standard_id::text,version,recorded_at FROM digital_timeline_standard_versions
 UNION ALL SELECT 'legacy_unified',configuration_id::text,version,created_at FROM digital_sla_configurations c
  WHERE NOT EXISTS(SELECT 1 FROM digital_timeline_standard_versions s WHERE s.unified_configuration_id=c.configuration_id)
 UNION ALL SELECT 'legacy_development',version::text,version,recorded_at FROM digital_development_cycle_standards d
  WHERE NOT EXISTS(SELECT 1 FROM digital_timeline_standard_versions s WHERE s.development_version=d.version)
)`;

export async function orderTimeHistoryEntry(db:PoolClient,kind:OrderTimeHistoryKind,id:string):Promise<OrderTimeHistoryRecord>{
 const metadata=(await db.query<{kind:OrderTimeHistoryKind;id:string;version:number;recorded_at:Date|string}>(history+` SELECT * FROM history WHERE kind=$1 AND id=$2 AND ${visible}`,[kind,id])).rows[0];
 if(!metadata)throw new ApplicationError('NOT_FOUND','历史设置不存在或已删除',404);
 const common={id,kind,version:metadata.version,recordedAt:new Date(metadata.recorded_at).toISOString()};
 if(kind==='order_time'){
  const row=(await db.query('SELECT standard_json,source_standard_id FROM digital_order_time_standards WHERE standard_id=$1',[id])).rows[0];
  return {...common,standard:OrderTimeStandardSchema.parse(row.standard_json),sourceId:row.source_standard_id,partial:false,missing:[]};
 }
 const repo=new SlaConfigurationRepository(db);let configuration;
 if(kind==='legacy_set'){
  const row=(await db.query(`SELECT c.version AS unified_version,s.development_version,s.planning_json,d.values_json
   FROM digital_timeline_standard_versions s JOIN digital_sla_configurations c ON c.configuration_id=s.unified_configuration_id
   JOIN digital_development_cycle_standards d ON d.version=s.development_version WHERE s.standard_id=$1`,[id])).rows[0];
  if(!row)throw Error('历史设置的原记录缺失');
  const unified=await repo.current(row.unified_version);if(!unified)throw Error('历史时效设置的原记录缺失');
  configuration=orderTimeConfigurationFromLegacy({unified:unified.values,development:DevelopmentCycleValuesSchema.parse(row.values_json),planning:row.planning_json});
 }else if(kind==='legacy_unified'){
  const unified=await repo.current(metadata.version);if(!unified)throw Error('历史时效设置的原记录缺失');
  configuration=orderTimeConfigurationFromLegacy({unified:unified.values});
 }else{
  const row=(await db.query('SELECT values_json FROM digital_development_cycle_standards WHERE version=$1',[metadata.version])).rows[0];
  configuration=orderTimeConfigurationFromLegacy({development:DevelopmentCycleValuesSchema.parse(row.values_json)});
 }
 const missing=kind==='legacy_unified'?['当时的开发周期','当时的规划日历']:kind==='legacy_development'?['当时的节点时效','当时的规划日历']:[];
 return {...common,standard:OrderTimeStandardSchema.parse({version:'order-time-standard-v1',reference:kind+':'+id,revision:metadata.version,...configuration}),sourceId:null,partial:missing.length>0,missing};
}

export async function orderTimeHistoryPage(db:PoolClient,page:number){
 const totalCount=Number((await db.query(history+` SELECT count(*) AS count FROM history WHERE ${visible}`)).rows[0].count);
 const selected=(await db.query<{kind:OrderTimeHistoryKind;id:string}>(history+` SELECT kind,id FROM history WHERE ${visible} ORDER BY recorded_at DESC,kind,id LIMIT 15 OFFSET $1`,[(page-1)*15])).rows;
 const items:OrderTimeHistoryRecord[]=[];for(const row of selected)items.push(await orderTimeHistoryEntry(db,row.kind,row.id));
 return {items,page,pageSize:15 as const,totalCount};
}
