import type {OrderClosureSheet} from '@dx-rework/contracts/order-closure';
import type {SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
/** Native packing records one cumulative style/PO quantity, not per-receipt allocations. Never invent FIFO. */
export function packingSlaEvidence(sheet:OrderClosureSheet){
 const facts:Record<string,SlaNodeFact>={},limitations:Array<{lineId:string;reason:string}>=[];
 for(const line of sheet.lines){
  const checks=sheet.quality?.filter(q=>q.lineId===line.lineId&&q.quantity>0)??[];
  const single=checks.length===1?checks[0]:null;
  const ready=single?.inspected&&single.qualifiedQuantity===single.quantity&&single.completedAt&&line.actualQuantity===line.documentQuantity?single.completedAt:null;
  const end=line.packingRecordedAt??null,complete=line.packingQuantity!==null&&line.packingQuantity>=line.orderedQuantity;
  const usableStart=ready&&(!end||Date.parse(ready)<=Date.parse(end))?ready:null;
  if(checks.length>1)limitations.push({lineId:line.lineId,reason:'原装箱仅记录本PO累计数量，尚无各回货批次装箱分配，不能冒充逐批起止时刻'});
  else if(!usableStart)limitations.push({lineId:line.lineId,reason:'尚无完整的合格可装起点依据，实际装箱事实保留'});
  if(usableStart||end)facts[`garment_packing:${line.lineId}`]={businessCompleted:complete,evidence:`packing:${line.packingRevisionId??'pending'}:qc:${single?.eventId??'unknown'}`,
   batchCoverageComplete:checks.length===1&&line.actualQuantity>=line.orderedQuantity,batchWindows:[{startedAt:usableStart,completedAt:complete?end:null,complete,evidence:`packing:${line.packingRevisionId??'pending'}:qc:${single?.eventId??'unknown'}`,
    deadline:usableStart&&single?.packingMinutes!=null?new Date(Date.parse(usableStart)+single.packingMinutes*60000).toISOString():null,
    warningAt:usableStart&&single?.packingMinutes!=null&&single.warningPercent!=null?new Date(Date.parse(usableStart)+single.packingMinutes*60000*single.warningPercent/100).toISOString():null}],
   ...(usableStart?{startedAt:usableStart}:{}),...(complete&&end?{completedAt:end}:{})};
 }
 return {facts,limitations};
}
