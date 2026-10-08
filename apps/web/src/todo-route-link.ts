import type { TodoRouteDescriptor } from "@dx-rework/contracts";
import { createWebUrls } from "../url-contract.js";
const { pageUrl } = createWebUrls(import.meta.env.BASE_URL);
export const todoRouteHref = (route: TodoRouteDescriptor): string => {
  const orderId = route.reworkOrderId ?? route.entityId;
  const query = new URLSearchParams({ todo: route.todoId });
  let target: string;
  switch (route.routeName) {
    case "supplier_onboarding":
      target = `ui/suppliers/requests/${route.entityId}`;
      break;
    case "pattern_room_order":
      target = `ui/pattern-room/orders/${route.entityId}`;
      if (route.roundId) query.set("round", route.roundId);
      break;
    case "sample_detail":
      target = `ui/samples/${route.entityId}`;
      break;
    case "digital_production_instruction":
      target = "ui/digital-production";
      query.set("instruction", route.entityId);
      if (route.developmentRound) query.set("instructionVersion", String(route.developmentRound));
      break;
    case "digital_development":
      target = "ui/digital-production";
      query.set("development", route.entityId);
      if(route.developmentRound)query.set("round",String(route.developmentRound));
      break;
    case "digital_production_task":
      target = "ui/digital-production";
      query.set("task", route.entityId);
      break;
    case "production_detail":
      target = `ui/production-dashboard/${route.entityId}`;
      if (route.factoryDecisionId) query.set("factoryDecisionId", route.factoryDecisionId);
      break;
    case "process_configuration":
      target = "ui/process-configuration";
      query.set("rework", route.entityId);
      break;
    case "whole_order_review":
      target = "ui/work-reporting";
      query.set("rework", orderId);
      break;
    case "wage_period_detail":
      target = `ui/wages/${route.entityId}`;
      break;
    case "sourcing_detail":
      target = `ui/sourcing/orders/${route.entityId}`;
      if (route.tab === "contract_return") query.set("section", "contract-return");
      break;
    case "responsibility_detail":
    case "own_factory_approval":
    case "external_responsibility_detail":
      target = `ui/tasks/${orderId}`;
      query.set("tab", route.tab ?? route.routeName.replace("_detail", ""));
      break;
    case "rework_detail":
      target = `ui/tasks/${orderId}`;
      if (route.tab) query.set("node", route.tab);
      break;
  }
  return `${pageUrl(target)}?${query.toString()}`;
};
