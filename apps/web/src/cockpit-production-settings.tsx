import {useEffect,useRef,useState} from "react";
import {Button,InsetField} from "@dx-rework/ui";
import {PageHeader} from "@dx-rework/ui/production";
import {JOURNEY_NODES,JOURNEY_STAGES} from "@dx-rework/contracts/digital-production-journey";
import type {DigitalDeadlinePolicy} from "@dx-rework/contracts/digital-production-tasks";
import type {DigitalAccessOptions} from "./digital-production-access-panel.js";
import {DigitalCockpitPersonnel} from "./digital-cockpit-personnel.js";
import {digitalRequest,DigitalRequestError} from "./digital-production-api.js";
import {createClientRequestId} from "./client-request-id.js";
import {trapCockpitDialogFocus} from "./cockpit-dialog-focus.js";
import "./cockpit-production-settings.css";

export const cockpitPolicyStage=(key:string)=>JOURNEY_NODES.find(node=>node.key===(key==="bulk_cutting_external"?"bulk_cutting":key==="production_sheet"?"production_instruction":key))?.stage??"other";
const date=(value:string)=>new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});
function PolicyEditor({policy,onClose,onSaved,onConflict}:{policy:DigitalDeadlinePolicy;onClose():void;onSaved(message:string):void;onConflict():Promise<void>}){
 const dialog=useRef<HTMLDialogElement>(null),backdropDown=useRef(false),writing=useRef(false),pending=useRef<{payload:string;key:string}|null>(null),live=useRef(true);
 const [busy,setBusy]=useState(false),[error,setError]=useState("");
 useEffect(()=>{live.current=true;const previous=document.activeElement as HTMLElement|null;dialog.current?.showModal();return()=>{live.current=false;dialog.current?.close();previous?.focus();};},[]);
 const save=async(form:HTMLFormElement)=>{
  if(writing.current)return;writing.current=true;setBusy(true);setError("");
  const fields=new FormData(form),body={expectedVersion:policy.version,slaHours:fields.get("hours")===""?null:Number(fields.get("hours")),warningRatio:Number(fields.get("ratio"))/100,note:String(fields.get("note")??"").trim()};
  const payload=JSON.stringify([policy.nodeKey,body]);if(pending.current?.payload!==payload)pending.current={payload,key:createClientRequestId()};
  try{const result=await digitalRequest<{nodeKey:string;version:number;affectedTasks:number}>(`deadline-policies/${policy.nodeKey}`,"PUT",body,pending.current.key);pending.current=null;if(live.current)onSaved(`已保存 ${policy.label}，应用到 ${result.affectedTasks} 个未完成任务。`);}
  catch(reason){if(live.current){if(reason instanceof DigitalRequestError&&reason.status===409){try{await onConflict();if(live.current)setError("参数已被其他人更新，现已刷新。请核对现行数值后重新填写并保存。");}catch{if(live.current)setError("参数发生冲突，读取现行数值失败。请关闭后刷新重试。");}}else setError(reason instanceof Error?reason.message:"保存失败，请重试");}}
  finally{writing.current=false;if(live.current)setBusy(false);}
 };
 return <dialog ref={dialog} className="cockpit-policy-dialog" aria-label={`编辑${policy.label}时效`} onCancel={event=>{event.preventDefault();if(!busy)onClose();}} onPointerDown={event=>{const box=event.currentTarget.getBoundingClientRect();backdropDown.current=event.target===event.currentTarget&&(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom);}} onClick={event=>{const box=event.currentTarget.getBoundingClientRect();if(backdropDown.current&&event.target===event.currentTarget&&!busy&&(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom))onClose();backdropDown.current=false;}} onKeyDown={trapCockpitDialogFocus}>
  <div><header><h2>{`编辑${policy.label}时效`}</h2><Button variant="secondary" disabled={busy} onClick={onClose}>关闭</Button></header>
   <p className="cockpit-policy-impact">应用于所有订单该节点的未完成任务，已完成和已取消历史保留。</p>
   {error&&<p role="alert">{error}</p>}
   <form key={`${policy.nodeKey}:${policy.version}`} onSubmit={event=>{event.preventDefault();void save(event.currentTarget);}}><fieldset disabled={busy}>
    <InsetField label="时限（小时，留空无时限）" name="hours" type="number" min="0.01" max="8760" step="0.01" defaultValue={policy.slaHours??""}/>
    <InsetField label="临期比例（%） *" name="ratio" type="number" min="1" max="99" step="any" required defaultValue={policy.warningRatio*100}/>
    <InsetField label="调整原因" name="note" maxLength={1000}/>
    <small className="cockpit-policy-baseline">现行版本 v{policy.version} · 最近调整 {date(policy.changedAt)}{policy.note?` · ${policy.note}`:""}</small>
    <Button type="submit">{busy?"保存中…":"应用到未完成任务"}</Button>
   </fieldset></form>
  </div>
 </dialog>;
}
export function CockpitProductionSettings(){
 const [access,setAccess]=useState<DigitalAccessOptions|null>(null),[policies,setPolicies]=useState<DigitalDeadlinePolicy[]>([]),[stage,setStage]=useState(""),[selected,setSelected]=useState<string|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState(""),[loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0);
 const live=useRef(true),generation=useRef(0);
 useEffect(()=>{live.current=true;const controller=new AbortController(),current=++generation.current;setLoading(true);setError("");void digitalRequest<DigitalAccessOptions>("access/options","GET",undefined,undefined,{signal:controller.signal}).then(async result=>{const rows=result.manage?await digitalRequest<DigitalDeadlinePolicy[]>("deadline-policies","GET",undefined,undefined,{signal:controller.signal}):[];if(live.current&&current===generation.current){setAccess(result);setPolicies(rows);setStage(value=>value||JOURNEY_STAGES.find(group=>rows.some(policy=>cockpitPolicyStage(policy.nodeKey)===group.key))?.key||"creation");}}).catch(reason=>{if(live.current&&reason.name!=="AbortError")setError(reason.message);}).finally(()=>{if(live.current&&current===generation.current)setLoading(false);});return()=>{live.current=false;controller.abort();};},[refresh]);
 const reloadPolicies=async()=>{const current=++generation.current;const rows=await digitalRequest<DigitalDeadlinePolicy[]>("deadline-policies");if(live.current&&current===generation.current)setPolicies(rows);};
 const chosen=policies.find(policy=>policy.nodeKey===selected),unknown=policies.filter(policy=>cockpitPolicyStage(policy.nodeKey)==="other"),currentStage=JOURNEY_STAGES.find(group=>group.key===stage),rows=policies.filter(policy=>cockpitPolicyStage(policy.nodeKey)===stage);
 return <div className="cockpit-settings">
  <PageHeader title="生产管理设置" actions={<Button variant="secondary" onClick={()=>setRefresh(value=>value+1)}>刷新数据</Button>}/>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  {loading?<p role="status">正在读取现行设置…</p>:!access?.manage&&!access?.customers?<p>当前岗位无权访问生产管理设置。</p>:<>
   <section className="cockpit-settings-overview" aria-label="现有生产设置">
    {access.customers&&<article><span className="cockpit-setting-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M17 14a5 5 0 0 1 4 5v2"/></svg></span><div><h2>客户跟单配置</h2><p>新建母单的默认主跟单</p></div><DigitalCockpitPersonnel orderId={null} onChanged={()=>setNotice("客户默认跟单已保存。")}/></article>}
    {access.manage&&<article><span className="cockpit-setting-symbol is-policy" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></svg></span><div><h2>节点时效</h2><p>{policies.length} 项现有参数 · 按阶段定位</p></div></article>}
   </section>
   {access.manage&&<>
    <section className="cockpit-settings-stages"><div className="cockpit-settings-section-title"><h2>生产流程阶段设置</h2><span>选择阶段，维护现有小节点时限</span></div>
     <div className="cockpit-policy-stage-scroll" role="region" tabIndex={0} aria-label="七阶段定位，可横向滚动"><ol className="cockpit-policy-stages">{JOURNEY_STAGES.map((group,index)=>{const count=policies.filter(policy=>cockpitPolicyStage(policy.nodeKey)===group.key).length;return <li key={group.key}><button type="button" aria-pressed={stage===group.key} aria-controls="cockpit-stage-policies" onClick={()=>setStage(group.key)}><span className="cockpit-policy-stage-ring" aria-hidden="true"><svg viewBox="0 0 72 72"><circle cx="36" cy="36" r="31"/><circle cx="36" cy="36" r="23"/></svg><b>{index+1}</b></span><strong>{group.label}</strong><small>{count?`${count} 个现有节点`:"暂无参数"}</small></button></li>;})}</ol></div>
     {unknown.length>0&&<Button variant="secondary" onClick={()=>setStage("other")}>归属待核实的节点（{unknown.length}）</Button>}
    </section>
    <section className="cockpit-settings-node-section" id="cockpit-stage-policies"><div className="cockpit-settings-section-title"><h2>阶段节点设置：{currentStage?.label??"归属待核实的现有节点"}</h2></div>
     {rows.length?<ul className="cockpit-policy-cards">{rows.map(policy=><li key={policy.nodeKey}><span className="cockpit-policy-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5H6v16h14V5h-2M9 3h8v4H9zM9 11h8M9 15h6"/></svg></span><div><h3>{policy.label}</h3><strong>{policy.slaHours===null?"无时限":`${policy.slaHours} 小时`}</strong><small>临期比例 {policy.warningRatio*100}%</small></div><Button variant="secondary" aria-label={`编辑${policy.label}时效`} onClick={()=>{setSelected(policy.nodeKey);setNotice("");}}>编辑</Button></li>)}</ul>:<p className="cockpit-policy-empty">本阶段暂无现有节点参数。</p>}
     <p className="cockpit-settings-footnote">未完成任务沿原规则应用调整，已完成和已取消历史保留。</p>
    </section>
   </>}
  </>}
  {chosen&&<PolicyEditor policy={chosen} onClose={()=>setSelected(null)} onConflict={reloadPolicies} onSaved={message=>{setSelected(null);setNotice(message);void reloadPolicies().catch(reason=>setError(`已保存，刷新失败：${reason.message}`));}}/>}
 </div>;
}
