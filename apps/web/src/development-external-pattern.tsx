import {Button} from "@dx-rework/ui";
import {useState} from 'react';
import type {useDevelopmentExecution,ExternalPatternRecord} from "./digital-development-execution-panel.js";
function DepartureEvidence({record,controller}:{record:ExternalPatternRecord;controller:ReturnType<typeof useDevelopmentExecution>}){
 const [unknown,setUnknown]=useState((record.intervalVersion??0)>0&&!record.actualDeparture);
 const local=(at:string)=>new Date(at).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}).replace(' ','T').slice(0,16);
 return <><p>实际交出：{record.actualDeparture?new Date(record.actualDeparture).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):(record.intervalVersion??0)>0?'时间未能核实，内部周期评价精度受限':'尚未登记'}{record.intervalVersion?` · v${record.intervalVersion}`:''}</p>{controller.state?.technical?.enrolled&&controller.state.canRequestExternalPattern&&<details open={!record.intervalVersion}><summary>{record.intervalVersion?'订正实际交出时间':'登记实际交出时间'}</summary><form className="development-technical-editor" onSubmit={event=>{event.preventDefault();const data=new FormData(event.currentTarget),value=String(data.get('departedAt')??'');void controller.run('technical/external-paper-interval',{requestId:record.requestId,expectedVersion:record.intervalVersion??0,departedAt:unknown?null:new Date(`${value}+08:00`).toISOString(),note:data.get('note')});}}><fieldset disabled={controller.busy||controller.uncertainWrite}><legend>技术主管核验交出时间</legend><p>请求不等于实际交出；只扣除有依据的真实外发。订正追加新版本，原记录和实际收回状态保留。</p><label>交出时间状态<select aria-label="交出时间状态" value={unknown?'unknown':'verified'} onChange={e=>setUnknown(e.target.value==='unknown')}><option value="verified">已有真实时间依据</option><option value="unknown">时间无法核实</option></select></label><label>实际交出时间（北京时间）<input aria-label="实际交出时间（北京时间）" name="departedAt" type="datetime-local" required={!unknown} disabled={unknown} defaultValue={record.actualDeparture?local(record.actualDeparture):''}/></label><label>交出依据或订正原因<input aria-label="交出依据或订正原因" name="note" required maxLength={2000}/></label><Button type="submit">{record.intervalVersion?'保存订正版本':'记录真实交出时间'}</Button></fieldset></form></details>}{!!record.departureHistory?.length&&<details><summary>交出时间历史（{record.departureHistory.length}）</summary>{record.departureHistory.map(h=><p key={h.version}>v{h.version} · {h.departedAt?new Date(h.departedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'时间未知'} · {h.quality} · {h.note} · {h.recordedBy}于{new Date(h.recordedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}登记</p>)}</details>}</>;
}
export function DevelopmentExternalPattern({controller}:{controller:ReturnType<typeof useDevelopmentExecution>}){
 const {state,busy,run,externalFiles,upload,urls}=controller;
 if(!state?.slaEnrolled)return null;
 const round=state.sheet.roundNumber??1,records=state.externalPatterns?.filter(row=>row.roundNumber===round)??[],record=records.at(-1);
 const task=record?state.tasks.find(t=>t.taskId===record.taskId):null;
 const date=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});
 return <section className="development-external-pattern">
  {record?<><p>{record.receivedAt?'已收到':'跟进中'} · 请求发出 {date(record.requestedAt)} · {record.requestedBy}</p>
   {state.technical?.enrolled&&<DepartureEvidence key={`${record.requestId}:${record.intervalVersion??0}`} record={record} controller={controller}/>}
   {record.receivedAt?<><p>实际收到 {date(record.receivedAt)} · {record.receivedBy}</p>{record.attachmentIds?.map((id,index)=><p key={id}><a href={urls.apiUrl(`digital-production/sources/${state.sheet.sourceId}/development/attachments/${id}`)} target="_blank" rel="noreferrer">外部纸样附件 {index+1}</a></p>)}</>:<>
    {task?.dueAt&&<p>应收到：{date(task.dueAt)}</p>}
    {task?.canExecute&&task.state==='ready'&&<form onSubmit={event=>{event.preventDefault();void run('external-pattern',{action:'receive',requestId:record.requestId,note:new FormData(event.currentTarget).get('note'),attachmentIds:externalFiles});}}><fieldset disabled={busy}>
     {controller.previews.view}<label>收到的纸样附件<input type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" onChange={event=>{const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value='';void upload(files,'外部纸样');}}/></label>
     <p>{externalFiles.length?`已上传 ${externalFiles.length} 份，提交后保存。`:'请上传实际收到的纸样。'}</p><label>备注<input name="note" maxLength={1000}/></label><Button type="submit" disabled={!externalFiles.length}>记录已收到</Button>
    </fieldset></form>}
   </>}{(record.note||record.receiptNote)&&<details><summary>办理说明</summary><p>{record.note}</p><p>{record.receiptNote}</p></details>}</>:!state.canRequestExternalPattern&&<p>本轮尚无外部纸样请求记录。</p>}
  {records.length>1&&<details><summary>此前请求（{records.length-1}）</summary>{records.slice(0,-1).map(row=><section key={row.requestId}><p>发出 {date(row.requestedAt)} · {row.receivedAt?`收到 ${date(row.receivedAt)}`:'跟进中'}</p>{state.technical?.enrolled&&<DepartureEvidence key={`${row.requestId}:${row.intervalVersion??0}`} record={row} controller={controller}/>}</section>)}</details>}
  {state.canRequestExternalPattern&&(!record||record.receivedAt)&&<form onSubmit={event=>{event.preventDefault();void run('external-pattern',{action:'request',roundNumber:round,note:new FormData(event.currentTarget).get('note')});}}><fieldset disabled={busy}><p>技术部主管在实际发出请求后登记，由该时刻开始跟进。</p><label>请求说明<input name="note" maxLength={1000}/></label><Button type="submit">记录请求已发出</Button></fieldset></form>}
 </section>;
}
