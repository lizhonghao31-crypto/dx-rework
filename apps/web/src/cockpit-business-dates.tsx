import type {JourneyBusinessDate,JourneyBusinessDateGroup} from '@dx-rework/contracts/digital-production-journey';
import {journeyTime} from './digital-journey-cockpit-model.js';

export const forecastBasisLabels={actual:'已有实际完成',remaining_estimate:'按有效剩余估计推算',standard_window:'按当前责任窗口推算',plan:'按本单时效计划推算',sla_plan:'按本单时效计划推算',unknown:'预计依据尚未齐全'};
export function businessDateLabel(value:JourneyBusinessDate,kind:'actual'|'plan'|'forecast'):string{
 const format=(at:string,precision:'instant'|'date')=>journeyTime(at,precision)+(kind==='plan'&&precision==='date'?' 当天结束':'');
 if(value.status==='not_applicable')return '不适用';
 if(value.status==='complete'&&value.at&&value.precision!=='unknown')return format(value.at,value.precision)+(kind==='actual'&&value.quality==='recorded'?'（原记录，待核）':'');
 if(value.status==='partial'&&value.coveredAt)return `已覆盖${value.covered}/${value.total}项最晚${format(value.coveredAt.at,value.coveredAt.precision)}`;
 if(kind==='actual'&&value.status==='incomplete')return '尚未全部完成';
 return value.reasons[0]??(kind==='actual'?'尚无完整实际完成时间':kind==='plan'?'尚无完整采用计划日期':'尚无完整预计依据');
}
export function BusinessDateFacts({dates,showPlan=true}:{dates:JourneyBusinessDateGroup;showPlan?:boolean}){
 const actualOnly=dates.forecast.bases.length===1&&dates.forecast.bases[0]==='actual'&&dates.actual.at===dates.forecast.at;
 return <div aria-label="本单计划、实际与预计日期">
  {showPlan&&dates.adoptedPlan.status!=='not_applicable'&&<small>已采用计划完成：{businessDateLabel(dates.adoptedPlan,'plan')}</small>}
  <small>实际完成：{businessDateLabel(dates.actual,'actual')}</small>
  {!actualOnly&&<small>预计完成：{businessDateLabel(dates.forecast,'forecast')}{dates.forecast.bases.length?` · ${dates.forecast.bases.map(basis=>forecastBasisLabels[basis]).join(' / ')}`:''}</small>}
 </div>;
}
