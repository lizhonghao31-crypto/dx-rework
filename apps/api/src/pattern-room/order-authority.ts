import { canUsePatternOrder, type PatternOrderCapability } from "@dx-rework/contracts/pattern-orders";
import { ApplicationError } from "../platform/errors.js";
import type { SqlClient, TrustedActorContext } from "../tools/repositories.js";

export const patternActorCapabilities = (actor: TrustedActorContext) => actor.authorizationCapabilities ?? [actor.authorizationCapability];
export const isPatternRoot = (actor: TrustedActorContext) => actor.actorRoles.includes("root_superuser");
export const canReadAllPatternOrders = (actor: TrustedActorContext) => actor.actorRoles.some(role => ["root_superuser", "pattern_room_supervisor", "owner_group", "production_management"].includes(role));
export async function authorizePatternOrder(db: SqlClient, actor: TrustedActorContext, capability: PatternOrderCapability, enabled: boolean): Promise<TrustedActorContext> {
  if (!canUsePatternOrder(actor.actorRoles, patternActorCapabilities(actor), capability)) throw new ApplicationError("FORBIDDEN", "当前账号无权执行此打板操作", 403);
  let roles: string[] | undefined;
  try { roles = (await db.query<{ roles: string[] }>("SELECT pattern_room_authorized_order_roles($1,$2) roles", [actor.actorId, capability])).rows[0]?.roles; }
  catch (error) {
    if ((error as { code?: string }).code === "42501") throw new ApplicationError("FORBIDDEN", "当前账号的打板权限已失效", 403);
    throw error;
  }
  if (!roles?.length) throw new ApplicationError("FORBIDDEN", "无法确认当前有效身份", 403);
  // Scope and action visibility use persisted roles, not a stale caller's broader snapshot.
  const effective = { ...actor, actorRoles: roles, authorizationCapability: capability };
  if (!enabled && !isPatternRoot(effective)) throw new ApplicationError("FEATURE_NOT_AVAILABLE", "订单打板尚未开放", 503);
  return effective;
}

/** Parameters are always [actorId, broadReader, isDesigner, isWorker]. */
export const patternOrderScopeSql = `( $2::boolean
  OR ($3::boolean AND orders.created_by=$1::uuid)
  OR ($4::boolean AND EXISTS(SELECT 1 FROM pattern_room_rounds scope_round
    JOIN pattern_room_segments scope_segment ON scope_segment.round_id=scope_round.round_id
    WHERE scope_round.round_id=orders.current_round_id AND scope_segment.worker_user_id=$1::uuid
      AND NOT EXISTS(SELECT 1 FROM pattern_room_segments newer_segment
        WHERE newer_segment.round_id=scope_segment.round_id AND newer_segment.segment_index>scope_segment.segment_index))) )`;
export const patternOrderScopeValues = (actor: TrustedActorContext) => [actor.actorId, canReadAllPatternOrders(actor), actor.actorRoles.includes("sample_designer"), actor.actorRoles.includes("worker")];
