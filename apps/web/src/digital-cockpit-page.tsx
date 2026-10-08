import { DigitalJourneyCockpit } from "./digital-journey-cockpit.js";
import {DigitalCockpitPersonnel} from "./digital-cockpit-personnel.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { JourneyReturnContextSchema, journeyReturnUrl, type JourneyResult, type OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import { cockpitContext, cockpitQuery, type CockpitContext } from "./digital-journey-cockpit-model.js";
import { createWebUrls } from "../url-contract.js";
import type { DigitalDeadlinePolicy } from "@dx-rework/contracts/digital-production-tasks";
import { digitalRequest } from "./digital-production-api.js";
import { createClientRequestId } from "./client-request-id.js";
import { Button } from "@dx-rework/ui";
import "./production-command-center-view.css";
import "./digital-cockpit.css";
const date=(value:string|null)=>value?new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false}):"待确认";
export {taskTimeProgress} from "./digital-cockpit-model.js";
export function DigitalCockpitPage(){
 const [data,setData]=useState<JourneyResult|null>(null),[error,setError]=useState(''),[context,setContext]=useState<CockpitContext>(()=>cockpitContext(window.location.search)),[refresh,setRefresh]=useState(0);
 const [detail,setDetail]=useState<OrderJourney|null>(null),[detailError,setDetailError]=useState(''),[detailLoading,setDetailLoading]=useState(false);
 const query=cockpitQuery(context),selectedId=context.selected??'';
 const viewContext=useMemo(()=>({...context,selected:selectedId||undefined}),[context,selectedId]);
 const changeContext=(patch:Partial<CockpitContext>,preserveSelection=false)=>{
  const parsed=JourneyReturnContextSchema.safeParse({...context,...patch,page:patch.page??(preserveSelection?context.page:1),...(!preserveSelection?{selected:undefined,expanded:undefined,focus:undefined,row:undefined,round:undefined}:{})});
  if(!parsed.success){setError(parsed.error.issues.map(issue=>issue.message).join('；'));return;}
  setError('');setContext(parsed.data);
  // Filter state changes only the query, preserving the shared router's history position.
  window.history.replaceState(window.history.state,'',createWebUrls(import.meta.env.BASE_URL).pageUrl(journeyReturnUrl(parsed.data)));
 };
 const [policies,setPolicies]=useState<DigitalDeadlinePolicy[]|null>(null),[busy,setBusy]=useState(false);
 const writing=useRef(false),pending=useRef<{payload:string;key:string}|null>(null);
 useEffect(()=>{let live=true;setData(null);setError('');const timer=window.setTimeout(()=>{void digitalRequest<JourneyResult>('journeys?'+query).then(value=>{if(live)setData(value);}).catch(e=>{if(live)setError(e.message);});},150);return()=>{live=false;window.clearTimeout(timer);};},[query,refresh]);
 useEffect(()=>{let live=true;setDetail(current=>current?.id===selectedId||current?.orderId===selectedId||current?.sourceId===selectedId?current:null);setDetailError('');setDetailLoading(Boolean(selectedId));if(selectedId)void digitalRequest<OrderJourney>('journeys/'+selectedId+(context.round?'?round='+context.round:'')).then(value=>{if(live)setDetail(value);}).catch(e=>{if(live)setDetailError(e.message);}).finally(()=>{if(live)setDetailLoading(false);});return()=>{live=false;};},[selectedId,context.round,refresh,data?.asOf]);
 const openPolicies=async()=>{try{setPolicies(await digitalRequest<DigitalDeadlinePolicy[]>('deadline-policies'));}catch(e){setError(e instanceof Error?e.message:'读取失败');}};
 const savePolicy=async(policy:DigitalDeadlinePolicy,form:HTMLFormElement)=>{if(writing.current)return;writing.current=true;setBusy(true);const values=new FormData(form);const body={expectedVersion:policy.version,slaHours:values.get('hours')===''?null:Number(values.get('hours')),warningRatio:Number(values.get('ratio'))/100,note:String(values.get('note')??'')};const payload=JSON.stringify([policy.nodeKey,body]);if(pending.current?.payload!==payload)pending.current={payload,key:createClientRequestId()};try{await digitalRequest(`deadline-policies/${policy.nodeKey}`,'PUT',body,pending.current.key);pending.current=null;await openPolicies();setRefresh(x=>x+1);}catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{writing.current=false;setBusy(false);}};
 return <div className="digital-cockpit"><DigitalJourneyCockpit data={data} error={error} detail={detail} detailError={detailError} detailLoading={detailLoading} context={viewContext} onChange={changeContext} actions={<div className="pattern-actions"><Button variant="secondary" onClick={()=>setRefresh(x=>x+1)}>刷新数据</Button>{data?.canManagePolicies&&<Button variant="secondary" onClick={()=>void openPolicies()}>工序时效设定</Button>}<DigitalCockpitPersonnel orderId={detail?.orderId??null} onChanged={()=>setRefresh(x=>x+1)}/></div>}/>
 {policies&&<div className="digital-cockpit-dialog-backdrop"><section role="dialog" aria-modal="true" aria-label="工序时效设定" className="digital-cockpit-dialog"><button disabled={busy} onClick={()=>setPolicies(null)}>关闭</button><h2>工序时效设定</h2><p>覆盖所有未完成同节点任务；已完成历史不变。</p>{error&&<p role="alert">{error}</p>}{policies.map(p=><form key={`${p.nodeKey}:${p.version}`} onSubmit={e=>{e.preventDefault();void savePolicy(p,e.currentTarget);}}><fieldset disabled={busy}><legend>{p.label} · v{p.version}</legend><label>时限（小时，留空无 SLA）<input type="number" name="hours" min="0.01" max="8760" step="0.01" defaultValue={p.slaHours??''}/></label><label>临期比例（%）<input type="number" name="ratio" min="1" max="99" required defaultValue={p.warningRatio*100}/></label><label>备注<input name="note" maxLength={1000}/></label><small>最近调整 {date(p.changedAt)} · {p.changedBy??'初始配置'} · {p.note}</small><button type="submit">应用到未完成任务</button></fieldset></form>)}</section></div>}</div>;
}
