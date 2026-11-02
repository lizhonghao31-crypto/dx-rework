import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {JourneyNode,OrderJourney,NodeMaterial} from '@dx-rework/contracts/digital-production-journey';
import {cachedVerifiedSession,verifiedSessionIdentity,registerSessionInvalidator,verifySession} from './auth-session.js';
import type {CockpitContext} from './digital-journey-cockpit-model.js';

export type MaterialView={open:boolean;filter:'all'|'pending'|'effective'|'mine';scroll:number;focus:string};
export const emptyMaterialView=():MaterialView=>({open:false,filter:'all',scroll:0,focus:''});
export const materialViewKey=(order:OrderJourney,node:JourneyNode|null)=>`${order.id}|${order.selectedRound??0}|${node?.instanceId??''}`;
export function materialViewFromContext(key:string,context:CockpitContext):MaterialView{
 return context.materialNode===key?{open:context.materialView==='expanded',filter:context.materialFilter??'all',scroll:context.materialScroll??0,focus:context.materialFocus??''}:emptyMaterialView();
}
export const materialViewPatch=(key:string,view:MaterialView):Partial<CockpitContext>=>({materialNode:key,materialView:view.open?'expanded':undefined,materialFilter:view.filter==='all'?undefined:view.filter,materialScroll:view.scroll||undefined,materialFocus:view.focus||undefined});
export function filterNodeMaterials(rows:NodeMaterial[],filter:MaterialView['filter']){
 return rows.filter(row=>filter==='all'||filter==='mine'&&row.mine||filter==='effective'&&row.state==='effective'||filter==='pending'&&row.applicability!=='not_applicable'&&row.state!=='effective'&&row.state!=='not_applicable');
}

const subscribeIdentity=(notify:()=>void)=>{let live=true;const unregister=registerSessionInvalidator(notify);void verifySession().then(()=>{if(live)notify();});return()=>{live=false;unregister();};};
/** The Map retains UI preferences only. It never caches server facts or grants. */
export function useNodeMaterialsView(order:OrderJourney,node:JourneyNode|null,context:CockpitContext,onChange:(patch:Partial<CockpitContext>)=>void){
 const identity=useSyncExternalStore(subscribeIdentity,()=>verifiedSessionIdentity(cachedVerifiedSession()),()=>''),key=materialViewKey(order,node);
 const namespace=identity+'|'+order.id,cache=useRef<{namespace:string;views:Map<string,MaterialView>;seeded:boolean;identity:string|undefined;orderId:string}>({namespace,views:new Map(),seeded:false,identity,orderId:order.id});
 const changed=cache.current.namespace!==namespace,firstVerification=changed&&cache.current.identity===undefined&&identity!==undefined&&cache.current.orderId===order.id;
 const identityChanged=changed&&!firstVerification;
 if(firstVerification)cache.current={...cache.current,namespace,identity};
 else if(identityChanged)cache.current={namespace,views:new Map(),seeded:true,identity,orderId:order.id};
 if(!cache.current.views.has(key))cache.current.views.set(key,!cache.current.seeded?materialViewFromContext(key,context):emptyMaterialView());
 cache.current.seeded=true;
 const [,render]=useState(0),base=useRef(context),change=useRef(onChange);base.current=context;change.current=onChange;
 const view=cache.current.views.get(key)!;
 const restore=useRef({key,focus:context.materialNode===key?context.materialFocus??'':'',pending:context.materialNode===key&&Boolean(context.materialFocus)});
 if(identityChanged)restore.current={key,focus:'',pending:false};
 const live=useRef(namespace+'|'+key),scrollTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);live.current=namespace+'|'+key;
 const update=(patch:Partial<MaterialView>,publish=true)=>{
  const next={...cache.current.views.get(key)!,...patch};cache.current.views.set(key,next);render(n=>n+1);if(publish)change.current(materialViewPatch(key,next));return {...base.current,...materialViewPatch(key,next)};
 };
 const capture=(focus:string)=>update({focus});
 const rememberScroll=(scroll:number)=>{const stamp=namespace+'|'+key,next={...cache.current.views.get(key)!,scroll};cache.current.views.set(key,next);clearTimeout(scrollTimer.current);scrollTimer.current=setTimeout(()=>{if(live.current===stamp)change.current(materialViewPatch(key,next));},80);};
 useEffect(()=>()=>clearTimeout(scrollTimer.current),[key,namespace]);
 const patch=materialViewPatch(key,view);
 useEffect(()=>{if(Object.entries(patch).some(([k,value])=>context[k as keyof CockpitContext]!==value))change.current(patch);},[key,view.open,view.filter,view.scroll,view.focus,context.materialNode,context.materialView,context.materialFilter,context.materialScroll,context.materialFocus]); // only UI URL state
 return {key,identity,view,update,capture,rememberScroll,context:{...context,...patch},restore};
}
