import type {ClosureLine} from '@dx-rework/contracts/order-closure';
/** Projection only: effective native receipts/packing remain the sole quantity source. */
export function receivingSummary(lines:(Pick<ClosureLine,'lineId'|'orderedQuantity'|'actualQuantity'|'packingQuantity'>&Partial<Pick<ClosureLine,'packingRevisionId'|'effectivePackingQuantity'>>)[]){
 const unique=new Map(lines.map(line=>[line.lineId,line]));
 const expected=[...unique.values()].reduce((n,l)=>n+l.orderedQuantity,0);
 const received=[...unique.values()].reduce((n,l)=>n+l.actualQuantity,0);
 const effective=(line:typeof lines[number])=>line.effectivePackingQuantity===undefined?line.packingQuantity:line.effectivePackingQuantity;
 const unknown=[...unique.values()].filter(line=>effective(line)===null).length;
 const packed=[...unique.values()].reduce((n,l)=>n+(effective(l)??0),0);
 return {expected,received,remaining:Math.max(0,expected-received),excess:Math.max(0,received-expected),
  status:unique.size>0&&expected>0&&received>=expected?'已收齐' as const:'待收齐' as const,
  shipmentQuantity:unknown?null:packed,knownShipmentQuantity:packed,unknownPackingLineCount:unknown,shipmentStatus:unknown?'未知' as const:[...unique.values()].some(l=>l.packingQuantity!==null&&(l.packingRevisionId===undefined||l.packingRevisionId!==null))?'按有效装箱记录' as const:'尚无装箱记录' as const};
}
/** Backfilled native dates contain synthetic time-of-day; do not expose that as an actual instant. */
export function receiptTime(receivedAt:Date|string,afterState:Record<string,unknown>|null){
 const date=typeof afterState?.receivedDate==='string'?afterState.receivedDate:null;
 if(afterState?.backfilled===true)return {receivedAt:null,receivedDate:date,precision:'date' as const};
 return {receivedAt:new Date(receivedAt).toISOString(),receivedDate:null,precision:'instant' as const};
}
