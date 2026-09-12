import { PATTERN_PRICE_READ_ROLES, canUsePatternPrice } from "@dx-rework/contracts/pattern-room";
import type { AuthorizedUser } from "./auth.js";

export const patternRoomPriceRequirements = PATTERN_PRICE_READ_ROLES.map(requiredRole => ({ requiredRole, requiredCapability: "pattern_room:prices:read" }));
export function canAccessPatternRoomPrices(user: AuthorizedUser): boolean {
  return user.isRoot === true || canUsePatternPrice(user.businessRoles ?? [], user.capabilities, "pattern_room:prices:read");
}
