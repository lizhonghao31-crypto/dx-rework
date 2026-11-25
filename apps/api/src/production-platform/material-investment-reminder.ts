import {orderTimeRule} from '@dx-rework/contracts/order-time-plan';
import type {MaterialInvestmentReminder} from '@dx-rework/contracts/production-readiness';
import {businessNow} from '../acceptance-clock/business-time.js';
import {fixedTimelineElapsedMilliseconds,shiftFixedTimelineMilliseconds,type FixedTimelineCalendar} from './fixed-timeline-targets.js';
import {OrderTimePlanRepository,type StoredOrderTimePlan} from './order-time-plan-repository.js';
import {journeyTermination} from './journey-termination.js';
import {preparationHash,preparationIso,type PreparationDB} from './preparation-material-repository.js';
import {workbenchPreorderPublication} from './development-source-lifecycle.js';
import {orderTimeCreated} from './order-time-created.js';

export function materialInvestmentWarningAt(start:string,due:string,calendar:FixedTimelineCalendar,percent:number):string|null{
 const from=Date.parse(start),to=Date.parse(due);
 if(!Number.isFinite(from)||!Number.isFinite(to)||from>=to||!Number.isInteger(percent)||percent<1||percent>99)return null;
 const elapsed=fixedTimelineElapsedMilliseconds(from,to,calendar);
 if(elapsed<=0)return null;
 const total=(BigInt(elapsed)*BigInt(percent)+99n)/100n;
 const warning=shiftFixedTimelineMilliseconds(from,Number(total),calendar);
 return warning<to?new Date(warning).toISOString():null;
}

/** Only an adopted order and the original native handover can provide a
 * reminder. Opening a page or changing the assigned person never starts it. */
export async function materialInvestmentReminder(db:PreparationDB,basis:{
 sourceId:string|null;orderId:string|null;handoverId:string;scopeFingerprint:string|null;
},now=businessNow(),adoptedPlan?:StoredOrderTimePlan):Promise<MaterialInvestmentReminder|null>{
 if(!basis.orderId||!basis.scopeFingerprint)return null;
 const saved=adoptedPlan??await new OrderTimePlanRepository(db).current({kind:'order',id:basis.orderId});
 const plans=Object.values(saved?.input.frameworkPlans??{});
 if(!plans.length||!saved)return null;
 const milestones=plans.map(plan=>plan.milestones.find(row=>row.key==='material_investment'));
 if(milestones.some(row=>!row?.target.at||!row.materialInvestmentTargetBasis?.scope?.reference.endsWith(':'+basis.scopeFingerprint)))return null;
 const first=milestones.reduce((a,b)=>Date.parse(a!.target.at!)<Date.parse(b!.target.at!)||a!.target.at===b!.target.at&&a!.target.exclusive?a:b)!;
 const clock=orderTimeRule(saved.input.plan,'material_investment')?.rule;
 if(clock?.kind!=='event'||!clock.calendar)return null;
 const origin=(await db.query(`SELECT version,occurred_at FROM digital_preparation_material_versions
  WHERE record_id=$1 AND kind='design_handover' AND scope_ref='whole' AND state='ready' AND occurred_at IS NOT NULL
   AND body->'investmentScopeBasis'->>'fingerprint'=$2
   AND (resource_kind='source' AND resource_id=$3 OR resource_kind='order' AND resource_id=$4)
  ORDER BY occurred_at,version LIMIT 1`,[basis.handoverId,basis.scopeFingerprint,basis.sourceId,basis.orderId])).rows[0];
 const occurrence=preparationIso(origin?.occurred_at),dueAt=first.target.at!,exclusive=first.target.exclusive;
 const scopeReference=first.materialInvestmentTargetBasis!.scope!.reference;
 const formalStart=occurrence&&basis.sourceId&&scopeReference.startsWith('preorder:'+basis.sourceId+':')
  &&await workbenchPreorderPublication(db,basis.sourceId)?(await orderTimeCreated(db,{kind:'order',id:basis.orderId}))?.at:null;
 const startedAt=occurrence&&formalStart&&occurrence<formalStart?formalStart:occurrence;
 const warningAt=startedAt&&clock.reminder.enabled?materialInvestmentWarningAt(startedAt,dueAt,clock.calendar,clock.reminder.percent):null;
 // A historical source association is a navigation alias for an order-born handover.
 const orderBorn=scopeReference.startsWith('order:'+basis.orderId+':');
 const resourceIdentity=orderBorn||!basis.sourceId?{orderId:basis.orderId}:{sourceId:basis.sourceId};
 const fingerprint=preparationHash({...resourceIdentity,handoverId:basis.handoverId,scope:basis.scopeFingerprint,
  startedAt,dueAt,exclusive,calendar:clock.calendar,percent:clock.reminder.percent,enabled:clock.reminder.enabled});
 const closed=(await db.query(`SELECT actor_id,after_state FROM audit_events
  WHERE entity_type='digital_material_investment' AND entity_id=$1 AND action='preparation_material_reminder_closed'
   AND after_state->>'fingerprint'=$2 ORDER BY created_at DESC,id LIMIT 1`,[basis.handoverId,fingerprint])).rows[0];
 const termination=await journeyTermination(db,{kind:'order',id:basis.orderId},now.toISOString())
  ??(basis.sourceId?await journeyTermination(db,{kind:'source',id:basis.sourceId},now.toISOString()):null);
 const asOf=termination?.at?Date.parse(termination.at):now.getTime(),due=Date.parse(dueAt);
 const status=termination&&!termination.at?'waiting':asOf>due||asOf===due&&exclusive?'overdue':warningAt&&asOf>=Date.parse(warningAt)?'warning':'waiting';
 return {fingerprint,handoverId:basis.handoverId,handoverVersion:origin?.version??null,adoptedPlanId:saved.id,startedAt,dueAt,warningAt,exclusive,
  calendar:clock.calendar,percent:clock.reminder.percent,enabled:clock.reminder.enabled,
  status,termination:termination?{at:termination.at,kind:termination.kind}:null,
  closed:closed?{actorId:closed.actor_id,at:closed.after_state.occurredAt,reason:closed.after_state.reason}:null};
}
