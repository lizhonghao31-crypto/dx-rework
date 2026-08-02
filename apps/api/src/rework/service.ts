import { createHash, randomUUID } from "node:crypto";

import type {
  CreateReworkDraft,
  ReworkInitiationOptionsResponse,
  ReworkOrderResponse,
  ReworkOrderStatus,
  SubmitReworkOrder,
  TransitionReworkOrder,
  UpdateReworkDraft,
} from "@dx-rework/contracts";
import { DomainRuleError, transitionReworkOrder } from "@dx-rework/domain";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  MessageOutboxRepository,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";

type DatabaseError = Readonly<{ code?: string }>;
type FactoryState = Readonly<{
  type: "own_factory" | "supplier";
  supplierId: string | null;
  supplierVersion: number | null;
}> | null;
type ReworkOrderRow = Readonly<{
  rework_order_id: string;
  rework_no: string | null;
  status: ReworkOrderStatus;
  style_no: string | null;
  order_no: string | null;
  merchandiser_user_id: string | null;
  processing_factory_type: "own_factory" | "supplier" | null;
  processing_factory_supplier_id: string | null;
  processing_factory_supplier_version: number | null;
  problem_part: string | null;
  problem_description: string | null;
  rework_quantity: number | null;
  created_by: string;
  updated_by: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  has_other_open_style_order: boolean;
}>;
type MutationResult<T> = Readonly<{ value: T; reused: boolean }>;

const ORDER_SELECT = `SELECT orders.*,
  EXISTS (
    SELECT 1
    FROM rework_orders other
    WHERE other.rework_order_id<>orders.rework_order_id
      AND other.style_no=orders.style_no
      AND other.status<>'cancelled'
  ) AS has_other_open_style_order
FROM rework_orders orders`;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
};

const requestHash = (scope: string, payload: unknown): string =>
  createHash("sha256").update(JSON.stringify(canonicalize({ scope, payload }))).digest("hex");

const translateDatabaseError = (error: unknown): never => {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof DomainRuleError) {
    throw new ApplicationError("INVALID_STATE_TRANSITION", "返工单当前状态不允许该操作", 409);
  }
  const code = (error as DatabaseError | null)?.code;
  if (code === "23505") throw new ApplicationError("CONFLICT", "返工单号或幂等记录已存在", 409);
  if (code === "23503") throw new ApplicationError("NOT_FOUND", "引用的跟单、加工厂或附件不存在", 404);
  if (code === "42501") throw new ApplicationError("FORBIDDEN", "当前用户无权执行该操作", 403);
  if (code === "55000") throw new ApplicationError("CONFLICT", "返工单不允许绕过受控流程修改", 409);
  if (code === "23514" || code === "22P02") {
    throw new ApplicationError("VALIDATION_ERROR", "返工单数据或状态不符合业务约束", 400);
  }
  throw error;
};

const factoryFromRow = (row: ReworkOrderRow): FactoryState => {
  if (row.processing_factory_type === null) return null;
  if (row.processing_factory_type === "own_factory") {
    return { type: "own_factory", supplierId: null, supplierVersion: null };
  }
  return {
    type: "supplier",
    supplierId: row.processing_factory_supplier_id,
    supplierVersion: row.processing_factory_supplier_version,
  };
};

export class ReworkInitiationService {
  constructor(
    private readonly database: Pool,
    private readonly corporationId: string,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
    private readonly outbox = new MessageOutboxRepository(),
  ) {}

  async createDraft(
    actor: TrustedActorContext,
    input: CreateReworkDraft,
    idempotencyKey: string,
  ): Promise<MutationResult<ReworkOrderResponse>> {
    return this.mutate(actor, "rework.draft.create", idempotencyKey, input, 201, async (client) => {
      const reworkOrderId = randomUUID();
      const factory = await this.resolveFactory(client, input.processingFactory ?? null);
      if (input.merchandiserUserId) {
        await this.ensureActiveMerchandiser(client, input.merchandiserUserId);
      }
      const attachmentIds = input.attachmentIds ?? [];
      const next = {
        reworkOrderId,
        reworkNo: null,
        status: "draft" as const,
        styleNo: input.styleNo ?? null,
        orderNo: input.orderNo ?? null,
        merchandiserUserId: input.merchandiserUserId ?? null,
        processingFactory: factory,
        problemPart: input.problemPart ?? null,
        problemDescription: input.problemDescription ?? null,
        reworkQuantity: input.reworkQuantity ?? null,
        attachmentIds,
        version: 1,
      };
      const eventId = await this.events.append(client, actor, {
        action: "rework.draft.create",
        entityType: "rework_order",
        entityId: reworkOrderId,
        after: next,
      });
      await this.setAuditContext(client, eventId, actor.requestId);
      await client.query(
        `INSERT INTO rework_orders(
           rework_order_id,style_no,order_no,merchandiser_user_id,
           processing_factory_type,processing_factory_supplier_id,
           processing_factory_supplier_version,problem_part,problem_description,
           rework_quantity,created_by,updated_by
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
        [
          reworkOrderId,
          next.styleNo,
          next.orderNo,
          next.merchandiserUserId,
          factory?.type ?? null,
          factory?.supplierId ?? null,
          factory?.supplierVersion ?? null,
          next.problemPart,
          next.problemDescription,
          next.reworkQuantity,
          actor.actorId,
        ],
      );
      await this.syncAttachments(client, actor.actorId, reworkOrderId, attachmentIds);
      return this.getOwnedWithClient(client, actor.actorId, reworkOrderId);
    });
  }

  async updateDraft(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: UpdateReworkDraft,
    idempotencyKey: string,
  ): Promise<MutationResult<ReworkOrderResponse>> {
    return this.mutate(actor, "rework.draft.update", idempotencyKey, { reworkOrderId, ...input }, 200, async (client) => {
      const current = await this.lockOwned(client, actor.actorId, reworkOrderId);
      this.ensureVersion(current, input.expectedVersion);
      transitionReworkOrder(current.status, "draft");
      if (current.status !== "draft") {
        throw new ApplicationError("INVALID_STATE_TRANSITION", "只有草稿可以修改", 409);
      }

      const existingAttachmentIds = await this.attachmentIds(client, reworkOrderId);
      const attachmentIds = input.attachmentIds ?? existingAttachmentIds;
      const merchandiserUserId = input.merchandiserUserId === undefined
        ? current.merchandiser_user_id
        : input.merchandiserUserId;
      if (merchandiserUserId) await this.ensureActiveMerchandiser(client, merchandiserUserId);
      const factory = input.processingFactory === undefined
        ? factoryFromRow(current)
        : await this.resolveFactory(client, input.processingFactory);
      const nextVersion = current.version + 1;
      const next = {
        reworkOrderId,
        reworkNo: current.rework_no,
        status: "draft" as const,
        styleNo: input.styleNo === undefined ? current.style_no : input.styleNo,
        orderNo: input.orderNo === undefined ? current.order_no : input.orderNo,
        merchandiserUserId,
        processingFactory: factory,
        problemPart: input.problemPart === undefined ? current.problem_part : input.problemPart,
        problemDescription: input.problemDescription === undefined
          ? current.problem_description
          : input.problemDescription,
        reworkQuantity: input.reworkQuantity === undefined
          ? current.rework_quantity
          : input.reworkQuantity,
        attachmentIds,
        version: nextVersion,
      };
      const eventId = await this.events.append(client, actor, {
        action: "rework.draft.update",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before: await this.auditState(client, current),
        after: next,
      });
      await this.setAuditContext(client, eventId, actor.requestId);
      await client.query(
        `UPDATE rework_orders
         SET style_no=$2,order_no=$3,merchandiser_user_id=$4,
             processing_factory_type=$5,processing_factory_supplier_id=$6,
             processing_factory_supplier_version=$7,problem_part=$8,
             problem_description=$9,rework_quantity=$10,updated_by=$11,
             version=$12,updated_at=CURRENT_TIMESTAMP
         WHERE rework_order_id=$1`,
        [
          reworkOrderId,
          next.styleNo,
          next.orderNo,
          next.merchandiserUserId,
          factory?.type ?? null,
          factory?.supplierId ?? null,
          factory?.supplierVersion ?? null,
          next.problemPart,
          next.problemDescription,
          next.reworkQuantity,
          actor.actorId,
          nextVersion,
        ],
      );
      if (input.attachmentIds !== undefined) {
        await this.syncAttachments(client, actor.actorId, reworkOrderId, attachmentIds);
      }
      return this.getOwnedWithClient(client, actor.actorId, reworkOrderId);
    });
  }

  async submit(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: SubmitReworkOrder,
    idempotencyKey: string,
  ): Promise<MutationResult<ReworkOrderResponse>> {
    return this.mutate(actor, "rework.submit", idempotencyKey, { reworkOrderId, ...input }, 200, async (client) => {
      const current = await this.lockOwned(client, actor.actorId, reworkOrderId);
      this.ensureVersion(current, input.expectedVersion);
      transitionReworkOrder(current.status, "pending_process_configuration");
      this.ensureComplete(current);
      await this.ensureActiveMerchandiser(client, current.merchandiser_user_id!);
      await this.ensureFactoryStillAvailable(client, factoryFromRow(current)!);
      const attachmentIds = await this.attachmentIds(client, reworkOrderId);
      await this.ensureReadyBoundAttachments(client, actor.actorId, reworkOrderId, attachmentIds);
      const numberResult = current.rework_no
        ? { rows: [{ rework_no: current.rework_no }] }
        : await client.query<{ rework_no: string }>("SELECT next_rework_order_number() AS rework_no");
      const reworkNo = numberResult.rows[0]!.rework_no;
      const nextVersion = current.version + 1;
      const after = {
        ...(await this.auditState(client, current)),
        reworkNo,
        status: "pending_process_configuration" as const,
        version: nextVersion,
        attachmentIds,
      };
      const eventId = await this.events.append(client, actor, {
        action: "rework.submit",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before: await this.auditState(client, current),
        after,
      });
      await this.setAuditContext(client, eventId, actor.requestId);
      await client.query(
        `UPDATE rework_orders
         SET rework_no=$2,status='pending_process_configuration',
             submitted_at=COALESCE(submitted_at,CURRENT_TIMESTAMP),
             updated_by=$3,version=$4,updated_at=CURRENT_TIMESTAMP
         WHERE rework_order_id=$1`,
        [reworkOrderId, reworkNo, actor.actorId, nextVersion],
      );
      await this.outbox.enqueue(client, {
        topic: "rework.pending_process_configuration",
        aggregateType: "rework_order",
        aggregateId: reworkOrderId,
        payload: { reworkOrderId, reworkNo, styleNo: current.style_no },
        recipientKey: "role:tail_supervisor",
        idempotencyKey: `${reworkOrderId}:submitted:${nextVersion}`,
      });
      return this.getOwnedWithClient(client, actor.actorId, reworkOrderId);
    });
  }

  async withdraw(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: TransitionReworkOrder,
    idempotencyKey: string,
  ): Promise<MutationResult<ReworkOrderResponse>> {
    return this.mutate(actor, "rework.withdraw", idempotencyKey, { reworkOrderId, ...input }, 200, async (client) => {
      const current = await this.lockOwned(client, actor.actorId, reworkOrderId);
      this.ensureVersion(current, input.expectedVersion);
      transitionReworkOrder(current.status, "draft");
      if (current.status !== "pending_process_configuration") {
        throw new ApplicationError("INVALID_STATE_TRANSITION", "只有待配置工序的返工单可以撤回", 409);
      }
      await this.ensureNoProcessConfigurationStarted(client, reworkOrderId);
      const nextVersion = current.version + 1;
      const before = await this.auditState(client, current);
      const after = { ...before, status: "draft" as const, version: nextVersion };
      const eventId = await this.events.append(client, actor, {
        action: "rework.withdraw",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before,
        after,
        reason: input.reason,
      });
      await this.setAuditContext(client, eventId, actor.requestId);
      await client.query(
        `UPDATE rework_orders
         SET status='draft',updated_by=$2,version=$3,updated_at=CURRENT_TIMESTAMP
         WHERE rework_order_id=$1`,
        [reworkOrderId, actor.actorId, nextVersion],
      );
      await this.outbox.enqueue(client, {
        topic: "rework.withdrawn",
        aggregateType: "rework_order",
        aggregateId: reworkOrderId,
        payload: { reworkOrderId, reworkNo: current.rework_no, reason: input.reason },
        recipientKey: "role:tail_supervisor",
        idempotencyKey: `${reworkOrderId}:withdrawn:${nextVersion}`,
      });
      return this.getOwnedWithClient(client, actor.actorId, reworkOrderId);
    });
  }

  async cancel(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: TransitionReworkOrder,
    idempotencyKey: string,
  ): Promise<MutationResult<ReworkOrderResponse>> {
    return this.mutate(actor, "rework.cancel", idempotencyKey, { reworkOrderId, ...input }, 200, async (client) => {
      const current = await this.lockOwned(client, actor.actorId, reworkOrderId);
      this.ensureVersion(current, input.expectedVersion);
      transitionReworkOrder(current.status, "cancelled");
      if (current.status === "pending_process_configuration") {
        await this.ensureNoProcessConfigurationStarted(client, reworkOrderId);
      }
      const nextVersion = current.version + 1;
      const before = await this.auditState(client, current);
      const after = {
        ...before,
        status: "cancelled" as const,
        version: nextVersion,
        cancelReason: input.reason,
      };
      const eventId = await this.events.append(client, actor, {
        action: "rework.cancel",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before,
        after,
        reason: input.reason,
      });
      await this.setAuditContext(client, eventId, actor.requestId);
      await client.query(
        `UPDATE rework_orders
         SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,cancelled_by=$2,
             cancel_reason=$3,updated_by=$2,version=$4,updated_at=CURRENT_TIMESTAMP
         WHERE rework_order_id=$1`,
        [reworkOrderId, actor.actorId, input.reason, nextVersion],
      );
      if (current.status === "pending_process_configuration") {
        await this.outbox.enqueue(client, {
          topic: "rework.cancelled",
          aggregateType: "rework_order",
          aggregateId: reworkOrderId,
          payload: { reworkOrderId, reworkNo: current.rework_no, reason: input.reason },
          recipientKey: "role:tail_supervisor",
          idempotencyKey: `${reworkOrderId}:cancelled:${nextVersion}`,
        });
      }
      return this.getOwnedWithClient(client, actor.actorId, reworkOrderId);
    });
  }

  async getOwn(actor: TrustedActorContext, reworkOrderId: string): Promise<ReworkOrderResponse> {
    this.ensureInitiator(actor);
    return this.getOwnedWithClient(this.database, actor.actorId, reworkOrderId);
  }

  async listOwn(
    actor: TrustedActorContext,
    status?: ReworkOrderStatus,
  ): Promise<ReworkOrderResponse[]> {
    this.ensureInitiator(actor);
    const values: unknown[] = [actor.actorId];
    const statusFilter = status ? " AND orders.status=$2" : "";
    if (status) values.push(status);
    const result = await this.database.query<ReworkOrderRow>(
      `${ORDER_SELECT} WHERE orders.created_by=$1${statusFilter}
       ORDER BY orders.updated_at DESC,orders.rework_order_id`,
      values,
    );
    return Promise.all(result.rows.map((row) => this.dto(this.database, row)));
  }

  async listInitiationOptions(
    actor: TrustedActorContext,
  ): Promise<ReworkInitiationOptionsResponse> {
    this.ensureInitiator(actor);
    const [merchandisers, factories] = await Promise.all([
      this.database.query<{ user_id: string; display_name: string }>(
        `SELECT users.id AS user_id,users.display_name
         FROM app_users users
         JOIN identity_mappings identity ON identity.user_id=users.id
         JOIN access_security_policy policy
           ON policy.policy_key='primary' AND policy.dingtalk_corp_id=identity.corp_id
         JOIN user_role_assignments assignment
           ON assignment.user_id=users.id
          AND assignment.role_code='order_merchandiser'
          AND assignment.revoked_at IS NULL
         WHERE users.enabled=true
           AND identity.provider='dingtalk'
           AND identity.corp_id=$1
           AND identity.active=true AND identity.employed=true
         ORDER BY users.display_name,users.id`,
        [this.corporationId],
      ),
      this.database.query<{
        supplier_id: string;
        version: number;
        supplier_name: string;
      }>(
        `SELECT supplier_id,version,supplier_name
         FROM current_supplier_catalog
         WHERE supplier_type='factory' AND active=true
         ORDER BY supplier_name,supplier_id`,
      ),
    ]);
    return {
      merchandisers: merchandisers.rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
      })),
      factories: factories.rows.map((row) => ({
        supplierId: row.supplier_id,
        supplierVersion: row.version,
        supplierName: row.supplier_name,
      })),
    };
  }

  async canDownloadBoundAttachment(
    actor: Readonly<{ actorId: string; actorRoles: readonly string[]; capabilities: readonly string[] }>,
    binding: Readonly<{ entityType: string; entityId: string }>,
  ): Promise<boolean> {
    if (binding.entityType !== "rework_order") return false;
    const result = await this.database.query<{
      created_by: string;
      status: ReworkOrderStatus;
    }>(
      "SELECT created_by,status FROM rework_orders WHERE rework_order_id=$1",
      [binding.entityId],
    );
    const order = result.rows[0];
    if (!order) return false;
    const isOwnQcEvidence = actor.actorRoles.includes("quality_control")
      && actor.capabilities.includes("rework:initiate")
      && order.created_by === actor.actorId;
    const isSupervisorConfigurationEvidence = actor.actorRoles.includes("tail_supervisor")
      && actor.capabilities.includes("process:configure")
      && order.status !== "draft"
      && order.status !== "cancelled";
    const isIeReviewEvidence = actor.actorRoles.includes("ie_reviewer")
      && actor.capabilities.includes("process:review")
      && order.status === "pending_ie_review";
    return isOwnQcEvidence || isSupervisorConfigurationEvidence || isIeReviewEvidence;
  }

  private async mutate<T>(
    actor: TrustedActorContext,
    scope: string,
    idempotencyKey: string,
    payload: unknown,
    statusCode: number,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<MutationResult<T>> {
    this.ensureInitiator(actor);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await this.idempotency.execute<T>(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, payload),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }, async () => ({ statusCode, response: await work(client) }));
      await client.query("COMMIT");
      return { value: result.response, reused: result.reused };
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      return translateDatabaseError(error);
    } finally {
      client.release();
    }
  }

  private ensureInitiator(actor: TrustedActorContext): void {
    if (
      actor.authorizationCapability !== "rework:initiate"
      || !actor.actorRoles.includes("quality_control")
    ) {
      throw new ApplicationError("FORBIDDEN", "只有品控人员可以发起和维护返工单", 403);
    }
  }

  private ensureVersion(row: ReworkOrderRow, expectedVersion: number): void {
    if (row.version !== expectedVersion) {
      throw new ApplicationError("CONFLICT", "返工单已被更新，请刷新后重试", 409);
    }
  }

  private ensureComplete(row: ReworkOrderRow): void {
    if (
      !row.style_no
      || !row.merchandiser_user_id
      || !row.processing_factory_type
      || !row.problem_part
      || !row.problem_description
      || !row.rework_quantity
    ) {
      throw new ApplicationError("VALIDATION_ERROR", "请完整填写款号、跟单、加工厂、问题和返工数量", 400);
    }
  }

  private async ensureActiveMerchandiser(client: PoolClient, userId: string): Promise<void> {
    const result = await client.query(
      `SELECT 1
       FROM app_users users
       JOIN identity_mappings identity ON identity.user_id=users.id
       JOIN access_security_policy policy
         ON policy.policy_key='primary' AND policy.dingtalk_corp_id=identity.corp_id
       JOIN user_role_assignments assignment
         ON assignment.user_id=users.id
        AND assignment.role_code='order_merchandiser'
        AND assignment.revoked_at IS NULL
       WHERE users.id=$1 AND users.enabled=true
         AND identity.provider='dingtalk'
         AND identity.corp_id=$2
         AND identity.active=true AND identity.employed=true`,
      [userId, this.corporationId],
    );
    if (!result.rows[0]) {
      throw new ApplicationError("NOT_FOUND", "所选订单跟单不存在、不在职或角色无效", 404);
    }
  }

  private async resolveFactory(
    client: PoolClient,
    input: CreateReworkDraft["processingFactory"],
  ): Promise<FactoryState> {
    if (input === null || input === undefined) return null;
    if (input.type === "own_factory") {
      return { type: "own_factory", supplierId: null, supplierVersion: null };
    }
    const result = await client.query<{ supplier_id: string; version: number }>(
      `SELECT supplier_id,version
       FROM current_supplier_catalog
       WHERE supplier_id=$1 AND supplier_type='factory' AND active=true`,
      [input.supplierId],
    );
    const supplier = result.rows[0];
    if (!supplier) throw new ApplicationError("NOT_FOUND", "所选加工厂不存在或已停用", 404);
    return {
      type: "supplier",
      supplierId: supplier.supplier_id,
      supplierVersion: supplier.version,
    };
  }

  private async ensureFactoryStillAvailable(client: PoolClient, factory: FactoryState): Promise<void> {
    if (!factory || factory.type === "own_factory") return;
    const result = await client.query(
      `SELECT 1 FROM current_supplier_catalog
       WHERE supplier_id=$1 AND supplier_type='factory' AND active=true`,
      [factory.supplierId],
    );
    if (!result.rows[0]) {
      throw new ApplicationError("NOT_FOUND", "草稿中的加工厂已停用，请重新选择", 404);
    }
  }

  private async lockOwned(
    client: PoolClient,
    actorId: string,
    reworkOrderId: string,
  ): Promise<ReworkOrderRow> {
    const result = await client.query<ReworkOrderRow>(
      `${ORDER_SELECT}
       WHERE orders.rework_order_id=$1
       FOR UPDATE OF orders`,
      [reworkOrderId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    if (row.created_by !== actorId) {
      throw new ApplicationError("FORBIDDEN", "只能查看和维护本人发起的返工单", 403);
    }
    return row;
  }

  private async ensureNoProcessConfigurationStarted(
    client: PoolClient,
    reworkOrderId: string,
  ): Promise<void> {
    const configuration = await client.query(
      "SELECT 1 FROM rework_process_configurations WHERE rework_order_id=$1 LIMIT 1 FOR SHARE",
      [reworkOrderId],
    );
    if (configuration.rowCount !== 0) {
      throw new ApplicationError(
        "INVALID_STATE_TRANSITION",
        "尾部主管已开始配置工序，品控不能再撤回或取消该返工单",
        409,
      );
    }
  }

  private async getOwnedWithClient(
    client: Pick<PoolClient, "query">,
    actorId: string,
    reworkOrderId: string,
  ): Promise<ReworkOrderResponse> {
    const result = await client.query<ReworkOrderRow>(
      `${ORDER_SELECT} WHERE orders.rework_order_id=$1`,
      [reworkOrderId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    if (row.created_by !== actorId) {
      throw new ApplicationError("FORBIDDEN", "只能查看和维护本人发起的返工单", 403);
    }
    return this.dto(client, row);
  }

  private async attachmentIds(
    client: Pick<PoolClient, "query">,
    reworkOrderId: string,
  ): Promise<string[]> {
    const result = await client.query<{ attachment_id: string }>(
      `SELECT attachment_id
       FROM attachments
       WHERE entity_type='rework_order' AND entity_id=$1
       ORDER BY created_at,attachment_id`,
      [reworkOrderId],
    );
    return result.rows.map((row) => row.attachment_id);
  }

  private async ensureReadyBoundAttachments(
    client: PoolClient,
    actorId: string,
    reworkOrderId: string,
    attachmentIds: readonly string[],
  ): Promise<void> {
    if (attachmentIds.length === 0) return;
    const result = await client.query(
      `SELECT attachment_id
       FROM attachments
       WHERE attachment_id=ANY($1::uuid[])
         AND uploaded_by=$2
         AND status='ready'
         AND entity_type='rework_order'
         AND entity_id=$3
       FOR UPDATE`,
      [attachmentIds, actorId, reworkOrderId],
    );
    if (result.rowCount !== attachmentIds.length) {
      throw new ApplicationError("ATTACHMENT_NOT_READY", "QC附件未完成上传、归属不符或已被替换", 409);
    }
  }

  private async syncAttachments(
    client: PoolClient,
    actorId: string,
    reworkOrderId: string,
    attachmentIds: readonly string[],
  ): Promise<void> {
    const uniqueIds = [...new Set(attachmentIds)];
    if (uniqueIds.length !== attachmentIds.length) {
      throw new ApplicationError("VALIDATION_ERROR", "QC附件不能重复", 400);
    }
    if (uniqueIds.length > 0) {
      const candidates = await client.query(
        `SELECT attachment_id
         FROM attachments
         WHERE attachment_id=ANY($1::uuid[])
           AND uploaded_by=$2
           AND status='ready'
           AND (
             (entity_type IS NULL AND entity_id IS NULL)
             OR
             (entity_type='rework_order' AND entity_id=$3)
           )
         FOR UPDATE`,
        [uniqueIds, actorId, reworkOrderId],
      );
      if (candidates.rowCount !== uniqueIds.length) {
        throw new ApplicationError(
          "ATTACHMENT_NOT_READY",
          "QC附件未完成上传、并非本人上传或已绑定其他业务",
          409,
        );
      }
    }
    await client.query(
      `UPDATE attachments
       SET entity_type=NULL,entity_id=NULL,updated_at=CURRENT_TIMESTAMP
       WHERE entity_type='rework_order' AND entity_id=$1
         AND NOT (attachment_id=ANY($2::uuid[]))`,
      [reworkOrderId, uniqueIds],
    );
    if (uniqueIds.length > 0) {
      await client.query(
        `UPDATE attachments
         SET entity_type='rework_order',entity_id=$2,updated_at=CURRENT_TIMESTAMP
         WHERE attachment_id=ANY($1::uuid[])
           AND entity_type IS NULL AND entity_id IS NULL`,
        [uniqueIds, reworkOrderId],
      );
    }
  }

  private async auditState(
    client: Pick<PoolClient, "query">,
    row: ReworkOrderRow,
  ): Promise<Record<string, unknown>> {
    return {
      reworkOrderId: row.rework_order_id,
      reworkNo: row.rework_no,
      status: row.status,
      styleNo: row.style_no,
      orderNo: row.order_no,
      merchandiserUserId: row.merchandiser_user_id,
      processingFactory: factoryFromRow(row),
      problemPart: row.problem_part,
      problemDescription: row.problem_description,
      reworkQuantity: row.rework_quantity,
      attachmentIds: await this.attachmentIds(client, row.rework_order_id),
      version: row.version,
    };
  }

  private async setAuditContext(
    client: PoolClient,
    eventId: string,
    requestId: string,
  ): Promise<void> {
    await client.query(
      `SELECT
         set_config('dx_rework.rework_event_id',$1,true),
         set_config('dx_rework.rework_request_id',$2,true)`,
      [eventId, requestId],
    );
  }

  private async dto(
    client: Pick<PoolClient, "query">,
    row: ReworkOrderRow,
  ): Promise<ReworkOrderResponse> {
    const factory = factoryFromRow(row);
    return {
      reworkOrderId: row.rework_order_id,
      reworkNo: row.rework_no,
      status: row.status,
      styleNo: row.style_no,
      orderNo: row.order_no,
      merchandiserUserId: row.merchandiser_user_id,
      processingFactory: factory?.type === "supplier"
        ? {
            type: "supplier",
            supplierId: factory.supplierId!,
            supplierVersion: factory.supplierVersion!,
          }
        : factory?.type === "own_factory"
          ? { type: "own_factory" }
          : null,
      problemPart: row.problem_part,
      problemDescription: row.problem_description,
      reworkQuantity: row.rework_quantity,
      attachmentIds: await this.attachmentIds(client, row.rework_order_id),
      hasOtherOpenStyleOrder: row.has_other_open_style_order,
      version: row.version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      submittedAt: row.submitted_at?.toISOString() ?? null,
      cancelledAt: row.cancelled_at?.toISOString() ?? null,
      cancelReason: row.cancel_reason,
    };
  }
}
