import type {Pool,PoolClient} from 'pg';
import type {BusinessTime,BusinessTimeScope} from '@dx-rework/domain/business-clock';
import type {DigitalTaskCurrentPlan} from '@dx-rework/contracts/digital-production-tasks';
import type {FixedTaskWorkBinding} from './fixed-task-targets.js';
import {OrderTimePlanRepository,type StoredOrderTimePlan} from './order-time-plan-repository.js';
import {arrangedOrderTimeTarget,frameworkTargetPrecision} from './framework-node-targets.js';
import {buildOrderTimeWork} from './order-time-schedule.js';
import {requiredFixedTimelineWork} from './fixed-timeline-targets.js';
import {orderTimeWorkTaskKind} from './order-time-work-task-kind.js';
import {wholeOrderActiveSql} from './whole-order-visibility.js';

type Task={taskId:string;kind:string;routeRef:string;stepRef:string|null;resource:BusinessTimeScope;round:number;state:string;retired:boolean};
type Labels=ReadonlyMap<string,string>;
const unavailable=(reason:string,saved?:StoredOrderTimePlan,state:DigitalTaskCurrentPlan['state']='unknown'):DigitalTaskCurrentPlan=>({state,reason,planVersionId:saved?.id??null,planRevision:saved?.revision??null,targets:[]});

function taskPlanScope(saved:StoredOrderTimePlan,task:Task,binding:FixedTaskWorkBinding){
 const missing=(reason:string,state:DigitalTaskCurrentPlan['state']='unknown')=>({kind:'unavailable' as const,value:unavailable(reason,saved,state)});
 if(task.resource.kind==='order'&&(saved.resource.kind!=='order'||saved.resource.id!==task.resource.id)||saved.resource.kind==='source'&&(task.resource.kind!=='source'||saved.resource.id!==task.resource.id))return missing('当前计划不属于本任务范围');
 if(task.retired||task.state==='cancelled')return missing('原任务已退出当前有效范围','not_applicable');
 const prefix=task.resource.kind==='source'?`source:${task.resource.id}:round:${task.round}:`:`order:${task.resource.id}:`;
 const reference=binding.currentPlanWorkRef??binding.canonicalWorkRef;
 if(!binding.captured||!binding.canonicalWorkRef?.startsWith(prefix)||!reference?.startsWith(prefix))return missing('本任务当前计划的依据尚未核实');
 const matches=saved.input.work.filter(work=>work.canonicalWorkRef===reference);
 if(matches.length!==1){
  const laterRound=task.resource.kind==='source'&&saved.input.work.some(work=>{
   const reference=work.canonicalWorkRef?.match(/^source:([^:]+):round:(\d+):/);return reference?.[1]===task.resource.id&&Number(reference[2])>task.round;
  });
  return missing(matches.length>1?'同一原工作存在多个当前计划对应':'当前生效版本没有本任务的精确工作',laterRound&&!matches.length&&saved.input.route.complete?'not_applicable':'unknown');
 }
 const work=matches[0]!,definitions=buildOrderTimeWork(saved.input.plan,saved.input.work);
 const scopes=saved.input.scopes.filter(scope=>requiredFixedTimelineWork(definitions,scope.terminalIds).some(value=>value.id===work.id));
 if(!scopes.length){
  const included=work.includedIn&&saved.input.scopes.some(scope=>requiredFixedTimelineWork(definitions,scope.terminalIds).some(value=>value.id===work.includedIn));
  return missing(included?'本任务内含于已安排工作，未单列独立计划时间':'当前计划没有本任务的有效交付范围',saved.input.route.complete?'not_applicable':'unknown');
 }
 return {kind:'available' as const,work,scopes,workRef:reference};
}
function scopedTargets(saved:StoredOrderTimePlan,selected:ReturnType<typeof taskPlanScope>,labels:Labels,notStarted:boolean):DigitalTaskCurrentPlan{
 if(selected.kind==='unavailable')return selected.value;
 const {work,scopes,workRef}=selected,targets:DigitalTaskCurrentPlan['targets']=[];
 for(const scope of scopes){
  if(scope.lineId&&!labels.has(scope.lineId))return unavailable('当前计划的PO范围尚未核实',saved);
  const target=arrangedOrderTimeTarget(saved,scope.scopeRef,work.id,notStarted),precision=frameworkTargetPrecision(target);
  targets.push({scopeRef:scope.scopeRef,lineId:scope.lineId,scopeLabel:scope.lineId?labels.get(scope.lineId)!:saved.resource.kind==='source'?'本开发单':'本订单',workRef,
   startAt:target?.start.at??null,endAt:target?.end.at??null,precision:precision.targetPrecision,date:precision.targetDate});
 }
 const ready=saved.input.route.complete&&targets.every(target=>target.endAt!==null);
 return {state:ready?'ready':'unknown',reason:ready?null:'本任务当前计划仍有缺少依据的时间或范围',planVersionId:saved.id,planRevision:saved.revision,targets};
}
export function selectCurrentTaskPlan(saved:StoredOrderTimePlan,task:Task,binding:FixedTaskWorkBinding,labels:Labels=new Map()):DigitalTaskCurrentPlan{
 return scopedTargets(saved,taskPlanScope(saved,task,binding),labels,task.state==='pending');
}

/** Framework-native rounds can predate legacy position rows. Their actual
 * publication root/round route plus a unique eligible native instance proves
 * the relation; neither the latest task nor kind equality alone does. */
async function nativeRoundBinding(db:Pick<Pool|PoolClient,'query'>,task:Task,saved:StoredOrderTimePlan):Promise<FixedTaskWorkBinding|undefined>{
 if(task.resource.kind!=='source')return undefined;
 const root=task.round===1?(await db.query(`SELECT t.route_instance_id AS route_id FROM digital_development_documents d
  JOIN digital_production_tasks t ON t.task_id=d.task_id JOIN digital_production_task_access a ON a.task_id=t.task_id
  WHERE d.source_id=$1 AND a.source_id=$1 AND t.route_version=1`,[task.resource.id])).rows[0]
  :(await db.query('SELECT route_id FROM digital_development_rounds WHERE source_id=$1 AND round_number=$2',[task.resource.id,task.round])).rows[0];
 if(root?.route_id!==task.routeRef)return undefined;
 const kinds=task.kind==='development_material_recheck'||task.kind==='development_materials'?['development_materials','development_material_recheck']:[task.kind];
 const peers=(await db.query(`SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
  LEFT JOIN LATERAL(SELECT r.sla_basis FROM digital_production_deadline_revisions r WHERE r.task_id=t.task_id ORDER BY revision_id DESC LIMIT 1) adopted ON true
  WHERE a.source_id=$1 AND t.route_version=$2 AND t.route_instance_id=$3 AND a.task_kind=ANY($4::text[]) AND t.state<>'cancelled'
   AND ($5::text IS NULL OR adopted.sla_basis->'basis' @> jsonb_build_array('craft-step:'||$5::text))
   AND NOT EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned')
   AND NOT EXISTS(SELECT 1 FROM digital_development_route_facts f WHERE f.task_id=t.task_id AND f.kind='尾查退回')`,[task.resource.id,task.round,task.routeRef,kinds,task.stepRef])).rows;
 if(peers.length!==1||peers[0]!.task_id!==task.taskId)return undefined;
 const prefix=`source:${task.resource.id}:round:${task.round}:`,kind=task.kind==='development_material_recheck'?'development_materials':task.kind;
 const work=saved.input.work.filter(work=>work.canonicalWorkRef?.startsWith(prefix)&&orderTimeWorkTaskKind(work)===kind
  &&(task.stepRef?work.canonicalWorkRef.includes(`:step:${task.stepRef}:`):!work.canonicalWorkRef.includes(':step:')));
 return work.length===1?{canonicalWorkRef:work[0]!.canonicalWorkRef!,captured:true}:undefined;
}

/** Called only after original authorization of this exact native task. Read its
 * confirmed P, never an executable Journey, another work or a historical/latest
 * kind fallback. The original fixed-B read supplies the captured binding. */
export async function currentTaskPlanTargets(db:Pick<Pool|PoolClient,'query'>,task:Task,time:BusinessTime,binding?:FixedTaskWorkBinding):Promise<DigitalTaskCurrentPlan>{
 if(task.retired||task.state==='cancelled')return unavailable('原任务已退出当前有效范围',undefined,'not_applicable');
 const repository=new OrderTimePlanRepository(db);
 if(!await repository.available())return unavailable('本单尚无已生效的当前计划');
 let resource=task.resource;
 if(resource.kind==='source'){
  const active=await wholeOrderActiveSql(db,'order','o.production_order_id');
  const orders=(await db.query(`SELECT o.production_order_id,NOT(${active}) AS retired
   FROM digital_production_orders o WHERE o.source_id=$1`,[resource.id])).rows;
  if(orders.length>1)return unavailable('开发单对应的母单范围尚未核实');
  if(orders[0]?.retired)return unavailable('原任务已退出当前有效范围',undefined,'not_applicable');
  if(orders[0])resource={kind:'order',id:orders[0].production_order_id};
 }
 let saved=await repository.current(resource),exact=binding?.captured&&binding.canonicalWorkRef?binding:saved?await nativeRoundBinding(db,task,saved):undefined;
 // An order can still adopt round1 while a legitimate round2 has its own
 // current source arrangement. Use the order only when it contains this exact
 // captured work; never substitute its older same-kind work or a historical
 // source version. This selects identity, not whichever date happens to exist.
 if(task.resource.kind==='source'&&resource.kind==='order'&&(!saved||!exact||!saved.input.work.some(work=>work.canonicalWorkRef===exact!.canonicalWorkRef))){
  const source=await repository.current(task.resource),own=exact??(source?await nativeRoundBinding(db,task,source):undefined);
  if(source&&own&&source.input.work.some(work=>work.canonicalWorkRef===own.canonicalWorkRef)){saved=source;resource=task.resource;exact=own;}
 }
 if(!saved)return unavailable('本单尚无已生效的当前计划');
 if(saved.time.scenarioId!==time.scenarioId)return unavailable('当前计划与本单业务观察范围不一致',saved);
 if(Date.parse(saved.time.now)>Date.parse(time.now))return unavailable('当前计划生效时间尚未核实',saved);
 if(!exact)return unavailable('本任务当前计划的依据尚未核实',saved);
 const selected=taskPlanScope(saved,task,exact);if(selected.kind==='unavailable')return selected.value;
 const ids=[...new Set(selected.scopes.flatMap(scope=>scope.lineId?[scope.lineId]:[]))],labels=new Map<string,string>();
 if(ids.length&&resource.kind==='order')for(const row of (await db.query(`SELECT line_id,COALESCE(formal_style_no,po_number) AS po,color FROM digital_production_po_lines WHERE production_order_id=$1 AND line_id=ANY($2::uuid[])`,[resource.id,ids])).rows)labels.set(row.line_id,`PO ${row.po??'号码尚未取得'} · ${row.color}`);
 return scopedTargets(saved,selected,labels,task.state==='pending');
}
