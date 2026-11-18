import type {BulkWashingScopeView} from '@dx-rework/contracts/bulk-washing';
import type {ScheduleFact,ScheduleResponsibilityWindow} from './fixed-schedule-progress.js';
import type {WashingPlan} from './bulk-washing-repository.js';
const unknown={precision:'unknown'} as const;
const actual=(at:string|null,asOf:string)=>at&&Number.isFinite(Date.parse(at))&&Date.parse(at)<=Date.parse(asOf)?{precision:'instant' as const,at}:unknown;
/** Quantities are the current native cutting scope, not the sum of received
 * batches. Thirty received and twenty washed cannot complete a hundred-piece PO. */
export function journeyWashingFact(scopes:readonly BulkWashingScopeView[],plans:readonly WashingPlan[],lineId:string,parameter:string,quantity:number|null,asOf:string):ScheduleFact{
 const mode=parameter.startsWith('bulk_factory_')?'factory':'after_receipt',inspection=parameter.endsWith('_inspection');
 const own=scopes.filter(s=>s.lineId===lineId&&s.mode===mode&&s.quantity>0);
 const windows:ScheduleResponsibilityWindow[]=own.flatMap(scope=>{
  const arrangement=plans.find(p=>p.id===scope.planId)?.document.arrangement;
  return scope.windows.filter(w=>w.kind===(inspection?'inspection':'washing')&&w.state!=='voided').map(w=>({
   sourceRef:`washing:${scope.scopeId}:${w.id}`,nativeWashingWindow:{scopeId:scope.scopeId,windowId:w.id},started:actual(w.startedAt,asOf),completed:actual(w.completedAt,asOf),complete:w.state==='completed',deadline:w.dueAt,warningAt:null,
   calendar:arrangement&&arrangement.mode!=='none'?(inspection?arrangement.inspection.calendar:arrangement.washing.calendar):null,
  }));
 });
 const count=own.reduce((sum,s)=>sum+(inspection?s.ledger.qualified??0:s.ledger.washed),0);
 const complete=quantity!==null&&quantity>0&&own.length>0&&own.every(s=>!s.ledger.conflict)&&own.reduce((sum,s)=>sum+s.quantity,0)===quantity&&count===quantity&&windows.every(w=>w.complete);
 const ends=windows.map(w=>w.completed),known=complete&&windows.length>0&&windows.every(w=>w.complete)&&ends.every(e=>e.precision==='instant');
 const starts=windows.map(w=>w.started),ready=starts.length>0&&starts.every(s=>s.precision==='instant')?{precision:'instant' as const,at:new Date(Math.min(...starts.map(s=>s.precision==='instant'?Date.parse(s.at):NaN))).toISOString()}:unknown;
 return {ready,clockStart:ready,businessCompleted:complete,completed:known?{precision:'instant',at:new Date(Math.max(...ends.map(e=>e.precision==='instant'?Date.parse(e.at):NaN))).toISOString()}:unknown,
  waitingForPredecessors:false,notYetReady:windows.length===0,evidenceRefs:own.map(s=>`washing:${s.scopeId}:v${s.revision}`),ownWindows:windows};
}
