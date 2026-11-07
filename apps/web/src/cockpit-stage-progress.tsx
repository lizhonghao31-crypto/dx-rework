import type {JourneyBusinessDate,JourneyVisualStage,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {CockpitDate} from './cockpit-date.js';

const known=(ratio:number|null|undefined):ratio is number=>typeof ratio==='number'&&Number.isFinite(ratio)&&ratio>=0&&ratio<=1;
export const cockpitStagePercentage=(ratio:number|null|undefined)=>known(ratio)?`${ratio===1?100:Math.min(99.9,Math.round(ratio*1000)/10)}%`:'—';
function StageDate({value}:{value:JourneyBusinessDate|undefined}){
 return value?.status==='complete'&&value.at&&value.precision!=='unknown'?<CockpitDate value={value.at} precision={value.precision}/>:<span>—</span>;
}
/** Only the shared server projection supplies progress, risk and date facts. */
export function CockpitStageProgress({stage,index,fact,selected,onSelect,tooltipOpen,onTooltipOpen,onTooltipClose}:{stage:OrderJourney['stages'][number];index:number;fact:JourneyVisualStage|undefined;selected:boolean;onSelect:()=>void;tooltipOpen:boolean;onTooltipOpen:()=>void;onTooltipClose:()=>void}){
 const time=cockpitStagePercentage(fact?.timeRatio),actual=cockpitStagePercentage(fact?.actualRatio);
 const started=Boolean(fact?.startedAt)||known(fact?.actualRatio)&&fact.actualRatio>0;
 const tone=!fact||fact.applicability!=='applicable'||fact.risk==='unknown'?'neutral':fact.risk==='overdue'?'danger':fact.risk==='due_soon'?'warning':started?'success':'neutral';
 const tip=`cockpit-stage-progress-${stage.key}`;
 return <div className={`cockpit-stage${selected?' is-selected':''} is-${tone}`}>
  <button type="button" className={"cockpit-stage-select"+(tooltipOpen?" is-progress-open":"")} aria-pressed={selected} data-cockpit-focus={'stage:'+stage.key} aria-label={`${stage.label}节点明细`} aria-describedby={tip} onClick={onSelect} onMouseEnter={onTooltipOpen} onMouseLeave={event=>{if(event.currentTarget!==event.currentTarget.ownerDocument.activeElement)onTooltipClose();}} onFocus={onTooltipOpen} onBlur={event=>{if(!event.currentTarget.matches(':hover'))onTooltipClose();}} onKeyDown={event=>{if(event.key==='Escape')onTooltipClose();}}>
   <span className="cockpit-stage-rings"><svg viewBox="0 0 104 104" aria-hidden="true">
    <circle cx="52" cy="52" r="46" className="cockpit-stage-track is-time" fill="none" strokeWidth="6"/>
    <circle cx="52" cy="52" r="35" className="cockpit-stage-track is-actual" fill="none" strokeWidth="7"/>
    {known(fact?.timeRatio)&&fact.timeRatio>0&&<circle cx="52" cy="52" r="46" className="cockpit-stage-arc is-time" fill="none" strokeWidth="6" pathLength="100" strokeDasharray={`${fact.timeRatio*100} 100`} transform="rotate(-90 52 52)"/>}
    {known(fact?.actualRatio)&&fact.actualRatio>0&&<circle cx="52" cy="52" r="35" className="cockpit-stage-arc is-actual" fill="none" strokeWidth="7" pathLength="100" strokeDasharray={`${fact.actualRatio*100} 100`} transform="rotate(-90 52 52)"/>}
    <text x="52" y="62" textAnchor="middle" fontSize="30" fontWeight="700">{fact?.actualRatio===1&&fact.applicability==='applicable'?'✓':index+1}</text>
   </svg></span><strong>{stage.label}</strong>
   <span id={tip} role="tooltip" className={'cockpit-stage-tooltip'+(tooltipOpen?' is-open':'')}><span>时间进度 <b>{time}</b></span><span>实际进度 <b>{actual}</b></span></span>
  </button>
  <div className="cockpit-stage-dates" aria-label={`${stage.label}日期`}><div><span>预计完成</span><StageDate value={fact?.expected}/></div><div><span>实际完成</span><StageDate value={fact?.actual}/></div></div>
 </div>;
}
