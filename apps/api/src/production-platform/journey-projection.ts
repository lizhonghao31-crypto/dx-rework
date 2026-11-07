import { JOURNEY_COVERAGE_KEYS, JOURNEY_STAGES, isJourneyPlanningNode, type JourneyCoverage, type JourneyFilter, type JourneyNode, type JourneyResult, type OrderJourney, type JourneyState } from "@dx-rework/contracts/digital-production-journey";
import {compareCockpitOrders,journeyDisplay} from "./journey-display.js";

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
const nodesOf=(item:OrderJourney)=>item.stages.flatMap(stage=>stage.nodes).filter(node=>node.current);
const ongoing=(item:OrderJourney)=>!completed(item)&&nodesOf(item).some(node=>!isJourneyPlanningNode(node)&&["active","pending","blocked"].includes(node.state));
// Whole-order completion comes only from the authoritative final packing/special-closure projection.
const completed=(item:OrderJourney)=>nodesOf(item).some(node=>["packing","special_closure"].includes(node.key)&&node.state==="completed");
export const journeyMatchesSearch=(item:OrderJourney,search:string)=>!search||[item.id,item.sourceId,item.orderId,item.designStyleNo,item.temporaryStyleNo,item.customer,item.designer,item.styleName,...item.orderNumbers,...item.links.map(link=>link.id),...item.merchandisers.map(person=>person.name),...item.lines.flatMap(line=>[line.po,line.formalStyleNo,line.temporaryStyleNo])].some(value=>value?.toLocaleLowerCase().includes(search));
export function selectJourneys(items:OrderJourney[],filter:JourneyFilter,asOf:string,paginate=true):JourneyResult {
  if(filter.scope)return selectCockpitJourneys(items,filter,asOf,paginate);
  const day=(value:string)=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(value));
  const search=filter.search.toLocaleLowerCase();
  const nodeMatches=(node:JourneyNode)=>(!filter.stage||node.stage===filter.stage)&&(!filter.node||node.key===filter.node)&&(!filter.state||node.state===filter.state)&&(!filter.risk||node.risks.includes(filter.risk));
  const hasNodeFilter=Boolean(filter.stage||filter.node||filter.state||filter.risk);
  const reminderMatches=(item:OrderJourney,reminder:NonNullable<OrderJourney["deliveryRisks"]>[number])=>(!filter.risk||reminder.risk===filter.risk)
    &&nodesOf(item).some(node=>node.key===reminder.nodeKey&&(!filter.stage||node.stage===filter.stage)&&(!filter.node||node.key===filter.node)&&(!filter.state||node.state===filter.state));
  const deliveryMatches=(item:OrderJourney)=>(item.deliveryRisks??[]).some(reminder=>reminderMatches(item,reminder));
  const risk=(item:OrderJourney,value:string)=>nodesOf(item).some(node=>node.risks.some(r=>r===value))||(item.deliveryRisks??[]).some(reminder=>reminder.risk===value&&reminderMatches(item,reminder));
  const scoped=items.filter(item=>journeyMatchesSearch(item,search)&&(!filter.customer||item.customer===filter.customer)&&(!filter.category||item.category===filter.category)
    &&(!filter.merchandiserId||item.merchandisers.some(person=>person.id===filter.merchandiserId))
    &&(!filter.startDate||day(item.createdAt)>=filter.startDate)&&(!filter.endDate||day(item.createdAt)<=filter.endDate)
    &&(!hasNodeFilter||nodesOf(item).some(nodeMatches)||deliveryMatches(item)));
  const summary={all:scoped.length,active:scoped.filter(ongoing).length,dueSoon:scoped.filter(item=>risk(item,"due_soon")).length,overdue:scoped.filter(item=>risk(item,"overdue")).length,blocked:scoped.filter(item=>risk(item,"blocked")).length,completed:scoped.filter(completed).length};
  const filtered=scoped.filter(item=>(!filter.missing||item.supervision?.coverage.some(c=>c.key===filter.missing))&&(filter.kpi==="all"||filter.kpi==="active"&&ongoing(item)||filter.kpi==="completed"&&completed(item)||filter.kpi==="due_soon"&&risk(item,"due_soon")||filter.kpi==="overdue"&&risk(item,"overdue")||filter.kpi==="blocked"&&risk(item,"blocked")));
  const selected=(paginate?filtered.slice((filter.page-1)*15,filter.page*15):filtered).map(item=>({...item,hitReasons:nodesOf(item).filter(node=>nodeMatches(node)&&(hasNodeFilter||node.risks.length>0)&&(filter.kpi!=="overdue"||node.risks.includes("overdue"))&&(filter.kpi!=="due_soon"||node.risks.includes("due_soon"))&&(filter.kpi!=="blocked"||node.risks.includes("blocked"))).map(node=>({nodeId:node.instanceId,nodeKey:node.key,stage:node.stage,risks:node.risks}))}));
  return {ruleVersion:"journey-v2.0",asOf,page:filter.page,pageSize:15,total:filtered.length,summary,items:selected};
}

function selectCockpitJourneys(items:OrderJourney[],filter:JourneyFilter,asOf:string,paginate:boolean):JourneyResult {
  const seen=new Set<string>();
  const base=selectJourneys(items,{...filter,scope:undefined,kpi:"all",page:1,missing:undefined},asOf,false).items.filter(item=>{
    if(seen.has(item.id))return false;seen.add(item.id);return true;
  })
    .map(item=>({...item,display:item.display??journeyDisplay(item,asOf)}));
  const scopeCounts={production:base.filter(item=>item.orderId&&item.display.mainState!=="cancelled").length,development:base.filter(item=>!item.orderId).length,cancelled:base.filter(item=>item.display.mainState==="cancelled").length};
  const scoped=base.filter(item=>filter.scope==="development"?!item.orderId:Boolean(item.orderId)&&item.display.mainState!=="cancelled").sort(compareCockpitOrders);
  const scopeNodes=(item:OrderJourney)=>nodesOf(item).filter(node=>(!filter.stage||node.stage===filter.stage)&&(!filter.node||node.key===filter.node)&&(!filter.state||node.state===filter.state)&&(!filter.risk||node.risks.includes(filter.risk)));
  const blocked=(item:typeof scoped[number])=>!['completed','cancelled'].includes(item.display.mainState)&&scopeNodes(item).some(node=>node.state==='blocked');
  const count=(state:NonNullable<OrderJourney["display"]>["mainState"])=>scoped.filter(item=>item.display.mainState===state).length;
  // Keep original closed-order coverage policy, and use it for both counts and
  // drill-down. Overlapping categories still count one mother in the KPI.
  const missing=(item:OrderJourney,key:JourneyCoverage['key'])=>(key==='fact_time'||!['completed','cancelled'].includes(item.display!.mainState))&&Boolean(item.supervision?.coverage.some(c=>c.key===key));
  const summary={all:scoped.length,active:count("active"),notStarted:count("not_started"),dueSoon:count("due_soon"),overdue:count("overdue"),completed:count("completed"),blocked:scoped.filter(blocked).length,timingMissing:scoped.filter(item=>JOURNEY_COVERAGE_KEYS.some(key=>missing(item,key))).length};
  const active=scoped.filter(item=>!["completed","cancelled"].includes(item.display.mainState));
  const inProgress=(item:OrderJourney)=>scopeNodes(item).filter(n=>!["completed","inherited","cancelled","not_applicable","unavailable"].includes(n.state));
  const supervision={overdue:active.filter(item=>inProgress(item).some(n=>n.risks.includes("overdue"))).length,dueSoon:active.filter(item=>inProgress(item).some(n=>n.risks.includes("due_soon"))).length,
    coverage:JOURNEY_COVERAGE_KEYS.flatMap(key=>{const affected=scoped.filter(item=>missing(item,key));return affected.length?[{key,orders:affected.length,message:affected[0]!.supervision!.coverage.find(c=>c.key===key)!.message}]:[];})};
  const filtered=scoped.filter(item=>(!filter.missing||missing(item,filter.missing))&&(filter.kpi==="all"||filter.kpi==="blocked"&&blocked(item)||item.display.mainState===filter.kpi));
  return {ruleVersion:"journey-v2.0",asOf,page:filter.page,pageSize:15,total:filtered.length,summary,supervision,scopeCounts,items:paginate?filtered.slice((filter.page-1)*15,filter.page*15):filtered};
}
