import { validationFieldLabel } from "@dx-rework/contracts/validation-language";
import { IdempotencyKeySchema } from "@dx-rework/contracts";
import {
  ErpEmergencyLinkV1Schema,
  ErpEmergencyReworkIntakeV1Schema,
  ErpReworkIntakeV1Schema,
  ErpReworkOrderParamsSchema,
  ErpReceiptQuerySchema,
} from "@dx-rework/contracts/erp-integration";
import { IntegrationDisabledError, type ErpAdapter } from "@dx-rework/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { ErpIntegrationService } from "./erp-integration-service.js";

const cookieToken = (request: FastifyRequest): string | undefined => request.headers.cookie
  ?.split(";")
  .map((value) => value.trim())
  .find((value) => value.startsWith("dx_rework_session="))
  ?.slice("dx_rework_session=".length);

const parse = <T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error?: { issues?: readonly { path?: readonly PropertyKey[]; message?: string }[] } } },
  value: unknown,
  contextLabel='ERP请求资料',
): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    const labels:Record<string,string>={contractVersion:'接口版本',source:'ERP来源',externalId:'来源标识',externalIdempotencyKey:'原提交标识',erpNodeId:'来源节点',payload:'返工资料',merchandiserUserId:'订单跟单映射',processingFactory:'加工厂映射',problemPart:'问题部位',problemDescription:'问题说明',reworkQuantity:'返工数量',requestFingerprint:'原请求内容指纹'};
    const issues=result.error?.issues??[],messages=issues.slice(0,6).map(issue=>{
      const path=issue.path??[],label=path.map(key=>labels[String(key)]??validationFieldLabel([key])).join(' / ')||contextLabel;
      const field=String(path.at(-1)??'');
      return `${label}：${field==='contractVersion'?'仅接受接口版本1':field==='reworkQuantity'?'请填写正整数':field==='merchandiserUserId'||field==='supplierId'||field==='reworkOrderId'?'请提供有效标识，由接入维护人员核对原映射':'请按原v1契约补齐并检查格式，不接受契约外字段'}`;
    });
    throw new ApplicationError("VALIDATION_ERROR",`${messages.join('；')||'ERP请求未符合原v1契约'}${issues.length>6?`；另有${issues.length-6}项需核对`:''}。请接入维护人员修正原请求，不使用默认值替代。`,400);
  }
  return result.data;
};

const idempotencyKey = (request: FastifyRequest): string =>
  parse(IdempotencyKeySchema, request.headers["idempotency-key"],'请求头提交标识');

export type ErpIntegrationHttpDependencies = Readonly<{
  authenticateSession(token: string | undefined): Promise<AuthUser>;
  authenticateIntegration?: (request: FastifyRequest) => Promise<TrustedActorContext>;
  adapter: ErpAdapter;
  service: ErpIntegrationService;
}>;

const integrationDisabled = (): ApplicationError =>
  new ApplicationError("INTEGRATION_DISABLED", "ERP生产接入尚未启用；请接入维护人员核对适配器与专用身份配置，不能改用普通账号提交。", 503);

export function registerErpIntegrationRoutes(
  app: FastifyInstance,
  dependencies: ErpIntegrationHttpDependencies,
): void {
  const integrationActor = async (request: FastifyRequest): Promise<TrustedActorContext> => {
    const status = await dependencies.adapter.status();
    if (!status.enabled || status.mode === "disabled" || !dependencies.authenticateIntegration) {
      throw integrationDisabled();
    }
    return dependencies.authenticateIntegration(request);
  };

  const adminActor = async (
    request: FastifyRequest,
    capability: "erp:emergency_intake" | "erp:result:read",
  ): Promise<TrustedActorContext> => {
    const user = await dependencies.authenticateSession(cookieToken(request));
    if (!user.businessRoles?.length) {
      throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    }
    if (!user.businessRoles.includes("system_admin") || !user.capabilities.includes(capability)) {
      throw new ApplicationError("FORBIDDEN", "当前管理员缺少ERP接入能力", 403);
    }
    return {
      actorId: user.id,
      actorRoles: user.businessRoles,
      authorizationCapability: capability,
      authorizationCapabilities: user.capabilities,
      requestId: request.id,
    };
  };

  app.post("/integrations/erp/v1/rework-orders", async (request, reply) => {
    const input = parse(ErpReworkIntakeV1Schema, request.body);
    const key = idempotencyKey(request);
    const actor = await integrationActor(request);
    const result = await dependencies.service.intakeFromErp(actor, input, key);
    if (!result.reused) {
      try {
        await dependencies.adapter.acceptSourceRecord(input);
      } catch (error: unknown) {
        // The local transaction has already committed. This failure cannot be
        // described as an unperformed intake or retried under a new key.
        throw new ApplicationError("ERP_ADAPTER_ACK_UNKNOWN",error instanceof IntegrationDisabledError
          ?"本地ERP接入已保存，外部适配在确认时停用。请接入维护人员用原键与内容指纹读取原本地回执，再核对适配配置，不要换键重建。"
          :"本地ERP接入已保存，外部适配确认未完成。请接入维护人员读取原本地回执并核对外部结果，不要换键重建。",502);
      }
    }
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(result.value);
  });

  // Keys stay in the existing header; only a digest is accepted in the URL.
  // These GETs never acquire/extend idempotency or invoke the external adapter.
  app.get('/integrations/erp/v1/rework-orders/intake-receipt',async(request,reply)=>{
    reply.header('Cache-Control','private, no-store').header('Vary','Authorization, Cookie, Idempotency-Key');
    const actor=await integrationActor(request),query=parse(ErpReceiptQuerySchema,request.query);
    return dependencies.service.intakeReceipt(actor,idempotencyKey(request),query.requestFingerprint);
  });
  app.get<{Params:{reworkOrderId:string}}>('/integrations/erp/v1/rework-orders/:reworkOrderId/link-receipt',async(request,reply)=>{
    reply.header('Cache-Control','private, no-store').header('Vary','Authorization, Cookie, Idempotency-Key');
    const actor=await integrationActor(request),params=parse(ErpReworkOrderParamsSchema,request.params),query=parse(ErpReceiptQuerySchema,request.query);
    return dependencies.service.linkReceipt(actor,params.reworkOrderId,idempotencyKey(request),query.requestFingerprint);
  });
  app.get('/admin/erp-emergency/v1/rework-orders/intake-receipt',async(request,reply)=>{
    reply.header('Cache-Control','private, no-store').header('Vary','Authorization, Cookie, Idempotency-Key');
    const actor=await adminActor(request,'erp:emergency_intake'),query=parse(ErpReceiptQuerySchema,request.query);
    return dependencies.service.emergencyReceipt(actor,idempotencyKey(request),query.requestFingerprint);
  });

  app.post<{ Params: { reworkOrderId: string } }>(
    "/integrations/erp/v1/rework-orders/:reworkOrderId/link",
    async (request, reply) => {
      const params = parse(ErpReworkOrderParamsSchema, request.params);
      const result = await dependencies.service.linkEmergency(
        await integrationActor(request),
        params.reworkOrderId,
        parse(ErpEmergencyLinkV1Schema, request.body),
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return result.value;
    },
  );

  app.get<{ Params: { reworkOrderId: string } }>(
    "/integrations/erp/v1/rework-orders/:reworkOrderId/result",
    async (request) => {
      const params = parse(ErpReworkOrderParamsSchema, request.params);
      return dependencies.service.result(await integrationActor(request), params.reworkOrderId);
    },
  );

  app.post("/admin/erp-emergency/v1/rework-orders", async (request, reply) => {
    const result = await dependencies.service.emergencyIntake(
      await adminActor(request, "erp:emergency_intake"),
      parse(ErpEmergencyReworkIntakeV1Schema, request.body),
      idempotencyKey(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(result.value);
  });

  app.get<{ Params: { reworkOrderId: string } }>(
    "/admin/erp/v1/rework-orders/:reworkOrderId/result",
    async (request) => {
      const params = parse(ErpReworkOrderParamsSchema, request.params);
      return dependencies.service.result(
        await adminActor(request, "erp:result:read"),
        params.reworkOrderId,
      );
    },
  );
}
