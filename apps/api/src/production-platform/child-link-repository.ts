import type { PoolClient } from "pg";
import { ApplicationError } from "../platform/errors.js";

export type DigitalChildModule = "sourcing" | "cutting" | "production" | "receiving" | "rework" | "pattern_room";
export type WorkflowGeneration = "legacy" | "digital_production_v1";
/** Internal adapters only: call in the same transaction that creates the real child.
 * No public 'attach arbitrary legacy order' API is exposed. Stable IDs only. */
export async function linkNewDigitalChild(client: PoolClient, input: {
  module: DigitalChildModule; childId: string; productionOrderId: string;
  lines: ReadonlyArray<{ childLineKey: string; lineId: string }>;
}): Promise<void> {
  await client.query("SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE", [input.productionOrderId]);
  await client.query(`INSERT INTO digital_production_child_links(module,child_id,production_order_id) VALUES($1,$2,$3)
    ON CONFLICT(module,child_id) DO NOTHING`, [input.module, input.childId, input.productionOrderId]);
  const resolved = await resolveDigitalChild(client, input.module, input.childId, "digital_production_v1");
  if (resolved !== input.productionOrderId) throw new ApplicationError("DIGITAL_LINK_CONFLICT", "子单已关联其他母单", 409);
  for (const line of input.lines) {
    await client.query(`INSERT INTO digital_production_child_lines(module,child_id,child_line_key,production_order_id,line_id)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(module,child_id,child_line_key) DO NOTHING`, [input.module, input.childId, line.childLineKey, input.productionOrderId, line.lineId]);
    const saved = await client.query("SELECT line_id FROM digital_production_child_lines WHERE module=$1 AND child_id=$2 AND child_line_key=$3", [input.module, input.childId, line.childLineKey]);
    if (saved.rows[0]?.line_id !== line.lineId) throw new ApplicationError("DIGITAL_LINK_CONFLICT", "子单款色映射冲突", 409);
  }
}
export async function resolveDigitalChild(client: Pick<PoolClient, "query">, module: DigitalChildModule, childId: string, generation: WorkflowGeneration): Promise<string | null> {
  const result = await client.query("SELECT production_order_id FROM digital_production_child_links WHERE module=$1 AND child_id=$2", [module, childId]);
  const rootId: string | undefined = result.rows[0]?.production_order_id;
  if (generation === "legacy" && !rootId) return null;
  if (generation === "digital_production_v1" && rootId) return rootId;
  throw new ApplicationError("DIGITAL_LINK_MISSING", "生命周期与来源关联不一致，不能继续办理", 409);
}
