import type { PoolClient } from "pg";
import type { DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import { appliedVerification } from "./development-material-verification.js";

/** Submitted clerk verification only. Designer arrival, substitutes and saved drafts are not receipts. */
export async function receivedDevelopmentAccessories(db: Pick<PoolClient, "query">, sourceId: string, round: number, document: DevelopmentDocument): Promise<Set<string>> {
  const applied = await appliedVerification(db, sourceId, round, document);
  if (applied) return new Set(applied.filter(row => row.usage === "use" && row.physical
    && !row.invalidatedChecks?.includes("physical") && document.materials.some(m => m.materialId === row.materialId && m.category === "辅料"))
    .map(row => row.materialId));
  if (!(await db.query("SELECT to_regclass('digital_development_execution_facts') AS relation")).rows[0]?.relation) return new Set();
  const facts = (await db.query(`SELECT f.payload FROM digital_development_execution_facts f
    JOIN digital_production_tasks t ON t.task_id=f.task_id
    JOIN digital_production_task_access a ON a.task_id=t.task_id
    WHERE f.source_id=$1 AND a.source_id=$1 AND t.route_version=$2
      AND a.task_kind IN ('development_materials','development_material_recheck')
      AND f.kind IN ('核配通过','缺项退回') ORDER BY f.sequence`, [sourceId, round])).rows;
  const received = new Set<string>();
  for (const fact of facts) for (const row of fact.payload.items ?? []) {
    if (!document.materials.some(m => m.materialId === row.materialId && m.category === "辅料")) continue;
    if (row.physical === true) received.add(row.materialId); else received.delete(row.materialId);
  }
  return received;
}
