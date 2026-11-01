import {SERIES_MILESTONES,type SeriesRoute,type SeriesMilestone,type SeriesObservedFact,type PlanningDependency,type PlanningDependencyResult} from '@dx-rework/contracts/digital-series-plan';
import {addCalendarDays,isCalendarDate} from '@dx-rework/contracts/series-calendar';
const OFFSETS={A:{design_handover:95,material_investment:95,fabric_receipt:54,color_confirmation:42,client_sample_approval:44,accessories_ready:33,style_label_ready:33,processing_dispatch:28,planned_shipment:0},
 B:{design_handover:64,material_investment:64,fabric_receipt:33,color_confirmation:null,client_sample_approval:44,accessories_ready:33,style_label_ready:33,processing_dispatch:28,planned_shipment:0}} as const;
export function seriesMilestones(plannedShippingDate:string,route:SeriesRoute,scopeRef='whole'):SeriesMilestone[]{
 if(!isCalendarDate(plannedShippingDate)||!['A','B'].includes(route))throw new Error('计划出货日期或对色路线无效');
 return SERIES_MILESTONES.flatMap(m=>{const days=OFFSETS[route][m.key];if(days===null)return [];
  const date=addCalendarDays(plannedShippingDate,-days);return [{...m,id:`${m.key}:${scopeRef}`,scopeRef,offsetDays:days,templateDate:date,targetDate:date,retainedFromRevision:null,frozenReason:null}];});
}
/** Selection changes plan targets only. Native actual timestamps and responsibility clocks are never inputs to mutate. */
export function retainSeriesTargets(candidate:SeriesMilestone[],previous:SeriesMilestone[],facts:SeriesObservedFact[],selected:string[]|null,previousRevision:number):{milestones:SeriesMilestone[];selectedNodeIds:string[]}{
 const byId=new Map(previous.map(m=>[m.id,m])),fact=(m:SeriesMilestone)=>{const group=facts.filter(f=>f.key===m.key&&f.scopeRef===m.scopeRef);return {completed:group.some(f=>f.completed),started:group.some(f=>f.started)};};
 const eligible=candidate.filter(m=>{const f=fact(m);return !f?.completed&&!f?.started;}).map(m=>m.id);
 const chosen=selected??eligible;if(new Set(chosen).size!==chosen.length||chosen.some(id=>!eligible.includes(id)))throw new Error('请选择当前可调整的未开始节点，已运行或完成目标保留原版');
 return {selectedNodeIds:chosen,milestones:candidate.map(m=>{
  if(chosen.includes(m.id))return m;
  const old=byId.get(m.id),f=fact(m),why=f?.completed?'已完成，保留历史目标':f?.started?'责任窗口已开始，保留原目标':'本次未采用此节点调整';
  return {...m,targetDate:old?.targetDate??null,retainedFromRevision:old?.retainedFromRevision??(old?previousRevision:null),frozenReason:why};
 })};
}
/** Precedence/batch calculation, not a resource-capacity optimizer or authority to start work. */
export function evaluatePlanningDependencies(nodes:PlanningDependency[]):PlanningDependencyResult[]{
 const source=new Map(nodes.map(n=>[n.id,n]));if(source.size!==nodes.length)throw new Error('计划依赖节点重复');
 const visiting=new Set<string>(),done=new Map<string,PlanningDependencyResult>();
 function visit(id:string):PlanningDependencyResult{
  const prior=done.get(id);if(prior)return prior;const node=source.get(id);if(!node)throw new Error(`缺少计划依赖：${id}`);
  if(visiting.has(id))throw new Error('计划依赖存在循环');visiting.add(id);
  if(new Set(node.dependsOn).size!==node.dependsOn.length)throw new Error('计划依赖重复');
  if(node.durationMinutes!==null&&(!Number.isSafeInteger(node.durationMinutes)||node.durationMinutes<0))throw new Error('计划工期无效');
  const deps=node.dependsOn.map(visit),reasons=deps.flatMap(d=>d.reasons);
  let start:number|null=null;if(node.anchorDate!==null){if(!isCalendarDate(node.anchorDate))throw new Error('计划依赖日期无效');start=Date.parse(`${addCalendarDays(node.anchorDate,1)}T00:00:00+08:00`);reasons.push("日期型计划以当天结束为统一估算边界，不代表实际发生时刻");}
  if(deps.length){if(deps.some(d=>!d.endAt)){reasons.push(`${node.label}的前提日期不完整`);start=null;}else start=Math.max(start??-Infinity,...deps.map(d=>Date.parse(d.endAt!)));}
  if(start===null)reasons.push(`${node.label}缺少已确认的计划起点`);
  if(node.durationMinutes===null)reasons.push(`${node.label}缺少计划工期`);
  const end=start===null||node.durationMinutes===null||deps.some(d=>!d.endAt)?null:start+node.durationMinutes*60000;
  let lateMinutes:number|null=null;
  if(node.targetDate){if(!isCalendarDate(node.targetDate))throw new Error('计划目标日期无效');const boundary=Date.parse(`${addCalendarDays(node.targetDate,1)}T00:00:00+08:00`);lateMinutes=end===null?null:Math.max(0,Math.ceil((end-boundary)/60000));}
  const result:PlanningDependencyResult={id,label:node.label,scopeRef:node.scopeRef,startAt:start===null?null:new Date(start).toISOString(),endAt:end===null?null:new Date(end).toISOString(),lateMinutes,
   basis:end===null||node.basis==='unknown'||deps.some(d=>d.basis==='unknown')?'unknown':node.basis==='estimate'||deps.some(d=>d.basis==='estimate')?'estimate':'confirmed',reasons:[...new Set(reasons)]};
  visiting.delete(id);done.set(id,result);return result;
 }
 return nodes.map(n=>visit(n.id));
}
