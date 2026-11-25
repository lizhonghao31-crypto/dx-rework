import {ListPagination} from './list-pagination.js';
import {TaskPlanTargets} from './task-plan-targets.js';
import {roleLabel} from './components.js';
import {TaskWorkbenchActions} from './task-workbench-actions.js';
import {digitalTaskView} from './digital-task-view.js';
import {useEffect,useRef,useState} from 'react';
import {Button,StatusBadge} from '@dx-rework/ui';
import {OrderRushBadge} from './order-rush-badge.js';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import {BulkPreparationPanel} from './bulk-preparation-panel.js';
import {OrderDocumentContainer} from './order-document-container.js';
import {WorkbenchActionTarget} from './workbench-action.js';
import {digitalRequest} from './digital-production-api.js';
import {digitalTaskDisplayStatus,digitalTaskObjectLabel,digitalTaskHistoryKindLabel,digitalTaskHistoryText} from './digital-workspace-copy.js';
import './task-workbench-sample.css';
const historyDate=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未登记';
/** Same confirmed bounded layout; native bulk paper/marker actions, no development route. */
export function BulkTaskWorkbench({task:initial,onClose}:{task:DigitalTask;onClose:()=>void}){
 const [task,setTask]=useState(initial),[tab,setTab]=useState('当前办理'),[target,setTarget]=useState<HTMLElement|null>(null),[history,setHistory]=useState<Array<{eventId:string;kind:string;occurredAt:string|null;recordedAt:string;actorName:string;payload:{reason?:string;note?:string}}>>([]),[page,setPage]=useState(1),[error,setError]=useState('');
 const root=useRef<HTMLDivElement>(null),leave=useRef<(()=>Promise<boolean>)|null>(null);
 useEffect(()=>{const resize=()=>root.current?.style.setProperty('--task-workbench-top',`${Math.max(0,root.current.getBoundingClientRect().top+window.scrollY)}px`);resize();window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
 useEffect(()=>{let live=true;if(tab==='操作记录')void digitalRequest<{events:typeof history}>(`tasks/${task.taskId}/history`).then(v=>{if(live)setHistory(v.events);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[tab,task]);
 const refresh=()=>void digitalRequest<DigitalTask>(`tasks/${task.taskId}`).then(setTask).catch(e=>setError(e.message));
 const correctionUrl=new URL(window.location.href);correctionUrl.searchParams.set('task',task.taskId);correctionUrl.searchParams.set('taskView','correct');
 const change=async(value:string)=>{if(tab==='本单资料'&&leave.current&&!await leave.current())return;setTab(value);};
 return <WorkbenchActionTarget.Provider value={target}><div ref={root} className="task-workbench-sample" aria-label="大货工序工作台"><header><Button onClick={onClose}>返回来源</Button><div><strong>{task.identity?.designStyleNo??'大货订单'}</strong><OrderRushBadge value={task.orderRush}/><span>{digitalTaskObjectLabel(task)} · {task.label} · {roleLabel(task.requiredRole)}：{task.assigneeName??'待安排'}</span><small>自身截止：{task.dueAt??'尚未启动'}</small></div><StatusBadge>{digitalTaskDisplayStatus(task,digitalTaskView(window.location.search)==='read')}</StatusBadge></header><nav>{['当前办理','本单资料','操作记录'].map(t=><Button key={t} aria-pressed={tab===t} onClick={()=>void change(t)}>{t}</Button>)}</nav><main><TaskPlanTargets task={task}/><div hidden={tab!=='当前办理'}><ul aria-label="本轮前置条件">{task.unmetConditions?.map((item,index)=><li key={`${item.condition}:${index}`}><strong>{item.name}</strong>：{item.missing}；负责岗位：{roleLabel(item.responsibleRole)}{item.action?`；${item.action}`:""}</li>)}</ul><BulkPreparationPanel orderId={task.orderId!} taskId={task.taskId} readonly={digitalTaskView(window.location.search)==='read'||['completed','cancelled'].includes(task.state)} onClose={onClose} onChanged={refresh}/>{digitalTaskView(window.location.search)==='handle'&&<TaskWorkbenchActions task={task} onChanged={refresh}/>}</div>{tab==='本单资料'&&<OrderDocumentContainer initial={{kind:'instruction',id:task.orderId!}} taskId={task.taskId} headerless onClose={()=>void change('当前办理')} onLeaveCheck={check=>{leave.current=check;}}/>}{tab==='操作记录'&&<section><h2>操作记录</h2>{history.slice((page-1)*10,page*10).map(e=><div key={e.eventId}><p>{digitalTaskHistoryKindLabel(e.kind)} · {e.kind==='system_route'?`业务触发人：${e.actorName}`:e.actorName} · 发生：{historyDate(e.occurredAt)} · 登记：{historyDate(e.recordedAt)}</p>{e.payload.reason&&<p>原因：{digitalTaskHistoryText(e.kind,e.payload,'reason')}</p>}{e.payload.note&&e.payload.note!==e.payload.reason&&<p>说明：{digitalTaskHistoryText(e.kind,e.payload,'note')}</p>}</div>)}<ListPagination page={page} totalPages={history.length===null?null:Math.max(1,Math.ceil(history.length/10))} total={history.length} busy={false} onPageChange={setPage} ariaLabel="大货工序操作记录分页"/>{task.canCorrect&&<a href={correctionUrl.pathname+correctionUrl.search}>核实原任务时间</a>}</section>}</main><footer>{error&&<p role="alert">{error}</p>}<div hidden={tab!=='当前办理'} ref={setTarget}/>{tab!=='当前办理'&&<Button onClick={()=>void change('当前办理')}>回到当前办理</Button>}</footer></div></WorkbenchActionTarget.Provider>;
}
