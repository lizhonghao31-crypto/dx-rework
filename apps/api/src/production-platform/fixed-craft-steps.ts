import type {PoolClient} from 'pg';
import {CraftStepChoicesSchema,type AdoptedCraftStep,type CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import type {BusinessTimeScope} from '@dx-rework/domain/business-clock';
import type {FixedTimelineAdoption} from './fixed-timeline-adoptions.js';
import {readFixedOrderRoute} from './fixed-order-route.js';

type DB=Pick<PoolClient,'query'>;
export async function fixedCraftSteps(db:DB,routeRef:string):Promise<AdoptedCraftStep[]>{
 if(!(await db.query("SELECT to_regclass('digital_timeline_craft_steps') AS relation")).rows[0]?.relation)return [];
 return (await db.query(`SELECT step_id AS "stepId",craft_kind AS "craftKind",sequence,scope_ref AS "scopeRef",canonical_work_ref AS "canonicalWorkRef",
  planning_parameter_ref AS "planningParameterRef",planning_minutes::float8 AS "planningMinutes",calendar_ref AS "calendarRef",
  responsibility_sla_ref AS "responsibilitySlaRef",responsibility_minutes::float8 AS "responsibilityMinutes",responsibility_calendar AS "responsibilityCalendar",adopted_version AS "adoptedVersion"
  FROM digital_timeline_craft_steps WHERE route_ref=$1 OR route_ref IN
   (SELECT canonical_route_ref FROM digital_timeline_order_routes WHERE route_ref=$1) ORDER BY sequence`,[routeRef])).rows;
}
/** Only called inside the original authorized route publication/creation.
 * A missing adopted planning/SLA value stays missing, never96h or84+84 by guess.
 */
export async function captureFixedCraftSteps(db:DB,saved:FixedTimelineAdoption,resource:BusinessTimeScope,routeRef:string,round:number,choices:readonly CraftStepChoice[],actorId:string,eventRef:string){
 const chosen=CraftStepChoicesSchema.parse(choices.map(({craftKind,sequence})=>({craftKind,sequence}))),existing=await fixedCraftSteps(db,routeRef);
 const scope=saved.input.sourceVersions.routeRef===routeRef?null:await readFixedOrderRoute(db,saved,routeRef);
 const frozen=scope?.craftSteps??saved.input.craftSteps,workItems=scope?.work.length?scope.work:saved.input.work;
 if(!frozen||frozen.length!==chosen.length||frozen.some((step,index)=>step.craftKind!==chosen[index]?.craftKind||step.sequence!==chosen[index]?.sequence)||saved.input.sourceVersions.routeRef!==routeRef&&!scope)throw Error('工艺步骤须沿本次原冻结路线，不能使用后来资料替换');
 if(existing.length){
  if(existing.length!==chosen.length||existing.some((step,index)=>step.craftKind!==chosen[index]?.craftKind||step.sequence!==chosen[index]?.sequence))throw Error('本路线工艺已采用，不能覆盖原步骤');
  return existing;
 }
 if(resource.kind!==saved.input.resource.kind||resource.id!==saved.input.resource.id||!eventRef.trim())throw Error('工艺采用与原冻结范围不一致');
 for(const choice of frozen){
  const parameterKey=`${resource.kind==='source'?'development':'bulk'}_${choice.craftKind}`,work=workItems.find(work=>work.parameterKey===parameterKey&&!work.includedIn);
  // These refs come only from this object's original adoption input. In
  // particular the historical combined key cannot become two personal SLAs.
  const source=saved.input.unified.values.parameters[parameterKey],originalMinutes=chosen.length===1&&source&&'minutes'in source.value?source.value.minutes:null,single=originalMinutes!==null;
  const minutes=work?work.minutes:originalMinutes,calendar=work?work.calendar:single?'continuous':null;
  const ref=work?work.planningParameterRef:single?`${saved.input.unified.snapshotRef}:${parameterKey}`:null;
  const scopeRef=`${resource.kind}:${resource.id}:round:${round}:route:${routeRef}:craft:${choice.craftKind}`;
  await db.query(`INSERT INTO digital_timeline_craft_steps(step_id,adoption_id,resource_kind,source_id,production_order_id,route_ref,round_number,craft_kind,sequence,scope_ref,canonical_work_ref,planning_parameter_ref,planning_minutes,calendar_ref,responsibility_sla_ref,adopted_version,source_event_ref,created_by,responsibility_minutes,responsibility_calendar)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$20,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
   [choice.stepId,saved.adoptionId,resource.kind,resource.kind==='source'?resource.id:null,resource.kind==='order'?resource.id:null,routeRef,round,choice.craftKind,choice.sequence,scopeRef,ref,minutes,calendar,
    work?work.responsibilitySlaRef:single?`${saved.input.unified.snapshotRef}:${parameterKey}`:null,saved.identityHash,eventRef,actorId,
    work?work.responsibilityMinutes??null:single?originalMinutes:null,work?work.responsibilityCalendar??null:single?'continuous':null,work?.canonicalWorkRef??scopeRef]);
 }
 return fixedCraftSteps(db,routeRef);
}
export async function fixedTaskPosition(db:DB,taskId:string){
 if(!(await db.query("SELECT to_regclass('digital_timeline_task_positions') AS relation")).rows[0]?.relation)return null;
 return (await db.query('SELECT * FROM digital_timeline_task_positions WHERE task_id=$1',[taskId])).rows[0]??null;
}
