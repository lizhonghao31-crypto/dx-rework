import {acceptanceTaskNow} from './acceptance-business-time.js';
import type {DigitalTask} from "@dx-rework/contracts/digital-production-tasks";
import {digitalTaskTiming} from "@dx-rework/domain/digital-task-deadline";
export function taskTimeProgress(task:DigitalTask,now:Date) {
  if(task.state==='pending')return {label:'条件未齐，未计时',percent:null};
  if(task.state==='cancelled')return {label:'已取消',percent:null};
  if(!task.enteredAt)return {label:'时间待确认',percent:null};
  const timing=digitalTaskTiming({...task,terminal:task.state==='completed'},acceptanceTaskNow(task,now));
  const label={unlimited:'仅记录滞留',unknown:'时间待确认',normal:'办理中',attention:'临期',overdue:'已超时',completed_on_time:'按期完成',completed_overdue:'超时完成'}[timing.state];
  const end=task.state==='completed'?task.completedAt:acceptanceTaskNow(task,now).toISOString();
  const duration=task.dueAt?new Date(task.dueAt).getTime()-new Date(task.enteredAt).getTime():NaN;
  const elapsed=end?new Date(end).getTime()-new Date(task.enteredAt).getTime():NaN;
  const percent=Number.isFinite(duration)&&duration>0&&Number.isFinite(elapsed)&&elapsed>=0?Math.round(elapsed/duration*100):null;
  return {label:`${label}${timing.elapsedSeconds===null?'':` · ${(timing.elapsedSeconds/3600).toFixed(1)} 小时`}`,percent};
}
