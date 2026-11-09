import type {FrozenInitialTimelineInput} from './fixed-timeline-initial-input.js';
import type {FixedTimelineCalendar} from './fixed-timeline-targets.js';

/** Planning and responsibility are separate adopted values. Changing a planning
 * budget does not change the original personal SLA or its calendar.
 */
export function frozenWorkDefinition(initial:FrozenInitialTimelineInput,key:string,dualCraft=false){
 const parameter=initial.data.unified.values.parameters[key]?.value;
 const adopted=initial.data.planning?.values[key] as {minutes?:number;calendar?:FixedTimelineCalendar;responsibilityAdopted?:boolean;responsibilityMinutes?:number;responsibilityCalendar?:FixedTimelineCalendar}|undefined;
 const ref=initial.data.planning?`${initial.data.planning.standardRef}:${key}`:null;
 const own=parameter?.kind==='duration'||parameter?.kind==='included',originalMinutes=parameter&&'minutes'in parameter?parameter.minutes:null;
 return {
  minutes:adopted?.minutes??(dualCraft?null:originalMinutes),
  calendar:adopted?.calendar??(dualCraft||originalMinutes===null?null:'continuous' as const),
  planningParameterRef:adopted?ref:!dualCraft&&originalMinutes!==null?`${initial.data.unified.snapshotRef}:${key}`:null,
  responsibilitySlaRef:dualCraft?(adopted?.responsibilityAdopted?ref:null):own?`${initial.data.unified.snapshotRef}:${key}`:null,
  responsibilityMinutes:dualCraft?(adopted?.responsibilityAdopted?adopted.responsibilityMinutes??null:null):own?originalMinutes:null,
  responsibilityCalendar:dualCraft?(adopted?.responsibilityAdopted?adopted.responsibilityCalendar??null:null):own?'continuous' as const:null,
 };
}
