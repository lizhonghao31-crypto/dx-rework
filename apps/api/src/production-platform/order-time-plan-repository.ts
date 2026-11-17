import {randomUUID} from 'node:crypto';
import {OrderTimeWashingReworkPlanSchema,type OrderTimeWashingReworkPlan} from '@dx-rework/contracts/order-time-washing-rework';
import type {SeriesRoute} from '@dx-rework/contracts/digital-series-plan';
import {FrozenTimeFrameworkSchema,type FrozenTimeFramework} from '@dx-rework/contracts/order-time-framework';
import type {OrderTimeNativeProgress} from './order-time-request-plan.js';
import {frameworkScopeInputs} from './order-time-framework-route.js';
import {preparedStoredRewash,retainedWashingReworkTargets} from './order-time-washing-rework.js';
import {evaluateTimeFrameworkCandidate,freezeTimeFrameworkCandidate} from './order-time-framework.js';
import type {PoolClient} from 'pg';
import {validateBusinessTime,type BusinessTime,type BusinessTimeScope} from '@dx-rework/domain/business-clock';
import type {SlaAnchor} from '@dx-rework/domain/digital-sla-plan';
import {FrozenOrderTimePlanSchema,type FrozenOrderTimePlan,type OrderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {orderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {fixedTimelineIdentity} from './fixed-timeline-identity.js';
import {SlaVersionConflict,SlaIdempotencyConflict} from './sla-configuration-repository.js';
import {evaluateOrderTimeScenario,type OrderTimeScope,type OrderTimeWork} from './order-time-schedule.js';
import type {FixedTimelineTarget} from './fixed-timeline-targets.js';

type DB=Pick<PoolClient,'query'>;
export type OrderTimeInput={version:'order-time-input-v1'|'order-time-input-rewash-v1';plan:FrozenOrderTimePlan;work:OrderTimeWork[];
 rewashing?:OrderTimeWashingReworkPlan[];
 frameworkContext?:{route:SeriesRoute;acceptedAt:SlaAnchor;notBefore:Record<string,SlaAnchor>;progress:Record<string,OrderTimeNativeProgress>};
 frameworkPlans?:Record<string,FrozenTimeFramework>;
 factoryCommitments?:Array<{lineId:string;label:string;date:string;version:number;source:string}>;
 scopes:Array<OrderTimeScope&{lineId:string|null;customerGoalIds:string[];customerDateVersion?:number}>;route:{complete:boolean;missing:string[]}};
type Targets=Record<string,Record<string,FixedTimelineTarget>>;
export type StoredOrderTimePlan={id:string;resource:BusinessTimeScope;revision:number;input:OrderTimeInput;targets:Targets;
 identityHash:string;time:BusinessTime;actorId:string;eventRef:string;changeKind:'initial'|'arrangement'|'customer_date_change'};
/** Server-only qualification from the same actor, transaction and business
 * observation. An unknown scope is an error, never an empty update set. */
export type LinkedOrderTimeQualification={value:OrderTimeInput;updates:Record<string,OrderTimeRule>};
type Row={plan_version_id:string;resource_kind:'source'|'order';source_id:string|null;production_order_id:string|null;
 revision:number;input_snapshot:OrderTimeInput;fixed_targets:Targets;identity_hash:string;business_time:BusinessTime;created_by:string;source_event_ref:string;change_kind:StoredOrderTimePlan['changeKind']};
const identity=(input:OrderTimeInput,targets:Targets)=>fixedTimelineIdentity({input,targets});
/** New work metadata and the actual frozen DAG are one versioned input.
 * Old snapshots remain v1; unsupported/mixed new inputs cannot be interpreted
 * as an original aggregate washing plan by a compatible reader. */
export function assertOrderTimeRewashInput(input:OrderTimeInput,resource:BusinessTimeScope,requireIntroduced:boolean){
 const rows=input.rewashing??[];
 if((input.version==='order-time-input-rewash-v1')!==(rows.length>0))throw Error('返洗计划格式版本与工作范围不一致');
 if(!rows.length&&input.work.some(work=>/^bulk_(?:factory|return)_washing(?:_inspection)?:rewash:/.test(work.id)))
  throw Error('返洗计划格式版本与工作范围不一致');
 if(!rows.length)return;
 if(resource.kind!=='order'||!input.plan.company.framework||!input.frameworkContext)throw Error('返洗计划须沿原订单正式安排');
 if(new Set(rows.map(row=>row.intentId)).size!==rows.length)throw Error('返洗工作身份不能重复');
 for(const row of rows){
  OrderTimeWashingReworkPlanSchema.parse(row);
  if(row.orderId!==resource.id)throw Error('返洗计划不属于原订单');
  if(requireIntroduced&&(!row.introducedAt||!row.introducedEventRef))throw Error('返洗正式安排缺少原生效来源');
  const prepared=preparedStoredRewash(row),scopes=input.scopes.filter(scope=>scope.lineId===row.lineId);
  if(scopes.length!==1||!scopes[0]!.terminalIds.includes(prepared.requiredForDelivery)||!scopes[0]!.customerGoalIds.includes(prepared.requiredForDelivery))throw Error('返洗工作未完整进入原PO交付范围');
  for(const expected of prepared.work){
   const matches=input.work.filter(work=>work.id===expected.id);
   if(matches.length!==1||fixedTimelineIdentity(matches[0])!==fixedTimelineIdentity(expected))throw Error('返洗工作身份、依赖或原采用用时不一致');
  }
 }
}
function saved(row:Row):StoredOrderTimePlan{
 const input=row.input_snapshot,targets=row.fixed_targets;
 if(!['order-time-input-v1','order-time-input-rewash-v1'].includes(input.version)||identity(input,targets)!==row.identity_hash)throw Error('本单时间方案版本或校验不受当前程序支持');
 FrozenOrderTimePlanSchema.parse(input.plan);
 assertOrderTimeRewashInput(input,{kind:row.resource_kind,id:(row.production_order_id??row.source_id)!},true);
 for(const plan of Object.values(input.frameworkPlans??{}))FrozenTimeFrameworkSchema.parse(plan);
 return {id:row.plan_version_id,resource:{kind:row.resource_kind,id:(row.production_order_id??row.source_id)!},revision:row.revision,input,targets,
  identityHash:row.identity_hash,time:validateBusinessTime(row.business_time),actorId:row.created_by,eventRef:row.source_event_ref,changeKind:row.change_kind};
}

/** Original authorized command owns the transaction, lock lifetime and business
 * change. No Pool, GET rebuild, current-settings read, authorization cache or
 * writes to native task clocks/actual events are introduced here.
 */
export class OrderTimePlanRepository{
 constructor(private readonly db:DB){}
 async available(){return Boolean((await this.db.query("SELECT to_regclass('digital_order_time_plan_versions') AS relation")).rows[0]?.relation);}
 async current(resource:BusinessTimeScope):Promise<StoredOrderTimePlan|null>{
  if(!await this.available())return null;
  const row=(await this.db.query(`SELECT * FROM digital_order_time_plan_versions WHERE resource_kind=$1
   AND ${resource.kind==='source'?'source_id':'production_order_id'}=$2 ORDER BY revision DESC LIMIT 1`,[resource.kind,resource.id])).rows[0];
  return row?saved(row):null;
 }
 async confirm(input:{resource:BusinessTimeScope;expectedRevision:number;value:OrderTimeInput;actorId:string;eventRef:string;time:BusinessTime;requestKey:string},refreshLinked?:(resource:BusinessTimeScope,changes:Record<string,OrderTimeRule>)=>Promise<LinkedOrderTimeQualification>):Promise<StoredOrderTimePlan>{
  const previous=await this.current(input.resource),result=await this.append(input,'arrangement');
  if(!previous||result.revision<=previous.revision)return result;
  const keys=new Set([...Object.keys(previous.input.plan.overrides),...Object.keys(result.input.plan.overrides)]),changed=Object.fromEntries([...keys].filter(key=>fixedTimelineIdentity(orderTimeRule(previous.input.plan,key)?.rule??null)!==fixedTimelineIdentity(orderTimeRule(result.input.plan,key)?.rule??null)).flatMap(key=>{const rule=orderTimeRule(result.input.plan,key)?.rule;return rule?[[key,rule]]:[];}));
  if(!Object.keys(changed).length)return result;
  const row=(await this.db.query(`SELECT source_id,production_order_id FROM digital_production_orders WHERE ${input.resource.kind==='source'?'source_id':'production_order_id'}=$1`,[input.resource.id])).rows[0];
  const linked:BusinessTimeScope|null=input.resource.kind==='source'?row?.production_order_id?{kind:'order',id:row.production_order_id}:null:row?.source_id?{kind:'source',id:row.source_id}:null;
  const counterpart=linked?await this.current(linked):null;
  // Only one actually linked order/source with the same original counterpart
  // shares future settings. Independent historical adoptions are not merged.
  if(!linked||!counterpart||fixedTimelineIdentity(counterpart.input.plan.company)!==fixedTimelineIdentity(result.input.plan.company))return result;
  const updates=Object.fromEntries(Object.entries(changed).filter(([key,rule])=>fixedTimelineIdentity(orderTimeRule(counterpart.input.plan,key)?.rule??null)!==fixedTimelineIdentity(rule)));
  if(!Object.keys(updates).length)return result;
  if(!refreshLinked)throw Error('关联本单调整须重新核对当前适用范围与事实');
  const qualified=await refreshLinked(linked,updates),selected=qualified.updates;
  for(const [key,rule]of Object.entries(selected))if(!Object.hasOwn(updates,key)||fixedTimelineIdentity(updates[key])!==fixedTimelineIdentity(rule))throw Error('关联适用范围不能引入额外时效修改');
  if(!Object.keys(selected).length)return result;
  const value=qualified.value;if(fixedTimelineIdentity(value.plan.company)!==fixedTimelineIdentity(counterpart.input.plan.company))throw new SlaVersionConflict('关联对象原时效基线已更新，请重新核对');
  value.plan={...value.plan,revision:counterpart.input.plan.revision+1,overrides:{...value.plan.overrides,...selected}};
  await this.append({resource:linked,expectedRevision:counterpart.revision,value,actorId:input.actorId,eventRef:input.eventRef,time:input.time,requestKey:'order-time:linked:'+fixedTimelineIdentity([input.requestKey,linked])},'arrangement');
  return result;
 }
 private async append(input:{resource:BusinessTimeScope;expectedRevision:number;value:OrderTimeInput;actorId:string;eventRef:string;time:BusinessTime;requestKey:string},kind:'arrangement'|'customer_date_change',changedScopes:ReadonlySet<string>=new Set()):Promise<StoredOrderTimePlan>{
  if(!await this.available())throw Error('本单时间方案迁移尚未完成');
  if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||!input.eventRef.trim()||!input.requestKey.trim()||input.requestKey.length>200)throw Error('本单时间方案身份或版本无效');
  const time=validateBusinessTime(input.time),value=structuredClone(input.value);
  if(!['order-time-input-v1','order-time-input-rewash-v1'].includes(value.version))throw Error('本单时间输入版本不受支持');
  FrozenOrderTimePlanSchema.parse(value.plan);
  const resource=input.resource,table=resource.kind==='source'?'digital_production_sources':'digital_production_orders',column=resource.kind==='source'?'source_id':'production_order_id';
  assertOrderTimeRewashInput(value,resource,false);
  if(!(await this.db.query(`SELECT ${column} FROM ${table} WHERE ${column}=$1 FOR UPDATE`,[resource.id])).rowCount)throw Error('本单不存在');
  const prior=(await this.db.query('SELECT * FROM digital_order_time_plan_versions WHERE request_key=$1',[input.requestKey])).rows[0];
  if(prior){
   const result=saved(prior),replayed=structuredClone(value);
   // The introduction was supplied by this exact original append, not the
   // caller. Replaying the same pre-effective intent must not create another
   // plan or fail merely because the stored receipt now contains that source.
   for(const row of replayed.rewashing??[])if(!row.introducedAt&&!row.introducedEventRef){
    const stored=result.input.rewashing?.find(previous=>previous.intentId===row.intentId);
    if(stored&&fixedTimelineIdentity({...stored,introducedAt:null,introducedEventRef:null})===fixedTimelineIdentity(row)){
     row.introducedAt=stored.introducedAt;row.introducedEventRef=stored.introducedEventRef;
    }
   }
   if(result.resource.kind!==resource.kind||result.resource.id!==resource.id||result.revision!==input.expectedRevision+1||result.actorId!==input.actorId||result.eventRef!==input.eventRef||fixedTimelineIdentity({...result.input,frameworkPlans:undefined})!==fixedTimelineIdentity({...replayed,frameworkPlans:undefined}))throw new SlaIdempotencyConflict('本次操作标识已用于其他时间方案');
   return result;
  }
  const previous=await this.current(resource);
  if((previous?.revision??0)!==input.expectedRevision)throw new SlaVersionConflict('本单安排已更新，请刷新后重试');
  const oldRewash=new Map((previous?.input.rewashing??[]).map(row=>[row.intentId,row]));
  const newRewash=(value.rewashing??[]).filter(row=>!oldRewash.has(row.intentId));
  for(const row of value.rewashing??[]){
   OrderTimeWashingReworkPlanSchema.parse(row);
   if(resource.kind!=='order'||row.orderId!==resource.id)throw Error('返洗计划不属于原订单');
   const old=oldRewash.get(row.intentId);
   if(old){if(fixedTimelineIdentity(old)!==fixedTimelineIdentity(row))throw Error('既有返洗计划身份、范围和采用不能被覆盖');}
   else{if(row.introducedAt||row.introducedEventRef)throw Error('新增返洗不能伪造原生效来源');row.introducedAt=time.now;row.introducedEventRef=input.eventRef;}
  }
  if([...oldRewash.keys()].some(id=>!value.rewashing?.some(row=>row.intentId===id)))throw Error('旧返洗计划须保留原安排与历史');

  if(previous){
   if(previous.time.scenarioId!==time.scenarioId||Date.parse(time.now)<Date.parse(previous.time.now)||time.revision<previous.time.revision)throw Error('本单时间来源或版本不能倒退');
   if(fixedTimelineIdentity(previous.input.plan.company)!==fixedTimelineIdentity(value.plan.company))throw Error('不能用后来公司标准覆盖本单原标准');
   const samePlan=fixedTimelineIdentity(previous.input.plan)===fixedTimelineIdentity(value.plan);
   if(!samePlan&&value.plan.revision!==previous.input.plan.revision+1)throw Error('本单用时版本必须接续上次有效版本');
   const oldWork=new Map(previous.input.work.map(work=>[work.id,work]));
   for(const work of value.work)if(oldWork.has(work.id)&&oldWork.get(work.id)!.parameterKey!==work.parameterKey)throw Error('替换工艺须保留原身份并新增实际工作，不能覆盖旧节点');
   for(const scope of value.scopes){const old=previous.input.scopes.find(row=>row.scopeRef===scope.scopeRef);
    if(old&&!changedScopes.has(scope.scopeRef)&&(fixedTimelineIdentity(old.customerGoal)!==fixedTimelineIdentity(scope.customerGoal)||old.lineId!==scope.lineId))throw Error('原客户目标只能沿真实批准改期变化');
    if(old&&!changedScopes.has(scope.scopeRef))for(const id of old.customerGoalIds)if(fixedTimelineIdentity(old.goals[id]??null)!==fixedTimelineIdentity(scope.goals[id]??null))throw Error('原客户目标只能沿真实批准改期变化');
   }
  }
  if(!value.scopes.length||new Set(value.scopes.map(scope=>scope.scopeRef)).size!==value.scopes.length)throw Error('本单缺少唯一交付范围');
  for(const scope of value.scopes){
   if(!scope.scopeRef.trim()||!scope.terminalIds.length||new Set(scope.terminalIds).size!==scope.terminalIds.length)throw Error('本单交付范围或终点无效');
   if(resource.kind==='source'&&scope.lineId!==null)throw Error('独立开发不能伪造生产PO');
   if(resource.kind==='order'&&(!scope.lineId||!scope.customerGoalIds.length||scope.customerGoalIds.some(id=>!scope.terminalIds.includes(id))||!(await this.db.query('SELECT 1 FROM digital_production_po_lines WHERE production_order_id=$1 AND line_id=$2',[resource.id,scope.lineId])).rowCount))throw Error('交付范围不属于当前订单PO');
  }
  // This evaluation uses creation/confirmation as a planning assumption only;
  // it neither fabricates readiness nor stores its expected end as an actual.
  const targets:Targets=structuredClone(previous?.targets??{});
  if(!previous&&resource.kind==='order'){
   const sourceId=(await this.db.query('SELECT source_id FROM digital_production_orders WHERE production_order_id=$1',[resource.id])).rows[0]?.source_id;
   const sourcePlan=sourceId?await this.current({kind:'source',id:sourceId}):null;
   if(sourcePlan){
    if(fixedTimelineIdentity(sourcePlan.input.plan.company)!==fixedTimelineIdentity(value.plan.company))throw Error('正式订单必须保留开发来源已采用的公司标准');
    const sourceWork=new Map(sourcePlan.input.work.map(work=>[work.canonicalWorkRef??work.id,work]));
    for(const scope of value.scopes){
     const kept:Record<string,FixedTimelineTarget>={};
     for(const work of value.work){
      const original=sourceWork.get(work.canonicalWorkRef??work.id);
      if(!original||original.parameterKey!==work.parameterKey||original.canonicalWorkRef!==work.canonicalWorkRef)continue;
      const candidates=Object.values(sourcePlan.targets).flatMap(rows=>rows[original.id]?[rows[original.id]!]:[]),unique=new Map(candidates.map(target=>[fixedTimelineIdentity(target),target]));
      // Independent development has one genuine prior promise. Preserve it on
      // conversion; ambiguous per-PO history must not borrow another PO's B.
      if(unique.size===1)kept[work.id]={...structuredClone([...unique.values()][0]!),id:work.id};
     }
     if(Object.keys(kept).length)targets[scope.scopeRef]=kept;
    }
   }
  }
  for(const scope of value.scopes){
   const kept=changedScopes.has(scope.scopeRef)?undefined:targets[scope.scopeRef];
   const evaluated=evaluateOrderTimeScenario({...value,start:{precision:'instant',value:time.now,source:input.eventRef},scopes:[scope],...(kept?{fixedTargets:kept}:{})})[0]!;
   targets[scope.scopeRef]={...targets[scope.scopeRef],...Object.fromEntries(evaluated.targets.map(target=>[target.id,target]))};
  }
  if(value.frameworkContext){
   const context=value.frameworkContext,progress=new Map(Object.entries(context.progress));
   const plans:Record<string,FrozenTimeFramework>={};
   for(const scope of frameworkScopeInputs(value,context.route,context.acceptedAt,context.notBefore)){
    const old=previous?.input.frameworkPlans?.[scope.scopeRef];
    if(old&&kind==='customer_date_change'&&!changedScopes.has(scope.scopeRef)){plans[scope.scopeRef]=structuredClone(old);continue;}
    const result=evaluateTimeFrameworkCandidate(scope,{purpose:'order_proposal',observedAt:time.now,retained:retainedWashingReworkTargets(scope,progress,old,time.now,newRewash.length>0,value.rewashing)});
    plans[scope.scopeRef]=freezeTimeFrameworkCandidate(result,{reference:`${input.eventRef}:${scope.scopeRef}`,revision:(old?.revision??0)+1,previousReference:old?.reference??null,eventRef:input.eventRef});
   }
   value.frameworkPlans=plans;
  }
  const row=(await this.db.query(`INSERT INTO digital_order_time_plan_versions(plan_version_id,resource_kind,source_id,production_order_id,revision,input_snapshot,fixed_targets,identity_hash,change_kind,source_event_ref,business_time,created_by,request_key)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[randomUUID(),resource.kind,resource.kind==='source'?resource.id:null,resource.kind==='order'?resource.id:null,input.expectedRevision+1,JSON.stringify(value),JSON.stringify(targets),identity(value,targets),previous?kind:'initial',input.eventRef,JSON.stringify(time),input.actorId,input.requestKey])).rows[0];
  return saved(row);
 }
 /** Called only after the existing PO writer validated authority and persisted
  * the genuine H approval, in that same transaction. The effective policy is
  * captured now, so a later standard/arrangement cannot change this revision.
  */
 async approvedCustomerChange(resource:BusinessTimeScope,actorId:string,eventId:string,time:BusinessTime,refreshFramework?:()=>Promise<NonNullable<OrderTimeInput['frameworkContext']>>):Promise<StoredOrderTimePlan|null>{
  const previous=await this.current(resource);if(!previous)return null;
  if(resource.kind!=='order')throw Error('客户PO改期只属于正式订单');
  const rows=(await this.db.query(`SELECT change_id,line_id,version,old_date::text AS old_date,new_date::text AS new_date FROM digital_po_date_changes
   WHERE production_order_id=$1 AND approval_event_id=$2 AND date_kind='customer' AND source='approved_customer_change'
    AND old_date IS DISTINCT FROM new_date ORDER BY line_id`,[resource.id,eventId])).rows;
  if(!rows.length)return previous;
  const value=structuredClone(previous.input),changed=new Set<string>();
  for(const row of rows)for(const scope of value.scopes.filter(scope=>scope.lineId===row.line_id)){
   const old=scope.customerGoal;
   if(old.precision==='date'?old.value!==row.old_date:old.precision!=='unknown'||row.old_date!==null)throw Error('本单客户目标与批准改期链不连续');
   const goal:SlaAnchor={precision:'date',value:row.new_date,source:`digital_po_date_changes:${row.change_id}`};
   const advance=orderTimeRule(value.plan,'ship_sample_advance')?.rule;
   if(scope.shipSample)scope.shipSample.advanceDays=advance?.kind==='offset'?advance.days:null;
   scope.customerDateVersion=Number(row.version);scope.customerGoal=goal;scope.goals={...scope.goals,...Object.fromEntries(scope.customerGoalIds.map(id=>[id,goal]))};changed.add(scope.scopeRef);
  }
  if(!changed.size)return previous;
  if(value.frameworkContext){if(!refreshFramework)throw Error('批准改期须重新读取本单事实');value.frameworkContext=await refreshFramework();}
  return this.append({resource,expectedRevision:previous.revision,value,actorId,eventRef:`audit_events:${eventId}`,time,requestKey:`order-time:customer:${eventId}`},'customer_date_change',changed);
 }
}
