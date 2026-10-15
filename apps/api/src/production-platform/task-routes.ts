import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DigitalTaskCompleteSchema, DigitalTaskAssignmentSchema, DigitalDeadlinePolicySchema, DigitalTimeCorrectionSchema } from "@dx-rework/contracts/digital-production-tasks";
import { businessActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import type { DigitalIdentityDependencies } from "./identity-routes.js";
import type { DigitalProductionTaskService } from "./task-service.js";
export function registerDigitalTaskRoutes(app: FastifyInstance, dependencies: DigitalIdentityDependencies, service: DigitalProductionTaskService) {
  const actor = async (request: FastifyRequest) => {
    const token = request.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith("dx_rework_session="))?.slice(18);
    return businessActor(dependencies.root, await dependencies.authenticate(token), request.id, "digital_production:tasks");
  };
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value); if (!result.success) throw new ApplicationError("VALIDATION_ERROR", "请检查任务、时间或时效参数", 400); return result.data;
  };
  const key = (request: FastifyRequest) => typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : "";
  const id = (request: FastifyRequest) => parse(z.string().uuid(), (request.params as Record<string, unknown>).taskId);
  app.get("/digital-production/document-directory/:kind/:id",async request=>{
    const params=parse(z.object({kind:z.enum(['source','order']),id:z.string().uuid()}).strict(),request.params);
    return service.resourceDocuments(await actor(request),params.kind,params.id);
  });
  app.post("/digital-production/tasks/:taskId/priority", async request => service.prioritize(await actor(request), id(request), parse(z.object({ priority: z.enum(["normal", "urgent"]) }).strict(), request.body).priority, key(request)));
  app.get("/digital-production/tasks", async request => service.list(await actor(request), parse(z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) }).strict(), request.query).page));
  app.get("/digital-production/tasks/:taskId", async request => service.read(await actor(request), id(request)));
  app.get("/digital-production/tasks/:taskId/documents", async request => service.documents(await actor(request), id(request)));
  app.get("/digital-production/tasks/:taskId/history", async request => service.history(await actor(request), id(request)));
  app.post("/digital-production/tasks/:taskId/complete", async request => service.complete(await actor(request), id(request), parse(DigitalTaskCompleteSchema, request.body), key(request)));
  app.post("/digital-production/tasks/:taskId/handover", async request => service.handover(await actor(request), id(request), parse(DigitalTaskCompleteSchema, request.body), key(request)));
  app.post("/digital-production/tasks/:taskId/feedback", async request => {
    const input = parse(z.object({ reason: z.string().trim().min(1).max(1000), blocked: z.boolean() }).strict(), request.body);
    return service.feedback(await actor(request), id(request), input.reason, input.blocked, key(request));
  });
  app.post("/digital-production/tasks/:taskId/reassign", async request => service.reassign(await actor(request), id(request), parse(DigitalTaskAssignmentSchema, request.body).assigneeId, key(request)));
  app.post("/digital-production/tasks/:taskId/time-corrections", async request => service.correctTime(await actor(request), id(request), parse(DigitalTimeCorrectionSchema, request.body), key(request)));
  app.get("/digital-production/deadline-policies", async request => service.policies(await actor(request)));
  app.put("/digital-production/deadline-policies/:nodeKey", async request => service.changePolicy(await actor(request), parse(z.string().regex(/^[a-z][a-z_]{1,99}$/), (request.params as Record<string, unknown>).nodeKey), parse(DigitalDeadlinePolicySchema, request.body), key(request)));
  app.post("/digital-production/lifecycle/:kind/:resourceId", async request => {
    const params = parse(z.object({ kind: z.enum(["order", "source"]), resourceId: z.string().uuid() }).strict(), request.params);
    const input = parse(z.object({ action: z.enum(["pause", "resume", "cancel"]), reason: z.string().trim().min(1).max(1000) }).strict(), request.body);
    return service.controlResource(await actor(request), { kind: params.kind, id: params.resourceId }, input.action, input.reason, key(request));
  });
}
