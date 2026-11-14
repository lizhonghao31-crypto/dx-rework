import type {BulkWashingArrangement,BulkWashingScopeView} from '@dx-rework/contracts/bulk-washing';
import type {WashingEvent} from './bulk-washing-repository.js';
import {shiftFixedTimeline} from './fixed-timeline-targets.js';
import {scheduleElapsed} from './fixed-schedule-progress.js';
import type {JourneyTermination} from './journey-termination.js';

/** Actual dispatch/completion evidence only; planned dates never open clocks.
 * Voiding an event removes coverage but does not erase its historical window. */
export function bulkWashingWindows(plan:BulkWashingArrangement,events:readonly WashingEvent[],voided:ReadonlySet<string>,now:string,termination:JourneyTermination|null=null):BulkWashingScopeView['windows']{
 if(plan.mode==='none')return [];
 const windows:BulkWashingScopeView['windows']=[],effective=events.filter(e=>!voided.has(e.id));
 const add=(id:string,kind:'washing'|'inspection',startedAt:string|null,completedAt:string|null,finished=false,invalidated=false)=>{
  const policy=kind==='washing'?plan.washing:plan.inspection;
  const dueAt=startedAt?shiftFixedTimeline(startedAt,policy.minutes,policy.calendar):null;
  const observed=invalidated||finished&&!completedAt?null:completedAt??(termination?termination.at:now);
  windows.push({id,kind,state:invalidated?'voided':finished?'completed':'active',startedAt,dueAt,completedAt,minutes:policy.minutes,
   overdueMinutes:dueAt&&observed?Math.max(0,scheduleElapsed(Date.parse(dueAt),Date.parse(observed),policy.calendar)):null});
 };
 for(const event of events){
  if(event.kind==='send'||event.kind==='factory_start'){
   const returns=effective.filter(e=>e.kind==='return'&&e.payload.sendId===event.id||e.kind==='factory_complete'&&e.payload.startId===event.id);
   const count=returns.reduce((sum,e)=>sum+Number(e.payload.quantity),0);
   const completed=count===Number(event.payload.quantity)&&returns.length>0&&returns.every(e=>e.occurredAt!==null)
    ?returns.map(e=>e.occurredAt!).sort().at(-1)!:null;
   add(event.id,'washing',event.occurredAt,completed,count===Number(event.payload.quantity)&&returns.length>0,voided.has(event.id));
  }
  if(event.kind==='return'||event.kind==='factory_complete'){
   const check=effective.find(e=>e.kind==='inspection'&&e.payload.completionId===event.id&&e.payload.quantity===event.payload.quantity);
   add(`${event.id}:qc`,'inspection',event.occurredAt,check?.occurredAt??null,Boolean(check),voided.has(event.id));
  }
 }
 return windows;
}
