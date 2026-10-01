import {
  TodoRouteDescriptorSchema,
  type TodoRouteDescriptor,
} from "@dx-rework/contracts";

import { ApplicationError } from "../platform/errors.js";

const normalizedBasePath = (value: string): string => {
  if (
    value !== "/"
    && (!/^\/(?!\/)[^?#\\]*\/$/.test(value) || value.includes("//"))
  ) {
    throw new ApplicationError("VALIDATION_ERROR", "Application base path is invalid", 500);
  }
  return value === "/" ? "" : value.slice(0, -1);
};

/**
 * Builds only known internal routes. A todo stores a descriptor, never a
 * client-supplied URL, so deployment base paths and route allow-lists remain
 * centralized here.
 */
export function buildTodoDeepLink(
  appBasePath: string,
  descriptor: TodoRouteDescriptor,
): string {
  const route = TodoRouteDescriptorSchema.parse(descriptor);
  const base = normalizedBasePath(appBasePath);
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
  return `${base}${path}?${query.toString()}`;
}

/** Builds the absolute HTTPS URL required by DingTalk clients. */
export function buildTodoExternalDeepLink(
  publicBaseUrl: string,
  descriptor: TodoRouteDescriptor,
): string {
  if (["digital_production_task", "digital_development"].includes(descriptor.routeName)) throw new ApplicationError("FORBIDDEN", "数字生产任务仅限站内通知", 403);
  let base: URL;
  try {
    base = new URL(publicBaseUrl);
  } catch {
    throw new ApplicationError("VALIDATION_ERROR", "Todo public base URL is invalid", 500);
  }
  if (
    base.protocol !== "https:"
    || base.username
    || base.password
    || base.search
    || base.hash
  ) {
    throw new ApplicationError("VALIDATION_ERROR", "Todo public base URL must be a clean HTTPS URL", 500);
  }
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const internalPath = buildTodoDeepLink(basePath, descriptor);
  return new URL(internalPath, base.origin).toString();
}
