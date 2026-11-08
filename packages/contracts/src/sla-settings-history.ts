import {z} from 'zod';
import type {DigitalSlaValue,DigitalSlaValues} from './digital-sla.js';
export const SlaHistoryQuerySchema=z.object({beforeVersion:z.coerce.number().int().positive().optional(),pageSize:z.coerce.number().int().min(1).max(50).default(10)}).strict();
export type SlaHistoryQuery=z.infer<typeof SlaHistoryQuerySchema>;
export type SlaHistoryRow={version:number;publishedAt:string;publishedBy:string|null;reason:string;scope:'new_orders'};
export type SlaHistoryPage={currentVersion:number;total:number;items:SlaHistoryRow[];nextBeforeVersion:number|null};
export type SlaVersionDifference={key:string;label:string;historical:DigitalSlaValue;current:DigitalSlaValue};
export type SlaVersionDetail=SlaHistoryRow&{currentVersion:number;values:DigitalSlaValues;differences:SlaVersionDifference[]};
export const SlaCopyVersionSchema=z.object({sourceVersion:z.number().int().positive(),expectedVersion:z.number().int().nonnegative(),expectedDraftRevision:z.number().int().nonnegative()}).strict();
export type SlaCopyVersion=z.infer<typeof SlaCopyVersionSchema>;
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
/** Legacy omitted notification metadata means enabled, exactly as the sender. */
export function slaHistoryValueEqual(key:string,a:DigitalSlaValue,b:DigitalSlaValue):boolean{
 const effective=(value:DigitalSlaValue)=>['warning_ratio','ship_sample_advance'].includes(key)?{...value,notificationEnabled:!('notificationEnabled'in value)||value.notificationEnabled!==false}:value;
 return canonical(effective(a))===canonical(effective(b));
}
export function copiedHistoryValues(historical:DigitalSlaValues,current:DigitalSlaValues):DigitalSlaValues{
 return Object.fromEntries(Object.entries(historical).map(([key,value])=>[key,structuredClone(slaHistoryValueEqual(key,value,current[key]!)?current[key]!:value)]));
}

export const SlaApplicationCandidatesQuerySchema=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),search:z.string().trim().max(100).default('')}).strict();
export type SlaApplicationCandidatesQuery=z.infer<typeof SlaApplicationCandidatesQuerySchema>;
export type SlaApplicationCandidate={orderId:string;designStyleNo:string;customerCode:string;pos:string[];adoptedVersion:number|null;selectable:boolean;reason:string|null};
export type SlaApplicationCandidatesPage={items:SlaApplicationCandidate[];page:number;total:number;pageSize:15};
