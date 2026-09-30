import { StatusBadge } from "@dx-rework/ui";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { PATTERN_ORDER_STATUS_LABELS } from "@dx-rework/contracts/pattern-orders";
import { elapsedText, patternTime } from "./pattern-order-client.js";
import { patternWorkflow, type PatternRound, type PatternStage } from "./pattern-workflow.js";

export function PatternRoundRecord({ round, misc, idPrefix = "", summaryOnly = false, omitSummary = false }: { round: PatternRound; misc: boolean; idPrefix?: string; summaryOnly?: boolean; omitSummary?: boolean }) {
  return <>
    {!summaryOnly && round.requestReason && <p className="pattern-note">返工要求：{round.requestReason}</p>}
    <dl className="pattern-facts">
      {!omitSummary && <><div><dt>品类</dt><dd>{round.categoryName}</dd></div>
      {misc ? round.actualHours !== undefined && <div><dt>实际工时</dt><dd>{round.actualHours === null ? "待填写" : `${formatBusinessDecimal(round.actualHours, 2)} 小时`}</dd></div>
        : round.quantity !== null && <div><dt>数量</dt><dd>{formatBusinessDecimal(round.quantity)} {round.unit}</dd></div>}
      {round.agreedAmount !== undefined && <div><dt>本轮价格</dt><dd>{round.agreedAmount === null ? "待核定" : `${formatBusinessDecimal(round.agreedAmount, 2)} 元`}</dd></div>}
      {misc && round.unitPrice !== undefined && <div><dt>小时单价</dt><dd>{formatBusinessDecimal(round.unitPrice, 2)} 元/小时</dd></div>}
      </>}{!summaryOnly && <>
      {round.cancelledAt && <div><dt>取消时间</dt><dd>{patternTime(round.cancelledAt)}</dd></div>}
      {round.cancelledAmount != null && <div><dt>取消费用</dt><dd>{formatBusinessDecimal(round.cancelledAmount, 2)} 元</dd></div>}
      {round.feeConfirmedAt && <div><dt>费用确认</dt><dd>{patternTime(round.feeConfirmedAt)}</dd></div>}
      </>}
    </dl>
    {!summaryOnly && round.segments.length > 0 && <div className="pattern-segments">{round.segments.map(segment => <section className="pattern-segment" id={`${idPrefix}segment-${segment.segmentId}`} key={segment.segmentId}>
      <div className="pattern-section-heading"><strong>{segment.workerName}</strong><StatusBadge tone={segment.wageEligible ? "success" : "info"}>{segment.wageEligible ? "可计薪" : misc && segment.actualHours === null ? "工时待填写" : "待计薪"}</StatusBadge></div>
      <dl className="pattern-facts">
        <div><dt>开始</dt><dd>{patternTime(segment.startedAt)}</dd></div>
        <div><dt>结束</dt><dd>{segment.endedAt ? patternTime(segment.endedAt) : "进行中"}</dd></div>
        {misc && segment.actualHours !== null && <div><dt>实际工时</dt><dd>{formatBusinessDecimal(segment.actualHours, 2)} 小时</dd></div>}
        {segment.amount != null && <div><dt>分配金额</dt><dd>{formatBusinessDecimal(segment.amount, 2)} 元</dd></div>}
      </dl>
    </section>)}</div>}
  </>;
}

export function PatternNodeRecord({ round, misc, stage }: { round: PatternRound; misc: boolean; stage: PatternStage }) {
  const item = patternWorkflow(round, misc).find(value => value.stage === stage)!;
  return <section className="pattern-node-record" aria-label={`${item.label}记录`}>
    <div className="pattern-section-heading"><h3>{item.label}</h3><StatusBadge tone={item.state === "cancelled" || item.state === "stopped" ? "danger" : "info"}>{item.status}</StatusBadge></div>
    {item.node ? <dl className="pattern-facts"><div><dt>进入时间</dt><dd>{patternTime(item.node.enteredAt)}</dd></div><div><dt>结束时间</dt><dd>{item.node.exitedAt ? patternTime(item.node.exitedAt) : "进行中"}</dd></div><div><dt>节点用时</dt><dd>{elapsedText(item.node.elapsedSeconds)}</dd></div></dl>
      : <p>{stage === "completed" && round.status === "completed" ? `完成时间：${patternTime(round.handedOverAt)}` : stage === "cancelled" ? `取消时间：${patternTime(round.cancelledAt)}` : "尚未到达此节点"}</p>}
  </section>;
}

export function PatternNodeHistory({ round, misc }: { round: PatternRound; misc: boolean }) {
  return <ol className="pattern-nodes">{patternWorkflow(round, misc).filter(item => item.node).map(item => <li key={item.stage}>
    <strong>{PATTERN_ORDER_STATUS_LABELS[item.node!.stage]}</strong><span>{item.status}</span>
    <span>{patternTime(item.node!.enteredAt)} → {item.node!.exitedAt ? patternTime(item.node!.exitedAt) : "当前"}</span><span>{elapsedText(item.node!.elapsedSeconds)}</span>
  </li>)}</ol>;
}
