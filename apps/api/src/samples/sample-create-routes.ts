import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { SamplePeopleQuerySchema } from "@dx-rework/contracts";
import type { AuthUser } from "../auth/service.js";
import type { RootAuthority } from "../access/root-authority.js";
import { businessActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import type { AttachmentService } from "../tools/attachments.js";
import type { SampleCreateService } from "./sample-create-service.js";
import type { SampleAttachmentService } from "./sample-attachments.js";

export type SampleCreateHttpDependencies = {
  authenticate(token: string | undefined): Promise<AuthUser>;
  root?: RootAuthority | undefined; service: SampleCreateService;
  files: SampleAttachmentService; attachments: AttachmentService;
};
export function registerSampleCreateRoutes(app: FastifyInstance, deps: SampleCreateHttpDependencies) {
  const actor = async (request: FastifyRequest, capability = "sample:view_basic") => {
    const token = request.headers.cookie?.split(";").map(part => part.trim()).find(part => part.startsWith("dx_rework_session="))?.slice("dx_rework_session=".length);
    return businessActor(deps.root, await deps.authenticate(token), request.id, capability);
  };
  const id = (input: unknown) => {
    const value = z.string().uuid().safeParse(input);
    if (!value.success) throw new ApplicationError("VALIDATION_ERROR", "样衣或附件编号无效", 400);
    return value.data;
  };
  app.get("/samples/creation-availability", async (request, reply) => {
    reply.header("Cache-Control", "no-store"); return deps.service.availability(await actor(request));
  });
  app.get("/samples/people", async (request, reply) => {
    const user = await actor(request, "sample:create"), query = SamplePeopleQuerySchema.safeParse(request.query);
    if (!query.success) throw new ApplicationError("VALIDATION_ERROR", "请输入员工姓名搜索", 400);
    reply.header("Cache-Control", "no-store"); return deps.service.people(user, query.data.search);
  });
  for (const [path, batch] of [["/samples", false], ["/samples/batch", true]] as const) {
    app.post(path, async (request, reply) => {
      const user = await actor(request, batch ? "sample:batch_create" : "sample:create"), key = request.headers["idempotency-key"];
      if (typeof key !== "string") throw new ApplicationError("VALIDATION_ERROR", "缺少提交编号，请重试", 400);
      reply.header("Cache-Control", "no-store");
      return reply.code(201).send(await deps.service.create(user, batch ? request.body : { items: [request.body] }, key, batch));
    });
  }
  app.get<{ Params: { id: string } }>("/samples/:id/attachments", async (request, reply) => {
    const user = await actor(request); reply.header("Cache-Control", "no-store");
    return deps.files.list(user, id(request.params.id));
  });
  app.get<{ Params: { id: string; attachmentId: string } }>("/samples/:id/attachments/:attachmentId/download", async (request, reply) => {
    const user = await actor(request), sampleId = id(request.params.id), attachmentId = id(request.params.attachmentId);
    if (!await deps.files.canDownloadForSample(user, sampleId, attachmentId)) throw new ApplicationError("FORBIDDEN", "当前身份无权查看此样衣附件", 403);
    const grant = await deps.attachments.createDownloadIntent(user, attachmentId, binding => deps.files.canDownload(user, binding), "inline");
    reply.header("Cache-Control", "no-store"); return reply.redirect(grant.downloadUrl);
  });
}
