import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {validateBusinessTime,type BusinessTime,type BusinessTimeScope} from '@dx-rework/domain/business-clock';
import type {SlaAnchor} from '@dx-rework/domain/digital-sla-plan';
import {FrozenOrderTimePlanSchema,type FrozenOrderTimePlan} from '@dx-rework/contracts/order-time-plan';
import {orderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {fixedTimelineIdentity} from './fixed-timeline-identity.js';
import {SlaVersionConflict,SlaIdempotencyConflict} from './sla-configuration-repository.js';
import {evaluateOrderTimeScenario,type OrderTimeScope,type OrderTimeWork} from './order-time-schedule.js';
import type {FixedTimelineTarget} from './fixed-timeline-targets.js';

type DB=Pick<PoolClient,'query'>;
export type OrderTimeInput={version:'order-time-input-v1';plan:FrozenOrderTimePlan;work:OrderTimeWork[];
 scopes:Array<OrderTimeScope&{lineId:string|null;customerGoalIds:string[]}>;route:{complete:boolean;missing:string[]}};
type Targets=Record<string,Record<string,FixedTimelineTarget>>;
export type StoredOrderTimePlan={id:string;resource:BusinessTimeScope;revision:number;input:OrderTimeInput;targets:Targets;
 identityHash:string;time:BusinessTime;actorId:string;eventRef:string;changeKind:'initial'|'arrangement'|'customer_date_change'};
type Row={plan_version_id:string;resource_kind:'source'|'order';source_id:string|null;production_order_id:string|null;
 revision:number;input_snapshot:OrderTimeInput;fixed_targets:Targets;identity_hash:string;business_time:BusinessTime;created_by:string;source_event_ref:string;change_kind:StoredOrderTimePlan['changeKind']};
const identity=(input:OrderTimeInput,targets:Targets)=>fixedTimelineIdentity({input,targets});
function saved(row:Row):StoredOrderTimePlan{
 const input=row.input_snapshot,targets=row.fixed_targets;
 if(input.version!=='order-time-input-v1'||identity(input,targets)!==row.identity_hash)throw Error('本单时间方案版本或校验不受当前程序支持');
 FrozenOrderTimePlanSchema.parse(input.plan);
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
 async confirm(input:{resource:BusinessTimeScope;expectedRevision:number;value:OrderTimeInput;actorId:string;eventRef:string;time:BusinessTime;requestKey:string}):Promise<StoredOrderTimePlan>{
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
  const value=structuredClone(counterpart.input);value.plan={...value.plan,revision:value.plan.revision+1,overrides:{...value.plan.overrides,...updates}};
  await this.append({resource:linked,expectedRevision:counterpart.revision,value,actorId:input.actorId,eventRef:input.eventRef,time:input.time,requestKey:'order-time:linked:'+fixedTimelineIdentity([input.requestKey,linked])},'arrangement');
  return result;
 }
 private async append(input:{resource:BusinessTimeScope;expectedRevision:number;value:OrderTimeInput;actorId:string;eventRef:string;time:BusinessTime;requestKey:string},kind:'arrangement'|'customer_date_change',changedScopes:ReadonlySet<string>=new Set()):Promise<StoredOrderTimePlan>{
  if(!await this.available())throw Error('本单时间方案迁移尚未完成');
  if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||!input.eventRef.trim()||!input.requestKey.trim()||input.requestKey.length>200)throw Error('本单时间方案身份或版本无效');
  const time=validateBusinessTime(input.time),value=structuredClone(input.value);
  if(value.version!=='order-time-input-v1')throw Error('本单时间输入版本不受支持');
  FrozenOrderTimePlanSchema.parse(value.plan);
  const resource=input.resource,table=resource.kind==='source'?'digital_production_sources':'digital_production_orders',column=resource.kind==='source'?'source_id':'production_order_id';
  if(!(await this.db.query(`SELECT ${column} FROM ${table} WHERE ${column}=$1 FOR UPDATE`,[resource.id])).rowCount)throw Error('本单不存在');
  const prior=(await this.db.query('SELECT * FROM digital_order_time_plan_versions WHERE request_key=$1',[input.requestKey])).rows[0];
  if(prior){
   const result=saved(prior);
   if(result.resource.kind!==resource.kind||result.resource.id!==resource.id||result.revision!==input.expectedRevision+1||result.actorId!==input.actorId||result.eventRef!==input.eventRef||fixedTimelineIdentity(result.input)!==fixedTimelineIdentity(value))throw new SlaIdempotencyConflict('本次操作标识已用于其他时间方案');
   return result;
  }
  const previous=await this.current(resource);
  if((previous?.revision??0)!==input.expectedRevision)throw new SlaVersionConflict('本单安排已更新，请刷新后重试');
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
  const row=(await this.db.query(`INSERT INTO digital_order_time_plan_versions(plan_version_id,resource_kind,source_id,production_order_id,revision,input_snapshot,fixed_targets,identity_hash,change_kind,source_event_ref,business_time,created_by,request_key)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[randomUUID(),resource.kind,resource.kind==='source'?resource.id:null,resource.kind==='order'?resource.id:null,input.expectedRevision+1,JSON.stringify(value),JSON.stringify(targets),identity(value,targets),previous?kind:'initial',input.eventRef,JSON.stringify(time),input.actorId,input.requestKey])).rows[0];
  return saved(row);
 }
 /** Called only after the existing PO writer validated authority and persisted
  * the genuine H approval, in that same transaction. The effective policy is
  * captured now, so a later standard/arrangement cannot change this revision.
  */
 async approvedCustomerChange(resource:BusinessTimeScope,actorId:string,eventId:string,time:BusinessTime):Promise<StoredOrderTimePlan|null>{
  const previous=await this.current(resource);if(!previous)return null;
  if(resource.kind!=='order')throw Error('客户PO改期只属于正式订单');
  const rows=(await this.db.query(`SELECT change_id,line_id,old_date::text AS old_date,new_date::text AS new_date FROM digital_po_date_changes
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
   scope.customerGoal=goal;scope.goals={...scope.goals,...Object.fromEntries(scope.customerGoalIds.map(id=>[id,goal]))};changed.add(scope.scopeRef);
  }
  if(!changed.size)return previous;
  return this.append({resource,expectedRevision:previous.revision,value,actorId,eventRef:`audit_events:${eventId}`,time,requestKey:`order-time:customer:${eventId}`},'customer_date_change',changed);
 }
}
