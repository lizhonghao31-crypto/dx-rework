import { JOURNEY_STAGES, type JourneyFilter, type JourneyNode, type JourneyResult, type OrderJourney, type JourneyState } from "@dx-rework/contracts/digital-production-journey";

export function journeyCompletion(expected:string|null,actual:string|null,verified:boolean) {
  if (!expected || !actual || !verified) return { result:"unknown" as const, overdueSeconds:null };
  const difference=(Date.parse(actual)-Date.parse(expected))/1000;
  return {result:difference>0?"late" as const:difference<0?"early" as const:"on_time" as const,overdueSeconds:Math.max(0,difference)};
}
export function stageState(nodes:JourneyNode[]):JourneyState {
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
const ongoing=(item:OrderJourney)=>!completed(item)&&nodesOf(item).some(node=>["active","pending","blocked"].includes(node.state));
// Whole-order completion comes only from the authoritative final packing/special-closure projection.
const completed=(item:OrderJourney)=>nodesOf(item).some(node=>["packing","special_closure"].includes(node.key)&&node.state==="completed");
export const journeyMatchesSearch=(item:OrderJourney,search:string)=>!search||[item.id,item.sourceId,item.orderId,item.designStyleNo,item.temporaryStyleNo,item.customer,item.designer,item.styleName,...item.orderNumbers,...item.links.map(link=>link.id),...item.merchandisers.map(person=>person.name),...item.lines.flatMap(line=>[line.po,line.formalStyleNo,line.temporaryStyleNo])].some(value=>value?.toLocaleLowerCase().includes(search));
export function selectJourneys(items:OrderJourney[],filter:JourneyFilter,asOf:string,paginate=true):JourneyResult {
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
  const filtered=scoped.filter(item=>filter.kpi==="all"||filter.kpi==="active"&&ongoing(item)||filter.kpi==="completed"&&completed(item)||filter.kpi==="due_soon"&&risk(item,"due_soon")||filter.kpi==="overdue"&&risk(item,"overdue")||filter.kpi==="blocked"&&risk(item,"blocked"));
  const selected=(paginate?filtered.slice((filter.page-1)*15,filter.page*15):filtered).map(item=>({...item,hitReasons:nodesOf(item).filter(node=>nodeMatches(node)&&(hasNodeFilter||node.risks.length>0)&&(filter.kpi!=="overdue"||node.risks.includes("overdue"))&&(filter.kpi!=="due_soon"||node.risks.includes("due_soon"))&&(filter.kpi!=="blocked"||node.risks.includes("blocked"))).map(node=>({nodeId:node.instanceId,nodeKey:node.key,stage:node.stage,risks:node.risks}))}));
  return {ruleVersion:"journey-v2.0",asOf,page:filter.page,pageSize:15,total:filtered.length,summary,items:selected};
}
