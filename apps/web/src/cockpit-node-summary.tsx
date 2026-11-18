import {StatusBadge} from '@dx-rework/ui';
import type {JourneyNode} from '@dx-rework/contracts/digital-production-journey';
import {journeyStateLabels,nodeStatus,nodeTerminationLabel,nodeIsTerminated} from './digital-journey-cockpit-model.js';
import {cockpitOwnStatus,cockpitDurationRange} from './cockpit-fixed-schedule.js';
import type {ScheduleRange} from '@dx-rework/contracts';

/** Display only original server-frozen responsibility. Never add PO ranges,
 * recalculate against browser now or revive a historical overdue risk. */
export function cockpitTerminationHistory(node:JourneyNode){
 if(node.planningOnly||!nodeIsTerminated(node))return null;
 const fixed=node.fixedTargets?.filter(target=>!target.progress.businessCompleted)??[];
 const timings=[...(node.timings??[]),...(node.timing?[node.timing]:[])].filter(timing=>timing.termination);
 const valid=(range:ScheduleRange|null):ScheduleRange|null=>range&&Number.isFinite(range.minimum)&&Number.isFinite(range.maximum)&&range.minimum>=0&&range.maximum>=range.minimum?range:null;
 const ranges=fixed.length?fixed.map(target=>valid(target.progress.ownSla.overdueMinutes??null)):[...new Map(timings.map(timing=>[JSON.stringify([timing.id,timing.termination]),timing])).values()].map(timing=>{
  const seconds=timing.termination!.overdueSeconds;return seconds===null?null:valid({minimum:seconds/60,maximum:seconds/60});
 });
 const known=ranges.filter((range):range is ScheduleRange=>range!==null),unknown=!ranges.length||known.length!==ranges.length;
 const texts=[...new Set(known.map(range=>range.maximum===0?'终止前未超时':'终止前超时'+cockpitDurationRange(range)))];
 const detail=texts.length?`${ranges.length>1?'已知各范围：':''}${texts.join(' / ')}${ranges.length>1?'；请逐范围查看':''}${unknown?'；另有范围的终止前责任超时待核':''}`:'终止前责任超时待核';
 return {text:nodeTerminationLabel(node)+'；'+detail,tone:'neutral'} as const;
}

export function cockpitResponsibilityResult(node:JourneyNode){
 const stopped=cockpitTerminationHistory(node);if(stopped)return stopped;
 if(node.key==='rework'&&node.current&&node.nativeWindows?.length===1&&node.nativeWindows[0]!.complete&&node.completionResult==='late'&&node.overdueSeconds!==null){
  return {text:'作业超时 '+cockpitDurationRange({minimum:node.overdueSeconds/60,maximum:node.overdueSeconds/60}),tone:'danger'} as const;
 }
 const overdue=node.fixedTargets?.flatMap(target=>target.progress.ownSla.state==='overdue'&&target.progress.ownSla.overdueMinutes?[target.progress.ownSla.overdueMinutes]:[])??[];
 if(overdue.length){const range={minimum:Math.max(...overdue.map(row=>row.minimum)),maximum:Math.max(...overdue.map(row=>row.maximum))};return {text:'逾期 '+cockpitDurationRange(range),tone:'danger'} as const;}
 const status=cockpitOwnStatus(node);if(status)return status;
 if(['inherited','cancelled','not_applicable'].includes(node.state))return {text:'—',tone:'neutral'} as const;
 const windows=node.fixedTargets?.map(target=>target.progress.ownSla)??[];
 if(windows.length&&windows.every(window=>window.state==='within'))return {text:node.state==='completed'?'按时完成':'正常',tone:'success'} as const;
 return {text:node.state==='uncreated'||node.state==='pending'?'尚未开始':'待核实',tone:'neutral'} as const;
}

/** The compact list selects the same original node. Full dates, scopes and
 * native read-only records remain available in its detail and full table. */
export function CockpitNodeSummary({nodes,selectedId,onSelect}:{nodes:JourneyNode[];selectedId:string|undefined;onSelect(node:JourneyNode):void}){
 return <table className="cockpit-node-summary"><colgroup><col className="summary-index"/><col/><col className="summary-state"/><col className="summary-result"/></colgroup>
  <thead><tr><th>序号</th><th>节点名称</th><th>状态</th><th>责任结果</th></tr></thead>
  <tbody>{nodes.map((node,index)=>{const result=cockpitResponsibilityResult(node),completed=['completed','inherited'].includes(node.state);return <tr key={node.instanceId} id={`journey-node-${node.instanceId}`} className={selectedId===node.instanceId?'is-focused':undefined}>
   <td>{index+1}</td><td><button type="button" className="journey-node-toggle" data-cockpit-focus={'node:'+node.instanceId} aria-pressed={selectedId===node.instanceId} onClick={()=>onSelect(node)}>{node.label}</button>{node.subject&&<small>{node.subject}</small>}{!node.current&&<small>第{node.round??'—'}轮 · 历史</small>}</td>
   <td><StatusBadge tone={nodeTerminationLabel(node)?'neutral':completed?'success':node.state==='active'?'info':'neutral'}>{nodeTerminationLabel(node)??(node.state==='inherited'||node.state==='unavailable'?nodeStatus(node):journeyStateLabels[node.state])}</StatusBadge></td>
   <td className={'cockpit-responsibility is-'+result.tone}>{result.text}</td>
  </tr>;})}</tbody>
 </table>;
}
