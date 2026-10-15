import {DevelopmentResultUpload} from "./development-result-upload.js";
import {OrderDocumentContainer,type DocumentCategory} from './order-document-container.js';
import {DevelopmentFabricReport} from './development-fabric-report.js';
import {useEffect,useRef,useState} from 'react';
import {roleLabel} from './components.js';
import {Button,StatusBadge} from '@dx-rework/ui';
import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
import {digitalRequest} from './digital-production-api.js';
import {useDevelopmentExecution} from './digital-development-execution-panel.js';
import {digitalTaskStateLabels} from './digital-workspace-copy.js';
import './task-workbench-sample.css';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {digitalTaskView} from './digital-task-view.js';

const tabs=['当前办理','本单资料','操作记录'] as const;

const date=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未登记';
type History={events:Array<{eventId:string;kind:string;occurredAt:string|null;recordedAt:string;actorName:string;payload:{note?:string;reason?:string}}>};

/** Limited opt-in sample using the original execution controller and commands. */
export function TaskWorkbenchSample({task:initialTask,onClose}:{task:DigitalTask;onClose:()=>void}){
 const [tab,setTab]=useState<typeof tabs[number]>('当前办理'),[note,setNote]=useState(''),[notice,setNotice]=useState('');
 const [category,setCategory]=useState<DocumentCategory>('development');
 const [history,setHistory]=useState<History|null>(null),[historyError,setHistoryError]=useState(''),[page,setPage]=useState(1),[revision,setRevision]=useState(0);
 const root=useRef<HTMLDivElement>(null),documentLeave=useRef<(()=>Promise<boolean>)|null>(null);
 const changeTab=async(value:typeof tabs[number])=>{if(tab==='本单资料'&&documentLeave.current&&!await documentLeave.current())return;setTab(value);};
 const controller=useDevelopmentExecution({sourceId:initialTask.sourceId!,taskId:initialTask.taskId,workspace:true,onChanged:message=>{setNotice(message??'已提交');setRevision(value=>value+1);}});
 useDigitalDetailNavigationGuard(Boolean(note||controller.craftFiles.length||controller.sewingFiles.length),controller.busy,controller.writing,'有未提交的备注或成果，确定离开？');
 const {state,busy,error,craftFiles,sewingFiles,run,urls}=controller,task=state?.tasks.find(item=>item.taskId===initialTask.taskId)??initialTask,doc=state?.sheet.document;
 useEffect(()=>{const size=()=>{if(root.current)root.current.style.setProperty('--task-workbench-top',`${Math.max(0,root.current.getBoundingClientRect().top+window.scrollY)}px`);};size();window.addEventListener('resize',size);return()=>window.removeEventListener('resize',size);},[]);

 useEffect(()=>{let live=true;if(tab==='操作记录'){setHistory(null);setHistoryError('');void digitalRequest<History>(`tasks/${task.taskId}/history`).then(value=>{if(live)setHistory(value);}).catch(reason=>{if(live)setHistoryError(reason.message);});}return()=>{live=false;};},[tab,task.taskId,revision]);
 const formId=`task-workbench-${task.taskId}`,canComplete=Boolean(state&&task.canExecute&&task.state==='ready'&&digitalTaskView(window.location.search)==='handle'),paper=task.taskKind==='development_pattern';
 const completedFiles=[...(state?.facts??[]),...(state?.routeFacts??[])].filter(fact=>fact.taskId===task.taskId).flatMap(fact=>fact.payload.attachmentIds??[]);
 const pendingFiles=paper?craftFiles:sewingFiles;
 return <div ref={root} className="task-workbench-sample" aria-label="工序工作台样板">
  <header><Button type="button" disabled={busy} onClick={onClose}>返回来源</Button><div><strong>{task.identity?.designStyleNo??state?.sheet.designStyleNo??'正在读取款号'}</strong><span>第 {task.routeVersion} 轮 · {task.label} · {task.assigneeName??'等待派工'}</span><small>{task.state==='completed'?`实际完成 ${date(task.completedAt)}`:`要求完成 ${date(task.dueAt)}`}</small></div><StatusBadge tone={task.state==='blocked'?'danger':'info'}>{digitalTaskStateLabels[task.state]}</StatusBadge><small>已确认工作台样板</small></header>
  <nav aria-label="任务页签">{tabs.map(value=><Button type="button" key={value} aria-pressed={tab===value} onClick={()=>void changeTab(value)}>{value}</Button>)}</nav>
  <main>
   {tab==='当前办理'&&<div className="task-workbench-handle"><aside><h2>本轮制作依据</h2><p>打板数量：{doc?.quantity??'未登记'} · 尺码：{doc?.sampleSize||'未登记'}</p><p>{doc?.instructions||'未登记制作说明'}</p><p>工艺：{doc?.craft??'待读取'} · 洗水：{doc?.washing??'待读取'}</p><Button type="button" onClick={()=>{setCategory('development');setTab('本单资料');}}>查看完整开发单</Button></aside><section><h2>{paper?'纸样办理':'车板办理'}</h2>{!state?<p role="status">正在读取原任务条件…</p>:<><ul aria-label="本轮前置条件">{task.unmetConditions?.map((item,index)=><li key={`${item.condition}:${index}`}><strong>{item.name}</strong>：{item.missing}；负责岗位：{roleLabel(item.responsibleRole)}{item.action?`；${item.action}`:''}</li>)}</ul>{!canComplete&&<p role="status">{task.state==='completed'?'本任务已完成':task.unmetConditions?.length?'请先处理上述前置条件':task.blockedReason||'当前任务状态或身份不具备办理条件，请核对原任务。'}</p>}{!paper&&<p>本轮齐料：{state.materialReadiness?.filter(item=>!item.available).length?'仍有待核实材料':'以原任务前置条件核验结果为准'} · 正式执行归属：{state.patternPreparation?.workerName??'等待主管派工'}</p>}<form id={formId} onSubmit={event=>{event.preventDefault();if(!canComplete)return;void run(paper?'complete':'route',paper?{taskId:task.taskId,note,attachmentIds:craftFiles}:{attachmentIds:sewingFiles,taskId:task.taskId,note,result:'通过',returnNodes:[],problemCategories:[],craftExecution:null,nextAssigneeId:null,sentDate:null,trackingNo:null}).then(updated=>{if(updated)setNote('');});}}><label>办理备注<textarea aria-label="办理备注" value={note} disabled={busy||!canComplete} maxLength={paper?1000:2000} rows={4} onChange={event=>setNote(event.target.value)}/></label></form><p>{pendingFiles.length?`已上传 ${pendingFiles.length} 份工艺成果，待随本次办理提交`:`已有 ${completedFiles.length} 份任务成果`}</p><Button type="button" onClick={()=>{setCategory('results');setTab('本单资料');}}>查看 / 上传本轮成果</Button></>}</section></div>}
   {tab==='本单资料'&&<OrderDocumentContainer key={revision} initial={{kind:'development',id:initialTask.sourceId!,version:task.routeVersion}} taskId={task.taskId} initialCategory={category} onCategory={setCategory} headerless onLeaveCheck={check=>{documentLeave.current=check;}} onClose={()=>setTab('当前办理')} extraContent={{materials:state?.canReportFabric?<DevelopmentFabricReport controller={controller}/>:undefined,results:<><h2>本轮工序成果</h2>{canComplete?<DevelopmentResultUpload controller={controller} task={task}/>:<p>没有待提交的上传文件。</p>}{completedFiles.map((id,index)=><p key={id}><a href={urls.apiUrl(`digital-production/sources/${initialTask.sourceId}/development/attachments/${id}`)} target="_blank" rel="noreferrer">查看已提交成果 {index+1}</a></p>)}</>}}/>}
   {tab==='操作记录'&&<section><h2>操作记录</h2>{historyError?<p role="alert">{historyError}</p>:!history?<p role="status">正在读取原任务记录…</p>:<><ol>{history.events.slice((page-1)*10,page*10).map(item=><li key={item.eventId}><strong>{item.kind}</strong> · {item.actorName} · {date(item.occurredAt)}<p>{item.payload.note??item.payload.reason??''}</p></li>)}</ol><Button type="button" disabled={page===1} onClick={()=>setPage(value=>value-1)}>上一页</Button><span>第 {page} 页</span><Button type="button" disabled={page*10>=history.events.length} onClick={()=>setPage(value=>value+1)}>下一页</Button></>}</section>}
  </main>
  <footer><div>{error?<p role="alert">{error}</p>:<p role="status">{busy?'正在处理，请勿重复提交':notice|| (pendingFiles.length?'成果已上传，尚未随办理提交':note?'备注尚未提交，切换页签会保留':'未提交业务变化')}</p>}</div>{tab==='当前办理'&&canComplete&&<Button type="submit" form={formId} variant="primary" disabled={busy}>{paper?'纸样完成，交给下一位':'车板完成，交给下一位'}</Button>}{tab!=='当前办理'&&<Button type="button" onClick={()=>void changeTab('当前办理')}>回到当前办理</Button>}</footer>
 </div>;
}
