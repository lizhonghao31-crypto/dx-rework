import {useState} from 'react';
import {BusinessTable} from '@dx-rework/ui/production';
import type {ProductionCollaboration} from '@dx-rework/contracts/production-collaboration';
import {roleLabel} from './components.js';

const time=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'原业务时间待核';
/** Uses the same bounded, authorized result as the original PO analysis. */
export function ProductionCollaborationPanel({data,taskHref,orderHref}:{data:ProductionCollaboration;orderHref:(id:string)=>string;taskHref:(id:string)=>string}){
 const [limit,setLimit]=useState(15);
 return <section className="current-production-section"><h2>人员协作事实</h2><p>观察时点 {time(data.asOf)}。以下是本次可见对象的原办理历史，不把期间选择当作人员产出排名。当前主办、当时负责、实际提交人与涉及问题分开看；参与和代办不等于过错。</p>
  {data.scopeUnknown.length>0&&<p className="current-production-alert">{data.scopeUnknown.length} 个已授权PO的筛选归属尚未核齐；以下只列已知人员子集，不能作为完整负荷或零问题结论。请从原生产缺件入口核对。</p>}
  <h3>当前负荷与明确经办</h3><p>按任务所属岗位、同一节点分开列原次数。一个任务可能有多名经办，人数与问题次数不能相加成总任务数。表格可左右滚动查看各项任务数。</p>
  <div className="current-production-table" tabIndex={0} role="region" aria-label="人员协作，可横向滚动"><BusinessTable><thead><tr><th>人员</th><th>任务所属岗位 / 节点</th><th>当前主办未完</th><th>实际办理任务</th><th>涉及问题 / 任务</th></tr></thead><tbody>{data.summary.slice(0,limit).map(row=><tr key={row.person.id+':'+row.role+':'+row.nodeKey}><td>{row.person.name}</td><td>{roleLabel(row.role)} / {data.tasks.find(task=>task.nodeKey===row.nodeKey)?.label??'原节点'}</td><td>{row.currentTasks}</td><td>{row.handledTasks}</td><td>{row.involvedProblems} 个问题 / {row.involvedTasks} 个任务<p>问题率待核：缺完整排查分母</p></td></tr>)}</tbody></BusinessTable></div>
  <h3>实际经办与负责期间</h3>{data.tasks.slice(0,limit).map(task=><details key={task.taskId}><summary>{task.label} · 当前主办 {task.currentAssignee?.name??'原未分派'} · {task.currentLoad?'当前未完负荷':'不计当前未完负荷'}</summary><p><a href={taskHref(task.taskId)}>查看原节点业务记录</a></p><p>本次有效截止 {task.deadlineExclusive?time(task.deadline?new Date(Date.parse(task.deadline)-1).toISOString():null)+' 日终':time(task.deadline)} · 截止时主办 {task.deadlinePending?'尚未到本次截止':task.deadline?task.assigneeAtDeadline?.name??'历史待核':'不适用或待核独立截止'}。此项不是过错认定。{task.deadlineExplanation}</p>{task.intervals.map((interval,index)=><p key={index}>{interval.person?.name??'当时未分派'}：{time(interval.from)} 至 {interval.to?time(interval.to):'本次观察时点'}；原主办接续记录</p>)}{task.handlers.map(event=><p key={event.eventId}>实际{event.kind==='completed'?'提交完成':event.kind==='blocked'?'登记阻断':event.kind==='unblocked'?'解除阻断':'办理'}：{event.person.name} · 发生 {event.verified?time(event.occurredAt):'未核'} · 登记 {time(event.recordedAt)}</p>)}<p>已证等待 {(task.waitingSeconds/3600).toFixed(2)} 小时，覆盖 {task.waitingCoverage==='complete'?'完整':task.waitingCoverage==='partial'?'部分':'待核'}；不是净工时，不扣正式时限。</p>{task.unknown.map(reason=><p key={reason}>{reason}</p>)}</details>)}
  <h3>涉及问题</h3><p>本次已核范围原问题去重 {data.globalProblemCount} 个，其中 {data.unattributedProblems.length} 个没有可证人员关联；保留问题，不自动归给当前主办。下列人员只表示原记录的办理关联；同问题多人涉及不可相加，也不自动推定负责或犯错。</p>{data.tasks.slice(0,limit).flatMap(task=>task.problems.map(problem=><p key={task.taskId+':'+problem.id}>{task.label} · {problem.kind} · 原记录办理人员 {problem.involved.map(person=>person.name).join('、')||'未核'} · <a href={taskHref(task.taskId)}>原问题记录</a></p>))}
  {data.unattributedProblems.slice(0,limit).map(problem=><p key={problem.id}>{problem.kind} · 人员关联未核 <a href={orderHref(problem.orderId)}>查看原母单问题</a></p>)}
  <h3>原业务已确认责任</h3><p>{data.personalResponsibility.reason}</p><p>个人责任率及排名待具体原认定证据，不能将“没有记录”显示为零责任。</p>{data.limitations.map(reason=><p key={reason}>{reason}</p>)}
  {(data.tasks.length>limit||data.summary.length>limit)&&<button className="current-production-link" onClick={()=>setLimit(value=>value+15)}>继续显示后15项</button>}
 </section>;
}
