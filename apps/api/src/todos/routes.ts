import {
  TodoListResponseSchema,
  TodoMineParamsSchema,
  TodoNewIndicatorSchema,
  TodoResponseSchema,
  TodoRoutingExceptionListResponseSchema,
  TodoRoutingExceptionParamsSchema,
  TransferTodoRoutingExceptionSchema,
} from "@dx-rework/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { TodoService } from "./service.js";

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
  service: Pick<TodoService,
    "getForActor" | "listForActor" | "latestIndicatorForActor"
      | "listRoutingExceptionsForActor" | "transferRoutingException">;
}>;

export function registerTodoRoutes(
  app: FastifyInstance,
  dependencies: TodoHttpDependencies,
): void {
  const actor = async (
    request: FastifyRequest,
    capability: "todo:view" | "todo:routing_exception_manage",
    role?: "production_management",
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
    const module = request.query.module;
    const query = request.query.q;
    const pageInput = request.query.page;
    if (module !== undefined && module !== "rework" && module !== "sourcing") {
      throw new ApplicationError("VALIDATION_ERROR", "待办模块无效", 400);
    }
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
    return TodoNewIndicatorSchema.parse(
      await dependencies.service.latestIndicatorForActor(currentActor),
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
        await actor(request, "todo:routing_exception_manage", "production_management"),
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
