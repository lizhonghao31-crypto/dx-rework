import {CockpitTargetDifference,CockpitStageDifference} from './cockpit-fixed-schedule.js';
import type {CockpitStageDates,JourneyBusinessDate,JourneyVisualStage,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {ScheduleOccurrence} from '@dx-rework/contracts';
import {CockpitDate} from './cockpit-date.js';

const known=(ratio:number|null|undefined):ratio is number=>typeof ratio==='number'&&Number.isFinite(ratio)&&ratio>=0&&ratio<=1;
export const cockpitStagePercentage=(ratio:number|null|undefined)=>known(ratio)?`${ratio===1?100:Math.min(99.9,Math.round(ratio*1000)/10)}%`:'—';
function StageDate({value}:{value:JourneyBusinessDate|undefined}){
 return value?.status==='complete'&&value.at&&value.precision!=='unknown'?<CockpitDate value={value.at} precision={value.precision} short/>:<span>—</span>;
}
function ScopedStageDate({value,missing}:{value:ScheduleOccurrence|undefined;missing:string}){
 return <CockpitDate value={value?.precision==='instant'?value.at:value?.precision==='date'?value.date:null} precision={value?.precision==='date'?'date':'instant'} missing={missing} short/>;
}
/** Only the shared server projection supplies progress, risk and date facts. */
export function CockpitStageProgress({stage,index,fact,selected,scheduleAsOf,lines,onSelect,scoped,dates}:{stage:OrderJourney['stages'][number];index:number;fact:JourneyVisualStage|undefined;selected:boolean;lines?:OrderJourney['lines']|undefined;scheduleAsOf?:string|undefined;onSelect:()=>void;scoped?:boolean;dates?:CockpitStageDates|undefined;tooltipOpen?:boolean;onTooltipOpen?:()=>void;onTooltipClose?:()=>void}){
 const time=cockpitStagePercentage(fact?.timeRatio),actual=cockpitStagePercentage(fact?.actualRatio);
 const started=Boolean(fact?.startedAt)||known(fact?.actualRatio)&&fact.actualRatio>0;
 const tone=!fact||fact.applicability!=='applicable'||fact.risk==='unknown'?'neutral':fact.risk==='overdue'?'danger':fact.risk==='due_soon'?'warning':started?'success':'neutral';
 const progress=[known(fact?.timeRatio)?`时间 ${time}`:null,known(fact?.actualRatio)?`实际 ${actual}`:null].filter(Boolean).join(' · ');
 return <div className={`cockpit-stage${selected?' is-selected':''} is-${tone}`}>
  <button type="button" className="cockpit-stage-select" aria-pressed={selected} data-cockpit-focus={'stage:'+stage.key} aria-label={`${stage.label}节点明细`} title={progress||undefined} onClick={onSelect}>
   <span className="cockpit-stage-rings"><svg viewBox="0 0 104 104" aria-hidden="true">
    <circle cx="52" cy="52" r="46" className="cockpit-stage-track is-time" fill="none" strokeWidth="6"/>
    <circle cx="52" cy="52" r="35" className="cockpit-stage-track is-actual" fill="none" strokeWidth="7"/>
    {known(fact?.timeRatio)&&fact.timeRatio>0&&<circle cx="52" cy="52" r="46" className="cockpit-stage-arc is-time" fill="none" strokeWidth="6" pathLength="100" strokeDasharray={`${fact.timeRatio*100} 100`} transform="rotate(-90 52 52)"/>}
    {known(fact?.actualRatio)&&fact.actualRatio>0&&<circle cx="52" cy="52" r="35" className="cockpit-stage-arc is-actual" fill="none" strokeWidth="7" pathLength="100" strokeDasharray={`${fact.actualRatio*100} 100`} transform="rotate(-90 52 52)"/>}
    <text x="52" y="62" textAnchor="middle" fontSize="30" fontWeight="700">{fact?.actualRatio===1&&fact.applicability==='applicable'?'✓':index+1}</text>
   </svg></span><strong>{stage.label}</strong>
  </button>
  {scoped?<div className="cockpit-stage-dates-with-delta">
   <div className="cockpit-stage-dates" aria-label={`${stage.label}日期`}>
    <div><span>预计：</span><ScopedStageDate value={dates?.expected} missing="待核"/></div>
    <div><span>实际：</span><ScopedStageDate value={dates?.actual} missing={dates?.actualComplete?'完成时间待核':'—'}/></div>
   </div>
   {dates?.goalDelta?<CockpitStageDifference goal={dates.goalDelta} asOf={scheduleAsOf} wrapUnits/>:<span>—</span>}
   {dates?.differenceUsesOriginalTarget&&dates.goalDelta&&<details className="cockpit-original-stage-goal">
    <summary>差异按原目标</summary>
    <ScopedStageDate value={dates.goalDelta.targetPrecision==='date'&&dates.goalDelta.targetDate
     ?{precision:'date',date:dates.goalDelta.targetDate}:dates.goalDelta.targetAt?{precision:'instant',at:dates.goalDelta.targetAt}:undefined} missing="待核"/>
    <small>版本 {dates.goalDelta.targetRevision.split(':').at(-1)}</small>
   </details>}
  </div>:<div className="cockpit-stage-dates-with-delta"><div className="cockpit-stage-dates" aria-label={`${stage.label}日期`}><div><span>预计<span className="cockpit-stage-date-colon">：</span></span><StageDate value={fact?.expected}/></div><div><span>实际：</span><StageDate value={fact?.actual}/></div></div>{fact?.goalDelta?<CockpitStageDifference goal={fact.goalDelta} asOf={scheduleAsOf} wrapUnits/>:<CockpitTargetDifference nodes={stage.nodes} asOf={scheduleAsOf} {...(lines?{lines}:{})} wrapUnits/>}</div>}
 </div>;
}
