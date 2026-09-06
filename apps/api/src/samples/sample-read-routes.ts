import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { SampleReadQuerySchema, SampleHistoryQuerySchema } from "@dx-rework/contracts";
import { businessActor } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { SampleReadService } from "./sample-read-service.js";

export type SampleReadHttpDependencies = {
  authenticate(token: string | undefined): Promise<AuthUser>;
  root?: RootAuthority | undefined;
  service: SampleReadService;
};
export function registerSampleReadRoutes(app: FastifyInstance, dependencies: SampleReadHttpDependencies) {
  const actor = async (request: FastifyRequest) => {
    const token = request.headers.cookie?.split(";").map(part => part.trim())
      .find(part => part.startsWith("dx_rework_session="))?.slice("dx_rework_session=".length);
    return businessActor(dependencies.root, await dependencies.authenticate(token), request.id, "sample:view_basic");
  };
  const id = (value: unknown) => {
    const parsed = z.string().uuid().safeParse(value);
    if (!parsed.success) throw new ApplicationError("VALIDATION_ERROR", "样衣编号无效", 400);
    return parsed.data;
  };
  app.get("/samples", async (request, reply) => {
    const user = await actor(request), query = SampleReadQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApplicationError("VALIDATION_ERROR", "样衣筛选条件无效", 400);
    reply.header("Cache-Control", "no-store");
    return dependencies.service.list(user, query.data);
  });
  app.get("/samples/options", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return dependencies.service.options(await actor(request));
  });
  app.get("/samples/amounts", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return dependencies.service.amounts(await actor(request));
  });
  app.get<{ Params: { id: string } }>("/samples/:id", async (request, reply) => {
    const user = await actor(request);
    reply.header("Cache-Control", "no-store");
    return dependencies.service.detail(user, id(request.params.id));
  });
  app.get<{ Params: { id: string } }>("/samples/:id/history", async (request, reply) => {
    const user = await actor(request), query = SampleHistoryQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApplicationError("VALIDATION_ERROR", "样衣历史筛选无效", 400);
    reply.header("Cache-Control", "no-store");
    return dependencies.service.history(user, id(request.params.id), query.data);
  });
}
