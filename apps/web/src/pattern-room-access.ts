import { PATTERN_ROOM_ORDERS_ENABLED, PATTERN_ORDER_ROLES, canUsePatternOrder } from "@dx-rework/contracts/pattern-orders";
import { PATTERN_PRICE_READ_ROLES, canUsePatternPrice } from "@dx-rework/contracts/pattern-room";
import type { AuthorizedUser } from "./auth.js";

export const patternRoomPriceRequirements = PATTERN_PRICE_READ_ROLES.map(requiredRole => ({ requiredRole, requiredCapability: "pattern_room:prices:read" }));
export function canAccessPatternRoomPrices(user: AuthorizedUser): boolean {
  return user.isRoot === true || canUsePatternPrice(user.businessRoles ?? [], user.capabilities, "pattern_room:prices:read");
}

export const patternRoomOrderRequirements = PATTERN_ORDER_ROLES["pattern_room:orders:view"].map(requiredRole => ({ requiredRole, requiredCapability: "pattern_room:orders:view" }));
export const patternRoomCreateRequirements = (["pattern_room:misc:create"] as const).flatMap(requiredCapability => PATTERN_ORDER_ROLES[requiredCapability].map(requiredRole => ({ requiredRole, requiredCapability })));
export function canAccessPatternRoomOrders(user: AuthorizedUser): boolean {
  return user.isRoot === true || (PATTERN_ROOM_ORDERS_ENABLED && canUsePatternOrder(user.businessRoles ?? [], user.capabilities, "pattern_room:orders:view"));
}
export const canAccessPatternRoom = (user: AuthorizedUser) => canAccessPatternRoomPrices(user) || canAccessPatternRoomOrders(user);

export function canCreatePatternRoomOrders(user: AuthorizedUser): boolean {
  return user.isRoot === true || (PATTERN_ROOM_ORDERS_ENABLED && (["pattern_room:misc:create"] as const).some(capability => canUsePatternOrder(user.businessRoles ?? [], user.capabilities, capability)));
}
