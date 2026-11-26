import type { PoolClient } from "pg";
import { ApplicationError } from "../platform/errors.js";
import { resolveDigitalChild } from "./child-link-repository.js";
import { assertWholeOrderActive } from "./whole-order-visibility.js";

type StyleLine = Readonly<{
  position: number;
  styleNo: string | null;
  alternateStyleNo: string | null;
  changed: boolean;
}>;

function mappingConflict(): never {
  throw new ApplicationError("DIGITAL_LINK_CONFLICT", "原外发与母单的 PO 关联不完整或不一致，请在原单核对后再办理", 409);
}

/** Only the original sourcing revision calls this on its locked transaction.
 * It retains authorization, audit, revision, contract preparation and commit. */
export async function writeSourcingPoStyleRevision(client: PoolClient, input: Readonly<{
  caseId: string;
  workflowGeneration: string | null;
  lines: readonly StyleLine[];
}>): Promise<void> {
  const identity = (await client.query<{ links: boolean; mappings: boolean; orders: boolean; po: boolean }>(`
    SELECT to_regclass('digital_production_child_links') IS NOT NULL AS links,
           to_regclass('digital_production_child_lines') IS NOT NULL AS mappings,
           to_regclass('digital_production_orders') IS NOT NULL AS orders,
           to_regclass('digital_production_po_lines') IS NOT NULL AS po`)).rows[0]!;
  // On the original pre-identity schema a missing generation column and all
  // identity tables is affirmative legacy evidence, not an absent native link.
  if (input.workflowGeneration === null && !Object.values(identity).some(Boolean)) return;
  if (input.workflowGeneration === "legacy") {
    if (identity.links) await resolveDigitalChild(client, "sourcing", input.caseId, "legacy");
    return;
  }
  if (input.workflowGeneration !== "digital_production_v1" || !Object.values(identity).every(Boolean)) mappingConflict();
  const orderId = await resolveDigitalChild(client, "sourcing", input.caseId, input.workflowGeneration);
  if (!orderId) mappingConflict();
  await assertWholeOrderActive(client,"order",orderId);

  const positions = new Set(input.lines.map(line => String(line.position)));
  if (!positions.size || positions.size !== input.lines.length) mappingConflict();
  const rows = (await client.query<{
    child_line_key: string; production_order_id: string; line_id: string; verified_po_id: string | null;
  }>(`SELECT child.child_line_key,child.production_order_id,child.line_id,po.line_id AS verified_po_id
       FROM digital_production_child_lines child LEFT JOIN digital_production_po_lines po
         ON po.production_order_id=child.production_order_id AND po.line_id=child.line_id
       WHERE child.module='sourcing' AND child.child_id=$1`,[input.caseId])).rows;
  if (rows.length !== positions.size) mappingConflict();
  const byPosition = new Map<string,string>();
  const seenPo = new Set<string>();
  for (const row of rows) {
    if (row.production_order_id !== orderId || row.verified_po_id !== row.line_id
      || !positions.has(row.child_line_key) || byPosition.has(row.child_line_key) || seenPo.has(row.line_id)) mappingConflict();
    byPosition.set(row.child_line_key,row.line_id);
    seenPo.add(row.line_id);
  }

  // Keep ascending sourcing position as the original PO write order. A line
  // left unchanged on the form does not materialize a projected alternate no.
  const changed = input.lines.filter(line => line.changed).sort((a,b) => a.position-b.position);
  if (!changed.length) return;
  for (const line of changed) {
    const lineId = byPosition.get(String(line.position));
    if (!lineId) mappingConflict();
    const updated = await client.query(`UPDATE digital_production_po_lines
       SET po_number=$3,formal_style_no=$3,temporary_style_no=$4
       WHERE production_order_id=$1 AND line_id=$2`,[orderId,lineId,line.styleNo,line.alternateStyleNo]);
    if (updated.rowCount !== 1) mappingConflict();
  }
  const mother = await client.query("UPDATE digital_production_orders SET version=version+1 WHERE production_order_id=$1",[orderId]);
  if (mother.rowCount !== 1) mappingConflict();
}
