import { z } from "zod";
import { SourcingProductionOrderSchema } from "./sourcing-production.js";
const Id = z.string().uuid();
const DateOnly = z.string().date();
export const ProductionReportInputSchema = z.object({
  position: z.number().int().min(1).max(20), businessDate: DateOnly,
  quantity: z.number().int().min(1).max(10000000), factoryDecisionId: Id.nullable().optional(),
}).strict();
export const ProductionCorrectionInputSchema = z.object({
  expectedReportId: Id, factoryDecisionId: Id.nullable().optional(), businessDate: DateOnly,
  quantity: z.number().int().min(0).max(10000000), reason: z.string().trim().min(1).max(500),
}).strict();
export const ProductionExecutionInputSchema = z.object({ businessDate: DateOnly, confirmed: z.literal(true), factoryDecisionId: Id.nullable().optional() }).strict();
export const ProductionScopeInputSchema = z.object({
  userId: Id, scopeType: z.enum(["supplier", "order"]), scopeId: Id, active: z.boolean(),
}).strict();
export const ProductionReportHistorySchema = z.object({
  reportId: Id, rootReportId: Id, revision: z.number().int().positive(), position: z.number().int().positive(),
  businessDate: DateOnly, quantity: z.number().int().nonnegative(), actorName: z.string(),
  createdAt: z.string().datetime(), reason: z.string().nullable(), effective: z.boolean(),
}).strict();
export const ProductionReportingDetailSchema = z.object({
  order: SourcingProductionOrderSchema,
  canReport: z.boolean(), canCorrect: z.boolean(),
  history: z.array(ProductionReportHistorySchema),
  transitions: z.array(z.object({status:z.string(), businessDate:DateOnly, actorName:z.string(), createdAt:z.string().datetime()}).strict()),
  shipment: z.object({firstStyleNo:z.string(), shippedOn:DateOnly, recordedQuantity:z.number().int().nonnegative()}).strict().nullable(),
}).strict();
export const ProductionReportingListSchema = z.object({
  items: z.array(SourcingProductionOrderSchema).max(15), page:z.number().int().positive(), pageSize:z.literal(15), totalCount:z.number().int().nonnegative(),
  suppliers:z.array(z.object({supplierId:Id,supplierName:z.string()}).strict()),
}).strict();
export const ProductionScopeDirectorySchema = z.object({
  users:z.array(z.object({userId:Id,displayName:z.string()}).strict()),
  suppliers:z.array(z.object({supplierId:Id,supplierName:z.string()}).strict()),
  scopes:z.array(ProductionScopeInputSchema.extend({scopeLabel:z.string()})),
}).strict();
export type ProductionReportInput = z.infer<typeof ProductionReportInputSchema>;
export type ProductionCorrectionInput = z.infer<typeof ProductionCorrectionInputSchema>;
export type ProductionExecutionInput = z.infer<typeof ProductionExecutionInputSchema>;
export type ProductionScopeInput = z.infer<typeof ProductionScopeInputSchema>;
export type ProductionReportingDetail = z.infer<typeof ProductionReportingDetailSchema>;
