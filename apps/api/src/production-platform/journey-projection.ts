import { JOURNEY_COVERAGE_KEYS, JOURNEY_STAGES, isJourneyPlanningNode, type JourneyCoverage, type JourneyFilter, type JourneyNode, type JourneyCompleteResult, type OrderJourney, type JourneyState } from "@dx-rework/contracts/digital-production-journey";
import {compareCockpitOrders,journeyDisplay} from "./journey-display.js";
import {journeyObservedDay} from './journey-risk-clock.js';

/** The complete selection contract, independent of task/document/SLA DTO
 * hydration. Callers must supply currently authorized and fresh facts. */
export type JourneySelectionNode=Pick<JourneyNode,'key'|'instanceId'|'stage'|'state'|'current'|'planningOnly'|'risks'>;
/** Filter-specific native SQL reductions. A global selection can carry these
 * booleans instead of transferring every mother's node collection. Detail
 * hydration still supplies the actual nodes/reasons for the selected page. */
export type JourneySelectionSignals={specialClosed?:boolean;completed:boolean;ongoing:boolean;nodeMatched:boolean;deliveryMatched:boolean;
 risks:{overdue:boolean;due_soon:boolean;blocked:boolean};scopedBlocked:boolean;scopedOverdue:boolean;scopedDueSoon:boolean;searchMatched?:boolean};
export type JourneySelection=Pick<OrderJourney,'id'|'sourceId'|'orderId'|'designStyleNo'|'temporaryStyleNo'|'customer'|'category'|'designer'|'styleName'|'merchandisers'|'orderNumbers'|'createdAt'>&{
 links:Array<{id:string}>;
 lines:Array<Pick<OrderJourney['lines'][number],'po'|'formalStyleNo'|'temporaryStyleNo'>>;
 stages:Array<{nodes:JourneySelectionNode[]}>;
 deliveryRisks?:Array<Pick<NonNullable<OrderJourney['deliveryRisks']>[number],'risk'|'nodeKey'>>;
 supervision?:{coverage:JourneyCoverage[]};
 display?:Pick<NonNullable<OrderJourney['display']>,'mainState'|'closedAt'|'earliestShipmentDate'>;
 fixedSchedule?:Pick<NonNullable<OrderJourney['fixedSchedule']>,'state'|'scopes'>;
 scheduleSelection?:{state:'normal'|'late'|'unknown'|'terminated';lagLineIds:string[];dueLineIds:string[];unknownLineIds:string[]};
 selectionSignals?:JourneySelectionSignals;
};
type SelectionResult<T>=Omit<JourneyCompleteResult,'items'>&{items:T[]};

/** A real instance replaces only its own round's empty catalogue slot. */
export function appendJourneyInstance(nodes:JourneyNode[],node:JourneyNode){
  const index=nodes.findIndex(value=>value.key===node.key&&value.round===node.round
    &&value.instanceId===`${value.key}:${value.round??0}`&&value.records.length===0
    &&['uncreated','unavailable'].includes(value.state));
  if(index>=0)nodes.splice(index,1,node);else nodes.push(node);
}

export function journeyCompletion(expected:string|null,actual:string|null,verified:boolean) {
  if (!expected || !actual || !verified) return { result:"unknown" as const, overdueSeconds:null };
  const difference=(Date.parse(actual)-Date.parse(expected))/1000;
  return {result:difference>0?"late" as const:difference<0?"early" as const:"on_time" as const,overdueSeconds:Math.max(0,difference)};
}
export function stageState(nodes:JourneyNode[]):JourneyState {
  nodes=nodes.filter(node=>!isJourneyPlanningNode(node));
  if(nodes.some(node=>node.state==="blocked"))return "blocked";
  if(nodes.some(node=>node.state==="active"))return "active";
  if(nodes.some(node=>node.state==="pending"))return "pending";
  if(nodes.some(node=>node.state==="unavailable"))return "unavailable";
  const applicable=nodes.filter(node=>node.state!=="not_applicable");
  if(!applicable.length)return "not_applicable";
  if(applicable.every(node=>node.state==="completed"||node.state==="inherited"))return "completed";
  if(applicable.every(node=>node.state==="cancelled"))return "cancelled";
  if(applicable.some(node=>node.state==="completed"||node.state==="inherited")&&applicable.some(node=>node.state==="uncreated"))return "pending";
  return "uncreated";
}
export function journeyStages(nodes:JourneyNode[]) { return JOURNEY_STAGES.map(stage=>({...stage,state:stageState(nodes.filter(node=>node.stage===stage.key&&node.current)),nodes:nodes.filter(node=>node.stage===stage.key)})); }
export function journeyScheduleSelection(item:JourneySelection){return item.scheduleSelection??(item.fixedSchedule?{state:item.fixedSchedule.state,lagLineIds:item.fixedSchedule.scopes.filter(scope=>scope.state==='late').flatMap(scope=>scope.lineId?[scope.lineId]:[]),dueLineIds:item.fixedSchedule.scopes.filter(scope=>scope.customerDuePassed).flatMap(scope=>scope.lineId?[scope.lineId]:[]),unknownLineIds:item.fixedSchedule.scopes.filter(scope=>scope.state==='unknown').flatMap(scope=>scope.lineId?[scope.lineId]:[])}:undefined);}
const scheduleMatches=(item:JourneySelection,filter:JourneyFilter)=>!filter.progress||Boolean(filter.progress==='schedule_lag'?journeyScheduleSelection(item)?.state==='late':filter.progress==='customer_due_passed'?journeyScheduleSelection(item)?.dueLineIds.length:journeyScheduleSelection(item)?.state==='unknown');
const nodesOf=(item:JourneySelection)=>item.stages.flatMap(stage=>stage.nodes).filter(node=>node.current);
const ongoing=(item:JourneySelection)=>item.selectionSignals?.ongoing??(!completed(item)&&!specialClosed(item)&&nodesOf(item).some(node=>!isJourneyPlanningNode(node)&&["active","pending","blocked"].includes(node.state)));
// Special closure stops the order but is not normal delivered completion.
const specialClosed=(item:JourneySelection)=>item.selectionSignals?.specialClosed??nodesOf(item).some(node=>node.key==="special_closure"&&node.state==="completed");
const completed=(item:JourneySelection)=>item.selectionSignals?.completed??nodesOf(item).some(node=>node.key==="packing"&&node.state==="completed");
/** The same unfiltered predicates, compiled once only for a complete native
 * view. Partial permissions or node filters must still use scoped reductions. */
export function journeyUnfilteredSignals(item:JourneySelection):JourneySelectionSignals{
 const nodes=nodesOf(item),delivery=item.deliveryRisks??[];
 const risk=(value:'overdue'|'due_soon'|'blocked')=>nodes.some(node=>node.risks.includes(value))||delivery.some(row=>row.risk===value);
 const open=nodes.filter(node=>!['completed','inherited','cancelled','not_applicable','unavailable'].includes(node.state));
 return {...(specialClosed(item)?{specialClosed:true}:{}),completed:completed(item),ongoing:ongoing(item),nodeMatched:nodes.length>0,deliveryMatched:delivery.length>0,
  risks:{overdue:risk('overdue'),due_soon:risk('due_soon'),blocked:risk('blocked')},
  scopedBlocked:nodes.some(node=>node.state==='blocked'),scopedOverdue:open.some(node=>node.risks.includes('overdue')),scopedDueSoon:open.some(node=>node.risks.includes('due_soon'))};
}
export const journeyMatchesSearch=(item:JourneySelection,search:string)=>!search||[item.id,item.sourceId,item.orderId,item.designStyleNo,item.temporaryStyleNo,item.customer,item.designer,item.styleName,...item.orderNumbers,...item.links.map(link=>link.id),...item.merchandisers.map(person=>person.name),...item.lines.flatMap(line=>[line.po,line.formalStyleNo,line.temporaryStyleNo])].some(value=>value?.toLocaleLowerCase().includes(search));
/** Native identity/search fields remain current even while complex facts are
 * pending. An unrelated customer's update must not blank this query's totals. */
export const journeyMatchesMetadata=(item:JourneySelection,filter:JourneyFilter)=>(item.selectionSignals?.searchMatched??journeyMatchesSearch(item,filter.search.toLocaleLowerCase()))
 &&(!filter.customer||item.customer===filter.customer)&&(!filter.category||item.category===filter.category)
 &&(!filter.merchandiserId||item.merchandisers.some(person=>person.id===filter.merchandiserId))
 &&(!filter.startDate||journeyObservedDay(item.createdAt)>=filter.startDate)&&(!filter.endDate||journeyObservedDay(item.createdAt)<=filter.endDate);
export function selectJourneys(items:OrderJourney[],filter:JourneyFilter,asOf:string,paginate=true):JourneyCompleteResult {
  return selectJourneySelections(filter.scope?items.map(item=>({...item,display:item.display??journeyDisplay(item,asOf)})):items,filter,asOf,paginate);
}
export function selectJourneySelections<T extends JourneySelection>(items:T[],filter:JourneyFilter,asOf:string,paginate=true):SelectionResult<T> {
  if(filter.scope)return selectCockpitSelections(items,filter,asOf,paginate);
  const nodeMatches=(node:JourneySelectionNode)=>(!filter.stage||node.stage===filter.stage)&&(!filter.node||node.key===filter.node)&&(!filter.state||node.state===filter.state)&&(!filter.risk||node.risks.includes(filter.risk));
  const hasNodeFilter=Boolean(filter.stage||filter.node||filter.state||filter.risk);
  const reminderMatches=(item:JourneySelection,reminder:NonNullable<JourneySelection["deliveryRisks"]>[number])=>(!filter.risk||reminder.risk===filter.risk)
    &&nodesOf(item).some(node=>node.key===reminder.nodeKey&&(!filter.stage||node.stage===filter.stage)&&(!filter.node||node.key===filter.node)&&(!filter.state||node.state===filter.state));
  const deliveryMatches=(item:JourneySelection)=>item.selectionSignals?.deliveryMatched??(item.deliveryRisks??[]).some(reminder=>reminderMatches(item,reminder));
  const risk=(item:JourneySelection,value:'overdue'|'due_soon'|'blocked')=>item.selectionSignals?.risks[value]??(nodesOf(item).some(node=>node.risks.some(r=>r===value))||(item.deliveryRisks??[]).some(reminder=>reminder.risk===value&&reminderMatches(item,reminder)));
  const scoped=items.filter(item=>journeyMatchesMetadata(item,filter)
    &&(!hasNodeFilter||(item.selectionSignals?.nodeMatched??nodesOf(item).some(nodeMatches))||deliveryMatches(item)));
  const summary={all:scoped.length,active:scoped.filter(ongoing).length,dueSoon:scoped.filter(item=>risk(item,"due_soon")).length,overdue:scoped.filter(item=>risk(item,"overdue")).length,blocked:scoped.filter(item=>risk(item,"blocked")).length,completed:scoped.filter(completed).length};
  const filtered=scoped.filter(item=>scheduleMatches(item,filter)&&(!filter.missing||item.supervision?.coverage.some(c=>c.key===filter.missing))&&(filter.kpi==="all"||filter.kpi==="active"&&ongoing(item)||filter.kpi==="completed"&&completed(item)||filter.kpi==="due_soon"&&risk(item,"due_soon")||filter.kpi==="overdue"&&risk(item,"overdue")||filter.kpi==="blocked"&&risk(item,"blocked")));
  const selected=(paginate?filtered.slice((filter.page-1)*15,filter.page*15):filtered).map(item=>({...item,hitReasons:nodesOf(item).filter(node=>nodeMatches(node)&&(hasNodeFilter||node.risks.length>0)&&(filter.kpi!=="overdue"||node.risks.includes("overdue"))&&(filter.kpi!=="due_soon"||node.risks.includes("due_soon"))&&(filter.kpi!=="blocked"||node.risks.includes("blocked"))).map(node=>({nodeId:node.instanceId,nodeKey:node.key,stage:node.stage,risks:node.risks}))}));
  return {ruleVersion:"journey-v2.0",asOf,page:filter.page,pageSize:15,total:filtered.length,summary,items:selected};
}

function selectCockpitSelections<T extends JourneySelection>(items:T[],filter:JourneyFilter,asOf:string,paginate:boolean):SelectionResult<T> {
  const seen=new Set<string>();
  const base=selectJourneySelections(items,{...filter,scope:undefined,kpi:"all",page:1,missing:undefined,progress:undefined},asOf,false).items.filter(item=>{
    if(seen.has(item.id))return false;seen.add(item.id);return true;
  })
    .map(item=>{if(!item.display)throw Error('Current authorized cockpit selection state is required');return {...item,display:item.display};});
  const scopeCounts={production:base.filter(item=>item.orderId&&item.display.mainState!=="cancelled").length,development:base.filter(item=>!item.orderId).length,cancelled:base.filter(item=>item.display.mainState==="cancelled").length};
  const scoped=base.filter(item=>filter.scope==="development"?!item.orderId:Boolean(item.orderId)&&item.display.mainState!=="cancelled").sort(compareCockpitOrders);
  const scopeNodes=(item:JourneySelection)=>nodesOf(item).filter(node=>(!filter.stage||node.stage===filter.stage)&&(!filter.node||node.key===filter.node)&&(!filter.state||node.state===filter.state)&&(!filter.risk||node.risks.includes(filter.risk)));
  const blocked=(item:typeof scoped[number])=>!['completed','closed','cancelled'].includes(item.display.mainState)&&(item.selectionSignals?.scopedBlocked??scopeNodes(item).some(node=>node.state==='blocked'));
  const count=(state:NonNullable<OrderJourney["display"]>["mainState"])=>scoped.filter(item=>item.display.mainState===state).length;
  // Keep original closed-order coverage policy, and use it for both counts and
  // drill-down. Overlapping categories still count one mother in the KPI.
  const missing=(item:JourneySelection,key:JourneyCoverage['key'])=>(key==='fact_time'||!['completed','closed','cancelled'].includes(item.display!.mainState))&&Boolean(item.supervision?.coverage.some(c=>c.key===key));
  const summary={all:scoped.length,active:count("active"),notStarted:count("not_started"),dueSoon:count("due_soon"),overdue:count("overdue"),completed:count("completed"),blocked:scoped.filter(blocked).length,timingMissing:scoped.filter(item=>JOURNEY_COVERAGE_KEYS.some(key=>missing(item,key))).length,...(scoped.some(item=>journeyScheduleSelection(item))?{scheduleLag:scoped.filter(item=>journeyScheduleSelection(item)?.state==='late').length,customerDuePassed:scoped.filter(item=>(journeyScheduleSelection(item)?.dueLineIds.length??0)>0).length,scheduleUnknown:scoped.filter(item=>journeyScheduleSelection(item)?.state==='unknown').length}:{})};
  const active=scoped.filter(item=>!["completed","closed","cancelled"].includes(item.display.mainState));
  const inProgress=(item:JourneySelection)=>scopeNodes(item).filter(n=>!["completed","inherited","cancelled","not_applicable","unavailable"].includes(n.state));
  const supervision={overdue:active.filter(item=>item.selectionSignals?.scopedOverdue??inProgress(item).some(n=>n.risks.includes("overdue"))).length,dueSoon:active.filter(item=>item.selectionSignals?.scopedDueSoon??inProgress(item).some(n=>n.risks.includes("due_soon"))).length,
    coverage:JOURNEY_COVERAGE_KEYS.flatMap(key=>{const affected=scoped.filter(item=>missing(item,key));return affected.length?[{key,orders:affected.length,message:affected[0]!.supervision!.coverage.find(c=>c.key===key)!.message}]:[];})};
  const filtered=scoped.filter(item=>scheduleMatches(item,filter)&&(!filter.missing||missing(item,filter.missing))&&(filter.kpi==="all"||filter.kpi==="blocked"&&blocked(item)||item.display.mainState===filter.kpi));
  return {ruleVersion:"journey-v2.0",asOf,page:filter.page,pageSize:15,total:filtered.length,summary,supervision,scopeCounts,items:paginate?filtered.slice((filter.page-1)*15,filter.page*15):filtered};
}
