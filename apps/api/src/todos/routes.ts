import type { SourcingTransferContractReconciliation } from "../sourcing/sourcing-transfer-contract-reconciliation.js";
import {
  TodoListResponseSchema,
  TodoMineParamsSchema,
  TodoModuleSchema,
  TodoCountIndicatorSchema,
  TodoResponseSchema,
  TodoRoutingExceptionListResponseSchema,
  TodoRoutingExceptionParamsSchema,
  TransferTodoRoutingExceptionSchema,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { businessActor, isRootUser } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";

import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { TodoService } from "./service.js";
import type { SourcingTodoReconciliationService } from "./sourcing-reconciliation-service.js";

const cookieToken = (request: FastifyRequest): string | undefined =>
  request.headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("dx_rework_session="))
    ?.slice("dx_rework_session=".length);

const parse = <T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApplicationError("VALIDATION_ERROR", "Request validation failed", 400);
  }
  return result.data;
};

export type TodoHttpDependencies = Readonly<{
  authenticate(token: string | undefined): Promise<AuthUser>;
  root?: RootAuthority;
  transferContractReconciliation?: SourcingTransferContractReconciliation;
  sourcingReconciliation?: SourcingTodoReconciliationService;
  service: Pick<TodoService,
    "getForActor" | "listForActor" | "countIndicatorForActor"
      | "listRoutingExceptionsForActor" | "transferRoutingException">;
}>;

export function registerTodoRoutes(
  app: FastifyInstance,
  dependencies: TodoHttpDependencies,
): void {
  if (dependencies.sourcingReconciliation) {
    const operator = async (request: FastifyRequest) => {
      const user = await dependencies.authenticate(cookieToken(request));
      if (!await isRootUser(dependencies.root,user.id))
        throw new ApplicationError("FORBIDDEN","仅 Root 可盘点或补偿外发失效待办",403);
      return businessActor(dependencies.root,user,request.id,"todo:routing_exception_manage");
    };
    const previewSchema = z.object({caseIds:z.array(z.string().uuid()).max(100).default([]),limit:z.number().int().min(1).max(500).default(200)}).strict();
    const applySchema = z.object({selected:z.array(z.object({todoId:z.string().uuid(),evidenceHash:z.string().regex(/^[0-9a-f]{64}$/)}).strict()).min(1).max(100),
      reason:z.string().trim().min(1).max(300)}).strict();
    // Preview is always read-only. There is no automatic startup repair.
    app.post("/todos/sourcing-reconciliation/preview",async(request,reply)=>{
      const current = await operator(request); const input = parse(previewSchema,request.body??{});
      reply.header("cache-control","no-store");
      return dependencies.sourcingReconciliation!.preview(current,input.caseIds,input.limit);
    });
    app.post("/todos/sourcing-reconciliation/apply",async(request,reply)=>{
      const current = await operator(request); const input = parse(applySchema,request.body);
      const key = parse(z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),request.headers["idempotency-key"]);
      reply.header("cache-control","no-store");
      return dependencies.sourcingReconciliation!.apply(current,input.selected,input.reason,key);
    });
  }
  if (dependencies.transferContractReconciliation) {
    const operator = async (request: FastifyRequest) => {
      const user=await dependencies.authenticate(cookieToken(request));
      if (!await isRootUser(dependencies.root,user.id)) throw new ApplicationError("FORBIDDEN","仅 Root 可盘点或补录转厂合同待签回",403);
      return businessActor(dependencies.root,user,request.id,"todo:routing_exception_manage");
    };
    app.post("/todos/transfer-contract-reconciliation/preview",async(request,reply)=>{
      const current=await operator(request);
      const input=parse(z.object({caseIds:z.array(z.string().uuid()).max(100).default([]),limit:z.number().int().min(1).max(500).default(200)}).strict(),request.body??{});
      reply.header("cache-control","no-store");
      return dependencies.transferContractReconciliation!.preview(current,input.caseIds,input.limit);
    });
    app.post("/todos/transfer-contract-reconciliation/apply",async(request,reply)=>{
      const current=await operator(request);
      const input=parse(z.object({selected:z.array(z.object({caseId:z.string().uuid(),documentId:z.string().uuid(),version:z.number().int().positive(),evidenceHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(3),reason:z.string().trim().min(1).max(300)}).strict(),request.body);
      const key=parse(z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),request.headers["idempotency-key"]);
      reply.header("cache-control","no-store");
      return dependencies.transferContractReconciliation!.apply(current,input.selected,input.reason,key);
    });
  }
  const actor = async (
    request: FastifyRequest,
    capability: "todo:view" | "todo:routing_exception_manage" | "todo:routing_exception_read",
    role?: "production_management" | "pmc",
  ): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(cookieToken(request));
    if (
      !user.businessRoles?.length
      || !user.capabilities.includes(capability)
      || (role && !user.businessRoles.includes(role))
    ) {
      throw new ApplicationError("FORBIDDEN", "Current user lacks todo capability", 403);
    }
    return {
      actorId: user.id,
      actorRoles: user.businessRoles,
      authorizationCapability: capability,
      authorizationCapabilities: user.capabilities,
      requestId: request.id,
    };
  };

  app.get<{
    Querystring: { module?: string; page?: string; q?: string };
  }>("/todos/mine", async (request) => {
    const module = request.query.module === undefined ? undefined : parse(TodoModuleSchema, request.query.module);
    const query = request.query.q;
    const pageInput = request.query.page;
    if (query !== undefined && typeof query !== "string") {
      throw new ApplicationError("VALIDATION_ERROR", "搜索内容无效", 400);
    }
    const page = pageInput === undefined ? 1 : Number(pageInput);
    if (!Number.isInteger(page) || page < 1 || page > 100_000) {
      throw new ApplicationError("VALIDATION_ERROR", "页码无效", 400);
    }
    return TodoListResponseSchema.parse(await dependencies.service.listForActor(
      await actor(request, "todo:view"),
      {
        ...(module ? { module } : {}),
        query: query ?? "",
        page,
      },
    ));
  });

  app.get("/todos/mine/indicator", async (request, reply) => {
    const currentActor = await actor(request, "todo:view");
    reply.header("x-dx-rework-actor-id", currentActor.actorId);
    return TodoCountIndicatorSchema.parse(
      await dependencies.service.countIndicatorForActor(currentActor),
    );
  });

  app.get<{ Params: { todoId: string } }>("/todos/mine/:todoId", async (request) =>
    TodoResponseSchema.parse(await dependencies.service.getForActor(
      await actor(request, "todo:view"),
      parse(TodoMineParamsSchema, request.params).todoId,
    )));

  app.get("/todos/routing-exceptions/mine", async (request) =>
    TodoRoutingExceptionListResponseSchema.parse({
      routingExceptions: await dependencies.service.listRoutingExceptionsForActor(
        await (async () => {
          const user = await dependencies.authenticate(cookieToken(request));
          return user.businessRoles?.includes("pmc") && user.capabilities.includes("todo:routing_exception_read")
            ? actor(request, "todo:routing_exception_read", "pmc")
            : actor(request, "todo:routing_exception_manage", "production_management");
        })(),
      ),
    }));

  app.post<{ Params: { routingExceptionId: string } }>(
    "/todos/routing-exceptions/:routingExceptionId/transfer",
    async (request) => {
      const transfer = parse(TransferTodoRoutingExceptionSchema, request.body);
      return TodoResponseSchema.parse(
        await dependencies.service.transferRoutingException(
          await actor(request, "todo:routing_exception_manage", "production_management"),
          {
            routingExceptionId: parse(TodoRoutingExceptionParamsSchema, request.params).routingExceptionId,
            recipientUserId: transfer.recipientUserId,
            reason: transfer.reason,
            ...(transfer.delegationId ? { delegationId: transfer.delegationId } : {}),
          },
        ),
      );
    },
  );
}
