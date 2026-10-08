import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DigitalDelegationSchema, DigitalCustomerAssignmentSchema, DigitalMerchandiserAssignmentSchema, DigitalDeliveryRequestSchema, DigitalDeliveryDecisionSchema, DigitalResourceKindSchema } from "@dx-rework/contracts/digital-production-access";
import { businessActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import type { DigitalIdentityDependencies } from "./identity-routes.js";
import type { DigitalProductionAccessService } from "./access-service.js";
export function registerDigitalAccessRoutes(app: FastifyInstance, dependencies: DigitalIdentityDependencies, service: DigitalProductionAccessService) {
  const actor = async (request: FastifyRequest) => {
    const token = request.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("dx_rework_session="))?.slice(18);
    return businessActor(dependencies.root, await dependencies.authenticate(token), request.id, "digital_production:view");
  };
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value); if (!result.success) throw new ApplicationError("VALIDATION_ERROR", "请检查授权、人员和日期", 400); return result.data;
  };
  const param = (request: FastifyRequest, name: string) => parse(z.string().uuid(), (request.params as Record<string, unknown>)[name]);
  app.get("/digital-production/access/options", async request => {
    const trusted = await actor(request);
    return service.options(trusted);
  });
  app.get("/digital-production/access/candidates", async request => service.candidates(await actor(request)));
  app.put("/digital-production/customers/:code/default-merchandiser", async request => service.setCustomerDefault(await actor(request), parse(z.string().trim().min(1).max(100), (request.params as Record<string, unknown>).code), parse(DigitalCustomerAssignmentSchema, request.body).merchandiserId));
  app.put("/digital-production/orders/:orderId/merchandiser", async request => {
    const input = parse(DigitalMerchandiserAssignmentSchema, request.body);
    return service.assignMerchandiser(await actor(request), param(request, "orderId"), input.merchandiserId, input.expectedVersion);
  });
  app.post("/digital-production/access/delegations", async request => service.delegate(await actor(request), parse(DigitalDelegationSchema, request.body)));
  app.get("/digital-production/access/delegations/:kind/:resourceId", async request => service.delegations(await actor(request), parse(DigitalResourceKindSchema, (request.params as Record<string, unknown>).kind), param(request, "resourceId")));
  app.post("/digital-production/access/delegations/:delegationId/revoke", async request => service.revoke(await actor(request), param(request, "delegationId")));
  app.post("/digital-production/orders/:orderId/delivery-requests", async request => service.requestDelivery(await actor(request), param(request, "orderId"), parse(DigitalDeliveryRequestSchema, request.body)));
  app.get("/digital-production/orders/:orderId/delivery-requests", async request => service.deliveryRequests(await actor(request), param(request, "orderId")));
  app.post("/digital-production/delivery-requests/:requestId/decision", async request => service.decideDelivery(await actor(request), param(request, "requestId"), parse(DigitalDeliveryDecisionSchema, request.body).decision));
}
