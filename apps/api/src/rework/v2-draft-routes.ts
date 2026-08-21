import { ReworkOrderResponseSchema } from "@dx-rework/contracts";
import { SaveReworkV2DraftSchema } from "@dx-rework/contracts/rework-supply-context";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { ReworkV2DraftService } from "./v2-draft-service.js";

const cookieToken = (request: FastifyRequest): string | undefined =>
  request.headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("dx_rework_session="))
    ?.slice("dx_rework_session=".length);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reworkOrderId = (request: FastifyRequest<{ Params: { reworkOrderId: string } }>): string => {
  const value = request.params.reworkOrderId;
  if (!UUID.test(value)) throw new ApplicationError("VALIDATION_ERROR", "返工单编号格式无效", 400);
  return value;
};

export type ReworkV2DraftHttpDependencies = Readonly<{
  authenticate(token: string | undefined): Promise<AuthUser>;
  service: ReworkV2DraftService;
  root?: RootAuthority;
}>;

export function registerReworkV2DraftRoutes(
  app: FastifyInstance,
  dependencies: ReworkV2DraftHttpDependencies,
): void {
  const actor = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticate(cookieToken(request));
    const isRoot = await dependencies.root?.isRootUser(user.id) ?? false;
    const isOwner = user.businessRoles?.includes("owner_group") === true;
    const isQualityControl = user.businessRoles?.includes("quality_control") === true
      && user.capabilities.includes("rework:initiate");
    if (!user.businessRoles?.length && !isRoot) {
      throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    }
    if (!isRoot && !isOwner && !isQualityControl) {
      throw new ApplicationError("FORBIDDEN", "只有品控、老板或超级用户可以维护 N01 草稿", 403);
    }
    const actorRoles = [...(user.businessRoles ?? [])];
    const authorizationCapabilities = [...user.capabilities];
    if (isRoot && !actorRoles.includes("root_superuser")) actorRoles.push("root_superuser");
    if ((isRoot || isOwner) && !actorRoles.includes("quality_control")) actorRoles.push("quality_control");
    if ((isRoot || isOwner) && !authorizationCapabilities.includes("rework:initiate")) {
      authorizationCapabilities.push("rework:initiate");
    }
    return {
      actorId: user.id,
      actorRoles,
      authorizationCapability: "rework:initiate",
      authorizationCapabilities,
      requestId: request.id,
    };
  };

  app.get<{ Params: { reworkOrderId: string } }>(
    "/rework-orders/:reworkOrderId/draft-v2",
    async (request) => ReworkOrderResponseSchema.parse(
      await dependencies.service.get(await actor(request), reworkOrderId(request)),
    ),
  );

  app.put<{ Params: { reworkOrderId: string } }>(
    "/rework-orders/:reworkOrderId/draft-v2",
    async (request, reply) => {
      const result = await dependencies.service.save(
        await actor(request),
        reworkOrderId(request),
        SaveReworkV2DraftSchema.parse(request.body),
        String(request.headers["idempotency-key"] ?? ""),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return ReworkOrderResponseSchema.parse(result.value);
    },
  );
}
