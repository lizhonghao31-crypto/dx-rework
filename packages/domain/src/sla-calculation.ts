import {isSlaDurationMinutes,type DigitalSlaValues} from '@dx-rework/contracts/digital-sla';
import type {DevelopmentCycleValues} from '@dx-rework/contracts/digital-development-technical';
import {CalculationAnchorSchema,SLA_CALCULATOR_VERSION,SLA_CALENDAR_VERSION,type CalculationAnchor,type CalculationGraph,type CalculationNode,type CalculationRow,type CalculationTime,type SlaCalculationResult} from '@dx-rework/contracts/sla-calculation';
import {orderedSlaNodes,slaAnchorTime} from './digital-sla-plan.js';

const MINUTE=60000,BEIJING=8*60*MINUTE;
export class SlaCalculationInputError extends Error{
 constructor(readonly field:string,message:string){super(message);this.name='SlaCalculationInputError';}
}
const unknown=(...reasons:string[]):CalculationTime=>({at:null,exclusive:false,reasons:[...new Set(reasons)]});
const known=(ms:number,exclusive=false):CalculationTime=>{
 if(!Number.isSafeInteger(ms)||Math.abs(ms)>8640000000000000)throw Error('演算时刻超出可表示范围');
 return {at:new Date(ms).toISOString(),exclusive,reasons:[]};
};
const at=(time:CalculationTime)=>Date.parse(time.at!);
/** Uses the exact Sunday-first endpoint convention of sourcing_contract_return_add_hours. */
export function addCalculationMinutes(start:string,minutes:number,calendar:CalculationNode['calendar']='continuous'):string{
 const parsed=startAnchor({precision:'instant',value:start,source:'calculation-calendar'},'参考起点').at!;
 if(!isSlaDurationMinutes(minutes))throw Error('演算时长须为合法的毫秒精度正数');
 let clock=Date.parse(parsed),remaining=Math.round(minutes*MINUTE);
 if(calendar!=='beijing_sunday_excluded')return known(clock+remaining).at!;
 while(true){
  const local=new Date(clock+BEIJING),midnight=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate()+1)-BEIJING;
  if(local.getUTCDay()===0){clock=midnight;continue;}
  if(remaining===0)return known(clock).at!;
  const available=midnight-clock;
  if(remaining<available)return known(clock+remaining).at!;
  remaining-=available;clock=midnight;
 }
}
function startAnchor(anchor:CalculationAnchor|undefined,key:string):CalculationTime{
 if(anchor){CalculationAnchorSchema.parse(anchor);if(anchor.precision==='instant'&&/[.]\d{3}\d*[1-9]\d*(?:Z|[+-]\d{2}:\d{2})$/.test(anchor.value))throw Error('参考时刻不能含不可表示的亚毫秒精度');}
 if(anchor?.precision==='date')return unknown(`${key}只有日期，缺少可信具体起算时刻`);
 return slaAnchorTime(anchor,key);
}
function maximum(times:CalculationTime[],reason:string):CalculationTime{
 if(!times.length)return unknown(reason);
 if(times.some(t=>!t.at))return unknown(...times.flatMap(t=>t.reasons));
 return times.reduce((a,b)=>at(a)>=at(b)?a:b);
}
const plus=(time:CalculationTime,minutes:number)=>time.at?known(at(time)+Math.round(minutes*MINUTE),time.exclusive):time;
const span=(start:CalculationTime,end:CalculationTime)=>start.at&&end.at&&at(end)>=at(start)?at(end)-at(start):null;

/** Pure standard-window calculation. No clock reads, storage, permissions, notifications or business writes. */
export function calculateSlaPreview(graph:CalculationGraph):SlaCalculationResult{
 if(!graph.endIds.length||new Set(graph.endIds).size!==graph.endIds.length)throw Error('必须明确唯一的演算终点集合');
 for(const n of graph.nodes)if(['duration','included','estimate'].includes(n.kind)&&!isSlaDurationMinutes(n.minutes))throw new SlaCalculationInputError(`${n.parameterKey}.minutes`,`${n.label}：时长须为合法的正数并保留毫秒精度`);
 for(const parent of graph.nodes){
  const children=graph.nodes.filter(n=>n.includedIn===parent.id&&n.applicable!=='no');
  if(children.reduce((sum,n)=>sum+n.minutes!,0)>(parent.minutes??0))throw new SlaCalculationInputError(`${parent.parameterKey}.minutes`,`${parent.label}：本实例保留的内含目标合计超过草稿父窗口，请核对父窗口与原冻结目标`);
 }
 const ordered=orderedSlaNodes(graph),definitions=new Map(graph.nodes.map(n=>[n.id,n]));
 for(const id of graph.endIds)if(!definitions.has(id))throw Error('演算终点不在本条路线');
 for(const id of graph.startIds??[])if(!definitions.has(id))throw Error('演算起点不在本条路线');
 const rows=new Map<string,CalculationRow>();
 for(const base of ordered){
  const n=definitions.get(base.id)!;
  if(!['continuous','natural_days','beijing_sunday_excluded'].includes(n.calendar))throw Error('未知的演算日历');
  if(n.calendar==='beijing_sunday_excluded'&&n.kind!=='duration')throw Error('业务日历只适用于独立固定窗口');
  let start:CalculationTime,end:CalculationTime,target:CalculationTime|null=null,determiningPredecessors:string[]=[],basis:CalculationRow['basis']='standard';
  if(n.applicable!=='yes'){
   start=end=unknown(n.applicable==='no'?`${n.label}不适用`:`${n.label}适用条件尚未确认`);basis='unknown';
  }else{
   const candidates=n.dependsOn.map(id=>({id,time:plus(rows.get(id)!.end,definitions.get(id)!.stage===n.stage?0:graph.stageBufferMinutes)}));
   if(n.anchorKey)candidates.push({id:`anchor:${n.anchorKey}`,time:startAnchor(graph.anchors[n.anchorKey],n.anchorKey)});
   start=maximum(candidates.map(c=>c.time),`${n.label}缺少可信起点`);
   if(start.at)determiningPredecessors=candidates.filter(c=>c.time.at&&at(c.time)===at(start)).map(c=>c.id).sort();
   if(n.completedAt){
    end=startAnchor(n.completedAt,`${n.label}完成依据`);basis=end.at?graph.observationMode==='instance'?'actual':'reference':'unknown';determiningPredecessors=[];
   }else if(n.waitingFor){end=unknown(n.waitingFor);basis='unknown';}
   else if(n.kind==='included'){
    const parent=rows.get(n.includedIn!)!;
    start=n.includedPosition==='start'?parent.start:plus(parent.end,-n.minutes!);
    end=plus(start,n.minutes!);determiningPredecessors=[n.includedIn!];
   }else if(n.kind==='order_date'||n.kind==='offset'){
    target=slaAnchorTime(graph.anchors[n.targetKey!],n.targetKey??n.label);
    if(n.kind==='offset')target=plus(target,-n.offsetDays!*1440);
    end=unknown(`${n.label}是日期目标或提醒，不作为已完成前置`);basis='target';
   }else if(n.kind==='unlimited'){
    end=unknown(`${n.label}没有固定时长，尚缺实际完成依据`);basis='unknown';
   }else{
    end=start.at?{...start,at:addCalculationMinutes(start.at,n.minutes!,n.calendar)}:start;
    if(n.exclusion){
     if(!n.independent)throw Error('真实外发扣除仅用于独立开发内部周期');
     if(n.exclusion.knownMs===null)end=unknown(...n.exclusion.reasons);
     else{if(!Number.isSafeInteger(n.exclusion.knownMs)||n.exclusion.knownMs<0)throw Error('外发区间并集精度不合法');if(end.at)end=known(at(end)+n.exclusion.knownMs,end.exclusive);}
    }
   }
  }
  rows.set(n.id,{id:n.id,label:n.label,stage:n.stage,kind:n.kind,applicable:n.applicable,source:n.source,calendar:n.calendar,minutes:n.minutes,offsetDays:n.offsetDays,start,end,target,determiningPredecessors,basis,includedIn:n.includedIn,independent:n.independent===true,...(n.estimateRange?{estimateRange:structuredClone(n.estimateRange)}:{})});
 }
 const sorted=[...rows.values()].sort((a,b)=>a.id.localeCompare(b.id,'en'));
 const relevant=new Set<string>();const select=(id:string)=>{if(relevant.has(id))return;relevant.add(id);for(const prior of definitions.get(id)?.dependsOn??[])select(prior);};graph.endIds.forEach(select);
 const executable=(row:CalculationRow)=>row.applicable!=='no'&&!row.independent&&!['included','offset','order_date'].includes(row.kind);
 const starts=graph.startIds?.length?graph.startIds.map(id=>rows.get(id)!.start):sorted.filter(r=>relevant.has(r.id)&&executable(r)&&!definitions.get(r.id)!.dependsOn.length).map(r=>r.start);
 const start=starts.length&&starts.every(t=>t.at)?starts.reduce((a,b)=>at(a)<=at(b)?a:b):unknown('所选范围尚缺部分起点依据',...starts.flatMap(t=>t.reasons));
 const ends=graph.endIds.map(id=>rows.get(id)!).filter(r=>r.applicable!=='no');
 const end=maximum(ends.map(r=>r.end),'所选终点均不适用，尚无可签的整体结果');
 const determining=new Set<string>();
 const visit=(id:string)=>{if(determining.has(id))return;determining.add(id);for(const prior of rows.get(id)?.determiningPredecessors??[])if(rows.has(prior))visit(prior);};
 if(end.at)for(const row of ends.filter(r=>r.end.at&&at(r.end)===at(end)))visit(row.id);
 const stages=Array.from({length:7},(_,i)=>i+1).flatMap(stage=>{
  const group=sorted.filter(r=>r.stage===stage&&executable(r));if(!group.length)return [];
  const available=group.filter(r=>r.start.at),s=available.length?available.map(r=>r.start).reduce((a,b)=>at(a)<=at(b)?a:b):unknown('本阶段缺少可信起点');
  const e=maximum(group.map(r=>r.end),'本阶段尚无出口');
  return [{stage,start:s,end:e,spanMs:span(s,e),partial:group.some(r=>!r.start.at||!r.end.at)||span(s,e)===null,missing:[...new Set([...group.flatMap(r=>[...r.start.reasons,...r.end.reasons]),...(s.at&&e.at&&at(e)<at(s)?['阶段完成早于范围起点，不能签可用跨度']:[])])]}];
 });
 const missing=[...new Set(sorted.filter(r=>relevant.has(r.id)&&r.applicable!=='no').flatMap(r=>[...r.start.reasons,...r.end.reasons]))].sort();
 if(start.at&&end.at&&at(end)<at(start))missing.push('所选完成早于范围起点，不能以0代替未知跨度');
 const branchStart=(id:string):CalculationTime=>{
  const roots:CalculationTime[]=[],seen=new Set<string>();
  const walk=(key:string)=>{if(seen.has(key))return;seen.add(key);const definition=definitions.get(key)!,r=rows.get(key)!;if(!definition.dependsOn.length)roots.push(r.start);else definition.dependsOn.forEach(walk);};walk(id);
  return roots.length&&roots.every(t=>t.at)?roots.reduce((a,b)=>at(a)<=at(b)?a:b):unknown('本分支尚缺起点依据',...roots.flatMap(t=>t.reasons));
 };
 return {calculatorVersion:SLA_CALCULATOR_VERSION,calendarVersion:SLA_CALENDAR_VERSION,rows:sorted,stages,
  overall:{status:span(start,end)!==null?'complete':'partial',start,end,spanMs:span(start,end),determiningNodes:[...determining].sort(),missing,
   knownBranches:sorted.filter(r=>executable(r)&&r.end.at&&!sorted.some(s=>s.applicable!=='no'&&definitions.get(s.id)!.dependsOn.includes(r.id)&&s.end.at)).map(r=>{const s=branchStart(r.id);return {id:r.id,start:s,end:r.end,spanMs:span(s,r.end)};})},
  rangeLabel:graph.rangeLabel,startLabel:graph.startLabel,endLabel:graph.endLabel};
}

/** A what-if overlay changes only explicitly edited standard values; frozen instance inputs retain their sources. */
export function calculationDraftGraph(graph:CalculationGraph,current:{unified:DigitalSlaValues;development:DevelopmentCycleValues},draft:{unified:DigitalSlaValues;development:DevelopmentCycleValues}):CalculationGraph{
 const result=structuredClone(graph);
 for(const n of result.nodes){
  if(!n.binding)continue;
  if(n.binding.group==='unified'){
   const key=n.binding.key,value=draft.unified[key];
   if(!value||JSON.stringify(value)===JSON.stringify(current.unified[key]))continue;
   if(n.kind!==value.kind)throw Error(`草稿时限类型不符：${n.label}`);
   if(n.estimateRange&&'minutes'in value&&n.minutes!==null){const shift=Math.round((value.minutes-n.minutes)*MINUTE);n.estimateRange={...n.estimateRange,fromInclusive:known(Date.parse(n.estimateRange.fromInclusive)+shift).at!,toExclusive:known(Date.parse(n.estimateRange.toExclusive)+shift).at!};}
   n.minutes='minutes' in value?value.minutes:null;n.offsetDays='days' in value?value.days:null;n.source=`本次未发布草稿 · ${n.label}`;
  }else{
   const key=n.binding.key as keyof DevelopmentCycleValues;
   if(draft.development[key]===current.development[key])continue;
   n.minutes=draft.development[key]*(key==='sizeReviewHours'?60:1440);n.source=`开发独立标准未发布草稿 · ${n.label}`;
  }
 }
 const buffer=draft.unified.stage_buffer,warning=draft.unified.warning_ratio;
 if(buffer?.kind==='buffer'&&JSON.stringify(buffer)!==JSON.stringify(current.unified.stage_buffer))result.stageBufferMinutes=buffer.minutes;
 if(warning?.kind==='ratio'&&JSON.stringify(warning)!==JSON.stringify(current.unified.warning_ratio))result.warningPercent=warning.percent;
 return result;
}
