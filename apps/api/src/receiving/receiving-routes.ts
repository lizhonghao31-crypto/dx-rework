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
  defectiveQuantity: number;
  attachmentIds: readonly string[];
  receivedDate?: string;
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
    throw new ApplicationError("VALIDATION_ERROR", "送货单图片信息无效", 400);
  }
  if (body.receivedDate !== undefined && typeof body.receivedDate !== "string") {
    throw new ApplicationError("VALIDATION_ERROR", "补录日期无效", 400);
  }
  return {
    styleNo: body.styleNo,
    documentQuantity: Number(body.documentQuantity),
    actualQuantity: Number(body.actualQuantity),
    defectiveQuantity: body.defectiveQuantity === undefined ? 0 : Number(body.defectiveQuantity),
    attachmentIds: (body.attachmentIds as string[] | undefined) ?? [],
    ...(typeof body.receivedDate === "string" ? { receivedDate: body.receivedDate } : {}),
  };
};

const mutationBody = (input: unknown): {
  expectedVersion: number;
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  defectiveQuantity?: number;
  attachmentIds?: readonly string[];
} => {
  if (!input || typeof input !== "object") {
    throw new ApplicationError("VALIDATION_ERROR", "收货订单修改信息不完整", 400);
  }
  const body = input as Record<string, unknown>;
  if (typeof body.styleNo !== "string") {
    throw new ApplicationError("VALIDATION_ERROR", "款号不能为空", 400);
  }
  if (body.attachmentIds !== undefined && (
    !Array.isArray(body.attachmentIds)
    || body.attachmentIds.some((value) => typeof value !== "string")
  )) {
    throw new ApplicationError("VALIDATION_ERROR", "替换送货单图片信息无效", 400);
  }
  return {
    expectedVersion: Number(body.expectedVersion),
    styleNo: body.styleNo,
    documentQuantity: Number(body.documentQuantity),
    actualQuantity: Number(body.actualQuantity),
    ...(body.defectiveQuantity === undefined
      ? {}
      : { defectiveQuantity: Number(body.defectiveQuantity) }),
    ...(body.attachmentIds === undefined
      ? {}
      : { attachmentIds: body.attachmentIds as string[] }),
  };
};

const receiptCorrectionBody = (input: unknown): {
  expectedVersion: number;
  source: "jiashun" | "other_factory";
  documentQuantity: number;
  actualQuantity: number;
  defectiveQuantity: number;
} => {
  if (!input || typeof input !== "object") {
    throw new ApplicationError("VALIDATION_ERROR", "收货记录修正信息不完整", 400);
  }
  const body = input as Record<string, unknown>;
  if (body.source !== "jiashun" && body.source !== "other_factory") {
    throw new ApplicationError("VALIDATION_ERROR", "请选择嘉顺收货或其他工厂收货", 400);
  }
  return {
    expectedVersion: Number(body.expectedVersion),
    source: body.source,
    documentQuantity: Number(body.documentQuantity),
    actualQuantity: Number(body.actualQuantity),
    defectiveQuantity: Number(body.defectiveQuantity),
  };
};

const deleteBody = (input: unknown): { expectedVersion: number } => {
  if (!input || typeof input !== "object") {
    throw new ApplicationError("VALIDATION_ERROR", "收货订单版本无效", 400);
  }
  return { expectedVersion: Number((input as Record<string, unknown>).expectedVersion) };
};

const batchId = (input: string): string => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
    throw new ApplicationError("VALIDATION_ERROR", "收货订单标识无效", 400);
  }
  return input;
};

const repeatBody = (input: unknown): {
  receivingBatchId: string;
  source: "jiashun" | "other_factory";
  documentQuantity?: number;
  actualQuantity: number;
  defectiveQuantity: number;
} => {
  if (!input || typeof input !== "object") {
    throw new ApplicationError("VALIDATION_ERROR", "多次收货信息不完整", 400);
  }
  const body = input as Record<string, unknown>;
  if (typeof body.receivingBatchId !== "string") {
    throw new ApplicationError("VALIDATION_ERROR", "请选择要追加收货的订单", 400);
  }
  if (body.source !== "jiashun" && body.source !== "other_factory") {
    throw new ApplicationError("VALIDATION_ERROR", "请选择嘉顺收货或其他工厂收货", 400);
  }
  if (body.source === "other_factory" && body.documentQuantity === undefined) {
    throw new ApplicationError("VALIDATION_ERROR", "请填写本次送货单数量", 400);
  }
  return {
    receivingBatchId: batchId(body.receivingBatchId),
    source: body.source,
    ...(body.source === "other_factory" ? { documentQuantity: Number(body.documentQuantity) } : {}),
    actualQuantity: Number(body.actualQuantity),
    defectiveQuantity: body.defectiveQuantity === undefined ? 0 : Number(body.defectiveQuantity),
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

  const rootCorrector = async (request: FastifyRequest) => {
    const user = await dependencies.authenticate(token(request));
    if (!(await isRootUser(dependencies.root, user.id))) {
      throw new ApplicationError("FORBIDDEN", "只有Root可以修改或删除收货订单", 403);
    }
    return businessActor(
      dependencies.root,
      user,
      request.id,
      "receiving:correct",
    );
  };

  app.get<{ Querystring: { q?: string } }>("/receiving/repeat-options", async (request) => {
    await creator(request);
    return { orders: await dependencies.service.listRepeatOptions(request.query.q ?? "") };
  });

  app.get<{ Querystring: { q?: string } }>("/receiving/style-options", async (request) => {
    await readUser(request);
    return { styles: await dependencies.service.listStyleOptions(request.query.q ?? "") };
  });

  app.get<{ Querystring: {
    page?: string;
    date?: string;
    startDate?: string;
    endDate?: string;
    q?: string;
    status?: string;
  } }>("/receiving/board", async (request) => {
    await readUser(request);
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const startDate = request.query.startDate ?? request.query.date ?? today;
    const endDate = request.query.endDate ?? request.query.date ?? startDate;
    const page = Number(request.query.page ?? "1");
    if (!Number.isInteger(page) || page < 1 || page > 100_000) {
      throw new ApplicationError("VALIDATION_ERROR", "分页页码无效", 400);
    }
    return dependencies.service.board(
      startDate,
      endDate,
      request.query.q ?? "",
      request.query.status ?? "all",
      page,
    );
  });

  app.post("/receiving/repeat-receipts", async (request, reply) => {
    const result = await dependencies.service.createRepeated(
      await creator(request),
      repeatBody(request.body),
      idempotencyKey(request),
    );
    if (result.reused) void reply.header("idempotency-replayed", "true");
    return reply.code(201).send(result.value);
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

  app.post<{ Params: { receiptId: string } }>(
    "/receiving/receipts/:receiptId/corrections",
    async (request) => dependencies.service.correctReceipt(
      await rootCorrector(request),
      batchId(request.params.receiptId),
      receiptCorrectionBody(request.body),
    ),
  );

  app.patch<{ Params: { receivingBatchId: string } }>(
    "/receiving/batches/:receivingBatchId",
    async (request) => dependencies.service.correctBatch(
      await rootCorrector(request),
      batchId(request.params.receivingBatchId),
      mutationBody(request.body),
    ),
  );

  app.delete<{ Params: { receivingBatchId: string } }>(
    "/receiving/batches/:receivingBatchId",
    async (request) => dependencies.service.deleteBatch(
      await rootCorrector(request),
      batchId(request.params.receivingBatchId),
      deleteBody(request.body).expectedVersion,
    ),
  );
}
