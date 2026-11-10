import type {DevelopmentOccurrence} from '@dx-rework/contracts/digital-development-execution';
import {DevelopmentOccurrenceSchema} from '@dx-rework/contracts/digital-development-execution';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {isCalendarDate} from '@dx-rework/contracts/series-calendar';
import {ApplicationError} from '../platform/errors.js';

/** A native action may happen now or register an earlier occurrence. A date is
 * never converted to midnight; registration remains the original SQL audit. */
export function developmentOccurrence(input:DevelopmentOccurrence|undefined,now:Date,enteredAt?:string|null){
 const actual=input===undefined?null:DevelopmentOccurrenceSchema.parse(input);
 const at=actual===null?now.toISOString():actual.precision==='instant'?new Date(actual.at).toISOString():null;
 const date=actual?.precision==='date'?actual.date:null;
 if(at&&(Date.parse(at)>now.getTime()||enteredAt&&Date.parse(at)<Date.parse(enteredAt))
  ||date&&(date>beijingCalendarDate(now)||enteredAt&&date<beijingCalendarDate(new Date(enteredAt))))
  throw new ApplicationError('DEVELOPMENT_OCCURRENCE_CONFLICT','实际发生时间不能晚于本单当前时间或早于本节点开始',409);
 return {actualCompletedAt:at,actualCompletedDate:date,timeQuality:actual===null?'现场登记':actual.precision==='unknown'?'缺失':'补报未核实'};
}

/** Old notes and recorded_at alone do not prove when the event happened. */
export function developmentRecordedTime(payload:Record<string,unknown>|null|undefined,asOf:string){
 const quality=payload?.timeQuality;
 if(!['现场登记','已核实','补报未核实'].includes(String(quality)))return null;
 const at=payload?.actualCompletedAt,date=payload?.actualCompletedDate;
 const verified=quality==='现场登记'||quality==='已核实';
 if(typeof at==='string'&&/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(at)&&Number.isFinite(Date.parse(at))&&Date.parse(at)<=Date.parse(asOf))
  return {at:new Date(at).toISOString(),date:null,quality:verified?'verified' as const:'unverified' as const};
 if(typeof date==='string'&&isCalendarDate(date)&&date<=beijingCalendarDate(new Date(asOf)))
  return {at:null,date,quality:verified?'verified' as const:'unverified' as const};
 return null;
}
