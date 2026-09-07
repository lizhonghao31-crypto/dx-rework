import {z} from "zod";
import {SourcingProductionOrderSchema, SourcingProductionStatusSchema} from "./sourcing-production.js";
const integer = z.string().regex(/^\d+$/);
const dueBucket = z.enum(["all","overdue","soon","missing","later","closed"]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const day = new Date(`${value}T00:00:00Z`); return Number.isFinite(day.getTime()) && day.toISOString().slice(0,10) === value;
});
export const ProductionAnalysisQuerySchema = z.object({
  supplierId:z.string().uuid().optional(),q:z.string().trim().max(120).default(""),
  status:SourcingProductionStatusSchema.optional(),dueFrom:date.optional(),dueTo:date.optional(),
  dueBucket:dueBucket.default("all"),
  page:z.coerce.number().int().min(1).max(100000).default(1),groupPage:z.coerce.number().int().min(1).max(100000).default(1),
}).strict().refine(query => !query.dueFrom || !query.dueTo || query.dueFrom <= query.dueTo,"交期范围无效");
export type ProductionAnalysisQuery = z.infer<typeof ProductionAnalysisQuerySchema>;
const quality = z.object({reworkOrderCount:z.number().int().nonnegative(),orders:z.array(z.object({
  reworkOrderId:z.string().uuid(),reworkNo:z.string().nullable(),quantity:integer.nullable(),status:z.string(),
})),ambiguousBatchCount:z.number().int().nonnegative()});
export const ProductionAnalysisResponseSchema = z.object({
  asOf:z.string(),filters:ProductionAnalysisQuerySchema,
  summary:z.object({totalCount:z.number().int().nonnegative(),openCount:z.number().int().nonnegative(),
    remainingQuantity:integer,overdueCount:z.number().int().nonnegative(),soonCount:z.number().int().nonnegative(),missingDueCount:z.number().int().nonnegative(),
    ordersWithoutReceipts:z.number().int().nonnegative(),ordersWithUnallocatedAdjustments:z.number().int().nonnegative(),
    alertCount:z.number().int().nonnegative(),qualityOrderCount:z.number().int().nonnegative().nullable()}),
  groupTotal:z.number().int().nonnegative(),groups:z.array(z.object({supplierId:z.string().uuid(),supplierName:z.string(),
    orderCount:z.number().int().nonnegative(),openCount:z.number().int().nonnegative(),remainingQuantity:integer,overdueCount:z.number().int().nonnegative()})).max(15),
  items:z.array(z.object({order:SourcingProductionOrderSchema,dueBucket,
    remainingQuantity:integer,completedOn:z.string().nullable(),completedRecordedAt:z.string().nullable(),
    shippedOn:z.string().nullable(),shipmentRecordedAt:z.string().nullable(),shippedQuantity:integer.nullable(),
    firstReceivedAt:z.string().nullable(),receivedQuantity:integer,
    receivingState:z.enum(["none","partial","quantity_met","unverified"]),
    archivedReceiptCount:z.number().int().nonnegative(),unallocatedBatchCount:z.number().int().nonnegative(),
    receipts:z.array(z.object({receiptId:z.string().uuid(),receivingBatchId:z.string().uuid(),actualQuantity:integer,receivedAt:z.string(),correctionId:z.string().uuid().nullable(),archived:z.boolean()})),
    quality:quality.nullable(),
    alerts:z.array(z.object({alertId:z.string().uuid(),kind:z.enum(["behind","high_risk","stale"]),firstObservedAt:z.string(),closedAt:z.string().nullable(),readAt:z.string().nullable(),
      nextReportAt:z.string().nullable(),nextReportBusinessDate:z.string().nullable()})),
  })).max(15),
});
export type ProductionAnalysisResponse = z.infer<typeof ProductionAnalysisResponseSchema>;
