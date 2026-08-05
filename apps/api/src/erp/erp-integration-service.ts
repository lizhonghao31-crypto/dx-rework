import { createHash, randomUUID } from "node:crypto";

import {
  ErpEmergencyLinkResponseSchema,
  ErpIntakeResponseSchema,
  type ErpEmergencyLinkResponse,
  type ErpEmergencyLinkV1,
  type ErpEmergencyReworkIntakeV1,
  type ErpIntakeResponse,
  type ErpReworkIntakeV1,
  type ErpReworkPayload,
  type ErpReworkResultV1,
} from "@dx-rework/contracts/erp-integration";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  MessageOutboxRepository,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";
import {
  ERP_INTEGRATION_CAPABILITY,
  ERP_INTEGRATION_SERVICE_ACTOR_ID,
  ERP_INTEGRATION_SERVICE_ROLE,
  createErpIntegrationActor,
} from "./erp-integration-identity.js";
import { loadErpReworkResult } from "./erp-result-service.js";

type IntakeMode = "erp" | "emergency";
type MutationResult<T> = Readonly<{ value: T; reused: boolean }>;
type FactorySnapshot = Readonly<{
  type: "own_factory" | "supplier";
  supplierId: string | null;
  supplierVersion: number | null;
}>;

type IntakeInsertRow = Readonly<{ created_at: Date }>;
type LinkInsertRow = Readonly<{ created_at: Date }>;

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

const emergencyExternalId = (actorId: string, key: string): string =>
  `emergency:${createHash("sha256").update(`${actorId}:${key}`).digest("hex")}`;

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : undefined;

const translateDatabaseError = (error: unknown): never => {
  if (error instanceof ApplicationError) throw error;
  const code = databaseCode(error);
  if (code === "23505") throw new ApplicationError("CONFLICT", "ERP来源、幂等键或关联记录已存在", 409);
  if (code === "23503") throw new ApplicationError("NOT_FOUND", "ERP来源引用的业务资料不存在", 404);
  if (code === "42501") throw new ApplicationError("FORBIDDEN", "当前身份无权执行ERP集成操作", 403);
  if (code === "55000") throw new ApplicationError("CONFLICT", "ERP集成记录不允许绕过受控流程修改", 409);
  if (code === "23514" || code === "22P02") {
    throw new ApplicationError("VALIDATION_ERROR", "ERP集成数据不符合业务约束", 400);
  }
  throw error;
};

export class ErpIntegrationService {
  constructor(
    private readonly database: Pool,
    private readonly corporationId: string,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
    private readonly outbox = new MessageOutboxRepository(),
    private readonly todos?: TodoProjectionService,
  ) {}

  integrationActor(requestId: string): TrustedActorContext {
    return createErpIntegrationActor(requestId);
  }

  async intakeFromErp(
    actor: TrustedActorContext,
    input: ErpReworkIntakeV1,
    idempotencyKey: string,
  ): Promise<MutationResult<ErpIntakeResponse>> {
    if (input.source.externalIdempotencyKey !== idempotencyKey) {
      throw new ApplicationError(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency-Key必须与ERP来源契约中的externalIdempotencyKey一致",
        409,
      );
    }
    return this.intake(actor, "erp", input, idempotencyKey);
  }

  async emergencyIntake(
    actor: TrustedActorContext,
    input: ErpEmergencyReworkIntakeV1,
    idempotencyKey: string,
  ): Promise<MutationResult<ErpIntakeResponse>> {
    return this.intake(actor, "emergency", input, idempotencyKey);
  }

  async linkEmergency(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: ErpEmergencyLinkV1,
    idempotencyKey: string,
  ): Promise<MutationResult<ErpEmergencyLinkResponse>> {
    this.ensureIntegrationActor(actor);
    return this.mutate(
      actor,
      "erp.rework.link.v1",
      idempotencyKey,
      { reworkOrderId, input },
      200,
      async (client) => {
        await this.ensureIntegrationPrincipal(client);
        const intake = await client.query<{ intake_mode: IntakeMode; source_system: string }>(
          `SELECT intake.intake_mode,orders.source_system
           FROM erp_rework_intakes intake
           JOIN rework_orders orders USING(rework_order_id)
           WHERE intake.rework_order_id=$1
           FOR UPDATE OF intake`,
          [reworkOrderId],
        );
        const row = intake.rows[0];
        if (!row) throw new ApplicationError("NOT_FOUND", "返工单没有ERP接入记录", 404);
        if (row.intake_mode !== "emergency" || row.source_system !== "erp_emergency") {
          throw new ApplicationError("CONFLICT", "只有应急录入记录需要后续ERP关联", 409);
        }

        const existing = await client.query<{
          external_id: string;
          external_idempotency_key: string;
          erp_node_id: string;
          created_at: Date;
        }>(
          `SELECT external_id,external_idempotency_key,erp_node_id,created_at
           FROM erp_rework_links
           WHERE rework_order_id=$1`,
          [reworkOrderId],
        );
        const linked = existing.rows[0];
        if (linked) {
          if (
            linked.external_id !== input.externalId
            || linked.external_idempotency_key !== input.externalIdempotencyKey
            || linked.erp_node_id !== input.erpNodeId
          ) {
            throw new ApplicationError("IDEMPOTENCY_CONFLICT", "该应急返工单已关联不同ERP来源", 409);
          }
          return ErpEmergencyLinkResponseSchema.parse({
            contractVersion: "1",
            reworkOrderId,
            linkageStatus: "linked",
            source: {
              sourceSystem: "erp",
              externalId: linked.external_id,
              externalIdempotencyKey: linked.external_idempotency_key,
              erpNodeId: linked.erp_node_id,
            },
            linkedAt: linked.created_at.toISOString(),
          });
        }

        const eventId = await this.events.append(client, actor, {
          action: "rework.erp.link",
          entityType: "rework_order",
          entityId: reworkOrderId,
          before: { linkageStatus: "pending" },
          after: {
            linkageStatus: "linked",
            sourceSystem: "erp",
            externalId: input.externalId,
            externalIdempotencyKey: input.externalIdempotencyKey,
            erpNodeId: input.erpNodeId,
          },
        });
        await client.query(
          `SELECT set_config('dx_rework.erp_link_event_id',$1,true),
                  set_config('dx_rework.erp_link_request_id',$2,true)`,
          [eventId, actor.requestId],
        );
        const inserted = await client.query<LinkInsertRow>(
          `INSERT INTO erp_rework_links(
             link_id,rework_order_id,source_system,external_id,
             external_idempotency_key,erp_node_id,linked_by,operation_event_id,request_id
           ) VALUES($1,$2,'erp',$3,$4,$5,$6,$7,$8)
           RETURNING created_at`,
          [
            randomUUID(),
            reworkOrderId,
            input.externalId,
            input.externalIdempotencyKey,
            input.erpNodeId,
            actor.actorId,
            eventId,
            actor.requestId,
          ],
        );
        return ErpEmergencyLinkResponseSchema.parse({
          contractVersion: "1",
          reworkOrderId,
          linkageStatus: "linked",
          source: {
            sourceSystem: "erp",
            externalId: input.externalId,
            externalIdempotencyKey: input.externalIdempotencyKey,
            erpNodeId: input.erpNodeId,
          },
          linkedAt: inserted.rows[0]!.created_at.toISOString(),
        });
      },
    );
  }

  async result(actor: TrustedActorContext, reworkOrderId: string): Promise<ErpReworkResultV1> {
    return loadErpReworkResult(this.database, actor, reworkOrderId);
  }

  private async intake(
    actor: TrustedActorContext,
    mode: IntakeMode,
    input: ErpReworkIntakeV1 | ErpEmergencyReworkIntakeV1,
    idempotencyKey: string,
  ): Promise<MutationResult<ErpIntakeResponse>> {
    const scope = mode === "erp" ? "erp.rework.intake.v1" : "erp.rework.emergency_intake.v1";
    return this.mutate(actor, scope, idempotencyKey, input, 201, async (client) => {
      if (mode === "erp") {
        this.ensureIntegrationActor(actor);
        await this.ensureIntegrationPrincipal(client);
      } else {
        await this.ensureEmergencyActor(client, actor);
      }

      const payload = input.payload;
      const factory = await this.resolveFactory(client, payload.processingFactory);
      await this.ensureActiveMerchandiser(client, payload.merchandiserUserId);
      const reworkOrderId = randomUUID();
      const number = await client.query<{ rework_no: string }>(
        "SELECT next_rework_order_number() AS rework_no",
      );
      const reworkNo = number.rows[0]!.rework_no;
      const source = mode === "erp"
        ? (input as ErpReworkIntakeV1).source
        : {
            sourceSystem: "erp_emergency" as const,
            externalId: emergencyExternalId(actor.actorId, idempotencyKey),
            externalIdempotencyKey: idempotencyKey,
            erpNodeId: null,
          };
      const emergencyReason = mode === "emergency"
        ? (input as ErpEmergencyReworkIntakeV1).reason
        : undefined;
      const action = "rework.submit";
      const after = {
        reworkOrderId,
        reworkNo,
        status: "pending_process_configuration",
        styleNo: payload.styleNo,
        orderNo: payload.orderNo ?? null,
        merchandiserUserId: payload.merchandiserUserId,
        processingFactory: factory.type === "own_factory"
          ? { type: "own_factory" as const }
          : {
              type: "supplier" as const,
              supplierId: factory.supplierId,
              supplierVersion: factory.supplierVersion,
            },
        problemPart: payload.problemPart,
        problemDescription: payload.problemDescription,
        reworkQuantity: payload.reworkQuantity,
        attachmentIds: [],
        sourceSystem: source.sourceSystem,
        externalId: source.externalId,
        externalIdempotencyKey: source.externalIdempotencyKey,
        erpNodeId: source.erpNodeId,
        intakeMode: mode,
        version: 1,
      };
      const eventId = await this.events.append(client, actor, {
        action,
        entityType: "rework_order",
        entityId: reworkOrderId,
        after,
        ...(emergencyReason ? { reason: emergencyReason } : {}),
      });
      await client.query(
        `SELECT set_config('dx_rework.rework_event_id',$1,true),
                set_config('dx_rework.rework_request_id',$2,true),
                set_config('dx_rework.erp_intake_event_id',$1,true),
                set_config('dx_rework.erp_intake_request_id',$2,true)`,
        [eventId, actor.requestId],
      );
      const inserted = await client.query<IntakeInsertRow>(
        `INSERT INTO rework_orders(
           rework_order_id,rework_no,status,source_system,external_id,
           external_idempotency_key,erp_node_id,style_no,order_no,
           merchandiser_user_id,processing_factory_type,
           processing_factory_supplier_id,processing_factory_supplier_version,
           problem_part,problem_description,rework_quantity,
           created_by,updated_by,submitted_at
         ) VALUES(
           $1,$2,'pending_process_configuration',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
           $13,$14,$15,$16,$16,CURRENT_TIMESTAMP
         )
         RETURNING created_at`,
        [
          reworkOrderId,
          reworkNo,
          source.sourceSystem,
          source.externalId,
          source.externalIdempotencyKey,
          source.erpNodeId,
          payload.styleNo,
          payload.orderNo ?? null,
          payload.merchandiserUserId,
          factory.type,
          factory.supplierId,
          factory.supplierVersion,
          payload.problemPart,
          payload.problemDescription,
          payload.reworkQuantity,
          actor.actorId,
        ],
      );
      await client.query(
        `INSERT INTO erp_rework_intakes(
           rework_order_id,contract_version,intake_mode,source_snapshot,
           received_by,emergency_reason,operation_event_id,request_id
         ) VALUES($1,'1',$2,$3,$4,$5,$6,$7)`,
        [
          reworkOrderId,
          mode,
          input,
          actor.actorId,
          emergencyReason ?? null,
          eventId,
          actor.requestId,
        ],
      );
      await this.outbox.enqueue(client, {
        topic: "rework.pending_process_configuration",
        aggregateType: "rework_order",
        aggregateId: reworkOrderId,
        payload: { reworkOrderId, reworkNo, styleNo: payload.styleNo, sourceSystem: source.sourceSystem },
        recipientKey: "role:tail_supervisor",
        idempotencyKey: `${reworkOrderId}:submitted:1`,
      });
      await this.todos?.actionableForUniqueDirectRole(client, actor, {
        category: "process_configuration",
        sourceEventId: eventId,
        sourceAction: action,
        entityType: "rework_order",
        entityId: reworkOrderId,
        requiredRole: "tail_supervisor",
        requiredCapability: "process:configure",
        route: { routeName: "process_configuration", entityId: reworkOrderId },
        policyKey: "general",
        dedupeKey: `process-config:${reworkOrderId}:1`,
      });
      return ErpIntakeResponseSchema.parse({
        contractVersion: "1",
        reworkOrderId,
        reworkNo,
        status: "pending_process_configuration",
        intakeMode: mode,
        linkageStatus: mode === "erp" ? "linked" : "pending",
        source,
        createdAt: inserted.rows[0]!.created_at.toISOString(),
      });
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
      const result = await this.idempotency.execute<T>(
        client,
        {
          scope,
          actorKey: actor.actorId,
          key: idempotencyKey,
          requestHash: requestHash(scope, payload),
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
        async () => ({ statusCode, response: await work(client) }),
      );
      await client.query("COMMIT");
      return { value: result.response, reused: result.reused };
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      return translateDatabaseError(error);
    } finally {
      client.release();
    }
  }

  private ensureIntegrationActor(actor: TrustedActorContext): void {
    if (
      actor.actorId !== ERP_INTEGRATION_SERVICE_ACTOR_ID
      || actor.authorizationCapability !== ERP_INTEGRATION_CAPABILITY
      || !actor.actorRoles.includes(ERP_INTEGRATION_SERVICE_ROLE)
    ) {
      throw new ApplicationError("FORBIDDEN", "ERP写入必须使用专用非人工集成身份", 403);
    }
  }

  private async ensureIntegrationPrincipal(client: PoolClient): Promise<void> {
    const principal = await client.query(
      `SELECT 1
       FROM erp_integration_principals principal
       JOIN app_users actor ON actor.id=principal.principal_id
       WHERE principal.principal_key='erp' AND principal.active=true
         AND actor.enabled=true AND actor.id=$1`,
      [ERP_INTEGRATION_SERVICE_ACTOR_ID],
    );
    if (!principal.rows[0]) {
      throw new ApplicationError("INTEGRATION_DISABLED", "ERP集成身份未启用", 503);
    }
  }

  private async ensureEmergencyActor(
    client: PoolClient,
    actor: TrustedActorContext,
  ): Promise<void> {
    if (
      actor.authorizationCapability !== "erp:emergency_intake"
      || !actor.actorRoles.includes("system_admin")
    ) {
      throw new ApplicationError("FORBIDDEN", "只有系统管理员可执行ERP应急录入", 403);
    }
    await client.query("SELECT access_authorized_actor_roles($1,'erp:emergency_intake')", [
      actor.actorId,
    ]);
  }

  private async ensureActiveMerchandiser(
    client: PoolClient,
    userId: string,
  ): Promise<void> {
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
      throw new ApplicationError("NOT_FOUND", "ERP来源中的订单跟单不存在、不在职或角色无效", 404);
    }
  }

  private async resolveFactory(
    client: PoolClient,
    input: ErpReworkPayload["processingFactory"],
  ): Promise<FactorySnapshot> {
    if (input.type === "own_factory") {
      return { type: "own_factory", supplierId: null, supplierVersion: null };
    }
    const supplier = await client.query<{ supplier_id: string; version: number }>(
      `SELECT supplier_id,version
       FROM current_supplier_catalog
       WHERE supplier_id=$1 AND supplier_type='factory' AND active=true`,
      [input.supplierId],
    );
    const row = supplier.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "ERP来源中的加工厂不存在或已停用", 404);
    return { type: "supplier", supplierId: row.supplier_id, supplierVersion: row.version };
  }
}
