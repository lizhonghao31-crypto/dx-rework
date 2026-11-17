import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import './task-plan-targets.css';

const date=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
/** Same effective P as the order progress view. No client-side rescheduling,
 * deadline substitution, averaging of PO targets or extra network request. */
export function TaskPlanTargets({task,lineId}:{task:DigitalTask;lineId?:string}){
 const original=task.currentPlanTargets,matched=lineId?original?.targets.filter(target=>target.lineId===lineId):original?.targets;
 const current=original&&lineId&&original.state!=='not_applicable'?{...original,targets:matched??[],...(!matched?.length?{state:'unknown' as const,reason:'本PO当前计划依据待核'}:{})}:original;
 return <section className="task-plan-targets" aria-label="本单当前计划" data-plan-version={current?.planVersionId??undefined}>
  <header><strong>{lineId?'本PO当前计划完成':'本单当前计划完成'}</strong>{current?.planRevision&&<small>本单安排第{current.planRevision}版</small>}</header>
  {current?.state==='not_applicable'?<p>{current.reason??'本任务已退出当前计划范围'}</p>:<>
   {current?.targets.length?<dl>{current.targets.map(target=><div key={target.scopeRef}><dt>{target.scopeLabel}</dt><dd>{target.precision==='date'&&target.date?`${target.date}（日期）`:target.endAt?date(target.endAt):'时间待核实'}</dd></div>)}</dl>:null}
   {(!current||current.state==='unknown')&&<p role="status">{current?.reason??'本任务当前计划依据待核'}</p>}
  </>}
 </section>;
}
/** The preparation API already authorizes its exact current task set. A
 * missing/ambiguous cutting task cannot borrow another work or PO target. */
export function BulkCuttingPlanTargets({tasks,lineId}:{tasks:readonly DigitalTask[];lineId:string}){
 const cutting=tasks.filter(task=>['bulk_cutting','bulk_cutting_external'].includes(task.taskKind));
 return cutting.length===1?<TaskPlanTargets task={cutting[0]!} lineId={lineId}/>:<p role="status">本PO当前计划依据待核</p>;
}
