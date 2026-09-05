import { z } from "zod";

export const SourcingProductionStatusSchema = z.enum(["in_production", "production_completed", "shipped"]);
export const DispatchSourcingOrderSchema = z.object({
  sourcingContractDocumentId: z.string().uuid(),
  confirmed: z.literal(true),
}).strict();
export const SourcingDispatchSummarySchema = z.object({
  productionOrderId: z.string().uuid(),
  status: SourcingProductionStatusSchema,
  dispatchedAt: z.string().datetime(),
}).strict();
export const SourcingDispatchStateSchema = z.object({
  item: SourcingDispatchSummarySchema.nullable(),
  canDispatch: z.boolean(),
}).strict();
export const SourcingProductionOrderSchema = SourcingDispatchSummarySchema.extend({
  sourcingCaseId: z.string().uuid(),
  decisionVersion: z.number().int().positive(),
  sourcingContractDocumentId: z.string().uuid(),
  contractNumber: z.string(),
  contractVersion: z.number().int().positive(),
  supplierId: z.string().uuid(),
  supplierName: z.string(),
  gender: z.enum(["男装", "女装"]).nullable(),
  styleName: z.string().nullable(),
  quantity: z.number().int().positive(),
  processes: z.array(z.string()),
  deliveryDate: z.string().nullable(),
  firstStyleNo: z.string(),
  dispatchedBy: z.string().uuid(),
  firstReportedOn: z.string().nullable(),
  reportingState: z.literal("pending_first_report").nullable(),
  timeProgress: z.null(),
  progressAlert: z.null(),
  lines: z.array(z.object({
    position: z.number().int().positive(),
    styleNo: z.string(),
    alternateStyleNo: z.string().nullable(),
    color: z.string().nullable(),
    quantity: z.number().int().positive(),
  }).strict()).min(1).max(20),
}).strict();
export const SourcingProductionOrderListSchema = z.object({
  items: z.array(SourcingProductionOrderSchema).max(15),
  page: z.number().int().positive(),
  pageSize: z.literal(15),
  totalCount: z.number().int().nonnegative(),
}).strict();
export type DispatchSourcingOrder = z.infer<typeof DispatchSourcingOrderSchema>;
export type SourcingDispatchState = z.infer<typeof SourcingDispatchStateSchema>;
export type SourcingProductionOrder = z.infer<typeof SourcingProductionOrderSchema>;
