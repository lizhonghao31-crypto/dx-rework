import {z} from 'zod';
import type {DigitalSlaValue,DigitalSlaValues} from './digital-sla.js';
export const SlaHistoryQuerySchema=z.object({
 beforeVersion:z.coerce.number().int().positive().optional(),
 pageSize:z.coerce.number().int().min(1).max(50).default(10),
 page:z.coerce.number().int().min(1).max(100000).optional(),
 browseMaxVersion:z.coerce.number().int().nonnegative().optional(),
 browseToken:z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict().superRefine((query,context)=>{
 const hasBrowse=query.browseMaxVersion!==undefined||query.browseToken!==undefined;
 if(query.page===undefined&&hasBrowse||query.page!==undefined&&query.beforeVersion!==undefined){
  context.addIssue({code:'custom',message:'版本游标和页码浏览不可混用'});
 }else if(hasBrowse&&(query.browseMaxVersion===undefined||query.browseToken===undefined)){
  context.addIssue({code:'custom',message:'页码浏览上界和回执须同时提供'});
 }
});
export type SlaHistoryQuery=z.infer<typeof SlaHistoryQuerySchema>;
export type SlaHistoryRow={version:number;publishedAt:string;publishedBy:string|null;reason:string;scope:'new_orders'};
export type SlaHistoryPage={currentVersion:number;total:number;items:SlaHistoryRow[];nextBeforeVersion:number|null;
 page?:number;pageSize?:number;browseMaxVersion?:number;browseToken?:string;newVersionAvailable?:boolean;refreshRequired?:boolean;
};
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
