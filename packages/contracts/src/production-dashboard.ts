import { z } from "zod";
import { SourcingProductionOrderSchema, SourcingProductionStatusSchema } from "./sourcing-production.js";
import { ProductionReportingDetailSchema } from "./production-reporting.js";
export const ProductionProgressStateSchema = z.enum(["pending_first_report", "normal", "behind", "high_risk", "stale", "completed"]);
export const ProductionProgressSchema = z.object({
  productionProgress: z.number().min(0).max(100), timeProgress: z.number().min(0).max(100).nullable(),
  plannedWorkdays: z.number().int().nonnegative().nullable(), elapsedWorkdays: z.number().int().nonnegative().nullable(),
  progressState: ProductionProgressStateSchema, daysWithoutUpdate: z.number().int().nonnegative().nullable(),
  frozen: z.boolean(), firstReportedOn: z.string().date().nullable(), completedQuantity: z.number().int().nonnegative(),
  lastUpdatedAt: z.string().datetime().nullable(), attention: z.boolean(),
}).strict();
export const ProductionChaseSchema = z.object({
  remainingQuantity: z.number().int().nonnegative(), remainingWorkdays: z.number().int().nonnegative().nullable(),
  requiredDailyQuantity: z.number().int().nonnegative().nullable(), recentDayCount: z.number().int().min(0).max(3),
  recentDailyQuantity: z.number().nonnegative().nullable(), deliveryPressure: z.boolean(), dueThisWeek: z.boolean(),
  supplierOpenCount: z.number().int().nonnegative(), supplierDueThisWeekCount: z.number().int().nonnegative(),
}).strict();
export const ProductionDashboardItemSchema = z.object({ order: SourcingProductionOrderSchema, progress: ProductionProgressSchema, chase: ProductionChaseSchema.optional() }).strict();
export const ProductionDashboardQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).optional(), q: z.string().max(100).optional(),
  supplierId: z.string().uuid().optional(), status: SourcingProductionStatusSchema.optional(), progressState: ProductionProgressStateSchema.optional(),
  risk: z.enum(["attention", "stale", "due_pressure"]).optional(),
  previousAsOf: z.string().datetime().optional(),
}).strict();
export const ProductionDashboardEventSchema = z.object({
  id: z.string(), productionOrderId: z.string().uuid(), factoryDecisionId:z.string().uuid().nullable().optional(), firstStyleNo: z.string(), supplierName: z.string(),
  kind: z.enum(["report", "correct", "complete", "ship", "progress_changed"]), businessDate: z.string().date(),
  recordedAt: z.string().datetime(), quantity: z.number().int().nonnegative().nullable(),
  previousState: ProductionProgressStateSchema.nullable(), progressState: ProductionProgressStateSchema.nullable(),
  daysWithoutUpdate: z.number().int().nonnegative().nullable(),
}).strict();
export const ProductionDashboardSchema = z.object({
  asOf: z.string().datetime(), items: z.array(ProductionDashboardItemSchema).max(15), page: z.number().int().positive(), pageSize: z.literal(15), totalCount: z.number().int().nonnegative(),
  counts: z.object({inProduction:z.number().int().nonnegative(),completed:z.number().int().nonnegative(),shipped:z.number().int().nonnegative(),attention:z.number().int().nonnegative()}).strict(),
  chaseCounts: z.object({attention: z.number().int().nonnegative(), stale: z.number().int().nonnegative(), duePressure: z.number().int().nonnegative()}).optional(),
  suppliers: z.array(z.object({supplierId:z.string().uuid(),supplierName:z.string()}).strict()),
  events: z.array(ProductionDashboardEventSchema).max(20),
}).strict();
export const ProductionDashboardDetailSchema = z.object({
  asOf: z.string().datetime(), progress: ProductionProgressSchema, detail: ProductionReportingDetailSchema,
}).strict();
export type ProductionDashboard = z.infer<typeof ProductionDashboardSchema>;
export type ProductionDashboardItem = z.infer<typeof ProductionDashboardItemSchema>;
export type ProductionDashboardQuery = z.infer<typeof ProductionDashboardQuerySchema>;
export type ProductionDashboardEvent = z.infer<typeof ProductionDashboardEventSchema>;
