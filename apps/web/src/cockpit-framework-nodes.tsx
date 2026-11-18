import type {JourneyNode,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {JOURNEY_STAGES} from '@dx-rework/contracts/digital-production-journey';
import {StatusBadge} from '@dx-rework/ui';
import {CockpitDate} from './cockpit-date.js';
import {CockpitActualDates,CockpitTargetDifference,observedTargetDelta} from './cockpit-fixed-schedule.js';
import {cockpitNodeStatus,cockpitNodeTone} from './cockpit-node-rows.js';
import {cockpitResponsibilityResult,cockpitTerminationHistory} from './cockpit-node-summary.js';

export function frameworkResponsibility(node:JourneyNode,asOf:string|undefined){
 const stopped=cockpitTerminationHistory(node);if(stopped)return stopped;
 const targets=node.fixedTargets??[];if(!targets.length)return cockpitResponsibilityResult(node);
 if(node.planningOnly)return {text:'不单独计责',tone:'neutral'} as const;
 const late=targets.some(target=>observedTargetDelta(target.progress,asOf).kind==='late');
 if(targets.some(target=>target.progress.ownSla.state==='overdue'))return {text:late?'逾期（有责）':'责任超时（有责）',tone:'danger'} as const;
 if(targets.every(target=>target.progress.ownSla.state==='within'&&target.progress.ownSla.sourceRef))return {text:late?'逾期（无责）':'正常',tone:late?'warning':'success'} as const;
 if(targets.every(target=>target.progress.ownSla.state==='terminated'))return {text:'已终止',tone:'neutral'} as const;
 return {text:'责任待核',tone:'neutral'} as const;
}

/** Current arranged targets may differ from completion-time historical deltas. */
export function CockpitPlanDates({node,lines=[]}:{node:JourneyNode;lines?:OrderJourney['lines']}){
 const targets=node.fixedTargets??[];
 if(!targets.length)return <CockpitDate value={node.expectedKind==='plan'?node.expectedAt:null} precision={node.expectedPrecision} missing="计划待补" short/>;
 return <>{targets.map(target=>{const current=target.progress.currentTarget??{at:target.progress.goalDelta.targetAt,date:target.progress.goalDelta.targetDate,precision:target.progress.goalDelta.targetPrecision};return <span className="cockpit-fixed-target-date" key={target.scopeRef+'|'+target.progress.id}>{targets.length>1&&<small>{lines.find(line=>line.id===target.lineId)?.po??'对应范围'}</small>}<CockpitDate value={current.precision==='date'?current.date:current.at} precision={current.precision} missing="计划待补" short/></span>;})}</>;
}
export function CockpitFrameworkNodes({nodes,lines,selectedId,onSelect,asOf}:{nodes:JourneyNode[];lines:OrderJourney['lines'];selectedId:string|undefined;onSelect:(node:JourneyNode)=>void;asOf:string|undefined}){
 return <table className="cockpit-node-summary cockpit-framework-nodes"><thead><tr><th scope="col">阶段</th><th scope="col">节点名称</th><th scope="col">预计完成</th><th scope="col">实际完成</th><th scope="col">日期差异</th><th scope="col">责任</th></tr></thead><tbody>{JOURNEY_STAGES.flatMap(stage=>{
  const rows=nodes.filter(node=>node.stage===stage.key);
  return rows.map((node,index)=>{const responsibility=frameworkResponsibility(node,asOf),unfinished=!['completed','inherited'].includes(node.state),before=unfinished&&node.fixedTargets?.length&&node.fixedTargets.every(target=>observedTargetDelta(target.progress,asOf).kind==='on_target');return <tr key={node.instanceId} id={'journey-node-'+node.instanceId} className={selectedId===node.instanceId?'is-focused':undefined}>
   {index===0&&<th scope="rowgroup" rowSpan={rows.length}>{stage.label}</th>}
   <td><button type="button" className="journey-node-toggle" aria-pressed={selectedId===node.instanceId} data-cockpit-focus={'node:'+node.instanceId} onClick={()=>onSelect(node)}>{node.label}</button> <StatusBadge tone={cockpitNodeTone(node)}>{cockpitNodeStatus(node)}</StatusBadge>{node.subject&&<small>{node.subject}</small>}{!node.current&&<small>第{node.round??'—'}轮 · 历史</small>}</td>
   <td><CockpitPlanDates node={node} lines={lines}/></td><td>{unfinished&&!node.fixedTargets?.some(target=>target.progress.businessCompleted)?node.state==='cancelled'?'已取消':'未完成':<CockpitActualDates node={node} lines={lines} short/>}</td>
   <td>{before?'未到期':<CockpitTargetDifference nodes={[node]} lines={lines} asOf={asOf}/>}</td><td className={'cockpit-responsibility is-'+responsibility.tone}>{responsibility.text}</td>
  </tr>;});
 })}</tbody></table>;
}
