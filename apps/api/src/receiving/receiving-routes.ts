import type { FastifyInstance, FastifyRequest } from "fastify";

import { businessActor, isRootUser } from "../access/business-authority.js";
import { assertDataExportPolicy } from "../access/data-export-policy.js";
import type { RootAuthority } from "../access/root-authority.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import { buildWorkbook } from "../reporting/xlsx-workbook.js";
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

const productionReference = (body:Record<string,unknown>):{productionOrderId?:string} => {
  if (body.productionOrderId === undefined) return {};
  if (typeof body.productionOrderId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.productionOrderId))
    throw new ApplicationError("VALIDATION_ERROR","生产订单编号无效",400);
  return {productionOrderId:body.productionOrderId};
};

const createBody = (input: unknown): {
  productionOrderId?: string;
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
    ...productionReference(body),
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

const packingBody = (input: unknown): {
  expectedVersion: number;
  expectedPackingRevisionId: string | null;
  packingQuantity: number;
} => {
  if (!input || typeof input !== "object") {
    throw new ApplicationError("VALIDATION_ERROR", "装箱数量信息不完整", 400);
  }
  const body = input as Record<string, unknown>;
  return {
    expectedVersion: Number(body.expectedVersion),
    expectedPackingRevisionId: typeof body.expectedPackingRevisionId === "string"
      ? body.expectedPackingRevisionId
      : null,
    packingQuantity: Number(body.packingQuantity),
  };
};

const resolutionBody = (input: unknown): {
  expectedVersion: number;
  expectedDocumentQuantity: number;
  expectedActualQuantity: number;
  expectedPackingRevisionId: string | null;
  differenceType: "receiving" | "packing";
  result: string;
} => {
  if (!input || typeof input !== "object") {
    throw new ApplicationError("VALIDATION_ERROR", "差异处理信息不完整", 400);
  }
  const body = input as Record<string, unknown>;
  if (body.differenceType !== "receiving" && body.differenceType !== "packing") {
    throw new ApplicationError("VALIDATION_ERROR", "差异类型无效", 400);
  }
  if (typeof body.result !== "string") {
    throw new ApplicationError("VALIDATION_ERROR", "请填写处理结果", 400);
  }
  return {
    expectedVersion: Number(body.expectedVersion),
    expectedDocumentQuantity: Number(body.expectedDocumentQuantity),
    expectedActualQuantity: Number(body.expectedActualQuantity),
    expectedPackingRevisionId: typeof body.expectedPackingRevisionId === "string"
      ? body.expectedPackingRevisionId
      : null,
    differenceType: body.differenceType,
    result: body.result,
  };
};

const batchId = (input: string): string => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
    throw new ApplicationError("VALIDATION_ERROR", "收货订单标识无效", 400);
  }
  return input;
};

const repeatBody = (input: unknown): {
  productionOrderId?: string;
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
    ...productionReference(body),
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

  app.get("/receiving/analysis", async (request, reply) => {
    const user = await readUser(request);
    const actor = await businessActor(dependencies.root, user, request.id, "receiving:read");
    reply.header("Cache-Control", "no-store");
    return dependencies.service.analysis(actor, request.query);
  });

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

  const boardOperator = async (
    request: FastifyRequest,
    role: "warehouse_receiver" | "tail_supervisor" | null,
    capability: "receiving:resolve_difference" | "receiving:packing_manage" | "receiving:export",
  ) => {
    const user = await dependencies.authenticate(token(request));
    const root = await isRootUser(dependencies.root, user.id);
    const permitted = user.capabilities.includes(capability)
      && (role === null || user.businessRoles?.includes(role) === true);
    if (!root && !permitted) {
      throw new ApplicationError("FORBIDDEN", "没有权限执行此订单回货操作", 403);
    }
    const trusted = await businessActor(dependencies.root, user, request.id, capability, root && role ? role : undefined);
    if (capability === "receiving:export") assertDataExportPolicy(trusted, "general");
    return trusted;
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

  app.get<{ Querystring: {
    date?: string;
    startDate?: string;
    endDate?: string;
    q?: string;
    status?: string;
  } }>("/receiving/board/export", async (request, reply) => {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const startDate = request.query.startDate ?? request.query.date ?? today;
    const endDate = request.query.endDate ?? request.query.date ?? startDate;
    const board = await dependencies.service.exportBoard(
      await boardOperator(request, null, "receiving:export"),
      startDate,
      endDate,
      request.query.q ?? "",
      request.query.status ?? "all",
    );
    const resolutionStatus = (value: { result: string; handledBy: string; handledAt: string } | null): string =>
      value ? "已处理" : "未处理";
    const workbook = buildWorkbook([
      {
        name: "订单汇总",
        rows: [
          ["筛选范围", board.mode === "search" ? "全时间款号搜索" : `${board.startDate} 至 ${board.endDate}`, "状态", board.status],
          ["导出时间", new Date().toISOString(), "订单数", board.totalCount],
          ["款号", "送货单数量", "实收数量", "次品数量", "收货差异", "收货差异状态", "收货差异处理结果", "收货差异处理人", "收货差异处理时间", "装箱数量", "装箱差异", "装箱差异状态", "装箱差异处理结果", "装箱差异处理人", "装箱差异处理时间", "最近收货", "收货人"],
          ...board.rows.map((row) => [
            row.styleNo,row.documentQuantity,row.cumulativeActualQuantity,row.defectiveQuantity,row.differenceQuantity,
            row.differenceQuantity === 0 ? "无差异" : resolutionStatus(row.receivingDifferenceResolution),
            row.receivingDifferenceResolution?.result ?? "",row.receivingDifferenceResolution?.handledBy ?? "",row.receivingDifferenceResolution?.handledAt ?? "",
            row.packingQuantity,row.packingDifferenceQuantity,
            row.packingDifferenceQuantity === null ? "未录入" : row.packingDifferenceQuantity === 0 ? "无差异" : resolutionStatus(row.packingDifferenceResolution),
            row.packingDifferenceResolution?.result ?? "",row.packingDifferenceResolution?.handledBy ?? "",row.packingDifferenceResolution?.handledAt ?? "",
            row.lastReceivedAt,row.lastReceiverName,
          ]),
        ],
      },
      {
        name: "收货明细",
        rows: [
          ["筛选范围", board.mode === "search" ? "全时间款号搜索" : `${board.startDate} 至 ${board.endDate}`, "状态", board.status],
          ["导出时间", new Date().toISOString(), "订单数", board.totalCount],
          ["款号", "收货次序", "来源", "本次送货单", "本次实收", "本次次品", "累计实收", "收货差异", "收货人", "收货时间"],
          ...board.rows.flatMap((row) => row.receivingHistory.map((item) => [
            row.styleNo,item.sequence,
            item.receivingSource === "other_factory" ? "其他工厂" : item.receivingSource === "jiashun" ? "嘉顺" : "来源待确认",
            item.receiptDocumentQuantity,item.actualQuantity,item.defectiveQuantity,item.cumulativeActualQuantity,item.differenceQuantity,
            item.receiverName,item.receivedAt,
          ])),
        ],
      },
    ]);
    return reply
      .header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", `attachment; filename="receiving-board-${board.endDate}.xlsx"`)
      .send(workbook);
  });

  app.post<{ Params: { receivingBatchId: string } }>(
    "/receiving/batches/:receivingBatchId/packing-revisions",
    async (request, reply) => {
      const input = packingBody(request.body);
      const result = await dependencies.service.recordPacking(
        await boardOperator(request, "tail_supervisor", "receiving:packing_manage"),
        { receivingBatchId: batchId(request.params.receivingBatchId), ...input },
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

  app.post<{ Params: { receivingBatchId: string } }>(
    "/receiving/batches/:receivingBatchId/difference-resolutions",
    async (request, reply) => {
      const input = resolutionBody(request.body);
      const role = input.differenceType === "receiving" ? "warehouse_receiver" : "tail_supervisor";
      const capability = input.differenceType === "receiving"
        ? "receiving:resolve_difference" as const
        : "receiving:packing_manage" as const;
      const result = await dependencies.service.resolveDifference(
        await boardOperator(request, role, capability),
        { receivingBatchId: batchId(request.params.receivingBatchId), ...input },
        idempotencyKey(request),
      );
      if (result.reused) void reply.header("idempotency-replayed", "true");
      return reply.code(201).send(result.value);
    },
  );

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
