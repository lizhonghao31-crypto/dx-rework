import {factoryReturnLogistics} from './factory-return-logistics.js';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {DIGITAL_SLA_PARAMETERS,validateDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import {evaluateSlaPlan} from '@dx-rework/domain/digital-sla-plan';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {isDigitalLeader,digitalForbidden} from './access-policy.js';
import {SlaConfigurationRepository} from './sla-configuration-repository.js';
import {SlaPlanRepository} from './sla-plan-repository.js';
import {SlaOrderService} from './sla-order-service.js';
import {DigitalProductionTaskService} from './task-service.js';
type Selection={orderId:string;configurationVersion:number;parameterKeys:string[];reason:string};
const fail=(message:string):never=>{throw new ApplicationError('DIGITAL_TASK_CONFLICT',message,409);};
const stable=(value:unknown):string=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const digest=(value:unknown)=>createHash('sha256').update(stable(value)).digest('hex');
/** One order per transaction; no all-or-nothing claim for a multi-order batch. */
export class SlaOrderApplicationService{
 constructor(private readonly pool:Pool){}
 private async prepared(db:PoolClient,actor:TrustedActorContext,input:Selection){
  if(!isDigitalLeader(actor))digitalForbidden();
  const keys=[...new Set(input.parameterKeys)].sort();
  if(!keys.length||keys.some(k=>!DIGITAL_SLA_PARAMETERS.some(p=>p.key===k&&!['unlimited','order_date'].includes(p.defaultValue.kind)))||!input.reason.trim())fail('请选择可调整参数并填写原因');
  const repo=new SlaConfigurationRepository(db),configuration=await repo.current();
  if(!configuration||configuration.version!==input.configurationVersion)fail('全局标准已变化，请重新预览');
  if((await db.query("SELECT 1 FROM digital_order_closures WHERE production_order_id=$1 UNION ALL SELECT 1 FROM digital_production_resource_lifecycle WHERE resource_kind='order' AND resource_id=$1 AND state='cancelled'",[input.orderId])).rowCount)fail('已结案或取消的订单不能应用新标准');
  const read=await new SlaOrderService(this.pool).readWithClient(actor,input.orderId,db);
  if(read.status!=='planned')fail('历史订单没有首版计划，不补造历史标准');
  const current=read as Extract<typeof read,{status:'planned'}>,snapshot=await repo.orderSnapshot(input.orderId);
  if(!snapshot)fail('订单冻结标准缺失');
  const tasks=(await db.query(`SELECT t.*,a.task_kind,a.source_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
   WHERE a.production_order_id=$1 OR a.source_id=(SELECT source_id FROM digital_production_orders WHERE production_order_id=$1) ORDER BY t.task_id`,[input.orderId])).rows;
  if(keys.some(k=>DIGITAL_SLA_PARAMETERS.find(p=>p.key===k)?.stage===2)||keys.includes('warning_ratio')){
   const shared=(await db.query(`SELECT count(*)::int AS n FROM digital_production_orders WHERE source_id=(SELECT source_id FROM digital_production_orders WHERE production_order_id=$1)`,[input.orderId])).rows[0];
   if(shared.n>1)fail('关联开发单被多个母单共用，不能单独改写其时效');
  }
  const next=structuredClone(snapshot!.snapshot),skipped:string[]=[];
  for(const key of keys){
   if(next.parameters[key]!.source!=='global'){skipped.push(key);continue;}
   next.parameters[key]={value:configuration.values[key]!,source:'global',sourceVersion:configuration.version};
  }
  validateDigitalSlaSnapshot(next);
  const effectiveKeys=keys.filter(k=>!skipped.includes(k)&&stable(next.parameters[k]!.value)!==stable(snapshot!.snapshot.parameters[k]!.value));
  if(!effectiveKeys.length)fail('所选标准没有可应用的数值变化');
  const plan=structuredClone(current.current.plan),completed=(id:string)=>!!(current.facts[id]?.businessCompleted||current.facts[id]?.completedAt);
  for(const node of plan.nodes){if(completed(node.id)||!effectiveKeys.includes(node.parameterKey))continue;const value=next.parameters[node.parameterKey]!.value;node.minutes='minutes'in value?value.minutes:null;node.offsetDays='days'in value?value.days:null;}
  if(effectiveKeys.includes('warning_ratio')){const v=next.parameters.warning_ratio!.value;if(v.kind==='ratio')plan.warningPercent=v.percent;}
  if(effectiveKeys.includes('stage_buffer')){const v=next.parameters.stage_buffer!.value;if(v.kind==='buffer')plan.stageBufferMinutes=v.minutes;}
  const logistics=await factoryReturnLogistics(db,input.orderId);
  const sourcing=(await db.query(`SELECT t.entity_id,t.category,bool_and(t.status IN ('completed','cancelled')) AS terminal FROM rework_todos t
   JOIN digital_production_child_links l ON l.module='sourcing' AND l.child_id::text=t.entity_id AND l.production_order_id=$1
   WHERE t.entity_type='sourcing_case' AND t.todo_type='business_action' GROUP BY t.entity_id,t.category`,[input.orderId])).rows;
  const completedWindows=[...logistics.filter(l=>l.hasReceived).map(l=>l.windowKey),...sourcing.filter(t=>t.terminal).map(t=>`sourcing:${t.entity_id}:${t.category}`),...tasks.filter(t=>['completed','cancelled'].includes(t.state)).map(t=>`task:${t.task_id}`),
   ...(current.factory?.windows.filter(w=>w.complete).map(w=>`factory:${w.kind}:${w.key}`)??[]),
   ...current.garments.windows.filter(w=>w.complete).map(w=>`receipt:${w.receiptId}`),
   ...current.rework.windows.filter(w=>w.complete).map(w=>w.windowKey),
   ...current.receiving.lines.filter(l=>l.packingQuantity!==null&&l.packingQuantity>=l.orderedQuantity).map(l=>`packing:${l.lineId}`),
   ...Object.keys(current.facts).filter(completed).map(id=>`node:${id}`),
   ...Object.keys(current.facts).filter(id=>id.startsWith('ship_sample:')&&completed(id)).map(id=>`sample:${id.split(':')[1]}`)];
  const token=digest({actor:actor.actorId,input:{...input,parameterKeys:keys},configuration:configuration.version,snapshot:snapshot!.snapshotId,
   planId:current.current.planId,facts:current.facts,receiving:current.receiving.revision,tasks,clock:{scenarioId:current.time.scenarioId,revision:current.time.revision}});
  // Preview duration changes against the same actual starts; batch projections are recalculated after the explicit reference is saved.
  const previewFacts=structuredClone(current.facts);
  for(const node of plan.nodes)if(!completed(node.id)&&effectiveKeys.includes(node.parameterKey)&&previewFacts[node.id]){
   if(node.minutes!==null)previewFacts[node.id]!.standardMinutes=node.minutes;
   for(const w of previewFacts[node.id]!.batchWindows??[])if(!w.complete&&w.startedAt&&node.minutes!==null){w.deadline=new Date(Date.parse(w.startedAt)+node.minutes*60000).toISOString();w.warningAt=new Date(Date.parse(w.startedAt)+node.minutes*60000*plan.warningPercent/100).toISOString();}
  }
  const after=evaluateSlaPlan({...current.evaluationPlan,nodes:current.evaluationPlan.nodes.map(n=>({...n,minutes:plan.nodes.find(p=>p.id===n.id)?.minutes??n.minutes,offsetDays:plan.nodes.find(p=>p.id===n.id)?.offsetDays??n.offsetDays})),warningPercent:plan.warningPercent,stageBufferMinutes:plan.stageBufferMinutes},previewFacts,current.time);
  const changes=after.filter(n=>!completed(n.id)&&effectiveKeys.some(k=>k===plan.nodes.find(p=>p.id===n.id)?.parameterKey||['warning_ratio','stage_buffer'].includes(k))).map(n=>({nodeId:n.id,label:plan.nodes.find(p=>p.id===n.id)?.label,before:current.nodes.find(old=>old.id===n.id),after:n}));
  if(!changes.length)fail('所选节点均已完成或不适用，没有未完成节点可调整');
  return {repo,configuration,snapshot:snapshot!,current,next,plan,token,completedWindows,effectiveKeys,changes,skipped};
 }
 async preview(actor:TrustedActorContext,input:Selection){
  const db=await this.pool.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const p=await this.prepared(db,actor,input);await db.query('COMMIT');return {orderId:input.orderId,token:p.token,changes:p.changes,skipped:p.skipped,configurationVersion:p.configuration.version};}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 async apply(actor:TrustedActorContext,input:Selection&{previewToken:string},key:string){
  if(!isDigitalLeader(actor))digitalForbidden();
  const db=await this.pool.connect();try{
   await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   const command=`sla-apply:${input.orderId}`,hash=digest(input),prior=(await db.query('SELECT * FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior){if(prior.payload_hash!==hash)fail('同一操作标识不能用于另一份预览');await db.query('COMMIT');return prior.response;}
   const {previewToken,...selection}=input,p=await this.prepared(db,actor,selection);
   if(previewToken!==p.token)fail('订单事实、计划或标准已变化，请重新预览');
   const saved=await p.repo.appendOrder({orderId:input.orderId,expectedRevision:p.snapshot.revision,configurationId:p.configuration.configurationId,snapshot:p.next,actorId:actor.actorId,reason:input.reason,requestKey:randomUUID()});
   const plan=await new SlaPlanRepository(db).appendPlan({orderId:input.orderId,expectedRevision:p.current.current.revision,snapshotId:saved.snapshotId,plan:p.plan,time:p.current.time,actorId:actor.actorId,reason:input.reason,requestKey:randomUUID()});
   const eventId=randomUUID();await db.query(`INSERT INTO digital_production_task_events(event_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload)
    VALUES($1,'order',$2,'sla_standard_applied',$3,$4,'现场登记',$5)`,[eventId,input.orderId,actor.actorId,p.current.time.now,JSON.stringify({snapshotId:saved.snapshotId,parameterKeys:p.effectiveKeys,completedWindows:p.completedWindows,planId:plan.planId,previousPlanId:p.current.current.planId,reason:input.reason,previousEvaluations:p.current.nodes})]);
   await new DigitalProductionTaskService(this.pool).applySlaVersionWithClient(db,actor,input.orderId,eventId,p.effectiveKeys);
   const response={orderId:input.orderId,snapshotId:saved.snapshotId,planId:plan.planId,applicationId:eventId,changedNodes:p.changes.length,skipped:p.skipped};
   await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(response)]);
   await db.query('COMMIT');return response;
  }catch(e){await db.query('ROLLBACK');if((e as {code?:string}).code==='40001')fail('订单正在变化，本单未应用，请重新预览');throw e;}finally{db.release();}
 }
}
