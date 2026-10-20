import {digitalTaskDisplayStatus} from './digital-workspace-copy.js';
import {roleLabel} from './components.js';
import {useEffect,useState} from 'react';
import {Button} from '@dx-rework/ui';
import type {DevelopmentArrangementInput} from '@dx-rework/contracts/development-arrangement';
import {SearchableSelect} from './search-select.js';
import {useDevelopmentExecution} from './digital-development-execution-panel.js';
import {useDigitalDetailNavigationGuard} from './use-digital-detail-navigation-guard.js';
export function DevelopmentAssignmentTable({controller,editing=false,onDirtyChange}:{controller:ReturnType<typeof useDevelopmentExecution>;editing?:boolean;onDirtyChange?:(dirty:boolean)=>void}){
 const {state,people,peopleFor,busy,run}=controller;
 const [dirty,setDirty]=useState(false),[notice,setNotice]=useState('');
 useEffect(()=>onDirtyChange?.(dirty),[dirty,onDirtyChange]);
 useEffect(()=>{if(controller.committedWrite?.path==='arrangement'){setDirty(false);setNotice('本次安排操作已保存。若最新资料暂未读取到，请仅重试读取。');}},[controller.committedWrite]);
 useDigitalDetailNavigationGuard(dirty,busy,controller.writing,'有未保存的人员安排，确定离开？');
 if(!state?.canDispatch)return null;
 const plan=state.arrangement;
 if(!editing)return <p><a href={`${controller.urls.pageUrl('ui/digital-production')}?arrangement=${state.sheet.sourceId}&round=${plan?.roundNumber??state.sheet.roundNumber??1}`}>打开本单总委派：安排 / 改派本轮师傅</a></p>;
 if(!plan)return <p>当前账号没有本轮安排权限，请从我的待办进入有权办理事项。</p>;
 if(!plan.readyToArrange)return <p>{plan.unavailableReason??"本轮安排条件暂未读取完整，请重新读取。"}</p>;
 if(peopleFor!==`${state.sheet.sourceId}:${plan.version}`)return <><p>岗位人员尚未读取完整，暂不能保存。</p><Button disabled={busy} onClick={()=>void controller.retryPeople()}>重新读取岗位人员</Button></>;
 const submit=async(form:FormData,management:DevelopmentArrangementInput['management'])=>{
   const entries=plan.rows.map(row=>({kind:row.kind as DevelopmentArrangementInput['entries'][number]['kind'],assigneeId:management==='keep'&&row.editable?(String(form.get(row.kind)||'')||null):row.assigneeId,expectedTask:row.taskId?{taskId:row.taskId,state:row.state!,assigneeId:row.assigneeId}:null,reason:management==='keep'?String(form.get(`${row.kind}:reason`)??''):''}));
   for(const row of plan.rows){const next=entries.find(entry=>entry.kind===row.kind)!;if(management==='keep'&&row.assigneeId&&next.assigneeId!==row.assigneeId&&row.taskId&&form.get(`${row.kind}:confirm`)!=='on'){setNotice(`请明确确认${row.label}的改派及其影响。`);return;}}
   const updated=await run('arrangement',{roundNumber:plan.roundNumber,expectedDocumentVersion:plan.documentVersion,expectedVersion:plan.version,entries,management,managementReason:String(form.get('managementReason')??'')},'PUT');
   if(updated){setDirty(false);setNotice(management==='keep'?'本轮安排已保存。已排人员的工序会在真实前置齐备后开始。':management==='takeover'?'已接管本轮安排。':'已交回文员安排。');}
 };
 return <section aria-label="本轮总委派">{controller.error&&<p role="alert">{controller.error}</p>}{notice&&<p role="status">{notice}</p>}
 <p>{plan.managerId?`本轮由${plan.managerName??'主管'}接管安排。`:'本轮由开发文员日常安排，主管可参与或随时接管。'}</p>
 <form key={`${plan.roundNumber}:${plan.version}`} onChange={event=>{if((event.target as unknown as HTMLInputElement).name!=='managementReason')setDirty(true);setNotice('');}} onSubmit={event=>{event.preventDefault();const management=((event.nativeEvent as SubmitEvent).submitter?.getAttribute('value')??'keep') as DevelopmentArrangementInput['management'];void submit(new FormData(event.currentTarget),management);}}><fieldset disabled={busy||controller.uncertainWrite}>
 <div className="development-table-scroll"><table><thead><tr><th>本轮工序</th><th>安排人员</th><th>当前进度 / 改派</th></tr></thead><tbody>{plan.rows.map(row=><tr key={row.kind}><th>{row.label}</th><td><SearchableSelect menuPortal aria-label={`安排${row.label}`} name={row.kind} defaultValue={row.assigneeId??''} disabled={!plan.canEdit||!row.editable}><option value="">尚未安排</option>{row.assigneeId&&!people.some(person=>person.id===row.assigneeId&&person.roles.includes(row.requiredRole))&&<option value={row.assigneeId}>{row.assigneeName??'原人员'}（当前不可安排）</option>}{people.filter(person=>person.roles.includes(row.requiredRole)).map(person=><option key={person.id} value={person.id}>{person.displayName}</option>)}</SearchableSelect></td><td>{!row.editable?'本工序已结束，保留历史人员':!row.valid?'尚未安排有效人员':state.tasks.find(task=>task.taskId===row.taskId)?digitalTaskDisplayStatus(state.tasks.find(task=>task.taskId===row.taskId)!):'人员已安排，等待实际前置建立任务'}{row.taskId&&state.tasks.find(task=>task.taskId===row.taskId)?.unmetConditions?.length?<ul>{state.tasks.find(task=>task.taskId===row.taskId)!.unmetConditions!.map((condition,index)=><li key={index}>{condition.name}：{condition.missing}；负责：{roleLabel(condition.responsibleRole)}{condition.action?`；${condition.action}`:''}</li>)}</ul>:null}{row.editable&&row.assigneeId&&row.taskId&&plan.canEdit&&<details><summary>明确改派</summary><label>改派原因<input name={`${row.kind}:reason`} maxLength={1000}/></label><label><input type="checkbox" name={`${row.kind}:confirm`}/>确认变更本任务人员；已有工资执行段须先由主管办理换人</label></details>}</td></tr>)}</tbody></table></div>
 <p>留空项仍保留同一安排待办。保存不会代替收货、完工或设计确认，不会调整价格或已有工资段。</p>
 {plan.canEdit&&<Button type="submit" value="keep">保存本轮安排</Button>}
 {plan.canTakeOver&&<details><summary>主管接管 / 交回文员</summary><label>接管或交回原因<textarea name="managementReason" maxLength={1000}/></label><Button type="submit" value="takeover" disabled={dirty}>接管本轮安排</Button>{plan.managerId&&<Button type="submit" value="release" disabled={dirty}>交回文员</Button>}<p>人员有未保存修改时，请先保存；接管操作不同时改变人员。</p></details>}
 </fieldset></form>
 {controller.uncertainWrite&&<Button disabled={busy} onClick={()=>void controller.recheck()}>重新读取已提交结果</Button>}
 </section>;
}
export function DevelopmentAssignmentEntry({sourceId,onChanged}:{sourceId:string;onChanged:()=>void}){const controller=useDevelopmentExecution({sourceId,onChanged});return <DevelopmentAssignmentTable controller={controller}/>;}
