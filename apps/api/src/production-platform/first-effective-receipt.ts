import type {ScheduleOccurrence} from '@dx-rework/contracts';

export type EffectiveReceiptTime={id:string;receivedAt:string|null;receivedDate?:string|null};
const DAY=86400000;
const bounds=(row:EffectiveReceiptTime):readonly[number,number]|null=>{
 if(row.receivedAt){const at=Date.parse(row.receivedAt);return Number.isFinite(at)?[at,at]:null;}
 if(row.receivedDate){const at=Date.parse(row.receivedDate+'T00:00:00+08:00');return Number.isFinite(at)?[at,at+DAY-1]:null;}
 return null;
};

/** Input is the complete, currently valid positive-quantity scope. Registration
 * order and synthetic midnight are never evidence of the first occurrence. */
export function firstEffectiveReceipt<T extends EffectiveReceiptTime>(receipts:readonly T[]):{delivered:boolean;first:T|null;occurred:ScheduleOccurrence;candidateIds:string[];reason:string|null}{
 const rows=[...new Map(receipts.map(row=>[row.id,row])).values()];
 if(!rows.length)return {delivered:false,first:null,occurred:{precision:'unknown'},candidateIds:[],reason:'尚无有效实收'};
 const ranges=rows.map(bounds);
 if(ranges.some(row=>!row))return {delivered:true,first:null,occurred:{precision:'unknown'},candidateIds:rows.map(row=>row.id),reason:'有效实收存在未知发生时间，首次交付时间待核'};
 const earliestEnd=Math.min(...ranges.map(row=>row![1]));
 const candidates=rows.filter((_,index)=>ranges[index]![0]<=earliestEnd);
 const min=Math.min(...ranges.map(row=>row![0])),max=earliestEnd;
 const day=(at:number)=>new Date(at+28800000).toISOString().slice(0,10);
 const occurred:ScheduleOccurrence=min===max?{precision:'instant',at:new Date(min).toISOString()}:day(min)===day(max)?{precision:'date',date:day(min)}:{precision:'unknown'};
 return {delivered:true,first:candidates.length===1?candidates[0]!:null,occurred,candidateIds:candidates.map(row=>row.id),reason:occurred.precision==='instant'?null:occurred.precision==='date'?'首次交付仅可确定日期，精确时刻待核':'首次交付时间待核'};
}
