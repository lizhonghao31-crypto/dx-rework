import type { PoolClient } from "pg";
import { slaParameterKey } from "./sla-policy-values.js";

/** Bind pending as well as active tasks to their order/source standard; a default edit is not an application. */
export async function frozenSlaTaskPolicy(client: Pick<PoolClient, "query">, taskId: string, nodeKey: string) {
  if (!(await client.query("SELECT to_regclass('digital_sla_configurations') AS relation")).rows[0]?.relation) return null;
  const task = (await client.query(`SELECT t.created_at,a.production_order_id,a.source_id,
    COALESCE(o.created_at,s.created_at,t.created_at) AS resource_created_at FROM digital_production_tasks t
    JOIN digital_production_task_access a USING(task_id)
    LEFT JOIN production_order_roots o ON o.production_order_id=a.production_order_id
    LEFT JOIN digital_production_sources s ON s.source_id=a.source_id WHERE t.task_id=$1`, [taskId])).rows[0];
  if (!task) return null;
  const evaluated = (await client.query(`SELECT p.* FROM digital_production_deadline_revisions r
    JOIN digital_production_deadline_policies p ON p.node_key=r.policy_node_key AND p.version=r.policy_version
    WHERE r.task_id=$1 ORDER BY r.revision_id DESC LIMIT 1`, [taskId])).rows[0];
  if (evaluated) return evaluated;
  let config;
  if (task.production_order_id) {
    config = (await client.query(`SELECT c.* FROM digital_sla_order_snapshots s JOIN digital_sla_configurations c USING(configuration_id)
      WHERE s.production_order_id=$1 ORDER BY s.revision DESC LIMIT 1`, [task.production_order_id])).rows[0];
  } else if (task.source_id && (await client.query("SELECT to_regclass('digital_development_sla_plans') AS relation")).rows[0]?.relation) {
    config = (await client.query(`SELECT c.* FROM digital_development_sla_plans s JOIN digital_sla_configurations c USING(configuration_id)
      WHERE s.source_id=$1 ORDER BY s.revision DESC LIMIT 1`, [task.source_id])).rows[0];
  }
  const reference = config?.policy_refs_json?.policies[slaParameterKey(nodeKey)] ?? null;
  if (reference) {
    const row = (await client.query("SELECT * FROM digital_production_deadline_policies WHERE node_key=$1 AND version=$2", [reference.nodeKey, reference.version])).rows[0];
    if (!row) throw new Error("Frozen SLA task policy is missing");
    return row;
  }
  // Legacy tasks retain their evaluated version, or the policy at creation if they have not started.
  return (await client.query(`SELECT * FROM digital_production_deadline_policies WHERE node_key=$1 AND changed_at<=$2
    ORDER BY version DESC LIMIT 1`, [nodeKey, task.resource_created_at])).rows[0]
    ?? (await client.query("SELECT * FROM digital_production_deadline_policies WHERE node_key=$1 ORDER BY version LIMIT 1", [nodeKey])).rows[0] ?? null;
}
