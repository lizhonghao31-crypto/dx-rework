import type {PoolClient} from 'pg';
import type {BusinessTime,BusinessTimeScope} from '@dx-rework/domain/business-clock';
import {OrderTimeStandardSchema,type FrozenOrderTimePlan} from '@dx-rework/contracts/order-time-plan';
import type {OrderTimeOperation} from '@dx-rework/contracts/order-time-requests';
import type {TrustedActorContext} from '../tools/repositories.js';
import {isRootActor} from '../access/business-authority.js';
import {DigitalProductionAccessPolicy,digitalForbidden} from './access-policy.js';
import {assertSlaSettingsActor} from './sla-settings-authority.js';
import {fixedTimelineIdentity} from './fixed-timeline-identity.js';
import {OrderTimePlanRepository} from './order-time-plan-repository.js';
import {ORDER_TIME_MODEL_ENABLED} from './order-time-activation.js';
import {readInitialTimelineInput} from './fixed-timeline-initial-input.js';
import {orderTimeConfigurationFromLegacy} from '@dx-rework/contracts/order-time-settings';
import {validateDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import {DevelopmentCycleValuesSchema} from '@dx-rework/contracts/digital-development-technical';

type DB=Pick<PoolClient,'query'>;
export type OrderTimeAdmission={requestId:string|null;requestVersion:number|null;actorId:string;designerId:string;operation:OrderTimeOperation;plan:FrozenOrderTimePlan;time:BusinessTime;activationEventId?:string;generatedOrderId?:string};
const admissions=new WeakMap<DB,OrderTimeAdmission>();
/** Only the original command's owned client carries this scope. No token,
 * session/user identity replacement or cross-request grant is introduced. */
export async function withinOrderTimeAdmission<T>(db:PoolClient,value:OrderTimeAdmission,work:()=>Promise<T>):Promise<T>{
 if(admissions.has(db))throw Error('本单时效办理不能嵌套或切换实体');
 admissions.set(db,value);try{return await work();}finally{admissions.delete(db);}
}
export function orderTimeAdmission(db:DB){return admissions.get(db)??null;}
export function bindOrderTimeOrder(db:DB,orderId:string){const value=admissions.get(db);if(value)value.generatedOrderId=orderId;}
export async function currentOrderTimeCompany(db:DB){
 if(!(await db.query("SELECT to_regclass('digital_order_time_standards') AS relation")).rows[0]?.relation)return null;
 const row=(await db.query('SELECT standard_json FROM digital_order_time_standards ORDER BY version DESC LIMIT 1')).rows[0];
 return row?OrderTimeStandardSchema.parse(row.standard_json):null;
}
/** The first new standard publication and its native adoption flow are one
 * rollout. Existing per-order policies never depend on this new-adoption test. */
export async function acceptsNewOrderTime(db:DB){return ORDER_TIME_MODEL_ENABLED&&Boolean(await currentOrderTimeCompany(db));}
/** Explicit remediation/conversion reads the historical counterpart, never
 * today's company values. An unrecorded old field remains a visible null. */
export async function historicalOrderTimeCompany(db:DB,resource:BusinessTimeScope){
 const initial=await readInitialTimelineInput(db,resource);if(initial?.data.orderTimePlan)return initial.data.orderTimePlan.company;
 let snapshot=initial?.data.unified.values;
 if(!snapshot){const table=resource.kind==='source'?'digital_development_sla_plans':'digital_sla_order_snapshots',column=resource.kind==='source'?'source_id':'production_order_id';
  if((await db.query('SELECT to_regclass($1) AS relation',[table])).rows[0]?.relation){const row=(await db.query(`SELECT rule_version,parameters_json FROM ${table} WHERE ${column}=$1 ORDER BY revision LIMIT 1`,[resource.id])).rows[0];if(row)snapshot=validateDigitalSlaSnapshot({ruleVersion:row.rule_version,parameters:row.parameters_json});}
 }
 let development=initial?.data.development?.values;
 if(!development&&resource.kind==='source'&&(await db.query("SELECT to_regclass('digital_development_technical_enrollments') AS relation")).rows[0]?.relation)development=(await db.query('SELECT values_json FROM digital_development_technical_enrollments WHERE source_id=$1',[resource.id])).rows[0]?.values_json;
 const configuration=orderTimeConfigurationFromLegacy({...(snapshot?{unified:Object.fromEntries(Object.entries(snapshot.parameters).map(([key,value])=>[key,value.value]))}:{}),...(development?{development:DevelopmentCycleValuesSchema.parse(development)}:{}),...(initial?.data.planning?{planning:initial.data.planning.values as NonNullable<Parameters<typeof orderTimeConfigurationFromLegacy>[0]['planning']>}: {})});
 return OrderTimeStandardSchema.parse({version:'order-time-standard-v1',reference:'original-frozen:'+resource.kind+':'+resource.id,revision:1,...configuration});
}
export async function approvedOrderTimeSource(db:DB,actor:TrustedActorContext,sourceId:string){
 const value=admissions.get(db);if(!value?.requestId||value.actorId!==actor.actorId||!('sourceId'in value.operation)||value.operation.sourceId!==sourceId||!['development_publish','confirm_order','development_revision'].includes(value.operation.kind))return false;
 await assertSlaSettingsActor(db,actor,true);
 const request=(await db.query('SELECT state,version,designer_id,operation_json FROM digital_order_time_requests WHERE request_id=$1 FOR UPDATE',[value.requestId])).rows[0];
 if(request?.state!=='pending'||request.version!==value.requestVersion||request.designer_id!==value.designerId||fixedTimelineIdentity(request.operation_json)!==fixedTimelineIdentity(value.operation))digitalForbidden();
 const source=(await db.query('SELECT created_by FROM digital_production_sources WHERE source_id=$1',[sourceId])).rows[0];
 if(source?.created_by!==value.designerId)digitalForbidden();
 if(!(value.designerId===actor.actorId&&isRootActor(actor))&&!await new DigitalProductionAccessPolicy(db).activeRole(value.designerId,'sample_designer'))digitalForbidden();
 return true;
}
export async function approvedOrderTimeCreation(db:DB,actor:TrustedActorContext){
 const value=admissions.get(db);if(!value?.requestId||value.actorId!==actor.actorId||value.operation.kind!=='direct_order')return false;
 await assertSlaSettingsActor(db,actor,true);
 const request=(await db.query('SELECT state,version,designer_id,operation_json FROM digital_order_time_requests WHERE request_id=$1 FOR UPDATE',[value.requestId])).rows[0];
 if(request?.state!=='pending'||request.version!==value.requestVersion||request.designer_id!==value.designerId||fixedTimelineIdentity(request.operation_json)!==fixedTimelineIdentity(value.operation))digitalForbidden();
 if(!(value.designerId===actor.actorId&&isRootActor(actor))&&!await new DigitalProductionAccessPolicy(db).activeRole(value.designerId,'sample_designer'))digitalForbidden();
 return true;
}
export async function approvedOrderTimeOrder(db:DB,actor:TrustedActorContext,orderId:string){
 const value=admissions.get(db);if(!value?.requestId||value.actorId!==actor.actorId||value.operation.kind!=='instruction_publish'||value.operation.orderId!==orderId)return false;
 await assertSlaSettingsActor(db,actor,true);
 const row=(await db.query('SELECT state,version,operation_json FROM digital_order_time_requests WHERE request_id=$1 FOR UPDATE',[value.requestId])).rows[0];
 if(row?.state!=='pending'||row.version!==value.requestVersion||fixedTimelineIdentity(row.operation_json)!==fixedTimelineIdentity(value.operation))digitalForbidden();
 return true;
}
export async function orderTimeRequester(db:DB,actor:TrustedActorContext,designerId:string){
 if(isRootActor(actor))return;
 if(actor.actorId!==designerId||!actor.actorRoles.includes('sample_designer')||!actor.authorizationCapabilities?.includes('pattern_room:orders:create')||!await new DigitalProductionAccessPolicy(db).lockActiveRole(actor.actorId,'sample_designer'))digitalForbidden();
}
export async function orderTimePolicy(db:DB,resource:BusinessTimeScope):Promise<FrozenOrderTimePlan|null>{
 const active=admissions.get(db);
 if(active){const operation=active.operation;
  if('sourceId'in operation&&resource.kind==='source'&&operation.sourceId===resource.id||'orderId'in operation&&resource.kind==='order'&&operation.orderId===resource.id||resource.kind==='order'&&active.generatedOrderId===resource.id||operation.kind==='arrangement'&&operation.resource.kind===resource.kind&&operation.resource.id===resource.id)return active.plan;
 }
 return (await new OrderTimePlanRepository(db).current(resource))?.input.plan??null;
}
