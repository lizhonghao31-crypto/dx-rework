import {externalPatternRecords} from './development-external-pattern-facts.js';
import type {PoolClient} from 'pg';
import {DevelopmentCycleValuesSchema,DEVELOPMENT_TECHNICAL_RULE,type DevelopmentCycleStatus} from '@dx-rework/contracts/digital-development-technical';
import {calculateDevelopmentCycle} from '@dx-rework/domain/development-cycle';
import {technicalEnrollment,type TechnicalDB} from './development-technical-repository.js';
import type {DevelopmentTiming} from './development-task-timing.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {orderTimeAdmission} from './order-time-admission.js';
import {OrderTimePlanRepository} from './order-time-plan-repository.js';
import {OrderTimeRuleSchema,orderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {scheduleElapsed} from './fixed-schedule-progress.js';
import {shiftFixedTimeline} from './fixed-timeline-targets.js';

const cycleValues=(value:Record<string,unknown>)=>DevelopmentCycleValuesSchema.parse(Object.fromEntries(Object.entries(value).filter(([key])=>key!=='orderTimeCycle')));

export async function captureTechnicalEnrollment(db:PoolClient,actorId:string,sourceId:string,eventKey:string){
 if(!(await db.query("SELECT to_regclass('digital_development_technical_enrollments') AS relation")).rows[0]?.relation)return;
 if(!(await db.query("SELECT 1 FROM audit_events WHERE id=$1 AND entity_id=$2 AND ((action='digital_source_created' AND actor_id=$3::uuid) OR (action='digital_development_first_published' AND after_state->>'createdBy'=$3::text))",[eventKey,sourceId,actorId])).rowCount)throw Error('Technical enrollment requires real source creation');
 const policy=(await db.query('SELECT * FROM digital_development_cycle_standards ORDER BY version DESC LIMIT 1')).rows[0];
 const values=DevelopmentCycleValuesSchema.parse(policy.values_json);
 await db.query(`INSERT INTO digital_development_technical_enrollments(source_id,rule_version,policy_version,values_json,created_by,event_key)
  VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source_id) DO NOTHING`,[sourceId,DEVELOPMENT_TECHNICAL_RULE,policy.version,JSON.stringify(values),actorId,eventKey]);
}
export async function captureTechnicalRound(db:PoolClient,actorId:string,sourceId:string,round:number,publishedAt:string,internalWashMinutes:number,warningRatio:number){
 const enrolled=await technicalEnrollment(db,sourceId);if(!enrolled)return;
 const plan=orderTimeAdmission(db)?.plan??(await new OrderTimePlanRepository(db).current({kind:'source',id:sourceId}))?.input.plan;
 const values=plan?{...enrolled.values_json,orderTimeCycle:{version:'order-time-cycle-v1',normal:orderTimeRule(plan,'development_cycle_normal')?.rule??null,urgent:orderTimeRule(plan,'development_cycle_urgent')?.rule??null}}:enrolled.values_json;
 await db.query(`INSERT INTO digital_development_cycle_rounds(source_id,round_number,published_at,policy_version,values_json,internal_wash_minutes,warning_ratio,created_by)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,[sourceId,round,publishedAt,enrolled.policy_version,values,internalWashMinutes,warningRatio,actorId]);
}
export async function developmentCycleEvidence(db:TechnicalDB,sourceId:string,round:number,now:string):Promise<DevelopmentCycleStatus|null>{
 if(!await technicalEnrollment(db,sourceId))return null;
 const saved=(await db.query('SELECT * FROM digital_development_cycle_rounds WHERE source_id=$1 AND round_number=$2',[sourceId,round])).rows[0];if(!saved)return null;
 const values=cycleValues(saved.values_json);
 const urgent=(await db.query('SELECT * FROM digital_development_urgent_events WHERE source_id=$1 AND round_number=$2 ORDER BY revision DESC LIMIT 1',[sourceId,round])).rows[0];
 const approved=Boolean((await db.query("SELECT 1 FROM digital_development_urgent_events WHERE source_id=$1 AND round_number=$2 AND action='approve'",[sourceId,round])).rowCount);
 const completed=(await db.query(`SELECT t.completed_at,t.completed_quality FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
  JOIN digital_development_route_facts f ON f.task_id=t.task_id AND f.kind='尾查通过'
  WHERE a.source_id=$1 AND t.route_version=$2 AND a.task_kind IN ('development_tail_check','development_patch_tail_check')
   AND t.state='completed' ORDER BY t.completed_at NULLS LAST,t.task_id LIMIT 1`,[sourceId,round])).rows[0];
 const completedAt=completed?.completed_at&&['现场登记','已核实'].includes(completed.completed_quality)?new Date(completed.completed_at).toISOString():null;
 const intervals=(await db.query(`SELECT DISTINCT ON(i.interval_id) i.*,t.state AS task_state,t.completed_at AS task_returned_at,t.completed_quality AS task_return_quality FROM digital_development_external_intervals i
  LEFT JOIN digital_production_tasks t ON t.task_id=i.source_task_id WHERE i.source_id=$1 AND i.round_number=$2 ORDER BY i.interval_id,i.version DESC`,[sourceId,round])).rows;
 const externalPapers=(await externalPatternRecords(db,sourceId)).filter(r=>r.roundNumber===round);
 const manual=intervals.map(i=>({id:i.interval_id,
   departedAt:i.departed_at?new Date(i.departed_at).toISOString():null,
   returnedAt:i.source_task_id&&i.task_state==='completed'?(i.task_returned_at?new Date(i.task_returned_at).toISOString():null):i.returned_at?new Date(i.returned_at).toISOString():null,
   credible:['现场登记','已核实'].includes(i.time_quality)&&(i.task_state!=='completed'||['现场登记','已核实'].includes(i.task_return_quality)),closed:Boolean(i.returned_at)||i.task_state==='completed'||i.task_state==='cancelled'}));
 for(const paper of externalPapers)if(!intervals.some(i=>i.external_pattern_request_id===paper.requestId))manual.push({id:paper.requestId,departedAt:null,returnedAt:paper.receivedAt?new Date(paper.receivedAt).toISOString():null,credible:false,closed:!!paper.receivedAt});
 const document=await developmentDocumentRow(db,sourceId,round);
 const departures=(await db.query(`SELECT f.fact_id,f.kind,f.payload,t.completed_at,t.completed_quality,t.route_instance_id
  FROM digital_development_route_facts f JOIN digital_production_tasks t ON t.task_id=f.task_id WHERE f.source_id=$1 AND f.route_version=$2
   AND t.state='completed' AND (f.kind='发工艺' AND f.payload->>'craftExecution'='外发' OR f.kind='洗水送出')`,[sourceId,round])).rows;
 const native=[];
 for(const sent of departures){
  if(sent.kind==='洗水送出'&&document?.document.washing!=='外洗')continue;
  const returned=(await db.query(`SELECT t.state,t.completed_at,t.completed_quality FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
   WHERE a.source_id=$1 AND t.route_version=$2 AND t.route_instance_id=$3 AND a.task_kind=ANY($4::text[]) ORDER BY t.created_at DESC LIMIT 1`,[sourceId,round,sent.route_instance_id,sent.kind==='发工艺'?['development_printing','development_embroidery','development_print_embroidery']:['development_washing']])).rows[0];
  native.push({id:`native:${sent.fact_id}`,departedAt:sent.completed_at?new Date(sent.completed_at).toISOString():null,returnedAt:returned?.completed_at?new Date(returned.completed_at).toISOString():null,
   credible:['现场登记','已核实'].includes(sent.completed_quality)&&(!returned?.completed_at||['现场登记','已核实'].includes(returned.completed_quality)),closed:returned?.state==='completed'||returned?.state==='cancelled'});
 }
 const perOrder=saved.values_json.orderTimeCycle,selected=perOrder?OrderTimeRuleSchema.nullable().parse(approved?perOrder.urgent:perOrder.normal):null;
 if(perOrder&&perOrder.version!=='order-time-cycle-v1')throw Error('本轮开发周期版本不受支持');
 const calendar=perOrder?selected?.calendar??null:null,minutes=selected?.kind==='supervision'?selected.minutes:null;
 const result=calculateDevelopmentCycle({publishedAt:new Date(saved.published_at).toISOString(),completedAt,internalCompleted:!!completed,
  now,allowedDays:perOrder?calendar&&minutes!==null?minutes/1440:null:approved?values.urgentDays:values.normalDays,warningRatio:selected?selected.reminder.percent/100:Number(saved.warning_ratio),intervals:[...manual,...native]},calendar?{
   elapsedSeconds:(from,to)=>scheduleElapsed(from,to,calendar)*60,
   shiftSeconds:(from,seconds)=>Date.parse(shiftFixedTimeline(new Date(from).toISOString(),seconds/60,calendar)),
  }:undefined);
 return {ruleVersion:DEVELOPMENT_TECHNICAL_RULE,policyVersion:saved.policy_version,roundNumber:round,mode:approved?'urgent':'normal',
  publishedAt:new Date(saved.published_at).toISOString(),completedAt,internalCompleted:!!completed,
  internalSeconds:result.internalSeconds,excludedSeconds:result.excludedSeconds,allowedSeconds:result.allowedSeconds,state:result.state,
  precisionReasons:result.openExternal?[...result.precisionReasons,'真实外发进行中，截止随实际回收更新']:result.precisionReasons,dueAt:result.dueAt,
  ...(perOrder?{calendarRef:calendar}:{}),urgentRevision:urgent?.revision??0,urgentState:urgent?.action==='approve'?'approved':urgent?.action==='reject'?'rejected':urgent?'requested':'none'};
}
/** New scoped policies do not alter the old global catalog or its immutable snapshots. */
export async function technicalDevelopmentTiming(db:TechnicalDB,task:{task_id:string;source_id:string|null;task_kind:string;route_version:number}):Promise<DevelopmentTiming|null>{
 if(!task.source_id||!['development_size_review','development_washing','development_patch_tail_check'].includes(task.task_kind))return null;
 const enrolled=await technicalEnrollment(db,task.source_id);if(!enrolled)return null;
 const saved=(await db.query('SELECT * FROM digital_development_cycle_rounds WHERE source_id=$1 AND round_number=$2',[task.source_id,task.route_version])).rows[0];if(!saved)return null;
 const values=cycleValues(saved.values_json);
 const basis=[`development-technical:${task.source_id}:${task.route_version}:policy:${saved.policy_version}`];
 let enteredAt:string|null=null,seconds:number|null=null;
 if(task.task_kind==='development_size_review'){
  const request=(await db.query('SELECT requested_at,final_comment_id FROM digital_development_size_review_requests WHERE task_id=$1',[task.task_id])).rows[0];
  if(request){enteredAt=new Date(request.requested_at).toISOString();basis.push(`final-comment:${request.final_comment_id}`);}seconds=values.sizeReviewHours*3600;
 }else if(task.task_kind==='development_patch_tail_check'){
  const prior=(await db.query(`SELECT t.completed_at,t.task_id FROM digital_development_patch_tasks p
   JOIN digital_development_patch_tasks work ON work.issue_id=p.issue_id AND work.purpose='work'
   JOIN digital_production_tasks t ON t.task_id=work.task_id WHERE p.task_id=$1 AND t.state='completed' AND t.completed_quality IN ('现场登记','已核实')`,[task.task_id])).rows[0];
  if(prior){enteredAt=new Date(prior.completed_at).toISOString();basis.push(`patch-work:${prior.task_id}`);}
  const original=(await db.query(`SELECT p.parameters_json FROM digital_development_sla_plans p WHERE p.source_id=$1 ORDER BY revision DESC LIMIT 1`,[task.source_id])).rows[0];
  seconds=(original?.parameters_json?.development_tail_check?.value?.minutes??30)*60;
 }else{
  const doc=await developmentDocumentRow(db,task.source_id,task.route_version);
  if(doc?.document.washing!=='外洗')return null;
  const before=(await db.query(`SELECT t.completed_at,t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
   WHERE a.source_id=$1 AND t.route_version=$2 AND a.task_kind='development_pre_wash_check' AND t.state='completed' AND t.completed_quality IN ('现场登记','已核实') ORDER BY t.completed_at DESC LIMIT 1`,[task.source_id,task.route_version])).rows[0];
  if(before){enteredAt=new Date(before.completed_at).toISOString();basis.push(`pre-wash:${before.task_id}`);}seconds=values.externalWashDays*86400;
 }
 const original=(await db.query('SELECT configuration_id FROM digital_development_sla_plans WHERE source_id=$1 ORDER BY revision DESC LIMIT 1',[task.source_id])).rows[0];
 return {sourceId:task.source_id,sourceRevision:saved.round_number,configurationId:original?.configuration_id??`${DEVELOPMENT_TECHNICAL_RULE}:${saved.policy_version}`,parameterKey:task.task_kind,
  enteredAt,seconds,warningRatio:Number(saved.warning_ratio),basis};
}
