import { z } from "zod";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const integer = z.string().regex(/^-?\d+$/);
const id = z.string().uuid();
export const ReceivingAnalysisQuerySchema = z.object({
  startDate: date, endDate: date, q: z.string().trim().max(120).default(""),
  fact: z.enum(["all", "receiving_difference", "packing_difference", "missing_packing", "handled"]).default("all"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
}).strict().refine(query => query.startDate <= query.endDate, "结束日期不能早于开始日期");
export type ReceivingAnalysisQuery = z.infer<typeof ReceivingAnalysisQuerySchema>;
export const ReceivingAnalysisResponseSchema = z.object({
  asOf: z.string(), filters: ReceivingAnalysisQuerySchema,
  summary: z.object({totalCount: z.number().int().nonnegative(), batchCount: integer, documentQuantity: integer,
    actualQuantity: integer, receivingDifference: integer, receivingAbsoluteDifference: integer,
    packingQuantity: integer.nullable(), packingDifference: integer.nullable(),
    missingPackingCount: integer, handledCount: integer, unlinkedReceiptCount: integer, excludedReceiptCount: integer}),
  items: z.array(z.object({
    receivingBatchId: id, styleNo: z.string(), version: z.number().int(), batchIds: z.array(id),
    documentQuantity: integer, actualQuantity: integer, receivingDifference: integer,
    packingRevisionId: id.nullable(), packingQuantity: integer.nullable(), packingDifference: integer.nullable(),
    receivingHandled: z.boolean(), packingHandled: z.boolean(),
    receipts: z.array(z.object({receiptId: id, receivingBatchId: id, receivedAt: z.string(),
      documentQuantity: integer, actualQuantity: integer, correctionId: id.nullable(),
      productionOrderId: id.nullable(), supplierId: id.nullable(), supplierName: z.string().nullable(),
      contractNumber: z.string().nullable(), excluded: z.boolean(),
      attachments: z.array(z.object({attachmentId: id, filename: z.string()}))})),
    packingHistory: z.array(z.object({revisionId: id, receivingBatchId: id, quantity: integer, recordedAt: z.string()})),
    resolutions: z.array(z.object({resolutionId: id, receivingBatchId: id, type: z.enum(["receiving", "packing"]),
      documentQuantity: integer, actualQuantity: integer, packingQuantity: integer.nullable(),
      differenceQuantity: integer, packingRevisionId: id.nullable(), result: z.string(), handledAt: z.string()})),
  })).max(15),
});
export type ReceivingAnalysisResponse = z.infer<typeof ReceivingAnalysisResponseSchema>;
