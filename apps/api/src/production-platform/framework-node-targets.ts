import type {FrozenTimeFramework} from '@dx-rework/contracts/order-time-framework';
import {orderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {buildOrderTimeWork} from './order-time-schedule.js';
import {fixedTimelineTargets,shiftFixedTimeline,type FixedTimelineTarget} from './fixed-timeline-targets.js';
import type {SlaTime} from '@dx-rework/domain/digital-sla-plan';
import type {StoredOrderTimePlan} from './order-time-plan-repository.js';
import {orderTimeWorkDefinition} from './fixed-work-definition.js';

/** Current arranged P used by both Journey and the exact native-task reader.
 * Completion/history assessment and milestone event constraints stay separate. */
export function arrangedOrderTimeTarget(saved:StoredOrderTimePlan,scopeRef:string,workId:string){
 const framework=saved.input.frameworkPlans?.[scopeRef];
 if(framework)return framework.arranged.find(target=>target.id===workId);
 if(saved.input.formalTargets?.[scopeRef])return saved.input.formalTargets[scopeRef][workId];
 const original=saved.targets[scopeRef]?.[workId];
 if(saved.changeKind==='arrangement'&&original?.end.at){
  const work=saved.input.work.find(row=>row.id===workId);
  if(work&&!work.includedIn&&Object.hasOwn(saved.input.plan.overrides,work.parameterKey)){
   const {minutes,calendar}=orderTimeWorkDefinition(saved.input.plan,work.parameterKey,work.craftStep);
   if(minutes!==null&&calendar&&Date.parse(original.end.at)<Date.parse(shiftFixedTimeline(saved.time.now,minutes,calendar))){
    // The old recorded target is proven too early for the approved duration.
    // Without the original arrangement inputs, neither subsequent execution
    // nor this floor can certify the old value as its current plan.
    const unknown={at:null,exclusive:false,reasons:['原调整未保存剩余安排依据，请从本单时效重新核对并正式安排']};
    return {id:workId,start:unknown,end:unknown};
   }
  }
 }
 return original;
}

/** An event contributes no extra work duration. Its scheduling position is not
 * an instruction to finish at order creation. Read its approved milestone or
 * downstream preparation constraint from this exact frozen version instead.
 * No current clock, company lookup, persisted rewrite or employee SLA here. */
export function frameworkNodeTargets(plan:FrozenTimeFramework):Map<string,FixedTimelineTarget>{
 const targets=new Map(plan.arranged.map(row=>[row.id,row]));
 const constrained=new Set(['design_handover','material_investment','budget','customer_confirmation']);
 const events=plan.input.work.filter(row=>constrained.has(row.parameterKey)&&orderTimeRule(plan.input.plan,row.parameterKey)?.rule.kind==='event');
 if(!events.length)return targets;
 const ends:Record<string,SlaTime>={};
 for(const milestone of plan.milestones)for(const id of milestone.workIds){
  const target=milestone.target,prior=ends[id];
  if(!prior||target.at&&prior.at&&(Date.parse(target.at)<Date.parse(prior.at)||target.at===prior.at&&target.exclusive&&!prior.exclusive))ends[id]=target;
 }
 const bounds=new Map(fixedTimelineTargets(buildOrderTimeWork(plan.input.plan,plan.input.work.map(row=>({id:row.id,parameterKey:row.parameterKey,stage:row.stage,dependsOn:row.dependsOn,...(row.includedIn?{includedIn:row.includedIn}:{}),...(row.includedPosition?{includedPosition:row.includedPosition}:{}),...(row.canonicalWorkRef?{canonicalWorkRef:row.canonicalWorkRef}:{}),...(row.craftStep?{craftStep:row.craftStep}:{}),...(row.nativeDuration?{nativeDuration:row.nativeDuration}:{})}))),{},{endTimes:ends,preserveUnknown:true}).map(row=>[row.id,row]));
 for(const event of events){
  // A direct milestone owns its business date. Budget/commercial preparation
  // uses the necessary downstream boundary, never an invented work duration.
  const direct=plan.milestones.filter(row=>row.workIds.includes(event.id)).sort((a,b)=>a.target.at===null?-1:b.target.at===null?1:Date.parse(a.target.at)-Date.parse(b.target.at))[0];
  const end=direct?.target??bounds.get(event.id)?.end;
  if(end)targets.set(event.id,{id:event.id,start:structuredClone(end),end:structuredClone(end)});
 }
 return targets;
}

/** A date end is encoded as following Beijing midnight, exclusive. Only a
 * proven date boundary gets a date label; arbitrary instants stay instants. */
export function frameworkTargetPrecision(target:FixedTimelineTarget|undefined){
 const end=target?.end;
 if(end?.at&&end.exclusive){
  const at=Date.parse(end.at),beijing=new Date(at+8*3600000);
  if(beijing.getUTCHours()===0&&beijing.getUTCMinutes()===0&&beijing.getUTCSeconds()===0&&beijing.getUTCMilliseconds()===0)return {targetPrecision:'date' as const,targetDate:new Date(at+8*3600000-86400000).toISOString().slice(0,10)};
 }
 return {targetPrecision:'instant' as const,targetDate:null};
}
