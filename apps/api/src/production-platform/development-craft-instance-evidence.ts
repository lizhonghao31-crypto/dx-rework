import type {SlaNodeFact,SlaTime} from '@dx-rework/domain/digital-sla-plan';
import type {BusinessTime} from '@dx-rework/domain/business-clock';

export type DevelopmentCraftInstance={sourceId:string;taskId:string;round:number;routeRef:string;stepRef:string|null;taskKind:string;definitionId:string;state:string;eligible:boolean;fact:SlaNodeFact;deadline:SlaTime;warningAt:string|null};
export type DevelopmentCraftRow={task_id:string;route_version:number;route_instance_id?:string;task_kind:string;state:string;entered_at:Date|string|null;entered_quality?:string;completed_at:Date|string|null;completed_quality:string;due_at:Date|string|null;warning_at?:Date|string|null;sla_basis:Record<string,unknown>|null;returned:boolean;rejected:boolean;correction_id?:string|null;predecessor_ids?:string[];
 instance_entered_at?:Date|string|null;instance_due_at?:Date|string|null;instance_warning_at?:Date|string|null;instance_sla_basis?:Record<string,unknown>|null};
const aliases:Record<string,string>={development_craft_confirmation:'development_craft_return'};
const kinds=new Set(['development_craft_dispatch','development_printing','development_embroidery','development_print_embroidery','development_craft_confirmation']);
const at=(value:Date|string|null|undefined)=>value==null?null:new Date(value).toISOString();
const trusted=(value:Date|string|null|undefined,quality:string|undefined,time:BusinessTime,onFutureEvidence?:((at:string)=>void))=>{
 if(!value||!['现场登记','已核实'].includes(quality??''))return null;
 const result=at(value)!;if(Date.parse(result)>Date.parse(time.now)){onFutureEvidence?.(result);return null;}return result;
};
const current=<T>(row:DevelopmentCraftRow,key:keyof DevelopmentCraftRow,fallback:T):T=>Object.hasOwn(row,key)?row[key] as T:fallback;
/** Read the already captured native window. A kind is never an instance ID;
 * missing own times or a missing own confirmation cannot borrow a sibling. */
export function developmentCraftInstances(sourceId:string,rows:readonly DevelopmentCraftRow[],time:BusinessTime,onFutureEvidence?:(at:string)=>void):DevelopmentCraftInstance[]{
 const result:DevelopmentCraftInstance[]=[];
 for(const row of rows){
  if(!kinds.has(row.task_kind))continue;
  const basis=current(row,'instance_sla_basis',row.sla_basis),identity=[basis,row.sla_basis].flatMap(value=>Array.isArray(value?.basis)?value.basis.filter((ref):ref is string=>typeof ref==='string'&&ref.startsWith('craft-step:')).map(ref=>ref.slice(11)):[]),steps=[...new Set(identity)];
  if(!steps.length)continue;
  const validIdentity=steps.length===1&&Boolean(steps[0])&&Boolean(row.route_instance_id)&&Number.isSafeInteger(row.route_version)&&row.route_version>0;
  const complete=row.state==='completed'&&!row.returned&&!row.rejected,started=validIdentity?trusted(current(row,'instance_entered_at',row.entered_at),row.entered_quality,time,onFutureEvidence):null,completed=complete?trusted(row.completed_at,row.completed_quality,time,onFutureEvidence):null;
  const fact:SlaNodeFact={evidence:`task:${row.task_id}:source:${sourceId}:round:${row.route_version}:step:${steps[0]}`,businessCompleted:complete,
   ...(started?{startedAt:started}:{}),...(completed?{completedAt:completed}:{}),standardMinutes:validIdentity&&typeof basis?.seconds==='number'?basis.seconds/60:null,
   ...(typeof basis?.warningRatio==='number'?{standardWarningPercent:basis.warningRatio*100}:{}),
   ...(['continuous','natural_days','beijing_sunday_excluded'].includes(String(basis?.calendarRef))?{standardCalendar:basis!.calendarRef as NonNullable<SlaNodeFact['standardCalendar']>}:{}),
  };
  const due=started?at(current(row,'instance_due_at',row.due_at)):null,deadline:SlaTime={at:due,exclusive:basis?.exclusive===true,reasons:due?[]:['本实例缺少可信责任起点或已采用截止']};
  if(complete)fact.completedDeadline=deadline;
  if(row.returned||row.rejected||row.state==='cancelled')fact.waitingFor={reason:'本实例已退回或取消，不能当作有效完成',source:fact.evidence};
  result.push({sourceId,taskId:row.task_id,round:row.route_version,routeRef:row.route_instance_id??'',stepRef:validIdentity?steps[0]!:null,taskKind:row.task_kind,definitionId:aliases[row.task_kind]??row.task_kind,state:row.state,eligible:!row.returned&&!row.rejected&&row.state!=='cancelled',fact,deadline,warningAt:started?at(current(row,'instance_warning_at',row.warning_at)):null});
 }
 for(const parent of result.filter(instance=>['development_printing','development_embroidery','development_print_embroidery'].includes(instance.taskKind))){
  const matching=parent.stepRef?result.filter(instance=>instance.definitionId==='development_craft_return'&&instance.round===parent.round&&instance.routeRef===parent.routeRef&&instance.stepRef===parent.stepRef&&instance.state!=='cancelled'):[];
  const connected=matching.filter(instance=>rows.find(row=>row.task_id===instance.taskId)?.predecessor_ids?.includes(parent.taskId));
  // Older declared fixtures can omit dependency metadata. Native readers always
  // provide it; an explicit empty/different edge never grants a fallback.
  const receipt=connected.length===1?connected[0]:connected.length?undefined:matching.length===1&&rows.find(row=>row.task_id===matching[0]!.taskId)?.predecessor_ids===undefined?matching[0]:undefined;
  delete parent.fact.completedAt;parent.fact.businessCompleted=receipt?.fact.businessCompleted===true;
  if(receipt?.fact.completedAt){parent.fact.completedAt=receipt.fact.completedAt;parent.fact.completedDeadline=parent.deadline;parent.fact.evidence+=`;return:${receipt.taskId}`;}
  else{delete parent.fact.completedDeadline;parent.fact.waitingFor={reason:receipt?.fact.businessCompleted?'本步骤回收已完成，实际发生时间待核':'本步骤回收尚未有效确认，未借用其他工艺的回收',source:parent.fact.evidence};}
 }
 return result;
}
/** Legacy kind summaries can aggregate real windows, but cannot choose one as
 * the R/D of every task. Exact task observations remain separately addressable. */
export function craftInstanceAggregates(instances:readonly DevelopmentCraftInstance[],round:number):Record<string,SlaNodeFact>{
 const result:Record<string,SlaNodeFact>={};
 const current=instances.filter(instance=>instance.round===round&&instance.eligible);
 for(const kind of new Set(current.map(instance=>instance.definitionId))){
  const own=current.filter(instance=>instance.definitionId===kind);
  if(own.length===1){result[kind]={...structuredClone(own[0]!.fact),evidence:`craft-kind:${kind}:source:${own[0]!.sourceId}:round:${round}`};continue;}
  const complete=own.every(instance=>instance.fact.businessCompleted===true),known=complete&&own.every(instance=>instance.fact.completedAt);
  result[kind]={evidence:`craft-kind:${kind}:source:${own[0]!.sourceId}:round:${round}`,businessCompleted:complete,batchCoverageComplete:true,
   batchWindows:own.map(instance=>({startedAt:instance.fact.startedAt??null,deadline:instance.deadline.at,warningAt:instance.warningAt,completedAt:instance.fact.completedAt??null,complete:instance.fact.businessCompleted===true,evidence:`task:${instance.taskId}:step:${instance.stepRef}`,...(instance.fact.standardCalendar?{calendarRef:instance.fact.standardCalendar}:{})})),
   ...(known?{completedAt:new Date(Math.max(...own.map(instance=>Date.parse(instance.fact.completedAt!)))).toISOString()}:{}),
  };
 }
 return result;
}
