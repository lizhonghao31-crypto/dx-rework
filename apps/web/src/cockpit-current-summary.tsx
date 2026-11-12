import type{JourneyNode}from'@dx-rework/contracts/digital-production-journey';
import{CockpitDate}from'./cockpit-date.js';
import{cockpitNodeOwner}from'./cockpit-node-rows.js';
import{cockpitResponsibilityResult}from'./cockpit-node-summary.js';
import{nodeTargetLabel,slaTargetLabel,originalNodeDeadlineLabel}from'./journey-sla-details.js';

export function CockpitCurrentSummary({node}:{node:JourneyNode}){
 const deadlines=[...new Set([node.nativeTaskDeadline?.at,...node.nativeWindows?.map(window=>window.deadline)??[],...node.timing?.windows?.map(window=>window.deadline)??[],...(node.timing?.kind!=='estimate'?[node.timing?.target.at]:[]),...node.timings?.filter(timing=>timing.kind!=='estimate').map(timing=>timing.target.at)??[]].filter((at):at is string=>Boolean(at)))];
 const result=cockpitResponsibilityResult(node);
 const original=node.nativeTaskDeadline,target=[...(node.timings??[]),...(node.timing?[node.timing]:[])].find(timing=>timing.kind!=='estimate'&&timing.target.at===deadlines[0])?.target;
 const single=original&&original.at===deadlines[0]?nodeTargetLabel({...node,expectedAt:original.at,expectedKind:'sla',expectedPrecision:original.precision,...(original.mode?{deadlineMode:original.mode}:{}),...(original.exclusive!==undefined?{deadlineExclusive:original.exclusive}:{}),nativeWindows:[]}):target?slaTargetLabel(target):<CockpitDate value={deadlines[0]??null} missing="—"/>;
 return <div className="cockpit-current-summary"><span><b>负责人：</b>{cockpitNodeOwner(node)}</span><span><b>自身截止：</b>{node.fixedTargets?.some(target=>Object.hasOwn(target.progress.ownSla,'deadlineAt'))?originalNodeDeadlineLabel(node):deadlines.length===1?single:deadlines.length?'按批次查看':'—'}</span><strong className={'cockpit-responsibility is-'+result.tone}>{result.text}</strong></div>;
}
