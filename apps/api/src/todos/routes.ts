import {
  TodoListResponseSchema,
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
  service: Pick<TodoService, "listForActor" | "listRoutingExceptionsForActor" | "transferRoutingException">;
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

  app.get("/todos/mine", async (request) => TodoListResponseSchema.parse({
    todos: await dependencies.service.listForActor(await actor(request, "todo:view")),
  }));

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
