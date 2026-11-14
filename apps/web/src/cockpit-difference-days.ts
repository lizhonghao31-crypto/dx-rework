import type {ScheduleGoalDelta} from '@dx-rework/contracts';
/** Presentation only. Keep the engine's sign, precision and responsibility
 * classification; do not subtract visible dates or round before judging risk. */
export function cockpitDifferenceDays(goal:Pick<ScheduleGoalDelta,'kind'|'unit'|'signedValue'>){
 const value=goal.signedValue;
 if(value===null||!Number.isFinite(value)||['unknown','terminated'].includes(goal.kind))return '—';
 if(value===0)return '-0';
 const days=Math.abs(value)/(goal.unit==='minute'?1440:1),sign=value>0?'+':'-';
 return `${sign}${days<0.01?'<0.01':Number(days.toFixed(2))}天`;
}
