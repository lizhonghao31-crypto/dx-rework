import type {PoolClient} from 'pg';
import type {DevelopmentTiming} from './development-task-timing.js';
import {fixedTaskPosition} from './fixed-craft-steps.js';
import {FixedTimelineAdoptionRepository} from './fixed-timeline-adoptions.js';
import {nativeTaskReadiness} from './task-readiness-facts.js';

type DB=Pick<PoolClient,'query'>;
export const FIXED_DEVELOPMENT_CRAFT_TASKS=new Set(['development_craft_dispatch','development_embroidery','development_printing','development_craft_confirmation']);
/** Independent craft clocks use their own saved scope and native predecessor
 * events. Missing adopted dual-craft responsibility is an explicit unrated
 * result, so the historical combined96/168h cannot reappear as a fallback.
 */
export async function fixedCraftTiming(db:DB,task:{task_id:string;source_id:string|null;task_kind:string;route_version:number},options:{prerequisitesOnly?:boolean}={}):Promise<DevelopmentTiming|null>{
 if(!task.source_id||!FIXED_DEVELOPMENT_CRAFT_TASKS.has(task.task_kind))return null;
 const position=await fixedTaskPosition(db,task.task_id);if(!position?.step_id)return null;
 const saved=await new FixedTimelineAdoptionRepository(db).existing({kind:'source',id:task.source_id},task.route_version);
 if(!saved||saved.input.sourceVersions.routeRef!==position.route_ref)throw Error('工艺任务与原冻结路线不一致');
 const node=saved.input.route?.find(row=>row.position===Number(position.route_position)),work=saved.input.work.find(work=>work.id===node?.nodeId);
 if(!node||!work)throw Error('工艺任务缺少本步骤采用输入');
 // The dispatch is contained in its parent window. The parent's clock starts
 // when that dispatch's complete prerequisites became true, not after dispatch.
 const basisTask=position.phase==='work'?(await db.query('SELECT task_id FROM digital_timeline_task_positions WHERE route_ref=$1 AND route_version=$2 AND step_id=$3 AND phase=\'dispatch\'',[position.route_ref,task.route_version,position.step_id])).rows[0]?.task_id:task.task_id;
 const rows=basisTask?(await db.query(`SELECT p.task_id,p.state,p.completed_at,p.completed_quality FROM digital_production_task_dependencies d JOIN digital_production_tasks p ON p.task_id=d.predecessor_id WHERE d.task_id=$1 AND p.node_key<>'factory_material_count'`,[basisTask])).rows:[];
 const known=rows.length>0&&rows.every(row=>row.state==='completed'&&row.completed_at&&['现场登记','已核实'].includes(row.completed_quality));
 let enteredAt=known?new Date(Math.max(Date.parse(saved.time.now),...rows.map(row=>new Date(row.completed_at).getTime()))).toISOString():null;
 const ready=await nativeTaskReadiness(db,[task.task_id,...(basisTask&&basisTask!==task.task_id?[basisTask]:[])]);
 if(options.prerequisitesOnly&&position.phase==='work'){
  const parent=ready.get(basisTask);if(parent?.tracked)enteredAt=parent.firstReadyAt;
 }else if(!options.prerequisitesOnly){
  // Only the native write records first readiness. A later GET must not infer
  // an unrecorded history or move it after reassignment/ordinary restoration.
  const own=ready.get(task.task_id);enteredAt=own?.tracked?own.firstReadyAt:null;
 }
 const warning=saved.input.unified.values.parameters.warning_ratio?.value;
 const step=saved.input.craftSteps!.find(step=>step.stepId===position.step_id)!;
 const reminder=step.specialCraft?.definition.development.reminder;
 return {sourceId:task.source_id,sourceRevision:saved.input.originalPlan.revision,configurationId:String(saved.input.sourceVersions.configurationId),
  parameterKey:work.parameterKey??task.task_kind,enteredAt,seconds:work.responsibilitySlaRef&&work.responsibilityMinutes!=null&&work.responsibilityCalendar?work.responsibilityMinutes*60:null,calendarRef:work.responsibilityCalendar??null,
  warningRatio:reminder?reminder.percent/100:warning?.kind==='ratio'?warning.percent/100:0.7,...(reminder?{notificationEnabled:reminder.enabled}:{}),...(step.specialCraft?{craftLabel:step.specialCraft.definition.name+(position.phase==='dispatch'?' · 发出':position.phase==='confirmation'?' · 回样确认':'')}:{}),basis:[`craft-step:${position.step_id}`,`craft-kind:${saved.input.craftSteps!.find(step=>step.stepId===position.step_id)!.craftKind}`,`adoption:${saved.adoptionId}`,...rows.map(row=>`task:${row.task_id}:completed`)]};
}
