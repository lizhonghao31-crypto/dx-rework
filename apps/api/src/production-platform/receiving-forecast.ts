import type {Pool,PoolClient} from 'pg';
import {factoryReturnLogistics} from './factory-return-logistics.js';
export type FutureReceipt={key:string;expected:number;received:number;arrival:{fromInclusive:string;toExclusive:string}|null};
export function forecastNetReceipts(expected:number,current:number,future:FutureReceipt[],now:string,unmappedReceived=0){
 if(current>=expected)return {state:'collected' as const,remaining:0,range:null,reason:null,netExpected:0};
 const remaining=expected-current;
 if(unmappedReceived>0)return {state:'unknown' as const,remaining,range:null,reason:'部分有效实收尚无对应工厂发货关联，不能重复加入预计余量',netExpected:0};
 const unique=new Map<string,FutureReceipt>();
 for(const item of future){const old=unique.get(item.key);if(old&&JSON.stringify(old)!==JSON.stringify(item))return {state:'unknown' as const,remaining,range:null,reason:'同一工厂发货范围的预计依据冲突',netExpected:0};unique.set(item.key,item);}
 let cumulative=current;const used:FutureReceipt[]=[];
 const known=[...unique.values()].filter(r=>r.arrival&&Date.parse(r.arrival.toExclusive)>Date.parse(now)).sort((a,b)=>Date.parse(a.arrival!.toExclusive)-Date.parse(b.arrival!.toExclusive));
 for(const item of known){const net=Math.max(0,item.expected-item.received);if(!net)continue;used.push(item);cumulative+=net;if(cumulative>=expected)return {state:'estimated' as const,remaining,range:{fromInclusive:new Date(Math.max(...used.map(r=>Date.parse(r.arrival!.fromInclusive)))).toISOString(),toExclusive:item.arrival!.toExclusive},reason:'仅累计当前有效实收与工厂已发未收净余量；日期范围不是硬期限',netExpected:cumulative-current};}
 return {state:'unknown' as const,remaining,range:null,reason:`当前依据仍少${Math.max(0,expected-cumulative)}件可靠未收预计，不能用已收数量重复补足`,netExpected:cumulative-current};
}
export async function receivingForecast(db:Pick<Pool|PoolClient,'query'>,orderId:string,expected:number,current:number,now=new Date()){
 const logistics=await factoryReturnLogistics(db,orderId,now);
 const shipments=(await db.query(`SELECT s.production_order_id,s.factory_decision_id,s.recorded_quantity,
 coalesce((SELECT sum(coalesce(c.actual_quantity,r.actual_quantity)) FROM sourcing_production_receipt_links link JOIN receiving_receipts r USING(receipt_id) JOIN receiving_batches b USING(receiving_batch_id)
 LEFT JOIN LATERAL(SELECT actual_quantity FROM receiving_receipt_corrections WHERE receipt_id=r.receipt_id ORDER BY created_at DESC,correction_id DESC LIMIT 1)c ON true
 WHERE link.production_order_id=s.production_order_id AND link.factory_decision_id IS NOT DISTINCT FROM s.factory_decision_id AND b.deleted_at IS NULL),0)::bigint AS received
 FROM digital_production_child_links l JOIN sourcing_production_shipments s ON s.production_order_id=l.child_id WHERE l.module='production' AND l.production_order_id=$1`,[orderId])).rows;
 const linked=shipments.reduce((n,r)=>n+Number(r.received),0);
 return forecastNetReceipts(expected,current,shipments.map(s=>({key:`${s.production_order_id}:${s.factory_decision_id??'original'}`,expected:Number(s.recorded_quantity),received:Number(s.received),arrival:logistics.find(r=>r.productionId===s.production_order_id&&r.factoryDecisionId===s.factory_decision_id)?.arrivalRange??null})),now.toISOString(),Math.max(0,current-linked));
}
