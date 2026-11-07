import type {CalculationGraph,CalculationNode} from '@dx-rework/contracts/sla-calculation';
import {isSlaDurationMinutes} from '@dx-rework/contracts/digital-sla';
import {orderedSlaNodes} from './digital-sla-plan.js';

type Point={origin:string;offset:number};
export type RelativeSlaSpan={spanMs:number|null;partial:boolean;knownPathMs:number|null};
export type RelativeSlaSummary={overall:RelativeSlaSpan;stages:Array<RelativeSlaSpan&{stage:number}>};
const maximum=(points:Array<Point|null>):Point|null=>points.length&&points.every((p):p is Point=>p!==null)&&new Set(points.map(p=>p.origin)).size===1?{origin:points[0]!.origin,offset:Math.max(...points.map(p=>p.offset))}:null;
const elapsed=(start:Point|null,end:Point|null)=>start&&end&&start.origin===end.origin&&end.offset>=start.offset?end.offset-start.offset:null;

/** Symbolic standard windows, never invented timestamps or zero event waits.
 * Different real entry events remain different origins. Sunday-dependent wall
 * spans require an actual instant and stay with the original absolute calculator. */
export function calculateRelativeSlaSummary(graph:CalculationGraph):RelativeSlaSummary{
 for(const n of graph.nodes)if(['duration','included','estimate'].includes(n.kind)&&!isSlaDurationMinutes(n.minutes))throw Error('标准相对用时包含非法时长');
 if(!graph.endIds.length||new Set(graph.endIds).size!==graph.endIds.length)throw Error('必须明确唯一的演算终点集合');
 for(const n of graph.nodes){if(!['continuous','natural_days','beijing_sunday_excluded'].includes(n.calendar))throw Error('未知的演算日历');if(n.stageBufferMinutes!==undefined&&(!Number.isSafeInteger(n.stageBufferMinutes)||n.stageBufferMinutes<0))throw Error('非法阶段缓冲');}
 const ordered=orderedSlaNodes(graph),all=new Map(graph.nodes.map(n=>[n.id,n]));
 const executable=(n:CalculationNode)=>!n.independent&&!n.includedIn&&!['offset','order_date'].includes(n.kind)&&n.applicable!=='no';
 const scope=(ids:Set<string>,ends?:string[],startIds?:string[]):RelativeSlaSpan=>{
  const times=new Map<string,{start:Point|null;end:Point|null}>(),segments=new Map<string,Point|null>();
  for(const item of ordered){
   const n=all.get(item.id)!;if(!ids.has(n.id))continue;
   const internal=n.dependsOn.filter(id=>ids.has(id)),external=n.dependsOn.filter(id=>!ids.has(id));
   const entry=JSON.stringify([n.anchorKey??null,...external.slice().sort(),...(!n.anchorKey&&!external.length?[n.id]:[])]);
   let start:Point|null=internal.length?maximum(internal.map(id=>{const value=times.get(id)?.end;if(!value)return null;const prior=all.get(id)!;return {...value,offset:value.offset+(prior.stage===n.stage?0:(n.stageBufferMinutes??graph.stageBufferMinutes)*60000)};})):{origin:'entry:'+entry,offset:0};
   // A second required actual anchor cannot silently be aligned with a prior branch.
   if(internal.length&&(n.anchorKey||external.length))start=null;
   let end:Point|null=null;
   if(n.applicable==='yes'&&!n.waitingFor&&!n.completedAt&&!n.exclusion){
    if(n.kind==='included'){
     const parent=times.get(n.includedIn!);start=n.includedPosition==='start'?parent?.start??null:parent?.end?{...parent.end,offset:parent.end.offset-(n.minutes??0)*60000}:null;
     end=start&&n.minutes!==null?{...start,offset:start.offset+n.minutes*60000}:null;
    }else if(['duration','estimate'].includes(n.kind)&&n.calendar!=='beijing_sunday_excluded'&&Number.isFinite(n.minutes)&&n.minutes!==null&&n.minutes>0){
     end=start?{...start,offset:start.offset+Math.round(n.minutes*60000)}:null;
    }
   }
   times.set(n.id,{start,end});
   // Retain a fully fixed contiguous segment even when another real event makes
   // the whole scope unknown. Its duration is labelled as a known path, never
   // substituted for that scope or used to assign zero to the unknown wait.
   const segmentPredecessors=internal.map(id=>{const point=segments.get(id);if(!point)return null;return {...point,offset:point.offset+(all.get(id)!.stage===n.stage?0:(n.stageBufferMinutes??graph.stageBufferMinutes)*60000)};});
   const segmentStart=internal.length&&!n.anchorKey&&!external.length?maximum(segmentPredecessors):null;
   const fixed=n.applicable==='yes'&&!n.completedAt&&!n.exclusion&&!n.waitingFor&&['duration','estimate'].includes(n.kind)&&n.calendar!=='beijing_sunday_excluded';
   const segment=fixed?{origin:segmentStart?.origin??'segment:'+n.id,offset:(segmentStart?.offset??0)+Math.round(n.minutes!*60000)}:null;
   if(segment&&!Number.isSafeInteger(segment.offset))throw Error('标准路径用时超出可表示范围');
   segments.set(n.id,segment);
  }
  const nodes=graph.nodes.filter(n=>ids.has(n.id)&&executable(n)),roots=nodes.filter(n=>!n.dependsOn.some(id=>ids.has(id)&&all.get(id)?.applicable!=='no'));
  const starts=(startIds?.length?startIds:roots.map(n=>n.id)).map(id=>times.get(id)?.start??null),same=starts.length&&starts.every((p):p is Point=>p!==null)&&new Set(starts.map(p=>p.origin)).size===1;
  const start=same?{origin:starts[0]!.origin,offset:Math.min(...starts.map(p=>p.offset))}:null;
  const terminals=ends?ends.map(id=>all.get(id)).filter((n):n is CalculationNode=>Boolean(n)&&n!.applicable!=='no'):nodes.filter(n=>!nodes.some(next=>next.dependsOn.includes(n.id)));
  const end=maximum(terminals.map(n=>times.get(n.id)?.end??null)),value=elapsed(start,end);
  const knownPath=Math.max(0,...nodes.map(n=>segments.get(n.id)?.offset??0));
  return {spanMs:value,partial:value===null,knownPathMs:knownPath||null};
 };
 const relevant=new Set<string>();const visit=(id:string)=>{if(relevant.has(id))return;const n=all.get(id);if(!n)throw Error('相对演算终点或依赖不在本条路线');relevant.add(id);n.dependsOn.forEach(visit);if(n.includedIn)visit(n.includedIn);};graph.endIds.forEach(visit);graph.startIds?.forEach(visit);
 return {overall:scope(relevant,graph.endIds,graph.startIds),stages:Array.from({length:7},(_,i)=>i+1).map(stage=>({stage,...scope(new Set(graph.nodes.filter(n=>n.stage===stage).map(n=>n.id)))}))};
}
