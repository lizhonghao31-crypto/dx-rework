import type { DigitalJourneyQuery } from "./journey-query.js";
import { JourneyFilterSchema, type OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import { DEVELOPMENT_VIEWS, PATTERN_GROUPS, PATTERN_LANES, type DevelopmentView, type DevelopmentWorkspaceFilter, type DevelopmentWorkspaceResult, type PatternWorkspaceFilter, type PatternWorkspaceResult, type PatternWorkspaceTask } from "@dx-rework/contracts/digital-development-workspace";
import type { TrustedActorContext } from "../tools/repositories.js";
import { isRootActor } from "../access/business-authority.js";
import { digitalForbidden, isDigitalManagementReader, isDigitalTechnicalManager } from "./access-policy.js";
import {journeyMatchesSearch} from "./journey-projection.js";

/** Display views only. The original publication, route and order facts remain authoritative. */
export function developmentView(item: OrderJourney): DevelopmentView {
  if (item.orderId) return "ordered";
  const published = item.stages.flatMap(stage => stage.nodes).find(node => node.key === "development_publish");
  if (published?.state !== "completed") return "draft";
  const route = item.stages.find(stage => stage.key === "development")?.nodes.filter(node => node.current && (node.countsInProgress || node.state === "inherited") && !["not_applicable", "cancelled"].includes(node.state)) ?? [];
  return route.length > 0 && route.every(node => ["completed", "inherited"].includes(node.state)) ? "awaiting_order" : "developing";
}

export function patternTasks(items: OrderJourney[]): PatternWorkspaceTask[] {
  return items.flatMap(item => item.stages.flatMap(stage => stage.nodes).flatMap(node => {
    const group = PATTERN_GROUPS.find(group => (group.nodes as readonly string[]).includes(node.key));
    // Material plans, uncreated placeholders and inherited references are not tasks.
    if (!group || !node.current || !/^[0-9a-f-]{36}$/i.test(node.instanceId) || !node.records.some(record => record.domain === "task" && record.id === node.instanceId) || ["cancelled", "unavailable", "not_applicable", "inherited", "uncreated"].includes(node.state)) return [];
    return [{ asOf:item.asOf??null, journeyId: item.id, sourceId: item.sourceId, orderId: item.orderId, designStyleNo: item.designStyleNo, customer: item.customer, designer: item.designer, node, group: group.key }];
  }));
}

export class DevelopmentWorkspaceQuery {
  constructor(private readonly journeys: DigitalJourneyQuery) {}
  async designer(actor: TrustedActorContext, filter: DevelopmentWorkspaceFilter): Promise<DevelopmentWorkspaceResult> {
    if (!isRootActor(actor) && !(actor.actorRoles.includes("sample_designer") && actor.authorizationCapabilities?.includes("pattern_room:orders:create"))) digitalForbidden();
    let selectionFacts:OrderJourney[]|undefined;
    const result = await this.journeys.list(actor, JourneyFilterSchema.parse({ search: filter.search, ...(filter.customer ? {customer: filter.customer} : {}), startDate: filter.startDate, endDate: filter.endDate }), true,items=>{
      selectionFacts=items;
      return items.filter(item=>(!filter.designer||item.designer===filter.designer)&&(filter.view==='all'||developmentView(item)===filter.view)).slice((filter.page-1)*15,filter.page*15);
    });
    const facts=selectionFacts??result.items,details=new Map(result.items.map(item=>[item.id,item]));
    const all = facts.filter(item => !filter.designer || item.designer === filter.designer).map(journey => ({journey, view: developmentView(journey), canConfirm: !journey.orderId && Boolean(journey.sourceId) && (isRootActor(actor) || journey.stages.flatMap(stage => stage.nodes).some(node => node.key === "product_development" && node.owner?.id === actor.actorId))}));
    const counts = Object.fromEntries(DEVELOPMENT_VIEWS.map(view => [view.key, view.key === "all" ? all.length : all.filter(item => item.view === view.key).length])) as DevelopmentWorkspaceResult["counts"];
    const filtered = filter.view === "all" ? all : all.filter(item => item.view === filter.view);
    return {asOf: result.asOf, page: filter.page, pageSize: 15, total: filtered.length, counts, designers: [...new Set(facts.flatMap(item => item.designer ? [item.designer] : []))].sort(), customers: [...new Set(facts.flatMap(item => item.customer ? [item.customer] : []))].sort(), items: filtered.slice((filter.page - 1) * 15, filter.page * 15).map(item=>({...item,journey:details.get(item.journey.id)!}))};
  }
  async pattern(actor: TrustedActorContext, filter: PatternWorkspaceFilter): Promise<PatternWorkspaceResult> {
    const manager=isDigitalManagementReader(actor)||isDigitalTechnicalManager(actor);
    const clerk=actor.actorRoles.includes("development_clerk");
    if(filter.scope!=="mine"&&!manager&&!clerk)digitalForbidden();
    if(filter.scope==="unassigned"&&!manager)digitalForbidden();
    if(filter.scope==="dispatch"&&!isRootActor(actor)&&!actor.actorRoles.includes("pattern_room_supervisor"))digitalForbidden();
    // Board cards contain read-only facts. Handling always re-reads the actual task.
    const result = await this.journeys.list(actor, JourneyFilterSchema.parse({}), true,undefined,{details:false,patternBusiness:filter.business});
    const journeys=new Map(result.items.map(item=>[item.id,item])),search=filter.search.toLocaleLowerCase();
    const all = patternTasks(result.items).filter(task => filter.business === "all" || (task.node.key === "bulk_pattern" ? filter.business === "bulk" : filter.business === "development"));
    const assignments=filter.scope==="dispatch"?await this.journeys.pendingPatternAssignments(actor,[...new Set(all.flatMap(task=>task.sourceId?[task.sourceId]:[]))]):[];
    // One genuine current task supplies document context for each pending original order.
    // Formal assignment never changes this task's readiness, owner or completion.
    const dispatch=assignments.flatMap(assignment=>{
      const candidates=all.filter(task=>task.sourceId===assignment.sourceId&&["pending","active","blocked"].includes(task.node.state));
      const task=candidates.find(task=>task.group==="dispatch")??candidates[0];
      return task?[{...task,nativeAssignment:{orderId:assignment.orderId}}]:[];
    });
    const scoped=filter.scope==="dispatch"?dispatch:all.filter(task=>filter.scope==="mine"?task.node.owner?.id===actor.actorId:filter.scope==="unassigned"?!task.node.owner:filter.scope==="personnel"?["materials","dispatch"].includes(task.group):true);
    const filtered = scoped.filter(task => (journeyMatchesSearch(journeys.get(task.journeyId)!,search)||Boolean(task.node.owner?.name?.toLocaleLowerCase().includes(search)))&&(!filter.owner || task.node.owner?.id === filter.owner)
      && (filter.state === "all" || (filter.state === "ongoing" ? ["pending", "active", "blocked"].includes(task.node.state) : task.node.state === filter.state))
      && (!filter.risk || task.node.risks.includes(filter.risk)));
    const lane = PATTERN_LANES.find(item => item.key === filter.lane);
    const visible = filtered.filter(task => (!filter.group || task.group === filter.group) && (!lane || (lane.groups as readonly string[]).includes(task.group)));
    const owners = [...new Map(scoped.flatMap(task => task.node.owner ? [[task.node.owner.id, task.node.owner] as const] : [])).values()];
    return {asOf: result.asOf, page: filter.page, pageSize: 15, total: visible.length, archiveTotal: new Set(visible.map(task => task.journeyId)).size,
      counts: Object.fromEntries(PATTERN_GROUPS.map(group => [group.key, filtered.filter(task => task.group === group.key).length])) as PatternWorkspaceResult["counts"], owners,
      riskCounts:Object.fromEntries(PATTERN_GROUPS.map(group=>[group.key,{dueSoon:filtered.filter(task=>task.group===group.key&&task.node.risks.includes("due_soon")).length,overdue:filtered.filter(task=>task.group===group.key&&task.node.risks.includes("overdue")).length}])) as PatternWorkspaceResult["riskCounts"],
      risks: visible.filter(task => task.node.risks.length > 0).slice(0, 15),
      boardPreview:PATTERN_LANES.flatMap(lane=>visible.filter(task=>(lane.groups as readonly string[]).includes(task.group)).slice(0,3)),
      items: visible.slice((filter.page - 1) * 15, filter.page * 15)};
  }
}
