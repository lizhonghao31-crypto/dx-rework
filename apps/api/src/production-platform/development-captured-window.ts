import type {SlaResponsibilityWindow} from '@dx-rework/domain/digital-sla-plan';
type Row={entered_at:Date|string|null;due_at:Date|string|null;warning_at?:Date|string|null;sla_basis:Record<string,unknown>|null;instance_entered_at?:Date|string|null;instance_due_at?:Date|string|null;instance_warning_at?:Date|string|null;instance_sla_basis?:Record<string,unknown>|null};
const iso=(at:Date|string|null|undefined)=>at==null?null:new Date(at).toISOString();
/** Caller has already verified the native responsibility occurrence. This
 * keeps the current captured revision's D/warning; it never interpolates P or
 * applies today's calendar to a historical task. Unknown D remains unknown. */
export function developmentCapturedWindow(row:Row,trustedStart:string|null,sourceRef:string):SlaResponsibilityWindow|undefined{
 if(!trustedStart)return;
 const own=<K extends keyof Row>(key:K,fallback:Row[K])=>Object.hasOwn(row,key)?row[key]:fallback;
 const start=iso(own('instance_entered_at',row.entered_at)),due=iso(own('instance_due_at',row.due_at)),basis=own('instance_sla_basis',row.sla_basis);
 if(!start||!basis)return;
 const calendar=['continuous','natural_days','beijing_sunday_excluded'].includes(String(basis.calendarRef))?basis.calendarRef as SlaResponsibilityWindow['calendar']:null;
 return {startedAt:start,deadline:{at:due,exclusive:basis.exclusive===true,reasons:due?[]:['原任务尚无可信独立截止']},warningAt:iso(own('instance_warning_at',row.warning_at)),calendar,sourceRef};
}
