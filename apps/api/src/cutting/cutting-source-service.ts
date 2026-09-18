import { randomUUID } from "node:crypto";

import type { CuttingSourceListResponse } from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";

const VIEW_CAPABILITY = "cutting:orders:view";
const ROOT_ROLE = "root_superuser";
const VIEW_ROLES = new Set([
  "cutting_supervisor",
  "cutting_worker",
  "owner_group",
  "production_management",
  "order_merchandiser",
]);
const BROAD_VIEW_ROLES = new Set([
  ROOT_ROLE,
  "cutting_supervisor",
  "cutting_worker",
  "owner_group",
  "production_management",
]);

const fail = (message: string, statusCode = 409, code = "INVALID_STATE_TRANSITION"): never => {
  throw new ApplicationError(code, message, statusCode);
};

export async function ensureCuttingOrdersForApproval(
  client: PoolClient,
  sourcingCaseId: string,
  approvalSnapshotId: string,
): Promise<void> {
  const approvedLines = await client.query<{ position: number }>(
    `SELECT line.position
     FROM sourcing_approval_snapshots snapshot
     JOIN sourcing_approval_snapshot_lines line
       ON line.sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id
     WHERE snapshot.sourcing_approval_snapshot_id=$1
       AND snapshot.sourcing_case_id=$2
     ORDER BY line.position`,
    [approvalSnapshotId, sourcingCaseId],
  );
  if (approvedLines.rowCount === 0) {
    fail("批准快照没有可生成的裁床款明细");
  }

  for (const line of approvedLines.rows) {
    await client.query(
      `INSERT INTO cutting_orders(
         cutting_order_id,sourcing_case_id,sourcing_line_position,approval_snapshot_id
       ) VALUES($1,$2,$3,$4)
       ON CONFLICT(sourcing_case_id,sourcing_line_position) DO NOTHING`,
      [randomUUID(), sourcingCaseId, line.position, approvalSnapshotId],
    );
  }

  const positions = approvedLines.rows.map((line) => line.position);
  const persisted = await client.query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM cutting_orders
     WHERE sourcing_case_id=$1
       AND sourcing_line_position=ANY($2::integer[])`,
    [sourcingCaseId, positions],
  );
  if (persisted.rows[0]?.count !== positions.length) {
    fail("裁床源单未能完整建立");
  }
}

type CuttingSourceRow = {
  cutting_order_id: string;
  sourcing_case_id: string;
  sourcing_line_position: number;
  formal_style_no: string | null;
  alternate_style_no: string | null;
  display_style_no: string;
  style_name_snapshot: string | null;
  gender: "男装" | "女装" | null;
  color: string | null;
  contract_quantity: number;
  supplier_id: string;
  supplier_name: string;
  merchandiser_id: string;
  merchandiser_name: string;
  delivery_date: string | null;
  cutting_process: "in_house" | "outsourced" | "other" | null;
  cutting_process_other: string | null;
  approved_at: Date | string;
};

export class CuttingSourceService {
  constructor(private readonly database: Pool) {}

  private assertReader(actor: TrustedActorContext): void {
    if (actor.actorRoles.includes(ROOT_ROLE)) return;
    if (
      actor.authorizationCapability !== VIEW_CAPABILITY
      || !actor.actorRoles.some((role) => VIEW_ROLES.has(role))
    ) {
      throw new ApplicationError("FORBIDDEN", "无权查看裁床实裁数据", 403);
    }
  }

  async listSources(actor: TrustedActorContext): Promise<CuttingSourceListResponse> {
    this.assertReader(actor);
    const hasBroadScope = actor.actorRoles.some((role) => BROAD_VIEW_ROLES.has(role));
    const merchandiserOnly = !hasBroadScope && actor.actorRoles.includes("order_merchandiser");
    const result = await this.database.query<CuttingSourceRow>(
      `SELECT cutting.cutting_order_id,cutting.sourcing_case_id,
              cutting.sourcing_line_position,
              source_line.formal_style_no,source_line.alternate_style_no,
              source_line.style_no AS display_style_no,
              source_case.style_name_snapshot,source_case.gender,source_line.color,
              source_line.quantity AS contract_quantity,
              COALESCE(current_decision.supplier_id,snapshot.supplier_id) AS supplier_id,
              COALESCE(current_decision.supplier_name_snapshot,snapshot.supplier_name_snapshot) AS supplier_name,
              source_case.created_by AS merchandiser_id,creator.display_name AS merchandiser_name,
              to_char(source_case.delivery_date,'YYYY-MM-DD') AS delivery_date,
              current_decision.cutting_process,current_decision.cutting_process_other,
              snapshot.approved_at
       FROM cutting_orders cutting
       JOIN sourcing_cases source_case
         ON source_case.sourcing_case_id=cutting.sourcing_case_id
        AND source_case.deleted_at IS NULL
       JOIN current_sourcing_case_lines source_line
         ON source_line.sourcing_case_id=cutting.sourcing_case_id
        AND source_line.position=cutting.sourcing_line_position
       JOIN sourcing_approval_snapshots snapshot
         ON snapshot.sourcing_approval_snapshot_id=cutting.approval_snapshot_id
       JOIN app_users creator ON creator.id=source_case.created_by
       LEFT JOIN LATERAL (
         SELECT decision.supplier_id,decision.supplier_name_snapshot,
                decision.cutting_process,decision.cutting_process_other
         FROM sourcing_decisions decision
         WHERE decision.sourcing_case_id=cutting.sourcing_case_id
         ORDER BY decision.decision_version DESC
         LIMIT 1
       ) current_decision ON true
       WHERE ($1::boolean=false OR source_case.created_by=$2::uuid)
       ORDER BY snapshot.approved_at ASC,cutting.sourcing_case_id,cutting.sourcing_line_position`,
      [merchandiserOnly, actor.actorId],
    );

    return {
      items: result.rows.map((row) => ({
        cuttingOrderId: row.cutting_order_id,
        sourcingCaseId: row.sourcing_case_id,
        sourcePosition: Number(row.sourcing_line_position),
        formalStyleNo: row.formal_style_no,
        alternateStyleNo: row.alternate_style_no,
        displayStyleNo: row.display_style_no,
        styleName: row.style_name_snapshot,
        gender: row.gender,
        color: row.color,
        contractQuantity: Number(row.contract_quantity),
        supplierId: row.supplier_id,
        supplierName: row.supplier_name,
        merchandiserId: row.merchandiser_id,
        merchandiserName: row.merchandiser_name,
        deliveryDate: row.delivery_date,
        cuttingProcess: row.cutting_process,
        cuttingProcessOther: row.cutting_process_other,
        approvedAt: row.approved_at instanceof Date
          ? row.approved_at.toISOString()
          : new Date(row.approved_at).toISOString(),
      })),
    };
  }
}
