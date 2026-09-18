import {
  CUTTING_CAPABILITY_ROLES,
  canUseCutting,
} from "@dx-rework/contracts";
import type { AuthorizedUser } from "./auth.js";

export const cuttingPageRequirements = CUTTING_CAPABILITY_ROLES["cutting:orders:view"]
  .map((requiredRole) => ({ requiredRole, requiredCapability: "cutting:orders:view" }));

export function canAccessCutting(user: AuthorizedUser): boolean {
  return user.isRoot === true
    || canUseCutting(
      user.businessRoles ?? [],
      user.capabilities,
      "cutting:orders:view",
    );
}
