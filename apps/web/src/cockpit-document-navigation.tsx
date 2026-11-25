import type {MouseEventHandler} from 'react';
import {JOURNEY_STAGES,type JourneyStageKey} from '@dx-rework/contracts/digital-production-journey';
import {NavigationIcon} from './navigation-icons.js';
import './cockpit-document-navigation.css';

const stageNames={creation:'订单',development:'开发',preparation:'产前',cutting:'开裁',post_cutting:'工艺',production:'生产',receiving:'回货'} as const;

/** Share the document catalog presentation without taking over the original
 * domain readers, selected-record identity, or page return context. */
export function CockpitDocumentStageTabs({stage,onSelect}:{stage:JourneyStageKey;onSelect(stage:JourneyStageKey):void}){
 return <div className="cockpit-document-node-tabs" role="tablist" aria-label="单据流程节点">
  {JOURNEY_STAGES.map(item=><button type="button" role="tab" aria-selected={item.key===stage} key={item.key}
   onClick={()=>onSelect(item.key)}>{stageNames[item.key]}</button>)}
 </div>;
}

export function CockpitDocumentDirectoryRow({category,label,status,readState,state,filled,expanded,onOpen}:{
 category:string;label:string;status:string;readState?:string;state?:string;filled:boolean;expanded?:boolean;onOpen:MouseEventHandler<HTMLButtonElement>;
}){
 return <button className="cockpit-document-priority-row" data-category={category} data-read-state={readState}
  data-state={state??'unknown'} aria-expanded={expanded} aria-label={expanded===undefined?undefined:label}
  aria-description={expanded===undefined?undefined:status} type="button" onClick={onOpen}>
  <span className="cockpit-document-title"><NavigationIcon name="FileText"/>{label}</span>
  <span className="cockpit-document-fill-status" data-filled={filled}>{filled?<NavigationIcon name="CircleCheck"/>:
   <span className="cockpit-document-empty-icon" aria-hidden>○</span>}<span>{status}</span></span>
  <span className="cockpit-document-arrow" aria-hidden>›</span>
 </button>;
}

export function CockpitDocumentMore({onOpen}:{onOpen:MouseEventHandler<HTMLButtonElement>}){
 return <footer className="cockpit-document-footer"><button type="button" className="journey-text-action cockpit-document-open-all"
  data-document-trigger onClick={onOpen}>查看更多 ›</button></footer>;
}
