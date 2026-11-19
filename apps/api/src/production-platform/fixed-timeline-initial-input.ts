import type {PoolClient} from 'pg';
import type {BusinessTime,BusinessTimeScope} from '@dx-rework/domain/business-clock';
import type {DigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import type {TimelineAdoptionMode} from './fixed-timeline-mode.js';
import {fixedTimelineIdentity} from './fixed-timeline-identity.js';
import {FrozenOrderTimePlanSchema,type FrozenOrderTimePlan} from '@dx-rework/contracts/order-time-plan';
import {OrderTimePlanRepository} from './order-time-plan-repository.js';

type DB=Pick<PoolClient,'query'>;
export type FrozenInitialTimelineInput={
 version:2;identityHash:string;
 data:{resource:BusinessTimeScope;creationEventRef:string;time:BusinessTime;
  unified:{configurationId:string;snapshotRef:string;values:DigitalSlaSnapshot};
  development:{snapshotRef:string;version:number;values:Record<string,unknown>}|null;
  planning:{standardRef:string;version:number;values:Record<string,unknown>}|null;
  orderTimePlan?:FrozenOrderTimePlan};
};
export async function readInitialTimelineInput(db:DB,resource:BusinessTimeScope):Promise<FrozenInitialTimelineInput|null>{
 const table=resource.kind==='source'?'digital_development_sla_plans':'digital_sla_plans';
 if(!(await db.query('SELECT to_regclass($1) AS relation',[table])).rows[0]?.relation)return null;
 const row=(await db.query(`SELECT to_jsonb(p)->>'timeline_schema_version' AS version,to_jsonb(p)->>'route_schema_version' AS route_version,to_jsonb(p)->'initial_adoption_input' AS input
  FROM ${table} p WHERE ${resource.kind==='source'?'source_id':'production_order_id'}=$1 ORDER BY revision LIMIT 1`,[resource.id])).rows[0];
 if(!row||row.version===null||row.version==='1')return null;
 const input=row.input as FrozenInitialTimelineInput;
 if(row.version!=='2'||row.route_version!=='2'||input?.version!==2||!input.data||fixedTimelineIdentity(input.data)!==input.identityHash)throw Error('此对象原采用版本或冻结输入不受当前程序支持');
 if(input.data.orderTimePlan)FrozenOrderTimePlanSchema.parse(input.data.orderTimePlan);
 return input;
}
/** Same original creation transaction: freeze existing standards even before
 * route/goal publication. Later scope capture may add genuine route facts but
 * must inherit these values, never the later global defaults.
 */
export async function freezeInitialTimelineInput(db:DB,mode:TimelineAdoptionMode,input:Omit<FrozenInitialTimelineInput['data'],'development'|'planning'>,inherited?:FrozenInitialTimelineInput|null,approvedFactoryWork=false):Promise<FrozenInitialTimelineInput|null>{
 if(mode==='legacy')return null;
 if(!(await db.query("SELECT to_regclass('digital_timeline_standard_versions') AS relation")).rows[0]?.relation)throw Error('固定计划采用所需迁移尚未完成');
 let development:FrozenInitialTimelineInput['data']['development']=inherited?inherited.data.development:null;
 if(!inherited){
  const row=input.resource.kind==='source'
   ?(await db.query('SELECT policy_version AS version,values_json FROM digital_development_technical_enrollments WHERE source_id=$1',[input.resource.id])).rows[0]
   :(await db.query('SELECT version,values_json FROM digital_development_cycle_standards ORDER BY version DESC LIMIT 1')).rows[0];
  if(row)development={snapshotRef:input.resource.kind==='source'?`development-enrollment:${input.resource.id}:policy:${row.version}`:`development-standard:${row.version}`,version:Number(row.version),values:row.values_json};
 }
 const row=inherited||!development?null:(await db.query('SELECT standard_id,version,planning_json FROM digital_timeline_standard_versions WHERE unified_configuration_id=$1 AND development_version=$2 ORDER BY version DESC LIMIT 1',[input.unified.configurationId,development.version])).rows[0];
 const planning=inherited?inherited.data.planning:row?{standardRef:row.standard_id,version:Number(row.version),values:row.planning_json}:null;
 const confirmed=inherited?await new OrderTimePlanRepository(db).current(inherited.data.resource):null;
 let policy=confirmed?.input.plan??inherited?.data.orderTimePlan??input.orderTimePlan;
 if(inherited?.data.orderTimePlan&&policy&&fixedTimelineIdentity(policy.company)!==fixedTimelineIdentity(inherited.data.orderTimePlan.company))throw Error('正式订单不能替换本单原公司标准');
 if(inherited&&input.orderTimePlan&&fixedTimelineIdentity(input.orderTimePlan)!==fixedTimelineIdentity(policy??null)){
  const adopted=input.orderTimePlan;
  const {factory_production_work:factory,...shared}=adopted.overrides;
  // An authorized first order may add this order-only forecast. The complete
  // rest of the policy must still hash to the exact source version. No source
  // with its own such work can accept a different value at order creation.
  const originalFactory=policy?.overrides.factory_production_work;
  if(!approvedFactoryWork||input.resource.kind!=='order'||!confirmed||!policy||factory?.kind!=='forecast'
   ||confirmed.input.work.some(work=>work.parameterKey==='factory_production_work')||adopted.revision!==policy.revision+1
   ||fixedTimelineIdentity({...adopted,revision:policy.revision,overrides:{...shared,...(originalFactory?{factory_production_work:originalFactory}:{})}})!==fixedTimelineIdentity(policy))
   throw Error('正式订单须沿本单当前已确认的时间方案');
  policy=adopted;
 }
 const data=structuredClone({...input,development,planning,...(policy?{orderTimePlan:FrozenOrderTimePlanSchema.parse(policy)}:{})});
 return {version:2,identityHash:fixedTimelineIdentity(data),data};
}
