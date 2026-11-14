import type {JourneyNode} from "@dx-rework/contracts/digital-production-journey";
import {journeyTime} from "./digital-journey-cockpit-model.js";
/** Date-only flow labels retain the full year; original time precision remains accessible. */
export function CockpitDate({value,precision="instant",missing="未登记",stacked=false,short=false}:{value:string|null;precision?:JourneyNode["expectedPrecision"];missing?:string;stacked?:boolean;short?:boolean}){
 const full=journeyTime(value,precision,missing),parts=/^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2})/.exec(full);
 const date=/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(full);
 if(short&&value&&date)return <time dateTime={value} title={full} aria-label={full}>{date[1]}-{date[2]!.padStart(2,"0")}-{date[3]!.padStart(2,"0")}</time>;
 if(!parts)return short&&value&&/^\d{4}-\d{2}-\d{2}$/.test(full)?<time dateTime={value} title={full} aria-label={full}>{full}</time>:<span>{full}</span>;
 const day=`${parts[1]}-${parts[2]!.padStart(2,"0")}-${parts[3]!.padStart(2,"0")}`,clock=`${parts[4]!.padStart(2,"0")}:${parts[5]}`;
 return <time dateTime={value??undefined} title={full} aria-label={full} className={stacked?"cockpit-compact-date":undefined}>{stacked?<><span>{day}</span><span>{clock}</span></>:`${day} ${clock}`}</time>;
}
