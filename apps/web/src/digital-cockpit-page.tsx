import {DigitalJourneyCockpit} from './digital-journey-cockpit.js';
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {JourneyReturnContextSchema,journeyReturnUrl} from '@dx-rework/contracts/digital-production-journey';
import {cockpitContext,cockpitQuery,type CockpitContext} from './digital-journey-cockpit-model.js';
import {createWebUrls} from '../url-contract.js';
import {canLeaveInternalPage,registerInternalNavigationGuard} from './internal-navigation.js';
import {useCockpitReads} from './cockpit-reads.js';
import {cachedVerifiedSession,verifySession} from './auth-session.js';
import {cockpitViewPatch,rememberCockpitReading,rememberedCockpitView,restoreCockpitReading,reconcileCockpitAnchor,matchesCockpitReading} from './cockpit-reading-context.js';
import {CockpitAstryxScope,CockpitButton,hasCockpitAstryx} from './cockpit-astryx.js';
import './production-command-center-view.css';
import './digital-cockpit.css';
import {deliveryReturnPath} from './delivery-calendar-model.js';
export {taskTimeProgress} from './digital-cockpit-model.js';

export function DigitalCockpitPage({deliveryReturn}:{deliveryReturn?:string|undefined}={}){
 const [astryx]=useState(hasCockpitAstryx);
 const [optedOut]=useState(()=>new URLSearchParams(window.location.search).get('cockpitAstryx')==='off');
 const calendarReturn=deliveryReturnPath(deliveryReturn??null,import.meta.env.BASE_URL);
 const returnContextUrl=(context:CockpitContext)=>journeyReturnUrl(context)+(calendarReturn?'&'+new URLSearchParams({deliveryReturn:calendarReturn}):'')+(optedOut?'&cockpitAstryx=off':'');
 const [context,setContext]=useState<CockpitContext>(()=>({...cockpitContext(window.location.search),scope:cockpitContext(window.location.search).scope??'production'})),[refresh,setRefresh]=useState(0),[contextError,setContextError]=useState(''),[notice,setNotice]=useState('');
 const [searchDraft,setSearchDraft]=useState({value:context.search,pending:false});
 const readKey=context.selected?JSON.stringify([context.selected,context.round]):cockpitQuery(context);
 const quietRefresh=useRef<{revision:number;key:string}|null>(null);
 const reads=useCockpitReads(context,refresh,'home',quietRefresh.current?.revision===refresh&&quietRefresh.current.key===readKey),root=useRef<HTMLDivElement>(null),navigation=useRef(0),previousIdentity=useRef(reads.identity),seeded=useRef(false),initial=useRef(context);
 const session=cachedVerifiedSession(),canDelete=Boolean(session&&session!=='denied'&&session.status==='authorized'&&session.user.isRoot);
 const ready=context.selected?Boolean(reads.detail)&&!reads.detailLoading:Boolean(reads.data)&&!['preparing','loading'].includes(reads.listPhase);
 // Live observation advances visible time locally, not the whole query.
 // Explicit refresh and committed actions own server reads.
 const restoreReading=Boolean(context.selected)&&matchesCockpitReading(reads.identity,context);
 const latest=useRef({context,identity:reads.identity,ready,canonicalId:reads.detail?.id});latest.current={context,identity:reads.identity,ready,canonicalId:reads.detail?.id};
 const remember=()=>{const current=latest.current;rememberCockpitReading(current.identity,current.context,root.current,current.ready);if(current.ready&&current.context.selected&&current.canonicalId&&current.context.selected!==current.canonicalId)rememberCockpitReading(current.identity,{...current.context,selected:current.canonicalId},root.current,true);};
 const changeContext=(patch:Partial<CockpitContext>,preserveSelection=false)=>{
  const originIdentity=reads.identity,originOrder=context.selected;
  void (async()=>{
   if(originIdentity!==latest.current.identity||originOrder!==latest.current.context.selected)return;
   const base=latest.current.context,target=preserveSelection?(Object.hasOwn(patch,'selected')?patch.selected:base.selected):undefined;
   const switching=target!==base.selected,changingRound=Object.hasOwn(patch,'round')&&patch.round!==base.round,attempt=++navigation.current;
   if((switching||changingRound)&&!await canLeaveInternalPage())return;
   if(attempt!==navigation.current||originIdentity!==latest.current.identity||originOrder!==latest.current.context.selected)return;
   remember();
   const restored=switching?{...cockpitViewPatch({}),...rememberedCockpitView(reads.identity,target??'')}:{},input={...latest.current.context,...restored,...patch,selected:target,page:patch.page??(preserveSelection?latest.current.context.page:1)};
   const parsed=JourneyReturnContextSchema.safeParse(input);
   if(!parsed.success){setContextError(parsed.error.issues.map(issue=>issue.message).join('；'));return;}
   setContextError('');if(switching)setNotice('');setContext(parsed.data);
   window.history.replaceState(window.history.state,'',createWebUrls(import.meta.env.BASE_URL).pageUrl(returnContextUrl(parsed.data)));
  })().catch(error=>setContextError(error instanceof Error?error.message:'切换失败，请重试'));
 };
 useEffect(()=>{
  if(previousIdentity.current&&previousIdentity.current!==reads.identity){++navigation.current;setContext(value=>({...value,...cockpitViewPatch({})}));setNotice('');}
  previousIdentity.current=reads.identity;
 },[reads.identity]);
 useEffect(()=>{
  if(seeded.current||!reads.identity)return;seeded.current=true;
  const saved=rememberedCockpitView(reads.identity,initial.current.selected??''),explicit=Object.fromEntries(Object.entries(cockpitViewPatch(initial.current)).filter(([,value])=>value!==undefined)),next={...initial.current,...saved,...explicit};
  setContext(next);window.history.replaceState(window.history.state,'',createWebUrls(import.meta.env.BASE_URL).pageUrl(returnContextUrl(next)));
 },[reads.identity]);
 useEffect(()=>registerInternalNavigationGuard(async()=>{remember();return true;}),[]);
 useLayoutEffect(()=>()=>remember(),[]);
 useLayoutEffect(()=>ready&&(!context.selected||restoreReading)?restoreCockpitReading(reads.identity,context.selected??'',root.current):undefined,[reads.identity,context.selected,ready]);
 useEffect(()=>{
  if(!reads.detail||reads.detailLoading)return;const patch=reconcileCockpitAnchor(reads.detail,context);
  if(patch){const next={...context,...patch};setContext(next);window.history.replaceState(window.history.state,'',createWebUrls(import.meta.env.BASE_URL).pageUrl(returnContextUrl(next)));setNotice('原节点已变更，已定位到所属阶段');}
 },[reads.detail,reads.detailLoading,context.focus,context.row,context.materialNode]);
 const draftChanged=useCallback((value:string,pending:boolean)=>setSearchDraft(current=>current.value===value&&current.pending===pending?current:{value,pending}),[]);
 const reload=(silent=false)=>{
  const waiting=context.selected?reads.detailLoading:['preparing','loading'].includes(reads.listPhase);
  if(!silent&&waiting)return;
  remember();
  if(!reads.identity)void verifySession(true);
  quietRefresh.current=silent?{revision:refresh+1,key:readKey}:null;
  setRefresh(version=>version===refresh?version+1:version);
 };
 return <div ref={root} className={astryx?'digital-cockpit dx-cockpit-astryx':'digital-cockpit'} onFocusCapture={remember}><CockpitAstryxScope enabled={astryx}>{notice&&<p role="status">{notice}</p>}<DigitalJourneyCockpit canDelete={canDelete} identityKey={reads.identity} data={reads.data} error={contextError||reads.listError} detail={reads.detail} detailError={reads.detailError} detailLoading={reads.detailLoading} context={context} appliedContext={reads.applied} readPhase={reads.listPhase} searchDraft={searchDraft} onSearchDraft={draftChanged} onPlanCommitted={()=>reload(true)} restoreReading={restoreReading} onChange={changeContext} actions={<div className="pattern-actions">{calendarReturn&&<a className="journey-text-action" href={createWebUrls(import.meta.env.BASE_URL).pageUrl(calendarReturn)}>返回交付点阵图</a>}<CockpitButton variant="secondary" onClick={()=>reload()}>刷新数据</CockpitButton></div>}/></CockpitAstryxScope></div>;
}
