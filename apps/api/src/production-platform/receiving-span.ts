import type {Pool,PoolClient} from 'pg';
import {receiptTime} from './receiving-summary.js';
import {firstEffectiveReceipt} from './first-effective-receipt.js';
export type ReceiptChange={id:string;receiptId:string;recordedAt:string;quantity:number;actualAt:string|null;date:string|null;kind:'receipt'|'correction'|'deletion'};
export function replayReceivingSpan(expected:number,changes:ReceiptChange[]){
 const quantities=new Map<string,number>(),history:Array<{recordedAt:string;actualAt:string|null;actualDate?:string;received:number;state:'已收齐'|'待收齐';cause:ReceiptChange['kind'];evidence:string}>=[];
 let received=0,collected=false;
 for(const event of [...changes].sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)||a.id.localeCompare(b.id))){
  received+=event.quantity-(quantities.get(event.receiptId)??0);quantities.set(event.receiptId,event.quantity);
  const next=expected>0&&received>=expected;
  if(next!==collected){history.push({recordedAt:event.recordedAt,actualAt:event.kind==='receipt'?event.actualAt:null,
   ...(event.kind==='receipt'&&!event.actualAt&&event.date?{actualDate:event.date}:{}),
   received,state:next?'已收齐':'待收齐',cause:event.kind,evidence:event.id});collected=next;}
 }
 return {received,history};
}
export async function receivingSpan(db:Pick<Pool|PoolClient,'query'>,orderId:string,expected:number,currentReceived:number,scope?:{lineId:string;position:number}){
 const original=(await db.query("SELECT after_state FROM audit_events WHERE entity_id=$1 AND action='digital_order_created' ORDER BY created_at,id LIMIT 1",[orderId])).rows[0]?.after_state;
 const initialLines=scope?original?.lines?.slice(scope.position-1,scope.position):original?.lines;
 const initial=initialLines?.reduce((n:number,l:{sizes:Array<{quantity:number}>})=>n+l.sizes.reduce((sum,q)=>sum+q.quantity,0),0);
 const receipts=(await db.query(`SELECT DISTINCT r.receipt_id,r.received_at,r.actual_quantity,e.event_id,e.created_at,e.after_state,b.deleted_at,b.last_operation_event_id
 FROM digital_production_child_lines l JOIN receiving_receipts r ON r.receipt_id=l.child_id JOIN receiving_batches b USING(receiving_batch_id)
 JOIN operation_events e ON e.event_id=r.operation_event_id WHERE l.module='receiving' AND l.production_order_id=$1 ${scope?'AND l.line_id=$2':''}` ,scope?[orderId,scope.lineId]:[orderId])).rows;
 const corrections=receipts.length?(await db.query('SELECT * FROM receiving_receipt_corrections WHERE receipt_id=ANY($1::uuid[]) ORDER BY created_at,correction_id',[receipts.map(r=>r.receipt_id)])).rows:[];
 const changes:ReceiptChange[]=[];
 for(const r of receipts){const time=receiptTime(r.received_at,r.after_state);changes.push({id:r.event_id,receiptId:r.receipt_id,recordedAt:new Date(r.created_at).toISOString(),quantity:Number(r.actual_quantity),actualAt:time.receivedAt,date:time.receivedDate,kind:'receipt'});
  for(const c of corrections.filter(c=>c.receipt_id===r.receipt_id))changes.push({id:c.operation_event_id,receiptId:r.receipt_id,recordedAt:new Date(c.created_at).toISOString(),quantity:Number(c.actual_quantity),actualAt:null,date:null,kind:'correction'});
  if(r.deleted_at)changes.push({id:`${r.last_operation_event_id}:${r.receipt_id}`,receiptId:r.receipt_id,recordedAt:new Date(r.deleted_at).toISOString(),quantity:0,actualAt:null,date:null,kind:'deletion'});
 }
 const replay=replayReceivingSpan(expected,changes),reason=initial!==expected?'应收数量历史尚未完整映射，不以当前数量改写旧收齐时间':replay.received!==currentReceived?'原收货合并或批量调整尚未完整映射，收齐历时保留未知':null;
 const effective=receipts.filter(r=>!r.deleted_at&&Number(corrections.filter(c=>c.receipt_id===r.receipt_id).at(-1)?.actual_quantity??r.actual_quantity)>0)
  .map(r=>({id:r.receipt_id,...receiptTime(r.received_at,r.after_state)}));
 const delivery=firstEffectiveReceipt(effective),first=delivery.first,last=replay.history.at(-1),correctedAfterCross=last&&changes.some(c=>c.kind!=='receipt'&&c.recordedAt>=last.recordedAt),end=!reason&&!correctedAfterCross&&currentReceived>=expected&&last?.state==='已收齐'?last.actualAt:null;
 const collectedDate=!reason&&!correctedAfterCross&&currentReceived>=expected&&last?.state==='已收齐'&&!end?last.actualDate??null:null;
 return {firstEffectiveReceipt:first,firstDelivery:delivery,history:reason?[]:replay.history,collectedAt:end,collectedDate,
  elapsedHours:!reason&&delivery.occurred.precision==='instant'&&end&&Date.parse(end)>=Date.parse(delivery.occurred.at)?(Date.parse(end)-Date.parse(delivery.occurred.at))/3600000:null,
  reason:reason??delivery.reason??(collectedDate?'实际收齐仅有日期，精确历时未知':currentReceived>=expected&&!end?'更正后达到应收，实际收齐时刻未知':null)};
}
