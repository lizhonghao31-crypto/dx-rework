import {Button} from "@dx-rework/ui";
import type {useDevelopmentExecution} from "./digital-development-execution-panel.js";
export function DevelopmentExternalPattern({controller}:{controller:ReturnType<typeof useDevelopmentExecution>}){
 const {state,busy,run,externalFiles,upload,urls}=controller;
 if(!state?.slaEnrolled)return null;
 const round=state.sheet.roundNumber??1,records=state.externalPatterns?.filter(row=>row.roundNumber===round)??[],record=records.at(-1);
 const task=record?state.tasks.find(t=>t.taskId===record.taskId):null;
 const date=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'});
 return <section className="development-external-pattern">
  {record?<><p>{record.receivedAt?'已收到':'跟进中'} · 请求发出 {date(record.requestedAt)} · {record.requestedBy}</p>
   {state.technical?.enrolled&&task?.canExecute&&!record.actualDeparture&&<form onSubmit={event=>{event.preventDefault();const data=new FormData(event.currentTarget),value=String(data.get('departedAt'));void run('technical/external-paper-interval',{requestId:record.requestId,expectedVersion:record.intervalVersion??0,departedAt:new Date(`${value}+08:00`).toISOString(),note:data.get('note')});}}><fieldset disabled={busy}><legend>实际交出做外部纸样</legend><p>请求登记不等于实际交出；只有真实交出至实际收到的区间用于内部周期排除。</p><label>实际交出时间（北京时间）<input name="departedAt" type="datetime-local" required/></label><label>实际交出依据<input name="note" required maxLength={2000}/></label><Button type="submit">记录真实交出时间</Button></fieldset></form>}{record.actualDeparture&&<p>实际交出 {date(record.actualDeparture)}</p>}
   {record.receivedAt?<><p>实际收到 {date(record.receivedAt)} · {record.receivedBy}</p>{record.attachmentIds?.map((id,index)=><p key={id}><a href={urls.apiUrl(`digital-production/sources/${state.sheet.sourceId}/development/attachments/${id}`)} target="_blank" rel="noreferrer">外部纸样附件 {index+1}</a></p>)}</>:<>
    {task?.dueAt&&<p>应收到：{date(task.dueAt)}</p>}
    {task?.canExecute&&task.state==='ready'&&<form onSubmit={event=>{event.preventDefault();void run('external-pattern',{action:'receive',requestId:record.requestId,note:new FormData(event.currentTarget).get('note'),attachmentIds:externalFiles});}}><fieldset disabled={busy}>
     {controller.previews.view}<label>收到的纸样附件<input type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf" onChange={event=>{const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value='';void upload(files,'外部纸样');}}/></label>
     <p>{externalFiles.length?`已上传 ${externalFiles.length} 份，提交后保存。`:'请上传实际收到的纸样。'}</p><label>备注<input name="note" maxLength={1000}/></label><Button type="submit" disabled={!externalFiles.length}>记录已收到</Button>
    </fieldset></form>}
   </>}{(record.note||record.receiptNote)&&<details><summary>办理说明</summary><p>{record.note}</p><p>{record.receiptNote}</p></details>}</>:!state.canRequestExternalPattern&&<p>本轮尚无外部纸样请求记录。</p>}
  {records.length>1&&<details><summary>此前请求（{records.length-1}）</summary>{records.slice(0,-1).map(row=><p key={row.requestId}>发出 {date(row.requestedAt)} · {row.receivedAt?`收到 ${date(row.receivedAt)}`:'跟进中'}</p>)}</details>}
  {state.canRequestExternalPattern&&(!record||record.receivedAt)&&<form onSubmit={event=>{event.preventDefault();void run('external-pattern',{action:'request',roundNumber:round,note:new FormData(event.currentTarget).get('note')});}}><fieldset disabled={busy}><p>技术部主管在实际发出请求后登记，由该时刻开始跟进。</p><label>请求说明<input name="note" maxLength={1000}/></label><Button type="submit">记录请求已发出</Button></fieldset></form>}
 </section>;
}
