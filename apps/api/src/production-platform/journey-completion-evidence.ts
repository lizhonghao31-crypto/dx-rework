import type {JourneyNode} from '@dx-rework/contracts/digital-production-journey';
import {isCalendarDate} from '@dx-rework/contracts/series-calendar';
import {journeyObservedDay} from './journey-risk-clock.js';

export type JourneyCompletionPoint={at:string;precision:'instant'|'date';quality:'verified'|'recorded'};
const instant=(at:string)=>/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(at)&&Number.isFinite(Date.parse(at));

export function journeyActualPoint(node:JourneyNode,asOf:string):JourneyCompletionPoint|null{
 if(node.state==='inherited'){
  const adoption=node.inheritedResult;
  return node.inheritedFrom&&node.progressApplicability!=='unknown'&&adoption?.adoptionSourceRef&&adoption.adoptedRound===node.round
   &&adoption.adoptedAt&&instant(adoption.adoptedAt)&&Date.parse(adoption.adoptedAt)<=Date.parse(asOf)
   ?{at:adoption.adoptedAt,precision:'instant',quality:'recorded'}:null;
 }
 if(node.state!=='completed'||node.actualQuality==='missing'||node.actualQuality==='unavailable')return null;
 if(node.timing?.assessmentIssue)return null;
 if(node.actualDate&&isCalendarDate(node.actualDate))return node.actualDate>journeyObservedDay(asOf)||node.enteredAt&&instant(node.enteredAt)&&node.actualDate<journeyObservedDay(node.enteredAt)?null:{at:node.actualDate,precision:'date',quality:node.actualQuality==='verified'?'verified':'recorded'};
 return node.actualAt&&instant(node.actualAt)&&Date.parse(node.actualAt)<=Date.parse(asOf)&&(!node.enteredAt||Date.parse(node.actualAt)>=Date.parse(node.enteredAt))?{at:node.actualAt,precision:'instant',quality:node.actualQuality==='verified'?'verified':'recorded'}:null;
}

/** A current task's stored lifecycle is not its completion at this observation.
 * Keep date-only recorded proof at its native precision, and let exact current
 * inheritance use its own adoption event. Unverified instants remain visible
 * to the time reader but cannot count as completed work. */
export function journeyCompletedAtObservation(node:JourneyNode,asOf:string):boolean{
 if(node.progressApplicability==='unknown'||node.progressApplicability==='not_applicable')return false;
 const occurrence=journeyActualPoint(node,asOf);
 // The all-PO cutting gate is a native logical conjunction, without its own
 // execution or timestamp. Contradictory evidence still disqualifies it.
 if(!occurrence&&node.key==='cutting_gate'&&node.state==='completed'&&node.occurrence===null
  &&node.instanceId===`cutting_gate:${node.round??0}`&&!node.actualAt&&!node.actualDate&&!node.timing?.assessmentIssue)return true;
 return occurrence!==null&&(node.state==='inherited'||occurrence.precision==='date'||occurrence.quality==='verified');
}
