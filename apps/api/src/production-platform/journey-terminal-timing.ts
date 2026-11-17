import type {JourneyTiming,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
import type {JourneyTermination} from './journey-termination.js';
import {scheduleElapsed} from './fixed-schedule-progress.js';

/** Reader shared by the live DTO and finite selector frames. Original facts,
 * R/D and actual observation remain intact. Closure is not cancellation or A.
 */
export function attachJourneyTerminalTiming(item:OrderJourney,facts:Record<string,SlaNodeFact>,termination:JourneyTermination|null|undefined,asOf:string){
 if(!termination)return;
 const root=item.orderId?`order:${item.orderId}`:item.sourceId?`source:${item.sourceId}`:null;
 if(termination.scopeRef!==root)return;
 const at=termination.precision==='instant'&&termination.at?Date.parse(termination.at):NaN;
 const trusted=Number.isFinite(at)&&at<=Date.parse(asOf)&&Boolean(termination.originEventRef);
 const timings=new Set([...(item.supervision?.nodes??[]),...item.stages.flatMap(stage=>stage.nodes).flatMap(node=>[...(node.timings??[]),...(node.timing?[node.timing]:[])])]);
 const ended=new Set<JourneyTiming>();
 for(const timing of timings){
  const fact=facts[timing.id];
  if(timing.status==='not_applicable'||fact?.businessCompleted||fact?.completedAt||timing.actualEnd||timing.status.startsWith('completed'))continue;
  const start=timing.actualStart?Date.parse(timing.actualStart):null,conflict=start!==null&&trusted&&at<start;
  const known=trusted&&!conflict;
  const calendar=fact?.responsibilityWindow?.calendar??fact?.standardCalendar;
  const due=timing.target.at?Date.parse(timing.target.at):null;
  const overtime=known&&due!==null&&start!==null?at<=due?0:calendar?scheduleElapsed(due,at,calendar)*60:null:null;
  timing.termination={kind:termination.kind,at:trusted?termination.at:null,sourceRef:termination.originEventRef,elapsedSeconds:known&&start!==null?calendar?scheduleElapsed(start,at,calendar)*60:at===start?0:null:null,overdueSeconds:overtime};
  timing.status=known?'terminated':'unknown';
  timing.forecast={at:null,exclusive:false,reasons:[!trusted?'已终止，真实终止时间待核':conflict?'终止早于本窗口责任起点，责任时间待核':termination.kind==='special_closure'?'已特殊结案，本窗口计时终止，未作为交付完成':'已取消，本窗口计时终止，未作为交付完成']};
  timing.forecastBasis='unknown';delete timing.provenRisk;ended.add(timing);
 }
 for(const node of item.stages.flatMap(stage=>stage.nodes)){
  const own=[...(node.timings??[]),...(node.timing?[node.timing]:[])];
  if(!node.current||!own.some(timing=>ended.has(timing)))continue;
  node.risks=node.risks.filter(risk=>risk!=='overdue'&&risk!=='due_soon');
  const unknown=own.some(timing=>ended.has(timing)&&timing.status==='unknown');
  if(unknown&&!node.risks.includes('unknown'))node.risks.push('unknown');
  const overdue=own.map(timing=>timing.termination?.overdueSeconds);
  node.overdueSeconds=overdue.every((value):value is number=>value!==null&&value!==undefined)?Math.max(...overdue):null;
 }
}
