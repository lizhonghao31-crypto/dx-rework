import type {OrderClosureSheet} from '@dx-rework/contracts/order-closure';
import type {SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {packingQualityCoverage} from './packing-quality-coverage.js';
/** Native packing records one cumulative style/PO quantity, not per-receipt allocations. Never invent FIFO. */
export function packingSlaEvidence(sheet:OrderClosureSheet){
 const facts:Record<string,SlaNodeFact>={},limitations:Array<{lineId:string;reason:string}>=[];
 for(const line of sheet.lines){
  if(line.cutScope==='unresolved'||line.packingRevisionId!==null&&line.packingQuantity===null){limitations.push({lineId:line.lineId,reason:'原开裁与装箱范围尚不能唯一对应本PO，不推定可装起点或物理完成'});continue;}
  const checks=[...new Map((sheet.quality?.filter(q=>q.lineId===line.lineId&&q.quantity>0)??[]).map(q=>[q.receiptId,q])).values()];
  const single=checks.length===1?checks[0]:null;
  const ready=single?.inspected&&single.qualifiedQuantity===single.quantity&&single.completedAt&&line.actualQuantity===line.documentQuantity?single.completedAt:null;
  const actual=line.packingActualTime;
  const end=actual?.precision==='instant'?actual.at:null;
  const covered=checks.length>0&&checks.reduce((sum,q)=>sum+q.quantity,0)>=line.orderedQuantity;
  const quality=packingQualityCoverage(line,sheet.quality);
  const qualified=quality.effectiveQuantity!==null;
  const complete=qualified&&quality.effectiveQuantity!>=line.orderedQuantity;
  const physical=complete&&line.actualQuantity>=line.orderedQuantity&&qualified;
  const actualEnd=physical&&end&&Number.isFinite(Date.parse(end))&&checks.every(q=>q.completedAt&&Number.isFinite(Date.parse(q.completedAt))&&Date.parse(q.completedAt)<=Date.parse(end))?end:null;
  const actualDate=physical&&actual?.precision==='date'&&checks.every(q=>q.completedAt&&Number.isFinite(Date.parse(q.completedAt))&&beijingCalendarDate(new Date(q.completedAt))<=actual.date)?actual.date:null;
  const usableStart=ready&&(!end||Date.parse(ready)<=Date.parse(end))?ready:null;
  if(checks.length>1)limitations.push({lineId:line.lineId,reason:'原装箱仅记录本PO累计数量，尚无各回货批次装箱分配，不能冒充逐批起止时刻'});
  else if(!usableStart)limitations.push({lineId:line.lineId,reason:'尚无完整的合格可装起点依据，实际装箱事实保留'});
  if(!qualified)limitations.push({lineId:line.lineId,reason:'本PO有效到仓质检及合格覆盖待核，装箱累计不替代质量放行事实'});
  if(complete&&!actualEnd)limitations.push({lineId:line.lineId,reason:actualDate?'实际装箱仅有日期，不能推定具体时刻':'数量已足，但尚无质量放行后的可信实际装箱时间'});
  if(usableStart||line.packingRevisionId)facts[`garment_packing:${line.lineId}`]={businessCompleted:complete,evidence:`packing:${line.packingRevisionId??'pending'}:qc:${single?.eventId??'unknown'}`,
   batchCoverageComplete:covered&&line.actualQuantity>=line.orderedQuantity,batchWindows:[{startedAt:usableStart,completedAt:actualEnd,complete,evidence:`packing:${line.packingRevisionId??'pending'}:qc:${single?.eventId??'unknown'}`,
    deadline:usableStart&&single?.packingMinutes!=null?new Date(Date.parse(usableStart)+single.packingMinutes*60000).toISOString():null,
    warningAt:usableStart&&single?.packingMinutes!=null&&single.warningPercent!=null?new Date(Date.parse(usableStart)+single.packingMinutes*60000*single.warningPercent/100).toISOString():null}],
   ...(usableStart?{startedAt:usableStart}:{}),...(actualEnd?{completedAt:actualEnd}:{}),...(actualDate?{completedDate:actualDate}:{})};
 }
 return {facts,limitations};
}
