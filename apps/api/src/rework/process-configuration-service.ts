import { createHash, randomUUID } from "node:crypto";

import type {
  ProcessConfigurationItem,
  ProcessConfigurationOptionsResponse,
  ProcessConfigurationResponse,
  ReviewProcessConfiguration,
  SaveProcessConfiguration,
  SubmitProcessConfiguration,
} from "@dx-rework/contracts";
import type { ReworkOrderStatus } from "@dx-rework/domain";
import type { Pool, PoolClient } from "pg";

import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  MessageOutboxRepository,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";

type DatabaseError = Readonly<{ code?: string }>;
type MutationResult<T> = Readonly<{ value: T; reused: boolean }>;
type OrderRow = Readonly<{
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
  tail_inspection_required: boolean;
  created_by: string;
  updated_by: string;
  version: number;
}>;
type ConfigurationRow = Readonly<{
  configuration_id: string;
  rework_order_id: string;
  configuration_version: number;
  configuration_kind: "initial" | "change";
  status: "draft" | "pending_ie_review" | "approved" | "rejected" | "superseded";
  change_reason: string | null;
  review_reason: string | null;
  created_by: string;
  created_at: Date;
  submitted_at: Date | null;
  reviewed_at: Date | null;
  worker_preassignment_required: boolean;
  unified_execution_required: boolean;
}>;
type ConfigurationItemRow = Readonly<{
  configuration_item_id: string;
  source: "catalog" | "custom";
  catalog_process_id: string | null;
  catalog_process_version: number | null;
  process_name: string;
  execution_kind: "worker" | "tail_inspection";
  pricing_unit: "piece" | "hour";
  planned_quantity: string | number;
  unit_price: string | number | null;
  promoted_process_id: string | null;
}>;
type PreparedItem = Readonly<{
  configurationItemId: string;
  source: "catalog" | "custom";
  processId: string | null;
  processVersion: number | null;
  customProcessName: string | null;
  processName: string;
  executionKind: "worker" | "tail_inspection";
  pricingUnit: "piece" | "hour";
  plannedQuantity: number;
  unitPrice: number;
}>;

type PromotionLockInput = Readonly<{
  source: "catalog" | "custom";
  processName: string;
  pricingUnit: "piece" | "hour";
}>;

export const customPromotionLockKeys = (
  items: readonly PromotionLockInput[],
): string[] => Array.from(
  new Set(
    items
      .filter((item) => item.source === "custom")
      .map((item) => "dx_rework:custom-process:" + item.processName.toLocaleLowerCase("zh-CN") + ":" + item.pricingUnit),
  ),
).sort();

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

const numberValue = (value: string | number): number => Number(value);
const decimalSource = (value: number): string => {
  const source = String(value);
  const exponentAt = source.search(/[eE]/);
  if (exponentAt === -1) return source;

  const coefficient = source.slice(0, exponentAt);
  const exponent = Number(source.slice(exponentAt + 1));
  const negative = coefficient.startsWith("-");
  const unsignedCoefficient = negative ? coefficient.slice(1) : coefficient;
  const [whole = "", fraction = ""] = unsignedCoefficient.split(".");
  const digits = whole + fraction;
  const decimalAt = whole.length + exponent;
  const expanded = decimalAt <= 0
    ? "0." + "0".repeat(-decimalAt) + digits
    : decimalAt >= digits.length
      ? digits + "0".repeat(decimalAt - digits.length)
      : digits.slice(0, decimalAt) + "." + digits.slice(decimalAt);
  return (negative ? "-" : "") + expanded;
};

export const truncateDecimal = (value: number, scale: number): number => {
  const [whole = "", fraction = ""] = decimalSource(value).split(".");
  return Number(fraction.length === 0 ? whole : whole + "." + fraction.slice(0, scale));
};

export const isIeSelfReviewBlocked = (
  actor: TrustedActorContext,
  orderCreatedBy: string,
  configurationCreatedBy: string,
): boolean => !isRootActor(actor)
  && (orderCreatedBy === actor.actorId || configurationCreatedBy === actor.actorId);

const translateDatabaseError = (error: unknown): never => {
  if (error instanceof ApplicationError) throw error;
  const code = (error as DatabaseError | null)?.code;
  if (code === "23505") throw new ApplicationError("CONFLICT", "工序配置版本或公共工序已存在", 409);
  if (code === "23503") throw new ApplicationError("NOT_FOUND", "返工单或工序目录不存在", 404);
  if (code === "42501") throw new ApplicationError("FORBIDDEN", "当前用户无权执行该操作", 403);
  if (code === "55000") throw new ApplicationError("CONFLICT", "工序配置不允许绕过受控流程修改", 409);
  if (code === "23514" || code === "22P02") {
    throw new ApplicationError("VALIDATION_ERROR", "工序、数量、单位、单价或状态不符合规则", 400);
  }
  throw error;
};

export class ProcessConfigurationService {
  constructor(
    private readonly database: Pool,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
    private readonly outbox = new MessageOutboxRepository(),
    private readonly todos?: TodoProjectionService,
  ) {}

  async get(actor: TrustedActorContext, reworkOrderId: string): Promise<ProcessConfigurationResponse> {
    this.ensureRead(actor);
    const order = await this.order(this.database, reworkOrderId);
    if (isRootActor(actor)) return this.dto(this.database, order);
    const isSupervisor = actor.actorRoles.includes("tail_supervisor")
      && actor.authorizationCapability === "process:configure";
    const isReviewer = actor.actorRoles.includes("ie_reviewer")
      && actor.authorizationCapability === "process:review";
    if (
      (isSupervisor && (order.status === "draft" || order.status === "cancelled"))
      || (isReviewer && order.status !== "pending_ie_review")
    ) {
      throw new ApplicationError("FORBIDDEN", "当前返工单不在您的工序处理范围内", 403);
    }
    return this.dto(this.database, order);
  }

  async options(actor: TrustedActorContext): Promise<ProcessConfigurationOptionsResponse> {
    this.ensureConfigure(actor);
    const [result, tailRoster] = await Promise.all([this.database.query<{
      process_id: string; version: number; process_name: string; pricing_unit: "piece" | "hour"; default_worker_person_ids: string[];
    }>(
      `SELECT catalog.process_id,catalog.version,catalog.process_name,catalog.pricing_unit,
              COALESCE(roster.person_ids,'{}'::uuid[]) AS default_worker_person_ids
       FROM current_process_catalog catalog
       LEFT JOIN LATERAL (
         SELECT person_ids FROM process_default_worker_roster_versions roster_version
         WHERE roster_version.process_id=catalog.process_id
         ORDER BY roster_version.roster_version DESC LIMIT 1
       ) roster ON true
      WHERE catalog.active=true AND catalog.pricing_unit='piece'
       ORDER BY catalog.process_name,catalog.process_id`,
    ), this.database.query<{ person_ids: string[] }>(
      `SELECT person_ids FROM tail_inspection_default_worker_roster_versions
       ORDER BY roster_version DESC LIMIT 1`,
    )]);
    return {
      processes: result.rows.map((row) => ({
        processId: row.process_id,
        version: row.version,
        processName: row.process_name,
        pricingUnit: row.pricing_unit,
        defaultWorkerPersonIds: row.default_worker_person_ids,
      })),
      tailDefaultWorkerPersonIds: tailRoster.rows[0]?.person_ids ?? [],
    };
  }

  async saveDraft(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: SaveProcessConfiguration,
    idempotencyKey: string,
  ): Promise<MutationResult<ProcessConfigurationResponse>> {
    this.ensureConfigure(actor);
    return this.mutate(actor, "rework.process_configuration.save", idempotencyKey, { reworkOrderId, ...input }, 201, async (client) => {
      const order = await this.lockOrder(client, reworkOrderId);
      this.ensureOrderVersion(order, input.expectedOrderVersion);
      if (order.status !== "pending_process_configuration") {
        throw new ApplicationError("INVALID_STATE_TRANSITION", "当前返工单不允许保存工序配置", 409);
      }
      const kind = "initial" as const;
      if (input.changeReason) {
        throw new ApplicationError("VALIDATION_ERROR", "初次配置不能伪造为变更单", 400);
      }
      const current = await this.latestConfiguration(client, reworkOrderId, true);
      const unifiedExecutionRequired = true;
      const workerPreassignmentRequired = true;
      const items = await this.prepareItems(client, input.items, order.tail_inspection_required);
      const configurationId = randomUUID();
      const configurationVersion = (current?.configuration_version ?? 0) + 1;
      const nextOrderVersion = order.version + 1;
      const nextConfiguration = {
        configurationId,
        configurationVersion,
        kind,
        status: "draft",
        changeReason: input.changeReason ?? null,
        replacesConfigurationId: current?.status === "draft" ? current.configuration_id : null,
        workerPreassignmentRequired,
        unifiedExecutionRequired,
        items: items.map((item) => this.auditItem(item)),
      };
      const eventId = await this.events.append(client, actor, {
        action: "rework.process_configuration.save",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before: {
          ...this.auditOrder(order),
          configuration: current ? await this.configurationAudit(client, current) : null,
        },
        after: {
          ...this.auditOrder(order, order.status, nextOrderVersion),
          configuration: nextConfiguration,
        },
        ...(input.changeReason ? { reason: input.changeReason } : {}),
      });
      await this.setConfigurationContext(client, eventId, actor.requestId);
      await this.setReworkContext(client, eventId, actor.requestId);
      if (current?.status === "draft") {
        await client.query(
          "UPDATE rework_process_configurations SET status='superseded' WHERE configuration_id=$1",
          [current.configuration_id],
        );
      }
      await client.query(
        "INSERT INTO rework_process_configurations(configuration_id,rework_order_id,configuration_version,configuration_kind,status,change_reason,created_by,worker_preassignment_required,unified_execution_required) VALUES($1,$2,$3,$4,'draft',$5,$6,$7,$8)",
        [configurationId, reworkOrderId, configurationVersion, kind, input.changeReason ?? null, actor.actorId, workerPreassignmentRequired, unifiedExecutionRequired],
      );
      for (const [index, item] of items.entries()) {
        await client.query(
          "INSERT INTO rework_process_configuration_items(configuration_item_id,configuration_id,position,source,catalog_process_id,catalog_process_version,custom_process_name,process_name,execution_kind,pricing_unit,planned_quantity,unit_price) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [
            item.configurationItemId, configurationId, index + 1, item.source, item.processId,
            item.processVersion, item.customProcessName, item.processName, item.executionKind, item.pricingUnit,
            item.plannedQuantity, item.unitPrice,
          ],
        );
      }
      await client.query(
        "UPDATE rework_orders SET updated_by=$2,version=$3,updated_at=CURRENT_TIMESTAMP WHERE rework_order_id=$1",
        [reworkOrderId, actor.actorId, nextOrderVersion],
      );
      return this.dto(client, await this.order(client, reworkOrderId));
    });
  }

  async submit(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: SubmitProcessConfiguration,
    idempotencyKey: string,
  ): Promise<MutationResult<ProcessConfigurationResponse>> {
    this.ensureConfigure(actor);
    return this.mutate(actor, "rework.process_configuration.submit", idempotencyKey, { reworkOrderId, ...input }, 200, async (client) => {
      const order = await this.lockOrder(client, reworkOrderId);
      this.ensureOrderVersion(order, input.expectedOrderVersion);
      if (order.status !== "pending_process_configuration") {
        throw new ApplicationError("INVALID_STATE_TRANSITION", "当前返工单不允许提交工序配置", 409);
      }
      const configuration = await this.latestConfiguration(client, reworkOrderId, true);
      if (!configuration || configuration.status !== "draft" || configuration.configuration_version !== input.expectedConfigurationVersion) {
        throw new ApplicationError("CONFLICT", "工序配置已被更新，请刷新后重新提交", 409);
      }
      const configurationItems = await this.items(client, configuration.configuration_id);
      if (configurationItems.filter((item) => item.execution_kind === "worker").length === 0) {
        throw new ApplicationError("VALIDATION_ERROR", "至少配置一道返工工序后才能提交IE审核", 400);
      }
      const tailItemCount = configurationItems.filter((item) => item.execution_kind === "tail_inspection").length;
      if (order.tail_inspection_required ? tailItemCount !== 1 : tailItemCount !== 0) {
        throw new ApplicationError(
          "VALIDATION_ERROR",
          order.tail_inspection_required ? "必须且只能包含一道整查特殊工序" : "本单不需要整查，不能配置整查工序",
          400,
        );
      }
      const nextOrderVersion = order.version + 1;
      const eventId = await this.events.append(client, actor, {
        action: "rework.process_configuration.submit",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before: { ...this.auditOrder(order), configuration: await this.configurationAudit(client, configuration) },
        after: {
          ...this.auditOrder(order, "pending_ie_review", nextOrderVersion),
          configuration: { ...(await this.configurationAudit(client, configuration)), status: "pending_ie_review" },
        },
      });
      await this.setConfigurationContext(client, eventId, actor.requestId);
      await this.setReworkContext(client, eventId, actor.requestId);
      await client.query(
        "UPDATE rework_process_configurations SET status='pending_ie_review',submitted_at=CURRENT_TIMESTAMP WHERE configuration_id=$1",
        [configuration.configuration_id],
      );
      await client.query(
        "UPDATE rework_orders SET status='pending_ie_review',updated_by=$2,version=$3,updated_at=CURRENT_TIMESTAMP WHERE rework_order_id=$1",
        [reworkOrderId, actor.actorId, nextOrderVersion],
      );
      await this.todos?.completeOpenByDedupePrefix(
        client,
        actor,
        `process-config:${reworkOrderId}:`,
        "Process configuration was submitted for IE review",
      );
      const returnedConfigurations = await client.query<{ configuration_id: string }>(
        `SELECT configuration_id
         FROM rework_process_configurations
         WHERE rework_order_id=$1 AND status='rejected'
         ORDER BY configuration_version`,
        [reworkOrderId],
      );
      for (const returned of returnedConfigurations.rows) {
        await this.todos?.completeOpenByDedupePrefix(
          client,
          actor,
          `process-config-return:${returned.configuration_id}:`,
          "Returned process configuration was corrected and resubmitted",
        );
      }
      await this.outbox.enqueue(client, {
        topic: "rework.process_configuration.pending_ie_review",
        aggregateType: "rework_order",
        aggregateId: reworkOrderId,
        payload: { reworkOrderId, reworkNo: order.rework_no, configurationVersion: configuration.configuration_version },
        recipientKey: "role:ie_reviewer",
        idempotencyKey: reworkOrderId + ":process-configuration:" + configuration.configuration_version + ":submit",
      });
      await this.todos?.actionableForUniqueDirectRole(client, actor, {
        category: "ie_review",
        sourceEventId: eventId,
        sourceAction: "rework.process_configuration.submit",
        entityType: "rework_order",
        entityId: reworkOrderId,
        requiredRole: "ie_reviewer",
        requiredCapability: "process:review",
        route: { routeName: "process_configuration", entityId: reworkOrderId },
        policyKey: "general",
        dedupeKey: `ie-review:${reworkOrderId}:${configuration.configuration_version}`,
      });
      return this.dto(client, await this.order(client, reworkOrderId));
    });
  }

  async review(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: ReviewProcessConfiguration,
    idempotencyKey: string,
  ): Promise<MutationResult<ProcessConfigurationResponse>> {
    this.ensureReview(actor);
    return this.mutate(actor, "rework.process_configuration.review", idempotencyKey, { reworkOrderId, ...input }, 200, async (client) => {
      const order = await this.lockOrder(client, reworkOrderId);
      this.ensureOrderVersion(order, input.expectedOrderVersion);
      if (order.status !== "pending_ie_review") {
        throw new ApplicationError("INVALID_STATE_TRANSITION", "当前返工单不在IE审核节点", 409);
      }
      const configuration = await this.latestConfiguration(client, reworkOrderId, true);
      if (!configuration || configuration.status !== "pending_ie_review" || configuration.configuration_version !== input.expectedConfigurationVersion) {
        throw new ApplicationError("CONFLICT", "待审核工序配置已发生变化，请刷新后处理", 409);
      }
      if (isIeSelfReviewBlocked(actor, order.created_by, configuration.created_by)) {
        throw new ApplicationError("FORBIDDEN", "IE审核人不得是返工单发起人或当前工序配置人", 403);
      }
      const items = await this.items(client, configuration.configuration_id);
      const approved = input.decision === "approved";
      const nextStatus = approved ? "pending_task_assignment" as const : "pending_process_configuration" as const;
      const nextOrderVersion = order.version + 1;
      const previousApproved = approved && configuration.configuration_kind === "change"
        ? await this.approvedConfiguration(client, reworkOrderId)
        : null;
      const promotions = approved ? await this.newCustomPromotions(client, items) : [];
      const eventId = await this.events.append(client, actor, {
        action: "rework.process_configuration.review",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before: { ...this.auditOrder(order), configuration: await this.configurationAudit(client, configuration) },
        after: {
          ...this.auditOrder(order, nextStatus, nextOrderVersion),
          configuration: {
            ...(await this.configurationAudit(client, configuration)),
            status: approved ? "approved" : "rejected",
            reviewReason: input.reason ?? null,
            replacesConfigurationId: previousApproved?.configuration_id ?? null,
            promotions,
          },
        },
        ...(input.reason ? { reason: input.reason } : {}),
      });
      await this.setConfigurationContext(client, eventId, actor.requestId);
      await this.setReworkContext(client, eventId, actor.requestId);
      if (previousApproved) {
        await client.query(
          "UPDATE rework_process_configurations SET status='superseded' WHERE configuration_id=$1",
          [previousApproved.configuration_id],
        );
      }
      if (approved) {
        await this.promoteCustomItems(client, actor.actorId, eventId, actor.requestId, promotions, items);
      }
      await client.query(
        "UPDATE rework_process_configurations SET status=$2,reviewed_by=$3,reviewed_at=CURRENT_TIMESTAMP,review_reason=$4 WHERE configuration_id=$1",
        [configuration.configuration_id, approved ? "approved" : "rejected", actor.actorId, input.reason ?? null],
      );
      await client.query(
        "UPDATE rework_orders SET status=$2,updated_by=$3,version=$4,updated_at=CURRENT_TIMESTAMP WHERE rework_order_id=$1",
        [reworkOrderId, nextStatus, actor.actorId, nextOrderVersion],
      );
      await this.todos?.completeOpenByDedupeKey(
        client,
        actor,
        `ie-review:${reworkOrderId}:${configuration.configuration_version}`,
        approved ? "IE process review was approved" : "IE process review was rejected",
      );
      await this.outbox.enqueue(client, {
        topic: approved ? "rework.process_configuration.approved" : "rework.process_configuration.rejected",
        aggregateType: "rework_order",
        aggregateId: reworkOrderId,
        payload: { reworkOrderId, reworkNo: order.rework_no, configurationVersion: configuration.configuration_version, reason: input.reason ?? null },
        recipientKey: "role:tail_supervisor",
        idempotencyKey: reworkOrderId + ":process-configuration:" + configuration.configuration_version + ":" + input.decision,
      });
      if (!approved) {
        await this.todos?.actionableForNamedRecipient(client, actor, {
          category: "process_configuration_return",
          sourceEventId: eventId,
          sourceAction: "rework.process_configuration.review",
          entityType: "rework_order",
          entityId: reworkOrderId,
          recipientUserId: configuration.created_by,
          requiredRole: "tail_supervisor",
          requiredCapability: "process:configure",
          route: { routeName: "process_configuration", entityId: reworkOrderId },
          policyKey: "general",
          dedupeKey: `process-config-return:${configuration.configuration_id}:${configuration.configuration_version}`,
        });
        await this.todos?.information(client, actor, {
          category: "process_configuration_rejection_notice",
          sourceEventId: eventId,
          sourceAction: "rework.process_configuration.review",
          entityType: "rework_order",
          entityId: reworkOrderId,
          recipientUserId: configuration.created_by,
          route: { routeName: "process_configuration", entityId: reworkOrderId },
          dedupeKey: `process-config-return-notice:${configuration.configuration_id}:${configuration.configuration_version}:${configuration.created_by}`,
        });
      }
      return this.dto(client, await this.order(client, reworkOrderId));
    });
  }

  private async mutate<T>(
    actor: TrustedActorContext,
    scope: string,
    idempotencyKey: string,
    payload: unknown,
    statusCode: number,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<MutationResult<T>> {
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

  private ensureRead(actor: TrustedActorContext): void {
    if (isRootActor(actor)) return;
    const canConfigure = actor.actorRoles.includes("tail_supervisor")
      && actor.authorizationCapability === "process:configure";
    const canReview = actor.actorRoles.includes("ie_reviewer")
      && actor.authorizationCapability === "process:review";
    if (!canConfigure && !canReview) {
      throw new ApplicationError("FORBIDDEN", "只有尾部主管或IE可以查看工序配置", 403);
    }
  }

  private ensureConfigure(actor: TrustedActorContext): void {
    if (!actor.actorRoles.includes("tail_supervisor") || actor.authorizationCapability !== "process:configure") {
      throw new ApplicationError("FORBIDDEN", "只有尾部主管可以配置工序和价格", 403);
    }
  }

  private ensureReview(actor: TrustedActorContext): void {
    if (!actor.actorRoles.includes("ie_reviewer") || actor.authorizationCapability !== "process:review") {
      throw new ApplicationError("FORBIDDEN", "只有IE可以审核工序和价格", 403);
    }
  }

  private async prepareItems(
    client: PoolClient,
    input: readonly ProcessConfigurationItem[],
    tailInspectionRequired: boolean,
  ): Promise<PreparedItem[]> {
    const tailItems = input.filter((item) => item.executionKind === "tail_inspection");
    if (tailInspectionRequired ? tailItems.length !== 1 : tailItems.length !== 0) {
      throw new ApplicationError(
        "VALIDATION_ERROR",
        tailInspectionRequired ? "必须且只能配置一道整查特殊工序" : "本单不需要整查，不能配置整查工序",
        400,
      );
    }
    const prepared: PreparedItem[] = [];
    const names = new Set<string>();
    for (const item of input) {
      const executionKind = item.executionKind ?? "worker";
      const submittedProcessName = item.source === "custom" ? item.customProcessName.trim() : "";
      if (executionKind === "tail_inspection" && (item.source !== "custom" || !["整查", "尾查"].includes(submittedProcessName))) {
        throw new ApplicationError("VALIDATION_ERROR", "整查特殊工序必须使用系统固定名称“整查”", 400);
      }
      const plannedQuantity = item.plannedQuantity;
      const unitPrice = truncateDecimal(item.unitPrice, 3);
      if (!Number.isInteger(plannedQuantity) || plannedQuantity <= 0 || unitPrice <= 0) {
        throw new ApplicationError("VALIDATION_ERROR", "数量和单价经规则截位后必须大于0", 400);
      }
      let processId: string | null = null;
      let processVersion: number | null = null;
      let customProcessName: string | null = null;
      let processName: string;
      if (item.source === "catalog") {
        const stableProcess = await client.query<{ process_id: string }>(
          "SELECT process_id FROM process_catalog_items WHERE process_id=$1 FOR SHARE",
          [item.processId],
        );
        if (!stableProcess.rows[0]) {
          throw new ApplicationError("NOT_FOUND", "所选公共工序不存在或已停用", 404);
        }
        const catalog = await client.query<{
          process_id: string; version: number; process_name: string; pricing_unit: "piece" | "hour";
        }>(
          "SELECT process_id,version,process_name,pricing_unit FROM current_process_catalog WHERE process_id=$1 AND active=true",
          [item.processId],
        );
        const row = catalog.rows[0];
        if (!row) throw new ApplicationError("NOT_FOUND", "所选公共工序不存在或已停用", 404);
        if (row.pricing_unit !== item.pricingUnit) {
          throw new ApplicationError("VALIDATION_ERROR", "公共工序的计价单位不能与目录不一致", 400);
        }
        processId = row.process_id;
        processVersion = row.version;
        processName = row.process_name;
      } else {
        customProcessName = executionKind === "tail_inspection" ? "整查" : submittedProcessName;
        processName = customProcessName;
      }
      const key = processName.toLocaleLowerCase("zh-CN");
      if (names.has(key)) throw new ApplicationError("VALIDATION_ERROR", "同一配置不能重复出现相同工序", 400);
      names.add(key);
      prepared.push({
        configurationItemId: randomUUID(),
        source: item.source,
        processId,
        processVersion,
        customProcessName,
        processName,
        executionKind,
        pricingUnit: item.pricingUnit,
        plannedQuantity,
        unitPrice,
      });
    }
    return prepared;
  }

  private async newCustomPromotions(
    client: PoolClient,
    items: readonly ConfigurationItemRow[],
  ): Promise<Array<{ configurationItemId: string; processId: string; processCode: string }>> {
    const customItems = items.filter((item) => item.source === "custom" && item.execution_kind === "worker");
    for (const lockKey of customPromotionLockKeys(customItems.map((item) => ({
      source: item.source,
      processName: item.process_name,
      pricingUnit: item.pricing_unit,
    })))) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
    }

    const promotions: Array<{ configurationItemId: string; processId: string; processCode: string }> = [];
    for (const item of customItems) {
      const exists = await client.query(
        "SELECT 1 FROM current_process_catalog WHERE lower(process_name)=lower($1) AND pricing_unit=$2 AND active=true",
        [item.process_name, item.pricing_unit],
      );
      if (exists.rowCount === 0) {
        const processId = randomUUID();
        promotions.push({
          configurationItemId: item.configuration_item_id,
          processId,
          processCode: "CUS-" + processId.replaceAll("-", "").slice(0, 24).toUpperCase(),
        });
      }
    }
    return promotions;
  }

  private async promoteCustomItems(
    client: PoolClient,
    actorId: string,
    eventId: string,
    requestId: string,
    promotions: readonly { configurationItemId: string; processId: string; processCode: string }[],
    items: readonly ConfigurationItemRow[],
  ): Promise<void> {
    if (promotions.length === 0) return;
    await client.query(
      "SELECT set_config('dx_rework.process_promotion_event_id',$1,true),set_config('dx_rework.process_promotion_request_id',$2,true)",
      [eventId, requestId],
    );
    for (const promotion of promotions) {
      const item = items.find((candidate) => candidate.configuration_item_id === promotion.configurationItemId);
      if (!item) throw new ApplicationError("INTERNAL_ERROR", "自定义工序提升记录不完整", 500);
      await client.query(
        "INSERT INTO rework_custom_process_promotions(configuration_item_id,process_id) VALUES($1,$2)",
        [promotion.configurationItemId, promotion.processId],
      );
      await client.query(
        "INSERT INTO process_catalog_items(process_id,process_code) VALUES($1,$2)",
        [promotion.processId, promotion.processCode],
      );
      await client.query(
        "INSERT INTO process_catalog_versions(process_id,version,process_name,pricing_unit,active,change_reason,changed_by) VALUES($1,1,$2,$3,true,$4,$5)",
        [
          promotion.processId,
          item.process_name,
          item.pricing_unit,
          "IE审核通过后由当前返工单自定义工序进入公共工序库",
          actorId,
        ],
      );
    }
  }

  private async lockOrder(client: PoolClient, reworkOrderId: string): Promise<OrderRow> {
    const result = await client.query<OrderRow>(
      "SELECT * FROM rework_orders WHERE rework_order_id=$1 AND status<>'deleted' FOR UPDATE",
      [reworkOrderId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    return row;
  }

  private async order(client: Pick<PoolClient, "query">, reworkOrderId: string): Promise<OrderRow> {
    const result = await client.query<OrderRow>(
      "SELECT * FROM rework_orders WHERE rework_order_id=$1 AND status<>'deleted'",
      [reworkOrderId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    return row;
  }

  private async latestConfiguration(
    client: Pick<PoolClient, "query">,
    reworkOrderId: string,
    lock = false,
  ): Promise<ConfigurationRow | null> {
    const result = await client.query<ConfigurationRow>(
      "SELECT * FROM rework_process_configurations WHERE rework_order_id=$1 AND status<>'superseded' ORDER BY configuration_version DESC LIMIT 1" + (lock ? " FOR UPDATE" : ""),
      [reworkOrderId],
    );
    return result.rows[0] ?? null;
  }

  private async approvedConfiguration(
    client: Pick<PoolClient, "query">,
    reworkOrderId: string,
  ): Promise<ConfigurationRow | null> {
    const result = await client.query<ConfigurationRow>(
      "SELECT * FROM rework_process_configurations WHERE rework_order_id=$1 AND status='approved' FOR UPDATE",
      [reworkOrderId],
    );
    return result.rows[0] ?? null;
  }

  private async items(client: Pick<PoolClient, "query">, configurationId: string): Promise<ConfigurationItemRow[]> {
    const result = await client.query<ConfigurationItemRow>(
      "SELECT item.configuration_item_id,item.source,item.catalog_process_id,item.catalog_process_version,item.process_name,item.execution_kind,item.pricing_unit,item.planned_quantity,item.unit_price,promotion.process_id AS promoted_process_id FROM rework_process_configuration_items item LEFT JOIN rework_custom_process_promotions promotion ON promotion.configuration_item_id=item.configuration_item_id WHERE item.configuration_id=$1 ORDER BY item.position,item.configuration_item_id",
      [configurationId],
    );
    return result.rows;
  }

  private async dto(client: Pick<PoolClient, "query">, order: OrderRow): Promise<ProcessConfigurationResponse> {
    const configuration = await this.latestConfiguration(client, order.rework_order_id);
    return {
      reworkOrderId: order.rework_order_id,
      reworkNo: order.rework_no,
      reworkStatus: order.status,
      orderVersion: order.version,
      tailInspectionRequired: order.tail_inspection_required,
      configuration: configuration ? {
        configurationId: configuration.configuration_id,
        configurationVersion: configuration.configuration_version,
        kind: configuration.configuration_kind,
        status: configuration.status,
        changeReason: configuration.change_reason,
        reviewReason: configuration.review_reason,
        createdAt: configuration.created_at.toISOString(),
        submittedAt: configuration.submitted_at?.toISOString() ?? null,
        reviewedAt: configuration.reviewed_at?.toISOString() ?? null,
        unifiedExecutionRequired: configuration.unified_execution_required,
        items: (await this.items(client, configuration.configuration_id)).map((item) => ({
          configurationItemId: item.configuration_item_id,
          source: item.source,
          processId: item.catalog_process_id,
          processVersion: item.catalog_process_version,
          processName: item.execution_kind === "tail_inspection" ? "整查" : item.process_name,
          executionKind: item.execution_kind,
          pricingUnit: item.pricing_unit,
          plannedQuantity: numberValue(item.planned_quantity),
          unitPrice: item.unit_price === null ? null : numberValue(item.unit_price),
          promotedProcessId: item.promoted_process_id,
        })),
      } : null,
    };
  }

  private async configurationAudit(
    client: Pick<PoolClient, "query">,
    configuration: ConfigurationRow,
  ): Promise<Record<string, unknown>> {
    return {
      configurationId: configuration.configuration_id,
      configurationVersion: configuration.configuration_version,
      kind: configuration.configuration_kind,
      status: configuration.status,
      changeReason: configuration.change_reason,
      reviewReason: configuration.review_reason,
      workerPreassignmentRequired: configuration.worker_preassignment_required,
      unifiedExecutionRequired: configuration.unified_execution_required,
      items: (await this.items(client, configuration.configuration_id)).map((item) => ({
        configurationItemId: item.configuration_item_id,
        source: item.source,
        processId: item.catalog_process_id,
        processVersion: item.catalog_process_version,
        processName: item.process_name,
        executionKind: item.execution_kind,
        pricingUnit: item.pricing_unit,
        plannedQuantity: numberValue(item.planned_quantity),
        unitPrice: item.unit_price === null ? null : numberValue(item.unit_price),
        promotedProcessId: item.promoted_process_id,
      })),
    };
  }

  private auditItem(item: PreparedItem): Record<string, unknown> {
    return {
      configurationItemId: item.configurationItemId,
      source: item.source,
      processId: item.processId,
      processVersion: item.processVersion,
      processName: item.processName,
      executionKind: item.executionKind,
      pricingUnit: item.pricingUnit,
      plannedQuantity: item.plannedQuantity,
      unitPrice: item.unitPrice,
    };
  }

  private auditOrder(order: OrderRow, status = order.status, version = order.version): Record<string, unknown> {
    return {
      reworkOrderId: order.rework_order_id,
      reworkNo: order.rework_no,
      status,
      styleNo: order.style_no,
      orderNo: order.order_no,
      merchandiserUserId: order.merchandiser_user_id,
      processingFactory: order.processing_factory_type === null
        ? null
        : order.processing_factory_type === "own_factory"
          ? { type: "own_factory" }
          : {
              type: "supplier",
              supplierId: order.processing_factory_supplier_id,
              supplierVersion: order.processing_factory_supplier_version,
            },
      problemPart: order.problem_part,
      problemDescription: order.problem_description,
      reworkQuantity: order.rework_quantity,
      version,
    };
  }

  private ensureOrderVersion(order: OrderRow, expectedVersion: number): void {
    if (order.version !== expectedVersion) {
      throw new ApplicationError("CONFLICT", "返工单已被更新，请刷新后重试", 409);
    }
  }

  private async setConfigurationContext(client: PoolClient, eventId: string, requestId: string): Promise<void> {
    await client.query(
      "SELECT set_config('dx_rework.process_configuration_event_id',$1,true),set_config('dx_rework.process_configuration_request_id',$2,true)",
      [eventId, requestId],
    );
  }

  private async setReworkContext(client: PoolClient, eventId: string, requestId: string): Promise<void> {
    await client.query(
      "SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true)",
      [eventId, requestId],
    );
  }
}
