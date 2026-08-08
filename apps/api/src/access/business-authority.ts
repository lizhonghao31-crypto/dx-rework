import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { RootAuthority } from "./root-authority.js";

export const ROOT_ACTOR_ROLE = "root_superuser";
export const BUSINESS_READ_ALL_CAPABILITY = "business:read_all";

export async function businessActor(
  root: RootAuthority,
  user: AuthUser,
  requestId: string,
  capability: string,
  actingRole?: string,
): Promise<TrustedActorContext> {
  const isRoot = await root.isRootUser(user.id);
  if (!user.businessRoles?.length && !isRoot) {
    throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
  }

  const actorRoles = [...(user.businessRoles ?? [])];
  const authorizationCapabilities = [...user.capabilities];
  if (isRoot) {
    if (!actorRoles.includes(ROOT_ACTOR_ROLE)) actorRoles.push(ROOT_ACTOR_ROLE);
    if (actingRole && !actorRoles.includes(actingRole)) actorRoles.push(actingRole);
    if (!authorizationCapabilities.includes(capability)) {
      authorizationCapabilities.push(capability);
    }
    if (!authorizationCapabilities.includes(BUSINESS_READ_ALL_CAPABILITY)) {
      authorizationCapabilities.push(BUSINESS_READ_ALL_CAPABILITY);
    }
  }

  return {
    actorId: user.id,
    actorRoles,
    authorizationCapability: capability,
    authorizationCapabilities,
    requestId,
  };
}

export function isRootActor(actor: TrustedActorContext): boolean {
  return actor.actorRoles.includes(ROOT_ACTOR_ROLE);
}

export function canReadAllBusiness(actor: TrustedActorContext): boolean {
  const capabilities = actor.authorizationCapabilities ?? [actor.authorizationCapability];
  return isRootActor(actor)
    || (actor.actorRoles.includes("owner_group")
      && capabilities.includes(BUSINESS_READ_ALL_CAPABILITY));
}
