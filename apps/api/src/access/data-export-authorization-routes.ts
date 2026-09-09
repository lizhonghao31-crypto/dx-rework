import type { FastifyInstance, FastifyRequest } from "fastify";

import { ApplicationError } from "../platform/errors.js";
import { ROOT_ACTOR_ROLE } from "./business-authority.js";
import { assertDataExportPolicy } from "./data-export-policy.js";
import type { AccessHttpDependencies } from "./routes.js";

const token = (request: FastifyRequest): string | undefined => request.headers.cookie
  ?.split(";")
  .map((part) => part.trim())
  .find((part) => part.startsWith("dx_rework_session="))
  ?.slice("dx_rework_session=".length);

export function registerDataExportAuthorizationRoutes(
  app: FastifyInstance,
  dependencies: AccessHttpDependencies,
): void {
  app.post("/access/data-export/authorize", async (request, reply) => {
    const user = await dependencies.authenticate(token(request));
    const root = await dependencies.root.isRootUser(user.id);
    if (!root && !user.businessRoles?.length) {
      throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    }
    const actorRoles = [...(user.businessRoles ?? [])];
    if (root && !actorRoles.includes(ROOT_ACTOR_ROLE)) actorRoles.push(ROOT_ACTOR_ROLE);
    assertDataExportPolicy({
      actorId: user.id,
      actorRoles,
      authorizationCapability: "data-export-policy",
      authorizationCapabilities: user.capabilities,
      requestId: request.id,
    }, "general");
    return reply.code(204).send();
  });
}
