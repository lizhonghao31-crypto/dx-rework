import type { PoolClient } from "pg";
import type { FinanceNodeKey } from "@dx-rework/contracts/reporting";
import type { TrustedActorContext } from "../tools/repositories.js";
import { canReadReworkHistoryNode, reworkHistoryNode } from "../rework/rework-node-history.js";

/** History entry IDs are operation-event IDs, never report/review/determination IDs. */
export async function journeyReworkHistoryUrl(db: PoolClient, actor: TrustedActorContext, orderId: string, node: FinanceNodeKey | readonly FinanceNodeKey[], recordId: string, operationEventId: string | null = null): Promise<string | null> {
  const nodes = typeof node === "string" ? [node] : node;
  if (!nodes.some(key => canReadReworkHistoryNode(actor, key))) return null;
  const events = (await db.query<{ event_id: string; action: string }>(`
    SELECT event_id,action FROM operation_events
    WHERE ((entity_type='rework_order' AND entity_id=$1) OR after_state->>'reworkOrderId'=$1)
      AND (event_id=$2::uuid OR after_state->>'orderReviewId'=$3 OR after_state->>'tailInspectionReportId'=$3)
    ORDER BY created_at,event_id`, [orderId, operationEventId, recordId])).rows.filter(event => {
      const key = reworkHistoryNode(event.action);
      return key !== null && nodes.includes(key);
    });
  const event = events.find(event => event.event_id === operationEventId) ?? events.at(-1);
  if (!event) return null;
  const actualNode = reworkHistoryNode(event.action)!;
  if (!canReadReworkHistoryNode(actor, actualNode)) return null;
  return `/ui/tasks/${orderId}?${new URLSearchParams({ node: actualNode, view: "node-history", entryId: event.event_id })}`;
}
