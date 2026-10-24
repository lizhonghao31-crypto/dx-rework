import type {PoolClient} from "pg";
import {validateDigitalSlaSnapshot} from "@dx-rework/contracts/digital-sla";

const parameters:Record<string,string>={sourcing_ie_quote:"sourcing_ie",sourcing_management_decision:"sourcing_selection",sourcing_owner_approval:"sourcing_approval"};
/** Reuse the original approval todo, business transition and mother-order snapshot.
 * undefined keeps unenrolled legacy behavior; a null date preserves genuinely unknown timing.
 * Called only for creation, after the original todo deduplication check. */
export async function sourcingTodoSla(client:Pick<PoolClient,"query">,input:{category:string;entityType:string;entityId:string;sourceEventId:string}) {
  const parameter=parameters[input.category];
  if(!parameter||input.entityType!=="sourcing_case")return undefined;
  if(!(await client.query("SELECT to_regclass('digital_sla_order_snapshots') AS relation")).rows[0]?.relation)return undefined;
  const row=(await client.query(`SELECT s.rule_version,s.parameters_json,s.snapshot_id,l.production_order_id FROM digital_production_child_links l
    JOIN LATERAL(SELECT * FROM digital_sla_order_snapshots s WHERE s.production_order_id=l.production_order_id ORDER BY revision DESC LIMIT 1)s ON true
    WHERE l.module='sourcing' AND l.child_id=$1`,[input.entityId])).rows[0];
  if(!row)return undefined;
  // A return/reassignment can create another original todo, but does not grant a
  // fresh responsibility window. Preserve the first captured deadline, even null.
  const previous=(await client.query(`SELECT t.due_at,original.snapshot_id FROM rework_todos t
    LEFT JOIN operation_events e ON e.event_id=t.created_operation_event_id
      AND e.action='todo.create' AND e.entity_type='rework_todo' AND e.entity_id=t.todo_id::text
    LEFT JOIN digital_sla_order_snapshots original ON original.snapshot_id::text=e.after_state->'slaTiming'->>'snapshotId'
      AND original.production_order_id=$3
    WHERE t.entity_type='sourcing_case' AND t.entity_id=$1 AND t.category=$2 AND t.todo_type='business_action'
    ORDER BY t.created_at,t.todo_id LIMIT 1`,[input.entityId,input.category,row.production_order_id])).rows[0];
  if(previous)return {dueAt:previous.due_at===null?null:new Date(previous.due_at),snapshotId:(previous.snapshot_id??null) as string|null};
  const value=validateDigitalSlaSnapshot({ruleVersion:row.rule_version,parameters:row.parameters_json}).parameters[parameter]?.value;
  if(value?.kind!=="duration")throw new Error("Frozen sourcing SLA duration missing");
  const transition=(await client.query(`SELECT transitioned_at FROM sourcing_case_transitions
    WHERE sourcing_case_id=$1 AND operation_event_id=$2 ORDER BY sequence DESC LIMIT 1`,[input.entityId,input.sourceEventId])).rows[0];
  return {dueAt:transition?new Date(new Date(transition.transitioned_at).getTime()+value.minutes*60000):null,snapshotId:row.snapshot_id as string};
}
