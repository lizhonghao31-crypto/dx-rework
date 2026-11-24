import type {TodoRouteDescriptor} from "@dx-rework/contracts";
import {todoDestination} from "@dx-rework/contracts/todo-destination";

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
  return normalizedBasePath(appBasePath) + todoDestination(descriptor);
}

/** Builds the absolute HTTPS URL required by DingTalk clients. */
export function buildTodoExternalDeepLink(
  publicBaseUrl: string,
  descriptor: TodoRouteDescriptor,
): string {
  if (["digital_production_task", "digital_short_lead", "digital_order_time", "digital_order_quotation", "digital_secondary_craft_order", "digital_secondary_craft_source", "digital_bulk_washing", "digital_development", "digital_development_arrangement", "digital_bulk_preparation", "digital_source_material_investment", "digital_order_material_investment", "digital_factory_progress"].includes(descriptor.routeName)) throw new ApplicationError("FORBIDDEN", "数字生产任务仅限站内通知", 403);
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
