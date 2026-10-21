import { createHash, randomUUID } from "node:crypto";

import {
  ErpEmergencyLinkResponseSchema,
  ErpCommandReceiptSchema,serializeErpCommandFingerprint,type ErpCommandScope,type ErpCommandReceipt,
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

const requestHash = (scope: ErpCommandScope, payload: unknown): string =>
  createHash("sha256").update(serializeErpCommandFingerprint(scope,payload)).digest("hex");

const emergencyExternalId = (actorId: string, key: string): string =>
  `emergency:${createHash("sha256").update(`${actorId}:${key}`).digest("hex")}`;

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : undefined;

// The intake source key is the command key for both direct and emergency
// creation. A link's external source key is independent of its HTTP command key.
const commandReceipt = (scope:ErpCommandScope,response:unknown,statusCode:number,key:string,orderId?:string) => {
  const parsed=scope==='erp.rework.link.v1'?ErpEmergencyLinkResponseSchema.safeParse(response):ErpIntakeResponseSchema.safeParse(response);
  if(!parsed.success||statusCode!==(scope==='erp.rework.link.v1'?200:201)
    ||scope!=='erp.rework.link.v1'&&'intakeMode'in parsed.data&&parsed.data.intakeMode!==(scope==='erp.rework.intake.v1'?'erp':'emergency')){
    throw new ApplicationError('ERP_RECEIPT_INVALID','原回执未符合本次命令的约定版本或接入方式，暂不能确认；请接入维护人员按请求编号核对，不能当作未保存重建。',502);
  }
  if(scope!=='erp.rework.link.v1'&&parsed.data.source.externalIdempotencyKey!==key)throw new ApplicationError('ERP_RECEIPT_INVALID','原回执的提交标识与本次原标识不一致，暂不能确认；请接入维护人员按请求编号核对原回执，不要换键重建。',502);
  if(orderId&&parsed.data.reworkOrderId!==orderId)throw new ApplicationError('IDEMPOTENCY_CONFLICT','原关联回执不属于当前返工单；请接入维护人员核对原单与提交标识，不重复补关联。',409);
  return parsed.data;
};

const translateDatabaseError = (error: unknown): never => {
  if (error instanceof ApplicationError) throw error;
  const code = databaseCode(error);
  if (code === "23505") throw new ApplicationError("CONFLICT", "ERP接入发生唯一性冲突，尚未定位具体记录；请接入维护人员核对原键回执和来源审计，不要换键重复建单", 409);
  if (code === "23503") throw new ApplicationError("NOT_FOUND", "ERP引用的业务资料不存在或关联失效，具体引用尚需核对；请接入维护人员检查原映射，并由原资料维护岗位处理，不使用默认人员或工厂代替", 404);
  if (code === "42501") throw new ApplicationError("FORBIDDEN", "当前身份无权执行ERP集成操作；请接入维护人员核对当前专用身份或原应急权限，不改用其他账号绕过", 403);
  if (code === "55000") throw new ApplicationError("CONFLICT", "ERP历史接入记录不能直接修改；请接入维护人员沿原应急关联入口核对，不覆盖旧来源", 409);
  if (code === "23514" || code === "22P02") {
    throw new ApplicationError("VALIDATION_ERROR", "ERP提交未通过业务校验，尚未确定具体字段；请接入维护人员按请求编号核对原契约和资料映射，不能猜字段或替换默认值", 400);
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
        "请求头提交标识必须与原ERP来源中的提交标识一致；请接入维护人员核对原键及原内容，不换新键重建",
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
        const intake = await client.query<{ intake_mode: IntakeMode; source_system: string }>(
          `SELECT intake.intake_mode,orders.source_system
           FROM erp_rework_intakes intake
           JOIN rework_orders orders USING(rework_order_id)
           WHERE intake.rework_order_id=$1 AND orders.status<>'deleted'
           FOR UPDATE OF intake`,
          [reworkOrderId],
        );
        const row = intake.rows[0];
        if (!row) throw new ApplicationError("NOT_FOUND", "本返工单未找到ERP接入记录；请接入维护人员核对原单标识与来源，不能据此重复建单", 404);
        if (row.intake_mode !== "emergency" || row.source_system !== "erp_emergency") {
          throw new ApplicationError("CONFLICT", "该记录不属于待关联的应急来源；请接入维护人员读取原来源结果，不重复补关联", 409);
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
            throw new ApplicationError("IDEMPOTENCY_CONFLICT", "原应急单已关联其他来源；请接入维护人员核对原关联历史，不覆盖或另建重复来源", 409);
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

  intakeReceipt(actor:TrustedActorContext,key:string,fingerprint:string):Promise<ErpCommandReceipt>{return this.readReceipt(actor,'erp.rework.intake.v1',key,fingerprint);}
  emergencyReceipt(actor:TrustedActorContext,key:string,fingerprint:string):Promise<ErpCommandReceipt>{return this.readReceipt(actor,'erp.rework.emergency_intake.v1',key,fingerprint);}
  linkReceipt(actor:TrustedActorContext,reworkOrderId:string,key:string,fingerprint:string):Promise<ErpCommandReceipt>{return this.readReceipt(actor,'erp.rework.link.v1',key,fingerprint,reworkOrderId);}

  /** No acquisition, row locks, expiry extension, auditing writes or adapter
   * calls. Missing/expired is unknown, never proof that the command failed. */
  private async readReceipt(actor:TrustedActorContext,scope:ErpCommandScope,key:string,fingerprint:string,orderId?:string):Promise<ErpCommandReceipt>{
    const client=await this.database.connect();
    try{await client.query('BEGIN TRANSACTION READ ONLY');await this.authorizeCommand(client,actor,scope);
      const result=await client.query<{request_hash:string;status:string;status_code:number|null;response:unknown;expires_at:Date;current:boolean}>(
        `SELECT request_hash,status,status_code,response,expires_at,expires_at>CURRENT_TIMESTAMP AS current
         FROM idempotency_records WHERE scope=$1 AND actor_key=$2 AND idempotency_key=$3`,[scope,actor.actorId,key]);
      const row=result.rows[0];let receipt:ErpCommandReceipt;
      if(!row||!row.current)receipt={contractVersion:'1',outcome:'unconfirmed',reason:'missing_or_expired',receipt:null,message:'未取得仍有效的原回执，不能据此认定未保存。请接入维护人员核对原来源审计，保留原键与内容，不要换键重建。'};
      else if(row.request_hash!==fingerprint)throw new ApplicationError('IDEMPOTENCY_CONFLICT','原提交标识与内容指纹不一致；请接入维护人员核对原请求内容和标识，不要改用新标识重复建单。',409);
      else if(row.status!=='completed')receipt={contractVersion:'1',outcome:'unconfirmed',reason:'in_progress',receipt:null,message:'原请求尚未取得完成回执。请保留原键与内容，稍后只读核对，不要另建提交。'};
      else{
        const response=commandReceipt(scope,row.response,row.status_code??0,key,orderId);
        receipt={contractVersion:'1',outcome:'confirmed',receipt:response,expiresAt:row.expires_at.toISOString(),message:'已确认原本地业务回执；此读取不执行写入，也不代表外部适配已确认完成。'};
      }
      const value=ErpCommandReceiptSchema.parse(receipt);await client.query('COMMIT');return value;
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);return translateDatabaseError(error);}finally{client.release();}
  }

  private async authorizeCommand(client:PoolClient,actor:TrustedActorContext,scope:ErpCommandScope){
    if(scope==='erp.rework.emergency_intake.v1')await this.ensureEmergencyActor(client,actor);
    else{this.ensureIntegrationActor(actor);await this.ensureIntegrationPrincipal(client);}
  }

  private async intake(
    actor: TrustedActorContext,
    mode: IntakeMode,
    input: ErpReworkIntakeV1 | ErpEmergencyReworkIntakeV1,
    idempotencyKey: string,
  ): Promise<MutationResult<ErpIntakeResponse>> {
    const scope = mode === "erp" ? "erp.rework.intake.v1" : "erp.rework.emergency_intake.v1";
    return this.mutate(actor, scope, idempotencyKey, input, 201, async (client) => {
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
    scope: ErpCommandScope,
    idempotencyKey: string,
    payload: unknown,
    statusCode: number,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<MutationResult<T>> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      // Replays and receipt reads require the same currently valid identity as
      // the original write; completed idempotency cannot bypass revocation.
      await this.authorizeCommand(client,actor,scope);
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
      // A controlled same-key retry must not bypass the binding checked by GET.
      commandReceipt(scope,result.response,result.statusCode,idempotencyKey,scope==='erp.rework.link.v1'?(payload as {reworkOrderId:string}).reworkOrderId:undefined);
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
      throw new ApplicationError("INTEGRATION_DISABLED", "ERP专用身份尚未启用；请接入维护人员核对专用身份及当前适配配置，不改用人工账号提交", 503);
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
      throw new ApplicationError("NOT_FOUND", "未找到同时满足当前公司、启用、在职及订单跟单岗位的来源人员；请接入维护人员核对人员映射，再由原员工权限维护岗位核对有效身份，具体缺项尚需核实", 404);
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
    if (!row) throw new ApplicationError("NOT_FOUND", "未找到有效来源加工厂；请接入维护人员核对工厂映射，再由原有权供应商维护岗位核对加工厂类型和启用状态，不重复新建同厂", 404);
    return { type: "supplier", supplierId: row.supplier_id, supplierVersion: row.version };
  }
}
