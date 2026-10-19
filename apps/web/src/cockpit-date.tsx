import type {JourneyNode} from "@dx-rework/contracts/digital-production-journey";
import {journeyTime} from "./digital-journey-cockpit-model.js";
/** Compact visible date; the full original precision remains in title and accessible name. */
export function CockpitDate({value,precision="instant",missing="未登记",stacked=false}:{value:string|null;precision?:JourneyNode["expectedPrecision"];missing?:string;stacked?:boolean}){
 const full=journeyTime(value,precision,missing),parts=/^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2})/.exec(full);
 if(!parts)return <span>{full}</span>;
 const day=`${parts[1]}-${parts[2]!.padStart(2,"0")}-${parts[3]!.padStart(2,"0")}`,clock=`${parts[4]!.padStart(2,"0")}:${parts[5]}`;
 return <time dateTime={value??undefined} title={full} aria-label={full} className={stacked?"cockpit-compact-date":undefined}>{stacked?<><span>{day}</span><span>{clock}</span></>:`${day} ${clock}`}</time>;
}
