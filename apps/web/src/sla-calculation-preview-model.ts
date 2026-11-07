import type {DigitalSlaValues} from '@dx-rework/contracts/digital-sla';
import type {DevelopmentCycleValues} from '@dx-rework/contracts/digital-development-technical';
import type {CalculationGraph,SlaCalculationContext,SlaCalculationResult} from '@dx-rework/contracts/sla-calculation';
import {calculationDraftGraph,calculateSlaPreview,calculateRelativeSlaSummary,SlaCalculationInputError} from '@dx-rework/domain/sla-calculation';
import type {SlaDraftSnapshot} from './sla-settings-draft.js';

/** Invalid text has no numeric value. Only its actual dependent branches become unknown. */
export function settingsCalculation(context:SlaCalculationContext,unified:SlaDraftSnapshot<DigitalSlaValues>|null,development:SlaDraftSnapshot<DevelopmentCycleValues>|null){
 const graph=calculationDraftGraph(context.graph,{unified:unified?.current??context.unified.values,development:development?.current??context.development.values},{unified:unified?.values??context.unified.values,development:development?.values??context.development.values});
 const errors=new Map<string,string>(),masked=new Set<string>();
 const mask=(ids:string[],message:string)=>{
  const group=new Set(ids);
  for(const n of graph.nodes)if(group.has(n.id)&&n.includedIn)group.add(n.includedIn);
  for(const n of graph.nodes)if(n.includedIn&&group.has(n.includedIn))group.add(n.id);
  for(const id of group){const original=context.graph.nodes.find(n=>n.id===id);if(!original)continue;const index=graph.nodes.findIndex(n=>n.id===id);graph.nodes[index]={...structuredClone(original),applicable:'unknown',waitingFor:message};masked.add(id);}
 };
 for(const [group,snapshot]of [['unified',unified],['development',development]] as const)for(const [key,message]of Object.entries(snapshot?.errors??{})){
  errors.set(`${group}:${key}`,message);mask(graph.nodes.filter(n=>n.binding?.group===group&&n.binding.key===key).map(n=>n.id),message);
  if(group==='unified'&&key==='stage_buffer')mask(graph.nodes.filter(n=>n.dependsOn.some(id=>graph.nodes.find(prior=>prior.id===id)?.stage!==n.stage)).map(n=>n.id),message);
 }
 // A frozen instance may retain different included values than the current global standard.
 for(let count=0;count<=graph.nodes.length;count++){
  try{return {result:calculateSlaPreview(graph),errors:[...new Set(errors.values())],graph};}
  catch(error){
   if(!(error instanceof SlaCalculationInputError))throw error;
   const key=error.field.split('.')[0],nodes=graph.nodes.filter(n=>n.parameterKey===key&&!masked.has(n.id));
   if(!nodes.length)throw error;errors.set(error.field,error.message);mask(nodes.map(n=>n.id),error.message);
  }
 }
 throw Error('本次草稿仍有无法归属的演算输入，请核对具体节点');
}
export function calculationSpanLabel(ms:number|null,format:(minutes:number)=>string){return ms===null?'尚不能确定':format(ms/60000);}

export type SlaStageTiming={stage:number;currentMs:number|null;draftMs:number|null;partial:boolean;currentKnownPathMs?:number|null;draftKnownPathMs?:number|null};

/** A standard window can be known without a calendar timestamp. Instance
 * observations retain the original absolute/frozen result and missing facts. */
export function settingsStandardTimes(graph:CalculationGraph,result:SlaCalculationResult){
 const relative=graph.observationMode==='example'?calculateRelativeSlaSummary(graph):null;
 return {overallMs:result.overall.spanMs??relative?.overall.spanMs??null,knownPathMs:relative?.overall.knownPathMs??null,stages:Array.from({length:7},(_,i)=>i+1).map(stage=>{
  const absolute=result.stages.find(row=>row.stage===stage),standard=relative?.stages.find(row=>row.stage===stage);
  return {stage,knownPathMs:standard?.knownPathMs??null,spanMs:absolute?.spanMs??standard?.spanMs??null,partial:absolute?.spanMs!==null&&absolute?.spanMs!==undefined?absolute.partial:standard?.partial??true};
 })};
}
