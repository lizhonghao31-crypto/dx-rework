import {hasWarehouseReceivingRole} from "@dx-rework/contracts";
import type { PoolClient } from "pg";
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalProductionAccessPolicy, digitalNotFound } from "./access-policy.js";
import { readCockpitFactoryScopes } from "./cockpit-home-facts.js";
import { journeyCutScopes } from "./journey-cut-scopes.js";
import { readJourneyCandidateVisibility } from "./journey-search-metadata.js";

type OrderRow = { production_order_id: string; source_id: string | null; created_by: string; primary_merchandiser_id: string | null };
type ReceiptPo = { lineId: string; poNumber: string | null; color: string; demand: number };
type ReceiptFactory = { productionId: string; factoryDecisionId: string | null };
type ReceiptPoScope = Omit<ReceiptPo, "demand"> & {
  demand: number | null;
  cutIds: string[];
  verifiedWholePo: boolean;
  cutId: string | null;
  factories: ReceiptFactory[];
};

/** Authoritative only while the caller's read-only repeatable snapshot is open. */
export async function readCockpitReceiptScope(
  db: PoolClient, actor: TrustedActorContext, orderId: string,
) {
  const policy = new DigitalProductionAccessPolicy(db);
  const order = (await db.query<OrderRow>(`SELECT production_order_id,source_id,created_by,primary_merchandiser_id
    FROM digital_production_orders WHERE production_order_id=$1`, [orderId])).rows[0];
  if (!order) return digitalNotFound();

  const visibility = await readJourneyCandidateVisibility(policy, actor, { source: null, order });
  if (!visibility.orderAccess) digitalNotFound();
  const scopedWarehouse = !visibility.fullOrder && hasWarehouseReceivingRole(actor.actorRoles)
    && await policy.activeRole(actor.actorId, 'warehouse_receiver')
    && (await db.query<{allowed:boolean}>(`
      SELECT EXISTS(SELECT 1 FROM digital_bulk_dispatch
        WHERE production_order_id=$1 AND warehouse_worker_id=$3)
      OR coalesce((SELECT warehouse_worker_id=$3 FROM digital_preparation_responsibilities
        WHERE resource_kind='order' AND resource_id=$1 OR resource_kind='source' AND resource_id=$2
        ORDER BY (resource_kind='order') DESC,version DESC LIMIT 1),false) AS allowed`,
      [orderId,order.source_id,actor.actorId])).rows[0]?.allowed===true;
  const whole = visibility.fullOrder || scopedWarehouse;
  const lines = (await db.query<ReceiptPo>(`SELECT p.line_id AS "lineId",p.po_number AS "poNumber",p.color,
    coalesce(sum(s.quantity),0)::int AS demand
    FROM digital_production_po_lines p LEFT JOIN digital_production_po_sizes s ON s.line_id=p.line_id
    WHERE p.production_order_id=$1 GROUP BY p.line_id ORDER BY p.position,p.line_id`, [orderId])).rows;
  const cuts = new Map((await journeyCutScopes(db, orderId)).map(scope => [scope.lineId, scope]));
  // A clock used to display historical business facts cannot revive a supplier's former PO access.
  const now = whole ? null : (await db.query<{now:Date}>('SELECT transaction_timestamp() AS now')).rows[0]!.now.toISOString();
  const allocation = now ? (await readCockpitFactoryScopes(db, actor, [{ id: orderId, asOf: now }])).get(orderId) ?? [] : [];

  const scoped: ReceiptPoScope[] = [];
  for (const line of lines) {
    const cut = cuts.get(line.lineId);
    const cutIds = cut?.cuts.filter(item => item.sourceLineId === line.lineId).map(item => item.cuttingOrderId) ?? [];
    const cutId = cut?.status === "verified" ? cut.cuts[0]!.cuttingOrderId : null;
    if (whole) {
      scoped.push({ ...line, cutId, cutIds, verifiedWholePo: true, factories: [] });
      continue;
    }
    const candidates = allocation.filter(row => row.lineId === line.lineId);
    const allowed = candidates.filter(row => row.visible);
    const demand = allowed.reduce((sum, row) => sum + row.quantity, 0);
    if (!allowed.length || demand <= 0) continue;
    // Factory allocation is by PO. It cannot split one PO’s demand between several cuts.
    const quantityProven = cutIds.length === 1 && cutId !== null;
    const verifiedWholePo = quantityProven && allowed.length === candidates.length && demand === line.demand;
    scoped.push({ ...line, demand: quantityProven ? demand : null, cutIds, verifiedWholePo, cutId: verifiedWholePo ? cutId : null,
      factories: allowed.map(({ productionId, factoryDecisionId }) => ({ productionId, factoryDecisionId })) });
  }
  if (!whole && !scoped.length) digitalNotFound();
  return { scope: whole ? "whole" as const : "visible" as const, lines: scoped };
}
