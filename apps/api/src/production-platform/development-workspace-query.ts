import type { DigitalJourneyQuery } from "./journey-query.js";
import { JourneyFilterSchema, type OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import { DEVELOPMENT_VIEWS, PATTERN_GROUPS, PATTERN_LANES, type DevelopmentView, type DevelopmentWorkspaceFilter, type DevelopmentWorkspaceResult, type PatternWorkspaceFilter, type PatternWorkspaceResult, type PatternWorkspaceTask } from "@dx-rework/contracts/digital-development-workspace";
import type { TrustedActorContext } from "../tools/repositories.js";
import { isRootActor } from "../access/business-authority.js";
import { digitalForbidden } from "./access-policy.js";

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
    return [{ journeyId: item.id, sourceId: item.sourceId, orderId: item.orderId, designStyleNo: item.designStyleNo, customer: item.customer, designer: item.designer, node, group: group.key }];
  }));
}

export class DevelopmentWorkspaceQuery {
  constructor(private readonly journeys: DigitalJourneyQuery) {}
  async designer(actor: TrustedActorContext, filter: DevelopmentWorkspaceFilter): Promise<DevelopmentWorkspaceResult> {
    if (!isRootActor(actor) && !(actor.actorRoles.includes("sample_designer") && actor.authorizationCapabilities?.includes("pattern_room:orders:create"))) digitalForbidden();
    const result = await this.journeys.list(actor, JourneyFilterSchema.parse({ search: filter.search, ...(filter.customer ? {customer: filter.customer} : {}), startDate: filter.startDate, endDate: filter.endDate }), true);
    const all = result.items.filter(item => !filter.designer || item.designer === filter.designer).map(journey => ({journey, view: developmentView(journey), canConfirm: !journey.orderId && Boolean(journey.sourceId) && (isRootActor(actor) || journey.stages.flatMap(stage => stage.nodes).some(node => node.key === "product_development" && node.owner?.id === actor.actorId))}));
    const counts = Object.fromEntries(DEVELOPMENT_VIEWS.map(view => [view.key, view.key === "all" ? all.length : all.filter(item => item.view === view.key).length])) as DevelopmentWorkspaceResult["counts"];
    const filtered = filter.view === "all" ? all : all.filter(item => item.view === filter.view);
    return {asOf: result.asOf, page: filter.page, pageSize: 20, total: filtered.length, counts, designers: [...new Set(result.items.flatMap(item => item.designer ? [item.designer] : []))].sort(), customers: [...new Set(result.items.flatMap(item => item.customer ? [item.customer] : []))].sort(), items: filtered.slice((filter.page - 1) * 20, filter.page * 20)};
  }
  async pattern(actor: TrustedActorContext, filter: PatternWorkspaceFilter): Promise<PatternWorkspaceResult> {
    const result = await this.journeys.list(actor, JourneyFilterSchema.parse({search: filter.search}), true);
    const all = patternTasks(result.items);
    const filtered = all.filter(task => (!filter.owner || task.node.owner?.id === filter.owner)
      && (filter.state === "all" || (filter.state === "ongoing" ? ["pending", "active", "blocked"].includes(task.node.state) : task.node.state === filter.state))
      && (!filter.risk || task.node.risks.includes(filter.risk)));
    const lane = PATTERN_LANES.find(item => item.key === filter.lane);
    const visible = filtered.filter(task => (!filter.group || task.group === filter.group) && (!lane || (lane.groups as readonly string[]).includes(task.group)));
    const owners = [...new Map(all.flatMap(task => task.node.owner ? [[task.node.owner.id, task.node.owner] as const] : [])).values()];
    return {asOf: result.asOf, page: filter.page, pageSize: 20, total: visible.length, archiveTotal: new Set(visible.map(task => task.journeyId)).size,
      counts: Object.fromEntries(PATTERN_GROUPS.map(group => [group.key, filtered.filter(task => task.group === group.key).length])) as PatternWorkspaceResult["counts"], owners,
      risks: visible.filter(task => task.node.risks.length > 0).slice(0, 20),
      items: visible.slice((filter.page - 1) * 20, filter.page * 20)};
  }
}
