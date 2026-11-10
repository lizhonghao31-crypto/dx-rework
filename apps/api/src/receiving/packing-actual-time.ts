import {PackingTimeInputSchema,type PackingTimeInput,type PackingActualTime} from '@dx-rework/contracts';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {ApplicationError} from '../platform/errors.js';

export function normalizePackingTime(value:unknown):PackingTimeInput|undefined{
 if(value===undefined)return undefined;
 const parsed=PackingTimeInputSchema.safeParse(value);
 if(!parsed.success)throw new ApplicationError('VALIDATION_ERROR','请选择有效的实际装箱时间或日期',400);
 return parsed.data;
}
/** Invoked only inside the original authorized, locked and idempotent write.
 * Root quantity correction without an occurrence does not manufacture one.
 */
export function resolvePackingTime(input:PackingTimeInput|undefined,now:string):PackingActualTime{
 if(!input||input.mode==='unknown')return {precision:'unknown'};
 if(input.mode==='now')return {precision:'instant',at:now};
 if(input.mode==='instant'){
  if(Date.parse(input.value)>Date.parse(now))throw new ApplicationError('VALIDATION_ERROR','实际装箱时间不能晚于本单当前时间',400);
  return {precision:'instant',at:new Date(input.value).toISOString()};
 }
 if(input.value>beijingCalendarDate(new Date(now)))throw new ApplicationError('VALIDATION_ERROR','实际装箱日期不能晚于本单当前日期',400);
 return {precision:'date',date:input.value};
}
