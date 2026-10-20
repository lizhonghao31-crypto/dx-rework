import {TodoRouteDescriptorSchema,type TodoRouteDescriptor} from "./todos.js";
/** Validated destination shared by API notifications and browser todos. */
export function todoDestination(descriptor:TodoRouteDescriptor):string {
  const route = TodoRouteDescriptorSchema.parse(descriptor);
  const fallback = `/ui/tasks/${route.reworkOrderId ?? route.entityId}`;
  let path: string;
  const query = new URLSearchParams({ todo: route.todoId });

  switch (route.routeName) {
    case "rework_detail":
      path = fallback;
      if (route.tab) query.set("node", route.tab);
      break;
    case "process_configuration":
      path = `/ui/my-tasks/${route.todoId}`;
      break;
    case "whole_order_review":
      path = "/ui/work-reporting";
      query.set("rework", route.reworkOrderId ?? route.entityId);
      break;
    case "wage_period_detail":
      path = `/ui/wages/${route.entityId}`;
      break;
    case "digital_production_instruction":
      path = "/ui/digital-production";
      query.set("instruction", route.entityId);
      if (route.developmentRound) query.set("instructionVersion", String(route.developmentRound));
      break;
    case "digital_development_arrangement":
      path = "/ui/digital-production";
      query.set("arrangement", route.entityId);
      if(route.developmentRound)query.set("round",String(route.developmentRound));
      break;
    case "digital_development":
      path = "/ui/digital-production";
      query.set("development", route.entityId);
      if(route.developmentRound)query.set("round",String(route.developmentRound));
      break;
    case "digital_production_task":
      path = "/ui/digital-production";
      query.set("task", route.entityId);
      break;
    case "production_detail":
      path = `/ui/production-dashboard/${route.entityId}`;
      if (route.factoryDecisionId) query.set("factoryDecisionId", route.factoryDecisionId);
      break;
    case "supplier_onboarding":
      path = `/ui/suppliers/requests/${route.entityId}`;
      break;
    case "pattern_room_order":
      path = `/ui/pattern-room/orders/${route.entityId}`;
      if (route.roundId) query.set("round", route.roundId);
      break;
    case "sample_detail":
      path = `/ui/samples/${route.entityId}`;
      break;
    case "sourcing_detail":
      path = `/ui/sourcing/orders/${route.entityId}`;
      if (route.tab === "contract_return") query.set("section", "contract-return");
      break;
    case "responsibility_detail":
    case "own_factory_approval":
    case "external_responsibility_detail":
      path = fallback;
      query.set("tab", route.tab ?? route.routeName.replace("_detail", ""));
      break;
  }
  return `${path}?${query.toString()}`;
}
