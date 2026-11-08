import type { FastifyInstance } from "fastify";
import { authenticateForRequest, type RequestAuthenticator } from "../auth/request-identity-context.js";
import { ApplicationError } from "../platform/errors.js";

export function memberWriteRouteModule(method: string, path: string): "rework" | "sourcing" | null {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return null;
  // OCR extraction and acknowledgement are technical reads, not order mutations.
  if (path === "/rework-orders/inspection-report-extractions") return null;
  if (/^\/(?:rework-orders|rework-process-configurations|work-tasks|work-reports|responsibility-determinations|own-factory-approvals|external-responsibility-cases|external-responsibility-batches|external-responsibility-revision-requests|external-deduction-cases|tail-inspection-assignments)(?:\/|$)/.test(path)) return "rework";
  if (/^\/(?:sourcing|production-reporting)(?:\/|$)/.test(path)) return "sourcing";
  return null;
}

export function registerMemberModuleHttpGuard(app: FastifyInstance, authenticate: RequestAuthenticator): void {
  app.addHook("preHandler", async request => {
    const module = memberWriteRouteModule(request.method, request.routeOptions.url ?? request.url.split("?")[0]!);
    if (!module) return;
    const token = request.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("dx_rework_session="))?.slice("dx_rework_session=".length);
    const user = await authenticateForRequest(authenticate, token, request, "admission");
    // Auth resolves policy from stable IDs on every request; Root never receives this restriction.
    if (user.readOnlyModules?.includes(module)) throw new ApplicationError("FORBIDDEN", "当前账号在此业务模块仅可查看", 403);
  });
}
