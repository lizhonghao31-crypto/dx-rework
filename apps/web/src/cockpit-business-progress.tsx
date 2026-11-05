import {JOURNEY_STAGES, type JourneyBusinessProgress, type OrderJourney} from '@dx-rework/contracts/digital-production-journey';

export function businessProgressLabel(progress: JourneyBusinessProgress): string {
  return progress.unknown
    ? `已完成${progress.completed}项 / 已知适用${progress.applicable}项，另${progress.unknown}项依据未齐`
    : `需完成${progress.applicable}项业务要求，已完成${progress.completed}项`;
}

/** Actual, adopted plan and quantity facts remain separately named and inspectable. */
export function CockpitBusinessProgress({order}: {order: OrderJourney}) {
  const progress = order.businessProgress;
  if (!progress) return null;
  const plan = progress.plan;
  return <div aria-label="实际业务与已采用计划">
    <strong>{businessProgressLabel(progress)}</strong>
    <p>{plan.status === 'not_adopted' ? '本单尚未取得已采用的系列计划'
      : plan.status === 'unavailable' ? '当前权限范围未包含本单已采用计划'
      : <>{plan.status === 'partial' ? `已有计划的${plan.covered}项中` : `适用的${progress.applicable}项中`}，截至本次数据时点应完成{plan.due}项
        {plan.status === 'partial' && `；另${plan.missing}项尚无完整对应计划日期`}
        {plan.outstandingDue.length > 0 && `；其中${plan.outstandingDue.length}项尚未完成`}</>}</p>
    <details><summary>查看进度依据与采用版本</summary>
      <p>实际与计划按同一业务要求逐项对应。分批办理不会增加业务要求份数；数量另列。</p>
      <ul>{progress.requirements.map(requirement => <li key={requirement.id}>
        {JOURNEY_STAGES.find(stage => stage.key === requirement.stage)?.label} · {requirement.label}：
        {requirement.applicability === 'not_applicable' ? '不适用' : requirement.applicability === 'unknown' ? '适用范围或依据尚未齐全' : requirement.completed ? '已完成' : '尚未完成'}
        {requirement.reasons.length > 0 && `；${requirement.reasons.join('；')}`}
        {requirement.targets.map((target, index) => <span key={`${target.planId}:${target.scopeRef}:${index}`}>；系列计划第{target.revision}版：{target.at}{target.precision === 'date' ? ' 当天结束' : ''}{target.retainedFromRevision !== null ? '（保留的原采用日期）' : ''}</span>)}
      </li>)}</ul>
    </details>
    {progress.quantities && <div aria-label="订单实际数量">{progress.quantities.lines.map(line => {
      const identity = order.lines.find(value => value.id === line.lineId);
      return <p key={line.lineId}>PO {identity?.po ?? '号码尚未取得'} · {identity?.color}：需求{line.demand}件，实收{line.received}件，
        到仓质检覆盖{line.inspected === null ? '尚未取得' : `${line.inspected}件`}，装箱{line.packed === null ? '尚无记录' : `${line.packed}件`}
        {line.remainingReceipt > 0 && `；还差实收${line.remainingReceipt}件`}
        {line.qualityGap !== null && line.qualityGap > 0 && <strong>；到仓质检仍有{line.qualityGap}件覆盖缺口</strong>}
        {line.qualityConflict && <strong>；原质检覆盖与当前有效实收范围不一致</strong>}
        {line.received > 0 && line.factoryAttribution === 'unknown' && '；实收数量尚不能确认各工厂归属'}
      </p>;
    })}</div>}
  </div>;
}
