import { hasFinanceWageRole, hasFinanceWageMarkRole } from "@dx-rework/contracts/finance-access";
import type { Pool } from "pg";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";

export type WageAccessCapability = "wage:view" | "wage:export" | "wage:settlement_mark";

export function canAccessFinanceWages(actor: TrustedActorContext, capability: WageAccessCapability): boolean {
  if (actor.actorRoles.includes("root_superuser")) return true;
  const capabilities = actor.authorizationCapabilities ?? [actor.authorizationCapability];
  return hasFinanceWageRole(actor.actorRoles) && capabilities.includes(capability)
    && (capability !== "wage:settlement_mark" || hasFinanceWageMarkRole(actor.actorRoles));
}

export function assertFinanceWageAccess(actor: TrustedActorContext, capability: WageAccessCapability): void {
  if (!canAccessFinanceWages(actor, capability)) {
    throw new ApplicationError("FORBIDDEN", "当前账号无权访问或操作工资管理", 403);
  }
}

export async function requireFinanceWageAccess(db: Pool, actor: TrustedActorContext, capability: WageAccessCapability): Promise<void> {
  assertFinanceWageAccess(actor, capability);
  // Recheck the persisted active roles/grants, including Root, before reading any wages.
  await db.query("SELECT finance_authorized_wage_roles($1,$2)", [actor.actorId, capability]);
}
