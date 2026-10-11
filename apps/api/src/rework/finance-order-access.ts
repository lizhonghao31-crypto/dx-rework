import type { Pool, PoolClient } from "pg";
import type { TrustedActorContext } from "../tools/repositories.js";

export const FINANCE_ORDER_CAPABILITY = "rework:finance_orders:read";

export async function canReadFinanceOrders(database: Pick<Pool | PoolClient, "query">, actor: TrustedActorContext): Promise<boolean> {
  if (!(actor.authorizationCapabilities ?? [actor.authorizationCapability]).includes(FINANCE_ORDER_CAPABILITY)) return false;
  const result=await database.query<{permitted:boolean}>("SELECT rework_finance_can_read_orders($1) permitted",[actor.actorId]);
  return result.rows[0]?.permitted===true;
}

export function isScopedFinanceReader(actor: TrustedActorContext): boolean {
  return actor.actorRoles.length>0&&actor.actorRoles.every(role=>[
    "factory_payables","embroidery_washing_payables","fabric_payables","wage_month_close_accountant",
  ].includes(role));
}

// Shared batch snapshots include whole-order wages and responsibility totals.
// Scoped readers receive their case rows plus basic order provenance only.
export function scopedExternalSource(snapshot: Record<string,unknown>): Record<string,unknown> {
  return {order:snapshot.order??null,qualityControl:snapshot.qualityControl??null};
}
