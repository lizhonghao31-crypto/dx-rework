import { z } from "zod";
export const ProductionPilotInputSchema=z.object({supplierId:z.string().uuid(),enabled:z.boolean()}).strict();
export const ProductionPilotListSchema=z.object({suppliers:z.array(z.object({supplierId:z.string().uuid(),supplierName:z.string(),enabled:z.boolean()}).strict())}).strict();
export const ProductionReceivingSummarySchema=z.object({productionOrderId:z.string().uuid(),factoryDecisionId:z.string().uuid().nullable().optional(),cuttingOrderIds:z.array(z.string().uuid()).optional(),firstStyleNo:z.string(),contractNumber:z.string(),supplierName:z.string(),shippedOn:z.string(),expectedQuantity:z.number().int().nonnegative(),
  receipts:z.array(z.object({receiptId:z.string().uuid(),receivingBatchId:z.string().uuid(),actualQuantity:z.number().int().nonnegative(),receivedAt:z.string().datetime(),archived:z.boolean()}).strict())}).strict();
export const ProductionExpectedReceiptsSchema=z.object({items:z.array(ProductionReceivingSummarySchema).max(15),page:z.number().int().positive(),totalCount:z.number().int().nonnegative()}).strict();
export type ProductionReceivingSummary=z.infer<typeof ProductionReceivingSummarySchema>;
