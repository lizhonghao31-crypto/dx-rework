import type {Pool,PoolClient} from 'pg';
import type {BusinessTimeScope} from '@dx-rework/domain/business-clock';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import {FixedTimelineAdoptionRepository} from './fixed-timeline-adoptions.js';
import type {FixedTimelineTarget} from './fixed-timeline-targets.js';
import {readFixedOrderRoute} from './fixed-order-route.js';
export type FixedTaskWorkBinding={canonicalWorkRef:string|null;captured:boolean};

/** Caller has already authorized this exact task. Read only that work's B;
 * never expose another task's facts, adopted settings or consumer permissions.
 * Native enteredAt/dueAt remain its independent responsibility window R/D. */
export async function fixedTaskTargets(db:Pick<Pool|PoolClient,'query'>,task:{taskId:string;resource:BusinessTimeScope;round:number;routeRef:string;kind:string},capture?:(binding:FixedTaskWorkBinding)=>void):Promise<DigitalTask['plannedTargets']>{
 const repository=new FixedTimelineAdoptionRepository(db),current=await repository.currentTargets(task.resource,task.round);
 if(!current)return undefined;
 const saved=current.adoption;
 const position=(await db.query('SELECT adoption_id,route_ref,route_version,route_position,step_id,phase FROM digital_timeline_task_positions WHERE task_id=$1',[task.taskId])).rows[0];
 if(position&&position.adoption_id!==saved.adoptionId)return {state:'pending',targets:[]};
 const route=task.resource.kind==='order'?await readFixedOrderRoute(db,saved,task.routeRef):null;
 const definition=(route?.route??saved.input.route??[]).find(value=>value.position===Number(position?.route_position));
 const key=task.kind==='bulk_cutting_external'?'bulk_cutting':task.kind;
 const added=route?.work.filter(work=>(work.parameterKey??work.id)===key)??[];
 const candidates=position?definition?[definition.nodeId]:[]:added.length?added.map(work=>work.id):saved.input.work.filter(work=>(work.parameterKey??work.id)===key).map(work=>work.id);
 if(candidates.length!==1)return {state:'pending',targets:[]};
 const nodeId=candidates[0]!,targets:NonNullable<DigitalTask['plannedTargets']>['targets']=[];
 const ownWork=(route?.work??saved.input.work).find(work=>work.id===nodeId);
 capture?.({canonicalWorkRef:ownWork?.canonicalWorkRef??null,captured:Boolean(position&&definition&&position.route_ref===task.routeRef&&Number(position.route_version)===task.round
  &&(definition.kind===task.kind||definition.kind==='bulk_cutting'&&task.kind==='bulk_cutting_external')&&(position.step_id??null)===(definition.stepId??null)&&(position.phase??null)===(definition.phase??null))});
 for(const scope of current.scopes){
  const target=(scope.targets_json as FixedTimelineTarget[]).find(value=>value.id===nodeId);if(!target)continue;
  const goal=scope.goal_anchor?.[nodeId],date=goal?.precision==='date'?goal.value:null;
  targets.push({scopeRef:scope.scope_ref,lineId:scope.line_id??null,targetRevision:`${saved.adoptionId}:${scope.revision}`,startAt:target.start.at,endAt:target.end.at,precision:date?'date':'instant',date});
 }
 return {state:targets.length&&targets.every(target=>target.startAt&&target.endAt)?'ready':'pending',targets};
}
