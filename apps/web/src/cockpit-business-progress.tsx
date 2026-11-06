import {type JourneyBusinessProgress, type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {BusinessDateFacts} from './cockpit-business-dates.js';

export function businessProgressLabel(progress: JourneyBusinessProgress): string {
  return progress.unknown
    ? `已完成${progress.completed}项 / 已知适用${progress.applicable}项，另${progress.unknown}项依据未齐`
    : `需完成${progress.applicable}项业务要求，已完成${progress.completed}项`;
}

/** Counts only the native returned quantity rows; factory ambiguity never hides a receipt shortage. */
export function CockpitReceiptSummary({order,compact=false}:{order:OrderJourney;compact?:boolean}){
 const lines=order.businessProgress?.quantities?.lines;
 if(!lines?.length)return null;
 if(new Set(lines.map(line=>line.lineId)).size!==lines.length||lines.some(line=>![line.demand,line.received,line.remainingReceipt].every(value=>Number.isSafeInteger(value)&&value>=0)))return <p>原实收数量明细待核，暂不能汇总。</p>;
 const complete=lines.length===order.lines.length&&order.lines.every(line=>lines.some(row=>row.lineId===line.id&&row.demand===line.orderedQuantity));
 const missing=lines.reduce((sum,line)=>sum+line.remainingReceipt,0),unknown=lines.filter(line=>line.factoryAttribution==='unknown').reduce((sum,line)=>sum+line.received,0);
 return <p className="cockpit-receipt-summary" aria-label="实收缺口与工厂归属"><strong>{complete?'全单':'当前可见范围'}{missing?`还差实收${missing}件`:'实收数量已齐'}</strong>{unknown>0&&(compact?`；${unknown}件工厂归属待核`:`；已收${unknown}件尚不能确认来自哪家工厂`)}{unknown>0&&!compact&&<small>请从原收货记录核对工厂归属。</small>}</p>;
}

/** Actual, adopted plan and quantity facts remain separately named and inspectable. */
export function CockpitBusinessProgress({order,compact=false}: {order: OrderJourney;compact?:boolean}) {
  const progress = order.businessProgress;
  if (!progress) return null;
  const plan = progress.plan;
  const quantityRow=(line:NonNullable<JourneyBusinessProgress['quantities']>['lines'][number])=>{
      const identity = order.lines.find(value => value.id === line.lineId);
      return <p key={line.lineId}>PO {identity?.po ?? '号码尚未取得'} · {identity?.color}：需求{line.demand}件，实收{line.received}件，
        到仓质检覆盖{line.inspected === null ? '尚未取得' : `${line.inspected}件`}，装箱{line.packed === null ? '尚无记录' : `${line.packed}件`}
        {line.remainingReceipt > 0 && `；还差实收${line.remainingReceipt}件`}
        {line.qualityGap !== null && line.qualityGap > 0 && <strong>；到仓质检仍有{line.qualityGap}件覆盖缺口</strong>}
        {line.qualityConflict && <strong>；原质检覆盖与当前有效实收范围不一致</strong>}
        {line.received > 0 && line.factoryAttribution === 'unknown' && '；实收数量尚不能确认各工厂归属'}
      </p>;
  };
  return <div className="cockpit-business-progress" aria-label="实际业务与已采用计划">
    <strong>{compact?progress.unknown?`已完成${progress.completed}项 / 已知${progress.applicable}项`:`已完成${progress.completed}/${progress.applicable}项`:businessProgressLabel(progress)}</strong>
    {compact&&progress.unknown>0&&<small>另{progress.unknown}项依据未齐</small>}
    {progress.applicable>0&&progress.unknown===0&&progress.ratio!==null&&<div className="cockpit-business-meter" role="progressbar" aria-label="实际业务完成比例" aria-valuemin={0} aria-valuemax={progress.applicable} aria-valuenow={progress.completed}><i style={{width:`${Math.max(0,Math.min(1,progress.ratio))*100}%`}}/></div>}
    {!compact&&order.orderId&&<p>{plan.status === 'not_adopted' ? '本单尚未取得已采用的系列计划'
      : plan.status === 'unavailable' ? '当前权限范围未包含本单已采用计划'
      : <>已采用系列计划第{plan.revision??'待核'}版；{plan.status === 'partial' ? `已有计划的${plan.covered}项中` : `适用的${progress.applicable}项中`}，截至本次数据时点应完成{plan.due}项
        {plan.status === 'partial' && `；另${plan.missing}项尚无完整对应计划日期`}
        {plan.outstandingDue.length > 0 && `；其中${plan.outstandingDue.length}项尚未完成`}</>}</p>}
    {!compact&&plan.status==='complete'&&progress.applicable>0&&<div className="cockpit-business-meter is-plan" role="progressbar" aria-label="已采用计划截至当前应完成" aria-valuemin={0} aria-valuemax={progress.applicable} aria-valuenow={plan.due}><i style={{width:`${Math.max(0,Math.min(1,plan.due/progress.applicable))*100}%`}}/></div>}
    {!compact&&progress.dates&&<BusinessDateFacts dates={progress.dates.overall} showPlan={Boolean(order.orderId)}/>}
    <CockpitReceiptSummary order={order} compact={compact}/>
    {!compact&&progress.quantities&&<div aria-label="订单实际数量">{progress.quantities.lines.map(quantityRow)}</div>}
  </div>;
}
