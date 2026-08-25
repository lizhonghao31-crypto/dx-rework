import type {
  ReworkSupplyContextOptionsResponse,
  ReworkSupplyContextResponse,
  SaveReworkSupplyContext,
} from "@dx-rework/contracts/rework-supply-context";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import { OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";

type DatabaseError = Readonly<{ code?: string }>;
type SupplierSnapshot = Readonly<{ supplierId: string; supplierVersion: number }> | null;
type SupplyContextRow = Readonly<{
  rework_order_id: string;
  washing_supplier_id: string | null;
  washing_supplier_version: number | null;
  embroidery_supplier_id: string | null;
  embroidery_supplier_version: number | null;
  fabric_supplier_id: string | null;
  fabric_supplier_version: number | null;
  embroidery_merchandiser_user_id: string | null;
  version: number;
}>;

type OrderAccessRow = Readonly<{
  created_by: string;
  status: string;
}>;

const sameSupplier = (left: SupplierSnapshot, right: SupplierSnapshot): boolean =>
  left?.supplierId === right?.supplierId
  && left?.supplierVersion === right?.supplierVersion;

const translateDatabaseError = (error: unknown): never => {
  if (error instanceof ApplicationError) throw error;
  const code = (error as DatabaseError | null)?.code;
  if (code === "23503") throw new ApplicationError("NOT_FOUND", "所选供应商或跟单不存在", 404);
  if (code === "23514") throw new ApplicationError("VALIDATION_ERROR", "供应商资料不符合当前返工单状态", 400);
  if (code === "55000") throw new ApplicationError("CONFLICT", "供应商资料不允许绕过受控流程修改", 409);
  throw error;
};

const supplierFromRow = (
  supplierId: string | null,
  supplierVersion: number | null,
): SupplierSnapshot => supplierId && supplierVersion
  ? { supplierId, supplierVersion }
  : null;

export class ReworkSupplyContextService {
  constructor(
    private readonly database: Pool,
    private readonly corporationId: string,
    private readonly events = new OperationEventRepository(),
  ) {}

  async get(
    actor: TrustedActorContext,
    reworkOrderId: string,
  ): Promise<ReworkSupplyContextResponse> {
    this.ensureInitiator(actor);
    await this.ensureOrderAccess(this.database, actor, reworkOrderId, false);
    const result = await this.database.query<SupplyContextRow>(
      `SELECT * FROM rework_order_supply_context WHERE rework_order_id=$1`,
      [reworkOrderId],
    );
    const row = result.rows[0];
    return row ? this.dto(row) : this.empty(reworkOrderId);
  }

  async save(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: SaveReworkSupplyContext,
  ): Promise<ReworkSupplyContextResponse> {
    this.ensureInitiator(actor);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await this.ensureOrderAccess(client, actor, reworkOrderId, true);
      const [washingSupplier, embroiderySupplier, fabricSupplier] = await Promise.all([
        this.resolveSupplier(client, input.washingSupplierId, "embroidery_washing", "洗水厂"),
        this.resolveSupplier(client, input.embroiderySupplierId, "embroidery_washing", "印绣花厂"),
        this.resolveSupplier(client, input.fabricSupplierId, "fabric", "面辅料供应商"),
      ]);
      if (input.embroideryMerchandiserUserId) {
        await this.ensureEmbroideryMerchandiser(client, input.embroideryMerchandiserUserId);
      }

      const existingResult = await client.query<SupplyContextRow>(
        `SELECT * FROM rework_order_supply_context WHERE rework_order_id=$1 FOR UPDATE`,
        [reworkOrderId],
      );
      const existing = existingResult.rows[0];
      const noFacts = !washingSupplier
        && !embroiderySupplier
        && !fabricSupplier
        && !input.embroideryMerchandiserUserId;
      if (!existing && noFacts) {
        await client.query("COMMIT");
        return this.empty(reworkOrderId);
      }

      if (existing) {
        const unchanged = sameSupplier(
          supplierFromRow(existing.washing_supplier_id, existing.washing_supplier_version),
          washingSupplier,
        ) && sameSupplier(
          supplierFromRow(existing.embroidery_supplier_id, existing.embroidery_supplier_version),
          embroiderySupplier,
        ) && sameSupplier(
          supplierFromRow(existing.fabric_supplier_id, existing.fabric_supplier_version),
          fabricSupplier,
        ) && existing.embroidery_merchandiser_user_id === input.embroideryMerchandiserUserId;
        if (unchanged) {
          await client.query("COMMIT");
          return this.dto(existing);
        }
      }

      const nextVersion = existing ? existing.version + 1 : 1;
      const after = {
        reworkOrderId,
        washingSupplier,
        embroiderySupplier,
        fabricSupplier,
        embroideryMerchandiserUserId: input.embroideryMerchandiserUserId,
        version: nextVersion,
      };
      const before = existing ? this.dto(existing) : undefined;
      const eventId = await this.events.append(client, actor, {
        action: "rework.supply_context.save",
        entityType: "rework_order_supply_context",
        entityId: reworkOrderId,
        ...(before ? { before } : {}),
        after,
      });
      await this.setAuditContext(client, eventId, actor.requestId);

      if (existing) {
        await client.query(
          `UPDATE rework_order_supply_context
           SET washing_supplier_id=$2,washing_supplier_version=$3,
               embroidery_supplier_id=$4,embroidery_supplier_version=$5,
               fabric_supplier_id=$6,fabric_supplier_version=$7,
               embroidery_merchandiser_user_id=$8,
               updated_by=$9,version=$10,updated_at=CURRENT_TIMESTAMP
           WHERE rework_order_id=$1`,
          [
            reworkOrderId,
            washingSupplier?.supplierId ?? null,
            washingSupplier?.supplierVersion ?? null,
            embroiderySupplier?.supplierId ?? null,
            embroiderySupplier?.supplierVersion ?? null,
            fabricSupplier?.supplierId ?? null,
            fabricSupplier?.supplierVersion ?? null,
            input.embroideryMerchandiserUserId,
            actor.actorId,
            nextVersion,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO rework_order_supply_context(
             rework_order_id,washing_supplier_id,washing_supplier_version,
             embroidery_supplier_id,embroidery_supplier_version,
             fabric_supplier_id,fabric_supplier_version,
             embroidery_merchandiser_user_id,created_by,updated_by,version
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)`,
          [
            reworkOrderId,
            washingSupplier?.supplierId ?? null,
            washingSupplier?.supplierVersion ?? null,
            embroiderySupplier?.supplierId ?? null,
            embroiderySupplier?.supplierVersion ?? null,
            fabricSupplier?.supplierId ?? null,
            fabricSupplier?.supplierVersion ?? null,
            input.embroideryMerchandiserUserId,
            actor.actorId,
            nextVersion,
          ],
        );
      }

      const saved = await client.query<SupplyContextRow>(
        `SELECT * FROM rework_order_supply_context WHERE rework_order_id=$1`,
        [reworkOrderId],
      );
      await client.query("COMMIT");
      return this.dto(saved.rows[0]!);
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      return translateDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async options(actor: TrustedActorContext): Promise<ReworkSupplyContextOptionsResponse> {
    this.ensureInitiator(actor);
    const [merchandisers, embroideryWashingSuppliers, fabricSuppliers] = await Promise.all([
      this.database.query<{ user_id: string; display_name: string }>(
        `SELECT users.id AS user_id,users.display_name
         FROM app_users users
         JOIN identity_mappings identity ON identity.user_id=users.id
         JOIN access_security_policy policy
           ON policy.policy_key='primary' AND policy.dingtalk_corp_id=identity.corp_id
         JOIN user_role_assignments assignment
           ON assignment.user_id=users.id
          AND assignment.role_code='embroidery_washing_merchandiser'
          AND assignment.revoked_at IS NULL
         WHERE users.enabled=true
           AND identity.provider='dingtalk'
           AND identity.corp_id=$1
           AND identity.active=true
           AND identity.employed=true
         ORDER BY users.display_name,users.id`,
        [this.corporationId],
      ),
      this.supplierOptions("embroidery_washing"),
      this.supplierOptions("fabric"),
    ]);
    return {
      embroideryWashingMerchandisers: merchandisers.rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
      })),
      embroideryWashingSuppliers,
      fabricSuppliers,
    };
  }

  private async supplierOptions(
    supplierType: "embroidery_washing" | "fabric",
  ): Promise<ReworkSupplyContextOptionsResponse["embroideryWashingSuppliers"]> {
    const result = await this.database.query<{
      supplier_id: string;
      version: number;
      supplier_name: string;
    }>(
      `SELECT supplier_id,version,supplier_name
       FROM current_supplier_catalog
       WHERE supplier_type=$1 AND active=true
       ORDER BY supplier_name,supplier_id`,
      [supplierType],
    );
    return result.rows.map((row) => ({
      supplierId: row.supplier_id,
      supplierVersion: row.version,
      supplierName: row.supplier_name,
    }));
  }

  private async resolveSupplier(
    client: PoolClient,
    supplierId: string | null,
    supplierType: "embroidery_washing" | "fabric",
    label: string,
  ): Promise<SupplierSnapshot> {
    if (!supplierId) return null;
    const result = await client.query<{ supplier_id: string; version: number }>(
      `SELECT supplier_id,version
       FROM current_supplier_catalog
       WHERE supplier_id=$1 AND supplier_type=$2 AND active=true`,
      [supplierId, supplierType],
    );
    const supplier = result.rows[0];
    if (!supplier) throw new ApplicationError("NOT_FOUND", `${label}不存在或已停用`, 404);
    return { supplierId: supplier.supplier_id, supplierVersion: supplier.version };
  }

  private async ensureEmbroideryMerchandiser(client: PoolClient, userId: string): Promise<void> {
    const result = await client.query(
      `SELECT 1
       FROM app_users users
       JOIN identity_mappings identity ON identity.user_id=users.id
       JOIN access_security_policy policy
         ON policy.policy_key='primary' AND policy.dingtalk_corp_id=identity.corp_id
       JOIN user_role_assignments assignment
         ON assignment.user_id=users.id
        AND assignment.role_code='embroidery_washing_merchandiser'
        AND assignment.revoked_at IS NULL
       WHERE users.id=$1
         AND users.enabled=true
         AND identity.provider='dingtalk'
         AND identity.corp_id=$2
         AND identity.active=true
         AND identity.employed=true`,
      [userId, this.corporationId],
    );
    if (!result.rows[0]) {
      throw new ApplicationError("NOT_FOUND", "所选印绣花跟单不存在、不在职或角色无效", 404);
    }
  }

  private async ensureOrderAccess(
    client: Pick<PoolClient, "query">,
    actor: TrustedActorContext,
    reworkOrderId: string,
    requireDraft: boolean,
  ): Promise<void> {
    const result = await client.query<OrderAccessRow>(
      `SELECT created_by,status FROM rework_orders
       WHERE rework_order_id=$1 AND status<>'deleted'
       ${requireDraft ? "FOR UPDATE" : ""}`,
      [reworkOrderId],
    );
    const order = result.rows[0];
    if (!order) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    if (!actor.actorRoles.includes("root_superuser") && order.created_by !== actor.actorId) {
      throw new ApplicationError("FORBIDDEN", "只能维护本人发起的返工单供应商资料", 403);
    }
    if (requireDraft && order.status !== "draft") {
      throw new ApplicationError("INVALID_STATE_TRANSITION", "只有草稿可以修改供应商资料", 409);
    }
  }

  private ensureInitiator(actor: TrustedActorContext): void {
    if (
      actor.authorizationCapability !== "rework:initiate"
      || !actor.actorRoles.includes("quality_control")
    ) {
      throw new ApplicationError("FORBIDDEN", "只有品控、老板或超级用户可以维护返工供应商资料", 403);
    }
  }

  private async setAuditContext(client: PoolClient, eventId: string, requestId: string): Promise<void> {
    await client.query(
      `SELECT
         set_config('dx_rework.rework_event_id',$1,true),
         set_config('dx_rework.rework_request_id',$2,true)`,
      [eventId, requestId],
    );
  }

  private empty(reworkOrderId: string): ReworkSupplyContextResponse {
    return {
      reworkOrderId,
      washingSupplier: null,
      embroiderySupplier: null,
      fabricSupplier: null,
      embroideryMerchandiserUserId: null,
      version: null,
    };
  }

  private dto(row: SupplyContextRow): ReworkSupplyContextResponse {
    return {
      reworkOrderId: row.rework_order_id,
      washingSupplier: supplierFromRow(row.washing_supplier_id, row.washing_supplier_version),
      embroiderySupplier: supplierFromRow(row.embroidery_supplier_id, row.embroidery_supplier_version),
      fabricSupplier: supplierFromRow(row.fabric_supplier_id, row.fabric_supplier_version),
      embroideryMerchandiserUserId: row.embroidery_merchandiser_user_id,
      version: row.version,
    };
  }
}
