import {slaApplications,appliedSlaWindow} from './sla-applied-window.js';
import {validateDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import type { PoolClient } from "pg";
import type { SlaNodeFact } from "@dx-rework/domain/digital-sla-plan";
import { validateBusinessTime } from "@dx-rework/domain/business-clock";
import type { StoredSlaPlan } from "./sla-plan-repository.js";

/** Creation proves the sheet start, not its completion. Retain a legacy completion
 * until that node has its own native-business adapter; never erase it with a start-only fact. */
export function applyOrderCreationEvidence(facts: Record<string, SlaNodeFact>, creation: Record<string, SlaNodeFact>) {
  const result = { ...facts, ...creation };
  if (facts.production_sheet && creation.production_sheet) result.production_sheet = {
    ...facts.production_sheet, ...creation.production_sheet,
    evidence: `${facts.production_sheet.evidence};${creation.production_sheet.evidence}`,
  };
  return result;
}

/** Read original business records; do not duplicate their actual timestamps in an SLA ledger. */
export async function orderCreationSlaEvidence(client: Pick<PoolClient, "query">, orderId: string, original: StoredSlaPlan): Promise<Record<string, SlaNodeFact>> {
  const anchor = original.plan.anchors.customer_order_confirmed;
  const source = anchor && anchor.precision !== "unknown" ? anchor.source : undefined;
  const eventId = source?.startsWith("audit_events:") ? source.slice("audit_events:".length) : null;
  if (!eventId) return {};
  const event = (await client.query("SELECT id,after_state FROM audit_events WHERE id=$1 AND entity_id=$2 AND action='digital_order_created'", [eventId, orderId])).rows[0];
  // Older publications did not store business time on the audit event. Keep their legacy read path,
  // rather than treating the audit recording time or a reconstructed plan as an actual timestamp.
  if (!event?.after_state?.slaBusinessTime) return {};
  const time = validateBusinessTime(event.after_state.slaBusinessTime);
  if (time.scenarioId !== original.time.scenarioId) throw new Error("Creation event SLA clock scope mismatch");
  const evidence = `audit_events:${event.id}`;
  let minutes = original.plan.nodes.find(n => n.id === "production_sheet")?.minutes;
  const saved=(await client.query('SELECT * FROM digital_sla_order_snapshots WHERE snapshot_id=$1',[original.snapshotId])).rows[0];
  if(saved){const applied=appliedSlaWindow(validateDigitalSlaSnapshot({ruleVersion:saved.rule_version,parameters:saved.parameters_json}),'production_sheet','node:production_sheet',await slaApplications(client,orderId));const value=applied.snapshot.parameters.production_sheet!.value;if(value.kind==='duration')minutes=value.minutes;}

  return {
    order_creation: { completedAt: time.now, evidence },
    customer_confirmation: { completedAt: time.now, evidence },
    production_sheet: { startedAt: time.now, evidence, ...(minutes !== null && minutes !== undefined ? { standardMinutes: minutes } : {}) },
  };
}
