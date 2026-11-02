import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AuthUser } from "../auth/service.js";
import { businessActor } from "./business-authority.js";
import type { RootAuthority } from "./root-authority.js";
import type { SupplierOnboardingService } from "./supplier-onboarding-service.js";
import { ApplicationError } from "../platform/errors.js";
export type SupplierOnboardingDependencies = { authenticate(token: string | undefined): Promise<AuthUser>; root: RootAuthority; service: SupplierOnboardingService };
const params = z.object({ requestId: z.string().uuid() }).strict();
const parse = <T>(schema: z.ZodType<T>, value: unknown) => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApplicationError("VALIDATION_ERROR", "请检查申请参数", 400);
  return result.data;
};
export function registerSupplierOnboardingRoutes(app: FastifyInstance, deps: SupplierOnboardingDependencies) {
  const actor = async (request: FastifyRequest, mode: "read" | "request" | "approve") => {
    const token = request.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith("dx_rework_session="))?.slice(18);
    const user = await deps.authenticate(token);
    const root = await deps.root.isRootUser(user.id);
    const reviewer = root || user.businessRoles?.some(role => ["owner_group", "production_management"].includes(role));
    const readonly = mode === "read" && user.businessRoles?.includes("pmc") && user.capabilities.includes("supplier_onboarding:read");
    const capability = `supplier_onboarding:${readonly ? "read" : mode === "read" ? reviewer ? "approve" : "request" : mode}`;
    const requesting = capability === "supplier_onboarding:request";
    if ((requesting && reviewer) || (!root && (!user.capabilities.includes(capability)
      || (requesting ? !user.businessRoles?.some(role => ["order_merchandiser", "embroidery_washing_merchandiser"].includes(role)) : !reviewer && !readonly)))) {
      throw new ApplicationError("FORBIDDEN", "当前账号没有此申请操作权限", 403);
    }
    return businessActor(deps.root, user, request.id, capability);
  };
  const key = (request: FastifyRequest) => typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : "";
  const id = (request: FastifyRequest) => parse(params, request.params).requestId;
  app.get("/supplier-onboarding/requests", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return deps.service.list(await actor(request, "read"), parse(z.object({ scope: z.enum(["mine", "pending", "all"]).default("mine") }).strict(), request.query).scope);
  });
  app.get("/supplier-onboarding/requests/:requestId", async (request, reply) => {
    reply.header("cache-control", "no-store"); return deps.service.get(await actor(request, "read"), id(request));
  });
  const send = async (reply: FastifyReply, outcome: Awaited<ReturnType<SupplierOnboardingService["submit"]>>) =>
    reply.header("idempotency-replayed", String(outcome.reused)).code(outcome.statusCode).send(outcome.response);
  app.post("/supplier-onboarding/requests", async (request, reply) => send(reply, await deps.service.submit(await actor(request, "request"), request.body, key(request))));
  app.post("/supplier-onboarding/requests/:requestId/resubmit", async (request, reply) => send(reply, await deps.service.resubmit(await actor(request, "request"), id(request), request.body, key(request))));
  for (const [path, decision] of [["approve", "approved"], ["return", "returned"]] as const) app.post(`/supplier-onboarding/requests/:requestId/${path}`, async (request, reply) => send(reply,
    await deps.service.decide(await actor(request, "approve"), id(request), decision, request.body, key(request))));
}
