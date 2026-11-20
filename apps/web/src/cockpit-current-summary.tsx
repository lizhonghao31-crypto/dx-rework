import type{JourneyNode}from'@dx-rework/contracts/digital-production-journey';
import{cockpitNodeOwner}from'./cockpit-node-rows.js';
import{cockpitResponsibilityResult}from'./cockpit-node-summary.js';

export function CockpitCurrentSummary({node}:{node:JourneyNode}){
 const result=cockpitResponsibilityResult(node);
 return <div className="cockpit-current-summary"><span><b>负责人：</b>{cockpitNodeOwner(node)}</span><strong className={'cockpit-responsibility is-'+result.tone}>{result.text}</strong></div>;
}
