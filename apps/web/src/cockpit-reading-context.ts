import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {registerSessionInvalidator} from './auth-session.js';
import type {CockpitContext} from './digital-journey-cockpit-model.js';

const keys=['milestone','expanded','focus','row','round','flow','nodeView','materialNode','materialView','materialFilter','materialScroll','materialFocus','documentOpen','documentView','documentStage','documentSearch','documentScroll','documentFocus'] as const;
type Point={left:number;top:number};
type Preferences={view:Partial<CockpitContext>;window:Point;outer:Point[];scrolls:Array<{selector:string}&Point>;disclosures:Array<{key:string;open:boolean}>;focus:{attribute:string;value:string}|null};
// Only UI preferences, held in this tab's bounded memory. No API result, grant,
// attachment URL, task payload or business draft is stored here.
const views=new Map<string,Preferences>();
registerSessionInvalidator(()=>views.clear());
const stamp=(identity:string,id:string)=>identity+'|'+(id||'overview');
export const cockpitViewPatch=(context:Partial<CockpitContext>)=>Object.fromEntries(keys.map(key=>[key,context[key]])) as Partial<CockpitContext>;
export function rememberedCockpitView(identity:string,id:string):Partial<CockpitContext>{return identity?{...views.get(stamp(identity,id))?.view}:{};}
/** A saved reading position takes priority only for the same anchor. An
 * explicit new node link must still reveal its requested node. */
export function matchesCockpitReading(identity:string,context:CockpitContext){
 const saved=views.get(stamp(identity,context.selected??''));
 return Boolean(identity&&saved?.scrolls.some(item=>item.selector==='.journey-node-viewport')&&(['milestone','focus','row','round','expanded','nodeView'] as const).every(key=>(saved.view[key]??(key==='nodeView'?'all':undefined))===(context[key]??(key==='nodeView'?'all':undefined))));
}
const point=(element:Element)=>({left:element.scrollLeft,top:element.scrollTop});
const ancestors=(root:HTMLElement)=>{const result:HTMLElement[]=[];for(let item=root.parentElement;item;item=item.parentElement)result.push(item);return result;};
const scrollSelectors=['.journey-node-viewport','.journey-po-order-facts','.cockpit-home-scroll','.cockpit-risk-list','.cockpit-related-documents','.node-materials-list','.cockpit-document-modal-scroll'];
export function rememberCockpitReading(identity:string,context:CockpitContext,root:HTMLElement|null,ready=true){
 if(!identity)return;const key=stamp(identity,context.selected??''),previous=views.get(key);
 const active=root?.contains(document.activeElement)?document.activeElement as HTMLElement:null;
 const focus=active?['data-cockpit-focus','data-material-focus','data-document-focus','id','aria-label'].map(attribute=>({attribute,value:active.getAttribute(attribute)??''})).find(item=>item.value)||previous?.focus||null:previous?.focus??null;
 const value:Preferences={view:cockpitViewPatch(context),window:ready&&root?{left:window.scrollX,top:window.scrollY}:previous?.window??{left:0,top:0},outer:ready&&root?ancestors(root).map(point):previous?.outer??[],scrolls:ready&&root?scrollSelectors.flatMap(selector=>{const element=root.querySelector(selector);return element?[{selector,...point(element)}]:[];}):previous?.scrolls??[],disclosures:ready&&root?[...root.querySelectorAll<HTMLDetailsElement>('details[data-cockpit-disclosure]')].map(item=>({key:item.dataset.cockpitDisclosure!,open:item.open})):previous?.disclosures??[],focus:ready?focus:previous?.focus??null};
 views.delete(key);views.set(key,value);if(views.size>40)views.delete(views.keys().next().value!);
}
export function restoreCockpitReading(identity:string,id:string,root:HTMLElement|null,restoreFocus=true){
 const saved=views.get(stamp(identity,id));if(!saved||!root)return()=>{};
 let cancelled=false,frame=0,second=0;const cancel=()=>{cancelled=true;};
 for(const event of ['pointerdown','keydown','wheel','touchstart'])window.addEventListener(event,cancel,{capture:true,passive:true});
 const restore=()=>{if(cancelled)return;
  for(const state of saved.disclosures){const found=[...root.querySelectorAll<HTMLDetailsElement>('details[data-cockpit-disclosure]')].find(item=>item.dataset.cockpitDisclosure===state.key);if(found)found.open=state.open;}
  for(const state of saved.scrolls){const element=root.querySelector(state.selector);if(element){element.scrollLeft=state.left;element.scrollTop=state.top;}}
  ancestors(root).forEach((item,index)=>{const state=saved.outer[index];if(state){item.scrollLeft=state.left;item.scrollTop=state.top;}});window.scrollTo(saved.window.left,saved.window.top);
  if(restoreFocus&&saved.focus){const target=[...root.querySelectorAll<HTMLElement>('['+saved.focus.attribute+']')].find(item=>item.getAttribute(saved.focus!.attribute)===saved.focus!.value);if(target&&target.getClientRects().length)target.focus({preventScroll:true});}
 };
 frame=requestAnimationFrame(()=>{restore();second=requestAnimationFrame(restore);});
 return()=>{cancelled=true;cancelAnimationFrame(frame);cancelAnimationFrame(second);for(const event of ['pointerdown','keydown','wheel','touchstart'])window.removeEventListener(event,cancel,true);};
}
/** Losing an anchor invalidates that anchor and its material view, not all UI. */
export function reconcileCockpitAnchor(order:OrderJourney,context:CockpitContext){
 const nodes=order.stages.flatMap(stage=>stage.nodes),missing=[context.focus,context.row].some(id=>Boolean(id)&&!nodes.some(node=>node.instanceId===id));
 const material=context.materialNode?.startsWith(order.id+'|')?context.materialNode.slice(context.materialNode.lastIndexOf('|')+1):null,missingMaterial=Boolean(material)&&!nodes.some(node=>node.instanceId===material);
 if(!missing&&!missingMaterial)return null;
 return {focus:undefined,row:undefined,...(missingMaterial?{materialNode:undefined,materialView:undefined,materialFilter:undefined,materialScroll:undefined,materialFocus:undefined}:{}),expanded:(context.expanded??'').split(',').filter(key=>order.stages.some(stage=>stage.key===key)).join(',')||nodes.find(node=>node.current)?.stage} satisfies Partial<CockpitContext>;
}
