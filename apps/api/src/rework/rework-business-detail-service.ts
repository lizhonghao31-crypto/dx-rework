import type { ReworkOrderStatus } from "@dx-rework/contracts";
import type { Pool } from "pg";

import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";

export type ReworkBusinessDetail = Readonly<{
  reworkOrderId: string;
  reworkNo: string | null;
  status: ReworkOrderStatus;
  styleNo: string | null;
  orderNo: string | null;
  merchandiser: Readonly<{ userId: string; displayName: string }> | null;
  processingFactory: Readonly<{
    type: "own_factory" | "supplier";
    supplierId: string | null;
    displayName: string;
  }> | null;
  problemPart: string | null;
  problemDescription: string | null;
  reworkQuantity: number | null;
  createdBy: Readonly<{ userId: string; displayName: string }>;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}>;

type DetailRow = Readonly<{
  rework_order_id: string;
  rework_no: string | null;
  status: ReworkOrderStatus;
  style_no: string | null;
  order_no: string | null;
  merchandiser_user_id: string | null;
  merchandiser_name: string | null;
  processing_factory_type: "own_factory" | "supplier" | null;
  processing_factory_supplier_id: string | null;
  supplier_name: string | null;
  problem_part: string | null;
  problem_description: string | null;
  rework_quantity: string | null;
  created_by: string;
  creator_name: string;
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
}>;

const broadBusinessReader = (actor: TrustedActorContext): boolean =>
  actor.actorRoles.some((role) => [
    "root_superuser",
    "owner_group",
    "production_management",
    "tail_supervisor",
  ].includes(role));

export class ReworkBusinessDetailService {
  constructor(private readonly database: Pool) {}

  async get(actor: TrustedActorContext, reworkOrderId: string): Promise<ReworkBusinessDetail> {
    const result = await this.database.query<DetailRow>(
      `SELECT
         orders.rework_order_id,orders.rework_no,orders.status,orders.style_no,orders.order_no,
         orders.merchandiser_user_id,merchandiser.display_name merchandiser_name,
         orders.processing_factory_type,orders.processing_factory_supplier_id,
         supplier.supplier_name,orders.problem_part,orders.problem_description,
         orders.rework_quantity::text,orders.created_by,creator.display_name creator_name,
         orders.created_at,orders.updated_at,orders.submitted_at,orders.cancelled_at,orders.cancel_reason
       FROM rework_orders orders
       JOIN app_users creator ON creator.id=orders.created_by
       LEFT JOIN app_users merchandiser ON merchandiser.id=orders.merchandiser_user_id
       LEFT JOIN supplier_catalog_versions supplier
         ON supplier.supplier_id=orders.processing_factory_supplier_id
        AND supplier.version=orders.processing_factory_supplier_version
       WHERE orders.rework_order_id=$1`,
      [reworkOrderId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    if (!(await this.canView(actor, row))) {
      throw new ApplicationError("FORBIDDEN", "当前用户与该返工单无业务查看关系", 403);
    }

    return {
      reworkOrderId: row.rework_order_id,
      reworkNo: row.rework_no,
      status: row.status,
      styleNo: row.style_no,
      orderNo: row.order_no,
      merchandiser: row.merchandiser_user_id && row.merchandiser_name
        ? { userId: row.merchandiser_user_id, displayName: row.merchandiser_name }
        : null,
      processingFactory: row.processing_factory_type === "own_factory"
        ? { type: "own_factory", supplierId: null, displayName: "本厂" }
        : row.processing_factory_type === "supplier"
          ? {
              type: "supplier",
              supplierId: row.processing_factory_supplier_id,
              displayName: row.supplier_name ?? "加工厂资料已变更",
            }
          : null,
      problemPart: row.problem_part,
      problemDescription: row.problem_description,
      reworkQuantity: row.rework_quantity === null ? null : Number(row.rework_quantity),
      createdBy: { userId: row.created_by, displayName: row.creator_name },
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      submittedAt: row.submitted_at?.toISOString() ?? null,
      cancelledAt: row.cancelled_at?.toISOString() ?? null,
      cancelReason: row.cancel_reason,
    };
  }

  private async canView(actor: TrustedActorContext, row: DetailRow): Promise<boolean> {
    if (broadBusinessReader(actor)) return true;
    if (row.created_by === actor.actorId || row.merchandiser_user_id === actor.actorId) return true;

    if (actor.actorRoles.includes("ie_reviewer")) {
      const configuration = await this.database.query(
        "SELECT 1 FROM rework_process_configurations WHERE rework_order_id=$1 LIMIT 1",
        [row.rework_order_id],
      );
      if (configuration.rows[0]) return true;
    }

    if (actor.actorRoles.includes("worker")) {
      const assignment = await this.database.query(
        `SELECT 1
         FROM business_people person
         JOIN rework_work_task_members member ON member.person_id=person.person_id
         JOIN rework_work_tasks task ON task.work_task_id=member.work_task_id
         WHERE person.app_user_id=$1 AND task.rework_order_id=$2
         LIMIT 1`,
        [actor.actorId, row.rework_order_id],
      );
      if (assignment.rows[0]) return true;
    }

    if (actor.actorRoles.some((role) => [
      "embroidery_washing_merchandiser",
      "factory_payables",
      "embroidery_washing_payables",
      "fabric_payables",
    ].includes(role))) {
      const external = await this.database.query(
        `SELECT 1
         FROM rework_external_responsibility_cases target_case
         WHERE target_case.rework_order_id=$2
           AND external_responsibility_can_view_case(
             $1,target_case.rework_order_id,target_case.responsibility_type
           )
         LIMIT 1`,
        [actor.actorId, row.rework_order_id],
      );
      if (external.rows[0]) return true;
    }

    if (actor.actorRoles.some((role) => [
      "administrative_clerk",
      "wage_month_close_accountant",
      "finance_read",
    ].includes(role))) {
      const wage = await this.database.query(
        "SELECT 1 FROM rework_wage_items WHERE rework_order_id=$1 LIMIT 1",
        [row.rework_order_id],
      );
      if (wage.rows[0]) return true;
    }

    return false;
  }
}
