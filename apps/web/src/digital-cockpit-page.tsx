import { DigitalJourneyCockpit } from "./digital-journey-cockpit.js";
import {DigitalCockpitPersonnel} from "./digital-cockpit-personnel.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { JourneyReturnContextSchema, journeyReturnUrl, type JourneyResult, type OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import { cockpitContext, cockpitQuery, type CockpitContext } from "./digital-journey-cockpit-model.js";
import { createWebUrls } from "../url-contract.js";
import { digitalRequest } from "./digital-production-api.js";
import { Button } from "@dx-rework/ui";
import "./production-command-center-view.css";
import "./digital-cockpit.css";
export {taskTimeProgress} from "./digital-cockpit-model.js";
export function DigitalCockpitPage(){
 const [data,setData]=useState<JourneyResult|null>(null),[error,setError]=useState(''),[context,setContext]=useState<CockpitContext>(()=>({...cockpitContext(window.location.search),scope:cockpitContext(window.location.search).scope??"production"})),[refresh,setRefresh]=useState(0);
 const [detail,setDetail]=useState<OrderJourney|null>(null),[detailError,setDetailError]=useState(''),[detailLoading,setDetailLoading]=useState(false);
 const query=cockpitQuery(context),selectedId=context.selected??'';
 const viewContext=useMemo(()=>({...context,selected:selectedId||undefined}),[context,selectedId]);
 const changeContext=(patch:Partial<CockpitContext>,preserveSelection=false)=>{
  const documentReset=!preserveSelection||Object.hasOwn(patch,'selected')&&patch.selected!==context.selected?{materialNode:undefined,materialView:undefined,materialFilter:undefined,materialScroll:undefined,materialFocus:undefined,nodeView:undefined,documentOpen:undefined,documentView:undefined,documentStage:undefined,documentSearch:undefined,documentScroll:undefined,documentFocus:undefined}:{};
  const parsed=JourneyReturnContextSchema.safeParse({...context,...patch,...documentReset,page:patch.page??(preserveSelection?context.page:1),...(!preserveSelection?{selected:undefined,expanded:undefined,focus:undefined,row:undefined,round:undefined}:{})});
  if(!parsed.success){setError(parsed.error.issues.map(issue=>issue.message).join('；'));return;}
  setError('');setContext(parsed.data);
  // Filter state changes only the query, preserving the shared router's history position.
  window.history.replaceState(window.history.state,'',createWebUrls(import.meta.env.BASE_URL).pageUrl(journeyReturnUrl(parsed.data)));
 };
 useEffect(()=>{let live=true;const controller=new AbortController();setData(null);setError('');if(selectedId)return()=>{live=false;controller.abort();};const timer=window.setTimeout(()=>{void digitalRequest<JourneyResult>('journeys?'+query,'GET',undefined,undefined,{signal:controller.signal}).then(value=>{if(live)setData(value);}).catch(e=>{if(live&&e.name!=='AbortError')setError(e.message);});},150);return()=>{live=false;controller.abort();window.clearTimeout(timer);};},[query,refresh,selectedId]);
 const detailKey=useRef('');
 useEffect(()=>{let live=true;const controller=new AbortController(),key=`${selectedId}:${context.round??'current'}`;const same=detailKey.current===key;setDetail(current=>same?current:null);detailKey.current=key;setDetailError('');setDetailLoading(Boolean(selectedId));if(selectedId)void digitalRequest<OrderJourney>('journeys/'+selectedId+'?view=cockpit'+(context.round?'&round='+context.round:''),'GET',undefined,undefined,{signal:controller.signal}).then(value=>{if(live)setDetail(value);}).catch(e=>{if(live&&e.name!=='AbortError')setDetailError(e.message);}).finally(()=>{if(live)setDetailLoading(false);});return()=>{live=false;controller.abort();};},[selectedId,context.round,refresh]);
 return <div className="digital-cockpit"><DigitalJourneyCockpit data={data} error={error} detail={detail} detailError={detailError} detailLoading={detailLoading} context={viewContext} onChange={changeContext} actions={<div className="pattern-actions"><Button variant="secondary" onClick={()=>setRefresh(x=>x+1)}>刷新数据</Button>{data?.canManagePolicies&&<a className="dx-button dx-button--secondary" href={createWebUrls(import.meta.env.BASE_URL).pageUrl("ui/digital-cockpit")+"?workspace=settings"}>生产管理设置</a>}<DigitalCockpitPersonnel showCustomer={false} orderId={detail?.orderId??null} onChanged={()=>setRefresh(x=>x+1)}/></div>}/>
 </div>;
}
