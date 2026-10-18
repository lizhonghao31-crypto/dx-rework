import {StatusBadge} from '@dx-rework/ui';
import type {BulkWorkroomResult} from '@dx-rework/contracts/bulk-preparation';
import {digitalTaskTiming} from '@dx-rework/domain/digital-task-deadline';
import {digitalTaskStateLabels} from './digital-workspace-copy.js';

type Item=BulkWorkroomResult['items'][number];
/** Read-only card projection. Classification, task permissions and completion facts stay on the original sheet. */
export function BulkPatternCard({item,href}:{item:Item;href:string}){
 const {sheet}=item,task=sheet.tasks.find(value=>value.taskKind==='bulk_pattern');
 const paper=sheet.facts.some(f=>f.kind==='纸样完成'),marker=sheet.facts.some(f=>f.kind==='唛架完成');
 const current=task?.state==='cancelled'?'原纸样任务已取消':task?.state==='completed'?'纸样任务已完成':paper&&marker?'纸样、唛架均已完成':task?.state==='blocked'?'纸样与唛架办理受阻':sheet.reasons.length||!sheet.preparationId?'核对大货准备条件':!sheet.facts.some(f=>f.kind==='纸样派交')?'等待纸样派工并交付':paper?'待完成唛架制作':marker?'待完成纸样制作':'制作纸样与唛架';
 const reasons=[...new Set([...sheet.reasons,...(task?.blockedReason?[task.blockedReason]:[])])];
 const lines=sheet.cutting.lines;
 const po=(line:typeof lines[number])=>[line.poNumber||line.formalStyleNo||line.temporaryStyleNo,line.color].filter(Boolean).join(' · ');
 const deadline=task?.dueAt&&!['completed','cancelled'].includes(task.state)?task.dueAt:null;
 const overdue=deadline&&task?.state!=='pending'&&digitalTaskTiming({...task!,terminal:false},new Date()).state==='overdue';
 return <article className="pattern-task-card bulk-pattern-card">
  <div className="bulk-pattern-card__identity">
   <a className="bulk-pattern-card__link" href={href} aria-label={`${item.designStyleNo}${item.customer?`，客户 ${item.customer}`:''}，查看大货纸样与唛架详情`}>
    <strong>{item.designStyleNo}</strong>{item.customer&&<span className="bulk-pattern-card__customer">{item.customer}</span>}
   </a>
   {task&&<span className="bulk-pattern-card__status"><StatusBadge>{digitalTaskStateLabels[task.state]}</StatusBadge></span>}
  </div>
  {lines.length>1?<details className="bulk-pattern-card__po"><summary>{lines.length} 个 PO / 颜色明细</summary><ul>{lines.map(line=><li key={line.lineId}>{po(line)}</li>)}</ul></details>:lines[0]&&<p className="bulk-pattern-card__single-po">{po(lines[0])}</p>}
  <p className="bulk-pattern-card__current">{task&&<span>负责人：{task.assigneeName||'待指派'}<br/></span>}当前：{current}</p>
  {deadline&&<p className={`bulk-pattern-card__deadline${overdue?' is-overdue':''}`}>{overdue?'已超时 · ':''}截止：{new Date(deadline).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'})}</p>}
  {reasons.length>0&&<p className="bulk-pattern-card__reason">待处理：{reasons.join('；')}</p>}
 </article>;
}
