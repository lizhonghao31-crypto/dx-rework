import {digitalTaskView} from './digital-task-view.js';
import {useEffect,useRef,useState} from 'react';
import {Button,StatusBadge} from '@dx-rework/ui';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import {BulkPreparationPanel} from './bulk-preparation-panel.js';
import {OrderDocumentContainer} from './order-document-container.js';
import {WorkbenchActionTarget} from './workbench-action.js';
import {digitalRequest} from './digital-production-api.js';
import {digitalTaskStateLabels} from './digital-workspace-copy.js';
import './task-workbench-sample.css';
/** Same confirmed bounded layout; native bulk paper/marker actions, no development route. */
export function BulkTaskWorkbench({task:initial,onClose}:{task:DigitalTask;onClose:()=>void}){
 const [task,setTask]=useState(initial),[tab,setTab]=useState('当前办理'),[target,setTarget]=useState<HTMLElement|null>(null),[history,setHistory]=useState<Array<{eventId:string;kind:string;recordedAt:string;actorName:string}>>([]),[page,setPage]=useState(1),[error,setError]=useState('');
 const root=useRef<HTMLDivElement>(null),leave=useRef<(()=>Promise<boolean>)|null>(null);
 useEffect(()=>{const resize=()=>root.current?.style.setProperty('--task-workbench-top',`${Math.max(0,root.current.getBoundingClientRect().top+window.scrollY)}px`);resize();window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
 useEffect(()=>{let live=true;if(tab==='操作记录')void digitalRequest<{events:typeof history}>(`tasks/${task.taskId}/history`).then(v=>{if(live)setHistory(v.events);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[tab,task]);
 const change=async(value:string)=>{if(tab==='本单资料'&&leave.current&&!await leave.current())return;setTab(value);};
 return <WorkbenchActionTarget.Provider value={target}><div ref={root} className="task-workbench-sample" aria-label="大货工序工作台"><header><Button onClick={onClose}>返回来源</Button><div><strong>{task.identity?.designStyleNo??'大货订单'}</strong><span>大货纸样 / 唛架 · {task.assigneeName??'待安排'}</span><small>截止：{task.dueAt??'尚未启动'}</small></div><StatusBadge>{digitalTaskStateLabels[task.state]}</StatusBadge></header><nav>{['当前办理','本单资料','操作记录'].map(t=><Button key={t} aria-pressed={tab===t} onClick={()=>void change(t)}>{t}</Button>)}</nav><main><div hidden={tab!=='当前办理'}><BulkPreparationPanel orderId={task.orderId!} taskId={task.taskId} readonly={digitalTaskView(window.location.search)==='read'||['completed','cancelled'].includes(task.state)} onClose={onClose} onChanged={()=>void digitalRequest<DigitalTask>(`tasks/${task.taskId}`).then(setTask).catch(e=>setError(e.message))}/></div>{tab==='本单资料'&&<OrderDocumentContainer initial={{kind:'instruction',id:task.orderId!}} taskId={task.taskId} headerless onClose={()=>void change('当前办理')} onLeaveCheck={check=>{leave.current=check;}}/>}{tab==='操作记录'&&<section><h2>操作记录</h2>{history.slice((page-1)*10,page*10).map(e=><p key={e.eventId}>{e.kind} · {e.actorName} · {e.recordedAt}</p>)}<Button disabled={page===1} onClick={()=>setPage(p=>p-1)}>上一页</Button><span>第 {page} 页</span><Button disabled={page*10>=history.length} onClick={()=>setPage(p=>p+1)}>下一页</Button></section>}</main><footer>{error&&<p role="alert">{error}</p>}<div hidden={tab!=='当前办理'} ref={setTarget}/>{tab!=='当前办理'&&<Button onClick={()=>void change('当前办理')}>回到当前办理</Button>}</footer></div></WorkbenchActionTarget.Provider>;
}
