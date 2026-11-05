import {JOURNEY_STAGES, type JourneyBusinessProgress, type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {BusinessDateFacts} from './cockpit-business-dates.js';

export function businessProgressLabel(progress: JourneyBusinessProgress): string {
  return progress.unknown
    ? `已完成${progress.completed}项 / 已知适用${progress.applicable}项，另${progress.unknown}项依据未齐`
    : `需完成${progress.applicable}项业务要求，已完成${progress.completed}项`;
}

/** Counts only the native returned quantity rows; factory ambiguity never hides a receipt shortage. */
export function CockpitReceiptSummary({order}:{order:OrderJourney}){
 const lines=order.businessProgress?.quantities?.lines;
 if(!lines?.length)return null;
 if(new Set(lines.map(line=>line.lineId)).size!==lines.length||lines.some(line=>![line.demand,line.received,line.remainingReceipt].every(value=>Number.isSafeInteger(value)&&value>=0)))return <p>原实收数量明细待核，暂不能汇总。</p>;
 const complete=lines.length===order.lines.length&&order.lines.every(line=>lines.some(row=>row.lineId===line.id&&row.demand===line.orderedQuantity));
 const missing=lines.reduce((sum,line)=>sum+line.remainingReceipt,0),unknown=lines.filter(line=>line.factoryAttribution==='unknown').reduce((sum,line)=>sum+line.received,0);
 return <p className="cockpit-receipt-summary" aria-label="实收缺口与工厂归属"><strong>{complete?'全单':'当前可见范围'}{missing?`还差实收${missing}件`:'实收数量已齐'}</strong>{unknown>0&&`；已收${unknown}件尚不能确认来自哪家工厂`}{unknown>0&&<small>请从原收货记录核对工厂归属。</small>}</p>;
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
    <strong>{businessProgressLabel(progress)}</strong>
    {progress.applicable>0&&progress.unknown===0&&progress.ratio!==null&&<div className="cockpit-business-meter" role="progressbar" aria-label="实际业务完成比例" aria-valuemin={0} aria-valuemax={progress.applicable} aria-valuenow={progress.completed}><i style={{width:`${Math.max(0,Math.min(1,progress.ratio))*100}%`}}/></div>}
    {order.orderId&&<p>{plan.status === 'not_adopted' ? '本单尚未取得已采用的系列计划'
      : plan.status === 'unavailable' ? '当前权限范围未包含本单已采用计划'
      : <>已采用系列计划第{plan.revision??'待核'}版；{plan.status === 'partial' ? `已有计划的${plan.covered}项中` : `适用的${progress.applicable}项中`}，截至本次数据时点应完成{plan.due}项
        {plan.status === 'partial' && `；另${plan.missing}项尚无完整对应计划日期`}
        {plan.outstandingDue.length > 0 && `；其中${plan.outstandingDue.length}项尚未完成`}</>}</p>}
    {plan.status==='complete'&&progress.applicable>0&&<div className="cockpit-business-meter is-plan" role="progressbar" aria-label="已采用计划截至当前应完成" aria-valuemin={0} aria-valuemax={progress.applicable} aria-valuenow={plan.due}><i style={{width:`${Math.max(0,Math.min(1,plan.due/progress.applicable))*100}%`}}/></div>}
    {progress.dates&&<BusinessDateFacts dates={progress.dates.overall} showPlan={Boolean(order.orderId)}/>}
    <CockpitReceiptSummary order={order}/>
    <details><summary>查看进度依据与采用版本</summary>
      <p>实际与计划按同一业务要求逐项对应。分批办理不会增加业务要求份数；数量另列。</p>
      <ul>{progress.requirements.map(requirement => <li key={requirement.id}>
        {JOURNEY_STAGES.find(stage => stage.key === requirement.stage)?.label} · {requirement.label}：
        {requirement.applicability === 'not_applicable' ? '不适用' : requirement.applicability === 'unknown' ? '适用范围或依据尚未齐全' : requirement.completed ? '已完成' : '尚未完成'}
        {requirement.reasons.length > 0 && `；${requirement.reasons.join('；')}`}
        {requirement.targets.map((target, index) => <span key={`${target.planId}:${target.scopeRef}:${index}`}>；系列计划第{target.revision}版：{target.at}{target.precision === 'date' ? ' 当天结束' : ''}{target.retainedFromRevision !== null ? '（保留的原采用日期）' : ''}</span>)}
      </li>)}</ul>
      {progress.dates&&<><p>日期依据与缺件：</p><ul>{[...new Set([...progress.dates.overall.actual.reasons,...progress.dates.overall.adoptedPlan.reasons,...progress.dates.overall.forecast.reasons])].map(reason=><li key={reason}>{reason}</li>)}</ul>{progress.dates.overall.adoptedPlan.sourcePlans.length>0&&<p>各要求的采用来源：{progress.dates.overall.adoptedPlan.sourcePlans.map(source=>`第${source.revision}版`).join(' / ')}；保留的原采用日期仍逐项列在以上要求。</p>}</>}
    </details>
    {progress.quantities&&<div aria-label="订单实际数量">{(compact?progress.quantities.lines.slice(0,2):progress.quantities.lines).map(quantityRow)}{compact&&progress.quantities.lines.length>2&&<details data-cockpit-disclosure="quantity-more"><summary>查看其余{progress.quantities.lines.length-2}个PO的实收、质检与装箱</summary>{progress.quantities.lines.slice(2).map(quantityRow)}</details>}</div>}
  </div>;
}
