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
      break;
    case "process_configuration":
      path = "/ui/process-configuration";
      query.set("rework", route.entityId);
      break;
    case "wage_period_detail":
      path = `/ui/wages/${route.entityId}`;
      break;
    case "whole_order_review":
    case "responsibility_detail":
    case "own_factory_approval":
    case "external_responsibility_detail":
      path = fallback;
      query.set("tab", route.tab ?? route.routeName.replace("_detail", ""));
      break;
  }
  return `${base}${path}?${query.toString()}`;
}
