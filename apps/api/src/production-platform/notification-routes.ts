import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { businessActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import type { DigitalIdentityDependencies } from "./identity-routes.js";
import type { DigitalProductionNotificationService } from "./notification-service.js";
export function registerDigitalNotificationRoutes(app:FastifyInstance,dependencies:DigitalIdentityDependencies,service:DigitalProductionNotificationService) {
  const actor=async(request:FastifyRequest)=>{
    const token=request.headers.cookie?.split(";").map(v=>v.trim()).find(v=>v.startsWith("dx_rework_session="))?.slice(18);
    const trusted=await businessActor(dependencies.root,await dependencies.authenticate(token),request.id,"todo:view");
    if(!trusted.authorizationCapabilities?.includes("todo:view"))throw new ApplicationError("FORBIDDEN","无权查看待办",403);
    return trusted;
  };
  const id=(request:FastifyRequest)=>{const result=z.string().uuid().safeParse((request.params as Record<string,unknown>).eventId);if(!result.success)throw new ApplicationError("VALIDATION_ERROR","提醒标识无效",400);return result.data;};
  app.post("/digital-production/notifications/claim",async(request,reply)=>{const trusted=await actor(request);reply.header("x-dx-rework-actor-id",trusted.actorId);return service.claim(trusted);});
  app.get("/digital-production/notifications/:eventId",async(request,reply)=>{const trusted=await actor(request);reply.header("x-dx-rework-actor-id",trusted.actorId);return service.current(trusted,id(request));});
  app.post("/digital-production/notifications/:eventId/acknowledge",async request=>service.acknowledge(await actor(request),id(request)));
}
