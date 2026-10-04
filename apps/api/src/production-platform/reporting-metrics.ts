export type AnalysisTask = {
 taskId:string;sourceId:string|null;orderId:string|null;styleNo:string;customer:string;category:string;requiredRole:string;
 assigneeId:string|null;assigneeName:string|null;nodeKey:string;label:string;round:number;state:string;createdAt:string;
 enteredAt:string|null;completedAt:string|null;enteredQuality:string;completedQuality:string;dueAt:string|null;policyVersion:number|null;
 pendingConditions:string[]; sourceCreatedAt:string|null;sourcePublished:boolean;events:AnalysisEvent[];
};
export type AnalysisEvent={id:string;kind:string;at:string|null;recordedAt:string;quality:string;actorId:string;actorName?:string;correctsId:string|null;payload:Record<string,unknown>};
export const ANALYSIS_RULE_VERSION='digital-production-p16-v1';
const trusted=(quality:string)=>['现场登记','已核实'].includes(quality);
export function intervalUnionSeconds(intervals:readonly [number,number][]) {
 const ordered=intervals.filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>=a).sort((a,b)=>a[0]-b[0]);
 let start:number|null=null,end=0,total=0;
 for(const [a,b] of ordered){if(start===null){start=a;end=b;}else if(a<=end)end=Math.max(end,b);else{total+=end-start;start=a;end=b;}}
 return (total+(start===null?0:end-start))/1000;
}
export function taskAnalysis(task:AnalysisTask,asOf:string){
 const completed=task.state==='completed';
 const start=task.enteredAt?Date.parse(task.enteredAt):NaN,end=task.completedAt?Date.parse(task.completedAt):NaN;
 const validTime=Number.isFinite(start)&&Number.isFinite(end)&&end>=start&&trusted(task.enteredQuality)&&trusted(task.completedQuality);
 const measurable=completed&&validTime;
 const handlingSeconds=measurable?(end-start)/1000:null;
 const slaIncluded=measurable&&task.dueAt!==null&&Number.isFinite(Date.parse(task.dueAt))&&Date.parse(task.dueAt)>start;
 const exclusion=!completed?'尚未有效完成':!validTime?'起终点缺失、未核实或顺序异常':!task.dueAt?'无 SLA':!slaIncluded?'有效期限异常':null;
 const intervals:[number,number][]=[];let blocked:number|null=null,unknownWaiting=0;
 // P03's current task columns are the authoritative corrected projection, not event timestamp ordering.
 const effectiveEvents=task.events.filter(e=>!e.correctsId).map(event=>event.kind==='ready'?{...event,at:task.enteredAt,quality:task.enteredQuality}:event.kind==='completed'?{...event,at:task.completedAt,quality:task.completedQuality}:event);
 const readyRecordedAt=Math.min(...effectiveEvents.filter(e=>e.kind==='ready').map(e=>Date.parse(e.recordedAt)).filter(Number.isFinite));
 let conditionBlocked=false;
 for(const event of effectiveEvents){
  // P03 condition writes carry missing/unverified occurrence times. Retain their
  // historical wait as unknown after activation, even after conditions recover.
  // Several unmet prerequisites in the same blocked episode must not add waits.
  if(event.kind==='condition'&&event.payload.satisfied===false&&Date.parse(event.recordedAt)>=readyRecordedAt&&!conditionBlocked){unknownWaiting++;conditionBlocked=true;}
  if(['unblocked','completed','cancelled','cancel'].includes(event.kind))conditionBlocked=false;
  if(event.kind==='blocked'){
   if(event.at&&Number.isFinite(Date.parse(event.at))&&trusted(event.quality)){if(blocked===null)blocked=Date.parse(event.at);}else unknownWaiting++;
  }else if(['unblocked','completed','cancelled','cancel'].includes(event.kind)&&blocked!==null){
   if(event.at&&Number.isFinite(Date.parse(event.at))&&Date.parse(event.at)>=blocked&&trusted(event.quality))intervals.push([blocked,Date.parse(event.at)]);else unknownWaiting++;
   blocked=null;
  }
 }
 if(blocked!==null){if(!['completed','cancelled'].includes(task.state)&&Date.parse(asOf)>=blocked)intervals.push([blocked,Date.parse(asOf)]);else unknownWaiting++;}
 const delays=effectiveEvents.filter(e=>e.at&&trusted(e.quality)&&Number.isFinite(Date.parse(e.at))&&Number.isFinite(Date.parse(e.recordedAt))&&Date.parse(e.recordedAt)>=Date.parse(e.at)).map(e=>(Date.parse(e.recordedAt)-Date.parse(e.at!))/1000);
 return {...task,handlingSeconds,slaIncluded,onTime:slaIncluded?Date.parse(task.completedAt!)<=Date.parse(task.dueAt!):null,exclusion,
  waitingSeconds:intervalUnionSeconds(intervals),waitingIntervals:intervals,unknownWaiting:unknownWaiting+Number(task.state==='pending'&&task.pendingConditions.some(c=>['materials_ready','handover_received'].includes(c))),
  missingTime:!['pending','cancelled'].includes(task.state)&&(!task.enteredAt||(completed&&!task.completedAt)),unverifiedTime:task.enteredQuality==='补报未核实'||(completed&&task.completedQuality==='补报未核实'),
  registrationDelaySeconds:delays.length?delays.reduce((a,b)=>a+b,0)/delays.length:null};
}
export function summarizeAnalysis(rows:ReturnType<typeof taskAnalysis>[],from:string,to:string){
 const sources=new Set(rows.filter(r=>r.sourceId&&r.sourcePublished&&r.sourceCreatedAt&&r.sourceCreatedAt>=from&&r.sourceCreatedAt<to).map(r=>r.sourceId));
 const periods=new Map<string,[number,number][]>();for(const row of rows){const key=row.sourceId??row.orderId??row.taskId;periods.set(key,[...(periods.get(key)??[]),...row.waitingIntervals]);}
 const measurable=rows.filter(r=>r.handlingSeconds!==null);
 return {newStyles:sources.size,materialPending:rows.filter(r=>r.pendingConditions.includes("materials_ready")).length,handoverPending:rows.filter(r=>r.pendingConditions.includes("handover_received")).length,tasks:rows.filter(r=>r.state!=='cancelled').length,cancelled:rows.filter(r=>r.state==='cancelled').length,completed:rows.filter(r=>r.state==='completed').length,slaDenominator:rows.filter(r=>r.slaIncluded).length,
  onTime:rows.filter(r=>r.onTime===true).length,measurable:measurable.length,handlingSeconds:measurable.reduce((n,r)=>n+r.handlingSeconds!,0),
  waitingSeconds:[...periods.values()].reduce((n,p)=>n+intervalUnionSeconds(p),0),unknownWaiting:rows.reduce((n,r)=>n+r.unknownWaiting,0),
  missingTime:rows.filter(r=>r.missingTime).length,unverifiedTime:rows.filter(r=>r.unverifiedTime).length,
  correctedTasks:rows.filter(r=>r.events.some(e=>e.kind==='time_corrected')).length};
}
