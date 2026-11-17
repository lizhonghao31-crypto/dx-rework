import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';

/** Older DTOs may prove an instant, but responsibility quality cannot certify it. */
export function taskCompletionText(task:Pick<DigitalTask,'actualCompletion'|'completedAt'|'completedTimeQuality'>):string{
 const actual=task.actualCompletion;
 if(actual?.precision==='unknown')return '时间未知';
 if(actual?.precision==='date')return `${actual.date}（仅日期${actual.quality==='unverified'?' · 时间待核':''}）`;
 const at=actual?.precision==='instant'?actual.at:task.completedAt;
 if(!at||!Number.isFinite(Date.parse(at)))return '时间未知';
 const quality=actual?.quality??(task.completedTimeQuality==='现场登记'||task.completedTimeQuality==='已核实'?'verified':'unverified');
 return new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+(quality==='unverified'?'（时间待核）':'');
}
export function TaskCompletionTime({task}:{task:Pick<DigitalTask,'actualCompletion'|'completedAt'|'completedTimeQuality'>}){
 return <span>实际完成 {taskCompletionText(task)}</span>;
}
