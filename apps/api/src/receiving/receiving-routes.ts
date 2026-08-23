import type { FastifyInstance, FastifyRequest } from "fastify";

import { businessActor, isRootUser } from "../access/business-authority.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import type { ReceivingService } from "./receiving-service.js";

const token = (request: FastifyRequest): string | undefined => request.headers.cookie
  ?.split(";")
  .map((part) => part.trim())
  .find((part) => part.startsWith("dx_rework_session="))
  ?.slice("dx_rework_session=".length);

const idempotencyKey = (request: FastifyRequest): string => {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new ApplicationError("VALIDATION_ERROR", "收货提交缺少有效请求标识", 400);
  }
  return value;
};

const createBody = (input: unknown): {
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  attachmentIds: readonly string[];
} => {
  if (!input || typeof input !== "object") {
    throw new ApplicationError("VALIDATION_ERROR", "收货信息不完整", 400);
  }
  const body = input as Record<string, unknown>;
  if (typeof body.styleNo !== "string") {
    throw new ApplicationError("VALIDATION_ERROR", "请选择或填写款号", 400);
  }
  if (body.attachmentIds !== undefined && (
    !Array.isArray(body.attachmentIds)
    || body.attachmentIds.some((value) => typeof value !== "string")
  )) {
    throw new ApplicationError("VALIDATION_ERROR", "收货单图片信息无效", 400);
  }
  return {
    styleNo: body.styleNo,
    documentQuantity: Number(body.documentQuantity),
    actualQuantity: Number(body.actualQuantity),
    attachmentIds: (body.attachmentIds as string[] | undefined) ?? [],
  };
};

export type ReceivingHttpDependencies = Readonly<{
  authenticate(value: string | undefined): Promise<AuthUser>;
  service: ReceivingService;
  root?: RootAuthority;
}>;

export function registerReceivingRoutes(app: FastifyInstance, dependencies: ReceivingHttpDependencies): void {
  const readUser = async (request: FastifyRequest): Promise<AuthUser> => {
    const user = await dependencies.authenticate(token(request));
    const root = await isRootUser(dependencies.root, user.id);
    if (!root && !user.businessRoles?.length) {
      throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
    }
    return user;
  };

  const creator = async (request: FastifyRequest) => {
    const user = await dependencies.authenticate(token(request));
    const root = await isRootUser(dependencies.root, user.id);
    const warehouse = user.businessRoles?.includes("warehouse_receiver") === true
      && user.capabilities.includes("receiving:create");
    if (!root && !warehouse) {
      throw new ApplicationError("FORBIDDEN", "只有仓管人员可以登记收货", 403);
    }
    return businessActor(
      dependencies.root,
      user,
      request.id,
      "receiving:create",
      root ? "warehouse_receiver" : undefined,
    );
  };

  app.get<{ Querystring: { q?: string } }>("/receiving/style-options", async (request) => {
    await readUser(request);
    return { styles: await dependencies.service.listStyleOptions(request.query.q ?? "") };
  });

  app.get<{ Querystring: { date?: string; q?: string } }>("/receiving/board", async (request) => {
    await readUser(request);
    const date = request.query.date ?? new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    return dependencies.service.board(date, request.query.q ?? "");
  });

  app.post("/receiving/receipts", async (request, reply) => {
    const result = await dependencies.service.create(
      await creator(request),
      createBody(request.body),
      idempotencyKey(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(result.value);
  });
}
