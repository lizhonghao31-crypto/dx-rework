import {useEffect,useRef,useState} from 'react';
import {roleLabel} from './components.js';
import {Button,StatusBadge} from '@dx-rework/ui';
import type {DigitalTask,DigitalTaskDocuments,DigitalTaskDocumentReference} from '@dx-rework/contracts/digital-production-tasks';
import type {DigitalOrder} from '@dx-rework/contracts/digital-production';
import {digitalRequest} from './digital-production-api.js';
import {useDevelopmentExecution} from './digital-development-execution-panel.js';
import {DigitalDevelopmentPanel} from './digital-development-panel.js';
import {ProductionInstructionPanel} from './production-instruction-panel.js';
import {DigitalBudgetPanel} from './digital-budget-panel.js';
import {DocumentChapterScope} from './document-editor.js';
import {digitalTaskStateLabels} from './digital-workspace-copy.js';
import './task-workbench-sample.css';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
import {digitalTaskView} from './digital-task-view.js';

const tabs=['当前办理','本单资料','操作记录'] as const;
const documentNames={development:'开发单',instruction:'大货制单',budget:'成本预算表'};
const chapters={development:[['development-images','款图与制作说明'],['development-basic','打板信息'],['development-materials','面辅料'],['development-sizes','尺寸表'],['development-labels','唛类'],['development-craft','工艺要求']],budget:[['budget-basic','基本资料'],['budget-section-0','主料'],['budget-section-1','辅料'],['budget-section-2','外发工序'],['budget-summary','费用与报价'],['budget-outsourcing','其他信息']]};
const date=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未登记';
type History={events:Array<{eventId:string;kind:string;occurredAt:string|null;recordedAt:string;actorName:string;payload:{note?:string;reason?:string}}>};
function DocumentReader({kind,reference}:{kind:keyof DigitalTaskDocuments;reference:DigitalTaskDocumentReference}){
 const [order,setOrder]=useState<DigitalOrder|null>(null),[error,setError]=useState(''),[chapter,setChapter]=useState(kind==='budget'?'budget-basic':'development-images');
 useEffect(()=>{let live=true;if(kind==='budget'&&reference.state==='published')void digitalRequest<DigitalOrder>(`orders/${reference.id}`).then(value=>{if(live)setOrder(value);}).catch(reason=>{if(live)setError(reason.message);});return()=>{live=false;};},[kind,reference]);
 if(reference.state!=='published')return <p>{reference.state==='unavailable'?'当前身份无权查看此类资料':reference.state==='not_applicable'?'尚无确定订单，不适用':reference.state==='draft'?'仅有草稿，尚未发布可用版本':'本轮没有可读取的已发布版本'}</p>;
 const content=kind==='development'?<DigitalDevelopmentPanel sourceId={reference.id} initialRound={reference.version} embedded onClose={()=>{}}/>:kind==='instruction'?<ProductionInstructionPanel orderId={reference.id} initialVersion={reference.version} embedded onClose={()=>{}}/>:error?<p role="alert">{error}</p>:order?<DigitalBudgetPanel order={order} initialVersion={reference.version} embedded onClose={()=>{}}/>:<p role="status">正在读取已授权订单…</p>;
 return <div className="task-document-reader"><p>{reference.label} · {kind==='development'?'轮次':'版本'} {reference.version}</p>{kind!=='instruction'&&<nav aria-label="单据章节">{chapters[kind].map(([id,label])=><Button key={id} type="button" aria-pressed={chapter===id} onClick={()=>setChapter(id!)}>{label}</Button>)}</nav>}{kind==='instruction'?content:<DocumentChapterScope chapter={chapter}>{content}</DocumentChapterScope>}</div>;
}

/** Limited opt-in sample using the original execution controller and commands. */
export function TaskWorkbenchSample({task:initialTask,onClose}:{task:DigitalTask;onClose:()=>void}){
 const [tab,setTab]=useState<typeof tabs[number]>('当前办理'),[note,setNote]=useState(''),[notice,setNotice]=useState('');
 const [documents,setDocuments]=useState<DigitalTaskDocuments|null>(null),[documentError,setDocumentError]=useState(''),[category,setCategory]=useState<keyof DigitalTaskDocuments|'results'>('development');
 const [history,setHistory]=useState<History|null>(null),[historyError,setHistoryError]=useState(''),[page,setPage]=useState(1),[revision,setRevision]=useState(0);
 const root=useRef<HTMLDivElement>(null);
 const controller=useDevelopmentExecution({sourceId:initialTask.sourceId!,taskId:initialTask.taskId,workspace:true,onChanged:message=>{setNotice(message??'已提交');setNote('');setRevision(value=>value+1);}});
 useDigitalDetailNavigationGuard(Boolean(note||controller.craftFiles.length),controller.busy,controller.writing,'有未提交的备注或成果，确定离开？');
 const {state,busy,error,craftFiles,run,upload,urls}=controller,task=state?.tasks.find(item=>item.taskId===initialTask.taskId)??initialTask,doc=state?.sheet.document;
 useEffect(()=>{const size=()=>{if(root.current)root.current.style.setProperty('--task-workbench-top',`${Math.max(0,root.current.getBoundingClientRect().top+window.scrollY)}px`);};size();window.addEventListener('resize',size);return()=>window.removeEventListener('resize',size);},[]);
 useEffect(()=>{let live=true;if(tab==='本单资料'){setDocuments(null);setDocumentError('');void digitalRequest<DigitalTaskDocuments>(`tasks/${task.taskId}/documents`).then(value=>{if(live)setDocuments(value);}).catch(reason=>{if(live)setDocumentError(reason.message);});}return()=>{live=false;};},[tab,task.taskId,revision]);
 useEffect(()=>{let live=true;if(tab==='操作记录'){setHistory(null);setHistoryError('');void digitalRequest<History>(`tasks/${task.taskId}/history`).then(value=>{if(live)setHistory(value);}).catch(reason=>{if(live)setHistoryError(reason.message);});}return()=>{live=false;};},[tab,task.taskId,revision]);
 const formId=`task-workbench-${task.taskId}`,canComplete=Boolean(state&&task.canExecute&&task.state==='ready'&&digitalTaskView(window.location.search)==='handle'),paper=task.taskKind==='development_pattern';
 const completedFiles=state?.facts.filter(fact=>fact.taskId===task.taskId).flatMap(fact=>fact.payload.attachmentIds??[])??[];
 return <div ref={root} className="task-workbench-sample" aria-label="工序工作台样板">
  <header><Button type="button" disabled={busy} onClick={onClose}>返回来源</Button><div><strong>{task.identity?.designStyleNo??state?.sheet.designStyleNo??'正在读取款号'}</strong><span>第 {task.routeVersion} 轮 · {task.label} · {task.assigneeName??'等待派工'}</span><small>{task.state==='completed'?`实际完成 ${date(task.completedAt)}`:`要求完成 ${date(task.dueAt)}`}</small></div><StatusBadge tone={task.state==='blocked'?'danger':'info'}>{digitalTaskStateLabels[task.state]}</StatusBadge><small>已确认工作台样板</small></header>
  <nav aria-label="任务页签">{tabs.map(value=><Button type="button" key={value} aria-pressed={tab===value} onClick={()=>setTab(value)}>{value}</Button>)}</nav>
  <main>
   {tab==='当前办理'&&<div className="task-workbench-handle"><aside><h2>本轮制作依据</h2><p>打板数量：{doc?.quantity??'未登记'} · 尺码：{doc?.sampleSize||'未登记'}</p><p>{doc?.instructions||'未登记制作说明'}</p><p>工艺：{doc?.craft??'待读取'} · 洗水：{doc?.washing??'待读取'}</p><Button type="button" onClick={()=>{setCategory('development');setTab('本单资料');}}>查看完整开发单</Button></aside><section><h2>{paper?'纸样办理':'车板办理'}</h2>{!state?<p role="status">正在读取原任务条件…</p>:<><ul aria-label="本轮前置条件">{task.unmetConditions?.map((item,index)=><li key={`${item.condition}:${index}`}><strong>{item.name}</strong>：{item.missing}；负责岗位：{roleLabel(item.responsibleRole)}{item.action?`；${item.action}`:''}</li>)}</ul>{!canComplete&&<p role="status">{task.state==='completed'?'本任务已完成':task.unmetConditions?.length?'请先处理上述前置条件':task.blockedReason||'当前任务状态或身份不具备办理条件，请核对原任务。'}</p>}{!paper&&<p>本轮齐料：{state.materialReadiness?.filter(item=>!item.available).length?'仍有待核实材料':'以原任务前置条件核验结果为准'} · 正式执行归属：{state.patternPreparation?.workerName??'等待主管派工'}</p>}<form id={formId} onSubmit={event=>{event.preventDefault();if(!canComplete)return;void run(paper?'complete':'route',paper?{taskId:task.taskId,note,attachmentIds:craftFiles}:{taskId:task.taskId,note,result:'通过',returnNodes:[],problemCategories:[],craftExecution:null,nextAssigneeId:null,sentDate:null,trackingNo:null});}}><label>办理备注<textarea aria-label="办理备注" value={note} disabled={busy||!canComplete} maxLength={paper?1000:2000} rows={4} onChange={event=>setNote(event.target.value)}/></label></form><p>{craftFiles.length?`已上传 ${craftFiles.length} 份工艺成果，待随本次办理提交`:`已有 ${completedFiles.length} 份任务成果`}</p><Button type="button" onClick={()=>{setCategory('results');setTab('本单资料');}}>查看 / 上传本轮成果</Button></>}</section></div>}
   {tab==='本单资料'&&<div className="task-workbench-documents"><nav aria-label="本单资料目录">{(Object.keys(documentNames) as Array<keyof DigitalTaskDocuments>).map(kind=><Button key={kind} type="button" aria-pressed={category===kind} onClick={()=>setCategory(kind)}>{documentNames[kind]}</Button>)}<Button type="button" aria-pressed={category==='results'} onClick={()=>setCategory('results')}>工序成果</Button></nav><section>{category==='results'?<><h2>本轮工序成果</h2>{paper&&canComplete&&<label>工艺开发板（原上传用途）<input type="file" disabled={busy} multiple accept="image/jpeg,image/png,image/webp,application/pdf" onChange={event=>{const files=Array.from(event.target.files??[]);event.target.value='';void upload(files,'工艺开发板');}}/></label>}<p>{craftFiles.length?`已上传 ${craftFiles.length} 份，返回当前办理提交后正式引用。`:'没有待提交的上传文件。'}</p>{completedFiles.map((id,index)=><p key={id}><a href={urls.apiUrl(`digital-production/sources/${initialTask.sourceId}/development/attachments/${id}`)} target="_blank" rel="noreferrer">查看已提交成果 {index+1}</a></p>)}</>:documentError?<p role="alert">{documentError}</p>:documents?<DocumentReader key={category} kind={category} reference={documents[category]}/>:<p role="status">正在读取授权资料目录…</p>}</section></div>}
   {tab==='操作记录'&&<section><h2>操作记录</h2>{historyError?<p role="alert">{historyError}</p>:!history?<p role="status">正在读取原任务记录…</p>:<><ol>{history.events.slice((page-1)*10,page*10).map(item=><li key={item.eventId}><strong>{item.kind}</strong> · {item.actorName} · {date(item.occurredAt)}<p>{item.payload.note??item.payload.reason??''}</p></li>)}</ol><Button type="button" disabled={page===1} onClick={()=>setPage(value=>value-1)}>上一页</Button><span>第 {page} 页</span><Button type="button" disabled={page*10>=history.events.length} onClick={()=>setPage(value=>value+1)}>下一页</Button></>}</section>}
  </main>
  <footer><div>{error?<p role="alert">{error}</p>:<p role="status">{busy?'正在处理，请勿重复提交':notice|| (craftFiles.length?'成果已上传，尚未随办理提交':note?'备注尚未提交，切换页签会保留':'未提交业务变化')}</p>}</div>{tab==='当前办理'&&canComplete&&<Button type="submit" form={formId} variant="primary" disabled={busy}>{paper?'纸样完成，交给下一位':'车板完成，交给下一位'}</Button>}{tab!=='当前办理'&&<Button type="button" onClick={()=>setTab('当前办理')}>回到当前办理</Button>}</footer>
 </div>;
}
